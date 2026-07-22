/**
 * A deterministic stand-in for the real sidecar, used by tests/shim/harness.c.
 * The production runtime is driven by plugins and game state; this one does
 * exactly what each scenario needs and nothing else, so a harness failure
 * points at the C IPC layer rather than at plugin behaviour.
 *
 *   bun tests/shim/echo-sidecar.ts        (VERGE_SOCKET is set by the shim)
 */
const socketPath = process.env.VERGE_SOCKET ?? "verge.sock";

// How many extra RPCs to send in the same write as the nesting trigger.
// They land in the shim's read buffer while it is blocked in a nested hook,
// which is precisely the situation that used to corrupt the framing.
const BURST = Number(process.env.HARNESS_BURST ?? 24);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
let nextRpcId = 1;

const sock = await Bun.connect({
  unix: socketPath,
  socket: {
    open(s) {
      send(s, {
        t: "hello",
        v: 1,
        subs: ["client_command", "server_command", "new_game", "player_connect"],
        frameEvery: 0,
      });
    },
    data(s, chunk) {
      buffer += decoder.decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) handle(s, JSON.parse(line));
    },
    close() {
      process.exit(0);
    },
  },
});

function send(s: Bun.Socket, msg: unknown) {
  s.write(encoder.encode(JSON.stringify(msg) + "\n"));
}

function handle(s: Bun.Socket, msg: any) {
  switch (msg.t) {
    case "ev":
      // new_game kicks off the nesting scenario: one RPC the harness answers
      // by dispatching a hook, plus a burst that must survive that detour.
      if (msg.name === "new_game") {
        send(s, { t: "rpc", id: nextRpcId++, fn: "console_command", args: ["nest"] });
        for (let i = 0; i < BURST; i++) {
          send(s, { t: "rpc", id: nextRpcId++, fn: "get_cvar", args: [`filler_${i}`] });
        }
      }
      break;

    case "hook":
      // Pass everything through; the harness asserts on ordering, not policy.
      send(s, { t: "hookres", id: msg.id, res: null });
      break;

    case "rpcres":
      // The harness prints its own accounting; nothing to do here.
      break;
  }
}

export {};
