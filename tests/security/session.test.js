'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity, ALLOWED_PERMISSIONS } = require('../../src/main/security');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const POS_ORIGIN = 'https://vendor.societyfiles.com';

function makeSecurity({ packaged = true } = {}) {
  return createSecurity({ getConfig: () => ({ serverUrl: POS_URL, extraAllowedOrigins: ['https://shop.example.com'] }), isPackaged: packaged });
}

/**
 * A session that accepts ONLY the two permission handlers. Touching anything else (a certificate verifier, a
 * proxy, a device handler) throws, which proves configureSession does not install other behaviour.
 */
function makeSession() {
  const state = { requestHandler: null, checkHandler: null, touched: [] };
  const session = new Proxy(
    {
      setPermissionRequestHandler(handler) {
        state.requestHandler = handler;
      },
      setPermissionCheckHandler(handler) {
        state.checkHandler = handler;
      },
    },
    {
      get(target, property) {
        state.touched.push(String(property));
        if (property in target) return target[property];
        throw new Error(`configureSession must not use session.${String(property)}`);
      },
    },
  );
  return { session, state };
}

function configure(options) {
  const { session, state } = makeSession();
  makeSecurity(options).configureSession(session);
  return state;
}

/** Asks the request handler and returns what it answered, asserting it answered exactly once. */
function ask(state, permission, { requestingUrl, webContentsUrl, isMainFrame = true } = {}) {
  const answers = [];
  const webContents = webContentsUrl === undefined ? undefined : { getURL: () => webContentsUrl };
  const details = requestingUrl === undefined ? undefined : { requestingUrl, isMainFrame };
  state.requestHandler(webContents, permission, (granted) => answers.push(granted), details);
  assert.equal(answers.length, 1, `the callback must be called exactly once (${permission})`);
  return answers[0];
}

test('configureSession installs the request handler and the check handler, and touches nothing else', () => {
  const state = configure();
  assert.equal(typeof state.requestHandler, 'function');
  assert.equal(typeof state.checkHandler, 'function');
  assert.deepEqual([...new Set(state.touched)].sort(), ['setPermissionCheckHandler', 'setPermissionRequestHandler']);
});

test('the permitted permissions are exactly those of SPEC 12', () => {
  assert.deepEqual([...ALLOWED_PERMISSIONS], ['notifications', 'fullscreen', 'clipboard-sanitized-write', 'media', 'window-management']);
  assert.ok(Object.isFrozen(ALLOWED_PERMISSIONS));
});

test('request handler: every permitted permission is granted to an allowed origin', () => {
  const state = configure();
  for (const permission of ALLOWED_PERMISSIONS) {
    for (const requestingUrl of [POS_URL, `${POS_ORIGIN}/`, 'https://gadgetspos.com/x', 'https://app.gadgetspos.com/', 'https://shop.example.com/pos']) {
      assert.equal(ask(state, permission, { requestingUrl }), true, `${permission} ${requestingUrl}`);
    }
  }
});

test('request handler: a permitted permission is denied to any other origin', () => {
  const state = configure();
  const origins = [
    'https://evil.example/',
    'https://gadgetspos.com.evil.com/',
    'https://evilgadgetspos.com/',
    'https://vendor.societyfiles.com:8443/',
    'http://vendor.societyfiles.com/',
    'https://js.stripe.com/v3/',
    'https://www.google.com/maps/embed',
    'https://connect.squareup.com/oauth2/authorize',
    'https://squareup.com/login',
    'file:///app/src/renderer/settings.html',
    'about:blank',
    'null',
    '',
  ];
  for (const permission of ALLOWED_PERMISSIONS) {
    for (const requestingUrl of origins) {
      assert.equal(ask(state, permission, { requestingUrl }), false, `${permission} ${requestingUrl}`);
    }
  }
});

test('request handler: every other permission is denied, even to an allowed origin', () => {
  const state = configure();
  const denied = [
    'geolocation', 'clipboard-read', 'display-capture', 'idle-detection', 'midi', 'midiSysex', 'pointerLock', 'keyboardLock', 'openExternal',
    'speaker-selection', 'storage-access', 'top-level-storage-access', 'unknown', 'fileSystem', 'mediaKeySystem', 'hid', 'serial', 'usb', 'bluetooth',
    'camera', 'microphone', 'push', 'background-sync', 'accessibility-events', 'payment-handler', 'Notifications', 'MEDIA', ' media', 'media ', '',
    undefined, null, 42, {}, [], ['media'],
  ];
  for (const permission of denied) {
    assert.equal(ask(state, permission, { requestingUrl: POS_URL }), false, String(permission));
  }
});

test('request handler: the REQUESTING frame decides, so an embedded third-party frame gets nothing', () => {
  const state = configure();
  // The page is the POS, but the frame asking is an iframe from another site.
  assert.equal(ask(state, 'media', { requestingUrl: 'https://evil.example/frame.html', webContentsUrl: POS_URL, isMainFrame: false }), false);
  assert.equal(ask(state, 'notifications', { requestingUrl: POS_URL, webContentsUrl: 'https://evil.example/' }), true, 'details.requestingUrl wins over the page url');
});

test('request handler: without details it uses the page url, and with neither it denies', () => {
  const state = configure();
  assert.equal(ask(state, 'fullscreen', { webContentsUrl: POS_URL }), true);
  assert.equal(ask(state, 'fullscreen', { webContentsUrl: 'https://evil.example/' }), false);
  assert.equal(ask(state, 'fullscreen', {}), false);
  assert.equal(ask(state, 'fullscreen'), false);
});

test('request handler: the callback is called exactly once even when reading the request fails', () => {
  const state = configure();
  const answers = [];
  const hostileDetails = {
    get requestingUrl() {
      throw new Error('details are gone');
    },
  };
  assert.doesNotThrow(() => state.requestHandler(undefined, 'media', (granted) => answers.push(granted), hostileDetails));
  assert.deepEqual(answers, [false]);

  const hostileWebContents = {
    getURL() {
      throw new Error('webContents destroyed');
    },
  };
  const more = [];
  assert.doesNotThrow(() => state.requestHandler(hostileWebContents, 'media', (granted) => more.push(granted), {}));
  assert.deepEqual(more, [false]);
});

test('check handler: permitted permissions for an allowed origin only', () => {
  const state = configure();
  for (const permission of ALLOWED_PERMISSIONS) {
    assert.equal(state.checkHandler({}, permission, POS_ORIGIN, { isMainFrame: true }), true, permission);
    assert.equal(state.checkHandler({}, permission, 'https://gadgetspos.com', { isMainFrame: true }), true, permission);
    assert.equal(state.checkHandler({}, permission, 'https://evil.example', { isMainFrame: true }), false, permission);
    assert.equal(state.checkHandler({}, permission, 'https://connect.squareup.com', { isMainFrame: true }), false, permission);
    assert.equal(state.checkHandler({}, permission, 'file://', { isMainFrame: true }), false, permission);
    assert.equal(state.checkHandler({}, permission, 'null', { isMainFrame: true }), false, permission);
  }
  for (const permission of ['geolocation', 'clipboard-read', 'hid', 'serial', 'usb', 'midi', 'openExternal', 'pointerLock', 'unknown', undefined, 42]) {
    assert.equal(state.checkHandler({}, permission, POS_ORIGIN, { isMainFrame: true }), false, String(permission));
  }
});

test('check handler: works without a webContents (workers) and falls back to details.requestingUrl', () => {
  const state = configure();
  assert.equal(state.checkHandler(null, 'notifications', POS_ORIGIN, {}), true);
  assert.equal(state.checkHandler(null, 'notifications', 'https://evil.example', {}), false);
  assert.equal(state.checkHandler(null, 'notifications', '', { requestingUrl: POS_URL }), true);
  assert.equal(state.checkHandler(null, 'notifications', undefined, undefined), false);
});

test('check handler: a throwing details object is a denial, not an exception', () => {
  const state = configure();
  const hostile = {
    get requestingUrl() {
      throw new Error('gone');
    },
  };
  assert.doesNotThrow(() => state.checkHandler(null, 'media', '', hostile));
  assert.equal(state.checkHandler(null, 'media', '', hostile), false);
});

test('development: a dev server may use the permitted permissions, a packaged app may not', () => {
  const dev = configure({ packaged: false });
  assert.equal(ask(dev, 'notifications', { requestingUrl: 'http://localhost:3000/pos' }), true);
  assert.equal(dev.checkHandler(null, 'notifications', 'http://localhost:3000', {}), true);
  assert.equal(ask(dev, 'geolocation', { requestingUrl: 'http://localhost:3000/pos' }), false);

  const prod = configure({ packaged: true });
  assert.equal(ask(prod, 'notifications', { requestingUrl: 'http://localhost:3000/pos' }), false);
  assert.equal(prod.checkHandler(null, 'notifications', 'http://localhost:3000', {}), false);
});

test('the answers follow the config: a new serverUrl is trusted for permissions by the next request', () => {
  const settings = { serverUrl: 'https://old.shop.example/pos', extraAllowedOrigins: [] };
  const { session, state } = makeSession();
  createSecurity({ getConfig: () => ({ get: (key, fallback) => settings[key] ?? fallback }), isPackaged: true }).configureSession(session);

  assert.equal(ask(state, 'media', { requestingUrl: 'https://new.shop.example/pos' }), false);
  settings.serverUrl = 'https://new.shop.example/pos';
  assert.equal(ask(state, 'media', { requestingUrl: 'https://new.shop.example/pos' }), true);
  assert.equal(state.checkHandler(null, 'media', 'https://new.shop.example', {}), true);
});
