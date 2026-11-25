#!/usr/bin/env bash
# Downloads the official Real-ESRGAN ncnn-vulkan engine (v0.2.5.0) for macOS or Linux,
# verifies its SHA-256 and installs it where Tauri expects it:
#   src-tauri/binaries/realesrgan-ncnn-vulkan-<rust host triple>   (Tauri sidecar naming)
#   src-tauri/resources/models/*.param, *.bin                       (bundled as <resource_dir>/models)
# Idempotent: does nothing when the engine is already installed from the same archive.
# Usage: scripts/fetch-engine.sh [--force]      (TARGET_TRIPLE=... overrides the detected triple)
set -euo pipefail

VERSION="v0.2.5.0"
BUILD="20220424"
BASE_URL="https://github.com/xinntao/Real-ESRGAN/releases/download/${VERSION}"

# SHA-256 of the official release zips, recorded from the first download (2026-11-25).
SHA_MACOS="e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a"
SHA_UBUNTU="e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
MODELS_DIR="$ROOT/src-tauri/resources/models"
MODELS=(realesrgan-x4plus realesrgan-x4plus-anime realesr-animevideov3-x2 realesr-animevideov3-x3 realesr-animevideov3-x4)

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

log() { printf '[fetch-engine] %s\n' "$*"; }
die() { printf '[fetch-engine] ERROR: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS="macos";  SHA="$SHA_MACOS" ;;
  Linux)  OS="ubuntu"; SHA="$SHA_UBUNTU" ;;
  *) die "unsupported OS $(uname -s); on Windows use scripts/fetch-engine.ps1" ;;
esac

# Rust host triple (Tauri looks for binaries/<name>-<triple>).
if [[ -z "${TARGET_TRIPLE:-}" ]]; then
  RUSTC="$(command -v rustc || true)"
  [[ -z "$RUSTC" && -x "$HOME/.cargo/bin/rustc" ]] && RUSTC="$HOME/.cargo/bin/rustc"
  [[ -n "$RUSTC" ]] || die "rustc not found (install Rust via rustup, or set TARGET_TRIPLE)"
  TARGET_TRIPLE="$("$RUSTC" -vV | sed -n 's/^host: //p')"
fi
[[ -n "$TARGET_TRIPLE" ]] || die "could not detect the Rust host triple"

ZIP_NAME="realesrgan-ncnn-vulkan-${BUILD}-${OS}.zip"
BIN_PATH="$BIN_DIR/realesrgan-ncnn-vulkan-${TARGET_TRIPLE}"
STAMP="$BIN_DIR/.engine-${TARGET_TRIPLE}.stamp"
STAMP_VALUE="${ZIP_NAME} ${SHA}"

installed() {
  [[ -x "$BIN_PATH" && -f "$STAMP" && "$(cat "$STAMP")" == "$STAMP_VALUE" ]] || return 1
  local m
  for m in "${MODELS[@]}"; do
    [[ -s "$MODELS_DIR/$m.param" && -s "$MODELS_DIR/$m.bin" ]] || return 1
  done
}

if [[ $FORCE -eq 0 ]] && installed; then
  log "already installed: $(basename "$BIN_PATH") + ${#MODELS[@]} models (use --force to reinstall)"
  exit 0
fi

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# The zip is cached so a reinstall does not download 50 MB again.
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/rodo-upscale"
mkdir -p "$CACHE_DIR"
ZIP="$CACHE_DIR/$ZIP_NAME"
if [[ ! -f "$ZIP" || "$(sha256 "$ZIP")" != "$SHA" ]]; then
  log "downloading $ZIP_NAME"
  curl -fL --retry 3 --progress-bar -o "$ZIP.part" "$BASE_URL/$ZIP_NAME"
  mv "$ZIP.part" "$ZIP"
fi
ACTUAL="$(sha256 "$ZIP")"
if [[ "$ACTUAL" != "$SHA" ]]; then
  rm -f "$ZIP"
  die "SHA-256 mismatch for $ZIP_NAME: expected $SHA, got $ACTUAL"
fi
log "SHA-256 OK ($SHA)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP"
# Releases put files at the zip root; tolerate a single top-level folder too.
SRC="$(dirname "$(find "$TMP" -type f -name realesrgan-ncnn-vulkan | head -n1)")"
[[ -f "$SRC/realesrgan-ncnn-vulkan" ]] || die "engine binary not found in $ZIP_NAME"

mkdir -p "$BIN_DIR" "$MODELS_DIR"
install -m 755 "$SRC/realesrgan-ncnn-vulkan" "$BIN_PATH"
if [[ "$OS" == "macos" ]]; then
  # curl does not set the quarantine flag, but strip it in case the zip came from a browser.
  xattr -d com.apple.quarantine "$BIN_PATH" 2>/dev/null || true
fi

find "$MODELS_DIR" -maxdepth 1 -type f \( -name '*.param' -o -name '*.bin' \) -delete
cp "$SRC"/models/*.param "$SRC"/models/*.bin "$MODELS_DIR/"

printf '%s' "$STAMP_VALUE" > "$STAMP"
installed || die "installation incomplete (missing binary or models)"

# -h prints the usage and exits non-zero, so check the text, not the exit code.
HELP="$("$BIN_PATH" -h 2>&1 || true)"
if [[ "$HELP" == *"Usage: realesrgan-ncnn-vulkan"* ]]; then
  log "engine runs: $BIN_PATH"
else
  die "engine installed but '$(basename "$BIN_PATH") -h' did not print its usage"
fi
log "models in $MODELS_DIR: ${MODELS[*]}"
