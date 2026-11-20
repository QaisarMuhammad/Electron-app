'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runPreload, reachableValues, PRELOAD_DIR } = require('./harness');
const { VERSION_ARG_PREFIX } = require('../../src/main/windows/main');

const SETTINGS_URL = 'file:///app/src/renderer/settings.html?tab=printers';
const PASSWORD_URL = 'file:///app/src/renderer/password.html?purpose=drawer';
const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale';

const local = (options) => runPreload('local.js', { url: SETTINGS_URL, ...options });

/** window.desktop.settings of SPEC 6.2, as [function name, channel, arguments to pass]. */
const SETTINGS_CALLS = [
  ['getState', 'desktop:settings:getState', []],
  ['listPrinters', 'desktop:settings:listPrinters', []],
  ['savePrinter', 'desktop:settings:savePrinter', ['receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' }]],
  ['testPrint', 'desktop:settings:testPrint', ['label', { kind: 'zebra' }]],
  ['setDrawerPassword', 'desktop:settings:setDrawerPassword', [{ current: 'old1', next: 'new2' }]],
  ['saveDrawerSettings', 'desktop:settings:saveDrawerSettings', [{ enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, requirePasswordForSettings: false, password: 'pw' }]],
  ['openDrawerTest', 'desktop:settings:openDrawerTest', [{ password: 'pw' }]],
  ['saveConnection', 'desktop:settings:saveConnection', [{ serverUrl: 'https://shop.example.com', extraAllowedOrigins: [], password: 'pw' }]],
  ['setGeneral', 'desktop:settings:setGeneral', [{ openAtLogin: true, startFullScreen: false, keepAwake: true }]],
  ['setPerformance', 'desktop:settings:setPerformance', [{ hardwareAcceleration: false }]],
  ['restartApp', 'desktop:settings:restartApp', []],
  ['checkForUpdates', 'desktop:settings:checkForUpdates', []],
  ['installUpdate', 'desktop:settings:installUpdate', []],
  ['openLogsFolder', 'desktop:settings:openLogsFolder', []],
  ['copyDiagnostics', 'desktop:settings:copyDiagnostics', []],
  ['resetAll', 'desktop:settings:resetAll', [{ password: 'pw' }]],
];

test('a file: page gets the full window.desktop of SPEC 6.2 and nothing else', () => {
  const { exposed, ipc } = local();
  assert.deepEqual(Object.keys(exposed), ['desktop']);
  const { desktop } = exposed;
  assert.deepEqual(Object.keys(desktop).sort(), ['connection', 'password', 'platform', 'settings', 'version', 'window']);
  assert.deepEqual(
    Object.keys(desktop.settings).sort(),
    [...SETTINGS_CALLS.map(([name]) => name), 'onState'].sort(),
  );
  assert.deepEqual(Object.keys(desktop.connection).sort(), ['getStatus', 'onStatus', 'openSettings', 'retryNow']);
  assert.deepEqual(Object.keys(desktop.password).sort(), ['cancel', 'getLockout', 'onLockout', 'submit']);
  assert.deepEqual(Object.keys(desktop.window), ['close']);
  for (const group of ['settings', 'connection', 'password', 'window']) {
    for (const [name, value] of Object.entries(desktop[group])) assert.equal(typeof value, 'function', `${group}.${name}`);
  }
  assert.equal(ipc.syncs.length, 0, 'no synchronous question to the main process');
});

test('on any page that is not a file: page it exposes nothing', () => {
  for (const url of [POS_URL, 'about:blank', 'data:text/html,hi', 'https://evil.example.com/']) {
    const { exposed, ipc } = local({ url });
    assert.deepEqual(exposed, {}, url);
    assert.equal(ipc.listeners.size, 0, url);
  }
});

test('ipcRenderer is never reachable from window.desktop', () => {
  const { exposed, ipc } = local();
  const reachable = reachableValues(exposed);
  assert.equal(reachable.has(ipc), false);
  for (const name of ['send', 'invoke', 'sendSync', 'on', 'removeListener']) assert.equal(reachable.has(ipc[name]), false, name);
});

test('it loads nothing but electron', () => {
  assert.deepEqual([...new Set(local().required)], ['electron']);
});

test('every settings call invokes desktop:settings:<name> with its arguments forwarded as given', async () => {
  const { exposed, ipc } = local({ invokeHandler: (channel) => ({ ok: true, channel }) });
  for (const [name, channel, args] of SETTINGS_CALLS) {
    ipc.invoked.length = 0;
    const result = await exposed.desktop.settings[name](...args);
    assert.deepEqual(result, { ok: true, channel }, name);
    assert.deepEqual(ipc.invoked, [{ channel, args }], name);
  }
});

test('the connection, password and window calls use their channels', async () => {
  const { exposed, ipc } = local({ url: PASSWORD_URL, invokeHandler: (channel) => ({ channel }) });
  const { connection, password, window } = exposed.desktop;
  await connection.getStatus();
  await connection.retryNow();
  await connection.openSettings();
  await password.submit('s3cret pass');
  await password.cancel();
  await password.getLockout();
  await window.close();
  assert.deepEqual(ipc.invoked, [
    { channel: 'desktop:connection:getStatus', args: [] },
    { channel: 'desktop:connection:retryNow', args: [] },
    { channel: 'desktop:connection:openSettings', args: [undefined] },
    { channel: 'desktop:password:submit', args: ['s3cret pass'] },
    { channel: 'desktop:password:cancel', args: [] },
    { channel: 'desktop:password:getLockout', args: [] },
    { channel: 'desktop:window:close', args: [] },
  ]);
});

test('connection.openSettings forwards a tab id and nothing else', async () => {
  const { exposed, ipc } = local();
  await exposed.desktop.connection.openSettings('about');
  await exposed.desktop.connection.openSettings({ tab: 'about' });
  assert.deepEqual(ipc.invoked.map((call) => call.args), [['about'], [undefined]]);
});

test('extra arguments the page passes are not forwarded', async () => {
  const { exposed, ipc } = local();
  await exposed.desktop.settings.restartApp('extra', { evil: true });
  await exposed.desktop.password.submit('pw', 'second');
  assert.deepEqual(ipc.invoked.map((call) => call.args), [[], ['pw']]);
});

test('every subscription is wired to its push channel, delivers the payload only, and returns an unsubscribe function', () => {
  const { exposed, ipc } = local();
  const { desktop } = exposed;
  const subscriptions = [
    ['settings.onState', desktop.settings.onState, 'desktop:state'],
    ['connection.onStatus', desktop.connection.onStatus, 'desktop:connection:status'],
    ['password.onLockout', desktop.password.onLockout, 'desktop:password:lockout'],
  ];
  for (const [label, subscribe, channel] of subscriptions) {
    const seen = [];
    const unsubscribe = subscribe((payload) => seen.push(payload));
    assert.equal(typeof unsubscribe, 'function', label);
    assert.equal(ipc.listenerCount(channel), 1, label);

    ipc.emitFromMain(channel, { n: 1 });
    assert.deepEqual(seen, [{ n: 1 }], `${label} gets the payload, not the IPC event`);

    unsubscribe();
    unsubscribe();
    assert.equal(ipc.listenerCount(channel), 0, `${label} unsubscribed`);
    ipc.emitFromMain(channel, { n: 2 });
    assert.equal(seen.length, 1, label);

    assert.throws(() => subscribe('not a function'), TypeError, label);
    assert.throws(() => subscribe(), TypeError, label);
  }
});

test('two subscribers on one channel are independent', () => {
  const { exposed, ipc } = local();
  const a = [];
  const b = [];
  const offA = exposed.desktop.settings.onState((payload) => a.push(payload));
  exposed.desktop.settings.onState((payload) => b.push(payload));
  ipc.emitFromMain('desktop:state', 1);
  offA();
  ipc.emitFromMain('desktop:state', 2);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 2]);
});

test('platform and version come from the process and the renderer arguments', () => {
  const { exposed } = local({ platform: 'linux', argv: ['x', '--gadgetspos-version=2.1.3'] });
  assert.equal(exposed.desktop.platform, 'linux');
  assert.equal(exposed.desktop.version, '2.1.3');
});

// -- the two preloads against each other and against the SPEC --------------------------------------------------------

const read = (file) => fs.readFileSync(path.join(PRELOAD_DIR, file), 'utf8');

function sharedBlock(source) {
  const begin = source.indexOf('// ==== BEGIN SHARED');
  const endMarker = '// ==== END SHARED ====';
  const end = source.indexOf(endMarker);
  assert.ok(begin >= 0 && end > begin, 'the shared block markers exist');
  return source.slice(begin, end + endMarker.length);
}

test('the connection and window block is identical in app.js and local.js (SPEC 6.3)', () => {
  const fromApp = sharedBlock(read('app.js'));
  const fromLocal = sharedBlock(read('local.js'));
  assert.equal(fromApp, fromLocal);
  assert.match(fromApp, /desktop:connection:getStatus/);
  assert.match(fromApp, /desktop:window:close/);
});

test('both preloads carry the version prefix that main.js puts into additionalArguments', () => {
  for (const file of ['app.js', 'local.js']) {
    assert.ok(read(file).includes(`const VERSION_ARG_PREFIX = '${VERSION_ARG_PREFIX}';`), file);
  }
});

test('preload sources follow the sandbox and security rules (SPEC 2, 12, 19)', () => {
  for (const file of ['app.js', 'local.js']) {
    const source = read(file);
    const requires = [...source.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1]);
    assert.deepEqual(requires, ["'electron'"], `${file} requires only electron`);
    for (const forbidden of ['__dirname', '__filename', 'eval(', 'new Function', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'exec(', 'execSync', 'shell: true']) {
      assert.equal(source.includes(forbidden), false, `${file} contains ${forbidden}`);
    }
    assert.doesNotMatch(source, /exposeInMainWorld\(\s*['"]ipcRenderer['"]/, `${file} never exposes ipcRenderer`);
    assert.doesNotMatch(source, /TODO|FIXME/, file);
    assert.match(source, /^'use strict';/, `${file} is strict`);
  }
});

test('the local preload checks for a file: page before it touches anything', () => {
  const source = read('local.js');
  assert.ok(source.indexOf("location.protocol !== 'file:'") < source.indexOf('exposeInMainWorld'));
});
