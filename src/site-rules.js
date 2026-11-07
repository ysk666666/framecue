(function initSiteRules(root) {
  'use strict';

  const VALID_HOST = /^[a-z0-9.-]+$/i;

  function normalizeHost(value) {
    let input = String(value == null ? '' : value).trim().toLowerCase();
    if (!input) {
      return '';
    }

    let wildcard = false;
    if (input.startsWith('*.')) {
      wildcard = true;
      input = input.slice(2);
    }

    if (input.includes('/') || input.includes(':')) {
      try {
        const url = new URL(input.includes('://') ? input : `https://${input}`);
        input = url.hostname.toLowerCase();
      } catch (_) {
        return '';
      }
    }

    input = input.replace(/\.+$/, '');
    if (!input || !VALID_HOST.test(input) || input.startsWith('.') || input.includes('..')) {
      return '';
    }
    return wildcard ? `*.${input}` : input;
  }

  function normalizeRule(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) {
      return '';
    }

    if (raw.startsWith('*.') || (!raw.includes('/') && !raw.includes(':') && !raw.includes('://'))) {
      return normalizeHost(raw);
    }

    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      return normalizeHost(url.hostname);
    } catch (_) {
      return '';
    }
  }

  function splitRule(rule) {
    const normalized = normalizeRule(rule);
    if (!normalized) {
      return null;
    }
    if (normalized.startsWith('*.')) {
      return { wildcard: true, host: normalized.slice(2) };
    }
    return { wildcard: false, host: normalized };
  }

  function ruleMatchesHost(rule, hostname) {
    const parsed = splitRule(rule);
    const host = normalizeHost(hostname);
    if (!parsed || !host) {
      return false;
    }
    if (host === parsed.host) {
      return true;
    }
    return parsed.wildcard && host.endsWith(`.${parsed.host}`);
  }

  function normalizeRuleList(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
      const rule = normalizeRule(item);
      if (rule && !seen.has(rule)) {
        seen.add(rule);
        result.push(rule);
      }
    }
    return result;
  }

  function patternsForRule(rule) {
    const parsed = splitRule(rule);
    if (!parsed) {
      return [];
    }
    const patterns = [`*://${parsed.host}/*`];
    if (parsed.wildcard) {
      patterns.push(`*://*.${parsed.host}/*`);
    }
    return patterns;
  }

  function matchesAny(rules, hostname) {
    return normalizeRuleList(rules).some((rule) => ruleMatchesHost(rule, hostname));
  }

  function siteDecision(settings, hostname) {
    const host = normalizeHost(hostname);
    if (!host) {
      return { allowed: false, reason: 'invalid-host' };
    }
    if (matchesAny(settings && settings.blocklist, host)) {
      return { allowed: false, reason: 'blocked' };
    }
    if (matchesAny(settings && settings.allowlist, host)) {
      return { allowed: true, reason: 'allowlisted' };
    }
    return { allowed: false, reason: 'not-allowlisted' };
  }

  const api = {
    normalizeHost,
    normalizeRule,
    normalizeRuleList,
    ruleMatchesHost,
    matchesAny,
    patternsForRule,
    siteDecision,
  };

  root.FrameCueSiteRules = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
