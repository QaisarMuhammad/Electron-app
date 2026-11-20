'use strict';

/**
 * Golden tests: the REAL v1.6.1 `send-barcode-data` handler (tests/fixtures/legacy-index.js, run by the harness in
 * tests/helpers/vm-dymo.js against a fake hidden window and a fake DYMO framework) versus the v2 plan + script.
 *
 * Comparison level (SPEC 16): the template file, the printer, and per label the ordered (object name, text) pairs, the QR
 * (object name, text) pairs and the state of the QR objects at print time. XML-level equality is not claimed.
 *
 * Every deliberate difference (SPEC 9.4 (a)-(e), plus the two clarifications named below) has its own test that asserts
 * BOTH sides: what v1 did and what v2 does. Nothing is skipped.
 *   (a) currency symbol from the currency code          (c) empty condition prints no "GRADE " entry
 *   (b) processor read from `Processor ?? processor`     (d) every value is cleaned and carried as data
 *   (e) an unlisted design with a sale, and at 70x54
 *   (f) a design number 7 sent directly is unlisted (v1 never printed it)
 *   (g) a repair message with no items answers INVALID_PAYLOAD (v1 printed nothing, silently)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { goldenOps, v2Ops, createFakeDymo, DEFAULT_PRINTER } = require('../helpers/vm-dymo');
const { buildLabelPlan, LabelPayloadError } = require('../../src/main/printing/dymo/plan');

const POUND = '£';

/** What the comparison looks at. */
const observed = (result) => ({
  template: result.template,
  printer: result.printer,
  labels: result.labels.map(({ ops, printed, qr }) => ({ ops, printed, qr })),
});

const textOf = (result, name) => result.ops.find((op) => op.name === name && op.kind === 'text')?.value;

/* ---------------------------------------------------------------------------------------------------------- */
/* Payload builders                                                                                            */
/* ---------------------------------------------------------------------------------------------------------- */

const FULL = {
  title: 'iPhone 13 128GB',
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
};
const { conditionObject: _omitted, ...FULL_WITHOUT_CONDITION } = FULL;

/** Field sets: with a condition, with few fields, without a condition, and a bare barcode (BarcodePDFGenerator's single-barcode path). */
const FIELD_SETS = {
  full: FULL,
  minimal: { title: 'Case', barcode: '12345', conditionObject: { grade: 'New' }, price: '9.99', salePrice: '7.99', regular_price: '9.99' },
  noCondition: FULL_WITHOUT_CONDITION,
  bare: { barcode: '9780201633610' },
};
const HAS_CONDITION = { full: true, minimal: true, noCondition: false, bare: false };

const REPAIR = {
  design: 'repair',
  orderDate: '2026-11-19',
  customer: { name: 'Jo Smith', cell_no: '07123 456789' },
  business: { business_name: 'T&R Mobile', branch_name: 'Main' },
  orderItem: {
    product_name: 'iPhone 13 screen',
    custom_field_value: [{ field_label: 'Device', value: 'iPhone 13' }, { field_label: 'Job', value: 'Screen' }, { field_label: 'Remarks', value: 'Rush' }],
  },
};

function payloadOf({ size, design, fields, isSale = false, currency, currencyIn = 'outer', extraEnvelope = {} }) {
  const barcodefinal = { printer: 'dymo', ...fields, isSale };
  if (design === 'repair') Object.assign(barcodefinal, REPAIR);
  if (currency && currencyIn === 'inner') barcodefinal.currency = currency;
  const payload = { barcodefinal, design: design === 'repair' ? 'repair' : design, ...extraEnvelope };
  if (size !== undefined) payload.size = size;
  if (currency && currencyIn === 'outer') payload.currency = currency;
  return payload;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Harness self-check: the golden side is only useful if it really runs v1                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('the golden harness runs v1 for real: a design 1 label prints on the first printer with v1 values', async () => {
  const v1 = await goldenOps(payloadOf({ size: '32x57', design: '1', fields: FULL }));
  assert.equal(v1.handlerError, null);
  assert.equal(v1.template, 'Labeldesign1_1.dymo');
  assert.equal(v1.printer, DEFAULT_PRINTER.name);
  assert.equal(v1.printed, true);
  assert.equal(textOf(v1, 'TEXT_4'), 'LIKE NEW');
  assert.equal(textOf(v1, 'TEXT_3'), `${POUND}499.99`);
  assert.equal(textOf(v1, 'TextObject1'), '********123456');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The matrix                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------- */

const SIZES = ['32x57', '25x25', '70x54'];
const DESIGNS = [1, '1', 2, 3, 4, 'repair'];
const SPEC_SLOTS = ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'];

/** How many spec slots (TEXT_4, TEXT, TEXT_1, TEXT_5, TEXT__1) a label of this kind fills from the spec list. */
function specSlotCount(size, design, onSale) {
  if (size === '25x25') return 0;
  const key = String(design);
  if (key === 'repair' || key === '3' || key === '4') return 0;
  if (key === '2') return 5; // design 2, and design 7 (= design 2 on sale)
  if (key === '1') return onSale ? 4 : 5;
  return 4; // an unlisted design: v1's final else
}

const isSaleFor = (fields, isSale) => isSale && Number(fields.regular_price) - Number(fields.salePrice) > 0;

for (const size of SIZES) {
  for (const design of DESIGNS) {
    test(`golden matrix: ${size}, design ${JSON.stringify(design)}`, async () => {
      for (const [setName, fields] of Object.entries(FIELD_SETS)) {
        for (const isSale of [false, true]) {
          for (const currency of [undefined, 'GBP']) {
            const label = `${size} design ${JSON.stringify(design)} ${setName} isSale=${isSale} currency=${currency}`;
            const payload = payloadOf({ size, design, fields, isSale, currency });
            const v1 = await goldenOps(payload);
            const v2 = v2Ops(payload);
            assert.equal(v1.printed, true, `v1 must print in the matrix (${label}): ${v1.error}`);
            assert.equal(v2.printed, true, `v2 must print (${label}): ${v2.error}`);
            assert.equal(v1.printParams, undefined);

            if (HAS_CONDITION[setName] || specSlotCount(size, design, isSaleFor(fields, isSale)) === 0) {
              assert.deepEqual(observed(v2), observed(v1), `v2 differs from v1 (${label})`);
              continue;
            }
            // (c) no condition: v1 put a bare "GRADE " first and shifted every other spec by one. v2 has no such entry.
            const slots = specSlotCount(size, design, isSaleFor(fields, isSale));
            assert.equal(textOf(v1, 'TEXT_4'), 'GRADE ', `v1 printed a bare GRADE entry (${label})`);
            const others = [fields.storage, fields.network, fields.ram, fields.Processor, fields.misc_color].filter(Boolean).map((value) => value.toUpperCase());
            const expectedOps = v1.ops.map((op) => {
              const slot = SPEC_SLOTS.slice(0, slots).indexOf(op.name);
              return slot < 0 ? op : { ...op, value: others[slot] || '' };
            });
            assert.deepEqual(v2.ops, expectedOps, `v2 differs from v1 beyond the missing GRADE entry (${label})`);
            assert.equal(v2.template, v1.template, label);
            assert.equal(v2.printer, v1.printer, label);
            assert.deepEqual(v2.labels[0].qr, v1.labels[0].qr, label);
          }
        }
      }
    });
  }
}

test('golden matrix: currency in the envelope or in barcodefinal, GBP in any case, prints the same pound sign as v1', async () => {
  for (const payload of [
    payloadOf({ size: '32x57', design: '1', fields: FULL, currency: 'GBP', currencyIn: 'outer' }),
    payloadOf({ size: '32x57', design: '1', fields: FULL, currency: 'gbp', currencyIn: 'inner' }),
    payloadOf({ size: '70x54', design: '2', fields: FULL, isSale: true, currency: ' GBP ', currencyIn: 'outer' }),
    payloadOf({ size: '32x57', design: '4', fields: FULL, currency: '', currencyIn: 'outer' }),
    payloadOf({ size: '25x25', design: '2', fields: FULL, currency: 'pounds', currencyIn: 'outer' }),
  ]) {
    assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)));
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Same behaviour on odd but real input                                                                        */
/* ---------------------------------------------------------------------------------------------------------- */

test('sizes other than 25x25 and 70x54 are the 32x57 label in v1 and in v2 (no error)', async () => {
  for (const size of ['32x57', '57x32', '57x35', '', undefined, 'abc']) {
    const payload = payloadOf({ size, design: '1', fields: FULL });
    const v1 = await goldenOps(payload);
    assert.equal(v1.template, 'Labeldesign1_1.dymo');
    assert.deepEqual(observed(v2Ops(payload)), observed(v1), `size ${size}`);
  }
});

test('an empty layout choice (design "") with no sale: v2 equals v1 at 32x57 and 25x25', async () => {
  for (const design of ['', undefined]) {
    for (const size of ['32x57', '25x25']) {
      const payload = payloadOf({ size, design, fields: FIELD_SETS.minimal });
      assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)), `${size} design ${design}`);
    }
  }
});

test('BoxLabelPrint: a container number as the price prints no price, and size 57x32 is the 32x57 label', async () => {
  const fields = { title: 'Box 7', barcode: 'BOX0007', price: 'CNT-12', salePrice: undefined, regular_price: 'CNT-12', conditionObject: undefined };
  const payload = payloadOf({ size: '57x32', design: '1', fields, isSale: false });
  const v1 = await goldenOps(payload);
  assert.equal(textOf(v1, 'TEXT_3'), '');
  // v1 prints a bare GRADE entry here (no condition): only that differs
  const v2 = v2Ops(payload);
  assert.equal(textOf(v2, 'TEXT_3'), '');
  assert.equal(v2.template, v1.template);
  assert.equal(textOf(v2, 'ItemNameVal'), 'Box 7');
  assert.equal(textOf(v2, 'TEXT_4'), '');
});

test('numbers and strings for prices and design are the same to v1 and to v2', async () => {
  for (const [price, design] of [[12.5, 1], ['12.5', '1'], [12, '2'], ['0', 1], [0, 3], ['', 4], [-3, 1], [undefined, 3]]) {
    const payload = payloadOf({ size: '32x57', design, fields: { ...FULL, price }, isSale: false });
    assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)), `price ${JSON.stringify(price)} design ${design}`);
  }
});

test('a sale needs isSale === true and a positive difference; a sub-penny difference is no sale in v1 and v2', async () => {
  const cases = [
    { isSale: true, regular_price: 10, salePrice: 10 },
    { isSale: true, regular_price: 10, salePrice: 12 },
    { isSale: true, regular_price: 10, salePrice: 9.996 }, // 0.004: toFixed(2) gives "0.00", not a sale in v1
    { isSale: 'true', regular_price: 10, salePrice: 5 },
    { isSale: 1, regular_price: 10, salePrice: 5 },
    { isSale: true, regular_price: '10.50', salePrice: '8' },
    { isSale: true, regular_price: 10, salePrice: 9.994 },
    { isSale: true, regular_price: 10, salePrice: 9.99 },
  ];
  for (const sale of cases) {
    for (const design of ['1', '2']) {
      const payload = payloadOf({ size: '32x57', design, fields: { ...FULL, ...sale } });
      payload.barcodefinal.isSale = sale.isSale;
      assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)), `${JSON.stringify(sale)} design ${design}`);
    }
  }
});

test('warranty prints only above 3 characters, upper-cased, like v1', async () => {
  for (const warranty of ['', '1y', '3 M', '12 Months', 'Lifetime', undefined]) {
    const payload = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, warranty } });
    assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)), `warranty ${JSON.stringify(warranty)}`);
  }
});

test('lab item labels: template, outer barcode and title, at every size', async () => {
  for (const size of SIZES) {
    // the barcodefinal carries other values on purpose: for a lab label only the OUTER barcode and title are read
    const payload = { type: 'lab', size, design: '1', barcode: '636400', title: 'iphone 15 oled screen', price: '', prints: 3, barcodefinal: { printer: 'dymo', ...FULL, title: 'NOT THIS' } };
    const v1 = await goldenOps(payload);
    assert.equal(v1.template, 'labitemdesign.dymo');
    assert.deepEqual(v1.ops, [
      { kind: 'text', name: 'BarcodeObject1', value: '636400' },
      { kind: 'text', name: 'TextObject12', value: 'iphone 15 oled screen' },
    ]);
    assert.deepEqual(observed(v2Ops(payload)), observed(v1), size);
  }
});

test('the envelope is not merged into barcodefinal: an outer title or barcode never reaches a normal label', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: FULL, extraEnvelope: { title: 'OUTER TITLE', barcode: 'OUTER-BARCODE', price: 1, prints: 5 } });
  const v1 = await goldenOps(payload);
  assert.equal(textOf(v1, 'ItemNameVal'), 'iPhone 13 128GB');
  assert.deepEqual(observed(v2Ops(payload)), observed(v1));
});

test('`prints` is never a copy count: one message prints one label in v1 and in v2', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: FULL, extraEnvelope: { prints: 7 } });
  payload.barcodefinal.prints = 7;
  assert.equal((await goldenOps(payload)).labels.length, 1);
  assert.equal(v2Ops(payload).labels.length, 1);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Repair labels                                                                                               */
/* ---------------------------------------------------------------------------------------------------------- */

test('repair, one item or several: the same labels in the same order as v1 (LabeldesignRepair at 32x57 and 70x54)', async () => {
  const twoItems = {
    ...REPAIR.orderItem,
    product_name: 'iPad Air',
    custom_field_value: [{ value: 'Battery' }],
  };
  for (const size of ['32x57', '70x54', undefined]) {
    for (const variant of [
      { orderItem: REPAIR.orderItem },
      { orderItems: [REPAIR.orderItem, twoItems, { product_name: 'Watch' }] },
      { orderItem: undefined, orderItems: [twoItems] },
    ]) {
      const payload = payloadOf({ size, design: 'repair', fields: { barcode: 'R-1042' } });
      Object.assign(payload.barcodefinal, variant);
      const v1 = await goldenOps(payload);
      assert.equal(v1.template, 'LabeldesignRepair.dymo');
      assert.equal(v1.printed, true);
      const v2 = v2Ops(payload);
      assert.equal(v2.labels.length, v1.labels.length);
      assert.deepEqual(observed(v2), observed(v1), `size ${size} ${JSON.stringify(Object.keys(variant))}`);
    }
  }
});

test('repair custom fields: position kept, entries without text give a blank, a non-array gives three blanks (as v1)', async () => {
  const variants = [
    [],
    [{ value: 'A' }],
    [{ value: 'A' }, { value: '' }, { value: 'C' }],
    [{ value: undefined }, { value: 'B' }],
    [{ value: 5 }, { value: ['x', 'y'] }, { value: 'Z' }],
    [{ value: 'A' }, { value: 'B' }, { value: 'C' }, { value: 'D' }],
    'not an array',
    undefined,
  ];
  for (const custom of variants) {
    const payload = payloadOf({ size: '32x57', design: 'repair', fields: { barcode: 'R-1' } });
    payload.barcodefinal.orderItem = { product_name: 'Phone', custom_field_value: custom };
    assert.deepEqual(observed(v2Ops(payload)), observed(await goldenOps(payload)), JSON.stringify(custom));
  }
});

test('repair at 25x25 prints the 25x25 QR label like any design (v1 checks the size first)', async () => {
  const payload = payloadOf({ size: '25x25', design: 'repair', fields: { barcode: 'R-1042', price: 15 } });
  const v1 = await goldenOps(payload);
  assert.equal(v1.template, '25_25_qrcode.dymo');
  assert.deepEqual(observed(v2Ops(payload)), observed(v1));
});

test('repair with missing customer, business and date prints blanks like v1 (v1\'s one lone space in the business line is cleaned away, (d))', async () => {
  const payload = { size: '32x57', barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R-9', orderItem: { product_name: 'x' } } };
  const v1 = await goldenOps(payload);
  const v2 = v2Ops(payload);
  assert.equal(textOf(v1, 'TEXT_5'), ' ', 'v1 joins two empty names with a space');
  assert.deepEqual(
    v2.ops,
    v1.ops.map((op) => (op.name === 'TEXT_5' ? { ...op, value: '' } : op))
  );
  assert.equal(v2.template, v1.template);
  assert.equal(v2.printer, v1.printer);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (a) currency                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('(a) currency: v1 always wrote the pound sign; v2 writes the currency code (the web receipt and Zebra rule)', async () => {
  for (const [size, design, isSale] of [['32x57', '1', false], ['32x57', '1', true], ['70x54', '2', true], ['32x57', '3', false], ['32x57', '4', false], ['25x25', '1', false], ['25x25', '2', false]]) {
    const payload = payloadOf({ size, design, fields: FULL, isSale, currency: 'USD' });
    const v1 = await goldenOps(payload);
    const v2 = v2Ops(payload);
    const priced = v1.ops.filter((op) => op.value.includes(POUND));
    assert.ok(priced.length > 0, `${size} design ${design}: v1 prints a price`);
    // exactly the pound signs are replaced by "USD "; nothing else changes
    assert.deepEqual(v2.ops, v1.ops.map((op) => ({ ...op, value: op.value.replaceAll(POUND, 'USD ') })), `${size} design ${design} sale=${isSale}`);
    assert.equal(v2.template, v1.template);
  }
});

test('(a) currency: the envelope wins over barcodefinal; unusable codes keep the pound sign', async () => {
  const price = (payload) => textOf(v2Ops(payload), 'TEXT_3');
  const base = { size: '32x57', design: '1', fields: FULL };
  assert.equal(price(payloadOf({ ...base, currency: 'AED', currencyIn: 'outer' })), 'AED 499.99');
  assert.equal(price(payloadOf({ ...base, currency: 'aed', currencyIn: 'inner' })), 'AED 499.99');
  const both = payloadOf({ ...base, currency: 'EUR', currencyIn: 'outer' });
  both.barcodefinal.currency = 'AED';
  assert.equal(price(both), 'EUR 499.99');
  for (const unusable of ['$', 'pounds', '', '  ', 'US', 'USDX', 123, null]) {
    const payload = payloadOf({ ...base, currency: unusable, currencyIn: 'outer' });
    payload.currency = unusable;
    assert.equal(price(payload), `${POUND}499.99`, `currency ${JSON.stringify(unusable)}`);
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (b) processor key                                                                                           */
/* ---------------------------------------------------------------------------------------------------------- */

test('(b) processor: Quick Add sends `processor`; v1 only read `Processor`, v2 reads both', async () => {
  const { Processor, ...withoutProcessor } = FULL;
  for (const design of ['1', '2', '']) {
    const lower = payloadOf({ size: '32x57', design, fields: { ...withoutProcessor, processor: 'A15' } });
    const upper = payloadOf({ size: '32x57', design, fields: FULL });
    const v1Lower = await goldenOps(lower);
    const v1Upper = await goldenOps(upper);
    assert.ok(!JSON.stringify(v1Lower.ops).includes('A15'), `v1 ignores the lower-case key (design ${design})`);
    assert.ok(JSON.stringify(v1Upper.ops).includes('A15'));
    // v2 with the lower-case key prints exactly what v1 prints for the upper-case key
    assert.deepEqual(observed(v2Ops(lower)), observed(v1Upper), `design ${design}`);
    assert.deepEqual(observed(v2Ops(upper)), observed(v1Upper), `design ${design}`);
  }
});

test('(b) processor: `Processor` wins when both are given, and an empty `Processor` is a value (nullish rule, not falsy)', () => {
  const both = payloadOf({ size: '32x57', design: '', fields: { ...FULL, Processor: 'Upper', processor: 'lower' } });
  assert.equal(textOf(v2Ops(both), 'TEXT__1'), 'Upper');
  const emptyUpper = payloadOf({ size: '32x57', design: '', fields: { ...FULL, Processor: '', processor: 'lower' } });
  assert.equal(textOf(v2Ops(emptyUpper), 'TEXT__1'), '');
  const nullUpper = payloadOf({ size: '32x57', design: '', fields: { ...FULL, Processor: null, processor: 'lower' } });
  assert.equal(textOf(v2Ops(nullUpper), 'TEXT__1'), 'lower');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (c) empty condition                                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

test('(c) empty condition: v1 printed a bare "GRADE " and shifted the specs; v2 prints no entry, in every spec design', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: FIELD_SETS.noCondition });
  const v1 = await goldenOps(payload);
  const v2 = v2Ops(payload);
  assert.deepEqual(
    SPEC_SLOTS.map((slot) => textOf(v1, slot)),
    ['GRADE ', '128GB', 'UNLOCKED', '4GB', 'A15']
  );
  assert.deepEqual(
    SPEC_SLOTS.map((slot) => textOf(v2, slot)),
    ['128GB', 'UNLOCKED', '4GB', 'A15', 'BLUE']
  );
});

test('(c) an empty or blank grade is no entry; New and A+ and other grades print as before', () => {
  const slot = (grade) => textOf(v2Ops(payloadOf({ size: '32x57', design: '1', fields: { barcode: '1', conditionObject: { grade } } })), 'TEXT_4');
  assert.equal(slot(''), '');
  assert.equal(slot('   '), '');
  assert.equal(slot(undefined), '');
  assert.equal(slot('New'), 'NEW');
  assert.equal(slot('A+'), 'LIKE NEW');
  assert.equal(slot('B'), 'GRADE B');
  assert.equal(slot('Refurbished A'), 'GRADE REFURBISHED A');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (d) values are data                                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

test('(d) a double quote in the title: v1 printed nothing (its script broke), v2 prints the exact text', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, title: 'MacBook Air 13" M1' } });
  const v1 = await goldenOps(payload);
  assert.equal(v1.printed, false);
  assert.match(v1.error, /SyntaxError/);
  const v2 = v2Ops(payload);
  assert.equal(v2.printed, true);
  assert.equal(textOf(v2, 'ItemNameVal'), 'MacBook Air 13" M1');
});

test('(d) a line break in the title: v1 printed nothing, v2 prints it as a space', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, title: 'iPhone 13\n128GB' } });
  const v1 = await goldenOps(payload);
  assert.equal(v1.printed, false);
  assert.equal(textOf(v2Ops(payload), 'ItemNameVal'), 'iPhone 13 128GB');
});

test('(d) a backslash: v1 turned it into an escape sequence, v2 prints it', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, title: 'Case C:\\temp' } });
  const v1 = await goldenOps(payload);
  assert.equal(textOf(v1, 'ItemNameVal'), 'Case C:' + String.fromCharCode(9) + 'emp', 'v1: \\t became a TAB');
  assert.equal(textOf(v2Ops(payload), 'ItemNameVal'), 'Case C:\\temp');
});

test('(d) a backtick and ${}: v1 broke the label (or ran the text as code), v2 prints them', async () => {
  const backtick = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, title: 'Phone `pro`' } });
  assert.equal(textOf(await goldenOps(backtick), 'ItemNameVal'), 'Phone `pro`', 'v1 handled a backtick in the title only because it is inside a double-quoted string');
  const placeholder = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, title: 'Cost ${1+1}' } });
  assert.equal(textOf(v2Ops(placeholder), 'ItemNameVal'), 'Cost ${1+1}');
});

test('(d) null and undefined values: v1 printed the words "null" and "undefined" where it could, v2 prints nothing', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: { ...FULL, salePrice: null, regular_price: 10 }, isSale: true });
  const v1 = await goldenOps(payload);
  assert.equal(textOf(v1, 'TEXT_3'), `${POUND}null`);
  assert.equal(textOf(v2Ops(payload), 'TEXT_3'), POUND);
});

test('(d) text is cleaned: a trailing blank of the repair business line and runs of spaces are removed', async () => {
  const payload = { size: '32x57', barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R-9', business: { business_name: 'T&R Mobile', branch_name: '' }, orderItem: { product_name: 'Phone   case' } } };
  const v1 = await goldenOps(payload);
  const v2 = v2Ops(payload);
  assert.equal(textOf(v1, 'TEXT_5'), 'T&R Mobile ');
  assert.equal(textOf(v2, 'TEXT_5'), 'T&R Mobile');
  assert.equal(textOf(v1, 'ItemNameVal'), 'Phone   case');
  assert.equal(textOf(v2, 'ItemNameVal'), 'Phone case');
});

test('(d) the QR text of designs 2 and 7: a "$&" or "&" or "<" in the barcode corrupted v1\'s label XML; v2 writes it exactly', async () => {
  for (const barcode of ['A$&B', 'A$1B', 'A&B', 'A<B>', 'A$$B']) {
    const payload = payloadOf({ size: '32x57', design: '2', fields: { ...FULL, barcode }, isSale: false });
    const v1 = await goldenOps(payload);
    const v2 = v2Ops(payload);
    assert.equal(v2.printed, true, barcode);
    const embed = v2.ops.find((op) => op.kind === 'qr-embed');
    assert.equal(embed.value, barcode, 'the QR carries the barcode exactly');
    assert.equal(v2.labels[0].embeds[0].data, barcode);
    assert.equal(v2.labels[0].embeds[0].holder, barcode, 'DataString and the TextDataHolder value agree');
    // v1: either no label at all (invalid XML) or a different QR text
    const v1Embed = v1.ops.find((op) => op.kind === 'qr-embed');
    assert.ok(!v1.printed || v1Embed.value !== barcode, `v1 could not write ${barcode} exactly`);
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (e) unlisted designs                                                                                        */
/* ---------------------------------------------------------------------------------------------------------- */

const UNLISTED = ['', undefined, 'x', 5, '5', 0, -1, 'abc'];

test('(e) an unlisted design WITHOUT a sale at 32x57 is v1\'s final-else label exactly', async () => {
  for (const design of UNLISTED) {
    const payload = payloadOf({ size: '32x57', design, fields: FULL, isSale: false });
    const v1 = await goldenOps(payload);
    assert.equal(v1.printed, true);
    assert.equal(v1.template, 'Labeldesign1_1.dymo');
    assert.deepEqual(observed(v2Ops(payload)), observed(v1), `design ${JSON.stringify(design)}`);
    // the final else prints the RAW processor in TEXT__1 (not upper-cased) and only four spec slots
    assert.equal(textOf(v1, 'TEXT__1'), 'A15');
  }
});

test('(e) an unlisted design WITH a sale: v1 printed nothing at 32x57 and 70x54; v2 prints the design-1 sale label of that size', async () => {
  for (const size of ['32x57', '70x54']) {
    for (const design of UNLISTED) {
      const payload = payloadOf({ size, design, fields: FULL, isSale: true });
      const v1 = await goldenOps(payload);
      assert.equal(v1.printed, false, `v1 printed nothing (${size}, design ${JSON.stringify(design)})`);
      assert.match(v1.error, /no object with name 'Text_was' was found/);
      assert.equal(v1.template, 'Labeldesign1_1.dymo', 'v1 even opened the 32x57 template at 70x54');

      const v2 = v2Ops(payload);
      assert.equal(v2.printed, true);
      assert.equal(v2.template, size === '70x54' ? '70_54_Labeldesign_sale.dymo' : 'Labeldesign_sale.dymo');
      // "Sale = the design-1 sale fill": the same values v1 prints for design 1 on the same data
      const design1 = await goldenOps(payloadOf({ size, design: 1, fields: FULL, isSale: true }));
      assert.deepEqual(v2.ops, design1.ops, `${size} design ${JSON.stringify(design)}`);
      assert.deepEqual(v2.labels[0].qr, design1.labels[0].qr);
    }
  }
});

test('(e) an unlisted design WITHOUT a sale at 70x54: v1 opened the 32x57 template; v2 opens the 70x54 design-1 template with the same values', async () => {
  for (const design of UNLISTED) {
    const payload = payloadOf({ size: '70x54', design, fields: FULL, isSale: false });
    const v1 = await goldenOps(payload);
    assert.equal(v1.printed, true);
    assert.equal(v1.template, 'Labeldesign1_1.dymo', 'v1: the wrong-size template');
    const v2 = v2Ops(payload);
    assert.equal(v2.template, '70_54_Labeldesign1_2_22.dymo');
    assert.deepEqual(v2.ops, v1.ops, `design ${JSON.stringify(design)}`);
    assert.equal(v2.printer, v1.printer);
  }
});

test('(e) at 25x25 an unlisted design is exactly v1: designs 1 and 3 print the barcode label, everything else the QR label', async () => {
  for (const design of [...UNLISTED, 1, '1', 3, 2, 4, 7, 'repair']) {
    const payload = payloadOf({ size: '25x25', design, fields: FULL });
    const v1 = await goldenOps(payload);
    const expected = String(design) === '1' || String(design) === '3' ? '25_25_barcode.dymo' : '25_25_qrcode.dymo';
    assert.equal(v1.template, expected, `v1 design ${JSON.stringify(design)}`);
    assert.deepEqual(observed(v2Ops(payload)), observed(v1), `design ${JSON.stringify(design)}`);
  }
});

test('(f) a design number 7 sent directly: v1 opened the 32x57 template and failed on TextObject9; v2 treats it as unlisted', async () => {
  for (const size of ['32x57', '70x54']) {
    for (const isSale of [false, true]) {
      const payload = payloadOf({ size, design: 7, fields: FULL, isSale });
      const v1 = await goldenOps(payload);
      assert.equal(v1.printed, false, `${size} sale=${isSale}`);
      assert.match(v1.error, /TextObject9/);
      const same = v2Ops(payloadOf({ size, design: '', fields: FULL, isSale }));
      assert.deepEqual(observed(v2Ops(payload)), observed(same), `${size} sale=${isSale}`);
    }
  }
  const qr25 = payloadOf({ size: '25x25', design: 7, fields: FULL });
  assert.deepEqual(observed(v2Ops(qr25)), observed(await goldenOps(qr25)));
});

test('design 2 on sale is label design 7: the sale QR template, the QR written into the XML, was/now/off prices', async () => {
  for (const size of ['32x57', '70x54']) {
    const payload = payloadOf({ size, design: '2', fields: FULL, isSale: true });
    const v1 = await goldenOps(payload);
    assert.equal(v1.template, size === '70x54' ? '70_54_Labeldesign3.dymo' : 'Labeldesign3.dymo');
    assert.deepEqual(
      v1.ops.map((op) => op.name),
      ['QRCodeObject0', 'ItemNameVal', 'TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1', 'TextObject11', 'TEXT_3', 'TextObject1', 'TextObject9', 'Text_barcode']
    );
    assert.equal(textOf(v1, 'TextObject1'), `${POUND}50.00 OFF`);
    assert.equal(textOf(v1, 'TextObject9'), `${POUND}499.99`);
    assert.deepEqual(observed(v2Ops(payload)), observed(v1));
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* (g) repair without items; printer choice                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

test('(g) a repair message with an empty orderItems list: v1 printed nothing silently; v2 answers INVALID_PAYLOAD', async () => {
  const payload = payloadOf({ size: '32x57', design: 'repair', fields: { barcode: 'R-1' } });
  payload.barcodefinal.orderItems = [];
  const v1 = await goldenOps(payload);
  assert.equal(v1.labels.length, 0);
  assert.equal(v1.printed, false);
  assert.throws(() => buildLabelPlan(payload), (error) => error instanceof LabelPayloadError && error.code === 'INVALID_PAYLOAD');
});

test('printer choice: v1 printed on the first printer; v2 honours the configured one and prefers a connected LabelWriter', async () => {
  const printers = [
    { name: 'DYMO LabelManager PnP', printerType: 'TapePrinter', isConnected: false },
    { name: 'DYMO LabelWriter 4XL', isConnected: true },
    { name: 'DYMO LabelWriter 450', isConnected: true },
  ];
  const payload = payloadOf({ size: '32x57', design: '1', fields: FULL });
  const v1 = await goldenOps(payload, { printers });
  assert.equal(v1.printer, 'DYMO LabelManager PnP', 'v1 always used printers[0]');
  assert.equal(v2Ops(payload, { printers }).printer, 'DYMO LabelWriter 4XL', 'automatic: the first connected LabelWriter');
  assert.equal(v2Ops(payload, { printers, configuredPrinter: 'labelwriter 450' }).printer, 'DYMO LabelWriter 450', 'configured name, case-insensitive');
  assert.equal(v2Ops(payload, { printers, configuredPrinter: 'DYMO LabelWriter 450' }).printer, 'DYMO LabelWriter 450');
});

test('with a single printer v1 and v2 print on the same one', async () => {
  const payload = payloadOf({ size: '32x57', design: '3', fields: FULL });
  const printers = [{ name: 'DYMO LabelWriter 450 Turbo' }];
  assert.equal(v2Ops(payload, { printers }).printer, (await goldenOps(payload, { printers })).printer);
});

test('(d) a quote in the printer name: v1 pasted it into its script and printed nothing; v2 prints on that printer', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: FULL });
  const printers = [{ name: 'Front desk "DYMO" 450' }];
  const v1 = await goldenOps(payload, { printers });
  assert.equal(v1.printed, false);
  const v2 = v2Ops(payload, { printers });
  assert.equal(v2.printed, true);
  assert.equal(v2.printer, 'Front desk "DYMO" 450');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The design 2/7 QR mechanism and the QR patch, against the framework variants                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('designs 2 and 7 behave the same whether or not the framework has its own _setQRCodeObjectText (v1 installs a wrapper only if it lacks one)', async () => {
  for (const nativeQrSetter of [true, false]) {
    for (const isSale of [false, true]) {
      const payload = payloadOf({ size: '32x57', design: '2', fields: FULL, isSale });
      assert.deepEqual(observed(v2Ops(payload, { nativeQrSetter })), observed(await goldenOps(payload, { nativeQrSetter })), `native=${nativeQrSetter} sale=${isSale}`);
    }
  }
});

test('QR state at print time matches v1: DataString and TextDataHolder value hold the barcode, no cached picture, for every QR design', async () => {
  for (const [size, design] of [['32x57', '4'], ['70x54', '4'], ['25x25', '2'], ['32x57', 'repair'], ['32x57', '2'], ['70x54', '2']]) {
    const payload = payloadOf({ size, design, fields: { ...FULL, barcode: 'QR-0123456789' } });
    const v1 = await goldenOps(payload);
    const v2 = v2Ops(payload);
    assert.ok(v2.labels[0].qr.length > 0, `${size} design ${design} has QR objects`);
    assert.deepEqual(v2.labels[0].qr, v1.labels[0].qr, `${size} design ${design}`);
    const touched = v2.labels[0].qr.filter((object) => object.data === 'QR-0123456789');
    assert.ok(touched.length > 0);
    for (const object of touched) {
      assert.equal(object.holder, 'QR-0123456789');
      assert.equal(object.hasRenderCache, false);
    }
  }
});

test('the fake framework used by the golden tests is wired like the real one (no printer = v1 prints nothing)', async () => {
  const payload = payloadOf({ size: '32x57', design: '1', fields: FULL });
  const v1 = await goldenOps(payload, { printers: [] });
  assert.equal(v1.printed, false);
  assert.equal(v1.labels.length, 0, 'v1 stops before opening a label when DYMO lists no printer');
  assert.equal(createFakeDymo({ printers: [] }).run('dymo.label.framework.getPrinters().length'), 0);
});
