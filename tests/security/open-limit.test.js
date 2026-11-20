'use strict';

/**
 * SPEC 12: a page gets only so many popups and system-browser opens in a row (OPEN_LIMITS in src/main/security.js): 3 per 10 seconds
 * from one webContents and 20 per minute from all of them. Popups and browser opens share the budget, only what was allowed counts,
 * and a refused burst is reported once, with the host only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity, OPEN_LIMITS } = require('../../src/main/security');

const POS_ORIGIN = 'https://vendor.societyfiles.com';

/** A clock the test moves (milliseconds). */
function manualClock(start = 1_000) {
  const clock = { time: start, now: () => clock.time, advance: (ms) => { clock.time += ms; } };
  return clock;
}

/** One webContents with the guards of one shared security object, and the hooks recorded. */
function pageOn(security, { origin = POS_ORIGIN } = {}) {
  const listeners = new Map();
  let openHandler = null;
  const record = { browser: [], blocked: [], notices: [] };
  security.attachGuards(
    {
      mainFrame: { origin },
      getURL: () => `${origin}/`,
      on: (event, listener) => listeners.set(event, listener),
      setWindowOpenHandler: (handler) => { openHandler = handler; },
    },
    {
      openExternal: (url) => record.browser.push(url),
      onBlocked: (info) => record.blocked.push(info),
      notify: (message) => record.notices.push(message),
      createChildWindow: () => ({ webPreferences: {} }),
    },
  );
  return {
    record,
    /** window.open: true when the page got its window */
    open: (url = 'about:blank') => openHandler({ url, features: '' }).action === 'allow',
    /** a main-frame navigation to a foreign site: true when it went to the system browser */
    navigate: (url) => {
      const before = record.browser.length;
      const event = { url, isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
      listeners.get('will-navigate')(event);
      assert.equal(event.prevented, true, 'the navigation itself is always cancelled');
      return record.browser.length > before;
    },
  };
}

const setup = (clock = manualClock()) => ({ clock, security: createSecurity({ getConfig: () => ({}), isPackaged: true, now: clock.now }) });

test('the limits are 3 per 10 seconds per webContents and 20 per minute overall', () => {
  assert.deepEqual({ ...OPEN_LIMITS }, { perContents: 3, perContentsMs: 10_000, overall: 20, overallMs: 60_000 });
  assert.ok(Object.isFrozen(OPEN_LIMITS));
});

test('a page gets three popups, the fourth and every later one is refused, and the budget comes back after ten seconds', () => {
  const { clock, security } = setup();
  const page = pageOn(security);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => page.open()), [true, true, true, false, false]);
  clock.advance(9_999);
  assert.equal(page.open(), false, 'not one millisecond early');
  clock.advance(1);
  assert.deepEqual([1, 2, 3, 4].map(() => page.open()), [true, true, true, false], 'the three were taken at one moment: all three expire together');
});

test('a refused attempt does not extend the wait: only what was allowed counts', () => {
  const { clock, security } = setup();
  const page = pageOn(security);
  for (let at = 0; at < 3; at += 1) {
    assert.equal(page.open(), true);
    clock.advance(1);
  }
  for (let at = 0; at < 6; at += 1) {
    assert.equal(page.open(), false);
    clock.advance(1);
  }
  clock.advance(10_000 - 9); // 10 s since the first allowed one: 11 000 on this clock
  assert.equal(page.open(), true, 'the first allowed one has expired, and the refusals in between changed nothing');
  assert.equal(page.open(), false, 'the other two (1 and 2 ms later) are still counted');
});

test('popups and system-browser opens share one budget (window.open to a foreign site and a blocked navigation both go to the browser)', () => {
  const { security } = setup();
  const page = pageOn(security);
  assert.equal(page.open(), true);
  assert.equal(page.navigate('https://example.org/a'), true);
  assert.equal(page.open('https://example.com/b'), false, 'window.open of a foreign https URL is denied either way; it was the third of the budget');
  assert.deepEqual(page.record.browser, ['https://example.org/a', 'https://example.com/b']);
  assert.equal(page.open(), false, 'the budget of three is used up');
  assert.equal(page.navigate('https://example.org/c'), false, 'and a navigation to a foreign site is still cancelled, but no longer opened');
  assert.equal(page.record.browser.length, 2);
  assert.equal(page.record.notices.length, 2, 'the notice is shown only for what was really opened');
});

test('each webContents has its own three; the whole app has twenty a minute', () => {
  const { clock, security } = setup();
  const pages = Array.from({ length: 8 }, () => pageOn(security));
  const opened = pages.map((page) => [1, 2, 3, 4].map(() => page.open()).filter(Boolean).length);
  assert.deepEqual(opened, [3, 3, 3, 3, 3, 3, 2, 0], 'the 21st popup of the minute is refused, whichever page asks');
  clock.advance(60_000);
  assert.equal(pages[7].open(), true, 'a minute later the overall budget is back');
});

test('a refused burst is reported once with the host only, and a new burst is reported again', () => {
  const { clock, security } = setup();
  const page = pageOn(security);
  for (let i = 0; i < 3; i += 1) page.open();
  for (let i = 0; i < 50; i += 1) page.navigate(`https://example.org/spam?token=SECRET${i}`);
  assert.equal(page.record.blocked.length, 1, 'fifty refusals, one log line');
  const [info] = page.record.blocked;
  assert.equal(info.reason, 'rate-limited');
  assert.equal(info.source, 'will-navigate');
  assert.equal(info.host, 'example.org');
  assert.equal(info.url, '', 'no address: a query string can carry a token');
  assert.ok(!JSON.stringify(info).includes('SECRET'));

  clock.advance(10_000);
  for (let i = 0; i < 3; i += 1) assert.equal(page.open(), true);
  assert.equal(page.open(), false);
  assert.equal(page.record.blocked.length, 2, 'the next burst is reported');
  assert.equal(page.record.blocked[1].source, 'window-open');
});

test('what opens nothing costs nothing: unsafe links and refused openers do not use the budget', () => {
  const { security } = setup();
  const page = pageOn(security);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(page.open('javascript:alert(1)'), false);
    assert.equal(page.navigate('file:///etc/passwd'), false);
  }
  assert.deepEqual(page.record.blocked.map((info) => info.reason), Array(40).fill('unsafe-url'));
  assert.deepEqual([1, 2, 3].map(() => page.open()), [true, true, true], 'the three popups are all still there');

  const foreign = pageOn(security, { origin: 'https://evil.example' });
  for (let i = 0; i < 10; i += 1) assert.equal(foreign.open('about:blank'), false);
  assert.equal(foreign.record.blocked.every((info) => info.reason === 'opener-not-allowed'), true);
});

test('without an injected clock the limit still works (performance.now)', () => {
  const security = createSecurity({ getConfig: () => ({}), isPackaged: true });
  const page = pageOn(security);
  assert.deepEqual([1, 2, 3, 4].map(() => page.open()), [true, true, true, false]);
});
