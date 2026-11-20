'use strict';

/**
 * Raw printing entry point (SPEC 8 and 9.1): `createRawPrinter(...).printRaw({ target, data })` sends bytes to a
 * printer without any shell involved.
 *
 *   system transport, Windows      -> win32-spooler.js (persistent PowerShell host, one-shot script as fallback)
 *   system transport, macOS/Linux  -> posix-cups.js (`lp -d <name> -o raw <file>`)
 *   port transport (legacy)        -> win32-port.js (UNC share or DOS device; Windows only)
 *
 * Every job is validated before the OS is touched, queued per target (key `system:<name>` or `port:<path>`) so two
 * jobs for one printer never overlap, and given a unique 0600 temp file that is always deleted afterwards.
 * Names and ports only ever travel as single argv elements or JSON data, never inside a command string.
 * All I/O (fs, execFile, spawn, tmpDir, platform, clock, timers) is injected.
 */

const path = require('node:path');
const { PrintError, ERROR_CODES, ok, clipDetail } = require('../../errors');
const { classifyPort, createWin32Port, PORT_INVALID_MESSAGE, MAX_TARGET_LENGTH } = require('./win32-port');
const { createWin32Spooler } = require('./win32-spooler');
const { createPosixCups } = require('./posix-cups');
const { DEFAULT_TIMEOUT_MS } = require('../queue');

/** Sanity limit for one raw job; the callers apply their own, much smaller limits first (receipts 5 MB, labels 64 KB). */
const MAX_RAW_BYTES = 16 * 1024 * 1024;
const INVALID_NAME_MESSAGE = 'The printer name cannot be used. Choose the printer again in Settings > Printers.';

/** Counter shared by every printer instance of this process, so temp names never collide. */
let tempSequence = 0;

/**
 * Wraps the callback style `execFile` into a promise that resolves `{ stdout, stderr }` and rejects with the
 * original error (its `code`, `killed`, `stdout` and `stderr` intact).
 *
 * @param {Function} execFile child_process.execFile or a fake
 * @returns {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string}>}
 */
function promisifyExecFile(execFile) {
  return (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout === undefined || stdout === null ? '' : stdout), stderr: String(stderr === undefined || stderr === null ? '' : stderr) });
    });
  });
}

/**
 * Unique temp files named `gpos-<pid>-<timestamp>-<seq>.<ext>`, created with mode 0600 and never overwriting.
 *
 * @returns {{write: (data: Buffer, ext: string) => Promise<{path: string, name: string, remove: () => Promise<void>}>}}
 */
function createTempFiles({ fs, tmpDir, platform, now, pid, log }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  async function write(data, ext) {
    tempSequence += 1;
    const name = `gpos-${pid}-${now()}-${tempSequence}.${ext}`;
    const filePath = pathApi.join(tmpDir, name);
    try {
      await fs.promises.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, {
        reason: 'temp-file',
        errno: error && typeof error.code === 'string' ? error.code : undefined,
        detail: clipDetail(error && error.message),
      });
    }
    let removed = false;
    return {
      path: filePath,
      name,
      /** Deletes the file; never throws, and a second call does nothing. */
      remove: async () => {
        if (removed) return;
        removed = true;
        try {
          await fs.promises.unlink(filePath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') log?.warn?.('could not delete a temp file', { name, errno: error && error.code });
        }
      },
    };
  }

  return { write };
}

/**
 * Normalises a configured target (`printers.receipt` / `printers.label`) and checks that something is configured.
 * A missing `transport` follows the migration rule: `port` when a port is set, otherwise `system`.
 *
 * @param {unknown} raw `{ transport, printerName, port }`
 * @returns {{transport: 'system'|'port', printerName: string, port: string}}
 * @throws {PrintError} NO_PRINTER_CONFIGURED, or INVALID_SETTINGS for an unknown transport
 */
function resolveTarget(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const printerName = typeof source.printerName === 'string' ? source.printerName.trim() : '';
  const port = typeof source.port === 'string' ? source.port.trim() : '';
  const transport = source.transport === undefined || source.transport === null || source.transport === ''
    ? (port ? 'port' : 'system')
    : source.transport;
  if (transport !== 'system' && transport !== 'port') {
    throw new PrintError(ERROR_CODES.INVALID_SETTINGS, undefined, { reason: 'unknown-transport' });
  }
  if ((transport === 'system' && !printerName) || (transport === 'port' && !port)) {
    throw new PrintError(ERROR_CODES.NO_PRINTER_CONFIGURED);
  }
  return { transport, printerName, port };
}

/**
 * @param {string} printerName already trimmed and non-empty
 * @throws {PrintError} INVALID_SETTINGS for a NUL character, more than 512 characters or a leading dash
 */
function assertSafePrinterName(printerName) {
  let reason = null;
  if (printerName.includes('\0')) reason = 'nul-character';
  else if (printerName.length > MAX_TARGET_LENGTH) reason = 'too-long';
  else if (printerName.startsWith('-')) reason = 'leading-dash';
  if (reason) throw new PrintError(ERROR_CODES.INVALID_SETTINGS, INVALID_NAME_MESSAGE, { reason });
}

/**
 * @param {unknown} data Buffer, Uint8Array or string
 * @returns {Buffer} a private copy
 * @throws {PrintError} INVALID_PAYLOAD when empty, too large or not binary or text
 */
function toBuffer(data) {
  let bytes = null;
  if (typeof data === 'string') bytes = Buffer.from(data, 'utf8');
  else if (data instanceof Uint8Array) bytes = Buffer.from(data);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_RAW_BYTES) {
    throw new PrintError(ERROR_CODES.INVALID_PAYLOAD, undefined, { reason: bytes ? 'size' : 'type' });
  }
  return bytes;
}

/**
 * @param {unknown} systemRoot `process.env.SystemRoot`, or anything else when it is not known
 * @param {string[]} segments path below the root
 * @param {string} fallback bare executable name used without a usable root
 * @returns {string} the absolute Windows path under `systemRoot`, or the bare `fallback` name when there is no usable root
 */
function systemFile(systemRoot, segments, fallback) {
  // eslint-disable-next-line no-control-regex
  const usable = typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot) && !/[\u0000-\u001f]/.test(systemRoot);
  return usable ? path.win32.join(systemRoot, ...segments) : fallback;
}

/**
 * @param {object} deps
 * @throws {TypeError} when a required dependency is missing (a wiring mistake, caught at start-up)
 */
function assertDeps({ platform, fs, execFile, tmpDir, resourcesPath, queue }) {
  const missing = [];
  if (!queue || typeof queue.enqueue !== 'function') missing.push('queue');
  if (!fs || !fs.promises) missing.push('fs');
  if (typeof execFile !== 'function') missing.push('execFile');
  if (typeof tmpDir !== 'string' || tmpDir === '') missing.push('tmpDir');
  if (platform === 'win32' && (typeof resourcesPath !== 'string' || resourcesPath === '')) missing.push('resourcesPath');
  if (missing.length > 0) throw new TypeError(`createRawPrinter is missing: ${missing.join(', ')}`);
}

/**
 * Creates the raw printer.
 *
 * @param {object} deps
 * @param {string} [deps.platform=process.platform]
 * @param {object} deps.fs node:fs or a fake with `promises.writeFile/unlink/open` and `constants.O_WRONLY`
 * @param {Function} deps.execFile child_process.execFile (callback style)
 * @param {Function} [deps.spawn] child_process.spawn; enables the persistent PowerShell host on Windows
 * @param {string} deps.tmpDir OS temp directory
 * @param {string} [deps.resourcesPath] Windows only: the folder that contains `scripts/` (outside the asar)
 * @param {{enqueue: Function}} deps.queue job queue from queue.js
 * @param {{info?: Function, warn?: Function}} [deps.log]
 * @param {() => number} [deps.now=Date.now]
 * @param {number} [deps.pid=process.pid]
 * @param {string} [deps.systemRoot] Windows only, `process.env.SystemRoot`: when given, powershell.exe and cmd.exe are started by absolute path
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] timers of the PowerShell host (tests)
 * @param {number} [deps.jobTimeoutMs=30000] timeout of one job
 * @param {object} [deps.host] PowerShell host tuning (tests)
 * @returns {{
 *   printRaw: (job: {target: object, data: Buffer|Uint8Array|string, label?: string, ext?: string}) => Promise<{ok: true}>,
 *   dispose: () => void
 * }}
 */
function createRawPrinter(deps) {
  const {
    platform = process.platform, fs, execFile, spawn, tmpDir, resourcesPath, queue, log,
    now = Date.now, pid = process.pid, systemRoot, timers, jobTimeoutMs = DEFAULT_TIMEOUT_MS, host,
  } = deps || {};
  assertDeps({ platform, fs, execFile, tmpDir, resourcesPath, queue });

  const win32 = platform === 'win32';
  const posix = platform === 'darwin' || platform === 'linux';
  const run = promisifyExecFile(execFile);
  const tempFiles = createTempFiles({ fs, tmpDir, platform, now, pid, log });
  const portTransport = win32
    ? createWin32Port({ fs, run, tempFiles, tmpDir, cmdPath: systemFile(systemRoot, ['System32', 'cmd.exe'], 'cmd.exe'), log })
    : null;
  let systemTransport = null;
  if (win32) {
    systemTransport = createWin32Spooler({
      run,
      spawn,
      resourcesPath,
      powershellPath: systemFile(systemRoot, ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], 'powershell.exe'),
      timers,
      now,
      log,
      host,
    });
  } else if (posix) {
    systemTransport = createPosixCups({ run });
  }

  /** Port transport: validated before anything is opened. */
  function preparePort(target, data, ext) {
    if (!portTransport) throw new PrintError(ERROR_CODES.UNSUPPORTED_PLATFORM, undefined, { platform });
    const classified = classifyPort(target.port);
    if (classified.kind === 'invalid') throw new PrintError(ERROR_CODES.INVALID_SETTINGS, PORT_INVALID_MESSAGE, { reason: classified.reason });
    return { key: `port:${classified.path}`, run: ({ signal }) => portTransport.print({ target: classified, data, ext, signal }) };
  }

  /** System transport: the bytes go to a temp file that the spooler or `lp` reads. */
  function prepareSystem(target, data, ext) {
    if (!systemTransport) throw new PrintError(ERROR_CODES.UNSUPPORTED_PLATFORM, undefined, { platform });
    assertSafePrinterName(target.printerName);
    const printerName = target.printerName;
    return {
      key: `system:${printerName}`,
      run: async ({ signal }) => {
        const file = await tempFiles.write(data, ext);
        try {
          await systemTransport.print({ printerName, filePath: file.path, signal });
        } finally {
          await file.remove();
        }
      },
    };
  }

  /** Validates everything and returns what to queue. Throws a PrintError before the OS is touched. */
  function prepare(rawTarget, rawData, rawExt) {
    const target = resolveTarget(rawTarget);
    const data = toBuffer(rawData);
    const ext = typeof rawExt === 'string' && /^[a-z0-9]{1,8}$/i.test(rawExt) ? rawExt.toLowerCase() : 'bin';
    const job = target.transport === 'port' ? preparePort(target, data, ext) : prepareSystem(target, data, ext);
    return { ...job, transport: target.transport };
  }

  /**
   * Sends bytes to the printer and resolves when the job has been handed over.
   *
   * @param {{target: {transport?: string, printerName?: string, port?: string}, data: Buffer|Uint8Array|string, label?: string, ext?: string}} job
   *   `ext` is the temp file extension (`bin` for receipts, `zpl` for labels)
   * @returns {Promise<{ok: true}>}
   * @throws {PrintError} INVALID_PAYLOAD, NO_PRINTER_CONFIGURED, INVALID_SETTINGS, UNSUPPORTED_PLATFORM, PRINTER_NOT_FOUND,
   *   SPOOLER_ERROR, PORT_WRITE_FAILED or PRINT_TIMEOUT
   */
  async function printRaw({ target, data, label = 'print', ext } = {}) {
    const startedAt = now();
    let transport = 'unknown';
    try {
      const job = prepare(target, data, ext);
      transport = job.transport;
      await queue.enqueue(job.key, job.run, { label, timeoutMs: jobTimeoutMs });
    } catch (error) {
      log?.warn?.('print job failed', { label, transport, code: error && error.code, ms: now() - startedAt });
      throw error;
    }
    log?.info?.('print job done', { label, transport, ms: now() - startedAt });
    return ok();
  }

  /** Stops the PowerShell host (quit). The printer must not be used afterwards. */
  function dispose() {
    if (systemTransport && typeof systemTransport.dispose === 'function') systemTransport.dispose();
  }

  return { printRaw, dispose };
}

module.exports = { createRawPrinter, resolveTarget, promisifyExecFile };
