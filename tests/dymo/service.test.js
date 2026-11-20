'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManualClock } = require('../helpers/fake-electron');
const { createWindowFactory, FakeHiddenWindow, summarizeCalls, LABELS_DIR } = require('../helpers/vm-dymo');
const { createDymoService, createTestLabelPayload, PRINTER_CACHE_MS } = require('../../src/main/printing/dymo/index');
const { ERROR_CODES, userMessage } = require('../../src/main/errors');
const { DYMO_IDLE_DISPOSE_MS } = require('../../src/main/printing/dymo/window');
const { LIST_PRINTERS_SCRIPT } = require('../../src/main/printing/dymo/script');

const POUND = '£';

/** A service on a manual clock with fake windows. */
function setup(options = {}) {
  const clock = createManualClock();
  const factory = createWindowFactory(options.windows || {});
  const logged = [];
  const log = {
    info: (message) => logged.push(['info', message]),
    warn: (message) => logged.push(['warn', message]),
    error: (message) => logged.push(['error', message]),
  };
  const reads = [];
  const readFile =
    options.readFile ||
    (async (file, encoding) => {
      reads.push([file, encoding]);
      return fs.readFileSync(file, encoding);
    });
  const config = options.config ?? {};
  const service = createDymoService({
    createHiddenWindow: factory.createHiddenWindow,
    labelsDir: LABELS_DIR,
    readFile,
    getConfig: () => config,
    log,
    timers: clock,
    ...options.service,
  });
  return { service, clock, factory, logged, reads };
}

const message = (extra = {}, envelope = {}) => ({
  size: '32x57',
  design: '1',
  barcodefinal: { printer: 'dymo', title: 'iPhone 13', barcode: 'ABCDEFGH123456', price: '10', conditionObject: { grade: 'New' }, ...extra },
  ...envelope,
});

const labelsOf = (win) => summarizeCalls(win.fake.calls);
const listRuns = (win) => win.scripts.filter((script) => script === LIST_PRINTERS_SCRIPT).length;
const textOf = (label, name) => label.ops.find((op) => op.name === name)?.value;

/* ---------------------------------------------------------------------------------------------------------- */
/* Start-up and the happy path                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

test('creating the service creates no window, reads no file and sets no timer (nothing at startup)', () => {
  const { factory, reads, clock } = setup();
  assert.equal(factory.created, 0);
  assert.equal(reads.length, 0);
  assert.equal(clock.pending(), 0);
});

test('createDymoService needs a window factory, a labels folder and a file reader', () => {
  const ok = { createHiddenWindow() {}, labelsDir: '/x', readFile() {} };
  assert.doesNotThrow(() => createDymoService(ok));
  for (const missing of ['createHiddenWindow', 'labelsDir', 'readFile']) assert.throws(() => createDymoService({ ...ok, [missing]: undefined }), TypeError, missing);
  assert.throws(() => createDymoService(), TypeError);
});

test('a label prints: { ok: true }, one label on the first connected LabelWriter, template read from the labels folder', async () => {
  const { service, factory, reads } = setup();
  assert.deepEqual(await service.print(message()), { ok: true });
  const [label] = labelsOf(factory.windows[0]);
  assert.equal(label.printed, true);
  assert.equal(label.printer, 'DYMO LabelWriter 450');
  assert.equal(textOf(label, 'ItemNameVal'), 'iPhone 13');
  assert.equal(textOf(label, 'TEXT_4'), 'NEW');
  assert.equal(textOf(label, 'TEXT_3'), `${POUND}10`);
  assert.deepEqual(reads, [[path.join(LABELS_DIR, 'Labeldesign1_1.dymo'), 'utf8']]);
});

test('design 2 renames its QR object with the injected clock (deterministic) and writes the barcode', async () => {
  const { service, factory } = setup();
  assert.deepEqual(await service.print(message({}, { design: '2' })), { ok: true });
  const win = factory.windows[0];
  const open = win.fake.calls.find((call) => call.type === 'open' && call.xml.includes('QRCodeObject0_'));
  assert.ok(open.xml.includes('<Name>QRCodeObject0_1700000000000</Name>'));
  assert.equal(labelsOf(win)[0].embeds[0].data, 'ABCDEFGH123456');
});

test('the sample label for Settings > Test prints design 1 at 32x57 with sample values', async () => {
  const { service, factory } = setup();
  assert.deepEqual(await service.print(createTestLabelPayload()), { ok: true });
  const [label] = labelsOf(factory.windows[0]);
  assert.equal(textOf(label, 'ItemNameVal'), 'GadgetsPOS test label');
  assert.equal(textOf(label, 'TEXT_4'), 'NEW');
  assert.equal(textOf(label, 'TEXT_3'), `${POUND}99.99`);
  assert.equal(textOf(label, 'BARCODE'), '1234567890');
  assert.equal(factory.windows[0].fake.calls.filter((call) => call.type === 'open').length, 1);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Performance guarantees (SPEC 18b L2, R4)                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('ONE window, ONE template read and ONE printer lookup for 100 labels', async () => {
  const { service, factory, reads, clock } = setup();
  for (let i = 0; i < 100; i += 1) {
    const result = await service.print(message({ barcode: `BC${i}`, title: `Item ${i}` }));
    assert.equal(result.ok, true, `label ${i}`);
  }
  const win = factory.windows[0];
  assert.equal(factory.created, 1);
  assert.equal(reads.length, 1, 'the template XML is cached');
  assert.equal(listRuns(win), 1, 'the printer list is cached');
  const labels = labelsOf(win);
  assert.equal(labels.length, 100);
  assert.ok(labels.every((label) => label.printed));
  assert.equal(textOf(labels[99], 'ItemNameVal'), 'Item 99');
  assert.equal(clock.pendingRefed(), 0, 'no timer keeps the process alive');
});

test('printer list cache: reused for 30 s, looked up again after that', async () => {
  const { service, factory, clock } = setup();
  assert.equal(PRINTER_CACHE_MS, 30_000);
  await service.print(message());
  const win = factory.windows[0];
  await clock.advance(PRINTER_CACHE_MS - 1);
  await service.print(message());
  assert.equal(listRuns(win), 1);
  await clock.advance(1);
  await service.print(message());
  assert.equal(listRuns(win), 2, 'expired after 30 s');
  assert.equal(factory.created, 1);
});

test('any failure drops the printer list: the next label asks DYMO again', async () => {
  const { service, factory } = setup();
  await service.print(message());
  const win = factory.windows[0];
  assert.equal(listRuns(win), 1);
  win.fake.setFailPrint(() => 'The printer is out of labels');
  const failed = await service.print(message());
  assert.equal(failed.ok, false);
  win.fake.setFailPrint(null);
  assert.equal((await service.print(message())).ok, true);
  assert.equal(listRuns(win), 2, 'looked up again after the failure');
  await service.print(message());
  assert.equal(listRuns(win), 2, 'and cached again');
});

test('an empty printer list is not cached: DYMO Connect started a moment later works at once', async () => {
  const { service, factory } = setup({ windows: { dymo: { printers: [] } } });
  const first = await service.print(message());
  assert.equal(first.code, 'DYMO_NO_PRINTER');
  factory.windows[0].fake.setPrinters([{ name: 'DYMO LabelWriter 450' }]);
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(listRuns(factory.windows[0]), 2);
});

test('an empty list that Settings looked up is not remembered either: a label sent right after DYMO Connect started prints', async () => {
  const { service, factory } = setup({ windows: { dymo: { printers: [] } } });
  const listed = await service.listPrinters();
  assert.deepEqual(listed.printers, []);
  factory.windows[0].fake.setPrinters([{ name: 'DYMO LabelWriter 450' }]);
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(listRuns(factory.windows[0]), 2);
});

test('the window is disposed after 10 idle minutes and rebuilt for the next label; the template cache stays, the printer list is looked up again', async () => {
  const { service, factory, clock, reads } = setup();
  await service.print(message());
  await clock.advance(DYMO_IDLE_DISPOSE_MS);
  assert.equal(factory.windows[0].destroyed, true);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(factory.created, 2);
  assert.equal(listRuns(factory.windows[1]), 1, 'the new window looked the printers up');
  assert.equal(reads.length, 1, 'the template was not read again');
});

test('ten labels sent at once on a cold service: one window, one printer lookup, all printed', async () => {
  const { service, factory } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => service.print(message({ title: `Item ${i}` }))));
  assert.ok(results.every((result) => result.ok === true));
  assert.equal(factory.created, 1);
  assert.equal(listRuns(factory.windows[0]), 1);
  assert.equal(labelsOf(factory.windows[0]).length, 10);
});

test('dispose() destroys the window and drops the caches; printing afterwards builds a new window', async () => {
  const { service, factory, clock, reads } = setup();
  await service.print(message());
  service.dispose();
  assert.equal(factory.windows[0].destroyed, true);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(factory.created, 2);
  assert.equal(reads.length, 2, 'the template cache was dropped too');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Printer choice and configuration                                                                            */
/* ---------------------------------------------------------------------------------------------------------- */

const TWO_PRINTERS = [
  { name: 'DYMO LabelWriter 450', isConnected: true },
  { name: 'DYMO LabelWriter 4XL', isConnected: true },
];

test('the configured printer is used (config object with get(), or a plain snapshot)', async () => {
  const asObject = { get: (key, fallback) => (key === 'printers.dymo.printerName' ? 'dymo labelwriter 4xl' : fallback) };
  const asSnapshot = { printers: { dymo: { printerName: 'DYMO LabelWriter 4XL' } } };
  for (const config of [asObject, asSnapshot]) {
    const { service, factory } = setup({ windows: { dymo: { printers: TWO_PRINTERS } }, config });
    assert.deepEqual(await service.print(message()), { ok: true });
    assert.equal(labelsOf(factory.windows[0])[0].printer, 'DYMO LabelWriter 4XL');
  }
});

test('the configuration is read for every label, so a change in Settings applies at once', async () => {
  let name = '';
  const { service, factory } = setup({ windows: { dymo: { printers: TWO_PRINTERS } }, config: { get: () => name } });
  await service.print(message());
  name = 'DYMO LabelWriter 4XL';
  await service.print(message());
  assert.deepEqual(
    labelsOf(factory.windows[0]).map((label) => label.printer),
    ['DYMO LabelWriter 450', 'DYMO LabelWriter 4XL']
  );
});

test('no configuration, an unusable one, or one that throws: automatic choice', async () => {
  for (const getConfig of [() => undefined, () => null, () => ({}), () => ({ get: () => 42 }), () => ({ printers: 'x' }), () => {
    throw new Error('config broke');
  }]) {
    const { service, factory } = setup({ windows: { dymo: { printers: TWO_PRINTERS } }, service: { getConfig } });
    assert.deepEqual(await service.print(message()), { ok: true });
    assert.equal(labelsOf(factory.windows[0])[0].printer, 'DYMO LabelWriter 450');
  }
});

test('a configured printer that DYMO does not list: it still prints, on another printer, and a warning is logged', async () => {
  const { service, factory, logged } = setup({ windows: { dymo: { printers: TWO_PRINTERS } }, config: { get: () => 'Zebra' } });
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(labelsOf(factory.windows[0])[0].printer, 'DYMO LabelWriter 450');
  assert.ok(logged.some(([level, text]) => level === 'warn' && /configured DYMO printer was not found/.test(text)));
});

test('a printer name with quotes, backslashes and line separators reaches the framework untouched', async () => {
  const name = `Front "desk" \\ \`DYMO\` \${x} ${String.fromCharCode(0x2028)} 450`;
  const { service, factory } = setup({ windows: { dymo: { printers: [{ name }] } } });
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(labelsOf(factory.windows[0])[0].printer, name);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Failures                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('no DYMO printer: DYMO_NO_PRINTER with the SPEC message', async () => {
  const { service } = setup({ windows: { dymo: { printers: [] } } });
  const result = await service.print(message());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DYMO_NO_PRINTER');
  assert.equal(result.message, 'No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on.', 'the SPEC (section 7) wording');
  assert.equal(result.message, userMessage(ERROR_CODES.DYMO_NO_PRINTER));
  assert.deepEqual(result.details, { reason: 'DYMO lists no printer.', printed: 0, total: 1 });
});

test('the helper window cannot be loaded: DYMO_UNAVAILABLE, and the next label works', async () => {
  const { service, factory } = setup({ windows: (index) => (index === 0 ? { load: 'fail' } : {}) });
  const result = await service.print(message());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DYMO_UNAVAILABLE');
  assert.equal(result.message, userMessage(ERROR_CODES.DYMO_UNAVAILABLE, result.details));
  assert.deepEqual({ printed: result.details.printed, total: result.details.total }, { printed: 0, total: 1 });
  assert.match(result.details.reason, /failed to load/);
  assert.deepEqual(await service.print(message()), { ok: true });
  assert.equal(factory.created, 2);
});

test('the framework never appears in the window: DYMO_UNAVAILABLE after the wait', async () => {
  const { service, clock } = setup({ windows: { frameworkAfterCalls: Infinity } });
  const pending = service.print(message());
  await clock.tick(6000);
  const result = await pending;
  assert.equal(result.code, 'DYMO_UNAVAILABLE');
});

test('a missing template file: DYMO_TEMPLATE_MISSING, no window is created for it, and the failure is not cached', async () => {
  let present = false;
  const { service, factory } = setup({
    readFile: async (file, encoding) => {
      if (!present) throw Object.assign(new Error(`ENOENT: no such file ${file}`), { code: 'ENOENT' });
      return fs.readFileSync(file, encoding);
    },
  });
  const result = await service.print(message());
  assert.equal(result.code, 'DYMO_TEMPLATE_MISSING');
  assert.equal(result.message, userMessage(ERROR_CODES.DYMO_TEMPLATE_MISSING));
  assert.match(result.details.reason, /Labeldesign1_1\.dymo could not be read/);
  assert.equal(factory.created, 0, 'nothing is started for a label that cannot be printed anyway');
  present = true;
  assert.deepEqual(await service.print(message()), { ok: true });
});

test('a template that lacks the QR object its design needs: DYMO_TEMPLATE_MISSING (not a label with the sample QR code)', async () => {
  const { service, factory } = setup({
    readFile: async (file, encoding) => fs.readFileSync(file, encoding).replace(/QRCodeObject0/g, 'SomethingElse'),
  });
  const result = await service.print(message({}, { design: '2' }));
  assert.equal(result.code, 'DYMO_TEMPLATE_MISSING');
  assert.match(result.details.reason, /QRCodeObject0/);
  assert.equal(labelsOf(factory.windows[0] ?? { fake: { calls: [] } }).filter((label) => label.printed).length, 0);
});

test('DYMO refuses the label: DYMO_PRINT_FAILED, the shared plain message, and the framework message in details.reason', async () => {
  const { service, factory } = setup();
  await service.print(message());
  factory.windows[0].fake.setFailPrint(() => 'The label roll is empty');
  const result = await service.print(message());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DYMO_PRINT_FAILED');
  assert.equal(result.message, userMessage(ERROR_CODES.DYMO_PRINT_FAILED, result.details));
  assert.equal(result.details.reason, 'The label roll is empty');
  assert.deepEqual({ printed: result.details.printed, total: result.details.total }, { printed: 0, total: 1 });
});

test('the label object is missing from the template: the framework message arrives in details.reason (not Electron\'s generic one)', async () => {
  const { service } = setup({
    readFile: async (file, encoding) => fs.readFileSync(file, encoding).replace('<Name>ItemNameVal</Name>', '<Name>Renamed</Name>'),
  });
  const result = await service.print(message());
  assert.equal(result.code, 'DYMO_PRINT_FAILED');
  assert.match(result.details.reason, /no object with name 'ItemNameVal' was found/);
});

/** The label script (not the readiness probe or the printer list) is the one that opens the label XML. */
const isLabelScript = (code) => code.includes('framework.openLabelXml(labelXml)');

function serviceWithWindow(WindowClass) {
  return createDymoService({
    createHiddenWindow: () => new WindowClass({}),
    labelsDir: LABELS_DIR,
    readFile: async (file, encoding) => fs.readFileSync(file, encoding),
    timers: createManualClock(),
  });
}

test('a script that the window rejects (not a framework message) is DYMO_PRINT_FAILED too', async () => {
  class Rejecting extends FakeHiddenWindow {
    _execute(code) {
      if (isLabelScript(code)) return Promise.reject(new Error('Render frame was disposed before WebFrameMain could be accessed'));
      return super._execute(code);
    }
  }
  const result = await serviceWithWindow(Rejecting).print(message());
  assert.equal(result.code, 'DYMO_PRINT_FAILED');
  assert.match(result.details.reason, /Render frame was disposed/);
});

test('DYMO Connect hangs while printing: after 20 s the label fails with DYMO_UNAVAILABLE, and the next label works on a new window', async () => {
  const clock = createManualClock();
  const windows = [];
  class HangsOnFirstLabel extends FakeHiddenWindow {
    _execute(code) {
      if (isLabelScript(code) && windows.indexOf(this) === 0) return new Promise(() => {});
      return super._execute(code);
    }
  }
  const svc = createDymoService({
    createHiddenWindow: () => {
      const win = new HangsOnFirstLabel({});
      windows.push(win);
      return win;
    },
    labelsDir: LABELS_DIR,
    readFile: async (file, encoding) => fs.readFileSync(file, encoding),
    timers: clock,
  });
  const pending = svc.print(message());
  await clock.tick(20_500, 500);
  const result = await pending;
  assert.equal(result.code, 'DYMO_UNAVAILABLE');
  assert.match(result.details.reason, /did not answer in time/);
  assert.deepEqual({ printed: result.details.printed, total: result.details.total }, { printed: 0, total: 1 });
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(await svc.print(message()), { ok: true });
  assert.equal(windows.length, 2);
});

test('a window that answers something unreadable is DYMO_PRINT_FAILED', async () => {
  class Mute extends FakeHiddenWindow {
    _execute(code) {
      if (isLabelScript(code)) return Promise.resolve('not json');
      return super._execute(code);
    }
  }
  const result = await serviceWithWindow(Mute).print(message());
  assert.equal(result.code, 'DYMO_PRINT_FAILED');
  assert.match(result.details.reason, /did not confirm/);
});

test('invalid payloads are INVALID_PAYLOAD; nothing is read or created for them; print never throws', async () => {
  const { service, factory, reads } = setup();
  const cases = [
    undefined,
    null,
    'a string',
    42,
    [],
    {},
    { barcodefinal: 'ZPL text' }, // the Zebra path
    { barcodefinal: null },
    { barcodefinal: [] },
    { barcodefinal: { printer: 'zebra' } },
    { barcodefinal: {} },
    { barcodefinal: { printer: 'DYMO' } },
    message({ design: 'repair' }, { barcodefinal: { printer: 'dymo', design: 'repair', orderItems: [] } }),
  ];
  for (const payload of cases) {
    const result = await service.print(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, 'INVALID_PAYLOAD', JSON.stringify(payload));
    assert.equal(typeof result.message, 'string');
    assert.equal(result.details, undefined, 'no print was attempted');
  }
  assert.equal(factory.created, 0);
  assert.equal(reads.length, 0);
});

test('INVALID_PAYLOAD says why: a repair message with no items', async () => {
  const { service } = setup();
  const result = await service.print({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R-1', orderItems: [] } });
  assert.equal(result.message, 'The repair label has no items to print.');
});

test('a payload whose properties throw when read is a failed Result, not an exception', async () => {
  const { service } = setup();
  const hostile = {
    get barcodefinal() {
      throw new Error('getter exploded');
    },
  };
  const result = await service.print(hostile);
  assert.equal(result.ok, false);
  assert.equal(typeof result.code, 'string');
});

test('too much label text is INVALID_PAYLOAD (a single long text is only cut)', async () => {
  const { service, factory } = setup();
  const long = await service.print(message({ title: 'x'.repeat(300_000) }));
  assert.deepEqual(long, { ok: true });
  assert.equal(textOf(labelsOf(factory.windows[0])[0], 'ItemNameVal').length, 2048);
  const items = Array.from({ length: 100 }, (_, i) => ({ product_name: 'p'.repeat(2000), custom_field_value: [{ value: 'c'.repeat(2000) }, { value: 'd'.repeat(2000) }] }));
  const tooMuch = await service.print({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R', orderItems: items } });
  assert.equal(tooMuch.code, 'INVALID_PAYLOAD');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Repair messages: one label per item, stop at the first failure                                              */
/* ---------------------------------------------------------------------------------------------------------- */

const repairMessage = (names) => ({
  barcodefinal: {
    printer: 'dymo',
    design: 'repair',
    barcode: 'R-1042',
    orderDate: '2026-11-19',
    customer: { name: 'Jo', cell_no: '0700' },
    business: { business_name: 'Shop', branch_name: 'Main' },
    orderItems: names.map((name) => ({ product_name: name, custom_field_value: [{ value: 'Cracked' }] })),
  },
});

test('a repair message prints one label per item, in order, on one printer, reading the template once', async () => {
  const { service, factory, reads } = setup();
  assert.deepEqual(await service.print(repairMessage(['iPhone 13', 'iPad Air', 'Watch'])), { ok: true });
  const labels = labelsOf(factory.windows[0]);
  assert.deepEqual(
    labels.map((label) => textOf(label, 'ItemNameVal')),
    ['iPhone 13', 'iPad Air', 'Watch']
  );
  assert.ok(labels.every((label) => label.printed && label.printer === 'DYMO LabelWriter 450'));
  assert.equal(reads.length, 1);
});

test('a repair message stops at the first failed label and reports how many were printed', async () => {
  const { service, factory } = setup();
  await service.print(message()); // warm the window so the failure counter starts clean
  let prints = 0;
  factory.windows[0].fake.setFailPrint(() => {
    prints += 1;
    return prints === 2 ? 'The printer is out of labels' : undefined;
  });
  const result = await service.print(repairMessage(['one', 'two', 'three']));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DYMO_PRINT_FAILED');
  assert.deepEqual({ printed: result.details.printed, total: result.details.total }, { printed: 1, total: 3 });
  assert.match(result.message, /1 of 3 labels were printed\.$/);
  assert.equal(result.message, userMessage(ERROR_CODES.DYMO_PRINT_FAILED, result.details));
  assert.equal(result.details.reason, 'The printer is out of labels');
  const opened = factory.windows[0].fake.calls.filter((call) => call.type === 'open').length;
  assert.equal(opened, 1 + 2, 'the warm-up label, then the first two labels of the message; the third is never opened');
});

test('a single-label failure does not claim "labels were printed"', async () => {
  const { service, factory } = setup();
  await service.print(message());
  factory.windows[0].fake.setFailPrint(() => 'boom');
  const result = await service.print(message());
  assert.doesNotMatch(result.message, /labels were printed/);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* listPrinters                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('listPrinters asks DYMO afresh every time and returns plain printer records', async () => {
  const { service, factory } = setup({ windows: { dymo: { printers: [{ name: 'DYMO LabelWriter 450', isConnected: true }, { name: 'DYMO LabelManager PnP', printerType: 'TapePrinter', isConnected: false }] } } });
  const first = await service.listPrinters();
  assert.deepEqual(first, {
    printers: [
      { name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true },
      { name: 'DYMO LabelManager PnP', modelName: 'DYMO LabelWriter 450', printerType: 'TapePrinter', isConnected: false, isLocal: true },
    ],
  });
  await service.listPrinters();
  assert.equal(listRuns(factory.windows[0]), 2, 'Settings has a refresh button: the answer is never served from the cache');
  assert.equal(factory.created, 1);
});

test('listPrinters feeds the printer cache that print() uses', async () => {
  const { service, factory } = setup();
  await service.listPrinters();
  await service.print(message());
  assert.equal(listRuns(factory.windows[0]), 1);
});

test('listPrinters with no printer says why (DYMO Connect hint); with a dead window it says the software could not start; then it recovers', async () => {
  const { service } = setup({ windows: { dymo: { printers: [] } } });
  assert.deepEqual(await service.listPrinters(), { printers: [], error: userMessage(ERROR_CODES.DYMO_NO_PRINTER) });

  const { service: broken } = setup({ windows: (index) => (index === 0 ? { load: 'fail' } : {}) });
  assert.deepEqual(await broken.listPrinters(), { printers: [], error: userMessage(ERROR_CODES.DYMO_UNAVAILABLE) });
  const recovered = await broken.listPrinters();
  assert.equal(recovered.printers.length, 1);
  assert.equal(recovered.error, undefined);
});

test('a framework error while listing is reported as DYMO not available', async () => {
  const { service, factory } = setup();
  await service.listPrinters();
  const win = factory.windows[0];
  // the framework throws inside getPrinters(): the list script answers {"error": ...}
  win.fake.dymo.label.framework.getPrinters = () => {
    throw new Error('service not reachable');
  };
  assert.deepEqual(await service.listPrinters(), { printers: [], error: userMessage(ERROR_CODES.DYMO_UNAVAILABLE) });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Template line breaks, logging                                                                               */
/* ---------------------------------------------------------------------------------------------------------- */

test('line breaks are removed from the template as in v1 (default), and kept with stripLineBreaks: false', async () => {
  const stripped = setup();
  await stripped.service.print(message());
  const xml = stripped.factory.windows[0].fake.calls.find((call) => call.type === 'open').xml;
  assert.ok(!xml.includes('\n'));
  assert.ok(xml.charCodeAt(0) === 0xfeff, 'the byte order mark is kept, as in v1');

  const kept = setup({ service: { stripLineBreaks: false } });
  await kept.service.print(message());
  assert.ok(kept.factory.windows[0].fake.calls.find((call) => call.type === 'open').xml.includes('\n'));
});

test('logs carry the job kind, size, design, outcome, duration and code, and no customer data', async () => {
  const { service, factory, logged } = setup();
  await service.print(message({ title: 'SECRET-TITLE-123', barcode: 'SECRET-BARCODE-999', storage: 'SECRET-STORAGE' }));
  factory.windows[0].fake.setFailPrint(() => 'a framework failure');
  await service.print(message({ title: 'SECRET-TITLE-456', barcode: 'SECRET-BARCODE-888' }));
  await service.print({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'SECRET-R', customer: { name: 'SECRET-CUSTOMER' }, orderItems: [] } });
  const lines = logged.map(([, text]) => text);
  assert.ok(lines.some((line) => /^label dymo 32x57 design 1: 1 of 1 printed in \d+ ms$/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /label dymo 32x57 design 1: failed \(DYMO_PRINT_FAILED\) after 0 of 1/.test(line)));
  assert.ok(lines.some((line) => /label dymo: failed \(INVALID_PAYLOAD\)/.test(line)));
  for (const line of lines) assert.doesNotMatch(line, /SECRET/, line);
});
