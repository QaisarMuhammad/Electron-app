'use strict';

/**
 * Windows `system` transport: RAW bytes to an installed printer through the Windows spooler (SPEC 9.1 and 18b L1).
 *
 * Two ways to reach the same PowerShell/winspool code:
 *  - the persistent HOST (`scripts/raw-print-host.ps1`): one long-lived PowerShell process, started lazily on the
 *    first job, that reads one JSON command per stdin line and answers one JSON line per command. Jobs after the
 *    first skip PowerShell's start-up cost. It is respawned after a crash or a command timeout and shut down after
 *    10 minutes without jobs (an unref()'d timer).
 *  - the ONE-SHOT script (`scripts/raw-print.ps1`): one PowerShell process per job. Used when the host cannot be
 *    started (it must say it is ready within 10 s) and whenever no `spawn` is injected.
 *
 * Printer names are never code: on the host they travel as JSON data, on the one-shot as one argv element.
 * Exit codes and host answer codes: 0 ok, 2 printer not found, 3 open failed, 4 write failed, 5 bad arguments.
 * All I/O (execFile, spawn, timers, clock) is injected.
 */

const path = require('node:path');
const { PrintError, ERROR_CODES, clipDetail } = require('../../errors');

const winPath = path.win32;

/** The host is stopped after this long without a job. */
const HOST_IDLE_MS = 10 * 60 * 1000;
/** A host that has not said it is ready within this long counts as unable to start. */
const HOST_START_TIMEOUT_MS = 10 * 1000;
/** After a failed start the one-shot script is used for this long before the host is tried again. */
const HOST_RETRY_AFTER_MS = 30 * 60 * 1000;
/** A host command that is not answered within this long fails with PRINT_TIMEOUT and the host is restarted. */
const HOST_COMMAND_TIMEOUT_MS = 25 * 1000;
/** A host line longer than this without a newline is garbage and is dropped. */
const MAX_HOST_LINE = 64 * 1024;

const POWERSHELL_FLAGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
const STAGES = Object.freeze({ 3: 'open', 4: 'write', 5: 'arguments' });
const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
});

/** Internal signal: the host cannot be used for this job, so the caller uses the one-shot script. Never leaves this module. */
class HostUnavailableError extends Error {
  /**
   * @param {string} reason short machine-readable reason
   * @param {unknown} [cause]
   */
  constructor(reason, cause) {
    super(`print host unavailable: ${reason}`);
    this.name = 'HostUnavailableError';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * JSON with every non-ASCII character written as a \uXXXX escape. The console code page of a Windows machine
 * is not UTF-8, so the host is fed pure ASCII: a printer called "Küchendrucker" arrives intact on any machine.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * @param {AbortSignal|undefined} signal
 * @throws {PrintError} PRINT_TIMEOUT when the job has already been given up on
 */
function failIfAborted(signal) {
  if (signal && signal.aborted) throw new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { step: 'spooler' });
}

/**
 * Maps an exit code (or host answer code) other than 0 to a PrintError.
 *
 * @param {number} code 2 not found, 3 open failed, 4 write failed, 5 bad arguments, anything else
 * @param {unknown} detail technical text from the script
 * @param {string} printerName
 * @returns {PrintError}
 */
function errorForExit(code, detail, printerName) {
  const info = { exitCode: code, detail: clipDetail(detail) };
  if (code === 2) return new PrintError(ERROR_CODES.PRINTER_NOT_FOUND, undefined, { printerName, ...info });
  return new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, { ...info, stage: STAGES[code] });
}

/** @returns {object|null} the last stdout line of the one-shot script when it is a JSON object, else null */
function readAnswerLine(stdout) {
  const lines = String(stdout === undefined || stdout === null ? '' : stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try {
    const value = JSON.parse(lines[lines.length - 1]);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Maps what a failed one-shot run rejected with to a PrintError. */
function mapOneShotError(error, printerName, signal) {
  if ((signal && signal.aborted) || (error && error.killed === true)) {
    return new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { step: 'powershell' });
  }
  if (error && typeof error.code === 'number') {
    const answer = readAnswerLine(error.stdout);
    return errorForExit(error.code, (answer && answer.message) || error.stderr || '', printerName);
  }
  if (error && error.code === 'ENOENT') {
    return new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, { reason: 'powershell-not-found', errno: 'ENOENT' });
  }
  return new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, {
    errno: error && typeof error.code === 'string' ? error.code : undefined,
    detail: clipDetail((error && error.message) || ''),
  });
}

/**
 * Splits text chunks from a stream into lines and hands each non-empty line to `onLine`.
 * A line that grows beyond MAX_HOST_LINE without a newline is garbage and is dropped.
 *
 * @param {(line: string) => void} onLine
 * @returns {(chunk: string) => void}
 */
function createLineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_HOST_LINE) buffer = '';
  };
}

/**
 * Normalises a parsed host answer. A failure always carries a failure code: a missing, non-integer or zero
 * code counts as "open failed" (3).
 *
 * @param {{ok?: unknown, code?: unknown, message?: unknown}} message
 * @returns {{ok: boolean, code: number, message: string}}
 */
function toAnswer(message) {
  const succeeded = message.ok === true;
  const failureCode = Number.isInteger(message.code) && message.code !== 0 ? message.code : 3;
  return { ok: succeeded, code: succeeded ? 0 : failureCode, message: clipDetail(message.message) };
}

/**
 * Starts ONE host process and resolves once it has said `{"ready":true}`. The returned object talks to that process.
 * Rejects with HostUnavailableError if it cannot be spawned, exits early or is not ready in time.
 *
 * @returns {Promise<{send: Function, kill: Function, isAlive: () => boolean}>}
 */
function startHostProcess({ spawn, command, args, timers, startTimeoutMs, commandTimeoutMs, nextId, log }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new HostUnavailableError('spawn-failed', error));
      return;
    }

    let alive = true;
    let ready = false;
    let stderrTail = '';
    let inFlight = null;
    const startTimer = timers.setTimeout(() => die('start-timeout'), startTimeoutMs);

    function endInFlight(settle, value) {
      const current = inFlight;
      if (!current) return;
      inFlight = null;
      current.cleanup();
      settle(current, value);
    }
    const failInFlight = (error) => endInFlight((current, value) => current.reject(value), error);
    const answerInFlight = (answer) => endInFlight((current, value) => current.resolve(value), answer);

    /** The process is gone or is being stopped: reject whoever waits and make sure nothing keeps running. */
    function die(reason, cause) {
      if (!alive) return;
      alive = false;
      timers.clearTimeout(startTimer);
      if (ready) failInFlight(new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, { reason, detail: clipDetail(stderrTail) }));
      else reject(new HostUnavailableError(reason, cause));
      try { if (proc.stdin && typeof proc.stdin.destroy === 'function') proc.stdin.destroy(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already gone */ }
    }

    function onLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log?.warn?.('print host sent a line that is not JSON');
        return;
      }
      if (message === null || typeof message !== 'object') return;
      if (message.ready === true) {
        if (ready || !alive) return;
        ready = true;
        timers.clearTimeout(startTimer);
        resolve(host);
        return;
      }
      if (inFlight && message.id === inFlight.id) answerInFlight(toAnswer(message));
    }

    /** Sends one command and waits for its answer, the command timeout or the job's abort, whichever comes first. */
    function send({ printerName, filePath }, signal) {
      return new Promise((resolveSend, rejectSend) => {
        if (!alive) {
          rejectSend(new HostUnavailableError('not-running'));
          return;
        }
        const id = nextId();
        const expire = (reason) => {
          failInFlight(new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { reason }));
          die('command-timeout');
        };
        const timer = timers.setTimeout(() => expire('host-command-timeout'), commandTimeoutMs);
        const onAbort = () => expire('job-aborted');
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        inFlight = {
          id,
          resolve: resolveSend,
          reject: rejectSend,
          cleanup: () => {
            timers.clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
          },
        };
        proc.stdin.write(`${asciiJson({ id, printerName, filePath })}\n`, (error) => {
          if (error) failInFlight(new PrintError(ERROR_CODES.SPOOLER_ERROR, undefined, { reason: 'host-write-failed', errno: error.code }));
        });
      });
    }

    const host = { send, kill: (reason = 'stopped') => die(reason), isAlive: () => alive };

    proc.on('error', (error) => die('process-error', error));
    proc.on('exit', (code, signal) => die('exited', { code, signal }));
    if (proc.stdin) proc.stdin.on('error', () => { /* a dead host: the exit event reports it */ });
    if (proc.stdout) {
      if (typeof proc.stdout.setEncoding === 'function') proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', createLineSplitter(onLine));
    }
    if (proc.stderr) {
      if (typeof proc.stderr.setEncoding === 'function') proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-1000); });
    }
  });
}

/**
 * Keeps at most one host process: lazy start, one command at a time, restart after a failure, idle shutdown.
 *
 * @param {object} options
 * @returns {{run: (job: {printerName: string, filePath: string, signal?: AbortSignal}) => Promise<{ok: boolean, code: number, message: string}>, dispose: () => void}}
 */
function createHostManager({ spawn, command, args, timers, now, log, idleMs, startTimeoutMs, commandTimeoutMs, retryAfterMs }) {
  let current = null;
  let idleTimer = null;
  let disabledUntil = 0;
  let disposed = false;
  let commandSeq = 0;
  let chain = Promise.resolve();

  const nextId = () => { commandSeq += 1; return commandSeq; };

  function clearIdle() {
    if (idleTimer === null) return;
    timers.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function stop(reason) {
    const host = current;
    current = null;
    if (!host) return;
    log?.info?.('print host stopped', { reason });
    host.kill(reason);
  }

  /** Arms the idle shutdown (an unref()'d timer, so it never keeps the app alive) while a live host waits for work. */
  function armIdle() {
    clearIdle();
    if (!current || !current.isAlive()) return;
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      stop('idle');
    }, idleMs);
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function acquire() {
    if (current && current.isAlive()) return current;
    current = null;
    let host;
    try {
      host = await startHostProcess({ spawn, command, args, timers, startTimeoutMs, commandTimeoutMs, nextId, log });
    } catch (error) {
      disabledUntil = now() + retryAfterMs;
      log?.warn?.('print host could not start, using the one-shot script', { reason: error.reason });
      throw error;
    }
    if (disposed) {
      host.kill('disposed');
      throw new HostUnavailableError('disposed');
    }
    current = host;
    return host;
  }

  async function execute({ printerName, filePath, signal }) {
    failIfAborted(signal);
    if (disposed) throw new HostUnavailableError('disposed');
    if (now() < disabledUntil) throw new HostUnavailableError('cooling-off');
    clearIdle();
    try {
      const host = await acquire();
      failIfAborted(signal);
      return await host.send({ printerName, filePath }, signal);
    } finally {
      armIdle();
    }
  }

  /** Commands run one after the other: the host answers one line per command. */
  function run(job) {
    const result = chain.then(() => execute(job));
    chain = result.then(() => undefined, () => undefined);
    return result;
  }

  function dispose() {
    disposed = true;
    clearIdle();
    stop('dispose');
  }

  return { run, dispose };
}

/**
 * Creates the Windows spooler transport.
 *
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string}>} deps.run promisified execFile (one-shot script)
 * @param {Function} [deps.spawn] child_process.spawn; without it the host is never used
 * @param {string} deps.resourcesPath folder that contains `scripts/` (outside the asar)
 * @param {string} [deps.powershellPath='powershell.exe']
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers]
 * @param {() => number} [deps.now]
 * @param {{info?: Function, warn?: Function}} [deps.log]
 * @param {{enabled?: boolean, idleMs?: number, startTimeoutMs?: number, commandTimeoutMs?: number, retryAfterMs?: number}} [deps.host] host tuning (tests)
 * @returns {{print: (job: {printerName: string, filePath: string, signal?: AbortSignal}) => Promise<void>, dispose: () => void}}
 */
function createWin32Spooler({ run, spawn, resourcesPath, powershellPath = 'powershell.exe', timers = DEFAULT_TIMERS, now = Date.now, log, host: tuning = {} }) {
  const oneShotScript = winPath.join(resourcesPath, 'scripts', 'raw-print.ps1');
  const hostScript = winPath.join(resourcesPath, 'scripts', 'raw-print-host.ps1');
  const manager = typeof spawn === 'function' && tuning.enabled !== false
    ? createHostManager({
      spawn,
      command: powershellPath,
      args: [...POWERSHELL_FLAGS, hostScript],
      timers,
      now,
      log,
      idleMs: tuning.idleMs || HOST_IDLE_MS,
      startTimeoutMs: tuning.startTimeoutMs || HOST_START_TIMEOUT_MS,
      commandTimeoutMs: tuning.commandTimeoutMs || HOST_COMMAND_TIMEOUT_MS,
      retryAfterMs: tuning.retryAfterMs || HOST_RETRY_AFTER_MS,
    })
    : null;

  async function runOneShot({ printerName, filePath, signal }) {
    const args = [...POWERSHELL_FLAGS, oneShotScript, '-PrinterName', printerName, '-FilePath', filePath];
    try {
      await run(powershellPath, args, { windowsHide: true, signal });
    } catch (error) {
      throw mapOneShotError(error, printerName, signal);
    }
  }

  async function print({ printerName, filePath, signal }) {
    if (manager) {
      try {
        const answer = await manager.run({ printerName, filePath, signal });
        if (answer.ok) return;
        throw errorForExit(answer.code, answer.message, printerName);
      } catch (error) {
        if (!(error instanceof HostUnavailableError)) throw error;
      }
    }
    failIfAborted(signal);
    await runOneShot({ printerName, filePath, signal });
  }

  return { print, dispose: () => { if (manager) manager.dispose(); } };
}

module.exports = {
  createWin32Spooler,
  asciiJson,
  HOST_IDLE_MS,
  HOST_START_TIMEOUT_MS,
  HOST_RETRY_AFTER_MS,
  HOST_COMMAND_TIMEOUT_MS,
};
