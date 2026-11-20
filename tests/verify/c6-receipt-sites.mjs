// contract-matrix, every RECEIPT call site (the real handlers cut from the source): the ORIGINAL (origin/main, window.electron.sendReceiptData) and the NEW
// (sendReceipt of utils/desktop) each against the v1.x desktop (a recording stub) and the v2 desktop (real preload + src/main). The receipt generators are replaced by
// functions that answer fixed bytes (the desktop never reads them), so what is compared is what each site SENDS and what the desktop PRINTS.
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=170000 tests/verify/c6-receipt-sites.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { bootNewDesktop, connectPage, makeWebDesktop, oldDesktopStub, lib, cutWeb, cutWebOriginal, instantiate, freeNamesOf, hex } from './_kit.mjs';
import * as P from './_payloads.mjs';
import { spy } from './_sites.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c6 report ====\n' + REPORT.join('\n')));

const RECEIPTS = 'src/components/componentToPrint/POS/print-receipt/printReceiptsComponents';
const POS = 'src/pages-sections/vendor/point-of-sale';
const BYTES = Buffer.from([0x1b, 0x40, ...Buffer.from('Receipt £5.00\n'), 0x1d, 0x56, 0x00]);

const SITES = [
  { id: 'ReceiptIcons', file: `${RECEIPTS}/ReceiptIcons.jsx`, fn: 'handlePrinting' },
  { id: 'CompletedOrderReceipts', file: `${RECEIPTS}/CompletedOrderReceipts.jsx`, fn: 'handlePrinting' },
  { id: 'AllSalesCompletedOrderReceipts', file: `${RECEIPTS}/AllSalesCompletedOrderReceipts.jsx`, fn: 'handlePrinting' },
  { id: 'CustomerOrderReceipt', file: `${RECEIPTS}/CustomerOrderReceipt.jsx`, fn: 'handlePrinting' },
  { id: 'PendingAndProgressReceipt', file: `${RECEIPTS}/PendingAndProgressReceipt.jsx`, fn: 'handlePrinting' },
  { id: 'ReturnCompleteOrderReceipt', file: `${RECEIPTS}/ReturnCompleteOrderReceipt.jsx`, fn: 'handlePrinting' },
  { id: 'RemainingOrderAmountReceipt', file: `${RECEIPTS}/RemainingOrderAmountReceipt.jsx`, fn: 'handlePrintDialogAndElectron', args: () => [P.sampleOrder()] },
  { id: 'drawerpurchaseprint', file: 'src/pages-sections/vendor/purchases/retrun-orders/product-return/drawerpurchaseprint.jsx', fn: 'handlePrinting' },
  { id: 'DailyClosing', file: `${POS}/topbar/DailyClosing.jsx`, fn: 'handlePrinting', args: () => [{ id: 9, total: 100, notes: 'x'.repeat(5000) }] },
  ...['pos-buy-orders/pos-card-items/pos-card-items-bottom.jsx', 'orders-list/pending-order-list.jsx', 'orders-list/pending-order-list-card-view.jsx', 'orders-list/progress-order-list.jsx', 'orders-list/progress-order-list-card-view.jsx', 'orders-list/useBulkOrderComplete.js'].flatMap((f) => [
    { id: `${f.split('/').pop()} (auto receipt)`, file: `${POS}/${f}`, fn: 'handleNewOrderCompleted', args: () => [P.sampleOrder()], flags: { print_auto_receipt_on_complete: true }, expect: 1 },
    { id: `${f.split('/').pop()} (cash drawer receipt)`, file: `${POS}/${f}`, fn: 'handleNewOrderCompleted', args: () => [P.sampleOrder()], flags: { print_auto_receipt_on_complete: false }, expect: f.includes('pending-order') || f.includes('progress-order-list') || f.includes('pos-card') || f.includes('useBulk') ? 1 : 1 },
  ]),
];

const proxySpy = () => new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? spy() : undefined) });
const GENERATORS = Object.fromEntries(Object.entries(lib).filter(([k, v]) => typeof v === 'function' && k !== 'opencashdrawer').map(([k]) => [k, async () => BYTES]));

function scopeFor(names, env, flags = {}) {
  const pos = { print_direct_receipt: true, print_auto_receipt_on_complete: true, use_print_server: false, label_printer_type: 'dymo', business_currency: 'GBP', receipt_paper_size: '80mm', ...flags };
  const known = {
    window: env.window, sendReceipt: env.sendReceipt, posCurrencyExit: pos, business: P.sampleBusiness(), order: P.sampleOrder(), imageBaseUrl: 'https://img.example.com/',
    isDuplicate: false, api: proxySpy(), apiProducts: proxySpy(), apiPrints: proxySpy(), dispatch: spy(), printRewardVoucherIfIssued: spy(), opencashdrawer: lib.opencashdrawer,
    statePos: { posCurrencyExit: pos }, handlePrint: spy(), handlePrintUI: spy(), receiptUpdatedOrder: P.sampleOrder(), purchaseOrder: { id: 5 }, console: { log() {}, error() {}, warn() {} },
    reload_product_list: false, setReceiptOrder: spy(), ...GENERATORS,
  };
  const unresolved = [];
  const scope = new Proxy(known, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key in globalThis) return globalThis[key];
      unresolved.push(key);
      return spy();
    },
    has: (_t, key) => typeof key === 'string',
  });
  return { scope, unresolved };
}

async function runSite(site, source, desk) {
  const cut = source === 'old' ? cutWebOriginal(site.file, site.fn, execFileSync) : cutWeb(site.file, site.fn);
  const names = freeNamesOf(cut);
  if (desk === 'v1') {
    const stub = oldDesktopStub();
    const { desktop, events } = makeWebDesktop(stub.electron);
    const { scope, unresolved } = scopeFor(names, { window: { electron: stub.electron }, sendReceipt: desktop.sendReceipt }, site.flags);
    const fn = new Function('__scope', `with (__scope) { return (${cut}); }`)(scope);
    let thrown = null;
    try { await fn(...(site.args ? site.args() : [])); } catch (error) { thrown = error; }
    return { thrown, unresolved: [...new Set(unresolved)], messages: stub.calls.map((c) => ({ fn: c.name, payload: c.payload })), events };
  }
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world);
  const { desktop, events } = makeWebDesktop(page.electron);
  const { scope, unresolved } = scopeFor(names, { window: { electron: page.electron }, sendReceipt: desktop.sendReceipt }, site.flags);
  const fn = new Function('__scope', `with (__scope) { return (${cut}); }`)(scope);
  let thrown = null;
  try { await fn(...(site.args ? site.args() : [])); } catch (error) { thrown = error; }
  await page.settle();
  const out = {
    thrown, unresolved: [...new Set(unresolved)], events,
    messages: [
      ...page.sent.filter((s) => s.channel === 'send-receipt-data').map((s) => ({ fn: 'sendReceiptData', payload: s.args[0] })),
      ...page.sandbox.ipc.invoked.filter((s) => s.channel === 'print-receipt').map((s) => ({ fn: 'printReceipt', payload: s.args[0] })),
    ],
    jobs: boot.world.rawPrinter.jobs.map((j) => ({ label: j.label, target: j.target.printerName, hex: hex(j.bytes) })),
    boxes: boot.world.dialog.calls.length,
  };
  boot.world.cleanup();
  return out;
}

const plain = (value) => JSON.parse(JSON.stringify(value, (k, v) => (v instanceof Uint8Array ? `bytes:${hex(v)}` : v)));

for (const site of SITES) {
  test(`receipt site ${site.id}`, async () => {
    const R = {};
    for (const source of ['old', 'new']) for (const desk of ['v1', 'v2']) R[`${source}/${desk}`] = await runSite(site, source, desk);
    for (const [k, r] of Object.entries(R)) assert.equal(r.thrown, null, `${k}: ${r.thrown && r.thrown.stack}`);
    const counts = Object.values(R).map((r) => r.messages.length);
    assert.equal(new Set(counts).size, 1, `message counts ${JSON.stringify(Object.fromEntries(Object.entries(R).map(([k, r]) => [k, r.messages.length])))}`);
    assert.ok(counts[0] >= 1, `${site.id}: the site sent nothing (a branch of the handler was not reached): ${R['new/v2'].unresolved}`);
    // old web's message == new web's message on a v1 desktop (the util hands the object over unchanged)
    R['old/v1'].messages.forEach((m, i) => {
      assert.equal(m.fn, 'sendReceiptData');
      assert.deepEqual(plain(R['new/v1'].messages[i].payload), plain(m.payload), `${site.id}: message ${i} is the same object content on a v1 desktop`);
      assert.equal(R['new/v1'].messages[i].fn, 'sendReceiptData');
      assert.equal(R['old/v2'].messages[i].fn, 'sendReceiptData');
      assert.equal(R['new/v2'].messages[i].fn, 'printReceipt');
      assert.ok(m.payload.receiptFileBinary, 'the site sent bytes');
    });
    // on the v2 desktop the new web sends ONLY the bytes (or the drawer request)
    for (const m of R['new/v2'].messages) assert.deepEqual(Object.keys(m.payload), ['receiptFileBinary'], `${site.id}: only the bytes cross to the new desktop`);
    // what the v2 desktop printed is the same for both web generations, and is the bytes the handler built
    assert.deepEqual(R['new/v2'].jobs, R['old/v2'].jobs, `${site.id}: old web and new web print the same on the new desktop`);
    assert.ok(R['new/v2'].jobs.length === counts[0] && R['new/v2'].jobs.every((j) => j.label === 'receipt' && j.target === 'EPSON TM-T20'), `${site.id}: every message printed on the receipt printer (${JSON.stringify(R['new/v2'].jobs.map((j) => j.hex.length))})`);
    assert.equal(R['new/v2'].boxes + R['old/v2'].boxes, 0);
    assert.deepEqual([...R['new/v2'].events, ...R['new/v1'].events], []);
    note(`[${site.id}] ${counts[0]} message(s); bytes ${R['new/v2'].jobs.map((j) => j.hex.length / 2).join('+')} B; keys sent by the site: ${Object.keys(R['old/v1'].messages[0].payload).join(',')}; auto-stubbed names: ${[...new Set([...R['new/v2'].unresolved, ...R['old/v2'].unresolved])].join(',') || '-'}`);
  });
}

test('directPrint.js dispatchDirectPrint (the shared dispatcher), old and new, on both desktops', async () => {
  const file = 'src/utils/directPrint.js';
  for (const desk of ['v1', 'v2']) {
    const results = {};
    for (const source of ['old', 'new']) {
      const cut = source === 'old' ? cutWebOriginal(file, 'dispatchDirectPrint', execFileSync) : cutWeb(file, 'dispatchDirectPrint');
      let electron; let boot; let page; let stub;
      let desktop;
      if (desk === 'v1') { stub = oldDesktopStub(); electron = stub.electron; ({ desktop } = makeWebDesktop(electron)); }
      else { boot = await bootNewDesktop(); page = connectPage(boot.world); electron = page.electron; ({ desktop } = makeWebDesktop(electron)); }
      const fn = instantiate(cut, { window: { electron }, sendReceipt: desktop.sendReceipt, apiProducts: { savePrintJob: spy() } });
      await fn({ generatorFn: async () => BYTES, payload: { order: P.sampleOrder(), isDuplicate: false, businessData: {} }, business: P.sampleBusiness(), posCurrencyExit: { print_direct_receipt: true }, browserPrintFallback: spy() });
      if (page) await page.settle();
      results[source] = desk === 'v1' ? stub.calls.length : boot.world.rawPrinter.jobs.map((j) => hex(j.bytes));
      if (boot) boot.world.cleanup();
    }
    assert.deepEqual(results.new, results.old, `directPrint on ${desk}`);
    if (desk === 'v2') assert.deepEqual(results.new, [hex(BYTES)]);
  }
});
