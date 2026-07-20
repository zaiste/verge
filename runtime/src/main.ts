/**
 * M1 echo sidecar: subscribes to every event, logs traffic, answers all
 * blocking hooks with pass-through, and proves the RPC path by querying a
 * cvar on new_game. Replaced by the real runtime in M2.
 */
import type { RpcName, RpcResMsg, ShimMsg, SidecarMsg } from "./protocol";
import { RAW_EVENTS } from "./protocol";

const socketPath = process.env.MINQLX_SOCKET ?? "minqlx.sock";
const log = (...args: unknown[]) => console.log("[minqlx-ts]", ...args);

let nextRpcId = 1;
const pendingRpcs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

type Socket = Bun.Socket<undefined>;
let sock: Socket | null = null;

function send(msg: SidecarMsg) {
  sock?.write(JSON.stringify(msg) + "\n");
}

function rpc<T = unknown>(fn: RpcName, ...args: unknown[]): Promise<T> {
  const id = nextRpcId++;
  send({ t: "rpc", id, fn, args });
  return new Promise((resolve, reject) => {
    pendingRpcs.set(id, { resolve: resolve as (v: unknown) => void, reject });
  });
}

async function handle(msg: ShimMsg) {
  switch (msg.t) {
    case "ev":
      log(`ev ${msg.name}`, JSON.stringify(msg.args));
      if (msg.name === "new_game") {
        const maxclients = await rpc<string | null>("get_cvar", "sv_maxclients");
        log(`rpc roundtrip OK: sv_maxclients = ${maxclients}`);
      }
      break;
    case "hook":
      log(`hook ${msg.name}`, JSON.stringify(msg.args));
      send({ t: "hookres", id: msg.id, res: null }); // always pass through
      break;
    case "rpcres": {
      const pending = pendingRpcs.get(msg.id);
      pendingRpcs.delete(msg.id);
      if (!pending) return;
      if (msg.ok) pending.resolve(msg.val);
      else pending.reject(new Error(msg.err ?? "rpc failed"));
      break;
    }
  }
}

let buffer = "";
const decoder = new TextDecoder(); // lossy on invalid engine bytes, by design

await Bun.connect({
  unix: socketPath,
  socket: {
    open(s) {
      sock = s;
      send({ t: "hello", v: 1, subs: [...RAW_EVENTS], frameEvery: 0 });
      log(`connected to ${socketPath}`);
    },
    data(_s, chunk) {
      buffer += decoder.decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        handle(JSON.parse(line) as ShimMsg).catch((e) => log("handler error:", e));
      }
    },
    close() {
      log("socket closed, exiting.");
      process.exit(0);
    },
    error(_s, error) {
      log("socket error:", error);
      process.exit(1);
    },
  },
});
