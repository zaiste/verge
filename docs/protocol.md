# Shim ↔ Sidecar Protocol

The C shim inside `minqlx.x64.so` talks to the Bun sidecar over a Unix
domain socket using newline-delimited JSON (UTF-8; invalid engine bytes are
lossily replaced). The shim listens on `$MINQLX_SOCKET` (default
`minqlx.sock` in the server directory) and spawns/supervises the sidecar
(`bun minqlx/main.js`). Kill the sidecar and the server keeps running as
vanilla QLDS; the shim respawns it with exponential backoff (1s → 30s).

The authoritative message/type definitions live in
[`runtime/src/protocol.ts`](../runtime/src/protocol.ts).

## Messages

Sidecar → shim:

```jsonc
{"t":"hello","v":1,"subs":["client_command", ...],"frameEvery":0}
{"t":"hookres","id":412,"res":null}   // null=pass, false=cancel, "str"=replace
{"t":"rpc","id":77,"fn":"kick","args":[3,"bye"]}
```

Shim → sidecar:

```jsonc
{"t":"ev","name":"player_disconnect","args":[5,"was kicked."]}
{"t":"hook","id":412,"name":"client_command","args":[5,"say !kick 3"]}
{"t":"rpcres","id":77,"ok":true,"val":null}
{"t":"rpcres","id":78,"ok":false,"err":"client_id out of range"}
```

Nothing is dispatched before `hello`. `subs` lists the events the sidecar
wants; unsubscribed events aren't even serialized.

## Blocking hooks

Five events block the engine's main thread awaiting `hookres`:
`client_command`, `server_command`, `set_configstring`, `player_connect`
(string result = rejection message shown to the client), and
`console_print` (cancel only; replacement is ignored by the engine).
Everything else is fire-and-forget.

The wait is bounded by `MINQLX_HOOK_TIMEOUT_MS` (default 100 ms); on
timeout the engine proceeds as if the hook returned pass-through, and the
late reply is dropped. While waiting, the shim executes incoming `rpc`
messages — that's what lets a ban handler `kick()` synchronously from
inside the connect hook.

## Threading model

The engine is single-threaded and its functions are not thread-safe. The
shim therefore executes RPCs only on the engine's main thread, at two
points: while blocked in a hook, and when draining the socket at the top
of every `G_RunFrame` (~every 25 ms). An RPC sent from the sidecar
outside a hook simply lands on the next frame.

## Numbers

SteamID64 values exceed IEEE-754/JS safe-integer precision, so `steamId`
is always a **string** on the wire and in the runtime.

## Tracing

Set `MINQLX_TRACE=/path/to/session.jsonl` and the shim tees every
protocol line (with direction) to that file — useful for replaying real
sessions in tests.
