'use strict';

/**
 * The hidden window that hosts the DYMO framework (SPEC 9.4 "Hidden window manager", 18b R4 and L2).
 *
 * v1 created the window at startup, answered callers as soon as `did-finish-load` fired (before the framework
 * object existed) and never noticed when the window died. This manager:
 *  - creates the window LAZILY, on the first call that needs it (never when the manager is created);
 *  - shares ONE load promise: every caller awaits the same load, so ten labels sent at once create one window;
 *  - treats the window as ready only when the page has loaded AND the framework object exists (polled for up to 5 s);
 *  - resets when the page fails to load, the render process dies or the window closes, so the next call builds a new one;
 *  - gives up on a load after 15 s and reports DYMO_UNAVAILABLE;
 *  - gives up on a script after 20 s and replaces the window: the framework talks to DYMO Connect with synchronous
 *    requests, so a hung DYMO service blocks the page for good and only a new window gets past it;
 *  - disposes the window after DYMO_IDLE_DISPOSE_MS without use (an unref'd timer, re-armed by every use), so an idle
 *    till does not keep a whole renderer process in memory.
 *
 * The window itself comes from the injected `createHiddenWindow` (a BrowserWindow factory owned by the integrator), so
 * the manager runs under plain Node with a fake window. Required of that window: `loadFile`, `destroy`/`isDestroyed`,
 * `on('closed')` and `webContents` with `executeJavaScript`, `on` and `removeListener`.
 */

const path = require('node:path');
const { FRAMEWORK_PROBE_SCRIPT } = require('./script');

/** A window with no label for this long is destroyed (10 minutes). */
const DYMO_IDLE_DISPOSE_MS = 10 * 60 * 1000;
/** The whole load (create, load the page, framework ready) must finish within this time. */
const LOAD_TIMEOUT_MS = 15_000;
/** A script that has not answered after this long is given up on and its window is replaced (a label normally takes well under a second). */
const SCRIPT_TIMEOUT_MS = 20_000;
/** After the page has loaded, the framework object is polled for this long. */
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 50;

/** src/renderer/dymo-loader.html, from src/main/printing/dymo. */
const DYMO_LOADER_FILE = path.join(__dirname, '..', '..', '..', 'renderer', 'dymo-loader.html');

/** The DYMO helper window is not available; `code` is the ERROR_CODES value the service answers with. */
class DymoWindowError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = 'DymoWindowError';
    this.code = 'DYMO_UNAVAILABLE';
    if (cause !== undefined) this.cause = cause;
  }
}

const realTimers = { setTimeout, clearTimeout, now: () => Date.now() };

/**
 * @param {object} options
 * @param {() => any} options.createHiddenWindow  returns a NEW hidden BrowserWindow that has not loaded anything yet (show: false, contextIsolation, sandbox, no node integration)
 * @param {string} [options.loaderFile]           the page to load (default: src/renderer/dymo-loader.html)
 * @param {{ setTimeout: Function, clearTimeout: Function, now: () => number }} [options.timers]  injected for tests
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 * @param {number} [options.idleDisposeMs]
 * @param {number} [options.loadTimeoutMs]
 * @param {number} [options.scriptTimeoutMs]
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.readyPollMs]
 */
function createDymoWindowManager({
  createHiddenWindow,
  loaderFile = DYMO_LOADER_FILE,
  timers = realTimers,
  log = {},
  idleDisposeMs = DYMO_IDLE_DISPOSE_MS,
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  scriptTimeoutMs = SCRIPT_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyPollMs = READY_POLL_MS,
} = {}) {
  if (typeof createHiddenWindow !== 'function') throw new TypeError('createDymoWindowManager: createHiddenWindow is required');

  const note = (level, message) => {
    try {
      if (typeof log[level] === 'function') log[level](message);
    } catch {
      // a failing logger must never break printing
    }
  };

  /** @type {{ win: any, ready: boolean, attempt: object | null, loading: Promise<any> | null, idleTimer: any, busy: number, listeners: Array<[any, string, Function]> }} */
  const state = { win: null, ready: false, attempt: null, loading: null, idleTimer: null, busy: 0, listeners: [] };

  /** Wakes the framework poll early when the window is dropped (so a dead window is not polled until its deadline). */
  let wakePoll = null;
  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = timers.setTimeout(wake, ms);
      function wake() {
        wakePoll = null;
        timers.clearTimeout(timer);
        resolve();
      }
      wakePoll = wake;
    });

  function clearIdleTimer() {
    if (state.idleTimer) timers.clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  /** (Re)starts the idle countdown. The timer is unref'd, so it can never keep the app alive. */
  function armIdleTimer() {
    clearIdleTimer();
    if (!state.win) return;
    const timer = timers.setTimeout(() => {
      state.idleTimer = null;
      if (state.busy > 0) return armIdleTimer(); // a script is running right now: count again from its end
      note('info', 'DYMO window disposed after being idle');
      return reset('idle', new DymoWindowError('The DYMO window was closed because it was idle.'));
    }, idleDisposeMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    state.idleTimer = timer;
  }

  /** Detaches our listeners, so a window we have let go of cannot reset a newer one. */
  function detachListeners() {
    for (const [emitter, event, listener] of state.listeners) {
      try {
        emitter.removeListener(event, listener);
      } catch {
        // the window may already be gone
      }
    }
    state.listeners = [];
  }

  /**
   * Forgets the current window and destroys it; a load still in progress is failed with `error`.
   * @param {string} reason for the log
   * @param {Error} [error]
   */
  function reset(reason, error) {
    const { win, attempt } = state;
    clearIdleTimer();
    detachListeners();
    state.win = null;
    state.ready = false;
    state.attempt = null;
    state.loading = null;
    if (wakePoll) wakePoll();
    if (attempt) attempt.fail(error || new DymoWindowError(`The DYMO window was reset (${reason}).`));
    if (win) {
      try {
        if (!(typeof win.isDestroyed === 'function' && win.isDestroyed())) win.destroy();
      } catch (destroyError) {
        note('warn', `DYMO window could not be destroyed: ${destroyError && destroyError.message}`);
      }
    }
  }

  /** Polls until the framework object exists (the page script may still be running when did-finish-load fires). */
  async function waitForFramework(win) {
    const deadline = timers.now() + readyTimeoutMs;
    for (;;) {
      if (state.win !== win) return; // the window was dropped meanwhile: nothing left to wait for
      let present = false;
      try {
        present = (await win.webContents.executeJavaScript(FRAMEWORK_PROBE_SCRIPT)) === true;
      } catch {
        present = false;
      }
      if (present) return;
      if (timers.now() >= deadline) throw new DymoWindowError('The DYMO framework did not start in the helper window.');
      await sleep(readyPollMs);
    }
  }

  /**
   * Creates the window and waits until it is usable. Exactly one of these runs at a time (see getWindow).
   * Every failure goes through reset(), which destroys the window and fails the returned promise, so a failed load
   * never leaves a half-made window behind.
   */
  function startLoad() {
    let win;
    try {
      win = createHiddenWindow();
    } catch (error) {
      return Promise.reject(new DymoWindowError(`The DYMO helper window could not be created: ${error && error.message}`, error));
    }
    state.win = win;
    state.ready = false;
    const started = timers.now();

    return new Promise((resolve, reject) => {
      const attempt = { settled: false, timeout: null, fail: null };
      attempt.fail = (error) => {
        if (attempt.settled) return;
        attempt.settled = true;
        timers.clearTimeout(attempt.timeout);
        reject(error);
      };
      state.attempt = attempt;

      // Every handler first checks that its window is still the current one: a late event of a window we dropped must not touch a newer one.
      const current = () => state.win === win;
      const listen = (emitter, event, listener) => {
        emitter.on(event, listener);
        state.listeners.push([emitter, event, listener]);
      };

      attempt.timeout = timers.setTimeout(() => {
        if (current()) reset('load timeout', new DymoWindowError('The DYMO helper window took too long to start.'));
      }, loadTimeoutMs);
      if (attempt.timeout && typeof attempt.timeout.unref === 'function') attempt.timeout.unref();

      listen(win.webContents, 'did-fail-load', (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!current() || isMainFrame === false) return;
        note('warn', `DYMO window failed to load (${errorCode} ${errorDescription})`);
        reset('did-fail-load', new DymoWindowError(`The DYMO helper page failed to load (${errorDescription || errorCode}).`));
      });
      listen(win.webContents, 'render-process-gone', (event, details) => {
        if (!current()) return;
        note('warn', `DYMO window renderer gone (${details && details.reason})`);
        reset('render-process-gone', new DymoWindowError('The DYMO helper window stopped working.'));
      });
      listen(win, 'closed', () => {
        if (current()) reset('closed', new DymoWindowError('The DYMO helper window was closed.'));
      });
      listen(win.webContents, 'did-finish-load', () => {
        if (!current() || attempt.settled) return;
        waitForFramework(win).then(
          () => {
            if (!current() || attempt.settled) return;
            attempt.settled = true;
            timers.clearTimeout(attempt.timeout);
            state.ready = true;
            note('info', `DYMO window ready in ${timers.now() - started} ms`);
            resolve(win);
          },
          (error) => {
            if (current()) reset('framework not ready', error);
          }
        );
      });

      try {
        const loading = win.loadFile(loaderFile);
        if (loading && typeof loading.catch === 'function') {
          loading.catch((error) => {
            // Only a window that is still loading is given up on: a rejection that comes after the page loaded (and the framework was found) is no reason to tear down a working window.
            if (current() && !attempt.settled) reset('loadFile rejected', new DymoWindowError(`The DYMO helper page could not be loaded: ${error && error.message}`, error));
          });
        }
      } catch (error) {
        reset('loadFile threw', new DymoWindowError(`The DYMO helper page could not be loaded: ${error && error.message}`, error));
      }
    });
  }

  /**
   * The ready window, creating it on first use. Callers that arrive during the load share its promise.
   * @returns {Promise<any>}
   * @throws {DymoWindowError} (as a rejection) when the window cannot be made ready
   */
  function getWindow() {
    const { win } = state;
    if (win && state.ready) {
      if (!(typeof win.isDestroyed === 'function' && win.isDestroyed())) return Promise.resolve(win);
      reset('window destroyed', new DymoWindowError('The DYMO helper window was destroyed.'));
    }
    if (!state.loading) {
      const loading = startLoad();
      state.loading = loading;
      const forget = () => {
        if (state.loading === loading) state.loading = null;
      };
      loading.then(forget, forget); // a failed load is never cached: the next call tries again
    }
    return state.loading;
  }

  /**
   * Waits for a running script, but not for ever: after scriptTimeoutMs the window is replaced (a page blocked in a
   * synchronous call cannot be unblocked) and the caller gets DYMO_UNAVAILABLE.
   */
  function withinTime(win, pending) {
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        const error = new DymoWindowError('The DYMO software did not answer in time.');
        note('warn', 'DYMO script timed out; the helper window is replaced');
        if (state.win === win) reset('script timeout', error);
        reject(error);
      }, scriptTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pending.then(
        (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          timers.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * Runs a script in the window (creating it if needed) and resolves with the script's value.
   * @param {string} script
   * @returns {Promise<any>}
   */
  async function run(script) {
    state.busy += 1;
    try {
      const win = await getWindow();
      return await withinTime(win, win.webContents.executeJavaScript(script));
    } finally {
      state.busy -= 1;
      armIdleTimer();
    }
  }

  return {
    getWindow,
    run,
    /** Destroys the window and cancels the timers; a later call builds a new window. */
    dispose() {
      reset('dispose', new DymoWindowError('The DYMO window was disposed.'));
    },
    /** Introspection for tests and diagnostics. */
    status: () => ({ hasWindow: Boolean(state.win), ready: state.ready, loading: Boolean(state.loading), busy: state.busy, idleTimer: Boolean(state.idleTimer) }),
  };
}

module.exports = {
  DYMO_IDLE_DISPOSE_MS,
  LOAD_TIMEOUT_MS,
  SCRIPT_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  DYMO_LOADER_FILE,
  DymoWindowError,
  createDymoWindowManager,
};
