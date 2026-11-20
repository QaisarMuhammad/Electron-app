'use strict';

/**
 * The operating-system side of the desktop shell: command-line switches, "start with the computer", keeping the computer
 * awake, native notices, and the quiet window class the test harnesses use (SPEC 18b R1, R2, D3 and 19.8).
 *
 * Every Electron object is injected (`app`, `powerSaveBlocker`, `Notification`, `BrowserWindow`), so each piece runs
 * under plain `node --test` with fakes.
 */

/** Size of Chromium's disk cache: 512 MB. The default is much smaller and the POS re-downloads its bundles often. */
const DISK_CACHE_BYTES = 512 * 1024 * 1024;

/** The power-save blocker type that keeps the computer awake (the display may still sleep: SPEC 18b R2). */
const KEEP_AWAKE_TYPE = 'prevent-app-suspension';

/**
 * Sets the Chromium switches, which only take effect before `app.whenReady()` (SPEC 18b R1 and R2).
 *
 *  - Hardware acceleration is ON unless `gpuDisabled` (the compatibility mode of flags.json or `--disable-gpu`).
 *  - `disk-cache-size` 512 MB.
 *  - On Windows `disable-features=CalculateNativeWinOcclusion`: Chromium otherwise treats a window that another one
 *    covers as hidden and stops painting it, which makes the POS stutter when it comes back to the front.
 *  - `disable-brotli` only when flags.json says so (v1 always did; the default of that flag keeps v1's behaviour).
 * `ignore-gpu-blocklist` is never passed: Chromium's own list of broken graphics drivers stays active.
 *
 * @param {object} options
 * @param {{ disableHardwareAcceleration: () => void, commandLine: { appendSwitch: Function } }} options.app
 * @param {NodeJS.Platform} options.platform
 * @param {{ disableBrotli?: boolean }} options.flags the content of flags.json
 * @param {boolean} options.gpuDisabled
 * @returns {string[]} the names of the switches that were set, for the log
 */
function applyCommandLineSwitches({ app, platform, flags, gpuDisabled }) {
  const applied = [];
  if (gpuDisabled) {
    app.disableHardwareAcceleration();
    applied.push('disable-hardware-acceleration');
  }
  app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_BYTES));
  applied.push('disk-cache-size');
  if (platform === 'win32') {
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
    applied.push('disable-features');
  }
  if (flags && flags.disableBrotli === true) {
    app.commandLine.appendSwitch('disable-brotli');
    applied.push('disable-brotli');
  }
  return applied;
}

/**
 * "Start GadgetsPOS when this computer starts" (SPEC 18b D3): Windows and macOS only, and only for an installed app:
 * an unpackaged run would register the bare Electron program, which opens an empty window at every login.
 *
 * @param {object} options
 * @param {{ getLoginItemSettings: () => {openAtLogin: boolean}, setLoginItemSettings: (settings: object) => void }} options.app
 * @param {NodeJS.Platform} options.platform
 * @param {boolean} options.isPackaged
 * @param {{ info?: Function, warn?: Function }} [options.log]
 * @returns {{ apply: (openAtLogin: boolean) => boolean }}
 */
function createLoginItem({ app, platform, isPackaged, log }) {
  /**
   * @param {boolean} openAtLogin the wanted state
   * @returns {boolean} true when the system setting was changed
   */
  function apply(openAtLogin) {
    if (platform === 'linux' || !isPackaged) return false;
    const wanted = openAtLogin === true;
    try {
      if (app.getLoginItemSettings().openAtLogin === wanted) return false;
      app.setLoginItemSettings({ openAtLogin: wanted });
      if (log && typeof log.info === 'function') log.info(`start at login is now ${wanted ? 'on' : 'off'}`);
      return true;
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn(`start at login could not be changed (${error && error.message})`);
      return false;
    }
  }
  return { apply };
}

/**
 * Keeps the computer awake while the POS window exists and `power.keepAwake` is on (SPEC 18b R2). The display is NOT kept
 * on: only the app is kept from being suspended, so timers, sockets and order sounds keep running.
 *
 * @param {object} options
 * @param {{ start: (type: string) => number, stop: (id: number) => void }} options.powerSaveBlocker
 * @param {{ info?: Function, warn?: Function }} [options.log]
 * @returns {{ sync: (wanted: boolean) => boolean, dispose: () => void, isActive: () => boolean }}
 */
function createPowerKeeper({ powerSaveBlocker, log }) {
  let blockerId = null;

  /**
   * Starts or stops the blocker so it matches `wanted`. Calling it again with the same value does nothing.
   * @param {boolean} wanted
   * @returns {boolean} whether the blocker is active afterwards
   */
  function sync(wanted) {
    try {
      if (wanted && blockerId === null) {
        blockerId = powerSaveBlocker.start(KEEP_AWAKE_TYPE);
      } else if (!wanted && blockerId !== null) {
        powerSaveBlocker.stop(blockerId);
        blockerId = null;
      }
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn(`keep awake could not be changed (${error && error.message})`);
    }
    return blockerId !== null;
  }

  return { sync, dispose: () => void sync(false), isActive: () => blockerId !== null };
}

/**
 * The one-line native notice "Opened in your browser: <host>" (SPEC 12). A system that cannot show notifications simply shows none.
 *
 * @param {{ Notification?: { isSupported: () => boolean, new (options: object): { show: () => void } }, title?: string, log?: { warn?: Function } }} options
 * @returns {(message: string) => void}
 */
function createNotifier({ Notification, title = 'GadgetsPOS', log }) {
  return function notify(message) {
    try {
      if (Notification && Notification.isSupported()) new Notification({ title, body: String(message), silent: true }).show();
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn(`a notice could not be shown (${error && error.message})`);
    }
  };
}

/**
 * The window class a harness uses so that it never takes focus from whatever the developer is doing (SPEC 19.8): `show()`
 * becomes `showInactive()` and `focus()` does nothing. Every window the app creates goes through this class.
 *
 * The class keeps the NAME of the one it extends. Electron's `BrowserWindow.fromWebContents`, `getAllWindows` and
 * `getFocusedWindow` only recognise a window whose constructor is called "BrowserWindow" (checked on Electron 32.3.3: a
 * subclass with another name is skipped, `getAllWindows()` answers `[]`), which would make `desktop:window:close` (the Settings
 * and password pages' own Close) do nothing in a harness run.
 *
 * @param {typeof Electron.BrowserWindow} BrowserWindow
 * @returns {typeof Electron.BrowserWindow}
 */
function createQuietWindowClass(BrowserWindow) {
  class QuietBrowserWindow extends BrowserWindow {
    show() {
      this.showInactive();
    }

    focus() {}
  }
  Object.defineProperty(QuietBrowserWindow, 'name', { value: BrowserWindow.name });
  return QuietBrowserWindow;
}

module.exports = {
  applyCommandLineSwitches,
  createLoginItem,
  createPowerKeeper,
  createNotifier,
  createQuietWindowClass,
  DISK_CACHE_BYTES,
  KEEP_AWAKE_TYPE,
};
