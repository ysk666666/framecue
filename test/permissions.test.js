'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

globalThis.FrameCueSiteRules = require('../src/site-rules.js');
const permissions = require('../src/permissions.js');

test('allowlist rules map to host permission patterns', () => {
  assert.deepEqual(
    permissions.originsForRules(['video.example.com', '*.example.org', 'video.example.com']),
    ['*://video.example.com/*', '*://example.org/*', '*://*.example.org/*'],
  );
  assert.deepEqual(permissions.originsForRules(['not a host']), []);
});

test('pending grants match only the requested host', () => {
  const grant = { hostname: 'video.example.com', origin: '*://video.example.com/*' };
  assert.equal(permissions.permissionCoversGrant(['*://video.example.com/*'], grant), true);
  assert.equal(permissions.permissionCoversGrant(['https://video.example.com/*'], grant), true);
  assert.equal(permissions.permissionCoversGrant(['*://other.example.com/*'], grant), false);
});
