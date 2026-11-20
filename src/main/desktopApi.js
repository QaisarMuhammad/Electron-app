'use strict';

/**
 * What the Settings window, the offline page and the password window ask of the main process (SPEC 6.2): one method per
 * `desktop:<area>:<name>` channel. `src/main/ipc.js` maps the channels to these methods and decides WHO may call them; this
 * file decides WHAT they do.
 *
 * Every method answers a Result (`{ ok: true, details? }` or `{ ok: false, code, message, details? }`) except the ones whose
 * answer is data by contract: `getState`, `listPrinters`, `checkForUpdates` (the update status), `copyDiagnostics` (the text) and
 * the connection status. A method never throws.
 *
 * Password rules (SPEC 10): saving the drawer settings, saving the connection (when "ask for the password before Settings opens"
 * is on) and the factory reset all go through `drawer.checkPassword`, which shares ONE throttle with the drawer itself, so five
 * wrong guesses anywhere lock every door. Test prints go through the print service, the exact path a real job takes.
 *
 * Pure Node: everything that touches Electron (windows, the clipboard, the shell, the restart) is injected.
 */

const { ERROR_CODES, PrintError, ok, toResult } = require('./errors');
const { classifyPort, PORT_INVALID_MESSAGE } = require('./printing/transports/win32-port');
const { buildTestReceipt } = require('./printing/receipt');
const { buildTestZpl } = require('./printing/zebra');
const { createTestLabelPayload } = require('./printing/dymo');
const { REASONS } = require('./flags');
const { compatibilityPatch } = require('./gpuGuard');
const { buildDiagnostics } = require('./diagnostics');

/** @param {unknown} value @returns {boolean} true for `{}` and class instances, false for null and arrays */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} code one of ERROR_CODES
 * @param {string} [message] replaces the standard text of the code
 * @param {object} [details]
 * @returns {{ok: false, code: string, message: string, details?: object}}
 */
function failure(code, message, details) {
  return toResult(new PrintError(code, message, details));
}

/**
 * Settings > General says why compatibility mode is on. The flags file stores a machine-readable reason; the page prints it as
 * a sentence, except `manual`, which it words itself.
 *
 * @param {string} reason a value of REASONS, `argument`, or free text
 * @returns {string}
 */
function describeCompatibilityReason(reason) {
  switch (reason) {
    case REASONS.GPU_CRASHES:
      return 'the graphics process stopped working twice within a minute';
    case REASONS.RENDERER_CRASH_AT_START:
      return 'the POS page crashed right after GadgetsPOS started';
    case 'argument':
      return 'this shortcut starts GadgetsPOS with --disable-gpu';
    case '':
    case undefined:
    case null:
    case REASONS.MANUAL:
      return REASONS.MANUAL;
    default:
      return String(reason);
  }
}

/**
 * @param {object} deps
 * @param {string} deps.appName
 * @param {string} deps.version
 * @param {NodeJS.Platform} deps.platform
 * @param {string} deps.arch
 * @param {string} [deps.osRelease]
 * @param {{ electron?: string, chrome?: string, node?: string }} deps.versions
 * @param {boolean} deps.isPackaged
 * @param {{ get: Function, publicState: Function, setPrinter: Function, setConnection: Function, setDrawer: Function, setGeneral: Function, reset: Function, path: string }} deps.config
 * @param {{ checkPassword: Function, setPassword: Function }} deps.drawer
 * @param {{ show: Function, submit: Function, cancel: Function, getLockout: Function, notifyLockout: Function }} deps.passwordPrompt
 * @param {{ open: Function, isOpen: () => boolean }} deps.settingsWindow
 * @param {{ printReceipt: Function, printBarcode: Function, openDrawer: Function }} deps.printService
 * @param {() => Promise<object>} deps.listPrinters `{ system, dymo, dymoError? }`
 * @param {{ read: () => object, write: (patch: object) => object }} deps.flags the flags.json accessors
 * @param {boolean} deps.argvDisableGpu `--disable-gpu` is on the command line
 * @param {boolean} deps.gpuDisabled the GPU is off in THIS run
 * @param {{ startup: () => object }} deps.perf
 * @param {{ status: () => object, checkNow: () => Promise<object>, install: () => boolean }} deps.updater
 * @param {{ status: () => object, notifyNetworkChange: (online: boolean) => void }} deps.connectivity
 * @param {() => ({ retryNow: () => unknown }|null)} deps.getController the main window controller
 * @param {{ userData: string, logsDir: string }} deps.paths
 * @param {(folder: string) => Promise<string>} deps.openPath `shell.openPath`: '' on success, otherwise the error text
 * @param {(text: string) => void} deps.writeClipboard
 * @param {() => void} deps.restart graceful quit and relaunch
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.log]
 */
function createDesktopApi(deps) {
  const {
    appName, version, platform, arch, osRelease, versions, isPackaged,
    config, drawer, passwordPrompt, settingsWindow, printService, listPrinters,
    flags, argvDisableGpu, gpuDisabled, perf, updater, connectivity, getController,
    paths, openPath, writeClipboard, restart, log = {},
  } = deps;

  const note = (level, message) => {
    if (typeof log[level] === 'function') log[level](message);
  };

  /** Hands a password Result back, after telling an open prompt about a lockout it may not know of. */
  function track(result) {
    passwordPrompt.notifyLockout(result);
    return result;
  }

  /** The password gate of Settings and the reset: succeeds at once when no password is set. */
  function check(password) {
    return track(drawer.checkPassword({ password }));
  }

  const passwordSet = () => Boolean(config.get('drawer.passwordRecord', null));

  /** The compatibility-mode part of the state: is hardware acceleration wanted, and if not, why. */
  function performanceState() {
    let stored = {};
    try {
      stored = flags.read();
    } catch {
      stored = {};
    }
    const off = argvDisableGpu || stored.disableGpu === true;
    const reason = !off ? '' : describeCompatibilityReason(stored.disableGpu === true ? stored.reason : 'argument');
    return { hardwareAcceleration: !off, compatibilityReason: reason, startup: perf.startup() };
  }

  // ---- state ----------------------------------------------------------------------------------------------------------

  /** Everything the Settings window shows. The password record never leaves the main process (`publicState`). */
  function getState() {
    return {
      config: config.publicState(),
      platform,
      arch,
      version,
      online: connectivity.status().online !== false,
      update: updater.status(),
      performance: performanceState(),
      paths: { userData: paths.userData, configFile: config.path, logsDir: paths.logsDir },
      versions: { electron: versions.electron, chrome: versions.chrome, node: versions.node },
    };
  }

  // ---- printers -------------------------------------------------------------------------------------------------------

  /**
   * Saves one printer. A port is checked with `classifyPort` first (SPEC 9.1), so Settings refuses a bad one with a clear
   * message instead of saving something that could never print; a port only exists on Windows.
   */
  function savePrinter(role, settings) {
    if (role !== 'dymo' && isObject(settings)) {
      if (settings.transport === 'port') {
        if (platform !== 'win32') return failure(ERROR_CODES.UNSUPPORTED_PLATFORM);
        const classified = classifyPort(settings.port);
        if (classified.kind === 'invalid') return failure(ERROR_CODES.INVALID_SETTINGS, PORT_INVALID_MESSAGE, { reason: classified.reason });
      } else if (settings.transport === 'system' && !(typeof settings.printerName === 'string' && settings.printerName.trim() !== '')) {
        return failure(ERROR_CODES.INVALID_SETTINGS, 'Choose a printer first.');
      }
    }
    return config.setPrinter(role, settings);
  }

  /** A test print of what is SAVED, through the same path as a real job (SPEC 9.5). */
  function testPrint(role, options) {
    if (role === 'receipt') {
      const printer = config.get('printers.receipt', {});
      const bytes = buildTestReceipt({ printerName: printer.printerName || printer.port || '' });
      return printService.printReceipt({ receiptFileBinary: bytes });
    }
    if (role === 'label') {
      const kind = isObject(options) && options.kind !== undefined ? options.kind : 'zebra';
      if (kind !== 'zebra') return Promise.resolve(failure(ERROR_CODES.INVALID_SETTINGS, 'This kind of label printer cannot be tested here.'));
      return printService.printBarcode({ barcodefinal: buildTestZpl() });
    }
    if (role === 'dymo') return printService.printBarcode(createTestLabelPayload());
    return Promise.resolve(failure(ERROR_CODES.INVALID_SETTINGS, 'Choose the receipt printer, the label printer or the DYMO printer.'));
  }

  // ---- cash drawer ----------------------------------------------------------------------------------------------------

  /** Sets or changes the drawer password; the current one is required when one is set. */
  function setDrawerPassword(request) {
    const input = isObject(request) ? request : {};
    return track(drawer.setPassword({ current: input.current, next: input.next }));
  }

  /**
   * Saves the drawer settings. The password that came with the form authorises the change when one is set; it is never stored.
   * Asking for the password before Settings opens makes no sense without a password, so that switch needs one.
   */
  function saveDrawerSettings(request) {
    if (!isObject(request)) return failure(ERROR_CODES.INVALID_SETTINGS);
    const { password, ...values } = request;
    const gate = check(password);
    if (!gate.ok) return gate;
    if (values.requirePasswordForSettings === true && !passwordSet()) {
      return failure(ERROR_CODES.INVALID_SETTINGS, 'Set a drawer password first, then you can ask for it before Settings opens.');
    }
    return config.setDrawer(values);
  }

  /** Settings > Cash drawer > "Open drawer (test)": the real drawer path, password included. */
  async function openDrawerTest(request) {
    const input = isObject(request) ? request : {};
    return track(await printService.openDrawer({ password: input.password }, { source: 'settings-test' }));
  }

  // ---- connection -----------------------------------------------------------------------------------------------------

  /** Saves the server address and the extra domains; the password is needed only when Settings is protected. */
  function saveConnection(request) {
    if (!isObject(request)) return failure(ERROR_CODES.INVALID_SETTINGS);
    if (config.get('drawer.requirePasswordForSettings', false) === true && passwordSet()) {
      const gate = check(request.password);
      if (!gate.ok) return gate;
    }
    return config.setConnection({ serverUrl: request.serverUrl, extraAllowedOrigins: request.extraAllowedOrigins });
  }

  /** "Retry now" and "Reload POS": starts the probe or the reload and answers at once; progress arrives as status pushes. */
  function retryNow() {
    const controller = getController();
    if (!controller) return failure(ERROR_CODES.UNKNOWN);
    Promise.resolve(controller.retryNow()).catch((error) => note('warn', `retry failed (${error && error.message})`));
    return ok();
  }

  /**
   * The browser of one of the app's pages reports that the network is back: a reconnection that is waiting for its next retry
   * probes at once (connectivity.js). Nothing happens while no outage is tracked, and nothing is answered.
   */
  function networkOnline() {
    connectivity.notifyNetworkChange(true);
  }

  /**
   * Opens the single Settings window, on a tab when one is given. When "ask for the password before Settings opens" is on, the
   * password window comes first and Settings follows a correct password. A Settings window that is already open is just
   * brought forward: it was authorised when it opened.
   */
  function openSettings(tab) {
    try {
      if (settingsWindow.isOpen()) {
        settingsWindow.open({ tab });
        return ok();
      }
      if (config.get('drawer.requirePasswordForSettings', false) === true && passwordSet()) {
        passwordPrompt.show('settings', { tab });
        return ok({ prompted: true });
      }
      settingsWindow.open({ tab });
      return ok();
    } catch (error) {
      note('error', `Settings could not be opened (${error && error.message})`);
      return failure(ERROR_CODES.UNKNOWN);
    }
  }

  // ---- general and performance ----------------------------------------------------------------------------------------

  /**
   * Hardware acceleration (SPEC 18b R1). Writes flags.json; Chromium reads it only at the next start, so the answer says a restart
   * is needed unless the choice matches how this run was started. A `--disable-gpu` shortcut argument always wins, so turning
   * acceleration on is refused while it is there.
   */
  function setPerformance(request) {
    if (!isObject(request) || typeof request.hardwareAcceleration !== 'boolean') return failure(ERROR_CODES.INVALID_SETTINGS);
    const wanted = request.hardwareAcceleration;
    if (wanted && argvDisableGpu) {
      return failure(
        ERROR_CODES.INVALID_SETTINGS,
        'This shortcut starts GadgetsPOS with --disable-gpu, so hardware acceleration stays off. Remove that part from the shortcut first.',
      );
    }
    try {
      flags.write(compatibilityPatch(!wanted));
    } catch (error) {
      note('error', `flags.json could not be written (${error && error.message})`);
      return failure(ERROR_CODES.UNKNOWN, 'The setting could not be saved. Check that the disk is not full or write-protected, then try again.');
    }
    const willBeOff = !wanted;
    return { ok: true, restartRequired: willBeOff !== gpuDisabled };
  }

  /** The factory reset: needs the drawer password when one is set, and erases every setting, the password included. */
  function resetAll(request) {
    const gate = check(isObject(request) ? request.password : undefined);
    if (!gate.ok) return gate;
    const result = config.reset();
    if (!result.ok) return result;
    note('info', 'all settings were reset to the defaults');
    return ok();
  }

  // ---- logs and diagnostics -------------------------------------------------------------------------------------------

  async function openLogsFolder() {
    try {
      const problem = await openPath(paths.logsDir);
      if (problem) {
        note('warn', `the logs folder could not be opened (${problem})`);
        return failure(ERROR_CODES.UNKNOWN, 'The logs folder could not be opened.');
      }
      return ok();
    } catch (error) {
      note('warn', `the logs folder could not be opened (${error && error.message})`);
      return failure(ERROR_CODES.UNKNOWN, 'The logs folder could not be opened.');
    }
  }

  /** @returns {string} the diagnostics text, which is also put on the clipboard */
  function copyDiagnostics() {
    const state = getState();
    const text = buildDiagnostics({
      appName, version, platform, arch, osRelease, versions,
      packaged: isPackaged,
      paths: state.paths,
      config: state.config,
      online: state.online,
      update: state.update,
      performance: state.performance,
    });
    writeClipboard(text);
    return text;
  }

  return {
    getState,
    listPrinters,
    savePrinter,
    testPrint,
    setDrawerPassword,
    saveDrawerSettings,
    openDrawerTest,
    saveConnection,
    setGeneral: (values) => config.setGeneral(values),
    setPerformance,
    restartApp() {
      restart();
      return ok();
    },
    checkForUpdates: () => updater.checkNow(),
    installUpdate: () => (updater.install() ? ok() : failure(ERROR_CODES.UPDATE_UNAVAILABLE, 'There is no update to install right now.')),
    openLogsFolder,
    copyDiagnostics,
    resetAll,
    connection: {
      getStatus: () => connectivity.status(),
      retryNow,
      networkOnline,
      openSettings,
    },
    password: {
      submit: (value) => passwordPrompt.submit(value),
      cancel: () => passwordPrompt.cancel(),
      getLockout: () => passwordPrompt.getLockout(),
    },
    openSettings,
  };
}

module.exports = { createDesktopApi, describeCompatibilityReason };
