#!/bin/bash
# minqlx installer: downloads the release tarball into a QLDS directory.
#
#   curl -fsSL https://raw.githubusercontent.com/<repo>/master/tools/install.sh \
#     | bash -s -- /path/to/steamcmd/steamapps/common/qlds
#
# No python, no redis, no pip. Requires: curl, tar.
set -euo pipefail

REPO="${MINQLX_REPO:-zaiste/verge}"
QLDS_DIR="${1:-}"

if [ -z "$QLDS_DIR" ] || [ ! -x "$QLDS_DIR/qzeroded.x64" ]; then
  echo "Usage: install.sh /path/to/qlds  (directory containing qzeroded.x64)" >&2
  exit 1
fi

# Pick the artifact for this libc.
suffix=""
if ! ldd --version 2>&1 | grep -qi 'glibc\|gnu'; then
  suffix="-musl"
fi

echo "Fetching latest minqlx release from $REPO..."
url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
  grep -o "\"browser_download_url\": *\"[^\"]*linux-x64${suffix}\.tar\.gz\"" |
  head -1 | cut -d'"' -f4)
if [ -z "$url" ]; then
  echo "Could not find a linux-x64${suffix} release asset for $REPO." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/minqlx.tar.gz"
tar -xzf "$tmp/minqlx.tar.gz" -C "$QLDS_DIR"

# First-time config.
if [ ! -f "$QLDS_DIR/minqlx.toml" ]; then
  if [ -t 0 ]; then
    read -rp "Owner SteamID64 (find yours at steamid.io): " owner
  else
    owner="${MINQLX_OWNER:-}"
  fi
  sed "s/76561198000000000/${owner:-76561198000000000}/" \
    "$QLDS_DIR/minqlx.toml.example" > "$QLDS_DIR/minqlx.toml"
  echo "Wrote $QLDS_DIR/minqlx.toml"
fi

echo
echo "Done! Start the server with:"
echo "  $QLDS_DIR/minqlx-run.sh +set net_port 27960 +exec server.cfg"
