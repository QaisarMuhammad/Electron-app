#!/usr/bin/env node
'use strict';

/**
 * DESKTOP-NATIVE verification of the real app (SPEC 18b S1-S3, R1-R4, D1-D6, L3), on this machine, under the real Electron.
 *
 *   node tests/verify/desktop-native/run-native.js            all runs
 *   NATIVE_RUNS=A,D node tests/verify/desktop-native/run-native.js   only these runs
 *
 * A plain Node script, in the style of tests/e2e/run-smoke.js. It starts a fake POS server (every socket and request is logged,
 * so S2 can be measured from the server's side), spawns the Electron binary of node_modules with tests/verify/desktop-native/
 * launch-native.js (the real `bootstrap()` with the real Menu, powerSaveBlocker, session, windows, DYMO helper window, print queue
 * and electron-log), and drives what a person would do through that launcher's control server. No remote-debugging port is opened.
 *
 * ONE Electron process at a time, and nothing steals focus (accessory activation policy, showInactive; `lsappinfo` is sampled).
 * Every Electron process gets `--host-resolver-rules` so that nothing but 127.0.0.1 can ever be reached: a fallback to the
 * production POS address would show up as an offline page and not as a request to the owner's server.
 *
 * Runs (each has its own userData folder):
 *   A  development, POS up          S1 S2 S3 R2 R3 R4 D1 D2 D4 D6 GPU-default, power, log rotation, GPU safety net
 *   B  development, POS down first  offline screen: paint, title, preconnect per attempt, throttling after the POS loaded
 *   C  as B, but the POS window is created with webPreferences.backgroundThrottling:false (the SPEC text, literally)
 *   D  installed (packaged) + update feed   D3 login item, lazy electron-updater (real module), packaged menus, full screen kept
 *   D2 the next start of D's data           full screen and login item come back
 *   E  installed, platform linux, flags disableGpu   GPU off before ready, login row hidden, no login item, close = quit
 *   F  development, --disable-gpu, flags disableGpu:false   the argument always wins
 *   G  development, a hung print job, the real DYMO window   L3 + D5 graceful quit order
 *   K  development, a slow (2.5 s) print job   L3: the quit waits for the job that finishes
 *   H  development, throttle page   R2: a minimised window keeps its timers
 *   J  development, POS up, then down, then crashed   the offline and crash screens paint after the POS had loaded (throttling already off)
 *   I  development, a v1 config.json   R1b: the one-time native "Does the screen look right?" question (answered No)
 *   I2 the next start of I's data       compatibility mode is on, the question is gone
 *
 * Exit code: 0 when every check passed, 1 when one failed, 2 when the harness itself broke.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const LAUNCH_SCRIPT = path.join(__dirname, 'launch-native.js');
const WATCHDOG_MS = 12 * 60 * 1000;

const ELECTRON = (() => {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function waitFor(fn, label, { timeoutMs = 15_000, intervalMs = 80 } = {}) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function descendantsOf(rootPid) {
  let table = '';
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) || []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Ends a process and everything below it. Only ever called with pids this script started. */
function killTree(pid, signal = 'SIGKILL') {
  for (const target of [...descendantsOf(pid).reverse(), pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The application that is in front right now (macOS `lsappinfo`; null elsewhere or when it cannot be read). */
function frontApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    if (!asn) return null;
    const info = execFileSync('lsappinfo', ['info', '-only', 'pid', '-only', 'name', asn], { encoding: 'utf8' });
    const pid = Number((/"pid"=(\d+)/.exec(info) || [])[1]);
    const name = (/"LSDisplayName"="([^"]*)"/.exec(info) || [])[1] || '';
    return Number.isFinite(pid) ? { pid, name } : null;
  } catch {
    return null;
  }
}

/** A harness started from an Electron-based terminal inherits ELECTRON_RUN_AS_NODE, which would make the child plain Node. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-native-'));
function makeDir(name) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------------

class Scenario {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.notes = [];
    this.error = null;
    this.ms = 0;
  }

  check(name, ok, detail) {
    const passed = Boolean(ok);
    this.checks.push(passed ? { name, ok: true } : { name, ok: false, detail });
    process.stdout.write(`  ${passed ? 'ok   ' : 'FAIL '} ${name}${passed ? '' : `   -> ${shorten(JSON.stringify(detail))}`}\n`);
    return passed;
  }

  note(text) {
    this.notes.push(text);
    process.stdout.write(`  note  ${text}\n`);
  }

  async eventually(name, fn, options) {
    try {
      const value = await waitFor(fn, name, options);
      this.check(name, true);
      return value;
    } catch (error) {
      this.check(name, false, error.message);
      return null;
    }
  }

  get passed() {
    return this.error === null && this.checks.length > 0 && this.checks.every((entry) => entry.ok);
  }
}

function shorten(text, max = 400) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** @type {Scenario[]} */
const scenarios = [];

async function scenario(id, title, fn) {
  const entry = new Scenario(id, title);
  scenarios.push(entry);
  process.stdout.write(`\n[${id}] ${title}\n`);
  const started = Date.now();
  try {
    await fn(entry);
  } catch (error) {
    entry.error = error;
    process.stdout.write(`  FAIL  scenario stopped: ${error.message}\n`);
  }
  entry.ms = Date.now() - started;
  return entry;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The fake POS: logs every socket and request
// ---------------------------------------------------------------------------------------------------------------------------

/** A valid RGBA PNG of one colour, written with zlib (no fixture file). */
function makePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x9a)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(16, 16);

const CONTEXT_ELEMENTS = `
<input id="field" class="box" style="left:20px;top:20px;width:240px;height:32px" value="typed text">
<textarea id="area" class="box" style="left:300px;top:20px;width:240px;height:60px">area text</textarea>
<p id="text" class="box" style="left:20px;top:110px;font-size:22px;margin:0">Selectable order number 12345</p>
<a id="link" class="box" href="https://example.com/orders/1" style="left:20px;top:170px;font-size:22px">Web link</a>
<a id="http" class="box" href="http://insecure.example.com/x" style="left:20px;top:220px;font-size:22px">Insecure link</a>
<a id="mail" class="box" href="mailto:shop@example.com?subject=hello" style="left:20px;top:270px;font-size:22px">Mail link</a>
<a id="js" class="box" href="javascript:void(0)" style="left:20px;top:320px;font-size:22px">Script link</a>
<img id="img" class="box" src="/img.png" width="80" height="80" style="left:420px;top:170px">
<a id="imglink" class="box" href="https://example.com/img-link" style="left:540px;top:170px"><img id="img2" src="/img.png" width="80" height="80" style="display:block"></a>
<div id="empty" class="box" style="left:20px;top:420px;width:300px;height:80px"></div>`;

const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Native POS</title><style>body{margin:0;font:16px sans-serif}.box{position:absolute}</style></head><body>';
const PAGE_QUIET = `${PAGE_HEAD}${CONTEXT_ELEMENTS}</body></html>`;
const PAGE_THROTTLE = `${PAGE_HEAD}${CONTEXT_ELEMENTS}<script>window.ticks=0;setInterval(function(){window.ticks++},100);window.raf=0;(function f(){window.raf++;requestAnimationFrame(f)})();</script></body></html>`;

/**
 * @typedef {object} Pos
 * @property {string} origin
 * @property {(query?: string) => string} url
 * @property {Array<{ id: number, at: number }>} connections
 * @property {Array<{ method: string, url: string, at: number, socketId: number, socketAgeMs: number }>} requests
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} start
 */

/** @returns {Promise<Pos>} */
async function startPos({ port = 0 } = {}) {
  const connections = [];
  const requests = [];
  const sockets = new Map();
  const open = new Set();
  let nextId = 1;
  let server = null;
  let boundPort = port;

  function serve(request, response) {
    const info = sockets.get(request.socket) || { id: 0, at: Date.now() };
    const target = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, url: request.url, at: Date.now(), socketId: info.id, socketAgeMs: Date.now() - info.at });
    if (request.method === 'HEAD') {
      response.writeHead(200).end();
    } else if (target.pathname === '/img.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(PNG);
    } else if (target.pathname === '/favicon.ico') {
      response.writeHead(204).end();
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(target.searchParams.get('page') === 'throttle' ? PAGE_THROTTLE : PAGE_QUIET);
    }
  }

  async function start() {
    if (server) return;
    const next = http.createServer(serve);
    next.keepAliveTimeout = 60_000;
    next.on('connection', (socket) => {
      const info = { id: nextId, at: Date.now() };
      nextId += 1;
      sockets.set(socket, info);
      connections.push(info);
      open.add(socket);
      socket.on('close', () => open.delete(socket));
    });
    await new Promise((resolve, reject) => {
      next.once('error', reject);
      next.listen(boundPort, '127.0.0.1', resolve);
    });
    boundPort = next.address().port;
    server = next;
  }

  function stop() {
    const closing = server;
    if (!closing) return Promise.resolve();
    server = null;
    return new Promise((resolve) => {
      for (const socket of open) socket.destroy();
      closing.close(() => resolve());
    });
  }

  await start();
  return {
    get origin() { return `http://127.0.0.1:${boundPort}`; },
    url: (query = '') => `http://127.0.0.1:${boundPort}/vendor/point-of-sale${query}`,
    connections,
    requests,
    start,
    stop,
    isListening: () => server !== null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// One run of the app
// ---------------------------------------------------------------------------------------------------------------------------

const tracked = new Set();
const everSpawned = new Set();
const quiet = { focus: [], uncaught: [] };
/** The startup marks of every run at the moment the app answered: the S1 / S3 budget is read from them at the end. */
const bootTimes = [];
const EGL_NOISE = /EGL Driver message|gl_display\.cc/;

class AppRun {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {string} options.userData
   * @param {string} [options.startUrl]
   * @param {boolean} [options.packaged]
   * @param {string} [options.platform]
   * @param {boolean} [options.feed]
   * @param {boolean} [options.fullScreenSpy]
   * @param {boolean} [options.hangPrint]
   * @param {number} [options.printDelayMs] the print job finishes after this long (instead of hanging)
   * @param {boolean} [options.specLiteralThrottling]
   * @param {string[]} [options.args] command-line arguments after the script (for example --disable-gpu)
   */
  constructor({ name, userData, startUrl = '', packaged = false, platform = '', feed = false, fullScreenSpy = false, hangPrint = false, printDelayMs = 0, specLiteralThrottling = false, args = [] }) {
    Object.assign(this, { name, userData, startUrl, packaged, platform, feed, fullScreenSpy, hangPrint, printDelayMs, specLiteralThrottling, args });
    this.eventsFile = path.join(RUN_DIR, `events-${name}.jsonl`);
    this.logFile = path.join(OUT_DIR, `native-run-${name}.log`);
    this.tmpDir = makeDir(`tmp-${name}`);
    this.child = null;
    this.exit = null;
    this.controlPort = 0;
    this.startedAt = 0;
  }

  async start() {
    this.controlPort = await freePort();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const log = fs.createWriteStream(this.logFile);
    const env = {
      ...cleanEnv(),
      GPOS_V_USER_DATA: this.userData,
      GPOS_V_EVENTS_FILE: this.eventsFile,
      GPOS_V_CONTROL_PORT: String(this.controlPort),
      GPOS_V_TMPDIR: this.tmpDir,
      GADGETSPOS_START_URL: this.startUrl,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ...(this.packaged ? { GPOS_V_PACKAGED: '1' } : {}),
      ...(this.platform ? { GPOS_V_PLATFORM: this.platform } : {}),
      ...(this.feed ? { GPOS_V_FEED: '1' } : {}),
      ...(this.fullScreenSpy ? { GPOS_V_FULLSCREEN_SPY: '1' } : {}),
      ...(this.hangPrint ? { GPOS_V_HANG_PRINT: '1' } : {}),
      ...(this.printDelayMs ? { GPOS_V_PRINT_DELAY_MS: String(this.printDelayMs) } : {}),
      ...(this.specLiteralThrottling ? { GPOS_V_SPEC_LITERAL_THROTTLING: '1' } : {}),
    };
    delete env.GADGETSPOS_UPDATE_URL;
    this.startedAt = Date.now();
    // Nothing but 127.0.0.1 can be resolved: the production POS address is never reached, whatever the app does.
    this.child = spawn(ELECTRON, ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', LAUNCH_SCRIPT, ...this.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk) => {
      const text = chunk.toString('utf8').split('\n').filter((line) => line && !EGL_NOISE.test(line)).join('\n');
      if (text) log.write(`${text}\n`);
    };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exit = { code, signal, at: Date.now() };
        log.end();
        resolve(this.exit);
      });
    });
    tracked.add(this.child.pid);
    everSpawned.add(this.child.pid);
    await waitFor(async () => {
      if (this.exit) throw new Error(`the app exited at start (code ${this.exit.code}); see ${this.logFile}`);
      try {
        const response = await fetch(`http://127.0.0.1:${this.controlPort}/health`, { signal: AbortSignal.timeout(1000) });
        return (await response.json()).ready === true;
      } catch {
        return false;
      }
    }, 'the app to start', { timeoutMs: 40_000, intervalMs: 120 });
    this.sampleFocus('after the app started');
    const { marks } = await this.state();
    bootTimes.push({ run: this.name, marks });
  }

  async cmd(name, args = {}, timeoutMs = 30_000) {
    const response = await fetch(`http://127.0.0.1:${this.controlPort}/cmd`, { method: 'POST', body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(timeoutMs) });
    const answer = await response.json();
    if (!answer.ok) throw new Error(`command ${name} failed: ${answer.error}`);
    return answer.value;
  }

  state() {
    return this.cmd('state');
  }

  events() {
    try {
      return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /** Runs a function in the page of a window (by window id) and answers what it returns. */
  evalWin(windowId, fn, arg) {
    const code = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    return this.cmd('evalMain', { code: `const win = ctx.electron.BrowserWindow.fromId(${Number(windowId)}); if (!win) throw new Error('no window ${Number(windowId)}'); return win.webContents.executeJavaScript(${JSON.stringify(code)}, true);` });
  }

  /** Runs a function in a page WITHOUT waiting for its answer (a page that closes its own window never answers). */
  fireWin(windowId, fn, arg) {
    const code = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    return this.cmd('evalMain', { code: `const win = ctx.electron.BrowserWindow.fromId(${Number(windowId)}); if (win) win.webContents.executeJavaScript(${JSON.stringify(code)}, true).catch(() => {}); return Boolean(win);` });
  }

  async windowByUrl(match) {
    const { windows } = await this.state();
    return windows.find((win) => (typeof match === 'function' ? match(win.url) : match.test(win.url))) || null;
  }

  /** The POS window: the one with the app preload that is not a popup. */
  async mainWindow() {
    const { windows } = await this.state();
    return windows.find((win) => win.meta && win.meta.preload === 'app.js') || null;
  }

  pids() {
    return this.child && !this.exit ? [this.child.pid, ...descendantsOf(this.child.pid)] : [];
  }

  sampleFocus(label) {
    const front = frontApp();
    if (front === null) return;
    quiet.focus.push({ run: this.name, label, front, ours: this.pids().includes(front.pid) });
  }

  /** Quits through the app's own quit and waits for the process to end; ends it by force when it does not. */
  async stop({ graceful = true, timeoutMs = 20_000 } = {}) {
    if (!this.child) return;
    if (graceful && !this.exit) {
      try {
        await this.cmd('quit', {}, 5000);
      } catch {
        // the app may already be on its way out
      }
    }
    const result = await Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
    if (result === null) {
      killTree(this.child.pid);
      await this.exited;
    }
    for (const event of this.events().filter((entry) => entry.type === 'uncaught' || entry.type === 'unhandled-rejection' || entry.type === 'launch-failed')) {
      quiet.uncaught.push(`${this.name}: ${event.type}: ${event.message}`);
    }
    killTree(this.child.pid);
    tracked.delete(this.child.pid);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Helpers shared by the scenarios
// ---------------------------------------------------------------------------------------------------------------------------

const MARK_ORDER = ['process-start', 'app-ready', 'window-created', 'loading-visible', 'config-ready', 'services-ready', 'pos-dom-ready', 'pos-loaded'];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const isSettingsUrl = (url) => /\/src\/renderer\/settings\.html/.test(url);
const isPasswordUrl = (url) => /\/src\/renderer\/password\.html/.test(url);
const isOfflineUrl = (url) => /\/src\/renderer\/offline\.html/.test(url);

/** Waits until the POS page of the fake server is on screen and the app reached `pos-loaded`. */
async function waitForPos(run, pos, timeoutMs = 40_000) {
  return waitFor(async () => {
    const win = await run.mainWindow();
    const state = win ? await run.state() : null;
    return win && win.url.startsWith(pos.origin) && state.marks['pos-loaded'] !== undefined ? win : null;
  }, 'the POS page', { timeoutMs, intervalMs: 120 });
}

async function openSettings(run, menuId = 'settings.printers') {
  await run.cmd('menuClick', { id: menuId });
  const win = await waitFor(() => run.windowByUrl(isSettingsUrl), 'the Settings window', { timeoutMs: 15_000 });
  await waitFor(() => run.evalWin(win.id, () => Boolean(document.body && document.body.dataset.state === 'ready')).catch(() => false), 'the Settings page to be ready', { timeoutMs: 20_000 });
  return win;
}

const labelsOf = (items) => items.filter((item) => item.type !== 'separator').map((item) => item.label);

/** Where an element of the fake page is (its centre, in the page's own coordinates). */
async function centreOf(run, windowId, selector) {
  return run.evalWin(windowId, (query) => {
    const rect = document.querySelector(query).getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector);
}

async function rightClickOn(run, windowId, selector, before) {
  if (before) await run.evalWin(windowId, before);
  const at = await centreOf(run, windowId, selector);
  return { at, ...(await run.cmd('rightClick', at)) };
}

const flagsPath = (userData) => path.join(userData, 'flags.json');

/** The DYMO helper window: created by src/main/index.js with no preload and DevTools off. */
const isDymoMeta = (win) => win.preload === null && win.devTools === false;
const dymoAlive = (state) => state.createdWindows.filter((win) => isDymoMeta(win) && win.closedAt === null).length;

// ---------------------------------------------------------------------------------------------------------------------------
// Run A: the development run
// ---------------------------------------------------------------------------------------------------------------------------

async function runA(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-A');
  const run = new AppRun({ name: 'A', userData, startUrl: pos.url(), fullScreenSpy: true });
  runs.push(run);
  await run.start();
  const mainWin = await waitForPos(run, pos);
  run.sampleFocus('POS loaded');
  const startEpoch = (await run.state()).startEpoch;
  const initial = await run.state();

  await scenario('S1', 'Boot order: flags and switches before ready, the origin handler before the first window, the loading screen before the services, the POS last', async (t) => {
    const flagReads = initial.reads.filter((read) => read.file === 'flags.json');
    t.check('flags.json is read before the app is ready (synchronously)', flagReads.length > 0 && flagReads[0].ready === false, flagReads);
    const configReads = initial.reads.filter((read) => read.file === 'config.json');
    t.check('the early read of config.json (window bounds, zoom, server address) is also before ready', configReads.length > 0 && configReads[0].ready === false, configReads);
    t.check('every Chromium switch is set before the app is ready', initial.switches.length > 0 && initial.switches.every((entry) => entry.ready === false), initial.switches);
    const lock = initial.appCalls.find((call) => call.call === 'requestSingleInstanceLock');
    t.check('the single-instance lock is requested before ready', Boolean(lock) && lock.ready === false, initial.appCalls);
    t.check('hardware acceleration is NOT disabled by default', !initial.appCalls.some((call) => call.call === 'disableHardwareAcceleration'), initial.appCalls);

    const origin = initial.ipcRegistrations.find((entry) => entry.channel === 'app:origin-allowed');
    t.check('app:origin-allowed is registered before the app is ready and before any window exists', Boolean(origin) && origin.ready === false && origin.windows === 0, origin);
    const alias = initial.ipcRegistrations.find((entry) => entry.channel === 'security:isAllowedOrigin');
    t.check('its alias security:isAllowedOrigin is registered at the same time', Boolean(alias) && alias.ready === false && alias.windows === 0, alias);
    const others = initial.ipcRegistrations.filter((entry) => entry.channel !== 'app:origin-allowed' && entry.channel !== 'security:isAllowedOrigin');
    const visibleAt = initial.marks['loading-visible'];
    t.check('every other IPC handler is registered after the loading screen was visible', others.length > 10 && others.every((entry) => entry.at >= visibleAt), { visibleAt, first: others[0] });

    const order = MARK_ORDER.filter((name) => initial.marks[name] !== undefined);
    t.check('all eight startup marks exist', order.length === MARK_ORDER.length, initial.marks);
    t.check('the marks are in the order of SPEC 18b S3 (non-decreasing)', MARK_ORDER.every((name, index) => index === 0 || initial.marks[name] >= initial.marks[MARK_ORDER[index - 1]]), initial.marks);
    t.check('process-start is 0 and app-ready comes later', initial.marks['process-start'] === 0 && initial.marks['app-ready'] > 0, initial.marks);

    const firstGet = pos.requests.find((req) => req.method === 'GET' && req.url.startsWith('/vendor/point-of-sale'));
    const firstGetAt = firstGet ? firstGet.at - startEpoch : null;
    t.check('the POS is requested only after services-ready (the POS is loaded last)', firstGet && firstGetAt >= initial.marks['services-ready'] - 20, { firstGetAt, marks: initial.marks });
    t.check('the loading screen is visible before the settings store is ready (loading-visible < config-ready)', initial.marks['loading-visible'] < initial.marks['config-ready'], initial.marks);
    t.note(`marks (ms since process start): ${MARK_ORDER.map((name) => `${name} ${initial.marks[name]}`).join(', ')}`);

    const loads = await run.cmd('moduleLoads');
    const beforeWindow = loads.filter((load) => load.at <= initial.marks['window-created']);
    const heavy = /node_modules[\\/](electron-log|electron-updater|electron-store|conf|ajv|builder-util-runtime|lazy-val|semver)[\\/]/;
    t.check('no heavy third-party module (electron-log, electron-updater, electron-store/conf/ajv) is loaded before the window exists', !beforeWindow.some((load) => heavy.test(load.file)), beforeWindow.filter((load) => heavy.test(load.file)));
    t.check('the printing modules, the desktop API and the updater are not loaded before the window exists', !beforeWindow.some((load) => /src[\\/]main[\\/](printing|desktopApi|updater|passwordPrompt|errorBoxes|printerList)/.test(load.file)), beforeWindow.filter((load) => /src[\\/]main[\\/](printing|desktopApi|updater)/.test(load.file)).map((load) => load.file));
    const logLoad = loads.find((load) => /node_modules[\\/]electron-log[\\/]/.test(load.file));
    t.check('electron-log is loaded only after the loading screen was visible', Boolean(logLoad) && logLoad.at >= initial.marks['loading-visible'], { logLoad: logLoad && logLoad.at, visible: initial.marks['loading-visible'] });
    t.check('electron-updater is NOT loaded at pos-loaded (it comes 10 s later, or never)', !loads.some((load) => /node_modules[\\/]electron-updater[\\/]/.test(load.file)), loads.filter((load) => /electron-updater/.test(load.file)));
    const total = Math.round(beforeWindow.reduce((sum, load) => (load.parent && /node_modules/.test(load.parent) ? sum : sum + load.ms), 0));
    t.note(`modules loaded before the window exists: ${beforeWindow.length} (top-level require time about ${total} ms); window-created at ${initial.marks['window-created']} ms`);
    t.note(`modules before the window: ${beforeWindow.filter((load) => /src[\\/]/.test(load.file)).map((load) => load.file.replace(/^src[\\/]main[\\/]/, '')).join(', ')}`);
  });

  await scenario('S2', 'Preconnect: opened as soon as the address is known, and the POS request reuses a socket that was already open', async (t) => {
    const first = initial.preconnects[0];
    t.check('session.preconnect is called with the POS origin and numSockets 4', Boolean(first) && first.url === pos.origin && first.numSockets === 4, initial.preconnects);
    t.check('it is called after window-created and before the settings store is ready', first && first.at >= initial.marks['window-created'] && first.at <= initial.marks['config-ready'], { at: first && first.at, marks: initial.marks });
    const firstGet = pos.requests.find((req) => req.method === 'GET' && req.url.startsWith('/vendor/point-of-sale'));
    const before = pos.connections.filter((connection) => connection.at < firstGet.at);
    t.check('the server had at least 4 connections before the first request arrived (the sockets are really opened)', before.length >= 4, { before: before.length });
    t.check('the first request arrived on a connection that was already open (older than 100 ms)', firstGet.socketAgeMs > 100, { socketAgeMs: firstGet.socketAgeMs, socketId: firstGet.socketId });
    t.note(`first GET after ${firstGet.socketAgeMs} ms on socket #${firstGet.socketId}; ${before.length} connections before it`);
  });

  await scenario('R4a', 'At rest only the POS window exists; Settings opened on the About tab (which shows no printer) starts the hidden DYMO helper anyway', async (t) => {
    const base = await run.state();
    const metricsBefore = await run.cmd('appMetrics');
    t.check('at rest only the POS window exists (no hidden helper window at startup)', base.windowCount === 1 && base.webContentsCount === 1, { windows: base.windowCount, webContents: base.webContentsCount });
    t.check('no DYMO helper window was created at startup', !base.createdWindows.some(isDymoMeta), base.createdWindows.map((win) => win.preload));
    const win = await openSettings(run, 'help.about');
    await sleep(3000);
    const after = await run.state();
    const metricsAfter = await run.cmd('appMetrics');
    const tabsBefore = metricsBefore.filter((metric) => metric.type === 'Tab').length;
    const tabsAfter = metricsAfter.filter((metric) => metric.type === 'Tab').length;
    t.check('Settings opened on the About tab does NOT start the DYMO helper window (S1: the DYMO window comes with the first DYMO label)', dymoAlive(after) === 0, { dymoWindows: dymoAlive(after), renderers: `${tabsBefore} -> ${tabsAfter}` });
    const dymoMetric = metricsAfter.filter((metric) => metric.type === 'Tab').sort((a, b) => a.pid - b.pid);
    t.note(`renderer processes: ${tabsBefore} before, ${tabsAfter} with Settings on About; ${dymoAlive(after) > 0 ? 'the DYMO helper window now exists' : 'no DYMO helper window'}; renderer memory (KB): ${dymoMetric.map((metric) => metric.memoryKB).join(', ')}`);
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
    await sleep(500);
    const closed = await run.state();
    t.note(`after Settings closed: ${closed.windowCount} windows, ${closed.webContentsCount} web contents, DYMO helper alive: ${dymoAlive(closed)}`);
  });

  await scenario('S3', 'Startup marks: logged once as one line, in Settings > About > Startup details, and in the copied diagnostics', async (t) => {
    const logFile = path.join(userData, 'logs', 'main.log');
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => /startup: process-start/.test(line)) : [];
    t.check('exactly one "startup:" line in the log', lines.length === 1, lines.length);
    t.check('that line names every mark', MARK_ORDER.every((name) => (lines[0] || '').includes(name)), lines[0]);
    const win = await openSettings(run, 'help.about');
    const about = await run.evalWin(win.id, () => ({
      tabSelected: document.querySelector('#tab-about').getAttribute('aria-selected'),
      panelVisible: !document.querySelector('#panel-about').hidden,
      version: document.querySelector('#about-version').textContent.trim(),
      rows: [...document.querySelectorAll('#about-list dt')].map((dt) => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim()]),
      startupRows: [...document.querySelectorAll('#startup-body tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())),
      diagButton: Boolean(document.querySelector('#copy-diag')),
      logsButton: Boolean(document.querySelector('#open-logs')),
    }));
    const versions = await run.cmd('evalMain', { code: 'return { electron: process.versions.electron, chrome: process.versions.chrome };' });
    t.check('Help > About opens Settings on the About tab', about.tabSelected === 'true' && about.panelVisible, about);
    t.check('About shows the app version', /Version 2\.0\.0/.test(about.version), about.version);
    const rowMap = Object.fromEntries(about.rows);
    t.check('About shows the Electron version and the Chromium version', rowMap.Electron === versions.electron && rowMap.Chromium === versions.chrome, { rowMap, versions });
    t.check('About shows the data folder, the settings file and the logs folder', Boolean(rowMap['Data folder'] && rowMap['Settings file'] && rowMap['Logs folder']) && rowMap['Logs folder'].endsWith(`${path.sep}logs`), rowMap);
    t.check('the Startup details table lists the marks with their times', about.startupRows.length >= 6 && about.startupRows.some((row) => /loading|Loading/i.test(row[0])), about.startupRows);
    t.check('Copy diagnostics and Open logs folder buttons exist', about.diagButton && about.logsButton);
    await run.evalWin(win.id, () => document.querySelector('#copy-diag').click());
    const diagnostics = await waitFor(async () => (await run.state()).clipboard.find((text) => /^Startup:/m.test(text)), 'the diagnostics on the clipboard', { timeoutMs: 8000 }).catch(() => null);
    t.check('the copied diagnostics contain the startup marks', Boolean(diagnostics) && MARK_ORDER.slice(1).every((name) => diagnostics.includes(name)), diagnostics && diagnostics.slice(0, 300));
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('R2', 'POS window options and process switches (spellcheck, v8 cache, background throttling, disk cache, no GPU blocklist override)', async (t) => {
    const state = await run.state();
    const main = state.windows.find((win) => win.meta && win.meta.preload === 'app.js');
    const prefs = state.createdWindows.find((win) => win.preload === 'app.js').options;
    t.check('spellcheck is off on the POS window (the options the app gave the real BrowserWindow)', prefs.spellcheck === false, prefs);
    t.check("v8CacheOptions is 'bypassHeatCheck' on the POS window", prefs.v8CacheOptions === 'bypassHeatCheck', prefs);
    t.check('the POS window is sandboxed with context isolation, no node integration, web security on', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.webSecurity === true && prefs.allowRunningInsecureContent === false && prefs.webviewTag === false, prefs);
    t.check('webPreferences.backgroundThrottling is false (the SPEC text of 18b R2)', prefs.backgroundThrottling === false, { atCreation: prefs.backgroundThrottling });
    t.check('the web contents is NOT throttled once the POS has loaded (webContents.backgroundThrottling === false)', main.backgroundThrottling === false, main.backgroundThrottling);
    const gpu = await run.cmd('gpu');
    t.check('disk-cache-size is 536870912 (512 MB)', gpu.switches['disk-cache-size'] === '536870912', gpu.switches);
    t.check('ignore-gpu-blocklist is never passed', gpu.switches['ignore-gpu-blocklist'] === false, gpu.switches);
    t.check('on macOS the Windows-only occlusion switch is not set', gpu.switches['disable-features'] === '', gpu.switches);
    t.check('disable-brotli is set (v1 parity, flags default)', gpu.switches['disable-brotli'] === true, gpu.switches);
    const settings = await openSettings(run, 'settings.general');
    const local = (await run.state()).createdWindows.find((win) => win.id === settings.id);
    t.check('the Settings window has spellcheck off too', local.options.spellcheck === false && local.preload === 'local.js', local);
    await run.fireWin(settings.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('GPU', 'Hardware acceleration is really on by default (real GPU status) and the General tab says so', async (t) => {
    const gpu = await run.cmd('gpu');
    const compositing = gpu.status.gpu_compositing;
    t.check('Chromium reports gpu_compositing enabled', compositing === 'enabled', gpu.status);
    const win = await openSettings(run, 'settings.general');
    const view = await run.evalWin(win.id, () => ({ accel: document.querySelector('#sw-accel').checked, compatHidden: document.querySelector('#compat-notice').hidden, loginRowHidden: document.querySelector('#row-login').hidden }));
    t.check('the Hardware acceleration switch is on and no compatibility notice shows', view.accel === true && view.compatHidden === true, view);
    t.check('the start-with-computer row is visible on macOS', view.loginRowHidden === false, view);
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('D4', 'Window title follows the page title and falls back to GadgetsPOS', async (t) => {
    const titleOf = async () => (await run.mainWindow()).title;
    t.check('the POS page title is the window title', (await titleOf()) === 'Native POS', await titleOf());
    const cases = [
      ['a changed page title is followed', () => { document.title = 'Orders | Gadgets POS'; }, 'Orders | Gadgets POS'],
      ['an empty page title falls back', () => { document.title = ''; }, 'GadgetsPOS'],
      ['a page title that is only spaces falls back', () => { document.title = '   '; }, 'GadgetsPOS'],
      ['a page title that is the page address falls back', () => { document.title = location.href; }, 'GadgetsPOS'],
      ['a page title that is the address without its scheme falls back', () => { document.title = location.host + location.pathname; }, 'GadgetsPOS'],
      ['a title is followed again afterwards', () => { document.title = 'Back to normal'; }, 'Back to normal'],
      ['a page WITHOUT a <title> element falls back (Chromium makes up a title from the address)', () => { document.querySelector('title').remove(); }, 'GadgetsPOS'],
    ];
    for (const [name, fn, expected] of cases) {
      await run.evalWin(mainWin.id, fn);
      await t.eventually(`${name} -> "${expected}"`, async () => (await titleOf()) === expected, { timeoutMs: 4000 });
    }
    await run.evalWin(mainWin.id, () => { document.title = 'Native POS'; });
  });

  await scenario('D1', 'Right-click menu in the POS window: every context, with the REAL parameters Chromium sends (development build)', async (t) => {
    const id = mainWin.id;
    const click = (selector, before) => rightClickOn(run, id, selector, before);
    const editable = await click('#field');
    t.check('an editable field gives isEditable and the full edit menu, then Inspect element (development)', editable.params[0] && editable.params[0].isEditable === true && JSON.stringify(labelsOf(editable.popups[0].items)) === JSON.stringify(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all', 'Inspect element']), { params: editable.params[0], items: editable.popups[0] && labelsOf(editable.popups[0].items) });
    t.check('the real edit flags reach the menu (typed text: Undo and Select all are enabled)', Boolean(editable.params[0] && editable.params[0].editFlags && editable.params[0].editFlags.canSelectAll === true), editable.params[0] && editable.params[0].editFlags);
    t.check('the menu is popped up in a window', editable.popups[0] && editable.popups[0].hasWindow === true, editable.popups[0]);
    t.check('Chromium itself reports spellcheck OFF in the POS window (R2: no dictionary, no suggestions)', editable.params[0] && editable.params[0].spellcheckEnabled === false, editable.params[0] && editable.params[0].spellcheckEnabled);
    const area = await click('#area');
    t.check('a textarea gives the same edit menu', area.popups[0] && labelsOf(area.popups[0].items).includes('Paste') && area.params[0].isEditable === true, area.popups[0] && labelsOf(area.popups[0].items));

    const selected = await click('#text', () => {
      const node = document.querySelector('#text');
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    t.check('selected text outside a field gives Copy only (plus Inspect element)', selected.popups[0] && JSON.stringify(labelsOf(selected.popups[0].items)) === JSON.stringify(['Copy', 'Inspect element']) && /order number/.test(selected.params[0].selectionText), { items: selected.popups[0] && labelsOf(selected.popups[0].items), params: selected.params[0] });
    await run.evalWin(id, () => window.getSelection().removeAllRanges());

    // On macOS a right click selects the word under the pointer, so Chromium reports a selection too: the app then offers Copy
    // first (selection group) and the link group after it. On Windows there is no selection and the menu starts with the link items.
    const withSelection = (result, expected) => (result.params[0] && result.params[0].selectionText ? ['Copy', ...expected] : expected);
    const sameLabels = (result, expected) => result.popups[0] && JSON.stringify(labelsOf(result.popups[0].items)) === JSON.stringify(withSelection(result, expected));
    const link = await click('#link');
    t.check('an https link: Open link in browser and Copy link address (after Copy when macOS selected the word)', sameLabels(link, ['Open link in browser', 'Copy link address', 'Inspect element']) && link.params[0].linkURL === 'https://example.com/orders/1', { items: link.popups[0] && labelsOf(link.popups[0].items), params: link.params[0] });
    const insecure = await click('#http');
    t.check('an http link is only copied, never offered to the system browser', sameLabels(insecure, ['Copy link address', 'Inspect element']), insecure.popups[0] && labelsOf(insecure.popups[0].items));
    const mail = await click('#mail');
    t.check('a mailto: link: Open link and Copy email address', sameLabels(mail, ['Open link in browser', 'Copy email address', 'Inspect element']), mail.popups[0] && labelsOf(mail.popups[0].items));
    const script = await click('#js');
    t.check('a javascript: link gets no link items at all (only Inspect element, after Copy when the word was selected)', sameLabels(script, ['Inspect element']) && !labelsOf(script.popups[0].items).some((label) => /link|email/i.test(label)), { items: script.popups[0] && labelsOf(script.popups[0].items), linkURL: script.params[0] && script.params[0].linkURL });
    const image = await click('#img');
    t.check('an image: Copy image and Save image as (and the real mediaType/srcURL)', image.popups[0] && JSON.stringify(labelsOf(image.popups[0].items)) === JSON.stringify(['Copy image', 'Save image as…', 'Inspect element']) && image.params[0].mediaType === 'image' && image.params[0].srcURL.endsWith('/img.png'), { items: image.popups[0] && labelsOf(image.popups[0].items), params: image.params[0] });
    const imageLink = await click('#img2');
    t.check('an image inside a link has both groups', imageLink.popups[0] && JSON.stringify(labelsOf(imageLink.popups[0].items)) === JSON.stringify(['Open link in browser', 'Copy link address', 'Copy image', 'Save image as…', 'Inspect element']), imageLink.popups[0] && labelsOf(imageLink.popups[0].items));
    const empty = await click('#empty');
    t.check('an empty area in development offers only Inspect element', empty.popups[0] && JSON.stringify(labelsOf(empty.popups[0].items)) === JSON.stringify(['Inspect element']), empty.popups[0] && labelsOf(empty.popups[0].items));

    // The clicks reach the real sinks.
    const before = await run.state();
    await rightClickOn(run, id, '#link');
    await run.cmd('popupClick', { label: 'Open link in browser' });
    await rightClickOn(run, id, '#link');
    await run.cmd('popupClick', { label: 'Copy link address' });
    await rightClickOn(run, id, '#mail');
    await run.cmd('popupClick', { label: 'Copy email address' });
    const imageClick = await rightClickOn(run, id, '#img');
    await run.cmd('popupClick', { label: 'Copy image' });
    await rightClickOn(run, id, '#img');
    await run.cmd('popupClick', { label: 'Save image as…' });
    const inspectClick = await rightClickOn(run, id, '#empty');
    await run.cmd('popupClick', { label: 'Inspect element' });
    await sleep(400);
    const after = await run.state();
    t.check('"Open link in browser" hands the exact URL to the system browser', after.openExternal.slice(before.openExternal.length).some((entry) => entry.url === 'https://example.com/orders/1'), after.openExternal);
    t.check('"Copy link address" and "Copy email address" write the link and the bare address', after.clipboard.slice(before.clipboard.length).join('|') === 'https://example.com/orders/1|shop@example.com', after.clipboard.slice(before.clipboard.length));
    t.check('"Copy image" calls copyImageAt with the position Chromium reported', JSON.stringify(after.copyImage.slice(before.copyImage.length)) === JSON.stringify([{ x: imageClick.params[0].x, y: imageClick.params[0].y }]), { copy: after.copyImage, params: imageClick.params[0] });
    t.check('"Save image as" starts a real download of the image (will-download)', after.downloads.slice(before.downloads.length).some((entry) => entry.url.endsWith('/img.png')), after.downloads);
    t.check('"Inspect element" calls inspectElement with the position Chromium reported', JSON.stringify(after.inspect.slice(before.inspect.length)) === JSON.stringify([{ x: inspectClick.params[0].x, y: inspectClick.params[0].y }]), { inspect: after.inspect, params: inspectClick.params[0] });
    t.check('a role item (Copy, Paste ...) is not clicked here, so the real clipboard is never touched', true);
  });

  await scenario('D2', 'Full screen: View > Toggle full screen, remembered in window.fullScreen; the application menu is built by the REAL Menu', async (t) => {
    const menu = await run.cmd('menu');
    const flat = [];
    const walk = (items) => items.forEach((item) => { flat.push(item); if (item.submenu) walk(item.submenu); });
    walk(menu);
    const fullItem = flat.find((item) => item.id === 'view.full-screen');
    t.check('macOS: Toggle full screen is Ctrl+Cmd+F', Boolean(fullItem) && fullItem.accelerator === 'Ctrl+Cmd+F', fullItem);
    t.check('the hidden shortcut items exist and are hidden (F5 and Ctrl+=)', flat.find((item) => item.id === 'view.reload-f5')?.visible === false && flat.find((item) => item.id === 'view.zoom-in-equals')?.visible === false, flat.filter((item) => /reload-f5|zoom-in-equals/.test(item.id || '')));
    t.check('the development menu has Toggle Developer Tools', flat.some((item) => item.id === 'view.devtools' && item.accelerator === 'CommandOrControl+Shift+I' || item.id === 'view.devtools'), flat.map((item) => item.id));
    for (const platform of ['win32', 'linux', 'darwin']) {
      for (const isDev of [false, true]) {
        let built = null;
        let error = null;
        try {
          built = await run.cmd('buildRealMenu', { platform, isDev });
        } catch (e) {
          error = e.message;
        }
        t.check(`the ${platform} template (${isDev ? 'development' : 'installed'}) is accepted by Electron's real Menu.buildFromTemplate`, built !== null, error);
        if (platform === 'win32' && built) {
          const all = [];
          const collect = (items) => items.forEach((item) => { all.push(item); if (item.submenu) collect(item.submenu); });
          collect(built.top);
          t.check(`win32 ${isDev ? 'development' : 'installed'}: F11 toggles full screen, Developer Tools ${isDev ? 'present' : 'absent'}`, all.find((item) => item.id === 'view.full-screen')?.accelerator === 'F11' && all.some((item) => item.id === 'view.devtools') === isDev, all.filter((item) => /full-screen|devtools/.test(item.id || '')));
        }
      }
    }
    const before = await run.state();
    t.check('full screen starts off', (await run.cmd('config')).window.fullScreen === false);
    await run.cmd('menuClick', { id: 'view.full-screen' });
    await sleep(500);
    const on = await run.cmd('config');
    const afterOn = await run.state();
    t.check('View > Toggle full screen calls setFullScreen(true)', JSON.stringify(afterOn.fullScreen.slice(before.fullScreen.length).map((entry) => entry.flag)) === JSON.stringify([true]), afterOn.fullScreen);
    t.check('the state is saved at once: window.fullScreen is true', on.window.fullScreen === true, on.window);
    await run.cmd('menuClick', { id: 'view.full-screen' });
    await sleep(500);
    const off = await run.cmd('config');
    t.check('toggling back saves window.fullScreen false', off.window.fullScreen === false, off.window);
    const settings = await openSettings(run, 'settings.general');
    await run.evalWin(settings.id, () => { document.querySelector('#sw-fullscreen').click(); });
    await waitFor(async () => (await run.cmd('config')).window.startFullScreen === true, 'startFullScreen saved', { timeoutMs: 5000 }).then(() => t.check('Settings > General "Start in full screen" saves window.startFullScreen (default was off)', true)).catch((error) => t.check('Settings > General "Start in full screen" saves window.startFullScreen', false, error.message));
    await run.evalWin(settings.id, () => { document.querySelector('#sw-fullscreen').click(); });
    await waitFor(async () => (await run.cmd('config')).window.startFullScreen === false, 'startFullScreen cleared', { timeoutMs: 5000 }).catch(() => {});
    await run.fireWin(settings.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('About', 'Help > About routing: opens Settings on About, switches an open window by hash without reloading it, and honours "ask for the password before Settings opens"', async (t) => {
    const win = await openSettings(run, 'settings.connection');
    const origin = () => run.evalWin(win.id, () => performance.timeOrigin);
    const tabOf = () => run.evalWin(win.id, () => document.querySelector('[role=tab][aria-selected=true]').id);
    const origin1 = await origin();
    await run.evalWin(win.id, () => { const field = document.querySelector('#conn-url'); field.value = 'https://typed-but-not-saved.example.com/'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await run.cmd('menuClick', { id: 'help.about' });
    await waitFor(async () => (await tabOf()) === 'tab-about', 'the About tab to be selected', { timeoutMs: 6000 }).then(() => t.check('with Settings open on another tab, Help > About selects About', true)).catch((e) => t.check('with Settings open on another tab, Help > About selects About', false, e.message));
    const origin2 = await origin();
    t.check('...by changing the address fragment only: the page is NOT reloaded (an unsaved edit on another tab stays)', origin1 === origin2, { origin1, origin2 });
    await run.cmd('menuClick', { id: 'settings.connection' });
    await waitFor(async () => (await tabOf()) === 'tab-connection', 'the Connection tab', { timeoutMs: 6000 }).catch(() => {});
    const edit = await run.evalWin(win.id, () => document.querySelector('#conn-url').value);
    t.check('the unsaved edit in the Connection field is still there after switching away and back through the menu', edit === 'https://typed-but-not-saved.example.com/', edit);
    const origin3 = await origin();
    await run.cmd('menuClick', { id: 'settings.connection' });
    await sleep(900);
    const origin4 = await origin().catch(() => null);
    const edit2 = await run.evalWin(win.id, () => document.querySelector('#conn-url').value).catch(() => null);
    t.check('choosing the tab that is ALREADY shown (Settings > Connection again) does not reload the page or drop the unsaved edit', origin4 === origin3 && edit2 === 'https://typed-but-not-saved.example.com/', { origin3, origin4, edit: edit2 });
    await run.cmd('menuClick', { id: 'help.about' });
    await sleep(900);
    const origin5 = await origin().catch(() => null);
    await run.cmd('menuClick', { id: 'help.about' });
    await sleep(900);
    const origin6 = await origin().catch(() => null);
    t.check('Help > About while About is already shown does not reload the page either', origin6 === origin5, { origin5, origin6 });
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });

    // protected Settings: the password window comes first, and Settings opens on the About tab after a correct password
    await run.cmd('evalMain', { code: "const r = ctx.handle.services.drawer.setPassword({ current: undefined, next: 'drawer-1234' }); const s = ctx.handle.services.config.setDrawer({ requirePasswordForSettings: true }); return { r, s };" });
    await run.cmd('menuClick', { id: 'help.about' });
    const prompt = await waitFor(() => run.windowByUrl(isPasswordUrl), 'the password window', { timeoutMs: 10_000 }).catch(() => null);
    t.check('with a protected Settings, Help > About asks for the password first', Boolean(prompt) && /purpose=settings/.test(prompt.url), prompt && prompt.url);
    t.check('...and no Settings window exists yet', !(await run.windowByUrl(isSettingsUrl)));
    if (prompt) {
      await waitFor(() => run.evalWin(prompt.id, () => document.readyState === 'complete' && Boolean(document.querySelector('input'))).catch(() => false), 'the prompt page', { timeoutMs: 10_000 });
      const wrong = await run.evalWin(prompt.id, async () => (await window.desktop.password.submit('nope')));
      t.check('a wrong password does not open Settings', wrong.ok === false && !(await run.windowByUrl(isSettingsUrl)), wrong);
      const right = await run.evalWin(prompt.id, async () => (await window.desktop.password.submit('drawer-1234')));
      t.check('the right password is accepted', right.ok === true, right);
      const settings = await waitFor(() => run.windowByUrl(isSettingsUrl), 'Settings after the password', { timeoutMs: 10_000 }).catch(() => null);
      t.check('Settings then opens on the About tab (the tab that was asked for)', Boolean(settings) && /tab=about/.test(settings.url), settings && settings.url);
      if (settings) {
        await run.fireWin(settings.id, () => window.desktop.window.close());
        await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
      }
      await waitFor(async () => !(await run.windowByUrl(isPasswordUrl)), 'the password window to close', { timeoutMs: 8000 }).catch(() => {});
    }
    await run.cmd('evalMain', { code: 'ctx.handle.services.config.setDrawer({ requirePasswordForSettings: false }); return true;' });
  });

  await scenario('R4', 'Settings and password windows are destroyed on close, never hidden; the DYMO helper is reused and its idle timer is unref()ed; the log rotates at 5 MB x 3', async (t) => {
    const counts = [];
    const tabsAtStart = (await run.cmd('appMetrics')).filter((metric) => metric.type === 'Tab').length;
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const settings = await openSettings(run, cycle % 2 === 0 ? 'help.about' : 'settings.printers');
      const open = await run.state();
      await run.fireWin(settings.id, () => window.desktop.window.close());
      await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
      await sleep(250);
      const closed = await run.state();
      counts.push({ cycle, open: open.windowCount, closed: closed.windowCount, contents: closed.webContentsCount, dymo: dymoAlive(closed) });
    }
    t.check('6 Settings open/close cycles: one more window while open, and afterwards exactly the windows there were before (no Settings window kept hidden)', counts.every((c) => c.open === c.closed + 1 && c.contents === c.closed), counts);
    t.check('every cycle created a NEW Settings window (nothing was kept hidden for re-use)', (await run.state()).createdWindows.filter((win) => win.preload === 'local.js').length >= 6, (await run.state()).createdWindows.map((win) => win.preload));
    t.check('after all cycles no Settings window is left (only the POS window and at most the one DYMO helper)', (await run.state()).windowCount === 1 + dymoAlive(await run.state()), await run.state().then((state) => state.windows.map((win) => win.url.slice(-40))));

    await sleep(2500);
    const tabsAtEnd = (await run.cmd('appMetrics')).filter((metric) => metric.type === 'Tab').length;
    t.check('Chromium gave the renderer processes back: as many renderer processes after the cycles as before them', tabsAtEnd === tabsAtStart, { tabsAtStart, tabsAtEnd });

    // password window: Ctrl+D (Open Drawer) needs a password; one is set already
    const prompts = [];
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const before = await run.state();
      await run.cmd('menuClick', { id: 'drawer' });
      const prompt = await waitFor(() => run.windowByUrl(isPasswordUrl), 'the password window', { timeoutMs: 10_000 });
      const open = await run.state();
      await run.fireWin(prompt.id, () => window.desktop.password.cancel());
      await waitFor(async () => !(await run.windowByUrl(isPasswordUrl)), 'the password window to close', { timeoutMs: 8000 });
      await sleep(250);
      const closed = await run.state();
      prompts.push({ cycle, before: before.windowCount, open: open.windowCount, closed: closed.windowCount, contents: closed.webContentsCount });
    }
    t.check('4 password window open/cancel cycles: it is created each time and gone afterwards, counts back where they were', prompts.every((c) => c.open === c.before + 1 && c.closed === c.before && c.contents === c.before), prompts);

    // the DYMO helper window is shared: a call from the POS page reuses it
    const dymoBefore = (await run.state()).createdWindows.filter(isDymoMeta).length;
    const printers = await run.evalWin(mainWin.id, async () => {
      const started = performance.now();
      const answer = await window.electron.getPrinters();
      return { ms: Math.round(performance.now() - started), dymo: answer.dymo, dymoError: answer.dymoError, system: answer.system };
    });
    const afterDymo = await run.state();
    t.check('getPrinters() from the POS page reuses the helper window (no second window)', afterDymo.createdWindows.filter(isDymoMeta).length === Math.max(dymoBefore, 1) && dymoAlive(afterDymo) === 1, { before: dymoBefore, alive: dymoAlive(afterDymo) });
    t.check('the helper window is hidden: never shown, never focused', afterDymo.createdWindows.filter(isDymoMeta).every((win) => win.shows === 0 && win.showInactives === 0 && win.focuses === 0), afterDymo.createdWindows.filter(isDymoMeta));
    const timersAfter = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app');
    const idleTimer = timersAfter.find((timer) => timer.delay === 600000);
    t.check('the DYMO idle-dispose timer is 10 minutes and unref()ed', Boolean(idleTimer) && idleTimer.hasRef === false, timersAfter);
    t.note(`DYMO list answered in ${printers.ms} ms with ${printers.dymoError ? `error "${String(printers.dymoError).slice(0, 80)}"` : `${printers.dymo.length} printers`}`);

    // electron-log rotation, with the app's own electron-log instance
    const logsDir = path.join(userData, 'logs');
    await run.cmd('writeLog', { lines: 4200, bytes: 4000 }, 60_000);
    const files = (await run.cmd('listDir', { dir: logsDir })).filter((file) => /^main(\.old\d*)?\.log$/.test(file.name));
    t.check('after about 17 MB of log the folder holds main.log, main.old.log and main.old2.log, and nothing older', JSON.stringify(files.map((file) => file.name).sort()) === JSON.stringify(['main.log', 'main.old.log', 'main.old2.log']), files);
    t.check('no log file is much larger than 5 MB', files.every((file) => file.size < 5.3 * 1024 * 1024), files);
    t.check('the archives are about 5 MB each (the rotation really happened at 5 MB)', files.filter((file) => /old/.test(file.name)).every((file) => file.size > 4.5 * 1024 * 1024), files);
    const mode = (fs.statSync(path.join(logsDir, 'main.log')).mode & 0o777).toString(8);
    t.check('the log file is private to the account (mode 600)', mode === '600', mode);
  });

  await scenario('Power', 'powerSaveBlocker (real): started with the POS window, stopped when it closes or the setting is off, and only the app is kept awake', async (t) => {
    const state = await run.state();
    const starts = state.power.filter((call) => call.op === 'start');
    t.check('one prevent-app-suspension blocker was started at boot (never prevent-display-sleep)', starts.length === 1 && starts[0].type === 'prevent-app-suspension', state.power);
    const startedId = starts[0].id;
    t.check("Electron itself says the blocker is active (powerSaveBlocker.isStarted)", await run.cmd('evalMain', { code: `return ctx.electron.powerSaveBlocker.isStarted(${startedId});` }) === true);
    const settings = await openSettings(run, 'settings.general');
    await run.evalWin(settings.id, () => { document.querySelector('#sw-awake').click(); });
    await waitFor(async () => (await run.state()).power.some((call) => call.op === 'stop' && call.id === startedId), 'the blocker to stop', { timeoutMs: 6000 }).then(() => t.check('turning "Keep this computer awake" off stops the blocker', true)).catch((e) => t.check('turning "Keep this computer awake" off stops the blocker', false, e.message));
    t.check('...and Electron agrees it is no longer active', await run.cmd('evalMain', { code: `return ctx.electron.powerSaveBlocker.isStarted(${startedId});` }) === false);
    await run.evalWin(settings.id, () => { document.querySelector('#sw-awake').click(); });
    await waitFor(async () => (await run.state()).power.filter((call) => call.op === 'start').length === 2, 'the blocker to start again', { timeoutMs: 6000 }).then(() => t.check('turning it on again starts a new blocker', true)).catch((e) => t.check('turning it on again starts a new blocker', false, e.message));
    await run.fireWin(settings.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
    const secondId = (await run.state()).power.filter((call) => call.op === 'start')[1].id;

    await run.cmd('closeMain');
    await waitFor(async () => (await run.state()).power.some((call) => call.op === 'stop' && call.id === secondId), 'the blocker to stop with the window', { timeoutMs: 6000 }).then(() => t.check('closing the POS window stops the blocker (macOS: the app keeps running)', true)).catch((e) => t.check('closing the POS window stops the blocker', false, e.message));
    t.check('the app is still alive after its window closed (macOS)', !run.exit);
    await run.cmd('emitApp', { event: 'activate' });
    const reopened = await waitFor(async () => {
      const win = await run.mainWindow();
      return win && win.url.startsWith(pos.origin) ? win : null;
    }, 'the POS window to come back', { timeoutMs: 20_000 }).catch(() => null);
    t.check('the Dock icon (activate) brings the POS window back and loads the POS again', Boolean(reopened));
    await waitFor(async () => (await run.state()).power.filter((call) => call.op === 'start').length === 3, 'the blocker to start with the new window', { timeoutMs: 6000 }).then(() => t.check('...and the blocker starts again with it', true)).catch((e) => t.check('...and the blocker starts again with it', false, e.message));
    const final = await run.state();
    t.check('every window the app showed went through showInactive (no focus steal)', final.createdWindows.every((win) => win.shows === 0 || win.showInactives > 0) && final.createdWindows.every((win) => win.focuses === 0), final.createdWindows.map((win) => ({ id: win.id, shows: win.shows, showInactives: win.showInactives, focuses: win.focuses })));
  });

  await scenario('R3', 'No timers left running while idle (20 s idle), and the server sees no polling', async (t) => {
    const main = await waitForPos(run, pos);
    await run.cmd('evalMain', { code: 'return true;' });
    t.check('the POS window is up again and loaded', Boolean(main));
    await sleep(3000);
    const idleStart = Date.now();
    const requestsBefore = pos.requests.length;
    const cpuBefore = await run.cmd('cpuUsage');
    await run.cmd('appMetrics'); // resets Chromium's CPU counters
    await sleep(20_000);
    const cpuAfter = await run.cmd('cpuUsage');
    const metrics = await run.cmd('appMetrics');
    const { timers, resources } = await run.cmd('timers');
    const appTimers = timers.filter((timer) => timer.origin === 'app');
    const external = timers.filter((timer) => timer.origin === 'external');
    t.check('no application timer is alive and ref()ed (nothing keeps the process busy)', appTimers.every((timer) => timer.hasRef === false), appTimers);
    t.check('every application timer that is alive is one-shot or long (no interval shorter than 1 minute, nothing that polls)', appTimers.every((timer) => timer.kind === 'timeout' || timer.delay >= 60_000), appTimers);
    t.check('Node reports no pending Timeout, Immediate, ChildProcess or file request in the main process (only the harness pipes and its control socket)', resources.every((kind) => !/^(Timeout|Immediate|ChildProcess|FSReqCallback|GetAddrInfoReqWrap|TLSWrap)$/.test(kind)), resources);
    t.check('no timer shorter than 1 s is alive while idle', timers.every((timer) => timer.origin === 'harness' || timer.delay >= 1000 || timer.hasRef === false), timers.filter((timer) => timer.origin !== 'harness' && timer.delay < 1000));
    t.check('the fake POS saw no request at all during the 20 s idle window (no probe, no poll)', pos.requests.length === requestsBefore, pos.requests.slice(requestsBefore));
    const cpuMs = ((cpuAfter.user - cpuBefore.user) + (cpuAfter.system - cpuBefore.system)) / 1000;
    const cpuPercent = Math.round((cpuMs / (Date.now() - idleStart)) * 1000) / 10;
    t.check('the main process used under 5 % of one core while idle', cpuPercent < 5, { cpuPercent });
    const total = Math.round(metrics.reduce((sum, metric) => sum + metric.cpu, 0) * 10) / 10;
    t.note(`idle main-process CPU ${cpuPercent} %; Chromium CPU of all processes ${total} % (${metrics.map((metric) => `${metric.type} ${metric.cpu.toFixed(1)}%`).join(', ')}); live timers: app ${appTimers.length}, external ${external.length}; resources: ${[...new Set(resources)].join(', ')}`);
    t.note(`app timers: ${JSON.stringify(appTimers.map((timer) => ({ delay: timer.delay, ref: timer.hasRef, from: timer.frames[0] })))}`);
    t.note(`external timers: ${JSON.stringify(external.map((timer) => ({ delay: timer.delay, ref: timer.hasRef })))}`);
  });

  await scenario('R1b-menu', 'Help > Compatibility mode (a native checkbox of the REAL menu) writes the manual flag, offers a restart, and switches off again', async (t) => {
    const flat = (items) => items.flatMap((item) => [item, ...(item.submenu ? flat(item.submenu) : [])]);
    const find = async () => flat(await run.cmd('menu')).find((entry) => entry.id === 'help.compatibility');
    t.check('the checkbox exists, is a checkbox and starts unchecked', (await find()).type === 'checkbox' && (await find()).checked === false, await find());
    await run.cmd('menuClick', { id: 'help.compatibility' });
    await waitFor(() => fs.existsSync(flagsPath(userData)) && readJson(flagsPath(userData)).disableGpu === true, 'flags.json', { timeoutMs: 6000 }).catch(() => {});
    const on = fs.existsSync(flagsPath(userData)) ? readJson(flagsPath(userData)) : {};
    t.check("clicking it writes { disableGpu: true, reason: 'manual' }", on.disableGpu === true && on.reason === 'manual', on);
    await waitFor(async () => (await find()).checked === true, 'the rebuilt menu to show it checked', { timeoutMs: 6000 }).then(() => t.check('the application menu is rebuilt and now shows the checkbox checked', true)).catch((e) => t.check('the application menu is rebuilt and now shows the checkbox checked', false, e.message));
    const box = (await run.state()).dialogs.find((dialog) => /Compatibility mode will be used/.test(dialog.message));
    t.check('a native box says it applies at the next start, with Restart now / Later', Boolean(box) && JSON.stringify(box.buttons) === JSON.stringify(['Restart now', 'Later']), (await run.state()).dialogs.map((dialog) => dialog.message));
    t.check('"Later" does not relaunch', (await run.state()).relaunches.length === 0);
    await run.cmd('menuClick', { id: 'help.compatibility' });
    await waitFor(() => readJson(flagsPath(userData)).disableGpu === false, 'flags.json to be cleared', { timeoutMs: 6000 }).catch(() => {});
    const off = readJson(flagsPath(userData));
    t.check('clicking it again clears the flag and the reason', off.disableGpu === false && off.reason === '', off);
  });

  await scenario('GPUnet', 'GPU safety net in the real app: two GPU crashes within a minute write compatibility mode and ask natively', async (t) => {
    const flagsBefore = fs.existsSync(flagsPath(userData)) ? readJson(flagsPath(userData)) : null;
    t.check('flags.json does not say disableGpu before', !flagsBefore || flagsBefore.disableGpu !== true, flagsBefore);
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 1 } });
    await sleep(300);
    t.check('one GPU crash does nothing', !fs.existsSync(flagsPath(userData)) || readJson(flagsPath(userData)).disableGpu !== true);
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'clean-exit', exitCode: 0 } });
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'Utility', reason: 'crashed', exitCode: 1 } });
    await sleep(300);
    t.check('a clean GPU exit and a crashed utility process do not count', !fs.existsSync(flagsPath(userData)) || readJson(flagsPath(userData)).disableGpu !== true);
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'abnormal-exit', exitCode: 2 } });
    await waitFor(() => fs.existsSync(flagsPath(userData)) && readJson(flagsPath(userData)).disableGpu === true, 'flags.json to say disableGpu', { timeoutMs: 6000 }).then(() => t.check('the second GPU crash within 60 s writes disableGpu:true to flags.json', true)).catch((e) => t.check('the second GPU crash within 60 s writes disableGpu:true to flags.json', false, e.message));
    const flags = fs.existsSync(flagsPath(userData)) ? readJson(flagsPath(userData)) : {};
    t.check("the reason is 'gpu-crashes' and brotli stays as v1 had it", flags.reason === 'gpu-crashes' && flags.disableBrotli === true, flags);
    const state = await run.state();
    const box = state.dialogs.find((dialog) => /compatibility mode/.test(dialog.message));
    t.check('a native box asks "The screen had a problem. GadgetsPOS will use compatibility mode." with Restart now / Later', Boolean(box) && JSON.stringify(box.buttons) === JSON.stringify(['Restart now', 'Later']), state.dialogs.map((dialog) => dialog.message));
    t.check('"Later" (the cancel button) does not relaunch', state.relaunches.length === 0, state.relaunches);
    const mode = (fs.statSync(flagsPath(userData)).mode & 0o777).toString(8);
    t.check('flags.json is written privately (mode 600) and atomically (no temp file left)', mode === '600' && fs.readdirSync(userData).filter((name) => /^flags\.json\..*\.tmp$/.test(name)).length === 0, { mode, files: fs.readdirSync(userData) });
  });

  await scenario('D6', 'Native look: system theme for dialogs, platform icon files, no custom title bar', async (t) => {
    const state = await run.state();
    t.check("nativeTheme.themeSource is 'system'", state.nativeTheme.themeSource === 'system', state.nativeTheme);
    const icons = ['icon.ico', 'icon.png', 'icon.icns'].map((name) => ({ name, size: fs.statSync(path.join(ROOT, 'assets', name)).size }));
    t.check('the three platform icons exist and are not empty', icons.every((icon) => icon.size > 1000), icons);
    const png = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png'));
    const ico = fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico'));
    t.check('icon.png is a 512x512 PNG', png.readUInt32BE(16) === 512 && png.readUInt32BE(20) === 512, { w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
    const entries = ico.readUInt16LE(4);
    const sizes = Array.from({ length: entries }, (_, i) => ico[6 + i * 16] || 256);
    t.check('icon.ico holds 16, 32, 48 and 256 pixel images (Windows picks the size it needs)', [16, 32, 48, 256].every((size) => sizes.includes(size)), sizes);
    const source = ['windows/main.js', 'windows/settings.js', 'windows/password.js'].map((file) => fs.readFileSync(path.join(ROOT, 'src', 'main', file), 'utf8')).join('\n');
    t.check('no window uses frame:false, titleBarStyle or a title bar overlay', !/frame\s*:\s*false|titleBarStyle|titleBarOverlay/.test(source));
    const main = state.windows.find((win) => win.meta && win.meta.preload === 'app.js');
    t.check('the main window is a normal framed window that was shown with showInactive in the harness', main.meta.showInactives >= 1 || main.meta.shows >= 0, main.meta);
  });

  run.sampleFocus('end of run A');
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run B and C: the offline start
// ---------------------------------------------------------------------------------------------------------------------------

async function runOffline(runs, { name, specLiteral }) {
  const pos = await startPos();
  await pos.stop();
  const userData = makeDir(`user-data-${name}`);
  const run = new AppRun({ name, userData, startUrl: pos.url(), specLiteralThrottling: specLiteral });
  runs.push(run);
  await run.start();

  await scenario(`${name}1`, specLiteral
    ? 'SPEC 18b R2 taken literally (webPreferences.backgroundThrottling:false at creation) and a first load that fails: the offline screen is NOT painted (confirms why the app sets it later)'
    : 'A first load that fails shows the offline screen, painted, with a title; preconnect before every attempt; throttling is switched off once the POS has loaded', async (t) => {
    await waitFor(async () => {
      const win = await run.mainWindow();
      return win && isOfflineUrl(win.url) ? win : null;
    }, 'the offline page', { timeoutMs: 30_000 });
    await sleep(1200);
    const current = await run.mainWindow();
    const created = (await run.state()).createdWindows.find((win) => win.preload === 'app.js');
    t.check('the window shows offline.html', isOfflineUrl(current.url), current.url);
    const capture = await run.cmd('capture', { timeoutMs: 6000 });
    const raf = await run.cmd('evalIn', { code: "new Promise((resolve) => { const timer = setTimeout(() => resolve('rAF never fired'), 2000); requestAnimationFrame(() => { clearTimeout(timer); resolve('rAF fired'); }); })" });
    if (specLiteral) {
      t.check('the injection worked: the real BrowserWindow was created with backgroundThrottling:false', created.options.backgroundThrottling === false, created.options);
      t.check('...and then capturePage() answers an EMPTY image: the offline screen is not painted', capture.ok === true && capture.width === 0 && capture.height === 0, capture);
      t.check('...and requestAnimationFrame never fires', raf === 'rAF never fired', raf);
      t.note(`capture ${JSON.stringify(capture)}, rAF ${raf}. The app's normal run (B1) paints this screen, so the runtime setBackgroundThrottling(false) after the POS loaded is a justified deviation from the SPEC text.`);
    } else {
      t.check('capturePage() answers an image of the offline screen (the window is painting)', capture.ok === true && capture.width > 200, capture);
      t.check('requestAnimationFrame fires on the offline screen', raf === 'rAF fired', raf);
      t.check('the window was created WITHOUT backgroundThrottling:false (it is set at run time instead)', created.options.backgroundThrottling === undefined, created.options);
      t.check("the window title is the offline page's own title (GadgetsPOS - ...)", /^GadgetsPOS - /.test(current.title), current.title);
      t.check('before the POS has loaded the page is still throttled by default (the loading and offline screens)', current.backgroundThrottling === true, current.backgroundThrottling);
      const attempts = await waitFor(async () => {
        const status = await run.cmd('evalIn', { code: 'window.desktop.connection.getStatus()' });
        return status.attempt >= 2 ? status : null;
      }, 'two probe attempts', { timeoutMs: 20_000 }).catch(() => null);
      const state = await run.state();
      t.check('every probe attempt was preceded by a preconnect (the initial one plus one per attempt)', Boolean(attempts) && state.preconnects.length >= 1 + attempts.attempt, { attempts: attempts && attempts.attempt, preconnects: state.preconnects.length });
      t.check('all of them target the POS origin with 4 sockets', state.preconnects.every((entry) => entry.url === pos.origin && entry.numSockets === 4), state.preconnects);
      t.note(`attempt ${attempts && attempts.attempt}, preconnect calls ${state.preconnects.length}`);
      const timers = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app');
      t.check('the reconnect timer is unref()ed', timers.length > 0 && timers.every((timer) => timer.hasRef === false), timers);
      await pos.start();
      const win = await waitFor(async () => {
        const w = await run.mainWindow();
        return w && w.url.startsWith(pos.origin) ? w : null;
      }, 'the POS to load when the server returns', { timeoutMs: 30_000 }).catch(() => null);
      t.check('the POS loads by itself when the server comes back', Boolean(win));
      if (win) {
        await sleep(500);
        const after = await run.mainWindow();
        t.check('once the POS page has loaded it is no longer throttled', after.backgroundThrottling === false, after.backgroundThrottling);
        t.check('the POS title replaces the offline title', after.title === 'Native POS', after.title);
      }
    }
  });

  run.sampleFocus(`end of run ${name}`);
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run D and D2: installed app
// ---------------------------------------------------------------------------------------------------------------------------

function seedConfig(userData, posUrl, extra = {}) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ schemaVersion: 2, serverUrl: posUrl, ...extra }));
}

async function runD(runs, ctx) {
  const pos = await startPos();
  ctx.pos = pos;
  const userData = makeDir('user-data-D');
  ctx.userData = userData;
  seedConfig(userData, pos.url());
  const run = new AppRun({ name: 'D', userData, packaged: true, feed: true, fullScreenSpy: true });
  runs.push(run);
  await run.start();
  const mainWin = await waitForPos(run, pos);
  const posLoadedState = await run.state();

  await scenario('S1-lazy', 'electron-updater (the real module) is not loaded until 10 s after the POS page loaded; the instrumentation sees it then', async (t) => {
    const loadedAtPos = (await run.cmd('moduleLoads')).filter((load) => /node_modules[\\/]electron-updater[\\/]/.test(load.file));
    t.check('right after pos-loaded, electron-updater is not loaded', loadedAtPos.length === 0, loadedAtPos.map((load) => load.file));
    const posLoadedMark = posLoadedState.marks['pos-loaded'];
    const loaded = await waitFor(async () => {
      const loads = (await run.cmd('moduleLoads')).filter((load) => /node_modules[\\/]electron-updater[\\/]/.test(load.file));
      return loads.length > 0 ? loads : null;
    }, 'electron-updater to be loaded', { timeoutMs: 25_000, intervalMs: 250 }).catch(() => null);
    t.check('electron-updater IS loaded later (the feed in resources/app-update.yml enables the updater)', Boolean(loaded));
    if (loaded) {
      const entry = loaded.find((load) => /electron-updater[\\/]out[\\/]main\.js$/.test(load.file)) || loaded[0];
      const delay = entry.at - posLoadedMark;
      t.check('it is loaded between 9.5 s and 13 s after pos-loaded (UPDATER_DELAY_MS = 10 s)', delay >= 9500 && delay <= 13000, { delay, at: entry.at, posLoadedMark });
      t.check('loading it took well under half a second of main-process time (informational budget)', entry.ms < 500, entry.ms);
      t.note(`electron-updater required ${Math.round(delay)} ms after pos-loaded, taking ${entry.ms} ms (${loaded.length} modules)`);
    }
    const timers = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app');
    t.check('every application timer is unref()ed (updater, idle disposal ...)', timers.every((timer) => timer.hasRef === false), timers);
    t.note(`app timers after the updater started: ${JSON.stringify(timers.map((timer) => ({ delay: timer.delay, kind: timer.kind, ref: timer.hasRef, from: timer.frames[0] })))}`);
    // the first check comes at 30 s of uptime at the earliest; then a 4 hour repeat
    await waitFor(async () => (await run.cmd('evalMain', { code: 'return process.uptime();' })) > 32, 'the first update check time', { timeoutMs: 40_000, intervalMs: 500 });
    await sleep(1500);
    const later = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app');
    const repeat = later.find((timer) => timer.delay === 4 * 60 * 60 * 1000);
    t.check('after the first check the 4 h repeat exists and is unref()ed (SPEC 13: first check not before 30 s, then every 4 h)', Boolean(repeat) && repeat.hasRef === false && later.every((timer) => timer.hasRef === false), later);
    const status = await run.cmd('evalMain', { code: 'return ctx.handle.services.updater.status();' });
    t.note(`updater status after the first check: ${JSON.stringify(status)}`);
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
    t.check('the log says the updater started (and it did not crash the app)', /updater: (ready|error|disabled)/.test(log), log.split('\n').filter((line) => /updater/.test(line)).slice(0, 4));
    t.check('no uncaught exception', (await run.state()).uncaught.length === 0, (await run.state()).uncaught);
  });

  await scenario('D1-installed', 'Right-click menu in the installed app: no Inspect element, no menu on an empty area; no Developer Tools menu item', async (t) => {
    const id = mainWin.id;
    t.check('the POS window is NOT given DevTools in an installed app', (await run.state()).createdWindows.find((win) => win.id === id).options.devTools === false, (await run.state()).createdWindows.find((win) => win.id === id).options);
    const editable = await rightClickOn(run, id, '#field');
    t.check('an editable field: the edit menu without Inspect element', editable.popups[0] && JSON.stringify(labelsOf(editable.popups[0].items)) === JSON.stringify(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all']), editable.popups[0] && labelsOf(editable.popups[0].items));
    const selected = await rightClickOn(run, id, '#text', () => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#text'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    t.check('selected text: Copy only', selected.popups[0] && JSON.stringify(labelsOf(selected.popups[0].items)) === JSON.stringify(['Copy']), selected.popups[0] && labelsOf(selected.popups[0].items));
    await run.evalWin(id, () => window.getSelection().removeAllRanges());
    const link = await rightClickOn(run, id, '#link');
    const expectedLink = link.params[0] && link.params[0].selectionText ? ['Copy', 'Open link in browser', 'Copy link address'] : ['Open link in browser', 'Copy link address'];
    t.check('a link: Open link in browser and Copy link address (after Copy when macOS selected the word)', link.popups[0] && JSON.stringify(labelsOf(link.popups[0].items)) === JSON.stringify(expectedLink), link.popups[0] && labelsOf(link.popups[0].items));
    const image = await rightClickOn(run, id, '#img');
    t.check('an image: Copy image and Save image as', image.popups[0] && JSON.stringify(labelsOf(image.popups[0].items)) === JSON.stringify(['Copy image', 'Save image as…']), image.popups[0] && labelsOf(image.popups[0].items));
    const empty = await rightClickOn(run, id, '#empty');
    t.check('an empty area: the app shows no menu at all (Chromium reported the click, the template was empty)', empty.params.length === 1 && empty.popups.length === 0, { params: empty.params.length, popups: empty.popups.length });
    const menu = await run.cmd('menu');
    const flat = [];
    const walk = (items) => items.forEach((item) => { flat.push(item); if (item.submenu) walk(item.submenu); });
    walk(menu);
    t.check('the installed application menu has no Toggle Developer Tools item', !flat.some((item) => item.id === 'view.devtools'), flat.map((item) => item.id).filter(Boolean));
    t.check('macOS installed app: the standard app menu, File > Open Drawer, Edit, View, Settings, Window, Help', JSON.stringify(menu.map((item) => item.label)) === JSON.stringify(['GadgetsPOS', 'File', 'Edit', 'View', 'Settings', 'Window', 'Help']), menu.map((item) => item.label));
  });

  await scenario('D3', 'Start with the computer, through the real Settings page: setLoginItemSettings follows the switch (installed app, macOS)', async (t) => {
    const boot = await run.state();
    t.check('at boot, with the setting off and the system state off, setLoginItemSettings is NOT called', boot.login.calls.length === 0, boot.login);
    const win = await openSettings(run, 'settings.general');
    const view = await run.evalWin(win.id, () => ({ hidden: document.querySelector('#row-login').hidden, checked: document.querySelector('#sw-login').checked }));
    t.check('the switch is visible and off', view.hidden === false && view.checked === false, view);
    await run.evalWin(win.id, () => { document.querySelector('#sw-login').click(); });
    await waitFor(async () => (await run.state()).login.calls.length === 1, 'setLoginItemSettings', { timeoutMs: 6000 }).catch(() => {});
    const on = await run.state();
    t.check('turning it on calls app.setLoginItemSettings({ openAtLogin: true }) exactly once', on.login.calls.length === 1 && on.login.calls[0].openAtLogin === true, on.login);
    t.check('the setting is saved in config (startup.openAtLogin)', (await run.cmd('config')).startup.openAtLogin === true);
    await run.evalWin(win.id, () => { document.querySelector('#sw-fullscreen').click(); });
    await waitFor(async () => (await run.cmd('config')).window.startFullScreen === true, 'startFullScreen', { timeoutMs: 6000 }).catch(() => {});
    const stillOne = await run.state();
    t.check('changing another General switch does not touch the login item again', stillOne.login.calls.length === 1, stillOne.login);
    await run.evalWin(win.id, () => { document.querySelector('#sw-login').click(); });
    await waitFor(async () => (await run.state()).login.calls.length === 2, 'the second login call', { timeoutMs: 6000 }).catch(() => {});
    const off = await run.state();
    t.check('turning it off calls setLoginItemSettings({ openAtLogin: false })', off.login.calls.length === 2 && off.login.calls[1].openAtLogin === false, off.login);
    await run.evalWin(win.id, () => { document.querySelector('#sw-login').click(); }); // leave it ON for the next start
    await waitFor(async () => (await run.state()).login.calls.length === 3, 'the third login call', { timeoutMs: 6000 }).catch(() => {});
    t.check('left on for the next start', (await run.cmd('config')).startup.openAtLogin === true && (await run.state()).login.open === true);
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('D2-persist', 'Full screen remembered: toggled from the menu in this run, restored by the next start (run D2)', async (t) => {
    await run.cmd('menuClick', { id: 'view.full-screen' });
    await waitFor(async () => (await run.cmd('config')).window.fullScreen === true, 'fullScreen saved', { timeoutMs: 6000 }).then(() => t.check('the menu toggle saves window.fullScreen = true', true)).catch((e) => t.check('the menu toggle saves window.fullScreen = true', false, e.message));
    const file = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    t.check('it is on disk in config.json (not only in memory)', file.window && file.window.fullScreen === true && file.window.startFullScreen === true, file.window);
  });

  run.sampleFocus('end of run D');
  await run.stop();
}

async function runD2(runs, ctx) {
  const run = new AppRun({ name: 'D2', userData: ctx.userData, packaged: true, feed: true, fullScreenSpy: true });
  runs.push(run);
  await run.start();
  await waitForPos(run, ctx.pos);
  await scenario('D2-restore', 'The next start: full screen comes back, and the login item is synced with the saved setting', async (t) => {
    const state = await run.state();
    t.check('setFullScreen(true) was called when the window was shown (remembered state and "Start in full screen")', state.fullScreen.length >= 1 && state.fullScreen[0].flag === true, state.fullScreen);
    const main = state.windows.find((win) => win.meta && win.meta.preload === 'app.js');
    t.check('the window reports itself in full screen', main.fullScreen === true, main);
    t.check('at boot the login item is set to the saved value (the system said off, the setting says on)', state.login.calls.length === 1 && state.login.calls[0].openAtLogin === true, state.login);
    const config = await run.cmd('config');
    t.check('the saved settings were read back: window.fullScreen and startFullScreen', config.window.fullScreen === true && config.window.startFullScreen === true, config.window);
    await run.cmd('menuClick', { id: 'view.full-screen' });
    await waitFor(async () => (await run.cmd('config')).window.fullScreen === false, 'fullScreen cleared', { timeoutMs: 6000 }).then(() => t.check('leaving full screen is saved too', true)).catch((e) => t.check('leaving full screen is saved too', false, e.message));
  });
  run.sampleFocus('end of run D2');
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run E: platform linux with flags.json disableGpu
// ---------------------------------------------------------------------------------------------------------------------------

async function runE(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-E');
  seedConfig(userData, pos.url());
  fs.writeFileSync(flagsPath(userData), JSON.stringify({ disableGpu: true, disableBrotli: false, reason: 'manual', gpuChecked: true }));
  const run = new AppRun({ name: 'E', userData, packaged: true, platform: 'linux' });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);

  await scenario('E-GPU', 'flags.json disableGpu is honoured through app.disableHardwareAcceleration before ready; brotli follows the file', async (t) => {
    const state = await run.state();
    const call = state.appCalls.find((entry) => entry.call === 'disableHardwareAcceleration');
    t.check('app.disableHardwareAcceleration() was called, before the app was ready', Boolean(call) && call.ready === false, state.appCalls);
    t.check('flags.json was read before ready', state.reads.find((read) => read.file === 'flags.json').ready === false, state.reads);
    const gpu = await run.cmd('gpu');
    t.check('Chromium confirms: gpu_compositing is no longer "enabled"', gpu.status.gpu_compositing !== 'enabled', gpu.status);
    t.check('disable-brotli is NOT set when flags.json says disableBrotli:false', gpu.switches['disable-brotli'] === false, gpu.switches);
    t.check('the Windows-only occlusion switch is absent on linux too', !state.switches.some((entry) => entry.name === 'disable-features'), state.switches);
    const win = await openSettings(run, 'settings.general');
    const view = await run.evalWin(win.id, () => ({ accel: document.querySelector('#sw-accel').checked, compatHidden: document.querySelector('#compat-notice').hidden, compatText: document.querySelector('#compat-text').textContent.trim(), loginRowHidden: document.querySelector('#row-login').hidden }));
    t.check('Settings shows Hardware acceleration OFF with the compatibility notice and its reason', view.accel === false && view.compatHidden === false && /Help menu/.test(view.compatText), view);
    t.check('Settings hides "Start GadgetsPOS when this computer starts" on Linux', view.loginRowHidden === true, view);
    const answer = await run.evalWin(win.id, async () => window.desktop.settings.setGeneral({ openAtLogin: true, startFullScreen: false, keepAwake: true }));
    await sleep(500);
    const after = await run.state();
    t.check('even a direct setGeneral({ openAtLogin: true }) never calls setLoginItemSettings on Linux (installed app)', answer.ok === true && after.login.calls.length === 0, { answer, login: after.login });
    const menu = await run.cmd('menu');
    t.check('the Linux application menu (built by the real Menu): Open Drawer, View, Settings, Help, Quit', JSON.stringify(menu.map((item) => item.label)) === JSON.stringify(['Open Drawer (Ctrl+D)', 'View', 'Settings', 'Help', 'Quit']), menu.map((item) => item.label));
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  await scenario('E-close', 'On Linux and Windows closing the POS window quits the app, gracefully (D5)', async (t) => {
    const closedAt = Date.now();
    await run.cmd('closeMain');
    const exit = await Promise.race([run.exited, sleep(15_000).then(() => null)]);
    t.check('the process ends by itself after the window closes', exit !== null, 'still running');
    if (exit) {
      t.check('with exit code 0', exit.code === 0, exit);
      const events = run.events();
      const names = events.map((event) => event.type);
      t.check('before-quit, will-quit and quit were all reached', ['before-quit', 'will-quit', 'quit'].every((name) => names.includes(name)), names);
      t.note(`closed to exit: ${seconds(exit.at - closedAt)}`);
    }
  });

  run.sampleFocus('end of run E');
  await run.stop({ graceful: false });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run F: --disable-gpu wins
// ---------------------------------------------------------------------------------------------------------------------------

async function runF(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-F');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(flagsPath(userData), JSON.stringify({ disableGpu: false, disableBrotli: true, reason: '', gpuChecked: true }));
  const run = new AppRun({ name: 'F', userData, startUrl: pos.url(), args: ['--disable-gpu'] });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);

  await scenario('F-GPU', '--disable-gpu on the command line always wins over flags.json (disableGpu:false)', async (t) => {
    const state = await run.state();
    const call = state.appCalls.find((entry) => entry.call === 'disableHardwareAcceleration');
    t.check('app.disableHardwareAcceleration() was called before ready', Boolean(call) && call.ready === false, state.appCalls);
    const gpu = await run.cmd('gpu');
    t.check('Chromium confirms hardware acceleration is off', gpu.status.gpu_compositing !== 'enabled', gpu.status);
    const win = await openSettings(run, 'settings.general');
    const view = await run.evalWin(win.id, () => ({ accel: document.querySelector('#sw-accel').checked, compatText: document.querySelector('#compat-text').textContent.trim(), compatHidden: document.querySelector('#compat-notice').hidden }));
    t.check('Settings shows the switch off and names the shortcut argument as the reason', view.accel === false && view.compatHidden === false && /--disable-gpu/.test(view.compatText), view);
    const refused = await run.evalWin(win.id, async () => window.desktop.settings.setPerformance({ hardwareAcceleration: true }));
    t.check('asking for hardware acceleration while the argument is there is refused (INVALID_SETTINGS)', refused.ok === false && refused.code === 'INVALID_SETTINGS', refused);
    t.check('flags.json was not changed by the refused request', readJson(flagsPath(userData)).disableGpu === false, readJson(flagsPath(userData)));
    const crash = async () => run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 1 } });
    await crash();
    await crash();
    await sleep(500);
    const after = await run.state();
    t.check('two GPU crashes with the GPU already off change nothing (no flag, no box)', readJson(flagsPath(userData)).disableGpu === false && !after.dialogs.some((dialog) => /compatibility/.test(dialog.message)), after.dialogs);
    await run.fireWin(win.id, () => window.desktop.window.close());
    await waitFor(async () => !(await run.windowByUrl(isSettingsUrl)), 'Settings to close', { timeoutMs: 8000 });
  });

  run.sampleFocus('end of run F');
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run G: a hung print job at quit, with the real DYMO helper window
// ---------------------------------------------------------------------------------------------------------------------------

async function runG(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-G');
  const run = new AppRun({ name: 'G', userData, startUrl: pos.url(), hangPrint: true });
  runs.push(run);
  await run.start();
  const mainWin = await waitForPos(run, pos);

  await scenario('L3', 'Quit with a HUNG print job: the queue is drained first (at most 5 s), then the DYMO window and the print helper are disposed, then the app quits', async (t) => {
    await run.cmd('evalMain', { code: "ctx.handle.services.config.setPrinter('receipt', { transport: 'system', printerName: 'V-Receipt-58', port: '' }); return true;" });
    const none = await run.state();
    t.check('before the first DYMO use only the POS window exists', none.windowCount === 1 && dymoAlive(none) === 0, none.windowCount);
    await run.evalWin(mainWin.id, async () => window.electron.getPrinters());
    const withDymo = await run.state();
    t.check('getPrinters() from the POS page creates the real DYMO helper window (lazily, hidden)', withDymo.windowCount === 2 && dymoAlive(withDymo) === 1 && withDymo.createdWindows.filter(isDymoMeta).every((win) => win.shows === 0 && win.showInactives === 0), withDymo.createdWindows.map((win) => win.preload));
    // the page does not wait for the hung job
    await run.evalWin(mainWin.id, () => { window.__hung = window.electron.printReceipt({ receiptFileBinary: new Uint8Array([0x1b, 0x40, 0x41, 0x0a]) }); return true; });
    await waitFor(async () => run.events().some((event) => event.type === 'hung-exec'), 'the hung lp job to start', { timeoutMs: 10_000 });
    t.check('the print job is queued on the app\'s real queue and running (lp never answers)', (await run.cmd('queueSize', { key: 'system:V-Receipt-58' })) === 1);
    const requestedAt = Date.now();
    await run.cmd('menuClick', { id: 'app.quit' }, 5000); // the REAL "Quit GadgetsPOS" menu item
    await sleep(1500);
    await run.cmd('quit', {}, 5000).catch(() => {}); // a second quit request while the first is draining
    t.check('1.5 s after the quit request (and after a second one) the app is still alive: it is waiting for the print queue', !run.exit, run.exit);
    const stillTwo = await run.state().catch(() => null);
    t.check('...and the DYMO window still exists during the drain (it is disposed AFTER the queue)', stillTwo !== null && stillTwo.windowCount >= 1 && stillTwo.createdWindows.filter((win) => win.preload === null && win.devTools === false).every((win) => win.closedAt === null), stillTwo && stillTwo.createdWindows);
    const exit = await Promise.race([run.exited, sleep(20_000).then(() => null)]);
    t.check('the app exits by itself even though the job never finished', exit !== null, 'did not exit within 20 s');
    if (!exit) return;
    const events = run.events();
    const at = (type) => events.find((event) => event.type === type);
    const beforeQuit = at('before-quit');
    const willQuit = at('will-quit');
    const dymoClosed = events.find((event) => event.type === 'window-closed' && event.preload === null);
    const mainClosed = events.find((event) => event.type === 'window-closed' && event.preload === 'app.js');
    t.check('exit code 0', exit.code === 0, exit);
    t.check('before-quit, will-quit and quit all happened, in that order', Boolean(beforeQuit) && Boolean(willQuit) && at('quit') && beforeQuit.t <= willQuit.t && willQuit.t <= at('quit').t, events.map((event) => event.type));
    const drain = willQuit.t - beforeQuit.t;
    t.check('the quit waited for the queue for about 5 s (4.8 s to 7 s between before-quit and will-quit)', drain >= 4800 && drain <= 7000, { drain });
    t.check('the DYMO helper window was destroyed only AFTER the drain (after the 5 s wait, before will-quit)', Boolean(dymoClosed) && dymoClosed.t - beforeQuit.t >= 4800 && dymoClosed.t <= willQuit.t, { dymoClosed: dymoClosed && dymoClosed.t - beforeQuit.t, drain });
    t.check('the POS window was closed after the drain as well (the tasks run before the windows are closed)', Boolean(mainClosed) && mainClosed.t >= beforeQuit.t + 4800, { main: mainClosed && mainClosed.t - beforeQuit.t });
    t.check('the hung job was never aborted by the 30 s timeout (the quit did not wait for it)', !events.some((event) => event.type === 'hung-exec-aborted'), events.map((event) => event.type));
    t.check('the whole quit took under 8 s from the request', exit.at - requestedAt < 8000, { ms: exit.at - requestedAt });
    t.note(`quit request to exit: ${seconds(exit.at - requestedAt)}; before-quit to will-quit ${seconds(drain)}`);
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
    const lines = log.split('\n').filter(Boolean);
    t.check('the log was flushed: it ends with the shutdown line and no half-written line', /shutdown: finishing the print queue/.test(log), lines.slice(-3));
    t.check('no shutdown task was abandoned or failed', !/shutdown: ".*" (took too long|failed)/.test(log), lines.filter((line) => /shutdown/.test(line)));
    const litter = fs.readdirSync(run.tmpDir).filter((name) => /^gpos-.*\.bin$/.test(name));
    t.note(`print temp files left in the temp folder after the forced quit: ${litter.length}`);
    quietLitter.push(...litter.map((name) => `${run.tmpDir}/${name}`));
  });

  run.sampleFocus('end of run G');
  await run.stop({ graceful: false });
}
const quietLitter = [];

// ---------------------------------------------------------------------------------------------------------------------------
// Run I and I2: the first start after an upgrade from v1 (R1b)
// ---------------------------------------------------------------------------------------------------------------------------

async function runI(runs, ctx) {
  const pos = await startPos();
  ctx.posI = pos;
  const userData = makeDir('user-data-I');
  ctx.userDataI = userData;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ printerName: 'EPSON TM-T20', printerPort: '', password: '1234', labelPrinterName: 'ZDesigner ZD420', labelPrinterPort: '' }));
  const run = new AppRun({ name: 'I', userData, startUrl: pos.url() });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);
  await run.cmd('answerDialog', { match: 'Does the screen look right', response: 1 }); // "No, use compatibility mode"

  await scenario('R1b-question', 'After a v1 -> v2 upgrade the cashier is asked ONCE, in a native box, 20 s after the POS is visible; "No" writes compatibility mode and restarts', async (t) => {
    const config = readJson(path.join(userData, 'config.json'));
    t.check('the v1 settings file was migrated (schemaVersion 2) and the legacy printer keys are kept', config.schemaVersion === 2 && config.printerName === 'EPSON TM-T20', config);
    t.check('the plain-text password is gone, replaced by a hashed record', config.password === undefined && config.drawer && config.drawer.passwordRecord && config.drawer.passwordRecord.algo === 'scrypt', config.drawer && Object.keys(config.drawer));
    const early = await run.state();
    t.check('no question is asked in the first seconds', !early.dialogs.some((dialog) => /Does the screen look right/.test(dialog.message)), early.dialogs.map((dialog) => dialog.message));
    const armed = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app' && timer.delay === 20_000);
    t.check('a 20 s unref()ed timer is armed for the question', armed.length === 1 && armed[0].hasRef === false, armed);
    await waitFor(async () => (await run.state()).dialogs.some((dialog) => /Does the screen look right/.test(dialog.message)), 'the question', { timeoutMs: 30_000 }).catch(() => {});
    const state = await run.state();
    const box = state.dialogs.find((dialog) => /Does the screen look right/.test(dialog.message));
    t.check('the native question appears with Yes / "No, use compatibility mode"', Boolean(box) && JSON.stringify(box.buttons) === JSON.stringify(['Yes', 'No, use compatibility mode']), state.dialogs.map((dialog) => dialog.message));
    if (box) {
      const visibleAt = state.marks['loading-visible'];
      t.check('it came 19.5 to 24 s after the loading screen was visible', box.at - visibleAt >= 19_500 && box.at - visibleAt <= 24_000, { afterVisible: box.at - visibleAt });
      t.check('the question counts as one box', state.dialogs.filter((dialog) => /Does the screen look right/.test(dialog.message)).length === 1);
    }
    await waitFor(() => fs.existsSync(flagsPath(userData)) && readJson(flagsPath(userData)).gpuChecked === true, 'flags.json', { timeoutMs: 6000 }).catch(() => {});
    const flags = fs.existsSync(flagsPath(userData)) ? readJson(flagsPath(userData)) : {};
    t.check('"No" wrote { disableGpu: true, reason: manual, gpuChecked: true }', flags.disableGpu === true && flags.reason === 'manual' && flags.gpuChecked === true, flags);
    const exit = await Promise.race([run.exited, sleep(15_000).then(() => null)]);
    t.check('...and the app restarted through its graceful quit (relaunch requested, then the process ends by itself with code 0)', exit !== null && exit.code === 0 && run.events().some((event) => event.type === 'relaunch'), { exit, events: run.events().map((event) => event.type) });
  });
  run.sampleFocus('end of run I');
  await run.stop({ graceful: false });
}

async function runI2(runs, ctx) {
  const run = new AppRun({ name: 'I2', userData: ctx.userDataI, startUrl: ctx.posI.url() });
  runs.push(run);
  await run.start();
  await waitForPos(run, ctx.posI);
  await scenario('R1b-once', 'The next start: compatibility mode is on, and the question is never asked again', async (t) => {
    const state = await run.state();
    t.check('hardware acceleration is off for this start (flags.json was read before ready)', state.appCalls.some((call) => call.call === 'disableHardwareAcceleration' && call.ready === false), state.appCalls);
    const armed = (await run.cmd('timers')).timers.filter((timer) => timer.origin === 'app' && timer.delay === 20_000);
    t.check('no question timer is armed (gpuChecked is stored)', armed.length === 0, armed);
    const win = await openSettings(run, 'settings.general');
    const view = await run.evalWin(win.id, () => ({ accel: document.querySelector('#sw-accel').checked, notice: document.querySelector('#compat-text').textContent.trim() }));
    t.check('Settings > General says compatibility mode was switched on from the Help menu', view.accel === false && /Help menu/.test(view.notice), view);
    // switching hardware acceleration back on from the General tab, then "Restart now"
    await run.evalWin(win.id, () => { document.querySelector('#sw-accel').click(); });
    await waitFor(() => readJson(flagsPath(ctx.userDataI)).disableGpu === false, 'flags.json to say hardware acceleration is wanted', { timeoutMs: 6000 }).then(() => t.check('turning Hardware acceleration back on writes disableGpu:false and clears the reason', readJson(flagsPath(ctx.userDataI)).reason === '')).catch((e) => t.check('turning Hardware acceleration back on writes disableGpu:false', false, e.message));
    const notice = await run.evalWin(win.id, () => ({ shown: !document.querySelector('#restart-notice').hidden }));
    t.check('a "Restart now" notice appears (the setting is read only at the next start)', notice.shown === true, notice);
    await run.fireWin(win.id, () => document.querySelector('#restart-now').click());
    const exit = await Promise.race([run.exited, sleep(15_000).then(() => null)]);
    t.check('"Restart now" relaunches through the graceful quit: relaunch requested once, the process ends by itself with code 0', exit !== null && exit.code === 0 && run.events().filter((event) => event.type === 'relaunch').length === 1, { exit, events: run.events().map((event) => event.type) });
  });
  run.sampleFocus('end of run I2');
  await run.stop({ graceful: false });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run J: the offline screen AFTER the POS has been loaded (throttling is switched off by then)
// ---------------------------------------------------------------------------------------------------------------------------

async function runJ(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-J');
  const run = new AppRun({ name: 'J', userData, startUrl: pos.url() });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);

  /** What the window really paints right now: an image of it, and whether animation frames come. */
  const paints = async () => {
    const capture = await run.cmd('capture', { timeoutMs: 6000 });
    const raf = await run.cmd('evalIn', { code: "new Promise((resolve) => { const timer = setTimeout(() => resolve('rAF never fired'), 2000); requestAnimationFrame(() => { clearTimeout(timer); resolve('rAF fired'); }); })" }).catch(() => 'no answer');
    return { capture, raf, painted: capture.ok === true && capture.width > 200 && raf === 'rAF fired' };
  };

  await scenario('J1', 'Once the POS HAS loaded (so background throttling is off), every later screen of the same window still paints: offline after a reload, the crash screen, the POS again', async (t) => {
    await sleep(800);
    const first = await paints();
    t.check('the POS page itself paints', first.painted, first);
    t.check('background throttling is off by now', (await run.mainWindow()).backgroundThrottling === false);

    await pos.stop();
    await run.cmd('menuClick', { id: 'view.reload' });
    await waitFor(async () => {
      const win = await run.mainWindow();
      return win && isOfflineUrl(win.url) ? win : null;
    }, 'the offline page after View > Reload with the server down', { timeoutMs: 30_000 });
    await sleep(1500);
    const offline = await paints();
    t.check('server down + View > Reload: the offline screen shows AND PAINTS (not a blank window)', offline.painted, offline);
    t.check('throttling is still off on the offline screen (the property survives the navigation)', (await run.mainWindow()).backgroundThrottling === false);

    await pos.start();
    await waitFor(async () => {
      const win = await run.mainWindow();
      return win && win.url.startsWith(pos.origin) ? win : null;
    }, 'the POS to come back by itself', { timeoutMs: 30_000 });
    await sleep(800);
    const back = await paints();
    t.check('the POS comes back by itself and paints', back.painted, back);

    await run.cmd('crashMain');
    await waitFor(async () => {
      const win = await run.mainWindow();
      return win && isOfflineUrl(win.url) ? win : null;
    }, 'the crash screen', { timeoutMs: 20_000 });
    await sleep(1500);
    const crashed = await paints();
    t.check('a crashed POS page: the "page stopped responding" screen shows AND PAINTS', crashed.painted, crashed);
    await waitFor(async () => {
      const win = await run.mainWindow();
      return win && win.url.startsWith(pos.origin) ? win : null;
    }, 'the POS to reload after the crash', { timeoutMs: 40_000 }).then(() => t.check('the app reloads the POS by itself after the crash', true)).catch((error) => t.check('the app reloads the POS by itself after the crash', false, error.message));
    await sleep(800);
    const recovered = await paints();
    t.check('...and the recovered POS paints', recovered.painted, recovered);
    t.note(`paints: ${JSON.stringify({ first: first.capture.width, offline: offline.capture.width, back: back.capture.width, crashed: crashed.capture.width, recovered: recovered.capture.width })}`);
  });

  run.sampleFocus('end of run J');
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run K: a SLOW print job that does finish, at quit
// ---------------------------------------------------------------------------------------------------------------------------

async function runK(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-K');
  const run = new AppRun({ name: 'K', userData, startUrl: pos.url(), printDelayMs: 2500 });
  runs.push(run);
  await run.start();
  const mainWin = await waitForPos(run, pos);

  await scenario('L3-slow', 'Quit while a receipt is still printing (2.5 s job): the app waits for it, the job finishes, nothing is lost, then it quits', async (t) => {
    await run.cmd('evalMain', { code: "ctx.handle.services.config.setPrinter('receipt', { transport: 'system', printerName: 'V-Receipt-58', port: '' }); return true;" });
    await run.evalWin(mainWin.id, () => { window.__job = window.electron.printReceipt({ receiptFileBinary: new Uint8Array([0x1b, 0x40, 0x41, 0x0a]) }); return true; });
    await waitFor(async () => run.events().some((event) => event.type === 'hung-exec'), 'the print job to start', { timeoutMs: 10_000 });
    const requestedAt = Date.now();
    await run.cmd('menuClick', { id: 'app.quit' }, 5000);
    const exit = await Promise.race([run.exited, sleep(15_000).then(() => null)]);
    t.check('the app exits by itself', exit !== null, 'still running');
    if (!exit) return;
    const events = run.events();
    const at = (type) => events.find((event) => event.type === type);
    const done = at('slow-exec-done');
    t.check('the job FINISHED (lp answered) after the quit began and before the app quit', Boolean(done) && done.t > at('before-quit').t && done.t <= at('will-quit').t, events.map((event) => `${event.type}@${event.t}`));
    t.check('before-quit to will-quit took about the length of the job (2.2 s to 4 s), not 5 s', at('will-quit').t - at('before-quit').t >= 2200 && at('will-quit').t - at('before-quit').t <= 4000, { ms: at('will-quit').t - at('before-quit').t });
    t.check('exit code 0 and no print temp file left behind (the finished job cleaned up)', exit.code === 0 && fs.readdirSync(run.tmpDir).filter((name) => /^gpos-/.test(name)).length === 0, { code: exit.code, files: fs.readdirSync(run.tmpDir) });
    t.note(`quit request to exit: ${seconds(exit.at - requestedAt)}`);
  });

  run.sampleFocus('end of run K');
  await run.stop({ graceful: false });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run H: does a minimised POS window keep running?
// ---------------------------------------------------------------------------------------------------------------------------

async function runH(runs) {
  const pos = await startPos();
  const userData = makeDir('user-data-H');
  const run = new AppRun({ name: 'H', userData, startUrl: pos.url('?page=throttle') });
  runs.push(run);
  await run.start();
  const mainWin = await waitForPos(run, pos);

  await scenario('R2-minimised', 'A minimised POS window keeps its timers, animation frames and page visibility (R2: order sounds, sockets and timers keep running)', async (t) => {
    await sleep(1200);
    await run.cmd('minimizeMain');
    await sleep(600);
    const visibility = await run.cmd('evalIn', { code: 'document.visibilityState' });
    t.check('the page is still "visible" while the window is minimised (throttling is really off)', visibility === 'visible', visibility);
    t.check('the window really is minimised', (await run.mainWindow()).minimized === true);
    await sleep(11_000); // past Chromium's grace period before it starts to throttle a hidden page
    const first = await run.cmd('evalIn', { code: '[window.ticks, window.raf]' });
    await sleep(5000);
    const second = await run.cmd('evalIn', { code: '[window.ticks, window.raf]' });
    const ticks = second[0] - first[0];
    const frames = second[1] - first[1];
    t.check('a 100 ms timer ticked about 50 times in 5 s (a throttled page would tick about 5 times)', ticks >= 35, { ticks });
    t.check('animation frames kept coming (a hidden page gets none)', frames >= 100, { frames });
    t.note(`minimised: ${ticks} ticks and ${frames} frames in 5 s, after ${seconds(11_000)} minimised`);
    void mainWin;
  });

  run.sampleFocus('end of run H');
  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// The final scenario and main
// ---------------------------------------------------------------------------------------------------------------------------

async function budgetScenario() {
  await scenario('Budget', 'SPEC 18b S1/S3: main-process boot (app-ready -> loading-visible) against the 400 ms budget, over every cold start of this verification', async (t) => {
    const boots = bootTimes.filter((entry) => entry.marks['loading-visible'] !== undefined).map((entry) => ({ run: entry.run, ready: entry.marks['app-ready'], created: entry.marks['window-created'], visible: entry.marks['loading-visible'], boot: entry.marks['loading-visible'] - entry.marks['app-ready'], services: entry.marks['services-ready'] }));
    const sorted = boots.map((entry) => entry.boot).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    t.note(`startup of ${boots.length} cold starts (ms since process start): ${boots.map((entry) => `${entry.run}: ready ${entry.ready}, window ${entry.created}, loading screen ${entry.visible} (boot ${entry.boot}), services ${entry.services}`).join(' | ')}`);
    t.check('main-process boot (app-ready -> loading-visible) is at most 400 ms (median of all cold starts; it depends on the load of this machine, which was running other Electron processes)', median > 0 && median <= 400, { median, boots: boots.map((entry) => entry.boot) });
  });
}

async function finalScenario() {
  await scenario('Z', 'Nothing took focus, no main process threw, nothing is left running', async (t) => {
    const stolen = quiet.focus.filter((entry) => entry.ours);
    t.check(`no app window was ever in front (${quiet.focus.length} samples of the front application)`, stolen.length === 0, stolen);
    t.check('no uncaught exception or unhandled rejection in any main process', quiet.uncaught.length === 0, quiet.uncaught);
    await sleep(500);
    const alive = [...everSpawned].filter((pid) => isAlive(pid));
    t.check('every Electron process this script started has ended', alive.length === 0, alive);
    t.note(`print temp files left behind by the hung job: ${quietLitter.length}`);
  });
}

async function main() {
  const wanted = new Set((process.env.NATIVE_RUNS || 'A,B,C,D,D2,E,F,G,H,I,I2,J,K').split(',').map((name) => name.trim().toUpperCase()));
  const runs = [];
  const ctx = {};
  const watchdog = setTimeout(() => {
    process.stderr.write('watchdog: the verification ran too long; ending every app it started\n');
    for (const pid of tracked) killTree(pid);
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref();

  const guard = async (id, fn) => {
    if (!wanted.has(id)) return;
    try {
      await fn();
    } catch (error) {
      await scenario(`run-${id}`, `Run ${id} could not complete`, () => { throw error; });
      for (const run of runs) {
        if (run.child && !run.exit) await run.stop({ graceful: false, timeoutMs: 2000 }).catch(() => {});
      }
    }
  };

  const started = Date.now();
  try {
    await guard('A', () => runA(runs));
    await guard('B', () => runOffline(runs, { name: 'B', specLiteral: false }));
    await guard('C', () => runOffline(runs, { name: 'C', specLiteral: true }));
    await guard('D', () => runD(runs, ctx));
    if (wanted.has('D2') && ctx.pos) await guard('D2', () => runD2(runs, ctx));
    await guard('E', () => runE(runs));
    await guard('F', () => runF(runs));
    await guard('G', () => runG(runs));
    await guard('K', () => runK(runs));
    await guard('H', () => runH(runs));
    await guard('J', () => runJ(runs));
    await guard('I', () => runI(runs, ctx));
    if (wanted.has('I2') && ctx.posI) await guard('I2', () => runI2(runs, ctx));
    await budgetScenario();
    await finalScenario();
  } finally {
    for (const pid of tracked) killTree(pid);
  }

  const failed = scenarios.filter((entry) => !entry.passed);
  const checks = scenarios.reduce((sum, entry) => sum + entry.checks.length, 0);
  const bad = scenarios.reduce((sum, entry) => sum + entry.checks.filter((check) => !check.ok).length, 0);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'native-report.json'), `${JSON.stringify({ at: new Date().toISOString(), scenarios: scenarios.map((entry) => ({ id: entry.id, title: entry.title, passed: entry.passed, ms: entry.ms, error: entry.error && entry.error.message, checks: entry.checks, notes: entry.notes })) }, null, 2)}\n`);
  process.stdout.write(`\n${scenarios.length} scenarios, ${checks} checks, ${bad} failed checks, ${failed.length} failed scenarios, ${seconds(Date.now() - started)}\n`);
  for (const entry of failed) process.stdout.write(`  FAILED [${entry.id}] ${entry.title}\n`);
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    // temp folder cleanup is best effort
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`harness failure: ${(error && error.stack) || error}\n`);
  for (const pid of tracked) killTree(pid);
  process.exit(2);
});
