'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { hashPassword, verifyPassword, needsRehash, SCRYPT_PARAMS, MAX_CANDIDATE_LENGTH } = require('../../src/main/password');

// One real record shared by the table tests: hashing costs about 60 ms each.
const PLAIN = 'correct horse';
const RECORD = hashPassword(PLAIN);

const clone = (value) => JSON.parse(JSON.stringify(value));

test('hashPassword makes a scrypt record with the SPEC parameters, a 16-byte salt and a 32-byte hash', () => {
  assert.deepEqual(Object.keys(RECORD).sort(), ['N', 'algo', 'hash', 'keylen', 'p', 'r', 'salt']);
  assert.equal(RECORD.algo, 'scrypt');
  assert.deepEqual({ N: RECORD.N, r: RECORD.r, p: RECORD.p, keylen: RECORD.keylen }, { N: 16384, r: 8, p: 1, keylen: 32 });
  assert.deepEqual(SCRYPT_PARAMS, { N: 16384, r: 8, p: 1, keylen: 32 });
  assert.equal(Buffer.from(RECORD.salt, 'base64').length, 16);
  assert.equal(Buffer.from(RECORD.hash, 'base64').length, 32);
  assert.equal(Buffer.from(RECORD.salt, 'base64').toString('base64'), RECORD.salt, 'base64, canonical');
});

test('the record never contains the password and survives a JSON round trip (it is stored as JSON)', () => {
  assert.ok(!JSON.stringify(RECORD).includes(PLAIN));
  assert.equal(verifyPassword(PLAIN, clone(RECORD)), true);
});

test('hashing the same password twice gives different salts and hashes', () => {
  const again = hashPassword(PLAIN);
  assert.notEqual(again.salt, RECORD.salt);
  assert.notEqual(again.hash, RECORD.hash);
  assert.equal(verifyPassword(PLAIN, again), true);
});

test('hashPassword hashes ANY non-empty string exactly as given: no trim, no length policy (SPEC 5.2)', () => {
  const passwords = ['1', '123', ' 1234 ', 'päss', 'x'.repeat(65), 'with\nnewline\tand tab', '😀😀😀', 'x'.repeat(1000)];
  for (const plain of passwords) {
    const record = hashPassword(plain);
    assert.equal(verifyPassword(plain, record), true, JSON.stringify(plain).slice(0, 30));
  }
});

test('hashPassword refuses anything that is not a non-empty string', () => {
  for (const bad of ['', undefined, null, 1234, true, {}, [], ['abcd'], Buffer.from('abcd')]) {
    assert.throws(() => hashPassword(bad), TypeError, String(bad));
  }
});

test('verifyPassword is exact: case, spaces and neighbours do not match', () => {
  assert.equal(verifyPassword(PLAIN, RECORD), true);
  for (const wrong of ['Correct horse', 'correct horse ', ' correct horse', 'correct hors', 'correct horsee', 'correct  horse', 'wrong']) {
    assert.equal(verifyPassword(wrong, RECORD), false, JSON.stringify(wrong));
  }
});

test('verifyPassword answers false (never throws) for a plain password that is not a non-empty string', () => {
  for (const bad of ['', undefined, null, 1234, {}, [], true, Symbol('x'), 10n]) {
    assert.equal(verifyPassword(bad, RECORD), false);
  }
});

test('verifyPassword answers false (never throws) for anything that is not a usable record', () => {
  const unusable = [undefined, null, '', 'scrypt', 0, 42, true, [], [RECORD], {}, () => RECORD, Symbol('record'), 10n];
  for (const record of unusable) assert.equal(verifyPassword(PLAIN, record), false, String(typeof record));
});

test('tampered records do not verify and never throw', () => {
  const flipLastByte = (value) => {
    const bytes = Buffer.from(value, 'base64');
    bytes[bytes.length - 1] ^= 0x01;
    return bytes.toString('base64');
  };
  const mutations = {
    'hash with one bit flipped': (r) => ({ ...r, hash: flipLastByte(r.hash) }),
    'salt with one bit flipped': (r) => ({ ...r, salt: flipLastByte(r.salt) }),
    'hash of another password': (r) => ({ ...r, hash: hashPassword('another').hash }),
    'N doubled': (r) => ({ ...r, N: r.N * 2 }),
    'N halved': (r) => ({ ...r, N: r.N / 2 }),
    'r changed': (r) => ({ ...r, r: 4 }),
    'p changed': (r) => ({ ...r, p: 2 }),
    'keylen shorter than the hash': (r) => ({ ...r, keylen: 16 }),
    'keylen longer than the hash': (r) => ({ ...r, keylen: 64 }),
    'algo changed': (r) => ({ ...r, algo: 'bcrypt' }),
    'algo upper case': (r) => ({ ...r, algo: 'SCRYPT' }),
    'algo missing': (r) => ({ ...r, algo: undefined }),
    'N missing': (r) => ({ ...r, N: undefined }),
    'r missing': (r) => ({ ...r, r: undefined }),
    'p missing': (r) => ({ ...r, p: undefined }),
    'keylen missing': (r) => ({ ...r, keylen: undefined }),
    'salt missing': (r) => ({ ...r, salt: undefined }),
    'hash missing': (r) => ({ ...r, hash: undefined }),
    'N as a string': (r) => ({ ...r, N: '16384' }),
    'N as a float': (r) => ({ ...r, N: 16384.5 }),
    'N as null': (r) => ({ ...r, N: null }),
    'N not a power of two': (r) => ({ ...r, N: 16383 }),
    'N below the supported range': (r) => ({ ...r, N: 512 }),
    'N above the supported range': (r) => ({ ...r, N: 2 ** 24 }),
    'r zero': (r) => ({ ...r, r: 0 }),
    'r above the supported range': (r) => ({ ...r, r: 33 }),
    'p zero': (r) => ({ ...r, p: 0 }),
    'p above the supported range': (r) => ({ ...r, p: 17 }),
    'keylen below the supported range': (r) => ({ ...r, keylen: 8 }),
    'keylen above the supported range': (r) => ({ ...r, keylen: 65 }),
    'memory demand far too high': (r) => ({ ...r, N: 2 ** 17, r: 32 }),
    'salt as a number': (r) => ({ ...r, salt: 12345 }),
    'hash as an array': (r) => ({ ...r, hash: [1, 2, 3] }),
    'salt empty': (r) => ({ ...r, salt: '' }),
    'salt too short': (r) => ({ ...r, salt: 'AAAA' }),
    'hash empty': (r) => ({ ...r, hash: '' }),
    'hash truncated': (r) => ({ ...r, hash: r.hash.slice(0, 20) }),
    'hash with extra bytes': (r) => ({ ...r, hash: `${r.hash.slice(0, -1)}AAAA=` }),
    'hash not base64': (r) => ({ ...r, hash: 'not base64 !!!' }),
    'hash base64 with whitespace': (r) => ({ ...r, hash: `${r.hash}\n` }),
    'hash base64 url alphabet': (r) => ({ ...r, hash: r.hash.replace(/\+/g, '-').replace(/\//g, '_') + '=' }),
    'hash with non-canonical padding bits': (r) => ({ ...r, hash: `${r.hash.slice(0, -2)}B=` }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const tampered = mutate(clone(RECORD));
    assert.doesNotThrow(() => verifyPassword(PLAIN, tampered), name);
    assert.equal(verifyPassword(PLAIN, tampered), false, name);
  }
});

test('if scrypt itself fails (out of memory, a platform limit), verifyPassword answers false instead of throwing', (t) => {
  t.mock.method(crypto, 'scryptSync', () => {
    throw new Error('Invalid scrypt params: memory limit exceeded');
  });
  assert.doesNotThrow(() => verifyPassword(PLAIN, RECORD));
  assert.equal(verifyPassword(PLAIN, RECORD), false);
});

test('a record whose fields cannot even be read does not make verifyPassword throw', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(verifyPassword(PLAIN, hostile), false);
  assert.equal(needsRehash(hostile), true);
});

test('extra unknown fields in a record are ignored, and a null-prototype record works', () => {
  assert.equal(verifyPassword(PLAIN, { ...RECORD, note: 'hello', extra: { a: 1 } }), true);
  assert.equal(verifyPassword(PLAIN, Object.assign(Object.create(null), RECORD)), true);
});

test('the comparison is constant time: timingSafeEqual runs once for a usable record and never for an unusable one', (t) => {
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  assert.equal(verifyPassword(PLAIN, RECORD), true);
  assert.equal(verifyPassword('wrong', RECORD), false);
  assert.equal(spy.mock.callCount(), 2);
  assert.equal(verifyPassword(PLAIN, { ...RECORD, algo: 'md5' }), false);
  assert.equal(verifyPassword(PLAIN, null), false);
  assert.equal(spy.mock.callCount(), 2, 'no comparison for records that are not usable');
});

test('records made with other (older) parameters still verify, and needsRehash says they should be upgraded', () => {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync('legacy pass', salt, 64, { N: 8192, r: 8, p: 2 });
  const older = { algo: 'scrypt', N: 8192, r: 8, p: 2, keylen: 64, salt: salt.toString('base64'), hash: hash.toString('base64') };
  assert.equal(verifyPassword('legacy pass', older), true);
  assert.equal(verifyPassword('other pass', older), false);
  assert.equal(needsRehash(older), true);
});

test('needsRehash: false for a fresh record, true for any other parameters or salt size, true for unusable records', () => {
  assert.equal(needsRehash(RECORD), false);
  assert.equal(needsRehash({ ...RECORD, N: 8192 }), true);
  assert.equal(needsRehash({ ...RECORD, r: 4 }), true);
  assert.equal(needsRehash({ ...RECORD, p: 2 }), true);

  const other = { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: crypto.randomBytes(8).toString('base64'), hash: RECORD.hash };
  assert.equal(needsRehash(other), true, 'a different salt size');

  for (const unusable of [null, undefined, {}, 'x', 42, [], { ...RECORD, hash: 'zzzz' }, { ...RECORD, algo: 'bcrypt' }]) {
    assert.equal(needsRehash(unusable), true, JSON.stringify(unusable));
  }
});

test('verifyPassword refuses a candidate longer than MAX_CANDIDATE_LENGTH (4096) without hashing it; one of exactly that length is still checked', (t) => {
  assert.equal(MAX_CANDIDATE_LENGTH, 4096);
  const spy = t.mock.method(crypto, 'scryptSync');
  assert.equal(verifyPassword('x'.repeat(MAX_CANDIDATE_LENGTH + 1), RECORD), false);
  assert.equal(verifyPassword('😀'.repeat(MAX_CANDIDATE_LENGTH), RECORD), false, 'counted in UTF-16 units: 4096 emoji are 8192');
  assert.equal(spy.mock.callCount(), 0, 'scrypt never saw an oversized candidate');
  assert.equal(verifyPassword('wrong', RECORD), false);
  assert.equal(spy.mock.callCount(), 1, 'a normal candidate is hashed');

  // a migrated v1 password may be any non-empty string (SPEC 5.2): up to the limit it keeps working
  const legacy = 'p'.repeat(MAX_CANDIDATE_LENGTH);
  assert.equal(verifyPassword(legacy, hashPassword(legacy)), true);
});
