'use strict';

/**
 * config.js against the REAL electron-store 10 / conf 13 (it imports under plain Node when given an explicit `cwd`),
 * not the fake: the v1.6.1 fixture of SPEC 16 through the real createConfig with the full v2 defaults, a second start,
 * a file that is already migrated, damaged files, and the live behaviour of the setters and notifications.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfig, DEFAULTS, BACKUP_FILE_NAME } = require('../../src/main/config');
const password = require('../../src/main/password');
const { createRecordingLog, makeV1Fixture } = require('../helpers/fake-store');

const WINDOWS = process.platform === 'win32';

/** A real-store config over a fresh temp folder. `file` is written to config.json first when given. */
async function setup(t, file, deps = {}) {
  const { default: ElectronStore } = await import('electron-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-real-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  if (file !== undefined) fs.writeFileSync(configFile, typeof file === 'string' ? file : JSON.stringify(file, undefined, '\t'));

  class DirStore extends ElectronStore {
    constructor(options) {
      super({ ...options, cwd: dir });
    }
  }
  const log = createRecordingLog();
  const open = () => createConfig({ Store: DirStore, log, defaults: DEFAULTS, ...deps });
  return { dir, configFile, log, open, config: open() };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the real store: a v1.6.1 file survives createConfig untouched, then migrates every key', async (t) => {
  const original = makeV1Fixture();
  const text = JSON.stringify(original, undefined, '\t');
  const { dir, configFile, config } = await setup(t, text);
  assert.equal(fs.readFileSync(configFile, 'utf8'), text, 'conf did not stamp the file when the config opened it');
  assert.equal(readJson(configFile).schemaVersion, undefined);

  const result = config.migrateLegacy();
  assert.deepEqual(result, { migrated: true, fromV1: true, backedUp: true, receipt: true, label: true, password: 'migrated' });

  assert.deepEqual(config.get('printers.receipt'), { transport: 'port', printerName: original.printerName, port: original.printerPort });
  assert.deepEqual(config.get('printers.label'), { transport: 'port', printerName: original.labelPrinterName, port: original.labelPrinterPort });
  assert.equal(password.verifyPassword(original.password, config.get('drawer.passwordRecord')), true);

  const file = readJson(configFile);
  assert.equal(file.schemaVersion, 2);
  assert.equal('password' in file, false);
  assert.equal('a4PrinterName' in file, false);
  for (const key of ['printerName', 'printerPort', 'labelPrinterName', 'labelPrinterPort']) assert.equal(file[key], original[key], key);
  const { password: _omitted, ...withoutPassword } = original;
  assert.deepEqual(readJson(path.join(dir, BACKUP_FILE_NAME)), withoutPassword);
});

test('the real store: files are private (0600), the config and its backup', { skip: WINDOWS && 'POSIX file modes only' }, async (t) => {
  const { dir, configFile, config } = await setup(t, makeV1Fixture());
  config.migrateLegacy();
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, BACKUP_FILE_NAME)).mode & 0o777, 0o600);
  config.set('window.zoomLevel', 1);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'also after later writes');
});

test('the real store: a second start changes nothing, not even the modification time', async (t) => {
  const { configFile, open, config } = await setup(t, makeV1Fixture());
  config.migrateLegacy();
  const before = fs.readFileSync(configFile, 'utf8');
  const mtime = fs.statSync(configFile).mtimeMs;

  const second = open();
  assert.deepEqual(second.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(fs.statSync(configFile).mtimeMs, mtime);
  assert.deepEqual(second.get('printers.receipt'), config.get('printers.receipt'));
});

test('the real store: a file already at schemaVersion 2 is untouched', async (t) => {
  const text = JSON.stringify({ schemaVersion: 2, printerName: 'legacy-looking key', serverUrl: 'https://pos.example.com/' }, undefined, '\t');
  const { configFile, config } = await setup(t, text);
  assert.deepEqual(config.migrateLegacy(), { migrated: false, reason: 'current' });
  assert.equal(fs.readFileSync(configFile, 'utf8'), text);
  assert.equal(config.get('serverUrl'), 'https://pos.example.com/');
});

test('the real store: a fresh install gets only schemaVersion and the defaults show through', async (t) => {
  const { dir, configFile, config } = await setup(t);
  assert.equal(fs.existsSync(configFile), false);
  assert.deepEqual(config.all(), DEFAULTS);
  assert.equal(config.migrateLegacy().fromV1, false);
  assert.deepEqual(readJson(configFile), { schemaVersion: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('the real store: a corrupt file is renamed and the app starts from the defaults', async (t) => {
  const { dir, config } = await setup(t, '{ "printerName": "EPSON", broken', { now: () => Date.UTC(2026, 10, 19, 14, 55, 7, 123) });
  assert.deepEqual(config.all(), DEFAULTS);
  assert.deepEqual(fs.readdirSync(dir), ['config.corrupt-2026-11-19T14-55-07-123Z.json']);
  assert.equal(config.set('window.zoomLevel', 2).ok, true);
  assert.deepEqual(readJson(path.join(dir, 'config.json')), { window: { zoomLevel: 2 } });
});

test('the real store: an empty (0-byte) file is renamed too, and the migration then runs', async (t) => {
  const { dir, config } = await setup(t, '');
  assert.deepEqual(config.all(), DEFAULTS);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('config.corrupt-')).length, 1);
  assert.equal(config.migrateLegacy().migrated, true);
  assert.deepEqual(readJson(path.join(dir, 'config.json')), { schemaVersion: 2 });
});

test('the real store: set(path, undefined) deletes, nested defaults resolve through get, writes are one change event each', async (t) => {
  const { configFile, config } = await setup(t);
  const changes = [];
  config.onDidChange((next, old) => changes.push([next.window.zoomLevel, old.window.zoomLevel]));
  assert.equal(config.get('printers.receipt.transport'), 'system');
  assert.equal(config.set('window.zoomLevel', 2).ok, true);
  assert.equal(config.set('window.zoomLevel', undefined).ok, true);
  assert.equal('zoomLevel' in readJson(configFile).window, false);
  assert.equal(config.get('window.zoomLevel'), 0);
  assert.deepEqual(changes, [[2, 0], [0, 2]]);

  assert.equal(config.setConnection({ serverUrl: 'https://pos.example.com', extraAllowedOrigins: ['*.example.com'] }).ok, true);
  assert.equal(config.setDrawer({ pin: 5, onTimeMs: 100 }).ok, true);
  assert.equal(config.setGeneral({ openAtLogin: true }).ok, true);
  assert.equal(config.setWindowState({ fullScreen: true }).ok, true);
  assert.deepEqual(config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON' }), { ok: true });
  const file = readJson(configFile);
  assert.equal(file.serverUrl, 'https://pos.example.com/');
  assert.deepEqual(file.drawer, { pin: 5, onTimeMs: 100 });
  assert.deepEqual(file.startup, { openAtLogin: true });
  assert.equal(file.window.fullScreen, true);
});

test('the real store: reset() clears everything, the password included', async (t) => {
  const { configFile, config } = await setup(t, makeV1Fixture());
  config.migrateLegacy();
  assert.equal(config.publicState().drawer.passwordSet, true);
  assert.deepEqual(config.reset(), { ok: true });
  assert.deepEqual(readJson(configFile), {});
  assert.deepEqual(config.all(), DEFAULTS);
  assert.equal(config.publicState().drawer.passwordSet, false);
});

test('the real store: a failing migration leaves the v1 file exactly as it was', async (t) => {
  const failing = { ...password, hashPassword: () => { throw new Error('scrypt exploded'); } };
  const text = JSON.stringify(makeV1Fixture(), undefined, '\t');
  const { dir, configFile, config } = await setup(t, text, { password: failing });
  const result = config.migrateLegacy();
  assert.equal(result.migrated, false);
  assert.match(result.error.message, /scrypt exploded/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), text);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});
