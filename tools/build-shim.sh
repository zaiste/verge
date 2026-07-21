#!/bin/bash
# Builds verge.x64.so for release, pinned to an old glibc.
#
# The shim is loaded into QLDS on whatever distribution the server admin
# runs, which is routinely older than any current CI image. Linking against
# the build host's glibc would bake that host's symbol versions into the
# artifact -- building on glibc 2.39, for instance, yields a library that
# needs GLIBC_2.34 and so refuses to load on Debian 11 or RHEL 8. zig cc
# lets us name the floor instead of inheriting it, and the check below
# fails the build if anything creeps above it.
set -euo pipefail
cd "$(dirname "$0")/.."

GLIBC_FLOOR="${GLIBC_FLOOR:-2.17}"

if ! command -v zig >/dev/null; then
  echo "zig is required (https://ziglang.org/download/)." >&2
  exit 1
fi

make so CC="zig cc -target x86_64-linux-gnu.${GLIBC_FLOOR}"

SO=bin/verge.x64.so
if command -v objdump >/dev/null; then
  max=$(objdump -T "$SO" | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1)
  highest=$(printf '%s\nGLIBC_%s\n' "$max" "$GLIBC_FLOOR" | sort -V | tail -1)
  if [ "$highest" != "GLIBC_$GLIBC_FLOOR" ]; then
    echo "$SO requires $max, above the GLIBC_$GLIBC_FLOOR floor." >&2
    exit 1
  fi
  echo "$SO: glibc floor $max (limit GLIBC_$GLIBC_FLOOR)"
else
  echo "objdump not found; skipping the glibc floor check." >&2
fi
