(function initPopup() {
  'use strict';

  const api = globalThis.FrameCueMath;
  const rules = globalThis.FrameCueSiteRules;
  const permissions = globalThis.FrameCuePermissions;
  const browserApi = globalThis.FrameCueApi;
  const STORAGE_KEY = 'frameCueSettings';
  const IS_MAC = /mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
  );
  const SHORTCUT_LABELS = IS_MAC
    ? { goStart: 'Option+←', goEnd: 'Option+→', rateDown: '⌘←', rateUp: '⌘→', edge: ['⌥←', '⌥→'] }
    : { goStart: 'Home', goEnd: 'End', rateDown: 'Ctrl+←', rateUp: 'Ctrl+→', edge: ['Home', 'End'] };

  const elements = {
    enabled: document.getElementById('enabled'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    frameReadout: document.getElementById('frame-readout'),
    timeReadout: document.getElementById('time-readout'),
    fpsSource: document.getElementById('fps-source'),
    fps: document.getElementById('fps'),
    rateButtons: Array.from(document.querySelectorAll('[data-rate-mode]')),
    goStart: document.getElementById('go-start'),
    stepBack: document.getElementById('step-back'),
    playPause: document.getElementById('play-pause'),
    stepForward: document.getElementById('step-forward'),
    goEnd: document.getElementById('go-end'),
    siteSection: document.getElementById('site-section'),
    siteHost: document.getElementById('site-host'),
    siteToggle: document.getElementById('site-toggle'),
    siteBlock: document.getElementById('site-block'),
    sitePermissionHint: document.getElementById('site-permission-hint'),
    openOptions: document.getElementById('open-options'),
  };

  let settings = api.normalizeSettings(null);
  let activeTab = null;
  let statusTimer = 0;
  let siteAccessGranted = false;

  async function saveSettings(nextSettings = settings) {
    settings = api.normalizeSettings(nextSettings);
    await browserApi.storage.set('sync', { [STORAGE_KEY]: settings });
    return settings;
  }

  function activateGrantedSite(grant) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'framecue-command',
        command: 'activate-granted-site',
        grant,
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || '无法启用站点'));
          return;
        }
        resolve(response);
      });
    });
  }

  function setStatus(state, text) {
    elements.statusDot.classList.remove('active', 'error');
    if (state) {
      elements.statusDot.classList.add(state);
    }
    elements.statusText.textContent = text;
  }

  function setTransportEnabled(enabled) {
    [
      elements.goStart,
      elements.stepBack,
      elements.playPause,
      elements.stepForward,
      elements.goEnd,
    ].forEach((button) => {
      button.disabled = !enabled;
    });
  }

  async function applyMasterSwitch(enabled) {
    settings = api.normalizeSettings({ ...settings, enabled });
    await saveSettings();
    renderSettings();
    renderSiteControls();
    if (!enabled) {
      await applyConfigurationToTab(activeTab && activeTab.id);
      setStatus('', '总开关已关闭');
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = '页面快捷键不受扩展影响';
      setTransportEnabled(false);
    } else {
      await applyConfigurationToTab(activeTab && activeTab.id);
      refreshStatus();
    }
  }

  function getHostname() {
    try {
      return new URL((activeTab && activeTab.url) || '').hostname;
    } catch (_) {
      return '';
    }
  }

  function renderSettings() {
    elements.enabled.checked = settings.enabled;
    elements.fps.value = String(settings.fps);
    elements.fps.disabled = settings.frameRateMode !== 'custom';
    elements.rateButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.rateMode === settings.frameRateMode));
    });
  }

  async function refreshSiteAccess() {
    const hostname = getHostname();
    siteAccessGranted = hostname
      ? await permissions.containsAccess(permissions.originForHost(hostname)).catch(() => false)
      : false;
  }

  function renderSiteControls() {
    const hostname = getHostname();
    const isBlocked = rules.matchesAny(settings.blocklist, hostname);
    const isAllowed = rules.matchesAny(settings.allowlist, hostname);
    // Rules sync across devices but site permissions do not.
    const needsGrant = isAllowed && !siteAccessGranted;

    elements.siteSection.hidden = !hostname;
    elements.siteHost.textContent = hostname;
    elements.siteToggle.textContent = needsGrant
      ? '授权此网站'
      : isAllowed ? '在此网站停用' : '在此网站启用';
    elements.siteToggle.classList.toggle('primary-text', !isAllowed || needsGrant);
    elements.siteBlock.hidden = isBlocked;
    elements.sitePermissionHint.textContent = isBlocked
      ? '此域名已在黑名单中'
      : needsGrant
        ? '已在白名单中，但此浏览器尚未授予站点访问权限。'
        : '加入白名单并授权后，页面才会加载扩展。';
  }

  function renderShortcutLabels() {
    elements.goStart.title = `跳到片头（${SHORTCUT_LABELS.goStart}）`;
    elements.goEnd.title = `跳到片尾（${SHORTCUT_LABELS.goEnd}）`;
    document.querySelectorAll('[data-shortcut]').forEach((element) => {
      const [key, index] = element.dataset.shortcut.split(':');
      const label = SHORTCUT_LABELS[key];
      element.textContent = Array.isArray(label) ? label[Number(index) || 0] : label;
    });
  }

  function renderStatus(response) {
    if (!response) {
      setStatus('', '当前页面无法连接扩展');
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = '刷新页面后重试';
      setTransportEnabled(false);
      return;
    }

    if (response.masterOff) {
      setStatus('', '总开关已关闭');
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = '页面快捷键不受扩展影响';
      setTransportEnabled(false);
      return;
    }

    if (!response.siteAllowed) {
      setStatus('error', '此网站尚未启用');
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = '在“当前网站”中启用后生效';
      setTransportEnabled(false);
      return;
    }

    if (!response.found) {
      setStatus('error', `已启用，尚未找到视频${response.hls ? ' · HLS' : ''}`);
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = response.hls ? '已检测到 HLS，请开始播放' : '请等待播放器加载完成';
      setTransportEnabled(false);
      return;
    }

    const playbackRate = Number(response.playbackRate) || 1;
    const rateText = Math.abs(playbackRate - 1) > 0.01 ? ` · ${playbackRate.toFixed(2)}×` : '';
    const hlsText = response.hls ? ' · HLS' : '';
    setStatus('active', `${response.paused ? '已暂停' : '播放中'}${rateText}${hlsText} · 快捷键已接管`);
    elements.frameReadout.hidden = false;
    elements.frameReadout.textContent = `帧 ${response.frame} / ${Math.max(0, response.frameCount - 1)}`;
    const durationLabel = response.durationMayGrow ? '缓冲时长' : '总时长';
    elements.timeReadout.textContent = `${api.formatClock(response.currentTime)} / ${durationLabel} ${api.formatClock(response.duration)} · ${response.fps} fps`;
    elements.fpsSource.textContent = response.fpsSource === 'measured'
      ? `实测 ${response.fps} fps`
      : response.fpsSource === 'metadata'
        ? `视频元数据 ${response.fps} fps`
        : response.fpsSource === 'custom'
          ? `固定 ${response.fps} fps`
          : `兜底 ${response.fps} fps`;
    elements.playPause.textContent = response.paused ? '▶' : 'Ⅱ';
    elements.playPause.setAttribute('aria-label', response.paused ? '播放' : '暂停');
    setTransportEnabled(true);
  }

  function refreshStatus() {
    if (!activeTab || /^(chrome|chrome-extension|moz-extension|about|file):/i.test(activeTab.url || '')) {
      renderStatus(null);
      return;
    }
    if (getHostname() && !rules.siteDecision(settings, getHostname()).allowed) {
      setStatus('', '此网站尚未启用');
      elements.frameReadout.hidden = true;
      elements.timeReadout.textContent = '在“当前网站”中启用后生效';
      setTransportEnabled(false);
      return;
    }
    chrome.tabs.sendMessage(activeTab.id, { type: 'framecue-command', command: 'status' }, (response) => {
      if (chrome.runtime.lastError) {
        const hostname = getHostname();
        if (hostname && rules.matchesAny(settings.allowlist, hostname) && !siteAccessGranted) {
          setStatus('error', '此网站需要重新授权');
          elements.frameReadout.hidden = true;
          elements.timeReadout.textContent = '点击“授权此网站”后生效';
          setTransportEnabled(false);
          return;
        }
        if (hostname && rules.matchesAny(settings.allowlist, hostname)) {
          setStatus('error', '此网站已启用，但页面尚未重载');
          elements.frameReadout.hidden = true;
          elements.timeReadout.textContent = '刷新一次页面即可生效';
          setTransportEnabled(false);
          return;
        }
        if (hostname) {
          setStatus('', '此网站尚未启用');
          elements.frameReadout.hidden = true;
          elements.timeReadout.textContent = '在“当前网站”中启用后生效';
          setTransportEnabled(false);
          return;
        }
        renderStatus(null);
        return;
      }
      renderStatus(response);
    });
  }

  function readSiteState(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'framecue-command', command: 'site-status' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function isSiteActive() {
    const hostname = getHostname();
    return Boolean(settings.enabled && hostname && rules.siteDecision(settings, hostname).allowed);
  }

  async function applyConfigurationToTab(tabId) {
    if (!tabId) {
      return false;
    }
    // activeTab lets the popup inject into any page it is opened on; only do
    // so for allowlisted sites. Other pages just get the new configuration.
    if (isSiteActive() && siteAccessGranted) {
      await permissions.reinject(tabId);
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
    const state = await readSiteState(tabId);
    return Boolean(state && state.siteAllowed);
  }

  function sendCommand(command) {
    if (!activeTab) {
      return;
    }
    chrome.tabs.sendMessage(activeTab.id, { type: 'framecue-command', command }, () => {
      if (chrome.runtime.lastError) {
        return;
      }
      window.setTimeout(refreshStatus, 100);
    });
  }

  function scheduleRefresh() {
    clearInterval(statusTimer);
    statusTimer = window.setInterval(refreshStatus, 800);
  }

  async function toggleCurrentSite() {
    const hostname = getHostname();
    if (!hostname) {
      return;
    }
    const isAllowed = rules.matchesAny(settings.allowlist, hostname);
    if (isAllowed && siteAccessGranted) {
      settings = api.normalizeSettings({
        ...settings,
        allowlist: settings.allowlist.filter((rule) => !rules.ruleMatchesHost(rule, hostname)),
      });
      await saveSettings();
      await applyConfigurationToTab(activeTab.id);
      await permissions.revokeUnlistedOrigins(settings.allowlist).catch(() => {});
      await refreshSiteAccess();
      renderSiteControls();
      refreshStatus();
      return;
    }

    const hostOrigin = permissions.originForHost(hostname);
    const grant = {
      hostname,
      origin: hostOrigin,
      tabId: activeTab.id,
    };
    // Firefox only allows permissions.request while the click is still being
    // handled, so the request must be issued before the first await. The
    // pending grant is written afterwards as a fallback for the background
    // permissions.onAdded path.
    const requestPromise = permissions.requestAccess(hostOrigin);
    await permissions.savePendingGrant(grant);
    let granted = false;
    try {
      granted = await requestPromise;
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      await permissions.clearPendingGrant();
      elements.sitePermissionHint.textContent = '未获得站点访问权限，无法启用';
      return;
    }
    siteAccessGranted = true;

    const tab = await queryActiveTab();
    const tabId = tab ? tab.id : activeTab.id;
    let activated = false;
    try {
      const response = await activateGrantedSite({ ...grant, tabId });
      settings = api.normalizeSettings(response.settings);
      activated = await applyConfigurationToTab(tabId);
    } catch (_) {
      activated = await applyConfigurationToTab(tabId);
    } finally {
      await permissions.clearPendingGrant();
    }

    renderSettings();
    renderSiteControls();
    if (activated) {
      elements.sitePermissionHint.textContent = '已启用，无需重新加载页面';
      refreshStatus();
    } else {
      elements.sitePermissionHint.textContent = '已加入白名单，请刷新页面完成加载';
      refreshStatus();
    }
  }

  async function blockCurrentSite() {
    const hostname = getHostname();
    if (!hostname) {
      return;
    }
    settings = api.normalizeSettings({
      ...settings,
      allowlist: settings.allowlist.filter((rule) => !rules.ruleMatchesHost(rule, hostname)),
      blocklist: rules.normalizeRuleList(settings.blocklist.concat(hostname)),
    });
    await saveSettings();
    await applyConfigurationToTab(activeTab.id);
    await permissions.revokeUnlistedOrigins(settings.allowlist).catch(() => {});
    await refreshSiteAccess();
    renderSiteControls();
    refreshStatus();
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    chrome.storage.sync.get(STORAGE_KEY, async (result) => {
      settings = api.normalizeSettings(result[STORAGE_KEY]);
      await refreshSiteAccess();
      renderSettings();
      renderSiteControls();
      refreshStatus();
      scheduleRefresh();
    });
  });

  renderShortcutLabels();
  elements.enabled.addEventListener('change', () => {
    void applyMasterSwitch(elements.enabled.checked);
  });

  elements.rateButtons.forEach((button) => {
    button.addEventListener('click', () => {
      settings = api.normalizeSettings({ ...settings, frameRateMode: button.dataset.rateMode });
      renderSettings();
      void saveSettings();
    });
  });

  elements.fps.addEventListener('change', () => {
    settings = api.normalizeSettings({ ...settings, fps: elements.fps.value });
    renderSettings();
    void saveSettings();
  });

  elements.stepBack.addEventListener('click', () => sendCommand('step-back'));
  elements.stepForward.addEventListener('click', () => sendCommand('step-forward'));
  elements.playPause.addEventListener('click', () => sendCommand('play-pause'));
  elements.goStart.addEventListener('click', () => sendCommand('go-start'));
  elements.goEnd.addEventListener('click', () => sendCommand('go-end'));
  elements.siteToggle.addEventListener('click', toggleCurrentSite);
  elements.siteBlock.addEventListener('click', blockCurrentSite);
  elements.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[STORAGE_KEY]) {
      return;
    }
    settings = api.normalizeSettings(changes[STORAGE_KEY].newValue);
    renderSettings();
    renderSiteControls();
  });
  window.addEventListener('unload', () => {
    clearInterval(statusTimer);
  });
})();
