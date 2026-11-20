'use strict';

/**
 * The REAL DYMO Connect framework (assets/dymo.connect.framework.js, the file the app ships) running inside a Node `vm`
 * on a small strict XML DOM (./mini-dom.js, built on `sax`), plus an instrumentation layer that records what a script did.
 *
 * Why this exists (lens "dymo-golden"): the T2 golden harness (tests/helpers/vm-dymo.js) compares v1 and v2 on a hand-written
 * fake of the framework. Both sides of a comparison therefore share any mistake of that fake. This module is the second,
 * independent opinion: the framework's own Label class decides what `setObjectText` does, which object a name finds, and
 * what a missing object does (it throws), exactly as in the real hidden window.
 *
 * Not part of the app and not a test (no .test.js in the name).
 *
 * What is replaced: only the two places that talk to DYMO Connect over the network (`getPrinters`, `Label.prototype.print`),
 * and `openLabelXml`/`setObjectText`/`_forceQRCodeUpdate` are wrapped so every call is recorded in order.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FRAMEWORK_FILE = path.join(ROOT, 'assets', 'dymo.connect.framework.js');
const LABELS_DIR = path.join(ROOT, 'labels');

/** The element types the framework treats as label objects (`_allObjectTypes` in the framework source). */
const OBJECT_TYPES = Object.freeze([
  'AddressObject', 'TextObject', 'BarcodeObject', 'ShapeObject', 'CounterObject', 'ImageObject', 'CircularTextObject', 'DateTimeObject', 'QRCodeObject',
]);

const DEFAULT_PRINTER = Object.freeze({ name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true });

/** What Electron 32 reports to the main process when a script throws (the page's own message is not passed on). */
const GENERIC_SCRIPT_ERROR = 'Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.';

const { DOMParser, XMLSerializer, DOMImplementation } = require('./mini-dom');

let compiledFramework = null;
function frameworkScript() {
  if (!compiledFramework) compiledFramework = new vm.Script(fs.readFileSync(FRAMEWORK_FILE, 'utf8'), { filename: 'dymo.connect.framework.js' });
  return compiledFramework;
}

/**
 * Page-side instrumentation. `__record(kind, a, b, c)` is a host function: the host builds the recorded objects, so they live
 * in the host realm (a deepStrictEqual across realms would fail on prototypes).
 */
const INSTRUMENT = `(function () {
  var fw = dymo.label.framework;
  var proto = fw.Label.prototype;
  var record = __record;

  var realOpen = fw.openLabelXml;
  fw.openLabelXml = function (xml) {
    record('open', String(xml));
    try {
      return realOpen.apply(fw, arguments);
    } catch (error) {
      record('error', String(error && error.message));
      throw error;
    }
  };

  var realSetText = proto.setObjectText;
  proto.setObjectText = function (name, value) {
    var result;
    try {
      result = realSetText.apply(this, arguments);
    } catch (error) {
      record('error', String(error && error.message));
      throw error;
    }
    record('text', name, typeof value === 'string' ? value : 'NON-STRING:' + typeof value + ':' + String(value));
    return result;
  };

  // The framework has no _forceQRCodeUpdate: scripts install it. The accessor lets the installed implementation run and records every call.
  var forceImpl;
  Object.defineProperty(proto, '_forceQRCodeUpdate', {
    configurable: true,
    enumerable: false,
    get: function () { return forceImpl; },
    set: function (impl) {
      forceImpl = function (name, text) {
        var result;
        try {
          result = impl.call(this, name, text);
        } catch (error) {
          record('error', String(error && error.message));
          throw error;
        }
        record('qr', name, typeof text === 'string' ? text : 'NON-STRING:' + typeof text + ':' + String(text));
        return result;
      };
    }
  });

  // isDCDLabel() serialises the whole label document on every setObjectText call; the answer cannot change for a label, so it is worked out once.
  var realIsDcd = proto.isDCDLabel;
  proto.isDCDLabel = function () {
    if (this.__dcd === undefined) this.__dcd = realIsDcd.call(this);
    return this.__dcd;
  };

  // Replaces the network calls: print records the label document as it is at print time.
  proto.print = function (printerName, printParamsXml) {
    var known = JSON.parse(__printersJson()).some(function (p) { return p.name === printerName; });
    if (!known) {
      var message = "printLabel(): unknown printer '" + printerName + "'";
      record('error', message);
      throw new Error(message);
    }
    record('print', printerName, printParamsXml === undefined ? 'no-params' : 'params', new XMLSerializer().serializeToString(this._doc));
  };
  fw.getPrinters = function () { return JSON.parse(__printersJson()); };
})()`;

/**
 * @param {object} [options]
 * @param {object[]} [options.printers]       printers `getPrinters()` reports (default: one connected LabelWriter)
 * @param {boolean} [options.nativeQrSetter]  false: remove `Label.prototype._setQRCodeObjectText`, as in an older framework
 */
function createRealDymo(options = {}) {
  const printers = (options.printers || [DEFAULT_PRINTER]).map((printer) => ({ ...DEFAULT_PRINTER, ...printer }));
  const calls = [];

  const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const sandbox = { DOMParser, XMLSerializer, console: silent, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { implementation: new DOMImplementation(), createElement: () => ({}), getElementsByTagName: () => [], documentElement: {}, location: { href: 'file:///dymo-loader.html' } };
  sandbox.navigator = { userAgent: 'node', platform: 'node', appVersion: '5.0' };
  sandbox.location = { href: 'file:///dymo-loader.html', protocol: 'file:', hostname: '', host: '' };
  sandbox.XMLHttpRequest = function XMLHttpRequest() {
    throw new Error('no network in the test double');
  };
  sandbox.__record = (kind, a, b, c) => {
    if (kind === 'open') calls.push({ type: 'open', xml: a });
    else if (kind === 'text' || kind === 'qr') calls.push({ type: kind, name: a, value: b });
    else if (kind === 'print') calls.push({ type: 'print', printer: a, params: b === 'params', xml: c });
    else calls.push({ type: 'error', message: a });
  };
  sandbox.__printersJson = () => JSON.stringify(printers);

  const context = vm.createContext(sandbox);
  frameworkScript().runInContext(context);
  if (options.nativeQrSetter === false) vm.runInContext('delete dymo.label.framework.Label.prototype._setQRCodeObjectText', context);
  vm.runInContext(INSTRUMENT, context, { filename: 'instrument.js' });

  return {
    context,
    printers,
    /** Everything recorded since the last takeCalls(), in order. */
    takeCalls() {
      return calls.splice(0, calls.length);
    },
    peekCalls: () => calls.slice(),
    /** Runs code in the page. A SyntaxError or a thrown error propagates unchanged. */
    run(code) {
      return new vm.Script(String(code), { filename: 'page-script.js' }).runInContext(context, { timeout: 10_000 });
    },
    /** `webContents.executeJavaScript`: a thrown error rejects with Electron's generic text (the framework's own message is lost). */
    executeJavaScript(code) {
      return new Promise((resolve, reject) => {
        try {
          resolve(this.run(code));
        } catch (error) {
          const rejection = new Error(GENERIC_SCRIPT_ERROR);
          rejection.cause = error;
          reject(rejection);
        }
      });
    },
  };
}


/**
 * The same instrumentation for a REAL Chromium page (golden-fuzz-electron.js): the page keeps the records in `window.__calls`.
 * @param {object[]} [printers]
 * @returns {string} a script for webContents.executeJavaScript, to run once per page, after the framework loaded
 */
function browserPrelude(printers = [DEFAULT_PRINTER]) {
  const list = printers.map((printer) => ({ ...DEFAULT_PRINTER, ...printer }));
  return `(function () {
  window.__calls = [];
  window.__record = function (kind, a, b, c) { window.__calls.push([kind, a, b, c]); };
  window.__printersJson = function () { return ${JSON.stringify(JSON.stringify(list))}; };
})();
${INSTRUMENT}`;
}

/** Turns the `[kind, a, b, c]` records of a browser page into the call objects createRealDymo() records. */
function callsFromRecords(records) {
  return records.map(([kind, a, b, c]) => {
    if (kind === 'open') return { type: 'open', xml: a };
    if (kind === 'text' || kind === 'qr') return { type: kind, name: a, value: b };
    if (kind === 'print') return { type: 'print', printer: a, params: b === 'params', xml: c };
    return { type: 'error', message: a };
  });
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Reading a label document                                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

const items = (list) => Array.from({ length: list.length }, (_, index) => list[index]);

/**
 * The objects of a label document as the framework sees them, in document order, with the state a printer would get.
 * @param {string} xml
 * @returns {Array<{ type: string, name: string, texts?: string[], data?: string|null, holder?: string|null, renderCache?: boolean }>}
 */
function readLabelObjects(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const found = [];
  const walk = (element) => {
    for (const child of items(element.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (OBJECT_TYPES.includes(child.tagName)) found.push(child);
      walk(child);
    }
  };
  walk(doc.documentElement);
  const first = (element, tag) => items(element.getElementsByTagName(tag))[0];
  return found.map((element) => {
    const name = first(element, 'Name');
    const object = { type: element.tagName, name: name ? name.textContent : '' };
    if (element.tagName === 'TextObject' || element.tagName === 'AddressObject') {
      const formatted = first(element, 'FormattedText');
      object.texts = formatted ? items(formatted.getElementsByTagName('Text')).map((text) => text.textContent) : [];
    } else if (element.tagName === 'BarcodeObject') {
      const data = first(element, 'Data');
      object.data = data ? data.textContent : null;
    } else if (element.tagName === 'QRCodeObject') {
      const dataString = first(element, 'DataString');
      const holder = first(element, 'Value');
      object.data = dataString ? dataString.textContent : null;
      object.holder = holder ? holder.textContent : null;
      object.renderCache = items(element.getElementsByTagName('RenderCache')).length > 0;
    }
    return object;
  });
}

const QR_RENAMED = /^(.+)_(\d+)$/;
const stripSuffix = (name) => name.replace(/_\d+$/, '_<ts>');

/**
 * Turns the recorded calls into one record per opened label:
 * `{ ops: [{kind, name, value}], printed, printer, params, error, qr: [...] , applied: string[] }`.
 * `qr-embed` ops are read from the XML a design 2/7 script opens (its QR object renamed `<name>_<digits>`), as in the golden harness spec.
 * `applied` lists every disagreement between an op and the label document at print time (empty = every written value is in the document).
 */
function summarizeLabels(calls) {
  const labels = [];
  let current = null;
  for (const call of calls) {
    if (call.type === 'open') {
      current = { ops: [], printed: false, printer: null, params: false, error: null, qr: [], applied: [], objects: [] };
      labels.push(current);
      // a design 2/7 script renames its QR object to <name>_<digits> before opening the label; only then is there anything to read (a cheap test first: parsing is the slow part)
      if (/<Name>[^<]*_\d+<\/Name>/.test(call.xml)) {
        try {
          for (const object of readLabelObjects(call.xml)) {
            const renamed = object.type === 'QRCodeObject' && QR_RENAMED.exec(object.name);
            if (renamed) current.ops.push({ kind: 'qr-embed', name: renamed[1], value: object.data });
          }
        } catch {
          // ill-formed label XML: the framework itself refused to open it, which is recorded as the label's error
        }
      }
    } else if (!current) {
      continue;
    } else if (call.type === 'text' || call.type === 'qr') {
      current.ops.push({ kind: call.type, name: call.name, value: call.value });
    } else if (call.type === 'print') {
      current.printed = true;
      current.printer = call.printer;
      current.params = call.params;
      try {
        current.objects = readLabelObjects(call.xml);
        current.qr = current.objects
          .filter((object) => object.type === 'QRCodeObject')
          .map((object) => ({ name: stripSuffix(object.name), data: object.data, holder: object.holder, renderCache: object.renderCache }));
        current.applied = appliedProblems(current.ops, current.objects);
      } catch (error) {
        // the label document cannot be serialised to well-formed XML (for example a lone surrogate in a text): DYMO Connect would get a broken label
        current.applied = [`the printed label document is not well-formed XML: ${error.message}`];
      }
    } else if (call.type === 'error' && !current.error) {
      current.error = call.message;
    }
  }
  return labels;
}

/** Every op must be visible in the document that was printed: text in the first text span, barcode data, QR data and value. */
function appliedProblems(ops, objects) {
  const problems = [];
  const byName = new Map(objects.map((object) => [object.name, object]));
  for (const op of ops) {
    const name = op.kind === 'qr-embed' ? [...byName.keys()].find((key) => key.replace(/_\d+$/, '') === op.name && /_\d+$/.test(key)) : op.name;
    const object = byName.get(name);
    if (!object) {
      problems.push(`${op.kind} ${op.name}: the object is not in the printed label`);
      continue;
    }
    let actual;
    if (object.type === 'TextObject' || object.type === 'AddressObject') actual = object.texts[0];
    else actual = object.data;
    if (actual !== op.value) problems.push(`${op.kind} ${op.name}: the label holds ${JSON.stringify(actual)}, the op wrote ${JSON.stringify(op.value)}`);
    if (object.type === 'QRCodeObject') {
      if (object.holder !== op.value) problems.push(`${op.kind} ${op.name}: the QR value holder is ${JSON.stringify(object.holder)}, expected ${JSON.stringify(op.value)}`);
      if (object.renderCache && op.kind === 'qr') problems.push(`${op.name}: a cached QR picture is still there`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Template inventory, read straight from the label files (no framework, no fixture)                          */
/* ---------------------------------------------------------------------------------------------------------- */

const OBJECT_OPENING = new RegExp(`<(${OBJECT_TYPES.join('|')})>`, 'g');
const OBJECT_WITH_NAME = new RegExp(`<(${OBJECT_TYPES.join('|')})>\\s*<Name>([^<]*)</Name>`, 'g');

const inventoryCache = new Map();

/**
 * The addressable objects of a label file, found with plain regular expressions over the file text.
 * `complete` is false when some object element does not start with a <Name> child (then the regexp would under-count).
 * @param {string} file name inside labels/
 */
function templateInventory(file) {
  if (!inventoryCache.has(file)) {
    const text = fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');
    const objects = [...text.matchAll(OBJECT_WITH_NAME)].map((match) => ({ type: match[1], name: match[2] }));
    const opened = [...text.matchAll(OBJECT_OPENING)].length;
    inventoryCache.set(file, { objects, complete: objects.length === opened, opened });
  }
  return inventoryCache.get(file);
}

module.exports = {
  ROOT,
  LABELS_DIR,
  OBJECT_TYPES,
  DEFAULT_PRINTER,
  GENERIC_SCRIPT_ERROR,
  createRealDymo,
  INSTRUMENT,
  browserPrelude,
  callsFromRecords,
  readLabelObjects,
  summarizeLabels,
  templateInventory,
};
