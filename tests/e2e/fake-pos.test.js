'use strict';

/**
 * The fake POS server of the end-to-end runs (tests/e2e/fake-pos.js). It is test infrastructure with real logic (it can be stopped
 * and started again on the same address, it routes what the page reports, and it keeps the handshake that tests/e2e/run-app.js
 * depends on), so it has its own plain-Node tests. No Electron is needed: they talk to it with `fetch`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakePos, PAGE, POS_PATH } = require('./fake-pos');

/** A GET or POST that never reuses a connection, so a stopped server is seen as stopped. */
function ask(url, options = {}) {
  return fetch(url, { ...options, headers: { connection: 'close', ...(options.headers || {}) } });
}

test('the smoke page is served with ?harness=smoke, the legacy page without it, both from the POS address', async () => {
  const pos = await startFakePos();
  try {
    assert.equal(pos.url, `${pos.origin}${POS_PATH}`);
    assert.equal(pos.smokeUrl, `${pos.url}?harness=smoke`);
    const smoke = await (await ask(pos.smokeUrl)).text();
    assert.match(smoke, /<script src="\/assets\/pos\.js">/, 'the smoke page loads the automation');
    assert.doesNotMatch(smoke, /\/ready/, 'and does not run the legacy handshake');
    const legacy = await (await ask(pos.url)).text();
    assert.equal(legacy, PAGE, 'the legacy page is the self-running page of run-app.js');
  } finally {
    await pos.stop();
  }
});

test('the assets of the smoke page are served with their types, and /favicon.ico answers 204', async () => {
  const pos = await startFakePos();
  try {
    const script = await ask(`${pos.origin}/assets/pos.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /window\.__pos = /);
    const style = await ask(`${pos.origin}/assets/pos.css`);
    assert.match(style.headers.get('content-type'), /text\/css/);
    assert.equal((await ask(`${pos.origin}/favicon.ico`)).status, 204);
  } finally {
    await pos.stop();
  }
});

test('/ping answers pong, and a HEAD request (the app\'s connection probe) answers 200 without a body', async () => {
  const pos = await startFakePos();
  try {
    const ping = await ask(`${pos.origin}/ping?n=1`);
    assert.equal(await ping.text(), 'pong');
    assert.equal(ping.headers.get('cache-control'), 'no-store');
    const head = await ask(pos.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await pos.stop();
  }
});

test('it can be stopped and started again on the SAME address; while stopped nothing answers, and the logs are kept', async () => {
  const pos = await startFakePos();
  const origin = pos.origin;
  const { port } = pos;
  try {
    assert.equal(pos.isListening(), true);
    await ask(`${origin}/ping?first`);
    await pos.stop();
    assert.equal(pos.isListening(), false);
    await assert.rejects(ask(`${origin}/ping?down`), 'a stopped server refuses the connection');
    await pos.stop(); // stopping twice is harmless

    await pos.start();
    assert.equal(pos.isListening(), true);
    assert.equal(pos.port, port, 'it listens on the old port again');
    assert.equal(pos.origin, origin);
    assert.equal(await (await ask(`${origin}/ping?second`)).text(), 'pong');
    await pos.start(); // starting twice is harmless

    assert.deepEqual(pos.requests, ['GET /ping?first', 'GET /ping?second'], 'the requests of both lives are in one log');
    assert.equal(pos.hits('/ping'), 2);
    assert.equal(pos.hits('/assets'), 0);
  } finally {
    await pos.stop();
  }
});

test('a second server on a stopped one\'s port works (the way run-app.js brings it back)', async () => {
  const first = await startFakePos();
  const { port } = first;
  await first.stop();
  const second = await startFakePos({ port });
  try {
    assert.equal(second.port, port);
    assert.equal((await ask(`${second.origin}/ping`)).status, 200);
  } finally {
    await second.stop();
  }
});

test('/report: the smoke page\'s records are kept in order and awaited by name', async () => {
  const pos = await startFakePos();
  try {
    const post = (body) => ask(`${pos.origin}/report`, { method: 'POST', body: JSON.stringify(body) });
    const pending = pos.waitForReport('printReceipt');
    await post({ kind: 'call', name: 'getAppInfo', ok: true, result: { apiVersion: 2 } });
    await post({ kind: 'call', name: 'printReceipt', ok: true, result: { ok: false, code: 'SPOOLER_ERROR' } });
    const found = await pending;
    assert.equal(found.name, 'printReceipt');
    assert.equal(found.result.code, 'SPOOLER_ERROR');
    assert.deepEqual(pos.reports.map((entry) => entry.name), ['getAppInfo', 'printReceipt']);

    assert.equal((await pos.waitForReport('getAppInfo')).result.apiVersion, 2, 'a record that is already there answers at once');
    await assert.rejects(pos.waitForReport('getAppInfo', { since: 1, timeoutMs: 50 }), /no report called getAppInfo/, '`since` skips earlier records');
    await assert.rejects(pos.waitForReport('never', { timeoutMs: 50 }), /within 50 ms/);
  } finally {
    await pos.stop();
  }
});

test('/report: garbage is ignored, and a record without a kind is the legacy page\'s one final report', async () => {
  const pos = await startFakePos();
  try {
    const post = (body) => ask(`${pos.origin}/report`, { method: 'POST', body });
    assert.equal((await post('this is not json')).status, 200, 'a bad body does not break the server');
    assert.equal(pos.reports.length, 0);
    const final = pos.report();
    await post(JSON.stringify({ electron: 'object', desktop: 'undefined' }));
    assert.deepEqual(await final, { electron: 'object', desktop: 'undefined' });
    assert.equal(pos.reports.length, 0, 'it is not a smoke record');
  } finally {
    await pos.stop();
  }
});

test('the legacy handshake of run-app.js: ready, then /go is held until release()', async () => {
  const pos = await startFakePos();
  try {
    await ask(`${pos.origin}/ready`, { method: 'POST', body: JSON.stringify({ electron: 'object' }) });
    assert.deepEqual(await pos.ready(), { electron: 'object' });

    let answered = false;
    const go = ask(`${pos.origin}/go`).then(async (response) => {
      answered = true;
      return response.text();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(answered, false, 'the page waits for the harness');
    pos.release();
    assert.equal(await go, 'go');
    assert.equal(await (await ask(`${pos.origin}/go`)).text(), 'go', 'after release a later /go answers at once');
  } finally {
    await pos.stop();
  }
});
