'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity } = require('../../src/main/security');

const RENDERER_DIR = '/app/src/renderer';
const RENDERER_URL = 'file:///app/src/renderer';
const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const POS_ORIGIN = 'https://vendor.societyfiles.com';

function makeSecurity(options = {}) {
  return createSecurity({
    getConfig: () => ({ serverUrl: POS_URL, extraAllowedOrigins: ['https://shop.example.com'] }),
    isPackaged: true,
    rendererDir: RENDERER_DIR,
    ...options,
  });
}

/**
 * A fake IPC event: `{ sender: WebContents, senderFrame: WebFrameMain }`.
 *
 * @param {Object} [options]
 * @param {number} [options.id] webContents id
 * @param {string} [options.url] the frame's URL
 * @param {string} [options.origin] the frame's origin (default: derived from the URL as Chromium would)
 * @param {boolean} [options.subframe] the frame has a parent
 * @param {boolean} [options.distinctObject] senderFrame is another object for the same main frame
 * @param {boolean} [options.destroyed]
 */
function makeEvent({ id = 1, url = POS_URL, origin, subframe = false, distinctObject = false, destroyed = false } = {}) {
  const derived = (() => {
    try {
      const parsed = new URL(url);
      return parsed.origin === 'null' ? (parsed.protocol === 'file:' ? 'file://' : 'null') : parsed.origin;
    } catch {
      return 'null';
    }
  })();
  const resolved = origin === undefined ? derived : origin;
  const mainFrame = { url, origin: resolved, parent: null };
  const frame = subframe
    ? { url, origin: resolved, parent: mainFrame }
    : distinctObject
      ? { url, origin: resolved, parent: null }
      : mainFrame;
  return { sender: { id, mainFrame, isDestroyed: () => destroyed }, senderFrame: frame };
}

const registryOf = (entries) => new Map(Object.entries(entries).map(([id, areas]) => [Number(id), new Set(areas)]));

// ---------------------------------------------------------------------------------------------
// remote channels
// ---------------------------------------------------------------------------------------------

test('remote: the main frame of an allowed origin is trusted', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent(), undefined, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://gadgetspos.com/x' }), undefined, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://shop.example.com/pos' }), undefined, 'remote'), true, 'extraAllowedOrigins');
});

test('remote: a foreign, look-alike or opaque origin is refused', () => {
  const security = makeSecurity();
  const origins = [
    'https://evil.example',
    'https://gadgetspos.com.evil.com',
    'https://evilgadgetspos.com',
    'https://vendor.societyfiles.com:8443',
    'http://vendor.societyfiles.com',
    'null',
    'file://',
    'about:blank',
    '',
    'https://connect.squareup.com',
    'https://squareup.com',
  ];
  for (const origin of origins) {
    assert.equal(security.isTrustedSender(makeEvent({ origin }), undefined, 'remote'), false, JSON.stringify(origin));
  }
});

test('remote: the decision uses frame.origin, never the URL it was given', () => {
  const security = makeSecurity();
  // A page whose URL looks allowed but whose real origin is not (and the other way round).
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://gadgetspos.com/x', origin: 'https://evil.example' }), undefined, 'remote'), false);
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://evil.example/x', origin: POS_ORIGIN }), undefined, 'remote'), true);
});

test('remote: an about:blank popup is judged by the origin it inherited, and a blob page by its embedded origin', () => {
  const security = makeSecurity();
  const popup = (origin) => makeEvent({ url: 'about:blank', origin });
  assert.equal(security.isTrustedSender(popup(POS_ORIGIN), undefined, 'remote'), true, 'opened by the POS');
  assert.equal(security.isTrustedSender(popup('https://evil.example'), undefined, 'remote'), false);
  assert.equal(security.isTrustedSender(popup('null'), undefined, 'remote'), false);
  assert.equal(security.isTrustedSender(makeEvent({ url: 'blob:https://gadgetspos.com/0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11', origin: 'https://gadgetspos.com' }), undefined, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent({ url: 'blob:https://evil.example/0d2e1f0c', origin: 'https://evil.example' }), undefined, 'remote'), false);
});

test('remote: only the main frame is trusted', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent({ subframe: true }), undefined, 'remote'), false, 'an iframe of an allowed page');
  assert.equal(security.isTrustedSender(makeEvent({ subframe: true, origin: 'https://evil.example' }), undefined, 'remote'), false);
});

test('remote: senderFrame may be a different object for the same frame; parent === null decides', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent({ distinctObject: true }), undefined, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent({ distinctObject: true, origin: 'https://evil.example' }), undefined, 'remote'), false);
});

test('remote: a missing or malformed event is untrusted, never a throw', () => {
  const security = makeSecurity();
  const good = makeEvent();
  const events = [
    undefined,
    null,
    {},
    { sender: good.sender },
    { senderFrame: good.senderFrame },
    { sender: null, senderFrame: good.senderFrame },
    { sender: good.sender, senderFrame: null },
    { sender: good.sender, senderFrame: {} },
    { sender: good.sender, senderFrame: { origin: POS_ORIGIN } },
    { sender: good.sender, senderFrame: { origin: POS_ORIGIN, parent: undefined } },
    { sender: good.sender, senderFrame: { origin: undefined, parent: null } },
    { sender: good.sender, senderFrame: { origin: { toString: () => POS_ORIGIN }, parent: null } },
    'event',
    42,
  ];
  for (const event of events) assert.doesNotThrow(() => security.isTrustedSender(event, undefined, 'remote'));
  for (const event of events) assert.equal(security.isTrustedSender(event, undefined, 'remote'), false, JSON.stringify(event));
});

test('remote: a destroyed sender is untrusted', () => {
  assert.equal(makeSecurity().isTrustedSender(makeEvent({ destroyed: true }), undefined, 'remote'), false);
});

test('remote: a frame that throws when read (a disposed frame) is untrusted', () => {
  const security = makeSecurity();
  const disposed = () => {
    throw new Error('Render frame was disposed before WebFrameMain could be accessed');
  };
  const goodSender = makeEvent().sender;
  const throwingOrigin = { sender: goodSender, senderFrame: Object.defineProperties({}, { parent: { get: () => null }, origin: { get: disposed } }) };
  const throwingParent = { sender: goodSender, senderFrame: Object.defineProperties({}, { parent: { get: disposed }, origin: { get: () => POS_ORIGIN } }) };
  const throwingSender = {
    sender: Object.defineProperties({}, { id: { get: () => 1 }, mainFrame: { get: disposed } }),
    senderFrame: { origin: POS_ORIGIN, parent: null },
  };
  for (const event of [throwingOrigin, throwingParent, throwingSender]) {
    assert.doesNotThrow(() => security.isTrustedSender(event, undefined, 'remote'));
    assert.equal(security.isTrustedSender(event, undefined, 'remote'), false);
  }
});

test('remote: the provider hosts are never trusted senders (SPEC 12)', () => {
  const security = makeSecurity();
  for (const url of ['https://connect.squareup.com/oauth2/authorize', 'https://squareup.com/login', 'https://app.squareupsandbox.com/login']) {
    assert.equal(security.isTrustedSender(makeEvent({ url }), undefined, 'remote'), false, url);
  }
});

test('remote: a dev server is trusted only while unpackaged', () => {
  const event = makeEvent({ url: 'http://localhost:3000/pos' });
  assert.equal(makeSecurity({ isPackaged: true }).isTrustedSender(event, undefined, 'remote'), false);
  assert.equal(makeSecurity({ isPackaged: false }).isTrustedSender(event, undefined, 'remote'), true);
});

test('remote: a local file page is not a remote sender, even in a registered window', () => {
  const security = makeSecurity();
  const registry = registryOf({ 1: ['connection', 'window'] });
  assert.equal(security.isTrustedSender(makeEvent({ url: `${RENDERER_URL}/offline.html` }), registry, 'remote'), false);
});

test('remote: the registry is not consulted', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent(), null, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent(), {}, 'remote'), true);
  assert.equal(security.isTrustedSender(makeEvent(), registryOf({}), 'remote'), true);
});

test('remote: config changes are seen by the next check', () => {
  const settings = { serverUrl: 'https://old.shop.example/pos', extraAllowedOrigins: [] };
  const security = createSecurity({ getConfig: () => ({ get: (key, fallback) => settings[key] ?? fallback }), isPackaged: true });
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://new.shop.example/pos' }), undefined, 'remote'), false);
  settings.serverUrl = 'https://new.shop.example/pos';
  assert.equal(security.isTrustedSender(makeEvent({ url: 'https://new.shop.example/pos' }), undefined, 'remote'), true);
});

// ---------------------------------------------------------------------------------------------
// desktop:<area>:* channels (SPEC 6.3)
// ---------------------------------------------------------------------------------------------

/** The registry of SPEC 6.3: main window 1, settings window 2, password window 3, a window.open popup 4. */
const REGISTRY = registryOf({
  1: ['connection', 'window'],
  2: ['settings', 'connection', 'window'],
  3: ['password', 'window'],
});
const OFFLINE = `${RENDERER_URL}/offline.html?reason=dns&code=-105&desc=ERR_NAME_NOT_RESOLVED&url=${encodeURIComponent(POS_URL)}`;
const SETTINGS = `${RENDERER_URL}/settings.html`;
const PASSWORD = `${RENDERER_URL}/password.html`;

test('local: each window may call exactly the areas it was registered with', () => {
  const security = makeSecurity();
  const matrix = [
    // [window id, page url, area, expected]
    [1, OFFLINE, 'connection', true],
    [1, OFFLINE, 'window', true],
    [1, OFFLINE, 'settings', false],
    [1, OFFLINE, 'password', false],
    [2, SETTINGS, 'settings', true],
    [2, SETTINGS, 'connection', true],
    [2, SETTINGS, 'window', true],
    [2, SETTINGS, 'password', false],
    [3, PASSWORD, 'password', true],
    [3, PASSWORD, 'window', true],
    [3, PASSWORD, 'settings', false],
    [3, PASSWORD, 'connection', false],
  ];
  for (const [id, url, area, expected] of matrix) {
    assert.equal(security.isTrustedSender(makeEvent({ id, url }), REGISTRY, area), expected, `window ${id} ${area}`);
  }
});

test('local: a window.open popup, an unknown window and an empty registration have no desktop areas', () => {
  const security = makeSecurity();
  for (const area of ['settings', 'connection', 'window', 'password', 'local']) {
    assert.equal(security.isTrustedSender(makeEvent({ id: 4, url: OFFLINE }), REGISTRY, area), false, `popup ${area}`);
    assert.equal(security.isTrustedSender(makeEvent({ id: 99, url: OFFLINE }), REGISTRY, area), false, `unknown ${area}`);
    assert.equal(security.isTrustedSender(makeEvent({ id: 5, url: OFFLINE }), registryOf({ 5: [] }), area), false, `empty ${area}`);
  }
});

test('local: a remote page in a registered window cannot use the desktop areas', () => {
  const security = makeSecurity();
  // The main window shows the POS after loading.html: id 1 is registered for connection and window, but this
  // frame is the remote POS, not a page inside the renderer directory.
  for (const area of ['connection', 'window']) {
    assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: POS_URL }), REGISTRY, area), false, area);
    assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: 'https://evil.example/' }), REGISTRY, area), false, area);
  }
});

test('local: pages outside the renderer directory are refused, including traversals', () => {
  const security = makeSecurity();
  const urls = [
    'file:///app/src/main/index.js',
    'file:///app/src/renderer/../main/index.js',
    'file:///app/src/renderer/%2e%2e/main/index.js',
    'file:///app/src/renderer-evil/offline.html',
    'file:///app/src/renderer',
    'file:///etc/passwd',
    'file://evil.example/app/src/renderer/offline.html',
    'file:///app/src/renderer/..%2fmain/index.js',
  ];
  for (const url of urls) assert.equal(security.isTrustedSender(makeEvent({ id: 1, url }), REGISTRY, 'connection'), false, url);
});

test('local: only the main frame of a local page is trusted', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent({ id: 2, url: SETTINGS, subframe: true }), REGISTRY, 'settings'), false);
  assert.equal(security.isTrustedSender(makeEvent({ id: 2, url: SETTINGS, distinctObject: true }), REGISTRY, 'settings'), true);
});

test('local: "local" means any registered window on a local page', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: OFFLINE }), REGISTRY, 'local'), true);
  assert.equal(security.isTrustedSender(makeEvent({ id: 3, url: PASSWORD }), REGISTRY, 'local'), true);
  assert.equal(security.isTrustedSender(makeEvent({ id: 4, url: OFFLINE }), REGISTRY, 'local'), false);
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: POS_URL }), REGISTRY, 'local'), false);
});

test('local: an unknown or missing area is refused', () => {
  const security = makeSecurity();
  for (const area of [undefined, null, '', 'admin', 'Settings', 'SETTINGS', 42, {}]) {
    assert.equal(security.isTrustedSender(makeEvent({ id: 2, url: SETTINGS }), REGISTRY, area), false, String(area));
  }
});

test('local: the renderer directory comes from createSecurity, falling back to registry.rendererDir', () => {
  const event = makeEvent({ id: 1, url: OFFLINE });
  assert.equal(makeSecurity({ rendererDir: undefined }).isTrustedSender(event, REGISTRY, 'connection'), false, 'no directory known: nothing is local');

  const registryWithDir = registryOf({ 1: ['connection'] });
  registryWithDir.rendererDir = RENDERER_DIR;
  assert.equal(makeSecurity({ rendererDir: undefined }).isTrustedSender(event, registryWithDir, 'connection'), true);

  // The option wins over the registry.
  registryWithDir.rendererDir = '/elsewhere';
  assert.equal(makeSecurity().isTrustedSender(event, registryWithDir, 'connection'), true);
  assert.equal(makeSecurity({ rendererDir: '/elsewhere' }).isTrustedSender(event, registryWithDir, 'connection'), false);
});

test('local: registry shapes: arrays work, anything unusable fails closed', () => {
  const security = makeSecurity();
  const event = makeEvent({ id: 1, url: OFFLINE });
  assert.equal(security.isTrustedSender(event, new Map([[1, ['connection', 'window']]]), 'connection'), true);
  assert.equal(security.isTrustedSender(event, { get: (id) => (id === 1 ? new Set(['connection']) : undefined) }, 'connection'), true);

  for (const registry of [undefined, null, {}, [], 'registry', 42, new Map(), new Map([[1, null]]), new Map([[1, 42]]), new Map([[1, 'connection']]), { get: () => { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => security.isTrustedSender(event, registry, 'connection'));
    assert.equal(security.isTrustedSender(event, registry, 'connection'), false, String(registry));
  }
});

test('local: a destroyed window and a disposed frame are untrusted', () => {
  const security = makeSecurity();
  assert.equal(security.isTrustedSender(makeEvent({ id: 2, url: SETTINGS, destroyed: true }), REGISTRY, 'settings'), false);
  const frame = Object.defineProperties({}, {
    parent: { get: () => null },
    url: { get: () => { throw new Error('Render frame was disposed'); } },
  });
  assert.equal(security.isTrustedSender({ sender: makeEvent({ id: 2 }).sender, senderFrame: frame }, REGISTRY, 'settings'), false);
});

test('SPEC 6.3 scenarios: the offline page may retry and open settings; a remote page and the wrong window may not', () => {
  const security = makeSecurity();
  // the offline page loaded in the main window
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: OFFLINE }), REGISTRY, 'connection'), true);
  // desktop:settings:* from the main window
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: OFFLINE }), REGISTRY, 'settings'), false);
  // desktop:password:* from the settings window
  assert.equal(security.isTrustedSender(makeEvent({ id: 2, url: SETTINGS }), REGISTRY, 'password'), false);
  // a remote POS page in the main window
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: POS_URL }), REGISTRY, 'connection'), false);
  assert.equal(security.isTrustedSender(makeEvent({ id: 1, url: POS_URL }), REGISTRY, 'remote'), true);
});
