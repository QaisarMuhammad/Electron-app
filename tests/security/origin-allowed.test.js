'use strict';

/**
 * SPEC 6.1: the app preload asks main synchronously, at document start, whether the page it runs in is on an allowed
 * origin (`ipcRenderer.sendSync('app:origin-allowed')`). Main answers from the REAL sender frame, never from data the
 * page supplied:
 *
 *   try { event.returnValue = security.isAllowedOrigin(event.senderFrame.origin) } catch { event.returnValue = false }
 *
 * This file runs that handler (as written in the SPEC) against the real security object and walks through the
 * scenarios the SPEC lists: the preload exposes `window.electron` only when the answer is true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity } = require('../../src/main/security');

/** The handler body of SPEC 6.1, registered by ipc.js before the first window exists (S1). */
function originAllowedHandler(security) {
  return (event) => {
    try {
      event.returnValue = security.isAllowedOrigin(event.senderFrame.origin);
    } catch {
      event.returnValue = false;
    }
  };
}

/** What `ipcRenderer.sendSync('app:origin-allowed')` would return for a document with this frame origin. */
function ask(handler, origin, extraEventFields = {}) {
  const event = { senderFrame: { origin }, ...extraEventFields };
  handler(event);
  return event.returnValue;
}

function makeSecurity(settings) {
  return createSecurity({ getConfig: () => ({ get: (key, fallback) => settings[key] ?? fallback }), isPackaged: true });
}

test('6.1: a document on an extraAllowedOrigins origin gets window.electron, one on another origin does not', () => {
  const handler = originAllowedHandler(makeSecurity({ serverUrl: 'https://vendor.societyfiles.com/pos', extraAllowedOrigins: ['https://shop.example.com'] }));
  assert.equal(ask(handler, 'https://shop.example.com'), true);
  assert.equal(ask(handler, 'https://evil.example.com'), false);
});

test('6.1: after serverUrl is changed in Settings, a document loaded later sees the new answer', () => {
  const settings = { serverUrl: 'https://old.shop.example/pos', extraAllowedOrigins: [] };
  const handler = originAllowedHandler(makeSecurity(settings));
  assert.equal(ask(handler, 'https://new.shop.example'), false);
  assert.equal(ask(handler, 'https://old.shop.example'), true);

  settings.serverUrl = 'https://new.shop.example/pos';
  assert.equal(ask(handler, 'https://new.shop.example'), true);
  assert.equal(ask(handler, 'https://old.shop.example'), false);
});

test('6.1: an about:blank popup of an allowed origin gets it (its frame origin is inherited), a foreign or sandboxed one does not', () => {
  const handler = originAllowedHandler(makeSecurity({ serverUrl: 'https://vendor.societyfiles.com/pos' }));
  assert.equal(ask(handler, 'https://vendor.societyfiles.com'), true);
  assert.equal(ask(handler, 'https://evil.example'), false);
  assert.equal(ask(handler, 'null'), false, 'a sandboxed frame or a data: page has the opaque origin "null"');
});

test('6.1: the answer comes from senderFrame.origin only; anything the page supplied is ignored', () => {
  const handler = originAllowedHandler(makeSecurity({ serverUrl: 'https://vendor.societyfiles.com/pos' }));
  const pageClaims = { locationOrigin: 'https://vendor.societyfiles.com', args: ['https://vendor.societyfiles.com'], url: 'https://vendor.societyfiles.com/' };
  assert.equal(ask(handler, 'https://evil.example', pageClaims), false);
  assert.equal(ask(handler, 'https://vendor.societyfiles.com', { locationOrigin: 'https://evil.example', args: ['https://evil.example'] }), true);
});

test('6.1: the handler ALWAYS sets returnValue (an unset one would block the renderer forever)', () => {
  const handler = originAllowedHandler(makeSecurity({}));
  const withReturnValue = (event) => {
    handler(event);
    return Object.prototype.hasOwnProperty.call(event, 'returnValue') ? event.returnValue : 'UNSET';
  };

  assert.equal(withReturnValue({ senderFrame: { origin: 'https://gadgetspos.com' } }), true);
  assert.equal(withReturnValue({ senderFrame: { origin: 'https://evil.example' } }), false);
  // A destroyed frame throws when read; a missing frame is a TypeError.
  assert.equal(withReturnValue({ senderFrame: Object.defineProperty({}, 'origin', { get() { throw new Error('Render frame was disposed'); } }) }), false);
  assert.equal(withReturnValue({ senderFrame: null }), false);
  assert.equal(withReturnValue({}), false);
  assert.equal(withReturnValue({ senderFrame: { origin: undefined } }), false);
});

test('6.1: registered before the config exists, the handler already answers from the defaults (S1)', () => {
  const loading = originAllowedHandler(createSecurity({ getConfig: () => null, isPackaged: true }));
  assert.equal(ask(loading, 'https://vendor.societyfiles.com'), true);
  assert.equal(ask(loading, 'https://gadgetspos.com'), true);
  assert.equal(ask(loading, 'https://shop.example.com'), false, 'extra origins are not known yet');

  const noConfigAtAll = originAllowedHandler(createSecurity({ isPackaged: true }));
  assert.equal(ask(noConfigAtAll, 'https://gadgetspos.com'), true);
});

test('6.1: the provider hosts, local pages and dev servers (when packaged) never get window.electron', () => {
  const handler = originAllowedHandler(makeSecurity({}));
  for (const origin of ['https://connect.squareup.com', 'https://squareup.com', 'file://', 'http://localhost:3000', 'http://127.0.0.1:3000', 'about:blank', '']) {
    assert.equal(ask(handler, origin), false, JSON.stringify(origin));
  }
});
