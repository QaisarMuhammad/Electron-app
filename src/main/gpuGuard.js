'use strict';

/**
 * Recovery when the screen misbehaves (SPEC 18b R1 and R1b).
 *
 * v1 switched hardware acceleration off for everybody, which makes a heavy POS page scroll and animate on the CPU. v2 keeps
 * it ON and watches for trouble instead:
 *
 *  - the safety net: the GPU process dying twice within a minute, or the POS page's renderer crashing right after the
 *    start, writes `disableGpu: true` to flags.json (compatibility mode) and asks, in a NATIVE dialog, to restart;
 *  - the one-time question after an upgrade from v1: a blank, black or garbled screen crashes no process, so the cashier
 *    is asked once, in a native box, whether the screen looks right;
 *  - the Help > Compatibility mode checkbox, for a till whose web pages cannot be used at all.
 * Everything here is native on purpose: it must keep working when the web rendering of the app itself is broken.
 *
 * Pure Node: Electron's dialog, the flags file, the timers and the restart are injected.
 */

const { fallbackReason, REASONS } = require('./flags');

/** The "Does the screen look right?" question comes once the POS window has been visible this long. */
const SCREEN_CHECK_DELAY_MS = 20 * 1000;

const MAX_EVENTS = 20;

/**
 * The flags.json patch for switching compatibility mode on or off by hand.
 *
 * @param {boolean} enabled
 * @returns {{ disableGpu: boolean, reason: string }}
 */
function compatibilityPatch(enabled) {
  return { disableGpu: enabled === true, reason: enabled === true ? REASONS.MANUAL : '' };
}

/**
 * @param {object} deps
 * @param {{ showMessageBox: Function }} deps.dialog Electron's dialog
 * @param {{ read: () => object, write: (patch: object) => object }} deps.flags the flags.json accessors
 * @param {() => (object|null|undefined)} [deps.getWindow] the window the dialogs belong to
 * @param {() => void} deps.requestRestart relaunches the app (graceful quit included)
 * @param {{ setTimeout: Function, clearTimeout: Function }} deps.timers
 * @param {() => number} [deps.now=Date.now]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.log]
 * @param {boolean} deps.gpuDisabled true when the GPU is already off in this run (flags.json or `--disable-gpu`)
 * @param {boolean} [deps.argvDisableGpu=false] true when `--disable-gpu` is on the command line (it always wins)
 * @returns {{
 *   recordChildProcessGone: (details: {type?: string, reason?: string}) => void,
 *   recordRenderProcessGone: (details: {reason?: string}, startedAt: number) => void,
 *   scheduleScreenCheck: (options: {migratedFromV1: boolean}) => boolean,
 *   setCompatibilityMode: (enabled: boolean) => Promise<boolean>,
 *   dispose: () => void
 * }}
 */
function createGpuGuard({ dialog, flags, getWindow, requestRestart, timers, now = Date.now, log = {}, gpuDisabled, argvDisableGpu = false }) {
  /** @type {object[]} */
  const events = [];
  let handled = false;
  let screenTimer = null;
  let disposed = false;

  const note = (level, message) => {
    if (typeof log[level] === 'function') log[level](message);
  };

  /** Shows a native question and answers the index of the clicked button (the cancel button when the box fails). */
  async function ask(options) {
    try {
      const window = typeof getWindow === 'function' ? getWindow() : null;
      const usable = window && !(typeof window.isDestroyed === 'function' && window.isDestroyed());
      const answer = usable ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      return answer && Number.isInteger(answer.response) ? answer.response : options.cancelId;
    } catch (error) {
      note('warn', `a native question could not be shown (${error && error.message})`);
      return options.cancelId;
    }
  }

  /** Writes flags.json; returns false (after logging) when the file cannot be written. */
  function writeFlags(patch) {
    try {
      flags.write(patch);
      return true;
    } catch (error) {
      note('error', `flags.json could not be written (${error && error.message})`);
      return false;
    }
  }

  async function switchToCompatibility(reason) {
    if (!writeFlags({ disableGpu: true, reason })) return;
    note('warn', `the screen had a problem (${reason}); compatibility mode is on for the next start`);
    const answer = await ask({
      type: 'warning',
      title: 'GadgetsPOS',
      message: 'The screen had a problem. GadgetsPOS will use compatibility mode.',
      detail: 'Restart now to use it. If you choose Later, it is used the next time GadgetsPOS starts.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer === 0) requestRestart();
  }

  /** Decides whether the crashes seen so far are reason enough to give up hardware acceleration. */
  function evaluate() {
    if (gpuDisabled || handled || disposed) return;
    const reason = fallbackReason(events, now());
    if (!reason) return;
    handled = true;
    void switchToCompatibility(reason);
  }

  function record(entry) {
    events.push(entry);
    if (events.length > MAX_EVENTS) events.shift();
    evaluate();
  }

  async function askAboutTheScreen() {
    screenTimer = null;
    if (handled || disposed) return;
    const answer = await ask({
      type: 'question',
      title: 'GadgetsPOS',
      message: 'Does the screen look right?',
      detail: 'GadgetsPOS now uses your computer’s graphics card to run faster. If the screen is blank, black or looks broken, choose "No, use compatibility mode".',
      buttons: ['Yes', 'No, use compatibility mode'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const wantsCompatibility = answer === 1;
    const patch = wantsCompatibility ? { gpuChecked: true, ...compatibilityPatch(true) } : { gpuChecked: true };
    if (writeFlags(patch) && wantsCompatibility) requestRestart();
  }

  return {
    /** Feed it every `app.on('child-process-gone')` event. */
    recordChildProcessGone(details) {
      const info = details !== null && typeof details === 'object' ? details : {};
      record({ event: 'child-process-gone', reason: String(info.reason || ''), processType: String(info.type || ''), at: now() });
    },

    /** Feed it every `render-process-gone` of the POS window; `startedAt` is when that window began its life. */
    recordRenderProcessGone(details, startedAt) {
      const info = details !== null && typeof details === 'object' ? details : {};
      record({ event: 'render-process-gone', reason: String(info.reason || ''), at: now(), startedAt });
    },

    /**
     * Arms the one-time "Does the screen look right?" question (SPEC 18b R1b). It is asked only for a first launch after a v1
     * upgrade, only while the GPU is in use, and never again once it has been answered (`gpuChecked` in flags.json).
     *
     * @param {{ migratedFromV1: boolean }} options
     * @returns {boolean} true when the timer was armed
     */
    scheduleScreenCheck({ migratedFromV1 }) {
      if (migratedFromV1 !== true || gpuDisabled || disposed || screenTimer !== null) return false;
      try {
        if (flags.read().gpuChecked === true) return false;
      } catch {
        return false;
      }
      screenTimer = timers.setTimeout(() => void askAboutTheScreen(), SCREEN_CHECK_DELAY_MS);
      if (screenTimer && typeof screenTimer.unref === 'function') screenTimer.unref();
      return true;
    },

    /**
     * Help > Compatibility mode: writes the flag and offers a restart.
     *
     * @param {boolean} enabled
     * @returns {Promise<boolean>} false when flags.json could not be written
     */
    async setCompatibilityMode(enabled) {
      if (!writeFlags(compatibilityPatch(enabled))) return false;
      const stays = enabled !== true && argvDisableGpu;
      const answer = await ask({
        type: 'info',
        title: 'GadgetsPOS',
        message: enabled ? 'Compatibility mode will be used the next time GadgetsPOS starts.' : 'Compatibility mode will be switched off the next time GadgetsPOS starts.',
        detail: stays
          ? 'This shortcut starts GadgetsPOS with --disable-gpu, so compatibility mode stays on until that is removed from the shortcut.'
          : 'Restart now to apply it, or choose Later.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer === 0) requestRestart();
      return true;
    },

    dispose() {
      disposed = true;
      if (screenTimer !== null) timers.clearTimeout(screenTimer);
      screenTimer = null;
    },
  };
}

module.exports = { createGpuGuard, compatibilityPatch, SCREEN_CHECK_DELAY_MS };
