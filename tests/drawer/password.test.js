'use strict';

/**
 * The password flows of the drawer module (SPEC 10): checkPassword (Settings and factory reset), setPassword,
 * clearPassword, and the ONE throttle that every password check shares.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDrawer } = require('../../src/main/printing/drawer');
const { createHarness, assertFailure, PLAIN, RECORD, errors, password } = require('./harness');

// ---------------------------------------------------------------------------------------------
// checkPassword
// ---------------------------------------------------------------------------------------------

test('checkPassword succeeds when no password is set (there is nothing to protect) and does not touch the throttle', (t) => {
  const h = createHarness(t, { record: null });
  for (const candidate of [undefined, '', 'anything', PLAIN]) {
    assert.deepEqual(h.drawer.checkPassword({ password: candidate }), { ok: true });
  }
  assert.deepEqual(h.drawer.checkPassword(), { ok: true });
  assert.equal(h.throttle.state().failures, 0);
});

test('checkPassword: the right password succeeds and resets earlier failures', (t) => {
  const h = createHarness(t);
  h.drawer.checkPassword({ password: 'wrong' });
  h.drawer.checkPassword({ password: 'wrong' });
  assert.equal(h.throttle.state().failures, 2);
  assert.deepEqual(h.drawer.checkPassword({ password: PLAIN }), { ok: true });
  assert.equal(h.throttle.state().failures, 0);
});

test('checkPassword uses the PASSWORD_* codes: wrong with the attempts left, the fifth also with retryAfterSec', (t) => {
  const h = createHarness(t);
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 4 });
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 3 });
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 2 });
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 1 });
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 0, retryAfterSec: 30 });
  assertFailure(h.drawer.checkPassword({ password: PLAIN }), 'PASSWORD_LOCKED_OUT', { retryAfterSec: 30 });
  h.clock.advance(30_000);
  assert.deepEqual(h.drawer.checkPassword({ password: PLAIN }), { ok: true });
});

test('checkPassword: a missing password is PASSWORD_REQUIRED and is not counted', (t) => {
  const h = createHarness(t);
  for (const request of [undefined, {}, { password: '' }, { password: null }, { password: 1234 }, null]) {
    assertFailure(h.drawer.checkPassword(request), 'PASSWORD_REQUIRED');
  }
  assert.equal(h.throttle.state().failures, 0);
});

// ---------------------------------------------------------------------------------------------
// The throttle is shared by every check (SPEC 10)
// ---------------------------------------------------------------------------------------------

test('wrong passwords from the drawer, Settings and change-password all count towards ONE lock, which applies to all of them', async (t) => {
  const h = createHarness(t);
  await h.drawer.open({ password: 'wrong' });
  h.drawer.checkPassword({ password: 'wrong' });
  h.drawer.setPassword({ current: 'wrong', next: 'abcd' });
  h.drawer.clearPassword({ current: 'wrong' });
  assert.equal(h.throttle.state().failures, 4);
  assertFailure(h.drawer.checkPassword({ password: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 0, retryAfterSec: 30 });

  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
  assertFailure(h.drawer.checkPassword({ password: PLAIN }), 'PASSWORD_LOCKED_OUT', { retryAfterSec: 30 });
  assertFailure(h.drawer.setPassword({ current: PLAIN, next: 'abcd' }), 'PASSWORD_LOCKED_OUT', { retryAfterSec: 30 });
  assertFailure(h.drawer.clearPassword({ current: PLAIN }), 'PASSWORD_LOCKED_OUT', { retryAfterSec: 30 });
  assert.equal(h.rawPrinter.calls.length, 0);
  assert.equal(h.config.publicState().drawer.passwordSet, true, 'the password is unchanged');
});

test('a correct password anywhere resets the count for everything', async (t) => {
  const h = createHarness(t);
  await h.drawer.open({ password: 'wrong' });
  h.drawer.checkPassword({ password: 'wrong' });
  assert.deepEqual(h.drawer.checkPassword({ password: PLAIN }), { ok: true });
  assert.equal(h.throttle.state().failures, 0);
  for (let i = 0; i < 4; i += 1) await h.drawer.open({ password: 'wrong' });
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true, 'four wrong ones are still not a lock');
});

// ---------------------------------------------------------------------------------------------
// setPassword
// ---------------------------------------------------------------------------------------------

test('the first password needs no current one; it is stored hashed, as a strong password, in one write', (t) => {
  const h = createHarness(t, { record: null });
  const writes = h.env.stats.writes;
  assert.deepEqual(h.drawer.setPassword({ next: 'abcd' }), { ok: true });
  assert.equal(h.env.stats.writes, writes + 1);
  const record = h.config.get('drawer.passwordRecord');
  assert.equal(password.verifyPassword('abcd', record), true);
  assert.equal(record.algo, 'scrypt');
  assert.equal(h.config.get('drawer.passwordWeak'), false);
  assert.equal(h.config.publicState().drawer.passwordSet, true);
  assert.ok(!h.env.readText().includes('"abcd"'), 'the password itself is not in the file');
  assert.equal(h.throttle.state().failures, 0);
});

test('the first password may come with a current one that is simply ignored', (t) => {
  const h = createHarness(t, { record: null });
  assert.deepEqual(h.drawer.setPassword({ current: 'whatever', next: 'abcd' }), { ok: true });
  assert.equal(h.throttle.state().failures, 0, 'nothing was checked, so nothing was counted');
});

test('a new password must follow the policy: 4 to 64 characters; the message says what to change; nothing is stored', (t) => {
  const h = createHarness(t, { record: null });
  const writes = h.env.stats.writes;
  const short = h.drawer.setPassword({ next: 'abc' });
  assert.equal(short.ok, false);
  assert.equal(short.code, 'PASSWORD_TOO_SHORT');
  assert.equal(short.message, password.validatePasswordPolicy('abc').message);

  const long = h.drawer.setPassword({ next: 'x'.repeat(65) });
  assert.equal(long.code, 'INVALID_SETTINGS');
  assert.equal(long.message, password.validatePasswordPolicy('x'.repeat(65)).message);

  for (const next of [undefined, '', null, 1234, {}]) assert.equal(h.drawer.setPassword({ next }).code, 'PASSWORD_REQUIRED', String(next));
  assert.equal(h.drawer.setPassword().code, 'PASSWORD_REQUIRED');
  assert.equal(h.drawer.setPassword(null).code, 'PASSWORD_REQUIRED');
  assert.equal(h.env.stats.writes, writes);
  assert.equal(h.config.publicState().drawer.passwordSet, false);

  assert.deepEqual(h.drawer.setPassword({ next: 'x'.repeat(64) }), { ok: true }, '64 is fine');
});

test('the policy applies to the 4..64 length only: spaces and symbols are fine, and nothing is trimmed', (t) => {
  const h = createHarness(t, { record: null });
  assert.deepEqual(h.drawer.setPassword({ next: ' a b ' }), { ok: true });
  assert.equal(password.verifyPassword(' a b ', h.config.get('drawer.passwordRecord')), true);
  assert.equal(password.verifyPassword('a b', h.config.get('drawer.passwordRecord')), false);
});

test('changing the password needs the current one: missing is PASSWORD_REQUIRED, wrong is PASSWORD_WRONG (and counted)', (t) => {
  const h = createHarness(t);
  assertFailure(h.drawer.setPassword({ next: 'abcd' }), 'PASSWORD_REQUIRED');
  assertFailure(h.drawer.setPassword({ current: '', next: 'abcd' }), 'PASSWORD_REQUIRED');
  assert.equal(h.throttle.state().failures, 0, 'missing is not counted');
  assertFailure(h.drawer.setPassword({ current: 'wrong', next: 'abcd' }), 'PASSWORD_WRONG', { attemptsLeft: 4 });
  assert.equal(h.throttle.state().failures, 1);
  assert.deepEqual(h.config.get('drawer.passwordRecord'), RECORD, 'unchanged');
});

test('changing the password with the right current one: the new password works, the old one does not', async (t) => {
  const h = createHarness(t);
  assert.deepEqual(h.drawer.setPassword({ current: PLAIN, next: 'brand-new-pw' }), { ok: true });
  assert.equal(password.verifyPassword('brand-new-pw', h.config.get('drawer.passwordRecord')), true);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 4 });
  assert.equal((await h.drawer.open({ password: 'brand-new-pw' })).ok, true);
  assert.equal(h.rawPrinter.calls.length, 1);
});

test('a right current password with a new one that breaks the policy changes nothing; the old password still works', async (t) => {
  const h = createHarness(t);
  const result = h.drawer.setPassword({ current: PLAIN, next: '12' });
  assert.equal(result.code, 'PASSWORD_TOO_SHORT');
  assert.deepEqual(h.config.get('drawer.passwordRecord'), RECORD);
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
});

test('a "weak" migrated password (SPEC 5.2) is cleared by choosing a new one that follows the policy', (t) => {
  const h = createHarness(t, { record: password.hashPassword('12') });
  h.config.set('drawer.passwordWeak', true);
  assert.equal(h.config.publicState().drawer.passwordWeak, true);
  assert.deepEqual(h.drawer.setPassword({ current: '12', next: 'a-proper-one' }), { ok: true });
  assert.equal(h.config.get('drawer.passwordWeak'), false);
  assert.equal(h.config.publicState().drawer.passwordWeak, false);
});

test('changing the password keeps "require the password for Settings" switched on', (t) => {
  const h = createHarness(t);
  h.config.setDrawer({ requirePasswordForSettings: true });
  assert.deepEqual(h.drawer.setPassword({ current: PLAIN, next: 'another-one' }), { ok: true });
  assert.equal(h.config.get('drawer.requirePasswordForSettings'), true);
});

test('a failing disk while saving the password: a Result, and the old password stays', (t) => {
  const h = createHarness(t);
  h.env.failWrite();
  const result = h.drawer.setPassword({ current: PLAIN, next: 'another-one' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.deepEqual(h.config.get('drawer.passwordRecord'), RECORD);
});

// ---------------------------------------------------------------------------------------------
// clearPassword
// ---------------------------------------------------------------------------------------------

test('clearPassword needs the current password; the right one removes the password, the weak flag and "require for Settings"', async (t) => {
  const h = createHarness(t);
  h.config.setDrawer({ requirePasswordForSettings: true });
  h.config.set('drawer.passwordWeak', true);
  assert.deepEqual(h.drawer.clearPassword({ current: PLAIN }), { ok: true });
  assert.equal(h.config.get('drawer.passwordRecord'), null);
  assert.equal(h.config.get('drawer.passwordWeak'), false);
  assert.equal(h.config.get('drawer.requirePasswordForSettings'), false);
  assert.equal(h.config.publicState().drawer.passwordSet, false);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_PASSWORD_NOT_SET');
  assert.deepEqual(h.drawer.checkPassword({ password: 'anything' }), { ok: true }, 'nothing left to ask for');
});

test('clearPassword with a missing or wrong current password keeps the password', (t) => {
  const h = createHarness(t);
  assertFailure(h.drawer.clearPassword({}), 'PASSWORD_REQUIRED');
  assertFailure(h.drawer.clearPassword(), 'PASSWORD_REQUIRED');
  assertFailure(h.drawer.clearPassword(null), 'PASSWORD_REQUIRED');
  assertFailure(h.drawer.clearPassword({ current: 'wrong' }), 'PASSWORD_WRONG', { attemptsLeft: 4 });
  assert.deepEqual(h.config.get('drawer.passwordRecord'), RECORD);
});

test('clearPassword when no password is set is a harmless success', (t) => {
  const h = createHarness(t, { record: null });
  const writes = h.env.stats.writes;
  assert.deepEqual(h.drawer.clearPassword({ current: 'x' }), { ok: true });
  assert.deepEqual(h.drawer.clearPassword(), { ok: true });
  assert.equal(h.env.stats.writes, writes);
});

test('a failing disk while removing the password: a Result, and the password stays', (t) => {
  const h = createHarness(t);
  h.env.failWrite();
  const result = h.drawer.clearPassword({ current: PLAIN });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.deepEqual(h.config.get('drawer.passwordRecord'), RECORD);
});

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

test('no flow logs a password or a hash', (t) => {
  const h = createHarness(t);
  h.drawer.checkPassword({ password: 'guess-aaa-1' });
  h.drawer.setPassword({ current: 'guess-bbb-2', next: 'new-secret-3' });
  h.drawer.setPassword({ current: PLAIN, next: 'new-secret-3' });
  h.drawer.clearPassword({ current: 'guess-ccc-4' });
  h.drawer.clearPassword({ current: 'new-secret-3' });
  const text = h.log.text();
  assert.ok(text.length > 0);
  for (const secret of ['guess-aaa-1', 'guess-bbb-2', 'guess-ccc-4', 'new-secret-3', RECORD.hash, RECORD.salt]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /password changed/);
  assert.match(text, /password removed/);
});

test('an unexpected exception in a flow is an UNKNOWN Result, never a throw', (t) => {
  const h = createHarness(t);
  const exploding = createDrawer({
    config: h.config,
    rawPrinter: h.rawPrinter,
    password: { ...password, verifyPassword: () => { throw new Error('verify exploded'); }, hashPassword: () => { throw new Error('hash exploded'); } },
    throttle: h.throttle,
    log: h.log,
  });
  for (const result of [exploding.checkPassword({ password: PLAIN }), exploding.setPassword({ current: PLAIN, next: 'abcd' }), exploding.clearPassword({ current: PLAIN })]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, errors.ERROR_CODES.UNKNOWN);
  }
  assert.match(h.log.text(), /verify exploded/);

  const noPassword = createHarness(t, { record: null });
  const hashFails = createDrawer({
    config: noPassword.config,
    rawPrinter: noPassword.rawPrinter,
    password: { ...password, hashPassword: () => { throw new Error('hash exploded'); } },
    throttle: noPassword.throttle,
    log: noPassword.log,
  });
  assert.equal(hashFails.setPassword({ next: 'abcd' }).code, 'UNKNOWN');
  assert.equal(noPassword.config.publicState().drawer.passwordSet, false);
});

test('a created password is a real scrypt record that survives a restart of the config', (t) => {
  const h = createHarness(t, { record: null });
  h.drawer.setPassword({ next: 'survives-restart' });
  const { createConfig } = require('../../src/main/config');
  const reopened = createConfig({ Store: h.env.Store, log: h.log });
  assert.equal(password.verifyPassword('survives-restart', reopened.get('drawer.passwordRecord')), true);
  assert.equal(reopened.publicState().drawer.passwordSet, true);
});

// ---------------------------------------------------------------------------------------------
// A candidate of any size from the web page (SPEC 12)
// ---------------------------------------------------------------------------------------------

test('a candidate longer than 4096 characters is a wrong password: counted towards the lock, never hashed, with the same answer as any other wrong one', async (t) => {
  const crypto = require('node:crypto');
  const h = createHarness(t);
  const spy = t.mock.method(crypto, 'scryptSync');
  const huge = 'x'.repeat(5000);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assertFailure(await h.drawer.open({ password: huge }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 5 - attempt });
  }
  assertFailure(await h.drawer.open({ password: huge }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 0, retryAfterSec: 30 });
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
  assert.equal(spy.mock.callCount(), 0, 'scrypt was never asked to read an oversized candidate');
  assert.equal(h.rawPrinter.calls.length, 0);
});
