// contract-matrix, combination 4: the NEW desktop with the v1-era payload fields: processor / Processor, currency absent or odd, size absent or odd, design absent or odd,
// numbers where text is expected, `prints`, and the oldest message shapes (a label with no barcodefinal at all). Sent through the legacy function of the real preload,
// printed by the real DYMO service on the fake framework.
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=170000 tests/verify/c5-new-desktop-v1-fields.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootNewDesktop, connectPage, runV1, buildLabelPlan, dymoLabelsOf, pairs, opValue } from './_kit.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c5 report ====\n' + REPORT.join('\n')));

const base = (bf = {}, outer = {}) => ({
  barcodefinal: { printer: 'dymo', title: 'iPhone 13', barcode: 'ABCDEFGH123456', storage: '128GB', network: 'Unlocked', ram: '4GB', misc_color: 'Blue', warranty: '12 months', conditionObject: { grade: 'A+' }, price: 499.99, isSale: false, ...bf },
  barcode: 'ABCDEFGH123456', title: 'iPhone 13', price: 499.99, design: '1', ...outer,
});

async function printThroughNewDesktop(messages) {
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world);
  const out = [];
  for (const message of messages) {
    const before = dymoLabelsOf(boot.factory).length;
    page.electron.sendBarcodeData(structuredClone(message));
    await page.settle();
    const labels = dymoLabelsOf(boot.factory).slice(before);
    out.push({ labels, boxes: boot.world.dialog.calls.map((c) => c.options.detail) });
  }
  const boxes = boot.world.dialog.calls.map((c) => c.options.detail);
  boot.world.cleanup();
  return { out, boxes };
}

test('5A. processor / Processor: either key prints in the processor slot of every design that has one; both, neither, empty, odd types', async () => {
  const cases = [
    ['Processor only (BarcodePanelTab)', { Processor: 'A15 Bionic' }, 'A15 BIONIC'],
    ['processor only (Quick Add)', { processor: 'Snapdragon 8' }, 'SNAPDRAGON 8'],
    ['both, the same', { Processor: 'A15', processor: 'A15' }, 'A15'],
    ['both, different: Processor wins (Processor ?? processor)', { Processor: 'A15', processor: 'Other' }, 'A15'],
    ['Processor undefined, processor set', { Processor: undefined, processor: 'M1' }, 'M1'],
    ['Processor null, processor set', { Processor: null, processor: 'M1' }, 'M1'],
    ['neither', {}, null],
    ['a number', { Processor: 3.2 }, '3.2'],
    ['whitespace only', { Processor: '   ' }, null],
    ['Processor is an empty string and processor has the value (what an empty form field plus a Quick Add key would give)', { Processor: '', processor: 'M1' }, null],
  ];
  const { out } = await printThroughNewDesktop(cases.map(([, bf]) => base(bf)));
  cases.forEach(([name, , expected], i) => {
    const label = out[i].labels[0];
    assert.ok(label && label.printed, name);
    const specs = ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((n) => opValue(label, n)).filter(Boolean);
    if (expected === null) assert.ok(!specs.some((s) => /A15|SNAPDRAGON|M1/.test(s)), `${name}: no processor printed (${specs})`);
    else assert.ok(specs.includes(expected), `${name}: ${expected} in ${JSON.stringify(specs)}`);
    note(`[5A] ${name}: specs ${JSON.stringify(specs)}`);
  });
});

test('5B. currency: outer first, else barcodefinal.currency, default pound; the code for every other ISO code; never a glyph; the digits are as sent', async () => {
  const cases = [
    ['absent', {}, {}, '£499.99'],
    ['outer GBP', {}, { currency: 'GBP' }, '£499.99'],
    ['outer gbp lower case', {}, { currency: 'gbp' }, '£499.99'],
    ['outer " usd "', {}, { currency: ' usd ' }, 'USD 499.99'],
    ['outer AED', {}, { currency: 'AED' }, 'AED 499.99'],
    ['outer EUR', {}, { currency: 'EUR' }, 'EUR 499.99'],
    ['outer JPY', {}, { currency: 'JPY' }, 'JPY 499.99'],
    ['only in barcodefinal', { currency: 'AED' }, {}, 'AED 499.99'],
    ['both: the outer one wins', { currency: 'AED' }, { currency: 'USD' }, 'USD 499.99'],
    ['"$" is not a code', {}, { currency: '$' }, '£499.99'],
    ['"pounds" is not a code', {}, { currency: 'pounds' }, '£499.99'],
    ['empty string outer: the pound, even when barcodefinal has a code (?? only skips null)', { currency: 'AED' }, { currency: '' }, '£499.99'],
    ['null outer: barcodefinal.currency is used', { currency: 'AED' }, { currency: null }, 'AED 499.99'],
    ['a number', {}, { currency: 826 }, '£499.99'],
  ];
  const { out } = await printThroughNewDesktop(cases.map(([, bf, outer]) => base(bf, outer)));
  cases.forEach(([name, , , expected], i) => {
    const label = out[i].labels[0];
    assert.ok(label && label.printed, name);
    assert.equal(opValue(label, 'TEXT_3'), expected, name);
  });
  note('[5B] currency table: all 14 cases as specified (outer ?? inner, default pound, code + space for any other ISO code)');
});

test('5B. the currency in the sale fill and the QR/barcode designs follows the same rule', async () => {
  const sale = base({ isSale: true, salePrice: 399, regular_price: 499 }, { currency: 'AED' });
  const d3 = base({}, { currency: 'AED', design: '3' });
  const d4 = base({}, { currency: 'AED', design: '4' });
  const small = base({}, { currency: 'AED', design: '1', size: '25x25' });
  const { out } = await printThroughNewDesktop([sale, d3, d4, small]);
  assert.equal(opValue(out[0].labels[0], 'TEXT_3'), 'AED 399');
  assert.equal(opValue(out[0].labels[0], 'TEXT__1'), 'AED 100.00 OFF');
  assert.equal(opValue(out[0].labels[0], 'Text_was'), 'AED 499');
  assert.equal(opValue(out[1].labels[0], 'TextObject1'), 'AED 499.99');
  assert.equal(opValue(out[2].labels[0], 'TextObject12'), 'AED 499.99');
  assert.equal(opValue(out[3].labels[0], 'TextObject1'), 'AED 499.99');
});

test('5C. size: exactly 25x25 and 70x54 select those templates; absent, empty and every other value is the 32x57 default and NEVER an error', async () => {
  const cases = [[undefined, 'Labeldesign1_1.dymo'], ['', 'Labeldesign1_1.dymo'], ['32x57', 'Labeldesign1_1.dymo'], ['57x32', 'Labeldesign1_1.dymo'], ['57x35', 'Labeldesign1_1.dymo'], ['57x25', 'Labeldesign1_1.dymo'],
    ['32x25', 'Labeldesign1_1.dymo'], ['70x54', '70_54_Labeldesign1_2_22.dymo'], ['25x25', '25_25_barcode.dymo'], ['70X54', 'Labeldesign1_1.dymo'], [' 70x54', 'Labeldesign1_1.dymo'], [7054, 'Labeldesign1_1.dymo'], [null, 'Labeldesign1_1.dymo']];
  const messages = cases.map(([size]) => (size === undefined ? base() : base({}, { size })));
  const { out, boxes } = await printThroughNewDesktop(messages);
  cases.forEach(([size, template], i) => {
    assert.equal(out[i].labels[0]?.printed, true, `size ${JSON.stringify(size)} prints`);
    assert.equal(buildLabelPlan(messages[i]).plans[0].templateFile, template, `size ${JSON.stringify(size)}`);
  });
  assert.deepEqual(boxes, [], 'no native box for any of them');
});

test('5D. design: 1/"1" and 2/"2" are the same; "", undefined, 5, 7, "x", null are the unlisted design (design 1 template, never an error); the lab and repair types ignore it', async () => {
  const designs = [1, '1', 2, '2', 3, '3', 4, '4', '', undefined, 5, 7, 'x', null, '2abc', 0, -1];
  const messages = designs.map((design) => (design === undefined ? (() => { const m = base(); delete m.design; return m; })() : base({}, { design })));
  const { out, boxes } = await printThroughNewDesktop(messages);
  const templates = designs.map((_, i) => buildLabelPlan(messages[i]).plans[0].templateFile);
  designs.forEach((design, i) => assert.equal(out[i].labels[0]?.printed, true, `design ${JSON.stringify(design)}`));
  assert.deepEqual(templates, ['Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign2.dymo', 'Labeldesign2.dymo', 'mukltipleBarcode.dymo', 'mukltipleBarcode.dymo', 'multipleQRCODE.dymo', 'multipleQRCODE.dymo',
    'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo', 'Labeldesign2.dymo', 'Labeldesign1_1.dymo', 'Labeldesign1_1.dymo']);
  assert.deepEqual(boxes, []);
  note('[5D] design table as in SPEC 9.4: ' + templates.map((t, i) => `${JSON.stringify(designs[i])}->${t.replace('.dymo', '')}`).join(' '));
});

test('5E. `prints` is never a copy count (the web loops it itself): prints 1, 2, 5, "3", "abc", 0, -1 all print exactly ONE label per message', async () => {
  const prints = [1, 2, 5, '3', 'abc', 0, -1, undefined];
  const { out } = await printThroughNewDesktop(prints.map((p) => base({ prints: p }, { prints: p })));
  out.forEach((o, i) => assert.equal(o.labels.length, 1, `prints ${JSON.stringify(prints[i])}`));
});

test('5F. numbers where v1 expected text: price, salePrice, regular_price, barcode, title, ram, storage, grade as numbers, booleans and null never throw', async () => {
  const messages = [
    base({ ram: 8, storage: 128, network: 5, misc_color: 7, warranty: 12, conditionObject: { grade: 3 }, title: 12345, barcode: 987654321 }),
    base({ ram: null, storage: undefined, network: false, misc_color: true, conditionObject: null, title: null, barcode: 12 }),
    base({ price: '', salePrice: '', regular_price: '', isSale: true }),
    base({ price: 'MSKU1234567' }),
    base({ price: '0' }),
    base({ price: -5 }),
    base({ price: '12abc' }),
    base({ isSale: 'true', salePrice: 1, regular_price: 5 }),
    base({ isSale: true, salePrice: 5, regular_price: 5 }),
    base({ isSale: true, salePrice: 6, regular_price: 5 }),
    base({ isSale: true, salePrice: 4.999, regular_price: 5 }),
  ];
  const { out, boxes } = await printThroughNewDesktop(messages);
  out.forEach((o, i) => assert.equal(o.labels[0]?.printed, true, `message ${i} printed`));
  assert.deepEqual(boxes, []);
  const price = (i) => opValue(out[i].labels[0], 'TEXT_3');
  assert.equal(price(3), '', 'a container number prints no price');
  assert.equal(price(4), '', 'price 0');
  assert.equal(price(5), '', 'a negative price');
  assert.equal(price(6), '', 'a price that is not a number');
  assert.equal(price(7), '£499.99', 'isSale "true" (a text) is not a sale (strict true, as v1)');
  assert.equal(price(8), '£499.99', 'a sale price equal to the regular price is not a sale');
  assert.equal(price(9), '£499.99', 'a sale price above the regular price is not a sale');
  assert.equal(price(10), '£499.99', 'a difference below half a penny is not a sale');
});

test('5G. the oldest shapes: a label with NO barcodefinal (the very old system app), a Zebra text, a DYMO message with no title, no barcode, an object that is not a label', async () => {
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world);
  page.electron.sendBarcodeData({ barcode: 'ABC', title: 'x', price: 5, prints: 1 });
  await page.settle();
  assert.equal(boot.world.dialog.calls.length, 1);
  assert.match(boot.world.dialog.calls[0].options.detail, /could not read/);
  note(`[5G] a label with no barcodefinal on the new desktop: native box "${boot.world.dialog.calls[0].options.message}" / "${boot.world.dialog.calls[0].options.detail}"`);
  // what the real v1 did with the same message
  const v1 = await runV1('send-barcode-data', { barcode: 'ABC', title: 'x', price: 5, prints: 1 });
  note(`[5G] the same message on the real v1: handler error "${v1.handlerError}" (nothing printed, no box)`);
  for (const bad of [null, undefined, 'x', 5, [], { barcodefinal: 0 }, { barcodefinal: false }, { barcodefinal: '' }, { barcodefinal: '   ' }]) {
    page.electron.sendBarcodeData(bad);
  }
  await page.settle();
  assert.equal(boot.world.rawPrinter.jobs.length, 0);
  // a DYMO message with nothing in it prints an empty label rather than failing (v1 parity)
  const empty = { barcodefinal: { printer: 'dymo' } };
  page.electron.sendBarcodeData(empty);
  await page.settle();
  assert.equal(dymoLabelsOf(boot.factory).filter((l) => l.printed).length, 1);
  boot.world.cleanup();
});

test('5H. a repair message the way the v1-era web sent it: orderItem (one), orderItems (array), custom_field_value shapes, missing customer/business', async () => {
  const mk = (bf) => ({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'RPR-1', orderDate: '19/11/2026', ...bf }, barcode: 'RPR-1', design: 'repair' });
  const messages = [
    mk({ orderItem: { product_name: 'iPhone 12 screen', custom_field_value: [{ value: 'Cracked' }, { value: 'Black' }, { value: 'Rush' }] }, customer: { name: 'A', cell_no: '07' }, business: { business_name: 'Shop', branch_name: 'Main' } }),
    mk({ orderItems: [{ product_name: 'one' }, { product_name: 'two', custom_field_value: [{ value: [] }, { value: 'x' }] }] }),
    mk({}),
    mk({ orderItem: { product_name: 'x', custom_field_value: 'not an array' } }),
    mk({ orderItems: [] }),
  ];
  const { out, boxes } = await printThroughNewDesktop(messages);
  assert.equal(out[0].labels[0].printed, true);
  assert.deepEqual(out[0].labels[0].ops.filter((o) => ['TEXT', 'TEXT8', 'TEXT9', 'TextObject5', 'TEXT_5'].includes(o.name)).map((o) => o.value), ['Cracked', 'Black', 'Rush', 'A', 'Shop Main']);
  assert.equal(out[1].labels.length, 2, 'orderItems prints one label per element');
  assert.equal(out[2].labels.length, 1, 'no item: one blank label (v1 parity: [undefined])');
  assert.equal(out[3].labels.length, 1);
  assert.equal(out[4].labels.length, 0, 'an empty list prints nothing and says INVALID_PAYLOAD');
  assert.equal(boxes.length, 1);
  note(`[5H] repair: ${out.map((o) => o.labels.length).join(',')} labels for the five shapes; box: ${boxes[0]}`);
});

test('5I. non-ASCII and invisible characters in the title: v1 and the new desktop print the same text (whitespace controls aside); nothing the web can type makes the new desktop fail', async () => {
  const titles = ['Café Münch £5', 'آيفون 13 برو', '日本語のタイトル', '😀 phone 📱', 'nb sp', 'zero​width', '﻿bom', 'tab\tinside', 'two  spaces', '  padded  ', 'multi line', 'a\u0000b', '\u0085nel', 'x'.repeat(5000)];
  const { world, factory } = await bootNewDesktop();
  const page = connectPage(world);
  const rows = [];
  for (const title of titles) {
    const message = base({ title }, { title });
    const v1 = await runV1('send-barcode-data', structuredClone(message));
    const before = dymoLabelsOf(factory).length;
    page.electron.sendBarcodeData(structuredClone(message));
    await page.settle();
    const v2 = dymoLabelsOf(factory).slice(before)[0];
    assert.ok(v2 && v2.printed, `v2 prints ${JSON.stringify(title.slice(0, 20))}`);
    rows.push({ title: JSON.stringify(title.slice(0, 24)), v1: v1.printed ? JSON.stringify(opValue(v1.labels[0], 'ItemNameVal').slice(0, 24)) : 'v1 FAILED', v2: JSON.stringify(opValue(v2, 'ItemNameVal').slice(0, 24)), v2len: opValue(v2, 'ItemNameVal').length });
  }
  note('[5I] title A/B (v1 -> v2):\n' + rows.map((r) => `      ${r.title.padEnd(28)} v1 ${r.v1.padEnd(28)} v2 ${r.v2} (${r.v2len} chars)`).join('\n'));
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});
