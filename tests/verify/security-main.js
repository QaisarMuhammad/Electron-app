'use strict';

/**
 * Electron main script of the SECURITY verification run (tests/verify/security-e2e.js). It starts the REAL `bootstrap()` of
 * src/main/index.js under real Electron, against a local page, with fakes only for what would touch the machine (the raw
 * printer, DYMO, the system browser, native dialogs and notices). It adds a small control server on 127.0.0.1 so the runner
 * can read what the app did (windows and their options, calls to the system browser).
 *
 * It never takes focus (SPEC 19.8): macOS "accessory" activation policy, `showInactive()` for the app's own windows, and every
 * window the page opens with window.open is created HIDDEN (Electron would otherwise show it with `show()`, which activates the
 * app; the same trick as tests/e2e/launch-app.js). Hidden windows keep every option the page asked for, so what is checked
 * (always-on-top, kiosk, closable, opacity, ...) is still what the app allowed.
 *
 * Environment: GPOS_VERIFY_USER_DATA, GPOS_VERIFY_CONTROL_PORT, GADGETSPOS_START_URL (an http://127.0.0.1 page: trusted because
 * the app is started unpackaged with that one origin as its dev origin).
 *
 * Not named *.test.js: node --test must not run it.
 */

const realElectron = require('electron');

if (process.platform === 'darwin') realElectron.app.setActivationPolicy('accessory');

const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { bootstrap } = require(path.join(ROOT, 'src', 'main', 'index'));
const { ok } = require(path.join(ROOT, 'src', 'main', 'errors'));

const rec = { openExternal: [], rawJobs: [] };

const fakeShell = {
  openExternal: async (url) => { rec.openExternal.push(String(url)); },
  openPath: async () => '',
};
const fakeDialog = {
  showMessageBox: async () => ({ response: 0 }),
  showMessageBoxSync: () => 0,
  showErrorBox: () => {},
};
class FakeNotification {
  static isSupported() { return false; }
}
const electronForApp = new Proxy(realElectron, {
  get(target, prop) {
    if (prop === 'shell') return fakeShell;
    if (prop === 'dialog') return fakeDialog;
    if (prop === 'Notification') return FakeNotification;
    return target[prop];
  },
});

const rawPrinter = {
  async printRaw(job) {
    rec.rawJobs.push({ label: job.label, bytes: job.data.length });
    return ok();
  },
};
// The REAL DYMO service (label plan, script builder, window manager, caches) around a fake hidden window with a fake DYMO framework.
const { createDymoService } = require(path.join(ROOT, 'src', 'main', 'printing', 'dymo'));
const { createWindowFactory } = require(path.join(ROOT, 'tests', 'helpers', 'vm-dymo'));
const dymoWindows = createWindowFactory({ dymo: { printers: [{ name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', isConnected: true }] } });
const dymo = createDymoService({
  createHiddenWindow: () => dymoWindows.createHiddenWindow(),
  labelsDir: path.join(ROOT, 'labels'),
  readFile: (file, encoding) => require('node:fs').promises.readFile(file, encoding),
  getConfig: () => ({}),
  log: {},
});

/** A window the page opens is created by Electron itself and shown with `show()`: ask for it hidden (the app's decision is kept). */
realElectron.app.on('web-contents-created', (_event, contents) => {
  const install = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) => install((details) => {
    const decision = handler(details);
    if (decision && decision.action === 'allow') {
      return { ...decision, overrideBrowserWindowOptions: { ...(decision.overrideBrowserWindowOptions || {}), show: false } };
    }
    return decision;
  });
});

function describe(win) {
  const prefs = win.webContents.getLastWebPreferences();
  return {
    id: win.id,
    url: win.webContents.getURL(),
    alwaysOnTop: win.isAlwaysOnTop(),
    fullScreen: win.isFullScreen(),
    kiosk: win.isKiosk(),
    closable: win.isClosable(),
    movable: win.isMovable(),
    minimizable: win.isMinimizable(),
    focusable: win.isFocusable(),
    opacity: win.getOpacity(),
    frameless: JSON.stringify(win.getBounds()) === JSON.stringify(win.getContentBounds()),
    bounds: win.getBounds(),
    prefs: {
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
      nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
      nodeIntegrationInWorker: prefs.nodeIntegrationInWorker,
      webSecurity: prefs.webSecurity,
      allowRunningInsecureContent: prefs.allowRunningInsecureContent,
      webviewTag: prefs.webviewTag,
      enableBlinkFeatures: prefs.enableBlinkFeatures,
      experimentalFeatures: prefs.experimentalFeatures,
    },
  };
}

const commands = {
  state: () => ({ openExternal: rec.openExternal.slice(), rawJobs: rec.rawJobs.slice() }),
  windows: () => realElectron.BrowserWindow.getAllWindows().map(describe),
  closePopups: () => {
    for (const win of realElectron.BrowserWindow.getAllWindows()) if (win.id !== 1) win.destroy();
    return true;
  },
  clearExternal: () => { rec.openExternal.length = 0; return true; },
};

(async () => {
  const startUrl = process.env.GADGETSPOS_START_URL;
  const handle = await bootstrap({
    electron: electronForApp,
    testMode: true,
    userDataPath: process.env.GPOS_VERIFY_USER_DATA,
    isPackaged: false,
    env: { ...process.env, GADGETSPOS_START_URL: startUrl },
    devOrigins: [new URL(startUrl).origin],
    rawPrinter,
    dymo,
    dialog: fakeDialog,
    getPrintersAsync: async () => [],
  });
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try {
        if (request.url === '/health') {
          response.end(JSON.stringify({ ready: handle !== null }));
          return;
        }
        const { name, args } = JSON.parse(body || '{}');
        response.end(JSON.stringify({ ok: true, value: await commands[name](args || {}) }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ ok: false, error: String((error && error.stack) || error) }));
      }
    });
  });
  server.listen(Number(process.env.GPOS_VERIFY_CONTROL_PORT), '127.0.0.1');
  server.unref();
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exit(1);
});
