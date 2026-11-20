'use strict';

/**
 * Hostile strings (SPEC 16): `MacBook Air 13" M1`, a newline, a backslash, a backtick, `${x}`, `</script>`, U+2028, `$&`,
 * very long text and more, put in EVERY text field of every kind of label and in the printer name. For each one:
 *  - the generated script parses (new vm.Script),
 *  - the fake framework receives the text exactly as typed, apart from the documented cleanup (line breaks and tabs become
 *    a space, control characters go, text is cut to 2 KB). Every expected value below is written out, not computed by the
 *    code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { v2Ops, createFakeDymo, createWindowFactory, summarizeCalls, LABELS_DIR } = require('../helpers/vm-dymo');
const { createManualClock } = require('../helpers/fake-electron');
const { createDymoService } = require('../../src/main/printing/dymo/index');
const { buildPrintScript, prepareLabelXml } = require('../../src/main/printing/dymo/script');

const code = (...points) => String.fromCharCode(...points);
const LS = code(0x2028);
const PS = code(0x2029);
const NUL = code(0);
const BEL = code(7);

/** input: what the cashier's data contains. expected: what must reach the label (cleaned, not yet cut to 2 KB). */
const HOSTILE = [
  { label: 'double quote', input: 'MacBook Air 13" M1', expected: 'MacBook Air 13" M1' },
  { label: 'single quote', input: "O'Brien's phone", expected: "O'Brien's phone" },
  { label: 'newline', input: 'line1\nline2', expected: 'line1 line2' },
  { label: 'carriage return and line feed', input: 'line1\r\nline2', expected: 'line1 line2' },
  { label: 'tab', input: 'a\tb', expected: 'a b' },
  { label: 'backslash', input: 'C:\\temp\\new', expected: 'C:\\temp\\new' },
  { label: 'trailing backslash', input: 'ends with \\', expected: 'ends with \\' },
  { label: 'backtick', input: 'a`b`', expected: 'a`b`' },
  { label: 'template placeholder', input: '${x}', expected: '${x}' },
  { label: 'template placeholder with code', input: '${process.exit(1)} `${1+1}`', expected: '${process.exit(1)} `${1+1}`' },
  { label: 'closing script tag', input: '</script><script>alert(1)</script>', expected: '</script><script>alert(1)</script>' },
  { label: 'line separator U+2028', input: `a${LS}b`, expected: 'a b' },
  { label: 'paragraph separator U+2029', input: `a${PS}b`, expected: 'a b' },
  { label: 'replacement patterns', input: "$& $1 $$ $` $'", expected: "$& $1 $$ $` $'" },
  { label: 'script injection', input: '"); throw new Error("x"); ("', expected: '"); throw new Error("x"); ("' },
  { label: 'closing the function', input: "');}());(function(){('", expected: "');}());(function(){('" },
  { label: 'html comment and cdata end', input: '<!-- x --> ]]>', expected: '<!-- x --> ]]>' },
  { label: 'xml characters', input: '<a href="x">&amp; &lt; &</a>', expected: '<a href="x">&amp; &lt; &</a>' },
  { label: 'unicode', input: 'Café 日本語 \u{1F600} £5', expected: 'Café 日本語 \u{1F600} £5' },
  { label: 'NUL and BEL', input: `a${NUL}b${BEL}c`, expected: 'abc' },
  { label: 'lone surrogate', input: `a${code(0xd800)}b`, expected: 'ab' },
  { label: 'blanks around', input: '  padded   text  ', expected: 'padded text' },
  { label: 'very long text', input: 'x'.repeat(5000), expected: 'x'.repeat(5000) },
];

const cut = (text) => text.slice(0, 2048); // every hostile text is ASCII or short: 2 KB is 2048 characters here
const mask = (text) => (text.length <= 6 ? text : '*'.repeat(text.length - 6) + text.slice(-6));
const short = (text) => (text.length > 6 ? `**${text.slice(-6)}` : text);

/** Values of the observed ops of one label by kind and name. */
const valueOf = (result, kind, name) => result.ops.find((op) => op.kind === kind && op.name === name)?.value;

function check(payload, expectations, label) {
  const result = v2Ops(payload);
  assert.equal(result.printed, true, `${label}: the label must print (${result.error})`);
  assert.ok(result.outcomes.every((outcome) => outcome.ok === true), `${label}: every script answers ok`);
  for (const script of result.scripts) assert.doesNotThrow(() => new vm.Script(script), `${label}: the script parses`);
  for (const [kind, name, expected] of expectations) assert.equal(valueOf(result, kind, name), expected, `${label}: ${kind} ${name}`);
  return result;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Fields                                                                                                      */
/* ---------------------------------------------------------------------------------------------------------- */

const product = (extra) => ({ printer: 'dymo', title: 'T', barcode: '1234567890', price: '5', isSale: false, ...extra });

/**
 * One entry per (label kind, field): build(value) makes the payload, expects(clean) lists [kind, objectName, expectedValue].
 * `clean` is the cleaned hostile text (before the 2 KB cut).
 */
const FIELDS = [
  // design 1
  { name: 'title (design 1)', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ title: v }) }), expects: (c) => [['text', 'ItemNameVal', cut(c)]] },
  { name: 'barcode (design 1)', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ barcode: v }) }), expects: (c) => [['text', 'BARCODE', cut(c)], ['text', 'TextObject1', mask(cut(c))]] },
  { name: 'storage', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ storage: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'network', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ network: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'ram', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ ram: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'colour', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ misc_color: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'processor (Processor)', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ Processor: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'processor (lower case key)', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ processor: v }) }), expects: (c) => [['text', 'TEXT_4', cut(c).toUpperCase()]] },
  { name: 'processor raw in the final else', build: (v) => ({ size: '32x57', design: '', barcodefinal: product({ Processor: v }) }), expects: (c) => [['text', 'TEXT__1', cut(c)]] },
  { name: 'condition grade', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ conditionObject: { grade: v } }) }), expects: (c) => [['text', 'TEXT_4', cut(`GRADE ${c}`).toUpperCase()]] },
  { name: 'warranty', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ warranty: `W ${v}` }) }), expects: (c) => [['text', 'TextObject11', cut(`W ${c} WARRANTY`).toUpperCase()]] },
  // sale
  { name: 'title (design 1 on sale)', build: (v) => ({ size: '32x57', design: '1', barcodefinal: product({ title: v, isSale: true, salePrice: '8', regular_price: '10' }) }), expects: (c) => [['text', 'ItemNameVal', cut(c)], ['text', 'TEXT_3', '£8'], ['text', 'TEXT__1', '£2.00 OFF'], ['text', 'Text_was', '£10']] },
  // design 2 (QR written into the XML) and 7
  { name: 'barcode (design 2, QR in the XML)', build: (v) => ({ size: '32x57', design: '2', barcodefinal: product({ barcode: v }) }), expects: (c) => [['qr-embed', 'QRCodeObject0', cut(c)], ['text', 'Text_barcode', mask(cut(c))]] },
  { name: 'barcode (design 7 = 2 on sale)', build: (v) => ({ size: '70x54', design: '2', barcodefinal: product({ barcode: v, isSale: true, salePrice: '8', regular_price: '10' }) }), expects: (c) => [['qr-embed', 'QRCodeObject0', cut(c)], ['text', 'Text_barcode', mask(cut(c))]] },
  { name: 'title (design 2)', build: (v) => ({ size: '32x57', design: '2', barcodefinal: product({ title: v }) }), expects: (c) => [['text', 'ItemNameVal', cut(c)]] },
  // design 3 and 4
  { name: 'barcode (design 3)', build: (v) => ({ size: '32x57', design: '3', barcodefinal: product({ barcode: v }) }), expects: (c) => [['text', 'BarcodeObject0', cut(c)], ['text', 'BarcodeObject1', cut(c)]] },
  { name: 'barcode (design 4, three QR codes)', build: (v) => ({ size: '70x54', design: '4', barcodefinal: product({ barcode: v }) }), expects: (c) => [['qr', 'QRCodeObject0', cut(c)], ['qr', 'QRCodeObject1', cut(c)], ['qr', 'QRCodeObject2', cut(c)], ['text', 'TextObject3', short(cut(c))], ['text', 'TextObject5', short(cut(c))]] },
  // 25x25
  { name: 'barcode (25x25 barcode label)', build: (v) => ({ size: '25x25', design: '1', barcodefinal: product({ barcode: v }) }), expects: (c) => [['text', 'BarcodeObject0', cut(c)]] },
  { name: 'barcode (25x25 QR label)', build: (v) => ({ size: '25x25', design: '2', barcodefinal: product({ barcode: v }) }), expects: (c) => [['qr', 'QRCodeObject2', cut(c)], ['text', 'TextObject3', short(cut(c))]] },
  // lab (OUTER barcode and title)
  { name: 'lab barcode', build: (v) => ({ type: 'lab', size: '32x57', design: '1', barcode: v, title: 'Screen', barcodefinal: { printer: 'dymo' } }), expects: (c) => [['text', 'BarcodeObject1', cut(c)]] },
  { name: 'lab title', build: (v) => ({ type: 'lab', size: '32x57', design: '1', barcode: '636400', title: v, barcodefinal: { printer: 'dymo' } }), expects: (c) => [['text', 'TextObject12', cut(c)]] },
];

const repairBase = (extra, item = {}) => ({
  barcodefinal: {
    printer: 'dymo',
    design: 'repair',
    barcode: 'R-1042',
    orderDate: '2026-11-19',
    customer: { name: 'Jo', cell_no: '0700' },
    business: { business_name: 'Shop', branch_name: 'Main' },
    orderItem: { product_name: 'Phone', ...item },
    ...extra,
  },
});

const REPAIR_FIELDS = [
  { name: 'repair item name', build: (v) => repairBase({}, { product_name: v }), expects: (c) => [['text', 'ItemNameVal', cut(c)]] },
  { name: 'repair custom field 1', build: (v) => repairBase({}, { custom_field_value: [{ value: v }] }), expects: (c) => [['text', 'TEXT', cut(c)]] },
  { name: 'repair custom field 2', build: (v) => repairBase({}, { custom_field_value: [{ value: 'a' }, { value: v }] }), expects: (c) => [['text', 'TEXT8', cut(c)]] },
  { name: 'repair custom field 3', build: (v) => repairBase({}, { custom_field_value: [{ value: 'a' }, { value: 'b' }, { value: v }] }), expects: (c) => [['text', 'TEXT9', cut(c)]] },
  { name: 'repair customer name', build: (v) => repairBase({ customer: { name: v, cell_no: '0700' } }), expects: (c) => [['text', 'TextObject5', cut(c)]] },
  { name: 'repair customer phone', build: (v) => repairBase({ customer: { name: 'Jo', cell_no: v } }), expects: (c) => [['text', 'TextObject6', cut(c)]] },
  { name: 'repair business name', build: (v) => repairBase({ business: { business_name: v, branch_name: 'Main' } }), expects: (c) => [['text', 'TEXT_5', cut(`${c} Main`)]] },
  { name: 'repair branch name', build: (v) => repairBase({ business: { business_name: 'Shop', branch_name: v } }), expects: (c) => [['text', 'TEXT_5', cut(`Shop ${c}`)]] },
  { name: 'repair date', build: (v) => repairBase({ orderDate: v }), expects: (c) => [['text', 'TextObject1', cut(c)]] },
  { name: 'repair barcode (printed and as QR)', build: (v) => repairBase({ barcode: v }), expects: (c) => [['text', 'TEXT4', cut(c)], ['qr', 'QRCodeObject0', cut(c)]] },
];

for (const field of [...FIELDS, ...REPAIR_FIELDS]) {
  test(`hostile strings in ${field.name}: the script parses and the framework receives the exact text`, () => {
    // the ops a benign value produces: a hostile value must not add, drop or reorder any of them
    const benign = v2Ops(field.build('benign'));
    for (const { label, input, expected } of HOSTILE) {
      const result = check(field.build(input), field.expects(expected), `${field.name} / ${label}`);
      assert.deepEqual(
        result.ops.map((op) => `${op.kind}:${op.name}`),
        benign.ops.map((op) => `${op.kind}:${op.name}`),
        `${field.name} / ${label}: same operations as for a benign value`
      );
      assert.equal(result.template, benign.template);
    }
  });
}

test('hostile strings in the price fields: text that is not a number prints no price; numbers with blanks and line breaks print cleaned', () => {
  for (const { label, input } of HOSTILE) {
    const result = check({ size: '32x57', design: '1', barcodefinal: product({ price: input }) }, [['text', 'TEXT_3', '']], `price / ${label}`);
    assert.equal(result.printed, true);
  }
  for (const [input, expected] of [['12.5\n', '£12.5'], ['\n7', '£7'], [`7${LS}`, '£7'], [`${PS}7.25${PS}`, '£7.25'], ['\t 3 ', '£3'], ['1e1', '£1e1']]) {
    check({ size: '32x57', design: '1', barcodefinal: product({ price: input }) }, [['text', 'TEXT_3', expected]], `price ${JSON.stringify(input)}`);
  }
  const sale = (salePrice, regular) => ({ size: '32x57', design: '1', barcodefinal: product({ isSale: true, salePrice, regular_price: regular }) });
  check(sale('\t80 ', '100\n'), [['text', 'TEXT_3', '£80'], ['text', 'Text_was', '£100'], ['text', 'TEXT__1', '£20.00 OFF']], 'sale prices with blanks');
  for (const { label, input } of HOSTILE) {
    check(sale(input, '100'), [], `salePrice / ${label}`); // not a number: no sale, the plain label prints
    check(sale('80', input), [], `regular_price / ${label}`);
  }
});

test('hostile strings as currency, size and design: the defaults apply and the script parses', () => {
  for (const { label, input } of HOSTILE) {
    check({ size: '32x57', design: '1', currency: input, barcodefinal: product({}) }, [['text', 'TEXT_3', '£5']], `currency / ${label}`);
    check({ size: input, design: '1', barcodefinal: product({}) }, [['text', 'TEXT_3', '£5']], `size / ${label}`);
    check({ size: '32x57', design: input, barcodefinal: product({}) }, [['text', 'TEXT_3', '£5']], `design / ${label}`);
  }
});

test('every field hostile at once, on every kind of label: it parses and prints', () => {
  const all = (value) => ({
    printer: 'dymo',
    title: value,
    barcode: value,
    storage: value,
    network: value,
    ram: value,
    misc_color: value,
    warranty: `W ${value}`,
    conditionObject: { grade: value },
    Processor: value,
    price: '5',
    salePrice: '8',
    regular_price: '10',
    isSale: true,
    currency: value,
  });
  for (const { label, input } of HOSTILE) {
    for (const [size, design] of [['32x57', '1'], ['32x57', '2'], ['32x57', '3'], ['32x57', '4'], ['70x54', '1'], ['70x54', '2'], ['70x54', ''], ['25x25', '1'], ['25x25', '2']]) {
      check({ size, design, barcodefinal: all(input) }, [], `all fields / ${label} / ${size} ${design}`);
    }
    check(repairBase({ barcode: input, orderDate: input, customer: { name: input, cell_no: input }, business: { business_name: input, branch_name: input }, orderItems: [{ product_name: input, custom_field_value: [{ value: input }, { value: input }, { value: input }] }, { product_name: input }] }), [], `repair / ${label}`);
    check({ type: 'lab', size: '32x57', design: '1', barcode: input, title: input, barcodefinal: { printer: 'dymo' } }, [], `lab / ${label}`);
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Printer name                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

const PRINTER_NAMES = HOSTILE.filter(({ input }) => input.trim() !== '' && !/^\d+$/.test(input)).map(({ label, input }) => ({ label, name: input }));

test('hostile strings as the printer name: the script parses and the framework prints on exactly that name', () => {
  for (const { label, name } of PRINTER_NAMES) {
    const result = v2Ops({ size: '32x57', design: '1', barcodefinal: product({}) }, { printers: [{ name }] });
    assert.equal(result.printed, true, `${label}: ${result.error}`);
    assert.equal(result.printer, name, label);
    for (const script of result.scripts) assert.doesNotThrow(() => new vm.Script(script), label);
  }
});

test('hostile strings as the printer name, through the whole service', async () => {
  const xml = fs.readFileSync(`${LABELS_DIR}/Labeldesign1_1.dymo`, 'utf8');
  for (const { label, name } of PRINTER_NAMES) {
    const factory = createWindowFactory({ dymo: { printers: [{ name }] } });
    const service = createDymoService({ createHiddenWindow: factory.createHiddenWindow, labelsDir: LABELS_DIR, readFile: async () => xml, timers: createManualClock() });
    assert.deepEqual(await service.print({ size: '32x57', design: '1', barcodefinal: product({ title: label }) }), { ok: true }, label);
    assert.equal(summarizeCalls(factory.windows[0].fake.calls)[0].printer, name, label);
  }
});

test('hostile strings inside the label XML itself (an odd template) do not break the script', () => {
  const fake = createFakeDymo();
  const odd = prepareLabelXml(fs.readFileSync(`${LABELS_DIR}/Labeldesign1_1.dymo`, 'utf8')).replace('<Description>DYMO Label</Description>', `<Description><![CDATA[${'"`${x}\\'.repeat(3)}</script>]]></Description>`);
  const script = buildPrintScript({ labelXml: odd, ops: [{ kind: 'text', name: 'ItemNameVal', value: 'ok' }], printerName: 'DYMO LabelWriter 450' });
  assert.doesNotThrow(() => new vm.Script(script));
  assert.deepEqual(JSON.parse(fake.run(script)), { ok: true });
});

test('the cleaned values reach the framework as plain strings, never as code: nothing a hostile value says is ever evaluated', () => {
  // a global the hostile text would set if it were ever executed
  const fake = createFakeDymo();
  fake.context.__evil = 0;
  const value = '"); __evil = 1; ("' + "');__evil = 2;('" + '`${__evil = 3}`' + '${__evil = 4}';
  const script = buildPrintScript({
    labelXml: prepareLabelXml(fs.readFileSync(`${LABELS_DIR}/Labeldesign1_1.dymo`, 'utf8')),
    ops: [{ kind: 'text', name: 'ItemNameVal', value }, { kind: 'text', name: 'TEXT_3', value }],
    printerName: value,
  });
  const printers = [{ name: value }];
  fake.setPrinters(printers);
  assert.deepEqual(JSON.parse(fake.run(script)), { ok: true });
  assert.equal(fake.context.__evil, 0);
  assert.equal(summarizeCalls(fake.calls)[0].ops[0].value, value);
});
