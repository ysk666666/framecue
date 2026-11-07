#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/manifest.json').version")"
OUT="$ROOT/dist/firefox"
ZIP="$ROOT/dist/framecue-firefox-v${VERSION}.zip"
# Firefox needs a stable add-on id for storage.sync and optional host
# permissions. Override it if you plan to publish this build.
GECKO_ID="${FRAMECUE_FIREFOX_ID:-framecue@framecue.local}"

cleanup() {
  rm -rf "$STAGE"
}

STAGE="$(mktemp -d)"
trap cleanup EXIT

mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# The unpacked directory is what about:debugging and web-ext load.
rsync -a \
  "$ROOT/popup.html" \
  "$ROOT/popup.css" \
  "$ROOT/popup.js" \
  "$ROOT/options.html" \
  "$ROOT/options.css" \
  "$ROOT/options.js" \
  "$OUT/"

rsync -a --exclude '.DS_Store' "$ROOT/icons/" "$OUT/icons/"
rsync -a --exclude '.DS_Store' "$ROOT/src/" "$OUT/src/"
rsync -a --exclude '.DS_Store' "$ROOT/_locales/" "$OUT/_locales/"

# Derive the Firefox manifest from the Chrome one so the shared keys cannot
# drift. Only the background declaration differs: Firefox MV3 does not support
# background.service_worker and loads an event page from background.scripts.
node - "$ROOT/manifest.json" "$OUT/manifest.json" "$GECKO_ID" <<'NODE'
const fs = require('fs');

const [source, target, geckoId] = process.argv.slice(2);
const chromeManifest = JSON.parse(fs.readFileSync(source, 'utf8'));

const manifest = {
  manifest_version: chromeManifest.manifest_version,
  name: chromeManifest.name,
  version: chromeManifest.version,
  description: chromeManifest.description,
  default_locale: chromeManifest.default_locale,
  author: chromeManifest.author,
  permissions: chromeManifest.permissions,
  optional_host_permissions: chromeManifest.optional_host_permissions,
  background: {
    scripts: [
      'src/browser-api.js',
      'src/site-rules.js',
      'src/frame-math.js',
      'src/permissions.js',
      'src/background.js',
    ],
  },
  action: chromeManifest.action,
  icons: chromeManifest.icons,
  options_ui: chromeManifest.options_ui,
  browser_specific_settings: {
    gecko: {
      id: geckoId,
      // optional_host_permissions needs Firefox 116 or newer.
      strict_min_version: '116.0',
    },
  },
};

fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

(
  cd "$OUT"
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

node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const scripts = manifest.background && manifest.background.scripts;
if (!Array.isArray(scripts) || scripts.includes(undefined)) {
  throw new Error('manifest.background.scripts is missing');
}
if (manifest.background.service_worker) {
  throw new Error('Firefox manifest must not declare background.service_worker');
}
if (!manifest.browser_specific_settings || !manifest.browser_specific_settings.gecko.id) {
  throw new Error('browser_specific_settings.gecko.id is required');
}
const missing = ['src/browser-api.js', 'src/permissions.js', 'src/background.js']
  .filter((file) => !fs.existsSync(require('path').join(process.argv[2], file)));
if (missing.length) {
  throw new Error(\`missing runtime files: \${missing.join(', ')}\`);
}
" "$OUT/manifest.json" "$OUT"

printf 'Created unpacked Firefox build at %s\n' "$OUT"
printf 'Created %s\n' "$ZIP"
