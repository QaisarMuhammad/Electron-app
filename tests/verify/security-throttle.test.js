'use strict';

/**
 * SECURITY lens, the password throttle (SPEC 10). Five wrong passwords lock EVERY password check (the drawer, change password,
 * Settings, reset): the throttle itself is shared by all entry points and the checks run synchronously, so parallel calls cannot
 * interleave (verified: see "all entry points" below). But the lock is a deadline on the WALL clock (`Date.now`), wired in
 * src/main/index.js as `createThrottle({ now: clock.now })`. Whoever can move the system clock forward (or simply restart the
 * app: the counters are process memory) gets five new guesses every time. A monotonic clock would not care about the first, and
 * is a smaller change than persisting the lock.
 *
 * The test boots the real `bootstrap()` (fake Electron, real throttle, drawer, IPC table) with the clock wired as in production,
 * `now` = the wall clock, and moves that clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBootWorld } = require('../helpers/fake-boot');

const PASSWORD = 'Correct-Horse-9';

/** A booted app whose `clock.now` is a wall clock that the test can move (timers stay fake and deterministic). */
async function bootWithMovableWallClock() {
  let offset = 0;
  const world = createBootWorld();
  world.overrides.clock = { ...world.overrides.clock, now: () => Date.now() + offset };
  await world.boot();
  await world.settle();
  assert.equal(world.services().drawer.setPassword({ next: PASSWORD }).ok, true);
  const openDrawer = (password) => world.ipc.invoke('open-drawer', world.events.pos(), { password });
  return { world, openDrawer, moveClock: (ms) => { offset += ms; } };
}

test('five wrong drawer passwords lock the drawer, and the lock survives a change of the system clock', async (t) => {
  const { world, openDrawer, moveClock } = await bootWithMovableWallClock();
  t.after(() => world.cleanup());

  for (let i = 0; i < 5; i += 1) assert.equal((await openDrawer(`wrong-${i}`)).code, 'DRAWER_WRONG_PASSWORD');
  const locked = await openDrawer(PASSWORD);
  assert.equal(locked.code, 'DRAWER_LOCKED_OUT', 'the right password is refused while the lock is on');
  assert.ok(locked.details.retryAfterSec > 0);

  moveClock(10 * 60 * 1000); // the cashier sets the PC clock ten minutes forward
  const after = await openDrawer(PASSWORD);
  assert.equal(after.code, 'DRAWER_LOCKED_OUT', 'a clock that jumps forward must not end the lock: it ended after 0 ms of real time');
});

test('all entry points share the lock: the drawer, the Settings reset and the password change refuse during it (regression guard)', async (t) => {
  const { world, openDrawer } = await bootWithMovableWallClock();
  t.after(() => world.cleanup());

  // five wrong guesses at the same moment, through two different doors, in parallel
  const results = await Promise.all([
    openDrawer('a'), openDrawer('b'), world.services().desktopApi.resetAll({ password: 'c' }), world.services().desktopApi.setDrawerPassword({ current: 'd', next: 'Another-Pass-1' }), openDrawer('e'),
  ]);
  assert.ok(results.every((result) => result.ok === false));
  const doors = await Promise.all([
    openDrawer(PASSWORD),
    world.services().desktopApi.resetAll({ password: PASSWORD }),
    world.services().desktopApi.setDrawerPassword({ current: PASSWORD, next: 'Another-Pass-1' }),
    world.services().desktopApi.saveDrawerSettings({ password: PASSWORD, enabled: true }),
  ]);
  assert.deepEqual(doors.map((result) => result.code), ['DRAWER_LOCKED_OUT', 'PASSWORD_LOCKED_OUT', 'PASSWORD_LOCKED_OUT', 'PASSWORD_LOCKED_OUT']);
});
