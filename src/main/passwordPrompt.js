'use strict';

/**
 * The password prompt window and what happens after it (SPEC 10 and 6.3).
 *
 * One prompt at a time. `show(purpose)` opens the small modal window; the page sends the typed password through
 * `desktop:password:submit`, and the answer depends on what the prompt is for:
 *   - `drawer`   (Ctrl+D, the web's Open button): `drawer.open` verifies the password and sends the pulse, so a wrong password,
 *                a lockout and a pulse failure all come back as that one Result and are shown inline;
 *   - `settings` (the manager asked for a password before Settings opens): `drawer.checkPassword`, and on success the Settings
 *                window opens on the tab that was asked for;
 *   - `generic`  any other protected step: a password check and nothing else.
 * On success the window closes a moment later, so the "done" state of the page can be seen. Every check shares the throttle of
 * `drawer`, so five wrong guesses anywhere lock every door; `notifyLockout` tells an open prompt about a lockout that another
 * window caused.
 *
 * Pure Node: the windows, the drawer and the timers are injected.
 */

const { ERROR_CODES, PrintError, toResult } = require('./errors');
const { PASSWORD_PURPOSES } = require('./windows/password');

/** How long the window stays after a correct password, in milliseconds. */
const CLOSE_DELAY_MS = 450;

/**
 * @param {object} deps
 * @param {{ open: Function, close: Function, isOpen: () => boolean, send: Function }} deps.passwordWindow src/main/windows/password.js
 * @param {{ open: Function }} deps.settingsWindow src/main/windows/settings.js
 * @param {{ open: Function, checkPassword: Function }} deps.drawer src/main/printing/drawer.js
 * @param {{ check: () => {allowed: boolean, retryAfterSec: number} }} deps.throttle the throttle `drawer` uses
 * @param {{ setTimeout: Function, clearTimeout: Function }} deps.timers
 * @param {number} [deps.closeDelayMs=450]
 * @param {{ info?: Function, warn?: Function }} [deps.log]
 */
function createPasswordPrompt({ passwordWindow, settingsWindow, drawer, throttle, timers, closeDelayMs = CLOSE_DELAY_MS, log = {} }) {
  /** @type {null|{ purpose: string, tab?: string, window: any, done: boolean }} */
  let state = null;
  let closeTimer = null;

  /** @returns {{locked: boolean, retryAfterSec: number}} the lock of the shared throttle, for the lockout countdown of the page */
  function getLockout() {
    const gate = throttle.check();
    return { locked: !gate.allowed, retryAfterSec: gate.retryAfterSec };
  }

  /** Pushes the lock to an open prompt when `result` says a lockout is on. */
  function notifyLockout(result) {
    const wait = result && result.details && result.details.retryAfterSec;
    if (!result || result.ok !== false || !(wait > 0)) return;
    if (passwordWindow.isOpen()) passwordWindow.send('desktop:password:lockout', getLockout());
  }

  /**
   * Opens the prompt. When a prompt is already open it is only brought to the front: its purpose (and wording) never changes.
   *
   * @param {'drawer'|'settings'|'generic'} [purpose='drawer']
   * @param {{ tab?: string }} [options] `tab`: the Settings tab to open after a correct password (`purpose: 'settings'`)
   */
  function show(purpose = 'drawer', { tab } = {}) {
    const known = PASSWORD_PURPOSES.includes(purpose) ? purpose : 'drawer';
    if (passwordWindow.isOpen()) {
      passwordWindow.open({ purpose: known });
      return;
    }
    const window = passwordWindow.open({ purpose: known });
    state = { purpose: known, tab, window, done: false };
    window.once('closed', () => {
      if (state && state.window === window) state = null;
    });
  }

  function scheduleClose() {
    if (closeTimer !== null) timers.clearTimeout(closeTimer);
    closeTimer = timers.setTimeout(() => {
      closeTimer = null;
      passwordWindow.close();
    }, closeDelayMs);
    if (closeTimer && typeof closeTimer.unref === 'function') closeTimer.unref();
  }

  /**
   * The password typed in the prompt.
   *
   * @param {unknown} value
   * @returns {Promise<object>} a Result; `{ ok: true }` closes the window shortly after
   */
  async function submit(value) {
    if (!state || state.done) return toResult(new PrintError(ERROR_CODES.UNKNOWN));
    const password = typeof value === 'string' ? value : '';
    const { purpose, tab } = state;
    const result = purpose === 'drawer'
      ? await drawer.open({ password, source: 'prompt' })
      : drawer.checkPassword({ password });
    notifyLockout(result);
    if (result.ok) {
      if (state) state.done = true;
      if (purpose === 'settings') {
        try {
          settingsWindow.open({ tab });
        } catch (error) {
          if (typeof log.warn === 'function') log.warn(`Settings could not be opened after the password (${error && error.message})`);
        }
      }
      scheduleClose();
    }
    return result;
  }

  /** The Cancel button and the Escape key: closes the prompt without doing anything. */
  function cancel() {
    passwordWindow.close();
    return { ok: true };
  }

  return {
    show,
    submit,
    cancel,
    getLockout,
    notifyLockout,
    isOpen: () => passwordWindow.isOpen(),
    /** Stops the close timer (graceful quit). */
    dispose() {
      if (closeTimer !== null) timers.clearTimeout(closeTimer);
      closeTimer = null;
    },
  };
}

module.exports = { createPasswordPrompt, CLOSE_DELAY_MS };
