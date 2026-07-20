#!/bin/bash
# Launches QLDS with minqlx. Drop-in replacement for run_server_x64.sh.
cd "$(dirname "$0")"
export LD_PRELOAD=$LD_PRELOAD:./minqlx.x64.so
# The shim spawns the Bun sidecar itself; tune with env vars:
#   MINQLX_SOCKET, MINQLX_BUN, MINQLX_ENTRY, MINQLX_HOOK_TIMEOUT_MS,
#   MINQLX_NO_SPAWN (dev), MINQLX_TRACE (record protocol to a JSONL file)
LD_LIBRARY_PATH="./linux64:$LD_LIBRARY_PATH" exec ./qzeroded.x64 +set zmq_stats_enable 1 "$@"
