'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createShutdown, TASK_TIMEOUT_MS } = require('../../src/main/shutdown');
const { createManualClock } = require('../helpers/fake-electron');

/** Lets the promise chains of the shutdown run: a few turns of the event loop. */
async function turns(count = 10) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** An `app` that emits `before-quit` from quit() like Electron does: a prevented quit goes no further. */
function setup() {
  const app = new EventEmitter();
  const state = { relaunches: 0, quits: 0, really: 0 };
  app.relaunch = () => { state.relaunches += 1; };
  app.quit = () => {
    state.quits += 1;
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    if (!event.prevented) state.really += 1;
  };
  const clock = createManualClock();
  const entries = [];
  const log = { info: (m) => entries.push(['info', m]), warn: (m) => entries.push(['warn', m]), error: (m) => entries.push(['error', m]) };
  const shutdown = createShutdown({ app, timers: clock, log });
  shutdown.install();
  return { app, state, clock, entries, shutdown };
}

test('the first quit is held back, the tasks run in the order they were added, and only then does the app really quit', async () => {
  const { state, clock, shutdown } = setup();
  const order = [];
  shutdown.add('drain', async () => { order.push('drain start'); await new Promise((resolve) => setImmediate(resolve)); order.push('drain end'); });
  shutdown.add('dispose', () => order.push('dispose'));

  shutdown.quit();
  assert.equal(state.really, 0, 'the quit is held back');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['drain start'], 'the first task is running, the second waits for it');
  await turns();
  assert.deepEqual(order, ['drain start', 'drain end', 'dispose']);
  assert.equal(state.quits, 2, 'quit() is called again at the end');
  assert.equal(state.really, 1, 'and that second quit is not held back');
  assert.equal(shutdown.isQuitting(), true);
});

test('a second quit while the tasks run neither runs them again nor lets the app go early', async () => {
  const { state, clock, shutdown } = setup();
  let runs = 0;
  shutdown.add('slow', async () => { runs += 1; await turns(3); });
  shutdown.quit();
  shutdown.quit();
  shutdown.quit();
  assert.equal(state.really, 0);
  await turns();
  assert.equal(runs, 1);
  assert.equal(state.really, 1);
});

test('a task that throws, rejects or hangs is logged and abandoned: it never stops the others or the quit', async () => {
  const { state, clock, entries, shutdown } = setup();
  const ran = [];
  shutdown.add('throws', () => { throw new Error('first broke'); });
  shutdown.add('rejects', () => Promise.reject(new Error('second broke')));
  shutdown.add('hangs', () => new Promise(() => {}));
  shutdown.add('last', () => ran.push('last'));
  shutdown.quit();
  await turns();
  await clock.advance(TASK_TIMEOUT_MS + 1);
  await turns();
  assert.deepEqual(ran, ['last']);
  assert.equal(state.really, 1);
  const text = entries.map(([, message]) => message).join('\n');
  assert.match(text, /"throws" failed \(first broke\)/);
  assert.match(text, /"rejects" failed \(second broke\)/);
  assert.match(text, /"hangs" took too long/);
});

test('no timer is left running once the tasks are done', async () => {
  const { clock, shutdown } = setup();
  shutdown.add('quick', () => {});
  shutdown.quit();
  await turns();
  assert.equal(clock.pending(), 0);
});

test('a restart relaunches ONCE and quits gracefully, however often it is asked', async () => {
  const { state, clock, shutdown } = setup();
  const ran = [];
  shutdown.add('drain', () => ran.push('drain'));
  shutdown.restart();
  shutdown.restart();
  await turns();
  assert.equal(state.relaunches, 1);
  assert.deepEqual(ran, ['drain']);
  assert.equal(state.really, 1);
});

test('quitting with nothing registered (the boot was not finished) still goes through', async () => {
  const { state, clock, shutdown } = setup();
  shutdown.quit();
  await turns();
  assert.equal(state.really, 1);
});
