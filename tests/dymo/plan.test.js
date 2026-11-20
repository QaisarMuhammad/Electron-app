'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLabelPlan, LabelPayloadError, MAX_LABELS_PER_MESSAGE, MAX_LABEL_BYTES, TEMPLATES } = require('../../src/main/printing/dymo/plan');
const { MAX_RAW_CHARS } = require('../../src/main/printing/labelText');

const POUND = '£';

const product = (extra = {}) => ({
  printer: 'dymo',
  title: 'iPhone 13',
  barcode: 'ABCDEFGH123456',
  storage: '128GB',
  network: 'Unlocked',
  ram: '4GB',
  misc_color: 'Blue',
  warranty: '12 Months',
  conditionObject: { grade: 'A' },
  Processor: 'A15',
  price: '499.99',
  salePrice: '449.99',
  regular_price: '499.99',
  isSale: false,
  ...extra,
});
const envelope = (barcodefinal, extra = {}) => ({ size: '32x57', design: '1', barcodefinal, ...extra });

const plan = (payload, options) => buildLabelPlan(payload, options);
const only = (payload, options) => {
  const { plans } = plan(payload, options);
  assert.equal(plans.length, 1);
  return plans[0];
};
const valueOf = (labelPlan, name) => labelPlan.ops.find((op) => op.name === name)?.value;
const names = (labelPlan) => labelPlan.ops.map((op) => `${op.kind}:${op.name}`);

test('the plan is { plans: [...] } with a summary, and plans carry a template file and ops of kind text, qr or qr-embed', () => {
  const result = plan(envelope(product()));
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.summary, { size: '32x57', design: 1, lab: false, sale: false, labels: 1 });
  assert.equal(result.plans[0].templateFile, 'Labeldesign1_1.dymo');
  for (const op of result.plans[0].ops) {
    assert.deepEqual(Object.keys(op).sort(), ['kind', 'name', 'value']);
    assert.ok(['text', 'qr', 'qr-embed'].includes(op.kind));
    assert.equal(typeof op.value, 'string');
  }
  assert.ok(!('repeats' in result) && !('repeats' in result.plans[0]), 'there is no repeats field (SPEC 9.4)');
});

test('invalid input is a LabelPayloadError with the INVALID_PAYLOAD code and a plain message', () => {
  for (const bad of [undefined, null, 'x', 5, [], {}, { barcodefinal: 'ZPL' }, { barcodefinal: null }, { barcodefinal: [] }]) {
    assert.throws(() => plan(bad), (error) => error instanceof LabelPayloadError && error.code === 'INVALID_PAYLOAD' && /\w/.test(error.message), JSON.stringify(bad));
  }
});

test('size: only "25x25" and "70x54" select those templates; every other value is the 32x57 default and never an error', () => {
  assert.equal(only(envelope(product(), { size: '70x54' })).templateFile, TEMPLATES['70x54'].design1);
  assert.equal(only(envelope(product(), { size: '25x25' })).templateFile, TEMPLATES['25x25'].barcode);
  for (const size of ['32x57', '57x32', '57x35', '57x25', '', undefined, null, 5, '25X25', ' 70x54', {}]) {
    assert.equal(only(envelope(product(), { size })).templateFile, 'Labeldesign1_1.dymo', JSON.stringify(size));
  }
});

test('design: "1" and 1 are the same; "" undefined, unlisted and non-numeric values are NaN', () => {
  const template = (design, size = '32x57') => only(envelope(product(), { design, size })).templateFile;
  assert.equal(template(1), template('1'));
  assert.equal(template(' 2 '), 'Labeldesign2.dymo');
  assert.equal(template('3'), 'mukltipleBarcode.dymo');
  assert.equal(template(4), 'multipleQRCODE.dymo');
  assert.equal(plan(envelope(product(), { design: '' })).summary.design, null);
  assert.equal(plan(envelope(product(), { design: undefined })).summary.design, null);
  assert.equal(plan(envelope(product(), { design: 'x' })).summary.design, null);
  assert.equal(plan(envelope(product(), { design: 5 })).summary.design, 5);
  assert.equal(plan(envelope(product({ design: 'repair', orderItem: {} }), { design: 'whatever' })).summary.design, 'repair', 'barcodefinal.design === "repair" decides');
});

test('lab: its own template, filled from the OUTER barcode and title only', () => {
  const labelPlan = only({ type: 'lab', size: '70x54', design: '1', barcode: '636400', title: 'iphone 15 oled screen', barcodefinal: { printer: 'dymo', ...product({ title: 'NOT THIS' }) } });
  assert.equal(labelPlan.templateFile, 'labitemdesign.dymo');
  assert.deepEqual(labelPlan.ops, [
    { kind: 'text', name: 'BarcodeObject1', value: '636400' },
    { kind: 'text', name: 'TextObject12', value: 'iphone 15 oled screen' },
  ]);
});

test('lab: nothing else is read (the barcodefinal fields may throw when touched)', () => {
  const trap = { printer: 'dymo' };
  for (const key of ['title', 'barcode', 'price', 'salePrice', 'regular_price', 'isSale', 'storage', 'conditionObject', 'Processor', 'currency', 'warranty']) {
    Object.defineProperty(trap, key, {
      enumerable: true,
      get() {
        throw new Error(`read ${key}`);
      },
    });
  }
  assert.doesNotThrow(() => plan({ type: 'lab', barcode: '1', title: 't', barcodefinal: trap }));
});

test('normal labels read the fields of barcodefinal, never the envelope (an outer title is ignored)', () => {
  const labelPlan = only(envelope(product(), { title: 'OUTER', barcode: 'OUTER', price: 99, storage: 'OUTER', currency: undefined }));
  assert.equal(valueOf(labelPlan, 'ItemNameVal'), 'iPhone 13');
  assert.equal(valueOf(labelPlan, 'BARCODE'), 'ABCDEFGH123456');
  assert.equal(valueOf(labelPlan, 'TEXT_3'), `${POUND}499.99`);
});

test('unread properties are never touched: whole order/business/settings objects and giant values do not matter', () => {
  const bf = product();
  for (const key of ['order', 'business', 'businessData', 'settings', 'sim', 'prints', 'extra']) {
    Object.defineProperty(bf, key, {
      enumerable: true,
      get() {
        throw new Error(`read ${key}`);
      },
    });
  }
  assert.doesNotThrow(() => plan(envelope(bf, { prints: 5 })));
  assert.doesNotThrow(() => plan(envelope(product({ settings: { notes: 'x'.repeat(300_000) } }))));
});

test('`prints` is never read and never a copy count', () => {
  const bf = product();
  Object.defineProperty(bf, 'prints', {
    get() {
      throw new Error('prints was read');
    },
  });
  const payload = envelope(bf, {});
  Object.defineProperty(payload, 'prints', {
    get() {
      throw new Error('prints was read');
    },
  });
  assert.equal(plan(payload).plans.length, 1);
});

test('price prints only above zero: numbers and numeric strings, never "", 0, negatives or text', () => {
  const price = (value) => valueOf(only(envelope(product({ price: value }))), 'TEXT_3');
  assert.equal(price(12.5), `${POUND}12.5`);
  assert.equal(price('12.50'), `${POUND}12.50`);
  assert.equal(price(' 7 '), `${POUND}7`);
  assert.equal(price('12.5\n'), `${POUND}12.5`, 'Number() accepts it; the text is cleaned');
  for (const none of ['', 0, '0', -1, '-3', 'CNT-12', 'abc', undefined, null, NaN, {}, [], true === false]) assert.equal(price(none), '', JSON.stringify(none));
  assert.equal(price(true), `${POUND}true`, 'v1: true > 0 is true');
});

test('sale: needs isSale === true AND a positive difference; off is the difference to 2 decimals', () => {
  const sale = (extra) => plan(envelope(product(extra), { design: '1' })).summary.sale;
  assert.equal(sale({ isSale: true }), true);
  assert.equal(sale({ isSale: false }), false);
  for (const isSale of ['true', 1, 'yes', null, undefined, {}]) assert.equal(sale({ isSale }), false, JSON.stringify(isSale));
  assert.equal(sale({ isSale: true, salePrice: '499.99' }), false, 'no difference');
  assert.equal(sale({ isSale: true, salePrice: '600' }), false, 'a negative difference');
  assert.equal(sale({ isSale: true, salePrice: 'abc' }), false);
  assert.equal(sale({ isSale: true, regular_price: undefined }), false);
  assert.equal(sale({ isSale: true, regular_price: 10, salePrice: 9.996 }), false, 'a difference that rounds to 0.00 is no sale (v1)');
  assert.equal(sale({ isSale: true, regular_price: 10, salePrice: 9.99 }), true);
  const labelPlan = only(envelope(product({ isSale: true, regular_price: '499.99', salePrice: '449.99' })));
  assert.equal(labelPlan.templateFile, 'Labeldesign_sale.dymo');
  assert.equal(valueOf(labelPlan, 'TEXT__1'), `${POUND}50.00 OFF`);
  assert.equal(valueOf(labelPlan, 'TEXT_3'), `${POUND}449.99`);
  assert.equal(valueOf(labelPlan, 'Text_was'), `${POUND}499.99`);
});

test('warranty prints only when its text is longer than 3 characters, upper-cased with " WARRANTY"; numbers are coerced first', () => {
  const warranty = (value) => valueOf(only(envelope(product({ warranty: value }))), 'TextObject11');
  assert.equal(warranty('12 Months'), '12 MONTHS WARRANTY');
  assert.equal(warranty('Lifetime'), 'LIFETIME WARRANTY');
  assert.equal(warranty('1y'), '');
  assert.equal(warranty('3 M'), '');
  assert.equal(warranty('abcd'), 'ABCD WARRANTY');
  assert.equal(warranty(''), '');
  assert.equal(warranty(undefined), '');
  assert.equal(warranty(null), '');
  assert.equal(warranty(12345), '12345 WARRANTY');
  assert.equal(warranty(12), '', 'a number of 3 or fewer digits has no text above 3 characters');
});

test('spec slots: no empty entry takes a slot, and unused slots print blank', () => {
  const labelPlan = only(envelope(product({ conditionObject: undefined, storage: '', network: '  ', ram: '4GB', Processor: undefined, misc_color: 'Red' })));
  assert.deepEqual(
    ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((name) => valueOf(labelPlan, name)),
    ['4GB', 'RED', '', '', '']
  );
});

test('processor: Processor ?? processor', () => {
  const processor = (extra) => valueOf(only(envelope(product({ Processor: undefined, ...extra }), { design: '' })), 'TEXT__1');
  assert.equal(processor({ processor: 'M1' }), 'M1');
  assert.equal(processor({ Processor: 'A15', processor: 'M1' }), 'A15');
  assert.equal(processor({ Processor: null, processor: 'M1' }), 'M1');
  assert.equal(processor({ Processor: '', processor: 'M1' }), '');
  assert.equal(processor({}), '');
});

test('values of any type are String()-coerced: numbers and booleans never throw, null and undefined are empty', () => {
  const labelPlan = only(envelope(product({ title: 12345, barcode: 987654321, storage: 128, network: false, ram: null, misc_color: undefined, conditionObject: { grade: 5 } })));
  assert.equal(valueOf(labelPlan, 'ItemNameVal'), '12345');
  assert.equal(valueOf(labelPlan, 'BARCODE'), '987654321');
  assert.equal(valueOf(labelPlan, 'TextObject1'), '***654321');
  assert.deepEqual(['TEXT_4', 'TEXT', 'TEXT_1'].map((name) => valueOf(labelPlan, name)), ['GRADE 5', '128', 'FALSE']);
});

test('values are cleaned and cut to 2 KB; the text of a whole message is limited to 256 KB', () => {
  const labelPlan = only(envelope(product({ title: `  a\nb${String.fromCharCode(0)}c  `, storage: 'x'.repeat(10_000) })));
  assert.equal(valueOf(labelPlan, 'ItemNameVal'), 'a bc');
  assert.equal(valueOf(labelPlan, 'TEXT_4'), 'GRADE A', 'slot 0 is the condition');
  assert.equal(valueOf(labelPlan, 'TEXT'), 'X'.repeat(2048), 'the storage is cut to 2 KB');
  assert.equal(MAX_LABEL_BYTES, 256 * 1024);
  const item = { product_name: 'p'.repeat(2000), custom_field_value: [{ value: 'c'.repeat(2000) }, { value: 'd'.repeat(2000) }, { value: 'e'.repeat(2000) }] };
  const items = Array.from({ length: 40 }, () => item); // 40 x 8000 bytes = 320000 > 262144
  assert.throws(() => plan({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R', orderItems: items } }), LabelPayloadError);
  const fewer = Array.from({ length: 30 }, () => item); // 240000 bytes
  assert.equal(plan({ barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R', orderItems: fewer } }).plans.length, 30);
});

test('a single huge text is cut, never rejected', () => {
  const labelPlan = only(envelope(product({ title: 'x'.repeat(5_000_000) })));
  assert.equal(valueOf(labelPlan, 'ItemNameVal').length, 2048);
});

test('every text field the plan reads is read only up to MAX_RAW_CHARS units: text that starts beyond the limit never reaches a label (SEC-02)', () => {
  const repair = (extra) => ({
    barcodefinal: {
      printer: 'dymo',
      design: 'repair',
      barcode: 'R-1',
      orderDate: '2026-11-19',
      customer: { name: 'Jo', cell_no: '0700' },
      business: { business_name: 'T&R', branch_name: 'Main' },
      orderItem: { product_name: 'Screen', custom_field_value: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
      ...extra,
    },
  });
  const item = (extra) => ({ product_name: 'Screen', custom_field_value: [{ value: 'a' }, { value: 'b' }, { value: 'c' }], ...extra });
  const cases = (value) => ({
    title: envelope(product({ title: value })),
    barcode: envelope(product({ barcode: value })),
    storage: envelope(product({ storage: value })),
    network: envelope(product({ network: value })),
    ram: envelope(product({ ram: value })),
    colour: envelope(product({ misc_color: value, storage: '', network: '', ram: '', Processor: '' })), // the colour is the sixth spec: with all five before it set, no slot would print it
    Processor: envelope(product({ Processor: value })),
    processor: envelope(product({ Processor: undefined, processor: value })),
    warranty: envelope(product({ warranty: value })),
    'condition grade': envelope(product({ conditionObject: { grade: value } })),
    'design 4 barcode': envelope(product({ barcode: value }), { design: '4' }),
    '25x25 barcode': envelope(product({ barcode: value }), { size: '25x25' }),
    'lab title': { type: 'lab', barcode: '1', title: value, barcodefinal: { printer: 'dymo' } },
    'lab barcode': { type: 'lab', barcode: value, title: 'Screen', barcodefinal: { printer: 'dymo' } },
    'repair barcode': repair({ barcode: value }),
    'repair order date': repair({ orderDate: value }),
    'repair customer name': repair({ customer: { name: value, cell_no: '0700' } }),
    'repair customer phone': repair({ customer: { name: 'Jo', cell_no: value } }),
    'repair business name': repair({ business: { business_name: value, branch_name: 'Main' } }),
    'repair branch name': repair({ business: { business_name: 'T&R', branch_name: value } }),
    'repair item name': repair({ orderItem: item({ product_name: value }) }),
    'repair custom field 1': repair({ orderItem: item({ custom_field_value: [{ value }, { value: 'b' }, { value: 'c' }] }) }),
    'repair custom field 3': repair({ orderItem: item({ custom_field_value: [{ value: 'a' }, { value: 'b' }, { value }] }) }),
  });
  const within = `${' '.repeat(100)}TAIL`; // inside the limit: the text prints, so the cases below are not vacuous
  const beyond = `${' '.repeat(MAX_RAW_CHARS)}TAIL`; // the first MAX_RAW_CHARS units are blank: "TAIL" starts at the limit
  for (const [name, payload] of Object.entries(cases(within))) assert.ok(JSON.stringify(plan(payload).plans).includes('TAIL'), `${name}: the control text reaches the label`);
  for (const [name, payload] of Object.entries(cases(beyond))) assert.ok(!JSON.stringify(plan(payload).plans).includes('TAIL'), `${name}: text beyond the limit was read`);
});

test('currency: the envelope wins over barcodefinal; the injected symbol function is used', () => {
  const calls = [];
  const symbol = (iso) => {
    calls.push(iso);
    return 'S ';
  };
  const labelPlan = only(envelope(product({ currency: 'BF' }), { currency: 'OUTER' }), { currencySymbol: symbol });
  assert.deepEqual(calls, ['OUTER']);
  assert.equal(valueOf(labelPlan, 'TEXT_3'), 'S 499.99');
  calls.length = 0;
  only(envelope(product({ currency: 'BF' })), { currencySymbol: symbol });
  assert.deepEqual(calls, ['BF']);
  calls.length = 0;
  only(envelope(product({ currency: 'BF' }), { currency: null }), { currencySymbol: symbol });
  assert.deepEqual(calls, ['BF'], 'null falls through (??)');
});

test('every design at 32x57 and 70x54 picks its template; design 2 on sale is the sale QR template (label design 7)', () => {
  for (const size of ['32x57', '70x54']) {
    const t = TEMPLATES[size];
    const pick = (design, extra = {}) => only(envelope(product(extra), { size, design })).templateFile;
    assert.equal(pick(1), t.design1);
    assert.equal(pick(1, { isSale: true }), t.sale);
    assert.equal(pick(2), t.design2);
    assert.equal(pick(2, { isSale: true }), t.design2Sale);
    assert.equal(pick(3), t.design3);
    assert.equal(pick(4), t.design4);
    assert.equal(pick(3, { isSale: true }), t.design3, 'sale does not change designs 3 and 4');
    assert.equal(pick(4, { isSale: true }), t.design4);
    assert.equal(pick('', { isSale: true }), t.sale, 'an unlisted design on sale: the design-1 sale label (SPEC 9.4 (e))');
    assert.equal(pick('', {}), t.design1, 'and not on sale: the design-1 template of THIS size');
    assert.equal(pick(7), t.design1, 'a design number 7 sent directly is unlisted');
  }
});

test('25x25: designs 1 and 3 print the barcode label, everything else (NaN included) the QR label; a repair design has its own small label', () => {
  const at = (design, extra = {}) => only(envelope(product(extra), { size: '25x25', design }));
  for (const design of [1, '1', 3, '3']) {
    const labelPlan = at(design);
    assert.equal(labelPlan.templateFile, '25_25_barcode.dymo');
    assert.deepEqual(labelPlan.ops, [
      { kind: 'text', name: 'BarcodeObject0', value: 'ABCDEFGH123456' },
      { kind: 'text', name: 'TextObject1', value: `${POUND}499.99` },
    ]);
  }
  for (const design of [2, 4, 7, '', undefined, 'x', 9]) {
    const labelPlan = at(design);
    assert.equal(labelPlan.templateFile, '25_25_qrcode.dymo', JSON.stringify(design));
    assert.deepEqual(labelPlan.ops, [
      { kind: 'qr', name: 'QRCodeObject2', value: 'ABCDEFGH123456' },
      { kind: 'text', name: 'TextObject2', value: `${POUND}499.99` },
      { kind: 'text', name: 'TextObject3', value: '**123456' },
    ]);
  }
  // a repair at 25x25 is the small repair label (customer, QR code, job number), one per order item like at the other sizes
  const repair = plan({ size: '25x25', barcodefinal: product({ design: 'repair', customer: { name: 'Jo Smith' }, orderItems: [{ product_name: 'A' }, { product_name: 'B' }] }) });
  assert.equal(repair.plans.length, 2);
  for (const labelPlan of repair.plans) {
    assert.equal(labelPlan.templateFile, '25_25_repair.dymo');
    assert.deepEqual(labelPlan.ops, [
      { kind: 'text', name: 'TextObject2', value: 'Jo Smith' },
      { kind: 'qr', name: 'QRCodeObject2', value: 'ABCDEFGH123456' },
      { kind: 'text', name: 'TextObject3', value: '**123456' },
    ]);
  }
  const noCustomer = plan({ size: '25x25', barcodefinal: product({ design: 'repair', barcode: 'R-1042', orderItem: { product_name: 'iPhone 13' } }) }).plans[0];
  assert.equal(noCustomer.ops[0].value, 'iPhone 13', 'without a customer name the device is printed');
  assert.equal(noCustomer.ops[2].value, 'R-1042', 'a short job number is printed in full');
});

test('designs 2 and 7 use the XML-embedded QR (op kind qr-embed); design 4 and the repair label use the patch (kind qr)', () => {
  assert.deepEqual(only(envelope(product(), { design: '2' })).ops[0], { kind: 'qr-embed', name: 'QRCodeObject0', value: 'ABCDEFGH123456' });
  assert.deepEqual(only(envelope(product({ isSale: true }), { design: '2' })).ops[0], { kind: 'qr-embed', name: 'QRCodeObject0', value: 'ABCDEFGH123456' });
  assert.deepEqual(names(only(envelope(product(), { design: '4' }))).slice(0, 3), ['qr:QRCodeObject0', 'qr:QRCodeObject1', 'qr:QRCodeObject2']);
  const repair = plan({ barcodefinal: product({ design: 'repair', orderItem: {} }) }).plans[0];
  assert.deepEqual(repair.ops.at(-1), { kind: 'qr', name: 'QRCodeObject0', value: 'ABCDEFGH123456' });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Repair                                                                                                      */
/* ---------------------------------------------------------------------------------------------------------- */

const repair = (extra = {}) => ({
  barcodefinal: {
    printer: 'dymo',
    design: 'repair',
    barcode: 'R-1042',
    orderDate: '2026-11-19',
    customer: { name: 'Jo Smith', cell_no: '07123456789' },
    business: { business_name: 'T&R Mobile', branch_name: 'Main', post_code: 'AB1 2CD' },
    orderItem: { product_name: 'iPhone 13', current_price: 99, product_sn_imei_description: 'IMEI 1', custom_field_value: [{ value: 'Cracked' }, { value: 'Rush' }, { value: 'Back' }] },
    ...extra,
  },
});

test('repair: one label per orderItems element in array order; a lone orderItem is one label', () => {
  const many = plan(repair({ orderItems: [{ product_name: 'A' }, { product_name: 'B' }, { product_name: 'C' }] }));
  assert.deepEqual(
    many.plans.map((labelPlan) => valueOf(labelPlan, 'ItemNameVal')),
    ['A', 'B', 'C']
  );
  assert.ok(many.plans.every((labelPlan) => labelPlan.templateFile === 'LabeldesignRepair.dymo'));
  assert.equal(many.summary.labels, 3);
  const lone = plan(repair());
  assert.equal(lone.plans.length, 1);
  assert.equal(valueOf(lone.plans[0], 'ItemNameVal'), 'iPhone 13');
});

test('repair: every label size has its own template (32x57 is the default)', () => {
  const expected = { '32x57': 'LabeldesignRepair.dymo', '70x54': '70_54_LabeldesignRepair.dymo', '25x25': '25_25_repair.dymo', undefined: 'LabeldesignRepair.dymo' };
  for (const size of ['32x57', '70x54', '25x25', undefined]) assert.equal(plan({ ...repair(), size }).plans[0].templateFile, expected[size], String(size));
});

test('repair: the fields and their objects', () => {
  const [labelPlan] = plan(repair()).plans;
  assert.deepEqual(
    labelPlan.ops.map((op) => [op.kind, op.name, op.value]),
    [
      ['text', 'ItemNameVal', 'iPhone 13'],
      ['text', 'TEXT', 'Cracked'],
      ['text', 'TEXT8', 'Rush'],
      ['text', 'TEXT9', 'Back'],
      ['text', 'TextObject7', ''],
      ['text', 'TextObject5', 'Jo Smith'],
      ['text', 'TextObject6', '07123456789'],
      ['text', 'TEXT_5', 'T&R Mobile Main'],
      ['text', 'TextObject1', '2026-11-19'],
      ['text', 'TEXT4', 'R-1042'],
      ['qr', 'QRCodeObject0', 'R-1042'],
    ]
  );
  const printed = JSON.stringify(labelPlan.ops);
  for (const never of ['99', 'IMEI 1', 'AB1 2CD']) assert.ok(!printed.includes(never), `${never} is read by v1 but never printed`);
});

test('repair: custom fields keep their position; an entry whose value has no length is blank; a non-array gives blanks', () => {
  const fields = (custom) => ['TEXT', 'TEXT8', 'TEXT9'].map((name) => valueOf(plan(repair({ orderItem: { custom_field_value: custom } })).plans[0], name));
  assert.deepEqual(fields([{ value: 'A' }, { value: '' }, { value: 'C' }]), ['A', '', 'C']);
  assert.deepEqual(fields([{ value: undefined }, { value: 'B' }]), ['', 'B', '']);
  assert.deepEqual(fields([{ value: 5 }, { value: ['x', 'y'] }, null]), ['', 'x,y', '']);
  assert.deepEqual(fields([{ value: 'A' }, { value: 'B' }, { value: 'C' }, { value: 'D' }]), ['A', 'B', 'C']);
  assert.deepEqual(fields('not an array'), ['', '', '']);
  assert.deepEqual(fields(undefined), ['', '', '']);
  assert.deepEqual(fields([]), ['', '', '']);
});

test('repair: customer name and phone use || (falsy is blank); a missing business gives a blank business line', () => {
  const labelPlan = plan(repair({ customer: { name: 0, cell_no: null }, business: undefined })).plans[0];
  assert.equal(valueOf(labelPlan, 'TextObject5'), '');
  assert.equal(valueOf(labelPlan, 'TextObject6'), '');
  assert.equal(valueOf(labelPlan, 'TEXT_5'), '');
  assert.equal(valueOf(plan(repair({ business: { business_name: 'Shop', branch_name: '' } })).plans[0], 'TEXT_5'), 'Shop');
  assert.equal(valueOf(plan(repair({ business: { business_name: '', branch_name: 'North' } })).plans[0], 'TEXT_5'), 'North');
});

test('repair: neither orderItems nor orderItem is one blank-item label (v1: [undefined])', () => {
  const body = repair();
  delete body.barcodefinal.orderItem;
  const result = plan(body);
  assert.equal(result.plans.length, 1);
  assert.equal(valueOf(result.plans[0], 'ItemNameVal'), '');
});

test('repair: an empty orderItems array is INVALID_PAYLOAD; so are more than the maximum number of labels', () => {
  assert.throws(() => plan(repair({ orderItems: [] })), (error) => error instanceof LabelPayloadError && /no items/.test(error.message));
  assert.equal(plan(repair({ orderItems: Array.from({ length: MAX_LABELS_PER_MESSAGE }, () => ({})) })).plans.length, MAX_LABELS_PER_MESSAGE);
  assert.throws(() => plan(repair({ orderItems: Array.from({ length: MAX_LABELS_PER_MESSAGE + 1 }, () => ({})) })), LabelPayloadError);
});

test('repair: unread properties of the order item (even 300 KB ones) and of the business never matter', () => {
  const item = { product_name: 'x', huge: 'y'.repeat(300_000) };
  for (const key of ['current_price', 'product_sn_imei_description']) {
    Object.defineProperty(item, key, {
      enumerable: true,
      get() {
        throw new Error(`read ${key}`);
      },
    });
  }
  const business = { business_name: 'Shop' };
  Object.defineProperty(business, 'post_code', {
    get() {
      throw new Error('read post_code');
    },
  });
  const result = plan(repair({ orderItem: item, business }));
  assert.equal(JSON.stringify(result).length < 5000, true);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Specs chosen by the dashboard for the kind of device (phone, laptop, tablet, accessory)                       */
/* ---------------------------------------------------------------------------------------------------------- */

test('barcodefinal.specs (an ordered list) replaces the fixed field order: the first 5 fill the slots, the first 4 on a sale label', () => {
  const specs = ['Grade A', 'Intel i7-1360P', '32GB', '1TB SSD', 'WiFi 6', 'Silver'];
  const plain = plan({ size: '32x57', design: 1, barcodefinal: product({ specs, storage: 'ignored', ram: 'ignored', conditionObject: { grade: 'Z' } }) }).plans[0];
  const slots = (labelPlan) => ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((name) => labelPlan.ops.find((op) => op.name === name)?.value);
  assert.deepEqual(slots(plain), ['GRADE A', 'INTEL I7-1360P', '32GB', '1TB SSD', 'WIFI 6']);
  const sale = plan({ size: '32x57', design: 1, barcodefinal: product({ specs, isSale: true, regular_price: 500, salePrice: 400 }) }).plans[0];
  assert.deepEqual(slots(sale).slice(0, 4), ['GRADE A', 'INTEL I7-1360P', '32GB', '1TB SSD'], 'the processor survives on a sale label');
});

test('an empty specs list prints no spec lines at all (an accessory), and an old dashboard without specs keeps the field order', () => {
  const empty = plan({ size: '32x57', design: 1, barcodefinal: product({ specs: [], storage: '64GB', conditionObject: { grade: 'New' } }) }).plans[0];
  assert.deepEqual(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((name) => empty.ops.find((op) => op.name === name)?.value), ['', '', '', '', '']);
  const old = plan({ size: '32x57', design: 1, barcodefinal: product({ storage: '64GB', conditionObject: { grade: 'New' } }) }).plans[0];
  assert.equal(old.ops.find((op) => op.name === 'TEXT_4').value, 'NEW');
  assert.equal(old.ops.find((op) => op.name === 'TEXT').value, '64GB');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Designs 5, 6, 8 and 9: name + barcode, name + QR, name + price + barcode, name + price + QR                  */
/* ---------------------------------------------------------------------------------------------------------- */

test('designs 5, 6, 8, 9 have their own template at 32x57 and 70x54 and fill only the fields they show', () => {
  const rows = [
    [5, 'Labeldesign5_nameBarcode.dymo', ['text:ItemNameVal', 'text:BARCODE', 'text:TextObject1']],
    [6, 'Labeldesign6_nameQr.dymo', ['qr-embed:QRCodeObject0', 'text:ItemNameVal', 'text:Text_barcode']],
    [8, 'Labeldesign8_namePriceBarcode.dymo', ['text:ItemNameVal', 'text:TEXT_3', 'text:BARCODE', 'text:TextObject1']],
    [9, 'Labeldesign9_namePriceQr.dymo', ['qr-embed:QRCodeObject0', 'text:ItemNameVal', 'text:TEXT_3', 'text:Text_barcode']],
  ];
  for (const [design, file, ops] of rows) {
    for (const [size, prefix] of [['32x57', ''], ['70x54', '70_54_']]) {
      const labelPlan = plan({ size, design, barcodefinal: product() }).plans[0];
      assert.equal(labelPlan.templateFile, `${prefix}${file}`, `${size} design ${design}`);
      assert.deepEqual(labelPlan.ops.map((op) => `${op.kind}:${op.name}`), ops, `${size} design ${design}`);
    }
  }
  assert.equal(plan({ size: '32x57', design: '8', barcodefinal: product() }).plans[0].ops.find((op) => op.name === 'TEXT_3').value, `${POUND}499.99`, 'a numeric string works like a number');
});

test('designs 8 and 9 print the sale price while on sale (no was / OFF captions), the normal price otherwise', () => {
  const sale = plan({ size: '32x57', design: 8, barcodefinal: product({ isSale: true, regular_price: 500, salePrice: 400 }) });
  assert.equal(sale.plans[0].ops.find((op) => op.name === 'TEXT_3').value, `${POUND}400`);
  assert.equal(sale.summary.sale, true);
  const notSale = plan({ size: '70x54', design: 9, barcodefinal: product({ isSale: false, regular_price: 500, salePrice: 400 }) });
  assert.equal(notSale.plans[0].ops.find((op) => op.name === 'TEXT_3').value, `${POUND}499.99`);
});

test('at 25x25 the barcode designs (1, 3, 5, 8) print the barcode label and the QR designs (2, 4, 6, 9) the QR label', () => {
  for (const design of [1, 3, 5, 8]) assert.equal(plan({ size: '25x25', design, barcodefinal: product() }).plans[0].templateFile, '25_25_barcode.dymo', String(design));
  for (const design of [2, 4, 6, 9]) assert.equal(plan({ size: '25x25', design, barcodefinal: product() }).plans[0].templateFile, '25_25_qrcode.dymo', String(design));
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Designs 10-13 (price tag, IMEI / serial, accessory tag, sale tag) and the repair bag tag                       */
/* ---------------------------------------------------------------------------------------------------------- */

test('designs 10, 11, 12 and 13 fill exactly the objects their template has, at both big sizes', () => {
  const rows = [
    [10, 'Labeldesign10_priceTag.dymo', ['ItemNameVal', 'TEXT_3', 'TEXT_4', 'TEXT', 'TextObject11']],
    [11, 'Labeldesign11_serial.dymo', ['ItemNameVal', 'TEXT_4', 'TEXT', 'BARCODE', 'TextObject1']],
    [12, 'Labeldesign12_accessory.dymo', ['ItemNameVal', 'TEXT_4', 'TEXT', 'TEXT_3', 'BARCODE', 'TextObject1']],
    [13, 'Labeldesign13_saleTag.dymo', ['ItemNameVal', 'Text_was', 'TEXT__1', 'TEXT_3', 'BARCODE', 'TextObject1']],
  ];
  for (const [design, file, names] of rows) {
    for (const [size, prefix] of [['32x57', ''], ['70x54', '70_54_']]) {
      const sale = design === 13;
      const labelPlan = plan({ size, design, barcodefinal: product({ specs: ['Grade A', '256GB'], isSale: sale, regular_price: 500, salePrice: 400 }) }).plans[0];
      assert.equal(labelPlan.templateFile, `${prefix}${file}`, `${size} design ${design}`);
      assert.deepEqual(labelPlan.ops.map((op) => op.name), names, `${size} design ${design}`);
    }
  }
});

test('the IMEI / serial label prints the number in full under the barcode (not masked); the accessory tag masks it like the standard label', () => {
  const serial = plan({ size: '32x57', design: 11, barcodefinal: product({ barcode: '357771570289459' }) }).plans[0];
  assert.equal(serial.ops.find((op) => op.name === 'TextObject1').value, '357771570289459');
  const accessory = plan({ size: '32x57', design: 12, barcodefinal: product({ barcode: '357771570289459' }) }).plans[0];
  assert.equal(accessory.ops.find((op) => op.name === 'TextObject1').value, '*********289459');
});

test('the sale tag shows the old price, the saving and the sale price; a product that is not on sale prints the price tag instead', () => {
  const onSale = plan({ size: '32x57', design: 13, barcodefinal: product({ isSale: true, regular_price: 500, salePrice: 400 }) });
  const value = (labelPlan, name) => labelPlan.ops.find((op) => op.name === name).value;
  assert.equal(onSale.plans[0].templateFile, 'Labeldesign13_saleTag.dymo');
  assert.equal(value(onSale.plans[0], 'Text_was'), `${POUND}500`);
  assert.equal(value(onSale.plans[0], 'TEXT__1'), `${POUND}100.00 OFF`);
  assert.equal(value(onSale.plans[0], 'TEXT_3'), `${POUND}400`);
  const notOnSale = plan({ size: '70x54', design: 13, barcodefinal: product({ isSale: false }) });
  assert.equal(notOnSale.plans[0].templateFile, '70_54_Labeldesign10_priceTag.dymo');
});

test('the repair bag tag: its own template per size, the customer, phone, job number and QR; 25x25 uses the small repair label', () => {
  const bag = (size) => plan({ size, barcodefinal: { printer: 'dymo', design: 'repair-bag', barcode: 'R-1042', orderDate: '20/11/2026', customer: { name: 'Jo Smith', cell_no: '07123' }, business: { business_name: 'T&R', branch_name: 'Leeds' }, orderItem: { product_name: 'iPhone 13' } } }).plans[0];
  assert.equal(bag('32x57').templateFile, 'LabeldesignRepairBag.dymo');
  assert.equal(bag('70x54').templateFile, '70_54_LabeldesignRepairBag.dymo');
  assert.equal(bag('25x25').templateFile, '25_25_repair.dymo');
  assert.deepEqual(bag('32x57').ops.map((op) => `${op.kind}:${op.name}:${op.value}`), [
    'text:ItemNameVal:iPhone 13', 'text:TextObject5:Jo Smith', 'text:TextObject6:07123', 'text:TEXT_5:T&R Leeds', 'text:TextObject1:20/11/2026', 'text:TEXT4:R-1042', 'qr:QRCodeObject0:R-1042',
  ]);
});

test('at 25x25 every barcode design prints the barcode label (1, 3, 5, 8, 10, 11, 12, 13) and the QR designs the QR label', () => {
  for (const design of [1, 3, 5, 8, 10, 11, 12, 13]) assert.equal(plan({ size: '25x25', design, barcodefinal: product() }).plans[0].templateFile, '25_25_barcode.dymo', String(design));
  for (const design of [2, 4, 6, 9]) assert.equal(plan({ size: '25x25', design, barcodefinal: product() }).plans[0].templateFile, '25_25_qrcode.dymo', String(design));
});
