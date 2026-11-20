'use strict';

/**
 * The IPC surface of the real app (src/main/ipc.js) driven through the whole boot of tests/helpers/fake-boot.js: the real
 * security checks, window registry, config, drawer, throttle and print service; fake windows, printers and DYMO.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBootWorld, pageEvent, POS_ORIGIN } = require('../helpers/fake-boot');
const { createWindowFactory, summarizeCalls, LABELS_DIR } = require('../helpers/vm-dymo');
const { createDymoService } = require('../../src/main/printing/dymo');
const passwordTools = require('../../src/main/password');
const { PrintError } = require('../../src/main/errors');
const { COALESCE_WINDOW_MS } = require('../../src/main/errorBoxes');

const PASSWORD = 'tills-pw';
const RECEIPT_BYTES = Buffer.from([0x1b, 0x40, 0x54, 0x65, 0x73, 0x74, 0x0a, 0x1d, 0x56, 0x00]);
const ROOT = path.join(__dirname, '..', '..');

/** A booted app with printers set up and a drawer password, unless told otherwise. */
async function boot({ printers = true, password = true, ...options } = {}) {
  const world = createBootWorld(options);
  await world.boot();
  await world.settle();
  const { config } = world.services();
  if (printers) {
    config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
    config.setPrinter('label', { transport: 'system', printerName: 'ZDesigner ZD420', port: '' });
  }
  if (password) config.setPasswordRecord(passwordTools.hashPassword(PASSWORD));
  return world;
}

const legacyReceipt = () => ({
  receiptFileBinary: new Uint8Array(RECEIPT_BYTES),
  order: { id: 7, notes: 'N'.repeat(10 * 1024) },
  isDuplicate: false,
  business: { business_name: 'Gadgets Shop' },
  businessData: {},
  settings: { currency: 'GBP', notes: 'S'.repeat(10 * 1024) },
});
const OPEN_BUTTON = { isDuplicate: false, order: false, business: {}, businessData: false, openCashDrawer: true, settings: {} };

// ---- the origin question ---------------------------------------------------------------------------------------------------

test('app:origin-allowed answers from the sender frame origin: the POS server yes, a foreign page and a missing frame no, and it ALWAYS answers', async () => {
  const world = await boot();
  const ask = (event, channel = 'app:origin-allowed') => world.ipc.sendSync(channel, event);
  assert.equal(ask(world.events.pos()), true);
  assert.equal(ask(world.events.pos('https://pos.gadgetspos.com')), true, 'a gadgetspos.com subdomain');
  assert.equal(ask(world.events.foreign()), false);
  assert.equal(ask(world.events.pos('http://vendor.societyfiles.com')), false, 'plain http in production');
  assert.equal(ask({ sender: {}, senderFrame: null }), false, 'no frame');
  assert.equal(ask({}), false, 'no event data at all');
  assert.equal(ask({ senderFrame: { get origin() { throw new Error('disposed frame'); } } }), false, 'a getter that throws');
  assert.equal(ask(pageEvent({ id: 5, origin: 'null' })), false, 'an opaque origin');
  assert.equal(ask(world.events.pos(), 'security:isAllowedOrigin'), true, 'the alias answers the same');
  assert.equal(ask(world.events.foreign(), 'security:isAllowedOrigin'), false);
  world.cleanup();
});

test('the origin answer follows the settings: extra domains are allowed, and a later server address is seen by pages loaded afterwards', async () => {
  const world = await boot();
  const { config } = world.services();
  const shop = world.events.pos('https://shop.example.com');
  assert.equal(world.ipc.sendSync('app:origin-allowed', shop), false);
  config.setConnection({ extraAllowedOrigins: ['https://shop.example.com'] });
  assert.equal(world.ipc.sendSync('app:origin-allowed', shop), true);
  assert.equal(world.ipc.sendSync('app:origin-allowed', world.events.foreign()), false);
  const other = world.events.pos('https://pos.newserver.example');
  assert.equal(world.ipc.sendSync('app:origin-allowed', other), false);
  config.setConnection({ serverUrl: 'https://pos.newserver.example/' });
  assert.equal(world.ipc.sendSync('app:origin-allowed', other), true);
  world.cleanup();
});

test('a page opened with window.open (about:blank of an allowed page) is judged by its origin like the main window', async () => {
  const world = await boot();
  assert.equal(world.ipc.sendSync('app:origin-allowed', world.events.popup()), true);
  world.cleanup();
});

// ---- legacy channels (fire and forget) -------------------------------------------------------------------------------------

test('send-receipt-data prints a legacy receipt payload (with 10 KB strings inside the objects the app never reads)', async () => {
  const world = await boot();
  await world.ipc.send('send-receipt-data', world.events.pos(), legacyReceipt());
  assert.equal(world.rawPrinter.jobs.length, 1);
  assert.deepEqual(world.rawPrinter.jobs[0].bytes, RECEIPT_BYTES);
  assert.equal(world.rawPrinter.jobs[0].target.printerName, 'EPSON TM-T20');
  assert.equal(world.dialog.calls.length, 0, 'a success shows no box');
  world.cleanup();
});

test('send-receipt-data with the Open button payload opens the password window and prints nothing', async () => {
  const world = await boot();
  await world.ipc.send('send-receipt-data', world.events.pos(), OPEN_BUTTON);
  const { passwordWindow } = world.services();
  assert.equal(passwordWindow.isOpen(), true);
  assert.match(passwordWindow.getWindow().webContents.getURL(), /password\.html\?purpose=drawer$/);
  assert.equal(world.rawPrinter.jobs.length, 0);
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});

test('a failed legacy print is shown to the cashier in ONE native error box per error code, however many fail within 5 seconds', async () => {
  const world = await boot();
  world.rawPrinter.failWith = new PrintError('PRINTER_NOT_FOUND', undefined, { printerName: 'EPSON TM-T20' });
  for (let i = 0; i < 20; i += 1) await world.ipc.send('send-receipt-data', world.events.pos(), legacyReceipt());
  assert.equal(world.rawPrinter.jobs.length, 20, 'every job was tried');
  assert.equal(world.dialog.calls.length, 1);
  const box = world.dialog.calls[0].options;
  assert.equal(box.type, 'error');
  assert.equal(box.message, 'The receipt could not be printed');
  assert.match(box.detail, /The printer "EPSON TM-T20" was not found/);

  world.rawPrinter.failWith = new PrintError('SPOOLER_ERROR');
  world.dialog.responses.push(() => new Promise(() => {})); // this box is never answered: it stays open
  await world.ipc.send('send-receipt-data', world.events.pos(), legacyReceipt());
  assert.equal(world.dialog.calls.length, 2, 'another code is another box');
  await world.clock.advance(COALESCE_WINDOW_MS + 1);
  await world.ipc.send('send-receipt-data', world.events.pos(), legacyReceipt());
  assert.equal(world.dialog.calls.length, 2, 'that box is still open: no second one for its code, however long it stays');
  world.rawPrinter.failWith = new PrintError('PRINTER_NOT_FOUND');
  await world.ipc.send('send-receipt-data', world.events.pos(), legacyReceipt());
  assert.equal(world.dialog.calls.length, 3, 'the first code was answered more than 5 seconds ago: a new box may open');
  world.cleanup();
});

test('send-barcode-data: a ZPL string goes to the label printer, a DYMO envelope to DYMO, and a failure is a label box', async () => {
  const world = await boot();
  await world.ipc.send('send-barcode-data', world.events.pos(), { barcodefinal: '^XA^FDHello^FS^XZ', barcode: '1', title: 'x', prints: 1 });
  assert.equal(world.rawPrinter.jobs.length, 1);
  assert.equal(world.rawPrinter.jobs[0].target.printerName, 'ZDesigner ZD420');
  assert.equal(world.rawPrinter.jobs[0].ext, 'zpl');
  const dymoLabel = { barcodefinal: { printer: 'dymo', title: 'iPhone 13', barcode: 'ABC' }, size: '32x57', design: '1', currency: 'GBP', prints: 2 };
  await world.ipc.send('send-barcode-data', world.events.pos(), dymoLabel);
  assert.deepEqual(world.dymo.prints, [dymoLabel]);
  assert.equal(world.dialog.calls.length, 0);

  world.dymo.result = { ok: false, code: 'DYMO_NO_PRINTER', message: 'No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on.' };
  await world.ipc.send('send-barcode-data', world.events.pos(), dymoLabel);
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The label could not be printed');
  assert.match(world.dialog.calls[0].options.detail, /No DYMO printer was found/);
  world.cleanup();
});

test('send-barcode-data with no label at all (the web has no label printer type) shows the INVALID_PAYLOAD box instead of crashing', async () => {
  const world = await boot();
  await world.ipc.send('send-barcode-data', world.events.pos(), { barcode: '1', title: 'x' });
  assert.equal(world.dialog.calls.length, 1);
  assert.match(world.dialog.calls[0].options.detail, /could not read/);
  world.cleanup();
});

test('open-drawer-legacy opens the drawer with { cashDrawerOpenPassword }; a wrong password or a disabled drawer is a drawer box', async () => {
  const world = await boot();
  await world.ipc.send('open-drawer-legacy', world.events.pos(), { cashDrawerOpenPassword: PASSWORD });
  assert.deepEqual([...world.rawPrinter.jobs[0].bytes], [0x1b, 0x70, 0x00, 0x19, 0xff]);
  assert.equal(world.dialog.calls.length, 0);
  await world.ipc.send('open-drawer-legacy', world.events.pos(), { cashDrawerOpenPassword: 'wrong' });
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The cash drawer did not open');
  assert.match(world.dialog.calls[0].options.detail, /not correct/);
  world.cleanup();
});

test('a drawer problem on the receipt channel (the Open button with no password set) gets the drawer heading', async () => {
  const world = await boot({ password: false });
  await world.ipc.send('send-receipt-data', world.events.pos(), OPEN_BUTTON);
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The cash drawer did not open');
  assert.match(world.dialog.calls[0].options.detail, /Settings > Cash drawer/);
  assert.equal(world.services().passwordWindow.isOpen(), false);
  world.cleanup();
});

test('legacy messages from a page that is not trusted are dropped without a trace on the printers or the screen', async () => {
  const world = await boot();
  for (const event of [world.events.foreign(), world.events.subFrame(), world.events.offline(), { sender: {}, senderFrame: null }, {}]) {
    await world.ipc.send('send-receipt-data', event, legacyReceipt());
    await world.ipc.send('send-barcode-data', event, { barcodefinal: '^XA^XZ' });
    await world.ipc.send('open-drawer-legacy', event, { cashDrawerOpenPassword: PASSWORD });
  }
  assert.equal(world.rawPrinter.jobs.length, 0);
  assert.equal(world.dymo.prints.length, 0);
  assert.equal(world.dialog.calls.length, 0);
  assert.ok(world.log.texts('warn').some((line) => /send-receipt-data refused/.test(line)));
  world.cleanup();
});

test('a page opened with window.open prints like the main window (its origin is what is checked)', async () => {
  const world = await boot();
  await world.ipc.send('send-receipt-data', world.events.popup(), legacyReceipt());
  assert.equal(world.rawPrinter.jobs.length, 1);
  world.cleanup();
});

// ---- labels with the REAL DYMO service (fake framework window) -------------------------------------------------------------

/** A boot world whose DYMO service is the real one, over the fake framework window of the DYMO tests. */
async function bootWithRealDymo(windowOptions = {}) {
  const factory = createWindowFactory(windowOptions);
  const world = createBootWorld();
  world.overrides.dymo = createDymoService({
    createHiddenWindow: factory.createHiddenWindow,
    labelsDir: LABELS_DIR,
    readFile: (file, encoding) => fs.promises.readFile(file, encoding),
    getConfig: () => ({}),
    timers: world.clock,
  });
  await world.boot();
  await world.settle();
  return { world, factory };
}

const textOf = (label, name) => label.ops.find((op) => op.name === name)?.value;

test('a DYMO label as BarcodePanelTab sends it prints through the real DYMO service, currency and all, once per message', async () => {
  const { world, factory } = await bootWithRealDymo();
  const payload = {
    barcodefinal: {
      printer: 'dymo', title: 'iPhone 13 Pro', barcode: 'ABCDEFGH123456', storage: '128GB', network: 'Unlocked', ram: '6GB', misc_color: 'Graphite',
      warranty: '12 months', Processor: 'A15', conditionObject: { grade: 'A+' }, price: '599', salePrice: 0, isSale: false, regular_price: '599',
    },
    barcode: 'ABCDEFGH123456', title: 'iPhone 13 Pro', price: '599', currency: 'AED', salePrice: 0, isSale: false, regular_price: '599', prints: 2, design: '1', size: '32x57',
  };
  assert.deepEqual(await world.ipc.invoke('print-barcode', world.events.pos(), payload), { ok: true });
  const labels = summarizeCalls(factory.windows[0].fake.calls);
  assert.equal(labels.length, 1, '`prints` is the web\'s own loop count: the desktop prints ONE label per message');
  assert.equal(textOf(labels[0], 'ItemNameVal'), 'iPhone 13 Pro');
  assert.equal(textOf(labels[0], 'TEXT_3'), 'AED 599');
  assert.equal(textOf(labels[0], 'TEXT_4'), 'LIKE NEW');
  assert.equal(labels[0].printed, true);
  assert.equal(world.rawPrinter.jobs.length, 0, 'a DYMO label never touches the raw printers');
  world.cleanup();
});

test('a title with a double quote prints as typed, and the legacy fire-and-forget channel behaves like the new one', async () => {
  const { world, factory } = await bootWithRealDymo();
  const payload = { barcodefinal: { printer: 'dymo', title: 'MacBook Air 13" M1 \\ back\nslash', barcode: 'MB123456789', conditionObject: { grade: 'New' }, price: '999' }, size: '32x57', design: '1' };
  await world.ipc.send('send-barcode-data', world.events.pos(), payload);
  await world.settle(20);
  const [label] = summarizeCalls(factory.windows[0].fake.calls);
  assert.equal(textOf(label, 'ItemNameVal'), 'MacBook Air 13" M1 \\ back slash');
  assert.equal(label.error, null);
  assert.equal(world.dialog.calls.length, 0);
  world.cleanup();
});

test('a repair label with a 300 KB property the app never reads still prints (only the fields the app reads are looked at)', async () => {
  const { world, factory } = await bootWithRealDymo();
  const payload = {
    barcodefinal: {
      printer: 'dymo', design: 'repair', barcode: 'REP-1042', orderDate: '19/11/2026',
      customer: { name: 'A. Customer', cell_no: '07123456789' },
      business: { business_name: 'Gadgets Shop', branch_name: 'Main', business_address: 'x', post_code: 'AB1 2CD' },
      orderItem: { product_name: 'iPhone 12 screen', current_price: 50, custom_field_value: [{ value: 'Cracked' }, { value: 'Black' }], huge: 'H'.repeat(300 * 1024) },
    },
    barcode: 'REP-1042', design: 'repair', size: '32x57',
  };
  assert.deepEqual(await world.ipc.invoke('print-barcode', world.events.pos(), payload), { ok: true });
  const [label] = summarizeCalls(factory.windows[0].fake.calls);
  assert.equal(textOf(label, 'ItemNameVal'), 'iPhone 12 screen');
  assert.equal(textOf(label, 'TextObject5'), 'A. Customer');
  assert.equal(label.printed, true);
  world.cleanup();
});

test('the DYMO window is created by the first label, never at startup', async () => {
  const { world, factory } = await bootWithRealDymo();
  assert.equal(factory.created, 0);
  assert.deepEqual(await world.ipc.invoke('print-barcode', world.events.pos(), { barcodefinal: { printer: 'dymo', title: 'x', barcode: '1' } }), { ok: true });
  assert.equal(factory.created, 1);
  world.cleanup();
});

test('a DYMO label with no DYMO printer is DYMO_NO_PRINTER with the next step, and the old web gets a native box for it', async () => {
  const { world } = await bootWithRealDymo({ dymo: { printers: [] } });
  const label = { barcodefinal: { printer: 'dymo', title: 'x', barcode: '1' } };
  const result = await world.ipc.invoke('print-barcode', world.events.pos(), label);
  assert.equal(result.code, 'DYMO_NO_PRINTER');
  assert.match(result.message, /DYMO Connect is running and the printer is switched on/);
  await world.ipc.send('send-barcode-data', world.events.pos(), label);
  await world.settle(20);
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The label could not be printed');
  assert.match(world.dialog.calls[0].options.detail, /No DYMO printer was found/);
  world.cleanup();
});

// ---- acknowledged channels -------------------------------------------------------------------------------------------------

test('print-receipt answers a Result: { ok: true } on success, the printer\'s own code and message on failure, and no native box', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('print-receipt', world.events.pos(), { receiptFileBinary: RECEIPT_BYTES }), { ok: true });
  world.rawPrinter.failWith = new PrintError('PRINT_TIMEOUT');
  const failed = await world.ipc.invoke('print-receipt', world.events.pos(), { receiptFileBinary: RECEIPT_BYTES });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PRINT_TIMEOUT');
  assert.match(failed.message, /did not answer in time/);
  assert.equal(world.dialog.calls.length, 0, 'the web shows acknowledged failures itself');
  world.cleanup();
});

test('print-receipt with { openCashDrawer: true } answers { ok: true, details: { prompted: true } } as soon as the prompt window is shown', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('print-receipt', world.events.pos(), { openCashDrawer: true }), { ok: true, details: { prompted: true } });
  assert.equal(world.services().passwordWindow.isOpen(), true);
  world.cleanup();
});

test('print-receipt refuses nothing-to-print and an oversize receipt with INVALID_PAYLOAD', async () => {
  const world = await boot();
  for (const payload of [undefined, {}, { receiptFileBinary: new Uint8Array(0) }, { receiptFileBinary: new Uint8Array(5 * 1024 * 1024 + 1) }]) {
    const result = await world.ipc.invoke('print-receipt', world.events.pos(), payload);
    assert.equal(result.code, 'INVALID_PAYLOAD');
  }
  assert.equal(world.rawPrinter.jobs.length, 0);
  world.cleanup();
});

test('print-barcode answers a Result for Zebra and DYMO, including a DYMO label that stops part-way', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('print-barcode', world.events.pos(), { barcodefinal: '^XA^XZ' }), { ok: true });
  assert.deepEqual(await world.ipc.invoke('print-barcode', world.events.pos(), { barcodefinal: { printer: 'dymo' } }), { ok: true });
  world.dymo.result = { ok: false, code: 'DYMO_PRINT_FAILED', message: 'The DYMO label could not be printed. 2 of 3 labels were printed.', details: { printed: 2, total: 3 } };
  const stopped = await world.ipc.invoke('print-barcode', world.events.pos(), { barcodefinal: { printer: 'dymo' } });
  assert.equal(stopped.details.printed, 2);
  assert.equal(stopped.details.total, 3);
  world.cleanup();
});

test('open-drawer: the right password opens the drawer, a wrong one is counted, five lock the drawer for 30 s with retryAfterSec', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('open-drawer', world.events.pos(), { password: PASSWORD }), { ok: true });
  assert.equal(world.rawPrinter.jobs.length, 1);
  assert.equal((await world.ipc.invoke('open-drawer', world.events.pos(), {})).code, 'PASSWORD_REQUIRED');
  let last;
  for (let i = 0; i < 5; i += 1) last = await world.ipc.invoke('open-drawer', world.events.pos(), { password: 'wrong' });
  assert.equal(last.code, 'DRAWER_WRONG_PASSWORD');
  assert.equal(last.details.retryAfterSec, 30);
  const locked = await world.ipc.invoke('open-drawer', world.events.pos(), { password: PASSWORD });
  assert.equal(locked.code, 'DRAWER_LOCKED_OUT');
  assert.equal(locked.details.retryAfterSec, 30);
  assert.match(locked.message, /Try again in 30 seconds/);
  await world.clock.advance(30_001);
  assert.deepEqual(await world.ipc.invoke('open-drawer', world.events.pos(), { password: PASSWORD }), { ok: true });
  world.cleanup();
});

test('open-drawer on a drawer that is switched off, or has no password, says so', async () => {
  const off = await boot();
  off.services().config.setDrawer({ enabled: false });
  assert.equal((await off.ipc.invoke('open-drawer', off.events.pos(), { password: PASSWORD })).code, 'DRAWER_DISABLED');
  off.cleanup();
  const none = await boot({ password: false });
  assert.equal((await none.ipc.invoke('open-drawer', none.events.pos(), { password: 'x' })).code, 'DRAWER_PASSWORD_NOT_SET');
  none.cleanup();
});

test('app-info is { name, version, platform, apiVersion: 2, features }', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('app-info', world.events.pos()), {
    name: 'Gadgets POS', version: '2.0.0-test', platform: 'win32', apiVersion: 2, features: ['ack-print', 'drawer', 'printer-list', 'label-designs-1'],
  });
  world.cleanup();
});

test('list-printers answers the system and DYMO lists in the shapes of SPEC 6.1, and tolerates either source failing', async () => {
  const world = await boot();
  assert.deepEqual(await world.ipc.invoke('list-printers', world.events.pos()), {
    system: [{ name: 'EPSON TM-T20', displayName: 'EPSON TM-T20', isDefault: true, status: 0 }],
    dymo: [{ name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', isConnected: true }],
  });
  world.cleanup();

  const failing = await boot({ overrides: { getPrintersAsync: async () => { throw new Error('spooler down'); } } });
  const result = await failing.ipc.invoke('list-printers', failing.events.pos());
  assert.equal(result.ok, false);
  assert.deepEqual(result.system, []);
  assert.equal(result.dymo.length, 1, 'the DYMO list is still there');
  failing.cleanup();
});

test('every acknowledged channel refuses a sender that is not trusted with UNTRUSTED_SENDER, and logs only the channel and the origin', async () => {
  const world = await boot();
  const channels = [['print-receipt', legacyReceipt()], ['print-barcode', { barcodefinal: '^XA^XZ' }], ['open-drawer', { password: PASSWORD }], ['app-info'], ['list-printers']];
  const untrusted = [world.events.foreign(), world.events.subFrame(), world.events.offline(), world.events.settings ? null : null, { sender: {}, senderFrame: null }, {}].filter(Boolean);
  for (const [channel, payload] of channels) {
    for (const event of untrusted) {
      const result = await world.ipc.invoke(channel, event, payload);
      assert.equal(result.ok, false, `${channel}`);
      assert.equal(result.code, 'UNTRUSTED_SENDER', `${channel}`);
    }
  }
  assert.equal(world.rawPrinter.jobs.length, 0);
  assert.equal(world.dymo.prints.length, 0);
  const warnings = world.log.texts('warn').join('\n');
  assert.match(warnings, /print-receipt refused for a sender that is not trusted \(https:\/\/evil\.example\.com\)/);
  assert.doesNotMatch(warnings, /Gadgets Shop|tills-pw|EPSON/);
  world.cleanup();
});

test('a handler that fails unexpectedly answers an UNKNOWN Result and is logged, never thrown into Electron', async () => {
  const world = await boot();
  world.rawPrinter.failWith = new TypeError('internal bug text');
  const result = await world.ipc.invoke('print-receipt', world.events.pos(), { receiptFileBinary: RECEIPT_BYTES });
  assert.equal(result.code, 'UNKNOWN');
  assert.doesNotMatch(result.message, /internal bug/);
  world.cleanup();
});

// ---- the app's own pages: areas --------------------------------------------------------------------------------------------

const AREA_CALLS = {
  connection: [['desktop:connection:getStatus'], ['desktop:connection:retryNow'], ['desktop:connection:openSettings', 'printers']],
  window: [['desktop:window:close']],
  settings: [['desktop:settings:getState'], ['desktop:settings:listPrinters'], ['desktop:settings:setGeneral', { keepAwake: true }]],
  password: [['desktop:password:getLockout'], ['desktop:password:cancel']],
};

async function openWindows(world) {
  const { settingsWindow, passwordPrompt } = world.services();
  settingsWindow.open({ tab: 'printers' });
  passwordPrompt.show('drawer');
}

test('the offline page in the main window reaches connection and window, and nothing of settings or password (SPEC 6.3)', async () => {
  const world = await boot();
  const event = world.events.offline();
  for (const [channel, ...args] of [...AREA_CALLS.connection, ...AREA_CALLS.window.filter(([c]) => c !== 'desktop:window:close')]) {
    const result = await world.ipc.invoke(channel, event, ...args);
    assert.notEqual(result && result.code, 'UNTRUSTED_SENDER', channel);
  }
  for (const [channel, ...args] of [...AREA_CALLS.settings, ...AREA_CALLS.password]) {
    const result = await world.ipc.invoke(channel, event, ...args);
    assert.equal(result.code, 'UNTRUSTED_SENDER', channel);
  }
  world.cleanup();
});

test('the Settings window reaches settings, connection and window, and nothing of the password area', async () => {
  const world = await boot();
  await openWindows(world);
  const event = world.events.settings();
  for (const [channel, ...args] of [...AREA_CALLS.connection.filter(([c]) => c !== 'desktop:connection:openSettings'), ...AREA_CALLS.settings]) {
    const result = await world.ipc.invoke(channel, event, ...args);
    assert.notEqual(result && result.code, 'UNTRUSTED_SENDER', channel);
  }
  for (const [channel, ...args] of AREA_CALLS.password) {
    assert.equal((await world.ipc.invoke(channel, event, ...args)).code, 'UNTRUSTED_SENDER', channel);
  }
  world.cleanup();
});

test('the password window reaches password and window, and nothing of settings or connection', async () => {
  const world = await boot();
  await openWindows(world);
  const event = world.events.password();
  for (const [channel, ...args] of AREA_CALLS.password) {
    assert.notEqual((await world.ipc.invoke(channel, event, ...args)).code, 'UNTRUSTED_SENDER', channel);
  }
  for (const [channel, ...args] of [...AREA_CALLS.settings, ...AREA_CALLS.connection]) {
    assert.equal((await world.ipc.invoke(channel, event, ...args)).code, 'UNTRUSTED_SENDER', channel);
  }
  world.cleanup();
});

test('the POS page itself reaches no desktop channel at all, and neither does a window it opened', async () => {
  const world = await boot();
  const everything = [...AREA_CALLS.connection, ...AREA_CALLS.window, ...AREA_CALLS.settings, ...AREA_CALLS.password];
  for (const event of [world.events.pos(), world.events.popup(), world.events.foreign()]) {
    for (const [channel, ...args] of everything) assert.equal((await world.ipc.invoke(channel, event, ...args)).code, 'UNTRUSTED_SENDER', channel);
  }
  world.cleanup();
});

test('a local page must be a file inside src/renderer: the Settings window showing anything else is refused', async () => {
  const world = await boot();
  await openWindows(world);
  const id = world.services().settingsWindow.getWindow().webContents.id;
  for (const url of ['file:///etc/hosts', `file://${path.join(ROOT, 'src', 'main', 'index.js')}`, 'https://evil.example.com/settings.html', `file://${path.join(ROOT, 'src', 'renderer')}`]) {
    const event = pageEvent({ id, origin: 'file://', url });
    assert.equal((await world.ipc.invoke('desktop:settings:getState', event)).code, 'UNTRUSTED_SENDER', url);
  }
  const sub = world.events.settings();
  sub.senderFrame = { ...sub.senderFrame, parent: { url: 'x' } };
  assert.equal((await world.ipc.invoke('desktop:settings:getState', sub)).code, 'UNTRUSTED_SENDER', 'a sub-frame of the Settings window');
  world.cleanup();
});

test('desktop:window:close closes the window it came from, and never the POS window', async () => {
  const world = await boot();
  await openWindows(world);
  const settings = world.services().settingsWindow.getWindow();
  assert.deepEqual(await world.ipc.invoke('desktop:window:close', world.events.settings()), { ok: true });
  assert.equal(settings.isDestroyed(), true);
  assert.deepEqual(await world.ipc.invoke('desktop:window:close', world.events.offline()), { ok: true });
  assert.equal(world.mainWindow().isDestroyed(), false);
  world.cleanup();
});

// ---- the settings channels through the real handlers -----------------------------------------------------------------------

test('desktop:settings:getState carries the state of the app: config without secrets, platform, versions, paths and the startup marks', async () => {
  const world = await boot();
  await openWindows(world);
  const state = await world.ipc.invoke('desktop:settings:getState', world.events.settings());
  assert.equal(state.platform, 'win32');
  assert.equal(state.version, '2.0.0-test');
  assert.equal(state.config.printers.receipt.printerName, 'EPSON TM-T20');
  assert.equal(state.config.drawer.passwordSet, true);
  assert.doesNotMatch(JSON.stringify(state), /scrypt|tills-pw/);
  assert.deepEqual(Object.keys(state.performance.startup.marks).slice(0, 7), ['process-start', 'app-ready', 'window-created', 'loading-visible', 'loading-painted', 'config-ready', 'services-ready']);
  assert.equal(state.paths.userData, world.store.dir);
  assert.equal(state.paths.logsDir, path.join(world.store.dir, 'logs'));
  world.cleanup();
});

test('desktop:settings:savePrinter and testPrint reach the real printers: a port is checked, a test slip is printed on the saved printer', async () => {
  const world = await boot({ printers: false });
  await openWindows(world);
  const event = world.events.settings();
  assert.equal((await world.ipc.invoke('desktop:settings:testPrint', event, 'receipt', {})).code, 'NO_PRINTER_CONFIGURED');
  assert.equal((await world.ipc.invoke('desktop:settings:savePrinter', event, 'receipt', { transport: 'port', printerName: '', port: 'USB001' })).code, 'INVALID_SETTINGS');
  assert.deepEqual(await world.ipc.invoke('desktop:settings:savePrinter', event, 'receipt', { transport: 'port', printerName: '', port: '\\\\localhost\\EpsonTM' }), { ok: true });
  assert.deepEqual(await world.ipc.invoke('desktop:settings:testPrint', event, 'receipt', {}), { ok: true });
  assert.equal(world.rawPrinter.jobs.at(-1).target.port, '\\\\localhost\\EpsonTM');
  world.cleanup();
});

test('password prompt through the channels: wrong password, the lockout push to the window, the shared throttle, then the lock ends', async () => {
  const world = await boot();
  await world.ipc.send('send-receipt-data', world.events.pos(), OPEN_BUTTON);
  const event = world.events.password();
  const window = world.services().passwordWindow.getWindow();
  assert.deepEqual(await world.ipc.invoke('desktop:password:getLockout', event), { locked: false, retryAfterSec: 0 });
  assert.equal((await world.ipc.invoke('desktop:password:submit', event, 'wrong')).code, 'DRAWER_WRONG_PASSWORD');
  assert.equal(world.rawPrinter.jobs.length, 0);
  for (let i = 0; i < 4; i += 1) await world.ipc.invoke('desktop:password:submit', event, 'wrong');
  assert.deepEqual(await world.ipc.invoke('desktop:password:getLockout', event), { locked: true, retryAfterSec: 30 });
  assert.deepEqual(window.webContents.sent.at(-1), { channel: 'desktop:password:lockout', args: [{ locked: true, retryAfterSec: 30 }] });
  assert.equal((await world.ipc.invoke('desktop:password:submit', event, PASSWORD)).code, 'DRAWER_LOCKED_OUT');
  assert.equal((await world.ipc.invoke('open-drawer', world.events.pos(), { password: PASSWORD })).code, 'DRAWER_LOCKED_OUT', 'the web call shares the lock');
  await world.clock.advance(30_001);
  assert.deepEqual(await world.ipc.invoke('desktop:password:submit', event, PASSWORD), { ok: true });
  assert.deepEqual([...world.rawPrinter.jobs.at(-1).bytes], [0x1b, 0x70, 0x00, 0x19, 0xff]);
  await world.clock.advance(500);
  assert.equal(window.isDestroyed(), true, 'the prompt closes after a correct password');
  world.cleanup();
});

test('wrong passwords in Settings dialogs and in the drawer prompt count towards ONE lockout', async () => {
  const world = await boot();
  await openWindows(world);
  const settings = world.events.settings();
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await world.ipc.invoke('desktop:settings:resetAll', settings, { password: 'wrong' })).code, 'PASSWORD_WRONG');
  }
  const prompt = world.events.password();
  const fifth = await world.ipc.invoke('desktop:password:submit', prompt, 'wrong');
  assert.equal(fifth.details.retryAfterSec, 30);
  assert.equal((await world.ipc.invoke('desktop:settings:saveDrawerSettings', settings, { enabled: true, password: PASSWORD })).code, 'PASSWORD_LOCKED_OUT');
  world.cleanup();
});

test('"ask for the password before Settings opens": the offline page\'s button shows the prompt, and Settings opens after the password', async () => {
  const world = await boot();
  world.services().config.setDrawer({ requirePasswordForSettings: true });
  const { settingsWindow, passwordWindow } = world.services();
  assert.deepEqual(await world.ipc.invoke('desktop:connection:openSettings', world.events.offline(), 'connection'), { ok: true, details: { prompted: true } });
  assert.equal(settingsWindow.isOpen(), false);
  assert.match(passwordWindow.getWindow().webContents.getURL(), /purpose=settings/);
  assert.equal((await world.ipc.invoke('desktop:password:submit', world.events.password(), 'wrong')).code, 'PASSWORD_WRONG');
  assert.deepEqual(await world.ipc.invoke('desktop:password:submit', world.events.password(), PASSWORD), { ok: true });
  assert.equal(settingsWindow.isOpen(), true);
  assert.match(settingsWindow.getWindow().webContents.getURL(), /settings\.html\?tab=connection/);
  world.cleanup();
});

test('resetAll needs the password, erases the settings, and the Settings window is pushed the new state', async () => {
  const world = await boot();
  await openWindows(world);
  const event = world.events.settings();
  const window = world.services().settingsWindow.getWindow();
  assert.equal((await world.ipc.invoke('desktop:settings:resetAll', event, { password: '' })).code, 'PASSWORD_REQUIRED');
  assert.equal(world.services().config.get('printers.receipt.printerName'), 'EPSON TM-T20');
  window.webContents.sent.length = 0;
  assert.deepEqual(await world.ipc.invoke('desktop:settings:resetAll', event, { password: PASSWORD }), { ok: true });
  assert.equal(world.services().config.get('printers.receipt.printerName'), '');
  const pushed = window.webContents.sent.filter((entry) => entry.channel === 'desktop:state');
  assert.ok(pushed.length >= 1);
  assert.equal(pushed.at(-1).args[0].config.drawer.passwordSet, false);
  assert.equal(pushed.at(-1).args[0].config.printers.receipt.printerName, '');
  world.cleanup();
});

// ---- pushes ----------------------------------------------------------------------------------------------------------------

test('the Settings window is pushed desktop:state when the settings change and when the update status changes', async () => {
  const world = await boot();
  await openWindows(world);
  const window = world.services().settingsWindow.getWindow();
  window.webContents.sent.length = 0;
  world.services().config.setPrinter('dymo', { printerName: 'DYMO LabelWriter 450' });
  const first = window.webContents.sent.at(-1);
  assert.equal(first.channel, 'desktop:state');
  assert.equal(first.args[0].config.printers.dymo.printerName, 'DYMO LabelWriter 450');
  assert.equal('passwordRecord' in first.args[0].config.drawer, false, 'the record is never pushed');

  window.webContents.sent.length = 0;
  world.autoUpdater.emit('checking-for-update');
  assert.equal(window.webContents.sent.length, 0, 'the updater is not loaded before the POS has loaded');
  await world.services().updater.checkNow();
  const updates = window.webContents.sent.filter((entry) => entry.channel === 'desktop:state' && entry.args[0].update);
  assert.ok(updates.length >= 1);
  world.cleanup();
});

test('connection status reaches the offline page and banner of the main window and the Settings window', async () => {
  const world = await boot();
  await openWindows(world);
  const settingsWindow = world.services().settingsWindow.getWindow();
  world.mainWindow().webContents.sent.length = 0;
  settingsWindow.webContents.sent.length = 0;
  world.services().connectivity.start('https://vendor.societyfiles.com/', { mode: 'page', reason: 'dns' });
  const mainChannels = world.mainWindow().webContents.sent.map((entry) => entry.channel);
  assert.ok(mainChannels.includes('desktop:connection:status'));
  assert.ok(mainChannels.includes('connectivity:status'));
  const settingsChannels = settingsWindow.webContents.sent.map((entry) => entry.channel);
  assert.ok(settingsChannels.includes('desktop:connection:status'));
  const online = settingsWindow.webContents.sent.filter((entry) => entry.channel === 'desktop:state' && 'online' in entry.args[0]);
  assert.equal(online.at(-1).args[0].online, false);
  world.services().connectivity.stop();
  world.cleanup();
});

// ---- the network is back (RE-02) ---------------------------------------------------------------------------------------------

/** An outage that has lasted long enough for the delay between probes to be at its longest step; the next request would succeed. */
async function longOutage(world, { failures = 5 } = {}) {
  const { connectivity } = world.services();
  for (let i = 0; i < failures; i += 1) world.net.queue({ error: 'net::ERR_INTERNET_DISCONNECTED' });
  connectivity.start('https://vendor.societyfiles.com/vendor/point-of-sale?active=buy', { mode: 'page', reason: 'offline' });
  for (let i = 0; i < failures; i += 1) await world.clock.advance(connectivity.status().nextRetryInMs + 1);
  await world.settle();
  return connectivity;
}

test('the offline screen reports the network back: the reconnection probes at once instead of waiting out its delay', async () => {
  const world = await boot();
  const connectivity = await longOutage(world);
  assert.equal(world.net.requests.length, 5);
  assert.ok(connectivity.status().nextRetryInMs > 15000, 'the next retry is far away');
  assert.equal(connectivity.status().online, false);

  world.ipc.send('desktop:connection:networkOnline', world.events.offline());
  await world.settle();
  assert.equal(world.net.requests.length, 6, 'one probe, now');
  assert.equal(connectivity.status().online, true, 'the server answered, so the page can reload');
  world.cleanup();
});

test('the POS page reports it too, for the banner of a mid-session outage', async () => {
  const world = await boot();
  const connectivity = await longOutage(world);
  world.ipc.send('connectivity:networkOnline', world.events.pos());
  await world.settle();
  assert.equal(world.net.requests.length, 6);
  assert.equal(connectivity.status().online, true);
  world.cleanup();
});

test('a network-back notice starts nothing while no outage is tracked (no timer, no probe) and answers nothing', async () => {
  const world = await boot();
  const before = world.clock.pending();
  assert.equal(await world.ipc.send('desktop:connection:networkOnline', world.events.offline()), undefined);
  assert.equal(await world.ipc.send('connectivity:networkOnline', world.events.pos()), undefined);
  await world.settle();
  assert.equal(world.net.requests.length, 0);
  assert.equal(world.clock.pending(), before);
  world.cleanup();
});

test('only a trusted sender can make the app probe: a foreign page, a sub-frame and the wrong kind of page for the channel are refused', async () => {
  const world = await boot();
  await openWindows(world);
  const connectivity = await longOutage(world);
  const probes = world.net.requests.length;
  const refused = [
    ['connectivity:networkOnline', world.events.foreign()],
    ['connectivity:networkOnline', world.events.subFrame()],
    ['connectivity:networkOnline', world.events.offline()],
    ['desktop:connection:networkOnline', world.events.pos()],
    ['desktop:connection:networkOnline', world.events.password()],
    ['desktop:connection:networkOnline', world.events.popup()],
  ];
  for (const [channel, event] of refused) {
    await world.ipc.send(channel, event);
    await world.settle();
    assert.equal(world.net.requests.length, probes, `${channel} from ${event.senderFrame.url} must not probe`);
  }
  assert.equal(connectivity.status().online, false);
  await world.ipc.send('desktop:connection:networkOnline', world.events.settings());
  await world.settle();
  assert.equal(world.net.requests.length, probes + 1, 'the Settings window has the connection area, and its page is a local one');
  world.cleanup();
});

test('a window the POS page opened is as trusted on the remote channel as the page itself, like for every other remote channel', async () => {
  const world = await boot();
  const connectivity = await longOutage(world);
  await world.ipc.send('connectivity:networkOnline', world.events.popup());
  await world.settle();
  assert.equal(connectivity.status().online, true);
  world.cleanup();
});

// ---- the contract with the preloads ----------------------------------------------------------------------------------------

test('every channel the two preloads send or invoke has a handler, so no call goes unanswered', async () => {
  const world = await boot();
  const sources = ['app.js', 'local.js'].map((file) => fs.readFileSync(path.join(ROOT, 'src', 'preload', file), 'utf8'));
  const used = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:send|sendSync|invoke|invokeForResult)\(\s*'([^']+)'/g)) used.add(match[1]);
  }
  assert.equal(used.size, 34, `the preloads use ${[...used].join(', ')}`);
  assert.ok(used.has('connectivity:networkOnline') && used.has('desktop:connection:networkOnline'), 'the two network-back notices are in the contract');
  for (const channel of used) {
    const registered = world.ipc.handlers.has(channel) || world.ipc.listeners.has(channel);
    assert.equal(registered, true, `no handler for ${channel}`);
  }
  world.cleanup();
});

test('every channel the app handles is documented: the legacy three, the two network-back notices, the acknowledged five, the origin question, and desktop:<area>:<name>', async () => {
  const world = await boot();
  const on = [...world.ipc.listeners.keys()].sort();
  assert.deepEqual(on, ['app:origin-allowed', 'connectivity:networkOnline', 'desktop:connection:networkOnline', 'open-drawer-legacy', 'security:isAllowedOrigin', 'send-barcode-data', 'send-receipt-data']);
  const handled = [...world.ipc.handlers.keys()];
  for (const channel of ['print-receipt', 'print-barcode', 'open-drawer', 'app-info', 'list-printers']) assert.ok(handled.includes(channel), channel);
  assert.deepEqual(handled.filter((channel) => !/^desktop:(connection|window|settings|password):[A-Za-z]+$/.test(channel) && !['print-receipt', 'print-barcode', 'open-drawer', 'app-info', 'list-printers'].includes(channel)), []);
  assert.equal(handled.filter((channel) => channel.startsWith('desktop:settings:')).length, 16);
  world.cleanup();
});
