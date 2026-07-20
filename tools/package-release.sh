#!/bin/bash
# Builds a self-contained release tarball: minqlx-<version>-linux-x64.tar.gz
# Contents: minqlx.x64.so, bun binary, bundled runtime + plugins,
# minqlx.toml.example, run script. Run on (or cross-compile for) linux-x64.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(git describe --tags --always)
BUN_VERSION="${BUN_VERSION:-latest}"
LIBC="${LIBC:-glibc}" # or musl
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "Building minqlx.x64.so..."
make clean >/dev/null && make so

echo "Bundling runtime..."
(cd runtime && bun install --frozen-lockfile && bun run bundle)

echo "Fetching bun ($BUN_VERSION, $LIBC)..."
suffix=""
[ "$LIBC" = "musl" ] && suffix="-musl"
if [ "$BUN_VERSION" = "latest" ]; then
  url="https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64${suffix}.zip"
else
  url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64${suffix}.zip"
fi
curl -fsSL "$url" -o "$STAGE/bun.zip"
unzip -q "$STAGE/bun.zip" -d "$STAGE"
mv "$STAGE"/bun-linux-x64*/bun "$STAGE/bun"

echo "Staging..."
mkdir -p "$STAGE/pkg"
cp bin/minqlx.x64.so "$STAGE/pkg/"
cp -r bin/minqlx "$STAGE/pkg/minqlx"
cp "$STAGE/bun" "$STAGE/pkg/bun"
cp minqlx.toml.example "$STAGE/pkg/"
cp tools/minqlx-run.sh "$STAGE/pkg/"
chmod +x "$STAGE/pkg/bun" "$STAGE/pkg/minqlx-run.sh"

OUT="minqlx-${VERSION}-linux-x64${suffix}.tar.gz"
tar -czf "$OUT" -C "$STAGE/pkg" .
echo "Wrote $OUT"
