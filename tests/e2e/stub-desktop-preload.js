'use strict';
/*
 * Sandbox-safe preload for tests/e2e/ui-shots.js: exposes a MOCK window.desktop (SPEC 6.2) to the local pages.
 *
 * It is ONE self-contained file that only requires 'electron' (SPEC 2: sandboxed preloads cannot load local modules). The
 * fixture comes from the harness: `?fixture=<name>` in the page URL is turned into a JSON object by the main process
 * (ipcMain 'e2e:fixture'), so the page under test cannot tell this from the real preload.
 *
 * Fidelity rules
 *  - Only the areas a real window gets (SPEC 6.3) are exposed: loading/offline = connection + window, settings =
 *    settings + connection + window, password = password + window. A page that reaches for another area fails here.
 *  - Calls are slow like the real thing (fixture.latency / fixture.latencies[method]) so busy and loading states exist.
 *  - The mock enforces the same rules the main process does (password policy, throttle, port check, ranges) closely
 *    enough that the UI only ever shows Result.message; it never invents wording.
 *  - Every call is recorded; the harness reads them through window.__e2e (not part of the product API).
 */
const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(location.search);
const pageName = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');
const fixtureName = params.get('fixture') || 'default';
const fx = ipcRenderer.sendSync('e2e:fixture', { page: pageName, name: fixtureName }) || {};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = [];
let pending = 0;
const subscribers = { state: new Set(), status: new Set(), lockout: new Set() };

/** Wraps an API function: records it, simulates latency, honours fixture.results overrides. */
function api(name, fn) {
  return async (...args) => {
    calls.push({ name, args: clone(args), at: Math.round(performance.now()) });
    pending += 1;
    try {
      await sleep(fx.latencies?.[name] ?? fx.latency ?? 40);
      const forced = fx.results?.[name];
      if (forced !== undefined) return clone(forced);
      return await fn(...args);
    } finally {
      pending -= 1;
    }
  };
}

function emit(kind, payload) {
  for (const cb of subscribers[kind]) {
    try {
      cb(clone(payload));
    } catch (error) {
      console.error('subscriber failed', error);
    }
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Mutable mock state                                                                                                */
/* ---------------------------------------------------------------------------------------------------------------- */

const state = clone(fx.state) || { config: {}, platform: fx.platform || 'win32', version: fx.version || '2.0.0', online: true, update: { status: 'none' }, performance: {} };
const rule = { correct: fx.password?.correct ?? '1234', maxFailures: fx.password?.maxFailures ?? 3, lockSec: fx.password?.lockSec ?? 30 };
let failures = 0;
let lockedUntil = 0;

const pushState = () => emit('state', state);

const lockedResult = () => ({
  ok: false,
  code: 'PASSWORD_LOCKED_OUT',
  message: `Too many wrong passwords. Try again in ${Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000))} seconds.`,
  details: { retryAfterSec: Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000)) },
});

/** Password gate with the SPEC 10 throttle (rule.maxFailures wrong tries lock for rule.lockSec seconds). */
function checkPassword(given, wrongCode = 'PASSWORD_WRONG') {
  if (Date.now() < lockedUntil) return lockedResult();
  if (given === rule.correct) {
    failures = 0;
    return null;
  }
  failures += 1;
  if (failures >= rule.maxFailures) {
    failures = 0;
    lockedUntil = Date.now() + rule.lockSec * 1000;
    emit('lockout', { locked: true, retryAfterSec: rule.lockSec });
    return lockedResult();
  }
  return { ok: false, code: wrongCode, message: 'That password is not correct. Please try again.' };
}

const PORT_RE = /^(\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9 ._()-]+|(\\\\\.\\)?(LPT[1-9]|COM\d{1,3}|PRN):?)$/i;
const BAD_PORT = {
  ok: false,
  code: 'INVALID_SETTINGS',
  message: 'This port name cannot be used. Choose the installed printer, or a shared printer address such as \\\\localhost\\ZebraZD420.',
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* window.desktop                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

const settings = {
  getState: api('settings.getState', async () => clone(state)),
  listPrinters: api('settings.listPrinters', async () => {
    if (fx.printersError) throw new Error(fx.printersError);
    return clone(fx.printers) || { system: [], dymo: [] };
  }),
  savePrinter: api('settings.savePrinter', async (role, value) => {
    if (!['receipt', 'label', 'dymo'].includes(role)) return { ok: false, code: 'INVALID_PAYLOAD', message: 'Unknown printer role.' };
    if (role !== 'dymo' && value.transport === 'port') {
      if (!String(value.port || '').trim() || !PORT_RE.test(String(value.port).trim())) return clone(BAD_PORT);
    } else if (role !== 'dymo' && !String(value.printerName || '').trim()) {
      return { ok: false, code: 'INVALID_SETTINGS', message: 'Choose a printer first.' };
    }
    state.config.printers = state.config.printers || {};
    state.config.printers[role] = clone(value);
    pushState();
    return { ok: true };
  }),
  testPrint: api('settings.testPrint', async (role) => {
    const saved = state.config.printers?.[role] || {};
    if (role !== 'dymo' && !saved.printerName && !saved.port) {
      return { ok: false, code: 'NO_PRINTER_CONFIGURED', message: 'No printer is set up yet. Choose a printer and save it first.' };
    }
    const name = saved.printerName || saved.port || 'the DYMO printer';
    return { ok: true, details: { printer: name } };
  }),
  setDrawerPassword: api('settings.setDrawerPassword', async ({ current, next }) => {
    if (state.config.drawer?.passwordSet) {
      const blocked = checkPassword(current);
      if (blocked) return blocked;
    }
    if (typeof next !== 'string' || next.length < 4) return { ok: false, code: 'PASSWORD_TOO_SHORT', message: 'The password must be 4 to 64 characters long.' };
    if (next.length > 64) return { ok: false, code: 'PASSWORD_TOO_SHORT', message: 'The password must be 4 to 64 characters long.' };
    rule.correct = next;
    state.config.drawer = { ...state.config.drawer, passwordSet: true, passwordWeak: false };
    pushState();
    return { ok: true };
  }),
  saveDrawerSettings: api('settings.saveDrawerSettings', async (value) => {
    if (state.config.drawer?.passwordSet) {
      const blocked = checkPassword(value.password);
      if (blocked) return blocked;
    }
    for (const key of ['onTimeMs', 'offTimeMs']) {
      if (!Number.isFinite(value[key]) || value[key] < 2 || value[key] > 510) {
        return { ok: false, code: 'INVALID_SETTINGS', message: 'Pulse times must be between 2 and 510 milliseconds.' };
      }
    }
    const { password, ...rest } = value;
    state.config.drawer = { ...state.config.drawer, ...rest };
    pushState();
    return { ok: true };
  }),
  openDrawerTest: api('settings.openDrawerTest', async ({ password }) => {
    if (!state.config.drawer?.passwordSet) {
      return { ok: false, code: 'DRAWER_PASSWORD_NOT_SET', message: 'No drawer password is set. Set one in Settings first.' };
    }
    if (state.config.drawer?.enabled === false) return { ok: false, code: 'DRAWER_DISABLED', message: 'The cash drawer is switched off in Settings.' };
    const blocked = checkPassword(password, 'DRAWER_WRONG_PASSWORD');
    if (blocked) return blocked;
    return { ok: true };
  }),
  saveConnection: api('settings.saveConnection', async (value) => {
    if (state.config.drawer?.requirePasswordForSettings && state.config.drawer?.passwordSet) {
      const blocked = checkPassword(value.password);
      if (blocked) return blocked;
    }
    if (!/^https:\/\//i.test(String(value.serverUrl || '')) && !/^http:\/\/localhost/i.test(String(value.serverUrl || ''))) {
      return { ok: false, code: 'INVALID_SETTINGS', message: 'The server address must start with https://' };
    }
    state.config.serverUrl = value.serverUrl;
    state.config.extraAllowedOrigins = clone(value.extraAllowedOrigins) || [];
    pushState();
    return { ok: true };
  }),
  setGeneral: api('settings.setGeneral', async (value) => {
    state.config.startup = { ...state.config.startup, openAtLogin: !!value.openAtLogin };
    state.config.window = { ...state.config.window, startFullScreen: !!value.startFullScreen };
    state.config.power = { ...state.config.power, keepAwake: !!value.keepAwake };
    pushState();
    return { ok: true };
  }),
  setPerformance: api('settings.setPerformance', async ({ hardwareAcceleration }) => {
    state.performance = { ...state.performance, hardwareAcceleration: !!hardwareAcceleration, compatibilityReason: hardwareAcceleration ? '' : state.performance?.compatibilityReason || 'manual' };
    pushState();
    return { ok: true, restartRequired: true };
  }),
  restartApp: api('settings.restartApp', async () => ({ ok: true })),
  checkForUpdates: api('settings.checkForUpdates', async () => {
    state.update = { status: 'checking' };
    pushState();
    await sleep(fx.checkMs ?? 900);
    state.update = clone(fx.checkResult) || { status: 'none' };
    pushState();
    return clone(state.update);
  }),
  installUpdate: api('settings.installUpdate', async () => ({ ok: true })),
  openLogsFolder: api('settings.openLogsFolder', async () => ({ ok: true })),
  copyDiagnostics: api('settings.copyDiagnostics', async () => fx.diagnostics || 'GadgetsPOS 2.0.0\nplatform: win32 x64\nelectron: 32.3.3'),
  resetAll: api('settings.resetAll', async ({ password }) => {
    if (state.config.drawer?.passwordSet) {
      const blocked = checkPassword(password);
      if (blocked) return blocked;
    }
    state.config = clone(fx.resetConfig) || { ...state.config, printers: {}, extraAllowedOrigins: [], drawer: { enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, passwordSet: false } };
    pushState();
    return { ok: true };
  }),
  onState(cb) {
    subscribers.state.add(cb);
    return () => subscribers.state.delete(cb);
  },
};

let connectionStatus = clone(fx.connection?.status) || { online: true, attempt: 0, nextRetryInMs: 0, url: state.config.serverUrl, reason: 'other' };
const connection = {
  getStatus: api('connection.getStatus', async () => clone(connectionStatus)),
  retryNow: api('connection.retryNow', async () => ({ ok: true })),
  openSettings: api('connection.openSettings', async () => ({ ok: true })),
  onStatus(cb) {
    subscribers.status.add(cb);
    return () => subscribers.status.delete(cb);
  },
};

const password = {
  submit: api('password.submit', async (given) => {
    const blocked = checkPassword(given, 'DRAWER_WRONG_PASSWORD');
    if (blocked) return blocked.code === 'PASSWORD_LOCKED_OUT' ? { ...blocked, code: 'DRAWER_LOCKED_OUT' } : blocked;
    return { ok: true };
  }),
  cancel: api('password.cancel', async () => ({ ok: true })),
  getLockout: api('password.getLockout', async () => clone(fx.lockout ?? { locked: false, retryAfterSec: 0 })),
  onLockout(cb) {
    subscribers.lockout.add(cb);
    return () => subscribers.lockout.delete(cb);
  },
};

const win = { close: api('window.close', async () => ({ ok: true })) };

/** The areas each page may reach (SPEC 6.3). */
const AREAS = {
  loading: { connection, window: win },
  offline: { connection, window: win },
  settings: { settings, connection, window: win },
  password: { password, window: win },
};
const exposed = AREAS[pageName] || {};
contextBridge.exposeInMainWorld('desktop', { platform: fx.platform || state.platform || 'win32', version: fx.version || state.version || '2.0.0', ...exposed });

/* Timed pushes declared by the fixture, relative to document start. */
for (const step of fx.connection?.script || []) {
  setTimeout(() => {
    connectionStatus = { ...connectionStatus, ...clone(step.status) };
    emit('status', connectionStatus);
  }, step.at);
}
for (const step of fx.script || []) {
  setTimeout(() => {
    if (step.state) {
      Object.assign(state, clone(step.state));
      pushState();
    }
    if (step.lockout) emit('lockout', step.lockout);
  }, step.at);
}

/** Harness-only hooks (read by tests/e2e/ui-shots.js through executeJavaScript). */
contextBridge.exposeInMainWorld('__e2e', {
  calls: () => clone(calls),
  reset: () => {
    calls.length = 0;
  },
  pending: () => pending,
  emit: (kind, payload) => emit(kind, payload),
  fixture: () => fixtureName,
});
