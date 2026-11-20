'use strict';

/**
 * Proof of the harness (tests/helpers/vm-dymo.js, tests/helpers/fake-electron.js, tests/fixtures/legacy-index.js).
 * The golden tests are only as good as their reference, so this file checks the reference itself:
 *  - the v1 source is the pristine 1.6.1 file,
 *  - the fake framework behaves like the real one in the ways v1's output depends on (each point below was read from, or
 *    measured in, the real dymo.connect.framework.js: see tests/dymo/real-framework-check.js),
 *  - running the real v1 handler gives the results a reading of its source predicts, written out here as literals.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  LEGACY_INDEX,
  LABELS_DIR,
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
} = require('../helpers/vm-dymo');
const { createFakeElectron, interceptModules, createManualClock, silenceConsole } = require('../helpers/fake-electron');

const POUND = '£';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const template = (file) => fs.readFileSync(path.join(LABELS_DIR, file), 'utf8').replace(/\r?\n/g, '');
const pairs = (ops) => ops.map((op) => `${op.kind}:${op.name}=${op.value}`);

/* ---------------------------------------------------------------------------------------------------------- */
/* The reference                                                                                               */
/* ---------------------------------------------------------------------------------------------------------- */

test('tests/fixtures/legacy-index.js is the pristine v1.6.1 index.js (sha-256 pinned)', () => {
  assert.equal(sha256(LEGACY_INDEX), '2640723c69b1c37ee68ecd898675fce83ad29fdf7a6dba60fb2026eeef04c9cf');
  const source = fs.readFileSync(LEGACY_INDEX, 'utf8');
  assert.match(source, /ipcMain\.on\('send-barcode-data'/);
  assert.match(source, /escapeLabelXml/);
  assert.equal(source.match(/async function loadDymoFramework/g).length, 2, 'v1 really has the duplicate definition');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Mini XML DOM                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('parseXml / serializeXml: round trip, entities, attributes, CDATA, comments and the byte order mark', () => {
  const source = '﻿<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>t &lt;&amp;&gt; &#65;&#x42;</b><c/><d><![CDATA[<raw & text>]]></d></a>';
  const doc = parseXml(source);
  assert.equal(doc.documentElement.tagName, 'a');
  assert.equal(doc.documentElement.attributes.x, '1 & 2');
  assert.equal(doc.documentElement.getElementsByTagName('b')[0].textContent, 't <&> AB');
  assert.equal(doc.documentElement.getElementsByTagName('d')[0].textContent, '<raw & text>');
  assert.equal(serializeXml(doc.documentElement), '<a x="1 &amp; 2"><b>t &lt;&amp;&gt; AB</b><c/><d>&lt;raw &amp; text&gt;</d></a>');
  assert.equal(serializeXml(parseXml(serializeXml(doc.documentElement)).documentElement), serializeXml(doc.documentElement));
});

test('parseXml is as strict as a browser about broken XML', () => {
  for (const broken of ['<a><b></a>', '<a>', '<a></a><b/>', 'text only', '<a>a & b</a>', '<a>&nbsp;</a>', '<a></b></a>', '']) {
    assert.throws(() => parseXml(broken), /XML parse error/, JSON.stringify(broken));
  }
});

test('getElementsByTagName is document order and recursive; removeChild and appendChild keep the tree consistent', () => {
  const doc = parseXml('<r><a id="1"><a id="2"/></a><b><a id="3"/></b></r>');
  assert.deepEqual(doc.documentElement.getElementsByTagName('a').map((element) => element.attributes.id), ['1', '2', '3']);
  const [first] = doc.documentElement.getElementsByTagName('a');
  first.parentNode.removeChild(first);
  assert.deepEqual(doc.documentElement.getElementsByTagName('a').map((element) => element.attributes.id), ['3']);
  assert.throws(() => doc.documentElement.removeChild(first), /NotFoundError/);
});

test('extractObjects: the objects the framework can address, in order, named by their first <Name>', () => {
  assert.deepEqual(extractObjects(template('labitemdesign.dymo')), [
    { name: 'BarcodeObject1', type: 'BarcodeObject' },
    { name: 'TextObject12', type: 'TextObject' },
  ]);
  const withLine = extractObjects(template('Labeldesign3.dymo')).map((object) => object.type);
  assert.ok(!withLine.includes('LineObject'), 'a LineObject is not addressable by name in the framework');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The fake framework                                                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

test('fake framework: setObjectText on a DYMO Connect text object writes the first TextSpan text and records the call', () => {
  const fake = createFakeDymo();
  fake.run(`(function () {
    var label = dymo.label.framework.openLabelXml(${JSON.stringify(template('Labeldesign1_1.dymo'))});
    label.setObjectText('ItemNameVal', 'Hello');
    globalThis.__xml = label.getLabelXml();
  })()`);
  const doc = parseXml(fake.context.__xml);
  const item = doc.documentElement.getElementsByTagName('TextObject').find((element) => element.getElementsByTagName('Name')[0].textContent === 'ItemNameVal');
  assert.equal(item.getElementsByTagName('Text')[0].textContent, 'Hello');
  assert.deepEqual(fake.calls.filter((call) => call.type === 'text'), [{ type: 'text', name: 'ItemNameVal', value: 'Hello' }]);
});

test('fake framework: a missing object THROWS the framework\'s message (the real _getObjectByNameElement does) and is recorded as an error', () => {
  const fake = createFakeDymo();
  assert.throws(
    () => fake.run(`dymo.label.framework.openLabelXml(${JSON.stringify(template('Labeldesign1_1.dymo'))}).setObjectText('Text_was', 'x')`),
    { message: "getObjectByNameElement(): no object with name 'Text_was' was found" }
  );
  assert.equal(fake.calls.filter((call) => call.type === 'text').length, 0, 'the failed call is not recorded as a set');
  assert.equal(fake.calls.at(-1).type, 'error');
  assert.equal(summarizeCalls(fake.calls)[0].error, "getObjectByNameElement(): no object with name 'Text_was' was found");
});

test('fake framework: a barcode object takes its text in <Data>; a QR object through the native setter takes it in DataString only', () => {
  const fake = createFakeDymo();
  fake.run(`(function () {
    var l = dymo.label.framework.openLabelXml(${JSON.stringify(template('Labeldesign2.dymo'))});
    l.setObjectText('QRCodeObject0', 'QR-TEXT');
    globalThis.__qr = l.getLabelXml();
  })()`);
  const qr = parseXml(fake.context.__qr).documentElement.getElementsByTagName('QRCodeObject')[0];
  assert.equal(qr.getElementsByTagName('DataString')[0].textContent, 'QR-TEXT');
  assert.equal(qr.getElementsByTagName('Value')[0].textContent, '123', 'the TextDataHolder value is NOT updated by the native setter: that is why v1 patches it');

  const barcode = createFakeDymo();
  barcode.run(`(function () {
    var l = dymo.label.framework.openLabelXml(${JSON.stringify(template('Labeldesign1_1.dymo'))});
    l.setObjectText('BARCODE', 'BC-1');
    globalThis.__bc = l.getLabelXml();
  })()`);
  const object = parseXml(barcode.context.__bc).documentElement.getElementsByTagName('BarcodeObject')[0];
  assert.equal(object.getElementsByTagName('Data')[0].textContent, 'BC-1');
});

test('fake framework: _forceQRCodeUpdate does not exist until a script installs it; the install is observed and every call recorded', () => {
  const fake = createFakeDymo();
  const proto = fake.dymo.label.framework.Label.prototype;
  assert.equal(proto._forceQRCodeUpdate, undefined);
  fake.run(`dymo.label.framework.Label.prototype._forceQRCodeUpdate = function (name, text) { this.touched = [name, text]; return this; };`);
  assert.equal(typeof proto._forceQRCodeUpdate, 'function');
  fake.run(`dymo.label.framework.openLabelXml(${JSON.stringify(template('Labeldesign2.dymo'))})._forceQRCodeUpdate('QRCodeObject0', 'V')`);
  assert.deepEqual(fake.calls.filter((call) => call.type === 'qr'), [{ type: 'qr', name: 'QRCodeObject0', value: 'V' }]);
});

test('fake framework: the native _setQRCodeObjectText exists unless asked not to (the real framework has it)', () => {
  assert.equal(typeof createFakeDymo().dymo.label.framework.Label.prototype._setQRCodeObjectText, 'function');
  assert.equal(createFakeDymo({ nativeQrSetter: false }).dymo.label.framework.Label.prototype._setQRCodeObjectText, undefined);
});

test('fake framework: getPrinters is an array with the printers by index AND by name, like the real collection', () => {
  const fake = createFakeDymo({ printers: [{ name: 'A' }, { name: 'B', isConnected: false }] });
  const printers = fake.run('dymo.label.framework.getPrinters()');
  assert.equal(printers.length, 2);
  assert.equal(printers[0].name, 'A');
  assert.equal(printers.B.isConnected, false);
  assert.equal(printers.byIndex.length, 2);
  assert.equal(printers[0].isNetworkPrinter(), false);
  assert.equal(printers[1].printerType, 'LabelWriterPrinter');
});

test('fake framework: print looks the printer up by name and throws the real message for an unknown one', () => {
  const fake = createFakeDymo({ printers: [{ name: 'Known' }] });
  const open = `dymo.label.framework.openLabelXml(${JSON.stringify(template('labitemdesign.dymo'))})`;
  fake.run(`${open}.print('Known')`);
  assert.deepEqual(fake.calls.filter((call) => call.type === 'print').map((call) => call.printerName), ['Known']);
  assert.throws(() => fake.run(`${open}.print('Unknown')`), { message: "printLabel(): unknown printer 'Unknown'" });
  assert.throws(() => fake.run(`${open}.print()`), { message: "printLabel(): unknown printer 'undefined'" });
  fake.setFailPrint(() => 'Out of labels');
  assert.throws(() => fake.run(`${open}.print('Known')`), { message: 'Out of labels' });
});

test('fake framework: scripts run in their own context; the framework can be removed and restored; a runaway script is cut off', () => {
  const fake = createFakeDymo();
  assert.equal(fake.run('typeof dymo'), 'object');
  fake.setFrameworkLoaded(false);
  assert.equal(fake.run('typeof dymo'), 'undefined');
  assert.equal(fake.frameworkLoaded, false);
  fake.setFrameworkLoaded(true);
  assert.equal(fake.run('typeof dymo'), 'object');
  assert.equal(fake.run('typeof require + typeof process + typeof fetch'), 'undefinedundefinedundefined', 'no node or browser globals leak in');
  assert.throws(() => fake.run('while (true) {}'), /timed out/i);
  assert.throws(() => fake.run('this is not javascript'), SyntaxError);
});

test('summarizeCalls: one record per opened label, embeds read from the renamed QR object, QR state at print time', () => {
  const fake = createFakeDymo();
  const xml = template('Labeldesign2.dymo').replace('<Name>QRCodeObject0</Name>', '<Name>QRCodeObject0_99</Name>');
  fake.run(`(function () { var l = dymo.label.framework.openLabelXml(${JSON.stringify(xml)}); l.setObjectText('ItemNameVal', 'x'); l.print('${DEFAULT_PRINTER.name}'); })()`);
  const [label] = summarizeCalls(fake.calls);
  assert.deepEqual(label.ops, [{ kind: 'qr-embed', name: 'QRCodeObject0', value: '123' }, { kind: 'text', name: 'ItemNameVal', value: 'x' }]);
  assert.equal(label.printed, true);
  assert.deepEqual(label.qr, [{ name: 'QRCodeObject0_<ts>', data: '123', holder: '123', hasRenderCache: false }]);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The v1 run, against results derived from v1's source by hand                                                */
/* ---------------------------------------------------------------------------------------------------------- */

const bf = (extra = {}) => ({
  printer: 'dymo',
  title: 'iPhone 13',
  barcode: 'ABCDEFGH123456',
  storage: '128GB',
  network: 'Unlocked',
  ram: '4GB',
  misc_color: 'Blue',
  warranty: '12 Months',
  conditionObject: { grade: 'A+' },
  Processor: 'A15',
  price: 499.99,
  salePrice: 449.99,
  regular_price: 499.99,
  isSale: false,
  ...extra,
});

test('v1 design 1 (index.js lines 1678-1726), as read from the source', async () => {
  const v1 = await goldenOps({ size: '32x57', design: '1', barcodefinal: bf() });
  assert.equal(v1.template, 'Labeldesign1_1.dymo');
  assert.deepEqual(pairs(v1.ops), [
    'text:ItemNameVal=iPhone 13',
    'text:TEXT_4=LIKE NEW',
    'text:TEXT=128GB',
    'text:TEXT_1=UNLOCKED',
    'text:TEXT_5=4GB',
    'text:TEXT__1=A15',
    'text:TextObject11=12 MONTHS WARRANTY',
    `text:TEXT_3=${POUND}499.99`,
    'text:BARCODE=ABCDEFGH123456',
    'text:TextObject1=********123456',
  ]);
  assert.equal(v1.printer, 'DYMO LabelWriter 450');
  assert.equal(v1.printed, true);
  assert.equal(v1.handlerError, null);
  assert.deepEqual(v1.reads, ['Labeldesign1_1.dymo']);
  assert.equal(v1.scripts.length, 2, 'one script for the printer list, one for the label');
  assert.equal(v1.scripts[0], 'dymo.label.framework.getPrinters()');
});

test('v1 design 3 and design 4 (lines 1378-1488)', async () => {
  const three = await goldenOps({ size: '70x54', design: '3', barcodefinal: bf() });
  assert.equal(three.template, '70_54_mukltipleBarcode.dymo');
  assert.deepEqual(pairs(three.ops), [
    'text:BarcodeObject0=ABCDEFGH123456',
    'text:BarcodeObject1=ABCDEFGH123456',
    `text:TextObject1=${POUND}499.99`,
    `text:TextObject12=${POUND}499.99`,
  ]);
  const four = await goldenOps({ size: '32x57', design: '4', barcodefinal: bf() });
  assert.equal(four.template, 'multipleQRCODE.dymo');
  assert.deepEqual(pairs(four.ops), [
    'qr:QRCodeObject0=ABCDEFGH123456',
    'qr:QRCodeObject1=ABCDEFGH123456',
    'qr:QRCodeObject2=ABCDEFGH123456',
    `text:TextObject12=${POUND}499.99`,
    `text:TextObject1=${POUND}499.99`,
    `text:TextObject2=${POUND}499.99`,
    'text:TextObject3=**123456',
    'text:TextObject4=**123456',
    'text:TextObject5=**123456',
  ]);
});

test('v1 25x25 labels (lines 1191-1289): barcode label, and the QR label that forces QRCodeObject2', async () => {
  const barcode = await goldenOps({ size: '25x25', design: '1', barcodefinal: bf() });
  assert.equal(barcode.template, '25_25_barcode.dymo');
  assert.deepEqual(pairs(barcode.ops), ['text:BarcodeObject0=ABCDEFGH123456', `text:TextObject1=${POUND}499.99`]);
  const qr = await goldenOps({ size: '25x25', design: '2', barcodefinal: bf() });
  assert.equal(qr.template, '25_25_qrcode.dymo');
  assert.deepEqual(pairs(qr.ops), ['qr:QRCodeObject2=ABCDEFGH123456', `text:TextObject2=${POUND}499.99`, 'text:TextObject3=**123456']);
});

test('v1 lab labels (lines 1177-1189) read the OUTER barcode and title', async () => {
  const lab = await goldenOps({ type: 'lab', size: '70x54', barcode: '636400', title: 'Screen', barcodefinal: bf({ title: 'ignored' }) });
  assert.equal(lab.template, 'labitemdesign.dymo');
  assert.deepEqual(pairs(lab.ops), ['text:BarcodeObject1=636400', 'text:TextObject12=Screen']);
});

test('v1 repair (lines 1292-1377): one label per item, QR forced last', async () => {
  const v1 = await goldenOps({
    size: '32x57',
    barcodefinal: {
      printer: 'dymo',
      design: 'repair',
      barcode: 'R-1',
      orderDate: '2026-11-19',
      customer: { name: 'Jo', cell_no: '0700' },
      business: { business_name: 'Shop', branch_name: 'Main' },
      orderItems: [{ product_name: 'A', custom_field_value: [{ value: 'x' }] }, { product_name: 'B' }],
    },
  });
  assert.equal(v1.labels.length, 2);
  assert.deepEqual(pairs(v1.labels[0].ops), [
    'text:ItemNameVal=A',
    'text:TEXT=x',
    'text:TEXT8=',
    'text:TEXT9=',
    'text:TextObject7=',
    'text:TextObject5=Jo',
    'text:TextObject6=0700',
    'text:TEXT_5=Shop Main',
    'text:TextObject1=2026-11-19',
    'text:TEXT4=R-1',
    'qr:QRCodeObject0=R-1',
  ]);
  assert.equal(pairs(v1.labels[1].ops)[0], 'text:ItemNameVal=B');
  assert.ok(v1.labels.every((label) => label.printed));
  assert.equal(v1.printed, true);
});

test('v1 failures: no printer, an unknown design on sale, a quote in the title, a missing label file handler error', async () => {
  const none = await goldenOps({ size: '32x57', design: '1', barcodefinal: bf() }, { printers: [] });
  assert.deepEqual({ printed: none.printed, labels: none.labels.length, scripts: none.scripts.length }, { printed: false, labels: 0, scripts: 1 });

  const sale = await goldenOps({ size: '32x57', design: '', barcodefinal: bf({ isSale: true }) });
  assert.equal(sale.printed, false);
  assert.match(sale.error, /Text_was/);
  assert.equal(sale.labels[0].printed, false);

  const quote = await goldenOps({ size: '32x57', design: '1', barcodefinal: bf({ title: 'a"b' }) });
  assert.equal(quote.printed, false);
  assert.equal(quote.labels.length, 0, 'the script never reached the framework');
  assert.match(quote.error, /SyntaxError/);

  const broken = await goldenOps({ size: '32x57', design: '1' }); // no barcodefinal: v1 throws before its own try block
  assert.match(broken.handlerError, /Cannot read properties of undefined/);
});

test('v1 is run fresh each time: no state leaks between payloads, and the console stays quiet', async () => {
  const seen = [];
  const original = console.log;
  console.log = (...args) => seen.push(args);
  try {
    const first = await goldenOps({ size: '32x57', design: '4', barcodefinal: bf() });
    const second = await goldenOps({ size: '32x57', design: '1', barcodefinal: bf() });
    assert.equal(first.labels.length, 1);
    assert.equal(second.labels.length, 1);
    assert.equal(second.ops.some((op) => op.kind === 'qr'), false);
  } finally {
    console.log = original;
  }
  assert.deepEqual(seen, [], 'the legacy handler logs a lot; the harness silences it');
  assert.equal(require.cache[LEGACY_INDEX], undefined);
});

test('v2Ops sees the same observation shape as goldenOps', async () => {
  const payload = { size: '32x57', design: '1', barcodefinal: bf() };
  const v1 = await goldenOps(payload);
  const v2 = v2Ops(payload);
  assert.deepEqual(Object.keys(v2).filter((key) => ['template', 'printer', 'ops', 'printed', 'error', 'labels'].includes(key)).sort(), ['error', 'labels', 'ops', 'printed', 'printer', 'template']);
  assert.deepEqual(v2.ops, v1.ops);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Fake window, fake electron, manual clock                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('FakeHiddenWindow: a thrown page error reaches the caller as Electron\'s generic message (verified in a real window), with the cause attached', async () => {
  const win = new FakeHiddenWindow();
  win.fake.setFrameworkLoaded(true);
  assert.equal(await win.webContents.executeJavaScript('1 + 2'), 3);
  const error = await win.webContents.executeJavaScript('throw new Error("page message")').catch((e) => e);
  assert.equal(error.message, GENERIC_SCRIPT_ERROR);
  assert.equal(error.cause.message, 'page message');
  win.destroy();
  await assert.rejects(win.webContents.executeJavaScript('1'), /destroyed/);
});

test('FakeHiddenWindow: the framework appears only after the page loaded and the configured number of calls', async () => {
  const win = new FakeHiddenWindow({ frameworkAfterCalls: 2 });
  assert.equal(win.fake.run('typeof dymo'), 'undefined');
  await win.loadFile('/x.html');
  assert.equal(await win.webContents.executeJavaScript('typeof dymo'), 'undefined');
  assert.equal(await win.webContents.executeJavaScript('typeof dymo'), 'undefined');
  assert.equal(await win.webContents.executeJavaScript('typeof dymo'), 'object');
});

test('createWindowFactory hands out windows by index and counts them', () => {
  const factory = createWindowFactory((index) => ({ load: index === 0 ? 'fail' : 'finish' }));
  const first = factory.createHiddenWindow();
  const second = factory.createHiddenWindow();
  assert.equal(factory.created, 2);
  assert.equal(first.loadMode, 'fail');
  assert.equal(second.loadMode, 'finish');
});

test('createManualClock: timers fire in order as time advances, clearTimeout works, unref is remembered', async () => {
  const clock = createManualClock(1000);
  const fired = [];
  clock.setTimeout(() => fired.push('b'), 200);
  const a = clock.setTimeout(() => fired.push('a'), 100);
  const cleared = clock.setTimeout(() => fired.push('never'), 150);
  clock.clearTimeout(cleared);
  const unrefd = clock.setTimeout(() => fired.push('c'), 300).unref();
  assert.equal(clock.pending(), 3);
  assert.equal(clock.pendingRefed(), 2);
  assert.equal(unrefd.hasRef(), false);
  assert.equal(a.hasRef(), true);
  await clock.advance(250);
  assert.deepEqual(fired, ['a', 'b']);
  assert.equal(clock.now(), 1250);
  await clock.advance(50);
  assert.deepEqual(fired, ['a', 'b', 'c']);
  assert.equal(clock.pending(), 0);
});

test('createManualClock: a timer set by a firing timer fires in the same advance when due; tick() steps', async () => {
  const clock = createManualClock(0);
  const order = [];
  clock.setTimeout(() => {
    order.push('first');
    clock.setTimeout(() => order.push('second'), 50);
  }, 100);
  await clock.advance(200);
  assert.deepEqual(order, ['first', 'second']);
  let ticks = 0;
  const later = () => {
    ticks += 1;
    if (ticks < 3) clock.setTimeout(later, 50);
  };
  clock.setTimeout(later, 50);
  await clock.tick(200, 50);
  assert.equal(ticks, 3);
});

test('createFakeElectron: windows, events, ipc, app, dialog and screen stand in for electron', async () => {
  const fake = createFakeElectron({ version: '9.9.9', displays: [{ id: 7, workAreaSize: { width: 1000, height: 700 } }] });
  const { BrowserWindow, ipcMain, app, dialog, shell, screen, Menu, session } = fake.electron;
  const win = new BrowserWindow({ width: 100, height: 50 });
  const events = [];
  win.webContents.on('did-finish-load', () => events.push('loaded'));
  win.on('closed', () => events.push('closed'));
  await win.loadFile('/page.html');
  assert.deepEqual(events, ['loaded']);
  assert.equal(win.webContents.getURL(), 'file:///page.html');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  win.close();
  assert.deepEqual(events, ['loaded', 'closed']);
  assert.equal(win.isDestroyed(), true);
  assert.equal(BrowserWindow.getAllWindows().length, 0);

  const heard = [];
  ipcMain.on('chan', async (event, value) => heard.push(value));
  ipcMain.handle('ask', (event, value) => `answer ${value}`);
  await ipcMain.simulateSend('chan', 5);
  assert.deepEqual(heard, [5]);
  assert.equal(await ipcMain.simulateInvoke('ask', 'x'), 'answer x');
  await assert.rejects(ipcMain.simulateInvoke('nothing'), /no handler/);
  assert.deepEqual(ipcMain.channels(), { on: ['chan'], handle: ['ask'] });

  assert.equal(app.getVersion(), '9.9.9');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-brotli');
  assert.equal(fake.state.hardwareAcceleration, false);
  assert.equal(app.commandLine.hasSwitch('disable-brotli'), true);
  dialog.showErrorBox('t', 'c');
  assert.deepEqual(fake.state.errorBoxes, [{ title: 't', content: 'c' }]);
  await shell.openExternal('https://example.com');
  assert.deepEqual(fake.state.externalUrls, ['https://example.com']);
  assert.equal(screen.getPrimaryDisplay().id, 7);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'x' }]));
  assert.equal(fake.state.applicationMenu.items[0].label, 'x');
  session.defaultSession.preconnect({ url: 'https://x', numSockets: 4 });
  assert.equal(fake.state.preconnects.length, 1);
  assert.equal(app.isReady(), false);
});

test('interceptModules returns stubs only while installed and restores the real loader', () => {
  const restore = interceptModules({ 'definitely-not-installed-module': { stubbed: true } });
  assert.deepEqual(require('definitely-not-installed-module'), { stubbed: true });
  assert.equal(require('node:path'), path, 'other modules load normally');
  restore();
  assert.throws(() => require('definitely-not-installed-module'), /Cannot find module/);
  const calls = [];
  const restoreFn = interceptModules((request, parent) => {
    calls.push(request);
    return request === 'virtual-one' ? 1 : undefined;
  });
  assert.equal(require('virtual-one'), 1);
  restoreFn();
  assert.ok(calls.includes('virtual-one'));
  assert.equal(typeof Module._load, 'function');
});

test('silenceConsole mutes the five console methods and restores them', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const before = methods.map((name) => console[name]);
  const restore = silenceConsole();
  for (const name of methods) assert.notEqual(console[name], before[methods.indexOf(name)]);
  assert.doesNotThrow(() => console.error('muted'));
  restore();
  methods.forEach((name, index) => assert.equal(console[name], before[index]));
});
