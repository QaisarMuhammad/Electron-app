'use strict';

/**
 * The label plan: which template a DYMO message prints on and which value goes into which object (SPEC 9.4, 9.4a).
 *
 * This is v1's `send-barcode-data` branch logic (size x design x sale x lab x repair) without the script strings:
 * the output is data. `script.js` turns a plan into the script that runs in the hidden window.
 *
 * Where v1 is reproduced exactly, the ORDER of the operations is v1's order too. The only deliberate differences
 * (SPEC 9.4 (a)-(e)):
 *  (a) the price symbol comes from the currency code (`currencySymbol`), not a hard-coded pound sign;
 *  (b) the processor is read from `Processor ?? processor`;
 *  (c) an empty condition prints no "GRADE " entry;
 *  (d) every value is cleaned (line breaks, control characters, runs of spaces) and carried as data, so quotes,
 *      backslashes, backticks and `${}` print as typed; every value is coerced with String() (null -> '');
 *  (e) an unlisted design (NaN) with a sale prints the design-1 sale label instead of nothing, and at 70x54
 *      prints the 70x54 design-1 template instead of the 32x57 one.
 *  Two clarifications that are not in the list: a design number 7 sent directly is unlisted like 5 (v1 opened the
 *  32x57 template with the design-7 fill, which names objects that template does not have, so it never printed; design
 *  7 still exists as design 2 on sale), and a repair message with an empty `orderItems` list is INVALID_PAYLOAD (v1
 *  printed nothing, silently).
 *
 * Pure module: no electron, no fs.
 */

const { currencySymbol: defaultCurrencySymbol } = require('../currency');
const { toText, cleanText, truncateText, readField, maskBarcodeText, maskBarcodeShort, buildSpecs, cleanSpecList } = require('../labelText');

/** A repair message prints one label per order item; no real order has more. */
const MAX_LABELS_PER_MESSAGE = 100;
/** The label text a message may carry, in UTF-8 bytes (SPEC 12: the limit applies to the fields read). */
const MAX_LABEL_BYTES = 256 * 1024;

/** The label data cannot be printed; `code` is the ERROR_CODES value the service answers with. */
class LabelPayloadError extends Error {
  /** @param {string} message plain English, shown to the cashier */
  constructor(message) {
    super(message);
    this.name = 'LabelPayloadError';
    this.code = 'INVALID_PAYLOAD';
  }
}

/** Template file names (in the labels folder). `mukltipleBarcode` is spelled like that in the files. */
const TEMPLATES = Object.freeze({
  lab: 'labitemdesign.dymo',
  // one repair label per label size (the 70x54 one used to print on the small 32x57 template, and 25x25 printed the product QR label)
  repair: Object.freeze({ '25x25': '25_25_repair.dymo', '32x57': 'LabeldesignRepair.dymo', '70x54': '70_54_LabeldesignRepair.dymo' }),
  '25x25': Object.freeze({ barcode: '25_25_barcode.dymo', qr: '25_25_qrcode.dymo' }),
  '32x57': Object.freeze({
    design1: 'Labeldesign1_1.dymo',
    sale: 'Labeldesign_sale.dymo',
    design2: 'Labeldesign2.dymo',
    design2Sale: 'Labeldesign3.dymo',
    design3: 'mukltipleBarcode.dymo',
    design4: 'multipleQRCODE.dymo',
  }),
  '70x54': Object.freeze({
    design1: '70_54_Labeldesign1_2_22.dymo',
    sale: '70_54_Labeldesign_sale.dymo',
    design2: '70_54_Labeldesign2.dymo',
    design2Sale: '70_54_Labeldesign3.dymo',
    design3: '70_54_mukltipleBarcode.dymo',
    design4: '70_54_multipleQRCODE.dymo',
  }),
});

/** The text objects the spec list fills, in order. */
const SPEC_SLOTS = Object.freeze(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function toNumber(value) {
  try {
    return Number(value);
  } catch {
    return NaN;
  }
}

/** v1: `price !== "" && price > 0`. */
const isPositive = (value) => value !== '' && toNumber(value) > 0;

/** The price as printed ("£12.99"), or '' when there is no price above zero (a non-numeric one, such as a container number, prints nothing). */
const priceText = (bf, symbol) => (isPositive(bf.price) ? `${symbol}${readField(bf.price)}` : '');

/**
 * Builds the operations of one message. Every value goes through here: cleaned, cut to 2 KB, and counted against the
 * 256 KB budget of the whole message.
 */
function createOps() {
  let bytes = 0;
  const make = (kind, name, value) => {
    const text = truncateText(cleanText(value));
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_LABEL_BYTES) throw new LabelPayloadError('The label has too much text to print.');
    return { kind, name, value: text };
  };
  return {
    text: (name, value) => make('text', name, value),
    qr: (name, value) => make('qr', name, value),
    embed: (name, value) => make('qr-embed', name, value),
  };
}

/** The fields a product label (not lab, not repair) reads from `barcodefinal`, already prepared. */
function readProduct(bf, symbol) {
  const barcode = readField(bf.barcode);
  const processor = readField(bf.Processor ?? bf.processor);
  const isSale = bf.isSale === true;
  const difference = toNumber(bf.regular_price) - toNumber(bf.salePrice);
  // v1: off = (isSale && difference > 0) ? difference.toFixed(2) : 0, and the sale test is `isSale && off > 0`,
  // so a difference below half a penny ("0.00") is not a sale. Kept.
  const off = isSale && difference > 0 ? difference.toFixed(2) : null;
  const warranty = toText(bf.warranty);
  return {
    title: bf.title,
    barcode,
    masked: maskBarcodeText(barcode),
    short: maskBarcodeShort(barcode),
    processor,
    price: priceText(bf, symbol),
    warranty: warranty.length > 3 ? readField(`${warranty} WARRANTY`).toUpperCase() : '',
    // the dashboard chooses and orders the lines for the kind of device (phone, laptop, tablet, accessory) and sends them as `specs`; an older
    // dashboard sends the separate fields and the fixed order below is used
    specs: Array.isArray(bf.specs) ? cleanSpecList(bf.specs) : buildSpecs({
      grade: bf.conditionObject?.grade,
      storage: bf.storage,
      network: bf.network,
      ram: bf.ram,
      processor,
      color: bf.misc_color,
    }),
    sale: off !== null && Number(off) > 0,
    salePrice: `${symbol}${readField(bf.salePrice)}`,
    regularPrice: `${symbol}${readField(bf.regular_price)}`,
    offText: off === null ? '' : `${symbol}${off} OFF`,
  };
}

/** Spec-list ops for the first `count` slots; a slot with no spec prints blank, as in v1. */
const specOps = (ops, specs, count) => SPEC_SLOTS.slice(0, count).map((slot, index) => ops.text(slot, specs[index] || ''));

/** Design 1 (and the default design) on sale: the sale template with was/now/off prices. */
function saleFill(ops, p) {
  return [
    ops.text('ItemNameVal', p.title),
    ...specOps(ops, p.specs, 4),
    ops.text('TextObject11', p.warranty),
    ops.text('TEXT_3', p.salePrice),
    ops.text('TEXT__1', p.offText),
    ops.text('Text_was', p.regularPrice),
    ops.text('BARCODE', p.barcode),
    ops.text('TextObject1', p.masked),
  ];
}

/** Design 1, not on sale: all five spec slots. */
function design1Fill(ops, p) {
  return [
    ops.text('ItemNameVal', p.title),
    ...specOps(ops, p.specs, 5),
    ops.text('TextObject11', p.warranty),
    ops.text('TEXT_3', p.price),
    ops.text('BARCODE', p.barcode),
    ops.text('TextObject1', p.masked),
  ];
}

/** v1's final else (an unlisted design), not on sale: four spec slots, and the RAW processor in TEXT__1. */
function defaultFill(ops, p) {
  return [
    ops.text('ItemNameVal', p.title),
    ...specOps(ops, p.specs, 4),
    ops.text('TextObject11', p.warranty),
    ops.text('TEXT_3', p.price),
    ops.text('TEXT__1', p.processor),
    ops.text('BARCODE', p.barcode),
    ops.text('TextObject1', p.masked),
  ];
}

/** Design 2: name, specs and a QR code (written into the label XML, op kind 'qr-embed'). */
function design2Fill(ops, p) {
  return [
    ops.embed('QRCodeObject0', p.barcode),
    ops.text('ItemNameVal', p.title),
    ...specOps(ops, p.specs, 5),
    ops.text('TextObject11', p.warranty),
    ops.text('TEXT_3', p.price),
    ops.text('Text_barcode', p.masked),
  ];
}

/** Design 7 = design 2 on sale. */
function design7Fill(ops, p) {
  return [
    ops.embed('QRCodeObject0', p.barcode),
    ops.text('ItemNameVal', p.title),
    ...specOps(ops, p.specs, 5),
    ops.text('TextObject11', p.warranty),
    ops.text('TEXT_3', p.salePrice),
    ops.text('TextObject1', p.offText),
    ops.text('TextObject9', p.regularPrice),
    ops.text('Text_barcode', p.masked),
  ];
}

/** Design 3: two barcodes. */
function design3Fill(ops, p) {
  return [
    ops.text('BarcodeObject0', p.barcode),
    ops.text('BarcodeObject1', p.barcode),
    ops.text('TextObject1', p.price),
    ops.text('TextObject12', p.price),
  ];
}

/** Design 4: three QR codes (the `_forceQRCodeUpdate` patch, op kind 'qr'). */
function design4Fill(ops, p) {
  return [
    ops.qr('QRCodeObject0', p.barcode),
    ops.qr('QRCodeObject1', p.barcode),
    ops.qr('QRCodeObject2', p.barcode),
    ops.text('TextObject12', p.price),
    ops.text('TextObject1', p.price),
    ops.text('TextObject2', p.price),
    ops.text('TextObject3', p.short),
    ops.text('TextObject4', p.short),
    ops.text('TextObject5', p.short),
  ];
}

/** The first three custom field values of an order item, by position; an entry whose value has no length gives ''. */
function customFieldValues(item) {
  const entries = Array.isArray(item?.custom_field_value) ? item.custom_field_value : [];
  return [0, 1, 2].map((index) => {
    const value = entries[index]?.value;
    return value?.length > 0 ? toText(value) : '';
  });
}

/** One label per order item (v1 looped the items). v1 read, but never printed, current_price, product_sn_imei_description and post_code: nor does v2. */
function repairLabels(ops, bf, size) {
  const items = Array.isArray(bf.orderItems) ? bf.orderItems : [bf.orderItem];
  if (items.length === 0) throw new LabelPayloadError('The repair label has no items to print.');
  if (items.length > MAX_LABELS_PER_MESSAGE) throw new LabelPayloadError(`A repair label message can print at most ${MAX_LABELS_PER_MESSAGE} labels.`);
  const business = bf.business;
  const customer = bf.customer;
  const orderDate = bf.orderDate || '';
  const barcode = readField(bf.barcode);
  // 25x25 has room for the customer, a QR code and the job number only
  if (size === '25x25') {
    return items.map((item) => ({
      templateFile: TEMPLATES.repair['25x25'],
      ops: [
        ops.text('TextObject2', customer?.name || item?.product_name || ''),
        ops.qr('QRCodeObject2', barcode),
        ops.text('TextObject3', barcode.length > 12 ? maskBarcodeShort(barcode) : barcode),
      ],
    }));
  }
  return items.map((item) => {
    const custom = customFieldValues(item);
    return {
      templateFile: TEMPLATES.repair[size],
      ops: [
        ops.text('ItemNameVal', item?.product_name),
        ops.text('TEXT', custom[0]),
        ops.text('TEXT8', custom[1]),
        ops.text('TEXT9', custom[2]),
        ops.text('TextObject7', ''),
        ops.text('TextObject5', customer?.name || ''),
        ops.text('TextObject6', customer?.cell_no || ''),
        ops.text('TEXT_5', `${toText(business?.business_name)} ${toText(business?.branch_name)}`),
        ops.text('TextObject1', orderDate),
        ops.text('TEXT4', barcode),
        ops.qr('QRCodeObject0', barcode),
      ],
    };
  });
}

/**
 * @typedef {object} LabelPlan
 * @property {string} templateFile   file name in the labels folder
 * @property {Array<{ kind: 'text' | 'qr' | 'qr-embed', name: string, value: string }>} ops
 */

/**
 * Turns a legacy `send-barcode-data` envelope into the labels to print.
 *
 * `payload` is the outer envelope and `payload.barcodefinal` the label data (SPEC 9.4a). Only the fields a label
 * prints are read; the envelope's other properties (whole order, business and settings objects of legacy callers)
 * are never touched. `prints` is never read: the web sends one message per label.
 *
 * @param {object} payload
 * @param {object} [options]
 * @param {(iso: unknown) => string} [options.currencySymbol] defaults to the real currencySymbol
 * @returns {{ plans: LabelPlan[], summary: { size: string, design: (number|string|null), lab: boolean, sale: boolean, labels: number } }}
 * @throws {LabelPayloadError} the data cannot be printed (no label data, a repair message without items, too much text)
 */
function buildLabelPlan(payload, options = {}) {
  const symbolOf = typeof options.currencySymbol === 'function' ? options.currencySymbol : defaultCurrencySymbol;
  if (!isObject(payload)) throw new LabelPayloadError('The label message is empty.');
  const bf = payload.barcodefinal;
  if (!isObject(bf)) throw new LabelPayloadError('The label message has no label data.');

  const ops = createOps();
  const size = payload.size === '25x25' || payload.size === '70x54' ? payload.size : '32x57';
  const design = bf.design === 'repair' ? 'repair' : parseInt(payload.design, 10);
  const designName = Number.isNaN(design) ? null : design;
  const summary = (plans, sale) => ({ plans, summary: { size, design: designName, lab: payload.type === 'lab', sale, labels: plans.length } });

  // Lab item label: its own template, filled from the OUTER barcode and title; nothing else is read.
  if (payload.type === 'lab') {
    const plan = { templateFile: TEMPLATES.lab, ops: [ops.text('BarcodeObject1', payload.barcode), ops.text('TextObject12', payload.title)] };
    return summary([plan], false);
  }

  // A repair label reads only its own fields and needs no currency; every size has its own repair template.
  if (design === 'repair') return summary(repairLabels(ops, bf, size), false);

  const symbol = symbolOf(payload.currency ?? bf.currency);

  // 25x25: designs 1 and 3 print the barcode label, every other value the QR label (a repair design was handled above).
  if (size === '25x25') {
    const barcode = readField(bf.barcode);
    const price = priceText(bf, symbol);
    const plan =
      design === 1 || design === 3
        ? { templateFile: TEMPLATES['25x25'].barcode, ops: [ops.text('BarcodeObject0', barcode), ops.text('TextObject1', price)] }
        : {
            templateFile: TEMPLATES['25x25'].qr,
            ops: [ops.qr('QRCodeObject2', barcode), ops.text('TextObject2', price), ops.text('TextObject3', maskBarcodeShort(barcode))],
          };
    return summary([plan], false);
  }

  const templates = TEMPLATES[size];
  const product = readProduct(bf, symbol);
  let plan;
  if (design === 4) {
    plan = { templateFile: templates.design4, ops: design4Fill(ops, product) };
  } else if (design === 3) {
    plan = { templateFile: templates.design3, ops: design3Fill(ops, product) };
  } else if (design === 2) {
    plan = product.sale
      ? { templateFile: templates.design2Sale, ops: design7Fill(ops, product) }
      : { templateFile: templates.design2, ops: design2Fill(ops, product) };
  } else if (design === 1) {
    plan = product.sale
      ? { templateFile: templates.sale, ops: saleFill(ops, product) }
      : { templateFile: templates.design1, ops: design1Fill(ops, product) };
  } else {
    // an unlisted design (NaN, 5, 7 ...): the design-1 label of the requested size
    plan = product.sale
      ? { templateFile: templates.sale, ops: saleFill(ops, product) }
      : { templateFile: templates.design1, ops: defaultFill(ops, product) };
  }
  return summary([plan], product.sale);
}

module.exports = {
  MAX_LABELS_PER_MESSAGE,
  MAX_LABEL_BYTES,
  TEMPLATES,
  LabelPayloadError,
  buildLabelPlan,
};
