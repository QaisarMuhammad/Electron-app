// contract-matrix, combination 3: the NEW web util (and the real handlers of the new web source) against the NEW desktop (real preload, real src/main).
// Covers results, failures (Result ok:false), the feedback events and snackbars, the multi-label loops, and the cash drawer dialog.
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=170000 tests/verify/c4-new-web-new-desktop.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootNewDesktop, connectPage, makeWebDesktop, web, dymoLabelsOf, hex, lib, PrintError, cutWeb, instantiate, pairs, opValue } from './_kit.mjs';
import * as P from './_payloads.mjs';
import { SITES, buildHandler, quietConsole, spy } from './_sites.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c4 report ====\n' + REPORT.join('\n')));

const setup = async (options = {}) => {
  const boot = await bootNewDesktop(options);
  const page = connectPage(boot.world);
  const wd = makeWebDesktop(page.electron);
  return { ...boot, page, ...wd };
};
const failFromSecond = () => { let n = 0; return () => (++n >= 2 ? 'Out of labels' : undefined); };

// =====================================================================================================================================================
// 4A. results
// =====================================================================================================================================================
test('4A. getDesktopInfo is the app\'s answer once; every util call answers a Result; the desktop is sent ONLY the bytes of a receipt and the normalised label', async () => {
  const t = await setup();
  const info = await t.desktop.getDesktopInfo();
  assert.deepEqual(Object.keys(info).sort(), ['apiVersion', 'features', 'name', 'platform', 'version']);
  assert.equal(info.apiVersion, 2);
  assert.deepEqual(info.features, ['ack-print', 'drawer', 'printer-list']);
  assert.equal(await t.desktop.getDesktopInfo(), info, 'asked once and cached');
  assert.equal(t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'app-info').length, 1);

  // a full legacy receipt payload: only the bytes cross to the app
  const bytes = await P.saleReceiptBytes();
  const full = { receiptFileBinary: bytes, order: P.sampleOrder(), isDuplicate: false, business: P.sampleBusiness(), businessData: {}, settings: { ...P.sampleSettings(), notes: 'S'.repeat(50000) } };
  assert.deepEqual(await t.desktop.sendReceipt(full), { ok: true });
  const sentToApp = t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-receipt').at(-1).args[0];
  assert.deepEqual(Object.keys(sentToApp), ['receiptFileBinary'], 'only the bytes');
  assert.deepEqual(t.world.rawPrinter.jobs.at(-1).bytes, bytes);
  // the Open button
  const open = await t.desktop.sendReceipt({ isDuplicate: false, order: false, business: P.sampleBusiness(), businessData: false, openCashDrawer: true, settings: P.sampleSettings() });
  assert.deepEqual(open, { ok: true, details: { prompted: true } });
  assert.deepEqual(t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-receipt').at(-1).args[0], { openCashDrawer: true });
  assert.equal(t.world.services().passwordWindow.isOpen(), true);
  // a label: processor under both keys on the wire
  const q = await P.quickAdd('dymo', { processor: 'Snapdragon 8 Gen 2' });
  assert.deepEqual(await t.desktop.sendLabel(q), { ok: true });
  const wire = t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-barcode').at(-1).args[0];
  assert.equal(wire.barcodefinal.Processor, 'Snapdragon 8 Gen 2');
  assert.equal(wire.barcodefinal.processor, 'Snapdragon 8 Gen 2');
  assert.equal(wire.currency, 'GBP', 'currency is the call site\'s, never invented');
  assert.equal(Object.hasOwn(P.box(), 'currency'), false);
  // a box label has no currency: none is invented
  await t.desktop.sendLabel(P.box());
  assert.equal(Object.hasOwn(t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-barcode').at(-1).args[0], 'currency'), false);
  assert.deepEqual(t.events, []);
  t.world.cleanup();
});

test('4A. a plain browser page on a NOT allowed origin gets no window.electron: the util answers DESKTOP_UNAVAILABLE and nothing reaches the printers', async () => {
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world, { origin: 'https://evil.example.com' });
  assert.deepEqual(Object.keys(page.exposed), [], 'nothing exposed');
  const { desktop, events } = makeWebDesktop(page.exposed.electron);
  assert.equal(desktop.isDesktopApp(), false);
  assert.equal((await desktop.sendReceipt({ receiptFileBinary: Buffer.from([1]) })).code, 'DESKTOP_UNAVAILABLE');
  assert.equal(boot.world.rawPrinter.jobs.length, 0);
  assert.equal(events.length, 1);
  boot.world.cleanup();
});

// =====================================================================================================================================================
// 4B. failures and feedback
// =====================================================================================================================================================
test('4B. printer problems come back as Results with the desktop\'s own code and message, and each is raised ONCE as feedback { level, code, message }', async () => {
  const t = await setup({ printers: false });
  const bytes = await P.saleReceiptBytes();
  let r = await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: P.sampleOrder() });
  assert.deepEqual([r.ok, r.code], [false, 'NO_PRINTER_CONFIGURED']);
  assert.match(r.message, /Open Settings > Printers/);
  assert.deepEqual(t.events, [{ level: 'error', code: 'NO_PRINTER_CONFIGURED', message: r.message }]);
  // the same failure again within 4 s: not raised a second time
  await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: P.sampleOrder() });
  assert.equal(t.events.length, 1);
  t.config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  t.world.rawPrinter.failWith = new PrintError('PRINTER_NOT_FOUND', undefined, { printerName: 'EPSON TM-T20' });
  r = await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: P.sampleOrder() });
  assert.equal(r.code, 'PRINTER_NOT_FOUND');
  assert.match(r.message, /The printer "EPSON TM-T20" was not found/);
  assert.equal(t.events.length, 2);
  for (const code of ['SPOOLER_ERROR', 'PRINT_TIMEOUT', 'PORT_WRITE_FAILED', 'UNSUPPORTED_PLATFORM']) {
    t.world.rawPrinter.failWith = new PrintError(code);
    r = await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: P.sampleOrder() });
    assert.equal(r.code, code);
    assert.equal(t.events.at(-1).code, code);
  }
  // an unexpected (non PrintError) failure inside the printer: UNKNOWN with the generic text, never the raw error
  t.world.rawPrinter.failWith = new Error('ENOENT: secret C:\\Users\\Shop\\path');
  r = await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: P.sampleOrder() });
  assert.equal(r.code, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(r), /secret|C:\\Users/);
  note(`[4B] feedback events raised: ${t.events.map((e) => e.code).join(', ')}`);
  t.world.cleanup();
});

test('4B. label problems: no DYMO printer, DYMO helper window that cannot load, a printer that refuses, no Zebra printer set: Result + one event each', async () => {
  const none = await setup({ dymoFramework: { printers: [] } });
  let r = await none.desktop.sendLabel(await P.modal('dymo'));
  assert.deepEqual([r.ok, r.code], [false, 'DYMO_NO_PRINTER']);
  assert.match(r.message, /DYMO Connect is running and the printer is switched on/);
  assert.equal(none.events.length, 1);
  none.world.cleanup();

  const unavailable = await setup({ dymoWindow: { load: 'fail' } });
  r = await unavailable.desktop.sendLabel(await P.modal('dymo'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DYMO_UNAVAILABLE');
  note(`[4B] DYMO helper window cannot load -> ${r.code}: ${r.message}`);
  unavailable.world.cleanup();

  const refuses = await setup({ dymoFramework: { failPrint: () => 'Out of labels' } });
  r = await refuses.desktop.sendLabel(await P.modal('dymo'));
  assert.deepEqual([r.ok, r.code], [false, 'DYMO_PRINT_FAILED']);
  assert.equal(r.details.reason, 'Out of labels');
  assert.match(r.message, /label roll and the printer/);
  refuses.world.cleanup();

  const nozebra = await setup({ printers: false });
  r = await nozebra.desktop.sendLabel(await P.modal('zebra'));
  assert.deepEqual([r.ok, r.code], [false, 'NO_PRINTER_CONFIGURED']);
  nozebra.world.cleanup();
});

test('4B. a multi-label message (repair with orderItems, SPEC 9.4) stops at its first failure and the web shows "N of M labels were printed"', async () => {
  const t = await setup({ dymoFramework: { failPrint: failFromSecond() } });
  const message = {
    barcodefinal: {
      printer: 'dymo', design: 'repair', barcode: 'RPR-1', orderDate: '19/11/2026', customer: { name: 'A', cell_no: '1' }, business: { business_name: 'S', branch_name: 'M' },
      orderItems: [{ product_name: 'one' }, { product_name: 'two' }, { product_name: 'three' }],
    },
    barcode: 'RPR-1', design: 'repair',
  };
  const r = await t.desktop.sendLabel(message);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DYMO_PRINT_FAILED');
  assert.deepEqual([r.details.printed, r.details.total], [1, 3]);
  assert.match(r.message, /1 of 3 labels were printed/);
  assert.equal(t.events[0].message, r.message, 'the cashier reads the same sentence');
  assert.equal(dymoLabelsOf(t.factory).filter((l) => l.printed).length, 1, 'exactly one physical label');
  t.world.cleanup();
});

test('4B. a label with no printer type chosen is refused by the web itself (no IPC call), with the sentence of SPEC 18, once', async () => {
  const t = await setup();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await t.desktop.sendLabel({ barcodefinal: undefined, barcode: '1', title: 't' }), { ok: false, code: 'INVALID_PAYLOAD', message: 'No label printer type is chosen. Open Account settings and choose Zebra or DYMO.' });
  assert.equal(t.page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-barcode').length, 0);
  assert.equal(t.events.length, 1);
  t.world.cleanup();
});

test('4B. a transport failure and a payload that cannot cross the bridge are UNKNOWN Results, never an exception', async () => {
  const t = await setup();
  const withFunction = { barcodefinal: { printer: 'dymo', title: 'x', barcode: '1', onClick: () => {} } };
  let r = await t.desktop.sendLabel(withFunction);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN');
  assert.match(r.message, /could not complete the request/);
  note(`[4B] a function inside the payload -> ${r.code}: ${r.message}`);
  // a symbol in a receipt object
  r = await t.desktop.sendReceipt({ receiptFileBinary: Buffer.from([1, 2]), order: { s: Symbol('x') } });
  assert.equal(r.ok, true, 'the new web sends only the bytes: the unclonable order never reaches the bridge');
  t.world.cleanup();
});

test('4B. real module-level exports: a failure is a CustomEvent "dg:desktop-print" on window, de-duplicated for 4 s, and PrintFeedbackBridge turns it into a notistack snackbar', async () => {
  const boot = await bootNewDesktop({ printers: false });
  const page = connectPage(boot.world);
  const target = new EventTarget();
  globalThis.window = Object.assign(target, { electron: page.electron });
  try {
    const events = [];
    const snackbars = [];
    const stop = web.feedback.listenForFeedback((detail) => { events.push(detail); snackbars.push(web.feedback.toSnackbar(detail)); }, globalThis.window);
    const r1 = await web.index.sendReceipt({ receiptFileBinary: Buffer.from([1, 2, 3]) });
    const r2 = await web.index.sendReceipt({ receiptFileBinary: Buffer.from([1, 2, 3]) });
    assert.equal(r1.code, 'NO_PRINTER_CONFIGURED');
    assert.equal(r2.code, 'NO_PRINTER_CONFIGURED');
    assert.equal(events.length, 1, 'one event for two identical failures');
    assert.deepEqual(snackbars[0], { message: r1.message, options: { variant: 'error', autoHideDuration: 8000, preventDuplicate: true } });
    stop();
    await web.index.sendLabel({ barcodefinal: undefined });
    assert.equal(events.length, 1, 'after stop() nothing more is delivered');
    note(`[4B] snackbar from a failed receipt: ${JSON.stringify(snackbars[0])}`);
  } finally {
    delete globalThis.window;
    boot.world.cleanup();
  }
});

// =====================================================================================================================================================
// 4C. the multi-label loops, the real handlers of the NEW source on the NEW desktop
// =====================================================================================================================================================
async function loopRun(siteId, { failing, o = {}, printer = 'dymo' }) {
  const site = SITES.find((s) => s.id === siteId);
  const boot = await bootNewDesktop(failing === 'dymo' ? { dymoFramework: { failPrint: failFromSecond() } } : {});
  const page = connectPage(boot.world);
  const { desktop, events } = makeWebDesktop(page.electron);
  if (failing === 'zebra') {
    const original = boot.world.rawPrinter.printRaw;
    let n = 0;
    boot.world.rawPrinter.printRaw = async (job) => { if (job.label === 'label zebra' && ++n >= 2) throw new PrintError('SPOOLER_ERROR'); return original(job); };
  }
  const con = quietConsole();
  const snacks = spy();
  const env = { printer, currency: 'GBP', console: con, enqueueSnackbar: snacks, dymoLabelSize: web.index.dymoLabelSize, window: { electron: page.electron }, sendLabel: desktop.sendLabel };
  const scopeProbe = site.scope(env, o);
  const handler = buildHandler(site, 'new', env, o);
  let thrown = null;
  try { await site.call(handler, o); } catch (error) { thrown = error; }
  await page.settle();
  const out = {
    thrown, events, logs: con.logs.filter((l) => l[0] === 'log').map((l) => l.slice(1).join(' ')), snackbars: snacks.calls, scopeProbe,
    sent: page.sandbox.ipc.invoked.filter((c) => c.channel === 'print-barcode').length,
    dymoPrinted: dymoLabelsOf(boot.factory).filter((l) => l.printed).length, zebraJobs: boot.world.rawPrinter.jobs.filter((j) => j.label === 'label zebra').length,
  };
  boot.world.cleanup();
  return out;
}

test('4C. BarcodeModal (prints 3): all three labels print and are logged; when the 2nd is refused the loop STOPS, ONE event is raised, and the 3rd is never sent', async () => {
  const ok = await loopRun('BarcodeModal', { failing: null });
  assert.equal(ok.thrown, null);
  assert.equal(ok.sent, 3);
  assert.equal(ok.dymoPrinted, 3);
  assert.deepEqual(ok.logs, ['Printed label 1 of 3', 'Printed label 2 of 3', 'Printed label 3 of 3']);
  assert.deepEqual(ok.events, []);

  const bad = await loopRun('BarcodeModal', { failing: 'dymo' });
  assert.equal(bad.thrown, null);
  assert.equal(bad.sent, 2, 'label 3 was not even sent');
  assert.equal(bad.dymoPrinted, 1);
  assert.deepEqual(bad.logs, ['Printed label 1 of 3'], 'the refused label is not logged as printed');
  assert.equal(bad.events.length, 1);
  assert.equal(bad.events[0].code, 'DYMO_PRINT_FAILED');
  note(`[4C] BarcodeModal: sent ${bad.sent}, printed ${bad.dymoPrinted}, events ${bad.events.length} (${bad.events[0].message})`);
});

test('4C. BarcodePanelTab (prints 3): the flag ends the loop, the busy state is lowered in the finally either way', async () => {
  const bad = await loopRun('BarcodePanelTab', { failing: 'dymo', o: { prints: '3' } });
  assert.equal(bad.thrown, null);
  assert.equal(bad.sent, 2);
  assert.equal(bad.dymoPrinted, 1);
  assert.equal(bad.events.length, 1);
  // the busy-state spy of the instance that ran: read it through a second run with an explicit scope
  const site = SITES.find((s) => s.id === 'BarcodePanelTab');
  const boot = await bootNewDesktop({ dymoFramework: { failPrint: failFromSecond() } });
  const page = connectPage(boot.world);
  const { desktop } = makeWebDesktop(page.electron);
  const env = { printer: 'dymo', currency: 'GBP', console: quietConsole(), enqueueSnackbar: spy(), dymoLabelSize: web.index.dymoLabelSize, window: { electron: page.electron }, sendLabel: desktop.sendLabel };
  const setPrinting = spy();
  const handler = instantiate(cutWeb(site.file, site.fn), { ...site.scope(env, { prints: '3' }), setPrinting, sanitizeBarcode: instantiate(cutWeb(site.file, 'sanitizeBarcode'), {}) });
  await handler();
  assert.deepEqual(setPrinting.calls, [[true], [false]], 'busy on at the start, off in the finally');
  boot.world.cleanup();
});

test('4C. Quick Add: a refused label is ONE failed label, the loop stops, the handler still throws "N of M labels could not be printed" (reportLabelFailures keeps its warning) and the cashier gets ONE event', async () => {
  const bad = await loopRun('QuickAdd', { failing: 'dymo', o: { prints: 3 } });
  assert.ok(bad.thrown, 'the handler throws at the end');
  assert.equal(bad.thrown.message, '1 of 3 labels could not be printed');
  assert.equal(bad.sent, 2);
  assert.equal(bad.events.length, 1);
  note(`[4C] Quick Add: thrown "${bad.thrown.message}", sent ${bad.sent}, events ${bad.events.length}`);
  const ok = await loopRun('QuickAdd', { failing: null, o: { prints: 3 } });
  assert.equal(ok.thrown, null);
  assert.equal(ok.sent, 3);
});

test('4C. Quick Add serial loop as the page runs it: N handlePrint calls at once (reportLabelFailures maps every serial), against a printer that is off: every one fails, the web raises ONE event, the desktop prints nothing', async () => {
  const site = SITES.find((s) => s.id === 'QuickAdd');
  const boot = await bootNewDesktop({ dymoFramework: { printers: [] } });
  const page = connectPage(boot.world);
  const { desktop, events } = makeWebDesktop(page.electron);
  const env = { printer: 'dymo', currency: 'GBP', console: quietConsole(), enqueueSnackbar: spy(), dymoLabelSize: web.index.dymoLabelSize, window: { electron: page.electron }, sendLabel: desktop.sendLabel };
  const handler = buildHandler(site, 'new', env, {});
  const serials = Array.from({ length: 12 }, (_, i) => `SN-${100000 + i}`);
  const results = await Promise.allSettled(serials.map((product_no) => handler(1, {
    product_no, name: 'Galaxy', regular_price: 100, sale_price: 0, is_on_sale: false, network: 1, misc_color: 'Black', ram: '8GB', storage: '128GB', processor: 'SD', warranty: 6, conditionObject: { grade: 'A' },
  })));
  assert.equal(results.filter((r) => r.status === 'rejected').length, 12, 'each serial reports its failure (the product-was-saved warning counts them)');
  assert.equal(events.length, 1, 'the same sentence 12 times is raised once');
  assert.equal(dymoLabelsOf(boot.factory).filter((l) => l.printed).length, 0);
  boot.world.cleanup();
});

test('4C. Quick Add serial loop when the printer works: 20 serials at once all print, in the order of the list, on ONE helper window', async () => {
  const site = SITES.find((s) => s.id === 'QuickAdd');
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world);
  const { desktop, events } = makeWebDesktop(page.electron);
  const env = { printer: 'dymo', currency: 'GBP', console: quietConsole(), enqueueSnackbar: spy(), dymoLabelSize: web.index.dymoLabelSize, window: { electron: page.electron }, sendLabel: desktop.sendLabel };
  const handler = buildHandler(site, 'new', env, { design: 1, size: '32x57' });
  const serials = Array.from({ length: 20 }, (_, i) => `SN-${100000 + i}`);
  const results = await Promise.allSettled(serials.map((product_no) => handler(1, {
    product_no, name: 'Galaxy', regular_price: 100, sale_price: 0, is_on_sale: false, network: 1, misc_color: 'Black', ram: '8GB', storage: '128GB', processor: 'SD', warranty: 6, conditionObject: { grade: 'A' },
  })));
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  const labels = dymoLabelsOf(boot.factory);
  assert.equal(labels.length, 20);
  assert.deepEqual(labels.map((l) => opValue(l, 'BARCODE')), serials, 'the order of the serial list');
  assert.equal(boot.factory.created, 1, 'one hidden window');
  assert.deepEqual(events, []);
  boot.world.cleanup();
});

test('4C. BarcodePDFGenerator items loop: stops at the first refused item; a printer that works prints every item once, in order', async () => {
  const bad = await loopRun('BarcodePDFGenerator(items)', { failing: 'dymo' });
  assert.equal(bad.thrown, null);
  assert.equal(bad.sent, 2, 'item 3 never sent');
  assert.equal(bad.dymoPrinted, 1);
  assert.equal(bad.events.length, 1);
  const ok = await loopRun('BarcodePDFGenerator(items)', { failing: null });
  assert.equal(ok.sent, 3);
  assert.equal(ok.dymoPrinted, 3);
  const zebra = await loopRun('BarcodePDFGenerator(items)', { failing: 'zebra', printer: 'zebra' });
  assert.equal(zebra.sent, 2);
  assert.equal(zebra.events.length, 1);
  assert.equal(zebra.events[0].code, 'SPOOLER_ERROR');
});

test('4C. Zebra on the loops: BarcodeModal and Quick Add stop at the first refused label as well', async () => {
  const m = await loopRun('BarcodeModal', { failing: 'zebra', printer: 'zebra' });
  assert.equal(m.sent, 2);
  assert.equal(m.zebraJobs, 1);
  assert.equal(m.events.length, 1);
  const q = await loopRun('QuickAdd', { failing: 'zebra', printer: 'zebra', o: { prints: 4 } });
  assert.equal(q.sent, 2);
  assert.equal(q.thrown.message, '1 of 4 labels could not be printed');
});

test('4C. single-label sites (order labels, appointment, box): a refused label is announced once by the desktop feedback and the handler\'s busy state is lowered; the old catch(error) snackbar is for exceptions only', async () => {
  for (const id of ['OrderDetails(sell)', 'OrderDetails(buy)', 'OrderDetails(repair)', 'AppointmentDetail']) {
    const site = SITES.find((s) => s.id === id);
    const boot = await bootNewDesktop({ dymoFramework: { printers: [] } });
    const page = connectPage(boot.world);
    const { desktop, events } = makeWebDesktop(page.electron);
    const snacks = spy();
    const env = { printer: 'dymo', currency: 'GBP', console: quietConsole(), enqueueSnackbar: snacks, dymoLabelSize: web.index.dymoLabelSize, window: { electron: page.electron }, sendLabel: desktop.sendLabel };
    const handler = buildHandler(site, 'new', env, {});
    await site.call(handler, {});
    assert.equal(events.length, 1, `${id}: one event`);
    assert.equal(events[0].code, 'DYMO_NO_PRINTER');
    assert.equal(snacks.calls.length, 0, `${id}: no second message from the handler itself`);
    boot.world.cleanup();
  }
  note('[4C] order/appointment labels on a refused label: one feedback event, no duplicate snackbar from the handler');
});

test('4C. printLabItemLabels (the real exported function): { printed, failed } keeps its shape; a refused label ends the run (1 failed); a thrown build still goes on; a non-object answer counts as printed', async () => {
  const t = await setup({ dymoFramework: { failPrint: failFromSecond() } });
  const build = (input) => lib.printBarcodes(input);
  const refused = await web.labItem.printLabItemLabels({ printer: 'dymo', barcode: '636400', title: 'Screen', copies: 4, build, send: t.desktop.sendLabel });
  assert.deepEqual(refused, { printed: 1, failed: 1 });
  assert.equal(t.events.length, 1);
  t.world.cleanup();

  const good = await setup();
  const all = await web.labItem.printLabItemLabels({ printer: 'dymo', barcode: '636400', title: 'Screen "kit"', copies: 4, build, send: good.desktop.sendLabel });
  assert.deepEqual(all, { printed: 4, failed: 0 });
  assert.equal(dymoLabelsOf(good.factory).length, 4);
  assert.equal(opValue(dymoLabelsOf(good.factory)[0], 'TextObject12'), 'Screen "kit"', 'the new desktop prints the quote as typed');
  const stubs = await web.labItem.printLabItemLabels({ printer: 'dymo', barcode: '1', title: 't', copies: 3, build, send: () => 42 });
  assert.deepEqual(stubs, { printed: 3, failed: 0 });
  let n = 0;
  const flaky = await web.labItem.printLabItemLabels({ printer: 'dymo', barcode: '1', title: 't', copies: 3, build: async (x) => { if (++n === 2) throw new Error('x'); return build(x); }, send: () => undefined });
  assert.deepEqual(flaky, { printed: 2, failed: 1 });
  // with the DEFAULT `send` (sendLabel of the module-level util) on the real window
  globalThis.window = { electron: good.page.electron, dispatchEvent: () => true };
  try {
    const viaDefault = await web.labItem.printLabItemLabels({ printer: 'dymo', barcode: '77', title: 'Default send', copies: 2, build });
    assert.deepEqual(viaDefault, { printed: 2, failed: 0 });
  } finally {
    delete globalThis.window;
  }
  good.world.cleanup();
});

// =====================================================================================================================================================
// 4D. the cash drawer: the dialog handler and the Open button, the real handlers of the new source
// =====================================================================================================================================================
const DRAWER_FILE = 'src/pages-sections/vendor/point-of-sale/pos-buy-orders/pos-card-items/cashDrawerForm.jsx';
function dialog(t, password) {
  const state = { loading: [], error: [], closed: [] };
  const handler = instantiate(cutWeb(DRAWER_FILE, 'handleOpenCashDrawer'), {
    setButtonLoading: (v) => state.loading.push(v), setErrorText: (v) => state.error.push(v), setOpenCashDrawerDialog: (v) => state.closed.push(v),
    openCashDrawer: t.desktop.openCashDrawer, cashDrawerPassword: password, failureText: web.index.failureText,
  });
  return { state, run: () => handler() };
}

test('4D. the drawer dialog: right password closes it and pulses 1B 70 00 19 FF; wrong keeps it open with the message under the field; five wrong lock it with the wait; empty is asked for', async () => {
  const t = await setup();
  let d = dialog(t, 'tills-pw');
  await d.run();
  assert.deepEqual(d.state, { loading: [true, false], error: [''], closed: [false] });
  assert.equal(hex(t.world.rawPrinter.jobs.at(-1).bytes), '1b700019ff');
  assert.equal(t.world.rawPrinter.jobs.at(-1).label, 'cash drawer');

  d = dialog(t, 'wrong');
  await d.run();
  assert.deepEqual(d.state.closed, [], 'the dialog stays open');
  assert.equal(d.state.error.at(-1), 'That password is not correct. Try again.');
  d = dialog(t, '');
  await d.run();
  assert.equal(d.state.error.at(-1), 'Enter the password to continue.');
  for (let i = 0; i < 4; i += 1) { d = dialog(t, 'bad' + i); await d.run(); }
  note(`[4D] message in the dialog on the FIFTH wrong password (the one that locks): "${d.state.error.at(-1)}"`);
  d = dialog(t, 'tills-pw'); // the RIGHT one while locked
  await d.run();
  assert.match(d.state.error.at(-1), /Too many wrong passwords\. Try again in 30 seconds\./);
  assert.deepEqual(d.state.closed, []);
  assert.equal(t.world.rawPrinter.jobs.filter((j) => j.label === 'cash drawer').length, 1, 'no second pulse while locked');
  assert.deepEqual(t.events, [], 'notify:false -> the dialog shows it, no second snackbar');
  note(`[4D] lock-out message in the dialog: "${d.state.error.at(-1)}"`);
  // after the lock ends
  await t.world.clock.advance(31_000);
  d = dialog(t, 'tills-pw');
  await d.run();
  assert.deepEqual(d.state.closed, [false], 'works again after the lock');
  t.world.cleanup();
});

test('4D. the drawer dialog when the drawer cannot work: no password set, drawer switched off, printer gone: each says what to do, none closes the dialog', async () => {
  const noPw = await setup({ password: false });
  let d = dialog(noPw, 'x');
  await d.run();
  assert.match(d.state.error.at(-1), /No cash drawer password is set yet/);
  noPw.world.cleanup();

  const off = await setup();
  off.config.set('drawer.enabled', false);
  d = dialog(off, 'tills-pw');
  await d.run();
  assert.match(d.state.error.at(-1), /switched off/);
  off.world.cleanup();

  const gone = await setup();
  gone.world.rawPrinter.failWith = new PrintError('PRINTER_NOT_FOUND', undefined, { printerName: 'EPSON TM-T20' });
  d = dialog(gone, 'tills-pw');
  await d.run();
  assert.match(d.state.error.at(-1), /EPSON TM-T20/);
  assert.deepEqual(d.state.closed, []);
  gone.world.cleanup();

  const noPrinter = await setup({ printers: false });
  d = dialog(noPrinter, 'tills-pw');
  await d.run();
  assert.match(d.state.error.at(-1), /No printer is set up yet/);
  noPrinter.world.cleanup();
});

test('4D. the POS Open button (pos-card-items-bottom openCashDrawer): shows the desktop\'s password window; with no password set / drawer off the Result is raised as a snackbar sentence', async () => {
  const file = 'src/pages-sections/vendor/point-of-sale/pos-buy-orders/pos-card-items/pos-card-items-bottom.jsx';
  for (const [label, options, tweak, expected] of [
    ['ok', {}, null, null],
    ['no password', { password: false }, null, /No cash drawer password is set yet/],
    ['disabled', {}, (t) => t.config.set('drawer.enabled', false), /switched off/],
  ]) {
    const t = await setup(options);
    if (tweak) tweak(t);
    const handler = instantiate(cutWeb(file, 'openCashDrawer'), { sendReceipt: t.desktop.sendReceipt, business: P.sampleBusiness(), posCurrencyExit: P.sampleSettings() });
    handler();
    await t.page.settle();
    await t.world.settle(10);
    if (expected) {
      assert.equal(t.events.length, 1, label);
      assert.match(t.events[0].message, expected, label);
      assert.equal(t.world.services().passwordWindow.isOpen(), false, label);
    } else {
      assert.deepEqual(t.events, []);
      assert.equal(t.world.services().passwordWindow.isOpen(), true);
    }
    t.world.cleanup();
  }
});

// =====================================================================================================================================================
// 4E. order and burst behaviour
// =====================================================================================================================================================
test('4E. a burst NOT awaited (what the web does with receipts) keeps its order on the printer; labels and receipts of different printers do not block each other', async () => {
  const t = await setup();
  const receipts = Array.from({ length: 15 }, (_, i) => Buffer.from([0x1b, 0x40, i]));
  const promises = [];
  for (const [i, r] of receipts.entries()) {
    promises.push(t.desktop.sendReceipt({ receiptFileBinary: r, order: { id: i } }));
    promises.push(t.desktop.sendLabel({ barcodefinal: `^XA^FD${i}^FS^XZ`, barcode: String(i), title: 't' }));
  }
  const all = await Promise.all(promises);
  assert.ok(all.every((r) => r.ok));
  const receiptJobs = t.world.rawPrinter.jobs.filter((j) => j.label === 'receipt').map((j) => j.bytes[2]);
  const zebraJobs = t.world.rawPrinter.jobs.filter((j) => j.label === 'label zebra').map((j) => j.bytes.toString().match(/\^FD(\d+)/)[1]);
  assert.deepEqual(receiptJobs, receipts.map((_, i) => i));
  assert.deepEqual(zebraJobs, receipts.map((_, i) => String(i)));
  t.world.cleanup();
});

// =====================================================================================================================================================
// 4F. privacy at the boundary: customer data in label and receipt payloads, and passwords, never reach the log or a native box
// =====================================================================================================================================================
test('4F. the desktop log and the native boxes never contain customer names, phone numbers, notes, receipt text or passwords sent by the web (new and old calls)', async () => {
  const t = await setup({ dymoFramework: { failPrint: () => 'Out of labels' } });
  const S = { name: 'SENTINEL-CUSTOMER-NAME', phone: '07700900123456', note: 'SENTINEL-ORDER-NOTE', pw: 'SENTINEL-PASSWORD', title: 'SENTINEL-PRODUCT-TITLE', receipt: 'SENTINEL-RECEIPT-TEXT' };
  const bytes = Buffer.from(`${S.receipt}\n`);
  const repair = { barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'RPR-1', customer: { name: S.name, cell_no: S.phone }, business: { business_name: 'S', branch_name: 'M' }, orderItem: { product_name: S.title, notes: S.note } }, barcode: 'RPR-1', design: 'repair' };
  await t.desktop.sendLabel(repair); // fails (Out of labels): the failure path logs too
  t.page.electron.sendBarcodeData(repair);
  await t.desktop.sendReceipt({ receiptFileBinary: bytes, order: { notes: S.note, customer: { name: S.name } } });
  t.page.electron.sendReceiptData({ receiptFileBinary: bytes, order: { notes: S.note, customer: { name: S.name } } });
  await t.desktop.openCashDrawer({ password: S.pw }, { notify: false });
  t.page.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: S.pw });
  await t.page.settle();
  const logText = JSON.stringify(t.world.log.entries);
  const boxText = JSON.stringify(t.world.dialog.calls.map((c) => c.options));
  for (const [what, value] of Object.entries(S)) {
    assert.equal(logText.includes(value), false, `the log contains ${what}`);
    assert.equal(boxText.includes(value), false, `a native box contains ${what}`);
  }
  assert.ok(t.world.log.entries.length > 5, 'the log has entries to scan');
  note(`[4F] ${t.world.log.entries.length} log entries and ${t.world.dialog.calls.length} native boxes scanned for 6 sentinels: none found`);
  t.world.cleanup();
});
