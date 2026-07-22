# Porting from minqlx

What the Python stack became. The C hooking core is inherited unchanged;
everything above the dispatchers was rewritten.

## Modules

| minqlx (Python/C) | verge |
|---|---|
| `python_embed.c` (engine calls) | `shim/shim_rpc.c` (42 RPCs) |
| `python_dispatchers.c` | `shim/shim_dispatch.c` |
| `pyminqlx.h` | `shim/dispatch.h` |
| — | `shim/shim_ipc.c` (socket, supervision, spawn broker) |
| `_events.py` | `runtime/src/events.ts` |
| `_handlers.py` | `runtime/src/pipeline.ts` |
| `_player.py` / `_game.py` | `runtime/src/players.ts` / `game.ts` |
| `_commands.py` | `runtime/src/commands.ts` + `channels.ts` |
| `_core.py` | `runtime/src/runtime.ts` + `main.ts` |
| `_zmq.py` | `runtime/src/zmtp.ts` + `stats.ts` |
| Redis database | `runtime/src/db.ts` (SQLite, `verge:` keys) |

## Plugins

`essentials` + `ban` + `silence` + `permission` → **admin**;
`names` + `clan` → **identity**; `motd`, `balance`, `log`, `fun` kept as
they were. `workshop` and `solorace` became `[plugin.features]` flags.
Dropped: `irc`, `raw`, `docs`, `textart`, `plugin_manager`.

## Plugin API

A plugin is a value, not a subclass, and everything registered through
`ctx` is tracked so `!reload` can tear it down.

| minqlx | verge |
|---|---|
| `class X(minqlx.Plugin)` | `export default { name, setup(ctx) } satisfies Plugin` |
| `self.add_hook("chat", f)` | `ctx.on("chat", f)` |
| `self.add_command("kick", f, 2)` | `ctx.command("kick", { permission: 2 }, f)` |
| `self.players()` | `ctx.players()` |
| `self.msg(...)` / `player.tell(...)` | `ctx.msg(...)` / `player.tell(...)` |
| `self.get_cvar("qlx_foo")` | `ctx.config.foo` (from `verge.toml`) |
| `self.db[key]` | `ctx.db.get(key)` / `.set(key, v, { ttl })` |
| `@minqlx.delay(2)` | `ctx.delay(2000, fn)` |
| `@minqlx.thread` | `async` / `await` |
| `@minqlx.next_frame` | not needed — see [protocol.md](protocol.md) |
| `minqlx.RET_STOP_EVENT` | `EventResult.StopEvent` |

`RET_NONE`/`STOP`/`STOP_EVENT`/`STOP_ALL`/`USAGE` map one-to-one onto
`EventResult.None`/`Stop`/`StopEvent`/`StopAll`/`Usage`, and raw hook
returns keep their meaning: `false` cancels, a string replaces.

## Data and config

`qlx_*` cvars → `verge.toml`, mapped row by row in
[config.md](config.md). An existing Redis database imports with
`bun tools/migrate-redis.ts <redis-url> verge.db`, which rewrites the
`minqlx:` key prefix to `verge:` and preserves TTLs. Bans and silences
change shape: ban.py/silence.py stored a zset of ids plus a hash per id,
verge stores one JSON record with a TTL — the migrator converts the
longest still-active entry per player and drops expired history. Other
non-string keys (third-party plugin data) are reported, not migrated.
