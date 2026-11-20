'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRawPrinter, resolveTarget, promisifyExecFile } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES, PrintError } = require('../../src/main/errors');
const { createFakeFs, createFakeExecFile, exitError } = require('../helpers/fake-io');

const WIN_RESOURCES = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked';

function build({ platform, exec, deps = {} }) {
  const files = createFakeFs();
  const execFake = createFakeExecFile(exec);
  const printer = createRawPrinter({
    platform,
    fs: files.fs,
    execFile: execFake.execFile,
    tmpDir: platform === 'win32' ? 'C:\\Temp' : '/tmp',
    resourcesPath: WIN_RESOURCES,
    queue: createJobQueue(),
    now: () => 1700000000000,
    pid: 7,
    ...deps,
  });
  return { printer, files, exec: execFake };
}

const job = (printerName = 'Receipt Printer') => ({ target: { transport: 'system', printerName }, data: Buffer.from([1, 2, 3]) });

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'the job was expected to fail' });
}

// ---- Windows one-shot exit codes ------------------------------------------------------------------------------

test('exit code 2 means the printer was not found and names the printer', async () => {
  const { printer } = build({ platform: 'win32', exec: (call, done) => done(exitError(2, '', '{"id":null,"ok":false,"code":2,"message":"The printer name is invalid."}\r\n')) });
  const error = await failureOf(printer.printRaw(job('EPSON TM-T20')));
  assert.ok(error instanceof PrintError);
  assert.equal(error.code, ERROR_CODES.PRINTER_NOT_FOUND);
  assert.equal(error.details.printerName, 'EPSON TM-T20');
  assert.equal(error.details.exitCode, 2);
  assert.equal(error.details.detail, 'The printer name is invalid.', 'the message of the final JSON line is kept for the log');
  assert.match(error.message, /"EPSON TM-T20" was not found/);
});

test('exit codes 3, 4 and 5 are spooler errors that say which stage failed', async () => {
  const stages = { 3: 'open', 4: 'write', 5: 'arguments' };
  for (const [code, stage] of Object.entries(stages)) {
    const { printer } = build({ platform: 'win32', exec: (call, done) => done(exitError(Number(code), 'something went wrong')) });
    const error = await failureOf(printer.printRaw(job()));
    assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR, code);
    assert.equal(error.details.exitCode, Number(code));
    assert.equal(error.details.stage, stage);
    assert.equal(error.details.detail, 'something went wrong');
  }
});

test('any other exit code (for example a PowerShell script error) is a spooler error', async () => {
  const { printer } = build({ platform: 'win32', exec: (call, done) => done(exitError(1, 'The term is not recognized')) });
  const error = await failureOf(printer.printRaw(job()));
  assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(error.details.exitCode, 1);
  assert.equal(error.details.stage, undefined);
});

test('a missing powershell.exe is a spooler error, not a crash', async () => {
  const { printer } = build({ platform: 'win32', exec: (call, done) => done(Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })) });
  const error = await failureOf(printer.printRaw(job()));
  assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(error.details.reason, 'powershell-not-found');
});

test('a killed child is a timeout, and an unknown failure is a spooler error', async () => {
  let build1 = build({ platform: 'win32', exec: (call, done) => done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null })) });
  assert.equal((await failureOf(build1.printer.printRaw(job()))).code, ERROR_CODES.PRINT_TIMEOUT);
  build1 = build({ platform: 'win32', exec: (call, done) => done(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })) });
  const error = await failureOf(build1.printer.printRaw(job()));
  assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(error.details.errno, 'EPERM');
});

test('error details are plain data that survives JSON (they cross the IPC boundary)', async () => {
  const { printer } = build({ platform: 'win32', exec: (call, done) => done(exitError(2, 'x'.repeat(5000))) });
  const error = await failureOf(printer.printRaw(job()));
  assert.deepEqual(JSON.parse(JSON.stringify(error.details)), error.details);
  assert.ok(error.details.detail.length <= 200, 'technical text is clipped');
});

// ---- macOS and Linux -----------------------------------------------------------------------------------------

test('macOS and Linux print with lp: exact argv, the printer name as one element, no shell', async () => {
  for (const platform of ['darwin', 'linux']) {
    let seenContent = null;
    const { printer, exec, files } = build({
      platform,
      exec: (call, done) => { seenContent = Buffer.from(files.files.get(call.args[4]).data); done(null, 'request id is Zebra-12 (1 file(s))\n'); },
    });
    assert.deepEqual(await printer.printRaw(job('Zebra ZD420 (USB)')), { ok: true });
    const [call] = exec.calls;
    assert.equal(call.file, 'lp');
    assert.deepEqual(call.args.slice(0, 4), ['-d', 'Zebra ZD420 (USB)', '-o', 'raw']);
    assert.match(call.args[4], /^\/tmp\/gpos-7-1700000000000-\d+\.bin$/);
    assert.equal(call.args.length, 5);
    assert.equal(Object.prototype.hasOwnProperty.call(call.options, 'shell'), false);
    assert.deepEqual([...seenContent], [1, 2, 3]);
  }
});

test('lp output that says the destination does not exist is PRINTER_NOT_FOUND', async () => {
  const messages = [
    'lp: The printer or class does not exist.',
    'lp: Error - The printer or class does not exist.',
    'lp: Unknown destination "Foo".',
    'lp: no such printer',
  ];
  for (const stderr of messages) {
    const { printer } = build({ platform: 'darwin', exec: (call, done) => done(exitError(1, stderr)) });
    const error = await failureOf(printer.printRaw(job('Foo')));
    assert.equal(error.code, ERROR_CODES.PRINTER_NOT_FOUND, stderr);
    assert.equal(error.details.printerName, 'Foo');
  }
});

test('the printer name in lp\'s command line is not mistaken for a stderr message', async () => {
  const error = new Error('Command failed: lp -d does not exist -o raw /tmp/f');
  error.code = 1;
  error.stderr = 'lp: Scheduler is not running.';
  const { printer } = build({ platform: 'darwin', exec: (call, done) => done(error) });
  const failure = await failureOf(printer.printRaw(job('does not exist')));
  assert.equal(failure.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(failure.details.detail, 'lp: Scheduler is not running.');
});

test('other lp failures are spooler errors; a missing lp is reported as such; a killed lp is a timeout', async () => {
  let b = build({ platform: 'linux', exec: (call, done) => done(exitError(1, 'lp: Unable to connect to server: Connection refused')) });
  let error = await failureOf(b.printer.printRaw(job()));
  assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(error.details.exitCode, 1);
  b = build({ platform: 'linux', exec: (call, done) => done(Object.assign(new Error('spawn lp ENOENT'), { code: 'ENOENT' })) });
  error = await failureOf(b.printer.printRaw(job()));
  assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
  assert.equal(error.details.reason, 'lp-not-installed');
  b = build({ platform: 'linux', exec: (call, done) => done(Object.assign(new Error('killed'), { killed: true })) });
  assert.equal((await failureOf(b.printer.printRaw(job()))).code, ERROR_CODES.PRINT_TIMEOUT);
});

test('a printer name that starts with a dash is refused, so it can never become an lp option', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const name of ['-oraw', '-d', '--help', '-']) {
      const { printer, exec } = build({ platform });
      const error = await failureOf(printer.printRaw(job(name)));
      assert.equal(error.code, ERROR_CODES.INVALID_SETTINGS, `${platform} ${name}`);
      assert.equal(exec.calls.length, 0);
    }
  }
});

// ---- platform branches ----------------------------------------------------------------------------------------

test('the port transport exists on Windows only; the others answer UNSUPPORTED_PLATFORM without touching anything', async () => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    for (const port of ['LPT1', '\\\\localhost\\Zebra', 'USB001', 'C:\\x']) {
      const { printer, exec, files } = build({ platform });
      const error = await failureOf(printer.printRaw({ target: { transport: 'port', port }, data: Buffer.from([1]) }));
      assert.equal(error.code, ERROR_CODES.UNSUPPORTED_PLATFORM, `${platform} ${port}`);
      assert.equal(exec.calls.length, 0);
      assert.equal(files.created.length + files.opens.length, 0);
    }
  }
});

test('platforms without CUPS or the Windows spooler answer UNSUPPORTED_PLATFORM for installed printers', async () => {
  for (const platform of ['freebsd', 'aix', 'sunos']) {
    const { printer, exec } = build({ platform });
    const error = await failureOf(printer.printRaw(job()));
    assert.equal(error.code, ERROR_CODES.UNSUPPORTED_PLATFORM, platform);
    assert.equal(error.details.platform, platform);
    assert.equal(exec.calls.length, 0);
  }
});

test('the platform defaults to process.platform', async () => {
  const files = createFakeFs();
  const execFake = createFakeExecFile();
  const printer = createRawPrinter({
    fs: files.fs, execFile: execFake.execFile, tmpDir: process.platform === 'win32' ? 'C:\\Temp' : '/tmp', resourcesPath: WIN_RESOURCES, queue: createJobQueue(),
  });
  await printer.printRaw(job());
  assert.equal(execFake.calls[0].file, process.platform === 'win32' ? 'powershell.exe' : 'lp');
});

// ---- system executables by absolute path ----------------------------------------------------------------------

test('with a SystemRoot, powershell.exe is started by absolute path; without a usable root the bare name is used', async () => {
  const expected = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cases = [
    ['C:\\Windows', expected],
    ['C:\\Windows\\', expected],
    [undefined, 'powershell.exe'],
    ['', 'powershell.exe'],
    ['Windows', 'powershell.exe'],
    ['..\\Windows', 'powershell.exe'],
    ['C:\\Win\ndows', 'powershell.exe'],
    [42, 'powershell.exe'],
  ];
  for (const [systemRoot, file] of cases) {
    const { printer, exec } = build({ platform: 'win32', deps: { systemRoot } });
    await printer.printRaw(job());
    assert.equal(exec.calls[0].file, file, JSON.stringify(systemRoot));
  }
});

// ---- target resolution ----------------------------------------------------------------------------------------

test('resolveTarget follows the migration rule for a missing transport and trims values', () => {
  assert.deepEqual(resolveTarget({ printerName: ' EPSON ' }), { transport: 'system', printerName: 'EPSON', port: '' });
  assert.deepEqual(resolveTarget({ port: ' LPT1 ' }), { transport: 'port', printerName: '', port: 'LPT1' });
  assert.deepEqual(resolveTarget({ printerName: 'EPSON', port: 'LPT1' }), { transport: 'port', printerName: 'EPSON', port: 'LPT1' });
  assert.deepEqual(resolveTarget({ transport: 'system', printerName: 'EPSON', port: 'LPT1' }), { transport: 'system', printerName: 'EPSON', port: 'LPT1' });
  assert.deepEqual(resolveTarget({ transport: '', printerName: 'EPSON' }), { transport: 'system', printerName: 'EPSON', port: '' });
});

test('resolveTarget demands the field of the chosen transport', () => {
  for (const raw of [undefined, null, 'text', {}, { transport: 'system' }, { transport: 'system', port: 'LPT1' }, { transport: 'port', printerName: 'EPSON' }, { transport: 'port', port: '  ' }]) {
    assert.throws(() => resolveTarget(raw), { code: ERROR_CODES.NO_PRINTER_CONFIGURED }, JSON.stringify(raw));
  }
  assert.throws(() => resolveTarget({ transport: 'bluetooth', printerName: 'X' }), { code: ERROR_CODES.INVALID_SETTINGS });
});

// ---- wiring ---------------------------------------------------------------------------------------------------

test('createRawPrinter fails fast, naming what is missing', () => {
  const files = createFakeFs();
  const base = { platform: 'win32', fs: files.fs, execFile: () => {}, tmpDir: 'C:\\Temp', resourcesPath: WIN_RESOURCES, queue: createJobQueue() };
  assert.doesNotThrow(() => createRawPrinter(base));
  assert.throws(() => createRawPrinter({ platform: 'win32' }), /queue, fs, execFile, tmpDir, resourcesPath/);
  assert.throws(() => createRawPrinter({ ...base, queue: undefined }), /missing: queue/);
  assert.throws(() => createRawPrinter({ ...base, fs: {} }), /missing: fs/);
  assert.throws(() => createRawPrinter({ ...base, execFile: 'x' }), /missing: execFile/);
  assert.throws(() => createRawPrinter({ ...base, tmpDir: '' }), /missing: tmpDir/);
  assert.throws(() => createRawPrinter({ ...base, resourcesPath: undefined }), /missing: resourcesPath/);
  assert.doesNotThrow(() => createRawPrinter({ ...base, platform: 'darwin', resourcesPath: undefined }), 'resourcesPath is only needed on Windows');
});

test('promisifyExecFile resolves text and rejects with the original error carrying stdout and stderr', async () => {
  const run = promisifyExecFile((file, args, options, callback) => callback(null, Buffer.from('out'), undefined));
  assert.deepEqual(await run('x', [], {}), { stdout: 'out', stderr: '' });
  const failing = promisifyExecFile((file, args, options, callback) => callback(Object.assign(new Error('bad'), { code: 7 }), 'o', 'e'));
  const error = await failureOf(failing('x', [], {}));
  assert.equal(error.code, 7);
  assert.equal(error.stdout, 'o');
  assert.equal(error.stderr, 'e');
  const throwing = promisifyExecFile(() => { throw new TypeError('args must not contain null bytes'); });
  assert.ok((await failureOf(throwing('x', [], {}))) instanceof TypeError);
});

// ---- the source rules of SPEC 2 and 19 ------------------------------------------------------------------------

test('the print modules contain no exec, execSync, shell option, eval or direct child_process use', () => {
  const root = path.join(__dirname, '..', '..');
  const files = [
    'src/main/errors.js',
    'src/main/printing/queue.js',
    'src/main/printing/receipt.js',
    'src/main/printing/zebra.js',
    'src/main/printing/transports/index.js',
    'src/main/printing/transports/win32-port.js',
    'src/main/printing/transports/win32-spooler.js',
    'src/main/printing/transports/posix-cups.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /(?<![A-Za-z.])exec\s*\(/, `${file}: exec(`);
    assert.doesNotMatch(text, /execSync|execFileSync|spawnSync/, `${file}: sync process calls`);
    assert.doesNotMatch(text, /shell\s*:/, `${file}: shell option`);
    assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(/, `${file}: eval`);
    assert.doesNotMatch(text, /require\(\s*['"](?:node:)?child_process['"]\s*\)/, `${file}: child_process must be injected`);
    assert.doesNotMatch(text, /require\(\s*['"](?:node:)?fs['"]\s*\)/, `${file}: fs must be injected`);
  }
});
