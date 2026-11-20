'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGpuGuard, compatibilityPatch, SCREEN_CHECK_DELAY_MS } = require('../../src/main/gpuGuard');
const { createManualClock } = require('../helpers/fake-electron');

async function turns(count = 8) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {object} [options]
 * @param {boolean} [options.gpuDisabled]
 * @param {object} [options.stored] what flags.json holds
 * @param {number[]} [options.answers] the buttons the next dialogs are answered with
 */
function setup({ gpuDisabled = false, argvDisableGpu = false, stored = {}, answers = [] } = {}) {
  const clock = createManualClock();
  const state = { flags: { disableGpu: false, reason: '', gpuChecked: false, ...stored }, writes: [], dialogs: [], restarts: 0, failWrite: false, logs: [] };
  const flags = {
    read: () => ({ ...state.flags }),
    write: (patch) => {
      if (state.failWrite) throw new Error('disk full');
      state.writes.push(patch);
      state.flags = { ...state.flags, ...patch };
      return state.flags;
    },
  };
  const dialog = {
    showMessageBox: async (...args) => {
      const options = args.length === 1 ? args[0] : args[1];
      state.dialogs.push({ options, withWindow: args.length === 2 });
      return { response: answers.length > 0 ? answers.shift() : options.cancelId };
    },
  };
  const log = { info: (m) => state.logs.push(m), warn: (m) => state.logs.push(m), error: (m) => state.logs.push(m) };
  const guard = createGpuGuard({
    dialog, flags, getWindow: () => null, requestRestart: () => { state.restarts += 1; }, timers: clock, now: clock.now, log, gpuDisabled, argvDisableGpu,
  });
  return { guard, clock, state };
}

const GPU_DIED = { type: 'GPU', reason: 'crashed' };

test('the GPU process dying twice within a minute switches to compatibility mode and asks, natively, to restart', async () => {
  const { guard, clock, state } = setup({ answers: [0] });
  guard.recordChildProcessGone(GPU_DIED);
  assert.equal(state.writes.length, 0, 'one crash is not enough');
  await clock.advance(30_000);
  guard.recordChildProcessGone(GPU_DIED);
  await turns();
  assert.deepEqual(state.writes, [{ disableGpu: true, reason: 'gpu-crashes' }]);
  assert.equal(state.dialogs.length, 1);
  assert.equal(state.dialogs[0].options.message, 'The screen had a problem. GadgetsPOS will use compatibility mode.');
  assert.deepEqual(state.dialogs[0].options.buttons, ['Restart now', 'Later']);
  assert.equal(state.restarts, 1, '"Restart now" relaunches');
});

test('"Later" keeps the flag for the next start and does not restart', async () => {
  const { guard, state } = setup({ answers: [1] });
  guard.recordChildProcessGone(GPU_DIED);
  guard.recordChildProcessGone(GPU_DIED);
  await turns();
  assert.deepEqual(state.writes, [{ disableGpu: true, reason: 'gpu-crashes' }]);
  assert.equal(state.restarts, 0);
});

test('crashes more than a minute apart, clean exits and other processes do not count', async () => {
  const { guard, clock, state } = setup();
  guard.recordChildProcessGone(GPU_DIED);
  await clock.advance(61_000);
  guard.recordChildProcessGone(GPU_DIED);
  guard.recordChildProcessGone({ type: 'GPU', reason: 'clean-exit' });
  guard.recordChildProcessGone({ type: 'Utility', reason: 'crashed' });
  guard.recordChildProcessGone({ type: 'Utility', reason: 'crashed' });
  guard.recordChildProcessGone(undefined);
  await turns();
  assert.equal(state.writes.length, 0);
});

test('the POS page crashing within 20 seconds of the start switches to compatibility mode; a later crash does not', async () => {
  const early = setup({ answers: [1] });
  const startedAt = early.clock.now();
  await early.clock.advance(5_000);
  early.guard.recordRenderProcessGone({ reason: 'crashed' }, startedAt);
  await turns();
  assert.deepEqual(early.state.writes, [{ disableGpu: true, reason: 'renderer-crash-at-start' }]);

  const late = setup();
  const lateStart = late.clock.now();
  await late.clock.advance(25_000);
  late.guard.recordRenderProcessGone({ reason: 'crashed' }, lateStart);
  await turns();
  assert.equal(late.state.writes.length, 0);

  const killed = setup();
  killed.guard.recordRenderProcessGone({ reason: 'killed' }, killed.clock.now());
  killed.guard.recordRenderProcessGone({ reason: 'oom' }, killed.clock.now());
  await turns();
  assert.equal(killed.state.writes.length, 0, 'only crashed, launch-failed and integrity-failure count');
});

test('with the GPU already off (flag or --disable-gpu) the safety net does nothing: there is nothing left to switch off', async () => {
  const { guard, state } = setup({ gpuDisabled: true });
  guard.recordChildProcessGone(GPU_DIED);
  guard.recordChildProcessGone(GPU_DIED);
  guard.recordRenderProcessGone({ reason: 'crashed' }, 0);
  await turns();
  assert.equal(state.writes.length, 0);
  assert.equal(state.dialogs.length, 0);
});

test('the safety net acts once, even when more crashes follow', async () => {
  const { guard, state } = setup({ answers: [1, 1] });
  for (let i = 0; i < 5; i += 1) guard.recordChildProcessGone(GPU_DIED);
  await turns();
  assert.equal(state.writes.length, 1);
  assert.equal(state.dialogs.length, 1);
});

test('when flags.json cannot be written the cashier is not promised a restart that would change nothing', async () => {
  const { guard, state } = setup();
  state.failWrite = true;
  guard.recordChildProcessGone(GPU_DIED);
  guard.recordChildProcessGone(GPU_DIED);
  await turns();
  assert.equal(state.dialogs.length, 0);
  assert.ok(state.logs.some((line) => /flags\.json could not be written \(disk full\)/.test(line)));
});

test('the one-time question is asked once, 20 seconds after the screen is visible, only after an upgrade from v1', async () => {
  const { guard, clock, state } = setup({ answers: [0] });
  assert.equal(guard.scheduleScreenCheck({ migratedFromV1: false }), false, 'a fresh install is not asked');
  assert.equal(guard.scheduleScreenCheck({ migratedFromV1: true }), true);
  assert.equal(guard.scheduleScreenCheck({ migratedFromV1: true }), false, 'one timer only');
  assert.equal(clock.pendingRefed(), 0, 'the timer never keeps the app alive');
  await clock.advance(SCREEN_CHECK_DELAY_MS - 1);
  await turns();
  assert.equal(state.dialogs.length, 0);
  await clock.advance(1);
  await turns();
  assert.equal(state.dialogs.length, 1);
  assert.equal(state.dialogs[0].options.message, 'Does the screen look right?');
  assert.deepEqual(state.dialogs[0].options.buttons, ['Yes', 'No, use compatibility mode']);
  assert.deepEqual(state.writes, [{ gpuChecked: true }], '"Yes" only records that it was answered');
  assert.equal(state.restarts, 0);
});

test('"No, use compatibility mode" writes the flag, records the answer and relaunches', async () => {
  const { guard, clock, state } = setup({ answers: [1] });
  guard.scheduleScreenCheck({ migratedFromV1: true });
  await clock.advance(SCREEN_CHECK_DELAY_MS);
  await turns();
  assert.deepEqual(state.writes, [{ gpuChecked: true, disableGpu: true, reason: 'manual' }]);
  assert.equal(state.restarts, 1);
});

test('the question is never asked again once answered, and not at all when the GPU is already off', async () => {
  const answered = setup({ stored: { gpuChecked: true } });
  assert.equal(answered.guard.scheduleScreenCheck({ migratedFromV1: true }), false);
  const off = setup({ gpuDisabled: true });
  assert.equal(off.guard.scheduleScreenCheck({ migratedFromV1: true }), false);
  await answered.clock.advance(SCREEN_CHECK_DELAY_MS);
  assert.equal(answered.state.dialogs.length, 0);
});

test('the question is skipped when the safety net already took over, and a disposed guard asks nothing', async () => {
  const taken = setup({ answers: [1] });
  taken.guard.scheduleScreenCheck({ migratedFromV1: true });
  taken.guard.recordChildProcessGone(GPU_DIED);
  taken.guard.recordChildProcessGone(GPU_DIED);
  await turns();
  const dialogsBefore = taken.state.dialogs.length;
  await taken.clock.advance(SCREEN_CHECK_DELAY_MS);
  await turns();
  assert.equal(taken.state.dialogs.length, dialogsBefore, 'only the safety-net dialog');

  const disposed = setup();
  disposed.guard.scheduleScreenCheck({ migratedFromV1: true });
  disposed.guard.dispose();
  await disposed.clock.advance(SCREEN_CHECK_DELAY_MS);
  assert.equal(disposed.state.dialogs.length, 0);
});

test('Help > Compatibility mode writes the manual flag and offers a restart; switching it off clears the reason', async () => {
  const on = setup({ answers: [0] });
  assert.equal(await on.guard.setCompatibilityMode(true), true);
  assert.deepEqual(on.state.writes, [{ disableGpu: true, reason: 'manual' }]);
  assert.equal(on.state.restarts, 1);

  const off = setup({ answers: [1], stored: { disableGpu: true, reason: 'manual' } });
  assert.equal(await off.guard.setCompatibilityMode(false), true);
  assert.deepEqual(off.state.writes, [{ disableGpu: false, reason: '' }]);
  assert.equal(off.state.restarts, 0);
});

test('turning compatibility mode off says so when the shortcut forces it with --disable-gpu', async () => {
  const { guard, state } = setup({ argvDisableGpu: true, gpuDisabled: true });
  await guard.setCompatibilityMode(false);
  assert.match(state.dialogs[0].options.detail, /--disable-gpu/);
});

test('an unwritable flags file is reported as false and asks nothing', async () => {
  const { guard, state } = setup();
  state.failWrite = true;
  assert.equal(await guard.setCompatibilityMode(true), false);
  assert.equal(state.dialogs.length, 0);
});

test('compatibilityPatch is the one place that decides what a manual switch writes', () => {
  assert.deepEqual(compatibilityPatch(true), { disableGpu: true, reason: 'manual' });
  assert.deepEqual(compatibilityPatch(false), { disableGpu: false, reason: '' });
  assert.deepEqual(compatibilityPatch('yes'), { disableGpu: false, reason: '' });
});
