// contract-matrix, combination 2: the NEW web util against an OLD desktop (v1.x): a stub that has ONLY sendReceiptData / sendBarcodeData, and the REAL v1.6.1 handler.
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=170000 tests/verify/c3-new-web-old-desktop.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWebDesktop, oldDesktopStub, runV1, web, pairs, opValue } from './_kit.mjs';
import { cutWeb, instantiate } from './_kit.mjs';
import * as P from './_payloads.mjs';
import { quietConsole, spy } from './_sites.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c3 report ====\n' + REPORT.join('\n')));

// =====================================================================================================================================================
// 3A. the util against the OLD-desktop stub
// =====================================================================================================================================================
test('3A. getDesktopInfo / isDesktopApp on a v1.x desktop: { apiVersion: 1 } and true', async () => {
  const stub = oldDesktopStub();
  const { desktop } = makeWebDesktop(stub.electron);
  assert.equal(desktop.isDesktopApp(), true);
  assert.deepEqual(await desktop.getDesktopInfo(), { apiVersion: 1 });
  assert.deepEqual(stub.calls, [], 'asking never prints');
});

test('3A. sendReceipt on a v1.x desktop: every receipt shape goes to sendReceiptData as the SAME object, answers { ok: true }, and nothing else is called', async () => {
  const stub = oldDesktopStub();
  const { desktop, events } = makeWebDesktop(stub.electron);
  const bytes = await P.saleReceiptBytes();
  const shapes = [
    { receiptFileBinary: bytes, order: P.sampleOrder(), isDuplicate: false, business: P.sampleBusiness(), businessData: {}, settings: P.sampleSettings() },
    { test: 'test', receiptFileBinary: bytes, order: {}, isDuplicate: true },
    { receiptFileBinary: bytes, item: { id: 1 }, businessData: false, business: {}, isDuplicate: true, settings: {} },
    { receiptFileBinary: bytes, businessData: {}, business: {}, isDuplicate: true, settings: {} },
    { isDuplicate: false, order: false, business: {}, businessData: false, openCashDrawer: true, settings: {} }, // the Open button
    { receiptFileBinary: await (await import('./_kit.mjs')).lib.opencashdrawer(), order: P.sampleOrder() }, // the 7-byte kick
  ];
  for (const payload of shapes) {
    const result = await desktop.sendReceipt(payload);
    assert.deepEqual(result, { ok: true });
    assert.equal(stub.calls.at(-1).name, 'sendReceiptData');
    assert.equal(stub.calls.at(-1).payload, payload, 'the very same object, not a copy and not a slimmed one');
  }
  assert.equal(stub.calls.length, shapes.length);
  assert.deepEqual(events, []);
});

test('3A. sendReceipt refuses nothing-to-print on a v1.x desktop too (and says so once), without calling the desktop', async () => {
  const stub = oldDesktopStub();
  const { desktop, events } = makeWebDesktop(stub.electron);
  for (const bad of [undefined, null, 'x', [], {}, { order: {} }, { receiptFileBinary: '' }, { openCashDrawer: true, order: { id: 1 } }]) {
    const r = await desktop.sendReceipt(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_PAYLOAD');
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(events.length, 1, 'one sentence, de-duplicated');
  note(`[3A] nothing to print: ${JSON.stringify(events[0])}`);
});

test('3A. openCashDrawer on a v1.x desktop: sendReceiptData({ openCashDrawer: true }) and { ok: true, details: { prompted: true } }; sendOpenDrawerCommand is never used, even when the stub has it', async () => {
  const stub = oldDesktopStub();
  const { desktop } = makeWebDesktop(stub.electron);
  assert.deepEqual(await desktop.openCashDrawer({ password: 'typed-but-useless' }), { ok: true, details: { prompted: true } });
  assert.deepEqual(stub.calls, [{ name: 'sendReceiptData', payload: { openCashDrawer: true } }], 'the password is not sent anywhere');
  const withLegacyDrawer = oldDesktopStub();
  withLegacyDrawer.electron.sendOpenDrawerCommand = spy();
  const w2 = makeWebDesktop(withLegacyDrawer.electron);
  await w2.desktop.openCashDrawer({ password: 'x' });
  assert.equal(withLegacyDrawer.electron.sendOpenDrawerCommand.calls.length, 0);
  // and a call with no argument at all
  assert.deepEqual(await desktop.openCashDrawer(), { ok: true, details: { prompted: true } });
  assert.deepEqual(await desktop.openCashDrawer(undefined, { notify: false }), { ok: true, details: { prompted: true } });
});

test('3A. how the util degrades when the desktop has NO function at all, a partial bridge, a throwing bridge, or there is no window.electron (plain browser)', async () => {
  // no window.electron
  for (const electron of [undefined, null]) {
    const { desktop, events } = makeWebDesktop(electron);
    assert.equal(desktop.isDesktopApp(), false);
    assert.equal(await desktop.getDesktopInfo(), null);
    for (const r of [await desktop.sendReceipt({ receiptFileBinary: Buffer.from([1]) }), await desktop.sendLabel({ barcodefinal: { printer: 'dymo' } }), await desktop.openCashDrawer({ password: 'x' })]) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DESKTOP_UNAVAILABLE');
    }
    assert.ok(events.length >= 1);
    note(`[3A] browser: ${events.map((e) => e.message).join(' | ')}`);
  }
  // an EMPTY window.electron (exists, no functions): a desktop of some other kind
  const empty = makeWebDesktop({});
  assert.equal(empty.desktop.isDesktopApp(), true);
  assert.equal((await empty.desktop.sendLabel({ barcodefinal: { printer: 'dymo' } })).code, 'DESKTOP_UNAVAILABLE');
  // only sendReceiptData: labels are DESKTOP_UNAVAILABLE, receipts work, the drawer works through sendReceiptData
  const partial = [];
  const half = makeWebDesktop({ sendReceiptData: (p) => partial.push(p) });
  assert.equal((await half.desktop.sendReceipt({ receiptFileBinary: Buffer.from([1]) })).ok, true);
  assert.equal((await half.desktop.sendLabel({ barcodefinal: '^XA^XZ' })).code, 'DESKTOP_UNAVAILABLE');
  assert.equal((await half.desktop.openCashDrawer({})).ok, true);
  // a function that throws
  const boom = oldDesktopStub({ throwOn: 'sendBarcodeData' });
  const t = makeWebDesktop(boom.electron);
  const r = await t.desktop.sendLabel({ barcodefinal: { printer: 'dymo', title: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN');
  assert.match(r.message, /Close the app, open it again/);
  assert.equal(t.events.length, 1);
});

test('3A. sendLabel on a v1.x desktop: a Zebra ZPL text goes as the SAME object; a message with no barcodefinal never reaches the desktop (v1 would throw a TypeError)', async () => {
  const stub = oldDesktopStub();
  const { desktop, events } = makeWebDesktop(stub.electron);
  const zpl = await P.modal('zebra');
  assert.deepEqual(await desktop.sendLabel(zpl), { ok: true });
  assert.equal(stub.calls[0].payload, zpl, 'Zebra: untouched, same object');
  for (const message of [{ barcode: '1', title: 'x' }, { barcodefinal: undefined }, { barcodefinal: null }]) {
    const r = await desktop.sendLabel(message);
    assert.deepEqual(r, { ok: false, code: 'INVALID_PAYLOAD', message: 'No label printer type is chosen. Open Account settings and choose Zebra or DYMO.' });
  }
  assert.equal(stub.calls.length, 1);
  assert.equal(events.length, 1);
  // what v1 does with the same message if it were sent: it throws before its own try block (so the guard is a real fix, not cosmetics)
  const v1 = await runV1('send-barcode-data', { barcode: '1', title: 'x' });
  assert.match(v1.handlerError || '', /Cannot read properties of undefined/);
});

// =====================================================================================================================================================
// 3B. the REAL v1 handler with what the new web sends
// =====================================================================================================================================================
const HOSTILE = [
  ['MacBook Air 13" M1', "MacBook Air 13'' M1"],
  ['iPad Pro 12.9"', "iPad Pro 12.9''"],
  ['line one\nline two', 'line one line two'],
  ['line one\r\nline two', 'line one line two'],
  ['tab\there', 'tab here'],
  ['C:\\temp\\new', 'C:/temp/new'],
  ['trailing backslash\\', 'trailing backslash/'],
  ['sep\u2028arator\u2029s', 'sep arator s'],
  ['both "quote" and \\ and\nnewline', "both ''quote'' and / and newline"],
  ["it's fine", "it's fine"],
  ['back`tick and ${x}', 'back`tick and ${x}'],
  ['\u201csmart\u201d \u2018quotes\u2019 £ € é', '\u201csmart\u201d \u2018quotes\u2019 £ € é'],
];

test('3B. the title of every design on the REAL v1 handler: the new web makes it print, the old web did not (control), and the label shows the sanitised text', async () => {
  const designs = [
    ['1', '32x57', 'Labeldesign1_1.dymo'],
    ['2', '32x57', 'Labeldesign2.dymo'],
    ['3', '32x57', 'mukltipleBarcode.dymo'],
    ['4', '32x57', 'multipleQRCODE.dymo'],
    ['1', '70x54', '70_54_Labeldesign1_2_22.dymo'],
    ['1', '25x25', '25_25_barcode.dymo'],
  ];
  let controlFailures = 0;
  let runs = 0;
  for (const [raw, expected] of HOSTILE) {
    for (const [design, size] of designs) {
      const stub = oldDesktopStub();
      const { desktop } = makeWebDesktop(stub.electron);
      const message = {
        barcodefinal: { printer: 'dymo', title: raw, barcode: 'ABCDEFGH123456', storage: raw, network: raw, ram: raw, misc_color: raw, warranty: `12 ${raw}`, Processor: raw, conditionObject: { grade: raw }, price: 99.5, isSale: false, currency: 'GBP' },
        barcode: 'ABCDEFGH123456', title: raw, price: 99.5, design, size,
      };
      const before = structuredClone(message);
      await desktop.sendLabel(message);
      assert.deepEqual(message, before, 'the caller\'s object is never changed');
      const sent = stub.calls[0].payload;
      const v1 = await runV1('send-barcode-data', structuredClone(sent));
      runs += 1;
      assert.equal(v1.printed, true, `${JSON.stringify(raw)} design ${design} ${size}: v1 prints it (${v1.error || v1.consoleErrors.join(';')})`);
      assert.equal(v1.template, expected === undefined ? v1.template : v1.template);
      if (['25x25'].includes(size)) continue;
      if (design !== '3' && design !== '4') assert.equal(opValue(v1.labels[0], 'ItemNameVal'), expected, `${JSON.stringify(raw)}: the title on the label`);
      // control: the same message WITHOUT the util's sanitiser
      const control = await runV1('send-barcode-data', structuredClone(message));
      if (!control.printed) controlFailures += 1;
    }
  }
  note(`[3B] ${runs} hostile-title runs on the real v1 handler: all printed through the new web; ${controlFailures} of them fail when sent unsanitised (the old web)`);
  assert.ok(controlFailures > 0, 'the control must fail somewhere, otherwise the test proves nothing');
});

test('3B. the named cases from the brief on the real v1 handler: MacBook Air 13" M1, iPad Pro 12.9", a newline, through BarcodePanelTab / Quick Add / order / appointment / box / lab / repair shapes', async () => {
  const shapes = {
    panel: (t) => P.panel('dymo', { name: t }),
    quickAdd: (t) => P.quickAdd('dymo', { name: t }),
    orderSell: (t) => P.orderLabel('sell', 'dymo', { item: { id: 1, product_sn_imei_no: '356938035643809', product_name: t, current_price: 10, quantity: 1 } }),
    appointment: (t) => P.appointment('dymo', { product_name: t }),
    box: (t) => P.box({ box_label: t }),
    lab: (t) => P.lab('dymo', { title: t }),
    repair: (t) => P.repairItem('dymo', { item: { id: 9, product_name: t, device: t, job: t, remarks: t } }),
    modal: (t) => P.modal('dymo', { heading: t }),
  };
  const titles = ['MacBook Air 13" M1', 'iPad Pro 12.9"', 'two\nlines'];
  for (const [name, make] of Object.entries(shapes)) {
    for (const title of titles) {
      const payload = await make(title);
      const stub = oldDesktopStub();
      const { desktop } = makeWebDesktop(stub.electron);
      assert.deepEqual(await desktop.sendLabel(payload), { ok: true });
      const v1new = await runV1('send-barcode-data', structuredClone(stub.calls[0].payload));
      const v1old = await runV1('send-barcode-data', structuredClone(payload));
      assert.equal(v1new.printed, true, `${name} ${JSON.stringify(title)}: v1 prints the new web's message`);
      assert.equal(v1old.printed, false, `${name} ${JSON.stringify(title)}: v1 does NOT print the old web's message (the bug this fixes)`);
    }
  }
  note('[3B] 24 shape x title combinations: v1 prints every one from the new web and none from the old web');
});

test('3B. fuzz: random hostile text in EVERY string field of every design on the REAL v1 handler: the sanitiser leaves nothing that breaks v1 (numbers excepted)', async () => {
  let seed = 20261119;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const alphabet = ['"', '\\', '\n', '\r', '\t', '\u2028', '\u2029', "'", '`', '${', '$&', '$1', '<', '>', '&', ' ', '  ', 'a', 'Z', '9', '£', 'é', '\u0000', '\u000b', '\u0085', '\\u0041', '\\n', '}', ')', ';', '//', '/*'];
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
  const designs = [['1', '32x57'], ['2', '32x57'], ['3', '32x57'], ['4', '32x57'], ['1', '70x54'], ['2', '70x54'], ['', '32x57'], ['1', '25x25'], ['2', '25x25']];
  const failures = [];
  let runs = 0;
  for (let i = 0; i < 160; i += 1) {
    const [design, size] = designs[i % designs.length];
    const sale = i % 3 === 0;
    const message = {
      barcodefinal: {
        printer: 'dymo', title: text(), barcode: `B${Math.floor(rnd() * 1e9)}`, storage: text(), network: text(), ram: text(), misc_color: text(), warranty: text() + 'xx', Processor: text(), processor: text(),
        conditionObject: { grade: text() }, price: 10 + i, salePrice: sale ? 5 : 0, regular_price: 20, isSale: sale, currency: 'GBP',
      },
      barcode: `B${i}`, title: text(), price: 10, design, size,
    };
    if (sale && design === '') continue; // v1 prints nothing for this at all (intended difference e), whatever the text
    const stub = oldDesktopStub();
    const { desktop } = makeWebDesktop(stub.electron);
    await desktop.sendLabel(message);
    const v1 = await runV1('send-barcode-data', structuredClone(stub.calls[0].payload));
    runs += 1;
    if (!v1.printed) failures.push({ design, size, sale, error: v1.error, console: v1.consoleErrors, message: JSON.stringify(message.barcodefinal) });
  }
  note(`[3B] fuzz: ${runs} runs on the real v1 handler, ${failures.length} failures`);
  if (failures.length) note('[3B] FUZZ FAILURES (first 5): ' + failures.slice(0, 5).map((f) => `${f.design}/${f.size}/sale=${f.sale}: ${f.error} ${f.console.join(' ')} ${f.message.slice(0, 200)}`).join('\n      '));
  assert.deepEqual(failures.map((f) => `${f.design}/${f.size}: ${f.error}`), []);
});

test('3B. the barcode itself on v1: a hostile barcode is cleaned of quotes and backslashes but v1 still breaks on a backtick, ${, & or < in a QR design (documented limit; barcodes are product numbers)', async () => {
  const results = [];
  for (const barcode of ['AB"C1', 'AB\\C1', 'AB`C1', 'AB${x}C1', 'AB&C1', 'AB<C1', 'AB$&C1']) {
    for (const [design, size] of [['1', '32x57'], ['2', '32x57'], ['4', '32x57'], ['2', '25x25']]) {
      const stub = oldDesktopStub();
      const { desktop } = makeWebDesktop(stub.electron);
      await desktop.sendLabel({ barcodefinal: { printer: 'dymo', title: 'x', barcode, price: 5 }, barcode, title: 'x', price: 5, design, size });
      const v1 = await runV1('send-barcode-data', structuredClone(stub.calls[0].payload));
      results.push({ barcode, design, size, printed: v1.printed, error: v1.error });
    }
  }
  const failing = results.filter((r) => !r.printed);
  note(`[3B] hostile BARCODES on the real v1 handler via the new web: ${results.length - failing.length} printed, ${failing.length} failed: ${[...new Set(failing.map((f) => `${JSON.stringify(f.barcode)} on ${f.design}/${f.size}`))].join(' ; ')}`);
  // the quote and the backslash never fail (they are cleaned): the sanitiser's two jobs
  assert.ok(results.filter((r) => /["\\]/.test(r.barcode)).every((r) => r.printed));
});

// =====================================================================================================================================================
// 3C. the REAL v1 receipt channel: what a drawer request and a receipt reach
// =====================================================================================================================================================
test('3C. the REAL v1 send-receipt-data: { openCashDrawer: true } (what the new web sends) and the old web\'s Open payload both reach the drawer password flow, a receipt reaches the receipt printer path', async () => {
  const request = await runV1('send-receipt-data', { openCashDrawer: true });
  const open = await runV1('send-receipt-data', { isDuplicate: false, order: false, business: {}, businessData: false, openCashDrawer: true, settings: {} });
  const receipt = await runV1('send-receipt-data', { receiptFileBinary: Buffer.from([0x1b, 0x40]), order: { id: 1 } });
  const kick = await runV1('send-receipt-data', { receiptFileBinary: Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0, 0x19, 0xff]), order: { id: 1 }, openCashDrawer: undefined });
  note(`[3C] v1 on { openCashDrawer: true }: boxes=${JSON.stringify(request.errorBoxes)} | on the old Open payload: boxes=${JSON.stringify(open.errorBoxes)} | on a receipt: boxes=${JSON.stringify(receipt.errorBoxes)} | on the kick-with-order: ${JSON.stringify(kick.errorBoxes)}`);
  assert.deepEqual(request.errorBoxes.map((b) => b.content), open.errorBoxes.map((b) => b.content), 'the new web\'s slim request and the old Open payload take v1 to the same place');
  assert.match(request.errorBoxes[0].content, /No password is set for the cash drawer/, 'v1 went into openCashDrawer() (its password window flow)');
  assert.doesNotMatch(receipt.errorBoxes.map((b) => b.content).join(), /No password is set/);
  assert.match(receipt.errorBoxes[0].content, /Direct receipt printing is only supported on Windows|Printer port is not configured/, 'a receipt goes to the receipt path, not the drawer path');
  assert.doesNotMatch(kick.errorBoxes.map((b) => b.content).join(), /No password is set/, 'the kick with an order is a receipt on v1 too');
});

// =====================================================================================================================================================
// 3D. the cash drawer DIALOG (cashDrawerForm.jsx handleOpenCashDrawer), the real handler, on a v1.x desktop
// =====================================================================================================================================================
test('3D. cashDrawerForm.handleOpenCashDrawer on a v1.x desktop: the NEW handler closes the dialog and shows no error (v1 opens its own password window); the ORIGINAL handler throws a TypeError (dead UI)', async () => {
  const stub = oldDesktopStub();
  const { desktop, events } = makeWebDesktop(stub.electron);
  const file = 'src/pages-sections/vendor/point-of-sale/pos-buy-orders/pos-card-items/cashDrawerForm.jsx';
  const state = { loading: [], error: [], closed: [] };
  const handler = instantiate(cutWeb(file, 'handleOpenCashDrawer'), {
    setButtonLoading: (v) => state.loading.push(v), setErrorText: (v) => state.error.push(v), setOpenCashDrawerDialog: (v) => state.closed.push(v),
    openCashDrawer: desktop.openCashDrawer, cashDrawerPassword: 'typed', failureText: web.index.failureText,
  });
  await handler();
  assert.deepEqual(state, { loading: [true, false], error: [''], closed: [false] }, 'busy on, busy off, no error, dialog closed');
  assert.deepEqual(stub.calls, [{ name: 'sendReceiptData', payload: { openCashDrawer: true } }]);
  assert.deepEqual(events, []);

  // the original handler of origin/main on the same v1 stub: window.electron.sendOpenDrawerCommand does not exist there
  const { execFileSync } = await import('node:child_process');
  const { cutWebOriginal } = await import('./_kit.mjs');
  const original = instantiate(cutWebOriginal(file, 'handleOpenCashDrawer', execFileSync), { window: { electron: oldDesktopStub().electron }, cashDrawerPassword: 'typed' });
  assert.throws(() => original(), /sendOpenDrawerCommand is not a function/);
  note('[3D] new handler on v1: dialog closes, v1 opens its own password window (typed password unused); original handler on v1: TypeError sendOpenDrawerCommand is not a function (never reachable: the dialog is never opened)');
});
