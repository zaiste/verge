# Configuration

All configuration lives in one file, `verge.toml`, next to the server
binary (see [`verge.toml.example`](../verge.toml.example)). The old
Python-era `qlx_*` cvars are gone.

Environment overrides: `VERGE_OWNER`, `VERGE_PLUGINS` (comma-separated),
`VERGE_DATABASE`, `VERGE_CONFIG` (path to the TOML file).

Shim-level (engine side) settings are environment variables only, set
before launching the server: `VERGE_SOCKET`, `VERGE_BUN`, `VERGE_ENTRY`,
`VERGE_HOOK_TIMEOUT_MS`, `VERGE_NO_SPAWN`, `VERGE_TRACE`.

Sidecar fault backstops (rarely need touching): `VERGE_RPC_TIMEOUT_MS`
(default 5000; reject an RPC whose reply never comes) and
`VERGE_HOOK_DEADLINE_MS` (default 5000; reply pass-through for a hook
handler that never settles).

## qlx_* cvar → verge.toml mapping

| Old cvar | New setting |
|---|---|
| `qlx_owner` | `[server] owner` |
| `qlx_plugins` | `[server] plugins` |
| `qlx_pluginsPath` | dropped (plugins live in `verge/plugins/`; override with `VERGE_PLUGINS_DIR`) |
| `qlx_database` | dropped (always SQLite) |
| `qlx_redisAddress` / `qlx_redisDatabase` / `qlx_redisUnixSocket` / `qlx_redisPassword` | dropped (Redis removed; see `tools/migrate-redis.ts`) |
| `qlx_commandPrefix` | `[server] command_prefix` |
| `qlx_logs` / `qlx_logsSize` | `[plugin.log]` section |
| `qlx_votepass` | `[plugin.admin] vote_pass` |
| `qlx_votepassThreshold` | `[plugin.admin] vote_pass_threshold` |
| `qlx_teamsizeMinimum` / `qlx_teamsizeMaximum` | `[plugin.admin] teamsize_minimum` / `teamsize_maximum` |
| `qlx_leaverBan` + `qlx_leaverBan*` thresholds | `[plugin.admin] leaver_ban` + `leaver_*` keys |
| `qlx_enforceSteamName` | `[plugin.identity] enforce_steam_name` |
| `qlx_motd` / `qlx_motdSound` / `qlx_motdHeader` | `[plugin.motd]` section (motd text itself is stored in the database via `!setmotd`) |
| `qlx_balanceUrl` | `[plugin.balance] api_url` |
| `qlx_balanceAuto` | `[plugin.balance] auto_balance` |
| `qlx_balance*` (rest) | `[plugin.balance]` snake_case keys |
| `qlx_funSoundDelay` | `[plugin.fun] sound_delay` |
| `qlx_workshopReferences` | `[plugin.features] workshop` |
| `qlx_stats*` / `zmq_stats_password` | `[stats]` section (the engine-side `zmq_stats_enable 1` stays in the launch command) |
| `qlx_perm_<cmd>` / `qlx_ccmd_perm_<cmd>` overrides | dropped (edit the plugin config instead) |

Per-plugin keys are documented in a comment at the top of each plugin
file in [`plugins/`](../plugins/).

## Permissions

Levels 0–5, stored in the database (`!setperm <id> <level>`). The
`[server] owner` SteamID64 always has level 5. Level meanings follow the
old convention: 0 everyone, 1–4 increasing mod/admin tiers, 5 owner-level.
