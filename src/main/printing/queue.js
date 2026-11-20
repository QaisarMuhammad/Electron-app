'use strict';

/**
 * Per-key serial job queue for print jobs (SPEC section 8).
 *
 * - Jobs with the same key run strictly one after the other, in the order they were enqueued.
 * - Jobs with different keys never wait for each other: a stuck printer cannot block another printer.
 * - Every job has a timeout that starts when the job STARTS running (not while it waits). When it expires the
 *   caller gets a PrintError(PRINT_TIMEOUT), the job's AbortSignal fires so it can kill what it started, and the
 *   queue moves on. Whatever the job does later (finishes, fails) is ignored: a job settles exactly once.
 * - A rejection reaches only the caller of that enqueue; the chain keeps running for the jobs behind it.
 * - Nothing is kept for a key once its last job has finished.
 */

const { PrintError, ERROR_CODES } = require('../errors');

const DEFAULT_TIMEOUT_MS = 30000;

/** setTimeout fires immediately for delays above this (a signed 32-bit integer), so longer ones are clamped. */
const MAX_TIMER_MS = 2147483647;

const noop = () => {};

/**
 * @param {unknown} value a requested timeout
 * @param {number} fallback used when the value is not a usable number
 * @returns {number} milliseconds, always a finite number between 1 and MAX_TIMER_MS
 */
function pickTimeout(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.ceil(value), MAX_TIMER_MS);
}

/**
 * @param {string} reason what was wrong with the call (for the log; the cashier gets the generic text)
 * @returns {PrintError}
 */
function badCall(reason) {
  return new PrintError(ERROR_CODES.UNKNOWN, undefined, { reason });
}

/**
 * Creates a job queue.
 *
 * @param {object} [options]
 * @param {number} [options.defaultTimeoutMs=30000] timeout of a job that does not set its own
 * @param {{info?: Function, warn?: Function}} [options.log] optional logger (electron-log shape)
 * @returns {{
 *   enqueue: (key: string, jobFn: (ctx: {signal: AbortSignal, label: string}) => any, opts?: {label?: string, timeoutMs?: number}) => Promise<any>,
 *   size: (key: string) => number,
 *   drain: (timeoutMs?: number) => Promise<boolean>
 * }}
 */
function createJobQueue({ defaultTimeoutMs = DEFAULT_TIMEOUT_MS, log } = {}) {
  const fallbackTimeoutMs = pickTimeout(defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  /** @type {Map<string, {tail: Promise<void>, count: number}>} */
  const lanes = new Map();
  /** @type {Set<() => void>} */
  const idleWaiters = new Set();
  let pending = 0;

  /**
   * Runs one job with its timeout. Settles exactly once; later outcomes of the job are logged and ignored.
   *
   * @returns {Promise<any>}
   */
  function runWithTimeout(jobFn, label, timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const startedAt = Date.now();
      let settled = false;
      let timer = null;

      const settle = (action, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        action(value);
        return true;
      };

      timer = setTimeout(() => {
        const error = new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { label, timeoutMs });
        if (!settle(reject, error)) return;
        log?.warn?.('print job timed out', { label, timeoutMs });
        controller.abort(error);
      }, timeoutMs);

      let started;
      try {
        started = Promise.resolve(jobFn({ signal: controller.signal, label }));
      } catch (error) {
        settle(reject, error);
        return;
      }
      started.then(
        (value) => {
          if (!settle(resolve, value)) log?.warn?.('late job completion ignored', { label, ms: Date.now() - startedAt });
        },
        (error) => {
          if (!settle(reject, error)) log?.warn?.('late job failure ignored', { label, ms: Date.now() - startedAt });
        },
      );
    });
  }

  /** Bookkeeping when a job has settled: drops an empty lane and wakes drain() callers when nothing is left. */
  function release(key, lane) {
    lane.count -= 1;
    pending -= 1;
    if (lane.count === 0 && lanes.get(key) === lane) lanes.delete(key);
    if (pending > 0) return;
    for (const wake of [...idleWaiters]) {
      idleWaiters.delete(wake);
      wake();
    }
  }

  /**
   * Queues a job behind everything already queued under the same key.
   *
   * @param {string} key serialisation key, for example `system:EPSON TM-T20` or `port:\\.\LPT1`
   * @param {(ctx: {signal: AbortSignal, label: string}) => any} jobFn does the work; `signal` aborts when the job times out
   * @param {{label?: string, timeoutMs?: number}} [options] `label` is for logs only; `timeoutMs` overrides the default
   * @returns {Promise<any>} the job's result; rejects with the job's error or PrintError(PRINT_TIMEOUT)
   */
  function enqueue(key, jobFn, options) {
    if (typeof key !== 'string' || key === '') return Promise.reject(badCall('the key must be a non-empty string'));
    if (typeof jobFn !== 'function') return Promise.reject(badCall('the job must be a function'));
    const opts = options !== null && typeof options === 'object' ? options : {};
    const label = typeof opts.label === 'string' && opts.label ? opts.label : key;
    const timeoutMs = pickTimeout(opts.timeoutMs, fallbackTimeoutMs);

    let lane = lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), count: 0 };
      lanes.set(key, lane);
    }
    lane.count += 1;
    pending += 1;
    const previous = lane.tail;
    const owner = lane;

    const result = (async () => {
      await previous;
      try {
        return await runWithTimeout(jobFn, label, timeoutMs);
      } finally {
        release(key, owner);
      }
    })();
    // The tail never rejects, so one failed job cannot break the chain; it also marks `result` as handled for
    // callers that ignore the returned promise (fire-and-forget paths).
    lane.tail = result.then(noop, noop);
    return result;
  }

  /**
   * @param {string} key
   * @returns {number} jobs queued or running under the key
   */
  function size(key) {
    const lane = typeof key === 'string' ? lanes.get(key) : undefined;
    return lane ? lane.count : 0;
  }

  /**
   * Waits until every queue is idle (used on quit so the last receipt is not lost).
   *
   * @param {number} [timeoutMs] how long to wait; defaults to the queue's default job timeout
   * @returns {Promise<boolean>} true when idle, false when the time ran out first
   */
  function drain(timeoutMs) {
    if (pending === 0) return Promise.resolve(true);
    const wait = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? Math.min(Math.ceil(timeoutMs), MAX_TIMER_MS)
      : fallbackTimeoutMs;
    return new Promise((resolve) => {
      let timer = null;
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        idleWaiters.delete(onIdle);
        resolve(false);
      }, wait);
      idleWaiters.add(onIdle);
    });
  }

  return { enqueue, size, drain };
}

module.exports = { createJobQueue, DEFAULT_TIMEOUT_MS };
