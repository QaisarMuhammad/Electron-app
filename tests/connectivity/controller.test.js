'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConnectivity, BACKOFF_STEPS_MS, JITTER_RATIO } = require('../../src/main/connectivity');
const { createFakeClock, createFakeNet, createScriptedProbe, settle, HOLD } = require('../helpers/fake-net');

const URL_A = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const URL_B = 'https://pos.shop.example/';
const DOWN = { ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' };
const UP = { ok: true, status: 200 };

/** A controller on a manual clock with a scripted probe; `random` defaults to 0.5, which is exactly no jitter. */
function setup({ results = [], fallback, random = () => 0.5, net, log } = {}) {
  const clock = createFakeClock();
  const probe = createScriptedProbe(results, fallback);
  const events = [];
  const connectivity = createConnectivity({ probe, timers: clock, random, net, log, onStatus: (status) => events.push(status) });
  return { clock, probe, events, connectivity };
}

/** Lets `ms` pass and returns the delays of every retry that was scheduled in that time. */
async function collectDelays({ random, count }) {
  const { clock, connectivity, events } = setup({ random });
  connectivity.start(URL_A);
  for (let i = 0; i < count; i += 1) await clock.tick(clock.nextDelay());
  return events.filter((status) => status.nextRetryInMs !== null).map((status) => status.nextRetryInMs);
}

test('backoff: 3, 6, 12, 24 and 30 s, and the cap holds for the rest of the outage', async () => {
  const delays = await collectDelays({ random: () => 0.5, count: 8 });
  assert.deepEqual(delays.slice(0, 9), [3000, 6000, 12000, 24000, 30000, 30000, 30000, 30000, 30000]);
  assert.deepEqual([...BACKOFF_STEPS_MS], [3000, 6000, 12000, 24000, 30000]);
});

test('backoff: the jitter is +-20 % of each step, taken from the injected random', async () => {
  assert.equal(JITTER_RATIO, 0.2);
  const lowest = await collectDelays({ random: () => 0, count: 5 });
  assert.deepEqual(lowest.slice(0, 5), [2400, 4800, 9600, 19200, 24000]);
  const highest = await collectDelays({ random: () => 1, count: 5 });
  assert.deepEqual(highest.slice(0, 5), [3600, 7200, 14400, 28800, 36000]);
});

test('backoff: every delay stays inside the +-20 % band for a spread of random values', async () => {
  for (const sample of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999999]) {
    const delays = await collectDelays({ random: () => sample, count: 7 });
    delays.forEach((delay, index) => {
      const base = BACKOFF_STEPS_MS[Math.min(index, BACKOFF_STEPS_MS.length - 1)];
      assert.ok(delay >= Math.round(base * 0.8) && delay <= Math.round(base * 1.2), `step ${index} random ${sample}: ${delay}`);
    });
  }
});

test('backoff: a fresh random value is taken for every delay', async () => {
  const sequence = [0, 1, 0.5, 0.25];
  let index = 0;
  const delays = await collectDelays({ random: () => sequence[index++ % sequence.length], count: 4 });
  assert.deepEqual(delays.slice(0, 4), [2400, 7200, 12000, 21600]);
});

test('backoff: a broken random source cannot push a delay outside the band', async () => {
  for (const bad of [() => 5, () => -3, () => NaN, () => undefined]) {
    const delays = await collectDelays({ random: bad, count: 3 });
    delays.forEach((delay, index) => {
      const base = BACKOFF_STEPS_MS[index];
      assert.ok(delay >= base * 0.8 && delay <= base * 1.2, `${delay}`);
    });
  }
});

test('start: reports the outage at once and probes after the first delay, not before', async () => {
  const { clock, probe, events, connectivity } = setup({ results: [UP] });
  const status = connectivity.start(URL_A);

  assert.deepEqual(status, {
    online: false,
    attempt: 0,
    nextRetryInMs: 3000,
    lastError: null,
    url: URL_A,
    reason: null,
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], status);
  assert.deepEqual(Object.keys(status), ['online', 'attempt', 'nextRetryInMs', 'lastError', 'url', 'reason'], 'exactly the six fields of SPEC 6.2');

  await clock.tick(2999);
  assert.equal(probe.calls.length, 0, 'not before the delay');
  await clock.tick(1);
  assert.deepEqual(probe.calls, [URL_A]);
});

test('status(): nextRetryInMs counts down live between emissions', async () => {
  const { clock, connectivity } = setup();
  connectivity.start(URL_A);
  assert.equal(connectivity.status().nextRetryInMs, 3000);
  await clock.tick(1000);
  assert.equal(connectivity.status().nextRetryInMs, 2000);
  await clock.tick(2000);
  // The probe ran and failed: the next delay is the second step.
  assert.equal(connectivity.status().nextRetryInMs, 6000);
});

test('a failed probe: one emission with the error, the reason, the attempt count and the next delay', async () => {
  const { clock, events, connectivity } = setup({ results: [DOWN] });
  connectivity.start(URL_A);
  await clock.tick(3000);

  assert.equal(events.length, 2, 'the start and the end of the probe; nothing while it runs');
  assert.deepEqual(events[1], {
    online: false,
    attempt: 1,
    nextRetryInMs: 6000,
    lastError: { code: -106, description: 'ERR_INTERNET_DISCONNECTED' },
    url: URL_A,
    reason: 'offline',
  });
});

test('while a probe runs nothing is announced, and the status shows no countdown', async () => {
  const { clock, probe, events, connectivity } = setup({ results: [HOLD, DOWN] });
  connectivity.start(URL_A);
  await clock.tick(3000);

  assert.equal(probe.calls.length, 1);
  assert.equal(events.length, 1, 'only the start was announced');
  assert.equal(connectivity.status().nextRetryInMs, null);
  assert.equal(connectivity.status().attempt, 0, 'attempt counts completed probes');

  probe.release(DOWN);
  await settle();
  assert.equal(events.length, 2);
  assert.equal(events[1].attempt, 1);
});

test('a successful probe: emits online, stops by itself and leaves no timer behind', async () => {
  const { clock, probe, events, connectivity } = setup({ results: [DOWN, DOWN, UP] });
  connectivity.start(URL_A);
  await clock.tick(3000 + 6000 + 12000);

  const last = events[events.length - 1];
  assert.equal(last.online, true);
  assert.equal(last.attempt, 3);
  assert.equal(last.nextRetryInMs, null);
  assert.equal(last.lastError, null);
  assert.equal(last.reason, null);
  assert.equal(last.url, URL_A);
  assert.equal(clock.pending(), 0);
  assert.equal(probe.calls.length, 3);

  await clock.tick(10 * 60 * 1000);
  assert.equal(probe.calls.length, 3, 'no more probes after recovery');
  assert.equal(connectivity.status().online, true);
});

test('a server error (HTTP 5xx) keeps the loop going with reason "server"', async () => {
  const down = { ok: false, status: 503, error: { code: 503, description: 'HTTP 503' } };
  const { clock, events, connectivity } = setup({ results: [down, UP] });
  connectivity.start(URL_A);
  await clock.tick(3000);

  const failed = events[events.length - 1];
  assert.equal(failed.reason, 'server');
  assert.deepEqual(failed.lastError, { code: 503, description: 'HTTP 503' });
  assert.equal(failed.nextRetryInMs, 6000);

  await clock.tick(6000);
  assert.equal(events[events.length - 1].online, true);
});

test('a probe that reports only a status of 500 or more is understood too', async () => {
  const { clock, events, connectivity } = setup({ results: [{ ok: false, status: 502 }] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  const failed = events[events.length - 1];
  assert.equal(failed.reason, 'server');
  assert.deepEqual(failed.lastError, { code: 502, description: 'HTTP 502' });
});

test('probe failures are classified: dns, refused, timeout, tls, other', async () => {
  const cases = [
    ['net::ERR_NAME_NOT_RESOLVED', 'dns', -105],
    ['net::ERR_CONNECTION_REFUSED', 'refused', -102],
    ['net::ERR_CONNECTION_RESET', 'refused', -101],
    ['net::ERR_TIMED_OUT', 'timeout', -7],
    ['net::ERR_CONNECTION_TIMED_OUT', 'timeout', -118],
    ['net::ERR_CERT_DATE_INVALID', 'tls', -201],
    ['net::ERR_SSL_PROTOCOL_ERROR', 'tls', -107],
    ['net::ERR_NETWORK_CHANGED', 'offline', -21],
    ['net::ERR_SOMETHING_NEW', 'other', null],
  ];
  for (const [error, reason, code] of cases) {
    const { clock, events, connectivity } = setup({ results: [{ ok: false, error }] });
    connectivity.start(URL_A);
    await clock.tick(3000);
    const failed = events[events.length - 1];
    assert.equal(failed.reason, reason, error);
    assert.equal(failed.lastError.code, code, error);
    assert.equal(failed.lastError.description, error.replace('net::', ''), error);
  }
});

test('a probe that throws or answers nothing is a failure, not a crash', async () => {
  const { clock, events, connectivity } = setup({ results: [new Error('boom'), { ok: false }, undefined] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(events[events.length - 1].lastError.description, 'boom');
  assert.equal(events[events.length - 1].reason, 'other');
  await clock.tick(6000);
  assert.deepEqual(events[events.length - 1].lastError, { code: null, description: 'No answer from the server' });
  await clock.tick(12000);
  assert.equal(events[events.length - 1].online, false);
  assert.equal(events[events.length - 1].attempt, 3);
});

test('a probe that throws SYNCHRONOUSLY (a plain function, not async) is a failure and the loop carries on', async () => {
  const clock = createFakeClock();
  const answers = [() => { throw new Error('sync boom'); }, () => ({ ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' }), () => UP];
  const calls = [];
  const probe = (url) => {
    calls.push(url);
    return answers.shift()();
  };
  const events = [];
  const connectivity = createConnectivity({ probe, timers: clock, random: () => 0.5, onStatus: (status) => events.push(status) });

  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(events[events.length - 1].lastError.description, 'sync boom');
  assert.equal(events[events.length - 1].nextRetryInMs, 6000, 'the next probe is scheduled, nothing is stuck "in flight"');

  await clock.tick(6000);
  assert.equal(events[events.length - 1].reason, 'dns');
  await clock.tick(12000);
  assert.equal(events[events.length - 1].online, true);
  assert.equal(calls.length, 3);
});

test('a probe that returns a plain value instead of a promise works too', async () => {
  const clock = createFakeClock();
  const connectivity = createConnectivity({ probe: () => UP, timers: clock, random: () => 0.5 });
  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(connectivity.status().online, true);
});

test('a status listener that calls retryNow() from inside its callback starts exactly one new probe and replaces the timer', async () => {
  const clock = createFakeClock();
  const probe = createScriptedProbe([DOWN, UP]);
  let reentrant = null;
  const connectivity = createConnectivity({
    probe,
    timers: clock,
    random: () => 0.5,
    onStatus: (status) => {
      if (status.attempt === 1 && status.online === false && reentrant === null) reentrant = connectivity.retryNow();
    },
  });
  connectivity.start(URL_A);
  await clock.tick(3000);

  assert.ok(reentrant, 'the listener did call retryNow()');
  const status = await reentrant;
  assert.equal(probe.calls.length, 2, 'one more probe, not two');
  assert.equal(status.online, true);
  assert.equal(status.attempt, 2);
  assert.equal(clock.pending(), 0, 'the timer the failure had armed was replaced by the immediate retry');
});

test('the url is read when the attempt starts: a stop() right after retryNow() cannot turn it into a probe of null', async () => {
  const clock = createFakeClock();
  const probe = createScriptedProbe([UP]);
  const connectivity = createConnectivity({ probe, timers: clock, random: () => 0.5 });
  connectivity.start(URL_A);
  const pending = connectivity.retryNow();
  connectivity.stop();
  await pending;
  assert.deepEqual(probe.calls, [URL_A]);
  assert.equal(connectivity.status().online, true);
  assert.equal(connectivity.status().url, null, 'the late answer did not resurrect the outage');
});

test('the OS saying "offline" turns a dns, timeout or other failure into "offline", but not a tls or server one', async () => {
  const cases = [
    ['net::ERR_NAME_NOT_RESOLVED', false, 'offline'],
    ['net::ERR_TIMED_OUT', false, 'offline'],
    ['net::ERR_SOMETHING_NEW', false, 'offline'],
    ['net::ERR_NAME_NOT_RESOLVED', true, 'dns'],
    ['net::ERR_CERT_DATE_INVALID', false, 'tls'],
    ['net::ERR_CONNECTION_REFUSED', false, 'refused'],
  ];
  for (const [error, osOnline, reason] of cases) {
    const net = createFakeNet({ online: osOnline });
    const { clock, events, connectivity } = setup({ results: [{ ok: false, error }], net });
    connectivity.start(URL_A);
    await clock.tick(3000);
    assert.equal(events[events.length - 1].reason, reason, `${error} online=${osOnline}`);
  }
});

test('the OS coming back online mid-outage is noticed by the next failure: "offline" becomes "dns"', async () => {
  const net = createFakeNet({ online: false });
  const dns = { ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' };
  const { clock, events, connectivity } = setup({ results: [dns, dns], net });
  connectivity.start(URL_A);

  await clock.tick(3000);
  assert.equal(events[events.length - 1].reason, 'offline', 'the cable is unplugged: the dns failure is a symptom');
  net.setOnline(true);
  await clock.tick(6000);
  assert.equal(events[events.length - 1].reason, 'dns', 'the network is back and the name still does not resolve');
});

test('start(): what the failed load already told us is in the first status', () => {
  const { connectivity, events } = setup();
  connectivity.start(URL_A, { reason: 'dns', lastError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } });
  assert.equal(events[0].reason, 'dns');
  assert.deepEqual(events[0].lastError, { code: -105, description: 'ERR_NAME_NOT_RESOLVED' });

  const other = setup();
  other.connectivity.start(URL_A, { lastError: { code: -201, description: 'ERR_CERT_DATE_INVALID' } });
  assert.equal(other.events[0].reason, 'tls', 'derived from the error when no reason is given');

  const unknownReason = setup();
  unknownReason.connectivity.start(URL_A, { reason: 'because' });
  assert.equal(unknownReason.events[0].reason, null, 'an unknown reason is ignored');
});

test('start(): is idempotent for the same url and mode and never doubles the timers', async () => {
  const { clock, probe, events, connectivity } = setup();
  connectivity.start(URL_A);
  connectivity.start(URL_A);
  connectivity.start(URL_A, { reason: 'refused', lastError: { code: -102, description: 'ERR_CONNECTION_REFUSED' } });

  assert.equal(clock.pending(), 1);
  assert.equal(connectivity.status().reason, 'refused', 'the newer failure details are merged');
  assert.equal(connectivity.status().attempt, 0);
  assert.equal(events.length, 3, 'each call reports its status');

  await clock.tick(3000);
  assert.equal(probe.calls.length, 1, 'one loop, one probe');
});

test('start(): a different url restarts cleanly with the schedule back at the first step', async () => {
  const { clock, probe, connectivity } = setup();
  connectivity.start(URL_A);
  await clock.tick(3000);
  await clock.tick(6000);
  assert.equal(connectivity.status().attempt, 2);

  const status = connectivity.start(URL_B);
  assert.equal(status.url, URL_B);
  assert.equal(status.attempt, 0);
  assert.equal(status.nextRetryInMs, 3000);
  assert.equal(clock.pending(), 1);
  await clock.tick(3000);
  assert.equal(probe.calls[probe.calls.length - 1], URL_B);
});

test('modes: a banner request never downgrades a running full-screen page', async () => {
  for (const pageDetails of [{}, { mode: 'page' }, { mode: 'popup' }, { mode: undefined }]) {
    const { clock, events, connectivity } = setup();
    connectivity.start(URL_A, pageDetails);
    await clock.tick(1000);

    const status = connectivity.start(URL_A, { mode: 'banner' });
    assert.equal(status.nextRetryInMs, 2000, `${JSON.stringify(pageDetails)}: the page's countdown was not touched`);
    assert.equal(events.length, 1, 'the ignored request is silent');
    assert.equal(clock.pending(), 1);
  }
});

test('modes: a banner request is also ignored for another url while a page is running', async () => {
  const { clock, connectivity } = setup();
  connectivity.start(URL_A, { mode: 'page' });
  await clock.tick(1000);
  assert.equal(connectivity.start(URL_B, { mode: 'banner' }).url, URL_A);
  assert.equal(connectivity.status().nextRetryInMs, 2000);
});

test('modes: a page request takes over a running banner and restarts the schedule', async () => {
  const { clock, events, connectivity } = setup();
  connectivity.start(URL_A, { mode: 'banner' });
  await clock.tick(1000);
  assert.equal(connectivity.status().nextRetryInMs, 2000);

  const status = connectivity.start(URL_A, { mode: 'page' });
  assert.equal(status.nextRetryInMs, 3000, 'a fresh start');
  assert.equal(events.length, 2);
  assert.equal(clock.pending(), 1);
});

test('modes: a second banner request for the same url only merges, it does not restart', async () => {
  const { clock, events, connectivity } = setup();
  connectivity.start(URL_A, { mode: 'banner' });
  await clock.tick(1000);
  const status = connectivity.start(URL_A, { mode: 'banner', lastError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } });
  assert.equal(status.nextRetryInMs, 2000);
  assert.equal(status.reason, 'dns');
  assert.equal(events.length, 2);
  assert.equal(clock.pending(), 1);
});

test('modes: the mode is not part of the status', () => {
  const { connectivity } = setup();
  assert.equal('mode' in connectivity.start(URL_A, { mode: 'banner' }), false);
  assert.equal('checking' in connectivity.status(), false);
});

test('start(): a missing or empty url starts nothing', () => {
  const warnings = [];
  const { clock, connectivity, events } = setup({ log: { warn: (message) => warnings.push(message) } });
  for (const bad of [undefined, null, '', 42, {}]) {
    const status = connectivity.start(bad);
    assert.equal(status.online, true);
    assert.equal(status.url, null);
  }
  assert.equal(clock.pending(), 0);
  assert.equal(events.length, 0);
  assert.equal(warnings.length, 5);
});

test('retryNow: probes at once, cancels the pending timer and keeps the backoff going', async () => {
  const { clock, probe, connectivity } = setup({ results: [DOWN, DOWN] });
  connectivity.start(URL_A);
  await clock.tick(1000);
  assert.equal(probe.calls.length, 0);

  const status = await connectivity.retryNow();
  assert.equal(probe.calls.length, 1);
  assert.equal(status.attempt, 1);
  assert.equal(status.nextRetryInMs, 6000, 'the next delay is the second step, as after any failed probe');
  assert.equal(clock.pending(), 1, 'the old timer was replaced, not kept');

  await clock.tick(5999);
  assert.equal(probe.calls.length, 1);
  await clock.tick(1);
  assert.equal(probe.calls.length, 2);
});

test('retryNow: success ends the outage at once', async () => {
  const { clock, events, connectivity } = setup({ results: [UP] });
  connectivity.start(URL_A);
  const status = await connectivity.retryNow();
  assert.equal(status.online, true);
  assert.equal(events[events.length - 1].online, true);
  assert.equal(clock.pending(), 0);
});

test('retryNow: joins a probe that is already in flight instead of starting a second', async () => {
  const { clock, probe, connectivity } = setup({ results: [HOLD, UP] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(probe.calls.length, 1, 'the scheduled probe is running');

  const first = connectivity.retryNow();
  const second = connectivity.retryNow();
  assert.equal(probe.calls.length, 1);

  probe.release(DOWN);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.attempt, 1);
  assert.deepEqual(a, b);
  assert.equal(probe.calls.length, 1);
});

test('retryNow: does nothing when no outage is being tracked', async () => {
  const { clock, probe, events, connectivity } = setup();
  const status = await connectivity.retryNow();
  assert.equal(status.online, true);
  assert.equal(probe.calls.length, 0);
  assert.equal(events.length, 0);
  assert.equal(clock.pending(), 0);
});

test('stop(): cancels everything, is idempotent, and forgets the outage', async () => {
  const { clock, probe, events, connectivity } = setup();
  connectivity.stop();
  connectivity.stop();
  connectivity.start(URL_A);
  await clock.tick(3000);
  connectivity.stop();
  connectivity.stop();

  assert.equal(clock.pending(), 0);
  const emitted = events.length;
  await clock.tick(5 * 60 * 1000);
  assert.equal(probe.calls.length, 1, 'no probe after stop()');
  assert.equal(events.length, emitted, 'stop() is silent');
  assert.deepEqual(connectivity.status(), {
    online: true,
    attempt: 0,
    nextRetryInMs: null,
    lastError: null,
    url: null,
    reason: null,
  });
});

test('stop() while a probe is in flight: the late answer is ignored', async () => {
  const { clock, probe, events, connectivity } = setup({ results: [HOLD] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  const emitted = events.length;

  connectivity.stop();
  probe.release(UP);
  await settle();

  assert.equal(events.length, emitted, 'no online event after stop()');
  assert.equal(connectivity.status().online, true);
  assert.equal(connectivity.status().attempt, 0);
  assert.equal(clock.pending(), 0);
});

test('start() while a probe of the old url is in flight: the late answer does not touch the new outage', async () => {
  const { clock, probe, connectivity } = setup({ results: [HOLD] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  connectivity.start(URL_B);

  probe.release(UP);
  await settle();

  const status = connectivity.status();
  assert.equal(status.online, false);
  assert.equal(status.url, URL_B);
  assert.equal(status.attempt, 0);
  assert.equal(clock.pending(), 1);
});

test('after recovery a new start() begins a fresh outage', async () => {
  const { clock, probe, events, connectivity } = setup({ results: [UP, DOWN] });
  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(connectivity.status().online, true);

  const status = connectivity.start(URL_A);
  assert.equal(status.online, false);
  assert.equal(status.attempt, 0);
  assert.equal(status.nextRetryInMs, 3000);
  await clock.tick(3000);
  assert.equal(probe.calls.length, 2);
  assert.equal(events[events.length - 1].attempt, 1);
});

test('notifyNetworkChange(true) probes at once while an outage is tracked', async () => {
  const { clock, probe, connectivity } = setup({ results: [UP] });
  connectivity.start(URL_A);
  await clock.tick(500);
  connectivity.notifyNetworkChange(true);
  await settle();
  assert.equal(probe.calls.length, 1);
  assert.equal(connectivity.status().online, true);
  assert.equal(clock.pending(), 0);
});

test('notifyNetworkChange: "offline" reports, an idle controller and a running probe need no action', async () => {
  const idle = setup();
  idle.connectivity.notifyNetworkChange(true);
  idle.connectivity.notifyNetworkChange(false);
  await settle();
  assert.equal(idle.probe.calls.length, 0);
  assert.equal(idle.clock.pending(), 0, 'R3: it never starts the controller or a timer');

  const running = setup();
  running.connectivity.start(URL_A);
  running.connectivity.notifyNetworkChange(false);
  await settle();
  assert.equal(running.probe.calls.length, 0);

  const busy = setup({ results: [HOLD] });
  busy.connectivity.start(URL_A);
  await busy.clock.tick(3000);
  busy.connectivity.notifyNetworkChange(true);
  assert.equal(busy.probe.calls.length, 1, 'a probe is already in flight');
});

test('notifyNetworkChange(true) also restarts the delays: after a long outage a probe that still fails is retried in about 3 s, not 30 s', async () => {
  // A link that has just come up needs a few seconds before the first request gets through (DHCP, DNS): the 24 to 36 s step of an
  // old outage would keep the till on the offline page long after the network was back.
  const { clock, probe, events, connectivity } = setup({ results: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, UP] });
  connectivity.start(URL_A);
  for (let i = 0; i < 6; i += 1) await clock.tick(clock.nextDelay());
  assert.equal(probe.calls.length, 6);
  assert.equal(connectivity.status().nextRetryInMs, 30000, 'the outage is at the long step');

  connectivity.notifyNetworkChange(true);
  await settle();
  assert.equal(probe.calls.length, 7, 'probed at once');
  assert.equal(connectivity.status().online, false, 'and it failed');
  assert.equal(connectivity.status().nextRetryInMs, 3000, 'the next retry starts from the shortest delay again');
  assert.equal(events[events.length - 1].nextRetryInMs, 3000, 'and the offline page is told');
  await clock.tick(3000);
  assert.equal(probe.calls.length, 8);
  assert.equal(connectivity.status().online, true);
});

test('notifyNetworkChange(true) while a probe is in flight leaves that probe alone, but the retry that follows it starts from the shortest delay', async () => {
  const { clock, probe, connectivity } = setup({ results: [DOWN, DOWN, DOWN, DOWN, DOWN, HOLD, UP] });
  connectivity.start(URL_A);
  for (let i = 0; i < 6; i += 1) await clock.tick(clock.nextDelay());
  assert.equal(probe.calls.length, 6, 'the sixth probe is held back');

  connectivity.notifyNetworkChange(true);
  await settle();
  assert.equal(probe.calls.length, 6, 'no second probe next to the one in flight');
  probe.release(DOWN);
  await settle();
  assert.equal(connectivity.status().nextRetryInMs, 3000);
});

test('notifyNetworkChange(false) and a report to an idle controller change no delay and start nothing', async () => {
  const { clock, probe, connectivity } = setup({ results: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN] });
  connectivity.start(URL_A);
  for (let i = 0; i < 5; i += 1) await clock.tick(clock.nextDelay());
  const before = connectivity.status().nextRetryInMs;
  connectivity.notifyNetworkChange(false);
  connectivity.notifyNetworkChange(undefined);
  connectivity.notifyNetworkChange('yes');
  await settle();
  assert.equal(probe.calls.length, 5);
  assert.equal(connectivity.status().nextRetryInMs, before, 'the delays are untouched');

  connectivity.stop();
  connectivity.notifyNetworkChange(true);
  await settle();
  assert.equal(probe.calls.length, 5, 'a stopped controller is not started by a report');
  assert.equal(clock.pending(), 0);
});

test('R3: no timer exists unless an outage is being tracked, and every timer is unref()ed', async () => {
  const { clock, connectivity } = setup({ results: [DOWN, UP] });
  assert.equal(clock.pending(), 0, 'before start');
  connectivity.start(URL_A);
  assert.equal(clock.pending(), 1, 'while waiting');
  await clock.tick(3000);
  assert.equal(clock.pending(), 1, 'one retry timer, never two');
  await clock.tick(6000);
  assert.equal(clock.pending(), 0, 'after recovery');
  assert.ok(clock.created.length >= 2);
  assert.ok(clock.created.every((handle) => handle.unrefCalled), 'a pending retry must not keep the process alive');
});

test('a status listener that throws neither breaks the controller nor is called again out of order', async () => {
  const clock = createFakeClock();
  const probe = createScriptedProbe([DOWN, UP]);
  const errors = [];
  const connectivity = createConnectivity({
    probe,
    timers: clock,
    random: () => 0.5,
    log: { error: (...args) => errors.push(args.join(' ')) },
    onStatus: () => {
      throw new Error('listener bug');
    },
  });
  connectivity.start(URL_A);
  await clock.tick(3000 + 6000);
  assert.equal(connectivity.status().online, true);
  assert.ok(errors.length >= 3 && errors.every((line) => line.includes('listener bug')), 'the start, the failure and the recovery were each announced');
});

test('logging never reveals the path or query of the server url', async () => {
  const lines = [];
  const log = { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const { clock, connectivity } = setup({ results: [DOWN, UP], log });
  connectivity.start('https://vendor.societyfiles.com/vendor/point-of-sale?token=SECRET123');
  await clock.tick(3000 + 6000);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((line) => !line.includes('SECRET123') && !line.includes('point-of-sale')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('vendor.societyfiles.com')));
});

test('nextRetryInMs in an announcement is exactly the delay, even on a clock the test does not control', () => {
  // No `now` in the timers and the real Date.now: a millisecond may pass between scheduling and announcing.
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {} };
  for (let i = 0; i < 300; i += 1) {
    const emitted = [];
    const connectivity = createConnectivity({ probe: async () => UP, timers, random: () => 0.5, onStatus: (status) => emitted.push(status) });
    const returned = connectivity.start(URL_A);
    assert.equal(emitted[0].nextRetryInMs, 3000);
    assert.equal(returned.nextRetryInMs, 3000);
    connectivity.stop();
  }
});

test('createConnectivity needs a probe or a net, and works with a logger-less, timer-less setup', () => {
  assert.throws(() => createConnectivity({}), /needs Electron's net/);
  const connectivity = createConnectivity({ probe: async () => UP, random: () => 0.5 });
  assert.equal(connectivity.status().online, true);
  connectivity.start(URL_A);
  // The real clock is in use here, so a millisecond may already have passed.
  const left = connectivity.status().nextRetryInMs;
  assert.ok(left > 2900 && left <= 3000, String(left));
  connectivity.stop();
});

test('the clock can come from timers.now', () => {
  const clock = createFakeClock();
  const connectivity = createConnectivity({ probe: async () => UP, timers: clock, random: () => 0.5 });
  connectivity.start(URL_A);
  assert.equal(connectivity.status().nextRetryInMs, 3000);
  connectivity.stop();
});
