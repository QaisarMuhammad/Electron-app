'use strict';

/**
 * Electron main script of the DESKTOP-NATIVE verification (SPEC 18b S1-S3, R1-R4, D1-D6, L3).
 * tests/verify/desktop-native/run-native.js starts it like this, one Electron process at a time:
 *
 *   Electron --remote-debugging-port=<port> --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" launch-native.js [--disable-gpu]
 *
 * It calls the REAL `bootstrap()` of src/main/index.js, with the real Electron, the real settings store, the real log, the real
 * windows and preloads. It differs from tests/e2e/launch-app.js on purpose: whatever the verification is about stays REAL, and
 * only what would touch the machine is a fake.
 *
 *   REAL   the application Menu (every template is built by Electron's own `Menu.buildFromTemplate`, so an invalid accelerator or
 *          role throws here), `powerSaveBlocker` (spied, delegating: `isStarted(id)` is Electron's own answer), the default session
 *          (`preconnect` spied, delegating, so the fake POS can count the real sockets), `net`, `nativeTheme`, `screen`, the
 *          DYMO helper window and its service (the real default factory: nothing is passed as `overrides.dymo`), the real raw
 *          printer with the real print queue (only `execFile` is a fake that can hang), electron-log, electron-store,
 *          and, with GPOS_V_FEED=1, the real `electron-updater` module.
 *   FAKE   a context-menu POPUP (recorded, never shown: the template is still built by the real Menu), `app.setLoginItemSettings`,
 *          `app.relaunch`, `dialog`, `shell`, `clipboard`, `Notification`; `setFullScreen` with GPOS_V_FULLSCREEN_SPY=1 (a real macOS
 *          full screen would move the developer's desktop to a new space).
 *
 * Instrumentation installed BEFORE anything of src/ is required:
 *   - `Module._load`            every first load of a module, with the time since the process started and how long it took
 *   - global timers             every live setTimeout/setInterval with its delay, ref state and the project frames that created it
 *   - `fs.readFileSync`         reads of flags.json and config.json, with `app.isReady()` at that moment
 *   - the `app` object          command-line switches, single-instance lock, login item, relaunch, quit, each with `app.isReady()`
 *   - `ipcMain`                 which channels were registered, and how many windows existed then
 *   - `BrowserWindow`           every window (options, show / showInactive / focus calls, closed)
 *
 * Environment (set by run-native.js):
 *   GPOS_V_USER_DATA, GPOS_V_EVENTS_FILE, GPOS_V_CONTROL_PORT     required
 *   GADGETSPOS_START_URL                                          the POS address (honoured only while the app is not packaged)
 *   GPOS_V_PACKAGED=1            start as an installed app
 *   GPOS_V_PLATFORM=<name>       the platform the app believes it runs on (win32 / linux); the host stays macOS
 *   GPOS_V_FEED=1                a resources folder with app-update.yml, so the (packaged) updater is enabled
 *   GPOS_V_FULLSCREEN_SPY=1      record `setFullScreen` instead of performing it
 *   GPOS_V_HANG_PRINT=1          `execFile` of the real raw printer never answers (a hung job)
 *   GPOS_V_PRINT_DELAY_MS=<ms>   ... or answers after this long (a slow job that does finish)
 *   GPOS_V_SPEC_LITERAL_THROTTLING=1   the POS window is created with webPreferences.backgroundThrottling:false (SPEC 18b R2 literally)
 *   GPOS_V_TMPDIR                temp folder for the print jobs
 *
 * Not named *.test.js: node --test must not run it.
 */

const realElectron = require('electron');

const { app } = realElectron;
if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');

const Module = require('node:module');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const cfg = {
  userData: process.env.GPOS_V_USER_DATA,
  eventsFile: process.env.GPOS_V_EVENTS_FILE,
  controlPort: Number(process.env.GPOS_V_CONTROL_PORT),
  startUrl: process.env.GADGETSPOS_START_URL || '',
  packaged: process.env.GPOS_V_PACKAGED === '1',
  platform: process.env.GPOS_V_PLATFORM || '',
  feed: process.env.GPOS_V_FEED === '1',
  fullScreenSpy: process.env.GPOS_V_FULLSCREEN_SPY === '1',
  hangPrint: process.env.GPOS_V_HANG_PRINT === '1',
  printDelayMs: Number(process.env.GPOS_V_PRINT_DELAY_MS) || 0,
  specLiteralThrottling: process.env.GPOS_V_SPEC_LITERAL_THROTTLING === '1',
  tmpDir: process.env.GPOS_V_TMPDIR || '',
};
for (const [name, value] of [['GPOS_V_USER_DATA', cfg.userData], ['GPOS_V_EVENTS_FILE', cfg.eventsFile], ['GPOS_V_CONTROL_PORT', cfg.controlPort]]) {
  if (!value) {
    process.stderr.write(`launch-native.js: ${name} is required\n`);
    process.exit(2);
  }
}
if (cfg.tmpDir) process.env.TMPDIR = cfg.tmpDir; // os.tmpdir() of the print jobs

/** Milliseconds since the process started: the scale of the app's own startup marks (src/main/perf.js). */
const upMs = () => Math.round(process.uptime() * 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shorten = (file) => String(file).replace(`${ROOT}${path.sep}`, '');

/** Appends one event to the events file synchronously, so it survives the quit that a scenario tests. */
function emit(type, data = {}) {
  const event = { type, t: upMs(), ...data };
  try {
    fs.appendFileSync(cfg.eventsFile, `${JSON.stringify(event)}\n`);
  } catch {
    // the events file is a convenience for the harness
  }
  return event;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Instrumentation 1: module loads
// ---------------------------------------------------------------------------------------------------------------------------

/** @type {Array<{ request: string, file: string, parent: string|null, at: number, ms: number }>} */
const moduleLoads = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  const first = resolved !== null && path.isAbsolute(resolved) && !Module._cache[resolved];
  const at = upMs();
  const started = process.hrtime.bigint();
  // eslint-disable-next-line prefer-rest-params
  const result = originalLoad.apply(this, arguments);
  if (first) {
    moduleLoads.push({
      request,
      file: shorten(resolved),
      parent: parent && parent.filename ? shorten(parent.filename) : null,
      at,
      ms: Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 10) / 10,
    });
  }
  return result;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Instrumentation 2: timers
// ---------------------------------------------------------------------------------------------------------------------------

const liveTimers = new Map();
const nativeSetTimeout = global.setTimeout;
const nativeSetInterval = global.setInterval;
const nativeClearTimeout = global.clearTimeout;
const nativeClearInterval = global.clearInterval;

/** The project frames of the code that created a timer (the harness's own frames are marked by their file name). */
function callerFrames() {
  // The first lines are "Error", callerFrames, trackTimer and the patched global: the caller starts at the fifth line.
  return String(new Error().stack)
    .split('\n')
    .slice(4)
    .filter((line) => line.includes(ROOT))
    .map((line) => line.trim().replace(`${ROOT}${path.sep}`, '').replace(/^at /, ''))
    .slice(0, 4);
}

function trackTimer(kind, create, args) {
  const [callback, delay, ...rest] = args;
  const entry = { kind, delay: Number(delay) || 0, createdAt: upMs(), frames: callerFrames(), handle: null };
  const wrapped = typeof callback === 'function'
    ? function wrappedTimer(...callbackArgs) {
      if (kind === 'timeout') liveTimers.delete(entry.handle);
      return callback.apply(this, callbackArgs);
    }
    : callback;
  entry.handle = create(wrapped, delay, ...rest);
  liveTimers.set(entry.handle, entry);
  return entry.handle;
}

function copySymbols(patched, native) {
  for (const symbol of Object.getOwnPropertySymbols(native)) patched[symbol] = native[symbol];
  return patched;
}

global.setTimeout = copySymbols(function patchedSetTimeout(...args) { return trackTimer('timeout', nativeSetTimeout, args); }, nativeSetTimeout);
global.setInterval = copySymbols(function patchedSetInterval(...args) { return trackTimer('interval', nativeSetInterval, args); }, nativeSetInterval);
global.clearTimeout = function patchedClearTimeout(handle) {
  liveTimers.delete(handle);
  return nativeClearTimeout(handle);
};
global.clearInterval = function patchedClearInterval(handle) {
  liveTimers.delete(handle);
  return nativeClearInterval(handle);
};

/** Timers that are alive now. `app` = created by project code (not by this harness), `external` = no project frame at all. */
function describeTimers() {
  return [...liveTimers.values()].map((entry) => {
    const harness = entry.frames.some((frame) => frame.startsWith(`tests${path.sep}verify${path.sep}desktop-native${path.sep}launch-native.js`));
    const origin = harness ? 'harness' : entry.frames.length > 0 ? 'app' : 'external';
    let hasRef = null;
    try {
      hasRef = typeof entry.handle.hasRef === 'function' ? entry.handle.hasRef() : null;
    } catch {
      hasRef = null;
    }
    return { kind: entry.kind, delay: entry.delay, hasRef, ageMs: upMs() - entry.createdAt, origin, frames: entry.frames };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Instrumentation 3: file reads, the app object, ipcMain
// ---------------------------------------------------------------------------------------------------------------------------

const rec = {
  reads: [],
  switches: [],
  appCalls: [],
  ipcRegistrations: [],
  windows: [],
  windowsCreated: 0,
  preconnects: [],
  power: [],
  login: { open: false, calls: [] },
  relaunches: [],
  fullScreen: [],
  dialogs: [],
  notices: [],
  openExternal: [],
  openPath: [],
  clipboard: [],
  popups: [],
  menusBuilt: 0,
  contextParams: [],
  copyImage: [],
  inspect: [],
  downloads: [],
  uncaught: [],
  printer: { jobs: 0 },
};
let appMenu = null;

const realReadFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(file, ...rest) {
  if (typeof file === 'string' && /[\\/](flags|config)\.json$/.test(file)) {
    rec.reads.push({ file: path.basename(file), at: upMs(), ready: app.isReady() });
  }
  return realReadFileSync.call(this, file, ...rest);
};

process.on('uncaughtException', (error) => {
  rec.uncaught.push(String((error && error.stack) || error));
  emit('uncaught', { message: String((error && error.message) || error) });
});
process.on('unhandledRejection', (reason) => {
  rec.uncaught.push(String((reason && reason.stack) || reason));
  emit('unhandled-rejection', { message: String((reason && reason.message) || reason) });
});

const appPackage = require(path.join(ROOT, 'package.json'));

const fakeApp = new Proxy(app, {
  get(target, property) {
    if (property === 'getVersion') return () => appPackage.version;
    if (property === 'getName') return () => appPackage.productName || appPackage.name;
    if (property === 'commandLine') {
      return {
        appendSwitch: (name, value) => {
          rec.switches.push({ name, value: value === undefined ? null : String(value), ready: app.isReady(), at: upMs() });
          return target.commandLine.appendSwitch(name, value);
        },
        hasSwitch: (name) => target.commandLine.hasSwitch(name),
        getSwitchValue: (name) => target.commandLine.getSwitchValue(name),
      };
    }
    if (property === 'disableHardwareAcceleration') {
      return () => {
        rec.appCalls.push({ call: 'disableHardwareAcceleration', ready: app.isReady(), at: upMs() });
        return target.disableHardwareAcceleration();
      };
    }
    if (property === 'requestSingleInstanceLock') {
      return (...args) => {
        rec.appCalls.push({ call: 'requestSingleInstanceLock', ready: app.isReady(), at: upMs() });
        return target.requestSingleInstanceLock(...args);
      };
    }
    if (property === 'setLoginItemSettings') {
      return (settings) => {
        rec.login.calls.push({ ...settings, at: upMs() });
        rec.login.open = Boolean(settings && settings.openAtLogin);
        emit('login-item', { openAtLogin: rec.login.open });
      };
    }
    if (property === 'getLoginItemSettings') return () => ({ openAtLogin: rec.login.open });
    if (property === 'relaunch') {
      return (options) => {
        rec.relaunches.push({ at: upMs(), options: options || null });
        emit('relaunch');
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const ipcMainSpy = new Proxy(realElectron.ipcMain, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'on' || property === 'handle' || property === 'once') {
      return (channel, ...rest) => {
        rec.ipcRegistrations.push({ kind: String(property), channel: String(channel), at: upMs(), ready: app.isReady(), windows: rec.windowsCreated });
        return value.call(target, channel, ...rest);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// ---------------------------------------------------------------------------------------------------------------------------
// The windows: every one is recorded; never takes focus
// ---------------------------------------------------------------------------------------------------------------------------

class RecordingWindow extends realElectron.BrowserWindow {
  constructor(options = {}) {
    const next = { ...options, webPreferences: options.webPreferences ? { ...options.webPreferences } : options.webPreferences };
    const isPos = Boolean(next.webPreferences && /[\\/]preload[\\/]app\.js$/.test(String(next.webPreferences.preload || '')));
    if (cfg.specLiteralThrottling && isPos) next.webPreferences.backgroundThrottling = false;
    super(next);
    rec.windowsCreated += 1;
    const meta = {
      id: this.id,
      createdAt: upMs(),
      preload: next.webPreferences && next.webPreferences.preload ? path.basename(next.webPreferences.preload) : null,
      devTools: next.webPreferences ? next.webPreferences.devTools : undefined,
      parent: Boolean(next.parent),
      modal: Boolean(next.modal),
      options: Object.fromEntries(['spellcheck', 'v8CacheOptions', 'backgroundThrottling', 'devTools', 'sandbox', 'contextIsolation', 'nodeIntegration', 'webSecurity', 'allowRunningInsecureContent', 'webviewTag'].map((key) => [key, next.webPreferences ? next.webPreferences[key] : undefined])),
      shows: 0,
      showInactives: 0,
      focuses: 0,
      closedAt: null,
      url: '',
    };
    rec.windows.push(meta);
    this.__meta = meta;
    this.webContents.on('did-finish-load', () => {
      try {
        meta.url = this.webContents.getURL();
      } catch {
        // gone
      }
    });
    this.on('close', () => {
      try {
        meta.url = this.webContents.getURL() || meta.url;
      } catch {
        // gone
      }
    });
    this.once('closed', () => {
      meta.closedAt = upMs();
      emit('window-closed', { id: meta.id, url: meta.url, preload: meta.preload });
    });
    emit('window-created', { id: meta.id, preload: meta.preload, devTools: meta.devTools, parent: meta.parent, modal: meta.modal });
  }

  show() {
    this.__meta.shows += 1;
    return super.show();
  }

  showInactive() {
    this.__meta.showInactives += 1;
    return super.showInactive();
  }

  focus() {
    this.__meta.focuses += 1;
    return super.focus();
  }

  setFullScreen(flag) {
    if (!cfg.fullScreenSpy) return super.setFullScreen(flag);
    this.spyFullScreen = Boolean(flag);
    rec.fullScreen.push({ flag: Boolean(flag), at: upMs() });
    emit('set-full-screen', { flag: Boolean(flag) });
    this.emit(flag ? 'enter-full-screen' : 'leave-full-screen');
    return undefined;
  }

  isFullScreen() {
    return cfg.fullScreenSpy ? this.spyFullScreen === true : super.isFullScreen();
  }
}
// Electron's fromWebContents / getAllWindows only recognise a class called "BrowserWindow" (see src/main/platform.js).
Object.defineProperty(RecordingWindow, 'name', { value: 'BrowserWindow' });

// ---------------------------------------------------------------------------------------------------------------------------
// The other objects the app is given
// ---------------------------------------------------------------------------------------------------------------------------

const RealMenu = realElectron.Menu;

/** Builds the REAL menu (an invalid template throws), and remembers the template. A popup is recorded and never shown. */
class RecordingMenu {
  constructor(template) {
    this.template = template;
    this.real = RealMenu.buildFromTemplate(template);
  }

  static buildFromTemplate(template) {
    rec.menusBuilt += 1;
    return new RecordingMenu(template);
  }

  static setApplicationMenu(menu) {
    appMenu = menu;
    RealMenu.setApplicationMenu(menu.real);
    emit('application-menu', { top: menu.real.items.map((item) => item.label) });
  }

  static getApplicationMenu() {
    return RealMenu.getApplicationMenu();
  }

  popup(options) {
    rec.popups.push({ at: upMs(), real: this.real, template: this.template, hasWindow: Boolean(options && options.window) });
    emit('popup', { labels: this.real.items.map((item) => item.label || item.type) });
  }
}

/** Answers a native box wants to give other than its cancel button: `{ match: RegExp source of the message, response: index }`. */
const dialogRules = [];

/** A native box: recorded and answered with its cancel button ("Later", "Stay", "OK"), unless a rule says otherwise. */
function answerBox(first, second) {
  const options = second === undefined ? first : second;
  const box = options && typeof options === 'object' ? options : {};
  const rule = dialogRules.find((entry) => new RegExp(entry.match).test(String(box.message || '')));
  const response = rule ? rule.response : Number.isInteger(box.cancelId) ? box.cancelId : 0;
  rec.dialogs.push({ type: box.type || '', title: box.title || '', message: box.message || '', detail: box.detail || '', buttons: Array.isArray(box.buttons) ? box.buttons : [], response, at: upMs() });
  emit('dialog', { message: box.message || '', buttons: box.buttons || [] });
  return response;
}
const fakeDialog = {
  showMessageBox: async (first, second) => ({ response: answerBox(first, second), checkboxChecked: false }),
  showMessageBoxSync: (first, second) => answerBox(first, second),
  showErrorBox: (title, content) => {
    rec.dialogs.push({ type: 'error-box', title: String(title), message: String(content), detail: '', buttons: [], response: 0, at: upMs() });
    emit('dialog', { message: String(title), buttons: [] });
  },
};

/** Real `powerSaveBlocker`, spied: every start and stop is recorded, and Electron itself answers `isStarted`. */
const spyPower = {
  start(type) {
    const id = realElectron.powerSaveBlocker.start(type);
    rec.power.push({ op: 'start', type, id, at: upMs() });
    emit('power', { op: 'start', type, id });
    return id;
  },
  stop(id) {
    realElectron.powerSaveBlocker.stop(id);
    rec.power.push({ op: 'stop', id, at: upMs() });
    emit('power', { op: 'stop', id });
  },
  isStarted: (id) => realElectron.powerSaveBlocker.isStarted(id),
};

/** The default session with `preconnect` spied (and delegating, so the sockets are really opened). */
let wrappedDefaultSession = null;
function defaultSessionSpy() {
  if (wrappedDefaultSession) return wrappedDefaultSession;
  const real = realElectron.session.defaultSession;
  wrappedDefaultSession = new Proxy(real, {
    get(target, property) {
      if (property === 'preconnect') {
        return (options) => {
          rec.preconnects.push({ url: options && options.url, numSockets: options && options.numSockets, at: upMs() });
          emit('preconnect', { url: options && options.url, numSockets: options && options.numSockets });
          return target.preconnect(options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrappedDefaultSession;
}
const sessionSpy = new Proxy(realElectron.session, {
  get(target, property) {
    if (property === 'defaultSession') return defaultSessionSpy();
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const fakeShell = {
  openExternal: async (url) => {
    rec.openExternal.push({ url: String(url), at: upMs() });
    emit('open-external', { url: String(url) });
  },
  openPath: async (target) => {
    rec.openPath.push(String(target));
    return '';
  },
};
const fakeClipboard = {
  writeText: (text) => {
    rec.clipboard.push(String(text));
    emit('clipboard', { text: String(text).slice(0, 80) });
  },
};
class FakeNotification {
  constructor(options) {
    this.options = options || {};
  }

  show() {
    rec.notices.push({ title: this.options.title || '', body: this.options.body || '', at: upMs() });
  }

  static isSupported() {
    return true;
  }
}

const electronForApp = Object.create(realElectron, {
  app: { value: fakeApp, enumerable: true },
  BrowserWindow: { value: RecordingWindow, enumerable: true },
  ipcMain: { value: ipcMainSpy, enumerable: true },
  session: { value: sessionSpy, enumerable: true },
  powerSaveBlocker: { value: spyPower, enumerable: true },
  shell: { value: fakeShell, enumerable: true },
  clipboard: { value: fakeClipboard, enumerable: true },
  Notification: { value: FakeNotification, enumerable: true },
  Menu: { value: RecordingMenu, enumerable: true },
  dialog: { value: fakeDialog, enumerable: true },
});

// What the web contents do on a right click: the REAL params are recorded, and the actions that would touch the clipboard or open
// the developer tools are recorded instead of run (the app calls them on the instance, at click time).
app.on('web-contents-created', (_event, contents) => {
  contents.on('context-menu', (_e, params) => {
    rec.contextParams.push({
      at: upMs(),
      isEditable: params.isEditable,
      selectionText: String(params.selectionText || '').slice(0, 60),
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      hasImageContents: params.hasImageContents,
      editFlags: params.editFlags,
      x: params.x,
      y: params.y,
      inputFieldType: params.inputFieldType,
      spellcheckEnabled: params.spellcheckEnabled,
    });
  });
  contents.copyImageAt = (x, y) => {
    rec.copyImage.push({ x, y });
    emit('copy-image-at', { x, y });
  };
  contents.inspectElement = (x, y) => {
    rec.inspect.push({ x, y });
    emit('inspect-element', { x, y });
  };
});
app.whenReady().then(() => {
  realElectron.session.defaultSession.on('will-download', (_event, item) => {
    rec.downloads.push({ url: item.getURL(), at: upMs() });
    emit('will-download', { url: item.getURL().slice(0, 100) });
    item.cancel();
  });
});

app.on('before-quit', () => emit('before-quit'));
app.on('will-quit', () => emit('will-quit'));
app.on('quit', () => emit('quit'));
app.on('second-instance', () => emit('second-instance'));
app.on('window-all-closed', () => emit('window-all-closed'));

// ---------------------------------------------------------------------------------------------------------------------------
// The printer side: the real raw printer and print queue, with an execFile that can hang
// ---------------------------------------------------------------------------------------------------------------------------

const SYSTEM_PRINTERS = Object.freeze([
  { name: 'V-Receipt-58', displayName: 'V Receipt Printer', description: 'Thermal receipt printer', status: 3, isDefault: true, options: {} },
]);

/** `execFile` that never answers: the `lp` job is hung until its signal aborts. */
function hungExecFile(file, args, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  rec.printer.jobs += 1;
  emit('hung-exec', { file: path.basename(String(file)), job: rec.printer.jobs });
  const child = new EventEmitter();
  child.pid = 0;
  child.kill = () => true;
  if (cfg.printDelayMs > 0) {
    setTimeout(() => {
      emit('slow-exec-done', { job: rec.printer.jobs });
      done(null, '', '');
    }, cfg.printDelayMs);
  } else if (signal) {
    signal.addEventListener('abort', () => {
      emit('hung-exec-aborted');
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      done(error, '', '');
    });
  }
  return child;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The control server
// ---------------------------------------------------------------------------------------------------------------------------

/** @type {null|Awaited<ReturnType<typeof import('../../../src/main/index').bootstrap>>} */
let handle = null;

const mainWindow = () => {
  const controller = handle && handle.controller();
  return controller && !controller.window.isDestroyed() ? controller.window : null;
};

/** The parts of the real webPreferences a window was created with. */
function webPreferencesOf(win) {
  if (typeof win.webContents.getLastWebPreferences !== 'function') return { unavailable: true };
  const prefs = win.webContents.getLastWebPreferences();
  const pick = {};
  for (const key of ['spellcheck', 'v8CacheOptions', 'backgroundThrottling', 'contextIsolation', 'sandbox', 'nodeIntegration', 'webSecurity', 'devTools', 'webviewTag']) pick[key] = prefs[key];
  pick.preload = prefs.preload ? path.basename(prefs.preload) : null;
  return pick;
}

function describeWindow(win) {
  if (!win || win.isDestroyed()) return null;
  return {
    id: win.id,
    title: win.getTitle(),
    url: win.webContents.getURL(),
    bounds: win.getBounds(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    zoomLevel: win.webContents.getZoomLevel(),
    backgroundThrottling: win.webContents.backgroundThrottling,
    webPreferences: webPreferencesOf(win),
    meta: win.__meta ? { shows: win.__meta.shows, showInactives: win.__meta.showInactives, focuses: win.__meta.focuses, preload: win.__meta.preload, createdAt: win.__meta.createdAt } : null,
  };
}

/** The menu fields a test can read; submenus included. */
function summarizeMenu(menu) {
  return menu.items.map((item) => ({
    id: item.id || null,
    label: item.label,
    role: item.role || null,
    type: item.type,
    accelerator: item.accelerator ? String(item.accelerator) : null,
    visible: item.visible,
    enabled: item.enabled,
    checked: item.type === 'checkbox' || item.type === 'radio' ? item.checked : undefined,
    submenu: item.submenu ? summarizeMenu(item.submenu) : undefined,
  }));
}

function findItem(items, test) {
  for (const item of items) {
    if (test(item)) return item;
    if (item.submenu) {
      const inner = findItem(item.submenu.items, test);
      if (inner) return inner;
    }
  }
  return null;
}

const popupsSince = (since) => rec.popups.slice(since).map((popup) => ({ at: popup.at, hasWindow: popup.hasWindow, items: summarizeMenu(popup.real) }));

function snapshot() {
  const windows = realElectron.BrowserWindow.getAllWindows();
  return {
    pid: process.pid,
    startEpoch: Date.now() - upMs(),
    ready: handle !== null,
    packaged: cfg.packaged,
    marks: handle ? handle.perf.marks() : {},
    windowCount: windows.length,
    webContentsCount: realElectron.webContents.getAllWebContents().length,
    windows: windows.map(describeWindow).filter(Boolean),
    createdWindows: rec.windows.map((meta) => ({ ...meta })),
    reads: rec.reads.slice(),
    switches: rec.switches.slice(),
    appCalls: rec.appCalls.slice(),
    ipcRegistrations: rec.ipcRegistrations.slice(),
    preconnects: rec.preconnects.slice(),
    power: rec.power.slice(),
    login: { open: rec.login.open, calls: rec.login.calls.slice() },
    relaunches: rec.relaunches.slice(),
    fullScreen: rec.fullScreen.slice(),
    dialogs: rec.dialogs.slice(),
    notices: rec.notices.slice(),
    openExternal: rec.openExternal.slice(),
    clipboard: rec.clipboard.slice(),
    contextParams: rec.contextParams.slice(),
    copyImage: rec.copyImage.slice(),
    inspect: rec.inspect.slice(),
    downloads: rec.downloads.slice(),
    popups: rec.popups.length,
    menusBuilt: rec.menusBuilt,
    printerJobs: rec.printer.jobs,
    uncaught: rec.uncaught.slice(),
    nativeTheme: { themeSource: realElectron.nativeTheme.themeSource, dark: realElectron.nativeTheme.shouldUseDarkColors },
  };
}

const commands = {
  state: () => snapshot(),

  moduleLoads: () => moduleLoads.slice(),

  timers: () => ({
    timers: describeTimers(),
    resources: typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [],
  }),

  /** CPU of every Electron process as Chromium reports it (percent of one core since the last call). */
  appMetrics: () => app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu.percentCPUUsage, wakeups: metric.cpu.idleWakeupsPerSecond, memoryKB: metric.memory.workingSetSize })),

  cpuUsage: () => process.cpuUsage(),

  config: () => handle.services.config.publicState(),

  menu: () => (appMenu ? summarizeMenu(appMenu.real) : []),

  /** From now on a native box whose message matches answers with this button index. */
  answerDialog: ({ match, response } = {}) => {
    dialogRules.push({ match: String(match), response: Number(response) });
    return dialogRules.length;
  },

  /** "Clicks" an item of the REAL application menu by id: a checkbox toggles itself first, as Electron does. */
  menuClick: ({ id } = {}) => {
    if (!appMenu) throw new Error('the application menu is not installed yet');
    const item = appMenu.real.getMenuItemById(id);
    if (!item) throw new Error(`no menu item has the id ${id}`);
    item.click({}, mainWindow() || undefined, mainWindow() ? mainWindow().webContents : undefined);
    return { clicked: true, label: item.label, checked: item.checked };
  },

  /** Builds the menu template of another platform with the REAL Menu: an invalid accelerator or role throws. */
  buildRealMenu: ({ platform, isDev = false, compatibilityMode = false } = {}) => {
    const { buildMenuTemplate, REQUIRED_HANDLERS } = require('../../../src/main/windows/menu');
    const calls = [];
    const handlers = Object.fromEntries([...REQUIRED_HANDLERS, 'toggleDevTools'].map((name) => [name, (...args) => calls.push([name, ...args])]));
    const menu = RealMenu.buildFromTemplate(buildMenuTemplate({ platform, isDev, handlers, compatibilityMode }));
    return { top: summarizeMenu(menu), calls };
  },

  /** A real right click: Chromium works out the parameters itself. Answers the popups that appeared. */
  rightClick: async ({ x, y } = {}) => {
    const before = rec.popups.length;
    const beforeParams = rec.contextParams.length;
    const win = mainWindow();
    if (!win) throw new Error('the POS window is not open');
    const contents = win.webContents;
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    for (let waited = 0; waited < 2500 && rec.contextParams.length === beforeParams; waited += 50) await sleep(50);
    await sleep(150);
    return { popups: popupsSince(before), params: rec.contextParams.slice(beforeParams) };
  },

  /** Clicks an item of a popup by its label; a role item (it would touch the system clipboard) is refused. */
  popupClick: ({ index = rec.popups.length - 1, label } = {}) => {
    const popup = rec.popups[index];
    if (!popup) throw new Error(`there is no popup number ${index}`);
    const item = findItem(popup.real.items, (entry) => entry.label === label);
    if (!item) throw new Error(`no item is labelled ${label}`);
    if (item.role) throw new Error(`"${label}" is a role item: not clicked here (it would use the real clipboard)`);
    item.click({}, mainWindow() || undefined, mainWindow() ? mainWindow().webContents : undefined);
    return { clicked: true };
  },

  /** Kills the renderer process of the POS window, as a crash does. */
  crashMain: () => {
    mainWindow().webContents.forcefullyCrashRenderer();
    return true;
  },

  minimizeMain: () => {
    mainWindow().minimize();
    return true;
  },

  /** Emits an event on the real `app`, as Chromium would (a crashed GPU process, `activate` ...). */
  emitApp: ({ event, details } = {}) => {
    app.emit(event, {}, details);
    return true;
  },

  /** Closes the POS window the way the user does (the close button). */
  closeMain: () => {
    mainWindow().close();
    return true;
  },

  quit: () => {
    emit('quit-requested');
    setImmediate(() => app.quit());
    return true;
  },

  gpu: () => ({ status: app.getGPUFeatureStatus(), switches: { 'disk-cache-size': app.commandLine.getSwitchValue('disk-cache-size'), 'disable-gpu': app.commandLine.hasSwitch('disable-gpu'), 'ignore-gpu-blocklist': app.commandLine.hasSwitch('ignore-gpu-blocklist'), 'disable-brotli': app.commandLine.hasSwitch('disable-brotli'), 'disable-features': app.commandLine.getSwitchValue('disable-features') } }),

  /** What `webContents.capturePage()` sees of the POS window (an unpainted window answers nothing in time). */
  capture: async ({ timeoutMs = 5000 } = {}) => {
    const win = mainWindow();
    const started = Date.now();
    const image = await Promise.race([win.webContents.capturePage(), sleep(timeoutMs).then(() => null)]);
    if (!image) return { ok: false, ms: Date.now() - started };
    const size = image.getSize();
    return { ok: true, width: size.width, height: size.height, ms: Date.now() - started };
  },

  /** Runs a script in the POS window's page from the main process. */
  evalIn: ({ code } = {}) => mainWindow().webContents.executeJavaScript(String(code), true),

  /** Writes lines through the app's own electron-log instance (the same module instance), to test rotation. */
  writeLog: ({ lines = 1, bytes = 1000 } = {}) => {
    const electronLog = require('electron-log');
    const filler = 'x'.repeat(bytes);
    // A development build mirrors the log to the console: keep 17 MB of filler out of the harness's output.
    const consoleLevel = electronLog.transports.console.level;
    electronLog.transports.console.level = false;
    try {
      for (let i = 0; i < lines; i += 1) electronLog.info(`rotation line ${i} ${filler}`);
    } finally {
      electronLog.transports.console.level = consoleLevel;
    }
    return true;
  },

  listDir: ({ dir } = {}) => fs.readdirSync(dir).map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size })),

  /** The raw printer queue: how many jobs the app's own queue holds under a key. */
  queueSize: ({ key } = {}) => handle.services.queue.size(key),

  /** Anything else: a script run in the main process with `{ electron, app, handle, rec }` (a test harness, not the product). */
  evalMain: async ({ code } = {}) => {
    // eslint-disable-next-line no-new-func
    const run = new Function('ctx', `return (async () => { ${String(code)} })();`);
    return run({ electron: realElectron, app, handle, rec, upMs });
  },
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function startControlServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && target.pathname === '/health') {
        reply(response, 200, { ok: true, ready: handle !== null, pid: process.pid });
        return;
      }
      if (request.method === 'POST' && target.pathname === '/cmd') {
        const { name, args } = JSON.parse(await readBody(request));
        if (!Object.hasOwn(commands, name)) {
          reply(response, 404, { ok: false, error: `unknown command ${name}` });
          return;
        }
        reply(response, 200, { ok: true, value: await commands[name](args || {}) });
        return;
      }
      reply(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      reply(response, 500, { ok: false, error: String((error && error.message) || error), stack: String((error && error.stack) || '') });
    }
  });
  server.listen(cfg.controlPort, '127.0.0.1');
  server.unref();
  return server;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Start the app
// ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  // The app must put its own windows and dialogs on the SYSTEM theme (SPEC 18b D6): start from a different one to prove it does.
  realElectron.nativeTheme.themeSource = 'dark';
  const { bootstrap } = require('../../../src/main/index');
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const startOrigin = originOf(cfg.startUrl);

  let processOverride;
  if (cfg.feed) {
    // A resources folder with the feed file electron-builder would write: the packaged updater is then enabled.
    const resources = path.join(cfg.userData, '..', `resources-${process.pid}`);
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nurl: https://127.0.0.1:9/gadgetspos-desktop/\n');
    processOverride = new Proxy(process, {
      get(target, property) {
        if (property === 'resourcesPath') return resources;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const started = await bootstrap({
    electron: electronForApp,
    testMode: true,
    userDataPath: cfg.userData,
    isPackaged: cfg.packaged,
    ...(cfg.platform ? { platform: cfg.platform } : {}),
    env: { ...process.env, GADGETSPOS_START_URL: cfg.startUrl },
    devOrigins: startOrigin ? [startOrigin] : [],
    dialog: fakeDialog,
    getPrintersAsync: async () => SYSTEM_PRINTERS.map((printer) => ({ ...printer })),
    ...(processOverride ? { process: processOverride } : {}),
    ...(cfg.hangPrint || cfg.printDelayMs > 0 ? { execFile: hungExecFile } : {}),
  });
  if (started === null) {
    emit('second-instance-denied');
    return;
  }
  handle = started;
  startControlServer();
  emit('ready', { marks: handle.perf.marks() });
}

main().catch((error) => {
  emit('launch-failed', { message: String((error && error.stack) || error) });
  process.exitCode = 1;
  app.exit(1);
});
