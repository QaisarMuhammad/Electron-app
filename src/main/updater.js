'use strict';

/**
 * Auto-update (SPEC 13): `electron-updater` wired to the app, with a small status machine for Settings > About.
 *
 * - `electron-updater` is NEVER required here. `autoUpdater` is injected as the object or as a zero-argument
 *   function returning it, and that function is called only inside `init()`, which runs 10 s after the POS
 *   finished loading (S1). A disabled updater never loads the module at all.
 * - The updater is a harmless no-op ("disabled") whenever it cannot work: a packaged app without a usable
 *   `app-update.yml`, or a development run without `GADGETSPOS_UPDATE_URL`. A packaged app ignores that variable:
 *   an environment variable must not be able to redirect an installer download.
 * - Nothing here throws into the caller: every entry point catches and turns a failure into the `error` status.
 *
 * Status machine: disabled | checking | none | available | downloading | ready | error, with `version`, `message`
 * and, while downloading, `percent`.
 *
 * Pure Node: Electron, the timers and the environment are injected, so it runs under plain `node --test`.
 */

const nodePath = require('node:path');

/** The first check never comes earlier than this long after the process started (SPEC 13). */
const FIRST_CHECK_MIN_UPTIME_MS = 30 * 1000;

/** Interval between checks after the first one (SPEC 13). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Test hook for a development run (SPEC 13): an https feed URL, honoured only when the app is NOT packaged. */
const UPDATE_URL_ENV = 'GADGETSPOS_UPDATE_URL';

/** The values of `status` (SPEC 6.2). */
const STATUSES = Object.freeze(['disabled', 'checking', 'none', 'available', 'downloading', 'ready', 'error']);

const MAX_ERROR_MESSAGE_LENGTH = 160;

// ---------------------------------------------------------------------------------------------
// The feed URL
// ---------------------------------------------------------------------------------------------

/**
 * Reads the `url:` line of an `app-update.yml` (SPEC 13). electron-builder writes the file from
 * `build.publish[0]`; one pattern is enough, so there is no YAML dependency. The value may be unquoted, single
 * quoted or double quoted, and may be followed by a ` # comment`. Only a top-level key counts.
 *
 * @param {unknown} text the content of `<resources>/app-update.yml`
 * @returns {string|null} the URL, or null when there is no `url:` line or it is empty
 */
function parseFeedUrl(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^url[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    const quoted = /^(["'])(.*?)\1/.exec(value);
    // In YAML a # starts a comment at the start of the value or after whitespace; inside a URL it is a fragment.
    const url = (quoted ? quoted[2] : value.replace(/(^|[ \t])#.*$/, '')).trim();
    return url === '' ? null : url;
  }
  return null;
}

/**
 * The `readFeedUrl` the updater is injected with in production.
 *
 * @param {Object} options
 * @param {{ readFileSync: (path: string, encoding: string) => string }} options.fs
 * @param {string} options.resourcesPath `process.resourcesPath`
 * @returns {() => string|null} reads `<resourcesPath>/app-update.yml`; null when it is missing or unreadable
 */
function createFeedUrlReader({ fs, resourcesPath }) {
  return function readFeedUrl() {
    try {
      return parseFeedUrl(fs.readFileSync(nodePath.join(resourcesPath, 'app-update.yml'), 'utf8'));
    } catch {
      return null;
    }
  };
}

/**
 * @param {unknown} value
 * @returns {boolean} true for `https://host...`; the parser would also accept `https:///host` and `https:host`,
 *   which are not what anybody meant to write
 */
function isHttpsUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/[^/\s]/i.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} log an electron-log style logger, or nothing
 * @returns {{ info: Function, warn: Function, error: Function }} a logger that never throws
 */
function createLogger(log) {
  const call = (level) => (...args) => {
    try {
      if (log && typeof log[level] === 'function') log[level](...args);
    } catch {
      // Logging must never break the code that logs.
    }
  };
  return { info: call('info'), warn: call('warn'), error: call('error') };
}

/**
 * Lets the process exit even while the timer is pending (R3).
 *
 * @template T
 * @param {T} handle a timer handle; fakes may return a plain number
 * @returns {T}
 */
function unref(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Runs `fn` every `ms` with whatever timers were injected: `setInterval` when there is one, otherwise a
 * `setTimeout` that re-arms itself. Every handle is unref()ed.
 *
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval?: Function, clearInterval?: Function }} clock
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void} cancels the repetition
 */
function repeat(clock, fn, ms) {
  if (typeof clock.setInterval === 'function') {
    const handle = unref(clock.setInterval(fn, ms));
    return () => (typeof clock.clearInterval === 'function' ? clock.clearInterval(handle) : clock.clearTimeout(handle));
  }
  let handle = null;
  const arm = () => {
    handle = unref(clock.setTimeout(() => {
      arm();
      fn();
    }, ms));
  };
  arm();
  return () => clock.clearTimeout(handle);
}

/** @param {unknown} info an electron-updater `UpdateInfo` @returns {string|undefined} its version */
function versionOf(info) {
  return info && typeof info.version === 'string' ? info.version : undefined;
}

/**
 * @param {unknown} error whatever an update check failed with
 * @returns {string} one plain sentence for Settings > About (the full error goes to the log)
 */
function describeUpdateError(error) {
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : error;
  const firstLine = String(raw ?? '').split('\n')[0].trim();
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT/i.test(firstLine)) {
    return 'Could not reach the update server. Check the internet connection and try again.';
  }
  return firstLine ? `The update check failed: ${firstLine.slice(0, MAX_ERROR_MESSAGE_LENGTH)}` : 'The update check failed.';
}

// ---------------------------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} UpdateStatus
 * @property {'disabled'|'checking'|'none'|'available'|'downloading'|'ready'|'error'} status
 * @property {string} [version] the version found, downloading or ready
 * @property {string} [message] why updates are disabled, or what failed (plain English)
 * @property {number} [percent] download progress, 0-100, while `downloading`
 */

/**
 * @param {Object} options
 * @param {object|(() => object)} options.autoUpdater electron-updater's `autoUpdater`, or a function returning it;
 *   the function is called at most once, inside `init()`
 * @param {{ isPackaged?: boolean, getVersion?: () => string }} [options.app]
 * @param {(() => object)|object} [options.getConfig] the config (`get(path, fallback)` or a plain snapshot);
 *   `updates.autoDownload` defaults to true
 * @param {{ showMessageBox: Function }} [options.dialog] Electron's `dialog`
 * @param {object} [options.log] electron-log; also handed to electron-updater as its logger
 * @param {boolean} [options.isPackaged] production build; when omitted `app.isPackaged`, and when that is also
 *   unknown the strict `true`
 * @param {() => string|null} [options.readFeedUrl] the `url:` of `<resources>/app-update.yml` (see createFeedUrlReader)
 * @param {Record<string, string|undefined>} [options.env] defaults to `process.env`
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval?: Function, clearInterval?: Function }} [options.timers]
 *   `setInterval` is optional: without it the 4 h repetition is a `setTimeout` that re-arms itself
 * @param {() => number} [options.uptimeMs] milliseconds since the process started, for example
 *   `() => process.uptime() * 1000`. With it the first check is "never earlier than 30 s after the start" exactly;
 *   without it the 30 s are counted from `init()`, which is never earlier either (SPEC 13)
 * @param {() => object|null} [options.getWindow] the window the restart dialog attaches to; none = a free-standing dialog
 * @param {(status: UpdateStatus) => void} [options.onStatus] called on every status change (see also `subscribe`)
 * @returns {{
 *   init: () => UpdateStatus,
 *   checkNow: () => Promise<UpdateStatus>,
 *   install: () => boolean,
 *   status: () => UpdateStatus,
 *   subscribe: (listener: (status: UpdateStatus) => void) => (() => void),
 *   dispose: () => void
 * }}
 */
function createUpdater({
  autoUpdater,
  app,
  getConfig,
  dialog,
  log,
  isPackaged,
  readFeedUrl,
  env = process.env,
  timers,
  uptimeMs,
  getWindow,
  onStatus,
} = {}) {
  const logger = createLogger(log);
  const clock = timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const packaged = isPackaged !== undefined ? Boolean(isPackaged) : app && typeof app.isPackaged === 'boolean' ? app.isPackaged : true;

  /** @type {Set<(status: UpdateStatus) => void>} */
  const listeners = new Set(typeof onStatus === 'function' ? [onStatus] : []);
  /** @type {Array<[string, Function]>} */
  let attached = [];

  /** @type {UpdateStatus|null} resolved lazily, so a status read never forces anything to load */
  let state = null;
  let gate = null;
  let updater = null;
  let initialized = false;
  let firstTimer = null;
  let cancelRepeat = null;
  let running = null;
  let promptedVersion = null;

  /** @returns {unknown} one config value, or `fallback` while the config is missing, loading or broken */
  function readSetting(path, fallback) {
    try {
      const config = typeof getConfig === 'function' ? getConfig() : getConfig;
      if (!config) return fallback;
      const value =
        typeof config.get === 'function'
          ? config.get(path, fallback)
          : path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), config);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  /**
   * Whether updating can work at all (SPEC 13). A packaged app takes its feed from `app-update.yml` and ignores the
   * environment; an unpackaged one is a no-op unless GADGETSPOS_UPDATE_URL names an https feed.
   *
   * @returns {{ enabled: true, feedUrl: string, viaEnv: boolean } | { enabled: false, reason: string, message: string }}
   */
  function decideGate() {
    const disabled = (reason, message) => ({ enabled: false, reason, message });

    let feedUrl;
    if (packaged) {
      try {
        feedUrl = readFeedUrl ? readFeedUrl() : null;
      } catch {
        feedUrl = null;
      }
      if (!feedUrl) return disabled('no-feed', 'This installation has no update server set up.');
    } else {
      feedUrl = env && typeof env[UPDATE_URL_ENV] === 'string' ? env[UPDATE_URL_ENV].trim() : '';
      if (!feedUrl) return disabled('not-packaged', 'Updates are turned off in development builds.');
    }

    if (!isHttpsUrl(feedUrl)) return disabled('insecure-feed', 'The update server address is not secure, so updates are turned off.');
    if (/CHANGE-ME/i.test(feedUrl)) return disabled('placeholder-feed', 'The update server has not been set up yet.');
    return { enabled: true, feedUrl, viaEnv: !packaged };
  }

  /** @returns {ReturnType<typeof decideGate>} the decision, taken once */
  function getGate() {
    if (gate === null) gate = decideGate();
    return gate;
  }

  /** @returns {UpdateStatus} */
  function current() {
    if (state === null) {
      const decision = getGate();
      state = decision.enabled ? { status: 'none' } : { status: 'disabled', message: decision.message };
    }
    return state;
  }

  /** @returns {UpdateStatus} a copy of the current status */
  function status() {
    return { ...current() };
  }

  /**
   * Moves to a new status. Does nothing (and tells nobody) when nothing changed.
   *
   * @param {UpdateStatus} next
   * @returns {boolean} whether the status changed
   */
  function setStatus(next) {
    const previous = current();
    const merged = { status: next.status };
    for (const key of ['version', 'message', 'percent']) {
      if (next[key] !== undefined) merged[key] = next[key];
    }
    if (['status', 'version', 'message', 'percent'].every((key) => previous[key] === merged[key])) return false;
    state = merged;
    for (const listener of [...listeners]) {
      try {
        listener({ ...merged });
      } catch (error) {
        logger.error('updater: a status listener failed:', error && error.message);
      }
    }
    return true;
  }

  function handleError(error) {
    logger.error('updater: error:', error && error.stack ? error.stack : error);
    setStatus({ status: 'error', message: describeUpdateError(error) });
  }

  /** Asks to restart now or later. Once per version: a later check that finds the same download stays quiet. */
  async function promptRestart(version) {
    if (!dialog || typeof dialog.showMessageBox !== 'function' || promptedVersion === version) return;
    promptedVersion = version;
    try {
      const options = {
        type: 'info',
        title: 'Update ready',
        message: version ? `GadgetsPOS ${version} is ready to install.` : 'A new version of GadgetsPOS is ready to install.',
        detail: 'Restart now to finish the update, or choose Later. It will also be installed the next time you close GadgetsPOS.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const parent = typeof getWindow === 'function' ? getWindow() : null;
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (answer && answer.response === 0) install();
    } catch (error) {
      logger.error('updater: the restart dialog failed:', error && error.message);
    }
  }

  /** Applies the settings of SPEC 13 and the development feed override. */
  function configure(decision) {
    updater.autoDownload = readSetting('updates.autoDownload', true) !== false;
    updater.autoInstallOnAppQuit = true;
    updater.disableWebInstaller = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.logger = log || null;
    if (decision.viaEnv) {
      updater.forceDevUpdateConfig = true;
      updater.setFeedURL(decision.feedUrl);
    }
  }

  /** Removes every listener this module put on electron-updater. */
  function detachEvents() {
    if (updater && typeof updater.removeListener === 'function') {
      for (const [event, handler] of attached) updater.removeListener(event, handler);
    }
    attached = [];
  }

  /** Subscribes to every updater event: each one is logged and moves the status machine. */
  function attachEvents() {
    const on = (event, handler) => {
      updater.on(event, handler);
      attached.push([event, handler]);
    };
    on('checking-for-update', () => {
      logger.info('updater: checking for an update');
      setStatus({ status: 'checking' });
    });
    on('update-available', (info) => {
      logger.info(`updater: version ${versionOf(info)} is available`);
      setStatus({ status: 'available', version: versionOf(info) });
    });
    on('update-not-available', () => {
      logger.info('updater: no update available');
      setStatus({ status: 'none' });
    });
    on('download-progress', (progress) => {
      const percent = Math.min(100, Math.max(0, Math.floor(Number(progress && progress.percent) || 0)));
      const changed = setStatus({ status: 'downloading', version: current().version, percent });
      if (changed && percent % 10 === 0) logger.info(`updater: downloaded ${percent} %`);
    });
    on('update-downloaded', (info) => {
      const version = versionOf(info);
      logger.info(`updater: version ${version} is downloaded`);
      setStatus({ status: 'ready', version });
      void promptRestart(version);
    });
    on('update-cancelled', () => {
      logger.warn('updater: the download was cancelled');
      setStatus({ status: 'none' });
    });
    on('error', handleError);
  }

  /** The first check never comes earlier than 30 s after the start (see `uptimeMs`); then one every 4 h. */
  function scheduleChecks() {
    const sinceStart = typeof uptimeMs === 'function' ? Number(uptimeMs()) : 0;
    const delay = Math.max(0, FIRST_CHECK_MIN_UPTIME_MS - (Number.isFinite(sinceStart) ? sinceStart : 0));
    firstTimer = unref(
      clock.setTimeout(() => {
        firstTimer = null;
        void checkNow();
        cancelRepeat = repeat(clock, () => void checkNow(), CHECK_INTERVAL_MS);
      }, delay),
    );
  }

  /**
   * Prepares the updater. Idempotent, never throws. Disabled updaters stop here without touching
   * `autoUpdater`; an enabled one is resolved (the lazy require happens now), configured, wired to its events and
   * given its timers.
   *
   * @returns {UpdateStatus}
   */
  function init() {
    if (initialized) return status();
    initialized = true;
    try {
      const decision = getGate();
      if (!decision.enabled) {
        logger.info(`updater: disabled (${decision.reason})`);
        return status();
      }
      updater = typeof autoUpdater === 'function' ? autoUpdater() : autoUpdater;
      configure(decision);
      attachEvents();
      scheduleChecks();
      logger.info(`updater: ready (version ${app && typeof app.getVersion === 'function' ? app.getVersion() : 'unknown'}, ${decision.viaEnv ? 'development feed' : 'feed from app-update.yml'})`);
    } catch (error) {
      detachEvents();
      updater = null;
      handleError(error);
    }
    return status();
  }

  async function runCheck() {
    try {
      init();
      if (!getGate().enabled || updater === null) return status();
      const { status: now } = current();
      if (now === 'downloading' || now === 'ready') return status();

      setStatus({ status: 'checking' });
      const result = await updater.checkForUpdates();
      if (result === null || result === undefined) {
        setStatus({ status: 'disabled', message: 'Updates are not available in this build.' });
      } else if (current().status === 'checking') {
        setStatus(result.isUpdateAvailable ? { status: 'available', version: versionOf(result.updateInfo) } : { status: 'none' });
      }
    } catch (error) {
      handleError(error);
    }
    return status();
  }

  /**
   * Checks for an update now (the Settings button and the timers). A check that is already running is joined, not
   * repeated, and nothing is checked while an update is downloading or ready. Never rejects.
   *
   * @returns {Promise<UpdateStatus>}
   */
  function checkNow() {
    if (running === null) {
      running = runCheck().finally(() => {
        running = null;
      });
    }
    return running;
  }

  /**
   * Installs the downloaded update: `quitAndInstall(true, true)` (silent installer, then restart; the default call
   * would open the NSIS wizard). When an update was found but `updates.autoDownload` is off, this starts the
   * download instead and the restart dialog follows. Never throws.
   *
   * @returns {boolean} false when there is nothing to install
   */
  function install() {
    try {
      if (updater === null) return false;
      const { status: now } = current();
      if (now === 'ready') {
        logger.info('updater: restarting to install the update');
        updater.quitAndInstall(true, true);
        return true;
      }
      if (now === 'available' && updater.autoDownload === false) {
        logger.info('updater: downloading the update');
        Promise.resolve(updater.downloadUpdate()).catch(handleError);
        return true;
      }
    } catch (error) {
      handleError(error);
    }
    return false;
  }

  /** @param {(status: UpdateStatus) => void} listener @returns {() => void} unsubscribe */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Stops the timers and detaches from electron-updater (graceful quit, D5). */
  function dispose() {
    if (firstTimer !== null) clock.clearTimeout(firstTimer);
    if (cancelRepeat !== null) cancelRepeat();
    firstTimer = null;
    cancelRepeat = null;
    detachEvents();
    listeners.clear();
  }

  return { init, checkNow, install, status, subscribe, dispose };
}

module.exports = {
  createUpdater,
  createFeedUrlReader,
  parseFeedUrl,
  FIRST_CHECK_MIN_UPTIME_MS,
  CHECK_INTERVAL_MS,
  UPDATE_URL_ENV,
  STATUSES,
};
