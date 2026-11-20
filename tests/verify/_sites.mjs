// The REAL handlers of the web app's label call sites, cut out of the source with @babel/parser and run on fakes: the ORIGINAL source (git show origin/main:<file>,
// which calls window.electron.sendBarcodeData directly) and the NEW source (the worktree, which calls sendLabel of utils/desktop). Their free names are
// supplied from `scope`, so nothing they read is invented by the harness without being visible here.
import { execFileSync } from 'node:child_process';
import { cutWeb, cutWebOriginal, instantiate, lib, receiptMoney } from './_kit.mjs';

const POS = 'src/pages-sections/vendor/point-of-sale';
export const quietConsole = () => {
  const logs = [];
  return { logs, log: (...a) => logs.push(['log', ...a]), error: (...a) => logs.push(['error', ...a]), warn: (...a) => logs.push(['warn', ...a]), info: () => {}, debug: () => {} };
};
export const spy = () => {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
};

const PRINTER_ON = (type, currency = 'GBP') => ({ label_printer_type: type, user_direct_bar_code_printer: true, print_direct_receipt: true, business_currency: currency });

/**
 * Site definitions. `scope(env, o)` returns every free name of the handler; `call(handler, o)` invokes it as the component does.
 * env = { window, sendLabel, dymoLabelSize, printer ('dymo'|'zebra'), currency, console }
 */
export const SITES = [
  {
    id: 'BarcodeModal',
    file: 'src/components/bar-code-modal/BarcodeModal.jsx',
    fn: 'handlePrint',
    scope: (e, o = {}) => ({
      window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), barCode: o.barCode ?? 'IPH13-0001', prints: o.prints ?? '3', printBarcodes: lib.printBarcodes,
      heading: o.title ?? 'MacBook Air 13" M1', singleProduct: { type: 1, regularPrice: 999 }, variation: { price: 999 }, receiptIsoCode: receiptMoney.receiptIsoCode,
      systemCurrencyExit: { currency: 'GBP' }, dymoOption: o.design ?? '1', sendLabel: e.sendLabel, console: e.console, pdfDownload: () => { throw new Error('the PDF path was used'); },
    }),
    call: (h) => h(),
  },
  {
    id: 'BarcodePanelTab',
    file: `${POS}/pos-buy-orders/product-cards/View/BarcodePanelTab.jsx`,
    fn: 'handlePrint',
    helpers: ['sanitizeBarcode'],
    scope: (e, o = {}) => ({
      setPrinting: spy(), window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), barCode: o.barCode ?? 'IPH13-0001', prints: o.prints ?? '2', printBarcodes: lib.printBarcodes,
      heading: { name: o.title ?? 'iPhone 13 Pro 256GB' }, regular_price: o.regular_price ?? 649, receiptIsoCode: receiptMoney.receiptIsoCode, statePos: { posCurrencyExit: PRINTER_ON(e.printer, e.currency) },
      salePrice: o.salePrice ?? 0, isSale: o.isSale ?? false, misc_color: 'Graphite', variation_col_2: '', network: 'Unlocked', ramOrFallback: o.ram ?? '6GB', sim: 'eSIM', variation_col_4: '',
      storage: o.storage ?? '256GB', variation_col_1: '', warranty: '12 months', conditionObject: { grade: 'A+' }, processorOrFallback: o.Processor ?? 'A15 Bionic',
      dymoOption: o.design ?? '1', sendLabel: e.sendLabel, dymoLabelSize: e.dymoLabelSize, size: o.size ?? '57x35', console: e.console, pdfDownload: () => { throw new Error('the PDF path was used'); },
    }),
    call: (h) => h(),
  },
  {
    id: 'QuickAdd',
    file: `${POS}/topbar/QuickProductWithPurchaseOrder.jsx`,
    fn: 'handlePrint',
    helpers: ['sanitizeBarcode', 'cleanValue'],
    scope: (e, o = {}) => ({
      window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), printBarcodes: lib.printBarcodes, receiptIsoCode: receiptMoney.receiptIsoCode, systemCurrencyExit: { currency: 'GBP' },
      dropdown: { network: [{ value: 1, title: 'Unlocked' }], warranty: [{ value: 6, title: '6 months' }] },
      printSizeAndDesign: { printer_design: o.design ?? 2, printer_size: o.size ?? '70x54' }, sendLabel: e.sendLabel, console: e.console,
      generateDocDefinition: () => { throw new Error('the PDF path was used'); }, loadPdfMake: async () => { throw new Error('the PDF path was used'); },
    }),
    call: (h, o = {}) => h(o.prints ?? 3, {
      product_no: o.product_no ?? 'SN-35123456789012', name: o.title ?? 'Samsung Galaxy S23 128GB', regular_price: 499.99, sale_price: 0, is_on_sale: false, network: 1, sim: '', misc_color: 'Cream',
      ram: o.ram ?? '8GB', storage: '128GB', processor: o.processor ?? 'Snapdragon 8 Gen 2', warranty: 6, conditionObject: { grade: 'B' },
    }),
  },
  {
    id: 'BarcodePDFGenerator(items)',
    file: `${POS}/commonComponent/BarcodePDFGenerator.jsx`,
    fn: 'handlePrint',
    scope: (e, o = {}) => ({
      window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), barCode: 'RPR-5521', orderItems: o.orderItems ?? [
        { id: 1, product_name: o.title ?? 'iPhone 12 screen', device: 'iPhone 12', job: 'Screen', remarks: 'Cracked', custom_field_value: [] },
        { id: 2, product_name: 'Battery', device: 'iPhone 12', job: 'Battery', remarks: '', custom_field_value: [{ field_label: 'x', value: 'y', module_name: 'Order' }] },
        { id: 3, product_name: 'Back glass', device: 'iPhone 12', job: 'Glass', remarks: 'Chipped', custom_field_value: [] },
      ], orderDate: '19/11/2026', customer: { full_name: 'A. Customer', cell_no: '07123456789' },
      business: { business_name: 'Gadgets Shop', branch_name: 'Main St', business_address: '1 Road', post_code: 'AB1 2CD' }, printBarcodes: lib.printBarcodes, sendLabel: e.sendLabel,
      generatePDF: () => { throw new Error('the PDF path was used'); },
    }),
    call: (h) => h(),
  },
  {
    id: 'BarcodePDFGenerator(single)',
    file: `${POS}/commonComponent/BarcodePDFGenerator.jsx`,
    fn: 'handlePrint',
    scope: (e) => ({
      window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), barCode: 'ABC-123456', orderItems: false, orderDate: undefined, customer: null, business: null,
      printBarcodes: lib.printBarcodes, sendLabel: e.sendLabel, generatePDF: () => { throw new Error('the PDF path was used'); },
    }),
    call: (h) => h(),
  },
  {
    id: 'BoxLabelPrint',
    file: 'src/pages-sections/vendor/container-shipments/BoxLabelPrint.jsx',
    fn: 'printViaDymo',
    helpers: ['sanitizeBarcode'],
    only: 'dymo',
    scope: (e, o = {}) => ({
      window: e.window, box: { box_no: 'BX-0042', box_label: o.title ?? '' }, containerNo: o.containerNo ?? 'MSKU1234567', posCurrencyExit: PRINTER_ON('dymo', e.currency), sendLabel: e.sendLabel,
    }),
    call: (h) => h(),
  },
  ...[
    ['sell', 'src/pages-sections/vendor/orders/sell/OrderDetails.jsx', 'handlePrintTradeInLabel'],
    ['buy', 'src/pages-sections/vendor/orders/buy/OrderDetails.jsx', 'handlePrintSaleLabel'],
    ['repair', 'src/pages-sections/vendor/orders/repair/OrderDetails.jsx', 'handlePrintRepairLabel'],
  ].map(([kind, file, fn]) => ({
    id: `OrderDetails(${kind})`,
    file,
    fn,
    scope: (e, o = {}) => {
      const setter = spy();
      return {
        window: e.window, posCurrencyExit: PRINTER_ON(e.printer, e.currency), enqueueSnackbar: e.enqueueSnackbar, orderData: {
          sub_order_no: 'SO-10492', User: { first_name: 'Jo', last_name: o.lastName ?? 'Bloggs' }, Order: { trade_in_payment_type: 'cash', Return_address: { first_name: 'Jo', last_name: o.lastName ?? 'Bloggs' }, Shipping_address: { first_name: 'Jo', last_name: o.lastName ?? 'Bloggs' } },
        }, setPrintingTradeInLabelId: setter, setPrintingSaleLabelId: setter, setPrintingRepairLabelId: setter, receiptIsoCode: receiptMoney.receiptIsoCode,
        statePos: { posCurrencyExit: PRINTER_ON(e.printer, e.currency) }, printBarcodes: lib.printBarcodes, sendLabel: e.sendLabel,
      };
    },
    call: (h, o = {}) => h({ id: 1, product_sn_imei_no: '356938035643809', product_name: o.title ?? 'iPhone 12 mini', current_price: 19.99, cash_trade_in_value: 19.99, voucher_trade_in_value: 21, quantity: 3 }),
  })),
  {
    id: 'AppointmentDetail',
    file: 'src/pages-sections/vendor/orders/repair/apointmentListAndDetail/appointmentDetail.jsx',
    fn: 'handlePrintAppointmentLabel',
    scope: (e, o = {}) => ({
      window: e.window, statePos: { posCurrencyExit: PRINTER_ON(e.printer, e.currency) }, enqueueSnackbar: e.enqueueSnackbar,
      appointmentDetail: { appointment_no: 'APT-2231', product_name: o.title ?? 'iPad Pro 12.9" screen repair', first_name: 'Sam', last_name: "O'Neil" },
      setPrintingAppointmentLabel: spy(), printBarcodes: lib.printBarcodes, sendLabel: e.sendLabel,
    }),
    call: (h) => h(),
  },
];

/** Builds the callable handler of a site from the ORIGINAL ('old') or the NEW ('new') source, with its helpers. */
export function buildHandler(site, source, env, o = {}) {
  const cut = (name) => (source === 'old' ? cutWebOriginal(site.file, name, execFileSync) : cutWeb(site.file, name));
  const helperScope = {};
  for (const helper of site.helpers || []) helperScope[helper] = instantiate(cut(helper), {});
  const scope = { ...site.scope(env, o), ...helperScope };
  return instantiate(cut(site.fn), scope);
}
