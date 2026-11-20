'use strict';

/**
 * The printer lists of Settings > Printers and of the web's `getPrinters()` (SPEC 6.1, 6.2):
 *
 *   { system: [{ name, displayName, isDefault, status }], dymo: [{ name, modelName, isConnected }], dymoError?: string }
 *
 * `system` are the printers the operating system knows (Electron's `webContents.getPrintersAsync()`), `dymo` the ones DYMO
 * Connect reports. Either list may fail on its own, and neither failure may hide the other:
 *   - when the system list cannot be read the answer is a failed Result that STILL carries both lists (the page reads
 *     `ok === false` for its message and the arrays for what it can show);
 *   - when DYMO cannot be reached `dymoError` says why in plain English, and the system list is complete.
 *
 * Pure Node: the two sources are injected.
 */

const { ERROR_CODES, userMessage } = require('./errors');

/** @param {unknown} value @returns {string} */
const text = (value) => (typeof value === 'string' ? value : '');

/**
 * @param {unknown} raw what `getPrintersAsync` resolved with
 * @returns {Array<{ name: string, displayName: string, isDefault: boolean, status: unknown }>} only entries that have a name
 */
function normalizeSystemPrinters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((printer) => printer !== null && typeof printer === 'object' && text(printer.name) !== '')
    .map((printer) => ({
      name: printer.name,
      displayName: text(printer.displayName) || printer.name,
      isDefault: printer.isDefault === true,
      status: printer.status,
    }));
}

/**
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.getPrintersAsync the operating system's printers
 * @param {{ listPrinters: () => Promise<{ printers: object[], error?: string }> }} deps.dymo
 * @param {{ warn?: Function }} [deps.log]
 * @returns {() => Promise<object>} the list function
 */
function createPrinterLister({ getPrintersAsync, dymo, log = {} }) {
  const warn = (message) => {
    if (typeof log.warn === 'function') log.warn(message);
  };

  return async function listPrinters() {
    let system = [];
    let systemFailed = false;
    try {
      system = normalizeSystemPrinters(await getPrintersAsync());
    } catch (error) {
      systemFailed = true;
      warn(`the printer list could not be read (${error && error.message})`);
    }

    let dymoPrinters = [];
    let dymoError;
    try {
      const listed = await dymo.listPrinters();
      dymoPrinters = (Array.isArray(listed && listed.printers) ? listed.printers : [])
        .filter((printer) => printer !== null && typeof printer === 'object' && text(printer.name) !== '')
        .map((printer) => ({ name: printer.name, modelName: text(printer.modelName) || printer.name, isConnected: printer.isConnected === true }));
      if (listed && typeof listed.error === 'string' && listed.error) dymoError = listed.error;
    } catch (error) {
      warn(`the DYMO printer list could not be read (${error && error.message})`);
      dymoError = userMessage(ERROR_CODES.DYMO_UNAVAILABLE);
    }

    const lists = { system, dymo: dymoPrinters };
    if (dymoError) lists.dymoError = dymoError;
    if (systemFailed) {
      return { ok: false, code: ERROR_CODES.UNKNOWN, message: 'The list of printers could not be read.', ...lists };
    }
    return lists;
  };
}

module.exports = { createPrinterLister, normalizeSystemPrinters };
