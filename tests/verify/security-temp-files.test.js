'use strict';

/**
 * SECURITY lens, temp files of the print path (SPEC 9.1): permissions, predictable names, races. REGRESSION GUARDS against the REAL
 * file system (these pass today; POSIX only, where mode bits and symlinks exist).
 *
 * Every job writes its bytes (a receipt: customer names, phone numbers, items) to `gpos-<pid>-<timestamp>-<seq>.<ext>` in the OS
 * temp folder. The name is predictable, so what keeps another local account from reading, replacing or redirecting the file is
 * the way it is created: mode 0600 and `wx` (O_CREAT | O_EXCL, which also refuses a symlink that sits at the final name).
 *
 * Noted, not reported as a finding: nothing sweeps `gpos-*` files that a crash or a power cut left behind (the `finally` that
 * deletes them cannot run); they stay 0600 in the user's own temp folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { createFakeExecFile, exitError } = require('../helpers/fake-io');

const posix = process.platform === 'darwin' || process.platform === 'linux';
const options = { skip: posix ? false : 'POSIX file semantics (mode bits, symlinks)' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-verify-tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const printerOn = (dir, exec, extra = {}) => createRawPrinter({
  platform: process.platform, fs, execFile: exec.execFile, tmpDir: dir, queue: createJobQueue(), pid: 4242, ...extra,
});

test('temp files: created 0600 with exactly the job bytes, and deleted after a success and after a failure', options, async (t) => {
  const dir = tempDir(t);
  const seen = [];
  const exec = createFakeExecFile((call, done) => {
    const file = call.args[call.args.length - 1];
    seen.push({ file, mode: fs.statSync(file).mode & 0o777, content: fs.readFileSync(file) });
    if (call.args[1] === 'Broken') done(exitError(1, 'lp: The printer or class does not exist.'));
    else done(null, '', '');
  });
  const printer = printerOn(dir, exec);
  const bytes = Buffer.from('RECEIPT for J. Smith 07700 900123');

  await printer.printRaw({ target: { transport: 'system', printerName: 'Epson' }, data: bytes, label: 'receipt' });
  await assert.rejects(printer.printRaw({ target: { transport: 'system', printerName: 'Broken' }, data: bytes }), (error) => error.code === 'PRINTER_NOT_FOUND');

  assert.equal(seen.length, 2);
  for (const entry of seen) {
    assert.equal(entry.mode, 0o600, 'the temp file must not be readable by other accounts');
    assert.deepEqual(entry.content, bytes);
    assert.equal(path.dirname(entry.file), dir);
    assert.match(path.basename(entry.file), /^gpos-4242-\d+-\d+\.bin$/);
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'every temp file is deleted, also when the printer refuses the job');
});

test('temp files: forty jobs at the same moment get forty different names', options, async (t) => {
  const dir = tempDir(t);
  const names = new Set();
  const exec = createFakeExecFile((call, done) => {
    names.add(path.basename(call.args[call.args.length - 1]));
    setTimeout(() => done(null, '', ''), 5);
  });
  const printer = printerOn(dir, exec, { now: () => 1700000000000 }); // a frozen clock: only the sequence number can tell the files apart
  await Promise.all(Array.from({ length: 40 }, (_, i) => printer.printRaw({ target: { transport: 'system', printerName: `Printer${i}` }, data: Buffer.from('x') })));
  assert.equal(names.size, 40);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('temp files: a symlink planted at a predicted name is not followed: the victim stays intact and the job fails cleanly', options, async (t) => {
  const dir = tempDir(t);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'PRECIOUS');
  for (let seq = 1; seq <= 400; seq += 1) fs.symlinkSync(victim, path.join(dir, `gpos-4242-1700000000000-${seq}.bin`));
  const exec = createFakeExecFile();
  const printer = printerOn(dir, exec, { now: () => 1700000000000 });

  await assert.rejects(
    printer.printRaw({ target: { transport: 'system', printerName: 'Epson' }, data: Buffer.from('OVERWRITTEN?') }),
    (error) => error.code === 'SPOOLER_ERROR' && error.details && error.details.reason === 'temp-file',
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS', 'the file the symlink points to was written through it');
  assert.equal(exec.calls.length, 0, 'nothing was handed to the printer');
});
