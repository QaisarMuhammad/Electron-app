'use strict';

/**
 * Every `ipcMain` handler of the app, and the trust check in front of each one (SPEC 6, 10 and 12).
 *
 * Four families of channel:
 *
 *  1. The POS page (`window.electron`, source area `remote`, trusted only when the sender frame's ORIGIN is allowed):
 *       legacy, fire-and-forget   send-receipt-data  send-barcode-data  open-drawer-legacy
 *       acknowledged (invoke)     print-receipt  print-barcode  open-drawer  app-info  list-printers
 *     The legacy ones cannot report a failure to the old web app, so the APP does: one native error box per error code per
 *     5 seconds (`errorBoxes`). The acknowledged ones answer a Result and show nothing; the web shows it.
 *  2. The app's own pages (`window.desktop`): `desktop:<area>:<name>`, trusted only when the sender window is registered for that
 *     area AND the frame is a file page inside src/renderer (`security.isTrustedSender`). What each channel does is in desktopApi.js.
 *  3. `app:origin-allowed` (the sendSync the app preload asks at document start): answers from the REAL sender frame, always sets
 *     `returnValue` (an unset one would freeze the page), and is registered before the first window exists.
 *  4. Two notices from the app preload when the browser says the network is back (the page's `online` event): `connectivity:networkOnline`
 *     from the POS page (the sender's origin must be allowed) and `desktop:connection:networkOnline` from the offline screen (a
 *     local page of the `connection` area). Neither carries data or gets an answer; a reconnection that is waiting for its next
 *     retry then probes at once.
 *
 * Every handler is wrapped: it never throws into Electron, an untrusted sender gets `UNTRUSTED_SENDER` (or nothing, for a
 * fire-and-forget message), and nothing but the channel and the sender's origin is logged: never a payload.
 */

const { ERROR_CODES, PrintError, toResult } = require('./errors');

/** What `getAppInfo()` of the web reports (SPEC 6.1). The api version never goes down: functions are added, never removed. */
const API_VERSION = 2;
// 'label-designs-1': this app prints the label designs of catalog version 1 (design 5, 6, 8-13 and the repair bag tag, docs/label-design/catalog.json); the dashboard offers
// only the designs the connected app supports (an older app lacks this feature and gets the four original designs)
const FEATURES = Object.freeze(['ack-print', 'drawer', 'printer-list', 'label-designs-1']);

/** The channel the app preload asks synchronously, and the name the integration notes used for it. */
const ORIGIN_CHANNEL = 'app:origin-allowed';
const ORIGIN_CHANNEL_ALIAS = 'security:isAllowedOrigin';

/**
 * @param {unknown} event an IPC event
 * @returns {string} where the sender frame is, for a log line: the origin of a web page, `file:<page>` for a local page (never its
 *   query string), 'unknown' when it cannot be read
 */
function describeSender(event) {
  try {
    const parsed = new URL(String(event && event.senderFrame && event.senderFrame.url));
    return parsed.protocol === 'file:' ? `file:${parsed.pathname.split('/').pop()}` : parsed.origin;
  } catch {
    return 'unknown';
  }
}

/**
 * Registers the origin question of the app preload. It is a separate step because it must exist BEFORE the first window is
 * created, while the other handlers need the services, which are built after the loading screen is up.
 *
 * @param {{ ipcMain: { on: Function, removeListener: Function }, security: { isAllowedOrigin: (origin: string) => boolean } }} deps
 * @returns {() => void} removes the handlers again
 */
function registerOriginHandler({ ipcMain, security }) {
  const handler = (event) => {
    try {
      event.returnValue = security.isAllowedOrigin(event.senderFrame.origin) === true;
    } catch {
      event.returnValue = false;
    }
  };
  ipcMain.on(ORIGIN_CHANNEL, handler);
  ipcMain.on(ORIGIN_CHANNEL_ALIAS, handler);
  return () => {
    ipcMain.removeListener(ORIGIN_CHANNEL, handler);
    ipcMain.removeListener(ORIGIN_CHANNEL_ALIAS, handler);
  };
}

/**
 * @param {object} deps
 * @param {{ on: Function, handle: Function, removeListener: Function, removeHandler: Function }} deps.ipcMain
 * @param {{ isTrustedSender: (event: object, registry: object, area: string) => boolean }} deps.security
 * @param {Map<number, readonly string[]>} deps.registry webContents id -> the `desktop:` areas of that window
 * @param {{ info?: Function, warn?: Function, error?: Function }} deps.log
 * @param {{ printReceipt: Function, printBarcode: Function, openDrawer: Function }} deps.printService src/main/printing/jobs.js
 * @param {{ show: Function }} deps.errorBoxes src/main/errorBoxes.js
 * @param {object} deps.desktopApi src/main/desktopApi.js
 * @param {() => { name: string, version: string, platform: string }} deps.appInfo
 * @param {(sender: object) => void} deps.closeSenderWindow closes the window a `desktop:window:close` came from (never the POS window)
 * @param {{ send: (channel: string, payload: unknown) => void }} deps.settingsWindow receives `desktop:state` and `desktop:connection:status`
 * @returns {{
 *   pushState: (patch: object) => void,
 *   pushConnectionStatus: (status: object) => void,
 *   channels: () => { on: string[], handle: string[] },
 *   dispose: () => void
 * }}
 */
function registerIpc({ ipcMain, security, registry, log, printService, errorBoxes, desktopApi, appInfo, closeSenderWindow, settingsWindow }) {
  /** @type {Array<[string, Function]>} */
  const listeners = [];
  /** @type {string[]} */
  const handled = [];

  const trusted = (event, area) => security.isTrustedSender(event, registry, area);

  function refuse(channel, event) {
    log.warn(`ipc: ${channel} refused for a sender that is not trusted (${describeSender(event)})`);
    return toResult(new PrintError(ERROR_CODES.UNTRUSTED_SENDER));
  }

  /** A failure Result for an error that escaped a handler: logged, never shown raw. */
  function failed(channel, error) {
    log.error(`ipc: ${channel} failed unexpectedly (${error && error.message})`);
    return toResult(error);
  }

  /** The heading of a native box: a drawer problem is a drawer problem even when it came in on the receipt channel. */
  const kindOf = (result, fallback) => (result && typeof result.code === 'string' && result.code.startsWith('DRAWER_') ? 'drawer' : fallback);

  /** A fire-and-forget message from the POS page: run it, and show a failure in the one native box per code. */
  function onRemote(channel, kind, run) {
    const listener = (event, payload) => {
      if (!trusted(event, 'remote')) {
        refuse(channel, event);
        return;
      }
      Promise.resolve()
        .then(() => run(payload))
        .then(
          (result) => errorBoxes.show(result, { kind: kindOf(result, kind) }),
          (error) => errorBoxes.show(failed(channel, error), { kind }),
        );
    };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }

  /** A notice from one of the app's pages: the same trust check, then the handler; nothing is answered and nothing is shown. */
  function onNotice(channel, area, run) {
    const listener = (event) => {
      if (!trusted(event, area)) {
        refuse(channel, event);
        return;
      }
      try {
        run();
      } catch (error) {
        failed(channel, error);
      }
    };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }

  /** An `invoke` channel: the trust check, then the handler; always answers (a Result, or the data the channel is for). */
  function handle(channel, area, run) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event, area)) return refuse(channel, event);
      try {
        return await run(event, ...args);
      } catch (error) {
        return failed(channel, error);
      }
    });
    handled.push(channel);
  }

  // ---- the POS page: legacy, fire-and-forget --------------------------------------------------------------------------

  onRemote('send-receipt-data', 'receipt', (payload) => printService.printReceipt(payload));
  onRemote('send-barcode-data', 'label', (payload) => printService.printBarcode(payload));
  onRemote('open-drawer-legacy', 'drawer', (payload) => printService.openDrawer(payload, { source: 'legacy' }));

  // ---- the POS page: acknowledged -------------------------------------------------------------------------------------

  handle('print-receipt', 'remote', (_event, payload) => printService.printReceipt(payload));
  handle('print-barcode', 'remote', (_event, payload) => printService.printBarcode(payload));
  handle('open-drawer', 'remote', (_event, payload) => printService.openDrawer(payload, { source: 'web' }));
  handle('app-info', 'remote', () => ({ ...appInfo(), apiVersion: API_VERSION, features: [...FEATURES] }));
  handle('list-printers', 'remote', () => desktopApi.listPrinters());

  // ---- the app's own pages --------------------------------------------------------------------------------------------

  const asTab = (tab) => (typeof tab === 'string' ? tab : undefined);
  const desktop = [
    ['connection', 'getStatus', () => desktopApi.connection.getStatus()],
    ['connection', 'retryNow', () => desktopApi.connection.retryNow()],
    ['connection', 'openSettings', (_event, tab) => desktopApi.connection.openSettings(asTab(tab))],
    ['window', 'close', (event) => {
      closeSenderWindow(event.sender);
      return { ok: true };
    }],
    ['settings', 'getState', () => desktopApi.getState()],
    ['settings', 'listPrinters', () => desktopApi.listPrinters()],
    ['settings', 'savePrinter', (_event, role, settings) => desktopApi.savePrinter(role, settings)],
    ['settings', 'testPrint', (_event, role, options) => desktopApi.testPrint(role, options)],
    ['settings', 'setDrawerPassword', (_event, change) => desktopApi.setDrawerPassword(change)],
    ['settings', 'saveDrawerSettings', (_event, values) => desktopApi.saveDrawerSettings(values)],
    ['settings', 'openDrawerTest', (_event, request) => desktopApi.openDrawerTest(request)],
    ['settings', 'saveConnection', (_event, values) => desktopApi.saveConnection(values)],
    ['settings', 'setGeneral', (_event, values) => desktopApi.setGeneral(values)],
    ['settings', 'setPerformance', (_event, values) => desktopApi.setPerformance(values)],
    ['settings', 'restartApp', () => desktopApi.restartApp()],
    ['settings', 'checkForUpdates', () => desktopApi.checkForUpdates()],
    ['settings', 'installUpdate', () => desktopApi.installUpdate()],
    ['settings', 'openLogsFolder', () => desktopApi.openLogsFolder()],
    ['settings', 'copyDiagnostics', () => desktopApi.copyDiagnostics()],
    ['settings', 'resetAll', (_event, request) => desktopApi.resetAll(request)],
    ['password', 'submit', (_event, value) => desktopApi.password.submit(value)],
    ['password', 'cancel', () => desktopApi.password.cancel()],
    ['password', 'getLockout', () => desktopApi.password.getLockout()],
  ];
  for (const [area, name, run] of desktop) handle(`desktop:${area}:${name}`, area, run);

  // ---- the network is back (sent by the app preload when the browser fires `online`) ---------------------------------

  onNotice('connectivity:networkOnline', 'remote', () => desktopApi.connection.networkOnline());
  onNotice('desktop:connection:networkOnline', 'connection', () => desktopApi.connection.networkOnline());

  return {
    /** Tells the Settings window (when open) that part of its state changed; the page merges it shallowly. */
    pushState: (patch) => settingsWindow.send('desktop:state', patch),
    /** Tells the Settings window (when open) the connection status; the main window gets its own copy from its controller. */
    pushConnectionStatus: (status) => settingsWindow.send('desktop:connection:status', status),
    channels: () => ({ on: listeners.map(([channel]) => channel), handle: [...handled] }),
    dispose() {
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
      for (const channel of handled) ipcMain.removeHandler(channel);
      listeners.length = 0;
      handled.length = 0;
    },
  };
}

module.exports = { registerIpc, registerOriginHandler, API_VERSION, FEATURES, ORIGIN_CHANNEL, ORIGIN_CHANNEL_ALIAS };
