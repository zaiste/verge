# verge

Server-side mod for the Quake Live Dedicated Server: admin & chat
commands, bans, permissions, team balancing, MOTD, vote control — with
plugins written in **TypeScript** on [Bun](https://bun.sh) and **zero
external services**: no Python, no Redis, no pip. One config file, one
SQLite database, one install command.

verge is a modern rewrite of [minqlx](https://github.com/MinoMino/minqlx)'s
scripting stack; the battle-tested C hooking core is inherited from it.

## How it works

```
qzeroded.x64  ←LD_PRELOAD─  verge.x64.so (C shim)
                                 │  unix socket, JSON lines
                                 ▼
                            bun (sidecar) ── runtime + plugins (TypeScript)
                                 │
                            verge.db (SQLite)
```

The `.so` inline-hooks the closed-source server binary and forwards engine
events over a Unix socket to a supervised Bun process hosting the plugins.
Plugin crashes can never corrupt engine memory: if the sidecar dies, the
server keeps running as vanilla QLDS and the sidecar respawns
automatically. Blocking hooks are bounded by a hard timeout, so the engine
can never stall. Details in [docs/protocol.md](docs/protocol.md).

## Install

Into an existing [QLDS installation](https://steamdb.info/app/349090/):

```sh
curl -fsSL https://raw.githubusercontent.com/zaiste/verge/main/tools/install.sh \
  | bash -s -- /path/to/steamcmd/steamapps/common/qlds
```

That unpacks the shim, a `bun` binary, the bundled runtime and plugins,
and writes `verge.toml` (it asks for your SteamID64 — you're the owner).
Launch:

```sh
./verge-run.sh +set net_port 27960 +exec server.cfg
```

### From source

```sh
git clone https://github.com/zaiste/verge && cd verge
make so                                # needs only gcc + libc
cd runtime && bun install && bun run bundle && cd ..
cp bin/verge.x64.so tools/verge-run.sh verge.toml.example /path/to/qlds/
cp -r bin/verge /path/to/qlds/verge
```

On non-Linux hosts: `make CC="zig cc -target x86_64-linux-gnu" so`.

`make so` links against the build host's glibc, which is fine for a shim
you built on the machine that will run it. Release artifacts are built
with `tools/build-shim.sh` instead: it pins the glibc floor (2.17) so the
library loads on older server distributions, and fails if anything
creeps above it.

## Use

Configuration lives in one file, [`verge.toml`](verge.toml.example):
owner, plugin list, per-plugin settings. Env vars (`VERGE_*`) override.
Coming from Python-era `qlx_*` cvars? See the
[mapping table](docs/config.md). Migrating a Redis database:
`bun tools/migrate-redis.ts redis://localhost:6379 verge.db`.

In-game, commands start with `!` (permission levels 0–5, owner is 5):
`!kick`, `!ban 3 2 weeks flaming`, `!mute`, `!setperm`, `!teams`,
`!map`, ... — `!help` lists them. From the server console, `verge !cmd`
runs any command as owner; `vergerestart` restarts the sidecar.

Bundled plugins, the classic set consolidated:

| Plugin | Provides |
|---|---|
| `admin` | ~35 moderation commands, permissions, bans/silences, vote auto-pass, leaver bans |
| `identity` | `!name` display names, persistent clan tags |
| `motd` | Message of the day on join |
| `balance` | Elo-based `!teams` / `!balance` via qlstats |
| `log` | Chat/command logs with rotation |
| `fun` | Chat-triggered sounds |

`workshop` and `solorace` are config flags (`[plugin.features]`). Manage
at runtime with `!load` / `!unload` / `!reload <plugin>`.

## Write a plugin

Drop a file in `verge/plugins/` and add it to the config:

```ts
import type { Plugin } from "../runtime/src/plugin";

export default {
  name: "hello",
  setup(ctx) {
    ctx.on("player_loaded", (player) => player.tell("Welcome!"));
    ctx.command("hi", { permission: 0 }, (player, _args, channel) =>
      channel.reply(`Hi, ${player.cleanName}!`),
    );
  },
} satisfies Plugin;
```

The full API is typed: [`runtime/src/plugin.ts`](runtime/src/plugin.ts)
(context), [`runtime/src/events.ts`](runtime/src/events.ts) (events).
`!reload hello` picks up edits live.

## Test without a game server

The runtime is plain Bun code; the testkit implements the same engine
interface in-process, so plugins run in the production runtime with the
engine faked underneath:

```ts
const server = await createTestServer({ plugins: ["admin"] });
const { info } = await server.connect({ name: "Keel" });
await server.chat(info.clientId, "!ban 0 1 day spam");
```

```sh
bun test                     # plugins and runtime, no QLDS needed
make check-shim              # the C IPC layer against a real sidecar
cd runtime && bun run typecheck
```

A bot-driven end-to-end scenario ships as the `smoketest` plugin, and CI
checks that the release actually loads on distributions as old as glibc
2.28. See [docs/testing.md](docs/testing.md) for all four levels.

Against a real server: launch with `VERGE_NO_SPAWN=1` and run
`bun --watch runtime/src/main.ts` — the runtime reconnects on every edit.
`VERGE_TRACE=session.jsonl` records all shim↔sidecar traffic.

## License

GPLv3. The C hooking core originates from
[Mino's minqlx](https://github.com/MinoMino/minqlx); the scripting stack
is a ground-up rewrite.
