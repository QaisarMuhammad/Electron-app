'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManualClock } = require('../helpers/fake-electron');
const { createWindowFactory, FakeHiddenWindow } = require('../helpers/vm-dymo');
const {
  DYMO_IDLE_DISPOSE_MS,
  LOAD_TIMEOUT_MS,
  SCRIPT_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  DYMO_LOADER_FILE,
  DymoWindowError,
  createDymoWindowManager,
} = require('../../src/main/printing/dymo/window');

/** A manager on a manual clock with fake windows; `log` collects what it reports. */
function setup(windowOptions = {}, managerOptions = {}) {
  const clock = createManualClock();
  const factory = createWindowFactory(windowOptions);
  const logged = [];
  const log = {
    info: (message) => logged.push(['info', message]),
    warn: (message) => logged.push(['warn', message]),
  };
  const manager = createDymoWindowManager({ createHiddenWindow: factory.createHiddenWindow, timers: clock, log, ...managerOptions });
  return { clock, factory, manager, logged };
}

/** Settles to the rejection (or the value) so a rejection is never unhandled while the clock advances. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

test('constants: 10 minutes idle, 15 s load timeout, 20 s script timeout (below the print queue\'s 30 s), 5 s framework wait', () => {
  assert.equal(DYMO_IDLE_DISPOSE_MS, 10 * 60 * 1000);
  assert.equal(LOAD_TIMEOUT_MS, 15_000);
  assert.equal(SCRIPT_TIMEOUT_MS, 20_000);
  assert.ok(SCRIPT_TIMEOUT_MS < 30_000);
  assert.equal(READY_TIMEOUT_MS, 5_000);
});

test('the manager needs a window factory', () => {
  assert.throws(() => createDymoWindowManager({}), TypeError);
  assert.throws(() => createDymoWindowManager(), TypeError);
});

test('creating the manager creates no window, no timer and no listener (nothing at startup)', () => {
  const { factory, manager, clock } = setup();
  assert.equal(factory.created, 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(manager.status(), { hasWindow: false, ready: false, loading: false, busy: 0, idleTimer: false });
});

test('the window is created on first use, loads the loader page, and is reused', async () => {
  const { factory, manager } = setup();
  const first = await manager.getWindow();
  assert.equal(factory.created, 1);
  assert.equal(first.loadedFile, DYMO_LOADER_FILE);
  assert.equal(first.fake.frameworkLoaded, true);
  for (let i = 0; i < 5; i += 1) assert.equal(await manager.getWindow(), first);
  assert.equal(factory.created, 1);
  assert.equal(manager.status().ready, true);
});

test('the default loader page exists and its script path leads to the DYMO framework file', () => {
  assert.ok(DYMO_LOADER_FILE.endsWith(path.join('src', 'renderer', 'dymo-loader.html')));
  const html = fs.readFileSync(DYMO_LOADER_FILE, 'utf8');
  const src = /<script\s+src="([^"]+)"/.exec(html)[1];
  const framework = path.resolve(path.dirname(DYMO_LOADER_FILE), src);
  assert.ok(fs.existsSync(framework), `${src} -> ${framework}`);
  assert.equal(path.relative(path.resolve(__dirname, '..', '..'), framework), path.join('assets', 'dymo.connect.framework.js'));
  assert.ok(fs.readFileSync(framework, 'utf8').includes('dymo.label.framework'));
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /preload/i, 'no preload: the page has no bridge');
});

test('a custom loader file is honoured', async () => {
  const { factory, manager } = setup({}, { loaderFile: '/somewhere/loader.html' });
  await manager.getWindow();
  assert.equal(factory.windows[0].loadedFile, '/somewhere/loader.html');
});

test('ten callers on a cold window create ONE window and all get it once it is ready', async () => {
  const { factory, manager } = setup();
  const windows = await Promise.all(Array.from({ length: 10 }, () => manager.getWindow()));
  assert.equal(factory.created, 1);
  assert.ok(windows.every((win) => win === windows[0]));
  assert.equal(windows[0].fake.frameworkLoaded, true);
});

test('ten concurrent run() calls on a cold window create one window and every script runs once', async () => {
  const { factory, manager } = setup();
  const answers = await Promise.all(Array.from({ length: 10 }, (_, index) => manager.run(`${index} * 2`)));
  assert.deepEqual(answers, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(factory.created, 1);
  const runs = factory.windows[0].scripts.filter((script) => / \* 2$/.test(script));
  assert.equal(runs.length, 10);
});

test('ready means the page loaded AND the framework exists: the manager polls until it does', async () => {
  const { clock, manager, factory } = setup({ frameworkAfterCalls: 3 });
  let resolved = false;
  const pending = manager.getWindow().then((win) => {
    resolved = true;
    return win;
  });
  await clock.flush(); // the page has loaded; probe 1 found no framework
  assert.equal(resolved, false);
  await clock.advance(50); // probe 2
  assert.equal(resolved, false);
  await clock.advance(50); // probe 3
  assert.equal(resolved, false);
  await clock.advance(50); // probe 4: the framework is there
  assert.equal(resolved, true);
  assert.equal(await pending, factory.windows[0]);
  assert.equal(factory.created, 1);
});

test('a framework that never appears: DYMO_UNAVAILABLE after the 5 s wait, the window is destroyed, the next call builds a new one', async () => {
  const { clock, manager, factory } = setup((index) => (index === 0 ? { frameworkAfterCalls: Infinity } : {}));
  const outcome = settle(manager.getWindow());
  await clock.advance(READY_TIMEOUT_MS - 100);
  assert.equal(factory.windows[0].destroyed, false, 'still waiting');
  await clock.advance(200);
  const { error } = await outcome;
  assert.ok(error instanceof DymoWindowError);
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.match(error.message, /framework/i);
  assert.equal(factory.windows[0].destroyed, true);
  assert.deepEqual(manager.status(), { hasWindow: false, ready: false, loading: false, busy: 0, idleTimer: false });

  const again = await manager.getWindow();
  assert.equal(factory.created, 2);
  assert.notEqual(again, factory.windows[0]);
});

test('did-fail-load: callers get DYMO_UNAVAILABLE, the window is destroyed and nothing is cached', async () => {
  const { manager, factory } = setup((index) => (index === 0 ? { load: 'fail' } : {}));
  const callers = await Promise.all([settle(manager.getWindow()), settle(manager.getWindow()), settle(manager.getWindow())]);
  for (const { error } of callers) {
    assert.equal(error.code, 'DYMO_UNAVAILABLE');
    assert.match(error.message, /failed to load/i);
  }
  assert.equal(factory.created, 1, 'the three callers shared one load');
  assert.equal(factory.windows[0].destroyed, true);
  const win = await manager.getWindow();
  assert.equal(factory.created, 2);
  assert.equal(win, factory.windows[1]);
});

test('a sub-frame load failure is ignored', async () => {
  const { manager, factory } = setup();
  const pending = manager.getWindow();
  factory.windows[0].webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', false);
  const win = await pending;
  assert.equal(win, factory.windows[0]);
  assert.equal(win.destroyed, false);
});

test('render-process-gone after the window was ready resets it: the next call builds a new window', async () => {
  const { manager, factory, logged } = setup();
  const first = await manager.getWindow();
  first.crash('crashed');
  assert.equal(first.destroyed, true);
  assert.equal(manager.status().hasWindow, false);
  const second = await manager.getWindow();
  assert.notEqual(second, first);
  assert.equal(factory.created, 2);
  assert.ok(logged.some(([level, message]) => level === 'warn' && /renderer gone \(crashed\)/.test(message)));
});

test('render-process-gone while loading rejects every waiting caller', async () => {
  const { clock, manager, factory } = setup({ frameworkAfterCalls: Infinity });
  const callers = [settle(manager.getWindow()), settle(manager.getWindow())];
  await clock.flush();
  factory.windows[0].crash('oom');
  for (const { error } of await Promise.all(callers)) assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.equal(factory.windows[0].destroyed, true);
});

test('the window closing by itself resets the manager', async () => {
  const { manager, factory } = setup();
  const first = await manager.getWindow();
  first.destroy(); // emits "closed"
  assert.equal(manager.status().hasWindow, false);
  assert.notEqual(await manager.getWindow(), first);
  assert.equal(factory.created, 2);
});

test('a destroyed window that the manager did not hear about is replaced on the next call', async () => {
  const { manager, factory } = setup();
  const first = await manager.getWindow();
  first.destroyed = true; // destroyed without any event
  const second = await manager.getWindow();
  assert.notEqual(second, first);
  assert.equal(factory.created, 2);
});

test('late events of a window that was replaced never reset the new one', async () => {
  const { manager } = setup();
  const first = await manager.getWindow();
  first.crash();
  const second = await manager.getWindow();
  first.emit('closed');
  first.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  first.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'x', true);
  assert.equal(manager.status().ready, true);
  assert.equal(await manager.getWindow(), second);
  assert.equal(second.destroyed, false);
});

test('a load that never finishes: DYMO_UNAVAILABLE after 15 s and the half-made window is destroyed', async () => {
  const { clock, manager, factory } = setup((index) => (index === 0 ? { load: 'hang' } : {}));
  const outcome = settle(manager.getWindow());
  await clock.advance(LOAD_TIMEOUT_MS - 1);
  assert.equal(manager.status().loading, true);
  await clock.advance(1);
  const { error } = await outcome;
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.match(error.message, /too long/i);
  assert.equal(factory.windows[0].destroyed, true, 'no half-made window is left behind');
  assert.equal(clock.pending(), 0);
  const second = await manager.getWindow();
  assert.equal(factory.created, 2);
  assert.notEqual(second, factory.windows[0]);
});

test('a window factory that throws is DYMO_UNAVAILABLE and is not cached: the next call tries again', async () => {
  const clock = createManualClock();
  let attempts = 0;
  const factory = createWindowFactory();
  const manager = createDymoWindowManager({
    createHiddenWindow() {
      attempts += 1;
      if (attempts === 1) throw new Error('no display');
      return factory.createHiddenWindow();
    },
    timers: clock,
  });
  const { error } = await settle(manager.getWindow());
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.match(error.message, /no display/);
  assert.ok(await manager.getWindow());
  assert.equal(attempts, 2);
});

test('loadFile throwing or rejecting resets the manager', async () => {
  const clock = createManualClock();
  class Broken extends FakeHiddenWindow {
    loadFile() {
      throw new Error('disk gone');
    }
  }
  const manager = createDymoWindowManager({ createHiddenWindow: () => new Broken(), timers: clock });
  const { error } = await settle(manager.getWindow());
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.match(error.message, /disk gone/);
  assert.equal(manager.status().hasWindow, false);

  class Rejecting extends FakeHiddenWindow {
    loadFile() {
      return Promise.reject(new Error('ERR_FAILED'));
    }
  }
  const second = createDymoWindowManager({ createHiddenWindow: () => new Rejecting(), timers: clock });
  const result = await settle(second.getWindow());
  assert.equal(result.error.code, 'DYMO_UNAVAILABLE');
});

test('run() returns the script value; a failing script rejects but leaves the window usable', async () => {
  const { manager, factory } = setup();
  assert.equal(await manager.run('6 * 7'), 42);
  await assert.rejects(manager.run('throw new Error("page error")'), /Script failed to execute/);
  assert.equal(manager.status().busy, 0);
  assert.equal(await manager.run('1 + 1'), 2);
  assert.equal(factory.created, 1);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* A hung DYMO service                                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

/** A window whose script 'HANG' never answers, like a page blocked in the framework's synchronous request to a hung DYMO service. */
class Hanging extends FakeHiddenWindow {
  constructor(options) {
    super(options);
    const normal = this.webContents.executeJavaScript;
    this.webContents.executeJavaScript = (code) => (code === 'HANG' ? new Promise(() => {}) : normal(code));
  }
}

function hangingSetup() {
  const clock = createManualClock();
  const windows = [];
  const manager = createDymoWindowManager({
    createHiddenWindow: () => {
      const win = new Hanging({});
      windows.push(win);
      return win;
    },
    timers: clock,
  });
  return { clock, windows, manager };
}

test('a script that never answers (DYMO Connect hung): DYMO_UNAVAILABLE after 20 s, the stuck window is replaced, the next script runs on a new one', async () => {
  const { clock, windows, manager } = hangingSetup();
  await manager.run('1');
  const outcome = settle(manager.run('HANG'));
  await clock.advance(SCRIPT_TIMEOUT_MS - 1);
  assert.equal(windows[0].destroyed, false, 'still waiting');
  assert.equal(manager.status().busy, 1);
  await clock.advance(1);
  const { error } = await outcome;
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.match(error.message, /did not answer in time/);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(manager.status(), { hasWindow: false, ready: false, loading: false, busy: 0, idleTimer: false });
  assert.equal(await manager.run('2 + 2'), 4);
  assert.equal(windows.length, 2);
});

test('the script timeout is unref\'d, and a script that answers in time leaves no timer behind but the idle one', async () => {
  const { clock, manager } = hangingSetup();
  await manager.run('1');
  const hung = settle(manager.run('HANG'));
  await clock.flush();
  assert.ok(clock.timers().some((timer) => timer.at - clock.now() === SCRIPT_TIMEOUT_MS), 'the script timeout is scheduled');
  assert.equal(clock.pendingRefed(), 0, 'and it cannot keep the app alive');
  await clock.advance(SCRIPT_TIMEOUT_MS);
  await hung; // settled by the timeout

  assert.equal(await manager.run('3 + 3'), 6);
  assert.equal(clock.pending(), 1, 'only the idle timer remains');
  assert.equal(clock.timers()[0].at - clock.now(), DYMO_IDLE_DISPOSE_MS);
});

test('a hung script does not disturb a window that was replaced meanwhile', async () => {
  const { clock, windows, manager } = hangingSetup();
  await manager.run('1');
  const hung = settle(manager.run('HANG'));
  await clock.flush();
  windows[0].crash('crashed'); // the window is replaced before the timeout fires
  const second = await manager.run('5');
  assert.equal(second, 5);
  await clock.advance(SCRIPT_TIMEOUT_MS + 10);
  assert.equal(windows[1].destroyed, false, 'the timeout of the old script must not reset the new window');
  assert.equal(manager.status().ready, true);
  await hung; // it settles (rejected by the timeout)
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Idle disposal (SPEC 18b R4)                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

test('the window is disposed after 10 idle minutes and created again on the next use', async () => {
  const { clock, manager, factory, logged } = setup();
  await manager.run('1');
  assert.equal(manager.status().idleTimer, true);
  await clock.advance(DYMO_IDLE_DISPOSE_MS - 1);
  assert.equal(factory.windows[0].destroyed, false);
  await clock.advance(1);
  assert.equal(factory.windows[0].destroyed, true);
  assert.deepEqual(manager.status(), { hasWindow: false, ready: false, loading: false, busy: 0, idleTimer: false });
  assert.equal(clock.pending(), 0, 'no timer is left');
  assert.ok(logged.some(([, message]) => /disposed after being idle/.test(message)));

  assert.equal(await manager.run('2 + 2'), 4);
  assert.equal(factory.created, 2, 're-created after disposal');
  assert.equal(manager.status().ready, true);
});

test('every use restarts the idle countdown', async () => {
  const { clock, manager, factory } = setup();
  const minute = 60 * 1000;
  await manager.run('1');
  await clock.advance(9 * minute);
  await manager.run('2'); // uses it again at minute 9
  await clock.advance(9 * minute); // minute 18: only 9 minutes since the last use
  assert.equal(factory.windows[0].destroyed, false);
  await clock.advance(minute); // minute 19: 10 minutes since the last use
  assert.equal(factory.windows[0].destroyed, true);
  assert.equal(factory.created, 1);
});

test('the idle timer and the load timeout are unref\'d: they never keep the app alive', async () => {
  const { clock, manager } = setup({ frameworkAfterCalls: 0 });
  const loading = manager.getWindow();
  assert.equal(clock.pending(), 1, 'the load timeout');
  assert.equal(clock.pendingRefed(), 0);
  await loading;
  assert.equal(clock.pending(), 0, 'the load timeout is cleared once the window is ready');
  await manager.run('1');
  assert.equal(clock.pending(), 1, 'the idle timer');
  assert.equal(clock.pendingRefed(), 0);
  assert.equal(clock.timers()[0].unrefd, true);
});

test('a script still running when the idle timer fires is not cut off', async () => {
  const clock = createManualClock();
  class Holdable extends FakeHiddenWindow {
    constructor(options) {
      super(options);
      this.held = [];
      const normal = this.webContents.executeJavaScript;
      this.webContents.executeJavaScript = (code) => (code === 'HOLD' ? new Promise((resolve) => this.held.push(resolve)) : normal(code));
    }
  }
  const windows = [];
  const manager = createDymoWindowManager({
    createHiddenWindow: () => {
      const win = new Holdable({});
      windows.push(win);
      return win;
    },
    timers: clock,
    idleDisposeMs: 5_000, // shorter than the 20 s script timeout, so the idle timer can fire while a script is legitimately running
  });
  await manager.run('1');
  const held = manager.run('HOLD');
  await clock.flush();
  assert.equal(manager.status().busy, 1);
  await clock.advance(6_000);
  assert.equal(windows[0].destroyed, false, 'the busy window is kept');
  windows[0].held[0]('finished');
  assert.equal(await held, 'finished');
  assert.equal(manager.status().busy, 0);
  await clock.advance(5_000);
  assert.equal(windows[0].destroyed, true, 'disposed once it is idle again');
});

test('dispose() destroys the window, stops the timer, and a later call builds a new window', async () => {
  const { clock, manager, factory } = setup();
  const first = await manager.run('1').then(() => factory.windows[0]);
  manager.dispose();
  assert.equal(first.destroyed, true);
  assert.equal(clock.pending(), 0);
  assert.equal(manager.status().hasWindow, false);
  await manager.run('1');
  assert.equal(factory.created, 2);
  manager.dispose();
  manager.dispose(); // twice is harmless
});

test('dispose() while loading rejects the waiting callers and destroys the window', async () => {
  const { clock, manager, factory } = setup({ frameworkAfterCalls: Infinity });
  const outcome = settle(manager.getWindow());
  await clock.flush();
  manager.dispose();
  const { error } = await outcome;
  assert.equal(error.code, 'DYMO_UNAVAILABLE');
  assert.equal(factory.windows[0].destroyed, true);
  assert.equal(clock.pending(), 0);
});

test('with the real timers, the idle and load timers are unref\'d too (the process can exit)', async () => {
  const factory = createWindowFactory();
  const manager = createDymoWindowManager({ createHiddenWindow: factory.createHiddenWindow, idleDisposeMs: 60_000 });
  await manager.run('1');
  assert.equal(manager.status().idleTimer, true);
  manager.dispose(); // clears it, so this test does not leave a timer behind
  assert.equal(manager.status().idleTimer, false);
});
