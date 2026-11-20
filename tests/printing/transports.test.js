'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES, PrintError } = require('../../src/main/errors');
const {
  createFakeFs, createFakeExecFile, createRecordingLog, exitError, settle, sleep,
} = require('../helpers/fake-io');

const WIN_TMP = 'C:\\Users\\Shop Owner\\AppData\\Local\\Temp';
const WIN_RESOURCES = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked';
const ONE_SHOT_SCRIPT = `${WIN_RESOURCES}\\scripts\\raw-print.ps1`;
const NOW = 1700000000000;
const WIN_TEMP_NAME = /^C:\\Users\\Shop Owner\\AppData\\Local\\Temp\\gpos-4242-1700000000000-\d+\.(bin|zpl)$/;

/** A raw printer wired to fakes. `exec(call, done, files)` scripts execFile; `deps` overrides createRawPrinter options. */
function harness({ platform = 'win32', exec, deps = {}, queueOptions } = {}) {
  const files = createFakeFs();
  const execFake = createFakeExecFile(exec ? (call, done) => exec(call, done, files) : undefined);
  const log = createRecordingLog();
  const queue = createJobQueue({ defaultTimeoutMs: 5000, ...queueOptions });
  const printer = createRawPrinter({
    platform,
    fs: files.fs,
    execFile: execFake.execFile,
    tmpDir: platform === 'win32' ? WIN_TMP : '/tmp',
    resourcesPath: WIN_RESOURCES,
    queue,
    log,
    now: () => NOW,
    pid: 4242,
    ...deps,
  });
  return { printer, files, exec: execFake, log, queue };
}

const system = (printerName) => ({ transport: 'system', printerName });
const lastArg = (call) => call.args[call.args.length - 1];
const hasShellOption = (call) => Object.prototype.hasOwnProperty.call(call.options, 'shell');

test('Windows system transport runs the one-shot script with exactly the SPEC argv and no shell', async () => {
  let seen = null;
  const h = harness({
    exec: (call, done, files) => {
      seen = { call, content: Buffer.from(files.files.get(lastArg(call)).data), mode: files.files.get(lastArg(call)).mode };
      done(null, '{"id":null,"ok":true,"code":0,"message":""}\r\n');
    },
  });

  const result = await h.printer.printRaw({ target: system('EPSON TM-T20III Receipt'), data: Buffer.from([0x1b, 0x40, 0x41]), label: 'receipt' });

  assert.deepEqual(result, { ok: true });
  assert.equal(h.exec.calls.length, 1);
  const { call } = seen;
  assert.equal(call.file, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, 9), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ONE_SHOT_SCRIPT,
    '-PrinterName', 'EPSON TM-T20III Receipt', '-FilePath',
  ]);
  assert.equal(call.args.length, 10);
  assert.match(lastArg(call), WIN_TEMP_NAME);
  assert.equal(call.options.windowsHide, true);
  assert.equal(hasShellOption(call), false);
  assert.deepEqual([...seen.content], [0x1b, 0x40, 0x41], 'the temp file held the bytes while the script ran');
  assert.equal(seen.mode, 0o600);
});

test('the temp file is created exclusively with mode 0600 and deleted after a successful job', async () => {
  const h = harness();
  const writes = [];
  h.files.hooks.writeFile = (filePath, data, options) => writes.push({ filePath, options });
  await h.printer.printRaw({ target: system('Printer A'), data: 'hello', ext: 'zpl' });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { flag: 'wx', mode: 0o600 });
  assert.match(writes[0].filePath, /\.zpl$/);
  assert.deepEqual(h.files.deleted, h.files.created);
  assert.equal(h.files.files.size, 0);
});

test('hostile printer names stay inside ONE argv element and never reach a command string', async () => {
  const hostile = [
    'Receipt "Main" Printer',
    'a;b',
    'a & b',
    '100% done',
    'line one\nline two',
    'x" -FilePath C:\\evil.bin "y',
    '$(calc.exe)',
    '`whoami`',
    "O'Brien's printer",
    'caf\u00e9 \u30d7\u30ea\u30f3\u30bf\u30fc',
    'back\\slash\\',
    'a|b>c<d^e!f',
  ];
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const name of hostile) {
      const h = harness({ platform });
      await h.printer.printRaw({ target: system(name), data: Buffer.from([1]) });
      assert.equal(h.exec.calls.length, 1, `${platform}: ${name}`);
      const [call] = h.exec.calls;
      assert.equal(call.args.filter((arg) => arg === name).length, 1, `${platform}: exactly one element equals the name`);
      assert.equal(call.args.filter((arg) => arg !== name && arg.includes(name)).length, 0, `${platform}: the name is in no other element`);
      assert.ok(call.file === 'powershell.exe' || call.file === 'lp', `${platform}: only the expected program is started`);
      assert.equal(hasShellOption(call), false);
      assert.equal(call.args.length, platform === 'win32' ? 10 : 5);
    }
  }
});

test('no job ever starts cmd.exe for a system printer', async () => {
  const h = harness();
  await h.printer.printRaw({ target: system('A & B'), data: Buffer.from([1]) });
  assert.equal(h.exec.calls.every((call) => call.file !== 'cmd.exe'), true);
});

test('printer names are trimmed, and the trimmed name is used everywhere', async () => {
  const keys = [];
  const queue = { enqueue: (key, job, options) => { keys.push(key); return createJobQueue().enqueue(key, job, options); } };
  const h = harness({ deps: { queue } });
  await h.printer.printRaw({ target: system('  EPSON TM  '), data: Buffer.from([1]) });
  assert.deepEqual(keys, ['system:EPSON TM']);
  assert.equal(h.exec.calls[0].args[7], 'EPSON TM');
});

test('invalid input is rejected with a PrintError before the OS is touched', async () => {
  const bad = [
    [{ target: system(''), data: Buffer.from([1]) }, ERROR_CODES.NO_PRINTER_CONFIGURED],
    [{ target: system('   '), data: Buffer.from([1]) }, ERROR_CODES.NO_PRINTER_CONFIGURED],
    [{ target: {}, data: Buffer.from([1]) }, ERROR_CODES.NO_PRINTER_CONFIGURED],
    [{ target: null, data: Buffer.from([1]) }, ERROR_CODES.NO_PRINTER_CONFIGURED],
    [{ target: { transport: 'port', port: '' }, data: Buffer.from([1]) }, ERROR_CODES.NO_PRINTER_CONFIGURED],
    [{ target: system('Bad\0Name'), data: Buffer.from([1]) }, ERROR_CODES.INVALID_SETTINGS],
    [{ target: system('x'.repeat(513)), data: Buffer.from([1]) }, ERROR_CODES.INVALID_SETTINGS],
    [{ target: system('-oraw'), data: Buffer.from([1]) }, ERROR_CODES.INVALID_SETTINGS],
    [{ target: { transport: 'usb', printerName: 'X' }, data: Buffer.from([1]) }, ERROR_CODES.INVALID_SETTINGS],
    [{ target: system('X'), data: Buffer.alloc(0) }, ERROR_CODES.INVALID_PAYLOAD],
    [{ target: system('X'), data: '' }, ERROR_CODES.INVALID_PAYLOAD],
    [{ target: system('X'), data: undefined }, ERROR_CODES.INVALID_PAYLOAD],
    [{ target: system('X'), data: 123 }, ERROR_CODES.INVALID_PAYLOAD],
    [{ target: system('X'), data: { type: 'Buffer', data: [1] } }, ERROR_CODES.INVALID_PAYLOAD],
    [{ target: system('X'), data: Buffer.alloc(16 * 1024 * 1024 + 1) }, ERROR_CODES.INVALID_PAYLOAD],
    [undefined, ERROR_CODES.NO_PRINTER_CONFIGURED],
  ];
  for (const platform of ['win32', 'darwin']) {
    for (const [job, code] of bad) {
      const h = harness({ platform });
      await assert.rejects(h.printer.printRaw(job), (err) => err instanceof PrintError && err.code === code, `${platform}: ${JSON.stringify(job && job.target)} -> ${code}`);
      assert.equal(h.exec.calls.length, 0);
      assert.equal(h.files.created.length, 0);
    }
  }
});

test('a name of exactly 512 characters is accepted', async () => {
  const h = harness();
  await h.printer.printRaw({ target: system('n'.repeat(512)), data: Buffer.from([1]) });
  assert.equal(h.exec.calls[0].args[7].length, 512);
});

test('data may be a Buffer, a Uint8Array or a string, and is copied when the job is accepted', async () => {
  const written = [];
  const h = harness();
  h.files.hooks.writeFile = (filePath, data) => written.push(Buffer.from(data));
  const view = new Uint8Array([9, 8, 7]);
  const pending = h.printer.printRaw({ target: system('X'), data: view });
  view[0] = 0;
  await pending;
  await h.printer.printRaw({ target: system('X'), data: Buffer.from('caf\u00e9', 'utf8') });
  await h.printer.printRaw({ target: system('X'), data: 'caf\u00e9' });
  assert.deepEqual([...written[0]], [9, 8, 7]);
  assert.deepEqual([...written[1]], [...Buffer.from('caf\u00e9', 'utf8')]);
  assert.deepEqual([...written[2]], [...Buffer.from('caf\u00e9', 'utf8')]);
});

test('100 concurrent jobs use 100 unique temp names, all created 0600 and all deleted', async () => {
  const h = harness();
  const created = [];
  h.files.hooks.writeFile = (filePath, data, options) => created.push({ filePath, options });
  const jobs = Array.from({ length: 100 }, (_, i) => h.printer.printRaw({
    target: system(`Printer ${i % 7}`),
    data: Buffer.from([i]),
    ext: i % 2 ? 'zpl' : 'bin',
  }));
  await Promise.all(jobs);

  assert.equal(created.length, 100);
  assert.equal(new Set(created.map((entry) => entry.filePath)).size, 100);
  for (const entry of created) {
    assert.match(entry.filePath, WIN_TEMP_NAME);
    assert.deepEqual(entry.options, { flag: 'wx', mode: 0o600 });
  }
  assert.equal(h.files.deleted.length, 100);
  assert.equal(h.files.files.size, 0);
});

test('the temp file is deleted when the script fails', async () => {
  const h = harness({ exec: (call, done) => done(exitError(4, 'write failed')) });
  await assert.rejects(h.printer.printRaw({ target: system('X'), data: Buffer.from([1]) }), { code: ERROR_CODES.SPOOLER_ERROR });
  assert.equal(h.files.created.length, 1);
  assert.deepEqual(h.files.deleted, h.files.created);
});

test('the temp file is deleted when execFile throws synchronously', async () => {
  const h = harness({ exec: () => { throw new Error('spawn exploded'); } });
  await assert.rejects(h.printer.printRaw({ target: system('X'), data: Buffer.from([1]) }), { code: ERROR_CODES.SPOOLER_ERROR });
  assert.deepEqual(h.files.deleted, h.files.created);
});

test('on a timeout the job fails with PRINT_TIMEOUT, the child is aborted and the temp file is deleted', async () => {
  const h = harness({ deps: { jobTimeoutMs: 40 }, exec: () => {} });
  await assert.rejects(h.printer.printRaw({ target: system('Stuck'), data: Buffer.from([1]) }), { code: ERROR_CODES.PRINT_TIMEOUT });
  await settle();
  assert.equal(h.exec.calls[0].options.signal.aborted, true);
  assert.deepEqual(h.files.deleted, h.files.created);
  assert.equal(h.files.files.size, 0);
});

test('a timed-out printer does not stop the next job for the same printer', async () => {
  let calls = 0;
  const h = harness({
    deps: { jobTimeoutMs: 40 },
    exec: (call, done) => { calls += 1; if (calls > 1) done(null); },
  });
  await assert.rejects(h.printer.printRaw({ target: system('P'), data: Buffer.from([1]) }), { code: ERROR_CODES.PRINT_TIMEOUT });
  assert.deepEqual(await h.printer.printRaw({ target: system('P'), data: Buffer.from([2]) }), { ok: true });
});

test('a temp file that cannot be created fails the job with SPOOLER_ERROR and starts nothing', async () => {
  const h = harness();
  h.files.hooks.writeFile = () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); };
  await assert.rejects(h.printer.printRaw({ target: system('X'), data: Buffer.from([1]) }), (err) => {
    assert.equal(err.code, ERROR_CODES.SPOOLER_ERROR);
    assert.equal(err.details.reason, 'temp-file');
    assert.equal(err.details.errno, 'EACCES');
    return true;
  });
  assert.equal(h.exec.calls.length, 0);
});

test('a temp file that cannot be deleted does not fail the job and is reported in the log', async () => {
  const h = harness();
  h.files.hooks.unlink = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  assert.deepEqual(await h.printer.printRaw({ target: system('X'), data: Buffer.from([1]) }), { ok: true });
  assert.ok(h.log.entries.some((entry) => entry.level === 'warn' && /temp file/.test(entry.args[0])));
});

test('jobs for the same printer run one at a time; different printers run side by side', async () => {
  const running = new Map();
  let maxSame = 0;
  let maxAcross = 0;
  const h = harness({
    exec: (call, done) => {
      const name = call.args[7];
      running.set(name, (running.get(name) || 0) + 1);
      maxSame = Math.max(maxSame, running.get(name));
      maxAcross = Math.max(maxAcross, [...running.values()].reduce((sum, n) => sum + n, 0));
      setTimeout(() => { running.set(name, running.get(name) - 1); done(null); }, 5);
    },
  });
  await Promise.all(['A', 'A', 'A', 'B', 'B', 'C', 'A', 'B'].map((name) => h.printer.printRaw({ target: system(name), data: Buffer.from([1]) })));
  assert.equal(maxSame, 1);
  assert.ok(maxAcross > 1, 'different printers overlapped');
});

test('a stuck printer does not block another printer', async () => {
  const h = harness({
    deps: { jobTimeoutMs: 300 },
    exec: (call, done) => { if (call.args[7] !== 'Stuck') done(null); },
  });
  const stuck = h.printer.printRaw({ target: system('Stuck'), data: Buffer.from([1]) });
  stuck.catch(() => {});
  const startedAt = Date.now();
  assert.deepEqual(await h.printer.printRaw({ target: system('Free'), data: Buffer.from([2]) }), { ok: true });
  assert.ok(Date.now() - startedAt < 200);
  await assert.rejects(stuck, { code: ERROR_CODES.PRINT_TIMEOUT });
});

test('the queue key is system:<name>, and the job label and timeout are passed on', async () => {
  const calls = [];
  const queue = { enqueue: (key, job, options) => { calls.push({ key, options }); return createJobQueue().enqueue(key, job, options); } };
  const h = harness({ deps: { queue, jobTimeoutMs: 1234 } });
  await h.printer.printRaw({ target: system('Zebra ZD420'), data: 'x', label: 'label zebra' });
  assert.deepEqual(calls, [{ key: 'system:Zebra ZD420', options: { label: 'label zebra', timeoutMs: 1234 } }]);
});

test('every job is logged with its label, transport and duration, never with its content', async () => {
  const h = harness();
  await h.printer.printRaw({ target: system('X'), data: Buffer.from('SECRET-RECEIPT-CONTENT'), label: 'receipt' });
  await assert.rejects(h.printer.printRaw({ target: system(''), data: Buffer.from('SECRET-RECEIPT-CONTENT') }));
  const text = JSON.stringify(h.log.entries);
  assert.doesNotMatch(text, /SECRET-RECEIPT-CONTENT/);
  assert.ok(h.log.entries.some((entry) => entry.args[0] === 'print job done' && entry.args[1].label === 'receipt' && entry.args[1].transport === 'system'));
  assert.ok(h.log.entries.some((entry) => entry.args[0] === 'print job failed' && entry.args[1].code === ERROR_CODES.NO_PRINTER_CONFIGURED));
});

test('printRaw resolves { ok: true } and a slow job does not resolve early', async () => {
  const h = harness({ exec: (call, done) => setTimeout(() => done(null), 30) });
  const startedAt = Date.now();
  assert.deepEqual(await h.printer.printRaw({ target: system('X'), data: Buffer.from([1]) }), { ok: true });
  assert.ok(Date.now() - startedAt >= 25);
  await sleep(1);
});
