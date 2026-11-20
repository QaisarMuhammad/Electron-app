'use strict';

/**
 * Readiness races, leaks and unhandled rejections in the DYMO helper window manager (src/main/printing/dymo/window.js) and the service
 * on top of it (src/main/printing/dymo/index.js). Verification lens "dymo-golden". These tests do not repeat tests/dymo/window.test.js and
 * service.test.js: they hold the OUTCOME of many interleavings to the same four invariants, with a window double written for this file:
 *
 *   1. every promise settles (a print always answers a Result, a dispose never leaves a waiter hanging);
 *   2. nothing rejects unhandled (process-level `unhandledRejection` / `uncaughtException` stay silent);
 *   3. no timer is left that could keep the app alive (every timer is unref'd) and the manager holds no listener after dispose;
 *   4. one window at a time, and the manager is usable again after any failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createManualClock } = require('../helpers/fake-electron');
const { createDymoService } = require('../../src/main/printing/dymo');
const { createDymoWindowManager } = require('../../src/main/printing/dymo/window');
const { FRAMEWORK_PROBE_SCRIPT, LIST_PRINTERS_SCRIPT } = require('../../src/main/printing/dymo/script');
const { mulberry32 } = require('./golden-fuzz-lib/payload-fuzz');

const LABELS_DIR = path.join(__dirname, '..', '..', 'labels');
const GENERIC = 'Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.';
const PRINTER = { name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true };

const PAYLOAD = { size: '32x57', design: '1', barcodefinal: { printer: 'dymo', title: 'Phone', barcode: '1234567', price: '9.99', conditionObject: { grade: 'New' } } };

/* ---------------------------------------------------------------------------------------------------------- */
/* Process-level guards                                                                                        */
/* ---------------------------------------------------------------------------------------------------------- */

const escaped = [];
const onRejection = (reason) => escaped.push(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
const onException = (error) => escaped.push(`uncaughtException: ${error && error.stack ? error.stack : error}`);
process.on('unhandledRejection', onRejection);
process.on('uncaughtException', onException);
test.after(() => {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
});

/** Lets rejections that nobody handled surface (Node reports them after the microtask queue drains). */
const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/* ---------------------------------------------------------------------------------------------------------- */
/* A window whose every behaviour is scripted                                                                  */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} Behaviour
 * @property {'finish'|'sync-finish'|'fail'|'hang'|'throw'|'reject'|'finish-late-reject'} [load]
 * @property {number} [frameworkAfterProbes]    how many probes answer false before the framework exists (Infinity: never)
 * @property {'ok'|'hang'|'reject'|'garbage'} [label]
 * @property {'ok'|'hang'|'reject'} [listing]
 */
class ControlledWindow extends EventEmitter {
  constructor(behaviour = {}) {
    super();
    this.behaviour = { load: 'finish', frameworkAfterProbes: 0, label: 'ok', listing: 'ok', ...behaviour };
    this.destroyed = false;
    this.probes = 0;
    this.labelScripts = 0;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = (code) => this.execute(code);
    this.webContents.isDestroyed = () => this.destroyed;
  }

  loadFile() {
    switch (this.behaviour.load) {
      case 'sync-finish':
        this.webContents.emit('did-finish-load'); // before loadFile has even returned
        return Promise.resolve();
      case 'fail':
        return new Promise((resolve, reject) =>
          setImmediate(() => {
            this.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
            reject(new Error('ERR_FILE_NOT_FOUND (-6)'));
          })
        );
      case 'hang':
        return new Promise(() => {});
      case 'throw':
        throw new Error('loadFile threw');
      case 'reject':
        return Promise.reject(new Error('loadFile rejected'));
      case 'finish-late-reject':
        return new Promise((resolve, reject) =>
          setImmediate(() => {
            this.webContents.emit('did-finish-load');
            setImmediate(() => reject(new Error('a late rejection of loadFile')));
          })
        );
      default:
        return new Promise((resolve) =>
          setImmediate(() => {
            if (!this.destroyed) this.webContents.emit('did-finish-load');
            resolve();
          })
        );
    }
  }

  execute(code) {
    if (this.destroyed) return Promise.reject(new Error('Object has been destroyed'));
    if (code === FRAMEWORK_PROBE_SCRIPT) {
      this.probes += 1;
      return Promise.resolve(this.probes > this.behaviour.frameworkAfterProbes);
    }
    if (code === LIST_PRINTERS_SCRIPT) {
      if (this.behaviour.listing === 'hang') return new Promise(() => {});
      if (this.behaviour.listing === 'reject') return Promise.reject(new Error(GENERIC));
      return Promise.resolve(JSON.stringify({ printers: [PRINTER] }));
    }
    this.labelScripts += 1;
    if (this.behaviour.label === 'hang') return new Promise(() => {});
    if (this.behaviour.label === 'reject') return Promise.reject(new Error(GENERIC));
    if (this.behaviour.label === 'garbage') return Promise.resolve('not json');
    return Promise.resolve(JSON.stringify({ ok: true }));
  }

  crash() {
    this.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  }

  /** The window closes by itself (the user, the OS). */
  vanish() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  destroy() {
    this.vanish();
  }

  isDestroyed() {
    return this.destroyed;
  }

  /** How many listeners of the manager are still attached. */
  attached() {
    return ['closed'].reduce((sum, event) => sum + this.listenerCount(event), 0) + ['did-finish-load', 'did-fail-load', 'render-process-gone'].reduce((sum, event) => sum + this.webContents.listenerCount(event), 0);
  }
}

/** @param {(index: number) => Behaviour} [behaviour] */
function rig(behaviour = () => ({})) {
  const clock = createManualClock();
  const windows = [];
  const service = createDymoService({
    createHiddenWindow() {
      const win = new ControlledWindow(behaviour(windows.length));
      windows.push(win);
      return win;
    },
    labelsDir: LABELS_DIR,
    readFile: async () => '<DYMOLabel/>',
    getConfig: () => ({}),
    timers: clock,
    log: {},
  });
  return { clock, windows, service };
}

/** Runs the clock until `promise` settles (or `limit` ms of fake time have passed), so a print that waits on a timeout can finish. */
async function finish(clock, promise, limit = 120_000) {
  let done = false;
  let value;
  let failure;
  promise.then((v) => ((done = true), (value = v)), (e) => ((done = true), (failure = e)));
  for (let waited = 0; !done && waited < limit; waited += 250) await clock.advance(250);
  assert.ok(done, `the promise did not settle within ${limit} ms of fake time`);
  if (failure) throw failure;
  return value;
}

const assertQuiet = async (label) => {
  await settle();
  assert.deepEqual(escaped.splice(0), [], `${label}: nothing escaped as an unhandled rejection or exception`);
};

/* ---------------------------------------------------------------------------------------------------------- */
/* 1. Every kind of failed or odd load                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

const LOADS = [
  ['the page fails to load', { load: 'fail' }, 'DYMO_UNAVAILABLE'],
  ['the page never finishes loading', { load: 'hang' }, 'DYMO_UNAVAILABLE'],
  ['loadFile throws', { load: 'throw' }, 'DYMO_UNAVAILABLE'],
  ['loadFile rejects', { load: 'reject' }, 'DYMO_UNAVAILABLE'],
  ['the framework never appears', { frameworkAfterProbes: Infinity }, 'DYMO_UNAVAILABLE'],
  ['the printer list never answers', { listing: 'hang' }, 'DYMO_UNAVAILABLE'],
  ['the printer list script rejects', { listing: 'reject' }, 'DYMO_UNAVAILABLE'],
  ['the label script never answers', { label: 'hang' }, 'DYMO_UNAVAILABLE'],
  ['the label script rejects', { label: 'reject' }, 'DYMO_PRINT_FAILED'],
  ['the label script answers garbage', { label: 'garbage' }, 'DYMO_PRINT_FAILED'],
];

for (const [name, behaviour, code] of LOADS) {
  test(`races: ${name}: the print answers ${code}, nothing is left behind, and the next print on a healthy window works`, async () => {
    const { clock, windows, service } = rig((index) => (index === 0 ? behaviour : {}));
    const first = await finish(clock, service.print(PAYLOAD));
    assert.equal(first.ok, false);
    assert.equal(first.code, code);
    await assertQuiet(name);
    if (code === 'DYMO_PRINT_FAILED') {
      assert.equal(windows.length, 1, 'a failed label script does not replace the window');
    }
    // DYMO Connect comes back (a window that was kept answers properly again) and the service is usable again
    for (const win of windows) win.behaviour = { ...win.behaviour, label: 'ok', listing: 'ok', frameworkAfterProbes: 0 };
    const second = await finish(clock, service.print(PAYLOAD));
    assert.equal(second.ok, true, `the next print works (${JSON.stringify(second)})`);
    service.dispose();
    await clock.advance(1);
    assert.ok(windows.every((win) => win.isDestroyed()), 'every window is destroyed after dispose');
    assert.ok(windows.every((win) => win.attached() === 0), 'the manager removed every listener it added');
    assert.equal(clock.pendingRefed(), 0, 'no timer that could keep the app alive is left');
    assert.equal(clock.pending(), 0, 'no timer at all is left after dispose');
    await assertQuiet(`${name} (after dispose)`);
  });
}

test('races: did-finish-load fired synchronously inside loadFile (before loadFile returns) still gives a ready window', async () => {
  const { clock, windows, service } = rig(() => ({ load: 'sync-finish' }));
  const result = await finish(clock, service.print(PAYLOAD));
  assert.equal(result.ok, true);
  assert.equal(windows.length, 1);
  service.dispose();
  await assertQuiet('sync finish');
});

// Electron's loadFile() promise cannot reject after did-finish-load (it removes its listeners when it settles), so this was a latent hazard only; the guard
// is `!attempt.settled` next to `current()` in window.js startLoad().
test('races: a LATE rejection of loadFile after the page loaded does not tear down a working window (the manager resets only a window that is still loading)', async () => {
  const { clock, windows, service } = rig((index) => (index === 0 ? { load: 'finish-late-reject' } : {}));
  const first = await finish(clock, service.print(PAYLOAD));
  assert.equal(first.ok, true);
  await clock.advance(100);
  await settle();
  const second = await finish(clock, service.print(PAYLOAD));
  assert.equal(second.ok, true);
  assert.equal(windows.length, 1, 'the working window was kept (a late rejection of the load promise must not destroy it)');
  assert.equal(windows[0].isDestroyed(), false);
  service.dispose();
  await assertQuiet('late reject');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* 2. dispose() at every phase                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

const PHASES = [
  ['before the loader page answered', async () => {}],
  ['while the framework is being polled', async () => {}],
  ['while the printer list is being read', async () => {}],
  ['while the label script runs', async () => {}],
];

for (const [index, [name]] of PHASES.entries()) {
  test(`races: dispose() ${name}: every waiting print settles with a Result, and the service builds a new window afterwards`, async () => {
    const behaviours = [{ load: 'hang' }, { frameworkAfterProbes: Infinity }, { listing: 'hang' }, { label: 'hang' }];
    const { clock, windows, service } = rig((n) => (n === 0 ? behaviours[index] : {}));
    // three concurrent prints share the one window load
    const waiting = [service.print(PAYLOAD), service.print(PAYLOAD), service.print(PAYLOAD)];
    await clock.advance(120); // reach the phase
    service.dispose();
    const results = await finish(clock, Promise.all(waiting));
    for (const result of results) {
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(['DYMO_UNAVAILABLE', 'DYMO_PRINT_FAILED'].includes(result.code), result.code);
    }
    assert.ok(windows[0].isDestroyed(), 'the window of the disposed manager is destroyed');
    assert.equal(windows[0].attached(), 0);
    await assertQuiet(`dispose ${name}`);
    const after = await finish(clock, service.print(PAYLOAD));
    assert.equal(after.ok, true, 'a print after dispose() builds a new window');
    assert.equal(windows.length, 2);
    service.dispose();
    await assertQuiet(`dispose ${name} (cleanup)`);
  });
}

test('races: ten prints queued behind one cold window, the window crashes while the first label script runs: nobody hangs, the next batch gets a new window', async () => {
  const { clock, windows, service } = rig((index) => (index === 0 ? { label: 'hang' } : {}));
  const batch = Array.from({ length: 10 }, () => service.print(PAYLOAD));
  await clock.advance(200);
  windows[0].crash();
  const results = await finish(clock, Promise.all(batch));
  assert.ok(results.every((result) => result.ok === false || result.ok === true), 'every print answered');
  assert.equal(windows[0].isDestroyed(), true);
  const next = await finish(clock, Promise.all(Array.from({ length: 5 }, () => service.print(PAYLOAD))));
  assert.ok(next.every((result) => result.ok === true), JSON.stringify(next));
  assert.equal(windows.length, 2, 'one new window for the whole second batch');
  service.dispose();
  await assertQuiet('crash batch');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* 3. Idle disposal                                                                                            */
/* ---------------------------------------------------------------------------------------------------------- */

test('races: the idle disposal fires between two prints that arrive 10 minutes apart: the second print builds a window; the idle timer is re-armed by every use and is unref\'d', async () => {
  const { clock, windows, service } = rig();
  assert.equal((await finish(clock, service.print(PAYLOAD))).ok, true);
  assert.equal(clock.pendingRefed(), 0);
  await clock.advance(9 * 60 * 1000);
  assert.equal(windows[0].isDestroyed(), false, 'not yet');
  assert.equal((await finish(clock, service.print(PAYLOAD))).ok, true, 'a print at 9 minutes re-arms the idle countdown');
  await clock.advance(9 * 60 * 1000);
  assert.equal(windows[0].isDestroyed(), false, '9 minutes after the second print');
  await clock.advance(61 * 1000);
  assert.equal(windows[0].isDestroyed(), true, 'disposed after 10 idle minutes');
  assert.equal(windows[0].attached(), 0);
  assert.equal((await finish(clock, service.print(PAYLOAD))).ok, true);
  assert.equal(windows.length, 2);
  service.dispose();
  await assertQuiet('idle');
});

test('races: the idle timer fires while a label script is still running: the script is not cut off, and the countdown starts again afterwards', async () => {
  const clock = createManualClock();
  let release;
  const windows = [];
  const manager = createDymoWindowManager({
    createHiddenWindow() {
      const win = new ControlledWindow();
      const original = win.execute.bind(win);
      win.execute = (code) => (code === 'SLOW' ? new Promise((resolve) => (release = () => resolve('done'))) : original(code));
      windows.push(win);
      return win;
    },
    timers: clock,
    idleDisposeMs: 1000,
    log: {},
  });
  await manager.run('1'); // makes the window and arms the idle timer
  const running = manager.run('SLOW');
  await clock.advance(5000); // far beyond the idle time
  assert.equal(windows[0].isDestroyed(), false, 'a running script keeps its window');
  release();
  assert.equal(await running, 'done');
  await clock.advance(1500);
  assert.equal(windows[0].isDestroyed(), true, 'disposed after the script ended and the idle time passed again');
  assert.equal(clock.pending(), 0);
  await assertQuiet('idle during script');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* 4. A soak: hundreds of prints with random trouble, the invariants hold at every step                        */
/* ---------------------------------------------------------------------------------------------------------- */

test('soak: 400 prints with seeded random crashes, vanishing windows, hangs and failed loads: every print answers, one window at a time, nothing leaks, nothing escapes', { timeout: 120_000 }, async () => {
  const random = mulberry32(0xd1ce);
  const kinds = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'fail-load', 'hang-load', 'label-hang', 'label-reject', 'slow-framework', 'sync-finish'];
  const { clock, windows, service } = rig(() => {
    const kind = kinds[Math.floor(random() * kinds.length)];
    switch (kind) {
      case 'fail-load': return { load: 'fail' };
      case 'hang-load': return { load: 'hang' };
      case 'label-hang': return { label: 'hang' };
      case 'label-reject': return { label: 'reject' };
      case 'slow-framework': return { frameworkAfterProbes: 3 };
      case 'sync-finish': return { load: 'sync-finish' };
      default: return {};
    }
  });

  let answered = 0;
  for (let round = 0; round < 400; round += 1) {
    const burst = 1 + Math.floor(random() * 3);
    const pending = Array.from({ length: burst }, () => service.print(PAYLOAD));
    const trouble = random();
    await clock.advance(Math.floor(random() * 400));
    const live = windows.filter((win) => !win.isDestroyed());
    if (trouble < 0.12 && live.length > 0) live[live.length - 1].crash();
    else if (trouble < 0.2 && live.length > 0) live[live.length - 1].vanish();
    else if (trouble < 0.24) service.dispose();
    else if (trouble < 0.3) await clock.advance(11 * 60 * 1000); // idle disposal
    const results = await finish(clock, Promise.all(pending));
    for (const result of results) {
      assert.equal(typeof result.ok, 'boolean', `round ${round}: a Result`);
      if (!result.ok) assert.ok(['DYMO_UNAVAILABLE', 'DYMO_PRINT_FAILED', 'DYMO_NO_PRINTER', 'DYMO_TEMPLATE_MISSING'].includes(result.code), `round ${round}: ${result.code}`);
      answered += 1;
    }
    const alive = windows.filter((win) => !win.isDestroyed());
    assert.ok(alive.length <= 1, `round ${round}: ${alive.length} windows are alive at the same time`);
    assert.equal(clock.pendingRefed(), 0, `round ${round}: a timer that keeps the app alive is pending`);
    if (round % 50 === 0) await assertQuiet(`round ${round}`);
  }
  assert.equal(answered > 400, true);
  service.dispose();
  await clock.advance(1);
  assert.ok(windows.every((win) => win.isDestroyed()), 'every window ever created is destroyed');
  assert.ok(windows.every((win) => win.attached() === 0), 'no manager listener is left on any window');
  assert.equal(clock.pending(), 0);
  await assertQuiet('soak');
});
