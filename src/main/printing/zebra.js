'use strict';

/**
 * Zebra (ZPL) labels (SPEC 9.3 and 9.5): turns a ZPL string into a raw job for the label printer, and builds the
 * test label printed from Settings.
 *
 * Every call builds its own bytes and its own temp file (in the raw printer), and jobs for one printer run one after
 * the other, so a batch of labels can no longer overwrite each other's file like v1's shared `label.zpl` did.
 */

const { PrintError, ERROR_CODES, ok, toResult } = require('../errors');
const { resolveTarget } = require('./transports');

/** Largest label accepted, in UTF-8 bytes. */
const MAX_ZPL_BYTES = 64 * 1024;

/**
 * @param {string} reason
 * @returns {PrintError}
 */
function invalid(reason) {
  return new PrintError(ERROR_CODES.INVALID_PAYLOAD, undefined, { reason });
}

/**
 * Reads the ZPL out of the legacy string or `{ printer: 'zebra', zpl }`.
 *
 * @param {unknown} input
 * @returns {Buffer} UTF-8 bytes
 * @throws {PrintError} INVALID_PAYLOAD for a missing, blank or oversized label, or another printer type
 */
function zplBytes(input) {
  let zpl = input;
  if (input !== null && typeof input === 'object') {
    if (input.printer !== undefined && input.printer !== 'zebra') throw invalid('wrong-printer');
    zpl = input.zpl;
  }
  if (typeof zpl !== 'string' || zpl.trim() === '') throw invalid('empty');
  if (Buffer.byteLength(zpl, 'utf8') > MAX_ZPL_BYTES) throw invalid('too-large');
  return Buffer.from(zpl, 'utf8');
}

/**
 * Creates the Zebra printer.
 *
 * @param {object} deps
 * @param {{printRaw: Function}} deps.rawPrinter from transports/index.js
 * @param {() => (object|Promise<object>)} deps.getTarget returns `config.printers.label` (`{ transport, printerName, port }`)
 * @param {{warn?: Function}} [deps.log]
 * @returns {{print: (zplOrObject: unknown) => Promise<{ok: boolean, code?: string, message?: string, details?: object}>}}
 */
function createZebraPrinter({ rawPrinter, getTarget, log }) {
  /**
   * Prints one label. Never rejects: every failure is a Result.
   *
   * @param {string|{printer?: string, zpl: string}} zplOrObject the legacy ZPL string, or `{ printer: 'zebra', zpl }`
   * @returns {Promise<{ok: boolean, code?: string, message?: string, details?: object}>}
   */
  async function print(zplOrObject) {
    try {
      const bytes = zplBytes(zplOrObject);
      const target = resolveTarget(typeof getTarget === 'function' ? await getTarget() : null);
      await rawPrinter.printRaw({ target, data: bytes, label: 'label zebra', ext: 'zpl' });
      return ok();
    } catch (error) {
      log?.warn?.('label print failed', { code: error && error.code });
      return toResult(error);
    }
  }

  return { print };
}

/**
 * The label printed by Settings > Printers > Test (Zebra): the word TEST and a Code 128 sample.
 *
 * @returns {string} ZPL
 */
function buildTestZpl() {
  return [
    '^XA',
    '^FO40,30^A0N,50,50^FDTEST^FS',
    '^FO40,100^BY2^BCN,70,Y,N,N^FD123456789^FS',
    '^XZ',
    '',
  ].join('\n');
}

module.exports = { createZebraPrinter, buildTestZpl, MAX_ZPL_BYTES };
