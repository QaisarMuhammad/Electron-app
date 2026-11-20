'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDesktopApi, describeCompatibilityReason } = require('../../src/main/desktopApi');
const { createConfig } = require('../../src/main/config');
const { createDrawer } = require('../../src/main/printing/drawer');
const { createPrintService } = require('../../src/main/printing/jobs');
const { createPasswordPrompt } = require('../../src/main/passwordPrompt');
const { createPerf } = require('../../src/main/perf');
const { readFlagsSync, writeFlags } = require('../../src/main/flags');
const passwordTools = require('../../src/main/password');
const { createFakeStoreEnv } = require('../helpers/fake-store');
const { createManualClock } = require('../helpers/fake-electron');

const PASSWORD = 'manager-1';
const ZEBRA_TEST = /^\^XA[\s\S]*TEST[\s\S]*\^XZ\n?$/;

/**
 * The real config, drawer, throttle, print service and password prompt; fake windows, printers, updater and connectivity.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.password] the drawer password ('' = none set)
 * @param {boolean} [options.argvDisableGpu]
 * @param {boolean} [options.gpuDisabled]
 */
function setup({ platform = 'win32', password = PASSWORD, argvDisableGpu = false, gpuDisabled = false } = {}) {
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store });
  if (password) config.setPasswordRecord(passwordTools.hashPassword(password));
  const events = { jobs: [], dymo: [], prompts: [], settingsOpens: [], clipboard: [], restarts: 0, paths: [], pushes: [] };
  const rawPrinter = { async printRaw(job) { events.jobs.push({ target: job.target, bytes: Buffer.from(job.data), ext: job.ext }); return { ok: true }; } };
  const dymo = { async print(payload) { events.dymo.push(payload); return { ok: true }; }, async listPrinters() { return { printers: [] }; } };
  const throttle = passwordTools.createThrottle();
  const drawer = createDrawer({ config, rawPrinter, password: passwordTools, throttle });
  const printService = createPrintService({ config, rawPrinter, dymo, drawer });
  const passwordWindowState = { open: false };
  const passwordWindow = {
    open(options) { events.prompts.push(options); passwordWindowState.open = true; return Object.assign(new (require('node:events').EventEmitter)(), {}); },
    close() { passwordWindowState.open = false; },
    isOpen: () => passwordWindowState.open,
    send: (channel, payload) => events.pushes.push([channel, payload]),
  };
  const settingsState = { open: false };
  const settingsWindow = { isOpen: () => settingsState.open, open(options) { events.settingsOpens.push(options); settingsState.open = true; } };
  const clock = createManualClock();
  const passwordPrompt = createPasswordPrompt({ passwordWindow, settingsWindow, drawer, throttle, timers: clock });
  const flagsDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gpos-flags-'));
  const flags = { read: () => readFlagsSync(flagsDir), write: (patch) => writeFlags(flagsDir, patch) };
  const perf = createPerf({ now: clock.now, uptimeMs: () => 0 });
  perf.mark('loading-visible');
  const updaterState = { status: { status: 'none' }, installs: 0, checks: 0, canInstall: true };
  const updater = {
    status: () => ({ ...updaterState.status }),
    checkNow: async () => { updaterState.checks += 1; return { status: 'none' }; },
    install: () => { updaterState.installs += 1; return updaterState.canInstall; },
  };
  const connection = { status: { online: true, attempt: 0, nextRetryInMs: null, lastError: null, url: null, reason: null } };
  const networkReports = [];
  const retries = [];
  const controller = { retryNow: () => { retries.push('retry'); return Promise.resolve(); } };
  let openPathResult = '';
  const api = createDesktopApi({
    appName: 'Gadgets POS', version: '2.0.0', platform, arch: 'x64', osRelease: '10.0.19045',
    versions: { electron: '32.3.3', chrome: '128.0.6613.186', node: '20.18.1' }, isPackaged: true,
    config, drawer, passwordPrompt, settingsWindow, printService,
    listPrinters: async () => ({ system: [], dymo: [] }),
    flags, argvDisableGpu, gpuDisabled, perf, updater,
    connectivity: { status: () => connection.status, notifyNetworkChange: (online) => networkReports.push(online) },
    getController: () => controller,
    paths: { userData: flagsDir, logsDir: path.join(flagsDir, 'logs') },
    openPath: async (folder) => { events.paths.push(folder); return openPathResult; },
    writeClipboard: (text) => events.clipboard.push(text),
    restart: () => { events.restarts += 1; },
    log: { info() {}, warn() {}, error() {} },
  });
  return {
    api, config, events, flags, flagsDir, updaterState, connection, networkReports, retries, settingsState, passwordWindowState, passwordPrompt, clock,
    setOpenPathResult: (value) => { openPathResult = value; },
    cleanup: () => { env.cleanup(); fs.rmSync(flagsDir, { recursive: true, force: true }); },
  };
}

// ---- state -----------------------------------------------------------------------------------------------------------------

test('getState has everything the Settings page reads and never the password record', () => {
  const { api, cleanup } = setup();
  const state = api.getState();
  assert.equal(state.platform, 'win32');
  assert.equal(state.arch, 'x64');
  assert.equal(state.version, '2.0.0');
  assert.equal(state.online, true);
  assert.deepEqual(state.update, { status: 'none' });
  assert.equal(state.config.drawer.passwordSet, true);
  assert.equal('passwordRecord' in state.config.drawer, false);
  assert.doesNotMatch(JSON.stringify(state), /scrypt/);
  assert.equal(state.config.serverUrl, 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy');
  assert.deepEqual(state.versions, { electron: '32.3.3', chrome: '128.0.6613.186', node: '20.18.1' });
  assert.match(state.paths.configFile, /config\.json$/);
  assert.match(state.paths.logsDir, /logs$/);
  assert.equal(state.performance.hardwareAcceleration, true);
  assert.equal(state.performance.compatibilityReason, '');
  assert.equal(state.performance.startup.marks['loading-visible'], 0);
  assert.equal(state.performance.startup.summary, 'Loading screen in 0 ms.');
  cleanup();
});

test('the state says when the connection is down', () => {
  const { api, connection, cleanup } = setup();
  connection.status = { ...connection.status, online: false, attempt: 2, reason: 'dns' };
  assert.equal(api.getState().online, false);
  assert.deepEqual(api.connection.getStatus(), connection.status);
  cleanup();
});

test('compatibility mode is shown with a reason a person can read, whether flags.json or the shortcut switched it on', () => {
  for (const [stored, reason] of [
    [{ disableGpu: true, reason: 'gpu-crashes' }, 'the graphics process stopped working twice within a minute'],
    [{ disableGpu: true, reason: 'renderer-crash-at-start' }, 'the POS page crashed right after GadgetsPOS started'],
    [{ disableGpu: true, reason: 'manual' }, 'manual'],
    [{ disableGpu: true, reason: '' }, 'manual'],
    [{ disableGpu: true, reason: 'Some other text' }, 'Some other text'],
  ]) {
    const { api, flagsDir, cleanup } = setup();
    writeFlags(flagsDir, stored);
    const performance = api.getState().performance;
    assert.equal(performance.hardwareAcceleration, false);
    assert.equal(performance.compatibilityReason, reason);
    cleanup();
  }
  const shortcut = setup({ argvDisableGpu: true, gpuDisabled: true });
  assert.equal(shortcut.api.getState().performance.hardwareAcceleration, false);
  assert.match(shortcut.api.getState().performance.compatibilityReason, /--disable-gpu/);
  shortcut.cleanup();
  assert.equal(describeCompatibilityReason(undefined), 'manual');
});

// ---- printers --------------------------------------------------------------------------------------------------------------

test('savePrinter stores an installed printer for each role', () => {
  const { api, config, cleanup } = setup();
  assert.deepEqual(api.savePrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' }), { ok: true });
  assert.deepEqual(api.savePrinter('label', { transport: 'system', printerName: 'ZDesigner ZD420', port: '' }), { ok: true });
  assert.deepEqual(api.savePrinter('dymo', { printerName: 'DYMO LabelWriter 450' }), { ok: true });
  assert.deepEqual(config.get('printers.receipt'), { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.deepEqual(config.get('printers.dymo'), { printerName: 'DYMO LabelWriter 450' });
  cleanup();
});

test('savePrinter checks a port with classifyPort: UNC shares and DOS devices are saved, everything else is INVALID_SETTINGS with the standard message', () => {
  const { api, config, cleanup } = setup();
  for (const port of ['\\\\localhost\\ZebraZD420', 'LPT1', 'lpt1:', '\\\\.\\COM3']) {
    assert.deepEqual(api.savePrinter('label', { transport: 'port', printerName: '', port }), { ok: true }, port);
  }
  for (const port of ['USB001', 'C:\\x', '..\\x', 'LPT1&calc', '\\\\host\\a\\b', '\\\\?\\C:\\x', '50%']) {
    const result = api.savePrinter('receipt', { transport: 'port', printerName: '', port });
    assert.equal(result.ok, false, port);
    assert.equal(result.code, 'INVALID_SETTINGS', port);
    assert.match(result.message, /This port name cannot be used\. Choose the installed printer, or a shared printer address such as \\\\localhost\\ZebraZD420\./);
  }
  assert.equal(config.get('printers.receipt.port'), '', 'a refused port is never saved');
  cleanup();
});

test('a port exists only on Windows: elsewhere it is UNSUPPORTED_PLATFORM with the next step in the message', () => {
  const { api, cleanup } = setup({ platform: 'darwin' });
  const result = api.savePrinter('receipt', { transport: 'port', printerName: '', port: 'LPT1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.match(result.message, /choose an installed printer/);
  cleanup();
});

test('an installed printer needs a name, and an unknown role or a missing object is refused', () => {
  const { api, cleanup } = setup();
  assert.equal(api.savePrinter('receipt', { transport: 'system', printerName: '   ', port: '' }).message, 'Choose a printer first.');
  assert.equal(api.savePrinter('label', { transport: 'system', port: '' }).code, 'INVALID_SETTINGS');
  assert.equal(api.savePrinter('a4', { transport: 'system', printerName: 'x' }).code, 'INVALID_SETTINGS');
  assert.equal(api.savePrinter('receipt', null).code, 'INVALID_SETTINGS');
  assert.equal(api.savePrinter('receipt', 'EPSON').code, 'INVALID_SETTINGS');
  cleanup();
});

test('testPrint prints a test receipt on the saved receipt printer, through the real receipt path', async () => {
  const { api, events, cleanup } = setup();
  api.savePrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.deepEqual(await api.testPrint('receipt', {}), { ok: true });
  assert.equal(events.jobs.length, 1);
  assert.equal(events.jobs[0].target.printerName, 'EPSON TM-T20');
  const text = events.jobs[0].bytes.toString('latin1');
  assert.match(text, /GadgetsPOS/);
  assert.match(text, /Printer: EPSON TM-T20/);
  assert.deepEqual([...events.jobs[0].bytes.subarray(0, 2)], [0x1b, 0x40], 'starts with ESC @');
  assert.deepEqual([...events.jobs[0].bytes.subarray(-3)], [0x1d, 0x56, 0x00], 'ends with a full cut');
  cleanup();
});

test('testPrint without a saved printer says so (NO_PRINTER_CONFIGURED) instead of printing on a guess', async () => {
  const { api, events, cleanup } = setup();
  for (const role of ['receipt', 'label']) {
    const result = await api.testPrint(role, role === 'label' ? { kind: 'zebra' } : {});
    assert.equal(result.code, 'NO_PRINTER_CONFIGURED', role);
  }
  assert.equal(events.jobs.length, 0);
  cleanup();
});

test('testPrint on the label role prints the ZPL test label on printers.label; another kind is refused', async () => {
  const { api, events, cleanup } = setup();
  api.savePrinter('label', { transport: 'system', printerName: 'ZDesigner ZD420', port: '' });
  assert.deepEqual(await api.testPrint('label', { kind: 'zebra' }), { ok: true });
  assert.deepEqual(await api.testPrint('label', undefined), { ok: true }, 'zebra is the default kind');
  assert.equal(events.jobs.length, 2);
  assert.equal(events.jobs[0].target.printerName, 'ZDesigner ZD420');
  assert.equal(events.jobs[0].ext, 'zpl');
  assert.match(events.jobs[0].bytes.toString('utf8'), ZEBRA_TEST);
  assert.equal((await api.testPrint('label', { kind: 'dymo' })).code, 'INVALID_SETTINGS');
  cleanup();
});

test('testPrint on the DYMO role sends the sample label (32x57, design 1) through the DYMO path', async () => {
  const { api, events, cleanup } = setup();
  assert.deepEqual(await api.testPrint('dymo', {}), { ok: true });
  assert.equal(events.dymo.length, 1);
  assert.equal(events.dymo[0].barcodefinal.printer, 'dymo');
  assert.equal(events.dymo[0].size, '32x57');
  assert.equal(events.dymo[0].design, '1');
  assert.equal(events.dymo[0].barcodefinal.title, 'GadgetsPOS test label');
  assert.equal((await api.testPrint('a4', {})).code, 'INVALID_SETTINGS');
  cleanup();
});

// ---- cash drawer -----------------------------------------------------------------------------------------------------------

test('setDrawerPassword needs the current password when one is set, and the new one must meet the 4 to 64 rule', () => {
  const { api, cleanup } = setup();
  assert.equal(api.setDrawerPassword({ current: 'wrong', next: 'brand-new' }).code, 'PASSWORD_WRONG');
  assert.equal(api.setDrawerPassword({ current: '', next: 'brand-new' }).code, 'PASSWORD_REQUIRED');
  assert.equal(api.setDrawerPassword({ current: PASSWORD, next: 'abc' }).code, 'PASSWORD_TOO_SHORT');
  assert.equal(api.setDrawerPassword({ current: PASSWORD, next: 'x'.repeat(65) }).code, 'INVALID_SETTINGS');
  assert.deepEqual(api.setDrawerPassword({ current: PASSWORD, next: 'brand-new' }), { ok: true });
  assert.equal(api.setDrawerPassword({ current: PASSWORD, next: 'another-one' }).code, 'PASSWORD_WRONG', 'the old password no longer works');
  assert.deepEqual(api.setDrawerPassword({ current: 'brand-new', next: 'another-one' }), { ok: true });
  assert.equal(api.setDrawerPassword(undefined).code, 'PASSWORD_REQUIRED', 'a request without a password is not a guess');
  cleanup();
});

test('the first drawer password needs no current one', () => {
  const { api, config, cleanup } = setup({ password: '' });
  assert.deepEqual(api.setDrawerPassword({ current: '', next: 'first-pw' }), { ok: true });
  assert.equal(config.publicState().drawer.passwordSet, true);
  cleanup();
});

test('saveDrawerSettings needs the drawer password, never stores it, and applies the values', () => {
  const { api, config, cleanup } = setup();
  const values = { enabled: false, pin: 5, onTimeMs: 100, offTimeMs: 400, requirePasswordForSettings: false };
  assert.equal(api.saveDrawerSettings({ ...values, password: 'nope' }).code, 'PASSWORD_WRONG');
  assert.equal(config.get('drawer.pin'), 2);
  assert.deepEqual(api.saveDrawerSettings({ ...values, password: PASSWORD }), { ok: true });
  assert.equal(config.get('drawer.pin'), 5);
  assert.equal(config.get('drawer.enabled'), false);
  assert.equal(config.get('drawer.onTimeMs'), 100);
  assert.doesNotMatch(JSON.stringify(config.all().drawer), new RegExp(PASSWORD));
  cleanup();
});

test('saveDrawerSettings refuses pulse times outside 2..510 ms and a pin that is neither 2 nor 5', () => {
  const { api, cleanup } = setup();
  for (const bad of [{ onTimeMs: 1 }, { onTimeMs: 511 }, { offTimeMs: 0 }, { offTimeMs: 12.5 }, { pin: 3 }, { enabled: 'yes' }]) {
    const result = api.saveDrawerSettings({ enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, requirePasswordForSettings: false, ...bad, password: PASSWORD });
    assert.equal(result.code, 'INVALID_SETTINGS', JSON.stringify(bad));
  }
  assert.equal(api.saveDrawerSettings(null).code, 'INVALID_SETTINGS');
  cleanup();
});

test('"ask for the password before Settings opens" needs a password to ask for', () => {
  const { api, config, cleanup } = setup({ password: '' });
  const result = api.saveDrawerSettings({ requirePasswordForSettings: true, password: '' });
  assert.equal(result.ok, false);
  assert.match(result.message, /Set a drawer password first/);
  assert.equal(config.get('drawer.requirePasswordForSettings'), false);
  cleanup();
});

test('openDrawerTest runs the real drawer path: password, pulse bytes, source label', async () => {
  const { api, events, cleanup } = setup();
  api.savePrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  assert.equal((await api.openDrawerTest({ password: 'nope' })).code, 'DRAWER_WRONG_PASSWORD');
  assert.deepEqual(await api.openDrawerTest({ password: PASSWORD }), { ok: true });
  assert.deepEqual([...events.jobs[0].bytes], [0x1b, 0x70, 0x00, 0x19, 0xff]);
  assert.equal((await api.openDrawerTest(undefined)).code, 'PASSWORD_REQUIRED');
  cleanup();
});

test('openDrawerTest says why the drawer cannot open: not set up, or switched off', async () => {
  const none = setup({ password: '' });
  assert.equal((await none.api.openDrawerTest({ password: 'x' })).code, 'DRAWER_PASSWORD_NOT_SET');
  none.cleanup();
  const off = setup();
  off.config.setDrawer({ enabled: false });
  assert.equal((await off.api.openDrawerTest({ password: PASSWORD })).code, 'DRAWER_DISABLED');
  off.cleanup();
});

test('wrong drawer passwords from different Settings dialogs share ONE lockout, and the prompt window is told', async () => {
  const { api, events, passwordWindowState, cleanup } = setup();
  passwordWindowState.open = true;
  for (let i = 0; i < 2; i += 1) assert.equal(api.saveDrawerSettings({ enabled: true, password: 'wrong' }).code, 'PASSWORD_WRONG');
  assert.equal(api.resetAll({ password: 'wrong' }).code, 'PASSWORD_WRONG');
  assert.equal((await api.openDrawerTest({ password: 'wrong' })).code, 'DRAWER_WRONG_PASSWORD');
  const fifth = api.setDrawerPassword({ current: 'wrong', next: 'whatever1' });
  assert.equal(fifth.details.retryAfterSec, 30);
  assert.ok(events.pushes.some(([channel]) => channel === 'desktop:password:lockout'));
  for (const result of [api.saveDrawerSettings({ enabled: true, password: PASSWORD }), api.resetAll({ password: PASSWORD }), await api.openDrawerTest({ password: PASSWORD })]) {
    assert.match(result.code, /LOCKED_OUT/);
    assert.equal(result.details.retryAfterSec, 30);
  }
  cleanup();
});

// ---- connection ------------------------------------------------------------------------------------------------------------

test('saveConnection validates the address and the domains and saves them; no password is asked when Settings is not protected', () => {
  const { api, config, cleanup } = setup();
  assert.deepEqual(api.saveConnection({ serverUrl: 'https://shop.example.com/pos', extraAllowedOrigins: ['*.example.com', 'https://api.partner.co.uk'], password: '' }), { ok: true });
  assert.equal(config.get('serverUrl'), 'https://shop.example.com/pos');
  assert.deepEqual(config.get('extraAllowedOrigins'), ['*.example.com', 'https://api.partner.co.uk']);
  for (const serverUrl of ['http://shop.example.com', 'ftp://x.example.com', 'not a url', '', 'https://user:pw@shop.example.com']) {
    assert.equal(api.saveConnection({ serverUrl, extraAllowedOrigins: [] }).code, 'INVALID_SETTINGS', serverUrl);
  }
  assert.equal(api.saveConnection({ serverUrl: 'https://ok.example.com', extraAllowedOrigins: ['http://insecure.example.com'] }).code, 'INVALID_SETTINGS');
  assert.equal(api.saveConnection('x').code, 'INVALID_SETTINGS');
  cleanup();
});

test('saveConnection asks for the drawer password when "ask for the password before Settings opens" is on', () => {
  const { api, config, cleanup } = setup();
  config.setDrawer({ requirePasswordForSettings: true });
  const request = { serverUrl: 'https://shop.example.com', extraAllowedOrigins: [] };
  assert.equal(api.saveConnection({ ...request, password: '' }).code, 'PASSWORD_REQUIRED');
  assert.equal(api.saveConnection({ ...request, password: 'wrong' }).code, 'PASSWORD_WRONG');
  assert.equal(config.get('serverUrl'), 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy');
  assert.deepEqual(api.saveConnection({ ...request, password: PASSWORD }), { ok: true });
  cleanup();
});

test('retryNow and "Reload POS" start the work and answer at once', async () => {
  const { api, retries, cleanup } = setup();
  assert.deepEqual(api.connection.retryNow(), { ok: true });
  assert.deepEqual(retries, ['retry']);
  cleanup();
});

test('networkOnline tells the connection controller that the network is back, and answers nothing', () => {
  const { api, networkReports, cleanup } = setup();
  assert.equal(api.connection.networkOnline(), undefined);
  assert.deepEqual(networkReports, [true]);
  cleanup();
});

test('openSettings opens the Settings window on a tab, or brings an open one forward', () => {
  const { api, events, settingsState, cleanup } = setup();
  assert.deepEqual(api.connection.openSettings('printers'), { ok: true });
  assert.deepEqual(events.settingsOpens, [{ tab: 'printers' }]);
  assert.equal(settingsState.open, true);
  assert.deepEqual(api.openSettings('about'), { ok: true });
  assert.deepEqual(events.settingsOpens.at(-1), { tab: 'about' });
  assert.equal(events.prompts.length, 0);
  cleanup();
});

test('with "ask for the password before Settings opens" the password window comes first, and Settings follows a correct password', async () => {
  const { api, config, events, passwordPrompt, cleanup } = setup();
  config.setDrawer({ requirePasswordForSettings: true });
  assert.deepEqual(api.connection.openSettings('connection'), { ok: true, details: { prompted: true } });
  assert.deepEqual(events.prompts, [{ purpose: 'settings' }]);
  assert.equal(events.settingsOpens.length, 0);
  assert.equal((await api.password.submit('wrong')).code, 'PASSWORD_WRONG');
  assert.deepEqual(await api.password.submit(PASSWORD), { ok: true });
  assert.deepEqual(events.settingsOpens, [{ tab: 'connection' }]);
  passwordPrompt.dispose();
  cleanup();
});

test('an open Settings window is not asked for the password again: it was authorised when it opened', () => {
  const { api, config, events, settingsState, cleanup } = setup();
  config.setDrawer({ requirePasswordForSettings: true });
  settingsState.open = true;
  assert.deepEqual(api.openSettings('general'), { ok: true });
  assert.equal(events.prompts.length, 0);
  assert.deepEqual(events.settingsOpens, [{ tab: 'general' }]);
  cleanup();
});

test('a window that cannot be opened is an UNKNOWN Result, never a thrown error', () => {
  const { api, cleanup } = setup();
  const failing = createDesktopApiWith({ settingsOpen: () => { throw new Error('no display'); } });
  assert.equal(failing.openSettings('printers').code, 'UNKNOWN');
  cleanup();
});

/** A second API over the same fakes, with the Settings window replaced (to make it fail). */
function createDesktopApiWith({ settingsOpen }) {
  const base = setup();
  const api = createDesktopApi({
    appName: 'x', version: '1', platform: 'win32', arch: 'x64', versions: {}, isPackaged: true,
    config: base.config, drawer: { checkPassword: () => ({ ok: true }), setPassword: () => ({ ok: true }) },
    passwordPrompt: { show() {}, notifyLockout() {}, submit() {}, cancel() {}, getLockout() {} },
    settingsWindow: { isOpen: () => false, open: settingsOpen }, printService: {}, listPrinters: async () => ({}),
    flags: base.flags, argvDisableGpu: false, gpuDisabled: false, perf: { startup: () => ({}) }, updater: { status: () => ({}) },
    connectivity: { status: () => ({}) }, getController: () => null, paths: { userData: '', logsDir: '' },
    openPath: async () => '', writeClipboard() {}, restart() {},
  });
  base.cleanup();
  return api;
}

// ---- general, performance, restart -----------------------------------------------------------------------------------------

test('setGeneral saves the three start-up switches', () => {
  const { api, config, cleanup } = setup();
  assert.deepEqual(api.setGeneral({ openAtLogin: true, startFullScreen: true, keepAwake: false }), { ok: true });
  assert.equal(config.get('startup.openAtLogin'), true);
  assert.equal(config.get('window.startFullScreen'), true);
  assert.equal(config.get('power.keepAwake'), false);
  assert.equal(api.setGeneral({ openAtLogin: 'yes' }).code, 'INVALID_SETTINGS');
  cleanup();
});

test('setPerformance writes flags.json and says a restart is needed when the choice differs from how this run started', () => {
  const { api, flags, cleanup } = setup();
  assert.deepEqual(api.setPerformance({ hardwareAcceleration: false }), { ok: true, restartRequired: true });
  assert.deepEqual(flags.read(), { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: false });
  assert.deepEqual(api.setPerformance({ hardwareAcceleration: true }), { ok: true, restartRequired: false }, 'back to what this run uses');
  assert.deepEqual(flags.read(), { disableGpu: false, disableBrotli: true, reason: '', gpuChecked: false });
  cleanup();
});

test('turning acceleration back on in a run that started in compatibility mode needs a restart', () => {
  const { api, flagsDir, cleanup } = setup({ gpuDisabled: true });
  writeFlags(flagsDir, { disableGpu: true, reason: 'gpu-crashes' });
  assert.deepEqual(api.setPerformance({ hardwareAcceleration: true }), { ok: true, restartRequired: true });
  cleanup();
});

test('a --disable-gpu shortcut always wins, so acceleration cannot be switched on from Settings', () => {
  const { api, flags, cleanup } = setup({ argvDisableGpu: true, gpuDisabled: true });
  const result = api.setPerformance({ hardwareAcceleration: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_SETTINGS');
  assert.match(result.message, /--disable-gpu/);
  assert.equal(flags.read().disableGpu, false);
  assert.equal(api.setPerformance({ hardwareAcceleration: false }).ok, true);
  cleanup();
});

test('setPerformance refuses anything but a boolean and reports an unwritable flags file instead of promising a restart', () => {
  const { api, flagsDir, cleanup } = setup();
  assert.equal(api.setPerformance({ hardwareAcceleration: 'no' }).code, 'INVALID_SETTINGS');
  assert.equal(api.setPerformance(null).code, 'INVALID_SETTINGS');
  fs.rmSync(flagsDir, { recursive: true, force: true });
  fs.writeFileSync(flagsDir, 'a file where the folder should be');
  const result = api.setPerformance({ hardwareAcceleration: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /could not be saved/);
  fs.rmSync(flagsDir, { force: true });
  cleanup();
});

test('restartApp asks for the graceful restart and answers at once', () => {
  const { api, events, cleanup } = setup();
  assert.deepEqual(api.restartApp(), { ok: true });
  assert.equal(events.restarts, 1);
  cleanup();
});

// ---- updates, logs, diagnostics, reset -------------------------------------------------------------------------------------

test('checkForUpdates answers the update status and installUpdate says when there is nothing to install', async () => {
  const { api, updaterState, cleanup } = setup();
  assert.deepEqual(await api.checkForUpdates(), { status: 'none' });
  assert.equal(updaterState.checks, 1);
  updaterState.canInstall = false;
  const nothing = api.installUpdate();
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'UPDATE_UNAVAILABLE');
  updaterState.canInstall = true;
  assert.deepEqual(api.installUpdate(), { ok: true });
  assert.equal(updaterState.installs, 2);
  cleanup();
});

test('openLogsFolder opens the logs folder, and a folder that cannot be opened is a plain failure', async () => {
  const { api, events, flagsDir, setOpenPathResult, cleanup } = setup();
  assert.deepEqual(await api.openLogsFolder(), { ok: true });
  assert.equal(events.paths[0], path.join(flagsDir, 'logs'));
  setOpenPathResult('The file does not exist');
  const failed = await api.openLogsFolder();
  assert.equal(failed.ok, false);
  assert.equal(failed.message, 'The logs folder could not be opened.');
  cleanup();
});

test('copyDiagnostics returns the text, puts it on the clipboard, includes the startup marks and never a password hash or a query string', () => {
  const { api, events, config, cleanup } = setup();
  config.setConnection({ serverUrl: 'https://shop.example.com/pos?token=SECRET-TOKEN' });
  api.savePrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  const text = api.copyDiagnostics();
  assert.deepEqual(events.clipboard, [text]);
  assert.match(text, /^Gadgets POS 2\.0\.0/);
  assert.match(text, /Electron 32\.3\.3, Chromium 128\.0\.6613\.186, Node 20\.18\.1/);
  assert.match(text, /Receipt printer: "EPSON TM-T20"/);
  assert.match(text, /Server: https:\/\/shop\.example\.com\/pos\n/);
  assert.match(text, /password set/);
  assert.match(text, /Startup: process-start 0 ms, loading-visible 0 ms/);
  assert.match(text, /Loading screen in 0 ms\./);
  assert.doesNotMatch(text, /SECRET-TOKEN|scrypt|hash|salt/);
  cleanup();
});

test('resetAll needs the drawer password when one is set, erases the settings including the password, and does not touch flags.json', () => {
  const { api, config, flags, flagsDir, cleanup } = setup();
  api.savePrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
  writeFlags(flagsDir, { disableGpu: true, reason: 'manual' });
  assert.equal(api.resetAll({ password: '' }).code, 'PASSWORD_REQUIRED');
  assert.equal(api.resetAll({ password: 'wrong' }).code, 'PASSWORD_WRONG');
  assert.equal(config.get('printers.receipt.printerName'), 'EPSON TM-T20', 'nothing is erased without the password');
  assert.deepEqual(api.resetAll({ password: PASSWORD }), { ok: true });
  assert.equal(config.get('printers.receipt.printerName'), '');
  assert.equal(config.publicState().drawer.passwordSet, false);
  assert.equal(flags.read().disableGpu, true);
  cleanup();
});

test('with no password set the reset needs none', () => {
  const { api, cleanup } = setup({ password: '' });
  assert.deepEqual(api.resetAll({}), { ok: true });
  assert.deepEqual(api.resetAll(undefined), { ok: true });
  cleanup();
});

test('listPrinters is the lister the app was given', async () => {
  const { api, cleanup } = setup();
  assert.deepEqual(await api.listPrinters(), { system: [], dymo: [] });
  cleanup();
});
