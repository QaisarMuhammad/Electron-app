'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createConfig, DEFAULTS, SCHEMA_VERSION, LEGACY_KEYS } = require('../../src/main/config');
const { createFakeStoreEnv, createRecordingLog, makeV1Fixture } = require('../helpers/fake-store');

/** A config over a fake Store in a fresh temp folder. `file` is written to config.json first when given. */
function setup(t, file, deps = {}) {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  if (file !== undefined) env.writeRaw(file);
  const log = createRecordingLog();
  const config = createConfig({ Store: env.Store, log, ...deps });
  return { env, log, config };
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

test('createConfig needs the Store class', () => {
  assert.throws(() => createConfig({}), TypeError);
  assert.throws(() => createConfig({ Store: 'electron-store' }), TypeError);
  assert.throws(() => createConfig(), TypeError);
});

test('the Store is built with the file mode and NOTHING else: no defaults, no schemaVersion (SPEC 5.2 and 8)', (t) => {
  const { env } = setup(t);
  assert.deepEqual(env.stats.constructed, [{ configFileMode: 0o600 }]);
});

test('constructing the config does not touch a v1 file: it still has no schemaVersion and is byte for byte as v1 left it', (t) => {
  const text = JSON.stringify(makeV1Fixture(), undefined, '\t');
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  env.writeRaw(text);
  const writesBefore = env.stats.writes;
  createConfig({ Store: env.Store, log: createRecordingLog() });
  assert.equal(env.readText(), text);
  assert.equal(env.stats.writes, writesBefore);
  assert.equal(env.readRaw().schemaVersion, undefined);
});

test('a fresh install creates no file until something is saved', (t) => {
  const { env, config } = setup(t);
  config.get('serverUrl');
  config.all();
  config.publicState();
  assert.equal(env.exists('config.json'), false);
});

test('works without a logger, and with a logger that lacks some methods', (t) => {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  const config = createConfig({ Store: env.Store });
  assert.equal(config.set('window.zoomLevel', 1).ok, true);
  const partial = createConfig({ Store: env.Store, log: { info() {} } });
  assert.equal(partial.migrateLegacy().migrated, true);
});

test('a logger without an error method is fine: a failure is reported in the Result and nothing throws', (t) => {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  const config = createConfig({ Store: env.Store, log: { info() {} } });
  const result = config.set('custom.fn', () => {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
});

test('whatever a failing disk throws (even something that is not an Error) is reported and logged as text', (t) => {
  const { env, log, config } = setup(t);
  env.failWrite(1, 'plain string failure');
  assert.equal(config.set('window.zoomLevel', 1).ok, false);
  assert.match(log.text(), /plain string failure/);
  env.failWrite(1, { code: 'EIO' });
  assert.equal(config.set('window.zoomLevel', 1).ok, false);
});

test('exposes the file path', (t) => {
  const { env, config } = setup(t);
  assert.equal(config.path, env.file);
});

// ---------------------------------------------------------------------------------------------
// Defaults and get()
// ---------------------------------------------------------------------------------------------

test('an empty store reads as exactly the schema v2 defaults (no schemaVersion: only the migration writes it)', (t) => {
  const { config } = setup(t);
  assert.deepEqual(config.all(), DEFAULTS);
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal('schemaVersion' in config.all(), false);
});

test('the defaults of SPEC 5.1 and 18b, one by one', (t) => {
  const { config } = setup(t);
  const expected = {
    serverUrl: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy',
    extraAllowedOrigins: [],
    'printers.receipt': { transport: 'system', printerName: '', port: '' },
    'printers.label': { transport: 'system', printerName: '', port: '' },
    'printers.dymo': { printerName: '' },
    'drawer.enabled': true,
    'drawer.pin': 2,
    'drawer.onTimeMs': 50,
    'drawer.offTimeMs': 510,
    'drawer.passwordRecord': null,
    'drawer.passwordWeak': false,
    'drawer.requirePasswordForSettings': false,
    'window.bounds': null,
    'window.maximized': false,
    'window.zoomLevel': 0,
    'window.fullScreen': false, // 18b D2
    'window.startFullScreen': false, // 18b D2
    'updates.autoDownload': true,
    'startup.openAtLogin': false, // 18b D3
    'power.keepAwake': true, // 18b R2
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(config.get(key), value, key);
});

test('the exported DEFAULTS are frozen all the way down, so nothing can change them by accident', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.printers.receipt));
  assert.ok(Object.isFrozen(DEFAULTS.extraAllowedOrigins));
});

test('stored values win, per path, and nested defaults fill what the stored object lacks (conf does not do this)', (t) => {
  const { config } = setup(t, { drawer: { enabled: false }, printers: { receipt: { transport: 'port', port: 'LPT1' } }, window: { maximized: true } });
  assert.equal(config.get('drawer.enabled'), false);
  assert.equal(config.get('drawer.pin'), 2, 'default for a key that is not stored');
  assert.equal(config.get('drawer.onTimeMs'), 50);
  assert.deepEqual(config.get('printers.receipt'), { transport: 'port', printerName: '', port: 'LPT1' });
  assert.deepEqual(config.get('printers.label'), { transport: 'system', printerName: '', port: '' });
  assert.equal(config.get('window.maximized'), true);
  assert.equal(config.get('window.zoomLevel'), 0);
  assert.equal(config.get('window.fullScreen'), false);
});

test('a stored null stays null where the default is free-form, and unknown stored keys are kept', (t) => {
  const { config } = setup(t, { window: { bounds: { x: 1, y: 2, width: 800, height: 600 } }, custom: { thing: 7 } });
  assert.deepEqual(config.get('window.bounds'), { x: 1, y: 2, width: 800, height: 600 });
  assert.equal(config.get('custom.thing'), 7);
});

test('unknown keys inside a known setting are kept too (a newer app may have added them)', (t) => {
  const { config } = setup(t, { drawer: { pin: 5, futureOption: 'keep me' }, printers: { receipt: { transport: 'port', port: 'LPT1', note: 7 } } });
  assert.equal(config.get('drawer.futureOption'), 'keep me');
  assert.equal(config.get('drawer.pin'), 5);
  assert.deepEqual(config.get('printers.receipt'), { transport: 'port', printerName: '', port: 'LPT1', note: 7 });
});

test('get falls back to the given value for unknown or unusable paths', (t) => {
  const { config } = setup(t);
  assert.equal(config.get('nope'), undefined);
  assert.equal(config.get('nope', 'fallback'), 'fallback');
  assert.equal(config.get('printers.nope.deeper', 7), 7);
  assert.equal(config.get('printers.receipt.nope', 'x'), 'x');
  assert.equal(config.get('drawer.pin', 99), 2, 'a known setting never uses the fallback');
  for (const bad of ['', 5, null, undefined, {}, [], 'a..b', '.a', 'a.', '__proto__.polluted', 'printers.__proto__', 'constructor.name', 'toString']) {
    assert.equal(config.get(bad, 'fb'), 'fb', String(bad));
  }
  assert.equal({}.polluted, undefined);
});

test('something stored with the wrong type (a hand-edited file) reads as the default, so callers always get the right shape', (t) => {
  const { config } = setup(t, {
    serverUrl: 123,
    extraAllowedOrigins: 'https://shop.example.com',
    drawer: 'oops',
    printers: { receipt: 5, label: { transport: 7, printerName: ['x'], port: null } },
    window: { zoomLevel: 'big', maximized: 'yes' },
    updates: null,
    power: { keepAwake: 1 },
  });
  assert.equal(config.get('serverUrl'), DEFAULTS.serverUrl);
  assert.deepEqual(config.get('extraAllowedOrigins'), []);
  assert.equal(config.get('drawer.pin'), 2);
  assert.deepEqual(config.get('drawer'), DEFAULTS.drawer);
  assert.deepEqual(config.get('printers.receipt'), DEFAULTS.printers.receipt);
  assert.deepEqual(config.get('printers.label'), DEFAULTS.printers.label);
  assert.equal(config.get('window.zoomLevel'), 0);
  assert.equal(config.get('window.maximized'), false);
  assert.equal(config.get('updates.autoDownload'), true);
  assert.equal(config.get('power.keepAwake'), true);
});

test('the legacy v1 keys are invisible to get(), all() and publicState(): the plain password can never leak', (t) => {
  const { config } = setup(t, makeV1Fixture({ password: 'secret-plain-1234', printerBrand: 'epson', a4Password: 'a4secret' }));
  for (const key of LEGACY_KEYS) assert.equal(config.get(key, 'hidden'), 'hidden', key);
  for (const view of [config.all(), config.publicState()]) {
    for (const key of LEGACY_KEYS) assert.equal(key in view, false, key);
    assert.ok(!JSON.stringify(view).includes('secret-plain-1234'));
    assert.ok(!JSON.stringify(view).includes('a4secret'));
  }
});

test('a __proto__ key inside a known setting is ignored and cannot pollute anything', (t) => {
  const { config } = setup(t, '{"drawer": {"__proto__": {"polluted": true}, "pin": 5}, "printers": {"constructor": {"x": 1}, "receipt": {"printerName": "A"}}}');
  assert.equal(config.get('drawer.pin'), 5);
  assert.equal(config.get('printers.receipt.printerName'), 'A');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(config.all().drawer, '__proto__'), false);
  assert.equal(Object.hasOwn(config.all().printers, 'constructor'), false);
});

test('custom defaults are honoured, and publicState() still reports the password state when they have no drawer section', (t) => {
  const { config } = setup(t, { extra: 1 }, { defaults: { serverUrl: 'https://custom.example.com/', mode: { debug: false } } });
  assert.equal(config.get('serverUrl'), 'https://custom.example.com/');
  assert.equal(config.get('mode.debug'), false);
  assert.equal(config.get('extra'), 1);
  assert.deepEqual(config.publicState(), { serverUrl: 'https://custom.example.com/', mode: { debug: false }, extra: 1, drawer: { passwordSet: false } });
});

test('get returns copies: changing what it returns changes nothing', (t) => {
  const { config } = setup(t, { printers: { receipt: { transport: 'system', printerName: 'A', port: '' } }, extraAllowedOrigins: ['https://a.example.com'] });
  const receipt = config.get('printers.receipt');
  receipt.printerName = 'changed';
  config.get('extraAllowedOrigins').push('https://evil.example.com');
  config.all().printers.receipt.printerName = 'changed too';
  config.publicState().printers.receipt.printerName = 'and this';
  assert.equal(config.get('printers.receipt.printerName'), 'A');
  assert.deepEqual(config.get('extraAllowedOrigins'), ['https://a.example.com']);
  assert.equal(DEFAULTS.printers.receipt.printerName, '');
});

// ---------------------------------------------------------------------------------------------
// The in-memory snapshot
// ---------------------------------------------------------------------------------------------

test('reads come from the in-memory snapshot: no file access after construction, however often anything is read', (t) => {
  const { env, config } = setup(t, makeV1Fixture());
  const reads = env.stats.reads;
  for (let i = 0; i < 200; i += 1) {
    config.get('serverUrl');
    config.get('printers.receipt.port');
    config.all();
    config.publicState();
  }
  assert.equal(env.stats.reads, reads);
});

test('after a write the snapshot is refreshed from disk, and reads are again free', (t) => {
  const { env, config } = setup(t);
  assert.equal(config.set('window.zoomLevel', 1.5).ok, true);
  const reads = env.stats.reads;
  assert.equal(config.get('window.zoomLevel'), 1.5);
  assert.equal(config.get('window.zoomLevel'), 1.5);
  assert.equal(env.stats.reads, reads);
  assert.equal(env.readRaw().window.zoomLevel, 1.5);
});

// ---------------------------------------------------------------------------------------------
// set()
// ---------------------------------------------------------------------------------------------

test('set stores a value at a dot path, creating parents, and answers { ok: true }', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.set('window.zoomLevel', 2), { ok: true });
  assert.deepEqual(config.set('printers.receipt.port', 'LPT1'), { ok: true });
  assert.deepEqual(config.set('custom.deep.value', { a: [1, 2] }), { ok: true });
  assert.equal(config.get('window.zoomLevel'), 2);
  assert.deepEqual(config.get('printers.receipt'), { transport: 'system', printerName: '', port: 'LPT1' });
  assert.deepEqual(config.get('custom.deep.value'), { a: [1, 2] });
  assert.deepEqual(env.readRaw(), { window: { zoomLevel: 2 }, printers: { receipt: { port: 'LPT1' } }, custom: { deep: { value: { a: [1, 2] } } } });
});

test('set(path, undefined) deletes the key (conf would throw), and the default shows through again', (t) => {
  const { env, config } = setup(t);
  config.set('window.zoomLevel', 2);
  assert.deepEqual(config.set('window.zoomLevel', undefined), { ok: true });
  assert.equal(config.get('window.zoomLevel'), 0);
  assert.equal('zoomLevel' in env.readRaw().window, false);
  assert.deepEqual(config.set('never.was.there', undefined), { ok: true });
});

test('set accepts null and falsy values', (t) => {
  const { config } = setup(t);
  config.set('window.zoomLevel', 0);
  config.set('window.bounds', null);
  config.set('custom.empty', '');
  config.set('custom.no', false);
  assert.equal(config.get('window.zoomLevel'), 0);
  assert.equal(config.get('window.bounds'), null);
  assert.equal(config.get('custom.empty'), '');
  assert.equal(config.get('custom.no'), false);
});

test('set refuses names that are not usable paths, without writing anything', (t) => {
  const { env, config } = setup(t);
  const writes = env.stats.writes;
  for (const bad of ['', 5, null, undefined, {}, 'a..b', '.a', 'a.', '__proto__.x', 'a.__proto__', 'constructor.x', 'a.prototype', '__internal__', '__internal__.migrations']) {
    const result = config.set(bad, 1);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, 'INVALID_SETTINGS', String(bad));
    assert.ok(result.message.length > 0);
  }
  assert.equal(env.stats.writes, writes);
  assert.equal({}.x, undefined);
});

test('set never throws: a value JSON cannot hold, or a failing disk, comes back as a Result and is logged', (t) => {
  const { env, log, config } = setup(t);
  config.set('window.zoomLevel', 1);

  const notJson = config.set('custom.fn', () => {});
  assert.equal(notJson.ok, false);
  assert.equal(notJson.code, 'UNKNOWN');

  env.failWrite(1, new Error('ENOSPC: no space left on device'));
  const full = config.set('window.zoomLevel', 3);
  assert.equal(full.ok, false);
  assert.equal(full.code, 'UNKNOWN');
  assert.match(full.message, /could not be saved/i);
  assert.equal(config.get('window.zoomLevel'), 1, 'the snapshot still shows what is on disk');
  assert.equal(env.readRaw().window.zoomLevel, 1);
  assert.ok(log.entries.some((e) => e.level === 'error' && /ENOSPC/.test(log.text())), 'the cause is logged');

  assert.equal(config.set('window.zoomLevel', 3).ok, true, 'and the next write works');
  assert.equal(config.get('window.zoomLevel'), 3);
});

// ---------------------------------------------------------------------------------------------
// all() and publicState()
// ---------------------------------------------------------------------------------------------

test('all() is the full effective config, including the password record (main process only)', (t) => {
  const { config } = setup(t);
  const record = { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: 'AAAA', hash: 'BBBB' };
  config.setPasswordRecord(record);
  config.set('custom.thing', 1);
  const all = config.all();
  assert.deepEqual(all.drawer.passwordRecord, record);
  assert.equal(all.custom.thing, 1);
  assert.equal(all.serverUrl, DEFAULTS.serverUrl);
});

test('publicState() has no passwordRecord and says whether a password is set', (t) => {
  const { config } = setup(t);
  const before = config.publicState();
  assert.equal('passwordRecord' in before.drawer, false);
  assert.equal(before.drawer.passwordSet, false);

  config.setPasswordRecord({ algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', hash: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=' });
  const after = config.publicState();
  assert.equal(after.drawer.passwordSet, true);
  assert.equal('passwordRecord' in after.drawer, false);
  const text = JSON.stringify(after);
  assert.ok(!text.includes('c2FsdHNhbHRz') && !text.includes('aGFzaGhh'), 'neither salt nor hash');
  assert.deepEqual(Object.keys(after.drawer).sort(), ['enabled', 'offTimeMs', 'onTimeMs', 'passwordSet', 'passwordWeak', 'pin', 'requirePasswordForSettings']);
  assert.equal(after.drawer.passwordWeak, false);
});

test('publicState() carries the rest of the config unchanged', (t) => {
  const { config } = setup(t);
  config.set('window.fullScreen', true);
  const state = config.publicState();
  assert.equal(state.window.fullScreen, true);
  assert.equal(state.startup.openAtLogin, false);
  assert.equal(state.power.keepAwake, true);
  assert.equal(state.serverUrl, DEFAULTS.serverUrl);
});

// ---------------------------------------------------------------------------------------------
// onDidChange
// ---------------------------------------------------------------------------------------------

test('onDidChange calls back with the new and the old config after a real change', (t) => {
  const { config } = setup(t);
  const calls = [];
  config.onDidChange((next, old) => calls.push({ next, old }));
  config.set('window.zoomLevel', 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].next.window.zoomLevel, 1);
  assert.equal(calls[0].old.window.zoomLevel, 0);
});

test('every subscriber is told about every change, and each one already sees the new values through get()', (t) => {
  const { config } = setup(t);
  const seen = { first: [], second: [] };
  config.onDidChange(() => seen.first.push(config.get('window.zoomLevel')));
  config.onDidChange(() => seen.second.push(config.get('window.zoomLevel')));
  config.set('window.zoomLevel', 1);
  config.set('window.zoomLevel', 2);
  assert.deepEqual(seen, { first: [1, 2], second: [1, 2] });
});

test('no callback when the effective config did not change, including when only a legacy key was written (the app never sees those)', (t) => {
  const { config } = setup(t, makeV1Fixture());
  let calls = 0;
  config.onDidChange(() => { calls += 1; });
  config.set('window.zoomLevel', 0); // stored, but equal to the default: the effective config is the same
  config.set('printerName', 'Renamed printer'); // a legacy v1 key
  assert.equal(calls, 0);
  config.set('window.zoomLevel', 1);
  assert.equal(calls, 1);
});

test('the callbacks get copies of the config, and never the raw store (which carries the plain v1 password)', (t) => {
  const { config } = setup(t, makeV1Fixture({ password: 'secret-plain-1234' }));
  let received;
  config.onDidChange((next, old) => { received = { next, old }; });
  config.set('window.zoomLevel', 1);
  assert.ok(!JSON.stringify(received).includes('secret-plain-1234'));
  received.next.window.zoomLevel = 99;
  assert.equal(config.get('window.zoomLevel'), 1);
});

test('the function returned by onDidChange unsubscribes', (t) => {
  const { config } = setup(t);
  let calls = 0;
  const off = config.onDidChange(() => { calls += 1; });
  config.set('window.zoomLevel', 1);
  off();
  off();
  config.set('window.zoomLevel', 2);
  assert.equal(calls, 1);
});

test('a subscriber that throws is logged and does not stop the others or the write', (t) => {
  const { log, config } = setup(t);
  let second = 0;
  config.onDidChange(() => { throw new Error('listener exploded'); });
  config.onDidChange(() => { second += 1; });
  assert.equal(config.set('window.zoomLevel', 1).ok, true);
  assert.equal(second, 1);
  assert.ok(log.entries.some((e) => e.level === 'error' && /listener exploded/.test(log.text())));
});

test('onDidChange needs a function', (t) => {
  const { config } = setup(t);
  assert.throws(() => config.onDidChange('x'), TypeError);
  assert.throws(() => config.onDidChange(), TypeError);
});

// ---------------------------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------------------------

test('reset() erases everything: settings, window state and the password; the defaults show again', (t) => {
  const { env, config } = setup(t);
  config.setPasswordRecord({ algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: 'AAAA', hash: 'BBBB' });
  config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON' });
  config.setConnection({ serverUrl: 'https://pos.example.com/', extraAllowedOrigins: ['*.example.com'] });
  config.setDrawer({ pin: 5 });
  config.setWindowState({ maximized: true, fullScreen: true });
  assert.deepEqual(config.reset(), { ok: true });
  assert.deepEqual(config.all(), DEFAULTS);
  assert.equal(config.publicState().drawer.passwordSet, false);
  assert.deepEqual(env.readRaw(), {});
});

test('reset() also removes the legacy v1 keys, and notifies subscribers once', (t) => {
  const { env, config } = setup(t, makeV1Fixture());
  let calls = 0;
  config.onDidChange(() => { calls += 1; });
  config.set('window.zoomLevel', 1);
  config.reset();
  assert.deepEqual(env.readRaw(), {});
  assert.equal(calls, 2);
});

test('reset() reports a failing disk as a Result', (t) => {
  const { env, config } = setup(t);
  config.set('window.zoomLevel', 2);
  env.failWrite(1);
  const result = config.reset();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(config.get('window.zoomLevel'), 2, 'nothing was erased');
});

// ---------------------------------------------------------------------------------------------
// A damaged settings file
// ---------------------------------------------------------------------------------------------

test('a corrupt config.json is renamed to config.corrupt-<timestamp>.json and the app starts from the defaults', (t) => {
  const { env, log, config } = setup(t, '{ "printerName": "EPSON", broken', { now: () => Date.UTC(2026, 10, 19, 14, 55, 7, 123) });
  assert.deepEqual(config.all(), DEFAULTS);
  assert.deepEqual(env.list(), ['config.corrupt-2026-11-19T14-55-07-123Z.json']);
  assert.equal(fs.readFileSync(path.join(env.dir, 'config.corrupt-2026-11-19T14-55-07-123Z.json'), 'utf8'), '{ "printerName": "EPSON", broken', 'the damaged content is kept');
  assert.ok(log.entries.some((e) => e.level === 'error' && /damaged/.test(log.text()) && /config\.corrupt-2026-11-19T14-55-07-123Z\.json/.test(log.text())));

  assert.equal(config.set('window.zoomLevel', 1).ok, true, 'and it can save again');
  assert.deepEqual(env.readRaw(), { window: { zoomLevel: 1 } });
  assert.equal(env.list().length, 2);
});

test('an empty (0-byte) config.json is treated the same way', (t) => {
  const { env, config } = setup(t, '', { now: () => 1_700_000_000_000 });
  assert.deepEqual(config.all(), DEFAULTS);
  assert.deepEqual(env.list(), ['config.corrupt-2023-11-14T22-13-20-000Z.json']);
  assert.equal(config.migrateLegacy().migrated, true, 'the migration then runs on the empty store');
  assert.deepEqual(env.readRaw(), { schemaVersion: 2 });
});

test('the corrupt-file name falls back to the real clock when the injected one is unusable', (t) => {
  const { env } = setup(t, 'nope', { now: () => Number.NaN });
  assert.match(env.list()[0], /^config\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
});

test('if the damaged file cannot even be renamed, the app still starts and says so', (t) => {
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('EPERM: file is locked'), { code: 'EPERM' }); } };
  const { log, config } = setup(t, '{ bad', { fs: failing });
  assert.deepEqual(config.all(), DEFAULTS);
  assert.ok(log.entries.some((e) => e.level === 'error' && /could not be moved/.test(log.text()) && /EPERM/.test(log.text())));
});

test('only a damaged file is recovered: any other failure to open the store is not hidden', () => {
  class BrokenStore {
    constructor() {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
  }
  assert.throws(() => createConfig({ Store: BrokenStore, log: createRecordingLog() }), { code: 'EACCES' });
});

test('a settings file that cannot be read at all: nothing can be saved, and the last known settings stay in use', (t) => {
  const { env, log, config } = setup(t);
  config.set('window.zoomLevel', 2);
  env.failReads(new Error('EIO: i/o error'));
  const result = config.set('window.zoomLevel', 3);
  assert.equal(result.ok, false, 'conf reads the file before it writes');
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(config.get('window.zoomLevel'), 2);
  assert.ok(log.entries.some((e) => e.level === 'error' && /EIO/.test(log.text())));
  env.failReads(null);
  assert.equal(config.set('window.zoomLevel', 4).ok, true);
  assert.equal(config.get('window.zoomLevel'), 4);
});

test('a write that worked but could not be read back keeps the last snapshot until the next successful refresh', (t) => {
  const { env, log, config } = setup(t);
  config.set('window.zoomLevel', 2);
  let notified = 0;
  config.onDidChange(() => { notified += 1; });

  env.failReads(new Error('EIO: could not read back'), { skip: 1 }); // conf's own read passes, the refresh fails
  assert.equal(config.set('window.zoomLevel', 3).ok, true, 'the write itself succeeded');
  assert.equal(config.get('window.zoomLevel'), 2, 'stale, because the file could not be read back');
  assert.equal(env.readRaw().window.zoomLevel, 3);
  assert.equal(notified, 0, 'nothing is announced that is not known');
  assert.ok(log.entries.some((e) => e.level === 'error' && /last known settings/.test(log.text())));

  env.failReads(null);
  config.set('custom.x', 1);
  assert.equal(config.get('window.zoomLevel'), 3, 'the next refresh catches up');
  assert.equal(notified, 1);
});
