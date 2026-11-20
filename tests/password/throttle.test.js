'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createThrottle } = require('../../src/main/password');

const T0 = 1_700_000_000_000;

/** A controllable clock. */
function clock(start = T0) {
  const c = { time: start, now: () => c.time, advance: (ms) => (c.time += ms) };
  return c;
}

test('fresh throttle: allowed, nothing counted, raw state is exactly {failures, lockedUntil, retryAfterSec}', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  assert.deepEqual(throttle.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 5 });
  assert.deepEqual(throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
});

test('four wrong passwords only count down; the fifth locks for 30 seconds (SPEC 10)', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  for (const left of [4, 3, 2, 1]) {
    assert.deepEqual(throttle.fail(), { allowed: true, retryAfterSec: 0, attemptsLeft: left });
  }
  assert.deepEqual(throttle.state(), { failures: 4, lockedUntil: 0, retryAfterSec: 0 });
  assert.deepEqual(throttle.fail(), { allowed: false, retryAfterSec: 30, attemptsLeft: 0 });
  assert.deepEqual(throttle.state(), { failures: 5, lockedUntil: T0 + 30_000, retryAfterSec: 30 });
  assert.equal(throttle.check().allowed, false);
});

test('the lock counts down with the injected clock and rounds the seconds up', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  for (let i = 0; i < 5; i += 1) throttle.fail();
  c.advance(1);
  assert.equal(throttle.check().retryAfterSec, 30, '29.999 s left shows as 30');
  c.advance(9_999);
  assert.equal(throttle.check().retryAfterSec, 20);
  c.advance(19_000);
  assert.equal(throttle.check().retryAfterSec, 1, '1 s left');
  c.advance(999);
  assert.deepEqual(throttle.check(), { allowed: false, retryAfterSec: 1, attemptsLeft: 0 }, '1 ms short of the end still shows 1 and is still locked');
  c.advance(1);
  assert.deepEqual(throttle.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 0 });
  assert.equal(throttle.state().retryAfterSec, 0);
});

test('after the lock ends the count is NOT reset: the next wrong password locks again, for twice as long', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  const locks = [];
  for (let i = 0; i < 5; i += 1) throttle.fail();
  locks.push(throttle.state().retryAfterSec); // 30
  for (let round = 0; round < 4; round += 1) {
    c.advance(throttle.state().retryAfterSec * 1000);
    assert.equal(throttle.check().allowed, true);
    throttle.fail();
    locks.push(throttle.state().retryAfterSec);
  }
  assert.deepEqual(locks, [30, 60, 120, 240, 300], '30, 60, 120, 240 s, then the 5 minute cap (480 s would be next)');
});

test('the lock never exceeds 5 minutes, however many wrong passwords there are', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  for (let i = 0; i < 12; i += 1) throttle.fail();
  assert.equal(throttle.state().retryAfterSec, 300);
  assert.equal(throttle.state().lockedUntil, T0 + 300_000);
  for (let i = 0; i < 3000; i += 1) throttle.fail(); // 2 ** 2995 overflows to Infinity: still capped
  assert.equal(throttle.state().retryAfterSec, 300);
});

test('a correct password resets everything, at any point', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  for (let i = 0; i < 3; i += 1) throttle.fail();
  throttle.success();
  assert.deepEqual(throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
  assert.equal(throttle.check().attemptsLeft, 5);

  for (let i = 0; i < 6; i += 1) throttle.fail();
  assert.equal(throttle.check().allowed, false);
  c.advance(60_000);
  throttle.success();
  assert.deepEqual(throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
  for (let i = 0; i < 4; i += 1) throttle.fail();
  assert.equal(throttle.check().allowed, true, 'the count starts again from zero');
  assert.equal(throttle.fail().retryAfterSec, 30, 'and the first lock is the short one again');
});

test('check() does not count anything and can be called repeatedly', () => {
  const throttle = createThrottle({ now: clock().now });
  for (let i = 0; i < 10; i += 1) throttle.check();
  assert.deepEqual(throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
});

test('a clock set back never locks for longer than the cap', () => {
  const c = clock();
  const throttle = createThrottle({ now: c.now });
  for (let i = 0; i < 5; i += 1) throttle.fail(); // locked until T0 + 30 s
  c.advance(-3_600_000); // someone sets the clock back an hour
  assert.equal(throttle.check().retryAfterSec, 300, 'shortened to the 5 minute cap, not 1 hour 30 seconds');
  assert.equal(throttle.state().lockedUntil, T0 - 3_600_000 + 300_000);
  c.advance(300_000);
  assert.equal(throttle.check().allowed, true);
});

test('all four numbers are configurable', () => {
  const c = clock();
  const throttle = createThrottle({ maxFailures: 3, baseLockMs: 1_000, maxLockMs: 3_500, now: c.now });
  throttle.fail();
  throttle.fail();
  assert.deepEqual(throttle.fail(), { allowed: false, retryAfterSec: 1, attemptsLeft: 0 });
  c.advance(1_000);
  assert.equal(throttle.fail().retryAfterSec, 2);
  c.advance(2_000);
  assert.equal(throttle.fail().retryAfterSec, 4, 'the third lock would be 4 s; it is capped at 3.5 s, which shows as 4 (rounded up)');
  assert.equal(throttle.state().lockedUntil - c.time, 3_500);
});

test('defaults to the real clock', () => {
  const throttle = createThrottle();
  for (let i = 0; i < 5; i += 1) throttle.fail();
  const { lockedUntil } = throttle.state();
  assert.ok(Math.abs(lockedUntil - (Date.now() + 30_000)) < 2_000);
});

test('bad options are programmer errors and are reported at once', () => {
  assert.throws(() => createThrottle({ maxFailures: 0 }), RangeError);
  assert.throws(() => createThrottle({ baseLockMs: -1 }), RangeError);
  assert.throws(() => createThrottle({ maxLockMs: Number.NaN }), RangeError);
  assert.throws(() => createThrottle({ maxFailures: '5' }), RangeError);
  assert.throws(() => createThrottle({ now: 'tomorrow' }), TypeError);
});

// ---------------------------------------------------------------------------------------------
// The monotonic clock: the PC's clock cannot end the lock (red test of tests/verify/security-throttle.test.js)
// ---------------------------------------------------------------------------------------------

/** Two clocks: the wall clock (anyone can set it) and the monotonic one (only time passing moves it). */
function clocks(start = T0) {
  const wall = clock(start);
  const mono = clock(5_000);
  return { wall, mono, options: { now: wall.now, monotonic: mono.now } };
}

test('the lock is kept on the monotonic clock: setting the wall clock forward or back neither ends nor extends it', () => {
  const { wall, mono, options } = clocks();
  const throttle = createThrottle(options);
  for (let i = 0; i < 5; i += 1) throttle.fail();
  assert.equal(throttle.check().retryAfterSec, 30);

  wall.advance(10 * 60_000); // forward: the cashier puts the PC clock ten minutes ahead
  assert.deepEqual(throttle.check(), { allowed: false, retryAfterSec: 30, attemptsLeft: 0 });
  wall.advance(-3_600_000); // back an hour from there
  assert.deepEqual(throttle.check(), { allowed: false, retryAfterSec: 30, attemptsLeft: 0 }, 'not longer either: the cap is not even needed');
  mono.advance(29_999);
  assert.equal(throttle.check().allowed, false);
  mono.advance(1);
  assert.equal(throttle.check().allowed, true, 'only time that really passed ends it');
  assert.equal(throttle.state().lockedUntil, 5_000 + 30_000, 'lockedUntil is on the monotonic clock');
});

test('with no monotonic clock given, the wall clock is used for the deadline (a throttle without a persisted lock)', () => {
  const wall = clock();
  const throttle = createThrottle({ now: wall.now });
  for (let i = 0; i < 5; i += 1) throttle.fail();
  wall.advance(30_000);
  assert.equal(throttle.check().allowed, true);
});

// ---------------------------------------------------------------------------------------------
// Persistence: a restart does not give five new guesses
// ---------------------------------------------------------------------------------------------

/** A throttle over a store that remembers the last record, like config.json does. */
function withStore(start, saved = null) {
  const c = clocks(start);
  const store = { value: saved, writes: [] };
  const options = {
    ...c.options,
    load: () => store.value,
    save: (record) => {
      store.writes.push(record);
      store.value = record;
    },
  };
  return { ...c, store, options };
}

test('every change is saved as failures, time left and the wall-clock moment; nothing is written when nothing changed', () => {
  const { wall, store, options } = withStore();
  const throttle = createThrottle(options);
  throttle.success();
  throttle.check();
  assert.deepEqual(store.writes, [], 'a correct password with nothing to clear writes nothing (every drawer opening calls it)');

  for (let i = 0; i < 4; i += 1) throttle.fail();
  assert.deepEqual(store.writes.at(-1), { failures: 4, remainingMs: 0, writtenAt: T0 });
  wall.advance(7);
  throttle.fail();
  assert.deepEqual(store.writes.at(-1), { failures: 5, remainingMs: 30_000, writtenAt: T0 + 7 });
  assert.equal(store.writes.length, 5);
  throttle.success();
  assert.equal(store.writes.at(-1), null, 'a correct password removes the record');
});

test('a restart keeps the count and the time left: five wrong passwords, quit, start again: still locked, for what is left of the 30 s', () => {
  const first = withStore();
  const before = createThrottle(first.options);
  for (let i = 0; i < 5; i += 1) before.fail();

  // The app is closed for 10 s of real time, then started again. A new process: a new monotonic clock.
  const second = withStore(T0 + 10_000, first.store.value);
  const after = createThrottle(second.options);
  assert.deepEqual(after.check(), { allowed: false, retryAfterSec: 20, attemptsLeft: 0 });
  second.mono.advance(19_999);
  assert.equal(after.check().allowed, false);
  second.mono.advance(1);
  assert.equal(after.check().allowed, true);
  assert.equal(after.fail().retryAfterSec, 60, 'the count was kept too: the next wrong password locks for the second step');
});

test('a restart keeps a count that has not locked yet: three wrong, restart, two more wrong lock', () => {
  const first = withStore();
  const before = createThrottle(first.options);
  for (let i = 0; i < 3; i += 1) before.fail();
  const after = createThrottle(withStore(T0 + 60_000, first.store.value).options);
  assert.deepEqual(after.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 2 });
  after.fail();
  assert.deepEqual(after.fail(), { allowed: false, retryAfterSec: 30, attemptsLeft: 0 });
});

test('a lock that ran out while the app was closed is gone after the restart; the count of wrong passwords is not', () => {
  const first = withStore();
  const before = createThrottle(first.options);
  for (let i = 0; i < 5; i += 1) before.fail();
  const after = createThrottle(withStore(T0 + 31_000, first.store.value).options);
  assert.deepEqual(after.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 0 });
  assert.equal(after.fail().retryAfterSec, 60);
});

test('a wall clock set BACK while the app was closed never shortens the lock: it keeps what was saved and adds the difference, up to the cap', () => {
  const saved = { failures: 5, remainingMs: 30_000, writtenAt: T0 };
  const fiveSecondsBack = createThrottle(withStore(T0 - 5_000, saved).options);
  assert.equal(fiveSecondsBack.check().retryAfterSec, 35, 'longer than the 30 s that were saved');
  const anHourBack = createThrottle(withStore(T0 - 3_600_000, saved).options);
  assert.equal(anHourBack.check().retryAfterSec, 300, 'the 5 minute cap');
  assert.equal(anHourBack.state().retryAfterSec, 300);
});

test('a wall clock set far FORWARD while the app was closed does shorten the lock (accepted: after a restart only the wall clock is left)', () => {
  const saved = { failures: 5, remainingMs: 30_000, writtenAt: T0 };
  const throttle = createThrottle(withStore(T0 + 3_600_000, saved).options);
  assert.equal(throttle.check().allowed, true);
  assert.equal(throttle.check().attemptsLeft, 0, 'but the count stays');
});

test('a saved record that is not a usable lock is ignored, never thrown on, and never locks for longer than the cap', () => {
  const good = { failures: 5, remainingMs: 30_000, writtenAt: T0 };
  const unusable = [
    null, undefined, 'locked', 42, [], [good], {}, { ...good, failures: 0 }, { ...good, failures: -1 }, { ...good, failures: 1.5 }, { ...good, failures: '5' },
    { ...good, remainingMs: -1 }, { ...good, remainingMs: Number.NaN }, { ...good, remainingMs: '30000' }, { ...good, writtenAt: Number.NaN }, { ...good, writtenAt: Infinity },
    { failures: 5 }, { remainingMs: 30_000, writtenAt: T0 },
  ];
  for (const value of unusable) {
    const throttle = createThrottle(withStore(T0, value).options);
    assert.deepEqual(throttle.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 5 }, JSON.stringify(value));
  }
  const edited = createThrottle(withStore(T0, { failures: 10 ** 15, remainingMs: 10 ** 12, writtenAt: T0 }).options);
  assert.equal(edited.check().retryAfterSec, 300, 'a hand-edited file cannot lock the till for more than 5 minutes');
  assert.equal(edited.fail().retryAfterSec, 300, 'and a huge count does not break the doubling');
});

test('a load that throws starts clean, and a save that throws never breaks a password check', () => {
  const c = clocks();
  const throttle = createThrottle({
    ...c.options,
    load: () => { throw new Error('config is not ready'); },
    save: () => { throw new Error('disk is full'); },
  });
  assert.deepEqual(throttle.check(), { allowed: true, retryAfterSec: 0, attemptsLeft: 5 });
  for (let i = 0; i < 4; i += 1) throttle.fail();
  assert.deepEqual(throttle.fail(), { allowed: false, retryAfterSec: 30, attemptsLeft: 0 }, 'the lock still holds in memory');
  assert.doesNotThrow(() => throttle.success());
});

test('monotonic, load and save must be functions when given', () => {
  assert.throws(() => createThrottle({ monotonic: 'now' }), TypeError);
  assert.throws(() => createThrottle({ load: {} }), TypeError);
  assert.throws(() => createThrottle({ save: 1 }), TypeError);
});
