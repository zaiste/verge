/**
 * SocketEngine transport tests: the NDJSON framing, backpressure outbox,
 * hello ordering, RPC timeout, and hook reply paths that MockEngine
 * bypasses. A fake shim built on Bun.listen speaks the wire protocol.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

// Both timeouts are read from the environment at module load; set them
// before engine.ts is imported so the tests run in milliseconds.
process.env.VERGE_RPC_TIMEOUT_MS = "250";
process.env.VERGE_HOOK_DEADLINE_MS = "250";
const { SocketEngine } = await import("../runtime/src/engine");

let sockCounter = 0;
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

interface FakeShim {
  path: string;
  /** Every parsed NDJSON line, in arrival order. */
  lines: unknown[];
  /** Resolves when at least n lines have arrived. */
  waitForLines(n: number): Promise<unknown[]>;
  /** Sends raw bytes to the connected sidecar. */
  send(bytes: Uint8Array | string): void;
  stop(): void;
}

function fakeShim(): FakeShim {
  const path = `${tmpdir()}/verge-tt-${process.pid}-${sockCounter++}.sock`;
  const lines: unknown[] = [];
  const waiters: { n: number; resolve: (l: unknown[]) => void }[] = [];
  let conn: Bun.Socket<undefined> | null = null;
  let buffer = "";

  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      open(s) {
        conn = s;
      },
      data(_s, chunk) {
        buffer += new TextDecoder().decode(chunk);
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part) continue;
          lines.push(JSON.parse(part));
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (lines.length >= waiters[i]!.n) {
            waiters[i]!.resolve(lines);
            waiters.splice(i, 1);
          }
        }
      },
    },
  });

  const shim: FakeShim = {
    path,
    lines,
    waitForLines(n) {
      if (lines.length >= n) return Promise.resolve(lines);
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
    send(bytes) {
      conn!.write(bytes);
    },
    stop() {
      server.stop(true);
    },
  };
  cleanups.push(shim.stop);
  return shim;
}

async function connectedEngine(shim: FakeShim) {
  const engine = new SocketEngine(shim.path, () => {});
  await engine.start(["new_game", "client_command"]);
  await shim.waitForLines(1); // hello
  return engine;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SocketEngine transport", () => {
  test("hello is the first frame even when RPCs were issued before connect", async () => {
    const shim = fakeShim();
    const engine = new SocketEngine(shim.path, () => {});
    // A plugin RPC during setup(), before the socket exists.
    engine.rpc("get_cvar", "sv_maxclients").catch(() => {});
    await engine.start(["new_game"]);

    const lines = (await shim.waitForLines(2)) as { t: string }[];
    expect(lines[0]!.t).toBe("hello");
    expect(lines[1]!.t).toBe("rpc");
  });

  test("multi-byte UTF-8 split across reads survives intact", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);

    const name = "Папér🎯"; // multi-byte cyrillic + accented + emoji
    const received: unknown[][] = [];
    engine.onRaw("new_game", (args) => {
      received.push(args);
    });

    const frame = new TextEncoder().encode(JSON.stringify({ t: "ev", name: "new_game", args: [name] }) + "\n");
    // Split inside the emoji's 4-byte sequence.
    const cut = frame.length - 4;
    shim.send(frame.slice(0, cut));
    await sleep(20);
    shim.send(frame.slice(cut));
    await sleep(50);

    expect(received).toEqual([[name]]);
  });

  test("partial lines are reframed across reads", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);

    const seen: unknown[][] = [];
    engine.onRaw("new_game", (args) => {
      seen.push(args);
    });

    const a = JSON.stringify({ t: "ev", name: "new_game", args: [1] });
    const b = JSON.stringify({ t: "ev", name: "new_game", args: [2] });
    shim.send(a.slice(0, 10));
    await sleep(20);
    shim.send(a.slice(10) + "\n" + b + "\n");
    await sleep(50);

    expect(seen).toEqual([[1], [2]]);
  });

  test("rpc resolves on rpcres and clears its timer", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);

    const promise = engine.rpc("get_cvar", "fs_homepath");
    const lines = (await shim.waitForLines(2)) as { t: string; id: number }[];
    const rpc = lines.find((l) => l.t === "rpc")!;
    shim.send(JSON.stringify({ t: "rpcres", id: rpc.id, ok: true, val: "/qlds" }) + "\n");
    expect(await promise).toBe("/qlds");
  });

  test("rpc rejects after the timeout when the reply never comes", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);
    expect(engine.rpc("get_cvar", "lost")).rejects.toThrow(/timed out after 250 ms/);
  });

  test("a throwing hook handler still replies res:null", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);
    engine.onRaw("client_command", () => {
      throw new Error("plugin bug");
    });

    shim.send(JSON.stringify({ t: "hook", id: 7, name: "client_command", args: [0, "say hi"] }) + "\n");
    const lines = (await shim.waitForLines(2)) as { t: string; id: number; res: unknown }[];
    const res = lines.find((l) => l.t === "hookres")!;
    expect(res.id).toBe(7);
    expect(res.res).toBeNull();
  });

  test("a hanging hook handler gets a pass-through reply at the deadline, exactly once", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);
    let settle!: (v: import("../runtime/src/protocol").HookResult) => void;
    engine.onRaw("client_command", () => new Promise<import("../runtime/src/protocol").HookResult>((r) => (settle = r)));

    shim.send(JSON.stringify({ t: "hook", id: 8, name: "client_command", args: [0, "say hi"] }) + "\n");
    const lines = (await shim.waitForLines(2)) as { t: string; id: number; res: unknown }[];
    const res = lines.find((l) => l.t === "hookres")!;
    expect(res.id).toBe(8);
    expect(res.res).toBeNull();

    // The late settle must not produce a second hookres.
    settle(false);
    await sleep(50);
    expect(shim.lines.filter((l) => (l as { t: string }).t === "hookres")).toHaveLength(1);
  });

  test("large writes keep NDJSON framing under backpressure", async () => {
    const shim = fakeShim();
    const engine = await connectedEngine(shim);

    // A payload far beyond the kernel socket buffer, then a tail of small
    // frames: if a partial write were dropped instead of buffered, framing
    // would tear and JSON.parse in the fake shim would throw.
    const big = "x".repeat(4 * 1024 * 1024);
    engine.rpc("set_cvar", "big", big).catch(() => {});
    for (let i = 0; i < 100; i++) engine.rpc("get_cvar", `k${i}`).catch(() => {});

    const lines = (await shim.waitForLines(1 + 101)) as { t: string; args?: unknown[] }[];
    const rpcs = lines.filter((l) => l.t === "rpc");
    expect(rpcs).toHaveLength(101);
    expect((rpcs[0]!.args as string[])[1]).toHaveLength(big.length);
    expect(rpcs.at(-1)!.args).toEqual(["k99"]);
  });
});
