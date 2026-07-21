#!/bin/bash
# verge installer: downloads the release tarball into a QLDS directory.
#
#   curl -fsSL https://raw.githubusercontent.com/zaiste/verge/main/tools/install.sh \
#     | bash -s -- /path/to/steamcmd/steamapps/common/qlds
#
# No python, no redis, no pip. Requires: curl, tar.
set -euo pipefail

REPO="${VERGE_REPO:-zaiste/verge}"
QLDS_DIR="${1:-}"

if [ -z "$QLDS_DIR" ] || [ ! -x "$QLDS_DIR/qzeroded.x64" ]; then
  echo "Usage: install.sh /path/to/qlds  (directory containing qzeroded.x64)" >&2
  exit 1
fi

# QLDS is a glibc binary, so the shim is built against glibc too. Match on
# a captured string rather than a pipeline: under `set -o pipefail`, grep -q
# exiting on the first match can SIGPIPE ldd and fail the whole pipeline,
# which warned on perfectly good glibc systems.
libc=$(ldd --version 2>&1 || true)
case "$libc" in
  *GLIBC*|*glibc*|*GNU*|*gnu*) ;;
  *)
    echo "Warning: no glibc detected. QLDS itself needs glibc; if the server" >&2
    echo "runs here through a compatibility layer, verge should too." >&2
    ;;
esac

echo "Fetching latest verge release from $REPO..."
url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
  grep -o "\"browser_download_url\": *\"[^\"]*linux-x64\.tar\.gz\"" |
  head -1 | cut -d'"' -f4)
if [ -z "$url" ]; then
  echo "Could not find a linux-x64 release asset for $REPO." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/verge.tar.gz"
tar -xzf "$tmp/verge.tar.gz" -C "$QLDS_DIR"

# First-time config.
if [ ! -f "$QLDS_DIR/verge.toml" ]; then
  owner="${VERGE_OWNER:-}"
  # Under `curl | bash` stdin is the script itself, so ask the terminal.
  if [ -z "$owner" ] && [ -r /dev/tty ]; then
    read -rp "Owner SteamID64 (find yours at steamid.io): " owner < /dev/tty || true
  fi
  sed "s/76561198000000000/${owner:-76561198000000000}/" \
    "$QLDS_DIR/verge.toml.example" > "$QLDS_DIR/verge.toml"
  echo "Wrote $QLDS_DIR/verge.toml"
  [ -z "$owner" ] &&
    echo "No owner set: put your SteamID64 in $QLDS_DIR/verge.toml before starting." >&2
fi

echo
echo "Done! Start the server with:"
echo "  $QLDS_DIR/verge-run.sh +set net_port 27960 +exec server.cfg"
