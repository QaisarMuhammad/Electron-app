'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreload, findBanner } = require('./harness');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
/** SPEC 11.3, word for word (the dash is U+2014). */
const OFFLINE_TEXT = "No internet connection. We'll keep trying — your work on this page is not lost.";
const ONLINE_TEXT = 'Back online';
const ANNOUNCE_MS = 30;

const page = (options) => runPreload('app.js', { url: POS_URL, ...options });
const banner = (ctx) => findBanner(ctx.document);
const status = (ctx, payload) => ctx.ipc.emitFromMain('connectivity:status', payload);

test('an online page gets no banner DOM at all, only the listeners that will need it', () => {
  const ctx = page();
  assert.equal(ctx.document.documentElement.children.length, 0);
  assert.equal(banner(ctx), null);
  assert.equal(ctx.window.listenerCount('offline'), 1);
  assert.equal(ctx.window.listenerCount('online'), 1);
  assert.equal(ctx.ipc.listenerCount('connectivity:status'), 1);
});

test('going offline shows the banner in a closed Shadow DOM, announced politely a moment later', () => {
  const ctx = page();
  ctx.window.dispatch('offline');

  const shown = banner(ctx);
  assert.ok(shown, 'the banner exists');
  assert.equal(shown.host.shadowMode, 'closed');
  assert.equal(shown.host.shadowRoot, null, 'the page cannot reach into a closed shadow root');
  assert.equal(shown.host.parentNode, ctx.document.documentElement, 'appended to <html>, outside the page body');
  assert.equal(shown.state, 'offline');
  assert.equal(shown.message, '', 'the text is set after the region exists, so screen readers announce the change');
  assert.equal(shown.text.getAttribute('role'), 'status');
  assert.equal(shown.text.getAttribute('aria-live'), 'polite');
  assert.equal(shown.text.getAttribute('aria-atomic'), 'true');

  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(banner(ctx).message, OFFLINE_TEXT);
});

test('the banner is an overlay: fixed, top centre, transparent to the mouse except its button, at most 48 px, no layout shift', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  const { css, button } = banner(ctx);
  assert.match(css, /\.wrap \{[^}]*position: fixed;[^}]*top: 8px;[^}]*justify-content: center;[^}]*pointer-events: none;/);
  assert.match(css, /max-height: 48px;/);
  assert.match(css, /button \{[^}]*pointer-events: auto;/);
  assert.match(css, /z-index: 2147483647/);
  assert.match(css, /:host \{ all: initial; \}/, 'the page\'s CSS cannot restyle the host');
  assert.equal(button.getAttribute('aria-label'), 'Dismiss');
  assert.equal(button.type, 'button');
});

test('only opacity and transform are animated, and nothing moves under prefers-reduced-motion', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  const { css } = banner(ctx);
  const transitions = css.match(/transition:[^;]+;/g) || [];
  assert.equal(transitions.length, 2, 'the pill transition and the reduced-motion override');
  assert.match(transitions[0], /^transition: opacity 160ms cubic-bezier\([^)]*\), transform 160ms cubic-bezier\([^)]*\);$/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.pill \{ transition: none; \} \}/);
});

test('the banner never prints: receipts and invoices are printed from the page', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  assert.match(banner(ctx).css, /@media print \{ \.wrap \{ display: none; \} \}/);
});

test('coming back online shows "Back online" for 3 s and then the banner disappears', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  ctx.timers.advance(ANNOUNCE_MS);
  ctx.window.dispatch('online');

  let shown = banner(ctx);
  assert.equal(shown.state, 'online');
  assert.equal(shown.button.disabled, true, 'the dismiss button is only for the offline notice');
  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(banner(ctx).message, ONLINE_TEXT);

  ctx.timers.advance(2969); // 2999 ms after the page came back
  assert.equal(banner(ctx).state, 'online');
  ctx.timers.advance(1);
  shown = banner(ctx);
  assert.equal(shown.state, 'hidden');
  assert.equal(ctx.timers.pendingCount(), 0, 'no timer is left running when idle');
});

test('an "online" event without a preceding outage shows nothing', () => {
  const ctx = page();
  ctx.window.dispatch('online');
  ctx.timers.advance(10000);
  assert.equal(banner(ctx), null);
  assert.equal(ctx.document.documentElement.children.length, 0);
});

test('the usual shop outage: the browser says online but the main process cannot reach the server', () => {
  const ctx = page();
  status(ctx, { online: false, attempt: 1, nextRetryInMs: 3000, reason: 'dns' });
  assert.equal(banner(ctx).state, 'offline');

  ctx.window.dispatch('online'); // the router is up, the provider is not
  assert.equal(banner(ctx).state, 'offline', 'the main process is authoritative');

  status(ctx, { online: true });
  assert.equal(banner(ctx).state, 'online');
  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(banner(ctx).message, ONLINE_TEXT);
  ctx.timers.advance(3000);
  assert.equal(banner(ctx).state, 'hidden');
});

test('a successful probe does not hide the banner while the browser itself is still offline', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  status(ctx, { online: true });
  assert.equal(banner(ctx).state, 'offline');
  ctx.window.dispatch('online');
  assert.equal(banner(ctx).state, 'online');
});

test('status messages that are not a status are ignored', () => {
  const ctx = page();
  for (const junk of [null, undefined, {}, { online: 'yes' }, { online: 1 }, 'offline', 5]) status(ctx, junk);
  assert.equal(banner(ctx), null);
});

test('a page that starts offline shows the banner as soon as the document exists', () => {
  const ctx = page({ online: false, documentReady: false });
  assert.equal(ctx.document.documentElement, null);
  assert.equal(banner(ctx), null, 'nothing can be appended yet');
  assert.ok(ctx.document.listenerCount('DOMContentLoaded') >= 1);

  ctx.document.makeReady();
  assert.equal(banner(ctx).state, 'offline');
  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(banner(ctx).message, OFFLINE_TEXT);
});

test('Dismiss hides the offline notice; recovery and the next outage still show', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  ctx.timers.advance(ANNOUNCE_MS);
  banner(ctx).button.click();
  assert.equal(banner(ctx).state, 'hidden');
  assert.equal(banner(ctx).button.disabled, true, 'a hidden banner has no focusable button');

  ctx.window.dispatch('online');
  assert.equal(banner(ctx).state, 'online', 'the recovery is still reported');
  ctx.timers.advance(3000 + ANNOUNCE_MS);
  assert.equal(banner(ctx).state, 'hidden');

  ctx.window.dispatch('offline');
  assert.equal(banner(ctx).state, 'offline', 'a new outage is shown again');
  assert.equal(banner(ctx).button.disabled, false);
});

test('a new outage during "Back online" cancels the pending hide', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  ctx.window.dispatch('online');
  ctx.timers.advance(1000);
  ctx.window.dispatch('offline');
  ctx.timers.advance(5000);
  assert.equal(banner(ctx).state, 'offline');
  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(banner(ctx).message, OFFLINE_TEXT);
});

test('repeated offline events and status messages create one banner and do not restart anything', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  ctx.timers.advance(ANNOUNCE_MS);
  ctx.window.dispatch('offline');
  status(ctx, { online: false });
  status(ctx, { online: false });
  ctx.timers.advance(ANNOUNCE_MS);
  assert.equal(ctx.document.documentElement.children.filter((child) => child.localName === 'gadgetspos-banner').length, 1);
  assert.equal(banner(ctx).message, OFFLINE_TEXT);
  assert.equal(ctx.timers.pendingCount(), 0);
});

test('the banner never uses innerHTML or the page\'s DOM: it is built with createElement only', () => {
  const ctx = page();
  ctx.window.dispatch('offline');
  const names = ctx.document.created.map((element) => element.localName).sort();
  assert.deepEqual(names, ['button', 'div', 'div', 'gadgetspos-banner', 'span', 'span', 'style']);
});

test('no timer runs while the page is online and idle', () => {
  const ctx = page();
  ctx.timers.advance(60 * 60 * 1000);
  assert.equal(ctx.timers.pendingCount(), 0);
});
