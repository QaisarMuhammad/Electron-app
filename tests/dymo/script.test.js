'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakeDymo, summarizeCalls, parseXml, LABELS_DIR } = require('../helpers/vm-dymo');
const {
  FRAMEWORK_PROBE_SCRIPT,
  LIST_PRINTERS_SCRIPT,
  TemplateError,
  toScriptLiteral,
  prepareLabelXml,
  embedQrText,
  buildPrintScript,
} = require('../../src/main/printing/dymo/script');

const code = (...points) => String.fromCharCode(...points);
const template = (file) => prepareLabelXml(fs.readFileSync(path.join(LABELS_DIR, file), 'utf8'));
const run = (fake, script) => JSON.parse(fake.run(script));

/** A tiny DYMO Connect label: one text object and one QR object (optionally with a cached picture). */
const mini = (cache = '') =>
  `<?xml version="1.0"?><DesktopLabel><DYMOLabel><LabelObjects>` +
  `<TextObject><Name>T1</Name><FormattedText><LineTextSpan><TextSpan><Text>old</Text></TextSpan></LineTextSpan></FormattedText></TextObject>` +
  `<QRCodeObject><Name>Q1</Name><Data><DataString>123</DataString></Data><TextDataHolder><Value>123</Value></TextDataHolder>${cache}</QRCodeObject>` +
  `</LabelObjects></DYMOLabel></DesktopLabel>`;

const HOSTILE = [
  'MacBook Air 13" M1',
  "O'Brien's",
  'a\nb',
  'C:\\temp\\x\\',
  'a`b`${x}`',
  '</script><script>alert(1)</script>',
  `x${code(0x2028)}y${code(0x2029)}z`,
  '$& $1 $$ $` $\'',
  '"); throw new Error("x"); ("',
  "');}());(function(){('",
  '\u{1F600} 日本語 £',
  '<!-- x --> ]]> &amp;',
  '',
];

/* ---------------------------------------------------------------------------------------------------------- */
/* Literals                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('toScriptLiteral: every hostile string round-trips through the JavaScript engine unchanged', () => {
  for (const text of HOSTILE) {
    const literal = toScriptLiteral(text);
    assert.equal(vm.runInNewContext(`(${literal})`), text, JSON.stringify(text));
  }
});

test('toScriptLiteral: U+2028, U+2029 and "</script" never appear raw', () => {
  const literal = toScriptLiteral(`a${code(0x2028)}b${code(0x2029)}c</script>d</SCRIPT>e`);
  assert.ok(!literal.includes(code(0x2028)));
  assert.ok(!literal.includes(code(0x2029)));
  assert.ok(!/<\/script/i.test(literal));
  assert.ok(literal.includes('\\u2028') && literal.includes('\\u2029'));
  assert.equal(vm.runInNewContext(`(${literal})`), `a${code(0x2028)}b${code(0x2029)}c</script>d</SCRIPT>e`);
});

test('toScriptLiteral: objects and arrays; undefined becomes null', () => {
  const value = { kind: 'text', name: 'N', list: [1, 'x', null, { deep: 'y"z' }] };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(`(${toScriptLiteral(value)})`))), value, 'objects made by the engine have their own prototypes: compare as JSON');
  assert.equal(toScriptLiteral(undefined), 'null');
  assert.equal(toScriptLiteral(() => 1), 'null');
});

test('prepareLabelXml: line breaks are removed by default (v1), the byte order mark stays, and they can be kept', () => {
  assert.equal(prepareLabelXml('<a>\r\n  <b/>\n</a>'), '<a>  <b/></a>');
  assert.equal(prepareLabelXml('\uFEFF<a>\n</a>').charCodeAt(0), 0xfeff);
  assert.equal(prepareLabelXml('<a>\r\n<b/></a>', { stripLineBreaks: false }), '<a>\r\n<b/></a>');
  assert.ok(!template('Labeldesign1_1.dymo').includes('\n'));
});

/* ---------------------------------------------------------------------------------------------------------- */
/* buildPrintScript                                                                                            */
/* ---------------------------------------------------------------------------------------------------------- */

test('buildPrintScript: every hostile value in a text op, the printer name and the XML gives a script that parses', () => {
  for (const text of HOSTILE) {
    const script = buildPrintScript({ labelXml: mini(), ops: [{ kind: 'text', name: text || 'T1', value: text }, { kind: 'qr', name: 'Q1', value: text }], printerName: text || 'P' });
    assert.doesNotThrow(() => new vm.Script(script), JSON.stringify(text));
  }
  const hostileXml = `<?xml version="1.0"?><a>${HOSTILE.join('').replace(/[<&]/g, '')}</a>`;
  assert.doesNotThrow(() => new vm.Script(buildPrintScript({ labelXml: hostileXml, ops: [], printerName: 'P' })));
});

test('buildPrintScript: label data only ever appears inside JSON literals; the code around them is constant', () => {
  const marker = '"); throw "INJECTED"; ("';
  const script = buildPrintScript({ labelXml: mini(), ops: [{ kind: 'text', name: 'T1', value: marker }], printerName: marker });
  const encoded = JSON.stringify(marker).slice(1, -1);
  const withoutData = script.split(encoded).join('');
  assert.ok(!withoutData.includes('INJECTED'));
  assert.equal(script.split(encoded).length - 1, 2, 'once in the steps, once as the printer name');
  // the code outside the literals does not change with the data
  const other = buildPrintScript({ labelXml: mini(), ops: [{ kind: 'text', name: 'T1', value: 'plain' }], printerName: 'plain' });
  assert.equal(other.split('plain').join(''), script.split(encoded).join(''));
});

test('buildPrintScript: opens the XML, applies every op in order, prints on the named printer, answers {"ok":true}', () => {
  const fake = createFakeDymo({ printers: [{ name: 'My "Printer"' }] });
  const xml = template('Labeldesign1_1.dymo');
  const ops = [
    { kind: 'text', name: 'ItemNameVal', value: 'Phone' },
    { kind: 'text', name: 'TEXT_3', value: '£10' },
    { kind: 'text', name: 'BARCODE', value: '123' },
  ];
  assert.deepEqual(run(fake, buildPrintScript({ labelXml: xml, ops, printerName: 'My "Printer"' })), { ok: true });
  const [label] = summarizeCalls(fake.calls);
  assert.deepEqual(label.ops, ops);
  assert.equal(label.printer, 'My "Printer"');
  assert.equal(label.printed, true);
  assert.equal(fake.calls.find((call) => call.type === 'open').xml, xml, 'the XML reaches the framework as given');
});

test('buildPrintScript: a framework error comes back as {"ok":false,"message":...} and nothing is thrown', () => {
  const fake = createFakeDymo();
  const xml = template('Labeldesign1_1.dymo');
  const missing = run(fake, buildPrintScript({ labelXml: xml, ops: [{ kind: 'text', name: 'Nope', value: 'x' }], printerName: 'DYMO LabelWriter 450' }));
  assert.deepEqual(missing, { ok: false, message: "getObjectByNameElement(): no object with name 'Nope' was found" });
  const unknown = run(fake, buildPrintScript({ labelXml: xml, ops: [], printerName: 'No such printer' }));
  assert.deepEqual(unknown, { ok: false, message: "printLabel(): unknown printer 'No such printer'" });
  fake.setFailPrint(() => 'The printer is busy');
  assert.deepEqual(run(fake, buildPrintScript({ labelXml: xml, ops: [], printerName: 'DYMO LabelWriter 450' })), { ok: false, message: 'The printer is busy' });
  const malformed = run(fake, buildPrintScript({ labelXml: '<a><b></a>', ops: [], printerName: 'DYMO LabelWriter 450' }));
  assert.equal(malformed.ok, false);
});

test('buildPrintScript: without the framework (no `dymo` global) the script answers ok:false instead of throwing', () => {
  const fake = createFakeDymo();
  fake.setFrameworkLoaded(false);
  const answer = run(fake, buildPrintScript({ labelXml: mini(), ops: [], printerName: 'P' }));
  assert.equal(answer.ok, false);
  assert.match(answer.message, /dymo/);
});

test('buildPrintScript: it checks its arguments', () => {
  const ok = { labelXml: mini(), ops: [], printerName: 'P' };
  assert.doesNotThrow(() => buildPrintScript(ok));
  assert.throws(() => buildPrintScript(), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, labelXml: '' }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, labelXml: 5 }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, ops: 'x' }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, printerName: '' }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, printerName: undefined }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, ops: [{ kind: 'text', name: 'T1', value: 5 }] }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, ops: [{ kind: 'text', name: 5, value: 'x' }] }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, ops: [{ kind: 'eval', name: 'T1', value: 'x' }] }), /unknown op kind/);
  assert.throws(() => buildPrintScript({ ...ok, ops: [null] }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, nameSuffix: 'a b' }), TypeError);
  assert.throws(() => buildPrintScript({ ...ok, nameSuffix: '"></Name>' }), TypeError);
});

test('buildPrintScript: a patch is DEFINED in the script only when an op needs it', () => {
  const base = { labelXml: mini(), printerName: 'P' };
  const defines = (script) => ({ force: script.includes('_forceQRCodeUpdate = function'), embed: script.includes('_setQRCodeObjectText = function') });
  assert.deepEqual(defines(buildPrintScript({ ...base, ops: [{ kind: 'text', name: 'T1', value: 'x' }] })), { force: false, embed: false });
  assert.deepEqual(defines(buildPrintScript({ ...base, ops: [{ kind: 'qr', name: 'Q1', value: 'x' }] })), { force: true, embed: false });
  assert.deepEqual(defines(buildPrintScript({ ...base, ops: [{ kind: 'qr-embed', name: 'Q1', value: 'x' }] })), { force: false, embed: true });
  assert.deepEqual(
    defines(buildPrintScript({ ...base, ops: [{ kind: 'qr', name: 'Q1', value: 'x' }, { kind: 'qr-embed', name: 'Q1', value: 'y' }] })),
    { force: true, embed: true }
  );
});

test('buildPrintScript: the script never calls eval, Function, innerHTML, or touches anything but the framework', () => {
  const script = buildPrintScript({ labelXml: mini(), ops: [{ kind: 'qr', name: 'Q1', value: 'x' }, { kind: 'qr-embed', name: 'Q1', value: 'y' }], printerName: 'P' });
  const stripped = script.replace(/var (labelXml|steps|printerName) = .*;\n/g, '');
  for (const forbidden of [/\beval\b/, /\bFunction\b/, /innerHTML/, /document\./, /window\./, /require\(/, /process\./, /fetch\(/, /XMLHttpRequest/]) assert.doesNotMatch(stripped, forbidden);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* QR codes                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('qr op: the patch writes DataString and the TextDataHolder value, drops a cached picture, and is installed once per window', () => {
  const fake = createFakeDymo();
  const ops = [{ kind: 'qr', name: 'Q1', value: 'FIRST' }];
  run(fake, buildPrintScript({ labelXml: mini('<RenderCache>PICTURE</RenderCache>'), ops, printerName: 'DYMO LabelWriter 450' }));
  const first = fake.dymo.label.framework.Label.prototype._forceQRCodeUpdate;
  assert.equal(typeof first, 'function');
  const [one] = summarizeCalls(fake.calls);
  assert.deepEqual(one.qr, [{ name: 'Q1', data: 'FIRST', holder: 'FIRST', hasRenderCache: false }]);

  run(fake, buildPrintScript({ labelXml: mini('<RenderCache>PICTURE</RenderCache>'), ops: [{ kind: 'qr', name: 'Q1', value: 'SECOND' }], printerName: 'DYMO LabelWriter 450' }));
  assert.equal(fake.dymo.label.framework.Label.prototype._forceQRCodeUpdate, first, 'the patch was not installed a second time');
  assert.deepEqual(summarizeCalls(fake.calls)[1].qr, [{ name: 'Q1', data: 'SECOND', holder: 'SECOND', hasRenderCache: false }]);
});

test('qr op: a missing QR object is the framework message, not a silent label', () => {
  const fake = createFakeDymo();
  const answer = run(fake, buildPrintScript({ labelXml: mini(), ops: [{ kind: 'qr', name: 'Missing', value: 'x' }], printerName: 'DYMO LabelWriter 450' }));
  assert.equal(answer.ok, false);
  assert.match(answer.message, /no object with name 'Missing'/);
});

test('qr-embed op: DataString and the value holder hold the text exactly, the object is renamed with the injected suffix', () => {
  for (const value of ['ABC123', 'A$&B', 'A$1B$$C', "A$`B$'C", 'A&B', 'A<B>C', '</DataString>', '"quoted" \\ back', '']) {
    const xml = embedQrText(mini(), 'Q1', value, '555');
    const doc = parseXml(xml);
    const qr = doc.documentElement.getElementsByTagName('QRCodeObject')[0];
    assert.equal(qr.getElementsByTagName('Name')[0].textContent, 'Q1_555');
    assert.equal(qr.getElementsByTagName('DataString')[0].textContent, value, JSON.stringify(value));
    assert.equal(qr.getElementsByTagName('Value')[0].textContent, value, JSON.stringify(value));
    assert.equal(doc.documentElement.getElementsByTagName('TextObject')[0].getElementsByTagName('Text')[0].textContent, 'old', 'other objects are untouched');
  }
});

test('qr-embed op: through a script, on the real templates (designs 2 and 7), with the framework\'s own QR setter or without', () => {
  for (const nativeQrSetter of [true, false]) {
    for (const file of ['Labeldesign2.dymo', 'Labeldesign3.dymo', '70_54_Labeldesign2.dymo', '70_54_Labeldesign3.dymo']) {
      const fake = createFakeDymo({ nativeQrSetter });
      const answer = run(fake, buildPrintScript({ labelXml: template(file), ops: [{ kind: 'qr-embed', name: 'QRCodeObject0', value: 'X$&Y' }, { kind: 'text', name: 'ItemNameVal', value: 'Phone' }], printerName: 'DYMO LabelWriter 450', nameSuffix: '42' }));
      assert.deepEqual(answer, { ok: true }, `${file} native=${nativeQrSetter}`);
      const [label] = summarizeCalls(fake.calls);
      assert.deepEqual(label.qr, [{ name: 'QRCodeObject0_<ts>', data: 'X$&Y', holder: 'X$&Y', hasRenderCache: false }]);
      assert.deepEqual(label.embeds.map((embed) => embed.name), ['QRCodeObject0_42']);
    }
  }
});

test('qr-embed op: the wrapper around setObjectText is installed once, and only when the framework has no _setQRCodeObjectText', () => {
  const ops = [{ kind: 'qr-embed', name: 'QRCodeObject0', value: 'X' }, { kind: 'text', name: 'ItemNameVal', value: 'Phone' }];
  const script = buildPrintScript({ labelXml: template('Labeldesign2.dymo'), ops, printerName: 'DYMO LabelWriter 450', nameSuffix: '1' });

  const native = createFakeDymo({ nativeQrSetter: true });
  const nativeSetter = native.dymo.label.framework.Label.prototype.setObjectText;
  run(native, script);
  assert.equal(native.dymo.label.framework.Label.prototype.setObjectText, nativeSetter, 'the shipped framework has its own setter: nothing is wrapped (as in v1)');

  const lacking = createFakeDymo({ nativeQrSetter: false });
  const original = lacking.dymo.label.framework.Label.prototype.setObjectText;
  run(lacking, script);
  const wrapped = lacking.dymo.label.framework.Label.prototype.setObjectText;
  assert.notEqual(wrapped, original, 'installed');
  assert.equal(typeof lacking.dymo.label.framework.Label.prototype._setQRCodeObjectText, 'function');
  run(lacking, script);
  assert.equal(lacking.dymo.label.framework.Label.prototype.setObjectText, wrapped, 'not wrapped a second time');
  assert.equal(summarizeCalls(lacking.calls).filter((label) => label.printed).length, 2);
});

test('qr-embed op: an object the template lacks is a TemplateError (v1 printed the sample QR code "123")', () => {
  assert.throws(() => embedQrText(mini(), 'Nope', 'x', '1'), (error) => error instanceof TemplateError && error.code === 'DYMO_TEMPLATE_MISSING' && /Nope/.test(error.message));
  assert.throws(() => buildPrintScript({ labelXml: template('Labeldesign1_1.dymo'), ops: [{ kind: 'qr-embed', name: 'QRCodeObject0', value: 'x' }], printerName: 'P' }), TemplateError);
  // a QR object without a value holder is just as incomplete
  const noHolder = mini().replace('<TextDataHolder><Value>123</Value></TextDataHolder>', '');
  assert.throws(() => embedQrText(noHolder, 'Q1', 'x', '1'), TemplateError);
});

test('qr-embed op: only the named QR object changes; the object name is matched literally', () => {
  const xml = template('multipleQRCODE.dymo');
  const changed = embedQrText(xml, 'QRCodeObject1', 'ONLY-ME', '7');
  const states = parseXml(changed).documentElement.getElementsByTagName('QRCodeObject').map((element) => ({
    name: element.getElementsByTagName('Name')[0].textContent,
    data: element.getElementsByTagName('DataString')[0].textContent,
  }));
  assert.deepEqual(states, [
    { name: 'QRCodeObject0', data: '123' },
    { name: 'QRCodeObject1_7', data: 'ONLY-ME' },
    { name: 'QRCodeObject2', data: '123' },
  ]);
  assert.throws(() => embedQrText(mini(), 'Q.', 'x', '1'), TemplateError, 'a name with regexp characters does not match "Q1"');
  assert.throws(() => embedQrText(mini(), '.*', 'x', '1'), TemplateError);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The helper scripts                                                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

test('the framework probe is true only when the framework is there', () => {
  const fake = createFakeDymo();
  assert.equal(fake.run(FRAMEWORK_PROBE_SCRIPT), true);
  fake.setFrameworkLoaded(false);
  assert.equal(fake.run(FRAMEWORK_PROBE_SCRIPT), false);
  fake.setFrameworkLoaded(true);
  assert.equal(fake.run(FRAMEWORK_PROBE_SCRIPT), true);
});

test('the printer list script answers plain JSON, or {"error"} when the framework throws', () => {
  const fake = createFakeDymo({
    printers: [{ name: 'DYMO LabelWriter 450', isConnected: true }, { name: 'DYMO "Tape"', printerType: 'TapePrinter', isConnected: false, isLocal: false }],
  });
  assert.deepEqual(JSON.parse(fake.run(LIST_PRINTERS_SCRIPT)), {
    printers: [
      { name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true },
      { name: 'DYMO "Tape"', modelName: 'DYMO LabelWriter 450', printerType: 'TapePrinter', isConnected: false, isLocal: false },
    ],
  });
  fake.dymo.label.framework.getPrinters = () => {
    throw new Error('service down');
  };
  assert.deepEqual(JSON.parse(fake.run(LIST_PRINTERS_SCRIPT)), { error: 'service down' });
  assert.doesNotThrow(() => new vm.Script(LIST_PRINTERS_SCRIPT));
});
