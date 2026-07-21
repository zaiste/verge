#!/bin/bash
# Launches QLDS with verge. Drop-in replacement for run_server_x64.sh.
cd "$(dirname "$0")"
export LD_PRELOAD=$LD_PRELOAD:./verge.x64.so
# The shim spawns the Bun sidecar itself; tune with env vars:
#   VERGE_SOCKET, VERGE_BUN, VERGE_ENTRY, VERGE_HOOK_TIMEOUT_MS,
#   VERGE_NO_SPAWN (dev), VERGE_TRACE (record protocol to a JSONL file)
LD_LIBRARY_PATH="./linux64:$LD_LIBRARY_PATH" exec ./qzeroded.x64 +set zmq_stats_enable 1 "$@"
