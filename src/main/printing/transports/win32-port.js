'use strict';

/**
 * Windows `port` transport (legacy settings): raw bytes to a UNC printer share or a DOS device such as LPT1 (SPEC 9.1).
 *
 * The port is free text from a settings file, so `classifyPort` accepts only two shapes and everything else is
 * refused before anything is opened or spawned. The write is direct (open, write, close). If Windows refuses the
 * direct open in one of a few known ways, the job falls back ONCE to the legacy `copy /B`, so shops whose setup only
 * ever worked with `copy` keep working. All I/O is injected.
 */

const { PrintError, ERROR_CODES, clipDetail } = require('../../errors');

/** Longest printer name or port accepted anywhere in the transports. */
const MAX_TARGET_LENGTH = 512;

/** Shown when a port is refused (SPEC 9.1). */
const PORT_INVALID_MESSAGE = 'This port name cannot be used. Choose the installed printer, or a shared printer address such as \\\\localhost\\ZebraZD420.';

/** Errors of the direct write after which the single `copy` fallback is tried. */
const FALLBACK_ERRNOS = new Set(['ENOENT', 'EINVAL', 'EPERM', 'EACCES']);

// Characters cmd.exe re-parses, plus quotes: never part of a port.
const FORBIDDEN_CHARS = /["'&|<>^%!,;=]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const DEVICE_PATTERN = /^(?:\\\\\.\\)?(LPT[1-9]|COM(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-6])|PRN):?$/i;
const UNC_PATTERN = /^\\\\([\p{L}\p{M}\p{Nd}._-]+)\\([\p{L}\p{M}\p{Nd} ._()-]+)$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const PARENTHESES = /[()]/;

/**
 * @param {string} reason
 * @returns {{kind: 'invalid', path: string, reason: string}}
 */
function invalid(reason) {
  return { kind: 'invalid', path: '', reason };
}

/**
 * Decides what a configured port string is. Pure: it never touches the file system.
 *
 * Accepted: a UNC printer share `\\host\share` (nothing deeper) and the DOS devices LPT1-LPT9, COM1-COM256 and PRN
 * (any case, an optional `\\.\` prefix, one trailing colon dropped). A device is always returned as `\\.\NAME`.
 *
 * @param {unknown} raw the configured port
 * @returns {{kind: 'unc'|'device'|'invalid', path: string, reason?: string}} `path` is what may be opened; '' when invalid
 */
function classifyPort(raw) {
  if (typeof raw !== 'string') return invalid('empty');
  const text = raw.trim();
  if (text === '') return invalid('empty');
  if (text.length > MAX_TARGET_LENGTH) return invalid('too-long');
  if (CONTROL_CHARS.test(text)) return invalid('control-character');
  if (FORBIDDEN_CHARS.test(text)) return invalid('forbidden-character');

  const device = DEVICE_PATTERN.exec(text);
  if (device) return { kind: 'device', path: `\\\\.\\${device[1].toUpperCase()}` };

  const unc = UNC_PATTERN.exec(text);
  if (unc && HAS_LETTER_OR_DIGIT.test(unc[1]) && HAS_LETTER_OR_DIGIT.test(unc[2])) return { kind: 'unc', path: text };
  return invalid('unsupported-form');
}

/**
 * @param {{kind: string, path: string}} target
 * @param {'direct'|'copy'} step
 * @param {any} error what the step threw
 * @returns {PrintError} PORT_WRITE_FAILED with plain technical context
 */
function portFailure(target, step, error) {
  const errno = error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined;
  return new PrintError(ERROR_CODES.PORT_WRITE_FAILED, undefined, {
    port: target.path,
    step,
    errno,
    detail: clipDetail((error && (error.stderr || error.message)) || ''),
  });
}

/**
 * @param {AbortSignal|undefined} signal
 * @param {string} step
 * @throws {PrintError} PRINT_TIMEOUT when the job has already been given up on
 */
function failIfAborted(signal, step) {
  if (signal && signal.aborted) throw new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { step });
}

/**
 * Creates the port transport.
 *
 * @param {object} deps
 * @param {{promises: {open: Function}, constants: {O_WRONLY: number}}} deps.fs node:fs or a fake
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string}>} deps.run promisified execFile
 * @param {{write: (data: Buffer, ext: string) => Promise<{name: string, remove: () => Promise<void>}>}} deps.tempFiles unique temp files in `tmpDir`
 * @param {string} deps.tmpDir directory of the temp files (the working directory of the fallback)
 * @param {string} [deps.cmdPath='cmd.exe'] command interpreter used by the fallback
 * @param {{info?: Function, warn?: Function}} [deps.log]
 * @returns {{print: (job: {target: {kind: string, path: string}, data: Buffer, ext: string, signal?: AbortSignal}) => Promise<void>}}
 */
function createWin32Port({ fs, run, tempFiles, tmpDir, cmdPath = 'cmd.exe', log }) {
  /** open, write, close. A device is opened existing-only (no create, no truncate); a share with 'w' like `copy` does. */
  async function writeDirect(target, data) {
    const flags = target.kind === 'device' ? fs.constants.O_WRONLY : 'w';
    const handle = await fs.promises.open(target.path, flags);
    let failure = null;
    try {
      await handle.writeFile(data);
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      failure = failure || error;
    }
    if (failure) throw failure;
  }

  /** The legacy route: a temp file copied with cmd.exe. The file is passed as a bare name resolved through `cwd`. */
  async function writeWithCopy(target, data, ext, signal) {
    const file = await tempFiles.write(data, ext);
    try {
      await run(cmdPath, ['/d', '/c', 'copy', '/B', file.name, target.path], { cwd: tmpDir, windowsHide: true, signal });
    } finally {
      await file.remove();
    }
  }

  /** Only a path without parentheses may reach cmd.exe, which re-parses them. */
  function canFallBack(error, target) {
    return Boolean(error) && FALLBACK_ERRNOS.has(error.code) && !PARENTHESES.test(target.path);
  }

  async function print({ target, data, ext, signal }) {
    try {
      await writeDirect(target, data);
      return;
    } catch (directError) {
      failIfAborted(signal, 'direct');
      if (!canFallBack(directError, target)) throw portFailure(target, 'direct', directError);
      log?.info?.('port write refused, trying copy', { port: target.path, errno: directError.code });
    }
    try {
      await writeWithCopy(target, data, ext, signal);
    } catch (copyError) {
      failIfAborted(signal, 'copy');
      throw portFailure(target, 'copy', copyError);
    }
  }

  return { print };
}

module.exports = { classifyPort, createWin32Port, PORT_INVALID_MESSAGE, MAX_TARGET_LENGTH };
