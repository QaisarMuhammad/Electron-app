'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { HOST_START_TIMEOUT_MS, HOST_RETRY_AFTER_MS, HOST_COMMAND_TIMEOUT_MS } = require('../../src/main/printing/transports/win32-spooler');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES } = require('../../src/main/errors');
const {
  createFakeClock, createFakeFs, createFakeExecFile, createFakeSpawn, createRecordingLog, exitError, settle, sleep,
} = require('../helpers/fake-io');

const WIN_TMP = 'C:\\Users\\Shop Owner\\AppData\\Local\\Temp';
const RESOURCES = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked';
const ONE_SHOT_SCRIPT = `${RESOURCES}\\scripts\\raw-print.ps1`;

function hostHarness({ behaviour, host = {}, execHandler, jobTimeoutMs, queue } = {}) {
  const clock = createFakeClock();
  const spawn = createFakeSpawn(behaviour);
  const files = createFakeFs();
  const exec = createFakeExecFile(execHandler);
  const log = createRecordingLog();
  const printer = createRawPrinter({
    platform: 'win32',
    fs: files.fs,
    execFile: exec.execFile,
    spawn: spawn.spawn,
    tmpDir: WIN_TMP,
    resourcesPath: RESOURCES,
    queue: queue || createJobQueue({ defaultTimeoutMs: 60000 }),
    log,
    now: clock.now,
    pid: 4242,
    timers: clock.timers,
    host,
    jobTimeoutMs,
  });
  const print = (name = 'EPSON TM-T20', data = Buffer.from([0x1b, 0x40])) => printer.printRaw({ target: { transport: 'system', printerName: name }, data });
  return { printer, print, clock, spawn, files, exec, log };
}

const never = () => {};

test('the documented defaults: 10 s to start, 25 s per command, 30 minutes before the host is tried again', () => {
  assert.equal(HOST_START_TIMEOUT_MS, 10000);
  assert.equal(HOST_COMMAND_TIMEOUT_MS, 25000);
  assert.equal(HOST_RETRY_AFTER_MS, 30 * 60 * 1000);
});

test('a host that crashed while idle is replaced by a new one on the next job', async () => {
  const h = hostHarness();
  await h.print();
  h.spawn.children[0].exit(1);
  await settle();
  assert.deepEqual(await h.print(), { ok: true });
  assert.equal(h.spawn.calls.length, 2);
  assert.equal(h.spawn.children[1].commands.length, 1);
  assert.equal(h.exec.calls.length, 0);
});

test('a host that dies during a command fails that job (no re-print), and the next job gets a new host', async () => {
  let crashes = 0;
  const h = hostHarness({
    behaviour: {
      respond: (command, child) => {
        if (crashes === 0) {
          crashes += 1;
          child.stderr.emit('data', 'Add-Type : the host is going down\n');
          child.exit(3);
        } else {
          child.answer({ id: command.id });
        }
      },
    },
  });
  await assert.rejects(h.print(), (error) => {
    assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
    assert.equal(error.details.reason, 'exited');
    assert.match(error.details.detail, /the host is going down/);
    return true;
  });
  assert.equal(h.exec.calls.length, 0, 'the job is not sent a second time: it may already have printed');
  assert.equal(h.files.files.size, 0);

  assert.deepEqual(await h.print(), { ok: true });
  assert.equal(h.spawn.calls.length, 2);
  assert.equal(h.spawn.children[1].commands[0].id, 2, 'command ids continue across hosts');
});

test('a command that is not answered in time fails with PRINT_TIMEOUT, kills the host, and the next job restarts it', async () => {
  const h = hostHarness({ host: { commandTimeoutMs: 200 }, behaviour: { respond: never } });
  const job = h.print();
  job.catch(() => {});
  await settle();
  await h.clock.advance(199);
  assert.equal(h.spawn.children[0].killed, false);
  await h.clock.advance(1);

  await assert.rejects(job, (error) => {
    assert.equal(error.code, ERROR_CODES.PRINT_TIMEOUT);
    assert.equal(error.details.reason, 'host-command-timeout');
    return true;
  });
  assert.equal(h.spawn.children[0].killed, true, 'a host that may be stuck in WritePrinter is killed');
  assert.equal(h.files.files.size, 0);
  assert.equal(h.clock.pending(), 0);

  h.spawn.behaviour.respond = null;
  assert.deepEqual(await h.print(), { ok: true });
  assert.equal(h.spawn.calls.length, 2);
  assert.equal(h.exec.calls.length, 0);
});

test('the queue timeout of a job also stops a stuck host, and the next job restarts it', async () => {
  const h = hostHarness({ jobTimeoutMs: 50, host: { commandTimeoutMs: 3600000 }, behaviour: { respond: never } });
  await assert.rejects(h.print(), { code: ERROR_CODES.PRINT_TIMEOUT });
  await settle();
  assert.equal(h.spawn.children[0].killed, true);
  h.spawn.behaviour.respond = null;
  assert.deepEqual(await h.print('EPSON TM-T20'), { ok: true });
  assert.equal(h.spawn.calls.length, 2);
});

test('a job waiting behind a stuck command is served by a new host once the stuck host has been stopped', async () => {
  const h = hostHarness({ jobTimeoutMs: 120, host: { commandTimeoutMs: 3600000 }, behaviour: { respond: never } });
  const stuck = h.print('Receipt Printer');
  stuck.catch(() => {});
  await sleep(40);
  h.spawn.behaviour.respond = null;
  const waiting = h.print('Label Printer');

  await assert.rejects(stuck, { code: ERROR_CODES.PRINT_TIMEOUT });
  assert.deepEqual(await waiting, { ok: true }, 'the stuck printer did not take the other printer down with it');
  assert.equal(h.spawn.calls.length, 2);
  assert.equal(h.spawn.children[0].commands.length, 1);
  assert.equal(h.spawn.children[1].commands.length, 1);
  assert.equal(h.spawn.children[1].commands[0].printerName, 'Label Printer');
});

test('a job whose own deadline passed while it waited behind a slow command is never sent', async () => {
  const inner = createJobQueue({ defaultTimeoutMs: 60000 });
  const queue = {
    enqueue: (key, job, options) => inner.enqueue(key, job, { ...options, timeoutMs: key === 'system:Label Printer' ? 40 : 60000 }),
  };
  const h = hostHarness({
    queue,
    host: { commandTimeoutMs: 3600000 },
    behaviour: { respond: (command, child) => setTimeout(() => child.answer({ id: command.id }), 200) },
  });
  const slow = h.print('Receipt Printer');
  const waiting = h.print('Label Printer');
  waiting.catch(() => {});

  await assert.rejects(waiting, { code: ERROR_CODES.PRINT_TIMEOUT });
  assert.deepEqual(await slow, { ok: true });
  await settle();
  assert.equal(h.spawn.children[0].commands.length, 1, 'only the slow command ever reached the host');
  assert.equal(h.spawn.calls.length, 1);
  assert.equal(h.exec.calls.length, 0);
  assert.equal(h.files.files.size, 0);
});

test('stopping the app (dispose) while a command is running fails that job as a spooler error', async () => {
  const h = hostHarness({ behaviour: { respond: never } });
  const job = h.print();
  job.catch(() => {});
  await settle();
  h.printer.dispose();
  await assert.rejects(job, (error) => {
    assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
    assert.equal(error.details.reason, 'dispose');
    return true;
  });
  assert.equal(h.spawn.children[0].killed, true);
});

test('a failing stdin write fails the job as a spooler error', async () => {
  const h = hostHarness({ behaviour: { stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) } });
  await assert.rejects(h.print(), (error) => {
    assert.equal(error.code, ERROR_CODES.SPOOLER_ERROR);
    assert.equal(error.details.reason, 'host-write-failed');
    assert.equal(error.details.errno, 'EPIPE');
    return true;
  });
});

// ---- fallback to the one-shot script --------------------------------------------------------------------------

function expectOneShot(h, printerName = 'EPSON TM-T20') {
  assert.equal(h.exec.calls.length, 1, 'the one-shot script ran once');
  const [call] = h.exec.calls;
  assert.equal(call.file, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, 9), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ONE_SHOT_SCRIPT, '-PrinterName', printerName, '-FilePath']);
}

test('when spawn itself throws, the one-shot script prints the job', async () => {
  const h = hostHarness({ behaviour: { spawnThrows: new Error('spawn EACCES') } });
  assert.deepEqual(await h.print(), { ok: true });
  expectOneShot(h);
  assert.ok(h.log.entries.some((entry) => entry.level === 'warn' && /could not start/.test(entry.args[0]) && entry.args[1].reason === 'spawn-failed'));
});

test('when powershell.exe cannot be started (error event), the one-shot script prints the job', async () => {
  const h = hostHarness({ behaviour: { errorOnSpawn: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) } });
  assert.deepEqual(await h.print(), { ok: true });
  expectOneShot(h);
  assert.equal(h.spawn.children[0].commands.length, 0, 'nothing was sent to the dead host');
});

test('when the host exits before it is ready (for example the printing component cannot load), the one-shot script prints the job', async () => {
  const h = hostHarness({ behaviour: { exitOnSpawn: 3 } });
  assert.deepEqual(await h.print(), { ok: true });
  expectOneShot(h);
  assert.equal(h.spawn.children[0].commands.length, 0);
});

test('a host that is not ready within 10 s is dropped and the one-shot script prints the job', async () => {
  const h = hostHarness({ behaviour: { ready: 'never' } });
  const job = h.print();
  await settle();
  await h.clock.advance(HOST_START_TIMEOUT_MS - 1);
  assert.equal(h.exec.calls.length, 0, 'still waiting for the host');
  await h.clock.advance(1);
  assert.deepEqual(await job, { ok: true });
  expectOneShot(h);
  assert.equal(h.spawn.children[0].killed, true);
  assert.equal(h.spawn.children[0].commands.length, 0, 'the job was never handed to the unready host, so it cannot print twice');
});

test('a host that becomes ready just in time is used, not dropped', async () => {
  const h = hostHarness({ behaviour: { ready: 'never' } });
  const job = h.print();
  await settle();
  await h.clock.advance(9000);
  h.spawn.children[0].sayReady();
  assert.deepEqual(await job, { ok: true });
  assert.equal(h.exec.calls.length, 0);
  assert.equal(h.spawn.children[0].commands.length, 1);
});

test('after a failed start the one-shot script is used for 30 minutes, then the host is tried again', async () => {
  const h = hostHarness({ behaviour: { spawnThrows: new Error('spawn EACCES') } });
  await h.print();
  await h.print();
  await h.print();
  assert.equal(h.spawn.calls.length, 1, 'no new start attempt while cooling off');
  assert.equal(h.exec.calls.length, 3);

  await h.clock.advance(HOST_RETRY_AFTER_MS - 1);
  await h.print();
  assert.equal(h.spawn.calls.length, 1);
  assert.equal(h.exec.calls.length, 4);

  await h.clock.advance(1);
  h.spawn.behaviour.spawnThrows = null;
  assert.deepEqual(await h.print(), { ok: true });
  assert.equal(h.spawn.calls.length, 2, 'the host was tried again');
  assert.equal(h.spawn.children[0].commands.length, 1);
  assert.equal(h.exec.calls.length, 4, 'and this time it worked');
});

test('the one-shot fallback maps its exit codes like any one-shot job', async () => {
  const h = hostHarness({
    behaviour: { spawnThrows: new Error('spawn EACCES') },
    execHandler: (call, done) => done(exitError(2, '', '{"id":null,"ok":false,"code":2,"message":"The printer name is invalid."}')),
  });
  await assert.rejects(h.print('Missing Printer'), (error) => {
    assert.equal(error.code, ERROR_CODES.PRINTER_NOT_FOUND);
    assert.equal(error.details.printerName, 'Missing Printer');
    return true;
  });
  assert.equal(h.files.files.size, 0);
});

test('a job whose signal was aborted before it reached the transport does not start anything', async () => {
  const h = hostHarness({ jobTimeoutMs: 30, behaviour: { ready: 'never' }, host: { startTimeoutMs: 3600000 } });
  await assert.rejects(h.print(), { code: ERROR_CODES.PRINT_TIMEOUT });
  await settle();
  assert.equal(h.spawn.children[0].commands.length, 0);
  assert.equal(h.exec.calls.length, 0, 'a job that already timed out does not fall back to the one-shot script');
});
