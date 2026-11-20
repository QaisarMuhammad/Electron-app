'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_FLAGS,
  REASONS,
  fallbackReason,
  shouldFallBackToSoftware,
  resolveGpuDisabled,
} = require('../../src/main/flags');

const T0 = 1_700_000_000_000;
const SECOND = 1000;

const gpuGone = (at, reason = 'crashed', processType = 'GPU') => ({ event: 'child-process-gone', processType, reason, at });
const rendererGone = (at, startedAt, reason = 'crashed') => ({ event: 'render-process-gone', reason, at, startedAt });

// ---------------------------------------------------------------------------------------------
// Two GPU crashes within 60 s
// ---------------------------------------------------------------------------------------------

test('nothing happened: no fallback', () => {
  assert.equal(shouldFallBackToSoftware([], T0), false);
  assert.equal(fallbackReason([], T0), null);
});

test('events that are not a list, or entries that are not objects, are ignored', () => {
  for (const events of [undefined, null, 'crash', 42, {}]) {
    assert.equal(shouldFallBackToSoftware(events, T0), false, String(events));
  }
  assert.equal(shouldFallBackToSoftware([null, undefined, 'x', 42, gpuGone(T0)], T0), false);
  assert.equal(shouldFallBackToSoftware([null, gpuGone(T0), 7, gpuGone(T0 + SECOND)], T0 + SECOND), true);
});

test('one GPU crash is not enough', () => {
  assert.equal(shouldFallBackToSoftware([gpuGone(T0)], T0), false);
});

test('two GPU crashes within 60 s switch to compatibility mode', () => {
  const events = [gpuGone(T0), gpuGone(T0 + 30 * SECOND)];
  assert.equal(shouldFallBackToSoftware(events, T0 + 30 * SECOND), true);
  assert.equal(fallbackReason(events, T0 + 30 * SECOND), REASONS.GPU_CRASHES);
});

test('the 60 second window: exactly 60 s counts, one millisecond more does not', () => {
  assert.equal(shouldFallBackToSoftware([gpuGone(T0), gpuGone(T0 + 60 * SECOND)], T0 + 60 * SECOND), true);
  assert.equal(shouldFallBackToSoftware([gpuGone(T0), gpuGone(T0 + 60 * SECOND + 1)], T0 + 60 * SECOND + 1), false);
});

test('crashes that are further apart than 60 s never add up, however many there are', () => {
  const events = [gpuGone(T0), gpuGone(T0 + 61 * SECOND), gpuGone(T0 + 122 * SECOND), gpuGone(T0 + 183 * SECOND)];
  assert.equal(shouldFallBackToSoftware(events, T0 + 183 * SECOND), false);
});

test('an old crash falls out of the window: only crashes in the last 60 s count', () => {
  const events = [gpuGone(T0), gpuGone(T0 + 100 * SECOND), gpuGone(T0 + 110 * SECOND)];
  assert.equal(shouldFallBackToSoftware(events, T0 + 110 * SECOND), true, 'the last two are 10 s apart');
  assert.equal(shouldFallBackToSoftware(events.slice(0, 2), T0 + 100 * SECOND), false, 'the first two are 100 s apart');
});

test('a clean exit of the GPU process is not a crash', () => {
  assert.equal(shouldFallBackToSoftware([gpuGone(T0, 'clean-exit'), gpuGone(T0 + SECOND, 'clean-exit')], T0 + SECOND), false);
  assert.equal(shouldFallBackToSoftware([gpuGone(T0, 'clean-exit'), gpuGone(T0 + SECOND, 'crashed')], T0 + SECOND), false);
});

test('every other reason counts: crashed, abnormal-exit, killed, oom, launch-failed, integrity-failure', () => {
  for (const reason of ['crashed', 'abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure']) {
    assert.equal(shouldFallBackToSoftware([gpuGone(T0, reason), gpuGone(T0 + SECOND, reason)], T0 + SECOND), true, reason);
  }
});

test('only the GPU process counts, not utility, network or plugin processes', () => {
  assert.equal(shouldFallBackToSoftware([gpuGone(T0, 'crashed', 'Utility'), gpuGone(T0 + SECOND, 'crashed', 'Utility')], T0 + SECOND), false);
  assert.equal(shouldFallBackToSoftware([gpuGone(T0), gpuGone(T0 + SECOND, 'crashed', 'Utility')], T0 + SECOND), false);
  assert.equal(shouldFallBackToSoftware([gpuGone(T0, 'crashed', 'gpu'), gpuGone(T0 + SECOND, 'crashed', 'Gpu')], T0 + SECOND), true, 'the type is compared without regard to case');
  const untyped = (at) => ({ event: 'child-process-gone', reason: 'crashed', at });
  assert.equal(shouldFallBackToSoftware([untyped(T0), untyped(T0 + SECOND)], T0 + SECOND), false, 'no process type at all');
});

test('a renderer event is not a GPU event, and the other way round', () => {
  assert.equal(shouldFallBackToSoftware([{ ...gpuGone(T0), event: 'render-process-gone' }, gpuGone(T0 + SECOND)], T0 + SECOND), false);
  assert.equal(shouldFallBackToSoftware([gpuGone(T0), gpuGone(T0 + SECOND), { event: 'something-else', processType: 'GPU', reason: 'crashed', at: T0 }], T0 + SECOND), true);
});

test('events without a usable timestamp are ignored', () => {
  for (const at of [undefined, null, Number.NaN, '1700000000000', Infinity]) {
    assert.equal(shouldFallBackToSoftware([gpuGone(T0), { ...gpuGone(T0), at }], T0 + SECOND), false, String(at));
  }
});

test('an event stamped slightly in the future (clock adjustment) still counts as recent', () => {
  assert.equal(shouldFallBackToSoftware([gpuGone(T0 + 5 * SECOND), gpuGone(T0 + 6 * SECOND)], T0), true);
});

test('the decision does not change the events it is given', () => {
  const events = Object.freeze([Object.freeze(gpuGone(T0)), Object.freeze(gpuGone(T0 + SECOND))]);
  assert.equal(shouldFallBackToSoftware(events, T0 + SECOND), true);
});

// ---------------------------------------------------------------------------------------------
// A POS renderer crash within 20 s of its start
// ---------------------------------------------------------------------------------------------

test('a renderer crash 5 s after the window started switches to compatibility mode', () => {
  const events = [rendererGone(T0 + 5 * SECOND, T0)];
  assert.equal(shouldFallBackToSoftware(events, T0 + 5 * SECOND), true);
  assert.equal(fallbackReason(events, T0 + 5 * SECOND), REASONS.RENDERER_CRASH_AT_START);
});

test('the 20 second window: exactly 20 s counts, one millisecond more does not, and a crash at start (0 ms) counts', () => {
  assert.equal(shouldFallBackToSoftware([rendererGone(T0 + 20 * SECOND, T0)], T0 + 20 * SECOND), true);
  assert.equal(shouldFallBackToSoftware([rendererGone(T0 + 20 * SECOND + 1, T0)], T0 + 20 * SECOND + 1), false);
  assert.equal(shouldFallBackToSoftware([rendererGone(T0, T0)], T0), true);
});

test('a renderer crash later in the session is an ordinary crash and does not change the rendering mode', () => {
  assert.equal(shouldFallBackToSoftware([rendererGone(T0 + 10 * 60 * SECOND, T0)], T0 + 10 * 60 * SECOND), false);
});

test('which renderer reasons count: crashed, launch-failed, integrity-failure; not oom, killed, clean-exit, abnormal-exit', () => {
  for (const reason of ['crashed', 'launch-failed', 'integrity-failure']) {
    assert.equal(shouldFallBackToSoftware([rendererGone(T0 + SECOND, T0, reason)], T0 + SECOND), true, reason);
  }
  for (const reason of ['oom', 'killed', 'clean-exit', 'abnormal-exit', '']) {
    assert.equal(shouldFallBackToSoftware([rendererGone(T0 + SECOND, T0, reason)], T0 + SECOND), false, String(reason));
  }
  assert.equal(shouldFallBackToSoftware([{ event: 'render-process-gone', at: T0 + SECOND, startedAt: T0 }], T0 + SECOND), false, 'no reason at all');
});

test('a renderer event needs a start time, and the crash cannot be before the start', () => {
  assert.equal(shouldFallBackToSoftware([{ event: 'render-process-gone', reason: 'crashed', at: T0 }], T0), false, 'no startedAt');
  assert.equal(shouldFallBackToSoftware([rendererGone(T0, T0 + 5 * SECOND)], T0), false, 'before the start');
  assert.equal(shouldFallBackToSoftware([rendererGone(Number.NaN, T0)], T0), false);
  assert.equal(shouldFallBackToSoftware([rendererGone(T0, Number.NaN)], T0), false);
});

test('a child-process-gone event is not a renderer crash even with the same fields', () => {
  assert.equal(shouldFallBackToSoftware([{ ...rendererGone(T0 + SECOND, T0), event: 'child-process-gone', processType: 'Utility' }], T0 + SECOND), false);
});

test('when both rules apply the GPU reason is reported; either one alone gives its own reason', () => {
  const gpu = [gpuGone(T0 + SECOND), gpuGone(T0 + 2 * SECOND)];
  const renderer = [rendererGone(T0 + 3 * SECOND, T0)];
  assert.equal(fallbackReason([...gpu, ...renderer], T0 + 3 * SECOND), REASONS.GPU_CRASHES);
  assert.equal(fallbackReason(gpu, T0 + 3 * SECOND), REASONS.GPU_CRASHES);
  assert.equal(fallbackReason(renderer, T0 + 3 * SECOND), REASONS.RENDERER_CRASH_AT_START);
});

test('shouldFallBackToSoftware answers a real boolean', () => {
  assert.strictEqual(shouldFallBackToSoftware([], T0), false);
  assert.strictEqual(shouldFallBackToSoftware([rendererGone(T0, T0)], T0), true);
});

test('the reasons are stable strings the Settings screen can map to plain English', () => {
  assert.deepEqual({ ...REASONS }, { GPU_CRASHES: 'gpu-crashes', RENDERER_CRASH_AT_START: 'renderer-crash-at-start', MANUAL: 'manual' });
  assert.ok(Object.isFrozen(REASONS));
});

// ---------------------------------------------------------------------------------------------
// --disable-gpu always wins
// ---------------------------------------------------------------------------------------------

test('resolveGpuDisabled: the --disable-gpu argument always wins, whatever flags.json says', () => {
  assert.equal(resolveGpuDisabled({ argv: ['GadgetsPOS.exe', '--disable-gpu'], flags: { ...DEFAULT_FLAGS, disableGpu: false } }), true);
  assert.equal(resolveGpuDisabled({ argv: ['--disable-gpu'], flags: { ...DEFAULT_FLAGS, disableGpu: true } }), true);
  assert.equal(resolveGpuDisabled({ argv: ['--disable-gpu'], flags: DEFAULT_FLAGS }), true);
  assert.equal(resolveGpuDisabled({ argv: ['--disable-gpu'] }), true);
});

test('resolveGpuDisabled: without the argument the disableGpu flag decides', () => {
  assert.equal(resolveGpuDisabled({ argv: ['GadgetsPOS.exe'], flags: { ...DEFAULT_FLAGS, disableGpu: true } }), true);
  assert.equal(resolveGpuDisabled({ argv: ['GadgetsPOS.exe'], flags: { ...DEFAULT_FLAGS, disableGpu: false } }), false);
  assert.equal(resolveGpuDisabled({ argv: [], flags: DEFAULT_FLAGS }), false);
});

test('resolveGpuDisabled: hardware acceleration is on by default', () => {
  assert.equal(resolveGpuDisabled({}), false);
  assert.equal(resolveGpuDisabled(), false);
  assert.equal(resolveGpuDisabled({ argv: undefined, flags: undefined }), false);
});

test('resolveGpuDisabled: only the exact argument counts, and only a real boolean true in the flags', () => {
  for (const argument of ['--disable-gpu-sandbox', '--disable-gpu-compositing', '--disable-gpu=1', '--Disable-Gpu', 'disable-gpu', '-disable-gpu', '--enable-gpu']) {
    assert.equal(resolveGpuDisabled({ argv: [argument], flags: DEFAULT_FLAGS }), false, argument);
  }
  for (const value of ['true', 'yes', 1, {}, [true]]) {
    assert.equal(resolveGpuDisabled({ argv: [], flags: { disableGpu: value } }), false, String(value));
  }
  assert.equal(resolveGpuDisabled({ argv: [], flags: null }), false);
});

test('resolveGpuDisabled: argv that is not a list is ignored', () => {
  for (const argv of ['--disable-gpu', 42, { includes: () => true }, null]) {
    assert.equal(resolveGpuDisabled({ argv, flags: DEFAULT_FLAGS }), false, String(argv));
  }
});

test('resolveGpuDisabled answers a real boolean', () => {
  assert.strictEqual(resolveGpuDisabled({ argv: ['--disable-gpu'] }), true);
  assert.strictEqual(resolveGpuDisabled({ argv: [] }), false);
  assert.strictEqual(resolveGpuDisabled({ flags: null }), false);
});
