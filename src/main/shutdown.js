'use strict';

/**
 * Graceful quit (SPEC 18b D5 and L3).
 *
 * Closing the app must not lose the last receipt. On the first `before-quit` the quit is held back once, the registered
 * tasks run in order (the print queue is drained for up to 5 seconds first, then the hidden windows, the PowerShell print
 * host and the timers are disposed), and only then is the quit allowed to go through. The second `before-quit`, caused by
 * the `app.quit()` at the end of the tasks, is not touched.
 *
 * A restart (Settings, the compatibility dialogs, "Restart now" after an update) takes the same road: `app.relaunch()` is
 * registered first, then the app quits gracefully.
 *
 * Pure Node: Electron's `app` and the timers are injected.
 */

/** No single task may hold the quit back longer than this; a stuck one is abandoned and logged. */
const TASK_TIMEOUT_MS = 8000;

/**
 * @param {object} deps
 * @param {{ on: Function, quit: () => void, relaunch: () => void }} deps.app Electron's app
 * @param {{ setTimeout: Function, clearTimeout: Function }} deps.timers
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.log]
 * @param {number} [deps.taskTimeoutMs=8000]
 * @returns {{
 *   add: (name: string, task: () => (void|Promise<unknown>)) => void,
 *   install: () => void,
 *   quit: () => void,
 *   restart: () => void,
 *   isQuitting: () => boolean
 * }}
 */
function createShutdown({ app, timers, log = {}, taskTimeoutMs = TASK_TIMEOUT_MS }) {
  /** @type {Array<{ name: string, task: Function }>} */
  const tasks = [];
  let started = false;
  let finished = false;
  let relaunching = false;

  const note = (level, message) => {
    if (typeof log[level] === 'function') log[level](message);
  };

  /** Runs one task; a throw, a rejection or a task that takes too long is logged and does not stop the others. */
  async function runTask({ name, task }) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => {
        note('warn', `shutdown: "${name}" took too long and was abandoned`);
        resolve();
      }, taskTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      await Promise.race([Promise.resolve().then(task), timeout]);
    } catch (error) {
      note('error', `shutdown: "${name}" failed (${error && error.message})`);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function runAll() {
    for (const entry of tasks) await runTask(entry);
  }

  /** The `before-quit` listener: holds the quit back once, runs the tasks, then quits for real. */
  function onBeforeQuit(event) {
    if (finished) return;
    event.preventDefault();
    if (started) return;
    started = true;
    note('info', 'shutdown: finishing the print queue and stopping background work');
    runAll()
      .catch((error) => note('error', `shutdown failed (${error && error.message})`))
      .finally(() => {
        finished = true;
        app.quit();
      });
  }

  return {
    /** Registers work for the shutdown; tasks run in the order they were added. */
    add(name, task) {
      tasks.push({ name, task });
    },

    /** Starts listening for `before-quit`. */
    install() {
      app.on('before-quit', onBeforeQuit);
    },

    quit() {
      app.quit();
    },

    /** Quits gracefully and starts the app again (asking twice still starts it only once). */
    restart() {
      if (!relaunching) {
        relaunching = true;
        app.relaunch();
      }
      app.quit();
    },

    isQuitting: () => started,
  };
}

module.exports = { createShutdown, TASK_TIMEOUT_MS };
