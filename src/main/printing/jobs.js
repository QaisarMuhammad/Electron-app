'use strict';

/**
 * The print service: the one place where a request from the web page (or from Settings) is turned into a job for the right
 * printer (SPEC 3, 9 and 12). It ties together the receipt printer, the Zebra printer, the DYMO service and the cash drawer,
 * and it ALWAYS answers a Result (`{ ok: true, details? }` or `{ ok: false, code, message, details? }`), never an exception.
 *
 * Routing is exactly v1's:
 *   - a receipt request is `{ receiptFileBinary, ... }`; the web's Open button sends `{ openCashDrawer: true }` with no `order`,
 *     which is a request to open the drawer (the password window), not a receipt;
 *   - a label request is `{ barcodefinal, ... }`: an object with `printer: 'dymo'` goes to DYMO (that includes lab and repair
 *     labels), everything else is the Zebra path (a ZPL string, or `{ printer: 'zebra', zpl }`).
 *
 * Only the fields the app reads are looked at (SPEC 12): legacy receipt payloads carry whole `order`, `business` and `settings`
 * objects, and a repair label carries the whole order item. Nothing else is inspected, copied or logged.
 */

const { PrintError, ERROR_CODES, ok, toResult } = require('../errors');
const { createReceiptPrinter } = require('./receipt');
const { createZebraPrinter } = require('./zebra');

/** DYMO labels are printed one after the other, in the order they were sent, like the jobs of every other printer. */
const DYMO_QUEUE_KEY = 'dymo';

/** A DYMO job may include starting the helper window (15 s) and several scripts (20 s each): far more than a raw print job. */
const DYMO_JOB_TIMEOUT_MS = 180 * 1000;

/** @param {unknown} value @returns {boolean} true for `{}` and class instances, false for null and arrays */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} code one of ERROR_CODES
 * @param {object} [details]
 * @returns {{ok: false, code: string, message: string, details?: object}}
 */
function failure(code, details) {
  return toResult(new PrintError(code, undefined, details));
}

/**
 * @param {object} deps
 * @param {{ get: (path: string, fallback?: any) => any }} deps.config the settings (`drawer.enabled`, `drawer.passwordRecord` and the printers)
 * @param {{ printRaw: Function }} [deps.rawPrinter] builds the receipt and Zebra printers when they are not given
 * @param {{ print: (payload: object) => Promise<object> }} deps.dymo the DYMO service
 * @param {{ open: (request: {password?: string, source?: string}) => Promise<object> }} deps.drawer
 * @param {{ print: (payload: unknown) => Promise<object> }} [deps.receiptPrinter] defaults to one on `rawPrinter` and `printers.receipt`
 * @param {{ print: (payload: unknown) => Promise<object> }} [deps.zebraPrinter] defaults to one on `rawPrinter` and `printers.label`
 * @param {{ enqueue: Function }} [deps.queue] when given, DYMO labels run through it (one at a time, in order)
 * @param {() => void} [deps.promptDrawer] shows the password window for the cash drawer
 * @param {{ info?: Function, warn?: Function }} [deps.log]
 * @param {() => number} [deps.now=Date.now]
 * @returns {{
 *   printReceipt: (payload: unknown) => Promise<object>,
 *   printBarcode: (payload: unknown) => Promise<object>,
 *   openDrawer: (args: unknown, options?: {source?: string}) => Promise<object>,
 *   requestDrawerPrompt: () => Promise<object>
 * }}
 */
function createPrintService({ config, rawPrinter, dymo, drawer, receiptPrinter, zebraPrinter, queue, promptDrawer, log, now = Date.now }) {
  const missing = [];
  if (!config || typeof config.get !== 'function') missing.push('config');
  if (!dymo || typeof dymo.print !== 'function') missing.push('dymo');
  if (!drawer || typeof drawer.open !== 'function') missing.push('drawer');
  if (!receiptPrinter && !rawPrinter) missing.push('receiptPrinter or rawPrinter');
  if (!zebraPrinter && !rawPrinter) missing.push('zebraPrinter or rawPrinter');
  if (missing.length > 0) throw new TypeError(`createPrintService is missing: ${missing.join(', ')}`);

  const receipts = receiptPrinter || createReceiptPrinter({ rawPrinter, getTarget: () => config.get('printers.receipt'), log });
  const labels = zebraPrinter || createZebraPrinter({ rawPrinter, getTarget: () => config.get('printers.label'), log });

  /**
   * Runs one job, logs its outcome in a line (kind, result, duration and error code: never a payload) and turns anything
   * thrown into a failed Result.
   */
  async function run(kind, job) {
    const startedAt = now();
    let result;
    try {
      result = await job();
    } catch (error) {
      result = toResult(error);
    }
    const outcome = result && result.ok === true ? 'ok' : `failed (${(result && result.code) || ERROR_CODES.UNKNOWN})`;
    const level = result && result.ok === true ? 'info' : 'warn';
    if (log && typeof log[level] === 'function') log[level](`job ${kind}: ${outcome} in ${now() - startedAt} ms`);
    return result;
  }

  /** The Open button: after the checks that need no password, show the password window. */
  async function requestDrawerPrompt() {
    if (config.get('drawer.enabled', true) === false) return failure(ERROR_CODES.DRAWER_DISABLED);
    if (!config.get('drawer.passwordRecord', null)) return failure(ERROR_CODES.DRAWER_PASSWORD_NOT_SET);
    try {
      promptDrawer();
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn(`the drawer password window could not be shown (${error && error.message})`);
      return failure(ERROR_CODES.DRAWER_FAILED);
    }
    return ok({ prompted: true });
  }

  /** DYMO labels go through the queue, so a batch comes out in the order it was sent. */
  function printDymo(payload) {
    if (!queue) return dymo.print(payload);
    return queue
      .enqueue(DYMO_QUEUE_KEY, () => dymo.print(payload), { label: 'label dymo', timeoutMs: DYMO_JOB_TIMEOUT_MS })
      .catch(toResult);
  }

  return {
    /**
     * A receipt, or the Open drawer request of the web's Open button.
     *
     * @param {unknown} payload `{ receiptFileBinary, ... }` or `{ openCashDrawer: true, order: false, ... }`
     * @returns {Promise<object>} `{ ok: true, details: { prompted: true } }` for the Open request (the password window is showing)
     */
    printReceipt(payload) {
      if (!isObject(payload)) return Promise.resolve(failure(ERROR_CODES.INVALID_PAYLOAD, { reason: 'not-an-object' }));
      if (payload.openCashDrawer === true && !payload.order) return run('drawer prompt', requestDrawerPrompt);
      if (!payload.receiptFileBinary) return Promise.resolve(failure(ERROR_CODES.INVALID_PAYLOAD, { reason: 'no-receipt' }));
      return run('receipt', () => receipts.print(payload));
    },

    /**
     * One label. DYMO when `barcodefinal.printer === 'dymo'`, otherwise Zebra.
     *
     * @param {unknown} payload the legacy `send-barcode-data` envelope
     * @returns {Promise<object>}
     */
    printBarcode(payload) {
      if (!isObject(payload)) return Promise.resolve(failure(ERROR_CODES.INVALID_PAYLOAD, { reason: 'not-an-object' }));
      const label = payload.barcodefinal;
      if (label === null || label === undefined) return Promise.resolve(failure(ERROR_CODES.INVALID_PAYLOAD, { reason: 'no-label' }));
      if (isObject(label) && label.printer === 'dymo') return run('label dymo', () => printDymo(payload));
      return run('label zebra', () => labels.print(label));
    },

    /**
     * Opens the cash drawer with a password that came with the call (`{ password }`, or the legacy `{ cashDrawerOpenPassword }`).
     *
     * @param {unknown} args
     * @param {{ source?: string }} [options] labels the log: 'web' (default) or 'legacy'
     * @returns {Promise<object>}
     */
    openDrawer(args, { source = 'web' } = {}) {
      const request = isObject(args) ? args : {};
      const password = typeof request.password === 'string' ? request.password : request.cashDrawerOpenPassword;
      return run('drawer', () => drawer.open({ password: typeof password === 'string' ? password : undefined, source }));
    },

    requestDrawerPrompt: () => run('drawer prompt', requestDrawerPrompt),
  };
}

module.exports = { createPrintService, DYMO_QUEUE_KEY, DYMO_JOB_TIMEOUT_MS };
