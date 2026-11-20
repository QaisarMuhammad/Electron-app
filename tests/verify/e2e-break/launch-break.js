'use strict';

/**
 * RUNTIME-E2E LENS variant of tests/e2e/launch-app.js (a copy; the original is untouched). tests/verify/e2e-break/run-break.js starts it:
 *
 *   Electron --remote-debugging-port=<port> tests/verify/e2e-break/launch-break.js        (with the GPOS_E2E_* variables below)
 *
 * Differences from launch-app.js (everything else is identical):
 *   - GPOS_E2E_REAL_RAW=1  the app's REAL raw printer (src/main/printing/transports) runs, with the REAL print queue, REAL temp files
 *                          and the REAL posix `lp` transport, but with a FAKE `execFile` (mode `notfound` | `ok` | `hang`: `hang` starts a
 *                          real `sleep 300` that honours the abort signal, so a queue timeout really has to kill a process);
 *   - GPOS_E2E_REAL_DYMO=1  the app's REAL DYMO service and REAL hidden window (src/renderer/dymo-loader.html with the real DYMO Connect framework); with no
 *                          DYMO software on the machine every call fails the way it does in a shop without DYMO;
 *   - dialog rules         `dialogRules` answers a native box with a chosen button (the "page stopped responding" box: Wait or Reload);
 *   - more commands        closeMain, reloadMain, loadPos, retryNowMain, capturePng, captureWindow, openSettingsN, promptShow, queueSize,
 *                          memory, appMetrics, execLog, execMode, setConfig, tempFiles.
 *
 * Original header follows.
 *
 * The Electron main script of the smoke run (SPEC 17, 19.3). tests/e2e/run-smoke.js starts it like this:
 *
 *   Electron --remote-debugging-port=<port> tests/e2e/launch-app.js        (with the GPOS_E2E_* variables below)
 *
 * It calls the REAL `bootstrap()` of src/main/index.js with the real Electron, the real settings store, the real log, the real
 * windows and the real preloads, against the fake POS of tests/e2e/fake-pos.js. Only what would touch the machine is a fake:
 *
 *   - the raw printer       records every job (bytes, target, label), can fail with a chosen error code, can be slow. It queues
 *                           its jobs on the app's OWN print queue, exactly as the real transports do, so a slow job is really
 *                           "queued" when the app quits (SPEC 18b L3);
 *   - the DYMO service      the REAL service (plan, script, window manager, caches) around a fake hidden window with a fake DYMO
 *                           framework (tests/helpers/vm-dymo.js), so no DYMO software is needed;
 *   - the system printers   `getPrintersAsync` answers three printers;
 *   - native dialogs        `dialog` records every box and answers it with its cancel button ("Later", "Stay", "OK", "Yes");
 *   - the operating system  `app.setLoginItemSettings`, `app.relaunch`, `powerSaveBlocker`, `shell`, `clipboard`, `Notification`
 *                           and `Menu` (templates and popups are recorded, a menu item can be "clicked" by id) are fakes, so the run
 *                           never changes the machine, never relaunches itself and never shows a menu or a notice;
 *   - the clock             `now()` is the real time plus an offset that the harness can advance (the password lockout), and a
 *                           `GPOS_E2E_WARP_MS` timer fires after 200 ms (the 20 s "Does the screen look right?" question);
 *   - electron-updater      with GPOS_E2E_UPDATER=1 a stand-in `autoUpdater` (a check finds 2.0.1, downloads it in steps and says
 *                           it is ready) is loaded lazily, exactly where the app would `require('electron-updater')`.
 *
 * It never takes focus: `testMode` gives macOS the "accessory" activation policy and `showInactive()` for every window of the app,
 * and a window the POS page opens with window.open is created hidden (Electron would otherwise show it with `show()`, which
 * activates the app). A full-screen request can be recorded instead of performed (GPOS_E2E_FULLSCREEN_SPY), because a real macOS
 * full screen switches the developer's desktop to a new space.
 *
 * What the harness reads and does goes through a small control server on 127.0.0.1 (`GET /health`, `POST /cmd { name, args }`)
 * and through a JSON-lines events file (written synchronously, so it survives the quit that a scenario tests).
 *
 * Environment (set by run-smoke.js):
 *   GPOS_E2E_USER_DATA        the userData folder (a fresh temp folder per run)                       required
 *   GPOS_E2E_EVENTS_FILE      the JSON-lines file the events are appended to                          required
 *   GPOS_E2E_CONTROL_PORT     the port of the control server                                          required
 *   GADGETSPOS_START_URL      the POS address (honoured only while the app is not packaged)
 *   GPOS_E2E_PACKAGED=1       start as an installed app (production rules; the start URL is then ignored)
 *   GPOS_E2E_FULLSCREEN_SPY=1 record `setFullScreen` instead of performing it
 *   GPOS_E2E_WARP_MS=<ms>     a timer of exactly this length fires after 200 ms
 *   GPOS_E2E_UPDATER=1        updates are enabled for a development run (a test feed address) with the stand-in autoUpdater
 *
 * Not named *.test.js: node --test must not run it.
 */

// The very first thing: the app must never take focus, and this also keeps the Dock icon from lingering.
const realElectron = require('electron');

if (process.platform === 'darwin' && typeof realElectron.app.setActivationPolicy === 'function') realElectron.app.setActivationPolicy('accessory');

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');

const { bootstrap, APP_ROOT } = require('../../../src/main/index');
const appPackage = require('../../../package.json');
const { PrintError } = require('../../../src/main/errors');
const { createDymoService } = require('../../../src/main/printing/dymo');
const { createWindowFactory } = require('../../helpers/vm-dymo');

const { app } = realElectron;

// ---------------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------------

const config = {
  userData: process.env.GPOS_E2E_USER_DATA,
  eventsFile: process.env.GPOS_E2E_EVENTS_FILE,
  controlPort: Number(process.env.GPOS_E2E_CONTROL_PORT),
  startUrl: process.env.GADGETSPOS_START_URL || '',
  packaged: process.env.GPOS_E2E_PACKAGED === '1',
  fullScreenSpy: process.env.GPOS_E2E_FULLSCREEN_SPY === '1',
  warpMs: Number(process.env.GPOS_E2E_WARP_MS) || 0,
  updater: process.env.GPOS_E2E_UPDATER === '1',
  realRaw: process.env.GPOS_E2E_REAL_RAW === '1',
  realDymo: process.env.GPOS_E2E_REAL_DYMO === '1',
  realPrinters: process.env.GPOS_E2E_REAL_PRINTERS === '1',
  execMode: process.env.GPOS_E2E_EXEC_MODE || 'notfound',
};

/** The test feed of an update run: a development run honours GADGETSPOS_UPDATE_URL when it is https (SPEC 13). Nothing ever connects to it. */
const TEST_UPDATE_FEED = 'https://updates.example.test/gadgetspos/';

for (const [name, value] of [['GPOS_E2E_USER_DATA', config.userData], ['GPOS_E2E_EVENTS_FILE', config.eventsFile], ['GPOS_E2E_CONTROL_PORT', config.controlPort]]) {
  if (!value) {
    process.stderr.write(`launch-app.js: ${name} is required\n`);
    process.exit(2);
  }
}

/** The origin of the start URL: the only origin besides the built-in ones that an unpackaged app trusts in this run. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Recording: everything the fakes saw, and an events file the harness can read after the process is gone
// ---------------------------------------------------------------------------------------------------------------------------

const rec = {
  seq: 0,
  rawJobs: [],
  rawSeq: 0,
  printer: { failCode: null, failDetails: null, delayMs: 0 },
  dialogs: [],
  notices: [],
  openExternal: [],
  openPath: [],
  clipboard: [],
  login: { open: false, calls: [] },
  power: { calls: [], active: new Set(), seq: 0 },
  relaunches: [],
  fullScreen: [],
  appMenu: null,
  menusBuilt: 0,
  popups: [],
  clockOffset: 0,
  uncaught: [],
};

/** Records one event in the events file (synchronously) and on stdout. @returns {object} the event */
function emit(type, data = {}) {
  rec.seq += 1;
  const event = { ...data, n: rec.seq, t: Date.now(), type };
  const line = JSON.stringify(event);
  try {
    fs.appendFileSync(config.eventsFile, `${line}\n`);
  } catch {
    // The events file is a convenience for the harness; a failing disk must not break the app under test.
  }
  process.stdout.write(`E2E ${line}\n`);
  return event;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (error) => {
  rec.uncaught.push(String((error && error.stack) || error));
  emit('uncaught', { message: String((error && error.message) || error) });
});
process.on('unhandledRejection', (reason) => {
  rec.uncaught.push(String((reason && reason.stack) || reason));
  emit('unhandled-rejection', { message: String((reason && reason.message) || reason) });
});

/** The handle `bootstrap` returned; the fakes that need the app's own objects (the print queue, the config) look it up lazily. */
let handle = null;

// ---------------------------------------------------------------------------------------------------------------------------
// The fake printers
// ---------------------------------------------------------------------------------------------------------------------------

/** What `webContents.getPrintersAsync()` would answer (status: CUPS numbers, 3 = idle, 5 = stopped). */
const SYSTEM_PRINTERS = Object.freeze([
  { name: 'E2E-Receipt-58', displayName: 'E2E Receipt Printer', description: 'Thermal receipt printer', status: 3, isDefault: true, options: {} },
  { name: 'E2E-Zebra-ZD420', displayName: 'E2E Zebra ZD420', description: 'Label printer', status: 3, isDefault: false, options: {} },
  { name: 'Office-Laser', displayName: 'Office Laser', description: 'A4 laser', status: 5, isDefault: false, options: {} },
]);

/** The DYMO printers of the fake DYMO Connect. */
const DYMO_PRINTERS = Object.freeze([
  { name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', isConnected: true },
  { name: 'DYMO LabelWriter 550 Turbo', modelName: 'DYMO LabelWriter 550 Turbo', isConnected: false },
]);

/**
 * The raw printer. Like the real one (src/main/printing/transports/index.js) it validates nothing itself, queues every job
 * on the app's print queue under `system:<name>` or `port:<port>`, and answers `{ ok: true }` or rejects with a PrintError.
 */
const rawPrinter = {
  async printRaw({ target, data, label = 'print', ext } = {}) {
    const bytes = Buffer.from(data);
    const where = target && typeof target === 'object' ? target : {};
    const key = where.transport === 'port' ? `port:${where.port}` : `system:${where.printerName}`;
    rec.rawSeq += 1;
    const job = {
      id: rec.rawSeq,
      label,
      ext: ext || null,
      key,
      target: { transport: where.transport || '', printerName: where.printerName || '', port: where.port || '' },
      length: bytes.length,
      hex: bytes.toString('hex'),
      startedAt: null,
      endedAt: null,
      ok: null,
      code: null,
    };
    rec.rawJobs.push(job);
    const run = async () => {
      job.startedAt = Date.now();
      emit('job-start', { id: job.id, label, key });
      if (rec.printer.delayMs > 0) await sleep(rec.printer.delayMs);
      job.endedAt = Date.now();
      if (rec.printer.failCode) {
        job.ok = false;
        job.code = rec.printer.failCode;
        emit('job-failed', { id: job.id, label, code: job.code });
        throw new PrintError(rec.printer.failCode, undefined, rec.printer.failDetails || undefined);
      }
      job.ok = true;
      emit('job-end', { id: job.id, label, ms: job.endedAt - job.startedAt });
    };
    const queue = handle && handle.services && handle.services.queue;
    await (queue ? queue.enqueue(key, run, { label, timeoutMs: 30000 }) : run());
    return { ok: true };
  },
  dispose() {
    emit('raw-printer-disposed');
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// The fake `execFile` of the REAL raw printer (GPOS_E2E_REAL_RAW=1)
// ---------------------------------------------------------------------------------------------------------------------------

const realExecFile = require('node:child_process').execFile;
const execState = { mode: config.execMode, log: [], children: [] };

/**
 * What `lp` would do, without touching CUPS:
 *   notfound  fails like `lp -d <unknown>` (exit 1, "The printer or class does not exist.")
 *   ok        succeeds
 *   hang      runs a REAL `sleep 300` that honours the abort signal: when the queue's timeout fires, the signal kills the child
 * Every call is recorded with the size and mode of the temp file as it is AT THE MOMENT `lp` is started.
 */
function fakeExecFile(file, args, options, callback) {
  const tempPath = Array.isArray(args) ? args[args.length - 1] : '';
  let temp = null;
  try {
    const stat = fs.statSync(tempPath);
    temp = { path: tempPath, size: stat.size, mode: (stat.mode & 0o777).toString(8) };
  } catch {
    temp = { path: tempPath, size: null, mode: null };
  }
  const entry = { file, args: Array.isArray(args) ? args.slice() : args, at: Date.now(), mode: execState.mode, temp, childPid: null };
  execState.log.push(entry);
  emit('exec', { file, mode: entry.mode, tempSize: temp.size });
  if (execState.mode === 'hang') {
    const child = realExecFile('/bin/sleep', ['300'], { signal: options && options.signal }, (error, stdout, stderr) => {
      entry.endedWith = error ? String(error.name || error.code) : 'exit 0';
      callback(error, stdout, stderr);
    });
    entry.childPid = child.pid;
    execState.children.push(child.pid);
    return child;
  }
  setImmediate(() => {
    if (execState.mode === 'ok') {
      callback(null, 'request id is E2E-1 (1 file(s))\n', '');
    } else {
      const error = Object.assign(new Error('Command failed: lp'), { code: 1 });
      callback(error, '', 'lp: The printer or class does not exist.\n');
    }
  });
  return { pid: 0 };
}

/** The DYMO hidden windows the real DYMO service asked for; each runs its scripts against a fake framework. */
const dymoWindows = createWindowFactory({ dymo: { printers: DYMO_PRINTERS.map((printer) => ({ ...printer })) } });

const dymoLog = {
  info: (message) => emit('dymo-log', { level: 'info', message: String(message) }),
  warn: (message) => emit('dymo-log', { level: 'warn', message: String(message) }),
  error: (message) => emit('dymo-log', { level: 'error', message: String(message) }),
};

/** How the fake operating system answers `getPrintersAsync`: ok | empty | throw | hang | slow (10 s). */
let printersMode = 'ok';

/** When set, every DYMO print call fails with this message (the fake framework throws it, as the real one does). */
let dymoFailMessage = null;

const dymo = createDymoService({
  createHiddenWindow: () => {
    emit('dymo-window-created');
    const win = dymoWindows.createHiddenWindow();
    if (dymoFailMessage) win.fake.setFailPrint(() => dymoFailMessage);
    return win;
  },
  labelsDir: path.join(APP_ROOT, 'labels'),
  readFile: (file, encoding) => fs.promises.readFile(file, encoding),
  getConfig: () => (handle && handle.services ? handle.services.config : undefined),
  log: dymoLog,
});

// ---------------------------------------------------------------------------------------------------------------------------
// The stand-in for electron-updater
// ---------------------------------------------------------------------------------------------------------------------------

/** How many times the app asked for `autoUpdater` (it must be once, at the first check, and never before). */
let updaterLoads = 0;

/** electron-updater's `autoUpdater` as far as the app uses it: settings are written to it, a check emits what a real one would. */
const fakeAutoUpdater = Object.assign(new EventEmitter(), {
  feedUrl: null,
  quitAndInstallCalls: [],
  setFeedURL(url) {
    this.feedUrl = url;
  },
  /** Finds version 2.0.1, downloads it in four steps and says it is ready. */
  async checkForUpdates() {
    emit('updater-check');
    this.emit('checking-for-update');
    await sleep(300);
    this.emit('update-available', { version: '2.0.1' });
    for (const percent of [25, 60, 100]) {
      await sleep(300);
      this.emit('download-progress', { percent });
    }
    this.emit('update-downloaded', { version: '2.0.1' });
    return { isUpdateAvailable: true, updateInfo: { version: '2.0.1' } };
  },
  quitAndInstall(silent, forceRunAfter) {
    this.quitAndInstallCalls.push([silent, forceRunAfter]);
    emit('quit-and-install', { silent, forceRunAfter });
  },
});

// ---------------------------------------------------------------------------------------------------------------------------
// The other fakes: native dialogs, the operating system, the menu
// ---------------------------------------------------------------------------------------------------------------------------

/** Rules of the harness: a native box whose text contains `match` is answered with button number `response`. */
const dialogRules = [];

/** Records a native box and answers it with its cancel button (the first button when it has none): "Later", "Stay", "OK", "Yes". */
function answerBox(kind, first, second) {
  const options = second === undefined ? first : second;
  const box = options && typeof options === 'object' ? options : {};
  let response = Number.isInteger(box.cancelId) ? box.cancelId : 0;
  for (const rule of dialogRules) {
    if (`${box.message || ''} ${box.detail || ''}`.includes(rule.match)) {
      response = rule.response;
      break;
    }
  }
  const entry = {
    kind,
    type: box.type || '',
    title: box.title || '',
    message: box.message || '',
    detail: box.detail || '',
    buttons: Array.isArray(box.buttons) ? box.buttons : [],
    response,
    withWindow: second !== undefined,
    at: Date.now(),
  };
  rec.dialogs.push(entry);
  emit('dialog', { message: entry.message, buttons: entry.buttons, response });
  return response;
}

const dialog = {
  showMessageBox: async (first, second) => ({ response: answerBox('box', first, second), checkboxChecked: false }),
  showMessageBoxSync: (first, second) => answerBox('box-sync', first, second),
  showErrorBox: (title, content) => {
    rec.dialogs.push({ kind: 'error-box', title: String(title), message: String(content), detail: '', buttons: [], response: 0, withWindow: false, at: Date.now() });
    emit('dialog', { message: String(title), buttons: [], response: 0 });
  },
};

/**
 * `app` with the login item and the relaunch replaced, and the name and version of the PROJECT: started as
 * `electron tests/e2e/launch-app.js` there is no package.json beside the script, so the real `getVersion()` would answer
 * Electron's own version (32.3.3) and `getName()` "Electron". Everything else is the real app.
 */
const fakeApp = new Proxy(app, {
  get(target, property) {
    if (property === 'getVersion') return () => appPackage.version;
    if (property === 'getName') return () => appPackage.productName || appPackage.name;
    if (property === 'setLoginItemSettings') {
      return (settings) => {
        rec.login.calls.push({ ...settings });
        rec.login.open = Boolean(settings && settings.openAtLogin);
        emit('login-item', { openAtLogin: rec.login.open });
      };
    }
    if (property === 'getLoginItemSettings') return () => ({ openAtLogin: rec.login.open });
    if (property === 'relaunch') {
      return (options) => {
        rec.relaunches.push({ at: Date.now(), options: options || null });
        emit('relaunch');
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const fakePowerSaveBlocker = {
  start(type) {
    rec.power.seq += 1;
    rec.power.calls.push({ op: 'start', type, id: rec.power.seq });
    rec.power.active.add(rec.power.seq);
    emit('power-blocker', { op: 'start', blocker: type, id: rec.power.seq });
    return rec.power.seq;
  },
  stop(id) {
    rec.power.calls.push({ op: 'stop', id });
    rec.power.active.delete(id);
    emit('power-blocker', { op: 'stop', id });
  },
};

const fakeShell = {
  openExternal: async (url) => {
    rec.openExternal.push({ url: String(url), at: Date.now() });
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
    emit('clipboard', { length: String(text).length });
  },
};

class FakeNotification {
  constructor(options) {
    this.options = options || {};
  }

  show() {
    rec.notices.push({ title: this.options.title || '', body: this.options.body || '', at: Date.now() });
    emit('notice', { body: this.options.body || '' });
  }

  static isSupported() {
    return true;
  }
}

/** The menu fields a test can read: no functions, submenus included. */
function summarizeTemplate(template) {
  return (Array.isArray(template) ? template : []).map((item) => {
    const entry = {};
    for (const key of ['id', 'label', 'role', 'type', 'accelerator', 'enabled', 'checked', 'visible']) {
      if (item[key] !== undefined) entry[key] = item[key];
    }
    if (typeof item.click === 'function') entry.clickable = true;
    if (Array.isArray(item.submenu)) entry.submenu = summarizeTemplate(item.submenu);
    return entry;
  });
}

/** @returns {object|null} the first item (depth first) for which `test` is true */
function findItem(template, test) {
  for (const item of Array.isArray(template) ? template : []) {
    if (test(item)) return item;
    const inner = findItem(item.submenu, test);
    if (inner) return inner;
  }
  return null;
}

/** A menu that only remembers its template: the application menu is recorded, a popup is recorded and never shown. */
class FakeMenu {
  constructor(template) {
    this.template = template;
  }

  static buildFromTemplate(template) {
    rec.menusBuilt += 1;
    return new FakeMenu(template);
  }

  static setApplicationMenu(menu) {
    rec.appMenu = menu;
    emit('application-menu', { items: summarizeTemplate(menu.template).map((item) => item.label || item.role) });
  }

  popup(options) {
    rec.popups.push({ at: Date.now(), template: this.template, hasWindow: Boolean(options && options.window) });
    emit('popup', { items: summarizeTemplate(this.template).map((item) => item.label || item.type || item.role) });
  }
}

/** Records a full-screen request instead of performing it (a real one moves the developer's desktop to a new space). */
class FullScreenSpyWindow extends realElectron.BrowserWindow {
  setFullScreen(flag) {
    this.spyFullScreen = Boolean(flag);
    rec.fullScreen.push({ flag: Boolean(flag), at: Date.now() });
    emit('set-full-screen', { flag: Boolean(flag) });
    this.emit(flag ? 'enter-full-screen' : 'leave-full-screen');
  }

  isFullScreen() {
    return this.spyFullScreen === true;
  }
}

// Electron's BrowserWindow.getAllWindows() lists only windows whose constructor is NAMED 'BrowserWindow' (the app's own quiet subclass keeps that
// name for the same reason): without this line the spy class would hide every window of the app from the `windows` command.
Object.defineProperty(FullScreenSpyWindow, 'name', { value: 'BrowserWindow' });

/** The `electron` module the app is given: the real one, with the fakes above in front of it. */
const electronForApp = Object.create(realElectron, {
  app: { value: fakeApp, enumerable: true },
  powerSaveBlocker: { value: fakePowerSaveBlocker, enumerable: true },
  shell: { value: fakeShell, enumerable: true },
  clipboard: { value: fakeClipboard, enumerable: true },
  Notification: { value: FakeNotification, enumerable: true },
  Menu: { value: FakeMenu, enumerable: true },
  ...(config.fullScreenSpy ? { BrowserWindow: { value: FullScreenSpyWindow, enumerable: true } } : {}),
});

/**
 * A window the POS page opens with window.open is created by Electron itself, which shows it with `show()` and so activates the
 * app. The harness asks for it hidden instead: the page still gets its WindowProxy and the window still loads, but nothing comes
 * to the front. (Registered before bootstrap, so it wraps the handler that the app's own guards install.)
 */
app.on('web-contents-created', (_event, contents) => {
  const install = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) => install((details) => {
    const decision = handler(details);
    if (decision && decision.action === 'allow') {
      emit('popup-window', { url: String(details && details.url).slice(0, 60) });
      return { ...decision, overrideBrowserWindowOptions: { ...(decision.overrideBrowserWindowOptions || {}), show: false } };
    }
    return decision;
  });
});

app.on('before-quit', () => emit('before-quit'));
app.on('will-quit', () => emit('will-quit'));
app.on('quit', () => emit('quit'));
app.on('second-instance', () => emit('second-instance'));

// ---------------------------------------------------------------------------------------------------------------------------
// The control server: what the harness asks of the running app
// ---------------------------------------------------------------------------------------------------------------------------

function mainWindow() {
  const controller = handle && handle.controller();
  return controller && !controller.window.isDestroyed() ? controller.window : null;
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
  };
}

/** The webContents of the POS window. */
function mainContents() {
  const win = mainWindow();
  if (!win) throw new Error('the POS window is not open');
  return win.webContents;
}

function snapshot() {
  return {
    pid: process.pid,
    packaged: config.packaged,
    ready: handle !== null,
    marks: handle ? handle.perf.marks() : {},
    rawJobs: rec.rawJobs.map((job) => ({ ...job })),
    dialogs: rec.dialogs.slice(),
    notices: rec.notices.slice(),
    openExternal: rec.openExternal.slice(),
    openPath: rec.openPath.slice(),
    clipboard: rec.clipboard.slice(),
    login: { open: rec.login.open, calls: rec.login.calls.slice() },
    power: { calls: rec.power.calls.slice(), active: [...rec.power.active] },
    relaunches: rec.relaunches.slice(),
    fullScreen: rec.fullScreen.slice(),
    dymo: {
      windowsCreated: dymoWindows.created,
      windows: dymoWindows.windows.map((win) => ({ destroyed: win.destroyed, scripts: win.scripts.length, labels: win.fake.labels() })),
    },
    menu: { built: rec.menusBuilt, popups: rec.popups.length, top: rec.appMenu ? summarizeTemplate(rec.appMenu.template) : [] },
    clockOffset: rec.clockOffset,
    uncaught: rec.uncaught.slice(),
  };
}

/** The popup menus shown since the `since`-th one, as plain data. */
const popupsSince = (since) => rec.popups.slice(since).map((popup) => ({ at: popup.at, hasWindow: popup.hasWindow, template: summarizeTemplate(popup.template) }));

const commands = {
  state: () => snapshot(),

  windows: () => realElectron.BrowserWindow.getAllWindows().map(describeWindow).filter(Boolean),

  mainInfo: () => describeWindow(mainWindow()),

  minimizeMain: () => {
    mainWindow().minimize();
    return true;
  },

  /** Kills the renderer process of the POS window, as a crash does. */
  crashMain: () => {
    mainContents().forcefullyCrashRenderer();
    return true;
  },

  /** Shows the offline screen with these values (what the network or a server could put in them) and, unless told not to, retries. */
  showOffline: async ({ info = {}, options = {} } = {}) => {
    await handle.controller().showOffline(info, options);
    return true;
  },

  /** Moves and resizes the POS window. */
  setMainBounds: ({ bounds } = {}) => {
    mainWindow().setBounds(bounds);
    return mainWindow().getBounds();
  },

  /** Makes the raw printer fail every job with this error code (null: print again). */
  failPrinter: ({ code = null, details = null } = {}) => {
    rec.printer.failCode = code;
    rec.printer.failDetails = details;
    return rec.printer;
  },

  /** Makes every raw job take this long. */
  delayPrinter: ({ ms = 0 } = {}) => {
    rec.printer.delayMs = ms;
    return rec.printer;
  },

  /** Makes every DYMO print call fail with this message (null: print again). */
  dymoFail: ({ message = null } = {}) => {
    dymoFailMessage = message;
    for (const win of dymoWindows.windows) win.fake.setFailPrint(message ? () => message : null);
    return true;
  },

  menu: () => (rec.appMenu ? summarizeTemplate(rec.appMenu.template) : []),

  /** "Clicks" an item of the application menu by id, the way the operating system would call its handler. */
  menuClick: ({ id, checked = false } = {}) => {
    if (!rec.appMenu) throw new Error('the application menu is not installed yet');
    const item = findItem(rec.appMenu.template, (entry) => entry.id === id);
    if (!item || typeof item.click !== 'function') throw new Error(`no clickable menu item has the id ${id}`);
    item.click({ ...item, checked: Boolean(checked) }, mainWindow(), {});
    return { clicked: true, label: item.label };
  },

  /** "Clicks" an item of a popup menu by its label. */
  popupClick: ({ index = rec.popups.length - 1, label } = {}) => {
    const popup = rec.popups[index];
    if (!popup) throw new Error(`there is no popup number ${index}`);
    const item = findItem(popup.template, (entry) => entry.label === label);
    if (!item || typeof item.click !== 'function') throw new Error(`no clickable item is labelled ${label}`);
    item.click({ ...item }, mainWindow(), {});
    return { clicked: true };
  },

  /** A `context-menu` event on the POS window, with the parameters Chromium would send. */
  contextMenu: ({ params } = {}) => {
    const before = rec.popups.length;
    mainContents().emit('context-menu', { preventDefault() {} }, params);
    return popupsSince(before);
  },

  /** A real right click on the POS window: Chromium works out the parameters itself. */
  rightClick: async ({ x, y } = {}) => {
    const before = rec.popups.length;
    const contents = mainContents();
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    for (let waited = 0; waited < 2000 && rec.popups.length === before; waited += 50) await sleep(50);
    return popupsSince(before);
  },

  /** Emits an event on the real `app`, as Chromium would (a crashed GPU process, for example). */
  emitApp: ({ event, details } = {}) => {
    app.emit(event, {}, details);
    return true;
  },

  /** Moves the app's clock forward (the password lockout counts on it). */
  advanceClock: ({ ms = 0 } = {}) => {
    rec.clockOffset += ms;
    return rec.clockOffset;
  },

  /** Quits the way a menu item does: the answer goes out first. */
  quit: () => {
    setImmediate(() => app.quit());
    return true;
  },

  /** Runs a script in the POS window's page, from the main process: it does not depend on the debugger's view of the page. */
  evalIn: ({ code } = {}) => mainContents().executeJavaScript(String(code), true),

  gpu: () => app.getGPUFeatureStatus(),

  /** What the app did with electron-updater: how often it asked for it, what it wrote to it, how it was told to install. */
  updater: () => ({
    loads: updaterLoads,
    feedUrl: fakeAutoUpdater.feedUrl,
    autoDownload: fakeAutoUpdater.autoDownload,
    autoInstallOnAppQuit: fakeAutoUpdater.autoInstallOnAppQuit,
    disableWebInstaller: fakeAutoUpdater.disableWebInstaller,
    allowDowngrade: fakeAutoUpdater.allowDowngrade,
    allowPrerelease: fakeAutoUpdater.allowPrerelease,
    forceDevUpdateConfig: fakeAutoUpdater.forceDevUpdateConfig,
    quitAndInstallCalls: fakeAutoUpdater.quitAndInstallCalls.slice(),
  }),

  /** What `webContents.capturePage()` sees of the POS window: its size and how long the capture took (a window that is not painting is empty). */
  capture: async ({ timeoutMs = 5000 } = {}) => {
    const contents = mainContents();
    const started = Date.now();
    const image = await Promise.race([contents.capturePage(), sleep(timeoutMs).then(() => null)]);
    if (!image) return { ok: false, ms: Date.now() - started };
    const size = image.getSize();
    return { ok: true, width: size.width, height: size.height, bytes: image.toPNG().length, ms: Date.now() - started };
  },

  /** The settings a window may see (never the password record). */
  config: () => handle.services.config.publicState(),

  modules: () => ({ updaterLoaded: Object.keys(require.cache).some((file) => file.includes(`${path.sep}electron-updater${path.sep}`)) }),

  // ---- the commands of the runtime-e2e lens --------------------------------------------------------------------------------

  /** Answers native boxes whose text contains `match` with button `response` (replaces the earlier rules). */
  dialogRules: ({ rules = [] } = {}) => {
    dialogRules.length = 0;
    for (const rule of rules) dialogRules.push({ match: String(rule.match), response: Number(rule.response) });
    return dialogRules.length;
  },

  /** Closes the POS window the way the close button does. */
  closeMain: () => {
    mainWindow().close();
    return true;
  },

  /** `controller.reload()`: View > Reload. */
  reloadMain: ({ force = false } = {}) => {
    // not awaited: the promise settles only when the page has loaded, which a hung server never lets happen (the menu does not wait either)
    void Promise.resolve(handle.controller().reload({ force })).catch(() => {});
    return true;
  },

  /** `controller.loadPos()` (what the connectivity controller does when the server is back). */
  loadPos: () => {
    void Promise.resolve(handle.controller().loadPos()).catch(() => {});
    return true;
  },

  /** The offline screen's Retry now. */
  retryNowMain: () => {
    void Promise.resolve(handle.controller().retryNow()).catch(() => {});
    return true;
  },

  /**
   * Writes what the POS window shows to a PNG file; answers how long the capture took and how many different colours a sample of
   * its pixels has (`distinctColors`: 1 means one flat colour, which is what a blank window looks like).
   */
  capturePng: async ({ file, timeoutMs = 5000 } = {}) => {
    const started = Date.now();
    const image = await Promise.race([mainContents().capturePage(), sleep(timeoutMs).then(() => null)]);
    if (!image) return { ok: false, ms: Date.now() - started };
    const size = image.getSize();
    fs.writeFileSync(file, image.toPNG());
    const bitmap = image.toBitmap();
    const colors = new Set();
    const step = Math.max(4, Math.floor(bitmap.length / 4 / 20000) * 4);
    for (let at = 0; at + 3 < bitmap.length && colors.size < 64; at += step) colors.add(bitmap.readUInt32LE(at));
    return { ok: true, width: size.width, height: size.height, ms: Date.now() - started, distinctColors: colors.size };
  },

  /** The desktop API of the main process (what the pages' `window.desktop` calls end in): `{ name, args }`. */
  desktopApi: async ({ name, args = [] } = {}) => {
    const api = handle.services.desktopApi;
    const target = name.split('.').reduce((node, part) => node[part], api);
    return typeof target === 'function' ? target(...args) : target;
  },

  /** The state WITHOUT the job bytes (a 5 MB receipt is 10 MB of hex): what a flood scenario needs to count. */
  light: () => ({
    pid: process.pid,
    jobs: rec.rawJobs.map((job) => ({ id: job.id, label: job.label, key: job.key, length: job.length, ok: job.ok, code: job.code, startedAt: job.startedAt, endedAt: job.endedAt })),
    dialogs: rec.dialogs.slice(),
    notices: rec.notices.slice(),
    openExternal: rec.openExternal.slice(),
    relaunches: rec.relaunches.slice(),
    uncaught: rec.uncaught.slice(),
    dymo: { windowsCreated: dymoWindows.created, labels: dymoWindows.windows.flatMap((win) => win.fake.labels()) },
  }),

  /** How the (fake) operating system answers the printer list: ok | empty | throw | hang | slow. */
  printersMode: ({ mode } = {}) => {
    printersMode = String(mode);
    return printersMode;
  },

  /** Closes any window by id, the way its close button does. */
  closeWindow: ({ id } = {}) => {
    const win = realElectron.BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) return false;
    win.close();
    return true;
  },

  /** Kills the renderer process of any window by id, as a crash does. */
  crashWindow: ({ id } = {}) => {
    const win = realElectron.BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) return false;
    win.webContents.forcefullyCrashRenderer();
    return true;
  },

  /** A real left click on the POS window (an input event the renderer must answer: a hung renderer makes Electron say 'unresponsive'). */
  inputClick: ({ x = 50, y = 50 } = {}) => {
    const contents = mainContents();
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return true;
  },

  /** The work areas of the connected displays. */
  displays: () => realElectron.screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea, scaleFactor: display.scaleFactor })),

  /** What the POS window's webContents says about itself right now. */
  mainState: () => {
    const contents = mainContents();
    return { url: contents.getURL(), loading: contents.isLoading(), crashed: contents.isCrashed(), title: contents.getTitle() };
  },

  /** Writes what ANY window shows (Settings, the password prompt, a popup) to a PNG file. */
  captureWindow: async ({ id, file, timeoutMs = 5000 } = {}) => {
    const win = realElectron.BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no such window' };
    const image = await Promise.race([win.webContents.capturePage(), sleep(timeoutMs).then(() => null)]);
    if (!image) return { ok: false, reason: 'timeout' };
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, ...image.getSize() };
  },

  /** Asks for the Settings window `n` times in the same tick, the way concurrent menu clicks or page requests do. */
  openSettingsN: ({ n = 2, tab = 'printers' } = {}) => {
    const results = [];
    for (let i = 0; i < n; i += 1) results.push(handle.services.desktopApi.openSettings(tab));
    return results;
  },

  /** Shows the password prompt for a purpose (`drawer` | `settings` | `generic`). */
  promptShow: ({ purpose = 'drawer', tab } = {}) => {
    handle.services.passwordPrompt.show(purpose, { tab });
    return true;
  },

  queueSize: ({ key } = {}) => handle.services.queue.size(String(key)),

  /** The main process's own memory and how many windows exist. */
  memory: () => ({ ...process.memoryUsage(), windows: realElectron.BrowserWindow.getAllWindows().length }),

  /** Every process of the app with its memory (KB). */
  appMetrics: () => app.getAppMetrics().map((entry) => ({ pid: entry.pid, type: entry.type, workingSetKb: entry.memory.workingSetSize, cpu: entry.cpu.percentCPUUsage })),

  /** What the fake `execFile` was asked to run (real raw printer mode only). */
  execLog: () => ({ mode: execState.mode, log: execState.log, children: execState.children }),

  execMode: ({ mode } = {}) => {
    execState.mode = String(mode);
    return execState.mode;
  },

  /** Writes one setting through the app's own config (a Settings save would do the same). */
  setConfig: ({ path: settingPath, value } = {}) => handle.services.config.set(settingPath, value),

  /** The temp files of THIS process left in the OS temp folder (`gpos-<pid>-*`). */
  tempFiles: () => fs.readdirSync(require('node:os').tmpdir()).filter((name) => name.startsWith(`gpos-${process.pid}-`)),
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
  server.listen(config.controlPort, '127.0.0.1');
  server.unref();
  return server;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Start the app
// ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  const startOrigin = originOf(config.startUrl);
  const clock = {
    now: () => Date.now() + rec.clockOffset,
    monotonic: () => performance.now() + rec.clockOffset, // the password lock counts on this one, so `advanceClock` still ends it
    uptimeMs: () => process.uptime() * 1000,
    setTimeout: (callback, ms, ...args) => setTimeout(callback, config.warpMs > 0 && ms === config.warpMs ? 200 : ms, ...args),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (timer) => clearInterval(timer),
  };

  const started = await bootstrap({
    electron: electronForApp,
    testMode: true,
    userDataPath: config.userData,
    isPackaged: config.packaged,
    env: { ...process.env, GADGETSPOS_START_URL: config.startUrl, ...(config.updater ? { GADGETSPOS_UPDATE_URL: TEST_UPDATE_FEED } : {}) },
    ...(config.updater ? { loadAutoUpdater: () => { updaterLoads += 1; return fakeAutoUpdater; } } : {}),
    devOrigins: startOrigin ? [startOrigin] : [],
    clock,
    ...(config.realRaw ? { execFile: fakeExecFile } : { rawPrinter }),
    ...(config.realDymo ? {} : { dymo }),
    dialog,
    ...(config.realPrinters ? {} : {
      getPrintersAsync: async () => {
        // the operating system's printer list, as the harness wants it to behave (command `printersMode`)
        if (printersMode === 'empty') return [];
        if (printersMode === 'throw') throw new Error('The print system is not running');
        if (printersMode === 'hang') return new Promise(() => {});
        if (printersMode === 'slow') await sleep(10_000);
        return SYSTEM_PRINTERS.map((printer) => ({ ...printer }));
      },
    }),
  });
  if (started === null) {
    emit('second-instance-denied');
    return;
  }
  handle = started;

  // Show when the app is asked to focus its window (a second start of the app).
  const controller = handle.controller();
  if (controller) {
    const focus = controller.focus.bind(controller);
    controller.focus = () => {
      emit('main-focus');
      focus();
    };
  }
  startControlServer();
  emit('ready', { marks: handle.perf.marks(), packaged: config.packaged });
}

main().catch((error) => {
  emit('launch-failed', { message: String((error && error.stack) || error) });
  process.exitCode = 1;
  app.exit(1);
});
