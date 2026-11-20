'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrintService, DYMO_QUEUE_KEY, DYMO_JOB_TIMEOUT_MS } = require('../../src/main/printing/jobs');
const { createConfig } = require('../../src/main/config');
const { createDrawer } = require('../../src/main/printing/drawer');
const { createJobQueue } = require('../../src/main/printing/queue');
const passwordTools = require('../../src/main/password');
const { PrintError } = require('../../src/main/errors');
const { createFakeStoreEnv } = require('../helpers/fake-store');

const PASSWORD = 'drawer-pw';

/**
 * The real config (on a real settings file), the real drawer with its throttle and the real receipt and Zebra printers, over a
 * raw printer that records every job. Only the printers and the DYMO window are fake.
 */
function setup({ printers = {}, drawer: drawerSettings = {}, password = PASSWORD, withQueue = true, prompt = true } = {}) {
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store });
  config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '', ...printers.receipt });
  config.setPrinter('label', { transport: 'system', printerName: 'ZDesigner ZD420', port: '', ...printers.label });
  if (password) config.setPasswordRecord(passwordTools.hashPassword(password));
  if (Object.keys(drawerSettings).length > 0) config.setDrawer(drawerSettings);

  const jobs = [];
  const rawPrinter = {
    failWith: null,
    async printRaw(job) {
      jobs.push({ target: job.target, bytes: Buffer.from(job.data), label: job.label, ext: job.ext });
      if (rawPrinter.failWith) throw rawPrinter.failWith;
      return { ok: true };
    },
  };
  const dymoPrints = [];
  const dymo = { result: { ok: true }, async print(payload) { dymoPrints.push(payload); return dymo.result; } };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const throttle = passwordTools.createThrottle();
  const drawer = createDrawer({ config, rawPrinter, password: passwordTools, throttle, log });
  const prompts = [];
  const queue = withQueue ? createJobQueue({ log }) : undefined;
  const service = createPrintService({ config, rawPrinter, dymo, drawer, queue, log, promptDrawer: prompt ? () => prompts.push('shown') : undefined });
  return { service, config, jobs, dymo, dymoPrints, logs, prompts, rawPrinter, queue, throttle, cleanup: () => env.cleanup() };
}

const RECEIPT_BYTES = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00]);

/** What pos-card-items-bottom.jsx really sends for a receipt (the unread objects are large). */
const legacyReceipt = (extra = {}) => ({
  receiptFileBinary: new Uint8Array(RECEIPT_BYTES),
  order: { id: 1042, notes: 'N'.repeat(10 * 1024), items: Array.from({ length: 200 }, (_, i) => ({ i, name: `Item ${i}` })) },
  isDuplicate: false,
  business: { business_name: 'Gadgets Shop' },
  businessData: { logo: 'data:image/png;base64,' + 'A'.repeat(5000) },
  settings: { currency: 'GBP', notes: 'S'.repeat(10 * 1024) },
  imageBaseUrl: 'https://img.example.com',
  ...extra,
});

/** What the web's Open button really sends. */
const OPEN_BUTTON = { isDuplicate: false, order: false, business: { business_name: 'Gadgets Shop' }, businessData: false, openCashDrawer: true, settings: { currency: 'GBP' } };

// ---- receipts --------------------------------------------------------------------------------------------------------------

test('a legacy receipt payload prints on the receipt printer, bytes verbatim, even with 10 KB strings in the objects the app never reads', async () => {
  const { service, jobs, cleanup } = setup();
  assert.deepEqual(await service.printReceipt(legacyReceipt()), { ok: true });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].bytes, RECEIPT_BYTES);
  assert.deepEqual(jobs[0].target, { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.equal(jobs[0].ext, 'bin');
  cleanup();
});

test('every binary form the old web can send is a receipt: Buffer, Uint8Array and the JSON form of a Buffer', async () => {
  const { service, jobs, cleanup } = setup();
  for (const receiptFileBinary of [Buffer.from(RECEIPT_BYTES), new Uint8Array(RECEIPT_BYTES), { type: 'Buffer', data: [...RECEIPT_BYTES] }]) {
    assert.deepEqual(await service.printReceipt({ receiptFileBinary }), { ok: true });
  }
  assert.equal(jobs.length, 3);
  for (const job of jobs) assert.deepEqual(job.bytes, RECEIPT_BYTES);
  cleanup();
});

test('the Open button ({ openCashDrawer: true, order: false }) is a drawer request: the password window is shown and nothing is printed', async () => {
  const { service, jobs, prompts, cleanup } = setup();
  assert.deepEqual(await service.printReceipt(OPEN_BUTTON), { ok: true, details: { prompted: true } });
  assert.deepEqual(prompts, ['shown']);
  assert.equal(jobs.length, 0);
  assert.deepEqual(await service.printReceipt({ openCashDrawer: true }), { ok: true, details: { prompted: true } }, 'the slim payload of the new web');
  cleanup();
});

test('openCashDrawer WITH an order is still a receipt (the receipt carries the kick bytes itself)', async () => {
  const { service, jobs, prompts, cleanup } = setup();
  const kick = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xff]);
  assert.deepEqual(await service.printReceipt({ ...legacyReceipt({ receiptFileBinary: kick }), openCashDrawer: true }), { ok: true });
  assert.equal(prompts.length, 0);
  assert.deepEqual(jobs[0].bytes, kick, 'sent verbatim: the drawer settings do not apply to it');
  cleanup();
});

test('the Open button says why when the drawer cannot be opened, without showing a window', async () => {
  const off = setup({ drawer: { enabled: false } });
  const disabled = await off.service.printReceipt(OPEN_BUTTON);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'DRAWER_DISABLED');
  assert.deepEqual(off.prompts, []);

  const noPassword = setup({ password: '' });
  const missing = await noPassword.service.printReceipt(OPEN_BUTTON);
  assert.equal(missing.code, 'DRAWER_PASSWORD_NOT_SET');
  assert.match(missing.message, /Settings > Cash drawer/);
  assert.deepEqual(noPassword.prompts, []);
  off.cleanup();
  noPassword.cleanup();
});

test('a prompt window that cannot be shown is a DRAWER_FAILED Result, not a thrown error', async () => {
  const { service, cleanup } = setup({ prompt: false });
  const result = await service.printReceipt(OPEN_BUTTON);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRAWER_FAILED');
  cleanup();
});

test('nothing to print, or not a payload at all, is INVALID_PAYLOAD', async () => {
  const { service, jobs, cleanup } = setup();
  for (const payload of [undefined, null, 'receipt', 42, [1, 2, 3], {}, { receiptFileBinary: null }, { receiptFileBinary: 0 }, { openCashDrawer: false }]) {
    const result = await service.printReceipt(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, 'INVALID_PAYLOAD', JSON.stringify(payload));
  }
  const empty = await service.printReceipt({ receiptFileBinary: new Uint8Array(0) });
  assert.equal(empty.code, 'INVALID_PAYLOAD');
  assert.equal(jobs.length, 0);
  cleanup();
});

test('a receipt above 5 MB is refused as INVALID_PAYLOAD before any printer is touched', async () => {
  const { service, jobs, cleanup } = setup();
  const result = await service.printReceipt({ receiptFileBinary: new Uint8Array(5 * 1024 * 1024 + 1) });
  assert.equal(result.code, 'INVALID_PAYLOAD');
  assert.equal(jobs.length, 0);
  cleanup();
});

test('a printer that fails comes back as its own code and message, never as an exception', async () => {
  const { service, rawPrinter, cleanup } = setup();
  rawPrinter.failWith = new PrintError('PRINTER_NOT_FOUND', undefined, { printerName: 'EPSON TM-T20' });
  const result = await service.printReceipt(legacyReceipt());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRINTER_NOT_FOUND');
  assert.match(result.message, /EPSON TM-T20/);
  rawPrinter.failWith = new Error('some internal error text');
  const unknown = await service.printReceipt(legacyReceipt());
  assert.equal(unknown.code, 'UNKNOWN');
  assert.doesNotMatch(unknown.message, /internal error/);
  cleanup();
});

test('no receipt printer set up answers NO_PRINTER_CONFIGURED with the next step in the message', async () => {
  const { service, cleanup } = setup({ printers: { receipt: { printerName: '', port: '' } } });
  const result = await service.printReceipt(legacyReceipt());
  assert.equal(result.code, 'NO_PRINTER_CONFIGURED');
  assert.match(result.message, /Settings > Printers/);
  cleanup();
});

// ---- labels ----------------------------------------------------------------------------------------------------------------

test('a ZPL string is the Zebra path: UTF-8 bytes to the label printer', async () => {
  const { service, jobs, dymoPrints, cleanup } = setup();
  const zpl = '^XA^FO20,20^A0N,30,30^FDiPhone 13^FS^XZ';
  assert.deepEqual(await service.printBarcode({ barcodefinal: zpl, barcode: '123', title: 'x' }), { ok: true });
  assert.deepEqual(jobs[0].bytes, Buffer.from(zpl));
  assert.deepEqual(jobs[0].target, { transport: 'system', printerName: 'ZDesigner ZD420', port: '' });
  assert.equal(jobs[0].ext, 'zpl');
  assert.equal(dymoPrints.length, 0);
  cleanup();
});

test('{ printer: "zebra", zpl } is the Zebra path too; a missing or blank ZPL is INVALID_PAYLOAD', async () => {
  const { service, jobs, cleanup } = setup();
  assert.deepEqual(await service.printBarcode({ barcodefinal: { printer: 'zebra', zpl: '^XA^XZ' } }), { ok: true });
  assert.equal(jobs.length, 1);
  for (const barcodefinal of [{ printer: 'zebra' }, { printer: 'zebra', zpl: '   ' }, '', '   ', { printer: 'dymo-ish' }]) {
    const result = await service.printBarcode({ barcodefinal });
    assert.equal(result.code, 'INVALID_PAYLOAD', JSON.stringify(barcodefinal));
  }
  cleanup();
});

test('barcodefinal.printer === "dymo" is the DYMO path, with the whole envelope (lab and repair labels included)', async () => {
  const { service, jobs, dymoPrints, cleanup } = setup();
  const label = { barcodefinal: { printer: 'dymo', title: 'iPhone 13', barcode: 'ABC123' }, size: '32x57', design: '1', prints: 3, currency: 'GBP' };
  const lab = { barcodefinal: { printer: 'dymo' }, type: 'lab', barcode: 'LAB1', title: 'Lab item' };
  const repair = { barcodefinal: { printer: 'dymo', design: 'repair', orderItems: [{ product_name: 'Screen' }] }, barcode: 'R1', design: 'repair' };
  for (const payload of [label, lab, repair]) assert.deepEqual(await service.printBarcode(payload), { ok: true });
  assert.deepEqual(dymoPrints, [label, lab, repair]);
  assert.equal(jobs.length, 0);
  cleanup();
});

test('a repair label with a 300 KB property the app never reads is routed as it is (the DYMO service reads only its fields)', async () => {
  const { service, dymoPrints, cleanup } = setup();
  const payload = { barcodefinal: { printer: 'dymo', design: 'repair', orderItem: { product_name: 'Screen', huge: 'H'.repeat(300 * 1024) } }, design: 'repair' };
  assert.deepEqual(await service.printBarcode(payload), { ok: true });
  assert.equal(dymoPrints[0], payload, 'the same object: nothing is copied or inspected');
  cleanup();
});

test('a failure of the DYMO service is passed on exactly as it answered', async () => {
  const { service, dymo, cleanup } = setup();
  dymo.result = { ok: false, code: 'DYMO_NO_PRINTER', message: 'No DYMO printer was found.', details: { printed: 0, total: 1 } };
  assert.deepEqual(await service.printBarcode({ barcodefinal: { printer: 'dymo' } }), dymo.result);
  cleanup();
});

test('no label at all (the web has no label printer type chosen) is INVALID_PAYLOAD, not a crash', async () => {
  const { service, cleanup } = setup();
  for (const payload of [undefined, null, 'x', {}, { barcodefinal: null }, { barcodefinal: undefined, barcode: '1' }]) {
    const result = await service.printBarcode(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, 'INVALID_PAYLOAD', JSON.stringify(payload));
  }
  cleanup();
});

test('DYMO labels run one after the other, in the order they were sent, even when the first one is slow', async () => {
  const { service, dymo, cleanup } = setup();
  const finished = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  dymo.print = async (payload) => {
    if (payload.title === 'first') await gate;
    finished.push(payload.title);
    return { ok: true };
  };
  const labelOf = (title) => ({ barcodefinal: { printer: 'dymo' }, title });
  const results = [service.printBarcode(labelOf('first')), service.printBarcode(labelOf('second')), service.printBarcode(labelOf('third'))];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finished, [], 'nothing overtakes the first label');
  release();
  assert.deepEqual((await Promise.all(results)).map((r) => r.ok), [true, true, true]);
  assert.deepEqual(finished, ['first', 'second', 'third']);
  cleanup();
});

test('the DYMO queue has its own key and a generous timeout, and a job that times out is a PRINT_TIMEOUT Result', async () => {
  assert.equal(DYMO_QUEUE_KEY, 'dymo');
  assert.ok(DYMO_JOB_TIMEOUT_MS >= 120_000);
  const enqueued = [];
  const queue = { enqueue: (key, fn, options) => { enqueued.push({ key, options }); return Promise.reject(new PrintError('PRINT_TIMEOUT')); } };
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store });
  const service = createPrintService({ config, rawPrinter: { printRaw: async () => ({}) }, dymo: { print: async () => ({ ok: true }) }, drawer: { open: async () => ({ ok: true }) }, queue });
  const result = await service.printBarcode({ barcodefinal: { printer: 'dymo' } });
  assert.equal(result.code, 'PRINT_TIMEOUT');
  assert.equal(enqueued[0].key, 'dymo');
  assert.equal(enqueued[0].options.timeoutMs, DYMO_JOB_TIMEOUT_MS);
  env.cleanup();
});

test('a batch of 20 different Zebra labels is sent in order, one job each', async () => {
  const { service, jobs, cleanup } = setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => service.printBarcode({ barcodefinal: `^XA^FDLabel ${i}^FS^XZ` })));
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(jobs.map((job) => job.bytes.toString()), Array.from({ length: 20 }, (_, i) => `^XA^FDLabel ${i}^FS^XZ`));
  cleanup();
});

// ---- the drawer ------------------------------------------------------------------------------------------------------------

test('openDrawer takes the password of the new API ({ password }) and of the old one ({ cashDrawerOpenPassword }) and sends 1B 70 00 19 FF', async () => {
  const { service, jobs, cleanup } = setup();
  assert.deepEqual(await service.openDrawer({ password: PASSWORD }), { ok: true });
  assert.deepEqual(await service.openDrawer({ cashDrawerOpenPassword: PASSWORD }, { source: 'legacy' }), { ok: true });
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.deepEqual([...job.bytes], [0x1b, 0x70, 0x00, 0x19, 0xff]);
    assert.equal(job.label, 'cash drawer');
  }
  cleanup();
});

test('a wrong or missing drawer password is reported, counted, and locks out after five wrong ones', async () => {
  const { service, jobs, cleanup } = setup();
  assert.equal((await service.openDrawer({})).code, 'PASSWORD_REQUIRED');
  assert.equal((await service.openDrawer(undefined)).code, 'PASSWORD_REQUIRED');
  assert.equal((await service.openDrawer({ password: 5 })).code, 'PASSWORD_REQUIRED');
  for (let i = 0; i < 4; i += 1) assert.equal((await service.openDrawer({ password: 'wrong' })).code, 'DRAWER_WRONG_PASSWORD');
  const locked = await service.openDrawer({ password: 'wrong' });
  assert.equal(locked.code, 'DRAWER_WRONG_PASSWORD');
  assert.ok(locked.details.retryAfterSec > 0, 'the fifth wrong password starts the lock');
  const refused = await service.openDrawer({ password: PASSWORD });
  assert.equal(refused.code, 'DRAWER_LOCKED_OUT');
  assert.equal(jobs.length, 0, 'not even the right password opens the drawer while locked');
  cleanup();
});

// ---- logging and wiring ----------------------------------------------------------------------------------------------------

test('the log gets one line per job (kind, outcome, duration, code) and never a payload, a password or receipt text', async () => {
  const { service, logs, rawPrinter, cleanup } = setup();
  await service.printReceipt(legacyReceipt({ settings: { secret: 'SECRET-CUSTOMER-NOTE' } }));
  await service.printBarcode({ barcodefinal: '^XA^FDSECRET-LABEL-TEXT^FS^XZ' });
  rawPrinter.failWith = new PrintError('SPOOLER_ERROR');
  await service.printReceipt(legacyReceipt());
  await service.openDrawer({ password: PASSWORD });
  const text = logs.join('\n');
  assert.match(text, /job receipt: ok in \d+ ms/);
  assert.match(text, /job label zebra: ok in \d+ ms/);
  assert.match(text, /job receipt: failed \(SPOOLER_ERROR\) in \d+ ms/);
  assert.doesNotMatch(text, /SECRET|drawer-pw|Gadgets Shop|iPhone/);
  cleanup();
});

test('without a queue DYMO labels still print (the queue is an option), and a missing dependency is a clear error at start-up', async () => {
  const { service, dymoPrints, cleanup } = setup({ withQueue: false });
  assert.deepEqual(await service.printBarcode({ barcodefinal: { printer: 'dymo' } }), { ok: true });
  assert.equal(dymoPrints.length, 1);
  cleanup();
  assert.throws(() => createPrintService({}), /config, dymo, drawer, receiptPrinter or rawPrinter, zebraPrinter or rawPrinter/);
});

test('ready-made receipt and Zebra printers are used when they are given', async () => {
  const sent = [];
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store });
  const service = createPrintService({
    config,
    dymo: { print: async () => ({ ok: true }) },
    drawer: { open: async () => ({ ok: true }) },
    receiptPrinter: { print: async (payload) => { sent.push(['receipt', payload]); return { ok: true }; } },
    zebraPrinter: { print: async (payload) => { sent.push(['zebra', payload]); return { ok: true }; } },
  });
  await service.printReceipt({ receiptFileBinary: [1, 2, 3] });
  await service.printBarcode({ barcodefinal: '^XA^XZ' });
  assert.deepEqual(sent.map(([kind]) => kind), ['receipt', 'zebra']);
  assert.deepEqual(sent[0][1], { receiptFileBinary: [1, 2, 3] });
  assert.equal(sent[1][1], '^XA^XZ');
  env.cleanup();
});
