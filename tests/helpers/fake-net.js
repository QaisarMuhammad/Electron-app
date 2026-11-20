'use strict';

/**
 * Fakes for the connectivity and updater tests. Not a test file (it does not end in `.test.js`).
 *
 *  - `createFakeClock()`        a manual clock that is also a complete timer set (`setTimeout`, `clearTimeout`,
 *                               `setInterval`, `clearInterval`, `now`). Nothing runs until `tick()` is called, and
 *                               every handle it returns records whether `unref()` was called on it.
 *  - `createFakeNet()`          a scripted stand-in for Electron's `net`: `request()` returns a fake ClientRequest
 *                               that answers with the next queued outcome.
 *  - `createScriptedProbe()`    a scripted `probe(url)` for `createConnectivity`, with a way to hold an answer back.
 *  - `settle()`                 lets every pending promise continuation run.
 */

const { EventEmitter } = require('node:events');

/** Resolves after every promise continuation queued so far has run (a real macrotask boundary). */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {number} [start] the initial value of `now()`
 * @returns {{
 *   now: () => number,
 *   setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function,
 *   tick: (ms: number) => Promise<void>,
 *   pending: () => number,
 *   nextDelay: () => number|null,
 *   created: Array<{ id: number, unrefCalled: boolean }>
 * }}
 */
function createFakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  /** @type {Map<number, { id: number, at: number, fn: Function, every: number|null }>} */
  const timers = new Map();
  const created = [];

  function makeHandle() {
    const handle = {
      id: nextId++,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
        return this;
      },
    };
    created.push(handle);
    return handle;
  }

  function add(fn, ms, every) {
    const handle = makeHandle();
    timers.set(handle.id, { id: handle.id, at: current + Math.max(0, ms || 0), fn, every });
    return handle;
  }

  const clock = {
    created,
    now: () => current,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms || 1)),
    clearTimeout: (handle) => timers.delete(handle && handle.id),
    clearInterval: (handle) => timers.delete(handle && handle.id),
    /** @returns {number} how many timers are armed right now */
    pending: () => timers.size,
    /** @returns {number|null} milliseconds until the earliest armed timer, null when none */
    nextDelay() {
      let earliest = null;
      for (const timer of timers.values()) if (earliest === null || timer.at < earliest) earliest = timer.at;
      return earliest === null ? null : Math.max(0, earliest - current);
    },
    /**
     * Advances the clock by `ms`, firing every timer that falls due in order and letting promise continuations
     * run after each one, so an `await probe()` inside a timer callback completes before the next timer.
     */
    async tick(ms) {
      const target = current + ms;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at <= target && (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
        }
        if (next === null) break;
        current = Math.max(current, next.at);
        if (next.every === null) timers.delete(next.id);
        else next.at = current + next.every;
        next.fn();
        await settle();
      }
      current = target;
      await settle();
    },
  };
  return clock;
}

/** A fake of Electron's `ClientRequest`: records what it was given and answers with its scripted outcome. */
class FakeClientRequest extends EventEmitter {
  constructor(options, outcome) {
    super();
    this.options = options;
    this.outcome = outcome;
    this.ended = false;
    this.aborted = false;
  }

  end() {
    this.ended = true;
    setImmediate(() => this.play());
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('abort');
  }

  /** Delivers the outcome the way Electron would: `response`, `redirect` or `error`; `hang` stays silent. */
  play() {
    if (this.aborted || this.outcome.hang) return;
    const { status, redirect, error } = this.outcome;
    if (error) this.emit('error', error instanceof Error ? error : new Error(error));
    else if (redirect) this.emit('redirect', redirect, 'GET', 'https://example.com/next', {});
    else this.emit('response', { statusCode: status === undefined ? 200 : status, headers: {} });
  }
}

/**
 * @typedef {Object} NetOutcome
 * @property {number} [status] answer with this HTTP status (default 200)
 * @property {number} [redirect] answer with this redirect status
 * @property {string|Error} [error] fail with this error, for example 'net::ERR_NAME_NOT_RESOLVED'
 * @property {boolean} [hang] never answer (to test the timeout)
 * @property {Error} [throws] make `net.request()` itself throw
 */

/**
 * @param {{ online?: boolean }} [options]
 * @returns {{
 *   requests: FakeClientRequest[],
 *   request: (options: object) => FakeClientRequest,
 *   isOnline: () => boolean,
 *   setOnline: (online: boolean) => void,
 *   queue: (...outcomes: NetOutcome[]) => object
 * }}
 */
function createFakeNet({ online = true } = {}) {
  const outcomes = [];
  const requests = [];

  const net = {
    requests,
    isOnline: () => online,
    setOnline(value) {
      online = Boolean(value);
    },
    /** Queues outcomes for the next requests, in order; once they are used up every request answers HTTP 200. */
    queue(...next) {
      outcomes.push(...next);
      return net;
    },
    request(options) {
      const outcome = outcomes.length > 0 ? outcomes.shift() : { status: 200 };
      if (outcome.throws) throw outcome.throws;
      const request = new FakeClientRequest(options, outcome);
      requests.push(request);
      return request;
    },
  };
  return net;
}

/** Put in the script of a probe to hold that answer back until `probe.release(result)` is called. */
const HOLD = Symbol('hold');

/**
 * A scripted `probe(url)` for `createConnectivity`.
 *
 * @param {Array<object|Error|symbol>} [results] answers in order; an Error is thrown, HOLD waits for `release`
 * @param {object} [fallback] the answer once the script is used up (default: the network is down)
 * @returns {Function & { calls: string[], release: (result: object) => void }}
 */
function createScriptedProbe(results = [], fallback = { ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' }) {
  const script = [...results];
  const held = [];

  async function probe(url) {
    probe.calls.push(url);
    const next = script.length > 0 ? script.shift() : fallback;
    if (next === HOLD) return new Promise((resolve) => held.push(resolve));
    if (next instanceof Error) throw next;
    return next;
  }
  probe.calls = [];
  probe.release = (result) => held.shift()(result);
  return probe;
}

module.exports = { settle, createFakeClock, createFakeNet, createScriptedProbe, HOLD };
