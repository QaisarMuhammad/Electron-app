'use strict';

/**
 * Cash drawer: the pulse bytes and the password-protected orchestration (SPEC section 10).
 *
 * Every way of opening the drawer (the menu and Ctrl+D through the prompt window, the web's
 * `openCashDrawer` / `sendOpenDrawerCommand`, the Settings test button) ends in the same `open()`. The
 * password prompts of Settings and the factory reset use `checkPassword`, and changing or removing the
 * password uses `setPassword` / `clearPassword`. All of them share ONE throttle, so five wrong guesses
 * anywhere lock every door. Receipt bytes (including a drawer kick embedded in a receipt) never come
 * through here; they are sent verbatim by the receipt path.
 *
 * Failures are Results (`{ ok: false, code, message, details? }`), never exceptions. Passwords and
 * hashes are never logged or returned.
 */

const { ERROR_CODES, isPrintError, ok, toResult, userMessage } = require('../errors');

const ESC = 0x1b;
const PULSE_COMMAND = 0x70; // ESC p m t1 t2
const PULSE_UNIT_MS = 2; // t1 and t2 count units of 2 ms
const MIN_PULSE_UNITS = 1;
const MAX_PULSE_UNITS = 255;
/** The config defaults: they produce v1's bytes `1B 70 00 19 FF`. */
const DEFAULT_PULSE = Object.freeze({ pin: 2, onTimeMs: 50, offTimeMs: 510 });

/** Which Result code each kind of password failure gets: the drawer has its own, Settings and reset share another set. */
const DRAWER_CODES = Object.freeze({ locked: ERROR_CODES.DRAWER_LOCKED_OUT, wrong: ERROR_CODES.DRAWER_WRONG_PASSWORD });
const SETTINGS_CODES = Object.freeze({ locked: ERROR_CODES.PASSWORD_LOCKED_OUT, wrong: ERROR_CODES.PASSWORD_WRONG });

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,39}$/i;
const NOOP_LOG = Object.freeze({ info() {}, warn() {}, error() {} });

// ---------------------------------------------------------------------------------------------
// The pulse
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} ms
 * @param {number} fallbackMs used when `ms` is not a finite number
 * @returns {number} `min(255, max(1, round(ms / 2)))`: the number of 2 ms units for the printer
 */
function toPulseUnits(ms, fallbackMs) {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : fallbackMs;
  return Math.min(MAX_PULSE_UNITS, Math.max(MIN_PULSE_UNITS, Math.round(value / PULSE_UNIT_MS)));
}

/**
 * The ESC/POS drawer kick: `ESC p m t1 t2` with m = 0 for pin 2 and 1 for pin 5, t1 and t2 in units of 2 ms,
 * clamped to 1..255. Missing or unusable values fall back to the defaults, which give `1B 70 00 19 FF`.
 *
 * @param {{pin?: number, onTimeMs?: number, offTimeMs?: number}} [settings]
 * @returns {Buffer} 5 bytes
 */
function buildDrawerPulse(settings) {
  const { pin, onTimeMs, offTimeMs } = settings || {};
  return Buffer.from([
    ESC,
    PULSE_COMMAND,
    pin === 5 ? 1 : 0,
    toPulseUnits(onTimeMs, DEFAULT_PULSE.onTimeMs),
    toPulseUnits(offTimeMs, DEFAULT_PULSE.offTimeMs),
  ]);
}

// ---------------------------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------------------------

/** @param {unknown} error @returns {string} */
function describe(error) {
  return error && error.message ? String(error.message) : String(error);
}

/**
 * A failed Result. `message` is the plain-English text for the code; `details` is kept only when it has content.
 * @param {string} code one of ERROR_CODES
 * @param {object} [details]
 * @returns {{ok: false, code: string, message: string, details?: object}}
 */
function failure(code, details) {
  const result = { ok: false, code, message: userMessage(code, details) };
  if (details && Object.keys(details).length > 0) result.details = details;
  return result;
}

/** @param {unknown} source @returns {string} a short label for the log; anything odd becomes 'unknown' */
function describeSource(source) {
  return typeof source === 'string' && SOURCE_PATTERN.test(source) ? source : 'unknown';
}

/**
 * @typedef {{ok: true, details?: object}|{ok: false, code: string, message: string, details?: object}} Result
 */

/**
 * @param {object} deps
 * @param {{get: Function, set: Function, setPasswordRecord: Function}} deps.config the config object of src/main/config.js
 * @param {{printRaw: (job: object) => Promise<any>}} deps.rawPrinter the raw printer of the transports module; its rejections are PrintErrors
 * @param {{verifyPassword: Function, hashPassword: Function, needsRehash: Function, validatePasswordPolicy: Function}} deps.password src/main/password.js
 * @param {{check: Function, fail: Function, success: Function}} deps.throttle ONE `createThrottle()` instance shared by every password check
 * @param {{info: Function, warn: Function, error: Function}} [deps.log]
 * @returns {{
 *   open: (request?: {password?: string, source?: string}) => Promise<Result>,
 *   checkPassword: (request?: {password?: string}) => Result,
 *   setPassword: (request?: {current?: string, next?: string}) => Result,
 *   clearPassword: (request?: {current?: string}) => Result
 * }}
 */
function createDrawer({ config, rawPrinter, password, throttle, log = NOOP_LOG }) {
  /** Run a synchronous operation; anything unexpected becomes an UNKNOWN Result instead of an exception. */
  function guarded(what, operation) {
    try {
      return operation();
    } catch (error) {
      log.error(`drawer: ${what} failed unexpectedly (${describe(error)})`);
      return failure(ERROR_CODES.UNKNOWN);
    }
  }

  /**
   * After a correct password, re-save its hash when the stored record was made with other parameters than
   * today's. Best effort: it can never fail the check that triggered it. The `passwordWeak` flag is left alone.
   */
  function upgradeRecord(plain, record) {
    try {
      if (!password.needsRehash(record)) return;
      const saved = config.set('drawer.passwordRecord', password.hashPassword(plain));
      if (!saved.ok) log.warn('drawer: the stored password hash could not be upgraded');
    } catch (error) {
      log.warn(`drawer: the stored password hash could not be upgraded (${describe(error)})`);
    }
  }

  /**
   * The password gate shared by every flow. Order: locked out? a password given? is it right? A missing password
   * is not a guess and does not count as a failure. A wrong one is counted; the fifth in a row (and every one
   * after a lock) answers with `retryAfterSec` too, so the window can start its countdown at once.
   *
   * @param {unknown} plain
   * @param {{locked: string, wrong: string}} codes
   * @param {string} origin label for the log
   * @returns {Result} `{ ok: true }` when the password is right
   */
  function authenticate(plain, codes, origin) {
    const gate = throttle.check();
    if (!gate.allowed) {
      log.warn(`drawer: password refused while locked for ${gate.retryAfterSec} s (${origin})`);
      return failure(codes.locked, { retryAfterSec: gate.retryAfterSec });
    }
    if (typeof plain !== 'string' || plain.length === 0) return failure(ERROR_CODES.PASSWORD_REQUIRED);

    const record = config.get('drawer.passwordRecord', null);
    if (!password.verifyPassword(plain, record)) {
      const verdict = throttle.fail();
      const details = { attemptsLeft: verdict.attemptsLeft };
      if (!verdict.allowed) details.retryAfterSec = verdict.retryAfterSec;
      log.warn(`drawer: wrong password (${origin}), ${verdict.attemptsLeft} attempts left`);
      return failure(codes.wrong, details);
    }
    throttle.success();
    upgradeRecord(plain, record);
    return ok();
  }

  /**
   * Send the kick through the RECEIPT printer's transport. The raw printer validates the target, so a missing
   * printer comes back as its NO_PRINTER_CONFIGURED; every printer error keeps its own code.
   */
  async function sendPulse(origin) {
    const printer = config.get('printers.receipt', {});
    const data = buildDrawerPulse({
      pin: config.get('drawer.pin'),
      onTimeMs: config.get('drawer.onTimeMs'),
      offTimeMs: config.get('drawer.offTimeMs'),
    });
    try {
      await rawPrinter.printRaw({
        target: { transport: printer.transport, printerName: printer.printerName, port: printer.port },
        data,
        label: 'cash drawer',
      });
    } catch (error) {
      const result = isPrintError(error) ? toResult(error) : failure(ERROR_CODES.DRAWER_FAILED);
      log.error(`drawer: opening failed (${origin}): ${result.code} ${describe(error)}`);
      return result;
    }
    log.info(`drawer: opened (${origin})`);
    return ok();
  }

  /**
   * Open the drawer. Decision order: drawer disabled, no password set, locked out, no password given,
   * wrong password (counted), then the pulse. Attempts that are refused before the password is compared
   * (disabled, not set) never touch the throttle.
   *
   * @param {{password?: string, source?: string}} [request] `source` only labels the log ('menu', 'prompt', 'web', 'legacy', 'settings-test')
   * @returns {Promise<Result>}
   */
  async function open(request = {}) {
    const { password: plain, source } = request || {};
    const origin = describeSource(source);
    try {
      if (config.get('drawer.enabled', true) === false) return failure(ERROR_CODES.DRAWER_DISABLED);
      if (!config.get('drawer.passwordRecord', null)) return failure(ERROR_CODES.DRAWER_PASSWORD_NOT_SET);
      const auth = authenticate(plain, DRAWER_CODES, origin);
      if (!auth.ok) return auth;
      return await sendPulse(origin);
    } catch (error) {
      log.error(`drawer: opening failed unexpectedly (${origin}): ${describe(error)}`);
      return failure(ERROR_CODES.DRAWER_FAILED);
    }
  }

  /**
   * Ask for the drawer password in Settings and reset flows. When no password is set there is nothing to
   * protect and the call succeeds. Uses the PASSWORD_* codes and the same throttle as `open`.
   *
   * @param {{password?: string}} [request]
   * @returns {Result}
   */
  function checkPassword(request = {}) {
    return guarded('the password check', () => {
      if (!config.get('drawer.passwordRecord', null)) return ok();
      return authenticate((request || {}).password, SETTINGS_CODES, 'settings');
    });
  }

  /**
   * Set the drawer password, or change it. When one is already set the current one is required (and counted by
   * the throttle); the new one must pass the 4..64 policy. A new password clears the "weak" notice.
   *
   * @param {{current?: string, next?: string}} [request]
   * @returns {Result}
   */
  function setPassword(request = {}) {
    return guarded('setting the password', () => {
      const { current, next } = request || {};
      if (config.get('drawer.passwordRecord', null)) {
        const auth = authenticate(current, SETTINGS_CODES, 'settings');
        if (!auth.ok) return auth;
      }
      const policy = password.validatePasswordPolicy(next);
      if (!policy.ok) return { ok: false, code: policy.code, message: policy.message };
      const saved = config.setPasswordRecord(password.hashPassword(next));
      if (saved.ok) log.info('drawer: password changed');
      return saved;
    });
  }

  /**
   * Remove the drawer password (which also switches off "require the password for Settings"). The current
   * password is required when one is set; removing a password that is not set succeeds.
   *
   * @param {{current?: string}} [request]
   * @returns {Result}
   */
  function clearPassword(request = {}) {
    return guarded('removing the password', () => {
      if (!config.get('drawer.passwordRecord', null)) return ok();
      const auth = authenticate((request || {}).current, SETTINGS_CODES, 'settings');
      if (!auth.ok) return auth;
      const saved = config.setPasswordRecord(null);
      if (saved.ok) log.info('drawer: password removed');
      return saved;
    });
  }

  return { open, checkPassword, setPassword, clearPassword };
}

module.exports = { buildDrawerPulse, createDrawer };
