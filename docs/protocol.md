# Shim ↔ Sidecar Protocol

The C shim inside `verge.x64.so` talks to the Bun sidecar over a Unix
domain socket using newline-delimited JSON (UTF-8; invalid engine bytes are
lossily replaced). The shim listens on `$VERGE_SOCKET` (default
`verge.sock` in the server directory) and supervises the sidecar
(`bun verge/main.js`). Kill the sidecar and the server keeps running as
vanilla QLDS; it is respawned with exponential backoff (1s → 30s).

Supervision does not depend on engine frames (an idle QLDS stops running
them): a supervisor thread watches the socket, and sidecar processes are
created by a small single-threaded *spawn broker* forked at startup —
creating processes from the multithreaded engine later is unreliable, and
the broker also guarantees the sidecar dies with the server. RPCs received
off the engine's main thread are parked and executed on the next frame.

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
Everything else is fire-and-forget. `set_configstring` is only dispatched
when the value actually changes (the engine re-sets some indexes with
identical values every frame).

The wait is bounded by `VERGE_HOOK_TIMEOUT_MS` (default 100 ms); on
timeout the engine proceeds as if the hook returned pass-through, and the
late reply is dropped. While waiting, the shim executes incoming
**read-only** `rpc` messages (`player_info`, `get_cvar`, ...) — that's
what lets a hook handler look up state before answering.

## Threading model

The engine is single-threaded and its functions are not re-entrant:
running an arbitrary engine call while the engine is blocked inside a
hook dispatch can recurse engine→game→engine and corrupt state. RPCs are
therefore split into two classes:

- **Read-only** RPCs (no engine side effects) execute the moment they
  arrive on the engine's main thread — including inside a hook wait.
- **Mutating** RPCs are executed only at the top of `G_RunFrame`
  (~every 25 ms) — the same safe point Python minqlx's `@next_frame`
  used. When one arrives at an unsafe moment (inside a hook wait or
  another RPC), it is acknowledged immediately (`ok:true, val:null`) and
  parked; a handler awaiting it resolves right away and the call lands
  on the next frame. Order among parked RPCs is preserved. Consequence:
  a mutating RPC's return value is only meaningful when it executed
  directly (e.g. sent outside any hook context); don't read a mutating
  result from inside a hook handler.

A ban handler therefore rejects connects via the `player_connect` string
result (not a kick round-trip); a `kick()` issued from a hook handler is
acknowledged instantly and takes effect on the next frame.

## Numbers

SteamID64 values exceed IEEE-754/JS safe-integer precision, so `steamId`
is always a **string** on the wire and in the runtime.

## Tracing

Set `VERGE_TRACE=/path/to/session.jsonl` and the shim tees every
protocol line (with direction) to that file — useful for replaying real
sessions in tests.
