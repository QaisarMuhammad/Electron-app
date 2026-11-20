'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ERROR_CODES, PrintError, isPrintError, ok, toResult, userMessage,
} = require('../../src/main/errors');

/** The codes of SPEC section 7, in the order the SPEC lists them. */
const SPEC_CODES = [
  'INVALID_PAYLOAD', 'UNTRUSTED_SENDER', 'NO_PRINTER_CONFIGURED', 'PRINTER_NOT_FOUND', 'UNSUPPORTED_PLATFORM',
  'SPOOLER_ERROR', 'PORT_WRITE_FAILED', 'PRINT_TIMEOUT',
  'DYMO_UNAVAILABLE', 'DYMO_NO_PRINTER', 'DYMO_TEMPLATE_MISSING', 'DYMO_PRINT_FAILED',
  'DRAWER_DISABLED', 'DRAWER_PASSWORD_NOT_SET', 'DRAWER_WRONG_PASSWORD', 'DRAWER_LOCKED_OUT', 'DRAWER_FAILED',
  'PASSWORD_REQUIRED', 'PASSWORD_WRONG', 'PASSWORD_TOO_SHORT', 'PASSWORD_LOCKED_OUT',
  'INVALID_SETTINGS', 'UPDATE_UNAVAILABLE', 'UNKNOWN',
];

test('ERROR_CODES holds exactly the SPEC codes, each mapped to its own name, and is frozen', () => {
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), [...SPEC_CODES].sort());
  for (const code of SPEC_CODES) assert.equal(ERROR_CODES[code], code);
  assert.equal(Object.isFrozen(ERROR_CODES), true);
});

test('every code has a plain-English message that tells the cashier what happened', () => {
  for (const code of SPEC_CODES) {
    const message = userMessage(code, { retryAfterSec: 30 });
    assert.equal(typeof message, 'string', code);
    assert.ok(message.length >= 20, `${code}: too short: ${message}`);
    assert.match(message, /^[A-Z]/, `${code}: starts with a capital letter`);
    assert.match(message, /[.!]$/, `${code}: ends like a sentence`);
    assert.doesNotMatch(message, /[A-Z]{3,}_[A-Z_]+/, `${code}: no raw error code in the text`);
    assert.doesNotMatch(message, /ENOENT|EACCES|errno|exit code|stack|exception|undefined|null|\[object/i, `${code}: no technical wording`);
  }
});

test('failure messages say what to do next', () => {
  const advice = /(check|try again|choose|open |enter|reload|restart|reinstall|contact|set one|turn it on)/i;
  for (const code of SPEC_CODES) {
    assert.match(userMessage(code), advice, `${code}: gives a next step`);
  }
});

test('the SPEC example message for DYMO_NO_PRINTER is used word for word', () => {
  assert.equal(
    userMessage(ERROR_CODES.DYMO_NO_PRINTER),
    'No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on.',
  );
});

test('lockout messages use details.retryAfterSec', () => {
  for (const code of [ERROR_CODES.DRAWER_LOCKED_OUT, ERROR_CODES.PASSWORD_LOCKED_OUT]) {
    assert.equal(userMessage(code, { retryAfterSec: 30 }), 'Too many wrong passwords. Try again in 30 seconds.');
    assert.equal(userMessage(code, { retryAfterSec: 1 }), 'Too many wrong passwords. Try again in 1 second.');
    assert.equal(userMessage(code, { retryAfterSec: 58.2 }), 'Too many wrong passwords. Try again in 59 seconds.');
    assert.equal(userMessage(code, { retryAfterSec: 59.2 }), 'Too many wrong passwords. Try again in 1 minute.');
    assert.equal(userMessage(code, { retryAfterSec: 60 }), 'Too many wrong passwords. Try again in 1 minute.');
    assert.equal(userMessage(code, { retryAfterSec: 90 }), 'Too many wrong passwords. Try again in 2 minutes.');
    assert.equal(userMessage(code, { retryAfterSec: 300 }), 'Too many wrong passwords. Try again in 5 minutes.');
    assert.equal(userMessage(code, { retryAfterSec: 0 }), 'Too many wrong passwords. Try again in a moment.');
    assert.equal(userMessage(code, { retryAfterSec: NaN }), 'Too many wrong passwords. Try again in a moment.');
    assert.equal(userMessage(code, { retryAfterSec: '45' }), 'Too many wrong passwords. Try again in 45 seconds.');
    assert.equal(userMessage(code), 'Too many wrong passwords. Try again in a moment.');
    assert.equal(userMessage(code, null), 'Too many wrong passwords. Try again in a moment.');
  }
});

test('PRINTER_NOT_FOUND names the printer when it is known, safely', () => {
  assert.match(userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: 'EPSON TM-T20III' }), /"EPSON TM-T20III" was not found/);
  assert.equal(userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: '' }), userMessage(ERROR_CODES.PRINTER_NOT_FOUND));
  assert.equal(userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: 42 }), userMessage(ERROR_CODES.PRINTER_NOT_FOUND));
  const hostile = userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: 'Bad\nName\u0000\u001b[31m' });
  assert.doesNotMatch(hostile, /[\u0000-\u001f]/, 'control characters are removed');
  const long = userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: 'X'.repeat(500) });
  assert.ok(long.length < 220, 'a very long name is cut');
  assert.match(long, /\.\.\./);
});

test('DYMO_PRINT_FAILED reports how many labels were printed when a batch stopped', () => {
  assert.match(userMessage(ERROR_CODES.DYMO_PRINT_FAILED, { printed: 2, total: 5 }), /2 of 5 labels were printed\.$/);
  assert.match(userMessage(ERROR_CODES.DYMO_PRINT_FAILED, { printed: 0, total: 3 }), /0 of 3 labels were printed\.$/);
  const plain = userMessage(ERROR_CODES.DYMO_PRINT_FAILED);
  assert.equal(userMessage(ERROR_CODES.DYMO_PRINT_FAILED, { printed: 0, total: 1 }), plain, 'a single label needs no progress text');
  assert.equal(userMessage(ERROR_CODES.DYMO_PRINT_FAILED, { printed: 5, total: 5 }), plain);
  assert.equal(userMessage(ERROR_CODES.DYMO_PRINT_FAILED, { printed: 'x', total: 'y' }), plain);
});

test('an unknown or missing code gives the generic message', () => {
  const generic = userMessage(ERROR_CODES.UNKNOWN);
  assert.equal(userMessage('NOT_A_CODE'), generic);
  assert.equal(userMessage(undefined), generic);
  assert.equal(userMessage('toString'), generic);
  assert.equal(userMessage('__proto__'), generic);
});

test('PrintError carries code, details and the default message of its code', () => {
  const err = new PrintError(ERROR_CODES.PRINTER_NOT_FOUND, undefined, { printerName: 'Zebra' });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PrintError);
  assert.equal(err.name, 'PrintError');
  assert.equal(err.code, ERROR_CODES.PRINTER_NOT_FOUND);
  assert.deepEqual(err.details, { printerName: 'Zebra' });
  assert.equal(err.message, userMessage(ERROR_CODES.PRINTER_NOT_FOUND, { printerName: 'Zebra' }));
  assert.match(err.stack, /PrintError/);
});

test('PrintError accepts its own message and ignores details that are not plain objects', () => {
  const custom = new PrintError(ERROR_CODES.INVALID_SETTINGS, 'This port name cannot be used.', { reason: 'x' });
  assert.equal(custom.message, 'This port name cannot be used.');
  assert.equal(new PrintError(ERROR_CODES.UNKNOWN, '').message, userMessage(ERROR_CODES.UNKNOWN));
  assert.equal(new PrintError(ERROR_CODES.UNKNOWN, null, 'text').details, undefined);
  assert.equal(new PrintError(ERROR_CODES.UNKNOWN, null, [1, 2]).details, undefined);
  assert.equal(new PrintError(ERROR_CODES.UNKNOWN, null, null).details, undefined);
});

test('PrintError turns an unknown code into UNKNOWN', () => {
  const err = new PrintError('MADE_UP');
  assert.equal(err.code, ERROR_CODES.UNKNOWN);
  assert.equal(err.message, userMessage(ERROR_CODES.UNKNOWN));
});

test('ok() is { ok: true } and may carry details', () => {
  assert.deepEqual(ok(), { ok: true });
  assert.deepEqual(ok({ prompted: true }), { ok: true, details: { prompted: true } });
  assert.deepEqual(ok('text'), { ok: true });
  assert.deepEqual(ok(null), { ok: true });
});

test('toResult keeps code, message and details of a PrintError', () => {
  const result = toResult(new PrintError(ERROR_CODES.DRAWER_LOCKED_OUT, undefined, { retryAfterSec: 60 }));
  assert.deepEqual(result, {
    ok: false,
    code: 'DRAWER_LOCKED_OUT',
    message: 'Too many wrong passwords. Try again in 1 minute.',
    details: { retryAfterSec: 60 },
  });
});

test('toResult leaves out details when there are none', () => {
  const result = toResult(new PrintError(ERROR_CODES.PRINT_TIMEOUT));
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok']);
  assert.equal(result.ok, false);
});

test('toResult never leaks the text of a foreign error', () => {
  const result = toResult(new Error('ENOENT: no such file C:\\Users\\secret\\receipt.bin'));
  assert.deepEqual(result, { ok: false, code: 'UNKNOWN', message: userMessage(ERROR_CODES.UNKNOWN) });
  for (const value of [undefined, null, 'text', 42, {}, { code: 'SPOOLER_ERROR' }]) {
    assert.equal(toResult(value).code, 'UNKNOWN');
  }
});

test('a PrintError from another copy of the module is recognised by its shape', () => {
  const foreign = Object.assign(new Error('Printer is on fire.'), { name: 'PrintError', code: 'SPOOLER_ERROR', details: { a: 1 } });
  assert.equal(isPrintError(foreign), true);
  assert.deepEqual(toResult(foreign), { ok: false, code: 'SPOOLER_ERROR', message: 'Printer is on fire.', details: { a: 1 } });
  assert.equal(isPrintError(Object.assign(new Error('x'), { name: 'PrintError', code: 'NOPE' })), false);
  assert.equal(isPrintError(new Error('x')), false);
  assert.equal(isPrintError(null), false);
});
