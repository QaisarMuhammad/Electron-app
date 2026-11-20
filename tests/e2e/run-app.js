'use strict';

/**
 * End-to-end run of the REAL app under Electron (SPEC 17, 19.3):
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/e2e/run-app.js
 *
 * It boots `bootstrap()` of src/main/index.js with the real Electron, the real settings store, the real log and the real windows,
 * against the fake POS of tests/e2e/fake-pos.js (through GADGETSPOS_START_URL, honoured because the app is not packaged). Only the
 * printers, the DYMO service and the native dialogs are fakes, so nothing prints and nothing pops up.
 *
 * It never takes focus: macOS activation policy "accessory" and `showInactive()` come from `testMode`.
 *
 * What it proves in the real app: the loading screen and the POS load; `window.electron` exists on the POS page and `window.desktop`
 * does not; every legacy and new call answers as documented; with the server stopped the offline page appears, its
 * `window.desktop.connection` works and `settings` and `password` are not there; the Settings window opens from the offline page and
 * its area rules hold; the app reconnects by itself when the server returns; the quit is graceful.
 *
 * Exit code 0 when every check passed, 1 when one failed, 3 on the watchdog.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { app } = require('electron');

const { startFakePos } = require('./fake-pos');
const { bootstrap } = require('../../src/main/index');
const passwordTools = require('../../src/main/password');

const WATCHDOG_MS = 120_000;
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  process.stdout.write(`${ok ? 'ok     ' : 'FAILED '} ${name}${ok ? '' : `  ->  ${JSON.stringify(detail)}`}\n`);
}

async function waitFor(condition, label, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await condition()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    process.stderr.write('WATCHDOG: the end-to-end run took too long\n');
    process.exit(3);
  }, WATCHDOG_MS);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-e2e-'));
  const pos = await startFakePos();
  const rawJobs = [];
  const dymoPrints = [];
  const dialogs = [];
  const rawPrinter = {
    async printRaw(job) {
      rawJobs.push({ target: job.target, label: job.label, bytes: Buffer.from(job.data) });
      return { ok: true };
    },
    dispose() {},
  };
  const dymo = {
    async print(payload) {
      dymoPrints.push(payload);
      return { ok: true };
    },
    async listPrinters() {
      return { printers: [{ name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', isConnected: true }] };
    },
    dispose() {},
  };
  const dialog = {
    showMessageBox: async (...args) => (dialogs.push(args), { response: 0 }),
    showMessageBoxSync: () => 0,
    showErrorBox: (title, content) => dialogs.push([title, content]),
  };

  const handle = await bootstrap({
    testMode: true,
    userDataPath: userData,
    isPackaged: false,
    env: { ...process.env, GADGETSPOS_START_URL: pos.url },
    rawPrinter,
    dymo,
    dialog,
  });
  const { config } = handle.services;
  const mainContents = () => handle.controller().window.webContents;
  const consoleErrors = [];
  const watchConsole = (contents, name) => contents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(`${name}: ${message}`);
  });
  watchConsole(mainContents(), 'main');

  // ---- the POS page ----
  const seen = await pos.ready();
  check('the POS page of the fake server loaded in the app window', seen.electron !== undefined);
  check('on the POS page window.electron exists', seen.electron === 'object', seen.electron);
  check('on the POS page window.desktop does NOT exist (SPEC 6.3)', seen.desktop === 'undefined', seen.desktop);
  check('window.electron has every function of SPEC 6.1', JSON.stringify(seen.functions) === JSON.stringify(['getAppInfo', 'getPrinters', 'openCashDrawer', 'printBarcode', 'printReceipt', 'sendBarcodeData', 'sendOpenDrawerCommand', 'sendReceiptData']), seen.functions);

  config.setPrinter('receipt', { transport: 'system', printerName: 'E2E Receipt', port: '' });
  config.setPrinter('label', { transport: 'system', printerName: 'E2E Label', port: '' });
  config.setPasswordRecord(passwordTools.hashPassword('e2e-password'));
  pos.release();
  const report = await pos.report();

  check('printReceipt answers { ok: true }', report.printReceipt && report.printReceipt.ok === true, report.printReceipt);
  check('an empty receipt is INVALID_PAYLOAD', report.printReceiptEmpty && report.printReceiptEmpty.code === 'INVALID_PAYLOAD', report.printReceiptEmpty);
  check('printBarcode (Zebra) answers { ok: true }', report.printBarcodeZebra && report.printBarcodeZebra.ok === true, report.printBarcodeZebra);
  check('printBarcode (DYMO) answers { ok: true }', report.printBarcodeDymo && report.printBarcodeDymo.ok === true, report.printBarcodeDymo);
  check('a wrong drawer password is DRAWER_WRONG_PASSWORD', report.openDrawerWrong && report.openDrawerWrong.code === 'DRAWER_WRONG_PASSWORD', report.openDrawerWrong);
  check('the right drawer password opens the drawer', report.openDrawerRight && report.openDrawerRight.ok === true, report.openDrawerRight);
  check('the Open button request is { ok: true, details: { prompted: true } }', report.openButton && report.openButton.details && report.openButton.details.prompted === true, report.openButton);
  check('getAppInfo is apiVersion 2 with the features', report.appInfo && report.appInfo.apiVersion === 2 && report.appInfo.features.length === 3 && report.appInfo.platform === process.platform, report.appInfo);
  check('getPrinters has the system and DYMO lists', report.printers && Array.isArray(report.printers.system) && report.printers.dymo.length === 1, report.printers);

  await waitFor(() => rawJobs.length >= 5, 'the raw jobs');
  const bytesOf = (label) => rawJobs.filter((job) => job.label === label);
  check('the legacy receipt printed on the receipt printer', rawJobs.some((job) => job.target.printerName === 'E2E Receipt' && job.bytes.length === 8), rawJobs.map((job) => [job.label, job.target.printerName, job.bytes.length]));
  check('the legacy and the acknowledged Zebra labels printed on the label printer', rawJobs.filter((job) => job.target.printerName === 'E2E Label').length === 2, rawJobs.map((job) => [job.label, job.target.printerName]));
  check('the drawer pulse was 1B 70 00 19 FF', bytesOf('cash drawer').length === 1 && [...bytesOf('cash drawer')[0].bytes].join(',') === '27,112,0,25,255', bytesOf('cash drawer').map((job) => [...job.bytes]));
  check('the DYMO label reached the DYMO service', dymoPrints.length === 1 && dymoPrints[0].barcodefinal.title === 'iPhone 13', dymoPrints);
  await waitFor(() => handle.services.passwordWindow.isOpen(), 'the password window from the Open button');
  check('the Open button opened the password window', handle.services.passwordWindow.isOpen());
  handle.services.passwordWindow.close();
  await waitFor(() => !handle.services.passwordWindow.isOpen(), 'the password window to close');
  check('no native error box opened for the calls that succeeded', dialogs.length === 0, dialogs);

  const marks = handle.perf.marks();
  check('the startup marks exist in order', ['process-start', 'app-ready', 'window-created', 'loading-visible', 'config-ready', 'services-ready'].every((name) => name in marks) && marks['loading-visible'] >= marks['window-created'], marks);
  await waitFor(() => handle.perf.has('pos-loaded'), 'pos-loaded');
  process.stdout.write(`startup: ${JSON.stringify(handle.perf.marks())}\n`);

  // ---- the server disappears: the offline page ----
  await pos.stop();
  handle.controller().reload();
  await waitFor(() => /offline\.html/.test(mainContents().getURL()), 'the offline page');
  check('with the server stopped the window shows the offline page, not a blank window', /offline\.html\?reason=/.test(mainContents().getURL()), mainContents().getURL());
  await waitFor(async () => (await mainContents().executeJavaScript('document.readyState')) === 'complete', 'the offline page to finish loading');
  const offline = await mainContents().executeJavaScript(`(async () => ({
    electron: typeof window.electron,
    desktop: typeof window.desktop,
    connection: window.desktop ? Object.keys(window.desktop.connection).sort() : [],
    settings: window.desktop ? typeof window.desktop.settings : 'none',
    password: window.desktop ? typeof window.desktop.password : 'none',
    close: window.desktop ? typeof window.desktop.window.close : 'none',
    status: window.desktop ? await window.desktop.connection.getStatus() : null,
    headline: document.querySelector('#headline') ? document.querySelector('#headline').textContent : '',
  }))()`);
  check('on the offline page window.electron does not exist', offline.electron === 'undefined', offline.electron);
  check('on the offline page window.desktop has ONLY connection and window (SPEC 6.3)', offline.desktop === 'object' && offline.settings === 'undefined' && offline.password === 'undefined' && offline.close === 'function', offline);
  check('the offline page can read the connection status through the trusted channel', offline.status && offline.status.online === false && typeof offline.status.attempt === 'number', offline.status);
  check('the offline page has a headline for the reason', offline.headline.length > 3, offline.headline);

  // ---- Settings from the offline page ----
  const opened = await mainContents().executeJavaScript("window.desktop.connection.openSettings('printers')");
  check('the offline page opened the Settings window', opened && opened.ok === true, opened);
  await waitFor(() => handle.services.settingsWindow.isOpen(), 'the Settings window');
  const settingsContents = handle.services.settingsWindow.getWindow().webContents;
  watchConsole(settingsContents, 'settings');
  await waitFor(async () => (await settingsContents.executeJavaScript("document.body.dataset.state === 'ready'")), 'the Settings page to become ready');
  const inSettings = await settingsContents.executeJavaScript(`(async () => ({
    areas: Object.keys(window.desktop).sort(),
    state: await window.desktop.settings.getState(),
    printers: await window.desktop.settings.listPrinters(),
    password: await window.desktop.password.getLockout(),
    tabs: [...document.querySelectorAll('.nav__item')].length,
    receiptName: document.querySelector('#printers-root') ? document.querySelector('#printers-root').textContent.includes('Receipt printer') : false,
  }))()`);
  check('the Settings page rendered its tabs and the printer cards', inSettings.tabs === 5 && inSettings.receiptName, [inSettings.tabs, inSettings.receiptName]);
  check('the Settings window got the state: saved printer, platform, versions, startup marks', inSettings.state.config.printers.receipt.printerName === 'E2E Receipt' && inSettings.state.platform === process.platform && inSettings.state.versions.electron === process.versions.electron && 'services-ready' in inSettings.state.performance.startup.marks, inSettings.state);
  check('the state never carries the password record', !JSON.stringify(inSettings.state).includes('scrypt'));
  check('listPrinters answers the system and DYMO lists', Array.isArray(inSettings.printers.system) && inSettings.printers.dymo.length === 1, inSettings.printers);
  check('the Settings window is refused the password area (main enforces the area)', inSettings.password && inSettings.password.code === 'UNTRUSTED_SENDER', inSettings.password);

  const tested = await settingsContents.executeJavaScript("window.desktop.settings.testPrint('receipt', {})");
  check('Settings > Printers > Test printed the test slip on the saved printer', tested.ok === true && rawJobs.at(-1).label === 'receipt' && rawJobs.at(-1).bytes.toString('latin1').includes('Printer test'), [tested, rawJobs.at(-1) && rawJobs.at(-1).label]);
  const bad = await settingsContents.executeJavaScript("window.desktop.settings.savePrinter('receipt', { transport: 'port', printerName: '', port: 'C:\\\\evil.txt' })");
  const expectedCode = process.platform === 'win32' ? 'INVALID_SETTINGS' : 'UNSUPPORTED_PLATFORM';
  check(`a port that is a file path is refused (${expectedCode} on this platform: a port exists only on Windows)`, bad.ok === false && bad.code === expectedCode, bad);
  const compat = await settingsContents.executeJavaScript('window.desktop.settings.setPerformance({ hardwareAcceleration: false })');
  const flagsFile = JSON.parse(fs.readFileSync(path.join(userData, 'flags.json'), 'utf8'));
  check('turning hardware acceleration off writes flags.json and asks for a restart', compat.ok === true && compat.restartRequired === true && flagsFile.disableGpu === true, [compat, flagsFile]);
  await settingsContents.executeJavaScript('window.desktop.settings.setPerformance({ hardwareAcceleration: true })');

  // ---- the server returns: the app reconnects by itself ----
  const pos2 = await startFakePos({ port: pos.port });
  const waited = await waitFor(async () => (await pos2.ready().then(() => true, () => false)), 'the app to reconnect', 40_000);
  check(`the app reconnected by itself when the server came back (${waited} ms)`, true);
  await waitFor(() => !/offline\.html/.test(mainContents().getURL()), 'the POS page to replace the offline page');
  check('and the POS page replaced the offline page', /vendor\/point-of-sale/.test(mainContents().getURL()), mainContents().getURL());

  check('no console errors in the app windows', consoleErrors.length === 0, consoleErrors);
  const logFile = path.join(userData, 'logs', 'main.log');
  check('the log file exists in <userData>/logs and has the startup line', fs.existsSync(logFile) && /startup: process-start 0 ms/.test(fs.readFileSync(logFile, 'utf8')), fs.existsSync(logFile));
  const logText = fs.readFileSync(logFile, 'utf8');
  check('the log never contains the drawer password or receipt text', !/e2e-password/.test(logText) && !/Printer test/.test(logText));

  // ---- graceful quit ----
  await pos2.stop();
  const quit = new Promise((resolve) => app.once('quit', resolve));
  app.quit();
  await Promise.race([quit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  clearTimeout(watchdog);

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`e2e run failed: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
