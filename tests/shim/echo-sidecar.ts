/**
 * A deterministic stand-in for the real sidecar, used by tests/shim/harness.c.
 * The production runtime is driven by plugins and game state; this one does
 * exactly what each scenario needs and nothing else, so a harness failure
 * points at the C IPC layer rather than at plugin behaviour.
 *
 * Scenario triggers (sent by the harness):
 * - ev new_game            -> nesting trigger RPC + a burst of read-only RPCs
 * - ev rcon ["mutburst"]   -> interleaved mutating/read-only RPCs (drain order)
 * - ev rcon ["oversize"]   -> one line past MAX_LINE_SIZE (shim must drop us)
 * - hook ".. noreply"      -> no reply until well past the hook timeout
 * - hook ".. die"          -> exit without replying, mid-wait
 *
 *   bun tests/shim/echo-sidecar.ts        (VERGE_SOCKET is set by the shim)
 */
const socketPath = process.env.VERGE_SOCKET ?? "verge.sock";

// How many extra RPCs to send in the same write as the nesting trigger.
// They land in the shim's read buffer while it is blocked in a nested hook,
// which is precisely the situation that used to corrupt the framing.
const BURST = Number(process.env.HARNESS_BURST ?? 24);
/** Interleaved mutating/read-only pairs for the drain-order scenario. */
const MUT_BURST = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
let nextRpcId = 1;
/** Backpressure buffer: the oversize payload exceeds the kernel buffer, and
 * dropping the unwritten tail would leave an unterminated line. */
let outbox: Uint8Array | null = null;

const sock = await Bun.connect({
  unix: socketPath,
  socket: {
    open(s) {
      send(s, {
        t: "hello",
        v: 1,
        subs: ["client_command", "server_command", "new_game", "player_connect", "rcon"],
        frameEvery: 0,
      });
    },
    data(s, chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) handle(s, JSON.parse(line));
    },
    drain(s) {
      flush(s);
    },
    close() {
      process.exit(0);
    },
  },
});

function send(s: Bun.Socket, msg: unknown) {
  write(s, encoder.encode(JSON.stringify(msg) + "\n"));
}

function write(s: Bun.Socket, bytes: Uint8Array) {
  if (outbox) {
    const merged = new Uint8Array(outbox.length + bytes.length);
    merged.set(outbox);
    merged.set(bytes, outbox.length);
    outbox = merged;
  } else {
    outbox = bytes;
  }
  flush(s);
}

function flush(s: Bun.Socket) {
  if (!outbox) return;
  const written = s.write(outbox);
  outbox = written >= outbox.length ? null : outbox.slice(written);
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
      } else if (msg.name === "rcon" && msg.args?.[0] === "mutburst") {
        // Mutating RPCs get parked and drained at the next frame; read-only
        // ones may run inline. Arrival order must survive either path.
        for (let i = 0; i < MUT_BURST; i++) {
          send(s, { t: "rpc", id: nextRpcId++, fn: "set_cvar", args: [`mut_${i}`] });
          send(s, { t: "rpc", id: nextRpcId++, fn: "get_cvar", args: [`roint_${i}`] });
        }
      } else if (msg.name === "rcon" && msg.args?.[0] === "oversize") {
        // 2 MiB in one line: the shim must drop the connection ("input line
        // too long") rather than buffer without bound; we then get closed.
        write(s, encoder.encode(`{"t":"rpc","id":${nextRpcId++},"fn":"get_cvar","args":["${"x".repeat(2 * 1024 * 1024)}"]}\n`));
      }
      break;

    case "hook": {
      const cmd = String(msg.args?.[1] ?? "");
      if (cmd.includes("noreply")) {
        // Force the shim's timeout path; the late reply must be dropped as
        // stale, not matched to a newer wait.
        setTimeout(() => send(s, { t: "hookres", id: msg.id, res: null }), 2500);
        return;
      }
      if (cmd.includes("die")) process.exit(1);
      // Pass everything through; the harness asserts on ordering, not policy.
      send(s, { t: "hookres", id: msg.id, res: null });
      break;
    }

    case "rpcres":
      // The harness prints its own accounting; nothing to do here.
      break;
  }
}

export {};
