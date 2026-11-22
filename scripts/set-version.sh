#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <version>\n' "$(basename "$0")" >&2
  printf 'example: %s 1.2.0\n' "$(basename "$0")" >&2
  exit 64
fi

VERSION="$1"

node - "$ROOT" "$VERSION" <<'NODE'
const fs = require('fs');
const path = require('path');

const [root, version] = process.argv.slice(2);

// Chrome accepts 1-4 dot-separated integers, each 0-65535. Firefox is similar
// enough for our purposes, so validate once against the stricter shape.
if (!/^([0-9]{1,5})(\.[0-9]{1,5}){0,3}$/.test(version)) {
  console.error(`Invalid version "${version}". Expected up to four dot-separated integers, e.g. 1.2.0`);
  process.exit(1);
}
for (const part of version.split('.')) {
  if (Number(part) > 65535) {
    console.error(`Invalid version "${version}". Each part must be 0-65535`);
    process.exit(1);
  }
}

const writeJson = (file, mutate) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

writeJson(path.join(root, 'manifest.json'), (data) => {
  data.version = version;
});

writeJson(path.join(root, 'package.json'), (data) => {
  data.version = version;
});

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  writeJson(lockPath, (data) => {
    data.version = version;
    if (data.packages && data.packages['']) {
      data.packages[''].version = version;
    }
  });
}

console.log(`Set version to ${version} in manifest.json, package.json and package-lock.json`);
NODE
