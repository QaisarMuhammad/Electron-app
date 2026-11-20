'use strict';

/**
 * The drawer through T1's REAL queue and raw printer (macOS/Linux `lp` transport with a fake execFile and a fake
 * file system): proves the job the drawer builds (target shape, Buffer bytes, label) is what the transports accept,
 * and that their errors come back as the drawer's Result unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobQueue } = require('../../src/main/printing/queue');
const { createRawPrinter } = require('../../src/main/printing/transports');
const { createHarness, PLAIN, PRINTER } = require('./harness');

/** A real raw printer on a fake POSIX machine: writes land in `written`, `lp` runs land in `runs`. */
function posixRawPrinter({ lpFails } = {}) {
  const written = [];
  const removed = [];
  const runs = [];
  const fs = {
    promises: {
      writeFile: async (file, data, options) => { written.push({ file, bytes: Buffer.from(data).toString('hex').toUpperCase(), options }); },
      unlink: async (file) => { removed.push(file); },
    },
    constants: { O_WRONLY: 1 },
  };
  const execFile = (file, args, options, callback) => {
    runs.push({ file, args });
    if (lpFails) callback(Object.assign(new Error('lp failed'), { code: 1 }), '', lpFails);
    else callback(null, 'request id is EPSON-1 (1 file(s))', '');
  };
  const rawPrinter = createRawPrinter({ platform: 'linux', fs, execFile, tmpDir: '/tmp', queue: createJobQueue({}) });
  return { rawPrinter, written, removed, runs };
}

test('the drawer pulse reaches `lp -d <printer> -o raw <file>` as exactly the bytes 1B 70 00 19 FF, and the temp file is removed', async (t) => {
  const io = posixRawPrinter();
  const h = createHarness(t, { rawPrinter: io.rawPrinter });
  const result = await h.drawer.open({ password: PLAIN, source: 'menu' });

  assert.equal(result.ok, true);
  assert.equal(io.runs.length, 1);
  assert.equal(io.runs[0].file, 'lp');
  assert.deepEqual(io.runs[0].args.slice(0, 3), ['-d', PRINTER.printerName, '-o']);
  assert.equal(io.runs[0].args[3], 'raw');
  assert.equal(io.written.length, 1);
  assert.equal(io.written[0].bytes, '1B700019FF');
  assert.equal(io.runs[0].args[4], io.written[0].file, 'lp is given the file that was written');
  assert.deepEqual(io.removed, [io.written[0].file]);
});

test('a configured pin and pulse reach the printer as the matching bytes', async (t) => {
  const io = posixRawPrinter();
  const h = createHarness(t, { rawPrinter: io.rawPrinter });
  h.config.setDrawer({ pin: 5, onTimeMs: 100, offTimeMs: 400 });
  assert.equal((await h.drawer.open({ password: PLAIN })).ok, true);
  assert.equal(io.written[0].bytes, '1B700132C8');
});

test('no receipt printer set up: the raw printer answers NO_PRINTER_CONFIGURED and nothing runs', async (t) => {
  const io = posixRawPrinter();
  const h = createHarness(t, { rawPrinter: io.rawPrinter, printer: null });
  const result = await h.drawer.open({ password: PLAIN });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PRINTER_CONFIGURED');
  assert.equal(typeof result.message, 'string');
  assert.equal(io.runs.length, 0);
  assert.equal(io.written.length, 0);
});

test('a printer CUPS does not know comes back as PRINTER_NOT_FOUND with its name', async (t) => {
  const io = posixRawPrinter({ lpFails: 'lp: The printer or class does not exist.' });
  const h = createHarness(t, { rawPrinter: io.rawPrinter });
  const result = await h.drawer.open({ password: PLAIN });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRINTER_NOT_FOUND');
  assert.equal(result.details.printerName, PRINTER.printerName);
  assert.deepEqual(io.removed, [io.written[0].file], 'the temp file is removed after a failure too');
  assert.equal(h.throttle.state().failures, 0, 'the password was right');
});

test('any other lp failure is a SPOOLER_ERROR', async (t) => {
  const io = posixRawPrinter({ lpFails: 'lp: Error - scheduler not responding.' });
  const h = createHarness(t, { rawPrinter: io.rawPrinter });
  assert.equal((await h.drawer.open({ password: PLAIN })).code, 'SPOOLER_ERROR');
});

test('the legacy port transport is Windows only: on this machine it answers UNSUPPORTED_PLATFORM', async (t) => {
  const io = posixRawPrinter();
  const h = createHarness(t, { rawPrinter: io.rawPrinter, printer: { transport: 'port', printerName: '', port: 'LPT1' } });
  const result = await h.drawer.open({ password: PLAIN });
  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(io.runs.length, 0);
});

test('a wrong password never reaches the printer', async (t) => {
  const io = posixRawPrinter();
  const h = createHarness(t, { rawPrinter: io.rawPrinter });
  assert.equal((await h.drawer.open({ password: 'wrong' })).code, 'DRAWER_WRONG_PASSWORD');
  assert.equal(io.runs.length, 0);
  assert.equal(io.written.length, 0);
});
