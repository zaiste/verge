import { describe, expect, test } from "bun:test";
import { ZmtpSub } from "../runtime/src/zmtp";

/**
 * Minimal ZMTP 3.0 PUB server side for the handshake, enough to validate
 * our SUB client: greeting exchange, READY <-> READY (NULL mechanism),
 * consume the subscription frame, then publish messages.
 */
function pubGreeting(): Uint8Array {
  const g = new Uint8Array(64);
  g[0] = 0xff;
  g[9] = 0x7f;
  g[10] = 3;
  new TextEncoder().encodeInto("NULL", g.subarray(12, 32));
  return g;
}

function readyCommand(): Uint8Array {
  const name = new TextEncoder().encode("READY");
  const key = new TextEncoder().encode("Socket-Type");
  const val = new TextEncoder().encode("PUB");
  const size = 1 + name.length + 1 + key.length + 4 + val.length;
  const buf = new Uint8Array(2 + size);
  buf[0] = 0x04; // COMMAND
  buf[1] = size;
  let o = 2;
  buf[o++] = name.length;
  buf.set(name, o); o += name.length;
  buf[o++] = key.length;
  buf.set(key, o); o += key.length;
  new DataView(buf.buffer).setUint32(o, val.length); o += 4;
  buf.set(val, o);
  return buf;
}

function shortMessage(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const buf = new Uint8Array(2 + body.length);
  buf[0] = 0x00;
  buf[1] = body.length;
  buf.set(body, 2);
  return buf;
}

function longMessage(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const buf = new Uint8Array(9 + body.length);
  buf[0] = 0x02; // LONG
  new DataView(buf.buffer).setBigUint64(1, BigInt(body.length));
  buf.set(body, 9);
  return buf;
}

describe("zmtp", () => {
  test("NULL handshake, subscription, and message delivery", async () => {
    const received: string[] = [];
    let gotSubscription: Uint8Array | null = null;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const server = Bun.listen<{ stage: number }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.data = { stage: 0 };
          s.write(pubGreeting());
        },
        data(s, chunk) {
          if (s.data.stage === 0 && chunk.length >= 64) {
            // Client greeting arrived; complete handshake.
            s.data.stage = 1;
            s.write(readyCommand());
            return;
          }
          if (s.data.stage === 1) {
            // Client READY + subscription frame(s).
            if (chunk.includes(0x01)) {
              gotSubscription = new Uint8Array(chunk);
              s.data.stage = 2;
              // Publish one short and one long (>255 bytes) message.
              s.write(shortMessage('{"TYPE":"TEST","DATA":{}}'));
              s.write(longMessage(`{"TYPE":"LONG","DATA":"${"x".repeat(300)}"}`));
            }
          }
        },
      },
    });

    const sub = new ZmtpSub({
      host: "127.0.0.1",
      port: server.port,
      onMessage(data) {
        received.push(new TextDecoder().decode(data));
        if (received.length === 2) resolveDone();
      },
      onError(err) {
        throw err;
      },
      onClose() {},
    });

    await sub.connect();
    await done;
    sub.close();
    server.stop(true);

    expect(gotSubscription).not.toBeNull();
    expect(received[0]).toBe('{"TYPE":"TEST","DATA":{}}');
    expect(JSON.parse(received[1]!).TYPE).toBe("LONG");
  }, 5000);

  test("PLAIN handshake: HELLO -> WELCOME -> INITIATE -> READY, then delivery", async () => {
    const received: string[] = [];
    const commandsSeen: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    function plainGreeting(): Uint8Array {
      const g = pubGreeting();
      g.fill(0, 12, 32);
      new TextEncoder().encodeInto("PLAIN", g.subarray(12, 32));
      return g;
    }
    function command(name: string): Uint8Array {
      const n = new TextEncoder().encode(name);
      const buf = new Uint8Array(2 + 1 + n.length);
      buf[0] = 0x04;
      buf[1] = 1 + n.length;
      buf[2] = n.length;
      buf.set(n, 3);
      return buf;
    }

    // Buffer across reads: on a loaded runner the client's 64-byte greeting
    // and its HELLO frame can coalesce into one chunk.
    const server = Bun.listen<{ buf: number[]; greeted: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.data = { buf: [], greeted: false };
          s.write(plainGreeting());
        },
        data(s, chunk) {
          s.data.buf.push(...chunk);
          if (!s.data.greeted) {
            if (s.data.buf.length < 64) return;
            s.data.buf.splice(0, 64); // client greeting consumed
            s.data.greeted = true;
          }
          // Frames from the client: HELLO, INITIATE, then the subscription.
          const text = new TextDecoder().decode(new Uint8Array(s.data.buf));
          if (text.includes("HELLO")) {
            s.data.buf.length = 0;
            commandsSeen.push("HELLO");
            s.write(command("WELCOME"));
          } else if (text.includes("INITIATE")) {
            s.data.buf.length = 0;
            commandsSeen.push("INITIATE");
            s.write(readyCommand());
          } else if (s.data.buf.includes(0x01)) {
            s.data.buf.length = 0;
            s.write(shortMessage('{"TYPE":"PLAINOK"}'));
          }
        },
      },
    });

    const sub = new ZmtpSub({
      host: "127.0.0.1",
      port: server.port,
      username: "stats",
      password: "hunter2",
      onMessage(data) {
        received.push(new TextDecoder().decode(data));
        resolveDone();
      },
      onError(err) {
        throw err;
      },
      onClose() {},
    });

    await sub.connect();
    await done;
    sub.close();
    server.stop(true);

    expect(commandsSeen).toEqual(["HELLO", "INITIATE"]);
    expect(received[0]).toBe('{"TYPE":"PLAINOK"}');
  }, 5000);

  test("a protocol error still fires onClose so the caller can reconnect", async () => {
    const errors: string[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));

    const server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          // Not a ZMTP peer: garbage instead of the greeting.
          s.write(new Uint8Array(64).fill(0x42));
        },
        data() {},
      },
    });

    const sub = new ZmtpSub({
      host: "127.0.0.1",
      port: server.port,
      onMessage() {},
      onError(err) {
        errors.push(err.message);
      },
      onClose() {
        resolveClosed();
      },
    });

    await sub.connect();
    // Regression: the error teardown used to set the intentional-close flag,
    // which swallowed onClose and permanently disabled the stats feed.
    await closed;
    server.stop(true);

    expect(errors.some((e) => e.includes("not a ZMTP 3.x peer"))).toBe(true);
  }, 5000);

  test("close() suppresses onClose (intentional shutdown does not reconnect)", async () => {
    let closeCalls = 0;

    const server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.write(pubGreeting());
        },
        data() {},
      },
    });

    const sub = new ZmtpSub({
      host: "127.0.0.1",
      port: server.port,
      onMessage() {},
      onError() {},
      onClose() {
        closeCalls++;
      },
    });

    await sub.connect();
    sub.close();
    await new Promise((r) => setTimeout(r, 100));
    server.stop(true);

    expect(closeCalls).toBe(0);
  }, 5000);
});
