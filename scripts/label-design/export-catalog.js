#!/usr/bin/env node
'use strict';

/**
 * Writes the LABEL CATALOG the dashboard uses to draw a preview of the label before it is printed:
 *
 *   node scripts/label-design/export-catalog.js [out.json]      (default: docs/label-design/catalog.json)
 *
 * For every label size and design it runs the REAL plan (src/main/printing/dymo/plan.js) with marker values and records which object of which template
 * receives which field (title, spec 1..5, price, barcode, ...), next to the geometry of that template (docs/label-design/geometry.json, written by
 * relayout.py). So the preview shows each field where the Desktop app really puts it, and it cannot drift from the templates: run this again after
 * any change to a template or to plan.js (tests/dymo/catalog.test.js fails when the committed catalog is out of date).
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildLabelPlan, TEMPLATES } = require('../../src/main/printing/dymo/plan');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'label-design', 'catalog.json');
const geometry = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'label-design', 'geometry.json'), 'utf8'));

/**
 * The designs a person can choose, in the order the picker shows them, grouped for the picker.
 *   hasSale     the design has a sale variant (was / OFF captions) the preview can show
 *   onlyOnSale  the design is meant for a product on sale: a product that is not on sale prints the price tag (design 10)
 *   since       the label catalog version of the Desktop app that first prints it (the app tells the dashboard its version: window.desktop.labelCatalogVersion)
 *   kind        'product' (a product or stock item) or 'repair' (a repair order item)
 */
const DESIGNS = [
  { id: 1, key: 'name-details-barcode', group: 'Full label', name: 'Name + details + barcode', hint: 'Name, condition, storage and other details, price, warranty and a barcode. The standard label.', hasSale: true, since: 0, kind: 'product' },
  { id: 2, key: 'name-details-qr', group: 'Full label', name: 'Name + details + QR', hint: 'The same details with a QR code instead of the barcode.', hasSale: true, since: 0, kind: 'product' },
  { id: 10, key: 'price-tag', group: 'Shelf and window', name: 'Price tag', hint: 'Name and a very large price with the condition and warranty. For the shelf or the window.', hasSale: false, since: 1, kind: 'product' },
  { id: 13, key: 'sale-tag', group: 'Shelf and window', name: 'Sale tag', hint: 'The old price struck through, the saving and the new price. A product that is not on sale prints the price tag.', hasSale: true, onlyOnSale: true, since: 1, kind: 'product' },
  { id: 12, key: 'accessory-tag', group: 'Accessories', name: 'Accessory tag', hint: 'Name, two detail lines (colour, fits ...), price and barcode. For cases, chargers and cables.', hasSale: false, since: 1, kind: 'product' },
  { id: 8, key: 'name-price-barcode', group: 'Simple', name: 'Name + price + barcode', hint: 'Name, a large price and a barcode.', hasSale: false, since: 1, kind: 'product' },
  { id: 9, key: 'name-price-qr', group: 'Simple', name: 'Name + price + QR', hint: 'Name, a large price and a QR code.', hasSale: false, since: 1, kind: 'product' },
  { id: 5, key: 'name-barcode', group: 'Simple', name: 'Name + barcode', hint: 'Only the name and a barcode.', hasSale: false, since: 1, kind: 'product' },
  { id: 6, key: 'name-qr', group: 'Simple', name: 'Name + QR', hint: 'Only the name and a QR code.', hasSale: false, since: 1, kind: 'product' },
  { id: 11, key: 'serial-label', group: 'Devices', name: 'IMEI / serial label', hint: 'Model, two details and the IMEI or serial as a large barcode and in full digits. For stock rooms and drawers.', hasSale: false, since: 1, kind: 'product' },
  { id: 3, key: 'barcode-price', group: 'Small stickers', name: 'Barcode + price (2 stickers)', hint: 'Two small stickers on one label: barcode and price only.', hasSale: false, since: 0, kind: 'product' },
  { id: 4, key: 'qr-price', group: 'Small stickers', name: 'QR + price (3 stickers)', hint: 'Three small stickers on one label: QR code and price only.', hasSale: false, since: 0, kind: 'product' },
  { id: 'repair', key: 'repair-ticket', group: 'Repairs', name: 'Repair label', hint: 'Device, three custom fields, customer, phone, business, date and a QR code.', hasSale: false, since: 0, kind: 'repair' },
  { id: 'repair-bag', key: 'repair-bag', group: 'Repairs', name: 'Repair bag tag', hint: 'Customer name, phone and job number large enough to read on a bagged device, with a QR code.', hasSale: false, since: 1, kind: 'repair' },
];

/** The label catalog version of this release: raise it whenever a design is added, and set `since` of the new designs to it. The Desktop app tells the dashboard (window.desktop.labelCatalogVersion). */
const CATALOG_VERSION = 1;

const MARK = { title: 'TTL', barcode: 'BCD1234567890', warranty: 'WRT', specs: ['SP1', 'SP2', 'SP3', 'SP4', 'SP5'], price: 111, regular: 333, sale: 222 };

function product(sale) {
  return { printer: 'dymo', title: MARK.title, barcode: MARK.barcode, price: sale ? MARK.regular : MARK.price, regular_price: sale ? MARK.regular : MARK.price, salePrice: sale ? MARK.sale : 0, isSale: sale, warranty: MARK.warranty, specs: MARK.specs, currency: 'GBP' };
}

const repairData = (design = 'repair') => ({
  printer: 'dymo', design, barcode: MARK.barcode, orderDate: 'DATE1', customer: { name: 'CUS1', cell_no: 'PHN1' }, business: { business_name: 'BIZ1', branch_name: 'BRN1' },
  orderItem: { product_name: 'ITM1', custom_field_value: [{ value: 'CF1' }, { value: 'CF2' }, { value: 'CF3' }] },
});

/** name -> role, read from the values the plan wrote (markers identify the field). */
function rolesOf(labelPlan) {
  const roles = {};
  for (const op of labelPlan.ops) {
    const v = String(op.value);
    let role = null;
    if (op.kind === 'qr' || op.kind === 'qr-embed') role = 'qr';
    else if (v.includes('ITM1')) role = 'repairItem';
    else if (v === 'CF1') role = 'custom1';
    else if (v === 'CF2') role = 'custom2';
    else if (v === 'CF3') role = 'custom3';
    else if (v === 'CUS1') role = 'customer';
    else if (v === 'PHN1') role = 'phone';
    else if (v === 'DATE1') role = 'date';
    else if (v.includes('BIZ1')) role = 'business';
    else if (v.includes('OFF')) role = 'off';
    else if (v.includes('WRT')) role = 'warranty';
    else if (/^SP[1-5]$/.test(v)) role = `spec${v.slice(2)}`;
    else if (v.includes(MARK.title)) role = 'title';
    else if (v.includes('333') && v.includes('£')) role = 'was';
    else if (v.includes('£')) role = 'price';
    else if (v === MARK.barcode) role = op.name.startsWith('BarcodeObject') || op.name === 'BARCODE' ? 'barcode' : 'barcodeFull';
    else if (v.includes('*') || v === MARK.barcode.slice(-6)) role = v.startsWith('**') && v.length === 8 ? 'barcodeShort' : 'barcodeText';
    else if (v === '') role = 'blank';
    else role = 'text';
    roles[op.name] = role;
  }
  return roles;
}

const used = new Set();
const entry = (labelPlan) => {
  used.add(labelPlan.templateFile);
  return { template: labelPlan.templateFile, roles: rolesOf(labelPlan) };
};

const plans = {};
for (const size of ['25x25', '32x57', '70x54']) {
  plans[size] = {};
  for (const design of DESIGNS) {
    if (design.kind === 'repair') {
      plans[size][design.id] = { plain: entry(buildLabelPlan({ size, barcodefinal: repairData(design.id) }).plans[0]) };
      continue;
    }
    const plain = buildLabelPlan({ size, design: design.id, barcodefinal: product(false) }).plans[0];
    plans[size][design.id] = { plain: entry(plain) };
    if (design.hasSale) plans[size][design.id].sale = entry(buildLabelPlan({ size, design: design.id, barcodefinal: product(true) }).plans[0]);
  }
}

const templates = {};
for (const file of [...used].sort()) {
  if (!geometry[file]) throw new Error(`${file} is used by a plan but has no geometry: run python3 scripts/label-design/relayout.py first`);
  templates[file] = geometry[file];
}

const catalog = {
  schemaVersion: 1,
  catalogVersion: CATALOG_VERSION,
  note: 'Generated by scripts/label-design/export-catalog.js from the DYMO templates and the real plan. Millimetres from the top-left corner of the label. Do not edit by hand.',
  sizes: { '25x25': { name: '25 x 25 mm' }, '32x57': { name: '32 x 57 mm (57 x 32)' }, '70x54': { name: '70 x 54 mm' } },
  defaults: { size: '32x57', design: 1 },
  designs: DESIGNS,
  plans,
  templates,
  templateIndex: JSON.parse(JSON.stringify(TEMPLATES)),
};
fs.writeFileSync(OUT, `${JSON.stringify(catalog, null, 1)}\n`);
console.log(`catalog: ${DESIGNS.length} designs x 3 sizes, ${Object.keys(templates).length} templates -> ${OUT}`);
