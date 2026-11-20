'use strict';

/**
 * GadgetsPOS preload of the SETTINGS and PASSWORD windows (SPEC 6.2, 6.3).
 *
 * ONE self-contained file (a sandboxed preload can load only `electron`, SPEC 2). It exposes the full
 * `window.desktop` API of SPEC 6.2, and only on `file:` pages: the app's own pages in src/renderer. On any other page
 * it exposes nothing. `ipcRenderer` itself is never exposed.
 *
 * Every call is an `ipcRenderer.invoke` on the channel `desktop:<area>:<name>` with the arguments forwarded as given, so
 * `savePrinter(role, settings)` sends `invoke('desktop:settings:savePrinter', role, settings)`. The real security
 * boundary is in the main process: `isTrustedSender` lets a window call only the areas it was registered for
 * (settings window: settings, connection, window; password window: password, window), whatever this file exposes.
 *
 * `connection.openSettings(tab)` takes an optional tab id (`'printers'`, `'connection'` ...); a non-string is sent as `undefined`.
 *
 * Push channels (main -> page), each wrapped by a `subscribe` that returns an unsubscribe function:
 *   desktop:state            window.desktop.settings.onState
 *   desktop:connection:status  window.desktop.connection.onStatus
 *   desktop:password:lockout   window.desktop.password.onLockout
 */
(function gadgetsPosLocalPreload() {
  const { contextBridge, ipcRenderer } = require('electron');

  if (location.protocol !== 'file:') return;

  // ==== BEGIN SHARED: version, subscribe, connection and window controls (identical in app.js and local.js) ====
  const VERSION_ARG_PREFIX = '--gadgetspos-version=';

  /** The app version, which the main process passes to the renderer as a command-line argument. */
  function readAppVersion() {
    const args = Array.isArray(process.argv) ? process.argv : [];
    const entry = args.find((arg) => typeof arg === 'string' && arg.startsWith(VERSION_ARG_PREFIX));
    return entry ? entry.slice(VERSION_ARG_PREFIX.length) : '';
  }

  /**
   * Subscribes to a message the main process pushes. The page receives the payload only (never the IPC event, which
   * carries the sender) and a function that removes the subscription again.
   */
  function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error(err);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }

  const connection = Object.freeze({
    getStatus: () => ipcRenderer.invoke('desktop:connection:getStatus'),
    retryNow: () => ipcRenderer.invoke('desktop:connection:retryNow'),
    openSettings: (tab) => ipcRenderer.invoke('desktop:connection:openSettings', typeof tab === 'string' ? tab : undefined),
    onStatus: (callback) => subscribe('desktop:connection:status', callback),
  });

  const windowControls = Object.freeze({
    close: () => ipcRenderer.invoke('desktop:window:close'),
  });
  // ==== END SHARED ====

  /** Invokes `desktop:<area>:<name>`; the main process verifies the sender before it answers. */
  const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

  const settings = Object.freeze({
    getState: () => invoke('desktop:settings:getState'),
    listPrinters: () => invoke('desktop:settings:listPrinters'),
    savePrinter: (role, printerSettings) => invoke('desktop:settings:savePrinter', role, printerSettings),
    testPrint: (role, options) => invoke('desktop:settings:testPrint', role, options),
    setDrawerPassword: (change) => invoke('desktop:settings:setDrawerPassword', change),
    saveDrawerSettings: (values) => invoke('desktop:settings:saveDrawerSettings', values),
    openDrawerTest: (request) => invoke('desktop:settings:openDrawerTest', request),
    saveConnection: (values) => invoke('desktop:settings:saveConnection', values),
    setGeneral: (values) => invoke('desktop:settings:setGeneral', values),
    setPerformance: (values) => invoke('desktop:settings:setPerformance', values),
    restartApp: () => invoke('desktop:settings:restartApp'),
    checkForUpdates: () => invoke('desktop:settings:checkForUpdates'),
    installUpdate: () => invoke('desktop:settings:installUpdate'),
    openLogsFolder: () => invoke('desktop:settings:openLogsFolder'),
    copyDiagnostics: () => invoke('desktop:settings:copyDiagnostics'),
    resetAll: (request) => invoke('desktop:settings:resetAll', request),
    onState: (callback) => subscribe('desktop:state', callback),
  });

  const password = Object.freeze({
    submit: (value) => invoke('desktop:password:submit', value),
    cancel: () => invoke('desktop:password:cancel'),
    getLockout: () => invoke('desktop:password:getLockout'),
    onLockout: (callback) => subscribe('desktop:password:lockout', callback),
  });

  contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    version: readAppVersion(),
    settings,
    connection,
    password,
    window: windowControls,
  });
})();
