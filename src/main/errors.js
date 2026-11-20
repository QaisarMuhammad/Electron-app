'use strict';

/**
 * Result and error model shared by every main-process module (SPEC section 7).
 *
 *   Result = { ok: true, details? } | { ok: false, code, message, details? }
 *
 * Every failure carries one of the ERROR_CODES and a plain-English message a cashier can act on.
 * `details` is always plain JSON-safe data (it crosses the IPC boundary): never an Error, a function or a Buffer.
 */

const CODE_NAMES = [
  'INVALID_PAYLOAD', 'UNTRUSTED_SENDER', 'NO_PRINTER_CONFIGURED', 'PRINTER_NOT_FOUND', 'UNSUPPORTED_PLATFORM',
  'SPOOLER_ERROR', 'PORT_WRITE_FAILED', 'PRINT_TIMEOUT',
  'DYMO_UNAVAILABLE', 'DYMO_NO_PRINTER', 'DYMO_TEMPLATE_MISSING', 'DYMO_PRINT_FAILED',
  'DRAWER_DISABLED', 'DRAWER_PASSWORD_NOT_SET', 'DRAWER_WRONG_PASSWORD', 'DRAWER_LOCKED_OUT', 'DRAWER_FAILED',
  'PASSWORD_REQUIRED', 'PASSWORD_WRONG', 'PASSWORD_TOO_SHORT', 'PASSWORD_LOCKED_OUT',
  'INVALID_SETTINGS', 'UPDATE_UNAVAILABLE', 'UNKNOWN',
];

/** Every error code, as a frozen name -> name map. */
const ERROR_CODES = Object.freeze(Object.fromEntries(CODE_NAMES.map((name) => [name, name])));

/** Longest printer or share name shown inside a message; longer ones are cut so a message stays one readable line. */
const MAX_NAME_IN_MESSAGE = 60;

/** Static messages: each says what happened and what to do next. Codes that depend on details are built in `userMessage`. */
const MESSAGES = Object.freeze({
  INVALID_PAYLOAD: 'GadgetsPOS received a print request it could not read. Try again. If it keeps happening, restart GadgetsPOS or contact support.',
  UNTRUSTED_SENDER: 'GadgetsPOS blocked this request because it did not come from your POS page. Reload the POS page and try again.',
  NO_PRINTER_CONFIGURED: 'No printer is set up yet. Open Settings > Printers, choose your printer and press Save.',
  PRINTER_NOT_FOUND: 'The printer was not found. Check that it is switched on and connected, then choose it again in Settings > Printers.',
  UNSUPPORTED_PLATFORM: 'This kind of printer connection only works on Windows. In Settings > Printers, choose an installed printer instead.',
  SPOOLER_ERROR: 'The computer could not send the job to the printer. Check that the printer is on, has paper and shows no error light, then try again.',
  PORT_WRITE_FAILED: 'Nothing could be sent to the printer port. Check the cable or the network share, and the port name in Settings > Printers, then try again.',
  PRINT_TIMEOUT: 'The printer did not answer in time. Check that it is switched on, has paper and is connected, then try again.',
  DYMO_UNAVAILABLE: 'DYMO label printing is not ready. Check that DYMO Connect is installed and running, then try again.',
  DYMO_NO_PRINTER: 'No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on.',
  DYMO_TEMPLATE_MISSING: 'A label layout file is missing. Reinstall GadgetsPOS, or contact support if this keeps happening.',
  DYMO_PRINT_FAILED: 'The DYMO label could not be printed. Check the label roll and the printer, then try again.',
  DRAWER_DISABLED: 'The cash drawer is switched off. A manager can turn it on in Settings > Cash drawer.',
  DRAWER_PASSWORD_NOT_SET: 'No cash drawer password is set yet. A manager must set one in Settings > Cash drawer before the drawer can be opened.',
  DRAWER_WRONG_PASSWORD: 'That password is not correct. Try again.',
  DRAWER_FAILED: 'The cash drawer did not open. Check the cable between the drawer and the receipt printer, and that the receipt printer is switched on.',
  PASSWORD_REQUIRED: 'Enter the password to continue.',
  PASSWORD_WRONG: 'That password is not correct. Try again.',
  PASSWORD_TOO_SHORT: 'The password must be 4 to 64 characters long. Choose another one.',
  INVALID_SETTINGS: 'These settings cannot be used. Check the values and try again.',
  UPDATE_UNAVAILABLE: 'Updates are not available right now. Check the internet connection and try again later.',
  UNKNOWN: 'Something went wrong. Try again, and contact support if it keeps happening.',
});

/**
 * Turns a number of seconds into a short phrase: "30 seconds", "1 minute", "5 minutes". Rounds up, so the
 * cashier is never told to retry too early.
 *
 * @param {unknown} seconds
 * @returns {string}
 */
function formatWait(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return 'a moment';
  const rounded = Math.ceil(total);
  if (rounded < 60) return `${rounded} ${rounded === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(rounded / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Makes a user-supplied name safe to show inside a sentence: control characters removed, length capped.
 *
 * @param {unknown} name
 * @returns {string} '' when there is nothing usable
 */
function displayName(name) {
  if (typeof name !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_NAME_IN_MESSAGE ? `${clean.slice(0, MAX_NAME_IN_MESSAGE - 3)}...` : clean;
}

/**
 * Appends how many labels were printed when a multi-label job stopped part-way (`details.printed` / `details.total`).
 *
 * @param {string} base
 * @param {object|undefined} details
 * @returns {string}
 */
function withProgress(base, details) {
  const printed = details && details.printed;
  const total = details && details.total;
  if (!Number.isInteger(printed) || !Number.isInteger(total) || total < 2 || printed < 0 || printed >= total) return base;
  return `${base} ${printed} of ${total} labels were printed.`;
}

/**
 * Plain-English message for an error code. Always safe to show to a cashier.
 *
 * @param {string} code one of ERROR_CODES (anything else gives the UNKNOWN text)
 * @param {object} [details] optional context: `retryAfterSec` (lockouts), `printerName` (PRINTER_NOT_FOUND),
 *   `printed` and `total` (DYMO_PRINT_FAILED)
 * @returns {string}
 */
function userMessage(code, details) {
  const info = details !== null && typeof details === 'object' ? details : undefined;
  switch (code) {
    case ERROR_CODES.DRAWER_LOCKED_OUT:
    case ERROR_CODES.PASSWORD_LOCKED_OUT:
      return `Too many wrong passwords. Try again in ${formatWait(info && info.retryAfterSec)}.`;
    case ERROR_CODES.PRINTER_NOT_FOUND: {
      const name = displayName(info && info.printerName);
      return name
        ? `The printer "${name}" was not found. Check that it is switched on and connected, then choose it again in Settings > Printers.`
        : MESSAGES.PRINTER_NOT_FOUND;
    }
    case ERROR_CODES.DYMO_PRINT_FAILED:
      return withProgress(MESSAGES.DYMO_PRINT_FAILED, info);
    default:
      return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : MESSAGES.UNKNOWN;
  }
}

/**
 * An error that maps to a Result. `message` defaults to the cashier-friendly text for the code, so
 * `err.message` can always be shown as is; put technical context in `details` (plain data only).
 */
class PrintError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} [message] overrides the default message of the code
   * @param {object} [details] plain JSON-safe context
   */
  constructor(code, message, details) {
    const safeDetails = details !== null && typeof details === 'object' && !Array.isArray(details) ? details : undefined;
    const knownCode = Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? code : ERROR_CODES.UNKNOWN;
    super(typeof message === 'string' && message ? message : userMessage(knownCode, safeDetails));
    this.name = 'PrintError';
    this.code = knownCode;
    this.details = safeDetails;
    if (Error.captureStackTrace) Error.captureStackTrace(this, PrintError);
  }
}

/**
 * True for a PrintError, including one created by another copy of this module (checked by shape).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isPrintError(err) {
  if (err instanceof PrintError) return true;
  return Boolean(err) && err.name === 'PrintError' && typeof err.code === 'string'
    && Object.prototype.hasOwnProperty.call(ERROR_CODES, err.code) && typeof err.message === 'string';
}

/**
 * The success Result.
 *
 * @param {object} [details] optional extra data, for example `{ prompted: true }`
 * @returns {{ok: true, details?: object}}
 */
function ok(details) {
  return details !== null && typeof details === 'object' ? { ok: true, details } : { ok: true };
}

/**
 * Converts anything thrown into a failure Result. A PrintError keeps its code, message and details; any other
 * value becomes UNKNOWN with the generic message (its text is technical, so it is never passed on).
 *
 * @param {unknown} err
 * @returns {{ok: false, code: string, message: string, details?: object}}
 */
function toResult(err) {
  if (isPrintError(err)) {
    const result = { ok: false, code: err.code, message: err.message };
    if (err.details !== undefined) result.details = err.details;
    return result;
  }
  return { ok: false, code: ERROR_CODES.UNKNOWN, message: userMessage(ERROR_CODES.UNKNOWN) };
}

/**
 * Shortens technical text (stderr output, a system error message) so it can sit in `details`: control characters
 * become spaces, runs of whitespace collapse, and the result is cut to `max` characters.
 *
 * @param {unknown} text
 * @param {number} [max=200]
 * @returns {string} '' when there is no text
 */
function clipDetail(text, max = 200) {
  if (text === undefined || text === null) return '';
  // eslint-disable-next-line no-control-regex
  const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

module.exports = { ERROR_CODES, PrintError, isPrintError, ok, toResult, userMessage, clipDetail };
