# verge

A Quake Live dedicated server mod: a C shim (`core/` + `shim/`) is loaded
into the closed-source `qzeroded.x64` via LD_PRELOAD and forwards engine
events over a Unix socket to a Bun sidecar (`runtime/` + `plugins/`) that
hosts TypeScript plugins.

```
qzeroded.x64  ←LD_PRELOAD─  verge.x64.so  ──unix socket, NDJSON──  bun
```

Released at v0.1.0. It replaced minqlx's embedded CPython, Redis, and
~30 `qlx_*` cvars; see [docs/porting.md](docs/porting.md) for the
module, plugin, and API mapping.

## Layout

| Path | What |
|---|---|
| `core/` | inherited C: pattern scanning, inline hooks, HDE |
| `shim/` | IPC socket + supervision, dispatchers, the 42 RPCs |
| `runtime/src/` | sidecar: engine transport, event pipeline, commands, db |
| `plugins/` | the six bundled plugins, plus `smoketest` |
| `testkit/` + `tests/` | in-process engine fake; unit and shim tests |
| `tools/` | install, release packaging, glibc-pinned build, migration |

## Commands

```sh
tools/build-shim.sh        # build the shim (zig, pinned glibc floor, checked)
make check-shim            # shim IPC tests (needs bun on PATH)
bun test                   # plugin + runtime tests
cd runtime && bun run typecheck
cd runtime && bun run bundle   # -> bin/verge/
```

`make so` builds with the host compiler and only works on linux-x64; on
this Mac use `tools/build-shim.sh` (or
`make CC="zig cc -target x86_64-linux-gnu" so`), which cross-compiles.

Docs worth reading before changing behaviour:
[docs/protocol.md](docs/protocol.md) (wire protocol and threading),
[docs/testing.md](docs/testing.md), [docs/config.md](docs/config.md).

## Constraints that are easy to get wrong

**Engine functions are main-thread-only and not re-entrant.** RPCs are
classified in `shim/shim_rpc.c`: read-only ones run inline, including
inside a hook wait; anything that mutates engine state is acknowledged
immediately and executed at the top of the next frame. Running a mutating
RPC while the engine is blocked in a hook recurses engine→game→engine and
corrupts state. Consequence for plugin code: a mutating RPC's return value
is only meaningful outside a hook context.

**Nothing may hold a pointer or index into the shim's read buffer across
`process_line`.** Handling a line can re-enter the reader through a nested
hook wait. This caused a live segfault; `tests/shim/harness.c` is the
regression test.

**A plugin cannot observe its own replies.** Reply RPCs call the
*original* engine functions, never the hooked ones, so no event comes
back. Assert on game or database state instead.

**SteamID64 exceeds JS safe-integer precision** and is a string on the
wire and throughout the runtime.

**`set_configstring` is only dispatched when the value changes.** The
engine re-sets some indexes with identical values every frame; dispatching
those flooded the socket with thousands of round trips.

**Bots on this QLDS build have pseudo steam ids**, so `steamId === "0"` is
not sufficient — `Player.isBot` also checks the `skill` userinfo key.

**Socket writes can be partial.** `SocketEngine` buffers the remainder and
flushes on `drain`; ignoring the return value corrupts NDJSON framing
under load.

**A `Player` names a client slot, not a person.** After a disconnect the
slot is reused, so a held `Player` can act on whoever occupies the id
now. Act on one synchronously, or re-check
`ctx.player(p.id)?.steamId === p.steamId` after any await/delay (see
motd's delayed send and admin's leaver warning).

**Hooks and RPCs have fault backstops, not guarantees.** A lost `rpcres`
rejects after `VERGE_RPC_TIMEOUT_MS` (5 s); a hook handler that never
settles gets `res: null` sent for it after `VERGE_HOOK_DEADLINE_MS`
(5 s). The shim drops the connection outright at its ceilings (256
parked mutating RPCs, 512 KiB pending output, 1 MiB line).

## Compatibility

Release artifacts must keep loading on old server distributions. The
glibc floor (2.17) is pinned by `tools/build-shim.sh` rather than
inherited from the build host, and CI dlopens the result on images down
to glibc 2.17 (`centos:7`, the floor itself). Building on a modern image
without pinning silently produces a library that needs `GLIBC_2.34`. The
bundled `bun` is the baseline build for the same reason: the default one
needs AVX2.

## Releasing

Push a `v*` tag: `.github/workflows/release.yml` builds the tarball with
`tools/package-release.sh`, gates it (shim harness, runtime tests, the
packaged `.so` dlopened on the old-glibc matrix, the packaged runtime
booted to `hello` via `tests/release-smoke.ts`), and only then attaches
tarball + `SHA256SUMS` to the release, creating one if it does not exist
so notes can be written by hand first. `install.sh` is served from
`main`, so installer fixes ship without a new release; it verifies the
checksum and stages the unpack so a failed download can't half-update a
live install. Actions are pinned by commit SHA with the version in a
trailing comment.

## Conventions

- The project is `verge` everywhere in user-facing names, paths, env vars
  (`VERGE_*`), and database keys. Mentions of minqlx are kept only where
  they describe provenance or the Python-era API something was ported
  from — those are accurate history, not leftovers.
- Plugins are `export default { name, setup(ctx) } satisfies Plugin` and
  may import only types plus the pure modules (`constants.ts`, `util.ts`).
  Everything registered through `ctx` is tracked per-plugin so
  `!reload` can tear it down.
- Config lives in `verge.toml`; there are no `qlx_*` cvars.

## Verifying against a real server

Unit tests cannot cover pattern scanning or inline hooking. There is an
OrbStack VM (`orb -m minqlx-test`, amd64 Debian under emulation) with a
Steam QLDS in `~/qlds`. Deploy `bin/verge.x64.so` plus `bin/verge/` there
and run the `smoketest` plugin. Because it is emulated, set
`VERGE_HOOK_TIMEOUT_MS=1000`; the default 100 ms assumes native speed.

Verified there: all 15 smoke checks (including configstring bounds
rejection), plugin load, kill/respawn of the sidecar, and the ZMQ stats
feed.

## Known gaps

- The ban flow has never been exercised with a real Steam client —
  `!ban`, reconnect, rejection via the `player_connect` string result.
  Bots cannot test it.
- No soak test; every live run so far has been about two minutes.
- `VERGE_TRACE` recordings exist but nothing replays them yet.
- The engine-facing half of the shim (`core/`) has no automated tests,
  and its pattern offsets target specific QLDS builds.
- `console_print` subscribers can cancel but not replace output — the
  engine prints the original buffer regardless of a string result.
