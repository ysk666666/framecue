(function initOptions() {
  'use strict';

  const api = globalThis.FrameCueMath;
  const rules = globalThis.FrameCueSiteRules;
  const permissions = globalThis.FrameCuePermissions;
  const STORAGE_KEY = 'frameCueSettings';

  const elements = {
    allowlist: document.getElementById('allowlist'),
    blocklist: document.getElementById('blocklist'),
    measureFrameRate: document.getElementById('measure-frame-rate'),
    hudModeButtons: Array.from(document.querySelectorAll('[data-hud-mode]')),
    permissionState: document.getElementById('permission-state'),
    permissionDetail: document.getElementById('permission-detail'),
    permissionButton: document.getElementById('permission-button'),
    grantButton: document.getElementById('grant-button'),
    version: document.getElementById('version'),
    saveButton: document.getElementById('save-button'),
    saveState: document.getElementById('save-state'),
  };

  let settings = api.normalizeSettings(null);
  let loaded = false;

  function parseRules(text) {
    return rules.normalizeRuleList(String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean));
  }

  function render() {
    elements.allowlist.value = settings.allowlist.join('\n');
    elements.blocklist.value = settings.blocklist.join('\n');
    elements.measureFrameRate.checked = settings.measureFrameRate;
    elements.hudModeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.hudMode === settings.hudMode));
    });
    elements.saveButton.disabled = !loaded;
  }

  async function renderPermission() {
    const siteOrigins = await permissions.grantedSiteOrigins().catch(() => []);
    const missing = await permissions.missingOriginsForRules(settings.allowlist).catch(() => []);
    elements.permissionState.textContent = siteOrigins.length
      ? `已授权 ${siteOrigins.length} 个站点`
      : '尚未授权站点';
    elements.permissionDetail.textContent = missing.length
      ? `${missing.length} 项白名单尚未在此浏览器授权，授权前不会生效`
      : siteOrigins.length
        ? '仅这些白名单站点可自动加载'
        : '添加白名单后保存，或在弹窗中按站点授权';
    elements.permissionButton.hidden = siteOrigins.length === 0;
    elements.permissionButton.textContent = '撤销全部站点权限';
    elements.grantButton.hidden = missing.length === 0;
  }

  // permissions.request needs the click's user gesture, so it must be the
  // first asynchronous call in the handler.
  function requestAllowlistAccess(allowlist) {
    const origins = permissions.originsForRules(allowlist);
    if (!origins.length) {
      return Promise.resolve(true);
    }
    return chrome.permissions.request({ origins }).catch(() => false);
  }

  function refreshOpenTabs() {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (!tab.id || /^(chrome|chrome-extension|about):/i.test(tab.url || '')) {
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'framecue-command', command: 'refresh-site' }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  }

  function collectSettings() {
    return api.normalizeSettings({
      ...settings,
      allowlist: parseRules(elements.allowlist.value),
      blocklist: parseRules(elements.blocklist.value),
      measureFrameRate: elements.measureFrameRate.checked,
      hudMode: (
        elements.hudModeButtons.find((button) => button.getAttribute('aria-pressed') === 'true')
        || elements.hudModeButtons[0]
      ).dataset.hudMode,
    });
  }

  async function save() {
    const next = collectSettings();
    const granted = await requestAllowlistAccess(next.allowlist);
    settings = next;
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    await permissions.revokeUnlistedOrigins(settings.allowlist).catch(() => {});
    render();
    await renderPermission();
    refreshOpenTabs();
    elements.saveState.textContent = granted ? '已保存' : '已保存，但未授予站点权限，相关规则暂不生效';
    window.setTimeout(() => {
      elements.saveState.textContent = '';
    }, granted ? 1800 : 5000);
  }

  elements.permissionButton.addEventListener('click', async () => {
    try {
      const all = await chrome.permissions.getAll();
      const origins = (all.origins || []).filter((origin) => origin !== '*://*/*' && !origin.startsWith('chrome'));
      if (origins.length) {
        await chrome.permissions.remove({ origins });
      }
    } catch (_) {
      // The permission prompt can be dismissed by the user.
    }
    await renderPermission();
  });

  elements.grantButton.addEventListener('click', async () => {
    await requestAllowlistAccess(settings.allowlist);
    await renderPermission();
  });

  elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  elements.saveButton.addEventListener('click', save);
  chrome.storage.sync.get(STORAGE_KEY, (result) => {
    settings = api.normalizeSettings(result[STORAGE_KEY]);
    loaded = true;
    render();
    renderPermission();
  });
  elements.saveState.textContent = '';
  elements.saveButton.disabled = true;
  [elements.allowlist, elements.blocklist, elements.measureFrameRate, ...elements.hudModeButtons]
    .forEach((control) => {
    control.addEventListener('input', () => {
      elements.saveState.textContent = '';
    });
  });
  elements.hudModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      elements.hudModeButtons.forEach((candidate) => {
        candidate.setAttribute('aria-pressed', String(candidate === button));
      });
      elements.saveState.textContent = '';
    });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes[STORAGE_KEY]) {
      settings = api.normalizeSettings(changes[STORAGE_KEY].newValue);
      render();
    }
  });
})();
