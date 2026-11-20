'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNetProbe, createConnectivity } = require('../../src/main/connectivity');
const { createFakeClock, createFakeNet } = require('../helpers/fake-net');

const URL_A = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';

test('probe: a HEAD request to the url, no cookies, redirects not followed', async () => {
  const net = createFakeNet();
  const probe = createNetProbe({ net, timers: createFakeClock() });
  await probe(URL_A);

  assert.equal(net.requests.length, 1);
  const [request] = net.requests;
  assert.deepEqual(request.options, { method: 'HEAD', url: URL_A, redirect: 'manual', credentials: 'omit' });
  assert.equal(request.ended, true);
});

test('probe: any answer below 500 means the server is up', async () => {
  for (const status of [200, 204, 301, 401, 403, 404, 429, 499]) {
    const net = createFakeNet().queue({ status });
    const result = await createNetProbe({ net, timers: createFakeClock() })(URL_A);
    assert.deepEqual(result, { ok: true, status }, String(status));
  }
});

test('probe: a redirect proves the server is up and is not followed', async () => {
  const net = createFakeNet().queue({ redirect: 302 });
  const result = await createNetProbe({ net, timers: createFakeClock() })(URL_A);
  assert.deepEqual(result, { ok: true, status: 302 });
  assert.equal(net.requests[0].aborted, true, 'the manual redirect is cancelled, not followed');
});

test('probe: 500 and above is a failure that carries the status', async () => {
  for (const status of [500, 502, 503, 504]) {
    const net = createFakeNet().queue({ status });
    const result = await createNetProbe({ net, timers: createFakeClock() })(URL_A);
    assert.deepEqual(result, { ok: false, status, error: { code: status, description: `HTTP ${status}` } }, String(status));
  }
});

test('probe: a network error becomes { code, description }', async () => {
  const cases = [
    ['net::ERR_NAME_NOT_RESOLVED', { code: -105, description: 'ERR_NAME_NOT_RESOLVED' }],
    ['net::ERR_CONNECTION_REFUSED', { code: -102, description: 'ERR_CONNECTION_REFUSED' }],
    ['net::ERR_INTERNET_DISCONNECTED', { code: -106, description: 'ERR_INTERNET_DISCONNECTED' }],
    ['net::ERR_CERT_AUTHORITY_INVALID', { code: -202, description: 'ERR_CERT_AUTHORITY_INVALID' }],
    [new Error('net::ERR_NETWORK_CHANGED'), { code: -21, description: 'ERR_NETWORK_CHANGED' }],
    ['socket exploded', { code: null, description: 'socket exploded' }],
  ];
  for (const [error, expected] of cases) {
    const net = createFakeNet().queue({ error });
    const result = await createNetProbe({ net, timers: createFakeClock() })(URL_A);
    assert.deepEqual(result, { ok: false, error: expected }, String(error));
  }
});

test('probe: no answer within the timeout is ERR_TIMED_OUT, and the request is cancelled', async () => {
  const clock = createFakeClock();
  const net = createFakeNet().queue({ hang: true });
  const pending = createNetProbe({ net, timers: clock, timeoutMs: 5000 })(URL_A);

  await clock.tick(4999);
  assert.equal(net.requests[0].aborted, false);
  await clock.tick(1);
  assert.deepEqual(await pending, { ok: false, error: { code: -7, description: 'ERR_TIMED_OUT' } });
  assert.equal(net.requests[0].aborted, true);
  assert.equal(clock.pending(), 0);
});

test('probe: the default timeout is 8 s', async () => {
  const clock = createFakeClock();
  const net = createFakeNet().queue({ hang: true });
  const pending = createNetProbe({ net, timers: clock })(URL_A);
  await clock.tick(7999);
  assert.equal(net.requests[0].aborted, false);
  await clock.tick(1);
  assert.equal((await pending).error.description, 'ERR_TIMED_OUT');
});

test('probe: an answer cancels the timeout timer, and a late event is ignored', async () => {
  const clock = createFakeClock();
  const net = createFakeNet().queue({ status: 200 });
  const result = await createNetProbe({ net, timers: clock })(URL_A);
  assert.equal(result.ok, true);
  assert.equal(clock.pending(), 0);
  net.requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET'));
  net.requests[0].emit('response', { statusCode: 500 });
  assert.equal(net.requests.length, 1);
});

test('probe: net.request() throwing is a failure, not an exception', async () => {
  const net = createFakeNet().queue({ throws: new Error('net::ERR_INVALID_URL') });
  const result = await createNetProbe({ net, timers: createFakeClock() })('not a url');
  assert.deepEqual(result, { ok: false, error: { code: null, description: 'ERR_INVALID_URL' } });
});

test('probe: a response without a status is a failure', async () => {
  const net = createFakeNet();
  net.request = () => {
    const request = createFakeNet().queue({ status: 200 }).request({});
    request.play = function play() {
      this.emit('response', {});
    };
    return request;
  };
  const result = await createNetProbe({ net, timers: createFakeClock() })(URL_A);
  assert.deepEqual(result, { ok: false, error: { code: null, description: 'No answer from the server' } });
});

test('probe: the timeout timer is unref()ed so it never keeps the app alive', async () => {
  const clock = createFakeClock();
  const net = createFakeNet().queue({ status: 200 });
  await createNetProbe({ net, timers: clock })(URL_A);
  assert.ok(clock.created.length === 1 && clock.created[0].unrefCalled);
});

test('createNetProbe refuses a missing net', () => {
  assert.throws(() => createNetProbe({}), /needs Electron's net/);
  assert.throws(() => createNetProbe({ net: {} }), /needs Electron's net/);
  assert.throws(() => createNetProbe(), /needs Electron's net/);
});

test('the controller uses the net probe when no probe is injected: one HEAD per attempt, recovery on a good answer', async () => {
  const clock = createFakeClock();
  const net = createFakeNet({ online: true }).queue({ error: 'net::ERR_NAME_NOT_RESOLVED' }, { status: 503 }, { status: 200 });
  const events = [];
  const connectivity = createConnectivity({ net, timers: clock, random: () => 0.5, onStatus: (status) => events.push(status) });

  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(events[events.length - 1].reason, 'dns');
  await clock.tick(6000);
  assert.equal(events[events.length - 1].reason, 'server');
  await clock.tick(12000);

  assert.equal(events[events.length - 1].online, true);
  assert.equal(net.requests.length, 3);
  assert.ok(net.requests.every((request) => request.options.method === 'HEAD' && request.options.url === URL_A));
  assert.equal(clock.pending(), 0);
});

test('the net probe and the controller share one timer set: a hung request times out and the loop continues', async () => {
  const clock = createFakeClock();
  const net = createFakeNet().queue({ hang: true }, { status: 200 });
  const events = [];
  const connectivity = createConnectivity({ net, timers: clock, random: () => 0.5, probeTimeoutMs: 2000, onStatus: (status) => events.push(status) });

  connectivity.start(URL_A);
  await clock.tick(3000);
  assert.equal(connectivity.status().nextRetryInMs, null, 'the probe is running');
  await clock.tick(2000);
  const failed = events[events.length - 1];
  assert.equal(failed.reason, 'timeout');
  assert.equal(failed.nextRetryInMs, 6000);
  await clock.tick(6000);
  assert.equal(connectivity.status().online, true);
});
