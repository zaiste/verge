# minqlx

minqlx extends the Quake Live Dedicated Server with administration and
scripting: chat commands, bans, permissions, team balancing, MOTD, vote
control, and a modern plugin API — now in **TypeScript**, running on
[Bun](https://bun.sh), with **zero external services** (no Python, no
Redis, no pip).

## How it works

```
qzeroded.x64  ←LD_PRELOAD─  minqlx.x64.so (C shim)
                                 │  unix socket, JSON lines
                                 ▼
                            bun (sidecar) ── runtime + plugins (TypeScript)
                                 │
                            minqlx.db (SQLite)
```

The `.so` inline-hooks the closed-source server (byte-pattern scanning +
trampolines) and forwards engine events over a Unix socket to a supervised
Bun process hosting the plugins. Plugin crashes can never corrupt engine
memory: if the sidecar dies, the server keeps running as vanilla QLDS and
the sidecar is respawned automatically. Blocking hooks (chat filtering,
connect rejection) are bounded by a hard timeout, so the engine can never
stall. See [docs/protocol.md](docs/protocol.md).

## Install

Into an existing [QLDS installation](https://steamdb.info/app/349090/):

```sh
curl -fsSL https://raw.githubusercontent.com/MinoMino/minqlx/master/tools/install.sh \
  | bash -s -- /path/to/steamcmd/steamapps/common/qlds
```

That unpacks `minqlx.x64.so`, a `bun` binary, the bundled runtime and
plugins, and writes `minqlx.toml` (it asks for your SteamID64 — you're the
owner). Then launch with:

```sh
./minqlx-run.sh +set net_port 27960 +exec server.cfg
```

### From source

```sh
git clone <this repo> && cd minqlx
make so                                # needs only gcc + libc
cd runtime && bun install && bun run bundle
cp bin/minqlx.x64.so tools/minqlx-run.sh minqlx.toml.example /path/to/qlds/
cp -r bin/minqlx /path/to/qlds/minqlx
```

## Configure

Everything is in one file: [`minqlx.toml`](minqlx.toml.example) — owner,
plugin list, per-plugin settings. Coming from the Python-era `qlx_*`
cvars? See the [mapping table](docs/config.md). Migrating an existing
Redis database: `bun tools/migrate-redis.ts redis://localhost:6379 minqlx.db`.

## Plugins

The classic plugin set, consolidated:

| Plugin | Provides |
|---|---|
| `admin` | ~35 admin commands (kick/ban/tempban/mute/silence/put/map/...), permissions (`!setperm`), vote auto-pass, teamsize vote bounds, leaver bans |
| `identity` | `!name` display names, persistent clan tags |
| `motd` | Message of the day on join |
| `balance` | Elo-based `!teams` / `!balance` via qlstats |
| `log` | Chat/command logs with rotation |
| `fun` | Chat-triggered sounds |

`workshop` and `solorace` became config flags (`[plugin.features]`).
Manage at runtime with `!load` / `!unload` / `!reload <plugin>`.

### Writing a plugin

Drop a file in `minqlx/plugins/` and add it to the config:

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

The full API is typed — see [`runtime/src/plugin.ts`](runtime/src/plugin.ts)
(context) and [`runtime/src/events.ts`](runtime/src/events.ts) (events).
`!reload hello` picks up edits live.

## Test without a game server

The runtime is plain Bun code; the testkit fakes the engine in-process:

```ts
const server = await createTestServer({ plugins: ["admin"] });
const { info } = await server.connect({ name: "Keel" });
await server.chat(info.clientId, "!ban 0 1 day spam");
```

```sh
bun test                # runs everything, no QLDS needed
cd runtime && bun run typecheck
```

Dev loop against a real server: launch with `MINQLX_NO_SPAWN=1`, then run
`bun --watch runtime/src/main.ts` in another terminal — the runtime
reconnects to the live server on every edit.

## Development

- `make so` — build the shim (`make nopy` builds the hook core with no
  sidecar at all, as a diagnostic baseline)
- On non-Linux hosts: `make CC="zig cc -target x86_64-linux-gnu" so`
- `MINQLX_TRACE=session.jsonl` records all shim↔sidecar traffic
- Console commands: `qlx <cmd>` (rcon as owner), `qlxrestart` (restart the
  sidecar)

minqlx is GPLv3. It began as [Mino's Python-based minqlx](https://github.com/MinoMino/minqlx);
the C hooking core is inherited from it, the scripting stack is a rewrite.
