# Testing

verge is tested at four levels, cheapest first. The first three run in CI
on every push; the fourth needs a real server and is run by hand before a
release.

## 1. Plugin and runtime tests — `bun test`

The testkit implements the same `Engine` interface the socket transport
implements, in-process, so plugins run in the same runtime as production
with the engine faked underneath:

```ts
const server = await createTestServer({ plugins: ["admin"] });
const { info } = await server.connect({ name: "Keel" });
await server.chat(info.clientId, "!ban 0 1 day spam");
expect(server.messagesTo(null).join("")).toContain("banned");
```

`createTestServer` drives the real event pipeline, so a chat line goes
through the same parsing, command dispatch, and permission checks it
would on a live server. The database is an in-memory SQLite.

```sh
bun test                       # everything
bun test tests/admin.test.ts   # one file
cd runtime && bun run typecheck
```

## 2. Shim protocol — `make check-shim`

`tests/shim/harness.c` links the real `shim/shim_ipc.c` into a test binary,
stubs the engine side, and talks to a real Bun sidecar
(`tests/shim/echo-sidecar.ts`). It covers the sidecar handshake, event
delivery, blocking hooks, and re-entrancy.

The re-entrancy scenario is a regression test for the bug that segfaulted
a live server: an RPC that dispatches a hook while further RPCs are already
in the read buffer, so the hook's wait loop re-enters the reader. Revert
the fix in `read_and_process` and the harness dies with a bus error.

This covers the half of the shim that can run anywhere. The other half —
pattern scanning and inline hooking of `qzeroded.x64` — can only be tested
on a real server (level 4).

## 3. Portability — `tests/shim/load_test.c`

Servers run older distributions than any CI image. Two checks keep the
release loadable there:

- `tools/build-shim.sh` pins the glibc floor (2.17) with `zig cc` and fails
  if a symbol creeps above it.
- CI dlopens the built library with `RTLD_NOW` inside `debian:10`,
  `debian:11`, `ubuntu:20.04` and `rockylinux:8`, which is what the dynamic
  linker does when QLDS starts with it preloaded.

The floor check says what the library asks for; the load test says whether
a given glibc can provide it. Both matter: a library built on glibc 2.39
needs `GLIBC_2.33`+ and is rejected by every image above.

```sh
zig cc -target x86_64-linux-gnu.2.17 -o load_test tests/shim/load_test.c -ldl
docker run --rm -v "$PWD:/w" -w /w debian:10 ./load_test bin/verge.x64.so
```

## 4. Live scenario — the `smoketest` plugin

`plugins/smoketest.ts` drives a real QLDS through a scripted scenario and
prints `[SMOKE] PASS/FAIL` lines to the server console, ending in a
`[SMOKE] DONE passed=N failed=N` summary. Load it on a disposable server:

```toml
[server]
plugins = ["admin", "smoketest"]
```

```sh
VERGE_HOOK_TIMEOUT_MS=1000 ./verge-run.sh \
  +set net_port 27960 +set bot_enable 1 +set bot_minplayers 0 \
  +map campgrounds ffa
```

It adds bots as real clients, injects chat through the full pipeline with
the `client_command` RPC, and exercises the rcon path with
`console_command("verge !...")`. Assertions are on game and database state
rather than on reply text: replies travel over RPCs that call the
*original* engine functions, never the hooked ones, so a plugin cannot
observe its own output as an event.

Raise `VERGE_HOOK_TIMEOUT_MS` when the server is emulated (for example an
x86-64 VM on Apple silicon) — the default 100 ms budget assumes native
speed.

## Recording a session

`VERGE_TRACE=/path/to/session.jsonl` tees every protocol line, with
direction, to a file. Useful for seeing exactly what the engine sent
during a bug, and as raw material for future replay tests.
