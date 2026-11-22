#!/bin/bash
# SCS.2 video encoder - double-click this on a Mac.
#
# It makes sure Node and ffmpeg are available (downloading them into
# ~/.scs2-encoder if this computer does not already have them, no
# installer and no sudo), asks once for the worker address and the
# encoder key, and then runs encoder.mjs from this same folder.
#
# Run it again any time. Pass --reconfigure to be asked for the
# address and key again.

set -u

HOME_DIR="$HOME/.scs2-encoder"
NODE_VERSION="v22.11.0"
OLD_CONFIG="$HOME_DIR/config"
API_FILE="$HOME_DIR/address"
KEY_FILE="$HOME_DIR/key"

# (a) this script's own folder, so encoder.mjs beside it is found
# however it was launched
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/encoder.mjs"

fail() {
  echo ""
  echo "$1"
  echo ""
  echo "Press return to close this window."
  read -r _ || true
  exit 1
}

if [ ! -f "$RUNNER" ]; then
  fail "encoder.mjs is not in this folder. Keep scs-encoder.command and encoder.mjs together."
fi

mkdir -p "$HOME_DIR/bin" || fail "Could not make $HOME_DIR."

case "$(uname -m)" in
  arm64) NODE_ARCH="darwin-arm64"; FF_ARCH="arm64" ;;
  x86_64) NODE_ARCH="darwin-x64"; FF_ARCH="amd64" ;;
  *) fail "This launcher handles Intel and Apple Silicon Macs only. Install node and ffmpeg yourself, then run: node encoder.mjs" ;;
esac

echo "SCS.2 video encoder"
echo ""

# ---------- (b) Node ----------

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -ge 18 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    echo "Using the Node already on this computer ($(node -v))."
  fi
fi

if [ -z "$NODE_BIN" ]; then
  OWN_NODE="$HOME_DIR/node/node-$NODE_VERSION-$NODE_ARCH/bin/node"
  if [ -x "$OWN_NODE" ]; then
    NODE_BIN="$OWN_NODE"
    echo "Using the Node downloaded here earlier."
  else
    echo "Downloading Node $NODE_VERSION (about 40 MB, once)."
    mkdir -p "$HOME_DIR/node"
    TARBALL="$HOME_DIR/node/node.tar.gz"
    if ! curl -fL --progress-bar -o "$TARBALL" \
      "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_ARCH.tar.gz"; then
      fail "Could not download Node. Install it from nodejs.org, then run this again."
    fi
    if ! tar -xzf "$TARBALL" -C "$HOME_DIR/node"; then
      fail "The Node download would not unpack. Delete $HOME_DIR/node and try again."
    fi
    rm -f "$TARBALL"
    NODE_BIN="$OWN_NODE"
    [ -x "$NODE_BIN" ] || fail "Node did not unpack where it was expected."
    echo "Node is ready."
  fi
fi

# ---------- (c) ffmpeg and ffprobe ----------

get_ffmpeg_tool() {
  # $1 = ffmpeg or ffprobe
  local tool="$1"
  local target="$HOME_DIR/bin/$tool"
  if [ -x "$target" ]; then
    echo "$target"
    return 0
  fi
  local zip="$HOME_DIR/bin/$tool.zip"
  if ! curl -fL --progress-bar -o "$zip" \
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$FF_ARCH/release/$tool.zip" >&2; then
    return 1
  fi
  if ! unzip -o -q "$zip" -d "$HOME_DIR/bin" >&2; then
    rm -f "$zip"
    return 1
  fi
  rm -f "$zip"
  chmod +x "$target" 2>/dev/null
  [ -x "$target" ] || return 1
  echo "$target"
}

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  FFMPEG="$(command -v ffmpeg)"
  FFPROBE="$(command -v ffprobe)"
  echo "Using the ffmpeg already on this computer."
else
  echo "Downloading ffmpeg (about 80 MB, once)."
  FFMPEG="$(get_ffmpeg_tool ffmpeg)" || \
    fail "Could not download ffmpeg. Install it yourself with: brew install ffmpeg"
  FFPROBE="$(get_ffmpeg_tool ffprobe)" || \
    fail "Could not download ffprobe. Install it yourself with: brew install ffmpeg"
  echo "ffmpeg is ready."
fi

# ---------- (d) the worker address and the key ----------
#
# Each answer gets a file of its own holding that value and nothing
# else. An earlier version wrote both into one file of shell
# assignments that this script then sourced, so a key containing a
# quote came back short or ran as a command.

RECONFIGURE=0
for arg in "$@"; do
  [ "$arg" = "--reconfigure" ] && RECONFIGURE=1
done

if [ -f "$OLD_CONFIG" ]; then
  rm -f "$OLD_CONFIG"
  RECONFIGURE=1
  echo "The settings on this computer were saved in an older format that could"
  echo "store the key wrongly, so they need typing once more."
fi
[ -s "$API_FILE" ] || RECONFIGURE=1
[ -s "$KEY_FILE" ] || RECONFIGURE=1

if [ "$RECONFIGURE" -eq 1 ]; then
  echo ""
  echo "Two questions, once. They are kept in $HOME_DIR on this computer."
  DEFAULT_API="https://files.scs.andyrew.space"
  TYPED_API=""
  TYPED_KEY=""
  printf "Worker address [%s]: " "$DEFAULT_API"
  read -r TYPED_API || true
  [ -z "$TYPED_API" ] && TYPED_API="$DEFAULT_API"
  printf "Encoder key (it will not show as you type): "
  read -rs TYPED_KEY || true
  echo ""
  [ -z "$TYPED_KEY" ] && fail "No key, no encoding. Ask the tab team for the encoder key and run this again."
  umask 077
  # printf writes the value and no line ending, so it comes back exactly
  printf '%s' "$TYPED_API" > "$API_FILE"
  printf '%s' "$TYPED_KEY" > "$KEY_FILE"
  chmod 600 "$API_FILE" "$KEY_FILE"
  TYPED_KEY=""
  echo "Saved."
fi

# read back from disk even on the run that saved them, so a value that
# did not survive is caught now rather than next time
TAB_API="$(cat "$API_FILE" 2>/dev/null || true)"
ENCODER_KEY="$(cat "$KEY_FILE" 2>/dev/null || true)"

if [ -z "$TAB_API" ] || [ -z "$ENCODER_KEY" ]; then
  fail "The saved settings could not be read. Run this again with --reconfigure."
fi

# ---------- (e) run it ----------

echo ""
export TAB_API ENCODER_KEY FFMPEG FFPROBE
exec "$NODE_BIN" "$RUNNER"
