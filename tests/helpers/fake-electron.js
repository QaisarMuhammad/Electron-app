'use strict';

/**
 * Test doubles that let main-process code run under plain `node --test` (no Electron runtime):
 *
 *  - createFakeElectron(options)  a stub of the `electron` module (app, BrowserWindow, ipcMain, dialog, shell,
 *                                 session with webRequest, net, Menu, screen, nativeTheme, powerSaveBlocker,
 *                                 clipboard). Everything is recorded in `state`; nothing touches the OS.
 *  - interceptModules(resolver)   hooks Module._load, so `require('electron')` (or any other module) made by the
 *                                 code under test returns a stub. This is how the v1 index.js runs in the golden harness.
 *  - createManualClock(start)     deterministic timers with an async advance(ms), for idle/timeout tests.
 *  - silenceConsole()             mutes console output while a noisy legacy module runs.
 *
 * Shared by several test areas: extend it, do not rewrite it. It is a test helper only (never required from src/).
 */

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

/* ---------------------------------------------------------------------------------------------------------- */
/* Manual clock                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

/** Lets pending promise continuations (and one macrotask) run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fake setTimeout/clearTimeout/now trio. Time only moves when advance(ms) is awaited; timers due inside the
 * advanced span fire in order and the promise chains they start are allowed to settle between firings.
 * Handles mimic Node timers (`unref()`, `ref()`, `hasRef()`), and remember whether they were unref'd.
 * @param {number} [start]
 */
function createManualClock(start = 1_700_000_000_000) {
  let time = start;
  let nextId = 1;
  /** @type {Array<{ id: number, at: number, fn: Function, cleared: boolean, fired: boolean, unrefd: boolean }>} */
  const timers = [];

  function setTimeoutFake(fn, ms = 0) {
    const timer = { id: nextId++, at: time + Math.max(0, Number(ms) || 0), fn, cleared: false, fired: false, unrefd: false };
    timers.push(timer);
    timer.unref = () => {
      timer.unrefd = true;
      return timer;
    };
    timer.ref = () => {
      timer.unrefd = false;
      return timer;
    };
    timer.hasRef = () => !timer.unrefd;
    return timer;
  }

  function clearTimeoutFake(timer) {
    if (timer) timer.cleared = true;
  }

  const live = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  async function advance(ms) {
    const target = time + ms;
    await flush();
    for (;;) {
      const due = live()
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      time = Math.max(time, due.at);
      due.fired = true;
      due.fn();
      await flush();
    }
    time = target;
    await flush();
  }

  /**
   * Advances in small steps: for a flow that creates its timers only after earlier async work (a file read, a page
   * load), so each step lets the flow reach its next timer before time moves on.
   */
  async function tick(totalMs, stepMs = 50) {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await advance(Math.min(stepMs, totalMs - elapsed));
  }

  return {
    now: () => time,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
    tick,
    flush,
    /** Timers that are scheduled and have not fired or been cleared. */
    pending: () => live().length,
    /** Scheduled timers that would keep a real process alive (not unref'd). */
    pendingRefed: () => live().filter((timer) => !timer.unrefd).length,
    /** The scheduled timers (for assertions about unref and due times). */
    timers: live,
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Console                                                                                                     */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * Replaces console.log/info/warn/error/debug with no-ops (the v1 handler logs every payload).
 * @returns {() => void} restore function
 */
function silenceConsole() {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((name) => [name, console[name]]);
  for (const name of methods) console[name] = () => {};
  return () => {
    for (const [name, fn] of saved) console[name] = fn;
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Module interception                                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * Hooks Module._load. `resolver` is either a map { moduleName: exports } or a function (request, parent) =>
 * exports | undefined; `undefined` means "not stubbed, load the real module". Restore in the reverse order of
 * interception.
 * @param {Record<string, unknown> | ((request: string, parent: any) => unknown)} resolver
 * @returns {() => void} restore function
 */
function interceptModules(resolver) {
  const resolve =
    typeof resolver === 'function'
      ? resolver
      : (request) => (Object.prototype.hasOwnProperty.call(resolver, request) ? resolver[request] : undefined);
  const original = Module._load;
  function patchedLoad(request, parent, isMain) {
    const stub = resolve(request, parent);
    if (stub !== undefined) return stub;
    return original.call(this, request, parent, isMain);
  }
  Module._load = patchedLoad;
  return function restore() {
    if (Module._load === patchedLoad) Module._load = original;
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Fake electron                                                                                               */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {string} [options.version]            app.getVersion()
 * @param {boolean} [options.isPackaged]
 * @param {boolean} [options.ready]             true: app.whenReady() resolves at once; false (default): it never resolves, so a legacy `app.on('ready')` startup does not run
 * @param {Record<string, string>} [options.paths]   app.getPath() answers by name
 * @param {Array<object>} [options.displays]    displays for the screen module ({ id, bounds, workArea, workAreaSize })
 * @param {boolean} [options.online]            net.isOnline()
 */
function createFakeElectron(options = {}) {
  const state = {
    windows: [],
    dialogs: [],
    errorBoxes: [],
    externalUrls: [],
    switches: [],
    appEvents: [],
    preconnects: [],
    webRequestErrorListeners: [],
    permissionHandlers: [],
    menus: [],
    applicationMenu: null,
    clipboard: '',
    powerSaveBlockers: [],
    quitCalls: 0,
    hardwareAcceleration: true,
    loginItem: { openAtLogin: false },
    online: options.online !== false,
    nextMessageBoxResponse: 0,
  };
  const hooks = {
    /** Called with every BrowserWindow right after construction: customise `win.webContents.executeJavaScript` here. */
    onWindowCreated: null,
  };
  let nextWindowId = 1;

  class FakeWebContents extends EventEmitter {
    constructor(owner, id) {
      super();
      this.owner = owner;
      this.id = id;
      this.url = '';
      this.sent = [];
      this.windowOpenHandler = null;
    }

    /** Default: no handler. Tests (or hooks.onWindowCreated) replace it. */
    executeJavaScript() {
      return Promise.reject(new Error('fake electron: webContents.executeJavaScript has no handler'));
    }

    isDestroyed() {
      return this.owner.destroyed;
    }

    getURL() {
      return this.url;
    }

    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }

    send(channel, ...args) {
      this.sent.push({ channel, args });
    }

    setZoomLevel(level) {
      this.zoomLevel = level;
    }

    getZoomLevel() {
      return this.zoomLevel || 0;
    }

    openDevTools() {
      this.devToolsOpened = true;
    }
  }

  class BrowserWindow extends EventEmitter {
    static getAllWindows() {
      return state.windows.filter((win) => !win.destroyed);
    }

    constructor(windowOptions = {}) {
      super();
      this.options = windowOptions;
      this.id = nextWindowId++;
      this.destroyed = false;
      this.visible = false;
      this.maximized = false;
      this.fullScreen = false;
      this.bounds = { x: 0, y: 0, width: windowOptions.width || 800, height: windowOptions.height || 600 };
      this.webContents = new FakeWebContents(this, this.id);
      state.windows.push(this);
      if (hooks.onWindowCreated) hooks.onWindowCreated(this);
    }

    /** Resolves after emitting did-finish-load on a later macrotask, so listeners attached right after the call still hear it. */
    _finishLoad(target) {
      this.webContents.url = String(target);
      return new Promise((resolve) => {
        setImmediate(() => {
          if (!this.destroyed) this.webContents.emit('did-finish-load');
          resolve();
        });
      });
    }

    loadFile(file) {
      this.loadedFile = file;
      return this._finishLoad(`file://${file}`);
    }

    loadURL(url) {
      this.loadedUrl = url;
      return this._finishLoad(url);
    }

    show() {
      this.visible = true;
    }

    showInactive() {
      this.visible = true;
    }

    hide() {
      this.visible = false;
    }

    focus() {
      this.focused = true;
    }

    close() {
      if (this.destroyed) return;
      this.emit('close', { preventDefault() {} });
      this.destroy();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }

    isDestroyed() {
      return this.destroyed;
    }

    isVisible() {
      return this.visible;
    }

    isMaximized() {
      return this.maximized;
    }

    maximize() {
      this.maximized = true;
    }

    isFullScreen() {
      return this.fullScreen;
    }

    setFullScreen(flag) {
      this.fullScreen = Boolean(flag);
    }

    getBounds() {
      return { ...this.bounds };
    }

    setBounds(bounds) {
      this.bounds = { ...this.bounds, ...bounds };
    }

    setTitle(title) {
      this.title = title;
    }
  }

  const ipcListeners = new Map();
  const ipcHandlers = new Map();
  const makeEvent = (extra = {}) => ({ sender: { id: 0 }, senderFrame: null, returnValue: undefined, ...extra });
  const ipcMain = {
    on(channel, listener) {
      if (!ipcListeners.has(channel)) ipcListeners.set(channel, []);
      ipcListeners.get(channel).push(listener);
      return ipcMain;
    },
    once(channel, listener) {
      const wrapper = (...args) => {
        ipcMain.removeListener(channel, wrapper);
        return listener(...args);
      };
      return ipcMain.on(channel, wrapper);
    },
    removeListener(channel, listener) {
      const list = ipcListeners.get(channel) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return ipcMain;
    },
    removeAllListeners(channel) {
      ipcListeners.delete(channel);
      return ipcMain;
    },
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
    handleOnce(channel, handler) {
      ipcHandlers.set(channel, (...args) => {
        ipcHandlers.delete(channel);
        return handler(...args);
      });
    },
    removeHandler(channel) {
      ipcHandlers.delete(channel);
    },
    /** Test helper: registered channels. */
    channels() {
      return { on: [...ipcListeners.keys()], handle: [...ipcHandlers.keys()] };
    },
    /**
     * Test helper: delivers `ipcRenderer.send(channel, ...args)` to the listeners and waits for async listeners.
     * @returns {Promise<object>} the event object the listeners received
     */
    async simulateSend(channel, ...args) {
      const event = makeEvent();
      const results = (ipcListeners.get(channel) || []).map((listener) => listener(event, ...args));
      await Promise.all(results);
      return event;
    },
    /** Test helper: delivers `ipcRenderer.invoke(channel, ...args)` and returns the handler's answer. */
    async simulateInvoke(channel, ...args) {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error(`fake electron: no handler registered for ${channel}`);
      return handler(makeEvent(), ...args);
    },
  };

  const readyPromise = options.ready ? Promise.resolve() : new Promise(() => {});
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: Boolean(options.isPackaged),
    commandLine: {
      appendSwitch(name, value) {
        state.switches.push([name, value]);
      },
      hasSwitch(name) {
        return state.switches.some(([switchName]) => switchName === name);
      },
    },
    getPath(name) {
      return (options.paths && options.paths[name]) || path.join(os.tmpdir(), 'fake-electron', name);
    },
    getName: () => 'GadgetsPOS',
    getVersion: () => options.version || '0.0.0-test',
    getAppPath: () => path.resolve(__dirname, '..', '..'),
    whenReady: () => readyPromise,
    isReady: () => Boolean(options.ready),
    disableHardwareAcceleration() {
      state.hardwareAcceleration = false;
    },
    requestSingleInstanceLock: () => true,
    setLoginItemSettings(settings) {
      state.loginItem = { ...state.loginItem, ...settings };
    },
    getLoginItemSettings: () => ({ ...state.loginItem }),
    setActivationPolicy() {},
    focus() {},
    quit() {
      state.quitCalls += 1;
    },
    exit() {
      state.quitCalls += 1;
    },
    relaunch() {},
    dock: { hide() {}, show() {} },
  });
  const originalAppOn = app.on.bind(app);
  app.on = (event, listener) => {
    state.appEvents.push(event);
    return originalAppOn(event, listener);
  };

  const dialog = {
    showErrorBox(title, content) {
      state.errorBoxes.push({ title, content });
    },
    showMessageBox(...args) {
      state.dialogs.push(args);
      return Promise.resolve({ response: state.nextMessageBoxResponse, checkboxChecked: false });
    },
    showMessageBoxSync(...args) {
      state.dialogs.push(args);
      return state.nextMessageBoxResponse;
    },
  };

  const shell = {
    openExternal(url) {
      state.externalUrls.push(url);
      return Promise.resolve();
    },
    openPath() {
      return Promise.resolve('');
    },
    showItemInFolder() {},
  };

  const defaultSession = {
    webRequest: {
      onErrorOccurred(listener) {
        state.webRequestErrorListeners.push(listener);
      },
      onBeforeRequest() {},
      onHeadersReceived() {},
    },
    setPermissionRequestHandler(handler) {
      state.permissionHandlers.push(handler);
    },
    setPermissionCheckHandler() {},
    preconnect(preconnectOptions) {
      state.preconnects.push(preconnectOptions);
    },
    clearCache: () => Promise.resolve(),
    clearStorageData: () => Promise.resolve(),
  };
  const session = { defaultSession, fromPartition: () => defaultSession };

  const net = {
    isOnline: () => state.online,
    request() {
      throw new Error('fake electron: net.request is not implemented');
    },
    fetch() {
      return Promise.reject(new Error('fake electron: net.fetch is not implemented'));
    },
  };

  const Menu = {
    buildFromTemplate(template) {
      const menu = { template, items: template };
      state.menus.push(menu);
      return menu;
    },
    setApplicationMenu(menu) {
      state.applicationMenu = menu;
    },
    getApplicationMenu: () => state.applicationMenu,
  };

  const defaultDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    workAreaSize: { width: 1920, height: 1040 },
    scaleFactor: 1,
  };
  const displays = options.displays || [defaultDisplay];
  const screen = {
    getPrimaryDisplay: () => displays[0],
    getAllDisplays: () => displays,
    getDisplayMatching: () => displays[0],
  };

  const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false };
  const powerSaveBlocker = {
    start(type) {
      state.powerSaveBlockers.push(type);
      return state.powerSaveBlockers.length;
    },
    stop() {},
    isStarted: () => state.powerSaveBlockers.length > 0,
  };
  const clipboard = {
    writeText(text) {
      state.clipboard = text;
    },
    readText: () => state.clipboard,
  };

  const electron = { app, BrowserWindow, ipcMain, dialog, shell, session, net, Menu, screen, nativeTheme, powerSaveBlocker, clipboard };
  return { electron, state, hooks, ipcMain, app, BrowserWindow };
}

module.exports = { createFakeElectron, interceptModules, createManualClock, silenceConsole, flush };
