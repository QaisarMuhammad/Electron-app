'use strict';

/**
 * The real `bootstrap()` of src/main/index.js against the fake Electron world of tests/helpers/fake-boot.js (SPEC 18b S1, S2, S3,
 * R1, R1b, R2, R3, D2, D3, D5, L3 and 19.8). Everything except Electron, the printers and the DYMO window is the real code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBootWorld } = require('../helpers/fake-boot');
const { makePageAskToStay } = require('../helpers/fake-window');
const { makeV1Fixture } = require('../helpers/fake-store');
const { createFakeSpawn, createFakeExecFile } = require('../helpers/fake-io');
const { APP_ID, UPDATER_DELAY_MS, QUIT_DRAIN_MS, unpackedRoot } = require('../../src/main/index');
const { SCREEN_CHECK_DELAY_MS } = require('../../src/main/gpuGuard');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const flagsOf = (world) => JSON.parse(fs.readFileSync(path.join(world.store.dir, 'flags.json'), 'utf8'));

async function boot(options = {}) {
  const world = createBootWorld(options);
  await world.boot();
  await world.settle();
  return world;
}

/** Template entries of the application menu, found by id anywhere in the template. */
function menuItem(world, id) {
  const find = (items) => {
    for (const item of items || []) {
      if (item.id === id) return item;
      const inner = find(item.submenu);
      if (inner) return inner;
    }
    return undefined;
  };
  return find(world.Menu.applications.at(-1).template);
}

// ---- boot order (S1) -------------------------------------------------------------------------------------------------------

test('the order of the boot: switches and the origin handler BEFORE ready, the loading screen BEFORE the settings store, the POS AFTER the services', async () => {
  const world = createBootWorld({ deferReady: true });
  const booting = world.boot();
  await world.settle();
  assert.deepEqual(world.order.filter((entry) => entry !== 'ready'), [
    'switch:disk-cache-size', 'switch:disable-features', 'switch:disable-brotli', 'ipc:on:app:origin-allowed', 'ipc:on:security:isAllowedOrigin',
  ], 'before the app is ready: only the switches and the one synchronous IPC handler');
  assert.equal(world.windows.length, 0, 'no window before ready');
  world.ready();
  await booting;
  await world.settle();

  const at = (entry) => world.order.indexOf(entry);
  assert.ok(at('ipc:on:app:origin-allowed') < at('ready'));
  assert.ok(at('ready') < at('window'));
  assert.ok(at('window') < at('load:loading.html'), 'the loading page is requested as soon as the window exists');
  assert.ok(at('load:loading.html') < at('store'), 'electron-store is loaded only while the loading screen is up');
  assert.ok(at('store') < at('ipc:handle:print-receipt'), 'the IPC handlers need the services');
  assert.ok(at('ipc:handle:print-receipt') < at('loadURL'), 'the POS is loaded after the services are ready');
  assert.equal(world.order.filter((entry) => entry === 'window').length, 1, 'one window: no DYMO window, no settings window at startup');
  world.cleanup();
});

test('the loading screen is the first page, shown inactive in a harness, and the POS follows it', async () => {
  const world = await boot();
  const calls = world.mainWindow().webContents.calls.filter(([name]) => name === 'loadFile' || name === 'loadURL');
  assert.match(calls[0][1], /loading\.html$/);
  assert.equal(calls[1][0], 'loadURL');
  assert.equal(calls[1][1], POS_URL);
  world.cleanup();
});

test('the startup marks come in the order of SPEC 18b S3 and are in Settings > About state and in the diagnostics', async () => {
  const world = await boot();
  await world.loadPos();
  const marks = world.handle.perf.marks();
  assert.deepEqual(Object.keys(marks), ['process-start', 'app-ready', 'window-created', 'loading-visible', 'loading-painted', 'config-ready', 'services-ready', 'pos-dom-ready', 'pos-loaded']);
  const values = Object.values(marks);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  const state = world.services().desktopApi.getState();
  assert.deepEqual(Object.keys(state.performance.startup.marks), Object.keys(marks));
  assert.match(state.performance.startup.summary, /^Loading screen in \d+ ms\. POS ready in [\d.]+ s\.$|^Loading screen in \d+ ms\. POS ready in \d+ ms\.$/);
  const diagnostics = world.services().desktopApi.copyDiagnostics();
  assert.match(diagnostics, /Startup: process-start 0 ms, app-ready \d+ ms, window-created \d+ ms, loading-visible \d+ ms, loading-painted \d+ ms, config-ready \d+ ms, services-ready \d+ ms, pos-dom-ready \d+ ms, pos-loaded \d+ ms/);
  assert.equal(world.log.texts('info').filter((line) => line.startsWith('startup:')).length, 1, 'logged once, as one line');
  await world.loadPos();
  assert.equal(world.log.texts('info').filter((line) => line.startsWith('startup:')).length, 1, 'a reload does not log it again');
  world.cleanup();
});

test('the window is on screen as soon as the loading page is requested (loading-visible); the services wait until the page has been drawn (loading-painted)', async () => {
  // The renderer needs about 300 ms to start and draw the first frame, which the app cannot shorten: so the window comes up in the
  // colour of the page meanwhile, and the main thread, which that first frame needs, is left alone until it is there (SPEC 18b S1).
  const world = createBootWorld({ autoReadyToShow: false });
  const booting = world.boot();
  await world.settle();
  const [window] = world.windows;
  assert.equal(window.visible, true, 'on screen before the renderer has drawn anything');
  assert.equal(window.calls.filter((call) => call === 'show').length, 1);
  assert.equal(world.order.includes('store'), false, 'no settings store yet');
  assert.equal(world.order.includes('ipc:handle:print-receipt'), false, 'no services yet');
  assert.equal(world.order.includes('loadURL'), false, 'and the POS is not loaded yet');

  await world.clock.advance(300);
  window.emit('ready-to-show');
  await booting;
  await world.settle();
  const marks = world.handle.perf.marks();
  assert.equal(marks['loading-painted'] - marks['loading-visible'], 300);
  assert.ok(marks['window-created'] <= marks['loading-visible'] && marks['loading-painted'] <= marks['config-ready']);
  assert.ok(world.order.indexOf('store') > world.order.indexOf('load:loading.html'));
  world.cleanup();
});

test('a loading page that is never drawn cannot stall the boot: after 5 s the services are built anyway, and there is no loading-painted mark', async () => {
  const world = createBootWorld({ autoReadyToShow: false });
  const booting = world.boot();
  await world.settle();
  assert.equal(world.order.includes('store'), false);
  await world.clock.advance(4999);
  assert.equal(world.order.includes('store'), false, 'still waiting');
  await world.clock.advance(1);
  await booting;
  await world.settle();
  assert.ok(world.order.includes('store'));
  const marks = world.handle.perf.marks();
  assert.equal('loading-painted' in marks, false, 'it was never painted');
  assert.ok('loading-visible' in marks && 'config-ready' in marks && 'services-ready' in marks);
  assert.ok(world.order.includes('loadURL'), 'and the POS is loaded');
  world.cleanup();
});

test('a failure while the services are built is logged, shown in a native box and quits, so the loading screen never hangs for ever', async () => {
  const world = createBootWorld();
  world.overrides.Store = class BrokenStore {
    constructor() { throw new Error('config store is broken'); }
  };
  await world.boot();
  await world.settle();
  assert.equal(world.dialog.errorBoxes.length, 1);
  assert.equal(world.dialog.errorBoxes[0].title, 'GadgetsPOS could not start');
  assert.match(world.log.texts('error').join('\n'), /startup failed/);
  assert.ok(world.appCalls.quitRequests >= 1);
  world.cleanup();
});

// ---- switches and flags (R1, R2) -------------------------------------------------------------------------------------------

test('Windows: 512 MB disk cache, native occlusion off, brotli off like v1, and hardware acceleration ON (no disableHardwareAcceleration)', async () => {
  const world = await boot({ platform: 'win32' });
  assert.deepEqual(world.appCalls.switches, [['disk-cache-size', '536870912'], ['disable-features', 'CalculateNativeWinOcclusion'], ['disable-brotli', undefined]]);
  assert.equal(world.order.includes('switch:disable-hardware-acceleration'), false);
  world.cleanup();
});

test('macOS and Linux do not get the Windows occlusion switch', async () => {
  for (const platform of ['darwin', 'linux']) {
    const world = await boot({ platform });
    assert.deepEqual(world.appCalls.switches.map(([name]) => name), ['disk-cache-size', 'disable-brotli'], platform);
    world.cleanup();
  }
});

test('flags.json can switch compatibility mode on (hardware acceleration off) and brotli back on, BEFORE the app is ready', async () => {
  const world = createBootWorld({ deferReady: true, flags: { disableGpu: true, disableBrotli: false, reason: 'manual' } });
  const booting = world.boot();
  await world.settle();
  assert.ok(world.order.includes('switch:disable-hardware-acceleration'), 'applied before ready');
  assert.equal(world.order.includes('switch:disable-brotli'), false);
  world.ready();
  await booting;
  world.cleanup();
});

test('--disable-gpu on the command line always wins, whatever flags.json says', async () => {
  const world = await boot({ argv: ['--disable-gpu'], flags: { disableGpu: false } });
  assert.ok(world.order.includes('switch:disable-hardware-acceleration'));
  assert.equal(world.services().desktopApi.getState().performance.hardwareAcceleration, false);
  world.cleanup();
});

test('a damaged flags.json is ignored: the app starts with the defaults', async () => {
  const world = createBootWorld();
  fs.writeFileSync(path.join(world.store.dir, 'flags.json'), '{ not json');
  await world.boot();
  assert.equal(world.order.includes('switch:disable-hardware-acceleration'), false);
  world.cleanup();
});

test('the GPU process dying twice in a minute switches to compatibility mode, asks natively, and "Restart now" relaunches after a graceful quit', async () => {
  const world = await boot();
  world.dialog.responses.push(0);
  world.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
  world.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
  await world.settle();
  assert.deepEqual(flagsOf(world), { disableGpu: true, disableBrotli: true, reason: 'gpu-crashes', gpuChecked: false });
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'The screen had a problem. GadgetsPOS will use compatibility mode.');
  assert.equal(world.appCalls.relaunches, 1);
  assert.equal(world.quit, true, 'the app quit, after the graceful shutdown');
  world.cleanup();
});

test('the POS page crashing right after the start switches to compatibility mode too (the window itself still shows its own offline page)', async () => {
  const world = await boot();
  world.dialog.responses.push(1);
  world.mainWindow().webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await world.settle();
  assert.equal(flagsOf(world).disableGpu, true);
  assert.equal(flagsOf(world).reason, 'renderer-crash-at-start');
  assert.equal(world.appCalls.relaunches, 0, '"Later"');
  world.cleanup();
});

// ---- the single instance, the start URL, development -----------------------------------------------------------------------

test('a second instance asks the first one to show itself and quits without creating anything', async () => {
  const world = createBootWorld({ singleInstance: false });
  const handle = await world.boot();
  assert.equal(handle, null);
  assert.equal(world.windows.length, 0);
  assert.equal(world.appCalls.quitRequests, 1);
  world.cleanup();

  const first = await boot();
  first.mainWindow().calls.length = 0;
  first.app.emit('second-instance');
  assert.ok(first.mainWindow().calls.includes('show'));
  assert.ok(first.mainWindow().calls.includes('focus'));
  first.cleanup();
});

test('GADGETSPOS_START_URL is honoured only when the app is not packaged', async () => {
  const dev = await boot({ packaged: false, env: { GADGETSPOS_START_URL: 'http://127.0.0.1:4545/pos' } });
  assert.equal(dev.mainWindow().webContents.getURL(), 'http://127.0.0.1:4545/pos');
  assert.equal(dev.ipc.sendSync('app:origin-allowed', dev.events.pos('http://127.0.0.1:4545')), true, 'the local dev server may use window.electron in development');
  dev.cleanup();

  const installed = await boot({ packaged: true, env: { GADGETSPOS_START_URL: 'http://127.0.0.1:4545/pos' } });
  assert.equal(installed.mainWindow().webContents.getURL(), POS_URL);
  assert.equal(installed.ipc.sendSync('app:origin-allowed', installed.events.pos('http://127.0.0.1:4545')), false);
  installed.cleanup();
});

test('DevTools exist in development or with --devtools, never otherwise', async () => {
  const hasDevTools = (world) => Boolean(menuItem(world, 'view.devtools'));
  const installed = await boot({ packaged: true });
  assert.equal(hasDevTools(installed), false);
  assert.equal(installed.mainWindow().options.webPreferences.devTools, false);
  installed.cleanup();
  const flagged = await boot({ packaged: true, argv: ['--devtools'] });
  assert.equal(hasDevTools(flagged), true);
  assert.equal(flagged.mainWindow().options.webPreferences.devTools, true);
  flagged.cleanup();
  const dev = await boot({ packaged: false });
  assert.equal(hasDevTools(dev), true);
  dev.cleanup();
});

test('the Windows AppUserModelId is build.appId, set only on Windows', async () => {
  const win = await boot({ platform: 'win32' });
  assert.deepEqual(win.appCalls.appUserModelId, [APP_ID]);
  win.cleanup();
  const mac = await boot({ platform: 'darwin' });
  assert.deepEqual(mac.appCalls.appUserModelId, []);
  mac.cleanup();
});

test('the scripts folder is app.asar.unpacked when installed (PowerShell cannot run a script inside an archive)', () => {
  assert.equal(unpackedRoot('C:\\Program Files\\Gadgets POS\\resources\\app.asar'), 'C:\\Program Files\\Gadgets POS\\resources\\app.asar.unpacked');
  assert.equal(unpackedRoot('/Applications/Gadgets POS.app/Contents/Resources/app.asar'), '/Applications/Gadgets POS.app/Contents/Resources/app.asar.unpacked');
  assert.equal(unpackedRoot('/Users/shop/electron-app'), '/Users/shop/electron-app');
  assert.equal(unpackedRoot('/opt/app.asar.unpacked/x'), '/opt/app.asar.unpacked/x', 'already unpacked');
});

// ---- the settings migration at boot ----------------------------------------------------------------------------------------

test('a v1 settings file is migrated at boot: printers kept, password hashed, backup written, and nothing is lost', async () => {
  const world = await boot({ config: makeV1Fixture() });
  const { config } = world.services();
  assert.equal(config.get('printers.receipt.printerName'), 'EPSON TM-T20II Receipt');
  assert.equal(config.get('printers.receipt.transport'), 'port');
  assert.equal(config.get('printers.receipt.port'), '\\\\localhost\\EpsonTM');
  assert.equal(config.get('printers.label.printerName'), 'Zebra ZD420');
  assert.equal(config.publicState().drawer.passwordSet, true);
  assert.equal(world.store.exists('config.v1-backup.json'), true);
  const raw = world.store.readRaw();
  assert.equal('password' in raw, false, 'the plain-text password is gone');
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.printerPort, '\\\\localhost\\EpsonTM', 'the v1 keys stay so a downgrade still prints');
  world.cleanup();
});

// ---- connectivity and the update check (S2, S1, R3) ------------------------------------------------------------------------

test('the connection to the server is preconnected as soon as the window exists, with the server of the saved settings, before the store is loaded', async () => {
  const world = await boot({ config: { schemaVersion: 2, serverUrl: 'https://pos.custom-shop.example/app?x=1' } });
  assert.deepEqual(world.defaultSession.preconnects[0], { url: 'https://pos.custom-shop.example', numSockets: 4 });
  assert.ok(world.order.indexOf('preconnect') < world.order.indexOf('store'));
  world.cleanup();
});

test('a fresh install preconnects to the default server', async () => {
  const world = await boot();
  assert.deepEqual(world.defaultSession.preconnects[0], { url: 'https://vendor.societyfiles.com', numSockets: 4 });
  world.cleanup();
});

test('every reconnect attempt preconnects first, and a changed server address is preconnected at once', async () => {
  const world = await boot();
  const before = world.defaultSession.preconnects.length;
  world.services().connectivity.start(POS_URL, { mode: 'page', reason: 'refused' });
  await world.clock.advance(60_000);
  assert.ok(world.defaultSession.preconnects.length > before, 'a probe warms the connection');
  assert.ok(world.net.requests.length >= 1, 'and then the probe itself');
  world.services().connectivity.stop();

  const count = world.defaultSession.preconnects.length;
  world.services().config.setConnection({ serverUrl: 'https://new.example.com/pos' });
  assert.equal(world.defaultSession.preconnects.length, count + 1);
  assert.deepEqual(world.defaultSession.preconnects.at(-1), { url: 'https://new.example.com', numSockets: 4 });
  world.cleanup();
});

test('request errors from the POS server start the banner probe (SPEC 11.3): two different requests within 10 seconds, no timer before', async () => {
  const world = await boot();
  assert.equal(typeof world.defaultSession.errorListener, 'function');
  const status = () => world.services().connectivity.status();
  const timersBefore = world.clock.pending();
  assert.equal(status().online, true);
  world.defaultSession.errorListener({ id: 1, url: `${POS_URL}`, error: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.equal(status().online, true, 'one error is not an outage');
  assert.equal(world.clock.pending(), timersBefore, 'and starts no timer');
  world.defaultSession.errorListener({ id: 2, url: 'https://vendor.societyfiles.com/api/x', error: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.equal(status().online, false);
  assert.ok(world.mainWindow().webContents.sent.some((entry) => entry.channel === 'connectivity:status'));
  world.services().connectivity.stop();
  world.cleanup();
});

test('electron-updater is required 10 seconds after the POS page finished loading, and not one moment earlier', async () => {
  const world = await boot();
  assert.equal(world.autoUpdater.loads, 0, 'not at startup');
  await world.clock.advance(60_000);
  assert.equal(world.autoUpdater.loads, 0, 'not while the POS has not finished loading');
  await world.loadPos();
  await world.clock.advance(UPDATER_DELAY_MS - 1);
  assert.equal(world.autoUpdater.loads, 0);
  await world.clock.advance(1);
  assert.equal(world.autoUpdater.loads, 1);
  assert.equal(UPDATER_DELAY_MS, 10_000);
  await world.loadPos();
  await world.clock.advance(UPDATER_DELAY_MS);
  assert.equal(world.autoUpdater.loads, 1, 'a reload does not load it again');
  world.cleanup();
});

test('the real electron-updater module is not in the module cache after the boot, nor after the POS has loaded, until the 10 seconds are over', async () => {
  const world = createBootWorld({ withUpdater: false });
  await world.boot();
  await world.settle();
  const inCache = () => Object.keys(require.cache).filter((file) => file.includes(`${path.sep}node_modules${path.sep}electron-updater${path.sep}`));
  assert.deepEqual(inCache(), [], 'not at startup');
  await world.loadPos();
  await world.clock.advance(UPDATER_DELAY_MS - 1);
  assert.deepEqual(inCache(), [], 'not before the delay is over (the default loader is the real `require`)');
  world.cleanup();
});

test('an app without an update feed never loads the updater, even 10 seconds after the POS loaded', async () => {
  const world = await boot({ feed: false });
  await world.loadPos();
  await world.clock.advance(UPDATER_DELAY_MS);
  assert.equal(world.autoUpdater.loads, 0);
  assert.equal(world.services().updater.status().status, 'disabled');
  world.cleanup();
});

test('R3: nothing keeps the process alive and no timer polls while the app is idle', async () => {
  const world = await boot();
  await world.loadPos();
  assert.equal(world.clock.pendingRefed(), 0, 'every timer the app started is unref()ed');
  assert.equal(world.services().connectivity.status().online, true);
  const timers = world.clock.timers();
  const before = timers.length;
  await world.clock.advance(5 * 60 * 1000);
  assert.equal(world.clock.pendingRefed(), 0);
  assert.ok(world.clock.timers().length <= before, 'no new timers appear by themselves');
  world.cleanup();
});

// ---- printing wiring (L1) --------------------------------------------------------------------------------------------------

test('on Windows the real raw printer gets the persistent PowerShell host: ONE spawn for many receipts, powershell.exe by absolute path, the script outside the archive', async () => {
  const spawned = createFakeSpawn();
  const written = [];
  const hybridFs = { ...fs, promises: { ...fs.promises, writeFile: async (file, data) => { written.push([file, Buffer.from(data)]); }, unlink: async () => {} } };
  const world = createBootWorld({
    platform: 'win32',
    overrides: { rawPrinter: undefined, spawn: spawned.spawn, execFile: createFakeExecFile().execFile, fs: hybridFs, env: { SystemRoot: 'C:\\Windows' } },
  });
  await world.boot();
  await world.settle();
  world.services().config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.equal(spawned.calls.length, 0, 'the host starts with the first job, not at startup');
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await world.ipc.invoke('print-receipt', world.events.pos(), { receiptFileBinary: new Uint8Array([0x1b, 0x40, i]) }), { ok: true });
  }
  assert.equal(spawned.calls.length, 1, 'one PowerShell process for five jobs');
  assert.equal(spawned.calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(spawned.calls[0].args.at(-1), /scripts\\raw-print-host\.ps1$/);
  assert.deepEqual(spawned.children[0].commands.map((command) => command.printerName), Array(5).fill('EPSON TM-T20'));
  assert.equal(written.length, 5, 'each job had its own temp file');
  assert.equal(new Set(written.map(([file]) => file)).size, 5);
  world.app.quit();
  await world.settle(30);
  assert.equal(spawned.children[0].killed, true, 'the host is stopped at quit');
  world.cleanup();
});

test('the printer list of the app comes from the window\'s webContents, and is empty when no window exists (macOS after the last window closed)', async () => {
  const world = await boot({ platform: 'darwin', overrides: { getPrintersAsync: undefined } });
  world.mainWindow().webContents.getPrintersAsync = async () => [{ name: 'Brother QL-820', displayName: 'Brother QL-820', isDefault: false, status: 3 }];
  const lists = await world.ipc.invoke('list-printers', world.events.pos());
  assert.deepEqual(lists.system, [{ name: 'Brother QL-820', displayName: 'Brother QL-820', isDefault: false, status: 3 }]);
  world.mainWindow().destroy();
  assert.deepEqual((await world.services().desktopApi.listPrinters()).system, [], 'no window to ask: an empty list, not an error');
  world.cleanup();
});

// ---- DYMO, power, login, full screen ---------------------------------------------------------------------------------------

test('the DYMO helper window is never created at startup (the real DYMO service, a fake window factory)', async () => {
  const world = await boot({ overrides: { dymo: undefined } });
  assert.equal(world.windows.length, 1, 'only the main window exists');
  assert.equal(typeof world.services().dymo.print, 'function');
  world.cleanup();
});

test('the computer is kept awake while the POS window exists and power.keepAwake is on, and only the app (never the display)', async () => {
  const world = await boot();
  assert.deepEqual(world.powerSaveBlocker.started, ['prevent-app-suspension']);
  await world.services().desktopApi.setGeneral({ keepAwake: false });
  assert.deepEqual(world.powerSaveBlocker.stopped, [1]);
  world.services().desktopApi.setGeneral({ keepAwake: true });
  assert.equal(world.powerSaveBlocker.started.length, 2);
  world.mainWindow().destroy();
  assert.equal(world.powerSaveBlocker.stopped.length, 2, 'stopped with the window');
  world.cleanup();
});

test('the General tab\'s switches reach the system through the real channel: keep awake and start with the computer follow desktop:settings:setGeneral', async () => {
  const world = await boot({ platform: 'win32' });
  world.services().settingsWindow.open({ tab: 'general' });
  const event = world.events.settings();
  assert.deepEqual(await world.ipc.invoke('desktop:settings:setGeneral', event, { openAtLogin: true, startFullScreen: false, keepAwake: false }), { ok: true });
  assert.deepEqual(world.appCalls.loginItem, [{ openAtLogin: true }]);
  assert.deepEqual(world.powerSaveBlocker.stopped, [1]);
  assert.deepEqual(await world.ipc.invoke('desktop:settings:setGeneral', event, { openAtLogin: false, startFullScreen: true, keepAwake: true }), { ok: true });
  assert.deepEqual(world.appCalls.loginItem.at(-1), { openAtLogin: false });
  assert.equal(world.powerSaveBlocker.started.length, 2);
  assert.equal(world.services().config.get('window.startFullScreen'), true);
  world.cleanup();
});

test('keep awake off in the settings means the blocker is never started', async () => {
  const world = await boot({ config: { schemaVersion: 2, power: { keepAwake: false } } });
  assert.deepEqual(world.powerSaveBlocker.started, []);
  world.cleanup();
});

test('start with the computer follows startup.openAtLogin on Windows and macOS, once per change, never on Linux or in development', async () => {
  const win = await boot({ platform: 'win32' });
  assert.deepEqual(win.appCalls.loginItem, []);
  win.services().desktopApi.setGeneral({ openAtLogin: true });
  assert.deepEqual(win.appCalls.loginItem, [{ openAtLogin: true }]);
  win.services().desktopApi.setGeneral({ openAtLogin: true });
  assert.equal(win.appCalls.loginItem.length, 1);
  win.services().desktopApi.setGeneral({ openAtLogin: false });
  assert.deepEqual(win.appCalls.loginItem.at(-1), { openAtLogin: false });
  win.cleanup();

  const saved = await boot({ platform: 'darwin', config: { schemaVersion: 2, startup: { openAtLogin: true } } });
  assert.deepEqual(saved.appCalls.loginItem, [{ openAtLogin: true }], 'applied at the start too');
  saved.cleanup();

  const linux = await boot({ platform: 'linux', config: { schemaVersion: 2, startup: { openAtLogin: true } } });
  assert.deepEqual(linux.appCalls.loginItem, []);
  linux.cleanup();
  const dev = await boot({ packaged: false, config: { schemaVersion: 2, startup: { openAtLogin: true } } });
  assert.deepEqual(dev.appCalls.loginItem, []);
  dev.cleanup();
});

test('full screen is restored: remembered from last time, or forced by "Start in full screen", and saved when it changes', async () => {
  const remembered = await boot({ config: { schemaVersion: 2, window: { fullScreen: true } } });
  assert.ok(remembered.mainWindow().calls.includes('setFullScreen:true'));
  remembered.cleanup();
  const forced = await boot({ config: { schemaVersion: 2, window: { startFullScreen: true } } });
  assert.ok(forced.mainWindow().calls.includes('setFullScreen:true'));
  forced.cleanup();
  const normal = await boot();
  assert.equal(normal.mainWindow().calls.includes('setFullScreen:true'), false);
  normal.mainWindow().setFullScreen(true);
  await normal.settle();
  assert.equal(normal.services().config.get('window.fullScreen'), true, 'saved the moment it changes');
  normal.cleanup();
});

test('the first window uses the saved bounds from the settings file before the store is loaded', async () => {
  const world = await boot({ config: { schemaVersion: 2, window: { bounds: { x: 20, y: 30, width: 1200, height: 700 }, maximized: false } } });
  const options = world.mainWindow().options;
  assert.deepEqual({ x: options.x, y: options.y, width: options.width, height: options.height }, { x: 20, y: 30, width: 1200, height: 700 });
  world.cleanup();
});

// ---- the screen question after an upgrade (R1b) ----------------------------------------------------------------------------

test('after an upgrade from v1 the cashier is asked, natively and once, whether the screen looks right', async () => {
  const world = await boot({ config: makeV1Fixture() });
  world.dialog.responses.push(0);
  await world.clock.advance(SCREEN_CHECK_DELAY_MS - 1);
  assert.equal(world.dialog.calls.length, 0);
  await world.clock.advance(1);
  await world.settle();
  assert.equal(world.dialog.calls.length, 1);
  assert.equal(world.dialog.calls[0].options.message, 'Does the screen look right?');
  assert.equal(flagsOf(world).gpuChecked, true);
  assert.equal(flagsOf(world).disableGpu, false);
  world.cleanup();

  // the answer is stored: the next start (same flags.json) never asks again
  const again = createBootWorld({ config: makeV1Fixture(), flags: { gpuChecked: true } });
  await again.boot();
  await again.clock.advance(SCREEN_CHECK_DELAY_MS * 2);
  await again.settle();
  assert.equal(again.dialog.calls.length, 0);
  again.cleanup();
});

test('answering "No, use compatibility mode" writes the flag and relaunches', async () => {
  const world = await boot({ config: makeV1Fixture() });
  world.dialog.responses.push(1);
  await world.clock.advance(SCREEN_CHECK_DELAY_MS);
  await world.settle();
  assert.deepEqual(flagsOf(world), { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: true });
  assert.equal(world.appCalls.relaunches, 1);
  world.cleanup();
});

test('a fresh install, and a v2 settings file, are not asked', async () => {
  const fresh = await boot();
  await fresh.clock.advance(SCREEN_CHECK_DELAY_MS * 2);
  await fresh.settle();
  assert.equal(fresh.dialog.calls.length, 0);
  fresh.cleanup();
  const v2 = await boot({ config: { schemaVersion: 2 } });
  await v2.clock.advance(SCREEN_CHECK_DELAY_MS * 2);
  await v2.settle();
  assert.equal(v2.dialog.calls.length, 0);
  v2.cleanup();
});

// ---- the menu --------------------------------------------------------------------------------------------------------------

test('the application menu is installed with every handler working', async () => {
  const world = await boot({ platform: 'win32', packaged: false });
  assert.equal(world.Menu.applications.length, 1);
  const win = world.mainWindow();
  menuItem(world, 'view.zoom-in').click();
  assert.equal(world.services().config.get('window.zoomLevel'), 0.5);
  menuItem(world, 'view.zoom-reset').click();
  assert.equal(world.services().config.get('window.zoomLevel'), 0);
  menuItem(world, 'view.full-screen').click();
  assert.ok(win.calls.includes('setFullScreen:true'));
  menuItem(world, 'view.reload').click();
  menuItem(world, 'view.force-reload').click();
  assert.deepEqual(win.webContents.calls.filter(([name]) => name.startsWith('reload')).map(([name]) => name), ['reload', 'reloadIgnoringCache']);
  menuItem(world, 'view.devtools').click();
  assert.ok(win.webContents.calls.some(([name]) => name === 'toggleDevTools'));
  menuItem(world, 'settings.printers').click();
  assert.match(world.services().settingsWindow.getWindow().webContents.getURL(), /settings\.html\?tab=printers$/);
  menuItem(world, 'help.about').click();
  assert.match(world.services().settingsWindow.getWindow().webContents.getURL(), /#about$/);
  menuItem(world, 'help.logs').click();
  await world.settle();
  assert.deepEqual(world.shell.paths, [path.join(world.store.dir, 'logs')]);
  menuItem(world, 'help.diagnostics').click();
  assert.equal(world.clipboard.writes.length, 1);
  assert.deepEqual(world.notification.shown.at(-1), { title: 'GadgetsPOS', body: 'Diagnostics copied to the clipboard.', silent: true });
  world.cleanup();
});

test('Open Drawer (Ctrl+D) opens the password window, or explains why it cannot', async () => {
  const world = await boot({ password: false, printers: false });
  menuItem(world, 'drawer').click();
  await world.settle();
  assert.equal(world.services().passwordWindow.isOpen(), false);
  assert.equal(world.dialog.calls.length, 1, 'no password set: a box tells the manager');
  assert.match(world.dialog.calls[0].options.detail, /Settings > Cash drawer/);
  world.cleanup();

  const ready = createBootWorld();
  await ready.boot();
  await ready.settle();
  ready.services().config.setPasswordRecord(require('../../src/main/password').hashPassword('open-it'));
  menuItem(ready, 'drawer').click();
  await ready.settle();
  assert.equal(ready.services().passwordWindow.isOpen(), true);
  ready.cleanup();
});

test('Help > Compatibility mode is a native checkbox that writes the manual flag and offers a restart', async () => {
  const world = await boot();
  const item = menuItem(world, 'help.compatibility');
  assert.equal(item.checked, false);
  world.dialog.responses.push(0);
  item.click({ checked: true });
  await world.settle();
  assert.deepEqual(flagsOf(world), { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: false });
  assert.equal(world.appCalls.relaunches, 1);
  assert.equal(world.Menu.applications.length >= 2, true, 'the menu is rebuilt so the checkbox follows the flag');
  world.cleanup();

  const on = await boot({ flags: { disableGpu: true, reason: 'manual' } });
  assert.equal(menuItem(on, 'help.compatibility').checked, true);
  on.cleanup();
});

// ---- graceful quit (D5, L3) ------------------------------------------------------------------------------------------------

test('quitting drains the print queue FIRST, then disposes the DYMO window and the print helper, and only then quits', async () => {
  const world = await boot();
  const steps = [];
  const { queue } = world.services();
  const drain = queue.drain;
  queue.drain = async (ms) => { steps.push(`drain ${ms}`); return drain(ms); };
  world.dymo.dispose = () => steps.push('dymo dispose');
  world.rawPrinter.dispose = () => steps.push('print helper dispose');
  world.app.quit();
  assert.equal(world.quit, false, 'held back by the first before-quit');
  await world.settle(20);
  assert.deepEqual(steps, ['drain 5000', 'dymo dispose', 'print helper dispose']);
  assert.equal(QUIT_DRAIN_MS, 5000);
  assert.equal(world.quit, true);
  assert.equal(world.appCalls.quitRequests, 2, 'quit() once by the user, once at the end of the shutdown');
  world.cleanup();
});

test('a label that is still printing when the cashier quits is finished first', async () => {
  const world = await boot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  world.dymo.print = async () => { await gate; world.dymo.prints.push('printed'); return { ok: true }; };
  world.ipc.send('send-barcode-data', world.events.pos(), { barcodefinal: { printer: 'dymo', title: 'x' } });
  await world.settle();
  world.app.quit();
  await world.settle(20);
  assert.equal(world.quit, false, 'the label is still in the queue');
  assert.equal(world.dymo.disposed, 0, 'its window is not taken away');
  release();
  await world.settle(20);
  assert.deepEqual(world.dymo.prints, ['printed']);
  assert.equal(world.quit, true);
  assert.equal(world.dymo.disposed, 1);
  world.cleanup();
});

test('"Restart now" (Settings, an update, the compatibility dialogs) relaunches once through the same graceful quit', async () => {
  const world = await boot();
  world.services().desktopApi.restartApp();
  world.services().desktopApi.restartApp();
  await world.settle(20);
  assert.equal(world.appCalls.relaunches, 1);
  assert.equal(world.quit, true);
  world.cleanup();
});

test('closing the POS window quits the app on Windows and Linux, and keeps it running on macOS (where the dock icon brings the window back)', async () => {
  const win = await boot({ platform: 'win32' });
  win.mainWindow().destroy();
  await win.settle(20);
  assert.equal(win.quit, true);
  win.cleanup();

  const mac = await boot({ platform: 'darwin' });
  mac.mainWindow().destroy();
  await mac.settle(20);
  assert.equal(mac.quit, false);
  const before = mac.windows.length;
  mac.app.emit('activate');
  await mac.settle();
  assert.equal(mac.windows.length, before + 1, 'a new window');
  assert.match(mac.mainWindow().webContents.calls.find(([name]) => name === 'loadURL')[1], /societyfiles/);
  mac.cleanup();
});

test('the last window closing quits on Windows too, even when the hidden DYMO window still exists', async () => {
  const world = await boot({ platform: 'win32' });
  world.app.emit('window-all-closed');
  await world.settle(20);
  assert.equal(world.quit, true);
  const mac = await boot({ platform: 'darwin' });
  mac.app.emit('window-all-closed');
  await mac.settle(20);
  assert.equal(mac.quit, false);
  world.cleanup();
  mac.cleanup();
});

// ---- what a page may open (SPEC 12) ----------------------------------------------------------------------------------------

test('the popup and browser-tab budget of a page runs on the app\'s monotonic clock: three in a row, then refused, and back ten seconds later', async () => {
  const world = await boot();
  const contents = world.mainWindow().webContents;
  const open = (url = 'about:blank') => contents.windowOpenHandler({ url, features: '' }).action === 'allow';
  assert.deepEqual([1, 2, 3, 4, 5].map(() => open()), [true, true, true, false, false]);
  const blocked = world.log.texts('info').filter((line) => /window-open blocked \(rate-limited\)/.test(line));
  assert.deepEqual(blocked, ['window-open blocked (rate-limited): no address'], 'one line for the whole burst, no address in it');

  await world.clock.advance(9_999);
  assert.equal(open(), false, 'not one millisecond early');
  await world.clock.advance(1);
  assert.equal(open(), true, 'the budget is back after 10 s of the app clock');
  world.cleanup();
});

test('an allowed-domain wildcard over a shared suffix that is already in config.json is ignored by the running app, and logged once', async () => {
  const world = await boot({ config: { schemaVersion: 2, extraAllowedOrigins: ['*.co.uk', '*.github.io', 'https://shop.example.com'] } });
  const { security } = world.services();
  for (let i = 0; i < 3; i += 1) assert.equal(security.isAllowedOrigin('https://attacker.co.uk'), false);
  assert.equal(security.isAllowedOrigin('https://attacker.github.io'), false);
  assert.equal(security.isAllowedOrigin('https://shop.example.com'), true);
  assert.equal(security.isAllowedOrigin('https://societyfiles.com'), false, 'not the bare domain');
  assert.equal(security.isAllowedOrigin('https://vendor.societyfiles.com'), true, 'the default server still is');
  const warnings = world.log.texts('warn').filter((line) => /is ignored: it would trust every website/.test(line));
  assert.equal(warnings.length, 2, warnings.join('\n'));
  world.cleanup();
});

// ---- quitting with unsaved changes in Settings ----------------------------------------------------------------------------

/** A booted app whose Settings window is open and whose page asks to stay (a tab has unsaved edits); `answers` are the button numbers of the questions. */
async function bootWithUnsavedSettings(options = {}, answers = []) {
  const world = await boot(options);
  const queue = [...answers];
  world.dialog.showMessageBoxSync = (...args) => {
    world.dialog.syncCalls.push(args);
    return queue.length > 0 ? queue.shift() : 0;
  };
  const settings = world.services().settingsWindow;
  const win = settings.open({ tab: 'connection' });
  const seen = makePageAskToStay(win);
  return { world, settings, win, seen, questions: () => world.dialog.syncCalls.filter(([, box]) => /unsaved changes/.test(box.message)) };
}

test('Quit with unsaved changes in Settings asks the one question first; Keep editing cancels the quit and nothing has been shut down', async () => {
  const { world, win, questions } = await bootWithUnsavedSettings({}, [0]);
  const drained = [];
  world.services().queue.drain = async (ms) => { drained.push(ms); return true; };
  menuItem(world, 'quit').click();
  await world.settle(20);
  assert.equal(questions().length, 1, 'one question, from the Settings window');
  assert.equal(questions()[0][0], win, 'attached to it');
  assert.equal(win.isDestroyed(), false, 'Settings stays open');
  assert.equal(world.quit, false, 'the app is still running');
  assert.deepEqual(drained, [], 'the print queue was not touched');
  assert.equal(world.dymo.disposed, 0);
  assert.equal(world.powerSaveBlocker.stopped.length, 0, 'the computer is still kept awake');
  world.cleanup();
});

test('Quit with unsaved changes and Discard changes closes Settings, then quits gracefully, with that one question only', async () => {
  const { world, win, questions } = await bootWithUnsavedSettings({}, [1]);
  menuItem(world, 'quit').click();
  await world.settle(20);
  assert.equal(questions().length, 1);
  assert.equal(win.isDestroyed(), true);
  assert.equal(world.quit, true);
  assert.equal(world.appCalls.quitRequests, 2, 'quit() once by the cashier, once at the end of the shutdown');
  world.cleanup();
});

test('Quit asks again the next time (Keep editing is not remembered), and a Quit with nothing unsaved asks nothing', async () => {
  const { world, win, questions } = await bootWithUnsavedSettings({}, [0, 1]);
  menuItem(world, 'quit').click();
  await world.settle(20);
  assert.equal(world.quit, false);
  menuItem(world, 'quit').click();
  await world.settle(20);
  assert.equal(questions().length, 2);
  assert.equal(world.quit, true);
  world.cleanup();

  const clean = await boot();
  const settings = clean.services().settingsWindow.open();
  menuItem(clean, 'quit').click();
  await clean.settle(20);
  assert.equal(clean.dialog.syncCalls.length, 0, 'no question');
  assert.equal(settings.isDestroyed(), true, 'Settings was closed with the quit');
  assert.equal(clean.quit, true);
  clean.cleanup();
});

test('"Restart now" with unsaved changes asks first: Keep editing relaunches nothing, so a later quit does not bring the app back', async () => {
  const { world, win, questions } = await bootWithUnsavedSettings({}, [0, 1]);
  world.services().desktopApi.restartApp();
  await world.settle(20);
  assert.equal(questions().length, 1);
  assert.equal(world.appCalls.relaunches, 0, 'no relaunch was scheduled');
  assert.equal(world.quit, false);
  menuItem(world, 'quit').click();
  await world.settle(20);
  assert.equal(world.quit, true);
  assert.equal(world.appCalls.relaunches, 0, 'the plain quit that followed stays a quit');
  world.cleanup();

  const again = await bootWithUnsavedSettings({}, [1]);
  again.world.services().desktopApi.restartApp();
  await again.world.settle(20);
  assert.equal(again.world.appCalls.relaunches, 1, 'Discard changes: the restart goes ahead once');
  assert.equal(again.world.quit, true);
  again.world.cleanup();
});

test('closing the POS window with Settings open is a quit like any other on Windows and Linux: the question comes first, and Keep editing keeps both windows', async () => {
  for (const platform of ['win32', 'linux']) {
    const { world, win, questions } = await bootWithUnsavedSettings({ platform }, [0, 1]);
    const main = world.mainWindow();
    main.close();
    await world.settle(20);
    assert.equal(questions().length, 1, platform);
    assert.equal(main.isDestroyed(), false, `${platform}: the POS window is still there`);
    assert.equal(win.isDestroyed(), false, `${platform}: so is Settings`);
    assert.equal(world.quit, false);

    main.close();
    await world.settle(20);
    assert.equal(questions().length, 2, platform);
    assert.equal(win.isDestroyed(), true, platform);
    assert.equal(world.quit, true, `${platform}: the quit went ahead (Electron closes the POS window itself, in that quit)`);
    world.cleanup();
  }
});

test('closing the POS window with Settings closed is untouched (no question, the window closes), and on macOS it never quits the app', async () => {
  const win32 = await boot({ platform: 'win32' });
  win32.mainWindow().close();
  await win32.settle(20);
  assert.equal(win32.dialog.syncCalls.length, 0);
  assert.equal(win32.quit, true);
  win32.cleanup();

  const mac = await bootWithUnsavedSettings({ platform: 'darwin' }, [1]);
  mac.world.mainWindow().close();
  await mac.world.settle(20);
  assert.equal(mac.questions().length, 0, 'macOS keeps the app and the window rules of its own');
  assert.equal(mac.world.mainWindow(), null, 'the POS window is closed');
  assert.equal(mac.world.quit, false);
  mac.world.cleanup();
});

// ---- harness mode (19.8) ---------------------------------------------------------------------------------------------------

test('testMode: macOS accessory activation policy, and every window shows inactive and never takes focus', async () => {
  const world = await boot({ platform: 'darwin', testMode: true });
  assert.deepEqual(world.appCalls.activationPolicy, ['accessory']);
  world.services().settingsWindow.open({ tab: 'general' });
  world.services().passwordPrompt.show('drawer');
  await world.settle();
  world.app.emit('second-instance');
  assert.ok(world.windows.length >= 3);
  for (const window of world.windows) {
    assert.equal(window.calls.includes('show'), false, 'show() is never used');
    assert.equal(window.calls.includes('focus'), false, 'focus() is never used');
  }
  assert.ok(world.mainWindow().calls.includes('showInactive'));
  world.cleanup();
});

test('outside testMode the activation policy is left alone and windows show normally', async () => {
  const world = await boot({ platform: 'darwin', testMode: false });
  assert.deepEqual(world.appCalls.activationPolicy, []);
  assert.ok(world.mainWindow().calls.includes('show'));
  world.cleanup();
});

// ---- the password lock (SPEC 10) -------------------------------------------------------------------------------------------

test('the password lock is saved with the settings and is still there after a restart: closing the app does not give five new guesses', async () => {
  const first = await boot();
  const drawer = first.services().drawer;
  assert.equal(drawer.setPassword({ next: 'Correct-Horse-9' }).ok, true);
  for (let i = 0; i < 5; i += 1) await drawer.open({ password: `wrong-${i}` });
  assert.deepEqual(first.services().config.get('drawer.lock'), { failures: 5, remainingMs: 30_000, writtenAt: first.clock.now() });
  assert.equal(first.services().config.publicState().drawer.lock, undefined, 'a window never sees the counters');
  const raw = first.store.readRaw();
  first.cleanup();

  const second = await boot({ config: raw });
  assert.equal((await second.services().drawer.open({ password: 'Correct-Horse-9' })).code, 'DRAWER_LOCKED_OUT', 'the right password is refused after the restart');
  assert.equal(second.services().throttle.check().retryAfterSec, 30);
  await second.clock.advance(30_000);
  assert.equal(second.services().throttle.check().allowed, true, 'time that really passes ends it');
  second.services().drawer.checkPassword({ password: 'Correct-Horse-9' });
  assert.equal(second.services().config.get('drawer.lock', null), null, 'a correct password removes the saved lock');
  second.cleanup();
});

// ---- logging ---------------------------------------------------------------------------------------------------------------

test('uncaught exceptions and rejections are logged, and the log only starts after the boot attached it', async () => {
  const world = createBootWorld();
  const booting = world.boot();
  world.proc.emit('uncaughtException', new Error('early failure'));
  await booting;
  await world.settle();
  world.proc.emit('unhandledRejection', new Error('late failure'));
  const errors = world.log.texts('error').join('\n');
  assert.match(errors, /uncaught exception/);
  assert.match(errors, /unhandled promise rejection/);
  assert.match(world.log.texts('info')[0], /GadgetsPOS 2\.0\.0-test is starting \(win32, installed, hardware acceleration on\)/);
  world.cleanup();
});
