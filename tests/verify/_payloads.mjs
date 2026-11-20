// Realistic message builders: each function does what ONE call site of the web app does (read from the source at origin/main and the worktree), including the
// REAL printBarcodes of lib.js for `barcodefinal`, and returns the object the site hands to sendBarcodeData (old web) / sendLabel (new web).
import { lib, receiptMoney } from './_kit.mjs';

export const POS_STATE = {
  gbp: { posCurrencyExit: { business_currency: 'GBP', label_printer_type: 'dymo', user_direct_bar_code_printer: true, print_direct_receipt: true } },
  aed: { posCurrencyExit: { business_currency: 'AED', label_printer_type: 'dymo', user_direct_bar_code_printer: true, print_direct_receipt: true } },
  none: { posCurrencyExit: { label_printer_type: 'dymo', user_direct_bar_code_printer: true }, systemCurrencyExit: { currency: 'USD' } },
};
export const iso = (state) => receiptMoney.receiptIsoCode(state);

/** BarcodeModal.jsx handlePrint (one label of the `prints` loop). */
export async function modal(printer, o = {}) {
  const { barCode = 'IPH13-0001', heading = 'iPhone 13 128GB', price = 599, state = POS_STATE.gbp, prints = 2, dymoOption = '1' } = o;
  const currency = iso(state);
  const barcodefinal = await lib.printBarcodes({ printer, barcode: barCode, title: heading, price, currency, prints, design: dymoOption });
  return { barcodefinal, barcode: barCode, title: heading, price, currency, prints, design: dymoOption };
}

/** BarcodePanelTab.jsx handlePrint. `Processor` is capitalised here. `size` is the shared PDF/DYMO size state. */
export async function panel(printer, o = {}) {
  const {
    barCode = 'IPH13-0001', name = 'iPhone 13 Pro 256GB', regular_price = 649, salePrice = 0, isSale = false, state = POS_STATE.gbp, prints = 1, dymoOption = '1',
    size = '32x57', misc_color = 'Graphite', network = 'Unlocked', ram = '6GB', sim = 'eSIM', storage = '256GB', warranty = '12 months',
    conditionObject = { grade: 'A+' }, Processor = 'A15 Bionic', dymoSize, // dymoSize: what the NEW web sends (dymoLabelSize(size)); the old web sent `size` as stored
  } = o;
  const currency = iso(state);
  const barcodefinal = await lib.printBarcodes({
    printer, barcode: barCode, title: name, price: regular_price, currency, salePrice, isSale, regular_price, prints, misc_color, network, ram, sim, storage, warranty, conditionObject, Processor, design: dymoOption,
  });
  return {
    barcodefinal, barcode: barCode, title: name, price: regular_price, currency, salePrice, isSale, regular_price, prints, design: dymoOption,
    size: dymoSize !== undefined ? dymoSize : size,
  };
}

/** QuickProductWithPurchaseOrder.jsx handlePrint (a label of the serial loop). `processor` is lower case here. */
export async function quickAdd(printer, o = {}) {
  const {
    product_no = 'SN-35123456789012', name = 'Samsung Galaxy S23 128GB', regular_price = 499.99, sale_price = 0, is_on_sale = false, state = POS_STATE.gbp, prints = 3,
    network = 'Unlocked', sim = '', misc_color = 'Cream', ram = '8GB', storage = '128GB', processor = 'Snapdragon 8 Gen 2', warranty = '6 months',
    conditionObject = { grade: 'B' }, design = 1, size = '32x57',
  } = o;
  const currency = iso(state);
  const barcodefinal = await lib.printBarcodes({
    printer, barcode: product_no, title: name, price: regular_price, currency, salePrice: sale_price, isSale: is_on_sale, regular_price, prints, network, sim, misc_color, ram, storage, processor, warranty, conditionObject, design,
  });
  return { barcodefinal, barcode: product_no, title: name, price: regular_price, currency, salePrice: sale_price, isSale: is_on_sale, regular_price, prints, design, size };
}

/** labItemLabel.js: the lab item label (type "lab"). */
export async function lab(printer, o = {}) {
  const { barcode = '636400', title = 'Screen replacement kit', copies = 1 } = o;
  const data = web_labItemLabelData({ barcode, title, prints: copies });
  const barcodefinal = await lib.printBarcodes({ printer, ...data });
  return { barcodefinal, ...data };
}
// labItemLabelData is not re-exported through the kit to keep the kit small: the same three lines
const asciiOnly = (value) => String(value ?? '').replace(/[^\x00-\x7F]/g, '');
const web_labItemLabelData = ({ barcode, title, prints = 1 }) => ({ barcode: asciiOnly(barcode), title: String(title ?? ''), price: '', prints: Math.max(parseInt(prints, 10) || 1, 1), type: 'lab', design: '1' });

/** BoxLabelPrint.jsx printViaDymo: the box number as barcode, the container number in the price slot, the size "57x32". */
export function box(o = {}) {
  const { box_no = 'BX-0042', box_label = '', containerNo = 'MSKU1234567' } = o;
  const title = box_label || box_no;
  const price = containerNo || '-';
  const barcode = String(box_no || '').replace(/[^\x00-\x7F]/g, '');
  return {
    barcodefinal: {
      printer: 'dymo', barcode, title, price, salePrice: undefined, isSale: false, regular_price: price, prints: 1, misc_color: undefined, network: undefined, ram: undefined, sim: undefined,
      storage: undefined, warranty: undefined, conditionObject: undefined, Processor: undefined, design: '1',
    },
    barcode, title, price, salePrice: undefined, isSale: false, regular_price: price, prints: 1, design: '1', size: '57x32',
  };
}

/** The inspection labels of the order screens: sell (trade-in), buy (sale), repair. Same shape, different text. */
export async function orderLabel(kind, printer, o = {}) {
  const { item = { id: 1, product_sn_imei_no: '356938035643809', product_name: 'iPhone 12 mini', current_price: 129.99, quantity: 1 }, sub_order_no = 'SO-10492', customerName = 'Jo Bloggs', state = POS_STATE.gbp } = o;
  const barcodeValue = item.product_sn_imei_no || String(sub_order_no);
  const itemTotal = (item.current_price || 0) * (item.quantity || 1);
  const storage = { sell: `Trade-In: ${sub_order_no}`, buy: `Sale: ${sub_order_no}`, repair: `Repair: ${sub_order_no}` }[kind];
  const currency = iso(state);
  const payload = { printer, barcode: barcodeValue, title: item.product_name || '', price: itemTotal, currency, regular_price: itemTotal, salePrice: 0, isSale: false, prints: 1, storage, misc_color: customerName, design: '1' };
  const barcodefinal = await lib.printBarcodes(payload);
  return { barcodefinal, barcode: barcodeValue, title: payload.title, price: itemTotal, currency, salePrice: 0, isSale: false, regular_price: itemTotal, prints: 1, design: '1', size: '32x57' };
}

/** appointmentDetail.jsx: no currency, price 0. */
export async function appointment(printer, o = {}) {
  const { appointment_no = 'APT-2231', product_name = 'iPad Pro 12.9" screen repair', first_name = 'Sam', last_name = "O'Neil" } = o;
  const customerName = [first_name, last_name].filter(Boolean).join(' ');
  const payload = { printer, barcode: appointment_no, title: product_name || '', price: 0, regular_price: 0, salePrice: 0, isSale: false, prints: 1, storage: `Appointment: ${appointment_no}`, misc_color: customerName, design: '1' };
  const barcodefinal = await lib.printBarcodes(payload);
  return { barcodefinal, barcode: appointment_no, title: payload.title, price: 0, salePrice: 0, isSale: false, regular_price: 0, prints: 1, design: '1', size: '32x57' };
}

/** BarcodePDFGenerator.jsx, one item of the repair loop: design "repair", ONE orderItem per message (the web loops the items itself). */
export async function repairItem(printer, o = {}) {
  const {
    barCode = 'RPR-5521', orderDate = '19/11/2026', customer = { full_name: 'A. Customer', cell_no: '07123456789' },
    business = { business_name: 'Gadgets Shop', branch_name: 'Main St', business_address: '1 Road', post_code: 'AB1 2CD' },
    item = { id: 9, product_name: 'iPhone 12 screen', current_price: 79, job: 'Screen', device: 'iPhone 12', remarks: 'Cracked', custom_field_value: [] },
  } = o;
  // syncCustomFields of the component, in short: job/device/remarks become custom fields, device first
  const fields = [];
  for (const key of ['device', 'job', 'remarks']) if (item[key] !== undefined) fields.push({ field_label: key, value: item[key], module_name: 'Order', meta_data: { pending: true, process: true, completed: true } });
  const updated_item = { ...item, custom_field_value: fields };
  const common = {
    barcode: barCode, orderItem: updated_item, design: 'repair', orderDate,
    customer: { name: customer?.full_name || '', cell_no: customer?.cell_no || '' },
    business: { business_name: business?.business_name, branch_name: business?.branch_name, business_address: business?.business_address, post_code: business?.post_code },
  };
  const barcodefinal = await lib.printBarcodes({ printer, ...common });
  return { barcodefinal, ...common };
}

/** BarcodePDFGenerator.jsx: no orderItems, a single barcode. */
export async function singleBarcode(printer, barCode = 'ABC-123456') {
  const barcodefinal = await lib.printBarcodes({ printer, barcode: barCode });
  return { barcodefinal, barcode: barCode };
}

// ---- receipts -----------------------------------------------------------------------------------------------------------------------------
export const sampleOrder = () => ({
  id: 4411,
  cart_no: 'CN-4411',
  created_at: '2026-11-19T14:32:10.000Z',
  booking_at: '2026-11-19T14:32:10.000Z',
  User: { first_name: 'Ann', last_name: 'Till' },
  Order_items: [{ Product: { name: 'USB-C cable' }, quantity: 2, current_price: 5, item_discount: 0, after_discount_item_total_price: 10, is_replacement: false, is_return: false, is_trade_in: false }],
  sub_total: 10, grand_total: 10, total_amount_received: 10, cash: 10, credit_card: 0, bank: 0, cash_received: 10,
  notes: 'N'.repeat(12 * 1024),
});
export const sampleBusiness = () => ({ id: 3, business_name: 'Gadgets Shop', business_address: '1 Road', post_code: 'AB1 2CD', business_currency: 'GBP', business_meta_data: { sell_print_data: {}, repair_print_data: {} } });
export const sampleSettings = () => ({ receipt_paper_size: '80mm', print_direct_receipt: true, user_direct_bar_code_printer: true, label_printer_type: 'dymo', business_currency: 'GBP' });

/** The receipt the web builds for a sale (REAL generateAndPrintReceipt). */
export async function saleReceiptBytes() {
  return lib.generateAndPrintReceipt({ order: sampleOrder(), business: sampleBusiness(), businessData: sampleBusiness().business_meta_data, settings: sampleSettings(), isDuplicate: false });
}
