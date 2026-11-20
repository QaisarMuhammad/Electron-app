'use strict';

/**
 * Logging for the main process (SPEC 12 "Logs", 18b R4).
 *
 *  - `createDeferredLog`      a logger that can be used from the very first line of the boot, before `electron-log`
 *                             (about 40 ms to load) has been required: entries wait in a small buffer until the real
 *                             logger is attached, then they are written in order. The loading screen never waits for it.
 *  - `configureLogging`       puts the log files in `<userData>/logs`, rotates at 5 MB across 3 files and keeps the
 *                             console quiet in a packaged app.
 *  - `installProcessLogging`  writes `uncaughtException` and `unhandledRejection` to the log instead of letting them
 *                             open Electron's error box in front of the till.
 *
 * Nothing here ever logs a password, receipt bytes or a payload: callers pass short descriptions only.
 * Pure Node: the file system, the process and the logger are injected.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** A log file is rotated when it grows beyond this many bytes (5 MB). */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Files kept in total: the current log and two archives. */
const LOG_FILES_KEPT = 3;

const LOG_FILE_NAME = 'main.log';
const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * @param {number} [maxBuffered=200] entries kept while no real logger is attached; older ones are dropped first
 * @returns {{
 *   debug: Function, info: Function, warn: Function, error: Function,
 *   attach: (target: object) => void,
 *   isAttached: () => boolean
 * }} a logger with the four levels the app uses
 */
function createDeferredLog(maxBuffered = 200) {
  /** @type {Array<[string, unknown[]]>} */
  const buffer = [];
  let target = null;

  /** Calls one level of the real logger; a failing logger must never break the code that logs. */
  function forward(level, args) {
    try {
      if (target && typeof target[level] === 'function') target[level](...args);
    } catch {
      // Logging is best effort.
    }
  }

  const log = { attach, isAttached: () => target !== null };
  for (const level of LEVELS) {
    log[level] = (...args) => {
      if (target) {
        forward(level, args);
        return;
      }
      buffer.push([level, args]);
      if (buffer.length > maxBuffered) buffer.shift();
    };
  }

  /** @param {object} real an electron-log style logger; the buffered entries are written to it at once */
  function attach(real) {
    target = real;
    for (const [level, args] of buffer.splice(0)) forward(level, args);
  }

  return log;
}

/**
 * The `archiveLogFn` of electron-log's file transport: the log is renamed to `main.old.log`, the previous archive to
 * `main.old2.log`, and the oldest one is deleted, so `keepFiles` files exist at most. If renaming fails (a file is
 * locked by a virus scanner, say) the log is cropped instead, which is what electron-log does by default.
 *
 * @param {object} [options]
 * @param {typeof nodeFs} [options.fs]
 * @param {number} [options.keepFiles=3] files kept in total, the current log included
 * @param {{ warn?: Function }} [options.log]
 * @returns {(file: { toString: () => string, crop: (bytes: number) => void }) => void}
 */
function createLogArchiver({ fs = nodeFs, keepFiles = LOG_FILES_KEPT, log } = {}) {
  const archives = Math.max(1, Math.floor(keepFiles) - 1);

  return function archiveLogFn(file) {
    const current = file.toString();
    const { dir, name, ext } = nodePath.parse(current);
    const archivePath = (number) => nodePath.join(dir, `${name}.old${number === 1 ? '' : number}${ext}`);
    try {
      fs.rmSync(archivePath(archives), { force: true });
      for (let number = archives - 1; number >= 1; number -= 1) {
        if (fs.existsSync(archivePath(number))) fs.renameSync(archivePath(number), archivePath(number + 1));
      }
      fs.renameSync(current, archivePath(1));
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn(`log: could not rotate the log file (${error && error.message})`);
      file.crop(256 * 1024);
    }
  };
}

/**
 * Applies the app's logging rules to an electron-log instance.
 *
 * @param {object} options
 * @param {{ transports: { file: object, console: object } }} options.log electron-log
 * @param {string} options.logsDir folder of the log files (`<userData>/logs`)
 * @param {boolean} [options.verbose=false] true in a development build: the console shows messages too
 * @param {typeof nodeFs} [options.fs]
 * @returns {string} the path of the current log file
 */
function configureLogging({ log, logsDir, verbose = false, fs = nodeFs }) {
  const file = nodePath.join(logsDir, LOG_FILE_NAME);
  const transport = log.transports.file;
  transport.resolvePathFn = () => file;
  transport.maxSize = LOG_MAX_BYTES;
  transport.archiveLogFn = createLogArchiver({ fs, keepFiles: LOG_FILES_KEPT, log });
  transport.level = 'info';
  // Only the account that runs the app reads the log (the default is readable by everybody on the PC).
  transport.writeOptions = { flag: 'a', mode: 0o600, encoding: 'utf8' };
  log.transports.console.level = verbose ? 'info' : false;
  return file;
}

/**
 * Logs what would otherwise crash the main process or pop up Electron's own error box. Only a short description
 * and the stack go to the log. Calling the returned function removes the listeners again.
 *
 * @param {{ proc: { on: Function, removeListener: Function }, log: { error: Function } }} options
 * @returns {() => void}
 */
function installProcessLogging({ proc, log }) {
  const onException = (error) => log.error('uncaught exception', error && error.stack ? error.stack : String(error));
  const onRejection = (reason) => log.error('unhandled promise rejection', reason && reason.stack ? reason.stack : String(reason));
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.removeListener('uncaughtException', onException);
    proc.removeListener('unhandledRejection', onRejection);
  };
}

module.exports = {
  createDeferredLog,
  createLogArchiver,
  configureLogging,
  installProcessLogging,
  LOG_MAX_BYTES,
  LOG_FILES_KEPT,
  LOG_FILE_NAME,
};
