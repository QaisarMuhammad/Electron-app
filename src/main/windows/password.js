'use strict';

/**
 * The password prompt window (SPEC 10, 14, 6.3): 420 px wide, not resizable, modal over the main window so the till cannot
 * be used while it asks. The size is the CONTENT size and the height is 380, not the 300 of the first sketch: measured on
 * the real page, it needs 279 px idle, 303 px with a wrong-password message and 368 px while locked (banner), and at 300
 * outer (about 270 of content) the buttons are cut off. One window at a time, created on demand and destroyed on close.
 * Its page is src/renderer/password.html with `window.desktop.password` and `window.desktop.window` (local.js); main
 * lets it call the `password` and `window` areas. The page shows wrong-password and lockout messages inline.
 */

const { createLocalWindowHost } = require('./main');

/**
 * What the password is for. The page reads `?purpose=` to word its heading: the cash drawer (Ctrl+D, the web's Open
 * button), the Settings window when "require password for settings" is on, or any other protected step (`generic`).
 */
const PASSWORD_PURPOSES = Object.freeze(['drawer', 'settings', 'generic']);

/** `desktop:<area>:*` areas the password window may call. */
const PASSWORD_AREAS = Object.freeze(['password', 'window']);

const PASSWORD_SPEC = Object.freeze({
  page: 'password.html',
  title: 'GadgetsPOS',
  width: 420,
  height: 380,
  resizable: false,
  minimizable: false,
  modal: true,
  areas: PASSWORD_AREAS,
});

/**
 * @param {object} deps  See `createLocalWindowHost` in main.js (BrowserWindow, app, screen, registry, log, paths,
 *   getParent and optionally nativeTheme, isDev, platform).
 * @returns {{
 *   open: (options?: { purpose?: 'drawer'|'settings'|'generic' }) => Electron.BrowserWindow,
 *   close: () => void,
 *   isOpen: () => boolean,
 *   getWindow: () => (Electron.BrowserWindow|null),
 *   send: (channel: string, ...args: unknown[]) => void,
 * }}
 *   `open` creates the window, or focuses the open one (a second request does not change its purpose). An unknown
 *   purpose means `drawer`. `send` pushes `desktop:password:lockout` to the page; `close` is called after a correct password.
 */
function createPasswordWindow(deps) {
  const host = createLocalWindowHost(deps, PASSWORD_SPEC);
  return {
    open({ purpose } = {}) {
      const known = PASSWORD_PURPOSES.includes(purpose) ? purpose : 'drawer';
      return host.open({ query: { purpose: known } }).window;
    },
    close: host.close,
    isOpen: host.isOpen,
    getWindow: host.getWindow,
    send: host.send,
  };
}

module.exports = { createPasswordWindow, PASSWORD_PURPOSES, PASSWORD_AREAS };
