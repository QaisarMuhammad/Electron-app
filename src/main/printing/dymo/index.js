'use strict';

/**
 * The DYMO label service (SPEC 8 and 9.4).
 *
 *   const dymo = createDymoService({ createHiddenWindow, labelsDir, readFile, getConfig, log, currencySymbol });
 *   const result = await dymo.print(legacySendBarcodeDataEnvelope);   // -> { ok: true } | { ok: false, code, message, details? }
 *   const { printers, error } = await dymo.listPrinters();            // for Settings
 *   dymo.dispose();                                                   // on quit
 *
 * What it does for one message: validate it, build the label plan (plan.js), read the template (cached), pick the
 * printer (printers.js, list cached for 30 s), and run ONE generated script per label in the hidden DYMO window
 * (script.js, window.js). A repair message with several order items prints one label per item and stops at the first
 * failure. `print` never throws and never rejects: every failure is a Result (src/main/errors.js): `code` is one of
 * INVALID_PAYLOAD, DYMO_UNAVAILABLE, DYMO_NO_PRINTER, DYMO_TEMPLATE_MISSING, DYMO_PRINT_FAILED, `message` is the plain-English
 * text of that code (`userMessage`, which adds "N of M labels were printed." for a repair message that stopped part-way), and
 * `details` holds `{ printed, total, reason }`: `reason` is the technical cause, for example the framework's own message.
 *
 * Performance (SPEC 18b L2, R4): nothing is created until the first label; the window is reused for every label and
 * disposed after 10 idle minutes; the printer list and the template XML are cached.
 */

const path = require('node:path');
const { buildLabelPlan, LabelPayloadError } = require('./plan');
const { buildPrintScript, prepareLabelXml, LIST_PRINTERS_SCRIPT } = require('./script');
const { pickDymoPrinter } = require('./printers');
const { createDymoWindowManager, DymoWindowError, DYMO_IDLE_DISPOSE_MS } = require('./window');
const { currencySymbol: defaultCurrencySymbol } = require('../currency');
const { PrintError, ERROR_CODES, ok, toResult, userMessage, clipDetail } = require('../../errors');

/** The printer list is reused for this long; any failure drops it. */
const PRINTER_CACHE_MS = 30_000;

/** The codes a failed print can end with. Anything else that is thrown (a bug, a system error) is DYMO_PRINT_FAILED. */
const RESULT_CODES = new Set([
  ERROR_CODES.INVALID_PAYLOAD,
  ERROR_CODES.DYMO_UNAVAILABLE,
  ERROR_CODES.DYMO_NO_PRINTER,
  ERROR_CODES.DYMO_TEMPLATE_MISSING,
  ERROR_CODES.DYMO_PRINT_FAILED,
]);

/** No DYMO printer is available. */
class NoPrinterError extends Error {
  constructor() {
    super('DYMO lists no printer.');
    this.name = 'NoPrinterError';
    this.code = ERROR_CODES.DYMO_NO_PRINTER;
  }
}

/** A label file could not be read. */
class TemplateReadError extends Error {
  /**
   * @param {string} file
   * @param {unknown} cause
   */
  constructor(file, cause) {
    super(`The label file ${file} could not be read.`);
    this.name = 'TemplateReadError';
    this.code = ERROR_CODES.DYMO_TEMPLATE_MISSING;
    this.cause = cause;
  }
}

/** DYMO (the framework inside the helper window) refused or failed to print. */
class DymoPrintError extends Error {
  /** @param {string} message the framework's own message */
  constructor(message) {
    super(message);
    this.name = 'DymoPrintError';
    this.code = ERROR_CODES.DYMO_PRINT_FAILED;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const realTimers = { setTimeout, clearTimeout, now: () => Date.now() };

/** A short, customer-data-free description of a message for the log: "label dymo 32x57 design 1". */
const describeLabel = ({ size, design, lab }) => (lab ? 'label dymo lab' : `label dymo ${size} design ${design === null ? 'default' : design}`);

/** printers.dymo.printerName from either the config object (`get(path, fallback)`) or a plain snapshot. */
function configuredPrinterName(config) {
  let value;
  try {
    value = config && typeof config.get === 'function' ? config.get('printers.dymo.printerName', '') : config?.printers?.dymo?.printerName;
  } catch {
    value = '';
  }
  return typeof value === 'string' ? value : '';
}

/**
 * Sample label for Settings > Printers > "Test" on the DYMO printer (SPEC 9.5): 32x57, design 1, sample values.
 * It goes through the same print() path as a real label.
 * @returns {object} a legacy send-barcode-data envelope
 */
function createTestLabelPayload() {
  return {
    size: '32x57',
    design: '1',
    currency: 'GBP',
    barcodefinal: {
      printer: 'dymo',
      title: 'GadgetsPOS test label',
      barcode: '1234567890',
      storage: '128GB',
      network: 'Unlocked',
      ram: '4GB',
      misc_color: 'Black',
      warranty: '12 months',
      conditionObject: { grade: 'New' },
      price: '99.99',
      isSale: false,
    },
  };
}

/**
 * @param {object} options
 * @param {() => any} options.createHiddenWindow  BrowserWindow factory for the hidden helper window (called lazily, see window.js)
 * @param {string} options.labelsDir              folder with the .dymo template files
 * @param {(file: string, encoding: string) => (string | Promise<string>)} options.readFile  e.g. fs.promises.readFile
 * @param {() => any} [options.getConfig]         returns the config object (with get(path, fallback)) or a plain snapshot; read on every label, so a Settings change applies at once
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 * @param {(iso: unknown) => string} [options.currencySymbol]
 * @param {{ setTimeout: Function, clearTimeout: Function, now: () => number }} [options.timers]  injected for tests
 * @param {boolean} [options.stripLineBreaks]  remove line breaks from the templates as v1 did (default true; see prepareLabelXml)
 * @param {string} [options.loaderFile]
 * @param {number} [options.printerCacheMs]
 * @param {number} [options.idleDisposeMs]
 * @param {number} [options.loadTimeoutMs]
 * @param {number} [options.scriptTimeoutMs]
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.readyPollMs]
 */
function createDymoService({
  createHiddenWindow,
  labelsDir,
  readFile,
  getConfig = () => ({}),
  log = {},
  currencySymbol = defaultCurrencySymbol,
  timers = realTimers,
  stripLineBreaks = true,
  loaderFile,
  printerCacheMs = PRINTER_CACHE_MS,
  idleDisposeMs = DYMO_IDLE_DISPOSE_MS,
  loadTimeoutMs,
  scriptTimeoutMs,
  readyTimeoutMs,
  readyPollMs,
} = {}) {
  if (typeof createHiddenWindow !== 'function') throw new TypeError('createDymoService: createHiddenWindow is required');
  if (typeof labelsDir !== 'string' || labelsDir === '') throw new TypeError('createDymoService: labelsDir is required');
  if (typeof readFile !== 'function') throw new TypeError('createDymoService: readFile is required');

  const note = (level, message) => {
    try {
      if (typeof log[level] === 'function') log[level](message);
    } catch {
      // a failing logger must never break printing
    }
  };

  const manager = createDymoWindowManager({ createHiddenWindow, loaderFile, timers, log, idleDisposeMs, loadTimeoutMs, scriptTimeoutMs, readyTimeoutMs, readyPollMs });

  /* ---- template cache: the prepared XML of each file is read once ---- */
  /** @type {Map<string, Promise<string>>} */
  const templates = new Map();
  function loadTemplate(file) {
    if (!templates.has(file)) {
      const loading = Promise.resolve()
        .then(() => readFile(path.join(labelsDir, file), 'utf8'))
        .then((raw) => prepareLabelXml(raw, { stripLineBreaks }), (error) => {
          templates.delete(file); // a failure is not cached: a restored file works on the next label
          throw new TemplateReadError(file, error);
        });
      templates.set(file, loading);
    }
    return templates.get(file);
  }

  /* ---- printer list: cached for 30 s, shared while a fetch is running, dropped on any failure ---- */
  let printerCache = null;
  let printerFetch = null;

  async function fetchPrinters() {
    let raw;
    try {
      raw = await manager.run(LIST_PRINTERS_SCRIPT);
    } catch (error) {
      if (error && error.code === ERROR_CODES.DYMO_UNAVAILABLE) throw error;
      throw new DymoWindowError(`The DYMO helper window did not answer: ${error && error.message}`, error);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.error) throw new DymoWindowError(`DYMO did not return its printer list${parsed && parsed.error ? `: ${parsed.error}` : '.'}`);
    return Array.isArray(parsed.printers) ? parsed.printers : [];
  }

  function refreshPrinters() {
    if (!printerFetch) {
      printerFetch = fetchPrinters()
        .then((printers) => {
          // an empty list is not cached: DYMO Connect may simply not be running yet
          printerCache = printers.length > 0 ? { printers, expires: timers.now() + printerCacheMs } : null;
          return printers;
        })
        .finally(() => {
          printerFetch = null;
        });
    }
    return printerFetch;
  }

  function cachedPrinters() {
    if (printerCache && printerCache.expires > timers.now()) return Promise.resolve(printerCache.printers);
    return refreshPrinters();
  }

  async function choosePrinter() {
    const configured = configuredPrinterName(typeof getConfig === 'function' ? safely(getConfig) : getConfig);
    const { printer, reason } = pickDymoPrinter(await cachedPrinters(), configured);
    if (!printer) throw new NoPrinterError();
    if (configured.trim() !== '' && reason !== 'exact' && reason !== 'contains') {
      note('warn', `The configured DYMO printer was not found; printing to another one (${reason})`);
    }
    return printer;
  }

  /** Runs one label script and checks its JSON answer. */
  async function runLabelScript(script) {
    let raw;
    try {
      raw = await manager.run(script);
    } catch (error) {
      if (error && error.code === ERROR_CODES.DYMO_UNAVAILABLE) throw error;
      throw new DymoPrintError(error && error.message ? error.message : 'The DYMO window did not answer.');
    }
    let outcome = null;
    try {
      outcome = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      outcome = null;
    }
    if (!outcome || outcome.ok !== true) throw new DymoPrintError(outcome && outcome.message ? String(outcome.message) : 'DYMO did not confirm that the label was printed.');
  }

  /**
   * Turns anything thrown while printing into a failure Result. The message is the shared plain-English text of the code;
   * the technical cause (the framework's own message, a file name) goes into `details.reason`, with how many labels of a
   * multi-label message were printed. INVALID_PAYLOAD keeps the specific reason the plan gave: nothing was attempted.
   */
  function failureFrom(error, progress) {
    const code = error && RESULT_CODES.has(error.code) ? error.code : ERROR_CODES.DYMO_PRINT_FAILED;
    if (code === ERROR_CODES.INVALID_PAYLOAD) return toResult(new PrintError(code, error.message));
    const details = { reason: clipDetail(error && error.message) || 'unknown error' };
    if (progress) {
      details.printed = progress.printed;
      details.total = progress.total;
    }
    return toResult(new PrintError(code, undefined, details));
  }

  async function print(payload) {
    const started = timers.now();
    const progress = { printed: 0, total: 0 };
    let label = 'label dymo';
    try {
      if (!isObject(payload) || !isObject(payload.barcodefinal) || payload.barcodefinal.printer !== 'dymo') {
        throw new LabelPayloadError('This is not a DYMO label message.');
      }
      const { plans, summary } = buildLabelPlan(payload, { currencySymbol });
      label = describeLabel(summary);
      progress.total = plans.length;

      const xmlByFile = new Map();
      for (const file of new Set(plans.map((plan) => plan.templateFile))) xmlByFile.set(file, await loadTemplate(file));
      const printer = await choosePrinter();

      for (const plan of plans) {
        const script = buildPrintScript({
          labelXml: xmlByFile.get(plan.templateFile),
          ops: plan.ops,
          printerName: printer.name,
          nameSuffix: String(timers.now()),
        });
        await runLabelScript(script);
        progress.printed += 1;
      }
      note('info', `${label}: ${progress.printed} of ${progress.total} printed in ${timers.now() - started} ms`);
      return ok();
    } catch (error) {
      printerCache = null; // any failure: look the printers up again next time
      const failure = failureFrom(error, progress.total > 0 ? progress : null);
      if (failure.code === ERROR_CODES.DYMO_PRINT_FAILED && !(error instanceof DymoPrintError)) note('error', `${label}: unexpected error: ${failure.details.reason}`);
      note('warn', `${label}: failed (${failure.code}) after ${progress.printed} of ${progress.total} in ${timers.now() - started} ms`);
      return failure;
    }
  }

  /**
   * The DYMO printers, always freshly asked (Settings has a refresh button). `error` says why the list is empty.
   * @returns {Promise<{ printers: Array<{ name: string, modelName: string, printerType: string, isConnected: boolean, isLocal: boolean }>, error?: string }>}
   */
  async function listPrinters() {
    try {
      const printers = await refreshPrinters();
      if (printers.length === 0) return { printers: [], error: userMessage(ERROR_CODES.DYMO_NO_PRINTER) };
      return { printers: printers.map((printer) => ({ ...printer })) };
    } catch {
      printerCache = null;
      return { printers: [], error: userMessage(ERROR_CODES.DYMO_UNAVAILABLE) };
    }
  }

  /** Destroys the hidden window and drops the caches. A later print() builds a new window. */
  function dispose() {
    manager.dispose();
    printerCache = null;
    templates.clear();
  }

  return { print, listPrinters, dispose };
}

/** Calls a function and returns undefined if it throws. */
function safely(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

module.exports = {
  PRINTER_CACHE_MS,
  createDymoService,
  createTestLabelPayload,
};
