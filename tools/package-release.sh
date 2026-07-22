#!/bin/bash
# Builds a self-contained release tarball: verge-<version>-linux-x64.tar.gz
# Contents: verge.x64.so, bun binary, bundled runtime + plugins,
# verge.toml.example, run script. Run on (or cross-compile for) linux-x64.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(git describe --tags --always)
BUN_VERSION="${BUN_VERSION:-latest}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "Building verge.x64.so..."
make clean >/dev/null && tools/build-shim.sh

echo "Bundling runtime..."
(cd runtime && bun install --frozen-lockfile && bun run bundle)

# The baseline build runs without AVX2. Bun's default build does not, and
# on a CPU that lacks it the sidecar dies with a bare SIGILL that looks
# like a verge bug; the sidecar shuttles JSON, so the speed it gives up is
# not worth that failure mode. Same reasoning as the glibc floor.
echo "Fetching bun ($BUN_VERSION, baseline)..."
if [ "$BUN_VERSION" = "latest" ]; then
  url="https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64-baseline.zip"
else
  url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip"
fi
curl -fsSL "$url" -o "$STAGE/bun.zip"
unzip -q "$STAGE/bun.zip" -d "$STAGE"
mv "$STAGE"/bun-linux-x64*/bun "$STAGE/bun"

echo "Staging..."
mkdir -p "$STAGE/pkg"
cp bin/verge.x64.so "$STAGE/pkg/"
cp -r bin/verge "$STAGE/pkg/verge"
cp "$STAGE/bun" "$STAGE/pkg/bun"
cp verge.toml.example "$STAGE/pkg/"
cp tools/verge-run.sh "$STAGE/pkg/"
cp LICENSE README.md "$STAGE/pkg/"
chmod +x "$STAGE/pkg/bun" "$STAGE/pkg/verge-run.sh"

OUT="verge-${VERSION}-linux-x64.tar.gz"
# --no-xattrs: macOS tar otherwise embeds provenance attributes that make
# GNU tar warn on every entry at extraction time.
tar --no-xattrs -czf "$OUT" -C "$STAGE/pkg" .

# Checksums, published alongside the tarball and verified by install.sh.
if command -v sha256sum >/dev/null; then
  sha256sum "$OUT" > SHA256SUMS
else
  shasum -a 256 "$OUT" > SHA256SUMS
fi
echo "Wrote $OUT"
