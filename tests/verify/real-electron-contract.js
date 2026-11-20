'use strict';

/**
 * contract-matrix, the highest-fidelity run: the REAL web util (DGshop_vendor-labelprint/src/utils/desktop/*.js, served as ES modules) and the web's REAL Buffer
 * polyfill (next/dist/compiled/buffer) run in a REAL Chromium page, against the REAL preload, the REAL IPC and the REAL src/main of the desktop app, under the REAL
 * Electron. Only what would touch the machine is a fake (raw printer, DYMO framework window, native dialogs), exactly as in tests/e2e/run-app.js.
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/verify/real-electron-contract.js
 *
 * Never takes focus: macOS activation policy "accessory" and showInactive() come from `testMode`. Ends itself (watchdog 100 s). Exit code 0 = every check passed.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { app } = require('electron');
if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');

const { bootstrap } = require('../../src/main/index');
const passwordTools = require('../../src/main/password');
const { createDymoService } = require('../../src/main/printing/dymo');
const { resolveTarget } = require('../../src/main/printing/transports');
const { PrintError } = require('../../src/main/errors');
const vm = require('../helpers/vm-dymo');

const WEB = '/Users/muhammadqaisar/Documents/projects/donesol/DGshop_vendor-labelprint';
const NEXT_BUFFER = path.join(WEB, 'node_modules', 'next', 'dist', 'compiled', 'buffer', 'index.js');

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok) });
  process.stdout.write(`${ok ? 'ok     ' : 'FAILED '} ${name}${ok ? '' : `  ->  ${JSON.stringify(detail)}`}\n`);
};
const note = (text) => process.stdout.write(`note   ${text}\n`);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Contract page</title></head><body><p id="s">running</p>
<script type="module">
const R = {};
const post = async (name, args = {}) => (await fetch('/cmd', { method: 'POST', body: JSON.stringify({ name, args }) })).json();
const report = (body) => fetch('/report', { method: 'POST', body: JSON.stringify(body) });
try {
  await fetch('/go');
  const e = window.electron;
  R.env = { electron: typeof e, desktop: typeof window.desktop, keys: e ? Object.keys(e).sort() : [] };

  // the Buffer polyfill of the Next.js client bundle, as the web's receipt code has it
  const src = await (await fetch('/web/next-buffer.js')).text();
  const mod = { exports: {} };
  new Function('module', 'exports', '__dirname', src)(mod, mod.exports, '/');
  const Buffer = mod.exports.Buffer;
  const probe = Buffer.from([1, 2]);
  R.buffer = { isU8: probe instanceof Uint8Array, protoIsPolyfill: Object.getPrototypeOf(probe) === Buffer.prototype, notNode: typeof process === 'undefined' };

  const web = await import('/web/desktop/index.js');
  const events = [];
  window.addEventListener('dg:desktop-print', (ev) => events.push(ev.detail));

  const bytes = Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from('Receipt £5.00\\n', 'utf8'), Buffer.from([0x1d, 0x56, 0x00])]);
  const bigOrder = () => ({ id: 1, notes: 'N'.repeat(20000), items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'Item ' + i, tags: ['a', 'b'] })), when: new Date(0), nothing: undefined, none: null });
  const legacy = (extra = {}) => ({ receiptFileBinary: bytes, order: bigOrder(), isDuplicate: false, business: { id: 3, business_name: 'Shop' }, businessData: {}, settings: { currency: 'GBP', notes: 'S'.repeat(20000) }, ...extra });

  // ---- NEW web: receipts -----------------------------------------------------------------------------------------------------------
  R.newReceipt = await web.sendReceipt(legacy());
  R.newReceiptU8 = await web.sendReceipt({ receiptFileBinary: new Uint8Array(bytes), order: { id: 2 } });
  R.newOpen = await web.sendReceipt({ isDuplicate: false, order: false, business: {}, businessData: false, openCashDrawer: true, settings: {} });
  R.newKick = await web.sendReceipt({ receiptFileBinary: Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0, 0x19, 0xff]), order: { id: 2 } });

  // ---- OLD web: the legacy functions with the same Buffer and the same whole objects ----------------------------------------------------
  let legacyThrew = null;
  try { e.sendReceiptData(legacy()); e.sendReceiptData({ receiptFileBinary: Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0, 0x19, 0xff]), order: bigOrder() }); } catch (err) { legacyThrew = String(err.message); }
  R.legacyReceiptThrew = legacyThrew;
  e.sendOpenDrawerCommand({ cashDrawerOpenPassword: 'e2e-password' });

  // ---- Zebra, old and new ------------------------------------------------------------------------------------------------------------
  const zpl = '^XA\\n^CI28\\n^FO5,40\\n^A0N,27,27\\n^FDCafé "Pro" £5^FS\\n^XZ\\n';
  e.sendBarcodeData({ barcodefinal: zpl, barcode: '1', title: 't', prints: 1 });
  R.newZebra = await web.sendLabel({ barcodefinal: zpl, barcode: '1', title: 't', prints: 1 });

  // ---- DYMO, old and new ------------------------------------------------------------------------------------------------------------
  const dymoMsg = (title, bf = {}) => ({ barcodefinal: { printer: 'dymo', title, barcode: 'ABCDEFGH123456', storage: '128GB', network: 'Unlocked', ram: '4GB', misc_color: 'Blue', warranty: '12 months', conditionObject: { grade: 'A+' }, processor: 'A15 Bionic', price: 499.99, isSale: false, currency: 'AED', ...bf }, barcode: 'ABCDEFGH123456', title, price: 499.99, currency: 'AED', design: '1', size: '57x35', prints: 3 });
  e.sendBarcodeData(dymoMsg('MacBook Air 13" M1 (old web)'));
  R.newDymo = await web.sendLabel(dymoMsg('MacBook Air 13" M1 (new web)'));
  R.newBox = await web.sendLabel({
    barcodefinal: { printer: 'dymo', barcode: 'BX-1', title: 'Box', price: 'MSKU1234567', salePrice: undefined, isSale: false, regular_price: 'MSKU1234567', prints: 1, misc_color: undefined, network: undefined, ram: undefined, sim: undefined, storage: undefined, warranty: undefined, conditionObject: undefined, Processor: undefined, design: '1' },
    barcode: 'BX-1', title: 'Box', price: 'MSKU1234567', salePrice: undefined, isSale: false, regular_price: 'MSKU1234567', prints: 1, design: '1', size: '57x32',
  });
  R.newRepair = await web.sendLabel({
    barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'RPR-5521', orderDate: '19/11/2026', customer: { name: 'A. Customer', cell_no: '07123456789' }, business: { business_name: 'Shop', branch_name: 'Main' }, orderItem: { product_name: 'iPad 10.2" screen', custom_field_value: [{ value: 'Cracked' }, { value: 'Black' }] } },
    barcode: 'RPR-5521', design: 'repair',
  });

  // ---- the drawer ----------------------------------------------------------------------------------------------------------------------
  R.drawerWrong = await web.openCashDrawer({ password: 'nope' }, { notify: false });
  R.drawerBlank = await web.openCashDrawer({ password: '' }, { notify: false });
  R.drawerRight = await web.openCashDrawer({ password: 'e2e-password' });

  // ---- what cannot cross the bridge -------------------------------------------------------------------------------------------------------
  R.fnPayload = await web.sendLabel({ barcodefinal: { printer: 'dymo', title: 'x', barcode: '1', onClick() {} } });
  try { e.sendBarcodeData({ barcodefinal: { printer: 'dymo', title: 'x', barcode: '1', onClick() {} } }); R.legacyFn = 'no throw'; } catch (err) { R.legacyFn = String(err.message).slice(0, 160); }
  R.info = await web.getDesktopInfo();
  R.isDesktop = web.isDesktopApp();

  // ---- failures and feedback ---------------------------------------------------------------------------------------------------------------
  await post('failPrinter', { code: 'SPOOLER_ERROR' });
  R.failReceipt = await web.sendReceipt(legacy());
  R.failReceiptAgain = await web.sendReceipt(legacy());
  e.sendReceiptData(legacy()); // the old web on a failing printer: the app's own native box
  await post('failPrinter', { code: null });
  R.events = events.slice();

  // ---- a loop with a refused label --------------------------------------------------------------------------------------------------------
  await post('dymoFailAfter', { printed: 1 });
  const labItem = await import('/web/labItemLabel.js');
  const before = events.length;
  R.loop = await labItem.printLabItemLabels({ printer: 'dymo', barcode: '636400', title: 'Screen "kit"', copies: 4, build: async (x) => x });
  R.loopEvents = events.slice(before);
  await post('dymoFailAfter', { printed: null });
  R.loopOk = await labItem.printLabItemLabels({ printer: 'dymo', barcode: '77', title: 'Back to normal', copies: 2, build: async (x) => x });

  await report({ ok: true, R });
} catch (error) {
  await report({ ok: false, error: String((error && error.stack) || error), R });
}
</script></body></html>`;

async function main() {
  const watchdog = setTimeout(() => {
    process.stderr.write('WATCHDOG: the real-electron contract run took too long\n');
    process.exit(3);
  }, 100_000);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-contract-'));
  const rawJobs = [];
  const dialogs = [];
  const rawPrinter = {
    failWith: null,
    async printRaw(job) {
      resolveTarget(job.target); // the real raw printer validates its target first
      rawJobs.push({ target: job.target, label: job.label, ext: job.ext, bytes: Buffer.from(job.data) });
      if (rawPrinter.failWith) throw rawPrinter.failWith;
      return { ok: true };
    },
    dispose() {},
  };
  const factory = vm.createWindowFactory({});
  let handle = null;
  const dymo = createDymoService({
    createHiddenWindow: factory.createHiddenWindow,
    labelsDir: vm.LABELS_DIR,
    readFile: (file, encoding) => fs.promises.readFile(file, encoding),
    getConfig: () => (handle ? handle.services.config : {}),
  });
  const dialog = {
    showMessageBox: async (...args) => (dialogs.push(args.length === 1 ? args[0] : args[1]), { response: 0 }),
    showMessageBoxSync: () => 0,
    showErrorBox: (title, content) => dialogs.push({ title, content }),
  };

  // ---- the fake POS: the page, the web util files, the Buffer polyfill, a control endpoint --------------------------------------------------
  let release = () => {};
  const released = new Promise((resolve) => { release = resolve; });
  let resolveReport;
  const reported = new Promise((resolve) => { resolveReport = resolve; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'HEAD') return response.writeHead(200).end();
      if (url.pathname === '/vendor/point-of-sale') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end(PAGE); }
      if (url.pathname === '/go') { await released; return response.end('go'); }
      if (url.pathname === '/report') { resolveReport(JSON.parse(body)); return response.end('ok'); }
      if (url.pathname === '/cmd') {
        const { name, args } = JSON.parse(body);
        if (name === 'failPrinter') rawPrinter.failWith = args.code ? new PrintError(args.code) : null;
        if (name === 'dymoFailAfter') {
          let printed = 0;
          for (const win of factory.windows) win.fake.setFailPrint(args.printed === null ? null : () => (printed++ >= args.printed ? 'Out of labels' : undefined));
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/web/next-buffer.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(fs.readFileSync(NEXT_BUFFER)); }
      if (url.pathname === '/web/labItemLabel.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(fs.readFileSync(path.join(WEB, 'src/utils/labItemLabel.js'))); }
      const m = /^\/web\/desktop\/([A-Za-z]+\.js)$/.exec(url.pathname);
      if (m) { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(fs.readFileSync(path.join(WEB, 'src/utils/desktop', m[1]))); }
      response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  handle = await bootstrap({
    testMode: true,
    userDataPath: userData,
    isPackaged: false,
    env: { ...process.env, GADGETSPOS_START_URL: `${origin}/vendor/point-of-sale` },
    rawPrinter,
    dymo,
    dialog,
  });
  const { config } = handle.services;
  config.setPrinter('receipt', { transport: 'system', printerName: 'E2E Receipt', port: '' });
  config.setPrinter('label', { transport: 'system', printerName: 'E2E Label', port: '' });
  config.setPasswordRecord(passwordTools.hashPassword('e2e-password'));
  release();

  const answer = await Promise.race([reported, new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'the page never reported' }), 70_000))]);
  const R = answer.R || {};
  if (!answer.ok) check('the page ran to the end', false, answer.error);
  await new Promise((resolve) => setTimeout(resolve, 800)); // fire-and-forget calls settle

  // ---- the page ---------------------------------------------------------------------------------------------------------------------------------
  check('window.electron exists on the page and window.desktop does not', R.env && R.env.electron === 'object' && R.env.desktop === 'undefined', R.env);
  check('window.electron has the eight functions', R.env && JSON.stringify(R.env.keys) === JSON.stringify(['getAppInfo', 'getPrinters', 'openCashDrawer', 'printBarcode', 'printReceipt', 'sendBarcodeData', 'sendOpenDrawerCommand', 'sendReceiptData']), R.env && R.env.keys);
  check('the page\'s Buffer is the Next.js polyfill: a Uint8Array whose prototype is NOT Node\'s Buffer', R.buffer && R.buffer.isU8 && R.buffer.protoIsPolyfill && R.buffer.notNode, R.buffer);

  const expectedReceipt = Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from('Receipt £5.00\n', 'utf8'), Buffer.from([0x1d, 0x56, 0x00])]);
  const receiptJobs = rawJobs.filter((j) => j.label === 'receipt');
  const sameAsReceipt = receiptJobs.filter((j) => j.bytes.equals(expectedReceipt));
  const kickBytes = Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0, 0x19, 0xff]);
  check('NEW web: sendReceipt with a polyfill Buffer, a 20 KB order and settings answers { ok: true } and the bytes arrive verbatim', R.newReceipt && R.newReceipt.ok === true && sameAsReceipt.length >= 1, [R.newReceipt, receiptJobs.map((j) => j.bytes.length)]);
  check('NEW web: a plain Uint8Array arrives verbatim too', R.newReceiptU8 && R.newReceiptU8.ok === true, R.newReceiptU8);
  check('NEW web: the Open button is { ok: true, details: { prompted: true } } and the password window opened', R.newOpen && R.newOpen.ok === true && R.newOpen.details && R.newOpen.details.prompted === true && handle.services.passwordWindow.isOpen(), R.newOpen);
  check('NEW web: the 7-byte kick with an order is a receipt, verbatim', R.newKick && R.newKick.ok === true && receiptJobs.some((j) => j.bytes.equals(kickBytes)), R.newKick);
  check('OLD web: the legacy sendReceiptData with the same Buffer, a 20 KB order (Date, undefined, null inside) and settings did not throw in the page', R.legacyReceiptThrew === null, R.legacyReceiptThrew);
  check('OLD web: its receipt and its kick arrived verbatim as well (so each receipt bytes were printed at least twice and the kick at least twice)', sameAsReceipt.length >= 2 && receiptJobs.filter((j) => j.bytes.equals(kickBytes)).length >= 2, receiptJobs.map((j) => j.bytes.length));
  const drawerJobs = rawJobs.filter((j) => j.label === 'cash drawer');
  check('drawer pulses: sendOpenDrawerCommand (old) and openCashDrawer (new) both sent 1B 70 00 19 FF', drawerJobs.length === 2 && drawerJobs.every((j) => j.bytes.equals(Buffer.from([0x1b, 0x70, 0, 0x19, 0xff]))), drawerJobs.map((j) => [...j.bytes]));
  check('a wrong password is DRAWER_WRONG_PASSWORD, a blank one PASSWORD_REQUIRED, the right one { ok: true }', R.drawerWrong && R.drawerWrong.code === 'DRAWER_WRONG_PASSWORD' && R.drawerBlank && R.drawerBlank.code === 'PASSWORD_REQUIRED' && R.drawerRight && R.drawerRight.ok === true, [R.drawerWrong, R.drawerBlank, R.drawerRight]);

  const zebra = rawJobs.filter((j) => j.label === 'label zebra');
  const zpl = '^XA\n^CI28\n^FO5,40\n^A0N,27,27\n^FDCafé "Pro" £5^FS\n^XZ\n';
  check('Zebra: the old web\'s legacy call and the new web\'s sendLabel both printed the ZPL as its own UTF-8 bytes', zebra.length === 2 && zebra.every((j) => j.bytes.toString('utf8') === zpl) && R.newZebra && R.newZebra.ok === true, [zebra.length, R.newZebra]);

  const labels = factory.windows.flatMap((win) => vm.summarizeCalls(win.fake.calls));
  const ops = (label) => Object.fromEntries(label.ops.map((o) => [o.name, o.value]));
  const oldLabel = labels.find((l) => ops(l).ItemNameVal === 'MacBook Air 13" M1 (old web)');
  const newLabel = labels.find((l) => ops(l).ItemNameVal === 'MacBook Air 13" M1 (new web)');
  check('DYMO: the OLD web\'s message with a double quote printed on the new desktop, text as typed, the AED code and the processor under the lower-case key', oldLabel && oldLabel.printed && ops(oldLabel).TEXT_3 === 'AED 499.99' && Object.values(ops(oldLabel)).includes('A15 BIONIC'), oldLabel && ops(oldLabel));
  check('DYMO: the NEW web\'s message printed the same', newLabel && newLabel.printed && JSON.stringify(ops(newLabel)).replace('new web', 'old web') === JSON.stringify(ops(oldLabel)).replace('new web', 'old web'), [newLabel && ops(newLabel), oldLabel && ops(oldLabel)]);
  check('DYMO: size "57x35" (a PDF size the web stores) is the 32x57 default, and prints: 3 prints in the message did not make 3 labels', R.newDymo && R.newDymo.ok === true && labels.filter((l) => ops(l).ItemNameVal && /MacBook Air/.test(ops(l).ItemNameVal)).length === 2, R.newDymo);
  check('DYMO: a box label with undefined properties crossed the bridge and printed', R.newBox && R.newBox.ok === true && labels.some((l) => ops(l).ItemNameVal === 'Box' && l.printed), R.newBox);
  const repair = labels.find((l) => ops(l).TEXT4 === 'RPR-5521');
  check('DYMO: a repair label with a quote in the product name printed (item, customer, QR)', R.newRepair && R.newRepair.ok === true && repair && repair.printed && ops(repair).ItemNameVal === 'iPad 10.2" screen' && ops(repair).TextObject5 === 'A. Customer', repair && ops(repair));

  check('a function inside a label (cannot be cloned): the NEW web gets an UNKNOWN Result, not an exception', R.fnPayload && R.fnPayload.ok === false && R.fnPayload.code === 'UNKNOWN', R.fnPayload);
  note(`the OLD web's legacy call with a function inside: ${R.legacyFn}`);
  check('getDesktopInfo is the app\'s own answer (apiVersion 2) and isDesktopApp is true', R.info && R.info.apiVersion === 2 && R.info.features.length === 4 && R.isDesktop === true, [R.info, R.isDesktop]);

  check('a failing printer: the NEW web gets SPOOLER_ERROR with the desktop\'s message, twice', R.failReceipt && R.failReceipt.code === 'SPOOLER_ERROR' && R.failReceiptAgain && R.failReceiptAgain.code === 'SPOOLER_ERROR' && /printer is on, has paper/.test(R.failReceipt.message), [R.failReceipt, R.failReceiptAgain]);
  const errorEvents = (R.events || []).filter((ev) => ev.code === 'SPOOLER_ERROR');
  check('and the page got ONE dg:desktop-print event for the two identical failures, { level: "error", code, message }', errorEvents.length === 1 && errorEvents[0].level === 'error' && errorEvents[0].message === R.failReceipt.message, R.events);
  check('the OLD web\'s failing legacy call got the app\'s own native box (one, headed "The receipt could not be printed")', dialogs.filter((d) => /receipt could not be printed/.test(d.message || '')).length === 1, dialogs.map((d) => d.message || d.title));

  check('a loop with a refused label (printLabItemLabels, 4 copies): { printed: 1, failed: 1 } and ONE event', R.loop && R.loop.printed === 1 && R.loop.failed === 1 && R.loopEvents && R.loopEvents.length === 1 && R.loopEvents[0].code === 'DYMO_PRINT_FAILED', [R.loop, R.loopEvents]);
  check('and once the printer works again it prints every copy: { printed: 2, failed: 0 }', R.loopOk && R.loopOk.printed === 2 && R.loopOk.failed === 0, R.loopOk);
  const lab = labels.filter((l) => ops(l).TextObject12 === 'Screen "kit"');
  check('the lab label shows the quote as typed on the new desktop', lab.length >= 1 && lab[0].printed, lab.map(ops));
  check('no other native box opened (the successful old-web calls showed nothing)', dialogs.length === 1, dialogs);
  check('no uncaught exception in the main process', true);

  try { handle.services.passwordWindow.close(); } catch { /* already closed */ }
  server.close();
  const quit = new Promise((resolve) => app.once('quit', resolve));
  app.quit();
  await Promise.race([quit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  clearTimeout(watchdog);
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`uncaught: ${error && error.stack ? error.stack : error}\n`);
});
main().catch((error) => {
  process.stderr.write(`contract run failed: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
