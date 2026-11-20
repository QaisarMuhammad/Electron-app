'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validatePasswordPolicy, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = require('../../src/main/password');

test('the policy is 4 to 64 characters (SPEC 10)', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 4);
  assert.equal(MAX_PASSWORD_LENGTH, 64);
});

test('boundaries: 3 is too short, 4 and 64 pass, 65 is too long', () => {
  assert.equal(validatePasswordPolicy('abc').code, 'PASSWORD_TOO_SHORT');
  assert.deepEqual(validatePasswordPolicy('abcd'), { ok: true });
  assert.deepEqual(validatePasswordPolicy('x'.repeat(64)), { ok: true });
  const tooLong = validatePasswordPolicy('x'.repeat(65));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'INVALID_SETTINGS', 'SPEC 7 has no "too long" code');
});

test('every failure carries a code and a plain-English message', () => {
  for (const bad of ['', 'a', 'abc', 'x'.repeat(65), undefined, null, 1234, {}, ['abcd']]) {
    const result = validatePasswordPolicy(bad);
    assert.equal(result.ok, false, String(bad));
    assert.equal(typeof result.code, 'string');
    assert.ok(result.message.length > 10 && result.message.endsWith('.'), result.message);
  }
});

test('missing, empty and non-string passwords are PASSWORD_REQUIRED, not "too short"', () => {
  for (const bad of ['', undefined, null, 1234, {}, ['abcd'], true]) {
    assert.equal(validatePasswordPolicy(bad).code, 'PASSWORD_REQUIRED', String(bad));
  }
});

test('length counts characters, not UTF-16 units or bytes', () => {
  assert.deepEqual(validatePasswordPolicy('päss'), { ok: true }, 'a 4-character word with an umlaut');
  assert.equal(validatePasswordPolicy('😀😀😀').code, 'PASSWORD_TOO_SHORT', '3 emoji are 3 characters (6 UTF-16 units)');
  assert.deepEqual(validatePasswordPolicy('😀😀😀😀'), { ok: true });
  assert.deepEqual(validatePasswordPolicy('😀'.repeat(64)), { ok: true });
  assert.equal(validatePasswordPolicy('😀'.repeat(65)).code, 'INVALID_SETTINGS');
});

test('spaces count as characters and nothing is trimmed (the password is used exactly as typed)', () => {
  assert.deepEqual(validatePasswordPolicy('    '), { ok: true });
  assert.deepEqual(validatePasswordPolicy(' ab '), { ok: true });
  assert.equal(validatePasswordPolicy('   ').code, 'PASSWORD_TOO_SHORT');
});

test('a huge string is "too long" at once: the policy never walks all of it (the set and change paths hash only what passed)', () => {
  const huge = 'x'.repeat(64 * 1024 * 1024);
  const started = process.hrtime.bigint();
  const result = validatePasswordPolicy(huge);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.code, 'INVALID_SETTINGS');
  assert.match(result.message, /too long/);
  assert.ok(ms < 100, `${ms.toFixed(0)} ms for a 64 MB string`);
  assert.equal(validatePasswordPolicy('x'.repeat(129)).code, 'INVALID_SETTINGS', 'more than twice the limit in UTF-16 units can never be 64 characters');
  assert.deepEqual(validatePasswordPolicy('😀'.repeat(64)), { ok: true }, '128 units of 64 characters still pass');
});
