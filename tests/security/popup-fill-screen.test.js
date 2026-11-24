'use strict';

/**
 * A window the POS page opens for a real web address (the dashboard, a report, an image) fills the screen like the main window.
 * A blank or blob document (receipt, PDF, print preview) keeps the size its page asked for. The app's own windows (Settings,
 * the password prompt) are not made by `window.open`, so this listener never sees them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity } = require('../../src/main/security');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const POS_ORIGIN = 'https://vendor.societyfiles.com';

function setup() {
  const security = createSecurity({
    getConfig: () => ({ serverUrl: POS_URL, extraAllowedOrigins: [] }),
    isPackaged: true,
    now: () => 0,
  });
  const listeners = new Map();
  const webContents = {
    mainFrame: { origin: POS_ORIGIN },
    getURL: () => `${POS_ORIGIN}/`,
    on(event, listener) {
      listeners.set(event, listener);
      return webContents;
    },
    setWindowOpenHandler() {},
  };
  security.attachGuards(webContents, { createChildWindow: () => ({}) });
  return { created: listeners.get('did-create-window') };
}

/** A fake child window that counts `maximize()` calls. */
function childWindow() {
  const win = { maximized: 0, maximize() { win.maximized += 1; } };
  return win;
}

test('the guards listen for a window the page created', () => {
  assert.equal(typeof setup().created, 'function');
});

test('the dashboard opened from the POS screen fills the screen', () => {
  const { created } = setup();
  const win = childWindow();
  created(win, { url: `${POS_ORIGIN}/vendor/dashboard` });
  assert.equal(win.maximized, 1);
});

test('a page of the allowed site, with a size asked for in the features, still fills the screen', () => {
  const { created } = setup();
  const win = childWindow();
  created(win, { url: `${POS_ORIGIN}/vendor/orders/sell/42`, features: 'width=500,height=400' });
  assert.equal(win.maximized, 1);
});

test('an http address of a page fills the screen too', () => {
  const { created } = setup();
  const win = childWindow();
  created(win, { url: 'http://localhost:3000/vendor/dashboard' });
  assert.equal(win.maximized, 1);
});

test('a blank document (receipt, print preview, pdfMake) keeps the size its page asked for', () => {
  const { created } = setup();
  const win = childWindow();
  created(win, { url: 'about:blank' });
  assert.equal(win.maximized, 0);
});

test('a blob document (a generated PDF or label) keeps the size its page asked for', () => {
  const { created } = setup();
  const win = childWindow();
  created(win, { url: `blob:${POS_ORIGIN}/0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11` });
  assert.equal(win.maximized, 0);
});

test('an odd or missing address never maximizes and never throws', () => {
  const { created } = setup();
  for (const url of [undefined, null, '', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
    const win = childWindow();
    assert.doesNotThrow(() => created(win, { url }));
    assert.equal(win.maximized, 0, String(url));
  }
  assert.doesNotThrow(() => created(childWindow(), undefined));
  assert.doesNotThrow(() => created(childWindow(), null));
});

test('a window that cannot be maximized, or whose maximize() throws, does not break the guard', () => {
  const { created } = setup();
  assert.doesNotThrow(() => created({}, { url: `${POS_ORIGIN}/vendor/dashboard` }));
  assert.doesNotThrow(() => created(null, { url: `${POS_ORIGIN}/vendor/dashboard` }));
  assert.doesNotThrow(() =>
    created({ maximize() { throw new Error('gone'); } }, { url: `${POS_ORIGIN}/vendor/dashboard` }));
});
