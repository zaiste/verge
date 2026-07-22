/**
 * The single IO boundary between the runtime and the game engine.
 * SocketEngine talks to the C shim over the Unix socket; the testkit's
 * MockEngine implements the same interface in-process.
 */
import type {
  HookResult,
  RawEventName,
  RpcName,
  RpcSignatures,
  ShimMsg,
  SidecarMsg,
} from "./protocol";
import { log } from "./util";

/** A raw handler receives the event's argument array; for blocking hooks its
 * (awaited) return value is the hook result. */
export type RawHandler = (args: unknown[]) => HookResult | void | Promise<HookResult | void>;

export interface Engine {
  rpc<K extends RpcName>(
    fn: K,
    ...args: Parameters<RpcSignatures[K]>
  ): Promise<ReturnType<RpcSignatures[K]>>;
  /** Registers the single raw handler for an event (the event pipeline). */
  onRaw(name: RawEventName, handler: RawHandler): void;
  /** Sends hello with the subscription list; events flow after this. */
  start(subs: RawEventName[], frameEvery?: number): Promise<void>;
}

/** Fault backstops. The shim answers read-only RPCs inline and mutating ones
 * on the next frame (~25 ms), so a reply that takes seconds means the frame
 * or the connection is gone — reject rather than hang the caller forever.
 * Likewise a hook handler that never settles would leak and force the engine
 * to burn its full hook timeout on every dispatch; past the deadline we reply
 * pass-through on its behalf. */
const RPC_TIMEOUT_MS = Number(process.env.VERGE_RPC_TIMEOUT_MS ?? "") || 5000;
const HOOK_DEADLINE_MS = Number(process.env.VERGE_HOOK_DEADLINE_MS ?? "") || 5000;

export class SocketEngine implements Engine {
  private sock: Bun.Socket<undefined> | null = null;
  private nextRpcId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private handlers = new Map<RawEventName, RawHandler>();
  private buffer = "";
  private decoder = new TextDecoder(); // lossy on invalid engine bytes, by design
  private encoder = new TextEncoder();
  /** Bytes not yet accepted by the kernel; flushed on drain. Writing without
   * honoring backpressure would corrupt the NDJSON framing under load. */
  private outbox: Uint8Array | null = null;

  constructor(
    private socketPath: string,
    /** Called when the shim connection ends; production exits so the shim
     * can respawn us, tests inject a no-op. */
    private onDisconnect: (code: number) => void = (code) => process.exit(code),
  ) {}

  rpc<K extends RpcName>(
    fn: K,
    ...args: Parameters<RpcSignatures[K]>
  ): Promise<ReturnType<RpcSignatures[K]>> {
    const id = this.nextRpcId++;
    this.send({ t: "rpc", id, fn, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc '${fn}' timed out after ${RPC_TIMEOUT_MS} ms`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  onRaw(name: RawEventName, handler: RawHandler): void {
    this.handlers.set(name, handler);
  }

  async start(subs: RawEventName[], frameEvery = 0): Promise<void> {
    await Bun.connect({
      unix: this.socketPath,
      socket: {
        open: (s) => {
          this.sock = s;
          // hello must be the first frame on the wire; a plugin may have
          // issued RPCs during setup() that are already in the outbox.
          const hello = this.encoder.encode(
            JSON.stringify({ t: "hello", v: 1, subs, frameEvery }) + "\n",
          );
          if (this.outbox) {
            const merged = new Uint8Array(hello.length + this.outbox.length);
            merged.set(hello);
            merged.set(this.outbox, hello.length);
            this.outbox = merged;
          } else {
            this.outbox = hello;
          }
          this.flush();
          log.info(`connected to engine at ${this.socketPath}`);
        },
        data: (_s, chunk) => this.onData(chunk),
        drain: () => this.flush(),
        close: () => {
          // The shim owns our lifecycle: if the socket goes, so do we.
          log.info("engine socket closed, exiting.");
          this.onDisconnect(0);
        },
        error: (_s, error) => {
          log.error("engine socket error:", error);
          this.onDisconnect(1);
        },
      },
    });
  }

  private send(msg: SidecarMsg) {
    const bytes = this.encoder.encode(JSON.stringify(msg) + "\n");
    if (this.outbox) {
      const merged = new Uint8Array(this.outbox.length + bytes.length);
      merged.set(this.outbox);
      merged.set(bytes, this.outbox.length);
      this.outbox = merged;
    } else {
      this.outbox = bytes;
    }
    this.flush();
  }

  private flush() {
    if (!this.sock || !this.outbox) return;
    const written = this.sock.write(this.outbox);
    this.outbox = written >= this.outbox.length ? null : this.outbox.slice(written);
  }

  private onData(chunk: Uint8Array) {
    // stream: true carries multi-byte UTF-8 sequences split across reads
    // over to the next chunk instead of mangling both halves to U+FFFD.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let msg: ShimMsg;
      try {
        msg = JSON.parse(line) as ShimMsg;
      } catch {
        log.error("bad JSON from shim:", line.slice(0, 200));
        continue;
      }
      this.handle(msg);
    }
  }

  private handle(msg: ShimMsg) {
    switch (msg.t) {
      case "ev": {
        const handler = this.handlers.get(msg.name);
        if (!handler) return;
        Promise.resolve(handler(msg.args)).catch((e) =>
          log.error(`unhandled error in ${msg.name} handler:`, e),
        );
        break;
      }
      case "hook": {
        const handler = this.handlers.get(msg.name);
        if (!handler) {
          this.send({ t: "hookres", id: msg.id, res: null });
          return;
        }
        // Reply exactly once. The engine passed through on its own timeout
        // long ago by the time the deadline fires; this bounds our state and
        // surfaces the hung handler. A late settle is dropped here.
        let replied = false;
        const reply = (res: HookResult) => {
          if (replied) return;
          replied = true;
          clearTimeout(deadline);
          this.send({ t: "hookres", id: msg.id, res });
        };
        const deadline = setTimeout(() => {
          log.error(`${msg.name} hook handler still pending after ${HOOK_DEADLINE_MS} ms; passing through.`);
          reply(null);
        }, HOOK_DEADLINE_MS);
        Promise.resolve(handler(msg.args))
          .then((res) => reply(res ?? null))
          .catch((e) => {
            log.error(`unhandled error in ${msg.name} hook:`, e);
            reply(null);
          });
        break;
      }
      case "rpcres": {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.val);
        else pending.reject(new Error(msg.err ?? "rpc failed"));
        break;
      }
    }
  }
}
