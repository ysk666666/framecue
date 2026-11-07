(function initFrameCue() {
  'use strict';

  const api = globalThis.FrameCueMath;
  if (!api) {
    return;
  }

  function isContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // After an extension update or reload, the previous content script stays in
  // the page with a dead chrome.* context. Replace it instead of deferring.
  const previousInstance = globalThis.__frameCueInstance;
  if (previousInstance && previousInstance.isAlive()) {
    return;
  }
  if (previousInstance) {
    previousInstance.dispose();
  }

  const STORAGE_KEY = 'frameCueSettings';
  const OVERLAY_ID = 'framecue-hud';
  const STYLE_ID = 'framecue-style';
  const FRAME_RATE_KEYS = ['videoFrameRate', 'mozFrameRate', 'webkitFrameRate', 'frameRate'];
  const SEEK_EPSILON = 0.00025;
  const MEDIA_EVENTS = ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ratechange'];
  const HLS_URL = /\.m3u8(?:[?#]|$)/i;
  const TAKEOVER_EVENT = 'framecue:takeover';
  const INSTANCE_TOKEN = Math.random().toString(36).slice(2);
  const IS_MAC = /mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
  );
  const HUD_KEY_STEP_PX = 10;

  let disposed = false;
  let settings = api.normalizeSettings(null);
  let siteAllowed = false;
  let hud = null;
  let hudTimer = 0;
  let hudHideDue = false;
  let lastNotice = '';
  let noticeTimer = 0;
  let pendingStepPromise = Promise.resolve();
  let pendingFrameOffset = 0;
  let lastMedia = null;
  let isSeeking = false;
  let fastForwardMultiplier = 1;
  let measuredFps = null;
  let measuredFpsAt = 0;
  let frameCallbackId = null;
  let frameSampleTimes = [];
  let measuredFpsMedia = null;
  let hlsDetected = false;
  let hudPosition = null;
  let hudDragging = false;
  let holdPlay = null;
  let hlsObserver = null;
  const intervals = [];

  function getHostname() {
    return location.hostname;
  }

  function isTypingTarget(target) {
    if (!target || target === document.body) {
      return false;
    }
    const tag = target.tagName;
    // Native media controls are part of the video surface, not a text field.
    if (tag === 'VIDEO') {
      return false;
    }
    return target.isContentEditable
      || tag === 'INPUT'
      || tag === 'TEXTAREA'
      || tag === 'SELECT'
      || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
  }

  function getVideoCandidates() {
    const videos = Array.from(document.querySelectorAll('video'));
    const audio = Array.from(document.querySelectorAll('audio'));
    return videos.concat(audio)
      .filter((video) => video.readyState > 0 || video.currentSrc || video.src)
      .sort((left, right) => {
        const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
        const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
        if (rightArea !== leftArea) {
          return rightArea - leftArea;
        }
        if (left.paused !== right.paused) {
          return left.paused ? 1 : -1;
        }
        return (right.currentTime || 0) - (left.currentTime || 0);
      });
  }

  function getActiveVideo() {
    const candidates = getVideoCandidates();
    if (!candidates.length) {
      return null;
    }
    return candidates[0];
  }

  function getSeekableEnd(media) {
    if (!media || !media.seekable || !media.seekable.length) {
      return null;
    }
    try {
      const end = media.seekable.end(media.seekable.length - 1);
      return Number.isFinite(end) ? end : null;
    } catch (_) {
      return null;
    }
  }

  function hasPartialDuration(media) {
    const mediaDuration = Number(media && media.duration);
    const seekableEnd = getSeekableEnd(media);
    return !Number.isFinite(mediaDuration)
      || (seekableEnd != null && seekableEnd > mediaDuration + 1);
  }

  function readHlsSource(media) {
    if (!media) {
      return [];
    }
    const sources = Array.from(media.querySelectorAll('source'))
      .map((source) => source.src)
      .filter(Boolean);
    if (media.currentSrc) {
      sources.unshift(media.currentSrc);
    }
    if (media.src) {
      sources.unshift(media.src);
    }
    return sources.filter((source) => HLS_URL.test(source));
  }

  function markHlsIfPresent(media) {
    if (!hlsDetected && readHlsSource(media).length) {
      hlsDetected = true;
    }
  }

  function markHlsDetected() {
    if (hlsDetected) {
      return;
    }
    hlsDetected = true;
    resetFrameRateSamples();
    if (siteAllowed) {
      updateVisibleHud({ reveal: false });
    }
  }

  // Resource Timing exposes the page's playlist requests to the isolated
  // world, so HLS detection needs no MAIN-world hooks on fetch/XHR.
  function watchHlsRequests() {
    if (typeof PerformanceObserver !== 'function') {
      return null;
    }
    const observer = new PerformanceObserver((list) => {
      if (!hlsDetected && list.getEntries().some((entry) => HLS_URL.test(entry.name))) {
        markHlsDetected();
      }
    });
    try {
      observer.observe({ type: 'resource', buffered: true });
    } catch (_) {
      return null;
    }
    return observer;
  }

  function resetFrameRateSamples() {
    measuredFps = null;
    measuredFpsAt = 0;
    frameSampleTimes = [];
  }

  function stopFrameRateMeasurement() {
    if (frameCallbackId != null && measuredFpsMedia
      && typeof measuredFpsMedia.cancelVideoFrameCallback === 'function') {
      try {
        measuredFpsMedia.cancelVideoFrameCallback(frameCallbackId);
      } catch (_) {
        // The callback may have already fired.
      }
    }
    frameCallbackId = null;
    measuredFpsMedia = null;
    resetFrameRateSamples();
  }

  function measureFrameRate(media) {
    if (!settings.measureFrameRate || settings.frameRateMode === 'custom') {
      stopFrameRateMeasurement();
      return;
    }
    if (!media || measuredFpsMedia === media) {
      return;
    }
    stopFrameRateMeasurement();
    measuredFpsMedia = media;

    if (typeof media.requestVideoFrameCallback !== 'function') {
      return;
    }

    const onFrame = (_now, metadata) => {
      if (media !== measuredFpsMedia) {
        return;
      }
      if (Number.isFinite(metadata.mediaTime)) {
        frameSampleTimes.push(metadata.mediaTime);
        if (frameSampleTimes.length > 121) {
          frameSampleTimes.shift();
        }
        const estimate = api.estimateFrameRate(frameSampleTimes) || api.estimateFrameRateFromFrameCount(
          metadata,
          media.currentTime,
        );
        if (estimate) {
          measuredFps = estimate;
          measuredFpsAt = media.currentTime;
        }
      }
      frameCallbackId = media.requestVideoFrameCallback(onFrame);
    };

    frameCallbackId = media.requestVideoFrameCallback(onFrame);
  }

  function readFrameRate(media) {
    if (!media) {
      return null;
    }
    for (const key of FRAME_RATE_KEYS) {
      const value = Number(media[key]);
      if (Number.isFinite(value) && value > 0 && value < 1000) {
        return value;
      }
    }
    return null;
  }

  function readReportedFrameCount(media, fps) {
    if (!media) {
      return null;
    }
    const duration = Number(media.duration);
    const frameRate = api.normalizeFps(fps);
    const candidates = [
      media.totalFrames,
      media.getVideoPlaybackQuality
        ? (() => {
          try {
            const quality = media.getVideoPlaybackQuality();
            return quality && quality.totalVideoFrames;
          } catch (_) {
            return null;
          }
        })()
        : null,
    ];
    for (const candidate of candidates) {
      const value = Number(candidate);
      // Playback quality counts only presented frames, so it undercounts after
      // seeks. It is trustworthy only when it matches duration * fps.
      const expected = duration * frameRate;
      if (Number.isFinite(value) && value > 0
        && (!Number.isFinite(expected) || Math.abs(value - expected) <= Math.max(2, expected * 0.02))) {
        return value;
      }
    }
    return null;
  }

  function getFrameRateInfo(media) {
    const metadataFps = readFrameRate(media);
    const measuredIsStale = measuredFps
      && (hlsDetected
        ? media.currentTime > measuredFpsAt + 300
        : media.currentTime < measuredFpsAt - 1);
    const resolution = api.resolveFrameRate(
      { ...settings, measuredFps: measuredIsStale ? null : measuredFps },
      metadataFps,
    );
    return {
      fps: resolution.fps,
      source: resolution.source,
      metadataFps,
    };
  }

  function getFrameCount(media, fps) {
    return api.resolveFrameCount(media && media.duration, fps, readReportedFrameCount(media, fps));
  }

  function waitForSeek(media, targetTime, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        media.removeEventListener('seeked', onSeeked);
        resolve();
      };
      const onSeeked = () => finish();

      media.addEventListener('seeked', onSeeked, { once: true });
      timer = window.setTimeout(finish, timeoutMs);

      try {
        media.currentTime = targetTime;
      } catch (_) {
        finish();
        return;
      }

      if (Math.abs(media.currentTime - targetTime) < SEEK_EPSILON) {
        finish();
      }
    });
  }

  function setMediaTime(media, targetTime) {
    const duration = Number(media.duration);
    const seekableEnd = getSeekableEnd(media);
    const maxTime = Number.isFinite(duration) && duration > 0
      ? Math.max(duration, seekableEnd || 0)
      : seekableEnd || targetTime;
    const time = api.clamp(targetTime, 0, maxTime);

    if (isSeeking) {
      try {
        media.fastSeek(time);
      } catch (_) {
        media.currentTime = time;
      }
      return Promise.resolve();
    }

    isSeeking = true;
    return waitForSeek(media, time, settings.seekTimeoutMs)
      .finally(() => {
        isSeeking = false;
      });
  }

  function showNotice(message) {
    lastNotice = message;
    updateVisibleHud();
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      lastNotice = '';
      // Re-render in every mode: the notice's is-error class keeps the HUD
      // opaque on its own and must be cleared.
      if (hud) {
        renderHud({ force: true });
      }
      hideHudIfDue();
    }, 2600);
  }

  function isHudVisible() {
    return Boolean(hud && hud.classList.contains('is-visible'));
  }

  // The auto-hide timer can expire while a notice is shown or the HUD is
  // being dragged; hiding is then deferred until that ends.
  function hideHudIfDue() {
    if (!hudHideDue || !hud || hudDragging || lastNotice || settings.hudMode !== 'auto') {
      return;
    }
    hudHideDue = false;
    hud.classList.remove('is-visible');
  }

  function showHudTemporarily() {
    if (disposed || !hud || settings.hudMode === 'off') {
      return;
    }
    hud.classList.add('is-visible');
    clearTimeout(hudTimer);
    hudHideDue = false;
    if (settings.hudMode === 'always') {
      return;
    }
    hudTimer = window.setTimeout(() => {
      hudHideDue = true;
      hideHudIfDue();
    }, 3000);
  }

  function updateVisibleHud({ reveal = true } = {}) {
    if (reveal) {
      showHudTemporarily();
    }
    renderHud({ force: true });
  }

  function clampHudPosition(position) {
    if (!position) {
      return null;
    }
    return {
      xRatio: api.clamp(Number(position.xRatio) || 0, 0, 1),
      yRatio: api.clamp(Number(position.yRatio) || 0, 0, 1),
    };
  }

  function applyHudPosition() {
    if (!hud) {
      return;
    }
    const position = clampHudPosition(hudPosition);
    if (!position) {
      hud.style.left = 'auto';
      hud.style.top = 'auto';
      hud.style.right = '18px';
      hud.style.bottom = '18px';
      return;
    }
    const rect = hud.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
    hud.style.left = `${Math.round(position.xRatio * maxX)}px`;
    hud.style.top = `${Math.round(position.yRatio * maxY)}px`;
  }

  function saveHudPosition() {
    if (!hud) {
      return;
    }
    const rect = hud.getBoundingClientRect();
    const maxX = Math.max(1, window.innerWidth - rect.width);
    const maxY = Math.max(1, window.innerHeight - rect.height);
    hudPosition = clampHudPosition({
      xRatio: rect.left / maxX,
      yRatio: rect.top / maxY,
    });
    // Merge into the stored value: this tab's copy of the settings may be
    // older than a change just made in the popup or the options page.
    const position = hudPosition;
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        return;
      }
      chrome.storage.sync.set({
        [STORAGE_KEY]: api.normalizeSettings({ ...result[STORAGE_KEY], hudPosition: position }),
      });
    });
  }

  function moveHudByKey(event) {
    const delta = event.shiftKey ? HUD_KEY_STEP_PX * 5 : HUD_KEY_STEP_PX;
    const offsets = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const offset = offsets[event.key];
    if (!hud || !offset) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = hud.getBoundingClientRect();
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
    hud.style.left = `${Math.round(api.clamp(rect.left + offset[0], 0, window.innerWidth - rect.width))}px`;
    hud.style.top = `${Math.round(api.clamp(rect.top + offset[1], 0, window.innerHeight - rect.height))}px`;
    showHudTemporarily();
    saveHudPosition();
  }

  function startHudDrag(event) {
    if (!hud || !event.target.closest('.framecue-drag')) {
      return;
    }
    event.preventDefault();
    hudDragging = true;
    const rect = hud.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    hud.classList.add('is-dragging');

    const onMove = (moveEvent) => {
      if (!hud || !hudDragging) {
        return;
      }
      const nextX = api.clamp(moveEvent.clientX - offsetX, 0, window.innerWidth - rect.width);
      const nextY = api.clamp(moveEvent.clientY - offsetY, 0, window.innerHeight - rect.height);
      hud.style.right = 'auto';
      hud.style.bottom = 'auto';
      hud.style.left = `${Math.round(nextX)}px`;
      hud.style.top = `${Math.round(nextY)}px`;
    };

    const onUp = () => {
      hudDragging = false;
      if (hud) {
        hud.classList.remove('is-dragging');
      }
      hideHudIfDue();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      saveHudPosition();
    };

    const onDragVisibilityChange = () => {
      if (hud && settings.hudMode === 'auto') {
        hud.classList.add('is-visible');
      }
    };
    onDragVisibilityChange();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  }

  function ensureHud() {
    if (hud && hud.isConnected) {
      return hud;
    }

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${OVERLAY_ID} {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          box-sizing: border-box;
          min-width: 220px;
          max-width: min(360px, calc(100vw - 36px));
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 8px;
          background: rgba(20, 22, 26, 0.94);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          color: #f2f4f8;
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0;
          pointer-events: auto;
          opacity: 0;
          transition: opacity 120ms ease;
          user-select: none;
        }
        #${OVERLAY_ID}.is-visible,
        #${OVERLAY_ID}.is-error {
          opacity: 1;
        }
        #${OVERLAY_ID}.is-error {
          border-color: rgba(255, 125, 102, 0.65);
        }
        #${OVERLAY_ID} .framecue-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 3px;
        }
        #${OVERLAY_ID} .framecue-title {
          color: #9fd5ff;
          font-weight: 600;
        }
        #${OVERLAY_ID} .framecue-drag {
          flex: none;
          width: 18px;
          height: 18px;
          margin: -3px -4px -3px 0;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: #7f8b99;
          cursor: grab;
          font-size: 13px;
          line-height: 18px;
          text-align: center;
        }
        #${OVERLAY_ID} .framecue-drag:hover,
        #${OVERLAY_ID} .framecue-drag:focus-visible {
          background: rgba(255, 255, 255, 0.09);
          color: #d8e2ec;
          outline: 0;
        }
        #${OVERLAY_ID}.is-dragging .framecue-drag {
          cursor: grabbing;
        }
        #${OVERLAY_ID} .framecue-actions {
          display: flex;
          align-items: center;
          flex: none;
          gap: 1px;
          margin-left: auto;
        }
        #${OVERLAY_ID} .framecue-settings {
          flex: none;
          width: 20px;
          height: 20px;
          padding: 0;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: #7f8b99;
          cursor: pointer;
          font-size: 13px;
          line-height: 20px;
          text-align: center;
        }
        #${OVERLAY_ID} .framecue-settings:hover,
        #${OVERLAY_ID} .framecue-settings:focus-visible {
          background: rgba(255, 255, 255, 0.09);
          color: #d8e2ec;
          outline: 0;
        }
        #${OVERLAY_ID} .framecue-state {
          color: #9ca5b4;
          font-size: 11px;
        }
        #${OVERLAY_ID} .framecue-frame {
          font-size: 14px;
          font-variant-numeric: tabular-nums;
          font-weight: 600;
        }
        #${OVERLAY_ID} .framecue-time {
          color: #aeb7c5;
          font-variant-numeric: tabular-nums;
        }
        #${OVERLAY_ID} .framecue-note {
          margin-top: 5px;
          color: #ffc27d;
          font-size: 11px;
        }
      `;
      document.documentElement.appendChild(style);
    }

    hud = document.createElement('div');
    hud.id = OVERLAY_ID;
    hud.setAttribute('role', 'status');
    hud.setAttribute('aria-live', 'polite');
    hud.innerHTML = `
      <div class="framecue-head">
        <span class="framecue-title">帧刻 FrameCue</span>
          <span class="framecue-state"></span>
          <span class="framecue-actions">
            <button class="framecue-settings" type="button" title="打开 FrameCue 设置" aria-label="打开 FrameCue 设置">⚙</button>
            <span class="framecue-drag" role="button" tabindex="0" title="拖动或用方向键调整位置" aria-label="调整浮层位置：拖动或按方向键">⠿</span>
          </span>
      </div>
      <div class="framecue-frame"></div>
      <div class="framecue-time"></div>
      <div class="framecue-note"></div>
    `;
    hud.addEventListener('pointerdown', startHudDrag);
    hud.querySelector('.framecue-drag').addEventListener('keydown', moveHudByKey);
    hud.querySelector('.framecue-settings').addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    hud.querySelector('.framecue-settings').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      chrome.runtime.sendMessage({ type: 'framecue-command', command: 'open-options' });
    });
    hud.querySelector('.framecue-settings').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        chrome.runtime.sendMessage({ type: 'framecue-command', command: 'open-options' });
      }
    });
    document.documentElement.appendChild(hud);
    applyHudPosition();
    return hud;
  }

  function renderHud({ force = false } = {}) {
    if (disposed || !siteAllowed) {
      if (hud) {
        hud.remove();
        hud = null;
      }
      return;
    }
    if (settings.hudMode === 'off') {
      if (hud) {
        hud.remove();
        hud = null;
      }
      return;
    }

    if (settings.hudMode === 'auto' && !force && !isHudVisible()) {
      return;
    }

    const media = getActiveVideo();
    if (!media) {
      if (hud) {
        hud.classList.remove('is-visible');
      }
      return;
    }

    markHlsIfPresent(media);
    const element = ensureHud();
    const rateInfo = getFrameRateInfo(media);
    const frameCount = getFrameCount(media, rateInfo.fps);
    const seekableEnd = getSeekableEnd(media);
    const frame = api.timeToFrame(media.currentTime, rateInfo.fps);
    const state = media.paused ? '已暂停' : '播放中';
    const rateLabel = rateInfo.source === 'measured'
      ? '实测'
      : rateInfo.source === 'metadata'
        ? '视频'
        : rateInfo.source === 'custom'
          ? '手动'
          : '默认';
    const playbackRate = Number(media.playbackRate) || 1;
    const rateSuffix = Math.abs(playbackRate - 1) > 0.01 ? ` · ${playbackRate.toFixed(2)}×` : '';

    const note = lastNotice || holdPlaybackNote();
    element.classList.toggle('is-error', Boolean(note));
    const hlsSuffix = hlsDetected ? ' · HLS' : '';
    element.querySelector('.framecue-state').textContent = `${state}${rateSuffix}${hlsSuffix} · ${rateInfo.fps} fps ${rateLabel}`;
    const durationComplete = api.isDurationComplete(media.duration, seekableEnd);
    element.querySelector('.framecue-frame').textContent = api.formatFrameProgress(
      media.currentTime,
      rateInfo.fps,
      frameCount,
      durationComplete,
    );
    element.querySelector('.framecue-time').textContent = `${api.formatClock(media.currentTime)} · 左右键逐帧`;
    element.querySelector('.framecue-note').textContent = note;
  }

  function pauseMedia(media) {
    if (!media.paused) {
      media.pause();
      if (holdPlay) {
        const state = holdPlay;
        holdPlay = null;
        clearTimeout(state.timer);
      }
    }
  }

  function togglePlayback() {
    const media = getActiveVideo();
    if (!media) {
      showNotice('当前页面没有可控制的视频');
      return;
    }
    if (media.paused) {
      if (holdPlay) {
        const state = holdPlay;
        holdPlay = null;
        clearTimeout(state.timer);
      }
      media.play().catch(notifyPlayBlocked);
    } else {
      media.pause();
    }
    updateVisibleHud();
  }

  function queueFrameAction(action) {
    pendingStepPromise = pendingStepPromise
      .then(action)
      .catch((error) => {
        console.warn('[FrameCue]', error);
        showNotice(error.message || String(error));
      });
    return pendingStepPromise;
  }

  /**
   * Hold rapid key presses in one short batch. Each press adds a frame offset,
   * then the queue seeks once to the final frame boundary.
   */
  async function stepFrameBatched(direction) {
    const media = getActiveVideo();
    if (!media) {
      showNotice('当前页面没有可控制的视频');
      return;
    }

    const rateInfo = getFrameRateInfo(media);
    const wasPlaying = !media.paused;
    pauseMedia(media);
    if (wasPlaying) {
      pendingFrameOffset = 0;
      const step = api.stepTime(media.currentTime, direction, rateInfo.fps, media.duration);
      await setMediaTime(media, api.seekTimeForFrame(step.targetFrame, rateInfo.fps));
      updateVisibleHud();
      return;
    }
    pendingFrameOffset += direction < 0 ? -1 : 1;
    await new Promise((resolve) => window.setTimeout(resolve, api.DEFAULT_WAIT_MS));
    if (pendingFrameOffset === 0) {
      updateVisibleHud({ reveal: false });
      return;
    }

    const offset = pendingFrameOffset;
    pendingFrameOffset = 0;
    const currentFrame = api.timeToFrame(media.currentTime, rateInfo.fps);
    let targetFrame = Math.max(0, currentFrame + offset);
    await setMediaTime(media, api.seekTimeForFrame(targetFrame, rateInfo.fps));
    updateVisibleHud();
  }

  function jumpToEdge(edge) {
    const media = getActiveVideo();
    if (!media) {
      showNotice('当前页面没有可控制的视频');
      return;
    }

    pauseMedia(media);
    const rateInfo = getFrameRateInfo(media);
    const frameCount = getFrameCount(media, rateInfo.fps);
    const lastFrameTime = Math.max(0, api.frameToTime(Math.max(0, frameCount - 1), rateInfo.fps));
    const duration = Number(media.duration);
    const target = edge === 'start'
      ? 0
      : Number.isFinite(duration) && duration > 0
        ? Math.min(duration, lastFrameTime)
        : lastFrameTime;

    setMediaTime(media, target).then(() => {
      updateVisibleHud();
    });
  }

  function cycleRate(direction) {
    const media = getActiveVideo();
    if (!media) {
      showNotice('当前页面没有可控制的视频');
      return;
    }
    const baseRate = 1;
    const maxRate = 2;
    const step = 0.25;
    const current = Number(media.playbackRate) || baseRate;

    if (Math.abs(media.playbackRate - baseRate) < 0.05) {
      fastForwardMultiplier = 1;
    }
    fastForwardMultiplier += direction > 0 ? step : -step;
    fastForwardMultiplier = api.clamp(fastForwardMultiplier, baseRate, maxRate);

    media.playbackRate = fastForwardMultiplier;
    media.play().catch(() => {});
    showNotice(`${direction > 0 ? '快进' : '倒回'} ${fastForwardMultiplier.toFixed(2)}×`);
    updateVisibleHud();
  }

  function isHoldPlaying(state = holdPlay) {
    return Boolean(state && state.activated && state.playStarted && holdPlay === state);
  }

  function holdPlaybackNote() {
    if (!isHoldPlaying()) {
      return '';
    }
    const media = holdPlay.media;
    return `音量 ${Number(media.volume * 100).toFixed(0)}%${media.muted ? '（当前静音）' : ''}`;
  }

  // Holding → is a continuous run of frame steps, so the HUD stays up and
  // tracks every presented frame until the key is released.
  function followHoldPlayback(state) {
    const media = state.media;
    const tick = () => {
      if (disposed || !isHoldPlaying(state)) {
        return;
      }
      updateVisibleHud();
      if (typeof media.requestVideoFrameCallback === 'function') {
        media.requestVideoFrameCallback(tick);
      } else {
        window.requestAnimationFrame(tick);
      }
    };
    tick();
  }

  function startHoldPlayback() {
    const state = holdPlay;
    if (!state || state.activated) {
      return;
    }
    const media = state.media || getActiveVideo();
    if (!media) {
      holdPlay = null;
      return;
    }
    state.activated = true;
    state.stepped = false;
    state.media = media;
    state.previousRate = Number(media.playbackRate) || 1;
    state.startedAt = Number(media.currentTime) || 0;
    state.startedAtClock = performance.now();
    media.playbackRate = state.rate;
    state.playStarted = false;
    media.play().then(() => {
      state.playStarted = true;
      followHoldPlayback(state);
    }).catch(() => {
      state.playStarted = false;
      notifyPlayBlocked();
    });
    pendingFrameOffset = 0;
    updateVisibleHud();
  }

  function stopHoldPlayback() {
    const state = holdPlay;
    holdPlay = null;
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    if (!state.activated) {
      return;
    }
    if (!state.playStarted) {
      return;
    }
    const media = state.media;
    if (!media) {
      return;
    }
    media.pause();
    media.playbackRate = state.previousRate;
    const finish = () => {
      updateVisibleHud();
    };
    const rateInfo = getFrameRateInfo(media);
    const targetTime = api.resolveHoldPlayPosition(
      state.startedAt,
      (performance.now() - state.startedAtClock) / 1000,
    );
    const targetFrame = api.timeToFrame(targetTime, rateInfo.fps);
    setMediaTime(media, api.seekTimeForFrame(targetFrame, rateInfo.fps)).then(finish);
  }

  // Browsers reject play() without a user gesture on some pages. Tell the user
  // instead of synthesizing clicks, which could land on ads or links.
  function notifyPlayBlocked() {
    showNotice('浏览器阻止了播放，请先点击一次页面中的播放器');
  }

  function currentStatus() {
    if (!settings.enabled) {
      return {
        found: false,
        enabled: false,
        siteAllowed: globalThis.FrameCueSiteRules
          ? globalThis.FrameCueSiteRules.siteDecision(settings, getHostname()).allowed
          : false,
        masterOff: true,
      };
    }
    if (!siteAllowed) {
      return { found: false, enabled: settings.enabled, siteAllowed: false };
    }
    const media = getActiveVideo();
    if (!media) {
      return { found: false, enabled: settings.enabled, siteAllowed: true, hls: hlsDetected };
    }
    const rateInfo = getFrameRateInfo(media);
    const frameCount = getFrameCount(media, rateInfo.fps);
    const mediaDuration = Number(media.duration);
    const seekableEnd = getSeekableEnd(media);
    return {
      found: true,
      enabled: settings.enabled,
      paused: media.paused,
      currentTime: media.currentTime,
      duration: mediaDuration,
      seekableEnd,
      durationMayGrow: hasPartialDuration(media),
      fps: rateInfo.fps,
      fpsSource: rateInfo.source,
      frame: api.timeToFrame(media.currentTime, rateInfo.fps),
      frameCount,
      playbackRate: media.playbackRate,
      siteAllowed: true,
      hls: hlsDetected,
    };
  }

  function safeCommand(action) {
    try {
      const result = action();
      if (result && typeof result.then === 'function') {
        result.catch((error) => console.warn('[FrameCue]', error));
      }
    } catch (error) {
      console.warn('[FrameCue]', error);
    }
  }

  function isHudTarget(target) {
    return Boolean(hud && target instanceof Node && hud.contains(target));
  }

  // macOS keeps the ⌘/⌥ chords. On Windows/Linux Alt+←/→ is browser
  // back/forward, so edges use Home/End there and speed uses Ctrl.
  function resolveShortcut(event) {
    const command = IS_MAC ? event.metaKey : event.ctrlKey;
    const option = IS_MAC && event.altKey;
    const foreignModifier = IS_MAC ? event.ctrlKey : event.metaKey || event.altKey;
    if (foreignModifier || (command && option)) {
      return null;
    }
    const plain = !command && !option;
    switch (event.code) {
      case 'Space':
        return plain && !event.shiftKey ? 'play-pause' : null;
      case 'ArrowLeft':
        return command ? 'rate-down' : option ? 'go-start' : 'step-back';
      case 'ArrowRight':
        return command ? 'rate-up' : option ? 'go-end' : 'step-forward';
      case 'Home':
        return plain ? 'go-start' : null;
      case 'End':
        return plain ? 'go-end' : null;
      case 'KeyF':
        return plain && !event.shiftKey ? 'fullscreen' : null;
      default:
        return null;
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const media = getActiveVideo();
    const target = media && (media.closest('.video-player, [class*="player"]') || media);
    if (target && target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    }
  }

  function onKeyDown(event) {
    if (disposed) {
      return;
    }
    if (!isContextAlive()) {
      dispose();
      return;
    }
    if (!siteAllowed || !settings.enabled || event.isComposing) {
      return;
    }
    if (holdPlay && event.repeat && event.code === 'ArrowRight') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.defaultPrevented && holdPlay) {
      return;
    }
    if (isTypingTarget(event.target) || isHudTarget(event.target)) {
      return;
    }
    const shortcut = resolveShortcut(event);
    // Pages without media keep their own arrow-key scrolling and shortcuts.
    if (!shortcut || !getActiveVideo()) {
      return;
    }

    switch (shortcut) {
      case 'play-pause':
        safeCommand(togglePlayback);
        break;
      case 'step-back':
        safeCommand(() => queueFrameAction(() => stepFrameBatched(-1)));
        break;
      case 'step-forward':
        if (settings.hudMode !== 'off') {
          showHudTemporarily();
        }
        if (!holdPlay) {
          holdPlay = {
            activated: false,
            stepped: false,
            media: getActiveVideo(),
            rate: 1,
            timer: window.setTimeout(startHoldPlaybackTimer, api.HOLD_PLAY_DELAY_MS),
          };
          pendingFrameOffset = 0;
        }
        if (!holdPlay.stepped && !holdPlay.activated) {
          holdPlay.stepped = true;
          safeCommand(() => queueFrameAction(() => stepFrameBatched(1)));
        }
        break;
      case 'rate-down':
        safeCommand(() => cycleRate(-1));
        break;
      case 'rate-up':
        safeCommand(() => cycleRate(1));
        break;
      case 'go-start':
        safeCommand(() => jumpToEdge('start'));
        break;
      case 'go-end':
        safeCommand(() => jumpToEdge('end'));
        break;
      case 'fullscreen':
        safeCommand(toggleFullscreen);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function startHoldPlaybackTimer() {
    const state = holdPlay;
    if (!state || state.activated) {
      return;
    }
    startHoldPlayback();
  }


  function onKeyUp(event) {
    if (disposed) {
      return;
    }
    if (event.code === 'ArrowRight' && holdPlay) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!holdPlay.activated) {
        const state = holdPlay;
        holdPlay = null;
        clearTimeout(state.timer);
        if (!state.stepped) {
          safeCommand(() => queueFrameAction(() => stepFrameBatched(1)));
        }
        return;
      }
      safeCommand(stopHoldPlayback);
    }
  }

  function attachMediaTracking() {
    if (disposed) {
      return;
    }
    if (!isContextAlive()) {
      dispose();
      return;
    }
    const current = getActiveVideo();
    if (!current || current === lastMedia) {
      return;
    }
    lastMedia = current;
    markHlsIfPresent(current);
    measureFrameRate(current);
    MEDIA_EVENTS.forEach((eventName) => {
      current.addEventListener(eventName, () => {
        if (!disposed && settings.hudMode === 'always') {
          renderHud({ force: true });
        }
      });
    });
  }

  function applySettings(nextSettings) {
    if (disposed) {
      return;
    }
    settings = api.normalizeSettings(nextSettings);
    const decision = globalThis.FrameCueSiteRules
      ? globalThis.FrameCueSiteRules.siteDecision(settings, getHostname())
      : { allowed: false };
    siteAllowed = settings.enabled && decision.allowed;
    hudPosition = settings.hudPosition;
    if (!siteAllowed) {
      stopFrameRateMeasurement();
      if (hud) {
        hud.remove();
        hud = null;
      }
      noticeTimer = 0;
      lastNotice = '';
      document.documentElement.removeAttribute('data-framecue-page');
      return;
    }
    // Starts or stops sampling to match the settings; an unrelated change
    // (such as a HUD move) leaves an ongoing measurement intact.
    measureFrameRate(lastMedia);
    document.documentElement.setAttribute('data-framecue-page', '');
    if (settings.hudMode === 'off') {
      if (hud) {
        hud.remove();
        hud = null;
      }
    } else if (settings.hudMode === 'always') {
      updateVisibleHud();
    } else if (hud) {
      hud.classList.remove('is-visible');
    }
    applyHudPosition();
  }

  function loadSettings() {
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[FrameCue]', chrome.runtime.lastError.message);
        return;
      }
      applySettings(result[STORAGE_KEY]);
    });
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'sync' || !changes[STORAGE_KEY]) {
      return;
    }
    applySettings(changes[STORAGE_KEY].newValue);
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (disposed || !message || message.type !== 'framecue-command') {
      return false;
    }

    switch (message.command) {
      case 'status':
        sendResponse(currentStatus());
        break;
      case 'config':
        applySettings(message.settings);
        attachMediaTracking();
        sendResponse({ ok: true, siteAllowed, hostname: getHostname() });
        break;
      case 'site-status':
        sendResponse({
          siteAllowed,
          enabled: settings.enabled,
          hostname: getHostname(),
          loaded: true,
        });
        break;
      case 'site-state':
        sendResponse({
          siteAllowed,
          hostname: getHostname(),
          hls: hlsDetected,
          measureFrameRateSupported: typeof HTMLVideoElement !== 'undefined'
            && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
        });
        break;
      case 'play-pause':
        safeCommand(togglePlayback);
        sendResponse({ ok: true });
        break;
      case 'step-back':
        safeCommand(() => queueFrameAction(() => stepFrameBatched(-1)));
        sendResponse({ ok: true });
        break;
      case 'step-forward':
        safeCommand(() => queueFrameAction(() => stepFrameBatched(1)));
        sendResponse({ ok: true });
        break;
      case 'go-start':
        jumpToEdge('start');
        sendResponse({ ok: true });
        break;
      case 'go-end':
        jumpToEdge('end');
        sendResponse({ ok: true });
        break;
      case 'refresh-site':
        applySettings(settings);
        attachMediaTracking();
        sendResponse({ ok: true, siteAllowed });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown command' });
    }
    return false;
  }

  // A newer instance in another isolated world announces itself through the
  // shared DOM. Pages can dispatch this too, so only a dead instance yields.
  function onTakeover(event) {
    if (event.detail !== INSTANCE_TOKEN && !isContextAlive()) {
      dispose();
    }
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener(TAKEOVER_EVENT, onTakeover);
    intervals.forEach((id) => clearInterval(id));
    clearTimeout(hudTimer);
    clearTimeout(noticeTimer);
    if (holdPlay) {
      clearTimeout(holdPlay.timer);
      holdPlay = null;
    }
    if (hlsObserver) {
      hlsObserver.disconnect();
      hlsObserver = null;
    }
    stopFrameRateMeasurement();
    if (hud) {
      hud.remove();
      hud = null;
    }
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
    document.documentElement.removeAttribute('data-framecue-page');
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {
      // The extension context is already gone.
    }
    if (globalThis.__frameCueInstance && globalThis.__frameCueInstance.token === INSTANCE_TOKEN) {
      globalThis.__frameCueInstance = null;
    }
  }

  globalThis.__frameCueInstance = {
    token: INSTANCE_TOKEN,
    isAlive: () => !disposed && isContextAlive(),
    dispose,
  };
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: INSTANCE_TOKEN }));
  document.addEventListener(TAKEOVER_EVENT, onTakeover);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  hlsObserver = watchHlsRequests();

  loadSettings();
  intervals.push(window.setInterval(attachMediaTracking, 1000));
  intervals.push(window.setInterval(() => {
    if (settings.enabled
      && settings.hudMode === 'always'
      && !isSeeking) {
      renderHud();
    }
  }, 500));
})();
