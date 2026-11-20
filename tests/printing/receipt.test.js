'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReceiptPrinter, normalizeReceiptBytes, buildTestReceipt, MAX_RECEIPT_BYTES } = require('../../src/main/printing/receipt');
const { createRawPrinter } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES, PrintError } = require('../../src/main/errors');
const { createFakeFs, createFakeExecFile, createRecordingLog } = require('../helpers/fake-io');

const BYTES = [0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00];

function invalidPayload(value) {
  assert.throws(() => normalizeReceiptBytes(value), (err) => err instanceof PrintError && err.code === ERROR_CODES.INVALID_PAYLOAD && typeof err.details.reason === 'string');
}

// ---- normalizeReceiptBytes ------------------------------------------------------------------------------------

test('normalizeReceiptBytes accepts every binary form the web and Electron can send', () => {
  const buffer = Buffer.from(BYTES);
  const shared = new SharedArrayBuffer(BYTES.length);
  new Uint8Array(shared).set(BYTES);
  const forms = {
    Buffer: buffer,
    Uint8Array: new Uint8Array(BYTES),
    ArrayBuffer: new Uint8Array(BYTES).buffer,
    SharedArrayBuffer: shared,
    'JSON Buffer': { type: 'Buffer', data: [...BYTES] },
    'number array': [...BYTES],
    DataView: new DataView(new Uint8Array(BYTES).buffer),
    'JSON round trip of a Buffer': JSON.parse(JSON.stringify(buffer)),
  };
  for (const [name, form] of Object.entries(forms)) {
    const result = normalizeReceiptBytes(form);
    assert.ok(Buffer.isBuffer(result), name);
    assert.deepEqual([...result], BYTES, name);
  }
});

test('a view over a larger buffer yields only its own bytes', () => {
  const backing = new Uint8Array([9, 9, ...BYTES, 9, 9]);
  assert.deepEqual([...normalizeReceiptBytes(backing.subarray(2, 2 + BYTES.length))], BYTES);
  assert.deepEqual([...normalizeReceiptBytes(Buffer.from(backing.buffer, 2, BYTES.length))], BYTES);
  const words = new Uint16Array([0x4241, 0x4443]);
  assert.deepEqual([...normalizeReceiptBytes(words)], [0x41, 0x42, 0x43, 0x44], 'other typed arrays give their raw bytes');
});

test('the result is a private copy: later changes to the caller\'s data cannot alter the job', () => {
  const original = new Uint8Array(BYTES);
  const copy = normalizeReceiptBytes(original);
  original[0] = 0xff;
  assert.equal(copy[0], 0x1b);
  const buffer = Buffer.from(BYTES);
  const copy2 = normalizeReceiptBytes(buffer);
  buffer[0] = 0xff;
  assert.equal(copy2[0], 0x1b);
  const array = [...BYTES];
  const copy3 = normalizeReceiptBytes(array);
  array[0] = 0xff;
  assert.equal(copy3[0], 0x1b);
});

test('empty input is INVALID_PAYLOAD', () => {
  for (const empty of [Buffer.alloc(0), new Uint8Array(0), new ArrayBuffer(0), [], { type: 'Buffer', data: [] }, new DataView(new ArrayBuffer(0))]) {
    invalidPayload(empty);
  }
});

test('anything that is not binary is INVALID_PAYLOAD', () => {
  const notBinary = [
    undefined, null, 'ESC @', '', 42, true, {}, { receiptFileBinary: BYTES }, { type: 'Buffer' }, { type: 'Buffer', data: 'abc' }, { type: 'Buffer', data: { 0: 1 } },
    { type: 'buffer', data: [1] }, () => BYTES, Symbol('x'), { 0: 27, 1: 64, length: 2 }, new Map(), new Set([1]),
  ];
  for (const value of notBinary) invalidPayload(value);
});

test('arrays must hold byte values only', () => {
  const bad = [[1, 2, '3'], [1, 2.5], [-1], [256], [1, NaN], [1, null], [1, undefined], [1, [2]], [true], [Infinity], new Array(3), ['a']];
  for (const value of bad) {
    invalidPayload(value);
    invalidPayload({ type: 'Buffer', data: value });
  }
});

test('more than 5 MB is INVALID_PAYLOAD for every form, exactly 5 MB is accepted', () => {
  assert.equal(MAX_RECEIPT_BYTES, 5 * 1024 * 1024);
  const tooBig = MAX_RECEIPT_BYTES + 1;
  invalidPayload(Buffer.alloc(tooBig));
  invalidPayload(new Uint8Array(tooBig));
  invalidPayload(new ArrayBuffer(tooBig));
  invalidPayload(new Uint16Array(Math.ceil(tooBig / 2)));
  invalidPayload(new Array(tooBig).fill(1));
  invalidPayload({ type: 'Buffer', data: new Array(tooBig) });
  assert.equal(normalizeReceiptBytes(Buffer.alloc(MAX_RECEIPT_BYTES, 1)).length, MAX_RECEIPT_BYTES);
  assert.equal(normalizeReceiptBytes(new Array(1000).fill(7)).length, 1000);
});

// ---- createReceiptPrinter -------------------------------------------------------------------------------------

function fakeRawPrinter(behaviour) {
  const jobs = [];
  return {
    jobs,
    printRaw: async (job) => {
      jobs.push(job);
      if (behaviour) return behaviour(job);
      return { ok: true };
    },
  };
}

const TARGET = { transport: 'system', printerName: 'EPSON TM-T20', port: '' };

test('print hands the bytes and the configured target to the raw printer and answers { ok: true }', async () => {
  const rawPrinter = fakeRawPrinter();
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await receipt.print(Buffer.from(BYTES)), { ok: true });
  assert.equal(rawPrinter.jobs.length, 1);
  assert.deepEqual(rawPrinter.jobs[0].target, TARGET);
  assert.deepEqual([...rawPrinter.jobs[0].data], BYTES);
  assert.equal(rawPrinter.jobs[0].label, 'receipt');
  assert.equal(rawPrinter.jobs[0].ext, 'bin');
});

test('print accepts the legacy envelope and reads nothing but receiptFileBinary', async () => {
  const rawPrinter = fakeRawPrinter();
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => TARGET });
  const reads = [];
  const envelope = new Proxy({
    receiptFileBinary: new Uint8Array(BYTES),
    order: { notes: 'free text' },
    business: { name: 'Shop' },
    businessData: {},
    settings: { big: 'x'.repeat(10 * 1024) },
    isDuplicate: true,
  }, { get: (target, key) => { reads.push(String(key)); return target[key]; } });

  assert.deepEqual(await receipt.print(envelope), { ok: true });
  assert.deepEqual(reads, ['receiptFileBinary'], 'unread properties are never inspected');
  assert.deepEqual([...rawPrinter.jobs[0].data], BYTES);
});

test('a legacy receipt with a 10 KB string inside settings prints', async () => {
  const rawPrinter = fakeRawPrinter();
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => TARGET });
  const result = await receipt.print({ receiptFileBinary: Buffer.from(BYTES), settings: { text: 'y'.repeat(10 * 1024) }, order: { id: 1 } });
  assert.deepEqual(result, { ok: true });
});

test('the JSON form of a Buffer inside an envelope works', async () => {
  const rawPrinter = fakeRawPrinter();
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await receipt.print({ receiptFileBinary: { type: 'Buffer', data: BYTES } }), { ok: true });
  assert.deepEqual([...rawPrinter.jobs[0].data], BYTES);
});

test('the target is read for every job, and getTarget may be async', async () => {
  const rawPrinter = fakeRawPrinter();
  let current = { transport: 'system', printerName: 'First' };
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: async () => current });
  await receipt.print(Buffer.from(BYTES));
  current = { transport: 'port', port: 'LPT1' };
  await receipt.print(Buffer.from(BYTES));
  assert.deepEqual(rawPrinter.jobs.map((job) => job.target), [
    { transport: 'system', printerName: 'First', port: '' },
    { transport: 'port', printerName: '', port: 'LPT1' },
  ]);
});

test('with neither a printer name nor a port the answer is NO_PRINTER_CONFIGURED and nothing is sent', async () => {
  for (const target of [{}, null, undefined, { transport: 'system', printerName: '  ', port: '' }, { printerName: '', port: '' }]) {
    const rawPrinter = fakeRawPrinter();
    const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => target });
    const result = await receipt.print(Buffer.from(BYTES));
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.NO_PRINTER_CONFIGURED);
    assert.match(result.message, /Settings > Printers/);
    assert.equal(rawPrinter.jobs.length, 0);
  }
  const noGetter = createReceiptPrinter({ rawPrinter: fakeRawPrinter(), getTarget: undefined });
  assert.equal((await noGetter.print(Buffer.from(BYTES))).code, ERROR_CODES.NO_PRINTER_CONFIGURED);
});

test('an empty or non-binary payload is INVALID_PAYLOAD and is checked before the printer', async () => {
  const rawPrinter = fakeRawPrinter();
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => ({}) });
  for (const payload of [undefined, null, '', 'text', {}, { receiptFileBinary: new Uint8Array(0) }, { receiptFileBinary: 'abc' }, { order: {} }, Buffer.alloc(MAX_RECEIPT_BYTES + 1)]) {
    const result = await receipt.print(payload);
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.INVALID_PAYLOAD, JSON.stringify(payload && Object.keys(payload)));
  }
  assert.equal(rawPrinter.jobs.length, 0);
});

test('a failure of the raw printer becomes a Result with the same code, message and details', async () => {
  const failure = new PrintError(ERROR_CODES.PRINTER_NOT_FOUND, undefined, { printerName: 'EPSON TM-T20' });
  const receipt = createReceiptPrinter({ rawPrinter: fakeRawPrinter(() => { throw failure; }), getTarget: () => TARGET });
  assert.deepEqual(await receipt.print(Buffer.from(BYTES)), {
    ok: false, code: 'PRINTER_NOT_FOUND', message: failure.message, details: { printerName: 'EPSON TM-T20' },
  });
});

test('print never rejects, and a foreign error does not leak its text', async () => {
  const receipt = createReceiptPrinter({ rawPrinter: fakeRawPrinter(() => { throw new Error('ENOENT C:\\secret\\path'); }), getTarget: () => TARGET });
  const result = await receipt.print(Buffer.from(BYTES));
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.UNKNOWN);
  assert.doesNotMatch(result.message, /secret/);
  const throwingTarget = createReceiptPrinter({ rawPrinter: fakeRawPrinter(), getTarget: () => { throw new Error('config unreadable'); } });
  assert.equal((await throwingTarget.print(Buffer.from(BYTES))).code, ERROR_CODES.UNKNOWN);
});

test('failures are logged with the code only, never with the receipt', async () => {
  const log = createRecordingLog();
  const receipt = createReceiptPrinter({ rawPrinter: fakeRawPrinter(() => { throw new PrintError(ERROR_CODES.SPOOLER_ERROR); }), getTarget: () => TARGET, log });
  await receipt.print(Buffer.from('SECRET CUSTOMER NAME'));
  assert.deepEqual(log.entries, [{ level: 'warn', args: ['receipt print failed', { code: 'SPOOLER_ERROR' }] }]);
});

test('end to end with the real raw printer: the receipt bytes reach the spooler intact', async () => {
  const files = createFakeFs();
  let atExec = null;
  const exec = createFakeExecFile((call, done) => {
    atExec = Buffer.from(files.files.get(call.args[call.args.length - 1]).data);
    done(null);
  });
  const rawPrinter = createRawPrinter({
    platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: 'C:\\Temp', resourcesPath: 'C:\\res', queue: createJobQueue(), pid: 1,
  });
  const receipt = createReceiptPrinter({ rawPrinter, getTarget: () => ({ transport: 'system', printerName: 'EPSON TM-T20' }) });
  assert.deepEqual(await receipt.print({ receiptFileBinary: new Uint8Array(BYTES) }), { ok: true });
  assert.deepEqual([...atExec], BYTES);
  assert.equal(files.files.size, 0);
});

// ---- buildTestReceipt -----------------------------------------------------------------------------------------

test('the test receipt is ESC @, a centred title, plain ASCII lines, a feed and a full cut', () => {
  const bytes = buildTestReceipt({ printerName: 'EPSON TM-T20III', appName: 'GadgetsPOS' });
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'starts with ESC @');
  assert.deepEqual([...bytes.subarray(2, 5)], [0x1b, 0x61, 0x01], 'centre');
  assert.ok(bytes.subarray(5, 5 + 'GadgetsPOS\n'.length).equals(Buffer.from('GadgetsPOS\n')), 'the title follows');
  assert.deepEqual([...bytes.subarray(bytes.length - 3)], [0x1d, 0x56, 0x00], 'ends with GS V 0 (full cut)');

  const text = bytes.subarray(5 + 'GadgetsPOS\n'.length, bytes.length - 3);
  assert.deepEqual([...text.subarray(0, 3)], [0x1b, 0x61, 0x00], 'back to left alignment');
  const body = text.subarray(3).toString('latin1');
  assert.match(body, /^[\x20-\x7e\n]+$/, 'plain ASCII and line feeds only');
  const lines = body.split('\n').filter(Boolean);
  assert.ok(lines.length >= 3 && lines.length <= 4, `3 to 4 text lines, got ${lines.length}`);
  assert.ok(lines.some((line) => line.includes('EPSON TM-T20III')));
  assert.ok(lines.every((line) => line.length <= 32), 'every line fits a 58 mm slip');
  assert.match(body, /\n\n\n\n$/, 'a feed before the cut');
});

/** Removes the three command kinds the test receipt uses (ESC @, ESC a n, GS V 0) and returns what is left as text. */
function textOf(bytes) {
  return bytes.toString('latin1').replace(/\x1b@|\x1ba[\x00\x01]|\x1dV\x00/g, '');
}

test('the test receipt keeps hostile or long names printable and cannot smuggle in commands', () => {
  const hostile = 'Café プリンター\n\u001b@\u001dV\u0000 drawer\u001bp\u0000' + 'x'.repeat(100);
  const bytes = buildTestReceipt({ printerName: hostile, appName: '£ Shop ☃\u001b@' });
  const text = textOf(bytes);
  assert.match(text, /^[\x20-\x7e\n]+$/, 'after removing the three known commands only plain ASCII and line feeds remain');
  assert.equal(bytes.filter((byte) => byte === 0x1b).length, 3, 'exactly ESC @, ESC a 1 and ESC a 0');
  assert.equal(bytes.filter((byte) => byte === 0x1d).length, 1, 'exactly one GS (the cut)');
  assert.ok(text.split('\n').every((line) => line.length <= 32));
});

test('the test receipt has defaults and leaves out the printer line when no name is known', () => {
  const lines = textOf(buildTestReceipt()).split('\n').filter(Boolean);
  assert.deepEqual(lines, ['GadgetsPOS', 'Printer test', 'If you can read this,', 'your printer is ready.']);
  assert.deepEqual(textOf(buildTestReceipt({ printerName: '', appName: '' })).split('\n').filter(Boolean)[0], 'GadgetsPOS');
  const named = textOf(buildTestReceipt({ printerName: 'Zebra' })).split('\n').filter(Boolean);
  assert.deepEqual(named, ['GadgetsPOS', 'Printer test', 'Printer: Zebra', 'If you can read this,', 'your printer is ready.']);
});
