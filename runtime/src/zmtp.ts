/**
 * Minimal ZMTP 3.0 SUB client, just enough to subscribe to QLDS's ZeroMQ
 * stats publisher (NULL or PLAIN auth, single-frame JSON messages).
 * Replaces the pyzmq dependency with ~250 lines over Bun.connect.
 *
 * Wire format (https://rfc.zeromq.org/spec/23/):
 * - 64-byte greeting: signature, version, mechanism, as-server, filler
 * - frames: flags byte (MORE=1, LONG=2, COMMAND=4) + 1-or-8-byte length
 * - NULL handshake: READY <-> READY; PLAIN: HELLO -> WELCOME -> INITIATE -> READY
 * - SUB subscribes by sending a data frame starting with 0x01
 */

const FLAG_MORE = 0x01;
const FLAG_LONG = 0x02;
const FLAG_COMMAND = 0x04;

export interface ZmtpSubOptions {
  host: string;
  port: number;
  /** PLAIN auth credentials; omit for NULL auth. */
  username?: string;
  password?: string;
  onMessage(data: Uint8Array): void;
  onError(err: Error): void;
  /** Called when the connection closes (after which reconnect is up to the caller). */
  onClose(): void;
}

function greeting(mechanism: "NULL" | "PLAIN"): Uint8Array {
  const g = new Uint8Array(64);
  g[0] = 0xff;
  g[9] = 0x7f;
  g[10] = 3; // version major
  g[11] = 0; // version minor
  new TextEncoder().encodeInto(mechanism, g.subarray(12, 32));
  // as-server = 0, filler = zeros
  return g;
}

/** Builds a ZMTP command frame. */
function commandFrame(name: string, body: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const size = 1 + nameBytes.length + body.length;
  const long = size > 255;
  const frame = new Uint8Array(1 + (long ? 8 : 1) + size);
  frame[0] = FLAG_COMMAND | (long ? FLAG_LONG : 0);
  let o: number;
  if (long) {
    new DataView(frame.buffer).setBigUint64(1, BigInt(size));
    o = 9;
  } else {
    frame[1] = size;
    o = 2;
  }
  frame[o] = nameBytes.length;
  frame.set(nameBytes, o + 1);
  frame.set(body, o + 1 + nameBytes.length);
  return frame;
}

/** Metadata body: (name-len u8, name, value-len u32be, value)* */
function metadata(entries: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const k = enc.encode(key);
    const v = enc.encode(value);
    const buf = new Uint8Array(1 + k.length + 4 + v.length);
    buf[0] = k.length;
    buf.set(k, 1);
    new DataView(buf.buffer).setUint32(1 + k.length, v.length);
    buf.set(v, 5 + k.length);
    parts.push(buf);
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Data frame containing raw bytes. */
function dataFrame(body: Uint8Array): Uint8Array {
  const long = body.length > 255;
  const frame = new Uint8Array(1 + (long ? 8 : 1) + body.length);
  frame[0] = long ? FLAG_LONG : 0;
  if (long) {
    new DataView(frame.buffer).setBigUint64(1, BigInt(body.length));
    frame.set(body, 9);
  } else {
    frame[1] = body.length;
    frame.set(body, 2);
  }
  return frame;
}

type Phase = "greeting" | "handshake" | "ready";

export class ZmtpSub {
  private sock: Bun.Socket<undefined> | null = null;
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private phase: Phase = "greeting";
  private mechanism: "NULL" | "PLAIN";
  private closed = false;

  constructor(private opts: ZmtpSubOptions) {
    this.mechanism = opts.password ? "PLAIN" : "NULL";
  }

  async connect(): Promise<void> {
    await Bun.connect({
      hostname: this.opts.host,
      port: this.opts.port,
      socket: {
        open: (s) => {
          this.sock = s;
          s.write(greeting(this.mechanism));
        },
        data: (_s, chunk) => {
          try {
            this.onData(chunk);
          } catch (e) {
            this.opts.onError(e instanceof Error ? e : new Error(String(e)));
            this.close();
          }
        },
        close: () => {
          if (!this.closed) this.opts.onClose();
        },
        error: (_s, err) => this.opts.onError(err),
      },
    });
  }

  close(): void {
    this.closed = true;
    this.sock?.end();
    this.sock = null;
  }

  private onData(chunk: Uint8Array): void {
    this.buf = this.buf.length === 0 ? new Uint8Array(chunk) : concat([this.buf, chunk]);

    if (this.phase === "greeting") {
      if (this.buf.length < 64) return;
      if (this.buf[0] !== 0xff || this.buf[10] !== 3) {
        throw new Error("not a ZMTP 3.x peer");
      }
      this.buf = this.buf.slice(64);
      this.phase = "handshake";
      if (this.mechanism === "PLAIN") {
        const enc = new TextEncoder();
        const user = enc.encode(this.opts.username ?? "stats");
        const pass = enc.encode(this.opts.password ?? "");
        const body = new Uint8Array(1 + user.length + 1 + pass.length);
        body[0] = user.length;
        body.set(user, 1);
        body[1 + user.length] = pass.length;
        body.set(pass, 2 + user.length);
        this.sock?.write(commandFrame("HELLO", body));
      } else {
        this.sock?.write(commandFrame("READY", metadata({ "Socket-Type": "SUB" })));
      }
    }

    // Parse complete frames.
    for (;;) {
      const frame = this.parseFrame();
      if (!frame) return;
      this.handleFrame(frame.flags, frame.body);
    }
  }

  private parseFrame(): { flags: number; body: Uint8Array } | null {
    if (this.buf.length < 2) return null;
    const flags = this.buf[0]!;
    let size: number;
    let headerLen: number;
    if (flags & FLAG_LONG) {
      if (this.buf.length < 9) return null;
      const big = new DataView(this.buf.buffer, this.buf.byteOffset).getBigUint64(1);
      if (big > 16n * 1024n * 1024n) throw new Error("ZMTP frame too large");
      size = Number(big);
      headerLen = 9;
    } else {
      size = this.buf[1]!;
      headerLen = 2;
    }
    if (this.buf.length < headerLen + size) return null;
    const body = this.buf.slice(headerLen, headerLen + size);
    this.buf = this.buf.slice(headerLen + size);
    return { flags, body };
  }

  private handleFrame(flags: number, body: Uint8Array): void {
    if (flags & FLAG_COMMAND) {
      const nameLen = body[0] ?? 0;
      const name = new TextDecoder().decode(body.slice(1, 1 + nameLen));
      switch (name) {
        case "WELCOME":
          this.sock?.write(commandFrame("INITIATE", metadata({ "Socket-Type": "SUB" })));
          break;
        case "READY":
          this.phase = "ready";
          // Subscribe to everything (0x01 = subscribe, empty topic).
          this.sock?.write(dataFrame(new Uint8Array([0x01])));
          break;
        case "ERROR": {
          const reason = new TextDecoder().decode(body.slice(2 + nameLen));
          throw new Error(`ZMTP handshake error: ${reason}`);
        }
        default:
          break; // PING etc. shouldn't appear on 3.0; ignore
      }
      return;
    }

    if (this.phase !== "ready") return;
    // QLDS publishes single-frame JSON messages; ignore continuation flags
    // beyond passing each final frame up.
    if (!(flags & FLAG_MORE)) this.opts.onMessage(body);
  }
}
