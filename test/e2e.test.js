'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const PAGE_ROUTE = '/video';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
};

function createFixtureServer() {
  return http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url.startsWith(`${PAGE_ROUTE}?`) || request.url === PAGE_ROUTE || request.url === '/') {
      response.writeHead(200, { 'Content-Type': contentTypes['.html'] });
      fs.createReadStream(path.join(TEST_DIR, 'fixture.html')).pipe(response);
      return;
    }

    const fileName = path.basename(new URL(request.url, 'http://localhost').pathname);
    const filePath = path.join(TEST_DIR, fileName);
    if (!filePath.startsWith(TEST_DIR) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const fileSize = fs.statSync(filePath).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : fileSize - 1;
      response.writeHead(206, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

test('FrameCue steps exactly one frame with arrow keys', async (t) => {
  // An unprivileged port keeps the suite runnable without root on Linux.
  const origin = process.env.FRAMECUE_ORIGIN || 'http://localhost:47831';
  const server = createFixtureServer();
  const port = Number(new URL(origin).port || 80);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecue-chrome-'));
  const testExtensionPath = path.join(userDataDir, 'extension');
  fs.cpSync(EXTENSION_PATH, testExtensionPath, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(EXTENSION_PATH, source);
      return !/^(node_modules|dist|\.git)(\/|$)/.test(relative)
        && !relative.startsWith(path.join('test', '.chrome-profile'));
    },
  });
  const testManifestPath = path.join(testExtensionPath, 'manifest.json');
  const testManifest = JSON.parse(fs.readFileSync(testManifestPath, 'utf8'));
  testManifest.optional_host_permissions = ['*://localhost/*'];
  testManifest.host_permissions = ['*://localhost/*'];
  fs.writeFileSync(testManifestPath, `${JSON.stringify(testManifest, null, 2)}\n`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
    ],
    args: [
      `--disable-extensions-except=${testExtensionPath}`,
      `--load-extension=${testExtensionPath}`,
      '--disable-component-extensions-with-background-pages',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  t.after(async () => {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const extensionPage = await context.newPage();
  await extensionPage.goto('chrome://extensions/');
  const extensionId = await extensionPage.locator('extensions-item').first().getAttribute('id');
  await extensionPage.close();
  assert.ok(extensionId, 'could not read the loaded extension id');
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('pageerror', (error) => popupErrors.push(error.message));
  await popup.setViewportSize({ width: 380, height: 800 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForTimeout(400);
  assert.deepEqual(popupErrors, [], 'popup should not throw');
  assert.match(
    await popup.locator('h1').innerText(),
    /帧刻/,
    'popup should use the FrameCue brand',
  );
  // Opened as a page the popup has no activeTab grant, so the site section
  // stays hidden; it only needs to be present.
  assert.equal(
    await popup.locator('#site-section #site-toggle').count(),
    1,
    'popup should include the current-site controls',
  );
  assert.equal(
    await popup.locator('.switch-label').innerText(),
    '总开关',
    'the header switch should be labelled as the master switch',
  );
  assert.equal(
    await popup.locator('.open-section, #video-url').count(),
    0,
    'the old page-opening entry point must be removed',
  );
  await popup.close();

  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('[page]', error));
  await page.goto(`${origin}${PAGE_ROUTE}`);
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(() => document.documentElement.hasAttribute('data-framecue-page')),
    false,
    'an unlisted site must not receive the extension',
  );
  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await settingsPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.set({
      frameCueSettings: {
        enabled: true,
        frameRateMode: 'auto',
        fps: 30,
        allowlist: ['localhost'],
        blocklist: [],
        measureFrameRate: true,
        hudMode: 'auto',
      },
    }, resolve);
  }));
  await settingsPage.close();
  await page.reload();
  await page.waitForTimeout(700);
  const extensionLoaded = await page.evaluate(
    () => document.documentElement.hasAttribute('data-framecue-page'),
  ).catch(() => false);
  if (!extensionLoaded) {
    const extensions = await context.newPage();
    await extensions.goto('chrome://extensions/');
    await extensions.waitForTimeout(700);
    await extensions.waitForTimeout(500);
    const details = await extensions.evaluate(() => {
      function textOf(root) {
        let text = root.textContent || '';
        for (const child of root.children || []) {
          if (child.shadowRoot) {
            text += `\n${textOf(child.shadowRoot)}`;
          }
          text += `\n${textOf(child)}`;
        }
        return text;
      }
      return textOf(document.documentElement);
    });
    console.error('[extensions]', details.replace(/\s+/g, ' ').slice(0, 4000));
  }
  assert.equal(extensionLoaded, true, 'content script did not load into the fixture page');
  assert.equal(
    await page.evaluate(() => document.documentElement.hasAttribute('data-framecue-page')),
    true,
    'content script should enable an allowlisted site',
  );

  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.playbackRate = 4;
    return video.play();
  });
  await page.waitForFunction(() => document.querySelector('#test-video').currentTime > 1, null, {
    timeout: 5000,
  });
  assert.equal(
    await page.locator('#framecue-hud').count(),
    0,
    'normal playback must not create the auto HUD',
  );
  await page.locator('#test-video').click({ position: { x: 300, y: 180 } });
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  await page.waitForFunction(
    () => document.querySelector('#framecue-hud')?.innerText.includes('实测'),
    null,
    { timeout: 3000 },
  );
  const measuredLabel = await page.locator('#framecue-hud').innerText();
  assert.match(measuredLabel, /30 fps 实测/, `HUD should report measured fps: ${measuredLabel}`);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#test-video').paused, null, {
    timeout: 2000,
  });
  await page.waitForTimeout(250);
  await page.locator('#test-video').click({ position: { x: 300, y: 180 } });
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.muted = false;
    video.volume = 0.35;
  });
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.currentTime = 0;
    return video.play();
  });
  await page.waitForFunction(() => !document.querySelector('#test-video').paused, null, {
    timeout: 2000,
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#test-video').paused, null, {
    timeout: 2000,
  });
  await page.waitForTimeout(200);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1500);
  const holdState = await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    return {
      paused: video.paused,
      playbackRate: video.playbackRate,
      muted: video.muted,
      volume: video.volume,
    };
  });
  assert.equal(holdState.paused, false, 'holding right arrow should play normally');
  assert.equal(holdState.playbackRate, 1, 'hold playback should use normal 1x speed');
  assert.equal(holdState.muted, false, 'hold playback must preserve the page mute state');
  assert.ok(Math.abs(holdState.volume - 0.35) < 0.01, 'hold playback must preserve volume');
  assert.match(
    await page.locator('#framecue-hud').innerText(),
    /音量 35%/,
    'HUD should report volume rather than a playback mode label',
  );
  // Holding → is continuous frame stepping: the HUD must stay up with the
  // volume note well past the 3 s auto-hide and keep counting frames.
  const readHoldHud = () => page.locator('#framecue-hud').evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    visible: element.classList.contains('is-visible'),
    text: element.innerText,
    frame: Number((/帧 (\d+)/.exec(element.innerText) || [])[1]),
  }));
  const earlyHold = await readHoldHud();
  await page.waitForTimeout(2600);
  const lateHold = await readHoldHud();
  for (const sample of [earlyHold, lateHold]) {
    assert.equal(sample.visible, true, 'HUD must stay visible while holding right arrow');
    assert.equal(sample.opacity, '1', 'HUD must stay opaque while holding right arrow');
    assert.match(sample.text, /音量 35%/, `HUD should keep the volume note: ${sample.text}`);
  }
  assert.ok(
    lateHold.frame > earlyHold.frame + 30,
    `HUD frame number should follow playback: ${earlyHold.frame} -> ${lateHold.frame}`,
  );
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(1800);
  assert.equal(
    await page.evaluate(() => document.querySelector('#test-video').paused),
    true,
    'releasing right arrow should pause playback',
  );
  // A short hold releases while the volume notice is still showing; the HUD
  // must still fade out instead of staying opaque.
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(
    () => /音量/.test(document.querySelector('#framecue-hud')?.innerText || ''),
    null,
    { timeout: 3000 },
  );
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('#framecue-hud')).opacity === '0',
    null,
    { timeout: 6000 },
  ).catch(() => {});
  assert.equal(
    await page.locator('#framecue-hud').evaluate((element) => getComputedStyle(element).opacity),
    '0',
    'auto HUD must fade out after a short hold that showed a notice',
  );
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.playbackRate = 4;
  });
  await page.waitForFunction(() => document.querySelector('#test-video').currentTime > 0.5, null, {
    timeout: 3000,
  });
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.currentTime = 1;
  });
  await page.waitForTimeout(250);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(250);
  await page.keyboard.up('ArrowLeft');
  await page.evaluate(() => {
    document.querySelector('#test-video').currentTime = 0.2;
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    document.querySelector('#test-video').currentTime = 2;
  });
  await page.waitForTimeout(250);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1000);
  assert.equal(
    await page.evaluate(() => document.querySelector('#test-video').paused),
    true,
    'holding left arrow should only step frames and never start reverse playback',
  );
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.pause();
    video.playbackRate = 1;
    video.currentTime = 0;
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    return new Promise((resolve) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      video.addEventListener('loadeddata', () => resolve(), { once: true });
    });
  });
  await page.bringToFront();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#test-video').currentTime > 0.15, null, {
    timeout: 4000,
  });
  assert.equal(
    await page.evaluate(() => document.querySelector('#test-video').paused),
    false,
    'Space should start playback',
  );
  await page.evaluate(() => document.querySelector('#test-video').pause());
  await page.bringToFront();
  const grantSettingsPage = await context.newPage();
  await grantSettingsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await grantSettingsPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.set({
      frameCueSettings: {
        enabled: true,
        frameRateMode: 'auto',
        fps: 30,
        allowlist: [],
        blocklist: [],
        measureFrameRate: true,
        hudMode: 'auto',
      },
    }, resolve);
  }));
  await grantSettingsPage.close();
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => document.documentElement.hasAttribute('data-framecue-page')),
    false,
    'clearing the allowlist should disable the page',
  );
  const grantHarness = await context.newPage();
  await grantHarness.goto(`chrome-extension://${extensionId}/options.html`);
  const grantResult = await grantHarness.evaluate(async ({ pageOrigin }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => (
      typeof candidate.url === 'string'
      && candidate.url.startsWith(`${pageOrigin}/video`)
    ));
    if (!tab) {
      return { ok: false, error: 'video tab not found' };
    }
    const grant = {
      hostname: 'localhost',
      origin: '*://localhost/*',
      tabId: tab.id,
      createdAt: Date.now(),
    };
    await chrome.storage.session.set({ frameCuePendingSiteGrant: grant });
    const granted = await chrome.permissions.request({ origins: [grant.origin] });
    if (!granted) {
      return { ok: false, error: 'permission not granted' };
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'framecue-command',
        command: 'activate-granted-site',
        grant,
      }, resolve);
    });
  }, { pageOrigin: origin });
  assert.equal(grantResult.ok, true, grantResult.error || 'site activation failed');
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-framecue-page'),
    null,
    { timeout: 5000 },
  );
  const grantedSettings = await grantHarness.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.get('frameCueSettings', (result) => resolve(result.frameCueSettings));
  }));
  assert.deepEqual(grantedSettings.allowlist, ['localhost']);
  assert.equal(
    await grantHarness.evaluate(() => chrome.permissions.contains({ origins: ['*://localhost/*'] })),
    true,
    'site permission should remain after the one-click allowlist transaction',
  );
  await grantHarness.evaluate(() => chrome.storage.session.remove('frameCuePendingSiteGrant'));
  await grantHarness.close();
  await page.evaluate(() => document.querySelector('#test-video').pause());
  await page.evaluate(() => { document.querySelector('#test-video').currentTime = 0; });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    video.dataset.frameSteps = '0';
    video.addEventListener('seeked', () => {
      video.dataset.frameSteps = String(Number(video.dataset.frameSteps) + 1);
    });
  });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1200);
  const hudVisible = await page.locator('#framecue-hud').count();
  assert.equal(hudVisible, 1, 'content script should add a frame HUD');
  await page.waitForTimeout(450);
  const dragged = await page.locator('#framecue-hud').evaluate((element) => {
    const handle = element.querySelector('.framecue-drag');
    const rect = handle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: x - 100,
      clientY: y - 80,
      pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      clientX: x - 100,
      clientY: y - 80,
      pointerId: 1,
    }));
    return {
      left: element.style.left,
      top: element.style.top,
      position: getComputedStyle(element).position,
    };
  });
  assert.equal(dragged.position, 'fixed');
  assert.notEqual(dragged.left, 'auto');
  assert.notEqual(dragged.top, 'auto');
  assert.equal(
    await page.evaluate(() => window.fetch.toString().includes('[native code]')),
    true,
    'the extension must not patch page globals',
  );

  const afterForward = await page.evaluate(() => {
    const video = document.querySelector('#test-video');
    return {
      frame: Math.floor(video.currentTime * 30 + 1e-6),
      paused: video.paused,
    };
  });
  assert.equal(afterForward.paused, true, 'arrow step should stop playback');
  assert.ok(afterForward.frame >= 2, `expected at least 2 frame steps, got frame ${afterForward.frame}`);

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(450);
  const afterBack = await page.evaluate(() => Math.floor(document.querySelector('#test-video').currentTime * 30 + 1e-6));
  assert.ok(afterBack < afterForward.frame, `expected to step backward, got frame ${afterBack}`);
  const hud = await page.locator('#framecue-hud').innerText();
  assert.match(hud, /帧 \d+ \/ 89/, `HUD should show the current frame: ${hud}`);
  assert.match(hud, /30 fps/, `HUD should show the detected frame rate: ${hud}`);
  assert.doesNotMatch(hud, /总帧数待加载/);
  assert.equal(
    await page.locator('#framecue-hud .framecue-settings').count(),
    1,
    'HUD should include a direct settings button',
  );
  await page.waitForTimeout(3200);
  assert.equal(
    await page.locator('#framecue-hud').evaluate((element) => element.classList.contains('is-visible')),
    false,
    'auto HUD should fade out after three seconds without keyboard input',
  );

  const blockSettingsPage = await context.newPage();
  await blockSettingsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await blockSettingsPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.set({
      frameCueSettings: {
        enabled: true,
        frameRateMode: 'auto',
        fps: 30,
        allowlist: ['localhost'],
        blocklist: ['localhost'],
        measureFrameRate: true,
        hudMode: 'auto',
      },
    }, resolve);
  }));
  await blockSettingsPage.close();
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => document.documentElement.hasAttribute('data-framecue-page')),
    false,
    'updating the blocklist should disable the page immediately',
  );

  await t.test('popup fits without horizontal overflow', async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 720 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const layout = await popup.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(layout.scrollWidth, layout.clientWidth, 'popup has horizontal overflow');
    await popup.screenshot({ path: '/tmp/framecue-popup.png' });
    await popup.close();

    const options = await context.newPage();
    await options.setViewportSize({ width: 760, height: 900 });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const optionsLayout = await options.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      allowlist: document.querySelector('#allowlist').value,
    }));
    assert.equal(optionsLayout.scrollWidth, optionsLayout.clientWidth, 'options page has horizontal overflow');
    assert.equal(optionsLayout.allowlist, 'localhost', 'allowlist should contain only the test site');
    assert.equal(await options.locator('[data-hud-mode]').count(), 3);
    await options.screenshot({ path: '/tmp/framecue-options.png', fullPage: true });
    await options.close();
  });

  await t.test('no websites are injected by default', async () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(EXTENSION_PATH, 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.optional_host_permissions[0], '*://*/*');
    assert.equal(manifest.host_permissions, undefined);
  });
});
