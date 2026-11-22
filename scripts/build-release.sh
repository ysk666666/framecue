#!/usr/bin/env bash
set -euo pipefail

# Build store-ready packages and unpacked directories:
#   dist/chromium/                          (unpacked, load-unpacked testing)
#   dist/firefox/                           (unpacked, load-unpacked testing)
#   dist/framecue-Firefox-v<version>.zip
#   dist/framecue-Chromium-v<version>.zip
#
# Run through `npm run build`.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$ROOT/scripts/build-chromium.sh"
bash "$ROOT/scripts/build-firefox.sh"
