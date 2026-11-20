'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConnectivity, createRequestErrorMonitor } = require('../../src/main/connectivity');
const { createSecurity } = require('../../src/main/security');
const { createFakeClock, createScriptedProbe } = require('../helpers/fake-net');

const SERVER_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const UP = { ok: true, status: 200 };

/** A monitor wired to a recording stand-in for the controller, with a clock the test moves by hand. */
function setupStub({ allowed = () => true, getUrl = () => SERVER_URL, windowMs, threshold } = {}) {
  const starts = [];
  let current = 5000;
  const monitor = createRequestErrorMonitor({
    connectivity: { start: (url, options) => starts.push({ url, options }) },
    isAllowedOrigin: allowed,
    getUrl,
    now: () => current,
    windowMs,
    threshold,
  });
  return { monitor, starts, advance: (ms) => (current += ms) };
}

const failure = (id, error = 'net::ERR_INTERNET_DISCONNECTED', url = 'https://vendor.societyfiles.com/api/orders') => ({ id, url, error });

test('monitor: two errors from different requests within 10 s start the banner probe, with the last error', () => {
  const { monitor, starts, advance } = setupStub();
  monitor.handle(failure(1));
  assert.equal(starts.length, 0, 'one error is not enough');
  advance(4000);
  monitor.handle(failure(2, 'net::ERR_NAME_NOT_RESOLVED'));

  assert.equal(starts.length, 1);
  assert.equal(starts[0].url, SERVER_URL);
  assert.deepEqual(starts[0].options, { mode: 'banner', lastError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } });
});

test('monitor: the same request failing twice counts once', () => {
  const { monitor, starts } = setupStub();
  monitor.handle(failure(7));
  monitor.handle(failure(7));
  monitor.handle(failure(7));
  assert.equal(starts.length, 0);
});

test('monitor: errors more than 10 s apart do not add up', () => {
  const { monitor, starts, advance } = setupStub();
  monitor.handle(failure(1));
  advance(10001);
  monitor.handle(failure(2));
  assert.equal(starts.length, 0);
  advance(10000);
  monitor.handle(failure(3));
  assert.equal(starts.length, 1, 'requests 2 and 3 are 10 s apart, which still counts');
});

test('monitor: the window is exactly 10 s by default and the threshold exactly 2', () => {
  const edge = setupStub();
  edge.monitor.handle(failure(1));
  edge.advance(10000);
  edge.monitor.handle(failure(2));
  assert.equal(edge.starts.length, 1);

  const three = setupStub({ threshold: 3 });
  three.monitor.handle(failure(1));
  three.monitor.handle(failure(2));
  assert.equal(three.starts.length, 0);
  three.monitor.handle(failure(3));
  assert.equal(three.starts.length, 1);
});

test('monitor: only the network errors of SPEC 11.3 count', () => {
  const counted = [
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_ADDRESS_UNREACHABLE',
  ];
  for (const error of counted) {
    const { monitor, starts } = setupStub();
    monitor.handle(failure(1, error));
    monitor.handle(failure(2, error));
    assert.equal(starts.length, 1, error);
  }

  const ignored = [
    'net::ERR_ABORTED',
    'net::ERR_FAILED',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_CERT_DATE_INVALID',
    'net::ERR_TIMED_OUT',
    'net::ERR_UNKNOWN_URL_SCHEME',
    'net::ERR_INVALID_URL',
    'not an error',
    '',
  ];
  for (const error of ignored) {
    const { monitor, starts } = setupStub();
    monitor.handle(failure(1, error));
    monitor.handle(failure(2, error));
    monitor.handle(failure(3, error));
    assert.equal(starts.length, 0, error);
  }
});

test('monitor: ERR_ABORTED between two real errors does not count as one of them', () => {
  const { monitor, starts } = setupStub();
  monitor.handle(failure(1));
  monitor.handle(failure(2, 'net::ERR_ABORTED'));
  assert.equal(starts.length, 0);
  monitor.handle(failure(3));
  assert.equal(starts.length, 1);
});

test('monitor: errors from origins that are not allowed are ignored (SPEC 11.3, amendment 23: any ALLOWED origin)', () => {
  const security = createSecurity({ getConfig: () => ({ serverUrl: SERVER_URL }), isPackaged: true });
  const { monitor, starts } = setupStub({ allowed: security.isAllowedOrigin });

  monitor.handle(failure(1, 'net::ERR_NAME_NOT_RESOLVED', 'https://tracker.evil.example/pixel.gif'));
  monitor.handle(failure(2, 'net::ERR_NAME_NOT_RESOLVED', 'https://fonts.googleapis.com/css'));
  monitor.handle(failure(3, 'net::ERR_NAME_NOT_RESOLVED', 'https://connect.squareup.com/oauth2/authorize'));
  assert.equal(starts.length, 0);

  // API calls go to other allowed hosts than serverUrl: they count.
  monitor.handle(failure(4, 'net::ERR_NAME_NOT_RESOLVED', 'https://api.gadgetspos.com/v1/orders'));
  monitor.handle(failure(5, 'net::ERR_NAME_NOT_RESOLVED', 'https://vendor.societyfiles.com/api/x'));
  assert.equal(starts.length, 1);
});

test('monitor: a failing WebSocket handshake counts like a request to the same origin', () => {
  const security = createSecurity({ getConfig: () => ({ serverUrl: SERVER_URL }), isPackaged: true });
  const { monitor, starts } = setupStub({ allowed: security.isAllowedOrigin });
  monitor.handle(failure(1, 'net::ERR_CONNECTION_REFUSED', 'wss://relay.societyfiles.com/socket.io/'));
  monitor.handle(failure(2, 'net::ERR_CONNECTION_REFUSED', 'wss://evil.example/socket.io/'));
  assert.equal(starts.length, 0);
  monitor.handle(failure(3, 'net::ERR_CONNECTION_REFUSED', 'https://vendor.societyfiles.com/api/x'));
  assert.equal(starts.length, 1);
});

test('monitor: nothing to probe (no server url yet) starts nothing', () => {
  const { monitor, starts } = setupStub({ getUrl: () => '' });
  monitor.handle(failure(1));
  monitor.handle(failure(2));
  assert.equal(starts.length, 0);
});

test('monitor: after it triggers the window starts over, so one outage is one start per two errors', () => {
  const { monitor, starts } = setupStub();
  monitor.handle(failure(1));
  monitor.handle(failure(2));
  monitor.handle(failure(3));
  assert.equal(starts.length, 1);
  monitor.handle(failure(4));
  assert.equal(starts.length, 2, 'the controller makes the repeated start a no-op');
});

test('monitor: reset() forgets the errors seen so far', () => {
  const { monitor, starts } = setupStub();
  monitor.handle(failure(1));
  monitor.reset();
  monitor.handle(failure(2));
  assert.equal(starts.length, 0);
});

test('monitor: malformed notifications and a throwing controller never throw', () => {
  const throwing = createRequestErrorMonitor({
    connectivity: {
      start() {
        throw new Error('controller bug');
      },
    },
    isAllowedOrigin: () => true,
    getUrl: () => SERVER_URL,
    now: () => 1,
  });
  for (const bad of [undefined, null, {}, { error: 5 }, { error: 'net::ERR_ABORTED' }, 'x', 42]) assert.doesNotThrow(() => throwing.handle(bad));
  assert.doesNotThrow(() => {
    throwing.handle(failure(1));
    throwing.handle(failure(2));
  });
});

test('monitor.attach: listens on session.webRequest.onErrorOccurred and detaches by clearing the listener', () => {
  const registered = [];
  const session = { webRequest: { onErrorOccurred: (listener) => registered.push(listener) } };
  const { monitor, starts } = setupStub();

  const detach = monitor.attach(session);
  assert.equal(registered.length, 1);
  assert.equal(typeof registered[0], 'function');
  registered[0](failure(1));
  registered[0](failure(2));
  assert.equal(starts.length, 1);

  detach();
  assert.equal(registered.length, 2);
  assert.equal(registered[1], null);
});

// ---- the whole chain of SPEC 11.3: session errors -> controller in banner mode -> probe -> online -> stop ----

test('11.3 end to end: no timer before the first error; two session errors start the banner; the first good probe ends it', async () => {
  const clock = createFakeClock();
  const probe = createScriptedProbe([{ ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' }, UP]);
  const events = [];
  const connectivity = createConnectivity({ probe, timers: clock, random: () => 0.5, onStatus: (status) => events.push(status) });
  const security = createSecurity({ getConfig: () => ({ serverUrl: SERVER_URL }), isPackaged: true });
  const monitor = createRequestErrorMonitor({ connectivity, isAllowedOrigin: security.isAllowedOrigin, getUrl: () => SERVER_URL, now: clock.now });

  const listeners = [];
  monitor.attach({ webRequest: { onErrorOccurred: (listener) => listeners.push(listener) } });
  const emitError = listeners[0];

  // Healthy: errors that do not count leave no timer and no controller behind.
  assert.equal(clock.pending(), 0);
  emitError(failure(1, 'net::ERR_ABORTED'));
  emitError(failure(2, 'net::ERR_FAILED'));
  assert.equal(clock.pending(), 0, 'R3: still no timer');
  assert.equal(connectivity.status().online, true);

  // The first real error: still nothing.
  emitError(failure(3));
  assert.equal(clock.pending(), 0);
  assert.equal(events.length, 0);

  // The second error from a different request: the banner starts.
  await clock.tick(2000);
  emitError(failure(4, 'net::ERR_NAME_NOT_RESOLVED'));
  assert.equal(events.length, 1);
  assert.equal(events[0].online, false);
  assert.equal(events[0].url, SERVER_URL);
  assert.equal(events[0].reason, 'dns');
  assert.equal(clock.pending(), 1);

  // More errors while it runs change nothing.
  emitError(failure(5));
  emitError(failure(6));
  assert.equal(clock.pending(), 1);

  // The probe fails once, then succeeds: online is announced and the controller stops.
  await clock.tick(3000);
  assert.equal(events[events.length - 1].reason, 'offline');
  await clock.tick(6000);
  const last = events[events.length - 1];
  assert.equal(last.online, true);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(probe.calls, [SERVER_URL, SERVER_URL]);

  // A later outage starts a new banner.
  emitError(failure(10));
  emitError(failure(11));
  assert.equal(connectivity.status().online, false);
  assert.equal(connectivity.status().nextRetryInMs, 3000);
  assert.equal(clock.pending(), 1);
});

test('11.3: errors during a full-screen offline page do not turn it into a banner', async () => {
  const clock = createFakeClock();
  const probe = createScriptedProbe();
  const connectivity = createConnectivity({ probe, timers: clock, random: () => 0.5 });
  const monitor = createRequestErrorMonitor({ connectivity, isAllowedOrigin: () => true, getUrl: () => SERVER_URL, now: clock.now });

  connectivity.start(SERVER_URL, { mode: 'page', reason: 'offline' });
  await clock.tick(1000);
  monitor.handle(failure(1));
  monitor.handle(failure(2));
  assert.equal(connectivity.status().nextRetryInMs, 2000, 'the full-screen page keeps its countdown: it was not restarted as a banner');
  assert.equal(clock.pending(), 1);
});
