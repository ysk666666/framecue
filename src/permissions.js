(function initPermissionHelpers(root) {
  'use strict';

  const OPTIONAL_ORIGINS = ['*://*/*'];
  const PENDING_GRANT_KEY = 'frameCuePendingSiteGrant';
  const PENDING_GRANT_MAX_AGE_MS = 10 * 60 * 1000;
  const CONTENT_FILES = ['src/site-rules.js', 'src/frame-math.js', 'src/content.js'];

  function browserApi() {
    const api = root.FrameCueApi;
    if (!api) {
      throw new Error('FrameCue: browser API bridge is missing');
    }
    return api;
  }

  function pendingGrantArea() {
    return chrome.storage.session ? 'session' : 'local';
  }

  async function savePendingGrant(grant) {
    const value = {
      ...grant,
      createdAt: Date.now(),
    };
    await browserApi().storage.set(pendingGrantArea(), { [PENDING_GRANT_KEY]: value });
    return value;
  }

  async function readPendingGrant() {
    const result = await browserApi().storage.get(pendingGrantArea(), PENDING_GRANT_KEY);
    const grant = result && result[PENDING_GRANT_KEY];
    if (!grant || !grant.hostname || !grant.origin) {
      return null;
    }
    if (!Number.isFinite(Number(grant.createdAt))
      || Date.now() - Number(grant.createdAt) > PENDING_GRANT_MAX_AGE_MS) {
      await clearPendingGrant();
      return null;
    }
    return grant;
  }

  async function clearPendingGrant() {
    await browserApi().storage.remove(pendingGrantArea(), PENDING_GRANT_KEY);
  }

  function originMatchesGrant(origin, grant) {
    if (!grant) {
      return false;
    }
    const value = String(origin || '').toLowerCase();
    if (value === '*://*/*' || value === '<all_urls>') {
      return true;
    }
    if (value === String(grant.origin || '').toLowerCase()) {
      return true;
    }
    try {
      const normalized = value.replace(/^\*:\/\//, 'https://');
      return new URL(normalized).hostname.toLowerCase() === String(grant.hostname).toLowerCase();
    } catch (_) {
      return false;
    }
  }

  function permissionCoversGrant(origins, grant) {
    return Array.from(origins || []).some((origin) => originMatchesGrant(origin, grant));
  }

  function originForHost(hostname) {
    return `*://${hostname}/*`;
  }

  // Host permissions are the source of truth for where the extension may run;
  // allowlist rules map to these match patterns one to one.
  function originsForRules(ruleList) {
    const rules = root.FrameCueSiteRules;
    const origins = new Set();
    for (const rule of rules.normalizeRuleList(ruleList)) {
      rules.patternsForRule(rule).forEach((pattern) => origins.add(pattern));
    }
    return Array.from(origins);
  }

  async function grantedSiteOrigins() {
    const all = await browserApi().permissions.getAll();
    return ((all && all.origins) || []).filter((origin) => /^(\*|https?):\/\//.test(origin)
      && !OPTIONAL_ORIGINS.includes(origin));
  }

  async function missingOriginsForRules(ruleList) {
    const missing = [];
    for (const origin of originsForRules(ruleList)) {
      if (!(await browserApi().permissions.contains([origin]))) {
        missing.push(origin);
      }
    }
    return missing;
  }

  /** Revoke granted site origins that no allowlist rule needs any more. */
  async function revokeUnlistedOrigins(ruleList) {
    const required = new Set(originsForRules(ruleList));
    const stale = (await grantedSiteOrigins()).filter((origin) => !required.has(origin));
    if (stale.length) {
      await browserApi().permissions.remove(stale);
    }
    return stale;
  }

  async function requestAccess(origin) {
    return browserApi().permissions.request(origin ? [origin] : OPTIONAL_ORIGINS);
  }

  async function containsAccess(origin) {
    return browserApi().permissions.contains(origin ? [origin] : OPTIONAL_ORIGINS);
  }

  async function reinject(tabId) {
    await browserApi().scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES,
    }).catch(() => {});
  }

  const api = {
    OPTIONAL_ORIGINS,
    PENDING_GRANT_KEY,
    CONTENT_FILES,
    requestAccess,
    containsAccess,
    originForHost,
    originsForRules,
    grantedSiteOrigins,
    missingOriginsForRules,
    revokeUnlistedOrigins,
    reinject,
    savePendingGrant,
    readPendingGrant,
    clearPendingGrant,
    permissionCoversGrant,
  };
  root.FrameCuePermissions = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
