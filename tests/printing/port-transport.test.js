'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { PORT_INVALID_MESSAGE } = require('../../src/main/printing/transports/win32-port');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES } = require('../../src/main/errors');
const {
  createFakeFs, createFakeExecFile, createRecordingLog, exitError, fsError, sleep, settle,
} = require('../helpers/fake-io');

const WIN_TMP = 'C:\\Users\\Shop Owner\\AppData\\Local\\Temp';
const DATA = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a]);

function harness({ exec, deps = {} } = {}) {
  const files = createFakeFs();
  const execFake = createFakeExecFile(exec);
  const log = createRecordingLog();
  const printer = createRawPrinter({
    platform: 'win32',
    fs: files.fs,
    execFile: execFake.execFile,
    tmpDir: WIN_TMP,
    resourcesPath: 'C:\\app.asar.unpacked',
    queue: createJobQueue({ defaultTimeoutMs: 5000 }),
    log,
    now: () => 1700000000000,
    pid: 4242,
    ...deps,
  });
  return { printer, files, exec: execFake, log };
}

const port = (value) => ({ transport: 'port', port: value });

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'the job was expected to fail' });
}

test('a DOS device is written directly as \\\\.\\NAME, opened existing-only, and no temp file or process is involved', async () => {
  const h = harness();
  assert.deepEqual(await h.printer.printRaw({ target: port('LPT1'), data: DATA }), { ok: true });

  assert.equal(h.files.opens.length, 1);
  assert.equal(h.files.opens[0].path, '\\\\.\\LPT1');
  const { O_WRONLY, O_CREAT, O_TRUNC } = nodeFs.constants;
  assert.equal(h.files.opens[0].flags, O_WRONLY);
  assert.equal(h.files.opens[0].flags & O_CREAT, 0, 'never creates a missing device as a file');
  assert.equal(h.files.opens[0].flags & O_TRUNC, 0);
  assert.deepEqual([...h.files.handles[0].written[0]], [...DATA]);
  assert.equal(h.files.handles[0].closed, true);
  assert.equal(h.exec.calls.length, 0);
  assert.equal(h.files.created.length, 0);
});

test('every spelling of a device opens the same \\\\.\\NAME and shares one queue lane', async () => {
  const keys = [];
  const inner = createJobQueue();
  const queue = { enqueue: (key, job, options) => { keys.push(key); return inner.enqueue(key, job, options); } };
  const h = harness({ deps: { queue } });
  for (const spelling of ['LPT1', 'lpt1:', ' Lpt1 ', '\\\\.\\LPT1']) {
    await h.printer.printRaw({ target: port(spelling), data: DATA });
  }
  await h.printer.printRaw({ target: port('com3'), data: DATA });
  await h.printer.printRaw({ target: port('prn:'), data: DATA });
  assert.deepEqual(h.files.opens.map((open) => open.path), [
    '\\\\.\\LPT1', '\\\\.\\LPT1', '\\\\.\\LPT1', '\\\\.\\LPT1', '\\\\.\\COM3', '\\\\.\\PRN',
  ]);
  assert.deepEqual(keys, ['port:\\\\.\\LPT1', 'port:\\\\.\\LPT1', 'port:\\\\.\\LPT1', 'port:\\\\.\\LPT1', 'port:\\\\.\\COM3', 'port:\\\\.\\PRN']);
});

test('a UNC share is opened for writing with flag "w", as copy does', async () => {
  const h = harness();
  await h.printer.printRaw({ target: port('  \\\\localhost\\Zebra ZD420 '), data: DATA });
  assert.deepEqual(h.files.opens, [{ path: '\\\\localhost\\Zebra ZD420', flags: 'w' }]);
  assert.equal(h.files.handles[0].closed, true);
  assert.equal(h.exec.calls.length, 0);
});

test('a refused direct open (ENOENT, EINVAL, EPERM, EACCES) falls back ONCE to copy with a bare file name and cwd = the temp dir', async () => {
  for (const code of ['ENOENT', 'EINVAL', 'EPERM', 'EACCES']) {
    let atExec = null;
    const h = harness({
      exec: (call, done) => {
        const filePath = `${WIN_TMP}\\${call.args[4]}`;
        const file = h.files.files.get(filePath);
        atExec = { exists: Boolean(file), content: file && Buffer.from(file.data) };
        done(null, '        1 file(s) copied.\r\n');
      },
    });
    h.files.hooks.open = () => { throw fsError(code, 'cannot open'); };

    assert.deepEqual(await h.printer.printRaw({ target: port('LPT1'), data: DATA, ext: 'bin' }), { ok: true }, code);

    assert.equal(h.exec.calls.length, 1, code);
    const [call] = h.exec.calls;
    assert.equal(call.file, 'cmd.exe');
    assert.deepEqual(call.args.slice(0, 4), ['/d', '/c', 'copy', '/B']);
    assert.match(call.args[4], /^gpos-4242-1700000000000-\d+\.bin$/, 'a bare generated name, no directory');
    assert.equal(call.args[5], '\\\\.\\LPT1');
    assert.equal(call.args.length, 6);
    assert.equal(call.options.cwd, WIN_TMP);
    assert.equal(call.options.windowsHide, true);
    assert.equal(Object.prototype.hasOwnProperty.call(call.options, 'shell'), false);
    assert.equal(atExec.exists, true, 'the file existed in the temp dir while copy ran');
    assert.deepEqual([...atExec.content], [...DATA]);
    assert.deepEqual(h.files.deleted, h.files.created);
    assert.equal(h.files.files.size, 0);
  }
});

test('other direct-write errors do not fall back: they are PORT_WRITE_FAILED at once', async () => {
  for (const code of ['EBUSY', 'EIO', 'ENXIO', 'ENOSPC', 'EISDIR', 'EMFILE', undefined]) {
    const h = harness();
    h.files.hooks.open = () => { throw code ? fsError(code, 'boom') : new Error('mystery'); };
    const error = await failureOf(h.printer.printRaw({ target: port('LPT1'), data: DATA }));
    assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED, String(code));
    assert.equal(error.details.step, 'direct');
    assert.equal(error.details.port, '\\\\.\\LPT1');
    assert.equal(error.details.errno, code);
    assert.equal(h.exec.calls.length, 0, 'copy is not tried');
    assert.equal(h.files.created.length, 0);
  }
});

test('the fallback is tried only once: a failing copy is PORT_WRITE_FAILED and the temp file is deleted', async () => {
  const h = harness({ exec: (call, done) => done(exitError(1, 'The system cannot find the device specified.')) });
  h.files.hooks.open = () => { throw fsError('ENOENT', 'no device'); };
  const error = await failureOf(h.printer.printRaw({ target: port('LPT2'), data: DATA }));
  assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED);
  assert.equal(error.details.step, 'copy');
  assert.equal(error.details.errno, 1);
  assert.equal(error.details.detail, 'The system cannot find the device specified.');
  assert.equal(h.exec.calls.length, 1);
  assert.deepEqual(h.files.deleted, h.files.created);
});

test('a share name with parentheses never reaches cmd.exe, which would re-parse them', async () => {
  const h = harness({ exec: (call, done) => done(null) });
  h.files.hooks.open = () => { throw fsError('ENOENT', 'missing'); };
  const error = await failureOf(h.printer.printRaw({ target: port('\\\\SHOP-PC\\EPSON (USB)'), data: DATA }));
  assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED);
  assert.equal(h.exec.calls.length, 0);
  assert.equal(h.files.created.length, 0);
});

test('a share name with a space is passed to cmd.exe as ONE argv element', async () => {
  const h = harness({ exec: (call, done) => done(null) });
  h.files.hooks.open = () => { throw fsError('EACCES', 'denied'); };
  await h.printer.printRaw({ target: port('\\\\localhost\\Zebra ZD420'), data: DATA });
  assert.equal(h.exec.calls[0].args[5], '\\\\localhost\\Zebra ZD420');
  assert.equal(h.exec.calls[0].args.length, 6);
});

test('a bare non-device name, a path or anything with shell characters is refused before open or cmd.exe', async () => {
  const refused = [
    'USB001', 'DOT4_001', 'Zebra', 'LPT1&calc', 'LPT1;x', 'LPT1|x', '100%', '%TEMP%\\x', 'C:\\x', '..\\x', '.\\x',
    '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '\\\\host\\a\\b', '\\\\host\\sh"are', 'COM257', 'LPT10', 'LPT1\r\ncalc', 'LPT1\0',
  ];
  for (const value of refused) {
    const h = harness({ exec: (call, done) => done(null) });
    const error = await failureOf(h.printer.printRaw({ target: port(value), data: DATA }));
    assert.equal(error.code, ERROR_CODES.INVALID_SETTINGS, JSON.stringify(value));
    assert.equal(error.message, PORT_INVALID_MESSAGE);
    assert.equal(h.files.opens.length, 0, `${JSON.stringify(value)} never reached open`);
    assert.equal(h.exec.calls.length, 0, `${JSON.stringify(value)} never reached cmd.exe`);
    assert.equal(h.files.created.length, 0);
  }
});

test('a device that does not exist cannot silently become a file: only existing-only flags are ever requested', async () => {
  const { O_CREAT, O_TRUNC } = nodeFs.constants;
  const h = harness({ exec: (call, done) => done(null) });
  h.files.hooks.open = (filePath, flags) => {
    if (typeof flags !== 'number' || (flags & (O_CREAT | O_TRUNC)) !== 0) throw new Error('would have created a regular file');
    throw fsError('ENOENT', 'no such device');
  };
  assert.deepEqual(await h.printer.printRaw({ target: port('COM7'), data: DATA }), { ok: true });
  assert.equal(h.exec.calls.length, 1, 'a missing device leads to the copy fallback, never to a created file');
});

test('the handle is closed when the write fails, and the write error is the one reported', async () => {
  const h = harness();
  h.files.hooks.handleWriteFile = () => { throw fsError('EIO', 'write failed'); };
  const error = await failureOf(h.printer.printRaw({ target: port('LPT1'), data: DATA }));
  assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED);
  assert.equal(error.details.errno, 'EIO');
  assert.equal(h.files.handles[0].closed, true);
  assert.equal(h.exec.calls.length, 0);
});

test('a failing close after a good write is a failed job', async () => {
  const h = harness();
  const originalOpen = h.files.fs.promises.open;
  h.files.fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    handle.close = async () => { throw fsError('EIO', 'close failed'); };
    return handle;
  };
  const error = await failureOf(h.printer.printRaw({ target: port('LPT1'), data: DATA }));
  assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED);
  assert.equal(error.details.errno, 'EIO');
});

test('a temp file that cannot be created for the fallback is PORT_WRITE_FAILED at the copy step', async () => {
  const h = harness({ exec: (call, done) => done(null) });
  h.files.hooks.open = () => { throw fsError('ENOENT', 'missing'); };
  h.files.hooks.writeFile = () => { throw fsError('ENOSPC', 'disk full'); };
  const error = await failureOf(h.printer.printRaw({ target: port('LPT1'), data: DATA }));
  assert.equal(error.code, ERROR_CODES.PORT_WRITE_FAILED);
  assert.equal(error.details.step, 'copy');
  assert.equal(h.exec.calls.length, 0);
});

test('a copy that hangs times out, is aborted, and its temp file is deleted', async () => {
  const h = harness({ deps: { jobTimeoutMs: 40 }, exec: () => {} });
  h.files.hooks.open = () => { throw fsError('ENOENT', 'missing'); };
  await assert.rejects(h.printer.printRaw({ target: port('LPT1'), data: DATA }), { code: ERROR_CODES.PRINT_TIMEOUT });
  await settle();
  assert.equal(h.exec.calls[0].options.signal.aborted, true);
  assert.deepEqual(h.files.deleted, h.files.created);
});

test('a direct write that finishes failing after its job timed out does not start a second attempt', async () => {
  const h = harness({ deps: { jobTimeoutMs: 30 }, exec: (call, done) => done(null) });
  h.files.hooks.open = async () => { await sleep(90); throw fsError('ENOENT', 'late failure'); };
  await assert.rejects(h.printer.printRaw({ target: port('\\\\localhost\\Zebra'), data: DATA }), { code: ERROR_CODES.PRINT_TIMEOUT });
  await sleep(150);
  assert.equal(h.exec.calls.length, 0, 'the timed-out job did not fall back to copy later');
  assert.equal(h.files.created.length, 0);
});

test('with a SystemRoot the fallback starts cmd.exe by absolute path', async () => {
  const h = harness({ deps: { systemRoot: 'C:\\Windows' }, exec: (call, done) => done(null) });
  h.files.hooks.open = () => { throw fsError('ENOENT', 'missing'); };
  await h.printer.printRaw({ target: port('LPT1'), data: DATA });
  assert.equal(h.exec.calls[0].file, 'C:\\Windows\\System32\\cmd.exe');
});

test('jobs for one port run one after another', async () => {
  const h = harness();
  const order = [];
  let running = 0;
  let max = 0;
  h.files.hooks.open = async () => { running += 1; max = Math.max(max, running); await sleep(3); running -= 1; };
  h.files.hooks.handleWriteFile = (handle, data) => order.push(data[0]);
  await Promise.all([1, 2, 3, 4, 5].map((n) => h.printer.printRaw({ target: port('LPT1'), data: Buffer.from([n]) })));
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.equal(max, 1);
});
