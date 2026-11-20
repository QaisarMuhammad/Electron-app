'use strict';

/**
 * Seeded pseudo-random `send-barcode-data` envelopes for the golden fuzz (lens "dymo-golden").
 *
 * Every payload is a pure function of (seed, index): `generatePayload(seed, 37)` is the same object on every run and on every
 * machine, so a failure can be replayed on its own. The scenario axes (size, design, sale, lab/repair) CYCLE with the index
 * instead of being drawn, so any run of 64 consecutive payloads contains every size x design x sale combination at least once;
 * everything else (field presence, odd values, hostile strings, numbers-as-strings, currencies) is drawn from the seeded generator.
 *
 * The shapes follow what the web really sends (src/utils/desktop/payloads.js, BarcodePanelTab, Quick Add, the order pages): the
 * envelope repeats barcode/title/price/currency/salePrice/isSale/regular_price/prints/design/size outside `barcodefinal`, a DYMO
 * `barcodefinal` carries `printer: 'dymo'`, and lab labels read the OUTER barcode and title.
 *
 * No private-use characters (U+E000..U+F8FF) are ever produced: the oracle uses them as placeholders.
 */

/** mulberry32: a tiny, well-distributed 32-bit generator. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    /** entries: [[weight, value], ...] */
    weighted(entries) {
      const total = entries.reduce((sum, [weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [weight, value] of entries) {
        roll -= weight;
        if (roll < 0) return value;
      }
      return entries[entries.length - 1][1];
    },
  };
  return rng;
}

const SIZE_CLASSES = ['32x57', '70x54', '25x25', 'odd'];
const DESIGN_CLASSES = ['1', '2', '3', '4', '7', 'repair', 'nan', 'mixed'];

const TITLES = [
  'iPhone 13 128GB', 'Samsung Galaxy S23 Ultra', 'MacBook Air 13 M1', 'iPad Air 5th Gen', 'Apple Watch Series 8', 'USB-C Cable 1m', 'Phone Case Clear',
  'Screen Protector', 'AirPods Pro 2', 'Charger 20W', 'Box 7', 'Redmi Note 12 Pro Plus 5G 256GB Midnight Black', 'Nokia 3310',
];
const STORAGE = ['16GB', '32GB', '64GB', '128GB', '256GB', '512GB', '1TB'];
const NETWORK = ['Unlocked', 'EE', 'O2', 'Vodafone', 'Three', 'Locked'];
const RAM = ['2GB', '3GB', '4GB', '6GB', '8GB', '16GB', '85%'];
const COLOR = ['Black', 'White', 'Blue', 'Space Grey', 'Gold', 'Midnight Green', 'Repair: 1042'];
const PROCESSOR = ['A15', 'A16 Bionic', 'M1', 'Snapdragon 8 Gen 2', 'Intel i7', 'Ryzen 5', 'cracked back glass'];
const GRADES = ['New', 'A+', 'A', 'B', 'C', 'Refurbished A', 'new', 'A +'];
const WARRANTY = ['12 Months', '6 Months', '1 Year', 'Lifetime', '3 M', '1y', '24 months', 'abc'];

/** Strings that break v1's script or its XML, or that v2 cleans; the point of the whole rewrite. */
const HOSTILE = [
  'MacBook Air 13" M1',
  "O'Brien's phone",
  'Case C:\\temp\\new',
  'Phone `pro` max',
  'Cost ${1+1} total',
  "price $& $1 $$ $' $`",
  '</script><img src=x onerror=alert(1)>',
  'A & B < C > D',
  'line one\nline two',
  'windows\r\nbreak',
  'tab\there',
  'sep\u2028para\u2029end',
  'nul\u0000byte',
  'bell\u0007 del\u007f c1\u0085',
  'emoji \u{1F600} phone \u{1F4F1} case',
  'lone\ud800high',
  'lone\udc00low',
  'nonchar\uffff and \ufffe',
  'caf\u00e9 \u00fcber stra\u00dfe \u01f0 \u0149',
  '\u65e5\u672c\u8a9e\u306e\u30bf\u30a4\u30c8\u30eb',
  '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645',
  '   leading and trailing   ',
  'many     inner     spaces',
  '\u00a0nbsp\u00a0',
  '\u3000wide\u3000',
  '\u00a399.99 sale',
  '\u20ac 10 \u00a5 20',
  "'; alert(1); //",
  '"); label.print("x"); ("',
  '` + dymo.label.framework.getPrinters() + `',
  '\\"\\\\\\n',
  'x'.repeat(2500),
  '\u8bed'.repeat(900),
  ' ',
  '',
];

/** Single odd words: used as barcodes (placed raw in the QR XML of designs 2 and 7). */
const HOSTILE_BARCODES = ['A$&B', 'A$1B', 'A&B', 'A<B>', 'A$$B', 'AB"CD', 'AB`CD`', 'A${x}B', 'A\\B', "A'B", ' AB CD  EF1234 ', 'A\nB', '\u{1F600}ABCDEF', 'AB\u0000CD1234567', ''];

const PRICES = [499.99, 12.5, 0.99, 1299, 99.99000000000001, 0, -3, 1e-7, 7, '499.99', '12.5', '0', '', ' 12.50 ', '12\n', 'CNT-12', '1e3', '0x10', '\u00a35', undefined, null, NaN, true];
const SALE_PAIRS = [
  [499.99, 449.99], ['100.00', '79.50'], [100, 99.996], [100, 99.994], [100, 100], [100, 120], [100, null], ['100', ''], [undefined, 5], [100, undefined], [59, 49],
  ['10.50', '8'], [1e21, 5], [200, 0], [75.5, '70.25'], [null, -5],
];
const CURRENCIES = ['GBP', 'gbp', ' usd ', 'USD', 'AED', 'EUR', '$', '', 'pounds', 'EURO', null, 123, 'JPY ', 'sar', 'us', ' gbp'];
const ODD_SIZES = ['57x32', '', 'abc', undefined, '32X57', ' 25x25', '25x25 ', null, 5, '70x54x', '32x57'];
const NAN_DESIGNS = ['', undefined, 'x', 5, '5', 0, -1, null, '9', 'abc', true, '-', '\u0663', '\uff11'];

/** A text field: mostly a typical value, sometimes hostile, a number, missing, null or empty. */
function pickText(rng, typical, { hostile = 0.1, odd = 0.12 } = {}) {
  const roll = rng.next();
  if (roll < hostile) return rng.pick(HOSTILE);
  if (roll < hostile + odd) {
    return rng.weighted([
      [3, undefined],
      [2, null],
      [2, ''],
      [2, rng.pick([0, 1, 8, 128, 4.5, 20241])],
      [1, rng.pick([true, false])],
      [1, rng.pick([['a', 'b'], { a: 1 }])],
    ]);
  }
  return typeof typical === 'function' ? typical() : typical;
}

function pickBarcode(rng) {
  const roll = rng.next();
  if (roll < 0.08) return rng.pick(HOSTILE_BARCODES);
  if (roll < 0.12) return rng.pick([123456, 9780201633610, 5, undefined, null]);
  const length = rng.weighted([[1, 3], [2, 6], [1, 7], [6, 12], [3, 14], [1, 24]]);
  const alphabet = rng.chance(0.5) ? '0123456789' : 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let value = '';
  for (let i = 0; i < length; i += 1) value += alphabet[rng.int(alphabet.length)];
  return value;
}

function pickDesign(rng, designClass) {
  switch (designClass) {
    case '1': return rng.pick([1, '1']);
    case '2': return rng.pick([2, '2']);
    case '3': return rng.pick([3, '3']);
    case '4': return rng.pick([4, '4']);
    case '7': return rng.pick([7, '7']);
    case 'repair': return rng.pick([undefined, '1', 'repair', 1]);
    case 'nan': return rng.pick(NAN_DESIGNS);
    default: {
      const n = rng.pick([1, 2, 3, 4]);
      return rng.pick([` ${n}`, `${n}abc`, `${n}.9`, n + 0.9, `${n}e0`, `+${n}`, `0${n}`, `${n} `]);
    }
  }
}

function pickSize(rng, sizeClass) {
  return sizeClass === 'odd' ? rng.pick(ODD_SIZES) : sizeClass;
}

function pickCurrency(rng) {
  if (rng.chance(0.55)) return { outer: undefined, inner: undefined };
  const value = rng.pick(CURRENCIES);
  const where = rng.weighted([[4, 'outer'], [3, 'inner'], [2, 'both'], [1, 'conflict']]);
  if (where === 'outer') return { outer: value, inner: undefined };
  if (where === 'inner') return { outer: undefined, inner: value };
  if (where === 'both') return { outer: value, inner: value };
  return { outer: value, inner: rng.pick(CURRENCIES) };
}

function buildRepair(rng) {
  const customValue = () => rng.weighted([[6, rng.pick(['iPhone 13', 'Screen', 'Rush', 'Battery', 'Back glass'])], [1, rng.pick(HOSTILE)], [1, ''], [1, 5], [1, undefined], [1, ['x', 'y']]]);
  const customs = () => {
    const count = rng.int(5);
    return Array.from({ length: count }, () => (rng.chance(0.08) ? null : { field_label: 'f', value: customValue() }));
  };
  const item = () => ({
    product_name: pickText(rng, () => rng.pick(TITLES), { hostile: 0.12, odd: 0.1 }),
    custom_field_value: rng.chance(0.1) ? rng.pick([undefined, 'not an array', null]) : customs(),
    current_price: rng.pick([15, '9.99', 0]),
    product_sn_imei_description: 'never printed',
  });
  const shape = rng.weighted([[5, 'orderItems'], [3, 'orderItem'], [1, 'empty'], [1, 'none']]);
  const fields = {
    orderDate: pickText(rng, '2026-11-19', { hostile: 0.06, odd: 0.1 }),
    customer: rng.chance(0.1) ? undefined : { name: pickText(rng, 'Jo Smith', { hostile: 0.1, odd: 0.1 }), cell_no: pickText(rng, '07123 456789', { hostile: 0.05, odd: 0.1 }) },
    business: rng.chance(0.1) ? undefined : { business_name: pickText(rng, 'T&R Mobile', { hostile: 0.1, odd: 0.1 }), branch_name: pickText(rng, 'Main', { hostile: 0.05, odd: 0.15 }), post_code: 'AB1 2CD' },
  };
  if (shape === 'orderItems') fields.orderItems = Array.from({ length: 1 + rng.int(4) }, item);
  else if (shape === 'orderItem') fields.orderItem = item();
  else if (shape === 'empty') fields.orderItems = [];
  return fields;
}

/**
 * @param {number} seed
 * @param {number} index 0-based
 * @returns {{ payload: object, meta: { index: number, sizeClass: string, designClass: string, sale: boolean, lab: boolean, repair: boolean } }}
 */
function generatePayload(seed, index) {
  const rng = makeRng((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const sizeClass = SIZE_CLASSES[index % SIZE_CLASSES.length];
  const designClass = DESIGN_CLASSES[Math.floor(index / SIZE_CLASSES.length) % DESIGN_CLASSES.length];
  const saleWanted = Math.floor(index / (SIZE_CLASSES.length * DESIGN_CLASSES.length)) % 2 === 1;
  const lab = index % 11 === 5;
  const repair = designClass === 'repair';

  const size = pickSize(rng, sizeClass);
  const design = pickDesign(rng, designClass);
  const currency = pickCurrency(rng);
  // a sale payload: mostly a clean positive difference, but 45% draw from the edge list (equal, reversed, sub-penny, null, missing ...)
  const [regular, sale] = saleWanted && rng.chance(0.4) ? [rng.pick([499.99, 100, '100.00', '10.50', 59]), rng.pick([449.99, 79.5, '8', 49, 25])] : rng.pick(SALE_PAIRS);
  const isSale = saleWanted
    ? rng.weighted([[18, true], [1, 'true'], [1, 1], [1, undefined]])
    : rng.weighted([[17, false], [1, true], [1, 'true'], [1, undefined], [1, null], [1, 0]]);

  const title = pickText(rng, () => rng.pick(TITLES));
  const barcode = pickBarcode(rng);
  const price = rng.chance(0.85) ? rng.pick(PRICES) : saleWanted ? regular : undefined;

  const barcodefinal = {
    printer: 'dymo',
    barcode,
    title,
    price,
    salePrice: sale,
    regular_price: regular,
    isSale,
    prints: rng.pick([1, 2, 5, '3']),
    design: rng.chance(0.7) ? design : undefined,
  };
  if (rng.chance(0.75)) barcodefinal.storage = pickText(rng, () => rng.pick(STORAGE));
  if (rng.chance(0.6)) barcodefinal.network = pickText(rng, () => rng.pick(NETWORK));
  if (rng.chance(0.6)) barcodefinal.ram = pickText(rng, () => rng.pick(RAM));
  if (rng.chance(0.6)) barcodefinal.misc_color = pickText(rng, () => rng.pick(COLOR));
  if (rng.chance(0.6)) barcodefinal.warranty = pickText(rng, () => rng.pick(WARRANTY));
  if (rng.chance(0.75)) barcodefinal.conditionObject = rng.chance(0.08) ? rng.pick([{}, null, 'A+']) : { grade: pickText(rng, () => rng.pick(GRADES), { hostile: 0.06, odd: 0.15 }) };
  const processorKeys = rng.weighted([[4, 'Processor'], [3, 'processor'], [2, 'both'], [4, 'none']]);
  if (processorKeys === 'both') {
    // both keys: `Processor` wins unless it is missing (nullish); an empty or zero `Processor` is a value
    barcodefinal.Processor = rng.pick(['', 'A15', undefined, null, 0, 'X1']);
    barcodefinal.processor = rng.pick(['lower-case cpu', 'M2']);
  } else if (processorKeys === 'Processor') {
    barcodefinal.Processor = pickText(rng, () => rng.pick(PROCESSOR));
  } else if (processorKeys === 'processor') {
    barcodefinal.processor = pickText(rng, () => rng.pick(PROCESSOR));
  }
  if (currency.inner !== undefined) barcodefinal.currency = currency.inner;

  if (repair) {
    barcodefinal.design = 'repair';
    Object.assign(barcodefinal, buildRepair(rng));
  }

  // the envelope repeats fields of the label; a decoy value tells a reader of the wrong object apart
  const decoy = rng.chance(0.5);
  const payload = {
    barcodefinal,
    barcode: decoy ? `OUTER-${barcode}` : barcode,
    title: decoy ? 'OUTER TITLE' : title,
    price: decoy ? 777 : price,
    salePrice: sale,
    isSale,
    regular_price: regular,
    prints: barcodefinal.prints,
    design,
  };
  if (size !== undefined) payload.size = size;
  if (currency.outer !== undefined) payload.currency = currency.outer;

  if (lab) {
    payload.type = 'lab';
    payload.barcode = rng.chance(0.85) ? pickBarcode(rng) : rng.pick(['636400', 'LAB-1', undefined, null, 5]);
    payload.title = rng.chance(0.8) ? pickText(rng, () => rng.pick(['iphone 15 oled screen', 'Battery', 'Charging port flex'])) : rng.pick([undefined, null, '', 'He said "hi"']);
    payload.price = '';
  }

  if (rng.chance(0.03)) {
    // unread properties, even huge ones, must never matter
    const junk = { order: { notes: 'x'.repeat(300_000), items: [{ a: 1 }] }, business: { name: 'z' }, settings: { receipt: 'r'.repeat(10_000) } };
    if (rng.chance(0.5)) Object.assign(payload, junk);
    else Object.assign(barcodefinal, junk);
  }

  return { payload, meta: { index, sizeClass, designClass, sale: saleWanted, lab, repair } };
}

/** @returns {Array<{ payload: object, meta: object }>} */
function generateAll(seed, count) {
  return Array.from({ length: count }, (_, index) => generatePayload(seed, index));
}

module.exports = {
  SIZE_CLASSES,
  DESIGN_CLASSES,
  HOSTILE,
  HOSTILE_BARCODES,
  mulberry32,
  makeRng,
  generatePayload,
  generateAll,
};
