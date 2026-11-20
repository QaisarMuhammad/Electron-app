'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyCommandLineSwitches, createLoginItem, createPowerKeeper, createNotifier, createQuietWindowClass, DISK_CACHE_BYTES, KEEP_AWAKE_TYPE,
} = require('../../src/main/platform');

function fakeApp() {
  const app = { switches: [], gpuOff: 0, commandLine: { appendSwitch: (name, value) => app.switches.push(value === undefined ? [name] : [name, value]) } };
  app.disableHardwareAcceleration = () => { app.gpuOff += 1; };
  return app;
}

test('hardware acceleration stays ON unless compatibility mode (the GPU flag or --disable-gpu) says otherwise', () => {
  const on = fakeApp();
  applyCommandLineSwitches({ app: on, platform: 'darwin', flags: { disableBrotli: false }, gpuDisabled: false });
  assert.equal(on.gpuOff, 0);
  const off = fakeApp();
  applyCommandLineSwitches({ app: off, platform: 'darwin', flags: { disableBrotli: false }, gpuDisabled: true });
  assert.equal(off.gpuOff, 1);
});

test('the disk cache is 512 MB on every platform, and the native-occlusion switch exists only on Windows', () => {
  assert.equal(DISK_CACHE_BYTES, 536870912);
  const win = fakeApp();
  assert.deepEqual(applyCommandLineSwitches({ app: win, platform: 'win32', flags: {}, gpuDisabled: false }), ['disk-cache-size', 'disable-features']);
  assert.deepEqual(win.switches, [['disk-cache-size', '536870912'], ['disable-features', 'CalculateNativeWinOcclusion']]);
  for (const platform of ['darwin', 'linux']) {
    const other = fakeApp();
    applyCommandLineSwitches({ app: other, platform, flags: {}, gpuDisabled: false });
    assert.deepEqual(other.switches, [['disk-cache-size', '536870912']], platform);
  }
});

test('disable-brotli follows flags.json (v1 always set it), and the GPU blocklist is never overridden', () => {
  const app = fakeApp();
  applyCommandLineSwitches({ app, platform: 'win32', flags: { disableBrotli: true }, gpuDisabled: false });
  assert.ok(app.switches.some(([name]) => name === 'disable-brotli'));
  const flat = JSON.stringify(app.switches);
  assert.doesNotMatch(flat, /ignore-gpu-blocklist/);
  const none = fakeApp();
  applyCommandLineSwitches({ app: none, platform: 'win32', flags: { disableBrotli: false }, gpuDisabled: false });
  assert.ok(!none.switches.some(([name]) => name === 'disable-brotli'));
});

test('start at login: changed only when it differs, never on Linux, never for an unpackaged run', () => {
  const set = [];
  let current = false;
  const app = { getLoginItemSettings: () => ({ openAtLogin: current }), setLoginItemSettings: (settings) => { set.push(settings); current = settings.openAtLogin; } };

  assert.equal(createLoginItem({ app, platform: 'win32', isPackaged: true }).apply(true), true);
  assert.deepEqual(set, [{ openAtLogin: true }]);
  assert.equal(createLoginItem({ app, platform: 'win32', isPackaged: true }).apply(true), false, 'already on: no registry write');
  assert.equal(createLoginItem({ app, platform: 'darwin', isPackaged: true }).apply(false), true);
  assert.deepEqual(set.at(-1), { openAtLogin: false });
  assert.equal(createLoginItem({ app, platform: 'darwin', isPackaged: true }).apply('yes'), false, 'only a real true switches it on');

  set.length = 0;
  assert.equal(createLoginItem({ app, platform: 'linux', isPackaged: true }).apply(true), false);
  assert.equal(createLoginItem({ app, platform: 'win32', isPackaged: false }).apply(true), false, 'the bare Electron program is never registered');
  assert.deepEqual(set, []);
});

test('start at login survives a system that refuses', () => {
  const warned = [];
  const app = { getLoginItemSettings: () => { throw new Error('registry locked'); }, setLoginItemSettings() {} };
  assert.equal(createLoginItem({ app, platform: 'win32', isPackaged: true, log: { warn: (text) => warned.push(text) } }).apply(true), false);
  assert.match(warned[0], /registry locked/);
});

test('keep awake blocks app suspension only (not the display) and stops again', () => {
  const calls = [];
  const blocker = { start: (type) => (calls.push(['start', type]), 7), stop: (id) => calls.push(['stop', id]) };
  const power = createPowerKeeper({ powerSaveBlocker: blocker });
  assert.equal(KEEP_AWAKE_TYPE, 'prevent-app-suspension');
  assert.equal(power.sync(true), true);
  assert.equal(power.sync(true), true, 'asking again starts nothing');
  assert.equal(power.isActive(), true);
  assert.equal(power.sync(false), false);
  assert.equal(power.sync(false), false);
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
  power.sync(true);
  power.dispose();
  assert.equal(power.isActive(), false);
  assert.deepEqual(calls.at(-1), ['stop', 7]);
});

test('keep awake never throws into the caller', () => {
  const warned = [];
  const power = createPowerKeeper({ powerSaveBlocker: { start() { throw new Error('no power api'); }, stop() {} }, log: { warn: (text) => warned.push(text) } });
  assert.equal(power.sync(true), false);
  assert.match(warned[0], /no power api/);
});

test('the notice is shown when the system can, and silently skipped when it cannot', () => {
  const shown = [];
  class Notice {
    constructor(options) { this.options = options; }
    show() { shown.push(this.options); }
    static isSupported() { return true; }
  }
  createNotifier({ Notification: Notice })('Opened in your browser: example.com');
  assert.deepEqual(shown, [{ title: 'GadgetsPOS', body: 'Opened in your browser: example.com', silent: true }]);
  class Unsupported extends Notice {
    static isSupported() { return false; }
  }
  assert.doesNotThrow(() => createNotifier({ Notification: Unsupported })('x'));
  assert.equal(shown.length, 1);
  assert.doesNotThrow(() => createNotifier({})('x'));
});

test('the quiet window class shows without activating and never takes focus (SPEC 19.8)', () => {
  const calls = [];
  class Base {
    show() { calls.push('show'); }
    showInactive() { calls.push('showInactive'); }
    focus() { calls.push('focus'); }
  }
  const Quiet = createQuietWindowClass(Base);
  const window = new Quiet();
  window.show();
  window.focus();
  assert.deepEqual(calls, ['showInactive']);
  assert.ok(window instanceof Base);
});

test('the quiet window class keeps the name of the class it extends: Electron\'s fromWebContents and getAllWindows skip any other name', () => {
  class BrowserWindow {}
  const Quiet = createQuietWindowClass(BrowserWindow);
  assert.equal(Quiet.name, 'BrowserWindow');
  assert.equal(new Quiet().constructor.name, 'BrowserWindow');
});
