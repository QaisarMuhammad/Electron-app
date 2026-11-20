'use strict';

/**
 * The Settings window (SPEC 14, 6.3): one window at a time, 960x640 (at least 880x560) of content, opened on demand and
 * destroyed when it is closed. Its sizes are content sizes, so the page always has the viewport it was designed for (it must
 * look finished at 960x600). It belongs to the main window (always above it, minimized with it) but does not block it.
 * Its page is src/renderer/settings.html with the full `window.desktop` API of src/preload/local.js; main lets it call
 * the `settings`, `connection` and `window` areas. The page reads its first tab from `?tab=` and follows later changes of
 * the address fragment (`#drawer`).
 *
 * Unsaved changes. While a tab has edits that are not saved the page asks to stay (`beforeunload`, src/renderer/shared/settings.js).
 * Electron then refuses to close the window and tells nobody, unless the main process listens for `will-prevent-unload`: this file
 * does, and asks "You have unsaved changes. Discard them and close?" with "Keep editing" (the default, and what Escape means) and
 * "Discard changes". "Keep editing" leaves the refusal in place, so the window stays; "Discard changes" overrides the page. A page
 * with nothing unsaved asks nothing and closes at once. `confirmClose` runs the same path for the app (quit, restart): it closes
 * the window and says whether it went.
 */

const { createLocalWindowHost, APP_TITLE } = require('./main');

/** Tab ids of settings.html. The menu opens the first four; Help > About opens `about`. */
const SETTINGS_TABS = Object.freeze(['printers', 'drawer', 'connection', 'general', 'about']);

/** `desktop:<area>:*` areas the Settings window may call (its Connection tab shows the status and "Reload POS"). */
const SETTINGS_AREAS = Object.freeze(['settings', 'connection', 'window']);

const SETTINGS_SPEC = Object.freeze({
  page: 'settings.html',
  title: 'GadgetsPOS Settings',
  width: 960,
  height: 640,
  minWidth: 880,
  minHeight: 560,
  resizable: true,
  minimizable: true,
  modal: false,
  areas: SETTINGS_AREAS,
});

/**
 * The question asked when the window is closed with unsaved changes. "Keep editing" is the default and the answer to Escape, so a
 * stray Enter loses nothing; the button numbers are the ones `showMessageBoxSync` answers with.
 */
const UNSAVED_QUESTION = Object.freeze({
  type: 'question',
  title: APP_TITLE,
  message: 'You have unsaved changes. Discard them and close?',
  buttons: Object.freeze(['Keep editing', 'Discard changes']),
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});
const DISCARD = 1;

/**
 * @param {object} deps  See `createLocalWindowHost` in main.js (BrowserWindow, app, screen, registry, log, paths,
 *   getParent and optionally nativeTheme, isDev, platform), plus `dialog` (Electron's dialog) for the unsaved-changes question.
 * @returns {{
 *   open: (options?: { tab?: string }) => Electron.BrowserWindow,
 *   close: () => void,
 *   confirmClose: () => Promise<boolean>,
 *   isOpen: () => boolean,
 *   getWindow: () => (Electron.BrowserWindow|null),
 *   send: (channel: string, ...args: unknown[]) => void,
 * }}
 *   `open` creates the window, or focuses the open one; with `tab` (one of SETTINGS_TABS) it starts on that tab (`?tab=`), or
 *   switches an open window to it (`#tab`). An unknown tab is ignored. `send` pushes `desktop:state` and similar messages.
 *   `confirmClose` closes the window the way its close button does: it resolves true when the window is gone (nothing was unsaved,
 *   or the cashier chose "Discard changes", or no window was open) and false when it stays ("Keep editing").
 */
function createSettingsWindow(deps) {
  const host = createLocalWindowHost(deps, SETTINGS_SPEC);
  if (!deps.dialog) throw new TypeError('createSettingsWindow is missing: dialog');
  const { dialog, log } = deps;

  /** Set while `confirmClose` waits for the window to go or to stay. */
  let closing = null;
  function settleClosing(gone) {
    if (!closing) return;
    const { settle } = closing;
    closing = null;
    settle(gone);
  }

  /** Listens for the page's refusal to be unloaded, and for the window going away. */
  function watch(window) {
    window.webContents.on('will-prevent-unload', (event) => {
      let discard = false;
      try {
        discard = dialog.showMessageBoxSync(window, UNSAVED_QUESTION) === DISCARD;
      } catch (error) {
        log.error('Settings could not ask about the unsaved changes', error && error.message);
      }
      // `preventDefault()` here means "ignore the page's refusal": the window closes. Anything else leaves it open.
      if (discard) event.preventDefault();
      else settleClosing(false);
    });
    window.once('closed', () => settleClosing(true));
  }

  return {
    open({ tab } = {}) {
      const known = SETTINGS_TABS.includes(tab) ? tab : undefined;
      const { window, created } = host.open({ query: known ? { tab: known } : {} });
      if (created) watch(window);
      // settings.html switches tab when the fragment of its address changes: no reload, so unsaved edits stay.
      if (!created && known) host.setHash(known);
      return window;
    },
    close: host.close,
    confirmClose() {
      if (!host.isOpen()) return Promise.resolve(true);
      if (closing) return closing.answer;
      let settle;
      const answer = new Promise((resolve) => {
        settle = resolve;
      });
      closing = { answer, settle };
      host.close(); // a window with nothing unsaved is gone before this returns or soon after; one with unsaved changes asks first
      return answer;
    },
    isOpen: host.isOpen,
    getWindow: host.getWindow,
    send: host.send,
  };
}

module.exports = { createSettingsWindow, SETTINGS_TABS, SETTINGS_AREAS, UNSAVED_QUESTION };
