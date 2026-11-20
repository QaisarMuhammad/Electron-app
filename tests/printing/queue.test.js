'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobQueue } = require('../../src/main/printing/queue');
const { PrintError, ERROR_CODES } = require('../../src/main/errors');
const { deferred, sleep, settle } = require('../helpers/fake-io');

/**
 * Builds a queue while spying on the Map and Set it creates, so the tests can look inside for leaked entries.
 * @returns {{queue: object, maps: Map[], sets: Set[]}}
 */
function createQueueWithSpies(options) {
  const RealMap = Map;
  const RealSet = Set;
  const maps = [];
  const sets = [];
  globalThis.Map = class SpyMap extends RealMap { constructor(...args) { super(...args); maps.push(this); } };
  globalThis.Set = class SpySet extends RealSet { constructor(...args) { super(...args); sets.push(this); } };
  try {
    return { queue: createJobQueue(options), maps, sets };
  } finally {
    globalThis.Map = RealMap;
    globalThis.Set = RealSet;
  }
}

test('jobs with the same key run one at a time, in enqueue order', async () => {
  const queue = createJobQueue();
  const gates = [deferred(), deferred(), deferred()];
  const events = [];
  const jobs = gates.map((gate, index) => queue.enqueue('k', async () => {
    events.push(`start ${index}`);
    await gate.promise;
    events.push(`end ${index}`);
    return index;
  }));

  await settle();
  assert.deepEqual(events, ['start 0']);
  assert.equal(queue.size('k'), 3);

  gates[0].resolve();
  await settle();
  assert.deepEqual(events, ['start 0', 'end 0', 'start 1']);

  gates[1].resolve();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.deepEqual(events, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
});

test('a stuck key never blocks another key', async () => {
  const queue = createJobQueue();
  const stuck = deferred();
  const first = queue.enqueue('printer-a', () => stuck.promise);
  const behind = queue.enqueue('printer-a', () => 'a2');
  const other = await queue.enqueue('printer-b', async () => 'b1');
  assert.equal(other, 'b1');
  assert.equal(queue.size('printer-a'), 2);
  assert.equal(queue.size('printer-b'), 0);

  stuck.resolve('a1');
  assert.equal(await first, 'a1');
  assert.equal(await behind, 'a2');
});

test('a timed-out job rejects with PRINT_TIMEOUT, aborts its signal and lets the queue move on', async () => {
  const queue = createJobQueue();
  const never = deferred();
  let signal;
  const stuckJob = queue.enqueue('k', ({ signal: jobSignal }) => {
    signal = jobSignal;
    return never.promise;
  }, { label: 'stuck receipt', timeoutMs: 40 });
  const next = queue.enqueue('k', async () => 'next');

  await assert.rejects(stuckJob, (err) => {
    assert.ok(err instanceof PrintError);
    assert.equal(err.code, ERROR_CODES.PRINT_TIMEOUT);
    assert.equal(err.details.label, 'stuck receipt');
    assert.equal(err.details.timeoutMs, 40);
    return true;
  });
  assert.equal(signal.aborted, true);
  assert.equal(await next, 'next');
  assert.equal(queue.size('k'), 0);
});

test('the late completion of a timed-out job is ignored and never settles twice', async () => {
  const log = { warnings: [], warn(message, data) { this.warnings.push([message, data]); } };
  const queue = createJobQueue({ log });
  const late = deferred();
  let settleCount = 0;
  const job = queue.enqueue('k', () => late.promise, { timeoutMs: 20 });
  job.then(() => { settleCount += 1; }, () => { settleCount += 1; });

  await assert.rejects(job, { code: ERROR_CODES.PRINT_TIMEOUT });
  late.resolve('too late');
  await settle();
  assert.equal(settleCount, 1);
  assert.ok(log.warnings.some(([message]) => message === 'late job completion ignored'));
});

test('a late failure of a timed-out job is ignored as well', async () => {
  const queue = createJobQueue();
  const late = deferred();
  const job = queue.enqueue('k', () => late.promise, { timeoutMs: 20 });
  await assert.rejects(job, { code: ERROR_CODES.PRINT_TIMEOUT });
  late.reject(new Error('boom after the timeout'));
  await settle();
  assert.equal(await queue.enqueue('k', () => 'still works'), 'still works');
});

test('the timeout starts when a job starts, not while it waits behind another job', async () => {
  const queue = createJobQueue();
  const slow = queue.enqueue('k', () => sleep(80));
  const waiting = queue.enqueue('k', async () => 'ran', { timeoutMs: 40 });
  await slow;
  assert.equal(await waiting, 'ran');
});

test('the default timeout applies when a job sets none', async () => {
  const queue = createJobQueue({ defaultTimeoutMs: 25 });
  await assert.rejects(queue.enqueue('k', () => new Promise(() => {})), { code: ERROR_CODES.PRINT_TIMEOUT });
});

test('a rejection reaches only its own caller and the chain keeps running', async () => {
  const queue = createJobQueue();
  const failing = queue.enqueue('k', async () => { throw new PrintError(ERROR_CODES.SPOOLER_ERROR); });
  const after = queue.enqueue('k', async () => 'second');
  const third = queue.enqueue('k', () => { throw new Error('sync throw'); });
  const fourth = queue.enqueue('k', () => 'fourth');

  await assert.rejects(failing, { code: ERROR_CODES.SPOOLER_ERROR });
  assert.equal(await after, 'second');
  await assert.rejects(third, /sync throw/);
  assert.equal(await fourth, 'fourth');
});

test('a caller that ignores the returned promise does not cause an unhandled rejection', async () => {
  const queue = createJobQueue();
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    queue.enqueue('k', async () => { throw new Error('nobody listens'); });
    await settle(10);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0);
});

test('size() counts queued and running jobs and drops to zero', async () => {
  const queue = createJobQueue();
  const gate = deferred();
  assert.equal(queue.size('k'), 0);
  const a = queue.enqueue('k', () => gate.promise);
  const b = queue.enqueue('k', () => 1);
  assert.equal(queue.size('k'), 2);
  assert.equal(queue.size('other'), 0);
  assert.equal(queue.size(undefined), 0);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(queue.size('k'), 0);
});

test('finished keys leave no entries behind (lanes, waiters, timers)', async () => {
  const { queue, maps, sets } = createQueueWithSpies();
  const lanes = maps[0];
  const waiters = sets[0];
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

  await Promise.all(Array.from({ length: 50 }, (_, i) => queue.enqueue(`key-${i % 10}`, async () => i)));
  await queue.enqueue('failing', async () => { throw new Error('x'); }).catch(() => {});
  await queue.enqueue('timed-out', () => new Promise(() => {}), { timeoutMs: 15 }).catch(() => {});
  assert.equal(await queue.drain(0), true);
  await settle();

  assert.equal(lanes.size, 0, 'every lane is removed once its last job is done');
  assert.equal(waiters.size, 0, 'no drain waiter is left');
  const timersAfter = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(timersAfter <= timersBefore, `job timers were cleared (before ${timersBefore}, after ${timersAfter})`);
});

test('200 concurrent jobs on one key run in exact order and never overlap', async () => {
  const queue = createJobQueue();
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const jobs = Array.from({ length: 200 }, (_, index) => queue.enqueue('same-printer', async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    if (index % 7 === 0) await sleep(1);
    else await settle(1);
    order.push(index);
    running -= 1;
    return index;
  }));

  const results = await Promise.all(jobs);
  assert.deepEqual(order, Array.from({ length: 200 }, (_, i) => i));
  assert.deepEqual(results, order);
  assert.equal(maxRunning, 1);
  assert.equal(queue.size('same-printer'), 0);
});

test('jobs on many keys interleave but keep their own order', async () => {
  const queue = createJobQueue();
  const seen = { a: [], b: [], c: [] };
  const jobs = [];
  for (let i = 0; i < 30; i += 1) {
    for (const key of ['a', 'b', 'c']) {
      jobs.push(queue.enqueue(key, async () => { await settle(1); seen[key].push(i); }));
    }
  }
  await Promise.all(jobs);
  const expected = Array.from({ length: 30 }, (_, i) => i);
  assert.deepEqual(seen, { a: expected, b: expected, c: expected });
});

test('invalid calls reject with a PrintError instead of throwing', async () => {
  const queue = createJobQueue();
  await assert.rejects(queue.enqueue('', () => 1), { code: ERROR_CODES.UNKNOWN });
  await assert.rejects(queue.enqueue(undefined, () => 1), { code: ERROR_CODES.UNKNOWN });
  await assert.rejects(queue.enqueue('k', 'not a function'), { code: ERROR_CODES.UNKNOWN });
  assert.equal(queue.size('k'), 0);
});

test('a job may return a plain value, and bad timeout values fall back to the default', async () => {
  const queue = createJobQueue({ defaultTimeoutMs: 1000 });
  assert.equal(await queue.enqueue('k', () => 42, { timeoutMs: -5 }), 42);
  assert.equal(await queue.enqueue('k', () => 43, { timeoutMs: NaN }), 43);
  assert.equal(await queue.enqueue('k', () => 44, { timeoutMs: 'soon' }), 44);
  assert.equal(await queue.enqueue('k', () => 45, null), 45);
});

test('the job receives its label and an AbortSignal', async () => {
  const queue = createJobQueue();
  const context = await queue.enqueue('k', (ctx) => ctx, { label: 'receipt' });
  assert.equal(context.label, 'receipt');
  assert.equal(context.signal.aborted, false);
  const fallbackLabel = await queue.enqueue('system:Printer', (ctx) => ctx.label);
  assert.equal(fallbackLabel, 'system:Printer');
});

test('drain resolves true at once when the queue is idle', async () => {
  const queue = createJobQueue();
  assert.equal(await queue.drain(50), true);
  assert.equal(await queue.drain(), true);
});

test('drain waits for busy queues across keys and resolves true when they finish', async () => {
  const queue = createJobQueue();
  const a = deferred();
  const b = deferred();
  const jobA = queue.enqueue('a', () => a.promise);
  const jobB = queue.enqueue('b', () => b.promise);
  const drained = queue.drain(2000);
  let done = false;
  drained.then(() => { done = true; });

  a.resolve();
  await jobA;
  await settle();
  assert.equal(done, false, 'still waiting for key b');

  b.resolve();
  await jobB;
  assert.equal(await drained, true);
});

test('drain resolves false when the time runs out, and the jobs keep running', async () => {
  const queue = createJobQueue();
  const gate = deferred();
  const job = queue.enqueue('k', () => gate.promise);
  const startedAt = Date.now();
  assert.equal(await queue.drain(40), false);
  assert.ok(Date.now() - startedAt >= 30);
  assert.equal(queue.size('k'), 1);
  gate.resolve('done');
  assert.equal(await job, 'done');
  assert.equal(await queue.drain(10), true);
});

test('drain(0) is a poll: false while busy, true when idle', async () => {
  const queue = createJobQueue();
  const gate = deferred();
  const job = queue.enqueue('k', () => gate.promise);
  assert.equal(await queue.drain(0), false);
  gate.resolve();
  await job;
  assert.equal(await queue.drain(0), true);
});

test('several drain callers are all woken, and a timed-out job counts as finished', async () => {
  const queue = createJobQueue();
  const job = queue.enqueue('k', () => new Promise(() => {}), { timeoutMs: 30 });
  job.catch(() => {});
  const results = await Promise.all([queue.drain(1000), queue.drain(1000), queue.drain(1000)]);
  assert.deepEqual(results, [true, true, true]);
});
