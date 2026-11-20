'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createZebraPrinter, buildTestZpl, MAX_ZPL_BYTES } = require('../../src/main/printing/zebra');
const { createRawPrinter } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES, PrintError } = require('../../src/main/errors');
const {
  createFakeFs, createFakeExecFile, createRecordingLog, sleep,
} = require('../helpers/fake-io');

const ZPL = '^XA^FO20,20^A0N,30,30^FDiPhone 13 128GB^FS^FO20,60^BY2^BCN,60,Y,N,N^FD123456789012^FS^XZ';
const TARGET = { transport: 'system', printerName: 'ZDesigner ZD420', port: '' };

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

// ---- input rules ----------------------------------------------------------------------------------------------

test('print accepts the legacy ZPL string and sends its UTF-8 bytes to the label printer', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await zebra.print(ZPL), { ok: true });
  assert.equal(rawPrinter.jobs.length, 1);
  assert.deepEqual(rawPrinter.jobs[0].target, TARGET);
  assert.ok(Buffer.isBuffer(rawPrinter.jobs[0].data));
  assert.equal(rawPrinter.jobs[0].data.toString('utf8'), ZPL);
  assert.equal(rawPrinter.jobs[0].label, 'label zebra');
  assert.equal(rawPrinter.jobs[0].ext, 'zpl');
});

test('print accepts { printer: "zebra", zpl } and an object that only has zpl', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await zebra.print({ printer: 'zebra', zpl: ZPL }), { ok: true });
  assert.deepEqual(await zebra.print({ zpl: ZPL, title: 'ignored' }), { ok: true });
  assert.equal(rawPrinter.jobs.length, 2);
  assert.ok(rawPrinter.jobs.every((job) => job.data.toString('utf8') === ZPL));
});

test('labels are sent as UTF-8, so accents and other scripts survive', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  const text = '^XA^CI28^FDCaf\u00e9 \u00dcber \u4ef7\u683c \u20ac9.99^FS^XZ';
  await zebra.print(text);
  assert.deepEqual([...rawPrinter.jobs[0].data], [...Buffer.from(text, 'utf8')]);
});

test('missing, blank or non-text labels are INVALID_PAYLOAD and nothing is sent', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  const bad = [undefined, null, '', '   \n\t', 42, true, [], ['^XA^XZ'], {}, { zpl: '' }, { zpl: '  ' }, { zpl: 5 }, { zpl: ['^XA'] }, { printer: 'zebra' }, new Uint8Array([94, 88])];
  for (const value of bad) {
    const result = await zebra.print(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.INVALID_PAYLOAD, JSON.stringify(value));
  }
  assert.equal(rawPrinter.jobs.length, 0);
});

test('an object for another printer type is refused', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  for (const printer of ['dymo', 'Zebra', '', null, 0]) {
    const result = await zebra.print({ printer, zpl: ZPL });
    assert.equal(result.code, ERROR_CODES.INVALID_PAYLOAD, String(printer));
  }
  assert.equal(rawPrinter.jobs.length, 0);
});

test('the limit is 64 KB of UTF-8, counted in bytes', async () => {
  assert.equal(MAX_ZPL_BYTES, 64 * 1024);
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await zebra.print('a'.repeat(MAX_ZPL_BYTES)), { ok: true });
  assert.equal((await zebra.print('a'.repeat(MAX_ZPL_BYTES + 1))).code, ERROR_CODES.INVALID_PAYLOAD);
  assert.equal((await zebra.print('\u00e9'.repeat(MAX_ZPL_BYTES / 2 + 1))).code, ERROR_CODES.INVALID_PAYLOAD, 'two bytes per character');
  assert.deepEqual(await zebra.print('\u00e9'.repeat(MAX_ZPL_BYTES / 2)), { ok: true });
  assert.equal(rawPrinter.jobs.length, 2);
});

// ---- target and failures --------------------------------------------------------------------------------------

test('without a configured label printer the answer is NO_PRINTER_CONFIGURED', async () => {
  for (const target of [{}, null, undefined, { transport: 'port', port: '' }]) {
    const rawPrinter = fakeRawPrinter();
    const zebra = createZebraPrinter({ rawPrinter, getTarget: () => target });
    const result = await zebra.print(ZPL);
    assert.equal(result.code, ERROR_CODES.NO_PRINTER_CONFIGURED);
    assert.equal(rawPrinter.jobs.length, 0);
  }
});

test('a port target is passed on as a port target', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: async () => ({ port: '\\\\localhost\\ZebraZD420' }) });
  await zebra.print(ZPL);
  assert.deepEqual(rawPrinter.jobs[0].target, { transport: 'port', printerName: '', port: '\\\\localhost\\ZebraZD420' });
});

test('print never rejects: failures become Results with their code and details', async () => {
  const failing = createZebraPrinter({
    rawPrinter: fakeRawPrinter(() => { throw new PrintError(ERROR_CODES.PRINT_TIMEOUT, undefined, { label: 'label zebra' }); }),
    getTarget: () => TARGET,
  });
  const result = await failing.print(ZPL);
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.PRINT_TIMEOUT);
  assert.deepEqual(result.details, { label: 'label zebra' });

  const crashing = createZebraPrinter({ rawPrinter: fakeRawPrinter(() => { throw new Error('boom'); }), getTarget: () => TARGET });
  assert.equal((await crashing.print(ZPL)).code, ERROR_CODES.UNKNOWN);
});

test('failures are logged with the code only, never with the label text', async () => {
  const log = createRecordingLog();
  const zebra = createZebraPrinter({ rawPrinter: fakeRawPrinter(() => { throw new PrintError(ERROR_CODES.SPOOLER_ERROR); }), getTarget: () => TARGET, log });
  await zebra.print('^XA^FDSECRET CUSTOMER^FS^XZ');
  assert.deepEqual(log.entries, [{ level: 'warn', args: ['label print failed', { code: 'SPOOLER_ERROR' }] }]);
});

// ---- the v1 race: batches of labels ---------------------------------------------------------------------------

/** 20 different labels, as a serial/IMEI batch sends them. */
const batch = () => Array.from({ length: 20 }, (_, i) => `^XA^FO20,20^FDLabel ${i}^FS^FO20,60^BCN,60^FD${String(i).padStart(12, '0')}^FS^XZ`);

async function runBatch(zebra, labels) {
  const results = await Promise.all(labels.map((zpl) => zebra.print(zpl)));
  assert.ok(results.every((result) => result.ok === true), JSON.stringify(results.filter((result) => !result.ok)));
}

test('20 ZPL jobs started back to back each reach a slow Windows spooler printer with their OWN content, in order', async () => {
  const files = createFakeFs();
  const received = [];
  const names = [];
  let atPrinter = 0;
  let maxAtPrinter = 0;
  const exec = createFakeExecFile((call, done) => {
    const filePath = call.args[call.args.length - 1];
    const content = Buffer.from(files.files.get(filePath).data).toString('utf8');
    names.push(filePath);
    atPrinter += 1;
    maxAtPrinter = Math.max(maxAtPrinter, atPrinter);
    // A slow printer: the file is read only after a delay, while the next jobs are already waiting.
    setTimeout(() => {
      const stillThere = files.files.get(filePath);
      received.push(stillThere ? Buffer.from(stillThere.data).toString('utf8') : '<file vanished>');
      assert.equal(content, received[received.length - 1], 'the file did not change while the printer was reading it');
      atPrinter -= 1;
      done(null);
    }, 4);
  });
  const rawPrinter = createRawPrinter({
    platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: 'C:\\Temp', resourcesPath: 'C:\\res', queue: createJobQueue(), pid: 9,
  });
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  const labels = batch();

  await runBatch(zebra, labels);

  assert.deepEqual(received, labels, 'every label arrived complete and in the order it was started');
  assert.equal(maxAtPrinter, 1, 'jobs for one printer never overlapped');
  assert.equal(new Set(names).size, 20, 'every job used its own file (v1 reused label.zpl)');
  assert.ok(names.every((name) => /gpos-9-\d+-\d+\.zpl$/.test(name)));
  assert.equal(files.files.size, 0);
});

test('the same batch through lp on macOS and Linux arrives complete and in order', async () => {
  for (const platform of ['darwin', 'linux']) {
    const files = createFakeFs();
    const received = [];
    const exec = createFakeExecFile((call, done) => {
      const filePath = call.args[4];
      setTimeout(() => {
        received.push(Buffer.from(files.files.get(filePath).data).toString('utf8'));
        done(null);
      }, 3);
    });
    const rawPrinter = createRawPrinter({ platform, fs: files.fs, execFile: exec.execFile, tmpDir: '/tmp', queue: createJobQueue(), pid: 9 });
    const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
    const labels = batch();
    await runBatch(zebra, labels);
    assert.deepEqual(received, labels, platform);
  }
});

test('the same batch to a legacy port reaches a slow device with each label whole, in order', async () => {
  const files = createFakeFs();
  const written = [];
  files.hooks.handleWriteFile = async (handle, data) => {
    await sleep(3);
    written.push(Buffer.from(data).toString('utf8'));
  };
  const exec = createFakeExecFile();
  const rawPrinter = createRawPrinter({
    platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: 'C:\\Temp', resourcesPath: 'C:\\res', queue: createJobQueue(), pid: 9,
  });
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => ({ transport: 'port', port: 'LPT1' }) });
  const labels = batch();
  await runBatch(zebra, labels);
  assert.deepEqual(written, labels);
});

test('a failing label in the middle of a batch does not disturb the others', async () => {
  const files = createFakeFs();
  const received = [];
  const exec = createFakeExecFile((call, done) => {
    const content = Buffer.from(files.files.get(call.args[call.args.length - 1]).data).toString('utf8');
    received.push(content);
    done(content.includes('Label 7') ? Object.assign(new Error('failed'), { code: 4 }) : null);
  });
  const rawPrinter = createRawPrinter({
    platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: 'C:\\Temp', resourcesPath: 'C:\\res', queue: createJobQueue(), pid: 9,
  });
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  const labels = batch();
  const results = await Promise.all(labels.map((zpl) => zebra.print(zpl)));
  assert.deepEqual(received, labels);
  assert.equal(results[7].ok, false);
  assert.equal(results[7].code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(results.filter((result) => result.ok).length, 19);
  assert.equal(files.files.size, 0);
});

// ---- buildTestZpl ---------------------------------------------------------------------------------------------

test('the test label is a small ZPL label with the text TEST and a Code 128 sample', () => {
  const zpl = buildTestZpl();
  assert.equal(typeof zpl, 'string');
  assert.match(zpl, /^\^XA\n/);
  assert.match(zpl, /\^XZ\n$/);
  assert.match(zpl, /\^FDTEST\^FS/);
  assert.match(zpl, /\^BC[NRIB],\d+/, 'a Code 128 barcode');
  assert.match(zpl, /\^BC[^\n]*\^FD[0-9A-Za-z]+\^FS/);
  assert.match(zpl, /^[\x0a\x20-\x7e]+$/, 'plain ASCII');
  assert.ok(Buffer.byteLength(zpl) < 200);
  assert.equal(zpl.match(/\^XA/g).length, 1);
  assert.equal(zpl.match(/\^XZ/g).length, 1);
});

test('the test label goes through the production print path', async () => {
  const rawPrinter = fakeRawPrinter();
  const zebra = createZebraPrinter({ rawPrinter, getTarget: () => TARGET });
  assert.deepEqual(await zebra.print(buildTestZpl()), { ok: true });
  assert.equal(rawPrinter.jobs[0].data.toString('utf8'), buildTestZpl());
});
