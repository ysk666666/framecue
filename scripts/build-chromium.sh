#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/manifest.json').version")"
OUT="$ROOT/dist"
ZIP="$OUT/framecue-Chromium-v${VERSION}.zip"

STAGE="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p "$OUT"
rm -f "$OUT"/framecue-v*.zip "$OUT"/framecue-Chromium-v*.crx "$OUT"/framecue-Chromium-v*.zip
rm -f "$OUT/update_Chromium.xml"

# The staging directory becomes the archive root. Keep only the files Chromium
# needs at runtime; development metadata does not belong in the package.
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

# Keep a ready-to-load unpacked copy for local testing.
rm -rf "$OUT/chromium"
rsync -a "$STAGE/" "$OUT/chromium/"

node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (manifest.manifest_version !== 3) {
  throw new Error('Chromium package must be manifest v3');
}
if (!manifest.background || !manifest.background.service_worker) {
  throw new Error('Chromium manifest must declare background.service_worker');
}
if (manifest.update_url) {
  throw new Error('Chrome Web Store packages must not declare update_url');
}
" "$STAGE/manifest.json"

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

printf 'Created %s\n' "$ZIP"
printf 'Created unpacked Chromium build at %s\n' "$OUT/chromium"
