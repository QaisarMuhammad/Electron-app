'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerIpc, registerOriginHandler, API_VERSION, FEATURES, ORIGIN_CHANNEL, ORIGIN_CHANNEL_ALIAS } = require('../../src/main/ipc');

/** A bare ipcMain that records registrations, and stub services that record the calls they get. */
function setup({ trusted = () => true } = {}) {
  const listeners = new Map();
  const handlers = new Map();
  const ipcMain = {
    on: (channel, fn) => listeners.set(channel, fn),
    removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const checks = [];
  const security = { isTrustedSender: (event, registry, area) => { checks.push(area); return trusted(event, area); }, isAllowedOrigin: (origin) => origin === 'https://ok.example.com' };
  const calls = [];
  const spy = (name, answer = { ok: true }) => (...args) => { calls.push([name, ...args]); return answer; };
  const desktopApi = {
    getState: spy('getState', { state: true }), listPrinters: spy('listPrinters', { system: [], dymo: [] }), savePrinter: spy('savePrinter'), testPrint: spy('testPrint'),
    setDrawerPassword: spy('setDrawerPassword'), saveDrawerSettings: spy('saveDrawerSettings'), openDrawerTest: spy('openDrawerTest'),
    saveConnection: spy('saveConnection'), setGeneral: spy('setGeneral'), setPerformance: spy('setPerformance'), restartApp: spy('restartApp'),
    checkForUpdates: spy('checkForUpdates', { status: 'none' }), installUpdate: spy('installUpdate'), openLogsFolder: spy('openLogsFolder'),
    copyDiagnostics: spy('copyDiagnostics', 'text'), resetAll: spy('resetAll'),
    connection: { getStatus: spy('getStatus', { online: true }), retryNow: spy('retryNow'), networkOnline: spy('networkOnline'), openSettings: spy('openSettings') },
    password: { submit: spy('submit'), cancel: spy('cancel'), getLockout: spy('getLockout', { locked: false, retryAfterSec: 0 }) },
  };
  const printService = { printReceipt: spy('printReceipt'), printBarcode: spy('printBarcode'), openDrawer: spy('openDrawer') };
  const shown = [];
  const sent = [];
  const closed = [];
  const logs = { info() {}, warn: (m) => logs.entries.push(m), error: (m) => logs.entries.push(m), entries: [] };
  const handle = registerIpc({
    ipcMain, security, registry: new Map(), log: logs, printService, errorBoxes: { show: (...args) => shown.push(args) }, desktopApi,
    appInfo: () => ({ name: 'Gadgets POS', version: '2.0.0', platform: 'win32' }),
    closeSenderWindow: (sender) => closed.push(sender),
    settingsWindow: { send: (...args) => sent.push(args) },
  });
  return { ipcMain, listeners, handlers, checks, calls, printService, desktopApi, shown, sent, closed, logs, handle, security };
}

const event = { sender: { id: 1 }, senderFrame: { origin: 'https://ok.example.com', url: 'https://ok.example.com/x' } };

test('every handler asks the security module with the right area before it does anything', async () => {
  const { handlers, listeners, checks } = setup();
  const expected = {
    'print-receipt': 'remote', 'print-barcode': 'remote', 'open-drawer': 'remote', 'app-info': 'remote', 'list-printers': 'remote',
    'desktop:connection:getStatus': 'connection', 'desktop:connection:retryNow': 'connection', 'desktop:connection:openSettings': 'connection',
    'desktop:window:close': 'window',
    'desktop:password:submit': 'password', 'desktop:password:cancel': 'password', 'desktop:password:getLockout': 'password',
  };
  for (const [channel, area] of Object.entries(expected)) {
    checks.length = 0;
    await handlers.get(channel)(event, undefined);
    assert.deepEqual(checks, [area], channel);
  }
  const settingsChannels = [...handlers.keys()].filter((channel) => channel.startsWith('desktop:settings:'));
  assert.equal(settingsChannels.length, 16);
  for (const channel of settingsChannels) {
    checks.length = 0;
    await handlers.get(channel)(event, undefined);
    assert.deepEqual(checks, ['settings'], channel);
  }
  for (const channel of ['send-receipt-data', 'send-barcode-data', 'open-drawer-legacy']) {
    checks.length = 0;
    listeners.get(channel)(event, {});
    assert.deepEqual(checks, ['remote'], channel);
  }
});

test('an untrusted sender never reaches a service: invoke channels answer UNTRUSTED_SENDER, messages are dropped', async () => {
  const { handlers, listeners, calls, shown } = setup({ trusted: () => false });
  for (const channel of handlers.keys()) {
    const result = await handlers.get(channel)(event, 'x', 'y');
    assert.equal(result.ok, false, channel);
    assert.equal(result.code, 'UNTRUSTED_SENDER', channel);
  }
  for (const channel of ['send-receipt-data', 'send-barcode-data', 'open-drawer-legacy', 'connectivity:networkOnline', 'desktop:connection:networkOnline']) listeners.get(channel)(event, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.deepEqual(shown, []);
});

test('the arguments reach the services in order, and a non-string tab is not passed on', async () => {
  const { handlers, calls } = setup();
  await handlers.get('desktop:settings:savePrinter')(event, 'receipt', { transport: 'system' });
  await handlers.get('desktop:settings:testPrint')(event, 'label', { kind: 'zebra' });
  await handlers.get('desktop:connection:openSettings')(event, 'printers');
  await handlers.get('desktop:connection:openSettings')(event, { evil: true });
  await handlers.get('desktop:password:submit')(event, 'pw');
  await handlers.get('print-receipt')(event, { receiptFileBinary: [1] });
  assert.deepEqual(calls, [
    ['savePrinter', 'receipt', { transport: 'system' }],
    ['testPrint', 'label', { kind: 'zebra' }],
    ['openSettings', 'printers'],
    ['openSettings', undefined],
    ['submit', 'pw'],
    ['printReceipt', { receiptFileBinary: [1] }],
  ]);
});

test('the answers are data where the contract says data: state, the update status, the diagnostics text, the lockout', async () => {
  const { handlers } = setup();
  assert.deepEqual(await handlers.get('desktop:settings:getState')(event), { state: true });
  assert.deepEqual(await handlers.get('desktop:settings:checkForUpdates')(event), { status: 'none' });
  assert.equal(await handlers.get('desktop:settings:copyDiagnostics')(event), 'text');
  assert.deepEqual(await handlers.get('desktop:password:getLockout')(event), { locked: false, retryAfterSec: 0 });
  assert.deepEqual(await handlers.get('desktop:connection:getStatus')(event), { online: true });
});

test('app-info reports the api version and features without any other field of the app', async () => {
  const { handlers } = setup();
  assert.deepEqual(await handlers.get('app-info')(event), { name: 'Gadgets POS', version: '2.0.0', platform: 'win32', apiVersion: API_VERSION, features: [...FEATURES] });
  assert.equal(API_VERSION, 2);
  assert.deepEqual([...FEATURES], ['ack-print', 'drawer', 'printer-list']);
});

test('a service that throws becomes an UNKNOWN Result and a log line; a fire-and-forget failure becomes a native box', async () => {
  const { handlers, listeners, printService, desktopApi, logs, shown } = setup();
  desktopApi.getState = () => { throw new Error('boom inside'); };
  const result = await handlers.get('desktop:settings:getState')(event);
  assert.equal(result.code, 'UNKNOWN');
  assert.doesNotMatch(result.message, /boom/);
  assert.match(logs.entries.join('\n'), /desktop:settings:getState failed unexpectedly \(boom inside\)/);
  printService.printReceipt = async () => { throw new Error('printer exploded'); };
  listeners.get('send-receipt-data')(event, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.length, 1);
  assert.equal(shown[0][0].code, 'UNKNOWN');
  assert.equal(shown[0][1].kind, 'receipt');
});

test('the heading of a native box follows what failed: a drawer code on the receipt channel is a drawer box', async () => {
  const { listeners, printService, shown } = setup();
  printService.printReceipt = async () => ({ ok: false, code: 'DRAWER_PASSWORD_NOT_SET', message: 'm' });
  printService.printBarcode = async () => ({ ok: false, code: 'SPOOLER_ERROR', message: 'm' });
  printService.openDrawer = async () => ({ ok: false, code: 'DRAWER_WRONG_PASSWORD', message: 'm' });
  listeners.get('send-receipt-data')(event, {});
  listeners.get('send-barcode-data')(event, {});
  listeners.get('open-drawer-legacy')(event, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown.map(([, options]) => options.kind), ['drawer', 'label', 'drawer']);
});

// -- the network is back (RE-02) -------------------------------------------------------------------------------------

test('the network-back notices are judged by the right area (the POS page: its origin, the offline screen: the connection area) and reach the service', () => {
  const { listeners, checks, calls } = setup();
  for (const [channel, area] of [['connectivity:networkOnline', 'remote'], ['desktop:connection:networkOnline', 'connection']]) {
    checks.length = 0;
    calls.length = 0;
    assert.equal(listeners.get(channel)(event), undefined, `${channel}: nothing is answered`);
    assert.deepEqual(checks, [area], channel);
    assert.deepEqual(calls, [['networkOnline']], channel);
  }
});

test('a network-back notice from a sender that is not trusted is logged and dropped, and the service is not called', () => {
  const { listeners, calls, logs } = setup({ trusted: (_event, area) => area !== 'remote' && area !== 'connection' });
  listeners.get('connectivity:networkOnline')(event);
  listeners.get('desktop:connection:networkOnline')(event);
  assert.deepEqual(calls, []);
  assert.match(logs.entries.join('\n'), /connectivity:networkOnline refused for a sender that is not trusted/);
  assert.match(logs.entries.join('\n'), /desktop:connection:networkOnline refused/);
});

test('a service that throws on a network-back notice is logged and never thrown into Electron', () => {
  const { listeners, desktopApi, logs } = setup();
  desktopApi.connection.networkOnline = () => { throw new Error('probe exploded'); };
  assert.doesNotThrow(() => listeners.get('connectivity:networkOnline')(event));
  assert.match(logs.entries.join('\n'), /connectivity:networkOnline failed unexpectedly \(probe exploded\)/);
});

test('desktop:window:close hands the sender to the closer and answers ok', async () => {
  const { handlers, closed } = setup();
  assert.deepEqual(await handlers.get('desktop:window:close')(event), { ok: true });
  assert.equal(closed[0], event.sender);
});

test('pushes go to the Settings window', () => {
  const { handle, sent } = setup();
  handle.pushState({ online: false });
  handle.pushConnectionStatus({ online: false, attempt: 2 });
  assert.deepEqual(sent, [['desktop:state', { online: false }], ['desktop:connection:status', { online: false, attempt: 2 }]]);
});

test('dispose removes every handler it registered, and channels() lists them', () => {
  const { handle, handlers, listeners } = setup();
  assert.equal(handle.channels().on.length, 5, 'the three legacy messages and the two network-back notices');
  assert.ok(handle.channels().handle.includes('print-receipt'));
  assert.equal(handlers.size, handle.channels().handle.length);
  handle.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(listeners.size, 0);
  assert.deepEqual(handle.channels(), { on: [], handle: [] });
});

test('the origin handler always sets returnValue and can be removed; the alias answers the same', () => {
  const listeners = new Map();
  const ipcMain = { on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); } };
  const remove = registerOriginHandler({ ipcMain, security: { isAllowedOrigin: (origin) => origin === 'https://ok.example.com' } });
  assert.deepEqual([...listeners.keys()], [ORIGIN_CHANNEL, ORIGIN_CHANNEL_ALIAS]);
  for (const [origin, expected] of [['https://ok.example.com', true], ['https://evil.example.com', false]]) {
    const carrier = { senderFrame: { origin } };
    listeners.get(ORIGIN_CHANNEL)(carrier);
    assert.equal(carrier.returnValue, expected);
  }
  const broken = {};
  listeners.get(ORIGIN_CHANNEL_ALIAS)(broken);
  assert.equal(broken.returnValue, false, 'no frame at all');
  remove();
  assert.equal(listeners.size, 0);
});
