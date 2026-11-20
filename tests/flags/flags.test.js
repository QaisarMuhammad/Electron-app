'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_FLAGS,
  FLAGS_FILE_NAME,
  REASONS,
  sanitizeFlags,
  flagsPath,
  readFlagsSync,
  writeFlags,
} = require('../../src/main/flags');

const WINDOWS = process.platform === 'win32';

/** A fresh empty userData folder, removed when the test ends. */
function userDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function putFile(dir, content) {
  fs.writeFileSync(path.join(dir, FLAGS_FILE_NAME), typeof content === 'string' ? content : JSON.stringify(content));
}

// ---------------------------------------------------------------------------------------------
// Defaults and reading
// ---------------------------------------------------------------------------------------------

test('DEFAULT_FLAGS: hardware acceleration on, brotli off (v1 behaviour), no reason, GPU question not asked yet; frozen', () => {
  assert.deepEqual(DEFAULT_FLAGS, { disableGpu: false, disableBrotli: true, reason: '', gpuChecked: false });
  assert.ok(Object.isFrozen(DEFAULT_FLAGS));
  assert.equal(FLAGS_FILE_NAME, 'flags.json');
});

test('flagsPath puts flags.json inside the userData folder', () => {
  assert.equal(flagsPath(path.join('x', 'userData')), path.join('x', 'userData', 'flags.json'));
});

test('a missing file, or a missing folder, gives the defaults, as a NEW object every time', (t) => {
  const dir = userDataDir(t);
  const first = readFlagsSync(dir);
  assert.deepEqual(first, DEFAULT_FLAGS);
  first.disableGpu = true;
  first.reason = 'changed by a caller';
  assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'the caller cannot change what the next read returns');
  assert.deepEqual(readFlagsSync(path.join(dir, 'does', 'not', 'exist')), DEFAULT_FLAGS);
  assert.notEqual(readFlagsSync(dir), DEFAULT_FLAGS);
});

test('a complete file is read as written', (t) => {
  const dir = userDataDir(t);
  putFile(dir, { disableGpu: true, disableBrotli: false, reason: 'manual', gpuChecked: true });
  assert.deepEqual(readFlagsSync(dir), { disableGpu: true, disableBrotli: false, reason: 'manual', gpuChecked: true });
});

test('a partial file keeps the defaults for the keys it lacks', (t) => {
  const dir = userDataDir(t);
  putFile(dir, { disableGpu: true });
  assert.deepEqual(readFlagsSync(dir), { disableGpu: true, disableBrotli: true, reason: '', gpuChecked: false });
});

test('unknown keys are dropped', (t) => {
  const dir = userDataDir(t);
  putFile(dir, { disableGpu: true, enableMagic: true, __proto__x: 1, nested: { a: 1 } });
  assert.deepEqual(Object.keys(readFlagsSync(dir)).sort(), ['disableBrotli', 'disableGpu', 'gpuChecked', 'reason']);
});

test('types are coerced when they clearly mean something, and replaced by the default when they do not', () => {
  const table = [
    [{ disableGpu: 'true' }, { disableGpu: true }],
    [{ disableGpu: 'TRUE ' }, { disableGpu: true }],
    [{ disableGpu: 'yes' }, { disableGpu: true }],
    [{ disableGpu: 1 }, { disableGpu: true }],
    [{ disableGpu: '1' }, { disableGpu: true }],
    [{ disableGpu: 'false' }, { disableGpu: false }],
    [{ disableGpu: 0 }, { disableGpu: false }],
    [{ disableBrotli: 'false' }, { disableBrotli: false }],
    [{ disableBrotli: 0 }, { disableBrotli: false }],
    [{ disableBrotli: 'no' }, { disableBrotli: false }],
    [{ gpuChecked: 'true' }, { gpuChecked: true }],
    [{ disableGpu: 'maybe' }, { disableGpu: false }],
    [{ disableGpu: 2 }, { disableGpu: false }],
    [{ disableGpu: null }, { disableGpu: false }],
    [{ disableGpu: {} }, { disableGpu: false }],
    [{ disableGpu: [true] }, { disableGpu: false }],
    [{ disableBrotli: 'maybe' }, { disableBrotli: true }],
    [{ disableBrotli: null }, { disableBrotli: true }],
    [{ reason: 123 }, { reason: '' }],
    [{ reason: null }, { reason: '' }],
    [{ reason: { a: 1 } }, { reason: '' }],
  ];
  for (const [input, expected] of table) {
    assert.deepEqual(sanitizeFlags(input), { ...DEFAULT_FLAGS, ...expected }, JSON.stringify(input));
  }
});

test('the reason is one short line: control characters become spaces, runs collapse, 200 characters at most', () => {
  assert.equal(sanitizeFlags({ reason: '  gpu\ncrashed\t\ttwice\u0000now  ' }).reason, 'gpu crashed twice now');
  assert.equal(sanitizeFlags({ reason: 'x'.repeat(500) }).reason.length, 200);
  assert.equal(sanitizeFlags({ reason: '\n\n' }).reason, '');
});

test('sanitizeFlags turns anything that is not an object into the defaults', () => {
  for (const input of [undefined, null, 'x', 42, true, [], [{ disableGpu: true }], () => ({})]) {
    assert.deepEqual(sanitizeFlags(input), DEFAULT_FLAGS, String(input));
  }
});

test('a corrupt, empty or non-object file gives the defaults and never throws', (t) => {
  const dir = userDataDir(t);
  for (const content of ['', '   ', '{', '{"disableGpu": true', 'not json at all', '[]', '[{"disableGpu":true}]', 'null', '42', '"disableGpu"', '{"disableGpu":}', '\u0000\u0000']) {
    putFile(dir, content);
    assert.doesNotThrow(() => readFlagsSync(dir), JSON.stringify(content));
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, JSON.stringify(content));
  }
});

test('a byte-order mark at the start (Notepad adds one) is ignored', (t) => {
  const dir = userDataDir(t);
  putFile(dir, `﻿${JSON.stringify({ disableGpu: true, reason: 'manual' })}`);
  assert.deepEqual(readFlagsSync(dir), { ...DEFAULT_FLAGS, disableGpu: true, reason: 'manual' });
});

test('flags.json being a folder, or an unusable userData argument, still gives the defaults', (t) => {
  const dir = userDataDir(t);
  fs.mkdirSync(path.join(dir, FLAGS_FILE_NAME));
  assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS);
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.doesNotThrow(() => readFlagsSync(bad));
    assert.deepEqual(readFlagsSync(bad), DEFAULT_FLAGS);
  }
});

test('a file system that throws (permissions, a disk error) gives the defaults', () => {
  const broken = { readFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  assert.deepEqual(readFlagsSync('/anywhere', { fs: broken }), DEFAULT_FLAGS);
});

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

test('writeFlags creates the folder and a readable, pretty JSON file with a final newline, and returns what it wrote', (t) => {
  const dir = path.join(userDataDir(t), 'nested', 'userData');
  const written = writeFlags(dir, { disableGpu: true, reason: REASONS.MANUAL });
  assert.deepEqual(written, { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: false });
  const text = fs.readFileSync(flagsPath(dir), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n  "disableGpu": true'), '2-space indent');
  assert.deepEqual(JSON.parse(text), written);
  assert.deepEqual(readFlagsSync(dir), written);
});

test('writeFlags keeps the file private (mode 0600)', { skip: WINDOWS && 'POSIX file modes only' }, (t) => {
  const dir = userDataDir(t);
  writeFlags(dir, { disableGpu: true });
  assert.equal(fs.statSync(flagsPath(dir)).mode & 0o777, 0o600);
  writeFlags(dir, { gpuChecked: true });
  assert.equal(fs.statSync(flagsPath(dir)).mode & 0o777, 0o600, 'also after the file was replaced');
});

test('writeFlags merges the patch into what is stored and keeps everything else', (t) => {
  const dir = userDataDir(t);
  putFile(dir, { disableGpu: false, disableBrotli: false, reason: '', gpuChecked: true });
  assert.deepEqual(writeFlags(dir, { disableGpu: true, reason: 'gpu-crashes' }), {
    disableGpu: true,
    disableBrotli: false,
    reason: 'gpu-crashes',
    gpuChecked: true,
  });
  assert.deepEqual(writeFlags(dir, { disableGpu: false, reason: '' }), { disableGpu: false, disableBrotli: false, reason: '', gpuChecked: true });
});

test('writeFlags ignores keys that are not flags, undefined values and patches that are not objects', (t) => {
  const dir = userDataDir(t);
  writeFlags(dir, { disableGpu: true });
  for (const patch of [{ enableMagic: true, __proto__: { disableGpu: false } }, { disableGpu: undefined }, null, undefined, 'x', 42, []]) {
    writeFlags(dir, patch);
    assert.deepEqual(readFlagsSync(dir), { ...DEFAULT_FLAGS, disableGpu: true }, JSON.stringify(patch));
  }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(flagsPath(dir), 'utf8'))).sort(), ['disableBrotli', 'disableGpu', 'gpuChecked', 'reason']);
});

test('writeFlags coerces the patch with the same rules as reading', (t) => {
  const dir = userDataDir(t);
  assert.deepEqual(writeFlags(dir, { disableGpu: 'yes', gpuChecked: 1, reason: 'a\nb' }), { ...DEFAULT_FLAGS, disableGpu: true, gpuChecked: true, reason: 'a b' });
});

test('a corrupt flags.json is replaced by the defaults plus the patch', (t) => {
  const dir = userDataDir(t);
  putFile(dir, '{ this is not json');
  assert.deepEqual(writeFlags(dir, { gpuChecked: true }), { ...DEFAULT_FLAGS, gpuChecked: true });
  assert.deepEqual(readFlagsSync(dir), { ...DEFAULT_FLAGS, gpuChecked: true });
});

test('the gpuChecked answer is stored once and survives later writes, so the question is never asked again (R1b)', (t) => {
  const dir = userDataDir(t);
  assert.equal(readFlagsSync(dir).gpuChecked, false, 'first launch after the upgrade: the question is due');
  writeFlags(dir, { gpuChecked: true });
  assert.equal(readFlagsSync(dir).gpuChecked, true, 'next launch: answered');
  writeFlags(dir, { disableGpu: true, reason: REASONS.MANUAL });
  assert.deepEqual(readFlagsSync(dir), { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: true });
  writeFlags(dir, { disableGpu: false, reason: '' });
  assert.equal(readFlagsSync(dir).gpuChecked, true, 'switching acceleration back on does not bring the question back');
});

test('writing is atomic: a temp file in the same folder (mode 0600, created exclusively) is renamed over flags.json', (t) => {
  const dir = userDataDir(t);
  const calls = [];
  const spy = {
    ...fs,
    mkdirSync: (...args) => { calls.push(['mkdir', args[0]]); return fs.mkdirSync(...args); },
    writeFileSync: (...args) => { calls.push(['write', args[0], args[2]]); return fs.writeFileSync(...args); },
    renameSync: (...args) => { calls.push(['rename', args[0], args[1]]); return fs.renameSync(...args); },
  };
  writeFlags(dir, { disableGpu: true }, { fs: spy });

  const [mkdir, write, rename] = calls;
  assert.equal(mkdir[0], 'mkdir');
  assert.equal(write[0], 'write');
  assert.equal(rename[0], 'rename');
  const target = flagsPath(dir);
  assert.notEqual(write[1], target, 'never written in place');
  assert.equal(path.dirname(write[1]), dir, 'the temp file sits next to the target (same file system)');
  assert.deepEqual(write[2], { mode: 0o600, flag: 'wx' });
  assert.equal(rename[1], write[1]);
  assert.equal(rename[2], target);
  assert.deepEqual(fs.readdirSync(dir), [FLAGS_FILE_NAME], 'no temp file left behind');
});

test('a failed rename removes the temp file, throws, and leaves the old flags.json untouched', (t) => {
  const dir = userDataDir(t);
  writeFlags(dir, { disableGpu: true, reason: 'manual' });
  const before = fs.readFileSync(flagsPath(dir), 'utf8');
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('EPERM: locked by another program'), { code: 'EPERM' }); } };
  assert.throws(() => writeFlags(dir, { disableGpu: false }, { fs: failing }), { code: 'EPERM' });
  assert.equal(fs.readFileSync(flagsPath(dir), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), [FLAGS_FILE_NAME]);
});

test('a failed temp write throws the original error and leaves nothing behind', (t) => {
  const dir = userDataDir(t);
  const failing = { ...fs, writeFileSync: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } };
  assert.throws(() => writeFlags(dir, { disableGpu: true }, { fs: failing }), { code: 'ENOSPC' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('if even removing the temp file fails, the ORIGINAL error is the one reported', (t) => {
  const dir = userDataDir(t);
  const failing = {
    ...fs,
    renameSync: () => { throw Object.assign(new Error('rename failed'), { code: 'EXDEV' }); },
    rmSync: () => { throw new Error('rm failed too'); },
  };
  assert.throws(() => writeFlags(dir, { disableGpu: true }, { fs: failing }), { code: 'EXDEV' });
});

test('a flags.json that cannot be replaced (a folder in the way) throws and cleans up its temp file', (t) => {
  const dir = userDataDir(t);
  fs.mkdirSync(path.join(dir, FLAGS_FILE_NAME));
  assert.throws(() => writeFlags(dir, { disableGpu: true }));
  assert.deepEqual(fs.readdirSync(dir), [FLAGS_FILE_NAME], 'only the folder is left');
});
