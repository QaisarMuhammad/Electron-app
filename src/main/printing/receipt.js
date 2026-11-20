'use strict';

/**
 * ESC/POS receipts (SPEC 9.2 and 9.5): turns the receipt bytes of a print request into a raw job for the receipt printer,
 * and builds the test slip printed from Settings.
 */

const { isAnyArrayBuffer } = require('node:util').types;
const { PrintError, ERROR_CODES, ok, toResult } = require('../errors');
const { resolveTarget } = require('./transports');

/** Largest receipt accepted (SPEC 12). */
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const TEST_LINE_WIDTH = 32;

/**
 * @param {string} reason
 * @returns {PrintError}
 */
function invalid(reason) {
  return new PrintError(ERROR_CODES.INVALID_PAYLOAD, undefined, { reason });
}

/**
 * @param {unknown[]} values
 * @returns {Buffer}
 */
function bytesFromNumbers(values) {
  if (values.length > MAX_RECEIPT_BYTES) throw invalid('too-large');
  const bytes = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isInteger(value) || value < 0 || value > 255) throw invalid('not-binary');
    bytes[i] = value;
  }
  return bytes;
}

/**
 * Coerces the receipt binary of a print request into a private Buffer.
 * Accepts a Buffer, a Uint8Array or any other ArrayBuffer view, an ArrayBuffer, the JSON form of a Buffer
 * (`{ type: 'Buffer', data: [...] }`) and a plain array of byte values.
 *
 * @param {unknown} payload
 * @returns {Buffer} a copy, so later changes to the caller's data cannot alter the job
 * @throws {PrintError} INVALID_PAYLOAD when it is empty, larger than 5 MB or not binary
 */
function normalizeReceiptBytes(payload) {
  let bytes;
  if (ArrayBuffer.isView(payload)) {
    if (payload.byteLength > MAX_RECEIPT_BYTES) throw invalid('too-large');
    bytes = Buffer.from(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  } else if (isAnyArrayBuffer(payload)) {
    if (payload.byteLength > MAX_RECEIPT_BYTES) throw invalid('too-large');
    bytes = Buffer.from(new Uint8Array(payload));
  } else if (Array.isArray(payload)) {
    bytes = bytesFromNumbers(payload);
  } else if (payload !== null && typeof payload === 'object' && payload.type === 'Buffer' && Array.isArray(payload.data)) {
    bytes = bytesFromNumbers(payload.data);
  } else {
    throw invalid('not-binary');
  }
  if (bytes.length === 0) throw invalid('empty');
  return bytes;
}

/** @returns {unknown} the receipt binary of an envelope `{ receiptFileBinary }`, or the value itself when it is not one */
function binaryOf(payload) {
  const isEnvelope = payload !== null && typeof payload === 'object' && !ArrayBuffer.isView(payload) && !isAnyArrayBuffer(payload)
    && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, 'receiptFileBinary');
  return isEnvelope ? payload.receiptFileBinary : payload;
}

/**
 * Creates the receipt printer.
 *
 * @param {object} deps
 * @param {{printRaw: Function}} deps.rawPrinter from transports/index.js
 * @param {() => (object|Promise<object>)} deps.getTarget returns `config.printers.receipt` (`{ transport, printerName, port }`)
 * @param {{warn?: Function}} [deps.log]
 * @returns {{print: (payload: unknown) => Promise<{ok: boolean, code?: string, message?: string, details?: object}>}}
 */
function createReceiptPrinter({ rawPrinter, getTarget, log }) {
  /**
   * Prints one receipt. Never rejects: every failure is a Result.
   *
   * @param {unknown} payload the receipt binary, or the legacy envelope `{ receiptFileBinary, ... }` (nothing else in it is read)
   * @returns {Promise<{ok: boolean, code?: string, message?: string, details?: object}>}
   */
  async function print(payload) {
    try {
      const bytes = normalizeReceiptBytes(binaryOf(payload));
      const target = resolveTarget(typeof getTarget === 'function' ? await getTarget() : null);
      await rawPrinter.printRaw({ target, data: bytes, label: 'receipt', ext: 'bin' });
      return ok();
    } catch (error) {
      log?.warn?.('receipt print failed', { code: error && error.code });
      return toResult(error);
    }
  }

  return { print };
}

/**
 * Keeps a value safe for a receipt line: printable ASCII only, cut to `max` characters.
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function asciiText(text, max) {
  return String(text === undefined || text === null ? '' : text).replace(/[^\x20-\x7e]+/g, '?').trim().slice(0, max);
}

/**
 * The slip printed by Settings > Printers > Test: init, centred title, a few plain ASCII lines, feed, full cut.
 *
 * @param {{printerName?: string, appName?: string}} [options]
 * @returns {Buffer} ESC/POS bytes
 */
function buildTestReceipt({ printerName = '', appName = 'GadgetsPOS' } = {}) {
  const title = asciiText(appName, TEST_LINE_WIDTH) || 'GadgetsPOS';
  const name = asciiText(printerName, TEST_LINE_WIDTH - 'Printer: '.length);
  const lines = ['Printer test'];
  if (name) lines.push(`Printer: ${name}`);
  lines.push('If you can read this,', 'your printer is ready.');

  const parts = [
    Buffer.from([ESC, 0x40]), // initialise
    Buffer.from([ESC, 0x61, 0x01]), // centre
    Buffer.from(`${title}\n`, 'ascii'),
    Buffer.from([ESC, 0x61, 0x00]), // left
    Buffer.from(`${lines.join('\n')}\n`, 'ascii'),
    Buffer.from([LF, LF, LF, LF]), // feed
    Buffer.from([GS, 0x56, 0x00]), // full cut
  ];
  return Buffer.concat(parts);
}

module.exports = { createReceiptPrinter, normalizeReceiptBytes, buildTestReceipt, MAX_RECEIPT_BYTES };
