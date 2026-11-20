'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveWindowState,
  placeLocalWindow,
  classifyLoadFailure,
  windowTitleFor,
  resolveWindowIcon,
  windowBackground,
  clampZoom,
  buildRemoteWebPreferences,
  buildLocalWebPreferences,
  VERSION_ARG_PREFIX,
} = require('../../src/main/windows/main');
const { createFakeScreen } = require('../helpers/fake-window');

const stored = (overrides = {}) => ({ bounds: null, maximized: false, fullScreen: false, startFullScreen: false, ...overrides });

test('first run: 1600x900 centred on a large display, not maximized', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  assert.deepEqual(resolveWindowState(stored(), screen), {
    bounds: { x: 160, y: 70, width: 1600, height: 900 },
    maximized: false,
    fullScreen: false,
    restored: false,
  });
});

test('first run on a small display: the window fills the work area and starts maximized (v1 opened 1600x900 partly off-screen)', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1366, height: 728 }]);
  const state = resolveWindowState(stored(), screen);
  assert.deepEqual(state.bounds, { x: 0, y: 0, width: 1366, height: 728 });
  assert.equal(state.maximized, true);
});

test('first run: maximized only below 1400 px (1399 yes, 1400 no) and centred inside a work area that has an offset', () => {
  assert.equal(resolveWindowState(stored(), createFakeScreen([{ x: 0, y: 0, width: 1399, height: 900 }])).maximized, true);
  assert.equal(resolveWindowState(stored(), createFakeScreen([{ x: 0, y: 0, width: 1400, height: 900 }])).maximized, false);
  // a taskbar on the left edge: the work area starts at x=48
  const offset = resolveWindowState(stored(), createFakeScreen([{ x: 48, y: 0, width: 1872, height: 1040 }]));
  assert.deepEqual(offset.bounds, { x: 48 + 136, y: 70, width: 1600, height: 900 });
});

test('first run: a stored maximized flag is kept even on a large display', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 2560, height: 1400 }]);
  assert.equal(resolveWindowState(stored({ maximized: true }), screen).maximized, true);
});

test('saved bounds that are fully visible come back unchanged, with the maximized flag', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  const state = resolveWindowState(stored({ bounds: { x: 100, y: 80, width: 1200, height: 700 }, maximized: true }), screen);
  assert.deepEqual(state, { bounds: { x: 100, y: 80, width: 1200, height: 700 }, maximized: true, fullScreen: false, restored: true });
});

test('bounds saved on a monitor that is no longer connected fall back to the default placement', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  const state = resolveWindowState(stored({ bounds: { x: 2100, y: 100, width: 1200, height: 700 } }), screen);
  assert.equal(state.restored, false);
  assert.deepEqual(state.bounds, { x: 160, y: 70, width: 1600, height: 900 });
});

test('bounds saved on the second monitor are restored there while it is connected', () => {
  const screen = createFakeScreen([
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 2560, height: 1400 },
  ]);
  const state = resolveWindowState(stored({ bounds: { x: 2200, y: 200, width: 1800, height: 1000 } }), screen);
  assert.equal(state.restored, true);
  assert.deepEqual(state.bounds, { x: 2200, y: 200, width: 1800, height: 1000 });
});

test('visibility threshold: 200x100 px of overlap is enough, 199 wide or 99 high is not', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  const wide = resolveWindowState(stored({ bounds: { x: 1920 - 200, y: 100, width: 800, height: 600 } }), screen);
  assert.equal(wide.restored, true);
  const tooNarrow = resolveWindowState(stored({ bounds: { x: 1920 - 199, y: 100, width: 800, height: 600 } }), screen);
  assert.equal(tooNarrow.restored, false);
  const high = resolveWindowState(stored({ bounds: { x: 100, y: 1040 - 100, width: 800, height: 600 } }), screen);
  assert.equal(high.restored, true);
  const tooLow = resolveWindowState(stored({ bounds: { x: 100, y: 1040 - 99, width: 800, height: 600 } }), screen);
  assert.equal(tooLow.restored, false);
});

test('a partly hidden window is pulled completely onto the display that shows most of it', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  const state = resolveWindowState(stored({ bounds: { x: 1920 - 300, y: -50, width: 1000, height: 600 } }), screen);
  assert.equal(state.restored, true);
  assert.deepEqual(state.bounds, { x: 920, y: 0, width: 1000, height: 600 });
});

test('a window larger than the display is shrunk to the work area', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1280, height: 720 }]);
  const state = resolveWindowState(stored({ bounds: { x: -200, y: -100, width: 2400, height: 1300 } }), screen);
  assert.deepEqual(state.bounds, { x: 0, y: 0, width: 1280, height: 720 });
});

test('unusable saved bounds (not numbers, zero size, null, a string) are ignored', () => {
  const screen = createFakeScreen([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  for (const bounds of [{ x: 'a', y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 0, height: 600 }, { x: NaN, y: 0, width: 800, height: 600 }, null, 'wide']) {
    assert.equal(resolveWindowState(stored({ bounds }), screen).restored, false);
  }
});

test('full screen at start comes from the last state or from the "start in full screen" setting', () => {
  const screen = createFakeScreen();
  assert.equal(resolveWindowState(stored(), screen).fullScreen, false);
  assert.equal(resolveWindowState(stored({ fullScreen: true }), screen).fullScreen, true);
  assert.equal(resolveWindowState(stored({ startFullScreen: true }), screen).fullScreen, true);
});

test('placeLocalWindow centres over the parent, keeps the result inside the work area, and centres on the screen without a parent', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(placeLocalWindow({ parentBounds: { x: 100, y: 100, width: 1600, height: 900 }, workArea, width: 960, height: 640 }), { x: 420, y: 230 });
  // a parent at the left edge that is narrower than the child would push the child off-screen
  assert.deepEqual(placeLocalWindow({ parentBounds: { x: 0, y: 0, width: 800, height: 500 }, workArea, width: 960, height: 640 }), { x: 0, y: 0 });
  assert.deepEqual(placeLocalWindow({ workArea, width: 420, height: 300 }), { x: 750, y: 370 });
});

test('classifyLoadFailure maps Chromium errors to the reasons of SPEC 11.2', () => {
  const cases = [
    ['ERR_INTERNET_DISCONNECTED', 'offline'],
    ['ERR_NETWORK_CHANGED', 'offline'],
    ['ERR_NAME_NOT_RESOLVED', 'dns'],
    ['ERR_CONNECTION_REFUSED', 'refused'],
    ['ERR_CONNECTION_RESET', 'refused'],
    ['ERR_CONNECTION_CLOSED', 'refused'],
    ['ERR_TIMED_OUT', 'timeout'],
    ['ERR_CONNECTION_TIMED_OUT', 'timeout'],
    ['ERR_CERT_AUTHORITY_INVALID', 'tls'],
    ['ERR_CERT_DATE_INVALID', 'tls'],
    ['ERR_SSL_PROTOCOL_ERROR', 'tls'],
    ['ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'tls'],
    ['ERR_ADDRESS_UNREACHABLE', 'other'],
    ['ERR_FAILED', 'other'],
    ['', 'other'],
  ];
  for (const [errorDescription, reason] of cases) {
    assert.equal(classifyLoadFailure({ errorCode: -2, errorDescription }), reason, errorDescription);
  }
  assert.equal(classifyLoadFailure({ errorDescription: ' err_name_not_resolved ' }), 'dns', 'case and spaces do not matter');
  assert.equal(classifyLoadFailure(), 'other');
});

test('classifyLoadFailure falls back to the numeric code when there is no description', () => {
  const byCode = { '-106': 'offline', '-21': 'offline', '-105': 'dns', '-102': 'refused', '-101': 'refused', '-100': 'refused', '-7': 'timeout', '-118': 'timeout', '-202': 'tls', '-107': 'tls', '-2': 'other' };
  for (const [code, reason] of Object.entries(byCode)) {
    assert.equal(classifyLoadFailure({ errorCode: Number(code) }), reason, code);
  }
});

test('windowTitleFor follows the page title and falls back to GadgetsPOS', () => {
  assert.equal(windowTitleFor('Orders - Society Files', true, 'https://vendor.societyfiles.com/orders'), 'Orders - Society Files');
  assert.equal(windowTitleFor('  Orders  ', true, ''), 'Orders');
  assert.equal(windowTitleFor('', true, ''), 'GadgetsPOS');
  assert.equal(windowTitleFor('   ', true, ''), 'GadgetsPOS');
  assert.equal(windowTitleFor(undefined, true, ''), 'GadgetsPOS');
  assert.equal(windowTitleFor('loading.html', false, 'file:///app/loading.html'), 'GadgetsPOS', 'a title made up from a file URL');
  assert.equal(windowTitleFor('https://vendor.societyfiles.com/vendor/point-of-sale', true, ''), 'GadgetsPOS', 'a title that is an address');
  assert.equal(windowTitleFor('vendor.societyfiles.com/vendor/point-of-sale', true, 'https://vendor.societyfiles.com/vendor/point-of-sale'), 'GadgetsPOS', 'Chromium shows the address of a page without a title');
});

test('clampZoom limits the level to -3..5 and treats junk as 0', () => {
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(99), 5);
  assert.equal(clampZoom(-99), -3);
  assert.equal(clampZoom('2'), 2);
  for (const junk of [undefined, null, NaN, 'big', {}]) assert.equal(clampZoom(junk), 0);
});

test('the window icon is the .ico on Windows, the .png on Linux, none on macOS or without an assets folder', () => {
  const assets = path.join(path.sep, 'app', 'assets');
  assert.equal(resolveWindowIcon('win32', assets), path.join(assets, 'icon.ico'));
  assert.equal(resolveWindowIcon('linux', assets), path.join(assets, 'icon.png'));
  assert.equal(resolveWindowIcon('darwin', assets), undefined);
  assert.equal(resolveWindowIcon('win32', undefined), undefined);
});

test('the window background follows the system theme', () => {
  assert.equal(windowBackground({ shouldUseDarkColors: false }), '#F6F7FB');
  assert.equal(windowBackground({ shouldUseDarkColors: true }), '#0D1720');
  assert.equal(windowBackground(undefined), '#F6F7FB');
});

test('the window colour is the page colour: windowBackground() is --bg of tokens.css in both themes, so nothing changes when the page appears', () => {
  // The window is on screen about 300 ms before loading.html is drawn (SPEC 18b S1), showing only its own colour.
  const tokens = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'shared', 'tokens.css'), 'utf8');
  const match = /--bg:\s*light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/.exec(tokens);
  assert.ok(match, '--bg is defined with light-dark(light, dark)');
  assert.equal(windowBackground({ shouldUseDarkColors: false }).toUpperCase(), match[1].toUpperCase());
  assert.equal(windowBackground({ shouldUseDarkColors: true }).toUpperCase(), match[2].toUpperCase());
});

test('web preferences: the secure flags, the right preload per kind of window, and DevTools only in development', () => {
  const preloadDir = path.join(path.sep, 'app', 'src', 'preload');
  const secure = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false };

  const remote = buildRemoteWebPreferences({ preloadDir, version: '2.0.0' });
  assert.equal(remote.preload, path.join(preloadDir, 'app.js'));
  assert.deepEqual(remote.additionalArguments, [`${VERSION_ARG_PREFIX}2.0.0`]);
  assert.equal(remote.devTools, false);
  for (const [key, value] of Object.entries(secure)) assert.equal(remote[key], value, key);

  const local = buildLocalWebPreferences({ preloadDir, version: '2.0.0', isDev: true });
  assert.equal(local.preload, path.join(preloadDir, 'local.js'));
  assert.equal(local.devTools, true);
  for (const [key, value] of Object.entries(secure)) assert.equal(local[key], value, key);
});
