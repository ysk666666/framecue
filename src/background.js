// Chrome runs the background context as a service worker, where importScripts
// is available. Firefox MV3 backgrounds are event pages instead, so the
// Firefox manifest lists these files in background.scripts and they are
// already present on the global object.
if (typeof importScripts === 'function') {
  importScripts('browser-api.js', 'site-rules.js', 'frame-math.js', 'permissions.js');
}

const STORAGE_KEY = 'frameCueSettings';
const pendingGrantProcessing = new Set();
const pendingGrantWaiters = new Map();

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      resolve(globalThis.FrameCueMath
        ? globalThis.FrameCueMath.normalizeSettings(result[STORAGE_KEY])
        : null);
    });
  });
}

function getHostname(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return '';
    }
    return parsed.hostname;
  } catch (_) {
    return '';
  }
}

async function injectIfAllowed(tabId, url) {
  const hostname = getHostname(url);
  if (!hostname) {
    return;
  }
  const settings = await getSettings();
  if (!settings || !settings.enabled) {
    return;
  }

  const decision = globalThis.FrameCueSiteRules.siteDecision(settings, hostname);
  if (!decision.allowed) {
    return;
  }

  await globalThis.FrameCuePermissions.reinject(tabId);
}

async function sendConfiguration(tabId, settings) {
  if (!tabId) {
    return;
  }
  await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {
      type: 'framecue-command',
      command: 'config',
      settings,
    }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function activateGrantedSite(grant) {
  if (!grant || !grant.hostname) {
    return;
  }

  const rules = globalThis.FrameCueSiteRules;
  const settings = await getSettings();
  if (!settings || !rules) {
    return;
  }

  const updated = globalThis.FrameCueMath.normalizeSettings({
    ...settings,
    allowlist: rules.normalizeRuleList(settings.allowlist.concat(grant.hostname)),
    blocklist: settings.blocklist.filter((rule) => !rules.ruleMatchesHost(rule, grant.hostname)),
  });
  await globalThis.FrameCueApi.storage.set('sync', { [STORAGE_KEY]: updated });

  const tabId = Number(grant.tabId);
  if (Number.isInteger(tabId) && tabId >= 0) {
    await globalThis.FrameCuePermissions.reinject(tabId);
    await sendConfiguration(tabId, updated);
  }
}

function waitForGrantActivation(hostname) {
  return new Promise((resolve) => {
    let waiters = pendingGrantWaiters.get(hostname);
    if (!waiters) {
      waiters = new Set();
      pendingGrantWaiters.set(hostname, waiters);
    }
    waiters.add(resolve);
  });
}

function resolveGrantActivation(hostname) {
  const waiters = pendingGrantWaiters.get(hostname);
  if (!waiters) {
    return;
  }
  pendingGrantWaiters.delete(hostname);
  for (const resolve of waiters) {
    resolve();
  }
}

async function processPendingGrant(addedOrigins) {
  const permissionHelpers = globalThis.FrameCuePermissions;
  if (!permissionHelpers) {
    return;
  }
  const grant = await permissionHelpers.readPendingGrant();
  if (!grant || !permissionHelpers.permissionCoversGrant(addedOrigins, grant)) {
    return;
  }
  if (pendingGrantProcessing.has(grant.hostname)) {
    return;
  }

  pendingGrantProcessing.add(grant.hostname);
  try {
    await activateGrantedSite(grant);
    await permissionHelpers.clearPendingGrant();
  } finally {
    pendingGrantProcessing.delete(grant.hostname);
    resolveGrantActivation(grant.hostname);
  }
}

async function activateRequestedGrant(grant) {
  if (!grant || !grant.hostname) {
    return;
  }
  if (!pendingGrantProcessing.has(grant.hostname)) {
    await activateGrantedSite(grant);
    return;
  }

  await waitForGrantActivation(grant.hostname);
  const pending = await globalThis.FrameCuePermissions.readPendingGrant();
  if (pending) {
    await activateGrantedSite(pending);
  }
}

function isExtensionPage(sender) {
  return Boolean(sender
    && sender.id === chrome.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL('')));
}

function injectTab(tabId, changeInfo, tab) {
  if (!tab || !tab.url || changeInfo.status !== 'complete') {
    return;
  }
  void injectIfAllowed(tabId, tab.url);
}

function injectAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs || []) {
      // tab.url is only visible for origins the extension has been granted.
      if (tab.id && tab.url) {
        void injectIfAllowed(tab.id, tab.url);
      }
    }
  });
}

function siteRulesChanged(oldValue, newValue) {
  const before = globalThis.FrameCueMath.normalizeSettings(oldValue);
  const after = globalThis.FrameCueMath.normalizeSettings(newValue);
  return before.enabled !== after.enabled
    || JSON.stringify(before.allowlist) !== JSON.stringify(after.allowlist)
    || JSON.stringify(before.blocklist) !== JSON.stringify(after.blocklist);
}

chrome.tabs.onUpdated.addListener(injectTab);
chrome.runtime.onInstalled.addListener(injectAllTabs);
chrome.runtime.onStartup.addListener(injectAllTabs);
chrome.permissions.onAdded.addListener((permissions) => {
  void processPendingGrant((permissions && permissions.origins) || []);
  injectAllTabs();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = areaName === 'sync' && changes[STORAGE_KEY];
  if (change && siteRulesChanged(change.oldValue, change.newValue)) {
    injectAllTabs();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'framecue-command') {
    return false;
  }

  if (message.command === 'open-options') {
    chrome.runtime.openOptionsPage(() => {
      void chrome.runtime.lastError;
    });
    return false;
  }

  if (message.command === 'activate-granted-site' && message.grant) {
    // Only the popup may change the allowlist; content scripts run on pages
    // whose script could otherwise ask to allowlist arbitrary hosts.
    if (!isExtensionPage(sender)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    const rules = globalThis.FrameCueSiteRules;
    const permissionHelpers = globalThis.FrameCuePermissions;
    const hostname = rules.normalizeHost(message.grant.hostname);
    const grant = {
      hostname,
      origin: permissionHelpers.originForHost(hostname),
      tabId: message.grant.tabId,
    };
    const activationDone = (hostname ? permissionHelpers.containsAccess(grant.origin) : Promise.resolve(false))
      .then((granted) => {
        if (!granted) {
          throw new Error('站点访问权限未授予');
        }
        return activateRequestedGrant(grant);
      })
      .then(() => getSettings());
    void activationDone
      .then((settings) => {
        const allowed = Boolean(settings && rules.matchesAny(settings.allowlist, hostname));
        sendResponse({ ok: allowed, settings });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
