// contract-matrix, combination 1: OLD web (the legacy call shapes of origin/main) against the NEW desktop (src/main ipc.js + jobs.js, the real preload).
// Every message is built the way ONE call site builds it (see _payloads.mjs) and sent through the legacy functions of the real window.electron.
// For the DYMO labels the same message is also run through the REAL v1.6.1 handler, and every difference between the two is classified against the
// intended differences (a)-(e) of SPEC 9.4.
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=120000 tests/verify/c1-old-web-new-desktop.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootNewDesktop, connectPage, runV1, buildLabelPlan, dymoLabelsOf, pairs, hex, lib } from './_kit.mjs';
import * as P from './_payloads.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c1 report ====\n' + REPORT.join('\n')));

const SPEC_SLOTS = ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'];
const PRICE_SLOTS = ['TEXT_3', 'TextObject1', 'TextObject12', 'TextObject2', 'TextObject9'];
const byName = (ops) => Object.fromEntries(ops.map((op) => [op.name, op.value]));

/** Classifies the differences between the v1 run and the v2 run of the same message. */
function classify(v1, v2, ctx) {
  const reasons = [];
  const unexplained = [];
  if (!v2.printed) return { reasons: ['V2 DID NOT PRINT'], unexplained: ['v2 did not print: ' + (v2.error || '')] };
  if (!v1.printed) {
    if (ctx.hostile) reasons.push('d (v1 cannot print this text)');
    else if (ctx.nanSale) reasons.push('e (v1 prints nothing for an unlisted design on sale)');
    else if (ctx.numeric && !v1.error) reasons.push('v1 crashes silently on a non-string spec (v.toUpperCase), v2 coerces');
    else unexplained.push('v1 failed: ' + v1.error);
    return { reasons, unexplained };
  }
  if (ctx.template && v1.template && v1.template !== ctx.template) {
    if (ctx.nanAt70) reasons.push(`e-template (${v1.template} -> ${ctx.template})`);
    else unexplained.push(`template ${v1.template} -> ${ctx.template}`);
  }
  const a = byName(v1.ops);
  const b = byName(v2.ops);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const bareGrade = a.TEXT_4 === 'GRADE ';
  const specsOf = (m) => SPEC_SLOTS.map((n) => m[n]).filter((v) => v !== undefined && v !== '');
  // (c): v1's list without its bare "GRADE " is the start of v2's list (v2 fills the freed slot); (b): and the processor that v1 dropped is in v2's list
  let v1Specs = specsOf(a).filter((v) => v !== 'GRADE ');
  let v2Specs = specsOf(b);
  if (ctx.lowerProcessorUpper) v2Specs = v2Specs.filter((v) => v.toUpperCase() !== ctx.lowerProcessorUpper);
  const specsDiffer = SPEC_SLOTS.some((n) => a[n] !== b[n]);
  if (specsDiffer) {
    const prefixOk = v1Specs.every((value, i) => v2Specs[i] === value) || (v2Specs.length <= v1Specs.length && v2Specs.every((value, i) => v1Specs[i] === value));
    if (!prefixOk) unexplained.push(`spec lists: v1 ${JSON.stringify(specsOf(a))} v2 ${JSON.stringify(specsOf(b))}`);
    else {
      if (bareGrade) reasons.push('c (bare "GRADE " entry gone, the specs move up)');
      if (ctx.lowerProcessorUpper) reasons.push('b (the lower-case processor is now printed)');
      if (!bareGrade && !ctx.lowerProcessorUpper) unexplained.push('spec slots differ without a known reason');
    }
  }
  for (const name of names) {
    if (SPEC_SLOTS.includes(name) || a[name] === b[name]) continue;
    const symbol = ctx.currency && ctx.currency !== 'GBP' ? ctx.currency + ' ' : null;
    if (PRICE_SLOTS.includes(name) && symbol && String(a[name]).startsWith('£') && String(b[name]) === symbol + String(a[name]).slice(1)) {
      reasons.push(`a (${name}: ${a[name]} -> ${b[name]})`);
    } else {
      unexplained.push(`${name}: ${JSON.stringify(a[name])} -> ${JSON.stringify(b[name])}`);
    }
  }
  return { reasons: [...new Set(reasons)], unexplained };
}

async function dymoMatrix(label, cases) {
  const { world, factory, reads } = await bootNewDesktop();
  const page = connectPage(world);
  const rows = [];
  for (const c of cases) {
    const payload = await c.make();
    const v1 = await runV1('send-barcode-data', structuredClone(payload));
    const before = dymoLabelsOf(factory).length;
    page.electron.sendBarcodeData(payload); // the OLD web's call, on the real v2 preload
    await page.settle();
    const labels = dymoLabelsOf(factory).slice(before);
    const plan = (() => { try { return buildLabelPlan(payload); } catch (error) { return { error: error.message }; } })();
    const v2 = { printed: labels.length === 1 && labels[0].printed, ops: labels[0] ? labels[0].ops : [], error: labels[0]?.error || null, template: plan.plans?.[0]?.templateFile };
    const { reasons, unexplained } = classify(v1, v2, { ...c.ctx, template: v2.template });
    rows.push({ name: c.name, v1printed: v1.printed, v2printed: v2.printed, template: v2.template, v1template: v1.template, reasons, unexplained, boxes: world.dialog.calls.length });
    note(`[${label}] ${c.name}: v1 ${v1.printed ? 'printed' : 'FAILED(' + String(v1.error).slice(0, 60) + ')'} | v2 ${v2.printed ? 'printed' : 'FAILED'} | ${v2.template} | ${reasons.length ? reasons.join('; ') : 'identical'}${unexplained.length ? ' | UNEXPLAINED: ' + unexplained.join('; ') : ''}`);
  }
  assert.equal(world.dialog.calls.length, 0, 'no native error box for a label that printed');
  world.cleanup();
  return rows;
}

// =====================================================================================================================================================
// 1A. every label call site, DYMO, through the legacy sendBarcodeData of the real v2 preload; A/B against the real v1 handler
// =====================================================================================================================================================
test('1A. DYMO labels of every call site print on the new desktop; every difference from v1 is one of the intended ones (a)-(e)', async () => {
  const cases = [];
  const add = (name, make, ctx = {}) => cases.push({ name, make, ctx });
  // BarcodeModal: no size, design '' is the normal "no layout picked" state
  for (const design of ['', '1', '2', '3', '4']) add(`BarcodeModal design ${JSON.stringify(design)} GBP`, () => P.modal('dymo', { dymoOption: design }), { design: parseInt(design, 10) || NaN });
  add('BarcodeModal design "1" AED', () => P.modal('dymo', { state: P.POS_STATE.aed }), { currency: 'AED', design: 1 });
  // BarcodePanelTab: Processor capital, size shared with the PDF page sizes
  for (const design of ['', '1', '2', '3', '4']) {
    for (const size of ['32x57', '70x54', '25x25']) add(`BarcodePanelTab design ${JSON.stringify(design)} ${size}`, () => P.panel('dymo', { dymoOption: design, size }), { design: parseInt(design, 10) || NaN, nanAt70: design === '' && size === '70x54' });
  }
  add('BarcodePanelTab design "1" 70x54 on sale', () => P.panel('dymo', { dymoOption: '1', size: '70x54', isSale: true, salePrice: 549, regular_price: 649 }), { design: 1 });
  add('BarcodePanelTab design "2" 32x57 on sale (design 7)', () => P.panel('dymo', { dymoOption: '2', size: '32x57', isSale: true, salePrice: 549, regular_price: 649 }), { design: 2 });
  add('BarcodePanelTab design "" 32x57 on sale (NaN + sale)', () => P.panel('dymo', { dymoOption: '', size: '32x57', isSale: true, salePrice: 549, regular_price: 649 }), { nanSale: true });
  add('BarcodePanelTab design "" 70x54 on sale (NaN + sale at 70x54)', () => P.panel('dymo', { dymoOption: '', size: '70x54', isSale: true, salePrice: 549, regular_price: 649 }), { nanSale: true, nanAt70: true });
  add('BarcodePanelTab design "" 70x54 (NaN at 70x54, no sale)', () => P.panel('dymo', { dymoOption: '', size: '70x54' }), { nanAt70: true });
  add('BarcodePanelTab size "57x35" stored from the PDF selector (old web sends it as is)', () => P.panel('dymo', { dymoOption: '1', size: '57x35' }), { design: 1 });
  add('BarcodePanelTab with a comment as Processor (newline, quotes)', () => P.panel('dymo', { Processor: 'Battery 91%\nScreen "replaced"' }), { hostile: true });
  // Quick Add: processor lower case, numeric design, size from the category
  for (const design of [1, 2, 3, 4]) for (const size of ['32x57', '70x54', '25x25']) add(`QuickAdd design ${design} ${size}`, () => P.quickAdd('dymo', { design, size }), { design, lowerProcessorUpper: 'SNAPDRAGON 8 GEN 2' });
  add('QuickAdd design 1 on sale', () => P.quickAdd('dymo', { is_on_sale: true, sale_price: 399.99 }), { design: 1, lowerProcessorUpper: 'SNAPDRAGON 8 GEN 2' });
  add('QuickAdd AED', () => P.quickAdd('dymo', { state: P.POS_STATE.aed }), { currency: 'AED', design: 1, lowerProcessorUpper: 'SNAPDRAGON 8 GEN 2' });
  add('QuickAdd currency from the system when the business has none (USD)', () => P.quickAdd('dymo', { state: P.POS_STATE.none }), { currency: 'USD', design: 1, lowerProcessorUpper: 'SNAPDRAGON 8 GEN 2' });
  add('QuickAdd with a numeric RAM (cleanValue lets a number through)', () => P.quickAdd('dymo', { ram: 8 }), { design: 1, numeric: true });
  // lab item
  add('lab item label', () => P.lab('dymo'));
  add('lab item label with a quote in the title', () => P.lab('dymo', { title: 'Screen 6.1" OLED' }), { hostile: true });
  // box
  add('BoxLabelPrint (container number in the price slot, size 57x32)', async () => P.box(), { design: 1 });
  add('BoxLabelPrint with an all-digit container number', async () => P.box({ containerNo: '4455' }), { design: 1 });
  add('BoxLabelPrint with a quote in the box label', async () => P.box({ box_label: 'Cables "mixed"' }), { hostile: true, design: 1 });
  // order screens + appointment
  for (const kind of ['sell', 'buy', 'repair']) add(`order label (${kind})`, () => P.orderLabel(kind, 'dymo'), { design: 1 });
  add('order label (repair) with a customer name containing a quote', () => P.orderLabel('repair', 'dymo', { customerName: 'Pat "Dr" Jones' }), { hostile: true, design: 1 });
  add('order label AED', () => P.orderLabel('sell', 'dymo', { state: P.POS_STATE.aed }), { currency: 'AED', design: 1 });
  add('appointment label', () => P.appointment('dymo'), { hostile: true, design: 1 }); // O'Neil / iPad Pro 12.9": the title has a double quote
  // repair labels of BarcodePDFGenerator
  add('repair label, one item (BarcodePDFGenerator)', () => P.repairItem('dymo'), { design: 'repair' });
  add('repair label, item with a quote in the product name', () => P.repairItem('dymo', { item: { id: 9, product_name: 'iPad 10.2" screen', device: 'iPad', job: 'Screen', remarks: 'x' } }), { hostile: true });
  add('single barcode (BarcodePDFGenerator without items)', () => P.singleBarcode('dymo'), { design: NaN });

  const rows = await dymoMatrix('1A', cases);
  const bad = rows.filter((r) => r.unexplained.length > 0 || !r.v2printed);
  assert.deepEqual(bad.map((r) => `${r.name}: ${r.unexplained.join('; ')}`), [], 'every difference between v1 and v2 is an intended one');
  assert.equal(rows.every((r) => r.v2printed), true);
});

// =====================================================================================================================================================
// 1B. Zebra: the ZPL of the real printBarcodes goes out as UTF-8, one job per message, in order, on the label printer
// =====================================================================================================================================================
test('1B. Zebra labels of every call site: the ZPL string leaves as its own UTF-8 bytes, one job per message, in the order sent', async () => {
  const { world } = await bootNewDesktop();
  const page = connectPage(world);
  const makers = {
    modal: () => P.modal('zebra', { heading: 'Café Müller "Pro" £5' }),
    panel: () => P.panel('zebra'),
    quickAdd: () => P.quickAdd('zebra'),
    lab: () => P.lab('zebra'),
    orderSell: () => P.orderLabel('sell', 'zebra'),
    orderBuy: () => P.orderLabel('buy', 'zebra'),
    orderRepair: () => P.orderLabel('repair', 'zebra'),
    appointment: () => P.appointment('zebra'),
    singleBarcode: () => P.singleBarcode('zebra'),
    modalAED: () => P.modal('zebra', { state: P.POS_STATE.aed }),
  };
  const sent = [];
  for (const [name, make] of Object.entries(makers)) {
    const payload = await make();
    assert.equal(typeof payload.barcodefinal, 'string', `${name}: printBarcodes made ZPL`);
    sent.push([name, payload.barcodefinal]);
    page.electron.sendBarcodeData(payload);
  }
  await page.settle();
  const jobs = world.rawPrinter.jobs;
  assert.equal(jobs.length, sent.length, 'one job per message');
  sent.forEach(([name, zpl], i) => {
    assert.equal(jobs[i].ext, 'zpl', name);
    assert.equal(jobs[i].label, 'label zebra', name);
    assert.equal(jobs[i].target.printerName, 'ZDesigner ZD420', name);
    assert.deepEqual(jobs[i].bytes, Buffer.from(zpl, 'utf8'), `${name}: bytes are the UTF-8 of the ZPL`);
  });
  assert.equal(world.dialog.calls.length, 0);
  // a batch of 20 serial labels (Quick Add) keeps its order
  world.rawPrinter.jobs.length = 0;
  const batch = [];
  for (let i = 0; i < 20; i += 1) {
    const payload = await P.quickAdd('zebra', { product_no: `SN-${1000 + i}` });
    batch.push(payload.barcodefinal);
    page.electron.sendBarcodeData(payload);
  }
  await page.settle();
  assert.deepEqual(world.rawPrinter.jobs.map((j) => j.bytes.toString('utf8')), batch, '20 labels, in order, each its own job');
  world.cleanup();
});

// =====================================================================================================================================================
// 1C. receipts: every payload shape of every site, through sendReceiptData of the real preload
// =====================================================================================================================================================
const RECEIPT_SHAPES = {
  // site -> the keys it sends (read by AST from the original call sites)
  'pos-card-items-bottom: complete + auto receipt': ['receiptFileBinary', 'order', 'isDuplicate', 'business', 'businessData', 'settings'],
  'ReceiptIcons / Customer / Pending&Progress / Remaining / Return / order lists / bulk complete': ['receiptFileBinary', 'order', 'isDuplicate', 'business', 'businessData', 'settings'],
  'CompletedOrderReceipts (with the odd `test` key)': ['test', 'receiptFileBinary', 'order', 'isDuplicate', 'business', 'businessData', 'settings'],
  'AllSalesCompletedOrderReceipts (receiptUpdatedOrder instead of order)': ['receiptFileBinary', 'receiptUpdatedOrder', 'isDuplicate', 'business', 'businessData', 'settings'],
  'DailyClosing (item instead of order)': ['receiptFileBinary', 'item', 'businessData', 'business', 'isDuplicate', 'settings'],
  'OverAllReport / StockReports (no order at all)': ['receiptFileBinary', 'businessData', 'business', 'isDuplicate', 'settings'],
  'drawerpurchaseprint (purchaseOrder)': ['receiptFileBinary', 'order', 'purchaseOrder', 'business', 'isDuplicate', 'businessData', 'settings'],
  'directPrint.js ({ receiptFileBinary, ...fullPayload })': ['receiptFileBinary', 'order', 'isDuplicate', 'business', 'businessData', 'settings', 'imageBaseUrl'],
};

test('1C. every receipt payload shape prints verbatim on the receipt printer (Buffer and Uint8Array alike); the legacy payload objects (10+ KB strings) are never a problem', async () => {
  const { world } = await bootNewDesktop();
  const page = connectPage(world);
  const bytes = await P.saleReceiptBytes();
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 50, 'real generateAndPrintReceipt bytes');
  const fill = (key) => ({
    receiptFileBinary: bytes,
    order: P.sampleOrder(), receiptUpdatedOrder: P.sampleOrder(), item: { id: 1, notes: 'I'.repeat(11 * 1024) }, purchaseOrder: { id: 5, lines: new Array(200).fill({ sku: 'x', note: 'y'.repeat(100) }) },
    isDuplicate: false, business: P.sampleBusiness(), businessData: P.sampleBusiness().business_meta_data, settings: { ...P.sampleSettings(), notes: 'S'.repeat(12 * 1024) }, test: 'test', imageBaseUrl: 'https://img.example.com/',
  }[key]);
  let n = 0;
  for (const [site, keys] of Object.entries(RECEIPT_SHAPES)) {
    const payload = Object.fromEntries(keys.map((key) => [key, fill(key)]));
    page.electron.sendReceiptData(payload);
    n += 1;
    await page.settle();
    assert.equal(world.rawPrinter.jobs.length, n, `${site}: one job`);
    assert.deepEqual(world.rawPrinter.jobs.at(-1).bytes, bytes, `${site}: bytes verbatim`);
    assert.equal(world.rawPrinter.jobs.at(-1).target.printerName, 'EPSON TM-T20');
  }
  // the binary in the other forms the page can produce
  const forms = { uint8: new Uint8Array(bytes), plainArrayBuffer: new Uint8Array(bytes).buffer, jsonBuffer: JSON.parse(JSON.stringify(bytes)) };
  for (const [name, form] of Object.entries(forms)) {
    page.electron.sendReceiptData({ receiptFileBinary: form, order: P.sampleOrder() });
    n += 1;
    await page.settle();
    assert.deepEqual(world.rawPrinter.jobs.at(-1).bytes, bytes, `receiptFileBinary as ${name}`);
  }
  assert.equal(world.dialog.calls.length, 0, 'no box for a success');
  world.cleanup();
});

test('1C. the 7-byte drawer kick the web builds with opencashdrawer() is a RECEIPT (it has an order): sent verbatim, drawer settings do not apply', async () => {
  const { world, config } = await bootNewDesktop();
  const page = connectPage(world);
  config.set('drawer.enabled', false); // the drawer switched off in Settings must not stop a receipt-embedded kick (SPEC 10)
  config.set('drawer.pin', 5);
  const kick = await lib.opencashdrawer();
  assert.equal(hex(kick), '1b401b700019ff');
  page.electron.sendReceiptData({ receiptFileBinary: kick, order: P.sampleOrder(), isDuplicate: false, business: P.sampleBusiness(), businessData: {}, settings: P.sampleSettings() });
  await page.settle();
  assert.equal(world.rawPrinter.jobs.length, 1);
  assert.equal(hex(world.rawPrinter.jobs[0].bytes), '1b401b700019ff');
  assert.equal(world.rawPrinter.jobs[0].label, 'receipt');
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});

test('1C. the Open button (the original payload: order false, openCashDrawer true, whole business and settings) opens the password window and prints nothing', async () => {
  const { world } = await bootNewDesktop();
  const page = connectPage(world);
  page.electron.sendReceiptData({ isDuplicate: false, order: false, business: P.sampleBusiness(), businessData: false, openCashDrawer: true, settings: P.sampleSettings() });
  await page.settle();
  assert.equal(world.services().passwordWindow.isOpen(), true);
  assert.match(world.services().passwordWindow.getWindow().webContents.getURL(), /password\.html\?purpose=drawer$/);
  assert.equal(world.rawPrinter.jobs.length, 0);
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});

// =====================================================================================================================================================
// 1D. the legacy drawer command: sendOpenDrawerCommand({ cashDrawerOpenPassword }), exactly as cashDrawerForm.jsx called it at origin/main
// =====================================================================================================================================================
test('1D. sendOpenDrawerCommand: right password pulses 1B 70 00 19 FF; wrong / missing / not set / disabled / locked out are each ONE native drawer box', async () => {
  const { world, config } = await bootNewDesktop({ password: 'tills-pw' });
  const page = connectPage(world);
  page.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'tills-pw' });
  await page.settle();
  assert.deepEqual([...world.rawPrinter.jobs[0].bytes], [0x1b, 0x70, 0x00, 0x19, 0xff]);
  assert.equal(world.rawPrinter.jobs[0].label, 'cash drawer');
  assert.equal(world.dialog.calls.length, 0);

  page.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'nope' });
  await page.settle();
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The cash drawer did not open');
  assert.match(world.dialog.calls[0].options.detail, /not correct/);
  note(`[1D] wrong password box: "${world.dialog.calls[0].options.detail}"`);

  // an empty password (the web's field left blank) and a call with no argument at all
  page.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: '' });
  page.electron.sendOpenDrawerCommand();
  await page.settle();
  assert.equal(world.rawPrinter.jobs.length, 1, 'still only the first pulse');
  note(`[1D] boxes after wrong/blank/no-arg: ${world.dialog.calls.length} (${world.dialog.calls.map((c) => c.options.detail).join(' | ')})`);
  world.cleanup();

  const noPw = await bootNewDesktop({ password: false });
  const p2 = connectPage(noPw.world);
  p2.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'anything' });
  await p2.settle();
  assert.match(noPw.world.dialog.calls[0].options.detail, /Settings > Cash drawer/);
  noPw.world.cleanup();

  const off = await bootNewDesktop();
  off.config.set('drawer.enabled', false);
  const p3 = connectPage(off.world);
  p3.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'tills-pw' });
  await p3.settle();
  assert.match(off.world.dialog.calls[0].options.detail, /switched off/);
  off.world.cleanup();

  const lock = await bootNewDesktop();
  const p4 = connectPage(lock.world);
  for (let i = 0; i < 5; i += 1) p4.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'bad' + i });
  await p4.settle();
  p4.electron.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'tills-pw' }); // the RIGHT password while locked
  await p4.settle();
  assert.equal(lock.world.rawPrinter.jobs.length, 0, 'locked out: not even the right password opens it');
  note(`[1D] lockout boxes: ${lock.world.dialog.calls.map((c) => c.options.detail).join(' | ')}`);
  lock.world.cleanup();
});

// =====================================================================================================================================================
// 1E. what the OLD web (which cannot show a failure) gets from the new desktop: native boxes, coalesced
// =====================================================================================================================================================
test('1E. a batch of 20 labels against a switched-off DYMO is ONE native box; Zebra with no label printer is ONE box; a receipt with no printer is ONE box', async () => {
  const dym = await bootNewDesktop({ dymoFramework: { printers: [] } });
  const page = connectPage(dym.world);
  for (let i = 0; i < 20; i += 1) page.electron.sendBarcodeData(await P.modal('dymo'));
  await page.settle();
  assert.equal(dym.world.dialog.calls.length, 1);
  assert.match(dym.world.dialog.calls[0].options.detail, /No DYMO printer was found/);
  dym.world.cleanup();

  const none = await bootNewDesktop({ printers: false });
  const p2 = connectPage(none.world);
  for (let i = 0; i < 5; i += 1) p2.electron.sendBarcodeData(await P.modal('zebra'));
  for (let i = 0; i < 5; i += 1) p2.electron.sendReceiptData({ receiptFileBinary: await P.saleReceiptBytes(), order: P.sampleOrder() });
  await p2.settle();
  const details = none.world.dialog.calls.map((c) => `${c.options.message}: ${c.options.detail}`);
  note(`[1E] no printers configured: ${details.join(' | ')}`);
  // ONE box: the box is keyed by the error CODE, so the receipts that fail with the same code in the same 5 s are not shown at all (the label box's heading says "label")
  assert.equal(none.world.dialog.calls.length, 1);
  none.world.cleanup();
});

// =====================================================================================================================================================
// 1F. what the v1 preload exposed that the v2 preload does not
// =====================================================================================================================================================
test('1F. v1 also exposed window.ipcRenderer.send and window.dymo.printLabel; the web at origin/main never touched either (informational)', async () => {
  const { world } = await bootNewDesktop();
  const page = connectPage(world);
  assert.deepEqual(Object.keys(page.exposed), ['electron'], 'v2 exposes window.electron only');
  for (const name of ['sendReceiptData', 'sendBarcodeData', 'sendOpenDrawerCommand', 'printReceipt', 'printBarcode', 'openCashDrawer', 'getAppInfo', 'getPrinters']) {
    assert.equal(typeof page.electron[name], 'function', name);
  }
  world.cleanup();
});

// =====================================================================================================================================================
// 1G. a repair message with an orderItems ARRAY (what the v1 loop was written for): one label per item on both desktops, the same ops label by label
// =====================================================================================================================================================
test('1G. repair message with orderItems (3 items): v1 and the new desktop print 3 labels each, item by item with the same texts; an hostile item still prints on v2 only', async () => {
  const mk = (items) => ({
    barcodefinal: {
      printer: 'dymo', design: 'repair', barcode: 'RPR-5521', orderDate: '19/11/2026', customer: { name: 'A. Customer', cell_no: '07123456789' },
      business: { business_name: 'Gadgets Shop', branch_name: 'Main St', business_address: '1 Road', post_code: 'AB1 2CD' }, orderItems: items,
    },
    barcode: 'RPR-5521', design: 'repair',
  });
  const plain = [
    { id: 1, product_name: 'iPhone 12 screen', current_price: 79, custom_field_value: [{ value: 'Screen' }, { value: 'iPhone 12' }, { value: 'Cracked' }] },
    { id: 2, product_name: 'Battery', current_price: 25, custom_field_value: [{ value: 'Battery' }] },
    { id: 3, product_name: 'Back glass', current_price: 30 },
  ];
  const { world, factory } = await bootNewDesktop();
  const page = connectPage(world);
  for (const [name, items, v1prints] of [['plain items', plain, true], ['one item with a quote', [plain[0], { ...plain[1], product_name: 'iPad 10.2" battery' }, plain[2]], false]]) {
    const message = mk(items);
    const v1 = await runV1('send-barcode-data', structuredClone(message));
    const before = dymoLabelsOf(factory).length;
    page.electron.sendBarcodeData(structuredClone(message));
    await page.settle();
    const v2 = dymoLabelsOf(factory).slice(before);
    assert.equal(v2.length, 3, `${name}: v2 prints one label per item`);
    assert.ok(v2.every((l) => l.printed));
    if (v1prints) {
      assert.equal(v1.labels.length, 3, `${name}: v1 prints one label per item`);
      assert.deepEqual(v1.labels.map((l) => pairs(l.ops)), v2.map((l) => pairs(l.ops)), `${name}: identical ops label by label`);
    } else {
      assert.equal(v1.labels.length, 1, `${name}: v1 prints the first item, then its script breaks on the quote and the other items are never tried`);
      assert.equal(v1.scriptErrors.length, 1);
    }
    note(`[1G] ${name}: v1 labels=${v1.labels.length} printed=${v1.printed} | v2 labels=${v2.length} printed=${v2.every((l) => l.printed)}`);
  }
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});
