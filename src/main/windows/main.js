'use strict';

/**
 * Windows of the desktop shell: the POS window and the helpers the settings and password windows share
 * (SPEC 6.3, 11.1, 11.2, 12, 18b R2/D1/D2/D4/D6).
 *
 * Every Electron class (BrowserWindow, Menu, dialog, screen ...) is injected, so this file never requires `electron`
 * and the whole behaviour runs under plain `node --test` with the fakes in tests/helpers/fake-window.js.
 *
 * The main window shows three kinds of page in ONE window and never a blank one:
 *   loading.html  -> the POS (serverUrl)  -> offline.html when the load fails, the server answers 5xx or the page crashes.
 * A successful connectivity probe (fed through `controller.handleConnectivityStatus`) reloads the POS by itself.
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { attachContextMenu } = require('./contextMenu');

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/** Window title when the page has none (SPEC 18b D4). */
const APP_TITLE = 'GadgetsPOS';

/**
 * `webPreferences.additionalArguments` entry that hands the app version to the sandboxed preloads, which cannot read
 * it from anywhere else. src/preload/app.js and local.js hold a copy of this prefix (a test keeps the three in step).
 */
const VERSION_ARG_PREFIX = '--gadgetspos-version=';

/** `desktop:<area>:*` areas of the main window's local pages (loading and offline), SPEC 6.3. */
const MAIN_WINDOW_AREAS = Object.freeze(['connection', 'window']);

/** Why the main window shows the offline screen. `crashed` covers a dead page renderer (SPEC 11.2). */
const FAILURE_REASONS = Object.freeze(['offline', 'dns', 'refused', 'timeout', 'tls', 'server', 'crashed', 'other']);

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
/** A first-run window starts maximized on a display narrower than this many pixels (SPEC 11.1). */
const MAXIMIZE_BELOW_WIDTH = 1400;
/** Saved bounds count as visible when they overlap a display by at least this much (SPEC 11.1). */
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 100;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 500;
/**
 * Local windows are sized by their content area (the page's viewport is then the same on every platform), so the native
 * frame comes on top: about 28 px of title bar on macOS and 39 px of title bar and borders on Windows. These allowances keep
 * the whole window inside the work area of a small display and centre it correctly; they are not exact frame sizes.
 */
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 48;

const MIN_ZOOM = -3;
const MAX_ZOOM = 5;
/** Half a step is about 10 %, the same step as the built-in zoom roles use. */
const ZOOM_STEP = 0.5;

/** Resize and move events fire continuously while dragging: the position is saved once the drag has stopped. */
const SAVE_DEBOUNCE_MS = 500;
/**
 * The window is shown by `showLoading()`. This is the safety net for a window whose loading screen was never requested and whose
 * `ready-to-show` never arrives (a broken GPU path): it is never invisible.
 */
const SHOW_FALLBACK_MS = 4000;
/** Three crashes within a minute stop the automatic reload (a page that dies on load must not flicker forever). */
const CRASH_LOOP_COUNT = 3;
const CRASH_LOOP_WINDOW_MS = 60000;

/** Chromium's code for a navigation that was cancelled (a new load started, a download began, Esc was pressed). */
const ERR_ABORTED = -3;

/**
 * The window's own colour, shown while the page behind it is still being drawn (SPEC 18b S1: the window is on screen about 300 ms
 * before loading.html is). It is the page's `--bg` of src/renderer/shared/tokens.css in both themes, so no colour changes when the
 * page appears; tests/windows/main.test.js keeps the two files in step.
 */
const LIGHT_BACKGROUND = '#F6F7FB';
const DARK_BACKGROUND = '#0D1720';

const REASON_BY_NAME = new Map([
  ['ERR_INTERNET_DISCONNECTED', 'offline'],
  ['ERR_NETWORK_CHANGED', 'offline'],
  ['ERR_NAME_NOT_RESOLVED', 'dns'],
  ['ERR_CONNECTION_REFUSED', 'refused'],
  ['ERR_CONNECTION_RESET', 'refused'],
  ['ERR_CONNECTION_CLOSED', 'refused'],
  ['ERR_TIMED_OUT', 'timeout'],
  ['ERR_CONNECTION_TIMED_OUT', 'timeout'],
]);

/** The same mapping by Chromium's numeric net error, for the rare event that arrives without a description. */
const REASON_BY_CODE = new Map([
  [-106, 'offline'],
  [-21, 'offline'],
  [-105, 'dns'],
  [-102, 'refused'],
  [-101, 'refused'],
  [-100, 'refused'],
  [-7, 'timeout'],
  [-118, 'timeout'],
  [-107, 'tls'],
  [-113, 'tls'],
]);

// ---------------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Throws one TypeError naming every missing dependency: a forgotten injection must fail loudly at start-up, not on the
 * first right click or the first crash.
 * @param {string} owner
 * @param {object} deps
 * @param {string[]} names
 */
function requireDeps(owner, deps, names) {
  const missing = names.filter((name) => deps[name] === undefined || deps[name] === null);
  if (missing.length > 0) {
    throw new TypeError(`${owner} is missing: ${missing.join(', ')}`);
  }
}

/**
 * Maps a failed main-frame load to the reason shown on the offline page (SPEC 11.2).
 * ERR_CERT_* and ERR_SSL_* are `tls` (the page tells the cashier to check the PC date and time); anything unknown is `other`.
 * @param {{ errorCode?: number, errorDescription?: string }} failure  The `did-fail-load` arguments.
 * @returns {'offline'|'dns'|'refused'|'timeout'|'tls'|'other'}
 */
function classifyLoadFailure({ errorCode, errorDescription } = {}) {
  const name = typeof errorDescription === 'string' ? errorDescription.trim().toUpperCase() : '';
  if (name.startsWith('ERR_CERT_') || name.startsWith('ERR_SSL_')) return 'tls';
  if (REASON_BY_NAME.has(name)) return REASON_BY_NAME.get(name);
  const code = Number(errorCode);
  if (code <= -200 && code >= -299) return 'tls'; // Chromium's certificate error range
  return REASON_BY_CODE.get(code) || 'other';
}

/** @param {unknown} value @returns {number} The zoom level limited to -3..5; anything that is not a number is 0. */
function clampZoom(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) return 0;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
}

/** @param {string} url @returns {boolean} True for the app's own `file:` pages (loading, offline, settings ...). */
function isFileUrl(url) {
  return typeof url === 'string' && /^file:/i.test(url);
}

/**
 * The window title for a page (SPEC 18b D4): the page's own title, or "GadgetsPOS" when it has none. Chromium makes up
 * a title from the address for a page without a <title>, which is not a title worth showing.
 * @param {string} title
 * @param {boolean} [explicitSet]   `false` when the title was synthesised from a file URL.
 * @param {string} [url]            The page address.
 * @returns {string}
 */
function windowTitleFor(title, explicitSet, url) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (text === '' || explicitSet === false) return APP_TITLE;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return APP_TITLE;
  const bare = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (bare !== '' && (text === bare || text === bare.replace(/\/$/, ''))) return APP_TITLE;
  return text;
}

/**
 * The platform application icon (SPEC 18b D6): .ico on Windows, .png on Linux. macOS takes the icon of the app bundle
 * and ignores the window option.
 * @param {NodeJS.Platform} platform
 * @param {string} [assetsDir]
 * @returns {string|undefined}
 */
function resolveWindowIcon(platform, assetsDir) {
  if (!assetsDir) return undefined;
  if (platform === 'win32') return path.join(assetsDir, 'icon.ico');
  if (platform === 'linux') return path.join(assetsDir, 'icon.png');
  return undefined;
}

/** @param {{ shouldUseDarkColors?: boolean }} [nativeTheme] @returns {string} The window background (no white flash in dark mode). */
function windowBackground(nativeTheme) {
  return nativeTheme && nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

/** Origin and path of a URL for the log: never the query string, which can carry tokens. */
function summarizeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin + parsed.pathname : parsed.protocol;
  } catch {
    return 'invalid url';
  }
}

/** Text for the offline page's query string: one line, no control characters, shortened. */
function cleanText(value, max) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** Address for the offline page: origin and path only (a failing OAuth callback must not put its code on screen). */
function displayUrl(url) {
  try {
    const parsed = new URL(String(url));
    return cleanText(parsed.origin + parsed.pathname, 500);
  } catch {
    return '';
  }
}

/**
 * The host of an address for a sentence the cashier reads (never the path or the query, which can carry tokens, and never
 * credentials); '' when it has none. Short enough for the sentence to stay inside the 200 characters of the offline page's query.
 */
function hostLabel(url) {
  try {
    return cleanText(new URL(String(url)).host, 60);
  } catch {
    return '';
  }
}

/** True when both addresses are http(s) and share an origin. */
function sameOrigin(a, b) {
  try {
    const first = new URL(String(a));
    const second = new URL(String(b));
    return /^https?:$/.test(first.protocol) && first.origin === second.origin;
  } catch {
    return false;
  }
}

/** One-line error text for the log. */
function errorText(err) {
  return err && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------------------------------------------------
// Window state (SPEC 11.1)
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {{x:number,y:number,width:number,height:number}|null} Whole-number bounds, or null when the value is not usable. */
function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Size of the overlap of two rectangles (zero when they do not touch). */
function overlapOf(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * The display that shows most of `bounds`, provided at least 200x100 px of it is visible there; otherwise null.
 * The work area is used, so a window hidden under the taskbar does not count as visible.
 */
function pickVisibleDisplay(bounds, displays) {
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const overlap = overlapOf(bounds, display.workArea);
    const area = overlap.width * overlap.height;
    if (overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT && area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

/** Moves and shrinks a rectangle so it lies completely inside `area`. */
function clampIntoArea(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Decides where the main window opens (SPEC 11.1).
 *  - Saved bounds are restored only when 200x100 px of them are visible on a connected display (a second monitor may
 *    have been unplugged); they are then pulled fully onto that display.
 *  - Otherwise the window is min(1600, work width) x min(900, work height), centred on the primary display, and starts
 *    maximized when that display is narrower than 1400 px (v1 always opened 1600x900, partly off a small screen).
 * `maximized` and `fullScreen` are applied by the caller after the bounds.
 * @param {{ bounds: object|null, maximized: boolean, fullScreen: boolean, startFullScreen: boolean }} stored
 * @param {Electron.Screen} screen
 * @returns {{ bounds: {x:number,y:number,width:number,height:number}, maximized: boolean, fullScreen: boolean, restored: boolean }}
 */
function resolveWindowState(stored, screen) {
  const fullScreen = stored.fullScreen === true || stored.startFullScreen === true;
  const saved = normalizeBounds(stored.bounds);
  if (saved) {
    const display = pickVisibleDisplay(saved, screen.getAllDisplays());
    if (display) {
      return { bounds: clampIntoArea(saved, display.workArea), maximized: stored.maximized === true, fullScreen, restored: true };
    }
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DEFAULT_WIDTH, area.width);
  const height = Math.min(DEFAULT_HEIGHT, area.height);
  return {
    bounds: {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    },
    maximized: stored.maximized === true || area.width < MAXIMIZE_BELOW_WIDTH,
    fullScreen,
    restored: false,
  };
}

/**
 * Where a settings or password window opens: centred over its parent, kept inside the parent's display.
 * Without a parent it is centred in the work area.
 * @param {{ parentBounds?: object, workArea: object, width: number, height: number }} options
 * @returns {{x:number,y:number}}
 */
function placeLocalWindow({ parentBounds, workArea, width, height }) {
  const anchor = parentBounds || workArea;
  const x = Math.round(anchor.x + (anchor.width - width) / 2);
  const y = Math.round(anchor.y + (anchor.height - height) / 2);
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// webPreferences
// ---------------------------------------------------------------------------------------------------------------------

/** The secure flags every window of the app shares (SPEC 12). */
function secureWebPreferences({ preload, version, isDev }) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    // DevTools exist only in development (SPEC 12): in a packaged app no code path can open them.
    devTools: Boolean(isDev),
    additionalArguments: [`${VERSION_ARG_PREFIX}${version}`],
  };
}

/**
 * Preferences for pages that come from the web: the POS window and every window it opens with `window.open`
 * (src/preload/app.js). Exported so the window-open guard can pass the same flags to the windows it allows.
 * @param {{ preloadDir: string, version: string, isDev?: boolean }} options
 */
function buildRemoteWebPreferences({ preloadDir, version, isDev = false }) {
  return secureWebPreferences({ preload: path.join(preloadDir, 'app.js'), version, isDev });
}

/**
 * Preferences for the app's own pages in the settings and password windows (src/preload/local.js).
 * @param {{ preloadDir: string, version: string, isDev?: boolean }} options
 */
function buildLocalWebPreferences({ preloadDir, version, isDev = false }) {
  return secureWebPreferences({ preload: path.join(preloadDir, 'local.js'), version, isDev });
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry and guards (SPEC 6.3, 12)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the main process remembers about each window so `isTrustedSender` can judge a `desktop:<area>:*` call (SPEC 6.3):
 * a Map from the webContents id to the areas that window may call. It is the same Map that is passed to
 * `security.isTrustedSender(event, registry, area)`. A window with no areas (every page the web opened with
 * `window.open`) can call none.
 * @typedef {Map<number, readonly string[]>} WindowRegistry
 */

const trackedContents = new WeakSet();

/**
 * Records the areas of a webContents in the registry and removes the entry when the webContents is destroyed. Calling it
 * again for the same webContents replaces the areas and keeps one clean-up.
 * @param {WindowRegistry} registry
 * @param {Electron.WebContents} contents
 * @param {readonly string[]} areas  `[]` for a page from the web, the window's areas for a window of local pages.
 */
function registerWebContents(registry, contents, areas) {
  const id = contents.id;
  registry.set(id, Object.freeze([...areas]));
  if (!trackedContents.has(contents)) {
    trackedContents.add(contents);
    contents.once('destroyed', () => registry.delete(id));
  }
}

const guardedApps = new WeakSet();

/**
 * Installs, once per `app`, the listener that every webContents passes through (SPEC 12: "for EVERY webContents,
 * children included"): it attaches the navigation and window-open guards first, then records the contents in the
 * registry without any `desktop:*` area (a page from the web). The windows that own local pages register their areas
 * afterwards. `createMainWindow` calls this, so the integrator must NOT add a second `web-contents-created` listener
 * that calls `security.attachGuards`: a link would be handed to the system browser twice.
 * @param {object} deps
 * @param {Electron.App} deps.app
 * @param {{ attachGuards: Function }} deps.security
 * @param {WindowRegistry} deps.registry
 * @param {(url: string) => (void|Promise<void>)} deps.openExternal
 * @param {(message: string) => void} [deps.notify]  Shows the one-line notice "Opened in your browser: <host>".
 * @param {{ info: Function, error: Function }} deps.log
 * @param {() => object} deps.createChildWindow       BrowserWindow options for a window the page opens with window.open
 *   (the secure flags and the app preload, passed explicitly because a child does not inherit the preload).
 * @returns {boolean} False when the listener was already installed for this app.
 */
function installWebContentsGuards({ app, security, registry, openExternal, notify, log, createChildWindow }) {
  if (guardedApps.has(app)) return false;
  guardedApps.add(app);

  const onBlocked = (info) => {
    const { source = 'navigation', reason = 'blocked', url, host } = info && typeof info === 'object' ? info : {};
    // A refusal for the rate limit carries no address (what a looping page asks for is none of the log's business): the host says enough.
    log.info(`${source} blocked (${reason}): ${url ? summarizeUrl(url) : host || 'no address'}`);
  };

  app.on('web-contents-created', (_event, contents) => {
    try {
      security.attachGuards(contents, { openExternal, onBlocked, notify, createChildWindow });
    } catch (err) {
      log.error('could not attach the navigation guards', errorText(err));
    }
    try {
      registerWebContents(registry, contents, []);
    } catch (err) {
      log.error('could not register a new window', errorText(err));
    }
  });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Building blocks of the main window
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Wraps an event handler so that nothing it throws, or rejects with, reaches the main process: an uncaught exception there
 * opens Electron's error box in front of the till. Failures go to the log.
 * @param {{ error: Function }} log
 * @param {string} label  Names the handler in the log.
 * @param {Function} fn
 * @returns {Function} Returns what `fn` returns (a promise stays a promise), or undefined after a synchronous failure.
 */
function guard(log, label, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error(`${label} failed`, errorText(err)));
      }
      return result;
    } catch (err) {
      log.error(`${label} failed`, errorText(err));
      return undefined;
    }
  };
}

/**
 * One-shot timers addressed by name: starting a name replaces its timer, and no timer keeps the process alive
 * (SPEC 18b R3). The timer functions are injected so tests run on a manual clock.
 * @param {{ setTimeout: Function, clearTimeout: Function }} timers
 */
function createTimerSlots(timers) {
  const slots = new Map();
  function clear(name) {
    if (!slots.has(name)) return;
    timers.clearTimeout(slots.get(name));
    slots.delete(name);
  }
  return {
    start(name, fn, ms) {
      clear(name);
      const timer = timers.setTimeout(() => {
        slots.delete(name);
        fn();
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      slots.set(name, timer);
    },
    clear,
    clearAll() {
      for (const name of [...slots.keys()]) clear(name);
    },
  };
}

/**
 * Saves the window's position, size, maximized and full-screen state into `config` (`window.*`, SPEC 5.1).
 * `saveNow` writes at once (maximize, full screen, close, destroy); `scheduleSave` waits until a drag or a resize has stopped.
 * A value is written only when it changed, so an unchanged window never touches the disk, and a failing write is only logged.
 * @param {object} deps
 * @param {Electron.BrowserWindow} deps.win
 * @param {{ get: Function, set: Function }} deps.config
 * @param {ReturnType<typeof createTimerSlots>} deps.timerSlots
 * @param {{ error: Function }} deps.log
 */
function createWindowStateKeeper({ win, config, timerSlots, log }) {
  const persist = (key, value) => {
    if (JSON.stringify(config.get(key, null)) !== JSON.stringify(value)) config.set(key, value);
  };
  const saveNow = guard(log, 'save window state', () => {
    timerSlots.clear('save');
    if (win.isDestroyed()) return;
    // The NORMAL bounds: after "maximize" or "full screen" the window can return to the size it had before.
    const { x, y, width, height } = win.getNormalBounds();
    persist('window.bounds', { x, y, width, height });
    persist('window.maximized', win.isMaximized());
    persist('window.fullScreen', win.isFullScreen());
  });
  return { saveNow, scheduleSave: () => timerSlots.start('save', saveNow, SAVE_DEBOUNCE_MS) };
}

/**
 * The page zoom (SPEC 12b): the level is saved as `window.zoomLevel` (-3..5 in half steps) and applied again on every main-frame
 * load, because Chromium forgets it when the origin changes.
 * @param {{ contents: Electron.WebContents, config: { get: Function, set: Function } }} deps
 */
function createZoomControl({ contents, config }) {
  const read = () => clampZoom(config.get('window.zoomLevel', 0));
  function apply() {
    if (contents.isDestroyed()) return;
    const level = read();
    if (contents.getZoomLevel() !== level) contents.setZoomLevel(level);
  }
  function change(level) {
    const next = clampZoom(level);
    if (next !== read()) config.set('window.zoomLevel', next);
    apply();
  }
  return {
    apply,
    zoomIn: () => change(read() + ZOOM_STEP),
    zoomOut: () => change(read() - ZOOM_STEP),
    reset: () => change(0),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings and password windows
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} LocalWindowSpec
 * @property {string} page          File inside the renderer directory.
 * @property {string} title
 * @property {number} width         Content width: the page's viewport, without the native frame.
 * @property {number} height        Content height.
 * @property {number} [minWidth]    Minimum content width.
 * @property {number} [minHeight]   Minimum content height.
 * @property {boolean} resizable
 * @property {boolean} minimizable
 * @property {boolean} modal        Blocks its parent while open (only when a parent exists).
 * @property {readonly string[]} areas  `desktop:<area>:*` areas the window may call (SPEC 6.3).
 */

/**
 * Shared engine of the settings and password windows: at most ONE window at a time (a second request focuses it),
 * created on demand and destroyed on close (SPEC 18b R4: never hidden, so it costs no memory while closed), centred
 * over the main window, no menu bar on Windows and Linux, the local preload, registered as a local window.
 * @param {object} deps
 * @param {typeof Electron.BrowserWindow} deps.BrowserWindow
 * @param {Electron.App} deps.app
 * @param {Electron.Screen} deps.screen
 * @param {WindowRegistry} deps.registry
 * @param {{ info: Function, warn: Function, error: Function }} deps.log
 * @param {{ rendererDir: string, preloadDir: string, assetsDir?: string }} deps.paths
 * @param {() => (Electron.BrowserWindow|null)} deps.getParent  The main window (or null); looked up on every open.
 * @param {{ shouldUseDarkColors?: boolean }} [deps.nativeTheme]
 * @param {boolean} [deps.isDev=false]
 * @param {NodeJS.Platform} [deps.platform=process.platform]
 * @param {LocalWindowSpec} spec
 */
function createLocalWindowHost(deps, spec) {
  requireDeps(`createLocalWindowHost(${spec.page})`, deps, ['BrowserWindow', 'app', 'screen', 'registry', 'log', 'paths', 'getParent']);
  const { BrowserWindow, app, screen, registry, log, paths, getParent, nativeTheme, isDev = false, platform = process.platform } = deps;
  let current = null;

  const isOpen = () => current !== null && !current.isDestroyed();

  function focusCurrent() {
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  }

  /** The main window, when it can act as a parent (it must still exist). */
  function usableParent() {
    const parent = getParent();
    return parent && !parent.isDestroyed() ? parent : null;
  }

  /**
   * @param {{ query?: Record<string, string> }} [options]  Query string for the page (`?tab=about`, `?purpose=drawer`).
   * @returns {{ window: Electron.BrowserWindow, created: boolean }}  `created` is false when an open window was focused.
   */
  function open({ query = {} } = {}) {
    if (isOpen()) {
      focusCurrent();
      return { window: current, created: false };
    }

    const parent = usableParent();
    const parentBounds = parent ? (parent.isMinimized() ? parent.getNormalBounds() : parent.getBounds()) : undefined;
    const workArea = (parentBounds ? screen.getDisplayMatching(parentBounds) : screen.getPrimaryDisplay()).workArea;
    const maxWidth = workArea.width - FRAME_WIDTH;
    const maxHeight = workArea.height - FRAME_HEIGHT;
    const width = Math.min(spec.width, maxWidth);
    const height = Math.min(spec.height, maxHeight);
    const options = {
      ...placeLocalWindow({ parentBounds, workArea, width: width + FRAME_WIDTH, height: height + FRAME_HEIGHT }),
      width,
      height,
      useContentSize: true,
      resizable: spec.resizable,
      minimizable: spec.minimizable,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: spec.title,
      backgroundColor: windowBackground(nativeTheme),
      autoHideMenuBar: true,
      webPreferences: buildLocalWebPreferences({ preloadDir: paths.preloadDir, version: app.getVersion(), isDev }),
    };
    if (spec.minWidth) options.minWidth = Math.min(spec.minWidth, maxWidth);
    if (spec.minHeight) options.minHeight = Math.min(spec.minHeight, maxHeight);
    const icon = resolveWindowIcon(platform, paths.assetsDir);
    if (icon) options.icon = icon;
    if (parent) {
      options.parent = parent;
      options.modal = spec.modal;
    }

    const created = new BrowserWindow(options);
    current = created;
    if (platform !== 'darwin') created.removeMenu();
    registerWebContents(registry, created.webContents, spec.areas);
    created.once('ready-to-show', () => {
      if (!created.isDestroyed()) created.show();
    });
    created.once('closed', () => {
      if (current === created) current = null;
    });
    Promise.resolve(created.loadFile(path.join(paths.rendererDir, spec.page), { query })).catch((err) => {
      log.error(`${spec.page} could not be loaded`, errorText(err));
    });
    return { window: created, created: true };
  }

  return {
    open,
    isOpen,
    /** @returns {Electron.BrowserWindow|null} The open window, or null. */
    getWindow: () => (isOpen() ? current : null),
    /** Closes the window (it is destroyed, not hidden). */
    close() {
      if (isOpen()) current.close();
    },
    /** Pushes a message to the page (`desktop:state`, `desktop:password:lockout` ...); ignored while no window is open. */
    send(channel, ...args) {
      if (isOpen()) current.webContents.send(channel, ...args);
    },
    /**
     * Changes only the fragment of the open page's address (`settings.html?tab=printers#drawer`). The page keeps running, so
     * unsaved edits stay, and it can react to `hashchange`. Ignored while no window is open or its page has no address yet, and
     * when the page already shows that fragment.
     */
    setHash(fragment) {
      if (!isOpen()) return;
      const { webContents } = current;
      let target;
      try {
        target = new URL(webContents.getURL());
      } catch {
        return;
      }
      const shown = target.hash;
      target.hash = fragment;
      // The page already shows this tab: loading its own address again is a reload for Chromium, and the unsaved edits would be lost.
      if (target.hash === shown) return;
      Promise.resolve(webContents.loadURL(target.href)).catch((err) => {
        log.warn(`${spec.page} could not change its tab`, errorText(err));
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The main window
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} MainWindowController
 * @property {Electron.BrowserWindow} window
 * @property {() => Promise<void>} showLoading          Shows the window and loading.html in it (call it right after creating the controller).
 * @property {() => Promise<void>} loadPos              Loads the current `serverUrl` (read again on every call).
 * @property {(info?: object) => Promise<void>} showOffline  Shows offline.html and starts the connectivity probe.
 * @property {(options?: { force?: boolean }) => Promise<void>} reload  Reloads the POS page; from an offline screen it loads the POS.
 * @property {() => Promise<unknown>} retryNow          The offline screen's "Retry now": probes at once while reconnecting, otherwise loads the POS again.
 * @property {() => void} focus                         Restores, shows and focuses the window (second instance, tray, drawer).
 * @property {() => void} zoomIn
 * @property {() => void} zoomOut
 * @property {() => void} resetZoom
 * @property {() => void} toggleFullScreen
 * @property {() => void} toggleDevTools                No-op unless the app runs in development.
 * @property {(status: object) => void} handleConnectivityStatus  Feed it from `createConnectivity({ onStatus })`.
 * @property {(event: 'visible'|'painted'|'pos-dom-ready'|'pos-loaded', listener: Function) => MainWindowController} on
 * @property {(event: string, listener: Function) => MainWindowController} off
 * @property {() => void} destroy
 */

/**
 * Creates the main POS window.
 *
 * It saves the position, size, maximized and full-screen state and the zoom level in `config` (`window.*`, SPEC 5.1) and
 * restores them with off-screen protection, shows loading.html first and the POS afterwards, replaces a failed load by
 * the offline screen with automatic reconnection, and gives the cashier a right-click menu. It also installs the
 * app-wide guard listener (see `installWebContentsGuards`).
 *
 * Events of the controller: `visible` (the window was put on screen for the first time: right after the loading screen was
 * requested), `painted` (the first page, the loading screen, has been drawn: Chromium's `ready-to-show`, about 300 ms later),
 * `pos-dom-ready` and `pos-loaded` (the POS itself finished loading: not one of the app's own pages and not the error page of a
 * failed load; they fire again after every full page load).
 *
 * @param {object} deps
 * @param {typeof Electron.BrowserWindow} deps.BrowserWindow
 * @param {Electron.App} deps.app
 * @param {Electron.Screen} deps.screen
 * @param {{ get: Function, set: Function }} deps.config      createConfig() result (SPEC 8).
 * @param {{ attachGuards: Function }} deps.security          createSecurity() result (SPEC 8).
 * @param {{ start: Function, stop: Function }} deps.connectivity  createConnectivity() result (SPEC 8).
 * @param {{ rendererDir: string, preloadDir: string, assetsDir?: string }} deps.paths  Absolute directories.
 * @param {{ info: Function, warn: Function, error: Function }} deps.log
 * @param {(url: string) => (void|Promise<void>)} deps.openExternal  Opens a safe URL in the system browser.
 * @param {WindowRegistry} deps.registry
 * @param {typeof Electron.Menu} deps.Menu                   For the right-click menu (18b D1).
 * @param {Electron.Clipboard} deps.clipboard                For "Copy link address".
 * @param {Electron.Dialog} deps.dialog                      For the "page stopped responding" and "Leave this page?" questions.
 * @param {(url: string) => boolean} deps.isSafeExternalUrl  The app's rule for links that may leave the app.
 * @param {(message: string) => void} [deps.notify]          Shows "Opened in your browser: <host>" (SPEC 12); without it no notice is shown.
 * @param {{ themeSource: string, shouldUseDarkColors?: boolean }} [deps.nativeTheme]  Kept on `system` (18b D6).
 * @param {boolean} [deps.isDev=false]                       Development: DevTools and "Inspect element" exist.
 * @param {NodeJS.Platform} [deps.platform=process.platform]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [deps.timers]
 * @param {() => number} [deps.now=Date.now]
 * @param {() => string} [deps.getServerUrl]                 Overrides `config.get('serverUrl')` (the development start URL).
 * @returns {MainWindowController}
 */
function createMainWindow(deps) {
  requireDeps('createMainWindow', deps, [
    'BrowserWindow',
    'app',
    'screen',
    'config',
    'security',
    'connectivity',
    'paths',
    'log',
    'openExternal',
    'registry',
    'Menu',
    'clipboard',
    'dialog',
    'isSafeExternalUrl',
  ]);
  const {
    BrowserWindow,
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
    isSafeExternalUrl,
    notify,
    nativeTheme,
    isDev = false,
    platform = process.platform,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    getServerUrl,
  } = deps;

  const emitter = new EventEmitter();
  const state = {
    gone: false,
    shown: false,
    /** The offline screen is on display (as opposed to the mid-session banner, which never replaces the page). */
    offlineActive: false,
    /** The connectivity controller was started for the offline screen and is waiting for a successful probe. */
    retrying: false,
    /** `forcefullyCrashRenderer` was called on purpose, so the `render-process-gone` that follows is not a crash. */
    intentionalKill: false,
    hangDialogOpen: false,
    crashTimes: [],
  };
  const timerSlots = createTimerSlots(timers);
  const guarded = (label, fn) => guard(log, label, fn);

  if (nativeTheme) nativeTheme.themeSource = 'system'; // native dialogs follow the operating system (18b D6)

  const version = app.getVersion();
  const remotePreferences = buildRemoteWebPreferences({ preloadDir: paths.preloadDir, version, isDev });
  const icon = resolveWindowIcon(platform, paths.assetsDir);
  installWebContentsGuards({
    app,
    security,
    registry,
    openExternal,
    notify,
    log,
    createChildWindow: () => ({ autoHideMenuBar: true, webPreferences: { ...remotePreferences }, ...(icon ? { icon } : {}) }),
  });

  // -- create the window -----------------------------------------------------------------------------------------------

  const initial = resolveWindowState(
    {
      bounds: config.get('window.bounds', null),
      maximized: config.get('window.maximized', false),
      fullScreen: config.get('window.fullScreen', false),
      startFullScreen: config.get('window.startFullScreen', false),
    },
    screen,
  );
  const windowOptions = {
    ...initial.bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: APP_TITLE,
    backgroundColor: windowBackground(nativeTheme),
    // R2: compiled code is cached eagerly. Background throttling is NOT set here: see `keepPosRunning`.
    webPreferences: { ...remotePreferences, v8CacheOptions: 'bypassHeatCheck' },
  };
  if (icon) windowOptions.icon = icon;

  const win = new BrowserWindow(windowOptions);
  const contents = win.webContents;
  registerWebContents(registry, contents, MAIN_WINDOW_AREAS);

  // -- helpers ---------------------------------------------------------------------------------------------------------

  const isGone = () => state.gone || win.isDestroyed();

  /** A navigation promise rejects when the load fails; `did-fail-load` already handles that, so it is only logged. */
  function settle(promise, label) {
    return Promise.resolve(promise).catch((err) => {
      log.info(`${label} did not finish: ${errorText(err)}`);
    });
  }

  function emit(name, ...args) {
    try {
      emitter.emit(name, ...args);
    } catch (err) {
      log.error(`listener of "${name}" failed`, errorText(err));
    }
  }

  /** The address of the POS: the override or `serverUrl`, accepted only when it is a valid http(s) address. */
  function resolveServerUrl() {
    const raw = getServerUrl ? getServerUrl() : config.get('serverUrl');
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    try {
      return /^https?:$/.test(new URL(text).protocol) ? text : null;
    } catch {
      return null;
    }
  }

  function loadLocalPage(file, query) {
    return settle(win.loadFile(path.join(paths.rendererDir, file), query ? { query } : undefined), file);
  }

  function sendToPage(channel, payload) {
    try {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    } catch (err) {
      log.warn(`could not send ${channel}`, errorText(err));
    }
  }

  const windowState = createWindowStateKeeper({ win, config, timerSlots, log });
  const zoom = createZoomControl({ contents, config });

  // -- showing the window ----------------------------------------------------------------------------------------------

  /**
   * Puts the window on screen, once. `showLoading()` calls it as soon as the loading screen has been requested, and NOT when the
   * page has been drawn: starting the page's renderer process and drawing its first frame takes Chromium about 300 ms, which the
   * app cannot shorten, and a window that waits for it appears about a third of a second later than it could. The window opens in
   * the page's own background colour (see `windowBackground`), as the Electron guide advises for an app that should feel quick,
   * so nothing flashes when the logo appears. `ready-to-show` is the later "the loading screen is drawn" signal (`painted`).
   */
  function showWindow() {
    if (state.shown || isGone()) return;
    state.shown = true;
    timerSlots.clear('show');
    // maximize() and setFullScreen() also display a hidden window, so they run here, in front of show().
    if (initial.maximized) win.maximize();
    if (initial.fullScreen) win.setFullScreen(true);
    win.show();
    emit('visible');
  }

  // -- failures: offline screen, server errors, crashes ---------------------------------------------------------------

  function stopRetrying() {
    if (!state.retrying) return;
    state.retrying = false;
    try {
      connectivity.stop();
    } catch (err) {
      log.warn('could not stop the connectivity probe', errorText(err));
    }
  }

  /**
   * Starts the probe that reloads the POS as soon as the server answers, telling it what failed so its status (and the
   * offline screen's countdown) can say why. Calling it again during an outage only merges the new details: the
   * controller never runs two loops. A crashed page is no connection problem, so it passes no reason or error.
   */
  function startRetrying(reason, info) {
    const url = resolveServerUrl();
    if (!url) return;
    const details = { mode: 'page' };
    if (reason !== 'crashed') {
      details.reason = reason;
      const code = Number(info.code);
      if (Number.isFinite(code)) details.lastError = { code, description: cleanText(info.description, 200) };
    }
    try {
      connectivity.start(url, details);
      state.retrying = true;
    } catch (err) {
      log.error('could not start the connectivity probe', errorText(err));
    }
  }

  /**
   * Shows offline.html (SPEC 11.2) with `?reason=&code=&desc=&url=` and starts the probe that reloads the POS as soon
   * as the server answers. The query values come from the network, so the page must (and does) write them as text.
   * @param {{ reason?: string, code?: string|number, description?: string, url?: string }} [info]
   * @param {{ autoRetry?: boolean }} [options]  `false` shows the screen without reconnecting by itself.
   */
  function showOffline(info = {}, { autoRetry = true } = {}) {
    if (isGone()) return Promise.resolve();
    const query = {
      reason: FAILURE_REASONS.includes(info.reason) ? info.reason : 'other',
      code: cleanText(info.code, 40),
      desc: cleanText(info.description, 200),
      url: displayUrl(info.url || resolveServerUrl() || ''),
    };
    state.offlineActive = true;
    log.warn(`showing the offline screen (${query.reason}${query.code ? `, ${query.code}` : ''})`);

    const shown = loadLocalPage('offline.html', query);
    if (!autoRetry) {
      stopRetrying();
    } else {
      startRetrying(query.reason, info);
    }
    return shown;
  }

  const onDidFailLoad = guarded('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return undefined;
    if (isFileUrl(validatedURL)) {
      // One of the app's own pages is missing: showing another one would loop, so only the log can say so.
      log.error(`a local page could not be loaded (${errorCode} ${errorDescription})`);
      return undefined;
    }
    return showOffline({
      reason: classifyLoadFailure({ errorCode, errorDescription }),
      code: errorCode,
      description: errorDescription,
      url: validatedURL,
    });
  });

  const onDidNavigate = guarded('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    if (!(httpResponseCode >= 500) || !sameOrigin(url, resolveServerUrl())) return undefined;
    return showOffline({ reason: 'server', code: httpResponseCode, description: httpStatusText || 'Server error', url });
  });

  /**
   * The server answered the first load, or a reload, with a redirect to an address the app does not trust. The navigation guards
   * (installed when the window was created, so they run first) have already cancelled it, as SPEC 12 asks, and a cancelled load is
   * neither a failed one nor a finished one: the window would stay on loading.html, or on the offline screen that started the
   * reload, for ever, and the loading screen blames the internet. So the cashier is told, with the one thing they can do.
   *
   * No reconnection: the server is up (a probe counts a redirect as an answer), so it would reload, be sent away again, and
   * loop. "Retry now" still loads the POS again. A redirect that is cancelled while the POS itself is on display (a link inside
   * the page) changes nothing here: the page stays, and the guard has already handed an https link to the system browser.
   */
  const onRedirectBlocked = guarded('will-redirect', (event, ...legacy) => {
    // Electron 25+ puts url and isMainFrame on the event; the positional arguments are the older shape (the guard reads both too).
    const url = typeof event.url === 'string' ? event.url : legacy[0];
    const isMainFrame = typeof event.isMainFrame === 'boolean' ? event.isMainFrame : legacy[2] !== false;
    if (!event.defaultPrevented || !isMainFrame || !isFileUrl(contents.getURL())) return undefined;
    return showOffline(
      {
        reason: 'other',
        code: 'REDIRECT_BLOCKED',
        description: `The server address leads to ${hostLabel(url) || 'another website'}, which GadgetsPOS does not open. Check the address in Settings > Connection.`,
      },
      { autoRetry: false },
    );
  });

  const onRenderProcessGone = guarded('render-process-gone', (_event, details) => {
    const reason = details && details.reason;
    if (reason === 'clean-exit') return undefined;
    if (state.intentionalKill) {
      state.intentionalKill = false;
      return undefined;
    }
    const time = now();
    state.crashTimes = state.crashTimes.filter((at) => time - at < CRASH_LOOP_WINDOW_MS);
    state.crashTimes.push(time);
    const looping = state.crashTimes.length >= CRASH_LOOP_COUNT;
    log.error(`the page process is gone (${reason})`);
    return showOffline(
      {
        reason: 'crashed',
        code: reason,
        description: looping
          ? 'The page keeps stopping. Choose View > Reload, or close GadgetsPOS and open it again.'
          : 'The page stopped responding.',
      },
      { autoRetry: !looping },
    );
  });

  const onUnresponsive = guarded('unresponsive', async () => {
    if (state.hangDialogOpen || isGone()) return;
    state.hangDialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: APP_TITLE,
        message: 'The page stopped responding.',
        detail: 'Choose Reload to try again. Anything on this page that is not saved will be lost.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1 && !isGone()) {
        // A hung renderer cannot reload itself: it is ended first, then the page is loaded into a fresh one.
        state.intentionalKill = true;
        contents.forcefullyCrashRenderer();
        await loadPos();
      }
    } finally {
      state.hangDialogOpen = false;
    }
  });

  /**
   * A page asked to stay (the web app warns while an import is running). Electron would then refuse to close, quit or
   * reload without any prompt, which looks like a frozen window. So the cashier is asked, and "Leave" overrides the page.
   * The synchronous dialog is required: `preventDefault()` must be called before this handler returns.
   */
  const onWillPreventUnload = guarded('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: APP_TITLE,
      message: 'Leave this page?',
      detail: 'Changes you made may not be saved.',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) event.preventDefault();
  });

  // -- public actions --------------------------------------------------------------------------------------------------

  function showLoading() {
    if (isGone()) return Promise.resolve();
    // The page is requested first: starting its renderer is the longest step, and putting the window on screen (a round trip to
    // the window server) then happens while that process starts instead of delaying it.
    const loading = loadLocalPage('loading.html');
    showWindow();
    return loading;
  }

  function loadPos() {
    if (isGone()) return Promise.resolve();
    const url = resolveServerUrl();
    if (!url) {
      return showOffline(
        {
          reason: 'other',
          code: 'INVALID_URL',
          description: 'The server address is not valid. Open Settings > Connection and check it.',
        },
        { autoRetry: false },
      );
    }
    state.offlineActive = false;
    stopRetrying();
    return settle(win.loadURL(url), 'POS page');
  }

  function reload({ force = false } = {}) {
    if (isGone()) return Promise.resolve();
    const url = contents.getURL();
    if (state.offlineActive || !url || isFileUrl(url)) return loadPos();
    if (force) contents.reloadIgnoringCache();
    else contents.reload();
    return Promise.resolve();
  }

  /**
   * "Retry now" of the offline screen (`desktop:connection:retryNow`). While the connectivity probe runs it probes at once, and
   * the POS loads as soon as that probe succeeds. When no probe runs (the page keeps crashing, or the server address is
   * not valid) the connectivity controller has nothing to retry, so the POS is simply loaded again.
   */
  function retryNow() {
    if (isGone()) return Promise.resolve();
    if (state.retrying) return Promise.resolve(connectivity.retryNow());
    return loadPos();
  }

  function focus() {
    if (isGone()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /**
   * Forwards a connectivity status to the pages (`desktop:connection:status` feeds the offline screen's countdown,
   * `connectivity:status` the mid-session banner of the app preload) and, while the offline screen is showing, loads the
   * POS again on the first successful probe. In banner mode the page is NOT reloaded (SPEC 11.3).
   */
  function handleConnectivityStatus(status) {
    if (isGone() || !status || typeof status !== 'object') return;
    sendToPage('desktop:connection:status', status);
    sendToPage('connectivity:status', status);
    if (status.online === true && state.offlineActive && state.retrying) {
      log.info('the server answers again, reloading the POS');
      loadPos();
    }
  }

  function destroy() {
    if (state.gone) return;
    const alive = !win.isDestroyed();
    if (alive) windowState.saveNow();
    state.gone = true;
    timerSlots.clearAll();
    stopRetrying();
    if (alive) win.destroy();
  }

  // -- wiring ----------------------------------------------------------------------------------------------------------

  contents.on('did-fail-load', onDidFailLoad);
  contents.on('did-navigate', onDidNavigate);
  contents.on('will-redirect', onRedirectBlocked);
  contents.on('render-process-gone', onRenderProcessGone);
  contents.on('will-prevent-unload', onWillPreventUnload);
  win.on('unresponsive', onUnresponsive);

  /**
   * True while the page on display is the POS itself: not one of the app's own pages, and not what Chromium shows after
   * a failed load (it finishes loading an error page of its own, whose URL is the failed address).
   */
  const isPosPage = () => !state.offlineActive && !isFileUrl(contents.getURL());

  /**
   * R2: the POS keeps its timers, sockets and order sounds running while the window is minimised or covered. That is switched
   * on once the POS itself is on screen (and again after every load of it), NOT through `webPreferences.backgroundThrottling`:
   * a window created with that option set to false never paints its offline screen when the very first POS load fails (the
   * loading screen is replaced by the error page and then by offline.html; on Electron 32.3.3 `capturePage()` answers an empty
   * image and `requestAnimationFrame` never fires), which is the blank window of v1 that section 11 exists to fix. Started with
   * Electron's default, the loading and offline screens paint, and the POS is never throttled from the moment it has loaded.
   */
  function keepPosRunning() {
    try {
      if (typeof contents.setBackgroundThrottling === 'function' && !contents.isDestroyed()) contents.setBackgroundThrottling(false);
    } catch (err) {
      log.warn('could not stop the page from being throttled', errorText(err));
    }
  }

  const onPageReady = guarded('dom-ready', () => {
    zoom.apply(); // as early as possible, so a saved zoom does not show as a jump after the page has loaded
    if (isPosPage()) {
      keepPosRunning();
      emit('pos-dom-ready');
    }
  });
  const onPageLoaded = guarded('did-finish-load', () => {
    zoom.apply();
    if (isPosPage()) {
      keepPosRunning();
      state.intentionalKill = false;
      emit('pos-loaded');
    }
  });
  contents.on('dom-ready', onPageReady);
  contents.on('did-finish-load', onPageLoaded);

  win.on(
    'page-title-updated',
    guarded('page-title-updated', (event, title, explicitSet) => {
      event.preventDefault();
      win.setTitle(windowTitleFor(title, explicitSet, contents.getURL()));
    }),
  );

  win.on('resize', windowState.scheduleSave);
  win.on('move', windowState.scheduleSave);
  for (const eventName of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'close']) {
    win.on(eventName, windowState.saveNow);
  }
  win.once('closed', () => {
    state.gone = true;
    timerSlots.clearAll();
    stopRetrying();
  });

  win.once(
    'ready-to-show',
    guarded('ready-to-show', () => {
      showWindow(); // already on screen when the loading screen was requested; this covers a window that never asked for it
      emit('painted');
    }),
  );
  timerSlots.start('show', guarded('show window', showWindow), SHOW_FALLBACK_MS);

  attachContextMenu({ webContents: contents, ownerWindow: win, Menu, clipboard, isDev, isSafeExternalUrl, openExternal, log });

  /** @type {MainWindowController} */
  const controller = {
    window: win,
    showLoading,
    loadPos,
    showOffline,
    reload,
    retryNow,
    focus,
    zoomIn() {
      if (!isGone()) zoom.zoomIn();
    },
    zoomOut() {
      if (!isGone()) zoom.zoomOut();
    },
    resetZoom() {
      if (!isGone()) zoom.reset();
    },
    toggleFullScreen() {
      if (!isGone()) win.setFullScreen(!win.isFullScreen());
    },
    toggleDevTools() {
      if (isDev && !contents.isDestroyed()) contents.toggleDevTools();
    },
    handleConnectivityStatus,
    on(name, listener) {
      emitter.on(name, listener);
      return controller;
    },
    off(name, listener) {
      emitter.off(name, listener);
      return controller;
    },
    destroy,
  };
  return controller;
}

module.exports = {
  createMainWindow,
  createLocalWindowHost,
  installWebContentsGuards,
  registerWebContents,
  buildRemoteWebPreferences,
  buildLocalWebPreferences,
  classifyLoadFailure,
  resolveWindowState,
  placeLocalWindow,
  windowTitleFor,
  resolveWindowIcon,
  windowBackground,
  clampZoom,
  APP_TITLE,
  VERSION_ARG_PREFIX,
  MAIN_WINDOW_AREAS,
  FAILURE_REASONS,
};
