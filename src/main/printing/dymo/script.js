'use strict';

/**
 * The JavaScript the hidden DYMO window runs (SPEC 9.4).
 *
 * v1 pasted every label value into a template-literal script, so a product title with a quote, a backslash or a
 * line break broke the script and the label silently did not print. v2 has ONE generic script. All data (the label
 * XML, the list of operations, the printer name) is embedded as JSON literals; the code around them is constant and
 * contains no label text, so no value can change what the script does.
 *
 * The script reports its outcome as a JSON string: `{"ok":true}` or `{"ok":false,"message":"<framework message>"}`.
 * It catches inside the page on purpose: when a script throws, Electron's webContents.executeJavaScript rejects with
 * the generic text "Script failed to execute, this normally means an error was thrown" and the framework's own
 * message (for example "no object with name 'Text_was' was found") would be lost.
 *
 * Pure module: no electron, no fs.
 */

/** @typedef {{ kind: 'text' | 'qr' | 'qr-embed', name: string, value: string }} LabelOp */

/** A label file does not have what the plan needs (an object is missing); `code` is the ERROR_CODES value the service answers with. */
class TemplateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
    this.code = 'DYMO_TEMPLATE_MISSING';
  }
}

/** A page expression: true once the DYMO framework script has run. */
const FRAMEWORK_PROBE_SCRIPT =
  "typeof dymo !== 'undefined' && !!dymo.label && !!dymo.label.framework && " +
  "typeof dymo.label.framework.getPrinters === 'function' && typeof dymo.label.framework.openLabelXml === 'function'";

/** Lists the printers the framework knows as JSON: `{"printers":[{name,modelName,printerType,isConnected,isLocal}]}` or `{"error":"..."}`. */
const LIST_PRINTERS_SCRIPT = `(function () {
  'use strict';
  try {
    var found = dymo.label.framework.getPrinters();
    var printers = [];
    for (var i = 0; i < found.length; i += 1) {
      var printer = found[i];
      printers.push({
        name: String(printer.name),
        modelName: String(printer.modelName || ''),
        printerType: String(printer.printerType || ''),
        isConnected: printer.isConnected === true,
        isLocal: printer.isLocal === true
      });
    }
    return JSON.stringify({ printers: printers });
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
})()`;

/**
 * v1's `_forceQRCodeUpdate` patch, unchanged in behaviour: writes the text into the QR object's DataString and its
 * TextDataHolder value and drops the cached QR picture, so DYMO draws the new code. Installed once per window.
 */
const FORCE_QR_PATCH = `    if (!framework.Label.prototype._forceQRCodeUpdate) {
      framework.Label.prototype._forceQRCodeUpdate = function (objectName, text) {
        var objElem = this._getObjectByNameElement(objectName);
        if (!objElem) return this;
        var dataElem = dymo.xml.getElement(objElem, 'Data');
        if (dataElem) {
          var dataStringElem = dymo.xml.getElement(dataElem, 'DataString');
          if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
        }
        var textHolder = dymo.xml.getElement(objElem, 'TextDataHolder');
        if (textHolder) {
          var valElem = dymo.xml.getElement(textHolder, 'Value');
          if (valElem) dymo.xml.setElementText(valElem, text);
        }
        var renderCache = objElem.getElementsByTagName('RenderCache');
        if (renderCache.length > 0) objElem.removeChild(renderCache[0]);
        return this;
      };
    }`;

/**
 * v1's QR object support for designs 2 and 7, installed once per window and only when the framework has no
 * `_setQRCodeObjectText` of its own. The shipped framework does have it, so against it this block is skipped, exactly as in v1.
 */
const EMBED_QR_PATCH = `    if (!framework.Label.prototype._setQRCodeObjectText) {
      framework.Label.prototype._setQRCodeObjectText = function (objectElem, text) {
        var dataElem = dymo.xml.getElement(objectElem, 'Data');
        if (dataElem) {
          var dataStringElem = dymo.xml.getElement(dataElem, 'DataString');
          if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
        }
        var holderElem = dymo.xml.getElement(objectElem, 'TextDataHolder');
        if (holderElem) {
          var valueElem = dymo.xml.getElement(holderElem, 'Value');
          if (valueElem) dymo.xml.setElementText(valueElem, text);
        }
        return this;
      };
      var originalSetObjectText = framework.Label.prototype.setObjectText;
      framework.Label.prototype.setObjectText = function (name, value) {
        var objectElem = this._getObjectByNameElement(name);
        if (!objectElem) return this;
        if (objectElem.tagName === 'QRCodeObject') return this._setQRCodeObjectText(objectElem, value);
        return originalSetObjectText.call(this, name, value);
      };
    }`;

/**
 * A JSON literal that is safe to paste into script source: U+2028 and U+2029 (line terminators in older JavaScript)
 * and the sequence `</script` are escaped on top of what JSON.stringify does.
 * @param {unknown} value any JSON-serialisable value
 * @returns {string}
 */
function toScriptLiteral(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json
    .replace(/\p{Zl}/gu, '\\u2028')
    .replace(/\p{Zp}/gu, '\\u2029')
    .replace(/<\/(script)/gi, (match, tag) => `<\\/${tag}`);
}

/**
 * Prepares a template file for use. By default the line breaks are removed, exactly as v1 did (its escapeLabelXml),
 * because labels have always been printed that way. Quotes, backslashes and backticks need no escaping any more: the
 * XML travels as a JSON literal.
 *
 * Known quirk, measured in the real framework (tests/dymo/real-framework-check.js): with the line breaks removed, the
 * framework's own serialiser (dymo.xml.serialize, which post-processes `<Color .../>` with a greedy `.+` regexp)
 * returns XML that is malformed at its end; with the line breaks kept it is well-formed. DYMO Connect accepts what
 * v1 has always sent, so the default stays; `stripLineBreaks: false` is the switch to try on a real printer.
 * @param {string} rawXml the template file as read (a UTF-8 byte order mark at the start is kept, as in v1)
 * @param {{ stripLineBreaks?: boolean }} [options]
 * @returns {string}
 */
function prepareLabelXml(rawXml, { stripLineBreaks = true } = {}) {
  const xml = String(rawXml);
  return stripLineBreaks ? xml.replace(/\r?\n/g, '') : xml;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeXmlText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * v1's design 2 and 7 mechanism: the QR text is written into the label XML before the label is opened (the
 * DataString and the TextDataHolder value of the named QR object) and the object is renamed `<name>_<suffix>`, which
 * makes DYMO draw the code again. v1 did this with replacement STRINGS, so a `$` in a barcode corrupted the XML and an
 * `&` or `<` made it invalid; here the replacements are functions and the text is XML-escaped.
 * @param {string} labelXml
 * @param {string} name   the QR object name, e.g. QRCodeObject0
 * @param {string} value  the text the QR code must carry
 * @param {string} suffix the unique temporary name suffix (v1 used Date.now())
 * @returns {string}
 */
function embedQrText(labelXml, name, value, suffix) {
  const objectName = escapeRegExp(name);
  const dataString = new RegExp(`(<QRCodeObject>[\\s\\S]*?<Name>${objectName}<\\/Name>[\\s\\S]*?<Data>[\\s\\S]*?<DataString>)([\\s\\S]*?)(<\\/DataString>)`);
  const holderValue = new RegExp(`(<QRCodeObject>[\\s\\S]*?<Name>${objectName}<\\/Name>[\\s\\S]*?<TextDataHolder>[\\s\\S]*?<Value>)([\\s\\S]*?)(<\\/Value>)`);
  const nameTag = new RegExp(`(<Name>${objectName}<\\/Name>)`);
  // v1 did nothing when the object was missing and printed the template's sample QR code ("123"): a wrong code on a label is worse than an error
  if (!dataString.test(labelXml) || !holderValue.test(labelXml)) {
    throw new TemplateError(`The label file has no QR code object named ${name}.`);
  }
  const text = escapeXmlText(value);
  return labelXml
    .replace(dataString, (match, open, oldText, close) => open + text + close)
    .replace(holderValue, (match, open, oldText, close) => open + text + close)
    .replace(nameTag, () => `<Name>${name}_${suffix}</Name>`);
}

/**
 * Builds the script that prints ONE label.
 * @param {object} input
 * @param {string} input.labelXml     the prepared template XML (see prepareLabelXml)
 * @param {LabelOp[]} input.ops       'text' ops call setObjectText, 'qr' ops call the `_forceQRCodeUpdate` patch, 'qr-embed' ops rewrite the XML first
 * @param {string} input.printerName  the exact DYMO printer name
 * @param {string} [input.nameSuffix] suffix of the renamed QR object of a 'qr-embed' op (default: the current time in ms, as v1)
 * @returns {string} JavaScript source for webContents.executeJavaScript; its value is the JSON string described at the top of this file
 */
function buildPrintScript({ labelXml, ops, printerName, nameSuffix } = {}) {
  if (typeof labelXml !== 'string' || labelXml === '') throw new TypeError('buildPrintScript: labelXml must be a non-empty string');
  if (!Array.isArray(ops)) throw new TypeError('buildPrintScript: ops must be an array');
  if (typeof printerName !== 'string' || printerName === '') throw new TypeError('buildPrintScript: printerName must be a non-empty string');
  const suffix = String(nameSuffix ?? Date.now());
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(suffix)) throw new TypeError('buildPrintScript: nameSuffix may only contain letters, digits, "_" and "-"');

  let xml = labelXml;
  let usesForceUpdate = false;
  let usesEmbed = false;
  const steps = [];
  for (const op of ops) {
    if (!op || typeof op.name !== 'string' || typeof op.value !== 'string') throw new TypeError('buildPrintScript: every op needs a string name and a string value');
    if (op.kind === 'qr-embed') {
      xml = embedQrText(xml, op.name, op.value, suffix);
      usesEmbed = true;
    } else if (op.kind === 'qr') {
      usesForceUpdate = true;
      steps.push({ kind: 'qr', name: op.name, value: op.value });
    } else if (op.kind === 'text') {
      steps.push({ kind: 'text', name: op.name, value: op.value });
    } else {
      throw new TypeError(`buildPrintScript: unknown op kind ${JSON.stringify(op.kind)}`);
    }
  }

  const patches = [usesForceUpdate ? FORCE_QR_PATCH : '', usesEmbed ? EMBED_QR_PATCH : ''].filter(Boolean).join('\n');
  return `(function () {
  'use strict';
  try {
    var framework = dymo.label.framework;
    var labelXml = ${toScriptLiteral(xml)};
    var steps = ${toScriptLiteral(steps)};
    var printerName = ${toScriptLiteral(printerName)};
${patches}
    var label = framework.openLabelXml(labelXml);
    for (var i = 0; i < steps.length; i += 1) {
      if (steps[i].kind === 'qr') label._forceQRCodeUpdate(steps[i].name, steps[i].value);
      else label.setObjectText(steps[i].name, steps[i].value);
    }
    label.print(printerName);
    return JSON.stringify({ ok: true });
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message ? error.message : error) });
  }
})()`;
}

module.exports = {
  TemplateError,
  FRAMEWORK_PROBE_SCRIPT,
  LIST_PRINTERS_SCRIPT,
  toScriptLiteral,
  prepareLabelXml,
  embedQrText,
  buildPrintScript,
};
