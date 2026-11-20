'use strict';

/**
 * drawer.open(): the decision table of SPEC 10, in order:
 *   disabled -> no password set -> locked out -> no password given -> wrong password (counted) -> the pulse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDrawer } = require('../../src/main/printing/drawer');
const { createHarness, assertFailure, PLAIN, RECORD, errors, password } = require('./harness');

const hex = (buffer) => Buffer.from(buffer).toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1 ');

// ---------------------------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------------------------

test('the right password opens the drawer: one job to the receipt printer with the v1 bytes 1B 70 00 19 FF', async (t) => {
  const h = createHarness(t);
  const result = await h.drawer.open({ password: PLAIN, source: 'menu' });
  assert.equal(result.ok, true);
  assert.equal(h.rawPrinter.calls.length, 1);
  const [job] = h.rawPrinter.calls;
  assert.deepEqual(job.target, { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.equal(hex(job.data), '1B 70 00 19 FF');
  assert.equal(job.label, 'cash drawer');
  assert.ok(h.log.entries.some((e) => e.level === 'info') && /opened \(menu\)/.test(h.log.text()));
});

test('a legacy printer port is passed through as the target of the pulse', async (t) => {
  const h = createHarness(t, { printer: { transport: 'port', printerName: 'old name', port: '\\\\localhost\\EpsonTM' } });
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.deepEqual(h.rawPrinter.calls[0].target, { transport: 'port', printerName: 'old name', port: '\\\\localhost\\EpsonTM' });
});

test('the configured pin and pulse lengths are used', async (t) => {
  const h = createHarness(t);
  h.config.setDrawer({ pin: 5, onTimeMs: 100, offTimeMs: 400 });
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.equal(hex(h.rawPrinter.calls[0].data), '1B 70 01 32 C8');
});

test('a setting changed in Settings applies to the very next open (the config is read each time)', async (t) => {
  const h = createHarness(t);
  await h.drawer.open({ password: PLAIN });
  h.config.setPrinter('receipt', { transport: 'system', printerName: 'Another printer' });
  await h.drawer.open({ password: PLAIN });
  assert.equal(h.rawPrinter.calls[1].target.printerName, 'Another printer');
});

test('success resets the throttle', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 3; i += 1) await h.drawer.open({ password: 'wrong' });
  assert.equal(h.throttle.state().failures, 3);
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.deepEqual(h.throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
  for (let i = 0; i < 4; i += 1) assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 4 - i });
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true, 'four more wrong ones after a success do not lock');
});

// ---------------------------------------------------------------------------------------------
// Refused before the password is looked at
// ---------------------------------------------------------------------------------------------

test('DRAWER_DISABLED when the drawer is switched off: nothing is sent and the throttle is untouched', async (t) => {
  const h = createHarness(t);
  h.config.setDrawer({ enabled: false });
  for (const candidate of [PLAIN, 'wrong', undefined]) {
    assertFailure(await h.drawer.open({ password: candidate }), 'DRAWER_DISABLED');
  }
  assert.equal(h.rawPrinter.calls.length, 0);
  assert.deepEqual(h.throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
});

test('DRAWER_PASSWORD_NOT_SET when no password exists: nothing is sent and the throttle is untouched', async (t) => {
  const h = createHarness(t, { record: null });
  for (const candidate of [PLAIN, 'wrong', undefined, '']) {
    assertFailure(await h.drawer.open({ password: candidate }), 'DRAWER_PASSWORD_NOT_SET');
  }
  assert.equal(h.rawPrinter.calls.length, 0);
  assert.equal(h.throttle.state().failures, 0);
});

test('the order is: disabled, then no password set, then locked out', async (t) => {
  const h = createHarness(t, { record: null });
  for (let i = 0; i < 5; i += 1) h.throttle.fail();
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_PASSWORD_NOT_SET');
  h.config.setDrawer({ enabled: false });
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_DISABLED');
});

// ---------------------------------------------------------------------------------------------
// Wrong passwords and the lockout
// ---------------------------------------------------------------------------------------------

test('wrong passwords answer DRAWER_WRONG_PASSWORD with the attempts left; the fifth also starts the lock (30 s)', async (t) => {
  const h = createHarness(t);
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 4 });
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 3 });
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 2 });
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 1 });
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 0, retryAfterSec: 30 });
  assert.equal(h.rawPrinter.calls.length, 0, 'no pulse for a wrong password');
});

test('the next attempt is DRAWER_LOCKED_OUT with retryAfterSec, even with the RIGHT password; refused attempts are not counted', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'wrong' });

  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
  assertFailure(await h.drawer.open({ password: 'wrong' }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
  assertFailure(await h.drawer.open({}), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
  assert.equal(h.throttle.state().failures, 5, 'attempts made while locked are not counted');
  assert.equal(h.rawPrinter.calls.length, 0);

  h.clock.advance(10_000);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 20 });
  h.clock.advance(19_999);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 1 });
});

test('after the lock ends the right password opens the drawer and everything is reset', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'wrong' });
  h.clock.advance(30_000);
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.equal(h.rawPrinter.calls.length, 1);
  assert.deepEqual(h.throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 });
});

test('a wrong password right after a lock ended locks again for twice as long: 60 s, 120 s ... capped at 5 minutes', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'wrong' });
  const waits = [];
  for (let round = 0; round < 5; round += 1) {
    h.clock.advance(h.throttle.state().retryAfterSec * 1000);
    const result = await h.drawer.open({ password: 'wrong' });
    assert.equal(result.code, 'DRAWER_WRONG_PASSWORD');
    assert.equal(result.details.attemptsLeft, 0);
    waits.push(result.details.retryAfterSec);
  }
  assert.deepEqual(waits, [60, 120, 240, 300, 300]);
});

test('the lock message tells the cashier how long to wait', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'wrong' });
  const result = await h.drawer.open({ password: PLAIN });
  assert.equal(result.message, errors.userMessage('DRAWER_LOCKED_OUT', { retryAfterSec: 30 }));
  assert.match(result.message, /30/);
});

// ---------------------------------------------------------------------------------------------
// No password given
// ---------------------------------------------------------------------------------------------

test('no password at all is PASSWORD_REQUIRED: it is not a guess, so it is not counted and cannot lock the till', async (t) => {
  const h = createHarness(t);
  const calls = [undefined, {}, { password: undefined }, { password: '' }, { password: null }, { password: 1234 }, { password: {} }, { password: ['1234'] }, null];
  for (let round = 0; round < 3; round += 1) {
    for (const request of calls) assertFailure(await h.drawer.open(request), 'PASSWORD_REQUIRED');
  }
  assert.equal(h.throttle.state().failures, 0);
  assert.equal(h.rawPrinter.calls.length, 0);
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
});

test('being locked out comes before "no password given"', async (t) => {
  const h = createHarness(t);
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'wrong' });
  assertFailure(await h.drawer.open({}), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
});

test('the password is compared exactly: case, spaces and a trimmed copy do not match', async (t) => {
  const h = createHarness(t);
  for (const near of ['1234 ', ' 1234', '12345', '123']) {
    assert.equal((await h.drawer.open({ password: near })).code, 'DRAWER_WRONG_PASSWORD', JSON.stringify(near));
  }
  assert.equal(h.rawPrinter.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The printer
// ---------------------------------------------------------------------------------------------

test('printer errors keep their own codes and details (SPEC 7): not found, timeout, spooler, port, no printer', async (t) => {
  const cases = [
    [new errors.PrintError('PRINTER_NOT_FOUND', undefined, { printerName: 'EPSON TM-T20' }), 'PRINTER_NOT_FOUND', { printerName: 'EPSON TM-T20' }],
    [new errors.PrintError('PRINT_TIMEOUT'), 'PRINT_TIMEOUT', undefined],
    [new errors.PrintError('SPOOLER_ERROR', undefined, { detail: 'paper jam' }), 'SPOOLER_ERROR', { detail: 'paper jam' }],
    [new errors.PrintError('PORT_WRITE_FAILED'), 'PORT_WRITE_FAILED', undefined],
    [new errors.PrintError('NO_PRINTER_CONFIGURED'), 'NO_PRINTER_CONFIGURED', undefined],
    [new errors.PrintError('UNSUPPORTED_PLATFORM', undefined, { platform: 'darwin' }), 'UNSUPPORTED_PLATFORM', { platform: 'darwin' }],
    [new errors.PrintError('INVALID_SETTINGS', 'The printer name cannot be used.', { reason: 'leading-dash' }), 'INVALID_SETTINGS', { reason: 'leading-dash' }],
  ];
  for (const [error, code, details] of cases) {
    const h = createHarness(t, { printRaw: async () => { throw error; } });
    const result = await h.drawer.open({ password: PLAIN });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.equal(result.message, error.message, 'the message of the printer error, unchanged');
    assert.deepEqual(result.details, details);
    assert.equal(h.rawPrinter.calls.length, 1);
    assert.deepEqual(h.throttle.state(), { failures: 0, lockedUntil: 0, retryAfterSec: 0 }, 'the password was right, so the throttle is reset');
  }
});

test('an error that is not a PrintError becomes DRAWER_FAILED, and its technical text is not shown to the cashier but is logged', async (t) => {
  for (const thrown of [new TypeError('Cannot read properties of undefined'), 'a string', 42, null, undefined]) {
    const h = createHarness(t, { printRaw: async () => { throw thrown; } });
    const result = await h.drawer.open({ password: PLAIN });
    assertFailure(result, 'DRAWER_FAILED');
    assert.ok(!result.message.includes('Cannot read properties'));
    assert.ok(h.log.entries.some((e) => e.level === 'error' && /opening failed/.test(h.log.text())));
  }
  const h = createHarness(t, { printRaw: async () => { throw new TypeError('Cannot read properties of undefined'); } });
  await h.drawer.open({ password: PLAIN });
  assert.match(h.log.text(), /Cannot read properties of undefined/);
});

test('a printer that throws synchronously, instead of rejecting, is handled the same way', async (t) => {
  const h = createHarness(t, { printRaw: () => { throw new Error('sync boom'); } });
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_FAILED');
});

test('a printer error after the right password still resets the throttle, and the drawer can be tried again', async (t) => {
  let fail = true;
  const h = createHarness(t, { printRaw: async () => { if (fail) throw new errors.PrintError('PRINTER_NOT_FOUND'); return { ok: true }; } });
  await h.drawer.open({ password: 'wrong' });
  assert.equal((await h.drawer.open({ password: PLAIN })).code, 'PRINTER_NOT_FOUND');
  assert.equal(h.throttle.state().failures, 0);
  fail = false;
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
});

test('an error object from another copy of errors.js (same shape) is still recognised as a printer error', async (t) => {
  const foreign = Object.assign(new Error('The printer was not found. Check that it is on.'), { name: 'PrintError', code: 'PRINTER_NOT_FOUND', details: { printerName: 'X' } });
  const h = createHarness(t, { printRaw: async () => { throw foreign; } });
  const result = await h.drawer.open({ password: PLAIN });
  assert.equal(result.code, 'PRINTER_NOT_FOUND');
  assert.deepEqual(result.details, { printerName: 'X' });
});

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

test('passwords and hashes are never logged, whatever happens', async (t) => {
  const h = createHarness(t, { printRaw: async () => { throw new errors.PrintError('SPOOLER_ERROR'); } });
  for (const attempt of ['guess-one-9981', 'guess-two-9982', PLAIN, 'guess-three-9983']) await h.drawer.open({ password: attempt, source: 'menu' });
  for (let i = 0; i < 5; i += 1) await h.drawer.open({ password: 'guess-lock-7777' });
  const text = h.log.text();
  assert.ok(text.length > 0);
  for (const secret of ['guess-one-9981', 'guess-two-9982', 'guess-three-9983', 'guess-lock-7777', RECORD.hash, RECORD.salt]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(!text.includes(`"${PLAIN}"`));
});

test('a result never carries the password or the hash', async (t) => {
  const h = createHarness(t);
  const results = [await h.drawer.open({ password: 'guess-xyz-1' }), await h.drawer.open({ password: PLAIN })];
  for (const result of results) {
    const text = JSON.stringify(result);
    assert.ok(!text.includes('guess-xyz-1') && !text.includes(RECORD.hash) && !text.includes(RECORD.salt));
  }
});

test('the source only labels the log: odd values become "unknown" (no log injection)', async (t) => {
  const h = createHarness(t);
  await h.drawer.open({ password: 'wrong', source: 'evil\nINJECTED LINE' });
  await h.drawer.open({ password: 'wrong', source: 'x'.repeat(500) });
  await h.drawer.open({ password: 'wrong', source: { toString: () => 'object' } });
  await h.drawer.open({ password: 'wrong', source: 'web' });
  const text = h.log.text();
  assert.ok(!text.includes('INJECTED'));
  assert.ok(!text.includes('x'.repeat(100)));
  assert.match(text, /wrong password \(unknown\)/);
  assert.match(text, /wrong password \(web\)/);
});

test('an unexpected exception inside open() is a DRAWER_FAILED Result, not a throw', async (t) => {
  const h = createHarness(t);
  const exploding = createDrawer({
    config: { get: () => { throw new Error('config exploded'); } },
    rawPrinter: h.rawPrinter,
    password,
    throttle: h.throttle,
    log: h.log,
  });
  assertFailure(await exploding.open({ password: PLAIN }), 'DRAWER_FAILED');
  assert.match(h.log.text(), /config exploded/);
});

test('works without a logger', async (t) => {
  const h = createHarness(t);
  const quiet = createDrawer({ config: h.config, rawPrinter: h.rawPrinter, password, throttle: h.throttle });
  assert.equal((await quiet.open({ password: PLAIN })).ok, true);
  assert.equal((await quiet.open({ password: 'wrong' })).code, 'DRAWER_WRONG_PASSWORD');
  h.rawPrinter.behaviour = async () => { throw new errors.PrintError('PRINT_TIMEOUT'); };
  assert.equal((await quiet.open({ password: PLAIN })).code, 'PRINT_TIMEOUT', 'the error path logs too, silently');
});

// ---------------------------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------------------------

test('a damaged password record fails closed: it is "set" but nothing verifies, so every attempt is wrong and counts', async (t) => {
  const h = createHarness(t, { record: { ...RECORD, hash: 'not-base64!!' } });
  assert.equal(h.config.publicState().drawer.passwordSet, true);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_WRONG_PASSWORD', { attemptsLeft: 4 });
  assert.equal(h.rawPrinter.calls.length, 0);
});

test('a record made with older parameters still opens the drawer and is upgraded to the current ones, keeping the weak flag', async (t) => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const older = { algo: 'scrypt', N: 8192, r: 8, p: 1, keylen: 32, salt: salt.toString('base64'), hash: crypto.scryptSync(PLAIN, salt, 32, { N: 8192, r: 8, p: 1 }).toString('base64') };
  const h = createHarness(t, { record: older });
  h.config.set('drawer.passwordWeak', true);

  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  const upgraded = h.config.get('drawer.passwordRecord');
  assert.equal(upgraded.N, 16384);
  assert.notEqual(upgraded.hash, older.hash);
  assert.equal(password.needsRehash(upgraded), false);
  assert.equal(password.verifyPassword(PLAIN, upgraded), true);
  assert.equal(h.config.get('drawer.passwordWeak'), true, 'still the same weak password');

  const writes = h.env.stats.writes;
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.equal(h.env.stats.writes, writes, 'a current record is not rewritten');
});

test('a wrong password never upgrades the record', async (t) => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const older = { algo: 'scrypt', N: 8192, r: 8, p: 1, keylen: 32, salt: salt.toString('base64'), hash: crypto.scryptSync(PLAIN, salt, 32, { N: 8192, r: 8, p: 1 }).toString('base64') };
  const h = createHarness(t, { record: older });
  await h.drawer.open({ password: 'wrong' });
  assert.deepEqual(h.config.get('drawer.passwordRecord'), older);
});

test('if upgrading the record fails, opening the drawer still works (and the failure is logged)', async (t) => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const older = { algo: 'scrypt', N: 8192, r: 8, p: 1, keylen: 32, salt: salt.toString('base64'), hash: crypto.scryptSync(PLAIN, salt, 32, { N: 8192, r: 8, p: 1 }).toString('base64') };
  const h = createHarness(t, { record: older });
  h.env.failWrite();
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.equal(h.rawPrinter.calls.length, 1);
  assert.deepEqual(h.config.get('drawer.passwordRecord'), older, 'the old record is still there and still works');
  assert.match(h.log.text(), /could not be upgraded/);

  const brokenHash = createDrawer({
    config: h.config,
    rawPrinter: h.rawPrinter,
    password: { ...password, hashPassword: () => { throw new Error('hash exploded'); } },
    throttle: h.throttle,
    log: h.log,
  });
  assert.equal((await brokenHash.open({ password: PLAIN })).ok, true);
});

test('a migrated weak password (SPEC 5.2) opens the drawer like any other', async (t) => {
  const h = createHarness(t, { record: password.hashPassword('1') });
  h.config.set('drawer.passwordWeak', true);
  assert.equal((await h.drawer.open({ password: '1' })).ok, true);
  assert.equal(h.config.get('drawer.passwordWeak'), true);
});

// ---------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------

test('two opens started together are both checked and both counted', async (t) => {
  const h = createHarness(t);
  const [a, b, c] = await Promise.all([h.drawer.open({ password: PLAIN }), h.drawer.open({ password: 'wrong' }), h.drawer.open({ password: PLAIN })]);
  assert.equal(a.ok, true);
  assert.equal(b.code, 'DRAWER_WRONG_PASSWORD');
  assert.equal(c.ok, true);
  assert.equal(h.rawPrinter.calls.length, 2);
  assert.equal(h.throttle.state().failures, 0, 'the last right password reset the count');
});

test('five wrong guesses fired together lock the drawer; none can sneak past the throttle', async (t) => {
  const h = createHarness(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.drawer.open({ password: 'wrong' })));
  assert.equal(results.filter((r) => r.code === 'DRAWER_WRONG_PASSWORD').length, 5);
  assert.equal(results.filter((r) => r.code === 'DRAWER_LOCKED_OUT').length, 3);
  assertFailure(await h.drawer.open({ password: PLAIN }), 'DRAWER_LOCKED_OUT', { retryAfterSec: 30 });
});
