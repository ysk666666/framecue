(function initFrameMath(root) {
  'use strict';

  const DEFAULT_FPS = 30;
  const MIN_FPS = 1;
  const MAX_FPS = 240;
  const DEFAULT_STEP_SECONDS = 1 / DEFAULT_FPS;
  const DEFAULT_WAIT_MS = 85;
  const DEFAULT_SEEK_TIMEOUT_MS = 1500;
  const HOLD_PLAY_DELAY_MS = 420;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeFps(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) {
      return DEFAULT_FPS;
    }
    return Math.round(clamp(numeric, MIN_FPS, MAX_FPS) * 1000) / 1000;
  }

  function resolveFrameRate(settings, metadataFps) {
    const mode = settings && settings.frameRateMode;
    const configuredFps = normalizeFps(settings && settings.fps);
    const detectedFps = normalizeFps(metadataFps);
    const measuredFps = settings && settings.measuredFps
      ? Number(settings.measuredFps)
      : null;

    if (mode === 'custom') {
      return { fps: configuredFps, source: 'custom' };
    }
    if (measuredFps && Number.isFinite(measuredFps) && measuredFps > 0) {
      return { fps: normalizeFps(measuredFps), source: 'measured' };
    }
    if (metadataFps && Number.isFinite(Number(metadataFps)) && Number(metadataFps) > 0) {
      return { fps: detectedFps, source: 'metadata' };
    }
    return { fps: configuredFps, source: 'fallback' };
  }

  function median(values) {
    const sorted = values
      .map(Number)
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (!sorted.length) {
      return null;
    }
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function snapFrameRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const commonRates = [
      23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120,
      14.985, 15, 12.5, 20, 10, 5,
    ];
    let closest = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const rate of commonRates) {
      const delta = Math.abs(rate - numeric);
      if (delta < distance) {
        distance = delta;
        closest = rate;
      }
    }
    return distance / numeric <= 0.2 ? closest : Math.round(numeric * 1000) / 1000;
  }

  /**
   * Estimate CFR from media timestamps reported by requestVideoFrameCallback.
   * Reject pause/seek gaps and implausible jitter before taking the median.
   */
  function estimateFrameRate(mediaTimes) {
    const times = Array.from(mediaTimes || [])
      .map(Number)
      .filter((value) => Number.isFinite(value));
    const deltas = [];
    for (let index = 1; index < times.length; index += 1) {
      const delta = times[index] - times[index - 1];
      if (delta > 0.0005 && delta < 0.25) {
        deltas.push(delta);
      }
    }
    if (deltas.length < 5) {
      return null;
    }
    const center = median(deltas);
    const filtered = deltas.filter((delta) => Math.abs(delta - center) / center < 0.2);
    if (filtered.length < 5) {
      return null;
    }
    const estimate = 1 / median(filtered);
    return estimate >= 1 && estimate <= 240 ? snapFrameRate(estimate) : null;
  }

  function estimateFrameRateFromFrameCount(metadata, mediaTime) {
    const presented = Number(metadata && metadata.presentedFrames);
    const time = Number(mediaTime);
    if (!Number.isFinite(presented) || presented < 30 || !Number.isFinite(time) || time < 1) {
      return null;
    }
    const rate = presented / time;
    return rate >= 1 && rate <= 240 ? snapFrameRate(rate) : null;
  }

  function frameDuration(fps) {
    return 1 / normalizeFps(fps);
  }

  function timeToFrame(time, fps) {
    const safeTime = Math.max(0, Number(time) || 0);
    return Math.floor(safeTime * normalizeFps(fps) + 1e-6);
  }

  function frameToTime(frame, fps) {
    const safeFrame = Math.max(0, Math.trunc(Number(frame) || 0));
    return safeFrame / normalizeFps(fps);
  }

  // Chrome may round a seek on an exact PTS boundary to the following frame.
  // Apply the small nudge only when assigning currentTime.
  function seekTimeForFrame(frame, fps) {
    const time = frameToTime(frame, fps);
    return Math.max(0, time + Math.min(0.0006, time / 2));
  }

  /**
   * Snap to the frame boundary on the side we are stepping away from, then
   * advance exactly one frame. This avoids repeatedly seeking inside the same
   * frame when currentTime is slightly ahead of the displayed frame.
   */
  function stepTime(currentTime, direction, fps, duration) {
    const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
      ? Number(duration)
      : Number.POSITIVE_INFINITY;
    const rate = normalizeFps(fps);
    const currentFrame = timeToFrame(currentTime, rate);
    const targetFrame = Math.max(0, currentFrame + (direction < 0 ? -1 : 1));
    const targetTime = clamp(frameToTime(targetFrame, rate), 0, safeDuration);
    return {
      currentFrame,
      targetFrame,
      targetTime: Number.isFinite(targetTime) ? targetTime : frameToTime(targetFrame, rate),
    };
  }

  /**
   * Prefer a reported frame count; otherwise derive it from media duration and
   * frame rate. Fixed fps is accurate for CFR sources, which is the common case
   * for review recordings.
   */
  function resolveFrameCount(duration, fps, reportedFrames) {
    const frames = Number(reportedFrames);
    if (Number.isFinite(frames) && frames > 0) {
      return Math.floor(frames);
    }
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return 0;
    }
    // Rounding can count the terminal boundary as an additional frame.
    return Math.max(1, Math.ceil(seconds * normalizeFps(fps) - 1e-6));
  }

  function formatClock(time) {
    const safeTime = Math.max(0, Number(time) || 0);
    const hours = Math.floor(safeTime / 3600);
    const minutes = Math.floor((safeTime % 3600) / 60);
    const seconds = Math.floor(safeTime % 60);
    const milliseconds = Math.round((safeTime % 1) * 1000) % 1000;
    const base = hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${base}.${String(milliseconds).padStart(3, '0')}`;
  }

  function formatFrameProgress(currentTime, fps, frameCount, durationComplete) {
    const frame = timeToFrame(currentTime, fps);
    if (!durationComplete || !frameCount) {
      return `帧 ${frame} · 总帧数待加载`;
    }
    return `帧 ${frame} / ${Math.max(0, frameCount - 1)}`;
  }

  function isDurationComplete(duration, seekableEnd) {
    const total = Number(duration);
    if (!Number.isFinite(total) || total <= 0) {
      return false;
    }
    const available = Number(seekableEnd);
    return !Number.isFinite(available) || available <= total + 1;
  }

  function resolveHoldPlayPosition(currentTime, elapsedSeconds) {
    return Math.max(0, Number(currentTime) || 0) + Math.max(0, Number(elapsedSeconds) || 0);
  }

  function normalizeSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const hudMode = ['auto', 'always', 'off'].includes(input.hudMode)
      ? input.hudMode
      : input.showHud === false
        ? 'off'
        : 'auto';
    return {
      enabled: input.enabled !== false,
      frameRateMode: input.frameRateMode === 'custom' ? 'custom' : 'auto',
      fps: normalizeFps(input.fps == null ? DEFAULT_FPS : input.fps),
      allowlist: Array.isArray(input.allowlist) ? input.allowlist : [],
      blocklist: Array.isArray(input.blocklist) ? input.blocklist : [],
      measureFrameRate: input.measureFrameRate !== false,
      hudMode,
      hudDurationMs: 3000,
      stepSeconds: DEFAULT_STEP_SECONDS,
      seekTimeoutMs: DEFAULT_SEEK_TIMEOUT_MS,
      hudPosition: input.hudPosition
        && Number.isFinite(Number(input.hudPosition.xRatio))
        && Number.isFinite(Number(input.hudPosition.yRatio))
        ? {
          xRatio: clamp(Number(input.hudPosition.xRatio), 0, 1),
          yRatio: clamp(Number(input.hudPosition.yRatio), 0, 1),
        }
        : null,
    };
  }

  const api = {
    DEFAULT_FPS,
    DEFAULT_STEP_SECONDS,
    DEFAULT_WAIT_MS,
    DEFAULT_SEEK_TIMEOUT_MS,
    HOLD_PLAY_DELAY_MS,
    clamp,
    normalizeFps,
    normalizeSettings,
    resolveFrameRate,
    median,
    snapFrameRate,
    estimateFrameRate,
    estimateFrameRateFromFrameCount,
    frameDuration,
    timeToFrame,
    frameToTime,
    seekTimeForFrame,
    stepTime,
    resolveFrameCount,
    formatClock,
    formatFrameProgress,
    isDurationComplete,
    resolveHoldPlayPosition,
  };

  root.FrameCueMath = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
