'use strict';

/**
 * SECURITY lens, injection through printer names and ports (SPEC 9.1). REGRESSION GUARDS (these pass today): whatever a settings
 * file or the Settings window puts into a printer name or a port, it reaches the operating system as exactly ONE argv element
 * or as JSON data, never as part of a command string; a name that could be read as an option is refused; a port that is not a UNC
 * share or a DOS device never reaches the file system or cmd.exe.
 *
 * Covered: `lp -d <name> -o raw <file>` (macOS, Linux), the one-shot PowerShell script (`-PrinterName <name>` parameter binding),
 * the persistent PowerShell host (one JSON line per job) and the legacy `cmd.exe copy` fallback of the port transport.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRawPrinter } = require('../../src/main/printing/transports');
const { createJobQueue } = require('../../src/main/printing/queue');
const { createFakeFs, createFakeExecFile, createFakeSpawn, fsError, settle } = require('../helpers/fake-io');

const WIN_TMP = 'C:\\Users\\Shop Owner\\AppData\\Local\\Temp';
const RESOURCES = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked';

const NAMES = [
  'EPSON TM-T20', 'Zebra ZD420 (ZPL)', 'a b  c', "O'Brien \"Till\" 1", 'back\\slash', 'C:\\x\\..\\y', '\\\\evil\\share', '../../etc/passwd',
  'x; touch /tmp/pwned', 'x && calc', 'x | calc', '$(touch /tmp/pwned)', '`touch /tmp/pwned`', '%PATH%', '^&|<>!', 'tab\there', 'line\nbreak', 'cr\rlf',
  'K\u00fcchendrucker', '\u202eevil', '\u0000nul', '-oraw', '--help', '-', ' -x', '@file', '/?', 'A'.repeat(512), 'A'.repeat(513),
];

/** The names the transports must refuse before anything is started (SPEC 9.1: NUL, longer than 512, a leading dash after trimming). */
const refused = (name) => name.includes('\0') || name.trim().length > 512 || name.trim().startsWith('-');

const data = Buffer.from([0x1b, 0x40]);
const system = (printerName) => ({ target: { transport: 'system', printerName }, data });

test('lp (macOS, Linux): the printer name is one argv element after -d; refused names start nothing', async () => {
  for (const name of NAMES) {
    const files = createFakeFs();
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'darwin', fs: files.fs, execFile: exec.execFile, tmpDir: '/tmp', queue: createJobQueue(), pid: 1 });
    if (refused(name)) {
      await assert.rejects(printer.printRaw(system(name)), (error) => error.code === 'INVALID_SETTINGS', JSON.stringify(name));
      assert.equal(exec.calls.length, 0, JSON.stringify(name));
      continue;
    }
    await printer.printRaw(system(name));
    assert.equal(exec.calls.length, 1, JSON.stringify(name));
    const [call] = exec.calls;
    assert.equal(call.file, 'lp');
    assert.deepEqual(call.args.slice(0, 4), ['-d', name.trim(), '-o', 'raw'], JSON.stringify(name));
    assert.equal(call.args.length, 5, 'one file argument, nothing else');
    assert.match(call.args[4], /^\/tmp\/gpos-1-\d+-\d+\.bin$/);
    assert.ok(!call.options.shell, 'no shell');
  }
});

test('PowerShell one-shot: the name is the single value of -PrinterName, the file the single value of -FilePath', async () => {
  for (const name of NAMES) {
    const files = createFakeFs();
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: WIN_TMP, resourcesPath: RESOURCES, queue: createJobQueue(), pid: 1 });
    if (refused(name)) {
      await assert.rejects(printer.printRaw(system(name)), (error) => error.code === 'INVALID_SETTINGS', JSON.stringify(name));
      assert.equal(exec.calls.length, 0);
      continue;
    }
    await printer.printRaw(system(name));
    const [call] = exec.calls;
    assert.equal(call.file, 'powershell.exe');
    assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(call.args[5], `${RESOURCES}\\scripts\\raw-print.ps1`);
    assert.equal(call.args[6], '-PrinterName');
    assert.equal(call.args[7], name.trim(), JSON.stringify(name));
    assert.equal(call.args[8], '-FilePath');
    assert.match(call.args[9], /^C:\\Users\\Shop Owner\\AppData\\Local\\Temp\\gpos-1-\d+-\d+\.bin$/);
    assert.equal(call.args.length, 10);
    assert.ok(!call.options.shell, 'no shell');
  }
});

test('PowerShell host: the name travels as JSON data on one ASCII line', async () => {
  for (const name of NAMES.filter((candidate) => !refused(candidate))) {
    const files = createFakeFs();
    const spawn = createFakeSpawn();
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'win32', fs: files.fs, execFile: exec.execFile, spawn: spawn.spawn, tmpDir: WIN_TMP, resourcesPath: RESOURCES, queue: createJobQueue(), pid: 1 });
    await printer.printRaw(system(name));
    await settle();
    const [child] = spawn.children;
    assert.equal(child.rawLines.length, 1, JSON.stringify(name));
    assert.match(child.rawLines[0], /^[\x20-\x7e]+$/, `the command line must be one line of printable ASCII: ${JSON.stringify(name)}`);
    const command = JSON.parse(child.rawLines[0]);
    assert.equal(command.printerName, name.trim(), JSON.stringify(name));
    assert.deepEqual(Object.keys(command).sort(), ['filePath', 'id', 'printerName']);
    assert.equal(exec.calls.length, 0, 'the one-shot script is not needed');
  }
});

const PORTS = {
  accepted: ['LPT1', 'lpt1:', 'COM3', '\\\\.\\COM3', 'PRN', '\\\\localhost\\ZebraZD420', '\\\\print-server\\Zebra ZD420'],
  refused: ['USB001', 'C:\\spool\\out.prn', '..\\x', '\\\\?\\C:\\x', '\\\\host\\a\\b', '\\\\host\\sh%are', 'LPT1&calc', 'LPT1 | calc', 'COM257', '\\\\host\\sh"are', '\\\\host\\a^b', 'LP\nT1', 'LPT1\u0000', '\\\\host\\C$', '\\\\.\\PhysicalDrive0', 'NUL', 'CON', 'AUX'],
};

test('port transport: a refused port never reaches the file system or cmd.exe; an accepted one is opened as a device or share', async () => {
  for (const port of PORTS.refused) {
    const files = createFakeFs();
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: WIN_TMP, resourcesPath: RESOURCES, queue: createJobQueue(), pid: 1 });
    await assert.rejects(printer.printRaw({ target: { transport: 'port', port }, data }), (error) => error.code === 'INVALID_SETTINGS', JSON.stringify(port));
    assert.equal(files.opens.length + files.created.length + exec.calls.length, 0, `${JSON.stringify(port)} touched the file system or a process`);
  }
  for (const port of PORTS.accepted) {
    const files = createFakeFs();
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: WIN_TMP, resourcesPath: RESOURCES, queue: createJobQueue(), pid: 1 });
    await printer.printRaw({ target: { transport: 'port', port }, data });
    assert.equal(files.opens.length, 1, JSON.stringify(port));
    assert.match(files.opens[0].path, /^\\\\(\.\\(LPT[1-9]|COM\d+|PRN)|[^\\]+\\[^\\]+)$/, 'a device name is always opened in the explicit device namespace');
    assert.equal(exec.calls.length, 0);
  }
});

test('port transport: the cmd.exe fallback gets a bare generated file name, the validated port, and the temp folder as cwd', async () => {
  for (const port of ['LPT1', '\\\\localhost\\ZebraZD420', '\\\\print-server\\Zebra ZD420']) {
    const files = createFakeFs();
    files.hooks.open = () => { throw fsError('ENOENT'); };
    const exec = createFakeExecFile();
    const printer = createRawPrinter({ platform: 'win32', fs: files.fs, execFile: exec.execFile, tmpDir: WIN_TMP, resourcesPath: RESOURCES, queue: createJobQueue(), pid: 1 });
    await printer.printRaw({ target: { transport: 'port', port }, data, ext: 'zpl' });
    assert.equal(exec.calls.length, 1);
    const [call] = exec.calls;
    assert.equal(call.file, 'cmd.exe');
    assert.deepEqual(call.args.slice(0, 4), ['/d', '/c', 'copy', '/B']);
    assert.match(call.args[4], /^gpos-1-\d+-\d+\.zpl$/, 'a bare name, never a path built from the user profile');
    assert.doesNotMatch(call.args[5], /["'&|<>^%!,;=()]/, 'nothing cmd.exe re-parses');
    assert.equal(call.options.cwd, WIN_TMP);
    assert.ok(!call.options.shell);
  }
});
