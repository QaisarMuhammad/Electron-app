'use strict';

/**
 * migrateLegacy() (SPEC 5.2 and 16): the v1.6.1 -> v2 migration, run through the REAL createConfig with the full v2
 * defaults over a fake Store that reproduces conf (tests/helpers/fake-store.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createConfig, DEFAULTS, BACKUP_FILE_NAME, validatePrinter } = require('../../src/main/config');
const password = require('../../src/main/password');
const { createFakeStoreEnv, createRecordingLog, makeV1Fixture, V1_FIXTURE } = require('../helpers/fake-store');

const WINDOWS = process.platform === 'win32';

/** A config over a fake Store; `file` is written to config.json first when given (not for a fresh install). */
function setup(t, file, deps = {}) {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  if (file !== undefined) env.writeRaw(file);
  const log = createRecordingLog();
  const config = createConfig({ Store: env.Store, log, defaults: DEFAULTS, ...deps });
  return { env, log, config };
}

/** Migrate `raw` and return everything a test might look at. */
function migrate(t, raw, deps) {
  const ctx = setup(t, raw, deps);
  const result = ctx.config.migrateLegacy();
  return { ...ctx, result, file: ctx.env.readRaw() };
}

const readBackup = (env) => JSON.parse(fs.readFileSync(path.join(env.dir, BACKUP_FILE_NAME), 'utf8'));
const withoutPassword = (object) => {
  const { password: _omitted, ...rest } = object;
  return rest;
};

// ---------------------------------------------------------------------------------------------
// The v1.6.1 file of SPEC 16
// ---------------------------------------------------------------------------------------------

test('every key of a v1.6.1 file is migrated (printer, port, password, label printer, junk)', (t) => {
  const original = makeV1Fixture();
  const { env, config, result, file } = migrate(t, original);

  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: true, label: true, password: 'migrated' });
  assert.deepEqual(config.get('printers.receipt'), { transport: 'port', printerName: 'EPSON TM-T20II Receipt', port: '\\\\localhost\\EpsonTM' });
  assert.deepEqual(config.get('printers.label'), { transport: 'port', printerName: 'Zebra ZD420', port: 'USB001' });
  assert.deepEqual(config.get('printers.dymo'), { printerName: '' }, 'v1 never used the stored label printer for DYMO: it starts empty');
  assert.equal(config.get('drawer.passwordWeak'), false);
  assert.equal(password.verifyPassword('4321', config.get('drawer.passwordRecord')), true, 'the old password opens the drawer');
  assert.equal(password.verifyPassword('0000', config.get('drawer.passwordRecord')), false);
  assert.equal(config.publicState().drawer.passwordSet, true);

  assert.equal(file.schemaVersion, 2);
  assert.deepEqual(Object.keys(file.printers).sort(), ['label', 'receipt'], 'only what was migrated is stored; defaults stay in code');
  assert.ok(file.drawer.passwordRecord);
  assert.equal(file.drawer.passwordWeak, false);
  assert.equal('password' in file, false, 'the plain password is gone');
  for (const key of ['a4PrinterName', 'a4PrinterPort', 'a4Password', 'printerBrand']) assert.equal(key in file, false, key);
  for (const key of ['printerName', 'printerPort', 'labelPrinterName', 'labelPrinterPort']) {
    assert.equal(file[key], original[key], `${key} stays in place so a downgrade to v1.6.1 still prints`);
  }
  assert.deepEqual(Object.keys(file).sort(), ['drawer', 'labelPrinterName', 'labelPrinterPort', 'printerName', 'printerPort', 'printers', 'schemaVersion']);
  assert.equal(env.stats.writes, 1, 'one atomic write replaces the whole file');
});

test('config.v1-backup.json holds the old file WITHOUT its password, with mode 0600', { skip: WINDOWS && 'POSIX file modes only' }, (t) => {
  const original = makeV1Fixture();
  const { env } = migrate(t, original);
  assert.deepEqual(readBackup(env), withoutPassword(original));
  assert.equal('password' in readBackup(env), false);
  assert.equal(env.mode(BACKUP_FILE_NAME), 0o600);
  assert.equal(env.mode('config.json'), 0o600);
  assert.deepEqual(env.list(), ['config.json', BACKUP_FILE_NAME]);
});

test('the log gets a summary, never the password and never any part of the hash', (t) => {
  const { log, config } = migrate(t, makeV1Fixture({ password: 'my-very-secret-pw' }));
  const text = log.text();
  assert.match(text, /migrated/);
  assert.ok(!text.includes('my-very-secret-pw'));
  const record = config.all().drawer.passwordRecord;
  assert.ok(!text.includes(record.hash) && !text.includes(record.salt));
});

test('the migrated values are acceptable to the validators of the Settings screen', (t) => {
  const { config } = migrate(t, makeV1Fixture());
  assert.equal(validatePrinter('receipt', config.get('printers.receipt')).ok, true);
  assert.equal(validatePrinter('label', config.get('printers.label')).ok, true);
});

test('legacy keys stay invisible to the app after the migration', (t) => {
  const { config } = migrate(t, makeV1Fixture());
  for (const key of ['printerName', 'printerPort', 'password', 'labelPrinterName', 'labelPrinterPort']) assert.equal(config.get(key, 'hidden'), 'hidden', key);
  assert.equal('printerName' in config.all(), false);
});

test('a subscriber hears about the migration once, with the new config', (t) => {
  const { config } = setup(t, makeV1Fixture());
  const calls = [];
  config.onDidChange((next, old) => calls.push({ next, old }));
  config.migrateLegacy();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].next.schemaVersion, 2);
  assert.equal(calls[0].old.schemaVersion, undefined);
  assert.equal(calls[0].next.printers.receipt.printerName, V1_FIXTURE.printerName);
});

// ---------------------------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------------------------

test('a second start changes nothing: no write, same bytes, answers "current"', (t) => {
  const first = setup(t, makeV1Fixture());
  assert.equal(first.config.migrateLegacy().migrated, true);
  const before = first.env.readText();
  const writes = first.env.stats.writes;

  const second = createConfig({ Store: first.env.Store, log: createRecordingLog(), defaults: DEFAULTS });
  assert.deepEqual(second.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(first.env.readText(), before);
  assert.equal(first.env.stats.writes, writes);
  assert.deepEqual(second.get('printers.receipt'), first.config.get('printers.receipt'));
  assert.equal(password.verifyPassword('4321', second.get('drawer.passwordRecord')), true);
});

test('calling it twice on the same config is harmless', (t) => {
  const { env, config } = setup(t, makeV1Fixture());
  assert.equal(config.migrateLegacy().migrated, true);
  const writes = env.stats.writes;
  const text = env.readText();
  assert.deepEqual(config.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.deepEqual(config.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(env.stats.writes, writes);
  assert.equal(env.readText(), text);
});

test('a file already at schemaVersion 2 is untouched, even with legacy-looking keys in it', (t) => {
  const text = JSON.stringify({ schemaVersion: 2, serverUrl: 'https://pos.example.com/', printerName: 'stays as it is', password: 'stays too' }, undefined, '\t');
  const { env, config } = setup(t, text);
  assert.deepEqual(config.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(env.readText(), text);
  assert.equal(env.stats.writes, 0);
  assert.equal(env.exists(BACKUP_FILE_NAME), false);
  assert.equal(config.get('serverUrl'), 'https://pos.example.com/');
  assert.equal(config.get('printers.receipt.printerName'), '', 'the legacy printerName was NOT migrated');
});

test('a file from a newer app (schemaVersion above 2) is left alone as well', (t) => {
  const text = JSON.stringify({ schemaVersion: 3, printerName: 'x' });
  const { env, config } = setup(t, text);
  assert.deepEqual(config.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(env.readText(), text);
});

test('only a real integer of 2 or more counts as "current": absent, 0, 1, a string, a float, null all migrate', (t) => {
  for (const schemaVersion of [undefined, 0, 1, -1, '2', 2.5, null, true, [2], {}]) {
    const { result, file } = migrate(t, { schemaVersion, printerName: 'A' });
    assert.equal(result.migrated, true, String(schemaVersion));
    assert.equal(file.schemaVersion, 2, String(schemaVersion));
    assert.equal(file.printers.receipt.printerName, 'A');
  }
});

// ---------------------------------------------------------------------------------------------
// Every combination of legacy keys
// ---------------------------------------------------------------------------------------------

test('only a receipt printer by name: it uses the installed-printer transport', (t) => {
  const { config, result, file, env } = migrate(t, { printerName: 'EPSON', printerPort: '' });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: true, label: false, password: 'none' });
  assert.deepEqual(file.printers, { receipt: { transport: 'system', printerName: 'EPSON', port: '' } });
  assert.deepEqual(config.get('printers.label'), DEFAULTS.printers.label);
  assert.equal(file.drawer, undefined);
  assert.equal(config.get('drawer.passwordRecord'), null);
  assert.deepEqual(readBackup(env), { printerName: 'EPSON', printerPort: '' });
});

test('only a receipt port (no name): it uses the port transport', (t) => {
  const { result, file } = migrate(t, { printerPort: 'LPT1' });
  assert.equal(result.receipt, true);
  assert.deepEqual(file.printers.receipt, { transport: 'port', printerName: '', port: 'LPT1' });
});

test('a receipt printer with both a name and a port goes through the port, as v1 did', (t) => {
  const { file } = migrate(t, { printerName: 'EPSON', printerPort: '\\\\localhost\\EpsonTM' });
  assert.deepEqual(file.printers.receipt, { transport: 'port', printerName: 'EPSON', port: '\\\\localhost\\EpsonTM' });
});

test('only a label printer: it becomes printers.label and printers.dymo stays empty', (t) => {
  const { config, result, file } = migrate(t, { labelPrinterName: 'Zebra ZD420', labelPrinterPort: '' });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: true, password: 'none' });
  assert.deepEqual(file.printers, { label: { transport: 'system', printerName: 'Zebra ZD420', port: '' } });
  assert.deepEqual(config.get('printers.receipt'), DEFAULTS.printers.receipt);
  assert.equal(config.get('printers.dymo.printerName'), '');
  assert.equal(file.printers.dymo, undefined);
});

test('a label printer on a port', (t) => {
  const { file } = migrate(t, { labelPrinterName: 'Zebra', labelPrinterPort: '\\\\localhost\\ZebraZD420' });
  assert.deepEqual(file.printers.label, { transport: 'port', printerName: 'Zebra', port: '\\\\localhost\\ZebraZD420' });
});

test('no legacy keys at all (an empty file): only schemaVersion is written, and no backup', (t) => {
  const { env, result, file } = migrate(t, {});
  assert.deepEqual(result, { migrated: true, fromV1: false, backedUp: false, receipt: false, label: false, password: 'none' });
  assert.deepEqual(file, { schemaVersion: 2 });
  assert.equal(env.exists(BACKUP_FILE_NAME), false);
});

test('a fresh install (no file yet): the file is created with just schemaVersion, and no backup', (t) => {
  const { env, result, file } = migrate(t, undefined);
  assert.deepEqual(result, { migrated: true, fromV1: false, backedUp: false, receipt: false, label: false, password: 'none' });
  assert.deepEqual(file, { schemaVersion: 2 });
  assert.deepEqual(env.list(), ['config.json']);
});

test('keys that are not v1 keys are carried over untouched', (t) => {
  const { result, file } = migrate(t, { custom: { a: [1, 2] }, serverUrl: 'https://pos.example.com/' });
  assert.equal(result.fromV1, false);
  assert.deepEqual(file, { custom: { a: [1, 2] }, serverUrl: 'https://pos.example.com/', schemaVersion: 2 });
});

test('only a plain password: it becomes a record, the plain key is removed, and the backup has no password', (t) => {
  const { env, config, result, file } = migrate(t, { password: 'abcd' });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: false, password: 'migrated' });
  assert.equal('password' in file, false);
  assert.equal(file.printers, undefined);
  assert.equal(password.verifyPassword('abcd', config.get('drawer.passwordRecord')), true);
  assert.deepEqual(readBackup(env), {});
});

test('only obsolete keys (A4 printer, brand): they are removed, and the backup keeps them', (t) => {
  const { env, result, file } = migrate(t, { a4PrinterName: 'HP', a4PrinterPort: 'LPT2', a4Password: 'x', printerBrand: 'epson' });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: false, password: 'none' });
  assert.deepEqual(file, { schemaVersion: 2 });
  assert.deepEqual(readBackup(env), { a4PrinterName: 'HP', a4PrinterPort: 'LPT2', a4Password: 'x', printerBrand: 'epson' });
});

test('empty legacy values migrate nothing, and the keys stay where they are', (t) => {
  const { result, file } = migrate(t, { printerName: '', printerPort: '', labelPrinterName: '   ', labelPrinterPort: '' });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: false, password: 'none' });
  assert.equal(file.printers, undefined);
  assert.equal(file.printerName, '');
});

test('names and ports are trimmed', (t) => {
  const { file } = migrate(t, { printerName: '  EPSON  ', printerPort: ' LPT1 ' });
  assert.deepEqual(file.printers.receipt, { transport: 'port', printerName: 'EPSON', port: 'LPT1' });
});

test('corrupt values (numbers, objects, arrays, null, too long, control characters) are not migrated and do not stop the migration', (t) => {
  const corrupt = {
    printerName: 123,
    printerPort: { a: 1 },
    password: 12345,
    labelPrinterName: null,
    labelPrinterPort: ['x'],
    a4Password: 5,
  };
  const { config, result, file, env } = migrate(t, corrupt);
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: false, password: 'none' });
  assert.equal(file.schemaVersion, 2);
  assert.equal(file.printers, undefined);
  assert.equal(config.get('drawer.passwordRecord'), null, 'a number is not a password');
  assert.equal(config.publicState().drawer.passwordSet, false);
  assert.equal(file.password, 12345, 'a value that is not a password is left where it was');
  assert.equal('a4Password' in file, false, 'the obsolete keys go, whatever they hold');
  assert.deepEqual(readBackup(env), withoutPassword(corrupt));
});

test('names that are too long or contain control characters count as empty', (t) => {
  const { result, file } = migrate(t, { printerName: 'x'.repeat(513), printerPort: 'LPT1\u0000', labelPrinterName: 'ok\nname', labelPrinterPort: '' });
  assert.equal(result.receipt, false);
  assert.equal(result.label, false);
  assert.equal(file.printers, undefined);

  const exact = migrate(t, { printerName: 'x'.repeat(512) });
  assert.equal(exact.result.receipt, true, '512 characters is still allowed');
  assert.equal(exact.file.printers.receipt.printerName.length, 512);
});

test('an empty-string password is not a password', (t) => {
  const { result, file } = migrate(t, { password: '', printerName: 'A' });
  assert.equal(result.password, 'none');
  assert.equal(file.password, '');
  assert.equal(file.drawer, undefined);
});

test('a hostile key like __proto__ in the old file cannot pollute anything', (t) => {
  const { file } = migrate(t, '{"__proto__": {"polluted": true}, "printerName": "A", "constructor": {"x": 1}}');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(file, '__proto__'), false);
  assert.equal(Object.hasOwn(file, 'constructor'), false);
  assert.equal(file.printers.receipt.printerName, 'A');
});

// ---------------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------------

test('legacy passwords all verify after the migration; passwordWeak is set exactly when the 4..64 policy is broken (SPEC 16)', (t) => {
  const cases = [
    ['1', true],
    ['123', true],
    ['x'.repeat(65), true],
    ['   ', true],
    [' 1234 ', false],
    ['päss', false],
    ['abcd', false],
    ['x'.repeat(64), false],
    ['    ', false],
  ];
  for (const [legacy, weak] of cases) {
    const { config, result, file } = migrate(t, { password: legacy });
    const label = JSON.stringify(legacy).slice(0, 20);
    assert.equal(password.verifyPassword(legacy, config.get('drawer.passwordRecord')), true, `${label} verifies exactly as stored`);
    assert.equal(config.get('drawer.passwordWeak'), weak, `${label} weak`);
    assert.equal(result.password, weak ? 'weak' : 'migrated', label);
    assert.equal(file.drawer.passwordWeak, weak);
    assert.equal('password' in file, false);
    assert.equal(config.publicState().drawer.passwordWeak, weak);
    assert.equal(config.publicState().drawer.passwordSet, true);
  }
});

test('a migrated password is hashed as stored: no trim, so the trimmed text does not open the drawer', (t) => {
  const { config } = migrate(t, { password: ' 1234 ' });
  const record = config.get('drawer.passwordRecord');
  assert.equal(password.verifyPassword(' 1234 ', record), true);
  assert.equal(password.verifyPassword('1234', record), false);
});

// ---------------------------------------------------------------------------------------------
// Failures: the old settings must survive, and the next start retries
// ---------------------------------------------------------------------------------------------

test('a password that cannot be hashed leaves everything as it was, schemaVersion unwritten, and the error is returned', (t) => {
  const failing = { ...password, hashPassword: () => { throw new Error('scrypt exploded'); } };
  const { env, log, config } = setup(t, makeV1Fixture({ password: 'secret-4321' }), { password: failing });
  const before = env.readText();

  const result = config.migrateLegacy();
  assert.equal(result.migrated, false);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /scrypt exploded/);

  assert.equal(env.readText(), before, 'byte for byte');
  assert.equal(env.stats.writes, 0);
  assert.equal(env.exists(BACKUP_FILE_NAME), false);
  assert.equal(env.readRaw().schemaVersion, undefined);
  assert.equal(env.readRaw().password, 'secret-4321', 'the plain key is still there');
  assert.equal(config.get('drawer.passwordRecord'), null);
  assert.ok(log.entries.some((e) => e.level === 'error' && /migration failed/.test(log.text())));
  assert.ok(!log.text().includes('secret-4321'));
});

test('after a failed migration the next start retries and ends in the same state as a clean migration', (t) => {
  const original = makeV1Fixture({ password: 'secret-4321' });
  const failing = { ...password, hashPassword: () => { throw new Error('scrypt exploded'); } };
  const first = setup(t, original, { password: failing });
  assert.equal(first.config.migrateLegacy().migrated, false);

  const retry = createConfig({ Store: first.env.Store, log: createRecordingLog(), defaults: DEFAULTS });
  const result = retry.migrateLegacy();
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: true, label: true, password: 'migrated' });

  const clean = migrate(t, original);
  const dropRecord = (file) => ({ ...file, drawer: { ...file.drawer, passwordRecord: 'record' } });
  assert.deepEqual(dropRecord(first.env.readRaw()), dropRecord(clean.file));
  assert.equal(password.verifyPassword('secret-4321', retry.get('drawer.passwordRecord')), true);
});

test('a write that fails leaves the old file exactly as it was; the retry succeeds and keeps the first backup', (t) => {
  const original = makeV1Fixture();
  const { env, log, config } = setup(t, original);
  const before = env.readText();
  env.failWrite(1, new Error('ENOSPC: no space left on device'));

  const failed = config.migrateLegacy();
  assert.equal(failed.migrated, false);
  assert.match(failed.error.message, /ENOSPC/);
  assert.equal(env.readText(), before, 'the old file is untouched: nothing half-written');
  assert.equal(env.readRaw().schemaVersion, undefined);
  assert.equal(env.readRaw().password, original.password);
  assert.deepEqual(readBackup(env), withoutPassword(original), 'the backup was saved before the write was attempted');
  assert.ok(log.entries.some((e) => e.level === 'error' && /ENOSPC/.test(log.text())));

  const retried = config.migrateLegacy();
  assert.deepEqual(retried, { migrated: true, fromV1: true, backedUp: false, receipt: true, label: true, password: 'migrated' });
  assert.equal(env.readRaw().schemaVersion, 2);
  assert.deepEqual(readBackup(env), withoutPassword(original), 'the backup is the ORIGINAL v1 file, not a later state');
});

test('if the backup cannot be written, nothing is migrated (the old settings are the only copy)', (t) => {
  const failing = { ...fs, writeFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  const { env, config } = setup(t, makeV1Fixture(), { fs: failing });
  const before = env.readText();
  const result = config.migrateLegacy();
  assert.equal(result.migrated, false);
  assert.equal(result.error.code, 'EACCES');
  assert.equal(env.readText(), before);
  assert.equal(env.stats.writes, 0);
});

test('an existing backup is never overwritten (it is the pristine v1 file)', (t) => {
  const { env } = setup(t, makeV1Fixture());
  fs.writeFileSync(path.join(env.dir, BACKUP_FILE_NAME), 'pristine v1 backup');
  const config = createConfig({ Store: env.Store, log: createRecordingLog(), defaults: DEFAULTS });
  assert.equal(config.migrateLegacy().backedUp, false);
  assert.equal(fs.readFileSync(path.join(env.dir, BACKUP_FILE_NAME), 'utf8'), 'pristine v1 backup');
});

test('a settings file that cannot be read is reported, not thrown', (t) => {
  const { env, config } = setup(t, makeV1Fixture());
  env.failReads(new Error('EIO: i/o error'));
  const result = config.migrateLegacy();
  assert.equal(result.migrated, false);
  assert.match(result.error.message, /EIO/);
  assert.equal(env.stats.writes, 0);
});

test('migrateLegacy never throws, whatever goes wrong', (t) => {
  const exploding = { ...password, validatePasswordPolicy: () => { throw new TypeError('policy exploded'); } };
  const { config } = setup(t, makeV1Fixture(), { password: exploding });
  assert.doesNotThrow(() => config.migrateLegacy());
  assert.equal(config.migrateLegacy().migrated, false);
});

// ---------------------------------------------------------------------------------------------
// A retry must never undo what the user did in between
// ---------------------------------------------------------------------------------------------

test('a retry keeps printers and the password that already exist in the new format, and still removes the plain password', (t) => {
  const newerRecord = password.hashPassword('newer-password');
  const { config, result, file } = migrate(t, {
    printerName: 'OldReceipt',
    labelPrinterName: 'OldLabel',
    password: 'oldpass',
    a4PrinterName: 'x',
    printers: { receipt: { transport: 'system', printerName: 'ChosenLater', port: '' } },
    drawer: { passwordRecord: newerRecord, passwordWeak: false },
  });
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: false, label: true, password: 'kept' });
  assert.equal(config.get('printers.receipt.printerName'), 'ChosenLater', 'not overwritten by the legacy value');
  assert.equal(config.get('printers.label.printerName'), 'OldLabel', 'what is missing IS migrated');
  assert.equal(password.verifyPassword('newer-password', config.get('drawer.passwordRecord')), true);
  assert.equal(password.verifyPassword('oldpass', config.get('drawer.passwordRecord')), false, 'the old password does not come back');
  assert.equal('password' in file, false);
  assert.equal('a4PrinterName' in file, false);
});

test('an earlier attempt that saved the record but not schemaVersion: the retry keeps the record and the weak flag', (t) => {
  const record = password.hashPassword('123');
  const { config, result, file } = migrate(t, { password: '123', drawer: { passwordRecord: record, passwordWeak: true } });
  assert.equal(result.password, 'kept');
  assert.deepEqual(file.drawer, { passwordRecord: record, passwordWeak: true });
  assert.equal(config.get('drawer.passwordWeak'), true);
  assert.equal(password.verifyPassword('123', config.get('drawer.passwordRecord')), true);
});

test('an object where printers or drawer should be is replaced by a proper one, not trusted', (t) => {
  const { config, file } = migrate(t, { printerName: 'A', password: 'abcd', printers: 'oops', drawer: 7 });
  assert.deepEqual(file.printers, { receipt: { transport: 'system', printerName: 'A', port: '' } });
  assert.equal(password.verifyPassword('abcd', config.get('drawer.passwordRecord')), true);
  assert.equal(config.get('drawer.pin'), 2);
});

// ---------------------------------------------------------------------------------------------
// The SPEC trap
// ---------------------------------------------------------------------------------------------

test('the Store never sees `defaults`, so a v1 file is not stamped schema 2 by the constructor before the migration runs', (t) => {
  const { env, config } = setup(t, makeV1Fixture());
  assert.deepEqual(env.stats.constructed, [{ configFileMode: 0o600 }]);
  assert.equal(env.readRaw().schemaVersion, undefined, 'still a v1 file after createConfig');
  assert.equal(config.migrateLegacy().migrated, true, 'so the migration still runs');
  assert.equal(password.verifyPassword('4321', config.get('drawer.passwordRecord')), true);
});
