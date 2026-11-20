'use strict';

/**
 * Shared set-up of the drawer tests: the REAL config (over the fake Store in a temp folder), the REAL password
 * module, the REAL throttle with a controllable clock, and a fake raw printer that records its jobs.
 * Not named *.test.js: node --test must not run it.
 */

const assert = require('node:assert/strict');

const password = require('../../src/main/password');
const { createConfig } = require('../../src/main/config');
const { createDrawer } = require('../../src/main/printing/drawer');
const errors = require('../../src/main/errors');
const { createFakeStoreEnv, createRecordingLog } = require('../helpers/fake-store');

/** The drawer password used by most tests, hashed ONCE per test file (hashing costs about 60 ms). */
const PLAIN = '1234';
const RECORD = password.hashPassword(PLAIN);

/** A receipt printer that is set up. */
const PRINTER = Object.freeze({ transport: 'system', printerName: 'EPSON TM-T20' });

/**
 * @param {import('node:test').TestContext} t
 * @param {{record?: object|null, printer?: object|null, printRaw?: Function, rawPrinter?: object}} [options]
 *   `record: null` = no password set; `printer: null` = leave the receipt printer unconfigured; `printRaw` = how the
 *   fake printer behaves; `rawPrinter` = use this raw printer (for example T1's real one) instead of the fake
 */
function createHarness(t, { record = RECORD, printer = PRINTER, printRaw, rawPrinter: realRawPrinter } = {}) {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  const log = createRecordingLog();
  const config = createConfig({ Store: env.Store, log });
  if (record) assert.equal(config.setPasswordRecord(record).ok, true);
  if (printer) assert.equal(config.setPrinter('receipt', printer).ok, true);

  const clock = {
    time: 1_700_000_000_000,
    advance(ms) {
      this.time += ms;
    },
  };
  const throttle = password.createThrottle({ now: () => clock.time });
  const rawPrinter = realRawPrinter || {
    calls: [],
    behaviour: printRaw || (async () => ({ ok: true })),
    printRaw(job) {
      this.calls.push(job);
      return this.behaviour(job);
    },
  };
  const drawer = createDrawer({ config, rawPrinter, password, throttle, log });
  return { env, log, config, clock, throttle, rawPrinter, drawer };
}

/** Assert a failed Result: its code, a readable message (T1's text for that code and details), and optionally its exact details. */
function assertFailure(result, code, details) {
  assert.equal(result.ok, false, `expected ${code}, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, 'string');
  assert.equal(result.message, errors.userMessage(code, result.details), 'the message is the plain-English text of the code');
  if (details === undefined) assert.equal(result.details, undefined, `no details expected for ${code}`);
  else assert.deepEqual(result.details, details);
}

module.exports = { createHarness, assertFailure, PLAIN, RECORD, PRINTER, errors, password };
