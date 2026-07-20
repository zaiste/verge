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

export class SocketEngine implements Engine {
  private sock: Bun.Socket<undefined> | null = null;
  private nextRpcId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<RawEventName, RawHandler>();
  private buffer = "";
  private decoder = new TextDecoder(); // lossy on invalid engine bytes, by design

  constructor(private socketPath: string) {}

  rpc<K extends RpcName>(
    fn: K,
    ...args: Parameters<RpcSignatures[K]>
  ): Promise<ReturnType<RpcSignatures[K]>> {
    const id = this.nextRpcId++;
    this.send({ t: "rpc", id, fn, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
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
          this.send({ t: "hello", v: 1, subs, frameEvery });
          log.info(`connected to engine at ${this.socketPath}`);
        },
        data: (_s, chunk) => this.onData(chunk),
        close: () => {
          // The shim owns our lifecycle: if the socket goes, so do we.
          log.info("engine socket closed, exiting.");
          process.exit(0);
        },
        error: (_s, error) => {
          log.error("engine socket error:", error);
          process.exit(1);
        },
      },
    });
  }

  private send(msg: SidecarMsg) {
    this.sock?.write(JSON.stringify(msg) + "\n");
  }

  private onData(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk);
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
        Promise.resolve(handler(msg.args))
          .then((res) => this.send({ t: "hookres", id: msg.id, res: res ?? null }))
          .catch((e) => {
            log.error(`unhandled error in ${msg.name} hook:`, e);
            this.send({ t: "hookres", id: msg.id, res: null });
          });
        break;
      }
      case "rpcres": {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!pending) return;
        if (msg.ok) pending.resolve(msg.val);
        else pending.reject(new Error(msg.err ?? "rpc failed"));
        break;
      }
    }
  }
}
