#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/manifest.json').version")"
OUT="$ROOT/dist"
ZIP="$OUT/framecue-v${VERSION}.zip"
STAGE="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p "$OUT"

# dist is an output directory, not an unpacked copy of the extension.
find "$OUT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# The staging directory itself becomes the ZIP root. Keep only the files that
# Chrome needs at runtime; development metadata does not belong in the package.
rsync -a \
  "$ROOT/manifest.json" \
  "$ROOT/popup.html" \
  "$ROOT/popup.css" \
  "$ROOT/popup.js" \
  "$ROOT/options.html" \
  "$ROOT/options.css" \
  "$ROOT/options.js" \
  "$STAGE/"

rsync -a --exclude '.DS_Store' "$ROOT/icons/" "$STAGE/icons/"
rsync -a --exclude '.DS_Store' "$ROOT/src/" "$STAGE/src/"
rsync -a --exclude '.DS_Store' "$ROOT/_locales/" "$STAGE/_locales/"

(
  cd "$STAGE"
  zip -X -r -q "$ZIP" \
    manifest.json \
    popup.html \
    popup.css \
    popup.js \
    options.html \
    options.css \
    options.js \
    icons \
    _locales \
    src
)

# Validate the packaging invariants required by Chrome and Chrome Web Store.
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" \
  "$ROOT/manifest.json"
ARCHIVE_LIST="$(mktemp)"
trap 'rm -rf "$STAGE" "$ARCHIVE_LIST"' EXIT
unzip -Z1 "$ZIP" > "$ARCHIVE_LIST"
grep -Fxq 'manifest.json' "$ARCHIVE_LIST" || {
  printf 'Package validation failed: manifest.json is not at ZIP root\n' >&2
  exit 1
}
printf 'Created %s\n' "$ZIP"
