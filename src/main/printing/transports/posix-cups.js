'use strict';

/**
 * `system` transport on macOS and Linux: `lp -d <printer> -o raw <file>` through CUPS (SPEC 9.1).
 * The printer name travels only as one argv element, never inside a command string.
 */

const { PrintError, ERROR_CODES, clipDetail } = require('../../errors');

/** What `lp` says on stderr when the destination does not exist (CUPS wording varies between versions). */
const UNKNOWN_DESTINATION = /does not exist|unknown destination|no such (?:printer|destination)|not a valid (?:printer|destination)|unknown printer/i;

/**
 * Turns a failed `lp` run into a PrintError.
 *
 * @param {any} error what the injected `run` rejected with (an execFile error)
 * @param {string} printerName
 * @param {AbortSignal|undefined} signal
 * @returns {PrintError}
 */
function mapLpError(error, printerName, signal) {
  if ((signal && signal.aborted) || (error && error.killed === true)) {
    return new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { step: 'lp' });
  }
  const stderr = error && error.stderr !== undefined && error.stderr !== null ? String(error.stderr) : '';
  if (error && error.code === 'ENOENT') {
    return new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, { reason: 'lp-not-installed', errno: 'ENOENT' });
  }
  if (UNKNOWN_DESTINATION.test(stderr)) {
    return new PrintError(ERROR_CODES.PRINTER_NOT_FOUND, undefined, { printerName, detail: clipDetail(stderr) });
  }
  return new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, {
    exitCode: error && typeof error.code === 'number' ? error.code : undefined,
    detail: clipDetail(stderr || (error && error.message) || ''),
  });
}

/**
 * Creates the CUPS transport.
 *
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string}>} deps.run promisified execFile
 * @returns {{print: (job: {printerName: string, filePath: string, signal?: AbortSignal}) => Promise<void>}}
 */
function createPosixCups({ run }) {
  async function print({ printerName, filePath, signal }) {
    try {
      await run('lp', ['-d', printerName, '-o', 'raw', filePath], { windowsHide: true, signal });
    } catch (error) {
      throw mapLpError(error, printerName, signal);
    }
  }

  return { print };
}

module.exports = { createPosixCups };
