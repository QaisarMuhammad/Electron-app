'use strict';

/**
 * `flags.json` in the userData folder: the switches that must be known BEFORE the app is ready
 * (SPEC 18b R1 and R1b). Electron reads command-line switches before `app.whenReady`, long before the
 * config store exists, so these few values live in their own tiny file that is read synchronously.
 *
 *   { "disableGpu": false, "disableBrotli": true, "reason": "", "gpuChecked": false }
 *
 * - `disableGpu`    compatibility mode: hardware acceleration off (the escape hatch for broken graphics drivers).
 * - `disableBrotli` keeps v1's `disable-brotli` switch (reason unrecorded, so the v1 behaviour is the default).
 * - `reason`        why compatibility mode was switched on (see REASONS), shown in Settings > General.
 * - `gpuChecked`    the one-time "Does the screen look right?" question after a v1 -> v2 upgrade was answered.
 *
 * Pure Node: no Electron import, so every function runs under plain `node --test`.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');

const FLAGS_FILE_NAME = 'flags.json';
const FLAGS_FILE_MODE = 0o600;
const MAX_REASON_LENGTH = 200;

/** Values used when the file is missing, unreadable, or lacks a key. */
const DEFAULT_FLAGS = Object.freeze({
  disableGpu: false,
  disableBrotli: true,
  reason: '',
  gpuChecked: false,
});

/** Machine-readable values for the `reason` flag. Settings maps them to plain English. */
const REASONS = Object.freeze({
  GPU_CRASHES: 'gpu-crashes',
  RENDERER_CRASH_AT_START: 'renderer-crash-at-start',
  MANUAL: 'manual',
});

/** Safety net thresholds (SPEC 18b R1). */
const GPU_CRASH_WINDOW_MS = 60 * 1000;
const GPU_CRASH_LIMIT = 2;
const EARLY_RENDERER_CRASH_MS = 20 * 1000;
const FATAL_RENDERER_REASONS = Object.freeze(['crashed', 'launch-failed', 'integrity-failure']);

const DISABLE_GPU_ARGUMENT = '--disable-gpu';

// ---------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean} `value` as a boolean when it clearly is one (true/false, 1/0, "true"/"false"/"yes"/"no"/"1"/"0"), else `fallback`
 */
function coerceBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === 'yes' || text === '1') return true;
    if (text === 'false' || text === 'no' || text === '0') return false;
  }
  return fallback;
}

/**
 * @param {unknown} value
 * @returns {string} a short single-line text: control characters become spaces, runs of spaces collapse, at most 200 characters
 */
function coerceReason(value) {
  if (typeof value !== 'string') return DEFAULT_FLAGS.reason;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Reduce anything to a complete, correctly typed flags object: unknown keys are dropped, wrong types
 * are coerced when they clearly mean something and replaced by the default otherwise.
 *
 * @param {unknown} input
 * @returns {{disableGpu: boolean, disableBrotli: boolean, reason: string, gpuChecked: boolean}} a new object
 */
function sanitizeFlags(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    disableGpu: coerceBoolean(source.disableGpu, DEFAULT_FLAGS.disableGpu),
    disableBrotli: coerceBoolean(source.disableBrotli, DEFAULT_FLAGS.disableBrotli),
    reason: coerceReason(source.reason),
    gpuChecked: coerceBoolean(source.gpuChecked, DEFAULT_FLAGS.gpuChecked),
  };
}

/**
 * @param {string} userDataDir
 * @returns {string} absolute path of flags.json inside the userData folder
 */
function flagsPath(userDataDir) {
  return nodePath.join(userDataDir, FLAGS_FILE_NAME);
}

/**
 * Read flags.json SYNCHRONOUSLY (it is needed before `app.whenReady`). Never throws: a missing,
 * unreadable or corrupt file gives the defaults, so a damaged file can never keep the app from starting.
 * A leading byte-order mark (Notepad adds one) is ignored.
 *
 * @param {string} userDataDir
 * @param {{fs?: typeof nodeFs}} [deps]
 * @returns {{disableGpu: boolean, disableBrotli: boolean, reason: string, gpuChecked: boolean}} a new object, safe to modify
 */
function readFlagsSync(userDataDir, { fs = nodeFs } = {}) {
  try {
    const text = fs.readFileSync(flagsPath(userDataDir), 'utf8');
    return sanitizeFlags(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

/**
 * Merge `patch` into the stored flags and save the result ATOMICALLY: the new content goes to a
 * temporary file next to flags.json (mode 0600) and is renamed over it, so a crash or power cut leaves
 * either the old file or the new one, never half a file. Keys that are not flags, and `undefined`
 * values, are ignored.
 *
 * It is SYNCHRONOUS on purpose: callers write the flag and then relaunch or quit, and an asynchronous
 * write could still be in flight. Awaiting the result is harmless. It throws when the file cannot be
 * written (the temporary file is removed first), so the caller can tell the user instead of promising a
 * restart that would change nothing.
 *
 * @param {string} userDataDir
 * @param {Partial<{disableGpu: boolean, disableBrotli: boolean, reason: string, gpuChecked: boolean}>} patch
 * @param {{fs?: typeof nodeFs}} [deps]
 * @returns {{disableGpu: boolean, disableBrotli: boolean, reason: string, gpuChecked: boolean}} the flags as written
 */
function writeFlags(userDataDir, patch, { fs = nodeFs } = {}) {
  const changes = {};
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    if (patch && Object.hasOwn(patch, key) && patch[key] !== undefined) changes[key] = patch[key];
  }
  const next = sanitizeFlags({ ...readFlagsSync(userDataDir, { fs }), ...changes });

  const target = flagsPath(userDataDir);
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: FLAGS_FILE_MODE, flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The temporary file is only litter; the original error is the one that matters.
    }
    throw error;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// GPU safety net
// ---------------------------------------------------------------------------------------------

/**
 * One thing that went wrong, recorded by the caller (`app.on('child-process-gone')` and the POS window's
 * `render-process-gone`) with a millisecond timestamp.
 *
 * @typedef {object} CrashEvent
 * @property {'child-process-gone'|'render-process-gone'} event which Electron event it was
 * @property {string} reason Electron's `details.reason` ('crashed', 'clean-exit', 'launch-failed', ...)
 * @property {number} at when it happened (ms, the same clock as `now`)
 * @property {string} [processType] `details.type` of a child-process-gone event ('GPU', 'Utility', ...)
 * @property {number} [startedAt] render-process-gone only: when the POS window began loading (ms)
 */

/** @param {CrashEvent} entry @returns {boolean} */
function isGpuCrash(entry) {
  return (
    entry.event === 'child-process-gone' &&
    String(entry.processType).toUpperCase() === 'GPU' &&
    entry.reason !== 'clean-exit' &&
    Number.isFinite(entry.at)
  );
}

/** @param {CrashEvent} entry @returns {boolean} */
function isEarlyRendererCrash(entry) {
  if (entry.event !== 'render-process-gone' || !FATAL_RENDERER_REASONS.includes(entry.reason)) return false;
  if (!Number.isFinite(entry.at) || !Number.isFinite(entry.startedAt)) return false;
  const sinceStart = entry.at - entry.startedAt;
  return sinceStart >= 0 && sinceStart <= EARLY_RENDERER_CRASH_MS;
}

/**
 * Why the app should switch to compatibility mode, or null when it should not (the decision of R1):
 * - the GPU process died (any reason but a clean exit) twice within 60 seconds, or
 * - the POS window's renderer crashed (crashed, launch-failed or integrity-failure) within 20 seconds of its start.
 * Pure: it only looks at `events` and `now`.
 *
 * @param {CrashEvent[]} events
 * @param {number} now
 * @returns {string|null} one of REASONS (GPU_CRASHES or RENDERER_CRASH_AT_START), or null
 */
function fallbackReason(events, now) {
  const list = Array.isArray(events) ? events.filter((entry) => entry !== null && typeof entry === 'object') : [];
  const recentGpuCrashes = list.filter((entry) => isGpuCrash(entry) && now - entry.at <= GPU_CRASH_WINDOW_MS);
  if (recentGpuCrashes.length >= GPU_CRASH_LIMIT) return REASONS.GPU_CRASHES;
  if (list.some(isEarlyRendererCrash)) return REASONS.RENDERER_CRASH_AT_START;
  return null;
}

/**
 * @param {CrashEvent[]} events
 * @param {number} now
 * @returns {boolean} true when `fallbackReason` has a reason
 */
function shouldFallBackToSoftware(events, now) {
  return fallbackReason(events, now) !== null;
}

/**
 * Whether the GPU must be off for this run. `--disable-gpu` on the command line (the shop shortcut,
 * SHOP-SETUP.md) always wins; otherwise the `disableGpu` flag decides.
 *
 * @param {{argv?: string[], flags?: {disableGpu?: boolean}}} [input]
 * @returns {boolean}
 */
function resolveGpuDisabled({ argv = [], flags = DEFAULT_FLAGS } = {}) {
  if (Array.isArray(argv) && argv.includes(DISABLE_GPU_ARGUMENT)) return true;
  return Boolean(flags) && flags.disableGpu === true;
}

module.exports = {
  DEFAULT_FLAGS,
  FLAGS_FILE_NAME,
  REASONS,
  sanitizeFlags,
  flagsPath,
  readFlagsSync,
  writeFlags,
  fallbackReason,
  shouldFallBackToSoftware,
  resolveGpuDisabled,
};
