'use strict';

/**
 * Cash drawer password: hashing, policy and the brute-force throttle (SPEC sections 8 and 10).
 *
 * Pure Node (`node:crypto` only): no Electron, no config, no file access, so it runs under plain
 * `node --test`. The password and its hash are never logged or returned by anything in this file.
 *
 * A stored record looks like
 *   { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: <base64>, hash: <base64> }
 * and carries its own parameters, so the cost can be raised later while old records keep verifying
 * (`needsRehash` tells the caller when to upgrade one).
 */

const crypto = require('node:crypto');

const ALGO = 'scrypt';

/** Cost parameters of every NEW record (SPEC 10). Records made with other parameters still verify. */
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SALT_BYTES = 16;

/** Bounds a stored record must respect to be verified at all: a damaged file must not be able to make scrypt run away. */
const LIMITS = Object.freeze({
  N: Object.freeze({ min: 1024, max: 1048576 }),
  r: Object.freeze({ min: 1, max: 32 }),
  p: Object.freeze({ min: 1, max: 16 }),
  keylen: Object.freeze({ min: 16, max: 64 }),
  saltBytes: Object.freeze({ min: 8, max: 64 }),
});
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;

/** Length policy for passwords that are SET or CHANGED (SPEC 10). Counted in characters (code points), not bytes. */
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 64;

/**
 * The longest candidate `verifyPassword` will hash. A policy password has at most 64 characters and a migrated v1 password (any
 * non-empty string, SPEC 5.2) is never near this size, while the web page can send a string of any size to the drawer channels and
 * scrypt would read all of it on the main thread. A longer candidate is a wrong password: it is counted like one and never hashed.
 */
const MAX_CANDIDATE_LENGTH = 4096;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------------

/**
 * Memory scrypt needs for these parameters (128 * r * (N + 2 + p) bytes, as OpenSSL counts it).
 * @param {{N: number, r: number, p: number}} params
 * @returns {number}
 */
function scryptMemoryBytes({ N, r, p }) {
  return 128 * r * (N + 2 + p);
}

/** @param {unknown} value @param {{min: number, max: number}} range @returns {boolean} */
function isIntegerInRange(value, range) {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** @param {number} n @returns {boolean} */
function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Decode a canonical base64 string. Node's decoder silently skips invalid characters, so the string is
 * accepted only when it encodes back to exactly what was stored.
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function decodeBase64(value) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/**
 * Validate a stored record and decode its binary parts.
 * @param {unknown} record
 * @returns {{N: number, r: number, p: number, keylen: number, salt: Buffer, hash: Buffer}|null} null when the record is unusable
 */
function readRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.algo !== ALGO) return null;
  const { N, r, p, keylen } = record;
  if (!isIntegerInRange(N, LIMITS.N) || !isPowerOfTwo(N)) return null;
  if (!isIntegerInRange(r, LIMITS.r) || !isIntegerInRange(p, LIMITS.p) || !isIntegerInRange(keylen, LIMITS.keylen)) return null;
  if (scryptMemoryBytes({ N, r, p }) > MAX_SCRYPT_MEMORY_BYTES) return null;
  const salt = decodeBase64(record.salt);
  const hash = decodeBase64(record.hash);
  if (!salt || !hash) return null;
  if (salt.length < LIMITS.saltBytes.min || salt.length > LIMITS.saltBytes.max || hash.length !== keylen) return null;
  return { N, r, p, keylen, salt, hash };
}

/**
 * Like `readRecord`, and it never throws, whatever object it is given (a record is data read from a
 * file that anyone with access to the PC can edit).
 * @param {unknown} record
 * @returns {{N: number, r: number, p: number, keylen: number, salt: Buffer, hash: Buffer}|null}
 */
function parseRecord(record) {
  try {
    return readRecord(record);
  } catch {
    return null;
  }
}

/** @param {{N: number, r: number, p: number}} params @returns {{N: number, r: number, p: number, maxmem: number}} */
function scryptOptions({ N, r, p }) {
  return { N, r, p, maxmem: MAX_SCRYPT_MEMORY_BYTES };
}

/**
 * Hash a password for storage.
 *
 * Accepts ANY non-empty string and hashes it exactly as given: no trimming, no normalisation and no
 * length policy. A password saved by v1.6.1 only had to be non-empty, and it must keep working after
 * the upgrade (SPEC 5.2). The 4..64 policy is `validatePasswordPolicy`, applied only when a password
 * is set or changed.
 *
 * @param {string} plain
 * @returns {{algo: string, N: number, r: number, p: number, keylen: number, salt: string, hash: string}}
 * @throws {TypeError} when `plain` is not a non-empty string
 */
function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('A password must be a non-empty string.');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_PARAMS.keylen, scryptOptions(SCRYPT_PARAMS));
  return { algo: ALGO, ...SCRYPT_PARAMS, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/**
 * Check a password against a stored record. Constant-time comparison; never throws: a malformed,
 * tampered or unsupported record, a non-string password, or one longer than MAX_CANDIDATE_LENGTH
 * (refused before any hashing), simply does not verify.
 *
 * @param {unknown} plain
 * @param {unknown} record
 * @returns {boolean}
 */
function verifyPassword(plain, record) {
  if (typeof plain !== 'string' || plain.length === 0 || plain.length > MAX_CANDIDATE_LENGTH) return false;
  const parsed = parseRecord(record);
  if (!parsed) return false;
  try {
    const actual = crypto.scryptSync(plain, parsed.salt, parsed.keylen, scryptOptions(parsed));
    return crypto.timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * True when `record` differs from what `hashPassword` would create today (other cost parameters or
 * salt size), or is unusable. After a successful `verifyPassword` the caller can hash the plain
 * password again and store the new record, upgrading old records on the next successful login.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
function needsRehash(record) {
  const parsed = parseRecord(record);
  if (!parsed) return true;
  return (
    parsed.N !== SCRYPT_PARAMS.N ||
    parsed.r !== SCRYPT_PARAMS.r ||
    parsed.p !== SCRYPT_PARAMS.p ||
    parsed.keylen !== SCRYPT_PARAMS.keylen ||
    parsed.salt.length !== SALT_BYTES
  );
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

/**
 * The length policy for a password that is being set or changed: a string of 4 to 64 characters.
 * Returns a Result-shaped object so callers can hand it straight back to the user. The error codes are
 * the SPEC section 7 names (there is no "too long" code, so that case is INVALID_SETTINGS).
 *
 * @param {unknown} plain
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
function validatePasswordPolicy(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    return { ok: false, code: 'PASSWORD_REQUIRED', message: 'Enter a password.' };
  }
  // A code point is at most two UTF-16 units, so more than twice the limit is too long without walking the whole string.
  const length = plain.length > 2 * MAX_PASSWORD_LENGTH ? Infinity : Array.from(plain).length;
  if (length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
      message: `The password is too short. Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_SETTINGS',
      message: `The password is too long. Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------------------------

/** @param {string} name @param {unknown} value @returns {number} */
function requirePositive(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number.`);
  }
  return value;
}

/**
 * What a saved lock must look like to be believed: a file that anyone with access to the PC can edit must not be able to make the
 * throttle throw or lock the till for longer than its cap.
 * @param {unknown} value
 * @returns {{failures: number, remainingMs: number, writtenAt: number}|null}
 */
function readSavedLock(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { failures, remainingMs, writtenAt } = value;
  if (!Number.isInteger(failures) || failures < 1) return null;
  if (!Number.isFinite(remainingMs) || remainingMs < 0 || !Number.isFinite(writtenAt)) return null;
  return { failures, remainingMs, writtenAt };
}

/**
 * Brute-force throttle shared by EVERY password check (drawer, change password, Settings, reset).
 *
 * Timeline with the defaults: the 5th consecutive wrong password locks for 30 s, and every further
 * wrong password after that doubles the lock (60 s, 120 s, 240 s) up to a cap of 5 minutes. A correct
 * password resets everything.
 *
 * Two clocks. While the app runs the lock is a deadline on `monotonic`, a clock that only moves forward and that nobody can set
 * (process.hrtime / performance.now in the app), so moving the PC's clock, back OR forward, neither shortens nor ends it. It
 * defaults to `now`, which is what a throttle without a persisted lock needs. The wall clock `now` is used only to stamp what is
 * saved, and to read it again after a restart.
 *
 * Persistence. When `save` is given, every change is handed to it as `{ failures, remainingMs, writtenAt }` (`writtenAt` is `now()`,
 * `remainingMs` is the time left on the lock, 0 when there is none), or `null` when there is nothing to remember. `load` returns the
 * last saved value once, when the throttle is created, so closing and opening the app does not give five new guesses. After a
 * restart the wall clock is all there is: the time that passed while the app was closed is `now() - writtenAt`. A clock moved back
 * since then cannot shorten the lock (it only adds to it, up to the cap); a clock moved forward while the app was closed does shorten
 * it. That last gap is accepted, because it cannot be told apart from time that really passed.
 *
 * Callers must not `await` between `check()` and the password comparison, so two checks cannot interleave.
 *
 * @param {object} [options]
 * @param {number} [options.maxFailures=5] consecutive wrong passwords before the first lock
 * @param {number} [options.baseLockMs=30000] length of the first lock
 * @param {number} [options.maxLockMs=300000] longest lock
 * @param {() => number} [options.now=Date.now] wall clock in milliseconds
 * @param {() => number} [options.monotonic=now] clock in milliseconds that only moves forward; the lock deadline is kept on it
 * @param {() => unknown} [options.load] the last value `save` was given (or null)
 * @param {(record: {failures: number, remainingMs: number, writtenAt: number}|null) => void} [options.save]
 * @returns {{
 *   check: () => {allowed: boolean, retryAfterSec: number, attemptsLeft: number},
 *   fail: () => {allowed: boolean, retryAfterSec: number, attemptsLeft: number},
 *   success: () => void,
 *   state: () => {failures: number, lockedUntil: number, retryAfterSec: number}
 * }}
 *   `check()` answers whether an attempt may be made now; `fail()` records a wrong password and returns
 *   the new verdict; `success()` resets; `state()` is the raw counters for a lockout screen (`lockedUntil` is on the `monotonic` clock).
 */
function createThrottle({ maxFailures = 5, baseLockMs = 30000, maxLockMs = 300000, now = Date.now, monotonic = now, load, save } = {}) {
  requirePositive('maxFailures', maxFailures);
  requirePositive('baseLockMs', baseLockMs);
  requirePositive('maxLockMs', maxLockMs);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof monotonic !== 'function') throw new TypeError('monotonic must be a function.');
  for (const [name, hook] of [['load', load], ['save', save]]) {
    if (hook !== undefined && typeof hook !== 'function') throw new TypeError(`${name} must be a function.`);
  }

  let failures = 0;
  let lockedUntil = 0;

  /**
   * Milliseconds left on the current lock. A clock that was moved back must not lock the till for
   * longer than the cap, so an impossible remainder is shortened to `maxLockMs`.
   */
  function remainingMs() {
    const current = monotonic();
    const remaining = lockedUntil - current;
    if (remaining > maxLockMs) {
      lockedUntil = current + maxLockMs;
      return maxLockMs;
    }
    return Math.max(0, remaining);
  }

  /** Hands the counters and the time left to `save`; a failing disk never breaks a password check (the lock still holds in memory). */
  function remember() {
    if (save === undefined) return;
    try {
      save(failures === 0 ? null : { failures, remainingMs: Math.ceil(remainingMs()), writtenAt: now() });
    } catch {
      // nothing more can be done here; the next change tries again
    }
  }

  if (load !== undefined) {
    let saved = null;
    try {
      saved = readSavedLock(load());
    } catch {
      // an unreadable record is the same as none
    }
    if (saved) {
      failures = saved.failures;
      const left = Math.min(maxLockMs, saved.remainingMs - (now() - saved.writtenAt));
      if (left > 0) lockedUntil = monotonic() + left;
    }
  }

  function verdict() {
    const remaining = remainingMs();
    return {
      allowed: remaining === 0,
      retryAfterSec: Math.ceil(remaining / 1000),
      attemptsLeft: Math.max(0, maxFailures - failures),
    };
  }

  return {
    check: verdict,

    fail() {
      failures += 1;
      if (failures >= maxFailures) {
        const lockMs = Math.min(maxLockMs, baseLockMs * 2 ** (failures - maxFailures));
        lockedUntil = monotonic() + lockMs;
      }
      remember();
      return verdict();
    },

    success() {
      if (failures === 0 && lockedUntil === 0) return;
      failures = 0;
      lockedUntil = 0;
      remember();
    },

    state() {
      return { failures, lockedUntil, retryAfterSec: Math.ceil(remainingMs() / 1000) };
    },
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePasswordPolicy,
  createThrottle,
  SCRYPT_PARAMS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_CANDIDATE_LENGTH,
};
