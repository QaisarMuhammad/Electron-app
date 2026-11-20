'use strict';

/**
 * GadgetsPOS Desktop 2.0: the main process (SPEC 3, 18b S1).
 *
 * `bootstrap(overrides)` is the ONLY place with side effects. Everything else under src/main is a factory that receives what it
 * needs, so it can be tested under plain Node; this file wires the real Electron objects into them, in the order that gets the
 * loading screen in front of the cashier first:
 *
 *   1. before the app is ready      flags.json (read synchronously) -> Chromium switches -> single-instance lock -> the one IPC
 *                                   handler the app preload asks synchronously (`app:origin-allowed`)
 *   2. app ready                    the main window is created and shows loading.html at once. It uses a small synchronous read of
 *                                   config.json (earlyConfig.js) for its bounds, zoom and server address
 *   3. while the page renders       electron-store (about 170 ms) is imported at once: the browser thread has nothing else to do while
 *                                   the renderer process starts (measured: the POS starts loading about 90 ms sooner than when the
 *                                   import waits for the loading screen, for about 70 ms later loading screen)
 *   4. loading screen painted       electron-log (about 40 ms), then the config, the printing services, the windows, the menu, the IPC
 *                                   handlers, the connection recovery and the updater. (The window itself has been on screen since
 *                                   step 2, in the page's colour, and `loading-visible` marks that; `loading-painted` marks this step.)
 *   5. services ready               the POS page is loaded
 *   6. 10 s after the POS loaded    electron-updater is required (about 215 ms) and the first update check is scheduled
 *
 * Quitting is graceful (shutdown.js): the print queue is drained first, so the last receipt is not lost.
 * Started by Electron as the app entry (`electron .` in development, `resources/app.asar` once installed), this file starts itself
 * (see `isAppEntry`); required by a harness or a test it does nothing until `bootstrap` is called.
 */

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { performance } = require('node:perf_hooks');

const { createPerf } = require('./perf');
const { createDeferredLog, installProcessLogging, configureLogging } = require('./logging');
const { readFlagsSync, writeFlags, resolveGpuDisabled } = require('./flags');
const { applyCommandLineSwitches, createLoginItem, createPowerKeeper, createNotifier, createQuietWindowClass } = require('./platform');
const { readEarlyConfigSync, createDeferredConfig } = require('./earlyConfig');
const { DEFAULTS, createConfig } = require('./config');
const { defaultsForChannel, readChannel } = require('./channel');
const { createSecurity, isSafeExternalUrl, SECURE_WEB_PREFERENCES } = require('./security');
const { registerIpc, registerOriginHandler } = require('./ipc');
const { createShutdown } = require('./shutdown');
const { createGpuGuard } = require('./gpuGuard');
const { createConnectivity, createNetProbe, createRequestErrorMonitor } = require('./connectivity');
const { createMainWindow } = require('./windows/main');

/** The folder that contains package.json: `app.asar` when installed, the project folder in development. */
const APP_ROOT = nodePath.resolve(__dirname, '..', '..');

/**
 * The Windows AppUserModelId (notifications and the taskbar group). It is `build.appId` of package.json, which electron-builder
 * REMOVES from the package.json inside the installed app, so it is written here, and tests/packaging pins the two together.
 */
const APP_ID = 'com.example.gadgetspos';

/** The updater is loaded this long after the POS page finished loading (SPEC 13, 18b S1). */
const UPDATER_DELAY_MS = 10 * 1000;

/** The longest the boot waits for the loading screen to be drawn before it goes on anyway. */
const PAINT_WAIT_MS = 5 * 1000;

/** The print queue gets this long to finish before the app quits (SPEC 18b L3). */
const QUIT_DRAIN_MS = 5 * 1000;

/**
 * Where `scripts/` lives at run time. A file inside `app.asar` cannot be run by PowerShell, so electron-builder unpacks the
 * scripts next to the archive (`asarUnpack`), in `app.asar.unpacked`; in development, and in an installation without an
 * archive, the folder is the project folder itself.
 *
 * @param {string} appRoot the folder that contains package.json
 * @returns {string} the folder that contains `scripts/`
 */
function unpackedRoot(appRoot) {
  return appRoot.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
}

/**
 * Everything a test or a harness may replace. Each is optional; the default is the real thing.
 *
 * @typedef {object} BootstrapOverrides
 * @property {object} [electron] the `electron` module (required under plain Node, where it is only a path)
 * @property {NodeJS.Platform} [platform]
 * @property {string[]} [argv] command-line arguments (`--disable-gpu`, `--devtools`)
 * @property {Record<string, string|undefined>} [env] environment variables (`GADGETSPOS_START_URL`, `SystemRoot`, `GADGETSPOS_UPDATE_URL`)
 * @property {boolean} [isPackaged] defaults to `app.isPackaged`
 * @property {string[]} [devOrigins] origins trusted only when unpackaged
 * @property {string} [userDataPath] replaces the userData folder (everything the app stores goes below it)
 * @property {{ now?: () => number, monotonic?: () => number, uptimeMs?: () => number, setTimeout?: Function, clearTimeout?: Function, setInterval?: Function, clearInterval?: Function }} [clock]
 *   `now` is the wall clock; `monotonic` only moves forward and cannot be set (the password lock is kept on it, so changing the PC's clock does not end it)
 * @property {boolean} [testMode] macOS accessory activation policy and `showInactive()` for every window: a harness never takes focus
 * @property {Function} [Store] the `electron-store` class (default: `import('electron-store')`)
 * @property {object} [log] a logger (default: electron-log, configured)
 * @property {object} [rawPrinter] `{ printRaw, dispose? }` (default: the real transports)
 * @property {object} [dymo] `{ print, listPrinters, dispose? }` (default: the real DYMO service)
 * @property {() => Promise<object[]>} [getPrintersAsync] the operating system's printers
 * @property {() => object} [loadAutoUpdater] returns electron-updater's `autoUpdater` (default: `require('electron-updater')`)
 * @property {object} [process] where uncaught errors are caught and `resourcesPath` and `versions` are read
 * @property {{ promises: object }} [fs]
 * @property {Function} [execFile]
 * @property {Function} [spawn]
 * @property {object} [dialog] Electron's dialog
 * @property {string} [osRelease]
 */

/**
 * Starts the app. Resolves, once the loading screen is up and the services are built, with a handle for tests and harnesses; the
 * POS page is still loading then (watch `perf.has('pos-loaded')` or the controller's `pos-loaded` event). Resolves `null` when this
 * is a second instance (it asks the first one to show itself, then quits).
 *
 * @param {BootstrapOverrides} [overrides]
 * @returns {Promise<null|{ app: object, perf: object, shutdown: object, controller: () => (object|null), services: object }>}
 */
async function bootstrap(overrides = {}) {
  const electron = overrides.electron || require('electron');
  const { app, ipcMain } = electron;
  const dialog = overrides.dialog || electron.dialog;
  const proc = overrides.process || process;
  const fs = overrides.fs || nodeFs;
  const platform = overrides.platform || process.platform;
  const argv = overrides.argv || process.argv;
  const env = overrides.env || process.env;
  const testMode = overrides.testMode === true;
  const isPackaged = typeof overrides.isPackaged === 'boolean' ? overrides.isPackaged : Boolean(app.isPackaged);
  const isDev = !isPackaged || argv.includes('--devtools');
  // An injected clock is used as it is (never mixed with the real timers), so a test controls every timer the app starts.
  const clock = overrides.clock
    ? { uptimeMs: () => 0, monotonic: () => performance.now(), ...overrides.clock }
    : {
      now: Date.now,
      monotonic: () => performance.now(),
      uptimeMs: () => process.uptime() * 1000,
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
    };

  const log = createDeferredLog();
  const perf = createPerf({ now: clock.now, uptimeMs: clock.uptimeMs, log });
  installProcessLogging({ proc, log });

  // ---- 1. before the app is ready: what Chromium reads at start ------------------------------------------------------------

  if (testMode && platform === 'darwin' && typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');
  if (overrides.userDataPath) app.setPath('userData', overrides.userDataPath);
  if (platform === 'win32' && typeof app.setAppUserModelId === 'function') app.setAppUserModelId(APP_ID);

  const userDataDir = app.getPath('userData');
  const logsDir = nodePath.join(userDataDir, 'logs');
  const flagsFile = { read: () => readFlagsSync(userDataDir, { fs }), write: (patch) => writeFlags(userDataDir, patch, { fs }) };
  const flags = flagsFile.read();
  const argvDisableGpu = argv.includes('--disable-gpu');
  const gpuDisabled = resolveGpuDisabled({ argv, flags });
  applyCommandLineSwitches({ app, platform, flags, gpuDisabled });

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  const paths = {
    rendererDir: nodePath.join(APP_ROOT, 'src', 'renderer'),
    preloadDir: nodePath.join(APP_ROOT, 'src', 'preload'),
    assetsDir: nodePath.join(APP_ROOT, 'assets'),
  };
  const registry = new Map();
  const early = createDeferredConfig({ early: readEarlyConfigSync(userDataDir, { fs }), defaults: DEFAULTS });
  const security = createSecurity({ getConfig: () => early, isPackaged, devOrigins: overrides.devOrigins, rendererDir: paths.rendererDir, log, now: clock.monotonic });
  registerOriginHandler({ ipcMain, security });

  /** @type {null|ReturnType<typeof createMainWindow>} */
  let mainController = null;
  /** @type {null|ReturnType<typeof import('./ipc').registerIpc>} */
  let ipcHandle = null;
  let servicesReady = false;
  let updater = null;
  let updaterTimer = null;
  let config = null;
  let syncPower = () => {};

  const getMainWindow = () => (mainController && !mainController.window.isDestroyed() ? mainController.window : null);

  const shutdown = createShutdown({ app, timers: clock, log });
  shutdown.install();

  /**
   * The Settings window, as far as quitting is concerned (filled in when it exists). A quit or a restart that the cashier asks for
   * closes it first, through the same path as its close button: with unsaved changes that is the question "Keep editing" or
   * "Discard changes", and "Keep editing" cancels the quit. Without this the window, a child of the main window, would be taken
   * down with it and the question could not be answered.
   */
  const settingsGate = { isOpen: () => false, confirmClose: () => Promise.resolve(true) };
  const quitApp = () => void settingsGate.confirmClose().then((closed) => closed && shutdown.quit());
  const restartApp = () => void settingsGate.confirmClose().then((closed) => closed && shutdown.restart());

  const gpuGuard = createGpuGuard({
    dialog, flags: flagsFile, getWindow: getMainWindow, requestRestart: restartApp, timers: clock, now: clock.now, log, gpuDisabled, argvDisableGpu,
  });
  app.on('child-process-gone', (_event, details) => gpuGuard.recordChildProcessGone(details));
  app.on('second-instance', () => {
    if (mainController) mainController.focus();
  });
  app.on('window-all-closed', () => {
    if (platform !== 'darwin') shutdown.quit();
  });

  /** Opens the connections to the server before they are needed (SPEC 18b S2). */
  function preconnect(url) {
    try {
      const origin = new URL(String(url)).origin;
      if (/^https?:/.test(origin)) electron.session.defaultSession.preconnect({ url: origin, numSockets: 4 });
    } catch (error) {
      log.warn(`could not preconnect (${error && error.message})`);
    }
  }

  /** The address of the POS: the development start URL when unpackaged, otherwise the saved `serverUrl`. */
  function getServerUrl() {
    const start = env.GADGETSPOS_START_URL;
    if (!isPackaged && typeof start === 'string' && start.trim() !== '') return start.trim();
    return early.get('serverUrl');
  }

  const netProbe = createNetProbe({ net: electron.net, timers: clock });
  const connectivity = createConnectivity({
    net: electron.net,
    // The probe also warms the connection, so a reconnect that succeeds is already one connection ahead (SPEC 18b S2).
    probe: (url) => {
      preconnect(url);
      return netProbe(url);
    },
    timers: clock,
    now: clock.now,
    log,
    onStatus: (status) => {
      if (mainController) mainController.handleConnectivityStatus(status);
      if (ipcHandle) {
        ipcHandle.pushConnectionStatus(status);
        ipcHandle.pushState({ online: status.online });
      }
    },
  });

  log.info(`GadgetsPOS ${app.getVersion()} is starting (${platform}, ${isPackaged ? 'installed' : 'development'}, hardware acceleration ${gpuDisabled ? 'off' : 'on'})`);

  // ---- 2. app ready: the window and the loading screen first --------------------------------------------------------------

  await app.whenReady();
  perf.mark('app-ready');

  const WindowClass = testMode ? createQuietWindowClass(electron.BrowserWindow) : electron.BrowserWindow;
  const notify = createNotifier({ Notification: electron.Notification, log });

  function onPosLoaded() {
    perf.mark('pos-loaded');
    perf.logOnce();
    if (updater !== null && updaterTimer === null) {
      updaterTimer = clock.setTimeout(() => updater.init(), UPDATER_DELAY_MS);
      if (updaterTimer && typeof updaterTimer.unref === 'function') updaterTimer.unref();
    }
  }

  function onMainWindowClosed(controller) {
    if (mainController === controller) mainController = null;
    syncPower();
    if (platform !== 'darwin') shutdown.quit();
  }

  /** Creates the main window and hooks it into the startup marks, the GPU safety net and the quit rules. */
  function openMainWindow() {
    const controller = createMainWindow({
      BrowserWindow: WindowClass,
      app,
      screen: electron.screen,
      config: early,
      security,
      connectivity,
      paths,
      log,
      openExternal: (url) => electron.shell.openExternal(url),
      registry,
      Menu: electron.Menu,
      clipboard: electron.clipboard,
      dialog,
      isSafeExternalUrl,
      notify,
      nativeTheme: electron.nativeTheme,
      isDev,
      platform,
      timers: clock,
      now: clock.now,
      getServerUrl,
    });
    mainController = controller;
    const createdAt = clock.now();
    controller.on('visible', () => perf.mark('loading-visible'));
    controller.on('painted', () => perf.mark('loading-painted'));
    controller.on('pos-dom-ready', () => perf.mark('pos-dom-ready'));
    controller.on('pos-loaded', onPosLoaded);
    controller.window.webContents.on('render-process-gone', (_event, details) => gpuGuard.recordRenderProcessGone(details, createdAt));
    controller.window.on('close', (event) => {
      // Windows and Linux: closing the POS window quits the app. With Settings open that is a quit like any other (see `settingsGate`).
      if (platform === 'darwin' || shutdown.isQuitting() || !settingsGate.isOpen()) return;
      event.preventDefault();
      quitApp();
    });
    controller.window.once('closed', () => onMainWindowClosed(controller));
    return controller;
  }

  /**
   * Resolves when the loading screen has been drawn (or after a safety timeout, so a window that never reports itself cannot stall
   * the boot). The services wait for it, and not only for the window: they keep the main thread busy, and the first frame of the
   * page needs that thread.
   */
  function whenPainted(controller) {
    if (perf.has('loading-painted')) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        controller.off('painted', done);
        if (timer !== null) clock.clearTimeout(timer);
        resolve();
      };
      controller.on('painted', done);
      timer = clock.setTimeout(done, PAINT_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  const first = openMainWindow();
  perf.mark('window-created');
  preconnect(getServerUrl());
  void first.showLoading();

  // The settings store is the biggest thing to load. Importing it now overlaps with the renderer process starting up.
  const storeClass = overrides.Store ? Promise.resolve(overrides.Store) : import('electron-store').then((module) => module.default);
  storeClass.catch(() => {}); // the failure is reported where the store is used (below), not as an unhandled rejection

  const handle = { app, perf, shutdown, controller: () => mainController, services: {} };

  // ---- 3. the loading screen is drawn: everything else --------------------------------------------------------------------

  try {
    await whenPainted(first);

    const Store = await storeClass;
    if (overrides.log) {
      log.attach(overrides.log);
    } else {
      const electronLog = require('electron-log');
      configureLogging({ log: electronLog, logsDir, verbose: !isPackaged, fs });
      log.attach(electronLog);
    }

    // a fresh install opens the address of the channel it was built for (production or testing); a saved or carried-over address always wins
    const channel = readChannel(APP_ROOT);
    if (channel) log.info(`release channel: ${channel}`);
    config = createConfig({ Store, log, defaults: defaultsForChannel(DEFAULTS, channel) });
    const migration = config.migrateLegacy();
    early.attach(config);
    perf.mark('config-ready');

    // -- printing --
    const { createJobQueue } = require('./printing/queue');
    const { createRawPrinter } = require('./printing/transports');
    const { createDymoService } = require('./printing/dymo');
    const { createDrawer } = require('./printing/drawer');
    const { createPrintService } = require('./printing/jobs');
    const passwordTools = require('./password');

    const queue = createJobQueue({ log });
    const rawPrinter = overrides.rawPrinter || createRawPrinter({
      platform,
      fs,
      execFile: overrides.execFile || require('node:child_process').execFile,
      spawn: overrides.spawn || require('node:child_process').spawn,
      tmpDir: nodeOs.tmpdir(),
      resourcesPath: unpackedRoot(APP_ROOT),
      queue,
      log,
      systemRoot: env.SystemRoot,
    });
    const dymo = overrides.dymo || createDymoService({
      createHiddenWindow: () => new WindowClass({ show: false, webPreferences: { ...SECURE_WEB_PREFERENCES, backgroundThrottling: false, devTools: false } }),
      labelsDir: nodePath.join(APP_ROOT, 'labels'),
      readFile: (file, encoding) => fs.promises.readFile(file, encoding),
      getConfig: () => config,
      log,
    });
    // The lock runs on the monotonic clock and is saved with the wall-clock moment, so neither a changed PC clock nor a restart gives five new guesses.
    const throttle = passwordTools.createThrottle({
      now: clock.now,
      monotonic: clock.monotonic,
      load: () => config.get('drawer.lock', null),
      save: (record) => config.set('drawer.lock', record === null ? undefined : record),
    });
    const drawer = createDrawer({ config, rawPrinter, password: passwordTools, throttle, log });

    // -- windows --
    const { createSettingsWindow } = require('./windows/settings');
    const { createPasswordWindow } = require('./windows/password');
    const { createPasswordPrompt } = require('./passwordPrompt');
    const localDeps = {
      BrowserWindow: WindowClass,
      app,
      screen: electron.screen,
      registry,
      log,
      paths,
      dialog,
      getParent: getMainWindow,
      nativeTheme: electron.nativeTheme,
      isDev,
      platform,
    };
    const settingsWindow = createSettingsWindow(localDeps);
    Object.assign(settingsGate, { isOpen: settingsWindow.isOpen, confirmClose: settingsWindow.confirmClose });
    const passwordWindow = createPasswordWindow(localDeps);
    const passwordPrompt = createPasswordPrompt({ passwordWindow, settingsWindow, drawer, throttle, timers: clock, log });

    // -- what the pages and the menu ask of the main process --
    const { createErrorBoxes } = require('./errorBoxes');
    const { createPrinterLister } = require('./printerList');
    const { createDesktopApi } = require('./desktopApi');
    const { createUpdater, createFeedUrlReader } = require('./updater');

    const errorBoxes = createErrorBoxes({ dialog, getWindow: getMainWindow, now: clock.now, log });
    const printService = createPrintService({
      config, rawPrinter, dymo, drawer, queue, log, now: clock.now,
      promptDrawer: () => passwordPrompt.show('drawer'),
    });
    const getPrintersAsync = overrides.getPrintersAsync || (async () => {
      const window = getMainWindow() || settingsWindow.getWindow();
      return window ? window.webContents.getPrintersAsync() : [];
    });
    const listPrinters = createPrinterLister({ getPrintersAsync, dymo, log });

    updater = createUpdater({
      autoUpdater: overrides.loadAutoUpdater || (() => require('electron-updater').autoUpdater),
      app,
      getConfig: () => config,
      dialog,
      log,
      isPackaged,
      readFeedUrl: createFeedUrlReader({ fs, resourcesPath: proc.resourcesPath || '' }),
      env,
      timers: clock,
      uptimeMs: clock.uptimeMs,
      getWindow: getMainWindow,
    });

    const desktopApi = createDesktopApi({
      appName: app.getName(),
      version: app.getVersion(),
      platform,
      arch: proc.arch || process.arch,
      osRelease: overrides.osRelease || nodeOs.release(),
      versions: proc.versions || process.versions,
      isPackaged,
      config, drawer, passwordPrompt, settingsWindow, printService, listPrinters,
      flags: flagsFile,
      argvDisableGpu,
      gpuDisabled,
      perf,
      updater,
      connectivity,
      getController: () => mainController,
      paths: { userData: userDataDir, logsDir },
      openPath: async (folder) => {
        fs.mkdirSync(folder, { recursive: true });
        return electron.shell.openPath(folder);
      },
      writeClipboard: (text) => electron.clipboard.writeText(text),
      restart: restartApp,
      log,
    });

    ipcHandle = registerIpc({
      ipcMain,
      security,
      registry,
      log,
      printService,
      errorBoxes,
      desktopApi,
      appInfo: () => ({ name: app.getName(), version: app.getVersion(), platform }),
      closeSenderWindow: (sender) => {
        const window = electron.BrowserWindow.fromWebContents(sender);
        if (window && window !== getMainWindow()) window.close();
      },
      settingsWindow,
    });
    updater.subscribe((status) => ipcHandle.pushState({ update: status }));

    // -- the operating system --
    const power = createPowerKeeper({ powerSaveBlocker: electron.powerSaveBlocker, log });
    syncPower = () => power.sync(getMainWindow() !== null && config.get('power.keepAwake', true) !== false);
    const loginItem = createLoginItem({ app, platform, isPackaged, log });
    loginItem.apply(config.get('startup.openAtLogin', false) === true);
    syncPower();

    security.configureSession(electron.session.defaultSession);
    createRequestErrorMonitor({
      connectivity,
      isAllowedOrigin: security.isAllowedOrigin,
      getUrl: () => {
        const url = getServerUrl();
        return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;
      },
      now: clock.now,
      log,
    }).attach(electron.session.defaultSession);

    config.onDidChange((next, previous) => {
      ipcHandle.pushState({ config: config.publicState() });
      if (next.serverUrl !== previous.serverUrl) preconnect(getServerUrl());
      if (JSON.stringify(next.power) !== JSON.stringify(previous.power)) syncPower();
      if (next.startup && previous.startup && next.startup.openAtLogin !== previous.startup.openAtLogin) loginItem.apply(next.startup.openAtLogin === true);
    });

    // -- the menu --
    const { buildMenu } = require('./windows/menu');
    const installMenu = () => {
      const compatibilityMode = argvDisableGpu || flagsFile.read().disableGpu === true;
      const controller = () => mainController;
      electron.Menu.setApplicationMenu(buildMenu({
        app,
        Menu: electron.Menu,
        isPackaged,
        platform,
        argv,
        compatibilityMode,
        handlers: {
          openDrawer: () => void printService.requestDrawerPrompt().then((result) => errorBoxes.show(result, { kind: 'drawer' })),
          reload: () => controller() && controller().reload(),
          forceReload: () => controller() && controller().reload({ force: true }),
          zoomIn: () => controller() && controller().zoomIn(),
          zoomOut: () => controller() && controller().zoomOut(),
          resetZoom: () => controller() && controller().resetZoom(),
          toggleFullScreen: () => controller() && controller().toggleFullScreen(),
          toggleDevTools: () => controller() && controller().toggleDevTools(),
          openSettings: (tab) => desktopApi.openSettings(tab),
          about: () => desktopApi.openSettings('about'),
          checkForUpdates: () => {
            desktopApi.openSettings('about');
            void updater.checkNow();
          },
          openLogsFolder: () => void desktopApi.openLogsFolder().then((result) => errorBoxes.show(result, { kind: 'other' })),
          copyDiagnostics: () => {
            desktopApi.copyDiagnostics();
            notify('Diagnostics copied to the clipboard.');
          },
          setCompatibilityMode: (enabled) => void gpuGuard.setCompatibilityMode(enabled).then(installMenu),
          quit: quitApp,
        },
      }));
    };
    installMenu();

    // -- quitting: the print queue first, then everything that runs in the background (SPEC 18b D5, L3) --
    shutdown.add('print queue', () => queue.drain(QUIT_DRAIN_MS));
    shutdown.add('update check', () => {
      if (updaterTimer !== null) clock.clearTimeout(updaterTimer);
      updaterTimer = null;
      updater.dispose();
    });
    shutdown.add('connection check', () => connectivity.stop());
    shutdown.add('screen check and password window', () => {
      gpuGuard.dispose();
      passwordPrompt.dispose();
      power.dispose();
    });
    shutdown.add('DYMO window', () => (typeof dymo.dispose === 'function' ? dymo.dispose() : undefined));
    shutdown.add('print helper', () => (typeof rawPrinter.dispose === 'function' ? rawPrinter.dispose() : undefined));

    app.on('activate', () => {
      if (!servicesReady || getMainWindow() !== null) return;
      const next = openMainWindow();
      syncPower();
      void next.showLoading().then(() => next.loadPos());
    });

    gpuGuard.scheduleScreenCheck({ migratedFromV1: Boolean(migration && migration.migrated && migration.fromV1) });
    perf.mark('services-ready');
    servicesReady = true;
    handle.services = { config, queue, rawPrinter, dymo, drawer, throttle, printService, desktopApi, updater, connectivity, passwordPrompt, settingsWindow, passwordWindow, errorBoxes, gpuGuard, security, registry };

    // -- 4. the POS --
    void first.loadPos();
  } catch (error) {
    log.error('startup failed', error && error.stack ? error.stack : String(error));
    try {
      dialog.showErrorBox('GadgetsPOS could not start', 'Something went wrong while starting GadgetsPOS. Close it and open it again. If it keeps happening, contact support.');
    } catch {
      // The box is a courtesy; the log has the cause.
    }
    app.quit();
  }
  return handle;
}

/**
 * Whether Electron itself loaded this file as the app's entry point, which is when it must start the app. Electron has two loaders
 * (measured on Electron 32.3.3):
 *
 *   - `electron .`, `electron <folder>` and `electron <archive>` (the "default app"): the file has no parent module and
 *     `require.main` is undefined;
 *   - an INSTALLED app (`resources/app.asar`, what the installers lay out): Electron runs `Module._load(file, Module, true)`, so the
 *     parent is the Module class and `require.main` is this very module.
 *
 * Whatever merely `require()`s the file (a test, a harness) gives it a real parent module and a different `require.main`, so it
 * stays inert until `bootstrap` is called. Under plain Node `versions.electron` does not exist, so it never starts there either.
 *
 * @param {NodeModule} current this module (`module`)
 * @param {NodeModule|undefined} mainModule `require.main`
 * @param {{ electron?: string }} versions `process.versions`
 * @returns {boolean}
 */
function isAppEntry(current, mainModule, versions) {
  return Boolean(versions && versions.electron) && (mainModule === current || !current.parent);
}

if (isAppEntry(module, require.main, process.versions)) {
  bootstrap().catch((error) => {
    // Nothing else can report this: the app did not even get as far as its log.
    process.stderr.write(`GadgetsPOS failed to start: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = { bootstrap, isAppEntry, unpackedRoot, APP_ID, APP_ROOT, UPDATER_DELAY_MS, QUIT_DRAIN_MS };
