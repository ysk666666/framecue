'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const rules = require('../src/site-rules.js');

test('host and wildcard rules match subdomains only for wildcards', () => {
  assert.equal(rules.ruleMatchesHost('example.com', 'example.com'), true);
  assert.equal(rules.ruleMatchesHost('example.com', 'video.example.com'), false);
  assert.equal(rules.ruleMatchesHost('*.example.com', 'video.example.com'), true);
  assert.equal(rules.ruleMatchesHost('*.example.com', 'example.com'), true);
  assert.equal(rules.ruleMatchesHost('*.example.com', 'notexample.com'), false);
});

test('URLs normalize to hostnames and invalid input is rejected', () => {
  assert.equal(rules.normalizeRule('https://Video.Example.com/watch?id=1'), 'video.example.com');
  assert.equal(rules.normalizeRule('*.Example.com'), '*.example.com');
  assert.equal(rules.normalizeRule('not a host'), '');
  assert.equal(rules.normalizeRule('https://bad_host.example/'), '');
});

test('blocklist wins and an empty allowlist allows nothing', () => {
  const settings = {
    allowlist: ['video.example.com'],
    blocklist: ['blocked.example.com'],
  };
  assert.equal(rules.siteDecision(settings, 'video.example.com').allowed, true);
  assert.equal(rules.siteDecision(settings, 'other.example.com').allowed, false);
  assert.equal(rules.siteDecision({ ...settings, allowlist: [] }, 'other.example.com').allowed, false);
  assert.equal(rules.siteDecision({ ...settings, allowlist: ['*.example.com'] }, 'blocked.example.com').allowed, false);
});
