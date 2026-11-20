'use strict';

/**
 * A whole fake Electron world for `bootstrap()` (src/main/index.js) and the IPC tests. Plain Node, no Electron runtime.
 *
 * `createBootWorld(options)` returns `{ electron, overrides, boot, ... }`: `boot()` calls the REAL `bootstrap` with the fake
 * `electron` module, a real settings file in a temp folder (through the fake `electron-store` of fake-store.js), a manual clock,
 * a recording logger and fake printers. Every other module of src/main is the real one: the security checks, the window code,
 * the config, the drawer and its throttle, the print service and the IPC table run exactly as in the app.
 *
 * What it adds on top of the other helpers:
 *  - `world.order`        the order of the things the boot does ('switch:...', 'ready', 'window', 'store', 'ipc:...');
 *  - `world.ipc`          `send` / `sendSync` / `invoke` that deliver to the handlers registered on the fake `ipcMain`;
 *  - `world.events`       IPC events from the senders that matter: the POS page, a foreign page, the offline page, the Settings
 *                         window, the password window, a window opened by the page;
 *  - `world.app.quit()`   emits `before-quit` like Electron (a prevented quit goes no further).
 * Not named *.test.js: node --test must not run it.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const { createFakeEnv, createFakeLog } = require('./fake-window');
const { createManualClock } = require('./fake-electron');
const { createFakeStoreEnv } = require('./fake-store');
const { createFakeNet } = require('./fake-net');
const { bootstrap, APP_ROOT } = require('../../src/main/index');

const POS_ORIGIN = 'https://vendor.societyfiles.com';
const RENDERER_DIR = path.join(APP_ROOT, 'src', 'renderer');

/**
 * An IPC event as Electron delivers it: the sender webContents (the real fake one when `contents` is given, so
 * `BrowserWindow.fromWebContents(event.sender)` works) and the frame the message came from.
 */
function pageEvent({ contents, id, origin, url, parent = null }) {
  const frame = { origin, url: url || `${origin}/`, parent };
  const sender = contents || { id, isDestroyed: () => false };
  sender.mainFrame = parent === null ? frame : parent;
  return { sender, senderFrame: frame };
}

/** An IPC event from one of the app's own pages (file: URL inside src/renderer). */
function localEvent(contents, page) {
  return pageEvent({ contents, origin: 'file://', url: `${pathToFileURL(path.join(RENDERER_DIR, page)).href}` });
}

/** A fake of `Notification`: records what was shown. */
function createFakeNotification() {
  const shown = [];
  class FakeNotification {
    constructor(options) {
      this.options = options;
    }

    show() {
      shown.push(this.options);
    }

    static isSupported() {
      return true;
    }
  }
  FakeNotification.shown = shown;
  return FakeNotification;
}

/**
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform='win32']
 * @param {boolean} [options.packaged=true]
 * @param {string[]} [options.argv=[]]
 * @param {Record<string, string>} [options.env={}]
 * @param {boolean} [options.testMode=false]
 * @param {boolean} [options.singleInstance=true] what `requestSingleInstanceLock` answers
 * @param {boolean} [options.deferReady=false] `whenReady()` stays pending until `world.ready()`
 * @param {boolean} [options.autoReadyToShow=true] a window that loads loading.html reports `ready-to-show` by itself
 * @param {object} [options.flags] content of flags.json to write before the boot
 * @param {object} [options.config] content of config.json to write before the boot (a v1 file, for example)
 * @param {Array<{x:number,y:number,width:number,height:number}>} [options.workAreas]
 * @param {object[]} [options.systemPrinters] what the system reports
 * @param {boolean} [options.withUpdater=true] provide a fake `autoUpdater` through `loadAutoUpdater`
 * @param {boolean} [options.feed=true] write `<resources>/app-update.yml`, so the (packaged) updater is enabled
 * @param {object} [options.overrides] more bootstrap overrides
 */
function createBootWorld(options = {}) {
  const {
    platform = 'win32', packaged = true, argv = [], env = {}, testMode = false, singleInstance = true, deferReady = false,
    autoReadyToShow = true, workAreas, systemPrinters = [{ name: 'EPSON TM-T20', displayName: 'EPSON TM-T20', isDefault: true, status: 0 }],
    withUpdater = true, feed = true,
  } = options;

  const store = createFakeStoreEnv();
  if (options.config) store.writeRaw(options.config);
  if (options.flags) require('node:fs').writeFileSync(path.join(store.dir, 'flags.json'), JSON.stringify(options.flags));

  const base = createFakeEnv({ platform, workAreas });
  const app = base.app;
  const order = [];
  const clock = createManualClock();
  const log = createFakeLog();
  // `responses` holds what the next dialogs answer: the index of the clicked button, or a function returning a promise of one.
  const dialog = {
    calls: [],
    syncCalls: [],
    errorBoxes: [],
    responses: [],
    showMessageBox(...args) {
      const [window, dialogOptions] = args.length === 1 ? [null, args[0]] : args;
      dialog.calls.push({ window, options: dialogOptions });
      const next = dialog.responses.length > 0 ? dialog.responses.shift() : 0;
      return typeof next === 'function' ? next() : Promise.resolve({ response: next, checkboxChecked: false });
    },
    showMessageBoxSync(...args) {
      dialog.syncCalls.push(args);
      return 0;
    },
    showErrorBox: (title, content) => dialog.errorBoxes.push({ title, content }),
  };
  const notification = createFakeNotification();
  const net = createFakeNet();

  // ---- app ----
  const appCalls = { switches: [], relaunches: 0, exits: [], quitRequests: 0, loginItem: [], activationPolicy: [], appUserModelId: [], paths: {} };
  let ready = null;
  const readyPromise = new Promise((resolve) => {
    ready = () => {
      order.push('ready');
      resolve();
    };
  });
  if (!deferReady) ready();
  let loginOpen = false;
  Object.assign(app, {
    isPackaged: packaged,
    getName: () => 'Gadgets POS',
    getPath: (name) => appCalls.paths[name] || (name === 'userData' ? store.dir : path.join(store.dir, name)),
    setPath: (name, value) => {
      appCalls.paths[name] = value;
    },
    commandLine: {
      appendSwitch: (name, value) => {
        appCalls.switches.push([name, value]);
        order.push(`switch:${name}`);
      },
    },
    disableHardwareAcceleration: () => {
      appCalls.switches.push(['disable-hardware-acceleration']);
      order.push('switch:disable-hardware-acceleration');
    },
    requestSingleInstanceLock: () => singleInstance,
    whenReady: () => readyPromise,
    setActivationPolicy: (policy) => appCalls.activationPolicy.push(policy),
    setAppUserModelId: (id) => appCalls.appUserModelId.push(id),
    setLoginItemSettings: (settings) => {
      appCalls.loginItem.push(settings);
      loginOpen = settings.openAtLogin === true;
    },
    getLoginItemSettings: () => ({ openAtLogin: loginOpen }),
    relaunch: () => {
      appCalls.relaunches += 1;
    },
    exit: (code) => appCalls.exits.push(code),
    focus: () => {},
    quit: () => {
      appCalls.quitRequests += 1;
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      app.emit('before-quit', event);
      if (!event.defaultPrevented) {
        world.quit = true;
        app.emit('will-quit', {});
        app.emit('quit', {}, 0);
      }
    },
  });

  // ---- windows: the real fake window class, plus what bootstrap needs on top ----
  class BootWindow extends base.BrowserWindow {
    constructor(windowOptions) {
      super(windowOptions);
      order.push('window');
    }

    loadFile(file, fileOptions) {
      order.push(`load:${path.basename(String(file))}`);
      const loading = super.loadFile(file, fileOptions);
      if (autoReadyToShow && String(file).endsWith('loading.html')) setImmediate(() => this.emit('ready-to-show'));
      return loading;
    }

    loadURL(url) {
      order.push('loadURL');
      return super.loadURL(url);
    }

    showInactive() {
      this.calls.push('showInactive');
      this.visible = true;
    }

    static fromWebContents(contents) {
      return base.windows.find((window) => window.webContents === contents) || null;
    }

    static getAllWindows() {
      return base.windows.filter((window) => !window.destroyed);
    }
  }

  // ---- ipcMain ----
  const listeners = new Map();
  const handlers = new Map();
  const ipcMain = {
    on(channel, listener) {
      order.push(`ipc:on:${channel}`);
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
      return ipcMain;
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return ipcMain;
    },
    handle(channel, handler) {
      order.push(`ipc:handle:${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const ipc = {
    listeners,
    handlers,
    /** `ipcRenderer.send`: delivers to every listener and waits for the work they start. */
    async send(channel, event, ...args) {
      for (const listener of listeners.get(channel) || []) listener(event, ...args);
      for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    /** `ipcRenderer.sendSync`: the value the handler left in `returnValue` (undefined when it left none). */
    sendSync(channel, event) {
      const carrier = { ...event, returnValue: undefined };
      for (const listener of listeners.get(channel) || []) listener(carrier);
      return carrier.returnValue;
    },
    /** `ipcRenderer.invoke`. */
    async invoke(channel, event, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler(event, ...args);
    },
  };

  // ---- the rest of electron ----
  const shell = { opened: [], paths: [], openExternal: async (url) => shell.opened.push(url), openPath: async (target) => { shell.paths.push(target); return ''; } };
  const clipboard = { writes: [], writeText: (text) => clipboard.writes.push(text) };
  const powerSaveBlocker = { started: [], stopped: [], start: (type) => { powerSaveBlocker.started.push(type); return powerSaveBlocker.started.length; }, stop: (id) => powerSaveBlocker.stopped.push(id) };
  const defaultSession = {
    preconnects: [],
    errorListener: null,
    permissionHandlers: [],
    preconnect: (preconnectOptions) => {
      order.push('preconnect');
      defaultSession.preconnects.push(preconnectOptions);
    },
    setPermissionRequestHandler: (handler) => defaultSession.permissionHandlers.push(handler),
    setPermissionCheckHandler: (handler) => defaultSession.permissionHandlers.push(handler),
    webRequest: { onErrorOccurred: (listener) => { defaultSession.errorListener = listener; } },
  };
  const Menu = { template: null, applications: [], buildFromTemplate: (template) => ({ template }), setApplicationMenu: (menu) => { Menu.applications.push(menu); } };

  const electron = {
    app,
    BrowserWindow: BootWindow,
    ipcMain,
    dialog,
    shell,
    clipboard,
    powerSaveBlocker,
    session: { defaultSession },
    net,
    Menu,
    screen: base.screen,
    nativeTheme: base.nativeTheme,
    Notification: notification,
  };

  // ---- the settings store, counted ----
  const RealStore = store.Store;
  class RecordingStore extends RealStore {
    constructor(storeOptions) {
      super(storeOptions);
      order.push('store');
    }
  }

  // ---- printers and the updater ----
  const rawPrinter = {
    jobs: [],
    disposed: 0,
    failWith: null,
    async printRaw(job) {
      rawPrinter.jobs.push({ target: job.target, bytes: Buffer.from(job.data), label: job.label, ext: job.ext });
      if (rawPrinter.failWith) throw rawPrinter.failWith;
      return { ok: true };
    },
    dispose() {
      rawPrinter.disposed += 1;
    },
  };
  const dymo = {
    prints: [],
    disposed: 0,
    result: { ok: true },
    printers: [{ name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true }],
    async print(payload) {
      dymo.prints.push(payload);
      return dymo.result;
    },
    async listPrinters() {
      return { printers: dymo.printers };
    },
    dispose() {
      dymo.disposed += 1;
    },
  };
  const autoUpdater = Object.assign(new EventEmitter(), {
    loads: 0,
    checks: 0,
    quitCalls: [],
    setFeedURL() {},
    quitAndInstall: (...args) => autoUpdater.quitCalls.push(args),
    downloadUpdate: async () => [],
    checkForUpdates: async () => {
      autoUpdater.checks += 1;
      return { isUpdateAvailable: false, updateInfo: { version: '2.0.0' } };
    },
  });
  const resourcesPath = path.join(store.dir, 'resources');
  if (feed) {
    require('node:fs').mkdirSync(resourcesPath, { recursive: true });
    require('node:fs').writeFileSync(path.join(resourcesPath, 'app-update.yml'), 'provider: generic\nurl: https://updates.example.com/gadgetspos-desktop/\n');
  }
  const proc = Object.assign(new EventEmitter(), {
    resourcesPath,
    arch: 'x64',
    versions: { electron: '32.3.3', chrome: '128.0.6613.186', node: '20.18.1' },
  });

  const overrides = {
    electron,
    platform,
    argv,
    env,
    isPackaged: packaged,
    userDataPath: store.dir,
    // `monotonic` follows the manual clock, so a test that advances it ends a password lock; a test that moves only `now` (the wall clock) does not.
    clock: { now: clock.now, monotonic: clock.now, uptimeMs: () => 0, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    testMode,
    Store: RecordingStore,
    log,
    rawPrinter,
    dymo,
    getPrintersAsync: async () => systemPrinters,
    process: proc,
    osRelease: '10.0.19045',
    ...options.overrides,
  };
  if (withUpdater) {
    overrides.loadAutoUpdater = () => {
      autoUpdater.loads += 1;
      return autoUpdater;
    };
  }

  const world = {
    electron, overrides, app, appCalls, order, clock, log, dialog, shell, clipboard, powerSaveBlocker, defaultSession, Menu, net, notification,
    rawPrinter, dymo, autoUpdater, store, ipc, windows: base.windows, proc, quit: false,
    handle: null,
    ready,
    /** Runs the real bootstrap. */
    async boot() {
      world.handle = await bootstrap(overrides);
      return world.handle;
    },
    /** The POS page finishing its load in the main window (the real events the window code listens to). */
    async loadPos() {
      const contents = world.mainWindow().webContents;
      contents.emit('dom-ready');
      contents.emit('did-finish-load');
      await world.settle();
    },
    /** The main window (null before it exists). */
    mainWindow: () => (world.handle && world.handle.controller() ? world.handle.controller().window : null),
    services: () => world.handle.services,
    /** Events from the senders that matter (the windows must exist for the local ones). */
    events: {
      pos: (origin = POS_ORIGIN) => pageEvent({ contents: world.mainWindow().webContents, origin, url: `${origin}/vendor/point-of-sale` }),
      foreign: () => pageEvent({ contents: world.mainWindow().webContents, origin: 'https://evil.example.com' }),
      subFrame: () => {
        const parent = { origin: POS_ORIGIN, url: `${POS_ORIGIN}/`, parent: null };
        const contents = world.mainWindow().webContents;
        contents.mainFrame = parent;
        return { sender: contents, senderFrame: { origin: POS_ORIGIN, url: `${POS_ORIGIN}/embedded`, parent } };
      },
      offline: () => localEvent(world.mainWindow().webContents, 'offline.html'),
      settings: () => localEvent(world.services().settingsWindow.getWindow().webContents, 'settings.html'),
      password: () => localEvent(world.services().passwordWindow.getWindow().webContents, 'password.html'),
      /** A page in a window the POS page opened: a webContents of its own, registered with no desktop area. */
      popup: () => {
        const popup = new BootWindow({ width: 400, height: 300 });
        return pageEvent({ contents: popup.webContents, origin: POS_ORIGIN });
      },
    },
    /** Lets promises and the immediate-callbacks of the fakes run. */
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    cleanup() {
      store.cleanup();
    },
  };
  return world;
}

module.exports = { createBootWorld, pageEvent, localEvent, POS_ORIGIN, RENDERER_DIR };
