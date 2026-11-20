'use strict';

/**
 * DYMO test harness (no Electron, no DYMO software needed).
 *
 *  - parseXml / serializeXml / extractObjects   a tiny XML DOM, enough for DYMO label files
 *  - createFakeDymo(options)                    a fake `dymo` global inside node:vm. It follows the real framework
 *                                               (dymo.connect.framework.js) where it matters: objects are found by
 *                                               the first <Name> of the framework's object element types, a missing
 *                                               object THROWS, a DYMO Connect (<DYMOLabel>) text object keeps its text
 *                                               in the first TextSpan, `_setQRCodeObjectText` is native, `printLabel`
 *                                               looks the printer up by name. Every call is recorded, in order.
 *  - FakeHiddenWindow / createWindowFactory     a BrowserWindow-like object whose executeJavaScript runs the code in
 *                                               the fake (a thrown script error rejects with Electron's generic text)
 *  - goldenOps(payload)                         runs the REAL v1 `send-barcode-data` handler (tests/fixtures/legacy-index.js)
 *                                               against a fake window + the fake framework and returns what it did
 *  - v2Ops(payload)                             the same observation for the v2 plan + script pipeline
 *
 * Both sides are summarised by summarizeCalls() into the same shape, so a golden test is one deepEqual:
 *   { template, printer, ops: [{ kind: 'text' | 'qr' | 'qr-embed', name, value }], printed, error, labels, ... }
 * `qr-embed` is read from the label XML a design 2/7 script opens (its QR object renamed `QRCodeObject0_<digits>`).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createFakeElectron, interceptModules, silenceConsole } = require('./fake-electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LABELS_DIR = path.join(REPO_ROOT, 'labels');
const LEGACY_INDEX = path.join(REPO_ROOT, 'tests', 'fixtures', 'legacy-index.js');

/** The element types the real framework treats as label objects (`_allObjectTypes` in dymo.connect.framework.js). */
const OBJECT_TYPES = Object.freeze([
  'AddressObject',
  'TextObject',
  'BarcodeObject',
  'ShapeObject',
  'CounterObject',
  'ImageObject',
  'CircularTextObject',
  'DateTimeObject',
  'QRCodeObject',
]);

/** What Electron 32 reports to the main process when a script throws: the page's own message is NOT passed on (verified in a real window). */
const GENERIC_SCRIPT_ERROR = 'Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.';

const DEFAULT_PRINTER = Object.freeze({
  name: 'DYMO LabelWriter 450',
  modelName: 'DYMO LabelWriter 450',
  printerType: 'LabelWriterPrinter',
  isConnected: true,
  isLocal: true,
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Mini XML DOM                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

class XmlText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

class XmlElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = ownerDocument;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('NotFoundError: the node is not a child of this element');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  /** Descendants with this tag name, in document order. */
  getElementsByTagName(name) {
    const found = [];
    const walk = (element) => {
      for (const child of element.childNodes) {
        if (child.nodeType !== 1) continue;
        if (name === '*' || child.tagName === name) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

class XmlDocument {
  constructor() {
    this.documentElement = null;
  }

  createTextNode(data) {
    return new XmlText(String(data));
  }

  createElement(name) {
    return new XmlElement(name, this);
  }
}

const ENTITY = '(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos)';

function decodeEntities(text) {
  // a "&" that does not start one of the five predefined (or a numeric) references is malformed XML, as in a browser
  if (new RegExp(`&(?!${ENTITY};)`).test(text)) throw new Error('XML parse error: a "&" that does not start an entity');
  return text.replace(new RegExp(`&(${ENTITY});`, 'g'), (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[entity];
  });
}

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

/**
 * Parses XML text into the mini DOM. Unlike a browser DOMParser (which returns an error document) it THROWS on
 * malformed XML, which makes broken output of a script easy to see in tests.
 * @param {string} source
 * @returns {XmlDocument}
 */
function parseXml(source) {
  const raw = String(source);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // a template file starts with a UTF-8 byte order mark
  const doc = new XmlDocument();
  const stack = [];
  XML_TOKEN.lastIndex = 0;
  let match;
  while ((match = XML_TOKEN.exec(text))) {
    const [, cdata, closing, opening, attributes, selfClosing, characters] = match;
    const parent = stack[stack.length - 1];
    if (cdata !== undefined) {
      if (parent) parent.appendChild(doc.createTextNode(cdata));
    } else if (closing !== undefined) {
      const open = stack.pop();
      if (!open || open.tagName !== closing) throw new Error(`XML parse error: unexpected </${closing}>`);
    } else if (opening !== undefined) {
      const element = doc.createElement(opening);
      for (const attribute of (attributes || '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        element.attributes[attribute[1]] = decodeEntities(attribute[2] ?? attribute[3]);
      }
      if (parent) {
        parent.appendChild(element);
      } else if (doc.documentElement) {
        throw new Error('XML parse error: more than one root element');
      } else {
        doc.documentElement = element;
      }
      if (!selfClosing) stack.push(element);
    } else if (characters !== undefined && parent) {
      parent.appendChild(doc.createTextNode(decodeEntities(characters)));
    } else if (characters !== undefined && characters.trim() !== '') {
      throw new Error('XML parse error: text outside the root element');
    }
  }
  if (stack.length > 0 || !doc.documentElement) throw new Error('XML parse error: the document is not complete');
  return doc;
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function serializeXml(node) {
  if (node.nodeType === 3) return escapeXml(node.data);
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(value).replace(/"/g, '&quot;')}"`)
    .join('');
  if (node.childNodes.length === 0) return `<${node.tagName}${attributes}/>`;
  return `<${node.tagName}${attributes}>${node.childNodes.map(serializeXml).join('')}</${node.tagName}>`;
}

/**
 * Every label object the framework can address, in document order, with its type and name. The name is the text
 * of the FIRST <Name> descendant (what the framework's `_getObjectByNameElement` compares).
 * @param {string} xml
 * @returns {Array<{ name: string, type: string }>}
 */
function extractObjects(xml) {
  const objects = [];
  const walk = (element) => {
    for (const child of element.childNodes) {
      if (child.nodeType !== 1) continue;
      if (OBJECT_TYPES.includes(child.tagName)) {
        const nameElement = child.getElementsByTagName('Name')[0];
        objects.push({ name: nameElement ? nameElement.textContent : '', type: child.tagName });
      }
      walk(child);
    }
  };
  walk(parseXml(xml).documentElement);
  return objects;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Fake DYMO framework                                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {Array<object>} [options.printers]            printers `getPrinters()` reports (defaults to one connected LabelWriter)
 * @param {boolean} [options.nativeQrSetter]            false: the framework has no `Label.prototype._setQRCodeObjectText` (the real one has it)
 * @param {(printerName: string) => string | undefined} [options.failPrint]   return a message to make the print call throw
 */
function createFakeDymo(options = {}) {
  /** @type {Array<{ type: string, [key: string]: any }>} */
  const calls = [];
  const consoleCalls = [];
  const state = {
    printers: (options.printers || [DEFAULT_PRINTER]).map((printer) => ({ ...DEFAULT_PRINTER, ...printer })),
    failPrint: options.failPrint || null,
    frameworkLoaded: true,
  };

  function fail(message) {
    calls.push({ type: 'error', message });
    throw new Error(message);
  }

  const xml = {
    parse: (source) => parseXml(source),
    serialize: (doc) => serializeXml(doc.documentElement || doc),
    getElementText: (element) => (element ? element.textContent : ''),
    getElement: (element, name) => element.getElementsByTagName(name)[0],
    getElements: (element, name) => element.getElementsByTagName(name),
    removeAllChildren(element) {
      while (element.firstChild) element.removeChild(element.firstChild);
    },
    setElementText(element, text) {
      xml.removeAllChildren(element);
      element.appendChild(element.ownerDocument.createTextNode(text));
    },
  };

  class PrinterInfo {
    constructor(spec) {
      Object.assign(this, { printerUri: '', originalPrinterName: '' }, spec);
    }

    isNetworkPrinter() {
      return this.printerUri !== '';
    }
  }

  class Label {
    constructor(source) {
      this._doc = xml.parse(source);
      // the real framework looks for "</DYMOLabel>" in the serialised XML each time; the answer cannot change, so it is worked out once here
      this._dcd = this._doc.documentElement.tagName === 'DYMOLabel' || this._doc.documentElement.getElementsByTagName('DYMOLabel').length > 0;
    }

    getLabelXml() {
      return xml.serialize(this._doc);
    }

    isDCDLabel() {
      return this._dcd;
    }

    _getObjectElements() {
      const objects = [];
      const walk = (element) => {
        for (const child of element.childNodes) {
          if (child.nodeType !== 1) continue;
          if (OBJECT_TYPES.includes(child.tagName)) objects.push(child);
          walk(child);
        }
      };
      walk(this._doc.documentElement);
      return objects;
    }

    _getObjectByNameElement(name) {
      for (const element of this._getObjectElements()) {
        if (xml.getElementText(xml.getElement(element, 'Name')) == name) return element; // eslint-disable-line eqeqeq -- the framework compares loosely
      }
      return fail(`getObjectByNameElement(): no object with name '${name}' was found`);
    }

    _setAddressObjectText(element, text) {
      if (!this.isDCDLabel()) fail('fake framework: only DYMO Connect (<DYMOLabel>) label files are supported');
      const formatted = xml.getElement(element, 'FormattedText');
      const lines = xml.getElements(formatted, 'LineTextSpan');
      const spans = xml.getElements(lines[0], 'TextSpan');
      xml.setElementText(xml.getElement(spans[0], 'Text'), text);
      return this;
    }

    _setBarcodeObjectText(element, text) {
      const data = xml.getElement(element, this.isDCDLabel() ? 'Data' : 'Text');
      if (data) xml.setElementText(data, text);
      return this;
    }

    getObjectNames() {
      return this._getObjectElements().map((element) => xml.getElementText(xml.getElement(element, 'Name')));
    }

    print(printerName, printParamsXml, labelSetXml) {
      framework.printLabel(printerName, printParamsXml, this.getLabelXml(), labelSetXml);
    }
  }

  // The real framework defines _setQRCodeObjectText natively: for a DYMO Connect label it sets the DataString only.
  if (options.nativeQrSetter !== false) {
    Label.prototype._setQRCodeObjectText = function setQrText(element, text) {
      if (!this.isDCDLabel()) return this;
      const data = xml.getElement(element, 'Data');
      const dataString = data && xml.getElement(data, 'DataString');
      if (dataString) xml.setElementText(dataString, text);
      return this;
    };
  }

  // Recorded at the lowest level, so a script that wraps setObjectText is still observed.
  Label.prototype.setObjectText = function setObjectText(name, text) {
    const element = this._getObjectByNameElement(name);
    calls.push({ type: 'text', name, value: text });
    switch (element.tagName) {
      case 'AddressObject':
      case 'TextObject':
        this._setAddressObjectText(element, text);
        break;
      case 'QRCodeObject':
        this._setQRCodeObjectText(element, text);
        break;
      case 'BarcodeObject':
        this._setBarcodeObjectText(element, text);
        break;
      default:
        break;
    }
    return this;
  };

  // `_forceQRCodeUpdate` does not exist in the framework: the script under test installs it. The accessor lets that
  // script's own implementation run, and records every call to it.
  let installedForceUpdate;
  Object.defineProperty(Label.prototype, '_forceQRCodeUpdate', {
    configurable: true,
    enumerable: false,
    get: () => installedForceUpdate,
    set(implementation) {
      installedForceUpdate = function recordedForceUpdate(name, text) {
        calls.push({ type: 'qr', name, value: text });
        return implementation.call(this, name, text);
      };
    },
  });

  function getPrinters() {
    calls.push({ type: 'getPrinters' });
    const collection = [];
    Object.defineProperty(collection, 'byIndex', { enumerable: false, value: [] });
    for (const spec of state.printers) {
      const info = new PrinterInfo(spec);
      collection.push(info);
      collection.byIndex.push(info);
      collection[info.name] = info;
    }
    return collection;
  }

  const framework = {
    Label,
    PrintQuality: { Auto: 'Auto', Text: 'Text', BarcodeAndGraphics: 'BarcodeAndGraphics' },
    getPrinters,
    openLabelXml(source) {
      calls.push({ type: 'open', xml: String(source) });
      try {
        return new Label(source);
      } catch (error) {
        calls.push({ type: 'error', message: error.message });
        throw error;
      }
    },
    createLabelWriterPrintParamsXml(parameters) {
      return `<LabelWriterPrintParams><PrintQuality>${parameters.printQuality}</PrintQuality><Darkness>${parameters.darkness}</Darkness></LabelWriterPrintParams>`;
    },
    printLabel(printerName, printParamsXml, labelXml) {
      if (labelXml === undefined) fail('printLabel(): labelXml parameter should be specified');
      const printer = getPrinters()[printerName || ''];
      if (printer === undefined || printer === null) fail(`printLabel(): unknown printer '${printerName}'`);
      const failure = state.failPrint && state.failPrint(printer.name);
      if (failure) fail(failure);
      calls.push({ type: 'print', printerName: printer.name, hasParams: Boolean(printParamsXml), xml: labelXml });
    },
  };

  const dymo = { xml, label: { framework } };
  const silentConsole = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) silentConsole[level] = (...args) => consoleCalls.push({ level, args });
  const context = vm.createContext({ dymo, console: silentConsole });

  return {
    dymo,
    context,
    calls,
    consoleCalls,
    printers: state.printers,
    get frameworkLoaded() {
      return state.frameworkLoaded;
    },
    /** Models the page before the framework script ran: `dymo` is not a global. */
    setFrameworkLoaded(loaded) {
      state.frameworkLoaded = Boolean(loaded);
      if (loaded) context.dymo = dymo;
      else delete context.dymo;
    },
    setPrinters(printers) {
      state.printers.splice(0, state.printers.length, ...printers.map((printer) => ({ ...DEFAULT_PRINTER, ...printer })));
    },
    setFailPrint(handler) {
      state.failPrint = handler;
    },
    /** Runs code in the page context (sync). A SyntaxError or a thrown error propagates unchanged. */
    run(code) {
      const script = new vm.Script(String(code), { filename: 'dymo-script.js' });
      return script.runInContext(context, { timeout: 5000 });
    },
    /** The labels the recorded calls added up to. */
    labels: () => summarizeCalls(calls),
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Summaries                                                                                                   */
/* ---------------------------------------------------------------------------------------------------------- */

const QR_RENAME = /^(.+)_(\d+)$/;

/** QR objects a design 2/7 script embedded: the object was renamed `<name>_<digits>` and its text rewritten in the XML. */
function embeddedQrObjects(labelXml) {
  if (!labelXml.includes('<QRCodeObject>')) return []; // most labels have no QR object: skip the parse
  let doc;
  try {
    doc = parseXml(labelXml);
  } catch {
    return [];
  }
  const found = [];
  for (const element of doc.documentElement.getElementsByTagName('QRCodeObject')) {
    const name = element.getElementsByTagName('Name')[0]?.textContent ?? '';
    const renamed = QR_RENAME.exec(name);
    if (!renamed) continue;
    const data = element.getElementsByTagName('DataString')[0]?.textContent ?? null;
    const holder = element.getElementsByTagName('Value')[0]?.textContent ?? null;
    found.push({ baseName: renamed[1], name, data, holder });
  }
  return found;
}

/** The QR objects of the label as sent to the printer: what a scanner would read. Rename suffixes are normalised. */
function qrState(labelXml) {
  if (!labelXml.includes('<QRCodeObject>')) return [];
  const doc = parseXml(labelXml);
  return doc.documentElement.getElementsByTagName('QRCodeObject').map((element) => ({
    name: (element.getElementsByTagName('Name')[0]?.textContent ?? '').replace(/_\d+$/, '_<ts>'),
    data: element.getElementsByTagName('DataString')[0]?.textContent ?? null,
    holder: element.getElementsByTagName('Value')[0]?.textContent ?? null,
    hasRenderCache: element.getElementsByTagName('RenderCache').length > 0,
  }));
}

/**
 * Turns the recorded framework calls into one record per opened label.
 * @param {Array<{ type: string }>} calls
 * @returns {Array<{ ops: Array<{kind: string, name: string, value: string}>, printed: boolean, printer: string|null, error: string|null, qr: object[], embeds: object[], printParams?: boolean }>}
 */
function summarizeCalls(calls) {
  const labels = [];
  let current = null;
  for (const call of calls) {
    if (call.type === 'open') {
      current = { ops: [], printed: false, printer: null, error: null, qr: [], embeds: [] };
      labels.push(current);
      for (const embed of embeddedQrObjects(call.xml)) {
        current.ops.push({ kind: 'qr-embed', name: embed.baseName, value: embed.data });
        current.embeds.push(embed);
      }
    } else if (!current) {
      continue;
    } else if (call.type === 'text') {
      current.ops.push({ kind: 'text', name: call.name, value: call.value });
    } else if (call.type === 'qr') {
      current.ops.push({ kind: 'qr', name: call.name, value: call.value });
    } else if (call.type === 'print') {
      current.printed = true;
      current.printer = call.printerName;
      current.printParams = call.hasParams;
      current.qr = qrState(call.xml);
    } else if (call.type === 'error' && !current.error) {
      current.error = call.message;
    }
  }
  return labels;
}

function summarizeRun(calls, extra) {
  const labels = summarizeCalls(calls);
  const first = labels[0];
  const scriptErrors = extra.scriptErrors || [];
  return {
    ...extra,
    printer: first ? first.printer : null,
    ops: first ? first.ops : [],
    printed: labels.length > 0 && labels.every((label) => label.printed),
    // the first framework error of any label, else the first script error (a script that does not even compile never reaches the framework)
    error: labels.map((label) => label.error).find(Boolean) || scriptErrors[0] || null,
    labels,
    calls,
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Fake hidden window                                                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * A BrowserWindow stand-in for the DYMO hidden window.
 * @param {object} [options]
 * @param {'finish'|'fail'|'hang'} [options.load]      what loadFile does: emit did-finish-load (default), emit did-fail-load and reject, or never answer
 * @param {number} [options.frameworkAfterCalls]       how many executeJavaScript calls see no `dymo` global before the framework appears (Infinity: never)
 * @param {object} [options.fake]                      an existing createFakeDymo() to use
 * @param {object} [options.dymo]                      options for a new createFakeDymo()
 */
class FakeHiddenWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.fake = options.fake || createFakeDymo(options.dymo);
    this.loadMode = options.load || 'finish';
    this.frameworkAfterCalls = options.frameworkAfterCalls ?? 0;
    this.destroyed = false;
    this.loaded = false;
    this.loadedFile = null;
    this.scripts = [];
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = (code) => this._execute(code);
    this.webContents.isDestroyed = () => this.destroyed;
    this.fake.setFrameworkLoaded(false);
  }

  loadFile(file) {
    this.loadedFile = file;
    if (this.loadMode === 'hang') return new Promise(() => {});
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        if (this.destroyed) return resolve();
        if (this.loadMode === 'fail') {
          this.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', `file://${file}`, true);
          return reject(new Error('ERR_FILE_NOT_FOUND (-6)'));
        }
        this.loaded = true;
        this.webContents.emit('did-finish-load');
        return resolve();
      });
    });
  }

  _execute(code) {
    if (this.destroyed) return Promise.reject(new Error('Object has been destroyed'));
    this.scripts.push(String(code));
    if (this.loaded && !this.fake.frameworkLoaded && this.scripts.length > this.frameworkAfterCalls) this.fake.setFrameworkLoaded(true);
    try {
      return Promise.resolve(this.fake.run(code));
    } catch (error) {
      const rejection = new Error(GENERIC_SCRIPT_ERROR);
      rejection.cause = error;
      return Promise.reject(rejection);
    }
  }

  /** Simulates the renderer process dying. */
  crash(reason = 'crashed') {
    this.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  close() {
    this.destroy();
  }

  isDestroyed() {
    return this.destroyed;
  }
}

/**
 * Makes `createHiddenWindow` functions that hand out FakeHiddenWindows and remember them.
 * @param {object | ((index: number) => object)} [options] FakeHiddenWindow options, or a function of the window's index
 */
function createWindowFactory(options = {}) {
  const windows = [];
  return {
    windows,
    get created() {
      return windows.length;
    },
    createHiddenWindow() {
      const windowOptions = typeof options === 'function' ? options(windows.length) : options;
      const win = new FakeHiddenWindow(windowOptions);
      windows.push(win);
      return win;
    },
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Golden harness: the real v1 handler                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

/** v1 reads its .dymo files next to index.js; the harness serves them from the labels folder and records which ones it read. */
function createRedirectedFs(reads) {
  const redirect = (file) => (typeof file === 'string' && file.endsWith('.dymo') ? path.join(LABELS_DIR, path.basename(file)) : file);
  return Object.assign(Object.create(fs), {
    existsSync: (file) => fs.existsSync(redirect(file)),
    readFileSync(file, ...rest) {
      if (typeof file === 'string' && file.endsWith('.dymo')) reads.push(path.basename(file));
      return fs.readFileSync(redirect(file), ...rest);
    },
  });
}

/**
 * Runs the real v1.6.1 `ipcMain.on('send-barcode-data')` listener (tests/fixtures/legacy-index.js, loaded with
 * electron, pdfkit, electron-store and child_process intercepted) against a fake hidden window whose
 * `executeJavaScript` runs every code string in the fake framework.
 *
 * @param {object} payload the legacy send-barcode-data envelope
 * @param {object} [options]
 * @param {Array<object>} [options.printers]       printers the fake framework reports (v1 prints to the first)
 * @param {boolean} [options.nativeQrSetter]
 * @returns {Promise<object>} { template, printer, ops, printed, error, labels, reads, scripts, scriptErrors, handlerError }
 */
async function goldenOps(payload, options = {}) {
  const fakeElectron = createFakeElectron();
  const dymo = createFakeDymo({ printers: options.printers, nativeQrSetter: options.nativeQrSetter });
  const scripts = [];
  const scriptErrors = [];
  fakeElectron.hooks.onWindowCreated = (win) => {
    win.webContents.executeJavaScript = (code) =>
      new Promise((resolve, reject) => {
        scripts.push(String(code));
        try {
          resolve(dymo.run(code));
        } catch (error) {
          scriptErrors.push(`${error.name}: ${error.message}`);
          const rejection = new Error(GENERIC_SCRIPT_ERROR);
          rejection.cause = error;
          reject(rejection);
        }
      });
  };

  const reads = [];
  const stubs = {
    electron: fakeElectron.electron,
    pdfkit: class PDFDocument {},
    'electron-store': class ElectronStore {},
    child_process: { exec() {}, execFile() {} },
    fs: createRedirectedFs(reads),
  };
  const restoreModules = interceptModules((request, parent) =>
    parent && parent.filename === LEGACY_INDEX && Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : undefined
  );
  const restoreConsole = silenceConsole();
  let handlerError = null;
  try {
    delete require.cache[LEGACY_INDEX];
    require(LEGACY_INDEX); // registers the ipc listeners; app.whenReady() never resolves, so no window is created
    await fakeElectron.ipcMain.simulateSend('send-barcode-data', payload);
  } catch (error) {
    handlerError = error && error.message ? error.message : String(error);
  } finally {
    restoreConsole();
    restoreModules();
    delete require.cache[LEGACY_INDEX];
  }
  return summarizeRun(dymo.calls, { template: reads[reads.length - 1] || null, reads, scripts, scriptErrors, handlerError });
}

/**
 * The same observation for the v2 pipeline: buildLabelPlan -> pickDymoPrinter -> buildPrintScript, each script run in
 * a fresh fake framework.
 * @param {object} payload
 * @param {object} [options]
 * @param {Array<object>} [options.printers]
 * @param {string} [options.configuredPrinter]   printers.dymo.printerName
 * @param {string} [options.nameSuffix]          the QR rename suffix (injected so the output is deterministic)
 * @param {boolean} [options.nativeQrSetter]
 */
const preparedTemplates = new Map();

/** The prepared (line breaks removed) XML of a template file, read once per process. */
function preparedTemplate(file) {
  if (!preparedTemplates.has(file)) {
    const { prepareLabelXml } = require('../../src/main/printing/dymo/script');
    preparedTemplates.set(file, prepareLabelXml(fs.readFileSync(path.join(LABELS_DIR, file), 'utf8')));
  }
  return preparedTemplates.get(file);
}

function v2Ops(payload, options = {}) {
  const { buildLabelPlan } = require('../../src/main/printing/dymo/plan');
  const { buildPrintScript } = require('../../src/main/printing/dymo/script');
  const { pickDymoPrinter } = require('../../src/main/printing/dymo/printers');

  const dymo = createFakeDymo({ printers: options.printers, nativeQrSetter: options.nativeQrSetter });
  const built = buildLabelPlan(payload, options.currencySymbol ? { currencySymbol: options.currencySymbol } : undefined);
  const picked = pickDymoPrinter(dymo.printers, options.configuredPrinter || '');
  const scripts = [];
  const outcomes = [];
  for (const plan of built.plans) {
    const script = buildPrintScript({
      labelXml: preparedTemplate(plan.templateFile),
      ops: plan.ops,
      printerName: picked.printer.name,
      nameSuffix: options.nameSuffix || '1700000000000',
    });
    scripts.push(script);
    outcomes.push(JSON.parse(dymo.run(script)));
  }
  return summarizeRun(dymo.calls, {
    template: built.plans[0].templateFile,
    templates: built.plans.map((plan) => plan.templateFile),
    plans: built.plans,
    summary: built.summary,
    scripts,
    outcomes,
  });
}

module.exports = {
  REPO_ROOT,
  LABELS_DIR,
  LEGACY_INDEX,
  OBJECT_TYPES,
  GENERIC_SCRIPT_ERROR,
  DEFAULT_PRINTER,
  parseXml,
  serializeXml,
  extractObjects,
  createFakeDymo,
  summarizeCalls,
  FakeHiddenWindow,
  createWindowFactory,
  goldenOps,
  v2Ops,
};
