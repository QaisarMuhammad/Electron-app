'use strict';

/**
 * SECURITY lens, window.open and external links (SPEC 12). Two findings, both proven against the real app under real Electron by
 * tests/verify/security-e2e.js (V1 and V2); these tests are the fast, Node-only form.
 *
 *  1. The window.open `features` string reaches the NATIVE window options. Electron builds a popup's options as
 *     `{ show: true, width: 800, height: 600, ...optionsParsedFromFeatures, ...overrideBrowserWindowOptions }`, so an option the
 *     open handler does not override is whatever the page asked for. src/main/security.js (`childWindowOptions`) pins the web
 *     preferences, the menu bar and the size, and nothing else: a page (or a third-party iframe in it: the opener is judged by
 *     the main frame) can open a full-screen, kiosk, always-on-top popup that cannot be closed or moved, or one that is nearly
 *     invisible, and fill it with a fake "enter the manager password" page.
 *  2. A page can open unlimited windows and system-browser tabs: no user-gesture test, no cap, no rate limit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity } = require('../../src/main/security');

const POS = 'https://vendor.societyfiles.com';

/** The part of a webContents the guards use. `open(details)` calls the window-open handler; `emit(name, event)` a stored listener. */
function fakeContents() {
  const listeners = {};
  let openHandler = null;
  return {
    mainFrame: { origin: POS },
    getURL: () => `${POS}/vendor/point-of-sale`,
    on: (name, fn) => { listeners[name] = fn; },
    setWindowOpenHandler: (fn) => { openHandler = fn; },
    open: (details) => openHandler(details),
    emit: (name, event) => listeners[name](event),
  };
}

// ---- what Electron 32.3.3 does with a features string (observed in the real runtime, see security-e2e.js V1) -----------------

const BOOLEAN_FEATURES = ['alwaysOnTop', 'fullscreen', 'kiosk', 'closable', 'movable', 'resizable', 'minimizable', 'maximizable', 'focusable', 'frame', 'show', 'transparent', 'skipTaskbar', 'hasShadow'];
const NUMBER_FEATURES = ['x', 'y', 'width', 'height', 'opacity'];

function parseFeatures(text) {
  const parsed = {};
  for (const part of String(text).split(',')) {
    const [key, value = ''] = part.split('=').map((piece) => piece.trim());
    if (BOOLEAN_FEATURES.includes(key)) parsed[key] = ['', 'yes', 'true', '1'].includes(value.toLowerCase());
    else if (NUMBER_FEATURES.includes(key)) parsed[key] = Number(value);
  }
  return parsed;
}

/** The options of the popup: Electron's defaults, then what the features string asked for, then the handler's override. */
const optionsOfPopup = (features, override) => ({ show: true, width: 800, height: 600, ...parseFeatures(features), ...override });

test('window.open: a features string cannot change the native window options (always-on-top, kiosk, closable, opacity, ...)', () => {
  const security = createSecurity({ getConfig: () => ({}), isPackaged: true });
  const contents = fakeContents();
  // exactly what src/main/windows/main.js hands to the guards
  security.attachGuards(contents, { createChildWindow: () => ({ autoHideMenuBar: true, webPreferences: { preload: '/app/src/preload/app.js' } }) });

  const features = 'alwaysOnTop=yes,fullscreen=yes,kiosk=yes,closable=no,movable=no,frame=no,transparent=yes,focusable=no,show=no,opacity=0.05,x=-5000,y=-5000,width=300,height=200';
  const decision = contents.open({ url: 'about:blank', features });
  assert.equal(decision.action, 'allow');
  const popup = optionsOfPopup(features, decision.overrideBrowserWindowOptions);

  assert.ok(!popup.alwaysOnTop, 'a page must not get an always-on-top window (it would sit above the till and the password window)');
  assert.ok(!popup.fullscreen && !popup.kiosk, 'a page must not get a full-screen or kiosk window (a spoofed prompt that covers the whole screen)');
  assert.notEqual(popup.closable, false, 'a popup the cashier cannot close would lock the till');
  assert.notEqual(popup.movable, false);
  assert.notEqual(popup.focusable, false);
  assert.notEqual(popup.frame, false, 'a frameless popup has no title bar to tell the cashier it is a web page');
  assert.ok(!popup.transparent);
  assert.ok(popup.opacity === undefined || popup.opacity === 1, 'a near-invisible popup can sit over the till unseen');
  assert.notEqual(popup.show, false, 'a hidden popup is a hidden page that keeps running with an opener');
  assert.notEqual(popup.x, -5000, 'the page does not choose where on (or off) the screens the window goes');
  assert.notEqual(popup.y, -5000);
  // what IS allowed (SPEC 12): the size the page asks for
  assert.equal(popup.width, 300);
  assert.equal(popup.height, 200);
});

test('window.open and navigation: one page cannot open dozens of windows or system-browser tabs in a row', () => {
  const security = createSecurity({ getConfig: () => ({}), isPackaged: true });
  const contents = fakeContents();
  const external = [];
  security.attachGuards(contents, { openExternal: (url) => { external.push(url); }, createChildWindow: () => ({ webPreferences: {} }) });

  let windows = 0;
  for (let i = 0; i < 100; i += 1) if (contents.open({ url: 'about:blank', features: '' }).action === 'allow') windows += 1;
  assert.ok(windows <= 20, `100 window.open('about:blank') calls in a row were all answered with a real window (${windows}); there is no cap`);

  for (let i = 0; i < 200; i += 1) contents.open({ url: `https://example.com/spam${i}`, features: '' });
  for (let i = 0; i < 100; i += 1) contents.emit('will-navigate', { url: `https://example.org/spam${i}`, isMainFrame: true, preventDefault() {} });
  assert.ok(external.length <= 10, `300 foreign links in a row opened ${external.length} browser tabs; there is no rate limit or coalescing`);
});
