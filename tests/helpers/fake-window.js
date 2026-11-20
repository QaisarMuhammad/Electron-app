'use strict';

/**
 * Fakes for the window, preload and menu tests. Plain Node, no Electron.
 *
 * `createFakeEnv()` builds one consistent world: an `app` that emits `web-contents-created` from inside the
 * BrowserWindow constructor (as Electron does), a BrowserWindow / webContents pair that records every call, a `screen`
 * with configurable displays, a `config` with dot-path get/set, manual timers, and small stand-ins for the modules that
 * other roles write in parallel (security, connectivity, the window registry). The stand-ins follow SPEC section 8:
 *   - security.isAllowedOrigin(url): https origins from a list, `*.domain` entries, false for 'null';
 *   - security.attachGuards(webContents, options): only records the call;
 *   - connectivity: start(url, { mode }), stop(), retryNow(), status();
 *   - registry: a Map from the webContents id to the areas that window may call.
 * A helper that is not named *.test.js is not run by `node --test` (SPEC 2).
 */

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ---------------------------------------------------------------------------------------------------------------------
// Logger, timers
// ---------------------------------------------------------------------------------------------------------------------

/** A logger that records instead of printing. `texts(level)` returns the first argument of every entry of that level. */
function createFakeLog() {
  const entries = [];
  const record = (level) => (...args) => {
    entries.push({ level, args });
  };
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    texts: (level) => entries.filter((entry) => entry.level === level).map((entry) => String(entry.args[0])),
  };
}

/**
 * Manual timers: nothing fires until `advance(ms)` moves the clock. `now()` follows the same clock.
 * Timers have `unref()` like Node's.
 */
function createFakeTimers() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: clock + ms, fn });
      return { id, unref() {}, ref() {} };
    },
    clearTimeout(timer) {
      if (timer && pending.has(timer.id)) pending.delete(timer.id);
    },
    now: () => clock,
    pendingCount: () => pending.size,
    /** Moves the clock forward and runs every timer that becomes due, in order. */
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        pending.delete(id);
        clock = timer.at;
        timer.fn();
      }
      clock = target;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// screen, config, registry
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas  One work area per display; the first is the primary.
 */
function createFakeScreen(workAreas = [{ x: 0, y: 0, width: 1920, height: 1040 }]) {
  const displays = workAreas.map((workArea, index) => ({ id: index + 1, workArea, bounds: workArea }));
  const overlap = (a, b) => {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
  };
  return {
    displays,
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (rect) => displays.reduce((best, display) => (overlap(rect, display.workArea) > overlap(rect, best.workArea) ? display : best), displays[0]),
  };
}

/** A config with dot-path `get(path, fallback)` / `set(path, value)`; `sets` lists every write as [path, value]. */
function createFakeConfig(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const sets = [];
  const walk = (key) => key.split('.');
  return {
    sets,
    get(key, fallback) {
      let node = data;
      for (const part of walk(key)) {
        if (node === null || typeof node !== 'object' || !(part in node)) return fallback;
        node = node[part];
      }
      return node === undefined ? fallback : node;
    },
    set(key, value) {
      sets.push([key, value]);
      const parts = walk(key);
      let node = data;
      for (const part of parts.slice(0, -1)) {
        if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
      }
      node[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value));
    },
    all: () => data,
  };
}

/**
 * The webContentsId -> areas registry of SPEC 6.3. It is a plain Map, exactly what `security.isTrustedSender(event,
 * registry, area)` reads; `calls` additionally records every `set` and `delete` in order.
 */
class FakeRegistry extends Map {
  constructor() {
    super();
    this.calls = [];
  }

  set(id, areas) {
    this.calls.push(['set', id, areas]);
    return super.set(id, areas);
  }

  delete(id) {
    this.calls.push(['delete', id]);
    return super.delete(id);
  }
}

function createFakeRegistry() {
  return new FakeRegistry();
}

// ---------------------------------------------------------------------------------------------------------------------
// Stand-ins for modules written in parallel (security.js, connectivity.js)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Stand-in for `createSecurity()` (SPEC 8, 12): `isAllowedOrigin` accepts an origin or a URL, normalises with
 * `new URL(x).origin` and returns false for 'null'. `attachGuards` records its calls.
 * @param {{ allowedOrigins?: string[] }} [options]  Entries are exact origins or `*.domain`.
 */
function createFakeSecurity({ allowedOrigins = ['https://vendor.societyfiles.com'] } = {}) {
  const attached = [];
  const state = { allowedOrigins: [...allowedOrigins] };
  return {
    state,
    attached,
    isAllowedOrigin(value) {
      let origin;
      try {
        origin = new URL(String(value)).origin;
      } catch {
        return false;
      }
      if (origin === 'null') return false;
      const host = new URL(origin).hostname;
      return state.allowedOrigins.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : entry === origin));
    },
    attachGuards(webContents, options) {
      attached.push({ webContents, options });
    },
  };
}

/**
 * The main-process side of `app:origin-allowed` (SPEC 6.1), reproduced so the preload can be tested against it:
 * the answer comes from the sender frame's origin, always sets `returnValue`, and is false on any error.
 */
function createOriginAllowedHandler(security) {
  return (event) => {
    try {
      event.returnValue = security.isAllowedOrigin(event.senderFrame.origin);
    } catch {
      event.returnValue = false;
    }
  };
}

/** Stand-in for `createConnectivity()` (SPEC 8). */
function createFakeConnectivity() {
  const connectivity = {
    starts: [],
    stops: 0,
    retries: 0,
    running: false,
    start(url, options) {
      connectivity.starts.push({ url, options });
      connectivity.running = true;
    },
    stop() {
      connectivity.stops += 1;
      connectivity.running = false;
    },
    retryNow() {
      connectivity.retries += 1;
    },
    status: () => ({ online: false, attempt: 1, nextRetryInMs: 3000, lastError: null, url: '', reason: 'offline' }),
  };
  return connectivity;
}

// ---------------------------------------------------------------------------------------------------------------------
// Electron classes
// ---------------------------------------------------------------------------------------------------------------------

function createFakeMenu() {
  const built = [];
  return {
    built,
    buildFromTemplate(template) {
      const menu = {
        template,
        popups: [],
        popup(options) {
          menu.popups.push(options);
        },
      };
      built.push(menu);
      return menu;
    },
  };
}

/**
 * A fake `dialog`. `responses` is consumed one per `showMessageBox` call: a number (the clicked button) or a function
 * returning a Promise. `syncResponses` does the same for `showMessageBoxSync`, which answers with the button number.
 */
function createFakeDialog(responses = [], syncResponses = []) {
  const queue = [...responses];
  const syncQueue = [...syncResponses];
  const dialog = {
    calls: [],
    syncCalls: [],
    showMessageBox(window, options) {
      dialog.calls.push({ window, options });
      const next = queue.length > 0 ? queue.shift() : 0;
      return typeof next === 'function' ? next() : Promise.resolve({ response: next, checkboxChecked: false });
    },
    showMessageBoxSync(window, options) {
      dialog.syncCalls.push({ window, options });
      return syncQueue.length > 0 ? syncQueue.shift() : 0;
    },
  };
  return dialog;
}

/**
 * Makes the page of a fake window behave as Electron does when it asks to stay (`beforeunload`, as the Settings page does while a tab
 * has unsaved edits): `close()` emits `close`, then `will-prevent-unload` on its webContents, and the window goes only when nobody
 * prevented the default of that event. `later` lets the renderer answer on the next turn of the event loop, as the real one does.
 *
 * @param {object} win a fake BrowserWindow
 * @param {{ later?: boolean }} [options]
 * @returns {{ unloadEvents: number, closeEvents: number }} what the window has seen so far
 */
function makePageAskToStay(win, { later = false } = {}) {
  const seen = { unloadEvents: 0, closeEvents: 0 };
  const run = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    seen.unloadEvents += 1;
    win.webContents.emit('will-prevent-unload', event);
    if (event.prevented) win.destroy();
  };
  win.close = () => {
    if (win.destroyed) return;
    seen.closeEvents += 1;
    win.emit('close', { preventDefault() {} });
    if (later) setImmediate(run);
    else run();
  };
  return seen;
}

/**
 * Builds the fake Electron world.
 * @param {object} [options]
 * @param {Array} [options.workAreas]  Work areas of the displays (the first is primary).
 * @param {object} [options.config]    Initial config values.
 * @param {string} [options.themeSource] Initial `nativeTheme.themeSource` (the code under test must reset it to 'system').
 */
function createFakeEnv({ workAreas, config: initialConfig = {}, themeSource = 'system', platform = 'win32' } = {}) {
  const app = new EventEmitter();
  app.getVersion = () => '2.0.0-test';
  app.isPackaged = true;
  app.name = 'Gadgets POS';

  let nextContentsId = 1;
  const windows = [];

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.id = nextContentsId++;
      this.url = '';
      this.destroyed = false;
      this.zoomLevel = 0;
      this.calls = [];
      this.sent = [];
      this.loadFailures = [];
      this.session = {};
    }

    getURL() {
      return this.url;
    }

    loadURL(url) {
      this.calls.push(['loadURL', url]);
      this.url = url;
      return this.nextLoad();
    }

    loadFile(file, options) {
      this.calls.push(['loadFile', file, options]);
      const query = options && options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
      this.url = pathToFileURL(file).href + query;
      return this.nextLoad();
    }

    /** Makes the next load reject, like a failed navigation does. */
    nextLoad() {
      const failure = this.loadFailures.shift();
      return failure ? Promise.reject(failure) : Promise.resolve();
    }

    send(channel, ...args) {
      this.sent.push({ channel, args });
    }

    /** The handler the real security module installs (SPEC 12); `windowOpenHandler` is what a test calls. */
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }

    isDestroyed() {
      return this.destroyed;
    }

    setZoomLevel(level) {
      this.calls.push(['setZoomLevel', level]);
      this.zoomLevel = level;
    }

    getZoomLevel() {
      return this.zoomLevel;
    }

    setBackgroundThrottling(allowed) {
      this.calls.push(['setBackgroundThrottling', allowed]);
    }

    reload() {
      this.calls.push(['reload']);
    }

    reloadIgnoringCache() {
      this.calls.push(['reloadIgnoringCache']);
    }

    forcefullyCrashRenderer() {
      this.calls.push(['forcefullyCrashRenderer']);
    }

    toggleDevTools() {
      this.calls.push(['toggleDevTools']);
    }

    copyImageAt(x, y) {
      this.calls.push(['copyImageAt', x, y]);
    }

    downloadURL(url) {
      this.calls.push(['downloadURL', url]);
    }

    inspectElement(x, y) {
      this.calls.push(['inspectElement', x, y]);
    }

    /** The channels that were sent, in order. */
    channels() {
      return this.sent.map((entry) => entry.channel);
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.visible = false;
      this.minimized = false;
      this.maximized = false;
      this.fullScreen = false;
      this.focused = false;
      this.title = options.title || '';
      this.menuRemoved = false;
      this.calls = [];
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.normalBounds = { ...this.bounds };
      windows.push(this);
      // Electron emits this from inside the constructor, before the caller has the window.
      app.emit('web-contents-created', {}, this.webContents);
    }

    loadURL(url) {
      return this.webContents.loadURL(url);
    }

    loadFile(file, options) {
      return this.webContents.loadFile(file, options);
    }

    show() {
      this.calls.push('show');
      this.visible = true;
    }

    showInactive() {
      this.calls.push('showInactive');
      this.visible = true;
    }

    focus() {
      this.calls.push('focus');
      this.focused = true;
    }

    restore() {
      this.calls.push('restore');
      this.minimized = false;
    }

    isMinimized() {
      return this.minimized;
    }

    maximize() {
      this.calls.push('maximize');
      this.maximized = true;
      this.visible = true;
      this.emit('maximize');
    }

    unmaximize() {
      this.maximized = false;
      this.emit('unmaximize');
    }

    isMaximized() {
      return this.maximized;
    }

    setFullScreen(flag) {
      this.calls.push(`setFullScreen:${flag}`);
      this.fullScreen = Boolean(flag);
      this.emit(flag ? 'enter-full-screen' : 'leave-full-screen');
    }

    isFullScreen() {
      return this.fullScreen;
    }

    getBounds() {
      return this.bounds;
    }

    getNormalBounds() {
      return this.normalBounds;
    }

    setTitle(title) {
      this.title = title;
    }

    removeMenu() {
      this.menuRemoved = true;
    }

    isDestroyed() {
      return this.destroyed;
    }

    close() {
      if (this.destroyed) return;
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
      this.webContents.destroyed = true;
      this.webContents.emit('destroyed');
    }
  }

  const screen = createFakeScreen(workAreas);
  const config = createFakeConfig(initialConfig);
  const security = createFakeSecurity();
  const connectivity = createFakeConnectivity();
  const registry = createFakeRegistry();
  const log = createFakeLog();
  const timers = createFakeTimers();
  const Menu = createFakeMenu();
  const dialog = createFakeDialog();
  const clipboard = {
    writes: [],
    writeText(text) {
      clipboard.writes.push(text);
    },
  };
  const nativeTheme = { themeSource, shouldUseDarkColors: false };
  const opened = [];
  const openExternal = (url) => {
    opened.push(url);
    return Promise.resolve();
  };
  const paths = {
    rendererDir: path.join(path.sep, 'app', 'src', 'renderer'),
    preloadDir: path.join(path.sep, 'app', 'src', 'preload'),
    assetsDir: path.join(path.sep, 'app', 'assets'),
  };

  const env = {
    app,
    BrowserWindow: FakeBrowserWindow,
    windows,
    screen,
    config,
    security,
    connectivity,
    registry,
    log,
    timers,
    Menu,
    dialog,
    clipboard,
    nativeTheme,
    opened,
    openExternal,
    paths,
    /** The latest window that was created. */
    lastWindow: () => windows[windows.length - 1],
    /** Dependencies for `createMainWindow`, with optional overrides. */
    mainDeps(overrides = {}) {
      return {
        BrowserWindow: FakeBrowserWindow,
        app,
        screen,
        config,
        security,
        connectivity,
        paths,
        log,
        openExternal,
        registry,
        Menu,
        clipboard,
        dialog,
        nativeTheme,
        isSafeExternalUrl: (url) => /^(https:|mailto:|tel:)/i.test(url),
        isDev: false,
        platform,
        timers,
        now: timers.now,
        ...overrides,
      };
    },
    /** Dependencies for the settings and password windows. `parent` is the main window controller (or null). */
    localDeps(overrides = {}) {
      return {
        BrowserWindow: FakeBrowserWindow,
        app,
        screen,
        registry,
        log,
        paths,
        dialog,
        nativeTheme,
        platform,
        isDev: false,
        getParent: () => null,
        ...overrides,
      };
    },
  };
  return env;
}

module.exports = {
  createFakeEnv,
  createFakeLog,
  createFakeTimers,
  createFakeScreen,
  createFakeConfig,
  createFakeRegistry,
  createFakeSecurity,
  createFakeConnectivity,
  createFakeMenu,
  createFakeDialog,
  makePageAskToStay,
  createOriginAllowedHandler,
};
