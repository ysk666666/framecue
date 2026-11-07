'use strict';

// Loads the Firefox build into a real Firefox through WebDriver BiDi, then
// checks that an allowlisted page receives the content script and that the
// ArrowRight shortcut advances exactly one frame.
//
// Requirements: Firefox 116+ and Node 22+ (for the built-in WebSocket client).
// Point FRAMECUE_FIREFOX at the binary when Firefox is not installed in a
// standard location. The test skips itself when either requirement is absent.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const EXTENSION_PATH = path.join(ROOT, 'dist', 'firefox');
const PAGE_PORT = 47833;
const DEBUG_PORT = 9251;
const PAGE_URL = `http://localhost:${PAGE_PORT}/video`;
const ARROW_RIGHT = '\uE014';
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' };

function findFirefox() {
  const candidates = [
    process.env.FRAMECUE_FIREFOX,
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function createFixtureServer() {
  return http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url.startsWith('/video')) {
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
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
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId;
        nextId += 1;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolveCommand, rejectCommand, method });
        });
      },
      close() {
        socket.close();
      },
    }));
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) {
        return;
      }
      const { resolveCommand, rejectCommand, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        rejectCommand(new Error(`${method}: ${JSON.stringify(message.error)}`));
      } else {
        resolveCommand(message.result);
      }
    });
  });
}

async function waitForBiDi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const reachable = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${DEBUG_PORT}/session`);
      socket.addEventListener('open', () => {
        socket.close();
        resolve(true);
      });
      socket.addEventListener('error', () => resolve(false));
    });
    if (reachable) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Firefox WebDriver BiDi endpoint never came up');
}

// Firefox rejects browsingContext.navigate for extension-internal URLs and
// some builds do not expose it at all, so navigate through the page instead.
async function goto(session, context, url) {
  const evaluate = async (expression) => {
    const result = await session.send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (result.type === 'exception') {
      throw new Error(`script error: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result ? result.result.value : undefined;
  };

  await evaluate(`location.href = ${JSON.stringify(url)}, 'ok'`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const state = JSON.parse(await evaluate(
        'JSON.stringify({ href: location.href, readyState: document.readyState })',
      ));
      if (state.href === url && state.readyState === 'complete') {
        return evaluate;
      }
    } catch (_) {
      // The document is still being replaced.
    }
  }
  throw new Error(`navigation to ${url} did not settle`);
}

function buildTestExtension() {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'build-firefox.sh')], { stdio: 'pipe' });

  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.background.scripts), 'Firefox build must use background.scripts');
  assert.equal(manifest.background.service_worker, undefined, 'Firefox build must not use service_worker');
  assert.ok(
    manifest.background.scripts.indexOf('src/browser-api.js')
      < manifest.background.scripts.indexOf('src/permissions.js'),
    'the browser API bridge must load before permissions.js',
  );

  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'framecue-firefox-ext-'));
  fs.cpSync(EXTENSION_PATH, extensionPath, { recursive: true });
  const testManifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  // Temporary installs get host access without a prompt, so grant localhost
  // directly instead of driving the permission doorhanger.
  testManifest.host_permissions = [`*://localhost/*`];
  testManifest.optional_host_permissions = [`*://localhost/*`];
  testManifest.background.scripts = [...testManifest.background.scripts, 'src/test-seed.js'];
  fs.writeFileSync(
    path.join(extensionPath, 'manifest.json'),
    `${JSON.stringify(testManifest, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(extensionPath, 'src', 'test-seed.js'), `
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
});
`);
  return extensionPath;
}

test('FrameCue loads in Firefox and steps exactly one frame', async (t) => {
  const firefoxBinary = findFirefox();
  if (!firefoxBinary || typeof WebSocket === 'undefined') {
    t.skip('needs Firefox 116+ and Node 22+ (global WebSocket)');
    return;
  }

  const extensionPath = buildTestExtension();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'framecue-firefox-profile-'));
  fs.writeFileSync(path.join(profile, 'user.js'), `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("remote.active-protocols", 3);
user_pref("browser.startup.page", 0);
user_pref("media.autoplay.default", 0);
`);

  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PAGE_PORT, '127.0.0.1', resolve);
  });

  const firefox = spawn(firefoxBinary, [
    '--headless',
    '--no-remote',
    '--profile', profile,
    `--remote-debugging-port=${DEBUG_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let session = null;
  t.after(async () => {
    if (session) {
      session.close();
    }
    firefox.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  await waitForBiDi();
  session = await connect(`ws://127.0.0.1:${DEBUG_PORT}/session`);
  await session.send('session.new', { capabilities: {} });
  const installed = await session.send('webExtension.install', {
    extensionData: { type: 'path', path: extensionPath },
  });
  assert.ok(installed.extension, 'Firefox should install the temporary extension');

  const tab = await session.send('browsingContext.create', { type: 'tab' });
  const evaluate = await goto(session, tab.context, PAGE_URL);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(
    await evaluate('document.documentElement.hasAttribute("data-framecue-page")'),
    true,
    'content script did not load into the allowlisted fixture page',
  );

  await evaluate(`(async () => {
    const video = document.querySelector('#test-video');
    video.pause();
    video.currentTime = 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return video.currentTime;
  })()`);
  await session.send('input.performActions', {
    context: tab.context,
    actions: [{
      type: 'key',
      id: 'keyboard',
      actions: [
        { type: 'keyDown', value: ARROW_RIGHT },
        { type: 'keyUp', value: ARROW_RIGHT },
      ],
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 900));

  const state = JSON.parse(await evaluate(`JSON.stringify({
    currentTime: document.querySelector('#test-video').currentTime,
    frame: Math.floor(document.querySelector('#test-video').currentTime * 30 + 1e-6),
    hud: document.querySelectorAll('#framecue-hud').length,
  })`));
  assert.equal(state.frame, 31, `ArrowRight should land on frame 31: ${JSON.stringify(state)}`);
  assert.equal(state.hud, 1, 'the frame HUD should be created for the allowlisted page');
});
