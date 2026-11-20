'use strict';

/**
 * SPEC 12, window.open: a page chooses the SIZE of a window it opens and nothing else. Electron builds the options of a popup as
 * `{ show: true, width: 800, height: 600, ...whatTheFeaturesStringAskedFor, ...overrideBrowserWindowOptions }` and turns every
 * `key=value` of the page's features string into an option, so an option the open handler does not override is whatever the page
 * (or a third-party frame inside it: the opener is judged by the main frame) asked for: always on top, kiosk, not closable, frameless,
 * see-through, hidden, off screen. These tests model that merge, name every option of the installed Electron's typings, and fail when a
 * newer Electron adds an option that PINNED_POPUP_OPTIONS (src/main/security.js) does not name yet.
 *
 * The same attack is proven against the real Electron runtime by tests/verify/security-e2e.js (V1).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSecurity, PINNED_POPUP_OPTIONS, SECURE_WEB_PREFERENCES } = require('../../src/main/security');

const POS = 'https://vendor.societyfiles.com';
const APP_PRELOAD = '/app/src/preload/app.js';
const ELECTRON_TYPES = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'electron.d.ts');

/** The options the app decides itself, on top of the pinned table: the secure web preferences, the menu bar, and the size (validated). */
const APP_OWNED = Object.freeze(['autoHideMenuBar', 'webPreferences', 'width', 'height']);

// ---- what Electron does with a features string (lib/common/parse-features-string.ts and guest-window-manager.ts, Electron 32) ----------

const NUMBER_KEYS = new Set(['top', 'left', 'x', 'y', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'opacity']);
const WEB_PREFERENCE_KEYS = ['zoomFactor', 'nodeIntegration', 'javascript', 'contextIsolation', 'webviewTag'];

function coerce(key, value) {
  if (NUMBER_KEYS.has(key)) return Number(value);
  switch (value) {
    case 'true':
    case '1':
    case 'yes':
    case undefined:
      return true;
    case 'false':
    case '0':
    case 'no':
      return false;
    default:
      return value;
  }
}

function parseFeatures(text) {
  const bag = {};
  for (const part of String(text).split(',')) {
    const [key, value] = part.split('=').map((piece) => piece.trim());
    if (key) bag[key] = coerce(key, value);
  }
  const webPreferences = {};
  for (const key of WEB_PREFERENCE_KEYS) {
    if (bag[key] === undefined) continue;
    webPreferences[key] = bag[key];
    delete bag[key];
  }
  if (bag.left !== undefined) bag.x = bag.left;
  if (bag.top !== undefined) bag.y = bag.top;
  return { ...bag, webPreferences };
}

/** The options of the popup: Electron's defaults, then what the features string asked for, then the handler's override. */
const optionsOfPopup = (features, override) => ({ show: true, width: 800, height: 600, ...parseFeatures(features), ...override });

// ---- the guards with a fake webContents -------------------------------------------------------------------------------------

function openHandlerOf(createChildWindow) {
  let handler = null;
  const contents = {
    mainFrame: { origin: POS },
    getURL: () => `${POS}/vendor/point-of-sale`,
    on() {},
    setWindowOpenHandler: (fn) => {
      handler = fn;
    },
  };
  // a clock that is 11 s further on at every look: the open rate limit is not what this file is about
  let time = 0;
  createSecurity({ getConfig: () => ({}), isPackaged: true, now: () => (time += 11_000) }).attachGuards(contents, { createChildWindow });
  return handler;
}

/** What the page gets when it calls window.open('about:blank', '_blank', features). */
function popupFor(features, createChildWindow = () => ({ autoHideMenuBar: true, webPreferences: { preload: APP_PRELOAD } })) {
  const decision = openHandlerOf(createChildWindow)({ url: 'about:blank', features });
  assert.equal(decision.action, 'allow');
  return optionsOfPopup(features, decision.overrideBrowserWindowOptions);
}

// ---- every option of the installed Electron ---------------------------------------------------------------------------------

/** The option names of `BaseWindowConstructorOptions` and `BrowserWindowConstructorOptions` in electron.d.ts, or null without the typings. */
function optionNamesOfElectron() {
  let source;
  try {
    source = fs.readFileSync(ELECTRON_TYPES, 'utf8');
  } catch {
    return null;
  }
  const names = new Set();
  for (const name of ['BaseWindowConstructorOptions', 'BrowserWindowConstructorOptions']) {
    const start = source.indexOf(`interface ${name} `);
    if (start < 0) return null;
    const rest = source.slice(start);
    const body = rest.slice(0, rest.indexOf('\n  }\n'));
    for (const match of body.matchAll(/^ {4}([A-Za-z]+)\??:/gm)) names.add(match[1]);
  }
  return names.size > 20 ? [...names].sort() : null;
}

const ELECTRON_OPTIONS = optionNamesOfElectron();

test('every window option of Electron is named in the pinned table or decided by the app: a newer Electron that adds one fails here', (t) => {
  if (ELECTRON_OPTIONS === null) return t.skip('node_modules/electron/electron.d.ts is not available');
  const unnamed = ELECTRON_OPTIONS.filter((name) => !APP_OWNED.includes(name) && !Object.hasOwn(PINNED_POPUP_OPTIONS, name));
  assert.deepEqual(unnamed, [], `add these options of Electron to PINNED_POPUP_OPTIONS in src/main/security.js (a safe value, or undefined for Electron's default): ${unnamed.join(', ')}`);
  const stale = Object.keys(PINNED_POPUP_OPTIONS).filter((name) => !ELECTRON_OPTIONS.includes(name));
  assert.deepEqual(stale, [], 'the table names an option the installed Electron does not have');
  assert.ok(ELECTRON_OPTIONS.includes('alwaysOnTop') && ELECTRON_OPTIONS.includes('kiosk') && ELECTRON_OPTIONS.includes('closable'), 'the typings were read');
  return undefined;
});

test('the pinned table is frozen and holds the value of an ordinary window for the options that matter most', () => {
  assert.ok(Object.isFrozen(PINNED_POPUP_OPTIONS));
  assert.deepEqual(
    {
      show: PINNED_POPUP_OPTIONS.show, alwaysOnTop: PINNED_POPUP_OPTIONS.alwaysOnTop, fullscreen: PINNED_POPUP_OPTIONS.fullscreen, kiosk: PINNED_POPUP_OPTIONS.kiosk,
      simpleFullscreen: PINNED_POPUP_OPTIONS.simpleFullscreen, closable: PINNED_POPUP_OPTIONS.closable, movable: PINNED_POPUP_OPTIONS.movable,
      resizable: PINNED_POPUP_OPTIONS.resizable, minimizable: PINNED_POPUP_OPTIONS.minimizable, maximizable: PINNED_POPUP_OPTIONS.maximizable,
      focusable: PINNED_POPUP_OPTIONS.focusable, frame: PINNED_POPUP_OPTIONS.frame, transparent: PINNED_POPUP_OPTIONS.transparent,
      opacity: PINNED_POPUP_OPTIONS.opacity, skipTaskbar: PINNED_POPUP_OPTIONS.skipTaskbar, hasShadow: PINNED_POPUP_OPTIONS.hasShadow,
      titleBarStyle: PINNED_POPUP_OPTIONS.titleBarStyle, x: PINNED_POPUP_OPTIONS.x, y: PINNED_POPUP_OPTIONS.y,
    },
    {
      show: true, alwaysOnTop: false, fullscreen: false, kiosk: false, simpleFullscreen: false, closable: true, movable: true, resizable: true, minimizable: true,
      maximizable: true, focusable: true, frame: true, transparent: false, opacity: 1, skipTaskbar: false, hasShadow: true, titleBarStyle: 'default', x: undefined, y: undefined,
    },
  );
});

// ---- what a page can no longer do ------------------------------------------------------------------------------------------

test('the attack of the finding: always on top, kiosk, not closable, frameless, see-through, hidden and off screen all give an ordinary window', () => {
  const features = 'alwaysOnTop=yes,fullscreen=yes,kiosk=yes,simpleFullscreen=yes,closable=no,movable=no,frame=no,transparent=yes,focusable=no,show=no,opacity=0.05,x=-5000,y=-5000,skipTaskbar=yes,titleBarStyle=hidden,type=toolbar';
  const popup = popupFor(`${features},width=300,height=200`);
  assert.equal(popup.alwaysOnTop, false);
  assert.equal(popup.fullscreen, false);
  assert.equal(popup.kiosk, false);
  assert.equal(popup.simpleFullscreen, false);
  assert.equal(popup.closable, true);
  assert.equal(popup.movable, true);
  assert.equal(popup.frame, true);
  assert.equal(popup.transparent, false);
  assert.equal(popup.focusable, true);
  assert.equal(popup.show, true);
  assert.equal(popup.opacity, 1);
  assert.equal(popup.x, undefined);
  assert.equal(popup.y, undefined);
  assert.equal(popup.skipTaskbar, false);
  assert.equal(popup.titleBarStyle, 'default');
  assert.equal(popup.type, undefined);
  assert.equal(popup.width, 300, 'what the page keeps: its size');
  assert.equal(popup.height, 200);
});

test('left and top are the page\'s way to say x and y: they place nothing either', () => {
  const popup = popupFor('left=-3000,top=-3000,width=500,height=400');
  assert.equal(popup.x, undefined);
  assert.equal(popup.y, undefined);
  assert.equal(popup.width, 500);
});

test('whatever a page asks for an option, the window gets the app\'s value: every option of Electron, with the values that matter', (t) => {
  if (ELECTRON_OPTIONS === null) return t.skip('node_modules/electron/electron.d.ts is not available');
  const hostile = ['yes', 'no', '0', '1', '-5000', '100000', 'hidden', 'toolbar', '/etc/hosts'];
  const decide = openHandlerOf(() => ({ autoHideMenuBar: true, webPreferences: { preload: APP_PRELOAD } }));
  for (const name of ELECTRON_OPTIONS.filter((option) => option !== 'width' && option !== 'height')) {
    for (const value of hostile) {
      const features = `${name}=${value}`;
      const popup = optionsOfPopup(features, decide({ url: 'about:blank', features }).overrideBrowserWindowOptions);
      const expected = name === 'autoHideMenuBar' ? true : PINNED_POPUP_OPTIONS[name];
      if (name === 'webPreferences') {
        assert.equal(popup.webPreferences.sandbox, true, features);
      } else {
        assert.strictEqual(popup[name], expected, `${features} must not reach the window`);
      }
    }
  }
  return undefined;
});

test('a features string that names every option at once, with every value, still gives the app\'s window', (t) => {
  if (ELECTRON_OPTIONS === null) return t.skip('node_modules/electron/electron.d.ts is not available');
  const names = ELECTRON_OPTIONS.filter((option) => option !== 'width' && option !== 'height');
  for (const value of ['yes', 'no', '0', '-1']) {
    const features = [...names.map((name) => `${name}=${value}`), 'left=-9,top=-9', 'width=640,height=480'].join(',');
    const popup = popupFor(features);
    for (const name of names) {
      if (name === 'webPreferences') continue;
      assert.strictEqual(popup[name], name === 'autoHideMenuBar' ? true : PINNED_POPUP_OPTIONS[name], `${name}=${value}`);
    }
    assert.equal(popup.width, 640);
    assert.equal(popup.height, 480);
  }
});

test('the web preferences stay the secure ones, even when the page asks for node integration', () => {
  const popup = popupFor('nodeIntegration=yes,contextIsolation=no,webviewTag=yes,javascript=no,zoomFactor=9,sandbox=no,webSecurity=no');
  assert.deepEqual(popup.webPreferences, { preload: APP_PRELOAD, ...SECURE_WEB_PREFERENCES });
});

test('the size the page asks for is limited, and a size it does not ask for is Electron\'s default', () => {
  assert.equal(popupFor('width=99999999,height=99999999').width, 10000);
  const plain = popupFor('');
  assert.equal(plain.width, 800);
  assert.equal(plain.height, 600);
  assert.equal(popupFor('minWidth=5000,maxWidth=10,minHeight=5000,maxHeight=10').minWidth, undefined, 'a size range is not a size');
});

// ---- what the app itself may still decide -----------------------------------------------------------------------------------

test('the window factory of the app can still name an option (its icon, a parent): its value replaces the pinned one, the page\'s never does', () => {
  const factory = () => ({ icon: '/app/assets/icon.ico', autoHideMenuBar: false, webPreferences: { preload: APP_PRELOAD } });
  const popup = popupFor('icon=/etc/hosts,title=Enter the manager password,autoHideMenuBar=no', factory);
  assert.equal(popup.icon, '/app/assets/icon.ico');
  assert.equal(popup.autoHideMenuBar, true, 'the menu bar is the app\'s decision');
  assert.equal(popup.title, undefined, 'the title is the page\'s own <title>, not a feature');

  const bare = popupFor('icon=/etc/hosts', () => ({ webPreferences: { preload: APP_PRELOAD } }));
  assert.equal(bare.icon, undefined, 'without an icon of the app, a path from the page is not used either');
});

test('a window the guards deny gets no options at all: nothing is pinned for a popup that does not exist', () => {
  const decide = openHandlerOf(() => ({ webPreferences: {} }));
  assert.deepEqual(decide({ url: 'javascript:alert(1)', features: 'alwaysOnTop=yes' }), { action: 'deny' });
});
