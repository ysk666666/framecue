'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const api = require('../src/frame-math.js');

test('time and frame conversion keeps frame boundaries stable', () => {
  assert.equal(api.timeToFrame(0, 30), 0);
  assert.equal(api.timeToFrame(1 / 30, 30), 1);
  assert.equal(api.timeToFrame(1 - 1e-5, 30), 29);
  assert.equal(api.frameToTime(15, 30), 0.5);
  assert.ok(api.seekTimeForFrame(15, 30) > 0.5);
  assert.equal(api.timeToFrame(api.seekTimeForFrame(15, 30), 30), 15);
});

test('frame stepping remains accurate for a 15fps review recording', () => {
  const stepForward = api.stepTime(59.5, 1, 15, 192);
  const stepBack = api.stepTime(stepForward.targetTime, -1, 15, 192);
  assert.equal(stepForward.targetFrame, 893);
  assert.ok(Math.abs(stepForward.targetTime - 893 / 15) < 1e-9);
  assert.ok(Math.abs(stepBack.targetTime - 892 / 15) < 1e-9);
});

test('right arrow moves exactly one frame from inside a frame', () => {
  const step = api.stepTime(1.04, 1, 30, 10);
  assert.equal(step.currentFrame, 31);
  assert.equal(step.targetFrame, 32);
  assert.ok(Math.abs(step.targetTime - 32 / 30) < 1e-9);
});

test('left arrow moves exactly one frame from inside a frame', () => {
  const step = api.stepTime(1.04, -1, 30, 10);
  assert.equal(step.currentFrame, 31);
  assert.equal(step.targetFrame, 30);
  assert.ok(Math.abs(step.targetTime - 1) < 1e-9);
});

test('stepping is clamped at both ends', () => {
  assert.deepEqual(api.stepTime(0, -1, 25, 1), {
    currentFrame: 0,
    targetFrame: 0,
    targetTime: 0,
  });
  assert.deepEqual(api.stepTime(1, 1, 25, 1), {
    currentFrame: 25,
    targetFrame: 26,
    targetTime: 1,
  });
});

test('auto frame rate uses metadata before fallback', () => {
  assert.deepEqual(
    api.resolveFrameRate({ frameRateMode: 'auto', fps: 30 }, 59.94),
    { fps: 59.94, source: 'metadata' },
  );
  assert.deepEqual(
    api.resolveFrameRate({ frameRateMode: 'auto', fps: 25 }, null),
    { fps: 25, source: 'fallback' },
  );
  assert.deepEqual(
    api.resolveFrameRate({ frameRateMode: 'custom', fps: 24 }, 59.94),
    { fps: 24, source: 'custom' },
  );
});

test('frame count and progress use the last presented frame', () => {
  assert.equal(api.resolveFrameCount(2.5, 30, null), 75);
  assert.equal(api.resolveFrameCount(1, 30, null), 30);
  assert.equal(api.resolveFrameCount(2.5, 30, 99), 99);
  assert.equal(api.formatFrameProgress(0, 30, 75, true), '帧 0 / 74');
  assert.equal(api.formatFrameProgress(2.4667, 30, 75, true), '帧 74 / 74');
  assert.equal(api.formatFrameProgress(1, 30, 75, false), '帧 30 · 总帧数待加载');
});

test('clock formatting keeps milliseconds', () => {
  assert.equal(api.formatClock(62.345), '01:02.345');
  assert.equal(api.formatClock(3723.5), '1:02:03.500');
});

test('settings normalize invalid values safely', () => {
  assert.deepEqual(api.normalizeSettings({ enabled: false, fps: 0, frameRateMode: 'custom' }), {
    enabled: false,
    frameRateMode: 'custom',
    fps: 30,
    allowlist: [],
    blocklist: [],
    measureFrameRate: true,
    hudMode: 'auto',
    hudDurationMs: 3000,
    stepSeconds: 1 / 30,
    seekTimeoutMs: 1500,
    hudPosition: null,
  });
  assert.equal(api.normalizeSettings({ hudMode: 'always' }).hudMode, 'always');
  assert.equal(api.normalizeSettings({ hudMode: 'off' }).hudMode, 'off');
  assert.equal(api.normalizeFps(1000), 240);
  assert.equal(api.normalizeFps(-3), 1);
  assert.equal(api.normalizeFps(0), 30);
});

test('measured frame rate overrides metadata in auto mode', () => {
  assert.deepEqual(
    api.resolveFrameRate({ frameRateMode: 'auto', fps: 30, measuredFps: 15 }, 60),
    { fps: 15, source: 'measured' },
  );
  assert.deepEqual(
    api.resolveFrameRate({ frameRateMode: 'custom', fps: 15, measuredFps: 60 }, 30),
    { fps: 15, source: 'custom' },
  );
});

test('frame rate estimator rejects pauses and snaps common rates', () => {
  const times = Array.from({ length: 31 }, (_, index) => index / 30);
  assert.equal(api.estimateFrameRate(times), 30);
  assert.equal(api.estimateFrameRate(times.concat([10, 10.5])), 30);
  assert.equal(api.estimateFrameRate([0, 0.033, 0.066]), null);
  assert.equal(api.snapFrameRate(29.9705), 29.97);
  assert.equal(api.estimateFrameRateFromFrameCount({ presentedFrames: 300 }, 10), 30);
  assert.equal(api.estimateFrameRateFromFrameCount({ presentedFrames: 20 }, 10), null);
});

test('frame count is complete for HLS once duration is known', () => {
  assert.equal(api.isDurationComplete(192, 192), true);
  assert.equal(api.isDurationComplete(192, 240), false);
  assert.equal(api.isDurationComplete(Infinity, 240), false);
  assert.equal(api.formatFrameProgress(1, 30, 5760, true), '帧 30 / 5759');
  assert.equal(api.formatFrameProgress(1, 30, 5760, false), '帧 30 · 总帧数待加载');
});

test('hold playback position advances from start time', () => {
  assert.equal(api.resolveHoldPlayPosition(10, 0.25), 10.25);
  assert.equal(api.resolveHoldPlayPosition(0, -1), 0);
});
