'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreload, reachableValues } = require('./harness');
const { createFakeSecurity } = require('../helpers/fake-window');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const ELECTRON_API = ['getAppInfo', 'getPrinters', 'openCashDrawer', 'printBarcode', 'printReceipt', 'sendBarcodeData', 'sendOpenDrawerCommand', 'sendReceiptData'];

const app = (options) => runPreload('app.js', { url: POS_URL, ...options });

// -- window.electron on allowed pages --------------------------------------------------------------------------------

test('an allowed page gets window.electron with exactly the functions of SPEC 6.1 and nothing else', () => {
  const { exposed } = app();
  assert.deepEqual(Object.keys(exposed), ['electron']);
  assert.deepEqual(Object.keys(exposed.electron).sort(), ELECTRON_API);
  for (const name of ELECTRON_API) assert.equal(typeof exposed.electron[name], 'function', name);
});

test('the preload asks the main process once, synchronously, with no data from the page', () => {
  const { ipc } = app();
  assert.deepEqual(ipc.syncs, [{ channel: 'app:origin-allowed', args: [] }]);
});

test('it loads nothing but electron (a sandboxed preload cannot)', () => {
  const { required } = app();
  assert.deepEqual([...new Set(required)], ['electron']);
});

test('ipcRenderer itself is never reachable from what the page receives', () => {
  const { exposed, ipc } = app();
  const reachable = reachableValues(exposed);
  assert.equal(reachable.has(ipc), false);
  for (const name of ['send', 'invoke', 'sendSync', 'on', 'removeListener']) {
    assert.equal(reachable.has(ipc[name]), false, name);
  }
  assert.equal('ipcRenderer' in exposed, false);
});

test('legacy functions are fire-and-forget on their fixed channels', () => {
  const { exposed, ipc } = app();
  const receipt = { receiptFileBinary: new Uint8Array([1, 2, 3]), order: { id: 1 } };
  const label = { barcodefinal: '^XA^XZ' };
  const drawer = { cashDrawerOpenPassword: '1234' };
  assert.equal(exposed.electron.sendReceiptData(receipt), undefined);
  assert.equal(exposed.electron.sendBarcodeData(label), undefined);
  assert.equal(exposed.electron.sendOpenDrawerCommand(drawer), undefined);
  assert.deepEqual(ipc.sent, [
    { channel: 'send-receipt-data', args: [receipt] },
    { channel: 'send-barcode-data', args: [label] },
    { channel: 'open-drawer-legacy', args: [drawer] },
  ]);
  assert.equal(ipc.invoked.length, 0);
});

test('the acknowledged functions invoke their fixed channels and return the answer of the main process', async () => {
  const answers = {
    'print-receipt': { ok: true },
    'print-barcode': { ok: false, code: 'DYMO_NO_PRINTER', message: 'No DYMO printer was found.' },
    'open-drawer': { ok: true, details: { prompted: true } },
    'app-info': { name: 'GadgetsPOS', version: '2.0.0', platform: 'win32', apiVersion: 2, features: ['ack-print', 'drawer', 'printer-list'] },
    'list-printers': { system: [], dymo: [] },
  };
  const { exposed, ipc } = app({ invokeHandler: (channel) => answers[channel] });

  assert.deepEqual(await exposed.electron.printReceipt({ receiptFileBinary: new Uint8Array(2) }), answers['print-receipt']);
  assert.deepEqual(await exposed.electron.printBarcode({ barcodefinal: 'x' }), answers['print-barcode']);
  assert.deepEqual(await exposed.electron.openCashDrawer({ password: '1234' }), answers['open-drawer']);
  assert.deepEqual(await exposed.electron.getAppInfo(), answers['app-info']);
  assert.deepEqual(await exposed.electron.getPrinters(), answers['list-printers']);
  assert.deepEqual(
    ipc.invoked.map((call) => [call.channel, call.args.length]),
    [['print-receipt', 1], ['print-barcode', 1], ['open-drawer', 1], ['app-info', 0], ['list-printers', 0]],
  );
  assert.deepEqual(ipc.invoked[2].args, [{ password: '1234' }]);
});

test('print and drawer calls always answer a Result: a failed transport becomes { ok: false } instead of a rejection', async () => {
  const { exposed } = app({
    invokeHandler: () => {
      throw new Error("Error invoking remote method 'print-receipt': Error: handler exploded at C:\\secret\\path.js");
    },
  });
  for (const call of [exposed.electron.printReceipt({}), exposed.electron.printBarcode({}), exposed.electron.openCashDrawer({})]) {
    const result = await call;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNKNOWN');
    assert.match(result.message, /could not complete the request/);
    assert.doesNotMatch(JSON.stringify(result), /secret|exploded/, 'internal error text never reaches the page');
  }
});

test('getAppInfo and getPrinters pass failures on (they are data lookups, not results)', async () => {
  const { exposed } = app({ invokeHandler: () => { throw new Error('boom'); } });
  await assert.rejects(exposed.electron.getAppInfo(), /boom/);
  await assert.rejects(exposed.electron.getPrinters(), /boom/);
});

// -- which pages are trusted -----------------------------------------------------------------------------------------

test('a page on a foreign origin gets nothing, and the banner machinery is not even started', () => {
  const { exposed, window, ipc } = app({ url: 'https://evil.example.com/pos' });
  assert.deepEqual(exposed, {});
  assert.equal(window.listenerCount(), 0);
  assert.equal(ipc.listeners.size, 0);
});

test('extra allowed origins work, and a document loaded after serverUrl changed sees the new answer', () => {
  const security = createFakeSecurity({ allowedOrigins: ['https://vendor.societyfiles.com', 'https://shop.example.com'] });
  assert.deepEqual(Object.keys(app({ url: 'https://shop.example.com/pos', security }).exposed), ['electron']);
  assert.deepEqual(app({ url: 'https://evil.example.com/pos', security }).exposed, {});

  // Settings > Connection: the server address moves to another domain
  security.state.allowedOrigins = ['https://pos.newdomain.example'];
  assert.deepEqual(app({ url: POS_URL, security }).exposed, {}, 'the old address is no longer allowed');
  assert.deepEqual(Object.keys(app({ url: 'https://pos.newdomain.example/', security }).exposed), ['electron']);
});

test('wildcard entries allow subdomains only', () => {
  const security = createFakeSecurity({ allowedOrigins: ['*.example.com'] });
  assert.deepEqual(Object.keys(app({ url: 'https://shop.example.com/', security }).exposed), ['electron']);
  assert.deepEqual(app({ url: 'https://example.org/', security }).exposed, {});
});

test('an about:blank popup of an allowed origin gets window.electron, because main answers from the frame origin', () => {
  const { exposed } = app({ url: 'about:blank', frameOrigin: 'https://vendor.societyfiles.com' });
  assert.deepEqual(Object.keys(exposed), ['electron']);
});

test('an about:blank popup of a foreign origin, a data: page and an opaque (sandboxed) frame get nothing', () => {
  assert.deepEqual(app({ url: 'about:blank', frameOrigin: 'https://evil.example.com' }).exposed, {});
  assert.deepEqual(app({ url: 'data:text/html,hi', frameOrigin: 'null' }).exposed, {});
  assert.deepEqual(app({ url: 'about:blank', frameOrigin: 'null' }).exposed, {});
});

test('the page cannot lie about its origin: the preload sends nothing the page controls', () => {
  // Even if location.origin claims the allowed origin, the main process judges the frame origin it sees.
  const { exposed, ipc } = app({ url: POS_URL, frameOrigin: 'https://evil.example.com' });
  assert.deepEqual(exposed, {});
  assert.deepEqual(ipc.syncs[0].args, []);
});

test('a missing, wrong-typed or failing answer from the main process means "not allowed"', () => {
  for (const answer of [undefined, null, 'true', 1, {}, [], 0]) {
    assert.deepEqual(app({ syncHandler: () => answer }).exposed, {}, String(answer));
  }
  const failing = app({
    syncHandler: () => {
      throw new Error('ipc closed');
    },
  });
  assert.deepEqual(failing.exposed, {});
  assert.equal(failing.window.listenerCount(), 0);
});

test('nothing is exposed inside an iframe, and the main process is not even asked', () => {
  const { exposed, ipc } = app({ inIframe: true });
  assert.deepEqual(exposed, {});
  assert.equal(ipc.syncs.length, 0);
});

test('a window.top that cannot be read counts as "not the top frame"', () => {
  const { exposed, ipc } = app({ topThrows: true });
  assert.deepEqual(exposed, {});
  assert.equal(ipc.syncs.length, 0);
});

// -- the app's own pages (loading, offline) --------------------------------------------------------------------------

const OFFLINE_URL = 'file:///app/src/renderer/offline.html?reason=dns&code=-105&desc=ERR_NAME_NOT_RESOLVED&url=https%3A%2F%2Fvendor.societyfiles.com%2F';

test('a file: page of the app gets only window.desktop.connection and window.desktop.window, never window.electron', () => {
  const { exposed, ipc } = app({ url: OFFLINE_URL });
  assert.deepEqual(Object.keys(exposed), ['desktop']);
  const { desktop } = exposed;
  assert.deepEqual(Object.keys(desktop).sort(), ['connection', 'platform', 'version', 'window']);
  assert.deepEqual(Object.keys(desktop.connection).sort(), ['getStatus', 'onStatus', 'openSettings', 'retryNow']);
  assert.deepEqual(Object.keys(desktop.window), ['close']);
  assert.equal('settings' in desktop, false);
  assert.equal('password' in desktop, false);
  assert.equal(ipc.syncs.length, 0, 'no origin question for the app\'s own pages');
  assert.equal(ipc.listeners.size, 0, 'no banner on the offline screen');
});

test('platform and version are plain values; the version comes from the renderer arguments', () => {
  const { exposed } = app({ url: OFFLINE_URL, platform: 'darwin', argv: ['electron', '--other', '--gadgetspos-version=2.0.0'] });
  assert.equal(exposed.desktop.platform, 'darwin');
  assert.equal(exposed.desktop.version, '2.0.0');
  assert.equal(app({ url: OFFLINE_URL, argv: [] }).exposed.desktop.version, '', 'no argument, no version');
  assert.equal(app({ url: OFFLINE_URL, argv: null }).exposed.desktop.version, '', 'process.argv missing');
});

test('the offline page can retry, open the printer settings and close, over fixed channels', async () => {
  const { exposed, ipc } = app({ url: OFFLINE_URL, invokeHandler: (channel) => ({ channel }) });
  const { connection, window } = exposed.desktop;
  assert.deepEqual(await connection.getStatus(), { channel: 'desktop:connection:getStatus' });
  assert.deepEqual(await connection.retryNow(), { channel: 'desktop:connection:retryNow' });
  assert.deepEqual(await connection.openSettings(), { channel: 'desktop:connection:openSettings' });
  assert.deepEqual(await window.close(), { channel: 'desktop:window:close' });
  assert.deepEqual(ipc.invoked.map((call) => call.channel), [
    'desktop:connection:getStatus',
    'desktop:connection:retryNow',
    'desktop:connection:openSettings',
    'desktop:window:close',
  ]);
  assert.equal(reachableValues(exposed).has(ipc), false);
});

test('the offline page can open Settings on a tab: "Printer settings" and "Change server address" pass their tab id', async () => {
  const { exposed, ipc } = app({ url: OFFLINE_URL });
  await exposed.desktop.connection.openSettings('printers');
  await exposed.desktop.connection.openSettings('connection');
  await exposed.desktop.connection.openSettings();
  for (const junk of [{ tab: 'printers' }, 5, null, ['about'], () => 'about']) await exposed.desktop.connection.openSettings(junk);
  assert.deepEqual(
    ipc.invoked.map((call) => call.args),
    [['printers'], ['connection'], [undefined], [undefined], [undefined], [undefined], [undefined], [undefined]],
    'only a string reaches the main process',
  );
});

test('onStatus delivers the payload only, returns an unsubscribe function and rejects a non-function', () => {
  const { exposed, ipc } = app({ url: OFFLINE_URL });
  const seen = [];
  const unsubscribe = exposed.desktop.connection.onStatus((payload) => seen.push(payload));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(ipc.listenerCount('desktop:connection:status'), 1);

  ipc.emitFromMain('desktop:connection:status', { online: false, attempt: 2 });
  assert.deepEqual(seen, [{ online: false, attempt: 2 }], 'no IPC event, which carries the sender');

  unsubscribe();
  unsubscribe();
  assert.equal(ipc.listenerCount('desktop:connection:status'), 0);
  ipc.emitFromMain('desktop:connection:status', { online: true });
  assert.equal(seen.length, 1);

  for (const junk of [undefined, null, 'cb', {}]) {
    assert.throws(() => exposed.desktop.connection.onStatus(junk), TypeError);
  }
});

test('a throwing subscriber does not stop the others or break the preload', () => {
  const { exposed, ipc, consoleErrors } = app({ url: OFFLINE_URL });
  const seen = [];
  exposed.desktop.connection.onStatus(() => {
    throw new Error('page bug');
  });
  exposed.desktop.connection.onStatus((payload) => seen.push(payload));
  assert.doesNotThrow(() => ipc.emitFromMain('desktop:connection:status', { online: true }));
  assert.deepEqual(seen, [{ online: true }]);
  assert.equal(consoleErrors.length, 1);
});

// -- the network is back (RE-02) -------------------------------------------------------------------------------------

test('the offline screen tells the main process when the browser reports the network back, so the reconnection looks at once', () => {
  const { ipc, window } = app({ url: OFFLINE_URL });
  assert.deepEqual(ipc.sent, [], 'nothing is sent while the page loads');
  window.dispatch('online');
  assert.deepEqual(ipc.sent, [{ channel: 'desktop:connection:networkOnline', args: [] }], 'a fixed channel, no data');
  window.dispatch('online');
  assert.equal(ipc.sent.length, 2, 'every report is passed on: the main process decides whether a probe is due');
});

test('going offline sends nothing, and an online event the page made up itself is ignored (isTrusted is false for those)', () => {
  const { ipc, window } = app({ url: OFFLINE_URL });
  window.dispatch('offline');
  window.dispatch('online', { isTrusted: false });
  assert.deepEqual(ipc.sent, []);
  window.dispatch('online', { isTrusted: true });
  assert.equal(ipc.sent.length, 1);
});

test('the loading page and the offline page get the same listener; a foreign page gets none', () => {
  assert.equal(app({ url: 'file:///app/src/renderer/loading.html' }).window.listenerCount('online'), 1);
  assert.equal(app({ url: OFFLINE_URL }).window.listenerCount('online'), 1);
  assert.equal(app({ url: 'https://evil.example.com/pos' }).window.listenerCount('online'), 0);
  const { ipc, window } = app({ url: 'https://evil.example.com/pos' });
  window.dispatch('online');
  assert.deepEqual(ipc.sent, [], 'a page that is not allowed cannot make the app probe');
});

test('the POS page tells the main process too, for the banner of a mid-session outage, and only for the browser\'s own events', () => {
  const { ipc, window } = app();
  window.dispatch('online', { isTrusted: false });
  assert.deepEqual(ipc.sent, []);
  window.dispatch('online');
  assert.deepEqual(ipc.sent, [{ channel: 'connectivity:networkOnline', args: [] }]);
});
