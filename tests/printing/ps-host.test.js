'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { asciiJson, HOST_IDLE_MS } = require('../../src/main/printing/transports/win32-spooler');
const { createJobQueue } = require('../../src/main/printing/queue');
const { ERROR_CODES } = require('../../src/main/errors');
const {
  createFakeClock, createFakeFs, createFakeExecFile, createFakeSpawn, createRecordingLog, settle,
} = require('../helpers/fake-io');

const WIN_TMP = 'C:\\Users\\Shop Owner\\AppData\\Local\\Temp';
const RESOURCES = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked';
const HOST_SCRIPT = `${RESOURCES}\\scripts\\raw-print-host.ps1`;

/** A raw printer on Windows wired to a fake clock, a fake child process and a fake execFile (the one-shot fallback). */
function hostHarness({ behaviour, host = {}, execHandler, jobTimeoutMs } = {}) {
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
    queue: createJobQueue({ defaultTimeoutMs: 60000 }),
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

test('the host is started lazily, by the first job and not before', async () => {
  const h = hostHarness();
  await settle();
  assert.equal(h.spawn.calls.length, 0);
  await h.print();
  assert.equal(h.spawn.calls.length, 1);
});

test('the host is started with the SPEC PowerShell flags, the host script, no window and piped stdio', async () => {
  const h = hostHarness();
  await h.print();
  assert.deepEqual(h.spawn.calls[0], {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT],
    options: { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  });
});

test('ONE spawn serves 50 jobs; each job is one JSON line with an increasing id; the one-shot script is never used', async () => {
  const h = hostHarness();
  for (let i = 0; i < 50; i += 1) {
    assert.deepEqual(await h.print('EPSON TM-T20', Buffer.from([i])), { ok: true });
  }
  assert.equal(h.spawn.calls.length, 1, 'exactly one process was started');
  assert.equal(h.spawn.children.length, 1);
  const child = h.spawn.children[0];
  assert.equal(child.commands.length, 50);
  assert.deepEqual(child.commands.map((command) => command.id), Array.from({ length: 50 }, (_, i) => i + 1));
  for (const command of child.commands) {
    assert.deepEqual(Object.keys(command).sort(), ['filePath', 'id', 'printerName']);
    assert.equal(command.printerName, 'EPSON TM-T20');
    assert.match(command.filePath, /^C:\\Users\\Shop Owner\\AppData\\Local\\Temp\\gpos-4242-\d+-\d+\.bin$/);
  }
  assert.equal(new Set(child.commands.map((command) => command.filePath)).size, 50, 'every job has its own temp file');
  assert.equal(h.exec.calls.length, 0, 'no PowerShell process per job');
  assert.equal(h.files.files.size, 0, 'every temp file was deleted');
});

test('50 concurrent jobs for two printers still use one host, one command in flight at a time, in queue order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const h = hostHarness({
    behaviour: {
      respond: (command, child) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => { inFlight -= 1; child.answer({ id: command.id }); }, 1);
      },
    },
  });
  const jobs = Array.from({ length: 50 }, (_, i) => h.print(i % 2 ? 'Label Printer' : 'Receipt Printer', Buffer.from([i])));
  const results = await Promise.all(jobs);
  assert.ok(results.every((result) => result.ok === true));
  assert.equal(h.spawn.calls.length, 1);
  assert.equal(maxInFlight, 1);
  const perPrinter = (name) => h.spawn.children[0].commands.filter((command) => command.printerName === name).length;
  assert.equal(perPrinter('Receipt Printer'), 25);
  assert.equal(perPrinter('Label Printer'), 25);
});

test('jobs after the first add almost no overhead (budget: under 150 ms each, excluding the printer)', async () => {
  const h = hostHarness();
  const timings = [];
  for (let i = 0; i < 50; i += 1) {
    const startedAt = process.hrtime.bigint();
    await h.print('EPSON TM-T20', Buffer.from([i]));
    timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  const later = timings.slice(1);
  assert.ok(Math.max(...later) < 150, `slowest later job took ${Math.max(...later).toFixed(1)} ms`);
  assert.ok(later.reduce((sum, ms) => sum + ms, 0) / later.length < 50, 'average overhead stays far below the budget');
  assert.equal(h.clock.pending(), 1, 'no timer wait sits between jobs: only the idle timer exists');
});

test('the first command is written only after the host said it is ready', async () => {
  const h = hostHarness({ behaviour: { ready: 'never' } });
  const job = h.print();
  await settle();
  const [child] = h.spawn.children;
  assert.equal(child.commands.length, 0);
  child.sayReady();
  assert.deepEqual(await job, { ok: true });
  assert.equal(child.commands.length, 1);
});

test('hostile printer names travel only as JSON data: one ASCII line each, round-tripping exactly', async () => {
  const names = [
    'Receipt "Main" Printer', 'a;b & c', '100% | done', 'line one\nline two', 'tab\there', 'x" , "filePath": "C:\\evil.bin',
    '$(calc.exe) `whoami`', "O'Brien's", 'caf\u00e9 \u30d7\u30ea\u30f3\u30bf\u30fc', 'emoji \u{1F5A8}', 'back\\slash\\', 'u2028\u2028mid\u2029end', 'del\u007f',
  ];
  const h = hostHarness();
  for (const name of names) await h.print(name);
  const child = h.spawn.children[0];
  assert.equal(child.rawLines.length, names.length);
  child.rawLines.forEach((line, index) => {
    assert.match(line, /^[\x20-\x7e]+$/, `line ${index} is one line of printable ASCII`);
    assert.equal(JSON.parse(line).printerName, names[index], 'the name arrives byte for byte');
    assert.equal(Object.keys(JSON.parse(line)).length, 3, 'a hostile name cannot add fields');
  });
  assert.equal(h.exec.calls.length, 0, 'no command string was ever built');
});

test('asciiJson escapes everything outside printable ASCII and stays valid JSON', () => {
  const value = { text: 'caf\u00e9\n"\\\u2028\u{1F5A8}\u007f', n: 5 };
  const text = asciiJson(value);
  assert.match(text, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(text), value);
});

test('lines may arrive split across chunks, and garbage lines are ignored', async () => {
  const h = hostHarness({
    behaviour: {
      respond: (command, child) => {
        child.writeStdout('this is not json\n');
        child.writeStdout('{"id":999,"ok":false,"code":4,"message":"answer for another command"}\n');
        child.writeStdout('"just a string"\n');
        child.writeStdout(`{"id":${command.id},"ok":tr`);
        child.writeStdout('ue,"code":0,"message":""}\n');
      },
    },
  });
  assert.deepEqual(await h.print(), { ok: true });
  assert.ok(h.log.entries.some((entry) => /not JSON/.test(entry.args[0])));
});

test('a runaway line without a newline is dropped instead of growing without limit', async () => {
  const h = hostHarness({
    behaviour: {
      respond: (command, child) => {
        child.writeStdout('x'.repeat(70 * 1024));
        child.answer({ id: command.id });
      },
    },
  });
  assert.deepEqual(await h.print(), { ok: true });
});

test('host answers map to the same codes as the one-shot exit codes, and the host stays alive after a failure', async () => {
  const answers = [
    [{ ok: false, code: 2, message: 'The printer name is invalid.' }, ERROR_CODES.PRINTER_NOT_FOUND, undefined],
    [{ ok: false, code: 3, message: 'Access is denied.' }, ERROR_CODES.SPOOLER_ERROR, 'open'],
    [{ ok: false, code: 4, message: 'The device is not ready.' }, ERROR_CODES.SPOOLER_ERROR, 'write'],
    [{ ok: false, code: 5, message: 'The file to print was not found.' }, ERROR_CODES.SPOOLER_ERROR, 'arguments'],
    [{ ok: false, code: 77, message: 'something else' }, ERROR_CODES.SPOOLER_ERROR, undefined],
    [{ ok: false, message: 'no code given' }, ERROR_CODES.SPOOLER_ERROR, 'open'],
    [{ ok: false, code: 0, message: 'a failure that claims code 0' }, ERROR_CODES.SPOOLER_ERROR, 'open'],
    [{ ok: false, code: 'two', message: 'a code that is not a number' }, ERROR_CODES.SPOOLER_ERROR, 'open'],
  ];
  let next = 0;
  const h = hostHarness({ behaviour: { respond: (command, child) => child.say({ id: command.id, ...answers[next++][0] }) } });
  for (const [answer, code, stage] of answers) {
    await assert.rejects(h.print('EPSON'), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.stage, stage);
      assert.equal(error.details.detail, answer.message);
      if (code === ERROR_CODES.PRINTER_NOT_FOUND) assert.equal(error.details.printerName, 'EPSON');
      return true;
    });
  }
  assert.equal(h.spawn.calls.length, 1, 'printer errors do not restart the host');
  assert.equal(h.spawn.children[0].killed, false);
  assert.equal(h.files.files.size, 0, 'temp files are deleted after failures too');
});

test('after a job the idle shutdown is armed for 10 minutes with an unref()\'d timer', async () => {
  const h = hostHarness();
  await h.print();
  assert.equal(HOST_IDLE_MS, 10 * 60 * 1000);
  assert.equal(h.clock.pending(), 1, 'only the idle timer is left: start and command timers were cleared');
  const [timer] = h.clock.handles();
  assert.equal(timer.ms, 600000);
  assert.equal(timer.unrefCalled, true, 'it never keeps the app alive');
});

test('the host is stopped after 10 idle minutes and a later job starts a fresh one', async () => {
  const h = hostHarness();
  await h.print();
  await h.clock.advance(599999);
  assert.equal(h.spawn.children[0].killed, false);
  await h.clock.advance(1);
  assert.equal(h.spawn.children[0].killed, true);
  assert.equal(h.clock.pending(), 0);

  await h.print();
  assert.equal(h.spawn.calls.length, 2);
  assert.equal(h.spawn.children[1].commands.length, 1);
  assert.equal(h.exec.calls.length, 0);
});

test('every job pushes the idle shutdown back, and a long-running command is never cut off by it', async () => {
  const h = hostHarness({ host: { commandTimeoutMs: 3600000 }, behaviour: { respond: (command, child) => { if (command.id === 3) child.slow = command; else child.answer({ id: command.id }); } } });
  await h.print();
  await h.clock.advance(9 * 60 * 1000);
  await h.print();
  await h.clock.advance(9 * 60 * 1000);
  assert.equal(h.spawn.children[0].killed, false, '18 minutes in total, but never 10 idle minutes');

  const slow = h.print();
  await settle();
  await h.clock.advance(11 * 60 * 1000);
  assert.equal(h.spawn.children[0].killed, false, 'a command in flight keeps the host');
  h.spawn.children[0].answer({ id: h.spawn.children[0].slow.id });
  assert.deepEqual(await slow, { ok: true });
  assert.equal(h.clock.pending(), 1, 'the idle timer is armed again afterwards');
});

test('dispose stops the host and clears its timer; later jobs use the one-shot script', async () => {
  const h = hostHarness();
  await h.print();
  h.printer.dispose();
  await settle();
  assert.equal(h.spawn.children[0].killed, true);
  assert.equal(h.clock.pending(), 0);
  assert.deepEqual(await h.print(), { ok: true });
  assert.equal(h.exec.calls.length, 1);
  assert.equal(h.spawn.calls.length, 1, 'no new host after dispose');
});

test('the host can be switched off: the one-shot script is used even when spawn is available', async () => {
  const h = hostHarness({ host: { enabled: false } });
  await h.print();
  assert.equal(h.spawn.calls.length, 0);
  assert.equal(h.exec.calls.length, 1);
});
