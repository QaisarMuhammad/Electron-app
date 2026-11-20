#!/usr/bin/env node
'use strict';

/**
 * The desktop smoke run (SPEC 17, 19.3, 18b): it proves, on this machine, that the REAL app works under the REAL Electron.
 *
 *   node tests/e2e/run-smoke.js
 *
 * A plain Node script. It starts the fake POS (tests/e2e/fake-pos.js), spawns the Electron binary of node_modules with
 * `--remote-debugging-port=<free port>` and tests/e2e/launch-app.js (the real `bootstrap()` with fake printers, dialogs and
 * operating-system calls), attaches to it with puppeteer-core through `connect({ browserURL })` (a browser is never launched,
 * and `browser.close()` is never called: that would quit the app), and drives what a person would do: it reads the pages, clicks
 * the buttons, types into the fields, calls `window.electron` from the POS page and `window.desktop` from the app's own pages.
 * What only the main process knows (print jobs, native boxes, menus, the login item) it asks of launch-app.js's control server.
 *
 * Five app runs (each with its own userData folder), one table:
 *   A  development run, server down at the start:  1 2 3 4 5 5b 6 6b 7 7b 8 8b 8c 11 12 14 15 16 17
 *   B  a seeded v1 config.json:                     9 9b 10 19 (with a stand-in electron-updater)
 *   C  an installed (packaged) run:                 13 15b
 *   D  the next start of C's data folder:           13b (full screen, compatibility mode, window place and zoom)
 *   E  quitting with unsaved changes in Settings:   20
 * plus F: no window took focus, no page logged an error, no main-process exception, nothing left running.
 *
 * Nothing here steals focus (launch-app.js uses the macOS accessory activation policy and showInactive()) and nothing is left
 * running: every process this script starts is ended by pid, and the script checks for strays at the end.
 *
 * SMOKE_RUNS=B,C runs only those app runs (default A,B,C,D,E). Exit code: 0 when every scenario passed, 1 when one failed,
 * 2 when the harness itself broke.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
// the Electron the app runs on (this script runs in plain Node): the About text must name its major version, whichever it is
const ELECTRON_MAJOR = require('electron/package.json').version.split('.')[0];

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const FIXTURES_DIR = path.join(__dirname, 'smoke-fixtures');
const LAUNCH_SCRIPT = path.join(__dirname, 'launch-app.js');
const WATCHDOG_MS = 8 * 60 * 1000;

const { startFakePos } = require('./fake-pos');

/** puppeteer-core is the library of choice; the full puppeteer package is used only when that is all that is installed. */
function loadPuppeteer() {
  for (const name of ['puppeteer-core', 'puppeteer']) {
    try {
      return require(require.resolve(name, { paths: [ROOT] }));
    } catch {
      // try the next one
    }
  }
  throw new Error('neither puppeteer-core nor puppeteer is installed in node_modules');
}

function electronBinary() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
}

const puppeteer = loadPuppeteer();
const ELECTRON = electronBinary();
const PACKAGE = require(path.join(ROOT, 'package.json'));

// ---------------------------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `fn` until it answers something truthy and returns that. Throws, naming `label`, after `timeoutMs`.
 *
 * @template T
 * @param {() => (T|Promise<T>)} fn
 * @param {string} label what is being waited for
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<T>}
 */
async function waitFor(fn, label, { timeoutMs = 15_000, intervalMs = 60 } = {}) {
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

/** All descendants of a process, from the process table (`ps`), deepest last. */
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

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The environment of a child that must run as Electron: a harness started from an Electron-based terminal inherits ELECTRON_RUN_AS_NODE, which would make it plain Node. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** A fresh temp folder; the run folder holds every one of them so one removal cleans up. */
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-smoke-'));
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

  /** Records one check. `detail` is shown only when it fails. */
  check(name, ok, detail) {
    const passed = Boolean(ok);
    this.checks.push(passed ? { name, ok: true } : { name, ok: false, detail });
    process.stdout.write(`  ${passed ? 'ok   ' : 'FAIL '} ${name}${passed ? '' : `   -> ${shorten(JSON.stringify(detail))}`}\n`);
    return passed;
  }

  /** A check that waits: passes when `fn` answers something truthy within the time, and fails (with the reason) when not. */
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

  note(text) {
    this.notes.push(text);
    process.stdout.write(`  note  ${text}\n`);
  }

  get passed() {
    return this.error === null && this.checks.length > 0 && this.checks.every((entry) => entry.ok);
  }
}

function shorten(text, max = 300) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** @type {Scenario[]} */
const scenarios = [];

/** Runs one scenario: an error thrown inside it fails it and the run goes on with the next one. */
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

/** Sort key of a scenario id: 5, 5b, 9, 9b, 10 ... */
function idOrder(id) {
  const [, number, suffix] = /^(\d+)(.*)$/.exec(id) || [null, '999', id];
  return Number(number) * 100 + (suffix ? suffix.charCodeAt(0) - 96 : 0);
}

// ---------------------------------------------------------------------------------------------------------------------------
// One run of the app
// ---------------------------------------------------------------------------------------------------------------------------

const EGL_NOISE = /EGL Driver message|gl_display\.cc/;

/** Console errors of the app's OWN pages (file: pages) and exceptions of any main process, over every run. */
const quiet = { consoleErrors: [], uncaught: [], focus: [] };

class AppRun {
  /**
   * @param {object} options
   * @param {string} options.name       names the log and the events file
   * @param {string} options.userData
   * @param {string} [options.startUrl]
   * @param {boolean} [options.packaged]
   * @param {boolean} [options.fullScreenSpy]
   * @param {number} [options.warpMs]
   * @param {boolean} [options.updater] enable updates with the stand-in electron-updater
   */
  constructor({ name, userData, startUrl = '', packaged = false, fullScreenSpy = false, warpMs = 0, updater = false }) {
    this.name = name;
    this.userData = userData;
    this.startUrl = startUrl;
    this.packaged = packaged;
    this.fullScreenSpy = fullScreenSpy;
    this.warpMs = warpMs;
    this.updater = updater;
    this.eventsFile = path.join(RUN_DIR, `events-${name}.jsonl`);
    this.logFile = path.join(OUT_DIR, `smoke-run-${name}.log`);
    this.child = null;
    this.exit = null;
    this.browser = null;
    this.controlPort = 0;
    this.debugPort = 0;
    this.cursor = 0;
  }

  /** Starts the app, waits for its control server and attaches the debugger. */
  async start() {
    this.debugPort = await freePort();
    this.controlPort = await freePort();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const log = fs.createWriteStream(this.logFile);
    const env = {
      ...cleanEnv(),
      GPOS_E2E_USER_DATA: this.userData,
      GPOS_E2E_EVENTS_FILE: this.eventsFile,
      GPOS_E2E_CONTROL_PORT: String(this.controlPort),
      GADGETSPOS_START_URL: this.startUrl,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ...(this.packaged ? { GPOS_E2E_PACKAGED: '1' } : {}),
      ...(this.fullScreenSpy ? { GPOS_E2E_FULLSCREEN_SPY: '1' } : {}),
      ...(this.warpMs ? { GPOS_E2E_WARP_MS: String(this.warpMs) } : {}),
      ...(this.updater ? { GPOS_E2E_UPDATER: '1' } : {}),
    };
    this.child = spawn(ELECTRON, [`--remote-debugging-port=${this.debugPort}`, LAUNCH_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    }, 'the app to start', { timeoutMs: 40_000, intervalMs: 150 });

    // Attaching WHILE the window is still leaving the loading screen can leave the debugger looking at the old document (the
    // page swaps its renderer process on the first real navigation), so the debugger attaches once the window has moved on.
    await waitFor(async () => {
      const info = await this.cmd('mainInfo').catch(() => null);
      return info && info.url && !/loading\.html/.test(info.url);
    }, 'the main window to leave the loading screen', { timeoutMs: 20_000, intervalMs: 100 }).catch(() => {});
    await sleep(300);
    await this.attach();
  }

  /** Attaches the debugger (again): a new connection always starts from the pages as they are now. */
  async attach() {
    if (this.browser) await this.browser.disconnect().catch(() => {});
    this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${this.debugPort}`, defaultViewport: null, protocolTimeout: 30_000 });
    this.browser.on('targetcreated', (target) => void this.watchConsole(target));
    for (const page of await this.browser.pages()) this.watchPage(page);
  }

  /** The console errors of the app's own pages are collected: they must stay empty. */
  watchPage(page) {
    // A crashed page makes puppeteer emit 'error'; an EventEmitter with no listener for it throws.
    page.on('error', () => {});
    page.on('console', (message) => {
      if (message.type() === 'error' && page.url().startsWith('file:')) quiet.consoleErrors.push(`${this.name}: ${page.url().split('/').pop()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      if (page.url().startsWith('file:')) quiet.consoleErrors.push(`${this.name}: ${page.url().split('/').pop()}: ${error.message}`);
    });
  }

  async watchConsole(target) {
    try {
      const page = await target.page();
      if (page) this.watchPage(page);
    } catch {
      // not a page, or already gone
    }
  }

  /** Sends one command to launch-app.js and returns its value. */
  async cmd(name, args = {}, timeoutMs = 20_000) {
    const response = await fetch(`http://127.0.0.1:${this.controlPort}/cmd`, {
      method: 'POST',
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await response.json();
    if (!answer.ok) throw new Error(`command ${name} failed: ${answer.error}`);
    return answer.value;
  }

  state() {
    return this.cmd('state');
  }

  /** The events of launch-app.js so far (read from its file, which also survives the quit). */
  events() {
    try {
      return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /** Raw jobs of one label, from the app's recorder. */
  async jobs(label) {
    const { rawJobs } = await this.state();
    return label ? rawJobs.filter((job) => job.label === label) : rawJobs;
  }

  /**
   * @param {(url: string) => boolean} test
   * @returns {Promise<import('puppeteer-core').Page|null>} the first page whose TARGET url passes the test. The target url is what
   *   the browser reports for the window: for a popup that was written to with document.write, `page.url()` is the opener's
   *   address (the document took it over) while the target is still about:blank.
   */
  async findPage(test) {
    const pages = await this.browser.pages();
    return pages.find((page) => test(page.target().url())) || null;
  }

  waitPage(test, label, timeoutMs = 20_000) {
    return waitFor(() => this.findPage(test), label, { timeoutMs });
  }

  mainPage() {
    return this.findPage(isMainUrl);
  }

  /** Every pid of this run: the app and its helper processes. */
  pids() {
    return this.child && !this.exit ? [this.child.pid, ...descendantsOf(this.child.pid)] : [];
  }

  /** Records which application is in front: it must never be this one. */
  sampleFocus(label) {
    const front = frontApp();
    if (front === null) return;
    quiet.focus.push({ run: this.name, label, front, ours: this.pids().includes(front.pid) });
  }

  /** Quits the app through its menu action and waits for the process to end; ends it by force when it does not. */
  async stop({ graceful = true, timeoutMs = 20_000 } = {}) {
    if (!this.child) return;
    if (this.browser) {
      try {
        await this.browser.disconnect();
      } catch {
        // already disconnected
      }
      this.browser = null;
    }
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
    const state = this.events().filter((event) => event.type === 'uncaught' || event.type === 'unhandled-rejection' || event.type === 'launch-failed');
    for (const event of state) quiet.uncaught.push(`${this.name}: ${event.type}: ${event.message}`);
    killTree(this.child.pid);
    tracked.delete(this.child.pid);
  }
}

/** Every process id this script started and has not seen end: the final cleanup ends exactly these. */
const tracked = new Set();
/** Every Electron process id this script ever started: at the end none of them may be alive. */
const everSpawned = new Set();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------------------------------------

const isSettingsUrl = (url) => /\/src\/renderer\/settings\.html/.test(url);
const isPasswordUrl = (url) => /\/src\/renderer\/password\.html/.test(url);
/** The POS window: the loading page, the offline page or the POS itself; never a popup (about:blank, blob:) or a local window. */
const isMainUrl = (url) => url !== '' && !isSettingsUrl(url) && !isPasswordUrl(url) && !/^(about:|blob:|devtools:|chrome)/.test(url);
const isOfflineUrl = (url) => /\/src\/renderer\/offline\.html/.test(url);

/** `page.evaluate` that tries again when the page was navigating (the execution context it asked for is gone). */
async function evalIn(page, fn, ...args) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (error) {
      const transient = /Execution context was destroyed|Cannot find context|Target closed|Session closed/.test(error.message);
      if (!transient || attempt >= 6) throw error;
      await sleep(200);
    }
  }
}

/** Saves a screenshot of a page with the DevTools protocol call itself (`Page.captureScreenshot`). @returns {string} the file */
async function screenshot(page, name, session = null) {
  const file = path.join(OUT_DIR, `smoke-${name}.png`);
  const client = session || (await page.createCDPSession());
  try {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  } finally {
    if (!session) await client.detach().catch(() => {});
  }
  return file;
}

/** The same screenshot with the page told that the system theme is dark (the app's pages follow prefers-color-scheme, SPEC 14). */
async function screenshotDark(page, name) {
  const client = await page.createCDPSession();
  try {
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(400);
    return await screenshot(page, name, client);
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Walks a DOM snapshot of the DevTools protocol, shadow roots included. */
function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
  for (const root of node.shadowRoots || []) walk(root, visit);
}

const attributeOf = (node, name) => {
  const list = node.attributes || [];
  const at = list.indexOf(name);
  return at >= 0 ? list[at + 1] : undefined;
};
const textOfNode = (node) => (node.nodeType === 3 ? node.nodeValue : (node.children || []).map(textOfNode).join(''));

/**
 * Reads the offline banner of the app preload. It lives in a CLOSED shadow root, which the page itself (and so page.evaluate)
 * cannot see; the DevTools protocol can, which is also how the banner is kept private from the page.
 *
 * Pass the session that emulates the network when one is active: detaching ANOTHER session cancels that emulation.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').CDPSession} [session]
 * @returns {Promise<null|{ state: string, text: string, buttonEnabled: boolean, height: number }>} null when no banner exists
 */
async function readBanner(page, session = null) {
  const client = session || (await page.createCDPSession());
  try {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    let host = null;
    let pill = null;
    let text = null;
    let button = null;
    walk(root, (node) => {
      if (node.nodeType !== 1) return;
      if (node.nodeName.toLowerCase() === 'gadgetspos-banner') host = node;
      if (host && attributeOf(node, 'class') === 'pill') pill = node;
      if (host && attributeOf(node, 'class') === 'text') text = node;
      if (host && node.nodeName.toLowerCase() === 'button') button = node;
    });
    if (!host || !pill) return null;
    let height = 0;
    try {
      const box = await client.send('DOM.getBoxModel', { nodeId: pill.nodeId });
      height = box.model.height;
    } catch {
      height = 0;
    }
    return {
      state: attributeOf(pill, 'data-state'),
      text: text ? textOfNode(text) : '',
      buttonEnabled: button ? attributeOf(button, 'disabled') === undefined : false,
      height,
    };
  } finally {
    if (!session) await client.detach().catch(() => {});
  }
}

/** The text of a selector, trimmed (null when it is not there). */
const textOf = (page, selector) => page.$eval(selector, (element) => element.textContent.trim()).catch(() => null);

/** True when the element exists and is not hidden. */
const isShown = (page, selector) => page.$eval(selector, (element) => !element.hidden && element.getClientRects().length > 0).catch(() => false);

/** Types into a field after emptying it (the page's own handlers see real key events). */
async function typeInto(page, selector, text) {
  await page.$eval(selector, (element) => {
    element.focus();
    element.value = '';
  });
  await page.type(selector, text);
}

/** Opens Settings through the real application menu and waits for its page to be ready. */
async function openSettings(run, menuId = 'settings.printers') {
  await run.cmd('menuClick', { id: menuId });
  const page = await run.waitPage(isSettingsUrl, 'the Settings window');
  await waitFor(() => page.evaluate(() => document.body && document.body.dataset.state === 'ready').catch(() => false), 'the Settings page to be ready', { timeoutMs: 20_000 });
  return page;
}

async function closeWindowOf(run, page, label) {
  await evalIn(page, () => window.desktop.window.close()).catch(() => {});
  await waitFor(async () => !(await run.browser.pages()).includes(page), `the ${label} window to close`, { timeoutMs: 8000 }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------------------
// Shared pieces of the scenarios
// ---------------------------------------------------------------------------------------------------------------------------

/** The pulse of the default drawer settings (pin 2, 50 ms, 510 ms): ESC p 0 25 255. */
const DRAWER_PULSE_HEX = '1b700019ff';
const DRAWER_PASSWORD = 'drawer-1234';
/** The startup marks in the order the app reaches them (SPEC 18b S3). */
const MARK_ORDER = ['process-start', 'app-ready', 'window-created', 'loading-visible', 'config-ready', 'services-ready', 'pos-dom-ready', 'pos-loaded'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Presses a key that closes the page's own window: the key-up of that press then finds the target gone, which is the point. */
const pressClosing = (page, key) => page.keyboard.press(key).catch(() => {});

/** One call of the fake POS page, answering the result the desktop app gave. */
async function posCall(page, name, args = {}) {
  return (await evalIn(page, (callName, callArgs) => window.__pos.call(callName, callArgs), name, args)).result;
}

/** The POS page of a run, once it has loaded (the offline page is not it). */
async function waitForPos(run, pos, timeoutMs = 30_000, retried = false) {
  try {
    return await waitFor(async () => {
      const page = await run.mainPage();
      return page && page.url().startsWith(pos.origin) && (await page.evaluate(() => Boolean(window.__pos)).catch(() => false)) ? page : null;
    }, 'the POS page', { timeoutMs, intervalMs: 100 });
  } catch (error) {
    // Say what the app and the debugger see: that is what is needed to tell a harness problem from an app problem.
    const seen = (await run.browser.pages().catch(() => [])).map((page) => page.target().url());
    const main = await run.cmd('mainInfo').catch((problem) => ({ error: problem.message }));
    const message = `${error.message}; the debugger sees ${JSON.stringify(seen)}; the app's main window shows ${JSON.stringify(main && (main.url || main.error))}; the POS is ${pos.url}`;
    // A debugger that still shows an old document while the app shows the POS is stale: attach again, once.
    if (!retried && main && main.url && main.url.startsWith(pos.origin) && !seen.some((url) => url.startsWith(pos.origin))) {
      await run.attach();
      return waitForPos(run, pos, 15_000, true);
    }
    throw new Error(message);
  }
}

/** Every DYMO label the fake framework has printed or opened, over every helper window. */
async function dymoLabels(run) {
  return (await run.state()).dymo.windows.flatMap((win) => win.labels);
}

/** The startup marks of a diagnostics text: { name: ms } in the order written. */
function marksOf(diagnostics) {
  const line = /^Startup: (.+)$/m.exec(diagnostics);
  const marks = {};
  if (!line) return marks;
  for (const part of line[1].split(', ')) {
    const match = /^(\S+) (\d+) ms$/.exec(part.trim());
    if (match) marks[match[1]] = Number(match[2]);
  }
  return marks;
}

/** A guard around one run of the app: when the run cannot even start, that is one failed row, not a crash of the harness. */
async function guardRun(id, title, fn) {
  try {
    await fn();
  } catch (error) {
    await scenario(id, title, () => { throw error; });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run A: the development run
// ---------------------------------------------------------------------------------------------------------------------------

async function runDevelopment(servers, runs) {
  const pos = await startFakePos();
  await pos.stop(); // the server is DOWN when the app starts
  const other = await startFakePos(); // a second origin: the app must never reach it
  servers.push(pos, other);
  const run = new AppRun({ name: 'main', userData: makeDir('user-data-main'), startUrl: pos.smokeUrl });
  runs.push(run);
  await run.start();
  run.sampleFocus('after the app started');

  // ---- 1 cold start with the server down ---------------------------------------------------------------------------------
  await scenario('1', 'Cold start with the server down shows the offline page and counts the attempts', async (t) => {
    const url = await waitFor(async () => {
      const page = await run.mainPage();
      return page && isOfflineUrl(page.url()) ? page.url() : null;
    }, 'the offline page', { timeoutMs: 30_000 });
    const page = await run.mainPage();
    t.check('the window shows offline.html for a refused connection', /offline\.html\?reason=refused/.test(url), url);
    await page.waitForFunction(() => document.readyState === 'complete');
    const view = await evalIn(page, () => ({
      headline: document.querySelector('#headline') ? document.querySelector('#headline').textContent : '',
      textLength: document.body.innerText.length,
      buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()),
      electron: typeof window.electron,
      desktopKeys: window.desktop ? Object.keys(window.desktop).sort() : null,
      connectionKeys: window.desktop ? Object.keys(window.desktop.connection).sort() : null,
    }));
    t.check('it has a headline for the reason and real content (not a blank window)', view.headline.length > 5 && view.textLength > 150, view);
    const painted = await run.cmd('capture');
    t.check('and the window really paints it: the capture of the window is not empty', painted.ok && painted.width > 0 && painted.height > 0, painted);
    t.check('the window title is the page title (GadgetsPOS - ...)', /^GadgetsPOS - /.test((await run.cmd('mainInfo')).title), (await run.cmd('mainInfo')).title);
    t.check('it offers Retry now, Printer settings and Change server address', ['Retry now', 'Printer settings', 'Change server address'].every((name) => view.buttons.includes(name)), view.buttons);
    t.check('on it window.desktop has only connection and window, and window.electron is absent (SPEC 6.3)', JSON.stringify(view.desktopKeys) === JSON.stringify(['connection', 'platform', 'version', 'window']) && view.electron === 'undefined', view);
    t.check('window.desktop.connection has getStatus, retryNow, openSettings and onStatus', JSON.stringify(view.connectionKeys) === JSON.stringify(['getStatus', 'onStatus', 'openSettings', 'retryNow']), view.connectionKeys);

    const attemptOf = () => evalIn(page, () => window.desktop.connection.getStatus().then((status) => status.attempt));
    const initial = await attemptOf();
    await t.eventually('the attempt counter goes up by itself (probes come 3 s, 6 s, 12 s ... apart, plus or minus 20 %)', async () => (await attemptOf()) > initial, { timeoutMs: 12_000 });
    const sub = await textOf(page, '#connect-sub');
    t.check('the page tells which attempt it is on', /Attempt \d/.test(sub || ''), sub);
    await page.waitForSelector('#connect[data-state="waiting"]', { timeout: 5000 }).catch(() => {});
    await screenshot(page, 'offline');
    t.note(`the counter went from ${initial} to ${await attemptOf()}`);
  });

  // ---- 2 the server comes back -------------------------------------------------------------------------------------------
  await scenario('2', 'Starting the server makes the app load the POS by itself, right after its next scheduled probe', async (t) => {
    const offline = await run.mainPage();
    // The app schedules its probes itself (3, 6, 12 s ... plus or minus 20 %): the POS must be back right after the next one.
    const scheduled = await waitFor(async () => {
      const status = await evalIn(offline, () => window.desktop.connection.getStatus());
      return Number.isFinite(status.nextRetryInMs) ? status : null;
    }, 'the next scheduled probe', { timeoutMs: 8000 });
    const started = Date.now();
    await pos.start();
    const page = await t.eventually('the POS page replaces the offline page by itself', () => waitForPos(run, pos, 40_000).catch(() => null), { timeoutMs: 41_000, intervalMs: 200 });
    const elapsed = Date.now() - started;
    const allowed = scheduled.nextRetryInMs + 5000;
    t.check(`it came back ${seconds(elapsed)} after the server started; the app's next probe was due in ${seconds(scheduled.nextRetryInMs)} (after attempt ${scheduled.attempt}) and 5 s are allowed for the probe and the page load`, Boolean(page) && elapsed <= allowed, { elapsed, dueIn: scheduled.nextRetryInMs, allowed });
    t.note(`reconnected ${elapsed} ms after the server started (next probe was due in ${scheduled.nextRetryInMs} ms)`);
    if (page) t.check('the page URL is the POS address', page.url().startsWith(pos.url), page.url());
  });

  // ---- 3 the POS page has window.electron --------------------------------------------------------------------------------
  await scenario('3', 'The POS page has window.electron with the documented functions, apiVersion 2, and nothing of the desktop API', async (t) => {
    const page = await run.mainPage();
    const info = await evalIn(page, () => window.__pos.inspect());
    const documented = ['getAppInfo', 'getPrinters', 'openCashDrawer', 'printBarcode', 'printReceipt', 'sendBarcodeData', 'sendOpenDrawerCommand', 'sendReceiptData'];
    t.check('window.electron has exactly the 8 documented functions', JSON.stringify(info.functions) === JSON.stringify(documented), info.functions);
    t.check('every one of them is a function', documented.every((name) => info.types[name] === 'function'), info.types);
    t.check('window.desktop is absent on the POS page (SPEC 6.3)', info.desktop === 'undefined', info.desktop);
    t.check('the sandbox is closed: no require, process, ipcRenderer or Buffer on the page', Object.values(info.sandbox).every((value) => value === 'undefined'), info.sandbox);
    const before = await run.state();
    t.check('no DYMO helper window exists before the first label or printer list (lazy, SPEC 9.4 / 18b L2)', before.dymo.windowsCreated === 0, before.dymo);
    const appInfo = await posCall(page, 'getAppInfo');
    t.check('getAppInfo answers apiVersion 2 with the three features, the platform, and the name and version of the app', appInfo.apiVersion === 2 && JSON.stringify(appInfo.features) === JSON.stringify(['ack-print', 'drawer', 'printer-list']) && appInfo.platform === process.platform && appInfo.version === PACKAGE.version && appInfo.name === PACKAGE.productName, appInfo);
    t.check('the window title follows the page title (18b D4)', (await run.cmd('mainInfo')).title === 'Fake POS', (await run.cmd('mainInfo')).title);
    const printers = await posCall(page, 'getPrinters');
    t.check('getPrinters lists the 3 system printers (one default) and the 2 DYMO printers', printers.system.length === 3 && printers.system.filter((printer) => printer.isDefault).length === 1 && printers.dymo.length === 2, printers);
    const after = await run.state();
    t.check('asking for the printers created the DYMO helper window, once', after.dymo.windowsCreated === 1, after.dymo.windowsCreated);
    const modules = await run.cmd('modules');
    t.check('electron-updater was not loaded (lazy, SPEC 13 / 18b S1)', modules.updaterLoaded === false, modules);
    const gpu = await run.cmd('gpu');
    t.check('hardware acceleration is ON by default (the GPU compositor is enabled, 18b R1)', /^enabled/.test(gpu.gpu_compositing), gpu);
    t.note(`GPU compositing: ${gpu.gpu_compositing}`);
  });

  // ---- 8 settings: printers, password, lockout, test prints --------------------------------------------------------------
  await scenario('8', 'Settings lists the fake printers, saves them, test prints reach the printer; password set, 5 wrong attempts, lockout, then success', async (t) => {
    const posPage = await run.mainPage();
    const fresh = await posCall(posPage, 'printReceipt');
    t.check('a fresh install answers NO_PRINTER_CONFIGURED with a plain message', fresh.ok === false && fresh.code === 'NO_PRINTER_CONFIGURED' && /Settings > Printers/.test(fresh.message), fresh);

    const settings = await openSettings(run, 'settings.printers');
    run.sampleFocus('after Settings opened');
    t.check('the Settings window opened on the Printers tab from the real menu item', (await settings.$eval('#tab-printers', (tab) => tab.getAttribute('aria-selected'))) === 'true');
    const receiptNames = await waitFor(async () => {
      const names = await settings.$$eval('#printers-root [data-role="receipt"] .picker__name', (els) => els.map((el) => el.textContent.trim()));
      return names.length === 3 ? names : null;
    }, 'the receipt printer list', { timeoutMs: 15_000 });
    t.check('the receipt list shows the three printers of the fake system', JSON.stringify(receiptNames) === JSON.stringify(['E2E Receipt Printer', 'E2E Zebra ZD420', 'Office Laser']), receiptNames);
    const badges = await settings.$$eval('#printers-root [data-role="receipt"] .picker__row', (rows) => rows.map((row) => [...row.querySelectorAll('.badge')].map((badge) => badge.textContent.trim())));
    t.check('the default printer has the Default badge and the stopped one says Stopped', badges[0].includes('Default') && badges[2].includes('Stopped'), badges);
    const dymoNames = await waitFor(async () => {
      const names = await settings.$$eval('#printers-root [data-role="dymo"] .picker__name', (els) => els.map((el) => el.textContent.trim()));
      return names.length === 3 ? names : null;
    }, 'the DYMO list', { timeoutMs: 15_000 });
    t.check('the DYMO list is Automatic plus the two printers DYMO Connect reports', dymoNames[0] === 'Automatic (recommended)' && dymoNames.includes('DYMO LabelWriter 450'), dymoNames);

    const pick = async (role, label) => {
      const row = await settings.evaluateHandle((roleName, text) => [...document.querySelectorAll(`#printers-root [data-role="${roleName}"] .picker__row`)].find((item) => item.querySelector('.picker__name').textContent.trim() === text) || null, role, label);
      if (!row.asElement()) throw new Error(`no printer "${label}" in the ${role} list`);
      await row.asElement().click();
    };
    const part = (name, selector) => `#printers-root [data-role="${name}"] ${selector}`;

    await pick('receipt', 'E2E Receipt Printer');
    const unsaved = await textOf(settings, part('receipt', '.role__foot-note'));
    t.check('choosing a printer shows "Unsaved changes"', /Unsaved changes/.test(unsaved || ''), unsaved);
    await settings.click(part('receipt', '.role__buttons .btn--primary'));
    await t.eventually('Save answers "Saved"', async () => /Saved/.test((await textOf(settings, part('receipt', '.role__foot-note'))) || ''));
    const saved = (await run.cmd('config')).printers.receipt;
    t.check('the receipt printer is saved as an installed printer', saved.transport === 'system' && saved.printerName === 'E2E-Receipt-58' && saved.port === '', saved);
    const stored = readJson(path.join(run.userData, 'config.json'));
    t.check('and it is on disk in config.json (schema 2)', stored.schemaVersion === 2 && stored.printers.receipt.printerName === 'E2E-Receipt-58', stored.printers);

    const jobsBefore = (await run.jobs('receipt')).length;
    await settings.click(part('receipt', '.role__buttons .btn:not(.btn--primary)'));
    const slip = await t.eventually('the test print reaches the fake raw printer', async () => ((await run.jobs('receipt')).length > jobsBefore ? (await run.jobs('receipt')).at(-1) : null));
    if (slip) {
      const bytes = Buffer.from(slip.hex, 'hex');
      t.check('it is an ESC/POS slip (initialise first, cut last) for the chosen printer', bytes[0] === 0x1b && bytes[1] === 0x40 && bytes.includes('Printer test') && bytes.includes('Printer: E2E-Receipt-58') && bytes.at(-3) === 0x1d, slip.hex);
      t.check('it went to the saved target', slip.target.transport === 'system' && slip.target.printerName === 'E2E-Receipt-58', slip.target);
    }
    await t.eventually('the page says where the test went', async () => /Test receipt sent to E2E-Receipt-58/.test((await textOf(settings, part('receipt', '.role__foot-note'))) || ''));
    await settings.evaluate(() => { document.getElementById('content').scrollTop = 0; });
    await sleep(250);
    await screenshot(settings, 'settings-printers');
    await screenshotDark(settings, 'settings-printers-dark');
    await settings.evaluate(() => document.querySelector('#printers-root [data-role="receipt"] .role__foot').scrollIntoView({ block: 'center' }));
    await sleep(250);
    await screenshot(settings, 'settings-printers-test');
    await settings.evaluate(() => { document.getElementById('content').scrollTop = 0; });

    await pick('label', 'E2E Zebra ZD420');
    await settings.click(part('label', '.role__buttons .btn--primary'));
    await t.eventually('the label printer is saved', async () => (await run.cmd('config')).printers.label.printerName === 'E2E-Zebra-ZD420');
    await settings.click(part('label', '.role__buttons .btn:not(.btn--primary)'));
    const zpl = await t.eventually('the Zebra test label reaches the raw printer', async () => (await run.jobs('label zebra')).at(-1) || null);
    if (zpl) t.check('it is a ZPL label with the word TEST and goes to the label printer', Buffer.from(zpl.hex, 'hex').toString().includes('^FDTEST^FS') && zpl.target.printerName === 'E2E-Zebra-ZD420', zpl);

    await pick('dymo', 'DYMO LabelWriter 450');
    await settings.click(part('dymo', '.role__buttons .btn--primary'));
    await t.eventually('the DYMO printer is saved', async () => (await run.cmd('config')).printers.dymo.printerName === 'DYMO LabelWriter 450');
    await settings.click(part('dymo', '.role__buttons .btn:not(.btn--primary)'));
    const dymoLabel = await t.eventually('the DYMO test label is printed through the real DYMO service on the chosen printer', async () => (await dymoLabels(run)).find((label) => label.printed && label.printer === 'DYMO LabelWriter 450') || null);
    if (dymoLabel) t.check('with the test title on it', dymoLabel.ops.some((op) => op.value.includes('GadgetsPOS test label')), dymoLabel.ops);

    // -- the drawer password and its lockout --
    await settings.click('#tab-drawer');
    t.check('before a password is set the drawer card says so', /No password/.test((await textOf(settings, '#pw-badge')) || ''), await textOf(settings, '#pw-badge'));
    await settings.click('#pw-open');
    await settings.waitForSelector('dialog[open] #dlg-new');
    await typeInto(settings, '#dlg-new', DRAWER_PASSWORD);
    await typeInto(settings, '#dlg-confirm', DRAWER_PASSWORD);
    await settings.click('dialog[open] .dialog__foot button[type="submit"]');
    await t.eventually('the password dialog closes and the badge says "Password set"', async () => /Password set/.test((await textOf(settings, '#pw-badge')) || ''));
    const publicConfig = await run.cmd('config');
    t.check('the state shows passwordSet and never the record', publicConfig.drawer.passwordSet === true && !('passwordRecord' in publicConfig.drawer), publicConfig.drawer);
    const record = readJson(path.join(run.userData, 'config.json')).drawer.passwordRecord;
    t.check('on disk the password is a scrypt hash, not the text', record && record.algo === 'scrypt' && !JSON.stringify(record).includes(DRAWER_PASSWORD), record && record.algo);

    await run.cmd('menuClick', { id: 'drawer' });
    const prompt = await run.waitPage(isPasswordUrl, 'the password window');
    run.sampleFocus('after the password window opened');
    await prompt.waitForFunction(() => document.querySelector('#pw-input') !== null);
    t.check('the password window opened from the Open Drawer menu item', /Open cash drawer/.test((await textOf(prompt, '#pw-title')) || ''));
    await sleep(300);
    await screenshot(prompt, 'password-prompt');
    const fromSettings = await evalIn(settings, () => window.desktop.password.getLockout());
    const fromPrompt = await evalIn(prompt, () => window.desktop.settings.getState());
    t.check('main enforces the area of each window: the Settings window is refused the password area and the password window the settings area (UNTRUSTED_SENDER)', fromSettings.ok === false && fromSettings.code === 'UNTRUSTED_SENDER' && fromPrompt.ok === false && fromPrompt.code === 'UNTRUSTED_SENDER', { fromSettings, fromPrompt });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await typeInto(prompt, '#pw-input', `wrong-${attempt}`);
      await prompt.keyboard.press('Enter');
      if (attempt < 5) {
        await waitFor(async () => (await isShown(prompt, '#pw-error')) && /not correct/.test((await textOf(prompt, '#pw-error')) || ''), `the wrong-password message of attempt ${attempt}`, { timeoutMs: 8000 });
      }
    }
    await t.eventually('after the 5th wrong password the window locks and shows the countdown', async () => (await isShown(prompt, '#lock-banner')) && /^\d+:\d{2}$/.test((await textOf(prompt, '#lock-time')) || ''), { timeoutMs: 8000 });
    t.check('the password field is disabled while locked', await prompt.$eval('#pw-input', (input) => input.disabled));
    await sleep(250);
    await screenshot(prompt, 'password-locked');

    const locked = await posCall(posPage, 'openCashDrawer', { password: DRAWER_PASSWORD });
    t.check('the RIGHT password is refused while locked (DRAWER_LOCKED_OUT with retryAfterSec)', locked.ok === false && locked.code === 'DRAWER_LOCKED_OUT' && locked.details.retryAfterSec > 0 && locked.details.retryAfterSec <= 30, locked);
    const lockedSettings = await evalIn(settings, (password) => window.desktop.settings.openDrawerTest({ password }), DRAWER_PASSWORD);
    t.check('the lock is shared: the Settings drawer test is refused too', lockedSettings.ok === false && lockedSettings.code === 'DRAWER_LOCKED_OUT', lockedSettings);
    t.check('no pulse was sent while locked', (await run.jobs('cash drawer')).length === 0, await run.jobs('cash drawer'));

    await run.cmd('advanceClock', { ms: 31_000 });
    await pressClosing(prompt, 'Escape');
    await waitFor(async () => !(await run.findPage(isPasswordUrl)), 'the password window to close on Escape', { timeoutMs: 8000 });
    await run.cmd('menuClick', { id: 'drawer' });
    const prompt2 = await run.waitPage(isPasswordUrl, 'the password window again');
    await prompt2.waitForFunction(() => document.querySelector('#pw-input') !== null);
    await sleep(300);
    t.check('after 31 s on the injected clock the lock is gone', !(await isShown(prompt2, '#lock-banner')) && !(await prompt2.$eval('#pw-input', (input) => input.disabled)));
    await typeInto(prompt2, '#pw-input', DRAWER_PASSWORD);
    await prompt2.keyboard.press('Enter').catch(() => {});
    await t.eventually('the right password is accepted: the window closes itself', async () => !(await run.findPage(isPasswordUrl)), { timeoutMs: 8000 });
    const pulse = await t.eventually('the pulse reaches the receipt printer', async () => (await run.jobs('cash drawer')).at(-1) || null);
    if (pulse) t.check(`the pulse is ESC p 0 25 255 (${DRAWER_PULSE_HEX}) on the receipt printer`, pulse.hex === DRAWER_PULSE_HEX && pulse.target.printerName === 'E2E-Receipt-58', pulse);

    await typeInto(settings, '#drawer-test-pw', DRAWER_PASSWORD);
    await settings.click('#drawer-test');
    await t.eventually('Settings "Open drawer (test)" says the command was sent', async () => /Open command sent/.test((await textOf(settings, '#drawer-test-status')) || ''), { timeoutMs: 8000 });
    const pulses = await run.jobs('cash drawer');
    t.check('and the drawer test printed the same pulse bytes', pulses.length === 2 && pulses[1].hex === DRAWER_PULSE_HEX, pulses.map((job) => job.hex));
    t.check('no native box was shown for any of this (the windows handle their own messages)', (await run.state()).dialogs.length === 0, (await run.state()).dialogs);
  });

  // ---- 4 every legacy and new print call --------------------------------------------------------------------------------
  await scenario('4', 'Legacy and new print calls produce the expected jobs and results; failures give the right code and one coalesced box', async (t) => {
    const page = await run.mainPage();
    const call = (name, args) => posCall(page, name, args);
    const expected = await evalIn(page, () => window.__pos.expected);
    const waitJobs = (label, count) => waitFor(async () => ((await run.jobs(label)).length >= count ? run.jobs(label) : null), `${count} ${label} job(s)`, { timeoutMs: 8000 });

    // legacy, fire-and-forget
    let receipts = (await run.jobs('receipt')).length;
    await call('sendReceiptData');
    let list = await waitJobs('receipt', receipts + 1);
    let job = list.at(-1);
    t.check('legacy sendReceiptData: the receipt bytes arrive unchanged on the receipt printer (20 KB of unread order data did not matter)', job.hex === expected.receiptHex && job.target.printerName === 'E2E-Receipt-58', { length: job.length });
    const zebras = (await run.jobs('label zebra')).length;
    await call('sendBarcodeData');
    list = await waitJobs('label zebra', zebras + 1);
    job = list.at(-1);
    t.check('legacy sendBarcodeData (ZPL): the label arrives as UTF-8 on the label printer', job.hex === expected.zebraHex && job.target.printerName === 'E2E-Zebra-ZD420', job);
    const labelsBefore = (await dymoLabels(run)).length;
    await call('sendBarcodeData:dymo');
    const legacyLabel = (await waitFor(async () => {
      const labels = await dymoLabels(run);
      return labels.length > labelsBefore ? labels : null;
    }, 'the legacy DYMO label', { timeoutMs: 8000 })).at(-1);
    t.check('legacy DYMO label: printed on the chosen DYMO printer', legacyLabel.printed === true && legacyLabel.printer === 'DYMO LabelWriter 450', legacyLabel);
    t.check('a title with double quotes prints with the quotes (v1 lost this label)', legacyLabel.ops.some((op) => op.value.toUpperCase() === 'APPLE IPHONE 13 "PRO" 256GB'), legacyLabel.ops);

    // new, acknowledged
    receipts = (await run.jobs('receipt')).length;
    const printed = await call('printReceipt');
    t.check('printReceipt answers { ok: true } and prints', printed.ok === true && (await run.jobs('receipt')).length === receipts + 1, printed);
    const emptyReceipt = await call('printReceipt:empty');
    t.check('an empty receipt answers INVALID_PAYLOAD and prints nothing', emptyReceipt.ok === false && emptyReceipt.code === 'INVALID_PAYLOAD' && (await run.jobs('receipt')).length === receipts + 1, emptyReceipt);
    const zebra = await call('printBarcode');
    t.check('printBarcode (ZPL) answers { ok: true }', zebra.ok === true, zebra);
    const dymoResult = await call('printBarcode:dymo');
    t.check('printBarcode (DYMO) answers { ok: true }', dymoResult.ok === true, dymoResult);
    const lab = await call('printBarcode:lab');
    const labLabel = (await dymoLabels(run)).at(-1);
    t.check('a lab item label answers { ok: true } and reads barcode and title from the outer envelope', lab.ok === true && labLabel.ops.some((op) => op.name === 'BarcodeObject1' && op.value === 'LAB-000042') && labLabel.ops.some((op) => op.name === 'TextObject12' && op.value.includes('Battery')), { lab, ops: labLabel.ops });
    const repairBefore = (await dymoLabels(run)).length;
    const repair = await call('printBarcode:repair');
    const repairLabels = (await dymoLabels(run)).slice(repairBefore);
    t.check('a repair message prints one label per order item (2) and answers { ok: true }', repair.ok === true && repairLabels.length === 2 && repairLabels.every((label) => label.printed), { repair, count: repairLabels.length });

    // the cash drawer
    const wrong = await call('openCashDrawer', { password: 'nope' });
    t.check('openCashDrawer with a wrong password answers DRAWER_WRONG_PASSWORD', wrong.ok === false && wrong.code === 'DRAWER_WRONG_PASSWORD', wrong);
    const pulses = (await run.jobs('cash drawer')).length;
    const right = await call('openCashDrawer', { password: DRAWER_PASSWORD });
    const pulseJobs = await run.jobs('cash drawer');
    t.check('openCashDrawer with the right password opens the drawer: the pulse is on the receipt printer', right.ok === true && pulseJobs.length === pulses + 1 && pulseJobs.at(-1).hex === DRAWER_PULSE_HEX, { right, last: pulseJobs.at(-1) });
    await call('sendOpenDrawerCommand', { password: DRAWER_PASSWORD });
    await t.eventually('the legacy sendOpenDrawerCommand({ cashDrawerOpenPassword }) opens it too', async () => (await run.jobs('cash drawer')).length === pulses + 2, { timeoutMs: 8000 });
    const button = await call('printReceipt:openButton');
    t.check('the web Open button (printReceipt({ openCashDrawer: true, order: false })) answers { ok: true, details: { prompted: true } }', button.ok === true && button.details && button.details.prompted === true, button);
    const prompt = await run.waitPage(isPasswordUrl, 'the password window of the Open button');
    t.check('and the password window opened', Boolean(prompt));
    await prompt.waitForFunction(() => document.querySelector('#pw-input') !== null);
    await pressClosing(prompt, 'Escape');
    await waitFor(async () => !(await run.findPage(isPasswordUrl)), 'the password window to close', { timeoutMs: 8000 });
    await call('sendReceiptData:openButton');
    const legacyPrompt = await run.waitPage(isPasswordUrl, 'the password window of the legacy Open button');
    t.check('the legacy Open button (sendReceiptData({ openCashDrawer: true, order: false })) opens the password window as well', Boolean(legacyPrompt));
    await legacyPrompt.waitForFunction(() => document.querySelector('#pw-input') !== null);
    await pressClosing(legacyPrompt, 'Escape');
    await waitFor(async () => !(await run.findPage(isPasswordUrl)), 'the password window to close', { timeoutMs: 8000 });
    t.check('none of this showed a native error box', (await run.state()).dialogs.length === 0, (await run.state()).dialogs);

    // failing printers
    await run.cmd('failPrinter', { code: 'SPOOLER_ERROR' });
    const failedReceipt = await call('printReceipt');
    t.check('a failing printer: printReceipt answers { ok: false, code: SPOOLER_ERROR } with a plain message', failedReceipt.ok === false && failedReceipt.code === 'SPOOLER_ERROR' && /could not send the job to the printer/.test(failedReceipt.message), failedReceipt);
    const failedLabel = await call('printBarcode');
    t.check('and printBarcode gives the same code', failedLabel.ok === false && failedLabel.code === 'SPOOLER_ERROR', failedLabel);
    await run.cmd('failPrinter', { code: 'PRINTER_NOT_FOUND', details: { printerName: 'E2E-Receipt-58' } });
    const notFound = await call('printReceipt');
    t.check('PRINTER_NOT_FOUND names the printer in its message', notFound.ok === false && notFound.code === 'PRINTER_NOT_FOUND' && /E2E-Receipt-58/.test(notFound.message), notFound);
    await run.cmd('failPrinter', { code: 'SPOOLER_ERROR' });
    const boxesBefore = (await run.state()).dialogs.length;
    await call('sendReceiptData');
    await call('sendReceiptData');
    await call('sendReceiptData');
    await waitFor(async () => (await run.state()).dialogs.length > boxesBefore, 'the error box of the legacy path', { timeoutMs: 8000 });
    await sleep(700);
    const boxes = (await run.state()).dialogs.slice(boxesBefore);
    t.check('the legacy path shows EXACTLY ONE native box for three failed receipts (coalesced per code)', boxes.length === 1, boxes);
    t.check('it says what failed and what to do', boxes[0] && boxes[0].message === 'The receipt could not be printed' && /could not send the job to the printer/.test(boxes[0].detail), boxes[0]);
    await run.cmd('advanceClock', { ms: 6000 });
    await call('sendReceiptData');
    await t.eventually('after 5 seconds (injected clock) the same error may show a new box', async () => (await run.state()).dialogs.length === boxesBefore + 2, { timeoutMs: 8000 });
    await run.cmd('failPrinter', { code: null });

    await run.cmd('dymoFail', { message: 'The printer is out of labels' });
    const dymoFailed = await call('printBarcode:dymo');
    t.check('a failing DYMO printer answers DYMO_PRINT_FAILED and carries the framework message in the details', dymoFailed.ok === false && dymoFailed.code === 'DYMO_PRINT_FAILED' && /out of labels/.test(dymoFailed.details.reason), dymoFailed);
    await run.cmd('dymoFail', { message: null });
    const dymoAgain = await call('printBarcode:dymo');
    t.check('and DYMO prints again once the printer is fine', dymoAgain.ok === true, dymoAgain);

    // the fake POS keeps a record of every call: in its page and at its /report endpoint
    const inPage = await evalIn(page, () => ({ lines: document.querySelectorAll('#results li').length, calls: window.__pos.results.length }));
    t.check('every call is also written into the page (a line each in #results)', inPage.lines === inPage.calls && inPage.calls >= 20, inPage);
    const report = await pos.waitForReport('printBarcode:repair', { timeoutMs: 5000 }).catch(() => null);
    t.check('and posted to the server\'s /report endpoint with its result', report && report.ok === true && report.result.ok === true, report);
    t.check('the server saw the failed calls too (ok: false results are recorded as they were answered)', pos.reports.some((entry) => entry.name === 'printReceipt' && entry.result && entry.result.code === 'SPOOLER_ERROR'), pos.reports.length);
  });

  // ---- 5 emulated offline: the banner ------------------------------------------------------------------------------------
  await scenario('5', 'Emulated offline shows the banner, then "Back online"', async (t) => {
    const page = await run.mainPage();
    const marker = await evalIn(page, () => window.__pos.marker);
    t.check('no banner exists while the page is online (it is created only when it is first needed)', (await readBanner(page)) === null);
    const height = await evalIn(page, () => document.documentElement.scrollHeight);
    // ONE session does it all: detaching another session would cancel the emulation it did not start.
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const offline = await t.eventually('the banner appears (data-state offline) with its text', async () => {
      const banner = await readBanner(page, client);
      return banner && banner.state === 'offline' && banner.text.length > 0 ? banner : null;
    }, { timeoutMs: 6000 });
    if (offline) {
      t.check('it says "No internet connection. We\'ll keep trying - your work on this page is not lost."', offline.text === 'No internet connection. We\'ll keep trying \u2014 your work on this page is not lost.', offline.text);
      t.check('it is at most 48 px high and has a Dismiss button', offline.height > 0 && offline.height <= 48 && offline.buttonEnabled, offline);
    }
    t.check('it does not shift the page layout', (await evalIn(page, () => document.documentElement.scrollHeight)) === height);
    await sleep(450);
    await screenshot(page, 'pos-banner', client);
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await t.eventually('"Back online" appears when the connection returns', async () => {
      const banner = await readBanner(page, client);
      return banner && banner.state === 'online' && banner.text === 'Back online' ? banner : null;
    }, { timeoutMs: 6000 });
    await t.eventually('and it goes away after 3 seconds', async () => (await readBanner(page, client)).state === 'hidden', { timeoutMs: 6000 });
    t.check('the page was not reloaded (the marker survived)', (await evalIn(page, () => window.__pos.marker)) === marker);
    await client.send('Network.disable').catch(() => {});
    await client.detach().catch(() => {});
  });

  // ---- 5b a server that vanishes mid-session -------------------------------------------------------------------------------
  await scenario('5b', 'A server that vanishes mid-session raises the banner from request errors alone, and "Back online" follows without a reload (SPEC 11.3)', async (t) => {
    const page = await run.mainPage();
    const marker = await evalIn(page, () => window.__pos.marker);
    const logFile = path.join(run.userData, 'logs', 'main.log');
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    t.check('before the outage the app had not started a banner probe (nothing runs while all is well)', !/banner mode started/.test(before));
    await pos.stop();
    const pings = await evalIn(page, () => Promise.all([window.__pos.helpers.ping(1), window.__pos.helpers.ping(2)]));
    t.check('two requests of the page failed', pings.every((answer) => answer.error), pings);
    await t.eventually('the app notices (two request errors in 10 s) and the banner says offline', async () => {
      const banner = await readBanner(page);
      return banner && banner.state === 'offline' ? banner : null;
    }, { timeoutMs: 10_000 });
    t.check('the log says the banner probe started', /banner mode started/.test(fs.readFileSync(logFile, 'utf8')));
    await pos.start();
    await t.eventually('the next probe finds the server: "Back online"', async () => {
      const banner = await readBanner(page);
      return banner && banner.state === 'online' ? banner : null;
    }, { timeoutMs: 15_000 });
    t.check('the page was NOT reloaded: only the full-screen offline page reloads', (await evalIn(page, () => window.__pos.marker)) === marker && page.url().startsWith(pos.origin));
    await t.eventually('and the banner goes away again', async () => (await readBanner(page)).state === 'hidden', { timeoutMs: 6000 });
  });

  // ---- 7 navigation guards, popups ---------------------------------------------------------------------------------------
  await scenario('7', 'A page cannot navigate or open windows to other origins; allowed about:blank and blob: windows work', async (t) => {
    const page = await run.mainPage();
    const marker = await evalIn(page, () => window.__pos.marker);
    const unchanged = async () => page.url().startsWith(pos.origin) && (await evalIn(page, () => window.__pos.marker)) === marker;
    const otherUrl = `${other.origin}/vendor/point-of-sale`;
    let state = await run.state();
    const opened = state.openExternal.length;
    const notices = state.notices.length;
    const windowCount = (await run.cmd('windows')).length;

    await evalIn(page, (url) => window.__pos.helpers.navigate(url), otherUrl);
    await sleep(900);
    t.check('navigating to another origin (a second fake server) is blocked: the page stays, the marker is intact', await unchanged(), page.url());
    t.check('and that server never got a request', other.hits('/') === 0, other.requests);
    state = await run.state();
    t.check('an http address is not given to the system browser either (only https, mailto and tel are)', state.openExternal.length === opened, state.openExternal);

    await evalIn(page, () => window.__pos.helpers.navigate('https://evil.example.com/steal?token=1'));
    await sleep(900);
    state = await run.state();
    t.check('navigating to a foreign https address is blocked and handed to the (fake) system browser', (await unchanged()) && state.openExternal.length === opened + 1 && state.openExternal.at(-1).url === 'https://evil.example.com/steal?token=1', state.openExternal);
    t.check('with the one-line notice "Opened in your browser: evil.example.com"', state.notices.length === notices + 1 && state.notices.at(-1).body === 'Opened in your browser: evil.example.com', state.notices);

    const foreign = await evalIn(page, (url) => window.__pos.helpers.openWindow(url), otherUrl);
    await sleep(600);
    t.check('window.open to the other origin gives the page null; nothing opened and the server saw nothing', foreign.isNull === true && other.requests.length === 0 && (await run.cmd('windows')).length === windowCount, foreign);
    const foreignHttps = await evalIn(page, () => window.__pos.helpers.openWindow('https://evil.example.com/y'));
    await sleep(600);
    state = await run.state();
    t.check('window.open to a foreign https address goes to the (fake) openExternal; the opener gets null', foreignHttps.isNull === true && state.openExternal.at(-1).url === 'https://evil.example.com/y' && (await run.cmd('windows')).length === windowCount, { foreignHttps, last: state.openExternal.at(-1) });

    const blank = await evalIn(page, () => window.__pos.helpers.openBlank('<title>popup title</title><p>hello popup</p>'));
    t.check('window.open("about:blank") gives the page a real window it can write into (pdfMake and print() popups)', blank.opened === true && blank.title === 'popup title', blank);
    const popup = await run.waitPage((url) => url === 'about:blank', 'the about:blank window');
    const popupInfo = await evalIn(popup, () => ({ electron: typeof window.electron, desktop: typeof window.desktop, text: document.body.innerText }));
    t.check('it shows what the page wrote, has window.electron (an allowed origin) and no window.desktop', popupInfo.electron === 'object' && popupInfo.desktop === 'undefined' && /hello popup/.test(popupInfo.text), popupInfo);
    await popup.close();
    // The page has now used its three opens (two for the system browser, one popup): a fourth within ten seconds is refused (SPEC 12, OPEN_LIMITS).
    const tooMany = await evalIn(page, () => window.__pos.helpers.openBlank('<p>one too many</p>'));
    t.check('a fourth popup or browser open within ten seconds is refused: the page gets null (3 per 10 s per window)', tooMany.opened === false, tooMany);
    const mainLog = path.join(run.userData, 'logs', 'main.log');
    await t.eventually('the log says so once, with no address', () => (fs.readFileSync(mainLog, 'utf8').match(/window-open blocked \(rate-limited\): no address/g) || []).length === 1, { timeoutMs: 6000 });
    await run.cmd('advanceClock', { ms: 11_000 }); // ten seconds later the budget is back
    const blob = await evalIn(page, () => window.__pos.helpers.openBlob('<title>blob doc</title><p>hello blob</p>'));
    const blobPage = await run.waitPage((url) => url.startsWith('blob:'), 'the blob window');
    const blobInfo = await evalIn(blobPage, () => ({ url: location.href, electron: typeof window.electron, desktop: typeof window.desktop, text: document.body.innerText }));
    t.check('a blob: URL of this origin opens and shows its content (pdfMake)', blob.opened === true && blobInfo.url.startsWith(`blob:${pos.origin}/`) && /hello blob/.test(blobInfo.text), { blob, blobInfo });
    t.check('it has window.electron and no window.desktop', blobInfo.electron === 'object' && blobInfo.desktop === 'undefined', blobInfo);
    await blobPage.close();
    run.sampleFocus('after popups opened');
    t.check('the POS page was untouched through all of this', await unchanged());
  });

  // ---- 7b permissions ----------------------------------------------------------------------------------------------------
  await scenario('7b', 'Browser permissions: notifications are allowed for the POS origin, everything else is denied (SPEC 12)', async (t) => {
    const page = await run.mainPage();
    const answers = await evalIn(page, async () => {
      const geolocation = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error) => resolve(`denied (${error.code})`), { timeout: 4000 });
      });
      return {
        notifications: await Notification.requestPermission(),
        notificationsState: (await navigator.permissions.query({ name: 'notifications' })).state,
        geolocationState: (await navigator.permissions.query({ name: 'geolocation' })).state,
        geolocation,
      };
    });
    t.check('Notification.requestPermission() is granted for the POS origin, and its state says granted', answers.notifications === 'granted' && answers.notificationsState === 'granted', answers);
    t.check('geolocation is denied: its state says denied and asking for a position fails with PERMISSION_DENIED (1)', answers.geolocationState === 'denied' && answers.geolocation === 'denied (1)', answers);
  });

  // ---- 11 startup marks --------------------------------------------------------------------------------------------------
  await scenario('11', 'Startup marks are in the diagnostics, in order, and shown in Settings > About > Startup details (18b S3)', async (t) => {
    const settings = await openSettings(run, 'settings.drawer');
    const text = await evalIn(settings, () => window.desktop.settings.copyDiagnostics());
    const marks = marksOf(text);
    t.check('the diagnostics list every startup mark', MARK_ORDER.every((name) => name in marks), marks);
    const values = MARK_ORDER.map((name) => marks[name]);
    t.check('and they never go backwards (monotonic, in the order the app reaches them)', values.every((value, index) => index === 0 || value >= values[index - 1]) && values[0] === 0, values);
    t.check('the diagnostics put the same text on the (fake) clipboard', (await run.state()).clipboard.at(-1) === text);
    t.check('they carry no secret: no password hash, no password, no receipt text', !/scrypt|drawer-1234|Printer test/.test(text));
    t.check('they say development build, platform and versions', /development build/.test(text) && text.includes(process.platform) && new RegExp(`Electron ${ELECTRON_MAJOR}\\.`).test(text), text.split('\n').slice(0, 4));
    t.note(`startup: ${MARK_ORDER.map((name) => `${name} ${marks[name]}`).join(', ')}`);
    t.note(`main-process boot (app-ready -> loading-visible): ${marks['loading-visible'] - marks['app-ready']} ms`);

    await run.cmd('menuClick', { id: 'help.about' });
    await t.eventually('Help > About GadgetsPOS switches the open Settings window to the About tab', async () => (await settings.$eval('#tab-about', (tab) => tab.getAttribute('aria-selected'))) === 'true');
    t.check('in a development run without a test feed the About tab says automatic updates are off', /Automatic updates are off/.test((await textOf(settings, '#update-headline')) || ''), await textOf(settings, '#update-headline'));
    await run.cmd('menuClick', { id: 'help.logs' });
    t.check('Help > Open logs folder asks the (fake) shell to open <userData>/logs', (await run.state()).openPath.at(-1) === path.join(run.userData, 'logs'), (await run.state()).openPath);
    const before = await run.state();
    await run.cmd('menuClick', { id: 'help.diagnostics' });
    const after = await run.state();
    t.check('Help > Copy diagnostics copies the diagnostics and says so in a notice', after.clipboard.length === before.clipboard.length + 1 && /^Startup: /m.test(after.clipboard.at(-1)) && after.notices.length === before.notices.length + 1 && after.notices.at(-1).body === 'Diagnostics copied to the clipboard.', { clipboard: after.clipboard.length - before.clipboard.length, notice: after.notices.at(-1) });
    await settings.click('#startup > summary');
    const rows = await t.eventually('Startup details lists the marks in a table', async () => {
      const found = await settings.$$eval('#startup-body .startup-table tbody tr', (trs) => trs.map((tr) => tr.textContent.trim()));
      return found.length >= MARK_ORDER.length ? found : null;
    }, { timeoutMs: 6000 });
    if (rows) t.check('with friendly labels, first "Program started" and last "POS page fully loaded"', /Program started/.test(rows[0]) && /POS page fully loaded/.test(rows.at(-1)), rows);
    const log = fs.readFileSync(path.join(run.userData, 'logs', 'main.log'), 'utf8');
    t.check('the log has the same numbers as ONE line', (log.match(/startup: process-start 0 ms/g) || []).length === 1, log.split('\n').filter((line) => /startup:/.test(line)));
  });

  // ---- 15 the right-click menu -------------------------------------------------------------------------------------------
  await scenario('15', 'A context-menu event builds the expected template (editable, selection, link, image); a real right click on a field does too', async (t) => {
    const labelsOf = (popup) => popup.template.map((item) => item.label || item.type);
    const dev = ['separator', 'Inspect element'];

    const editable = (await run.cmd('contextMenu', { params: { isEditable: true, editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true }, x: 12, y: 34, mediaType: 'none', linkURL: '', selectionText: '' } }))[0];
    t.check('an editable field: Undo, Redo, Cut, Copy, Paste, Select all, then Inspect element (development)', editable && JSON.stringify(labelsOf(editable)) === JSON.stringify(['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'separator', 'Select all', ...dev]), editable && labelsOf(editable));
    if (editable) {
      const byLabel = Object.fromEntries(editable.template.filter((item) => item.label).map((item) => [item.label, item]));
      t.check('the standard roles carry the platform accelerators', byLabel.Undo.role === 'undo' && byLabel.Redo.role === 'redo' && byLabel.Cut.role === 'cut' && byLabel.Copy.role === 'copy' && byLabel.Paste.role === 'paste' && byLabel['Select all'].role === 'selectAll', editable.template);
      t.check('Chromium\'s edit flags decide what is greyed out (nothing to undo, cut or copy; paste and select all possible)', byLabel.Undo.enabled === false && byLabel.Cut.enabled === false && byLabel.Copy.enabled === false && byLabel.Paste.enabled === true && byLabel['Select all'].enabled === true, byLabel);
      t.check('it popped up in the POS window', editable.hasWindow === true);
    }
    const selection = (await run.cmd('contextMenu', { params: { isEditable: false, selectionText: 'IMEI 352099001761481', x: 1, y: 1, mediaType: 'none', linkURL: '' } }))[0];
    t.check('selected text: Copy only', selection && JSON.stringify(labelsOf(selection)) === JSON.stringify(['Copy', ...dev]), selection && labelsOf(selection));
    const link = (await run.cmd('contextMenu', { params: { isEditable: false, selectionText: '', linkURL: 'https://example.com/order/1', x: 1, y: 1, mediaType: 'none' } }))[0];
    t.check('a safe link: Open link in browser and Copy link address', link && JSON.stringify(labelsOf(link)) === JSON.stringify(['Open link in browser', 'Copy link address', ...dev]), link && labelsOf(link));
    const stateBefore = await run.state();
    await run.cmd('popupClick', { label: 'Open link in browser' });
    await run.cmd('popupClick', { label: 'Copy link address' });
    const stateAfter = await run.state();
    t.check('"Open link in browser" reaches the system browser and "Copy link address" the clipboard', stateAfter.openExternal.at(-1).url === 'https://example.com/order/1' && stateAfter.clipboard.length === stateBefore.clipboard.length + 1 && stateAfter.clipboard.at(-1) === 'https://example.com/order/1', { openExternal: stateAfter.openExternal.at(-1), clipboard: stateAfter.clipboard.at(-1) });
    const scripted = (await run.cmd('contextMenu', { params: { isEditable: false, selectionText: '', linkURL: 'javascript:alert(1)', x: 1, y: 1, mediaType: 'none' } }))[0];
    t.check('a javascript: link gets no link items', JSON.stringify(scripted ? labelsOf(scripted) : null) === JSON.stringify(dev.slice(1)), scripted && labelsOf(scripted));
    const image = (await run.cmd('contextMenu', { params: { isEditable: false, selectionText: '', linkURL: '', mediaType: 'image', srcURL: 'https://example.com/a.png', x: 5, y: 6 } }))[0];
    t.check('an image: Copy image and Save image as...', image && JSON.stringify(labelsOf(image)) === JSON.stringify(['Copy image', 'Save image as…', ...dev]), image && labelsOf(image));
    const blank = await run.cmd('contextMenu', { params: { isEditable: false, selectionText: '', linkURL: '', mediaType: 'none', x: 1, y: 1 } });
    t.check('the Developer Tools menu item exists in a development run', JSON.stringify(await run.cmd('menu')).includes('Toggle Developer Tools'));
    t.check('a click on an empty area still offers Inspect element in development', JSON.stringify(labelsOf(blank[0])) === JSON.stringify(['Inspect element']), blank[0] && labelsOf(blank[0]));

    const page = await run.mainPage();
    const point = await page.$eval('#note', (input) => {
      const box = input.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    });
    const real = (await run.cmd('rightClick', point))[0];
    t.check('a REAL right click on the note field: Chromium itself reports an editable field, so the editing items are offered', real && ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all'].every((label) => labelsOf(real).includes(label)), real && labelsOf(real));
  });

  // ---- 17 zoom -----------------------------------------------------------------------------------------------------------
  await scenario('17', 'View > Zoom in, Zoom out and Actual size change the page zoom and it is remembered (window.zoomLevel, SPEC 12b)', async (t) => {
    const configFile = path.join(run.userData, 'config.json');
    const zoomOf = async () => (await run.cmd('mainInfo')).zoomLevel;
    const saved = () => readJson(configFile).window.zoomLevel;
    t.check('the page starts at zoom level 0', (await zoomOf()) === 0, await zoomOf());
    await run.cmd('menuClick', { id: 'view.zoom-in' });
    await run.cmd('menuClick', { id: 'view.zoom-in' });
    t.check('two steps of Zoom in give level 1 (half a step each)', (await zoomOf()) === 1, await zoomOf());
    await t.eventually('and the level is saved as window.zoomLevel', async () => saved() === 1);
    await run.cmd('menuClick', { id: 'view.reload' });
    await waitFor(async () => (await run.cmd('mainInfo')).url.startsWith(pos.origin), 'the reload to finish', { timeoutMs: 10_000 });
    await waitForPos(run, pos, 15_000);
    t.check('after View > Reload the level is still 1', (await zoomOf()) === 1, await zoomOf());
    await run.cmd('menuClick', { id: 'view.zoom-out' });
    t.check('Zoom out gives level 0.5', (await zoomOf()) === 0.5, await zoomOf());
    await run.cmd('menuClick', { id: 'view.zoom-reset' });
    t.check('Actual size gives level 0', (await zoomOf()) === 0, await zoomOf());
    await t.eventually('and that is saved too', async () => saved() === 0);
  });

  // ---- 12 the GPU switch and the safety net ------------------------------------------------------------------------------
  await scenario('12', 'Hardware acceleration: the General switch writes flags.json and asks for a restart; two GPU crashes within 60 s switch to compatibility mode', async (t) => {
    const settings = await openSettings(run, 'settings.general');
    const flagsFile = path.join(run.userData, 'flags.json');
    t.check('hardware acceleration is shown as ON', await settings.$eval('#sw-accel', (input) => input.checked));
    await settings.click('#sw-accel');
    await t.eventually('turning it off shows "Restart to apply this change"', () => isShown(settings, '#restart-notice'));
    let flags = readJson(flagsFile);
    t.check('flags.json says disableGpu with the reason "manual"', flags.disableGpu === true && flags.reason === 'manual', flags);
    t.check('the app does NOT restart by itself', (await run.state()).relaunches.length === 0);
    await settings.click('#restart-later');
    await settings.click('#sw-accel');
    await t.eventually('turning it back on needs no restart (this run still has it on): the notice stays away', async () => !(await isShown(settings, '#restart-notice')));
    flags = readJson(flagsFile);
    t.check('and flags.json is back to disableGpu false', flags.disableGpu === false, flags);

    const boxes = (await run.state()).dialogs.length;
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'clean-exit' } });
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'clean-exit' } });
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'Utility', reason: 'crashed' } });
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'Utility', reason: 'crashed' } });
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 139 } });
    await sleep(400);
    t.check('two clean exits, two crashes of another process and ONE GPU crash change nothing', (await run.state()).dialogs.length === boxes && readJson(flagsFile).disableGpu === false);
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 139 } });
    const box = await t.eventually('the second GPU crash within 60 s shows the (fake) native dialog', async () => (await run.state()).dialogs.slice(boxes).find((entry) => /compatibility mode/.test(entry.message)) || null);
    if (box) {
      t.check('"The screen had a problem. GadgetsPOS will use compatibility mode." with Restart now and Later', box.message === 'The screen had a problem. GadgetsPOS will use compatibility mode.' && JSON.stringify(box.buttons) === JSON.stringify(['Restart now', 'Later']), box);
      t.check('answered "Later": no restart', box.response === 1 && (await run.state()).relaunches.length === 0, box);
    }
    flags = readJson(flagsFile);
    t.check('flags.json now says disableGpu with the reason "gpu-crashes"', flags.disableGpu === true && flags.reason === 'gpu-crashes', flags);
    const after = (await run.state()).dialogs.length;
    await run.cmd('emitApp', { event: 'child-process-gone', details: { type: 'GPU', reason: 'crashed' } });
    await sleep(300);
    t.check('a third crash does not ask again', (await run.state()).dialogs.length === after);

    await closeWindowOf(run, settings, 'Settings');
    t.check('the Settings page closes its own window (desktop:window:close)', !(await run.findPage(isSettingsUrl)));
  });

  // ---- 6 stop the server, reload -----------------------------------------------------------------------------------------
  await scenario('6', 'Stopping the server and reloading shows the offline page; its buttons work offline; the server coming back loads the POS again', async (t) => {
    const page = await run.mainPage();
    const marker = await evalIn(page, () => window.__pos.marker);
    await pos.stop();
    await run.cmd('menuClick', { id: 'view.reload' });
    const offline = await t.eventually('View > Reload with the server down shows offline.html', async () => {
      const main = await run.mainPage();
      return main && isOfflineUrl(main.url()) ? main : null;
    }, { timeoutMs: 20_000 });
    if (offline) {
      await offline.waitForFunction(() => document.readyState === 'complete');
      const view = await evalIn(offline, () => ({ headline: document.querySelector('#headline').textContent, url: location.search, desktop: typeof window.desktop, electron: typeof window.electron }));
      t.check('with reason=refused, a headline, window.desktop and no window.electron', /reason=refused/.test(view.url) && view.headline.length > 5 && view.desktop === 'object' && view.electron === 'undefined', view);
      const painted = await run.cmd('capture');
      t.check('and the window paints it', painted.ok && painted.width > 0, painted);
      await screenshotDark(offline, 'offline-dark');
      const attemptOf = () => evalIn(offline, () => window.desktop.connection.getStatus().then((status) => status.attempt));
      await t.eventually('the app is probing again (attempt counter at 1)', async () => (await attemptOf()) >= 1, { timeoutMs: 12_000 });
      const before = await attemptOf();
      await offline.click('#retry');
      await t.eventually('"Retry now" probes at once: the counter goes up', async () => (await attemptOf()) > before, { timeoutMs: 6000 });

      // the two buttons that must work without a server (SPEC 11.4)
      await offline.click('#open-printers');
      const settings = await run.waitPage(isSettingsUrl, 'the Settings window opened from the offline page');
      await waitFor(() => settings.evaluate(() => document.body && document.body.dataset.state === 'ready').catch(() => false), 'the Settings page to be ready', { timeoutMs: 15_000 });
      t.check('"Printer settings" opens Settings on the Printers tab, with no server at all', (await settings.$eval('#tab-printers', (tab) => tab.getAttribute('aria-selected'))) === 'true');
      await t.eventually('and Settings says the connection is Offline', async () => (await textOf(settings, '#rail-online')) === 'Offline', { timeoutMs: 6000 });
      await offline.click('#open-server');
      await t.eventually('"Change server address" switches that Settings window to the Connection tab', async () => (await settings.$eval('#tab-connection', (tab) => tab.getAttribute('aria-selected'))) === 'true', { timeoutMs: 6000 });
      await closeWindowOf(run, settings, 'Settings');
    }
    await pos.start();
    const back = await t.eventually('the POS loads again by itself', () => waitForPos(run, pos, 25_000).catch(() => null), { timeoutMs: 26_000, intervalMs: 200 });
    if (back) t.check('as a NEW page (the marker changed)', (await evalIn(back, () => window.__pos.marker)) !== marker);
  });

  // ---- 6b text from the network ------------------------------------------------------------------------------------------
  await scenario('6b', 'Text that came from the network is shown as text on the offline screen, under a strict Content-Security-Policy (SPEC 6.3)', async (t) => {
    const here = (code) => run.cmd('evalIn', { code });
    await run.cmd('showOffline', {
      info: { reason: 'refused', code: '<script>window.__code=1</script>', description: '"><img src=x onerror="window.__injected=1"> <b id="evil">bold</b>', url: `${pos.origin}/<i>x</i>` },
      options: { autoRetry: false },
    });
    await waitFor(async () => /offline\.html/.test((await run.cmd('mainInfo')).url) && (await here('document.readyState')) === 'complete', 'the offline screen with the hostile values', { timeoutMs: 10_000 });
    const view = JSON.parse(await here(`JSON.stringify({
      images: document.querySelectorAll('img[src="x"]').length,
      injected: document.querySelectorAll('#evil, script:not([src])').length,
      ran: [typeof window.__injected, typeof window.__code],
      details: document.querySelector('#tech-list').textContent,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    })`));
    t.check('no element was injected from the query string and no script ran', view.images === 0 && view.injected === 0 && view.ran.every((kind) => kind === 'undefined'), view);
    t.check('the hostile text is on the page as plain text', view.details.includes('<img src=x onerror=') && view.details.includes('<script>window.__code=1</script>'), view.details);
    t.check('the page carries a strict Content-Security-Policy (default-src none, script-src self)', /default-src 'none'/.test(view.csp) && /script-src 'self'/.test(view.csp), view.csp);
    await run.cmd('menuClick', { id: 'view.reload' });
    await t.eventually('View > Reload takes the window back to the POS', () => waitForPos(run, pos, 15_000).catch(() => null), { timeoutMs: 16_000, intervalMs: 200 });
  });

  // ---- 16 a crashed page -------------------------------------------------------------------------------------------------
  await scenario('16', 'A crashed POS page shows the offline screen (never a blank window) and the POS comes back; a crash loop stops the automatic reload (SPEC 11.2)', async (t) => {
    const main = () => run.cmd('mainInfo');
    const here = (code) => run.cmd('evalIn', { code });
    const onCrashScreen = async () => /offline\.html\?reason=crashed/.test((await main()).url);
    const settled = async () => (await onCrashScreen()) && (await here('document.readyState')) === 'complete';
    const page = await waitForPos(run, pos, 20_000);
    const marker = await evalIn(page, () => window.__pos.marker);

    await run.cmd('crashMain');
    await t.eventually('the window shows the offline screen for a crashed page (reason=crashed)', settled, { timeoutMs: 10_000, intervalMs: 100 });
    const headline = await here("document.querySelector('#headline').textContent");
    t.check('it has a headline and real content', headline.length > 5 && (await here('document.body.innerText.length')) > 150, headline);
    t.note(`the headline of a crashed page: "${headline}"`);
    const painted = await run.cmd('capture');
    t.check('and the window really paints it', painted.ok && painted.width > 0, painted);
    t.check('the technical details say the page stopped responding', /stopped responding/.test(await here("document.querySelector('#tech-list').textContent")));
    await t.eventually('the app loads the POS again by itself (its first probe finds the server)', async () => (await main()).url.startsWith(pos.origin), { timeoutMs: 15_000, intervalMs: 150 });
    const back = await waitForPos(run, pos, 15_000);
    t.check('as a NEW page (the marker changed)', (await evalIn(back, () => window.__pos.marker)) !== marker);

    // three crashes within a minute: the page is crashing in a loop, so the automatic reload stops
    await run.cmd('crashMain');
    await t.eventually('a second crash shows the screen again', settled, { timeoutMs: 10_000, intervalMs: 100 });
    await run.cmd('crashMain');
    await t.eventually('after the third crash the screen says the page keeps stopping', async () => (await settled()) && /keeps stopping/.test(await here("document.querySelector('#tech-list').textContent")), { timeoutMs: 10_000, intervalMs: 100 });
    await sleep(5000);
    t.check('and it stays: nothing reloads the POS by itself while it keeps crashing', await onCrashScreen());
    await run.cmd('menuClick', { id: 'view.reload' });
    const again = await t.eventually('View > Reload brings the POS back (v1 had no Reload at all)', () => waitForPos(run, pos, 15_000).catch(() => null), { timeoutMs: 16_000, intervalMs: 200 });
    if (again) t.check('as a new page again', (await evalIn(again, () => window.__pos.marker)) !== marker);
  });

  // ---- 8b settings behind the password -----------------------------------------------------------------------------------
  await scenario('8b', 'Settings can ask for the drawer password before it opens (SPEC 10)', async (t) => {
    let settings = await openSettings(run, 'settings.drawer');
    await settings.click('#drawer-protect');
    await typeInto(settings, '#drawer-pw', DRAWER_PASSWORD);
    await settings.click('#drawer-save');
    await t.eventually('"Ask for the password before Settings opens" is saved', async () => (await run.cmd('config')).drawer.requirePasswordForSettings === true);
    await closeWindowOf(run, settings, 'Settings');
    await run.cmd('menuClick', { id: 'settings.connection' });
    const prompt = await run.waitPage(isPasswordUrl, 'the password window that guards Settings');
    await prompt.waitForFunction(() => document.querySelector('#pw-input') !== null);
    t.check('a password window opens instead of Settings, worded for Settings', /Settings are protected/.test((await textOf(prompt, '#pw-title')) || '') && !(await run.findPage(isSettingsUrl)), await textOf(prompt, '#pw-title'));
    await typeInto(prompt, '#pw-input', 'not-it');
    await prompt.keyboard.press('Enter');
    await t.eventually('a wrong password is refused in the window and Settings stays closed', async () => /not correct/.test((await textOf(prompt, '#pw-error')) || '') && !(await run.findPage(isSettingsUrl)), { timeoutMs: 8000 });
    await typeInto(prompt, '#pw-input', DRAWER_PASSWORD);
    await prompt.keyboard.press('Enter').catch(() => {});
    settings = await run.waitPage(isSettingsUrl, 'the Settings window after the right password');
    await waitFor(() => settings.evaluate(() => document.body && document.body.dataset.state === 'ready').catch(() => false), 'the Settings page to be ready', { timeoutMs: 15_000 });
    t.check('the right password opens Settings on the tab that was asked for (Connection)', (await settings.$eval('#tab-connection', (tab) => tab.getAttribute('aria-selected'))) === 'true');
    await t.eventually('and the password window closes', async () => !(await run.findPage(isPasswordUrl)), { timeoutMs: 6000 });
    await settings.click('#tab-drawer');
    await settings.click('#drawer-protect');
    await typeInto(settings, '#drawer-pw', DRAWER_PASSWORD);
    await settings.click('#drawer-save');
    await t.eventually('the protection can be switched off again (it needs the password)', async () => (await run.cmd('config')).drawer.requirePasswordForSettings === false);
    await closeWindowOf(run, settings, 'Settings');
  });

  // ---- 8c unsaved changes in Settings (UX-09) ----------------------------------------------------------------------------
  await scenario('8c', 'Settings with unsaved changes asks before it closes: Keep editing keeps it, Discard changes closes it; a clean Settings closes without a question', async (t) => {
    const questions = () => run.events().filter((event) => event.type === 'dialog' && /unsaved changes/.test(event.message));
    const settingsOpen = async () => (await run.cmd('windows')).some((win) => isSettingsUrl(win.url));
    const typed = 'https://pos.mygadgetshop.co.uk/point-of-sale';
    const settings = await openSettings(run, 'settings.connection');
    await typeInto(settings, '#conn-url', typed);
    t.check('the Connection tab shows that it has unsaved changes', await isShown(settings, '#tab-connection .nav__dot'));

    await run.cmd('answerDialogs', { responses: [0] });
    await run.cmd('closeSettings');
    await t.eventually('closing the window asks the question', () => questions().length === 1, { timeoutMs: 8000 });
    const [question] = questions();
    t.check('"Keep editing" comes first, then "Discard changes"', question && question.buttons.join('|') === 'Keep editing|Discard changes', question);
    t.check('the question is the one in the SPEC', question && question.message === 'You have unsaved changes. Discard them and close?', question);
    await sleep(600); // a window that closes in spite of the answer would show itself by now
    t.check('Keep editing: the window is still open', await settingsOpen());
    t.check('and what was typed is still in the field', (await settings.$eval('#conn-url', (input) => input.value).catch(() => null)) === typed);

    await run.cmd('answerDialogs', { responses: [1] });
    await run.cmd('closeSettings');
    await t.eventually('Discard changes: the window closes', async () => !(await settingsOpen()), { timeoutMs: 8000 });
    t.check('closing it a second time asked once more, and no more than that', questions().length === 2 && questions()[1].response === 1, questions());
    t.check('the server address was not changed by any of it', (await run.cmd('config')).serverUrl !== typed);

    await run.cmd('answerDialogs', { responses: [1] }); // would discard if it were asked: it must not be
    await openSettings(run, 'settings.connection');
    await run.cmd('closeSettings');
    await t.eventually('a Settings window with nothing unsaved closes at once', async () => !(await settingsOpen()), { timeoutMs: 8000 });
    await sleep(300);
    t.check('and asks nothing', questions().length === 2, questions());
    await run.cmd('answerDialogs', { responses: [] });
  });

  // ---- 14 quit with a slow queued print job ------------------------------------------------------------------------------
  await scenario('14', 'Quitting with a slow queued print job waits for the drain (at most 5 s) and the job completes', async (t) => {
    const page = await waitForPos(run, pos, 20_000);
    await run.cmd('delayPrinter', { ms: 2500 });
    const lastSeen = run.events().at(-1).n;
    await posCall(page, 'sendReceiptData');
    const start = await waitFor(() => run.events().find((event) => event.n > lastSeen && event.type === 'job-start' && event.label === 'receipt'), 'the slow job to start', { timeoutMs: 5000 });
    run.sampleFocus('before the quit');
    await run.cmd('menuClick', { id: 'app.quit' });
    const exit = await Promise.race([run.exited, sleep(20_000).then(() => null)]);
    t.check('the app exits by itself, with code 0', exit !== null && exit.code === 0, exit);
    const events = run.events();
    const quit = events.find((event) => event.type === 'before-quit');
    const end = events.find((event) => event.type === 'job-end' && event.id === start.id);
    t.check('the job started BEFORE the quit began', quit && start.t < quit.t, { start, quit });
    t.check('and it completed (job-end) about 2.5 s after it started, AFTER the quit began: the quit waited for it', end && quit && end.t > quit.t + 1000 && end.t - start.t >= 2400, { start, quit, end });
    t.check('the process was still running when the job completed: the exit came after it', exit && end && exit.at >= end.t, { exit, end });
    t.check('the quit took less than the 5 s drain limit plus the shutdown of the rest', exit && quit && exit.at - quit.t < 7000, exit && quit && exit.at - quit.t);
    const log = fs.readFileSync(path.join(run.userData, 'logs', 'main.log'), 'utf8');
    t.check('the log says the shutdown started and abandoned nothing', /shutdown: finishing the print queue and stopping background work/.test(log) && !/abandoned/.test(log), log.split('\n').filter((line) => /shutdown/.test(line)));
    t.check('the print helper and the power blocker were released on the way out', events.some((event) => event.type === 'raw-printer-disposed') && events.some((event) => event.type === 'power-blocker' && event.op === 'stop'), events.map((event) => event.type));
    t.note(`quit took ${exit ? exit.at - quit.t : '?'} ms from the first before-quit to the process exit`);
  });

  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run B: a seeded v1 configuration
// ---------------------------------------------------------------------------------------------------------------------------

async function runMigration(servers, runs) {
  const pos = await startFakePos();
  servers.push(pos);
  const userData = makeDir('user-data-v1');
  fs.copyFileSync(path.join(FIXTURES_DIR, 'v1-config.json'), path.join(userData, 'config.json'));
  fs.chmodSync(path.join(userData, 'config.json'), 0o600);
  // The 20 s "Does the screen look right?" question (18b R1b) comes after 200 ms: the one timer of exactly that length is warped.
  const run = new AppRun({ name: 'migration', userData, startUrl: pos.smokeUrl, warpMs: 20_000, updater: true });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);
  run.sampleFocus('after the migration run started');

  await scenario('9', 'A v1 config.json (plain-text password, printer ports) is migrated; a receipt still goes to the legacy port target', async (t) => {
    const page = await run.mainPage();
    const config = readJson(path.join(userData, 'config.json'));
    t.check('config.json is now schema 2', config.schemaVersion === 2, config.schemaVersion);
    t.check('the plain-text password is gone and a scrypt record took its place', !('password' in config) && config.drawer.passwordRecord && config.drawer.passwordRecord.algo === 'scrypt' && !JSON.stringify(config).includes('"99"'), config.drawer);
    t.check('the weak v1 password ("99") is flagged, not refused', config.drawer.passwordWeak === true, config.drawer.passwordWeak);
    t.check('the receipt printer is migrated as a port target', JSON.stringify(config.printers.receipt) === JSON.stringify({ transport: 'port', printerName: 'EPSON TM-T20II Receipt', port: '\\\\localhost\\EPSONTM' }), config.printers.receipt);
    t.check('the label printer too', JSON.stringify(config.printers.label) === JSON.stringify({ transport: 'port', printerName: 'Zebra ZD420', port: 'COM3' }), config.printers.label);
    t.check('the legacy printer keys stay in place (a downgrade to v1.6.1 still prints)', config.printerName === 'EPSON TM-T20II Receipt' && config.printerPort === '\\\\localhost\\EPSONTM' && config.labelPrinterName === 'Zebra ZD420' && config.labelPrinterPort === 'COM3', Object.keys(config));
    t.check('the obsolete A4 and brand keys are removed', !('a4PrinterName' in config) && !('a4PrinterPort' in config) && !('a4Password' in config) && !('printerBrand' in config), Object.keys(config));
    const backupFile = path.join(userData, 'config.v1-backup.json');
    const backup = fs.existsSync(backupFile) ? readJson(backupFile) : null;
    t.check('config.v1-backup.json exists, owner-only (0600), has the old settings and NO password', backup && !('password' in backup) && backup.printerName === 'EPSON TM-T20II Receipt' && (fs.statSync(backupFile).mode & 0o777) === 0o600, backup && Object.keys(backup));
    t.check('config.json itself is owner-only (0600)', (fs.statSync(path.join(userData, 'config.json')).mode & 0o777) === 0o600);

    const receipt = await posCall(page, 'printReceipt');
    const job = (await run.jobs('receipt')).at(-1);
    t.check('a receipt still goes to the legacy port target', receipt.ok === true && job && job.target.transport === 'port' && job.target.port === '\\\\localhost\\EPSONTM' && job.target.printerName === 'EPSON TM-T20II Receipt', { receipt, job: job && job.target });
    await posCall(page, 'printBarcode');
    const label = (await run.jobs('label zebra')).at(-1);
    t.check('and a Zebra label to the label port', label && label.target.transport === 'port' && label.target.port === 'COM3', label && label.target);
    const wrong = await posCall(page, 'openCashDrawer', { password: 'nope' });
    t.check('the old password still guards the drawer: a wrong one is refused', wrong.ok === false && wrong.code === 'DRAWER_WRONG_PASSWORD', wrong);
    const right = await posCall(page, 'openCashDrawer', { password: '99' });
    const pulse = (await run.jobs('cash drawer')).at(-1);
    t.check('and the old password ("99") opens the drawer: the pulse goes to the port target', right.ok === true && pulse && pulse.hex === DRAWER_PULSE_HEX && pulse.target.port === '\\\\localhost\\EPSONTM', { right, pulse });

    const settings = await openSettings(run, 'settings.drawer');
    run.sampleFocus('after Settings opened (migration run)');
    t.check('Settings > Cash drawer shows the weak-password notice', await isShown(settings, '#pw-weak') && /4 to 64 characters/.test((await textOf(settings, '#pw-weak')) || ''), await textOf(settings, '#pw-weak'));
    await settings.click('#tab-printers');
    const receiptCard = await settings.evaluate(() => ({
      port: document.querySelector('#receipt-port') ? document.querySelector('#receipt-port').value : null,
      portRadio: document.querySelector('[data-role="receipt"] input[value="port"]').checked,
    }));
    t.check('and Settings > Printers shows the migrated port setting (Advanced: port) with its address', receiptCard.portRadio === true && receiptCard.port === '\\\\localhost\\EPSONTM', receiptCard);
    await closeWindowOf(run, settings, 'Settings');
  });

  await scenario('9b', 'After a v1 migration the app asks once, natively, "Does the screen look right?" (18b R1b)', async (t) => {
    const flagsFile = path.join(userData, 'flags.json');
    const box = await t.eventually('the native question is shown (its 20 s timer was warped to 200 ms)', async () => (await run.state()).dialogs.find((entry) => entry.message === 'Does the screen look right?') || null, { timeoutMs: 10_000 });
    if (box) t.check('with the answers "Yes" and "No, use compatibility mode"', JSON.stringify(box.buttons) === JSON.stringify(['Yes', 'No, use compatibility mode']) && box.type === 'question', box);
    const flags = await waitFor(() => (fs.existsSync(flagsFile) && readJson(flagsFile).gpuChecked === true ? readJson(flagsFile) : null), 'flags.json to remember the answer', { timeoutMs: 5000 }).catch(() => null);
    t.check('the answer "Yes" is stored (gpuChecked true) and compatibility mode stays off', flags && flags.gpuChecked === true && flags.disableGpu === false, flags);
    t.check('no restart was asked for', (await run.state()).relaunches.length === 0);
  });

  await scenario('10', 'A second instance with the same userData focuses the first and quits', async (t) => {
    await run.cmd('minimizeMain');
    await t.eventually('the first window is minimized', async () => (await run.cmd('mainInfo')).minimized === true, { timeoutMs: 6000 });
    const eventsFile = path.join(RUN_DIR, 'events-second.jsonl');
    const second = spawn(ELECTRON, [LAUNCH_SCRIPT], {
      env: {
        ...cleanEnv(),
        GPOS_E2E_USER_DATA: userData,
        GPOS_E2E_EVENTS_FILE: eventsFile,
        GPOS_E2E_CONTROL_PORT: String(await freePort()),
        GADGETSPOS_START_URL: pos.smokeUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      stdio: 'ignore',
    });
    tracked.add(second.pid);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        killTree(second.pid);
        resolve({ code: 'timeout' });
      }, 20_000);
      second.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    tracked.delete(second.pid);
    t.check('the second instance quits at once with code 0', result.code === 0, result);
    const secondEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    t.check('it was refused the single-instance lock (and showed no window)', /second-instance-denied/.test(secondEvents), secondEvents);
    await t.eventually('the first instance heard about it (second-instance) and focused its window', () => run.events().some((event) => event.type === 'second-instance') && run.events().some((event) => event.type === 'main-focus'), { timeoutMs: 5000 });
    await t.eventually('the first window was restored from the minimized state', async () => (await run.cmd('mainInfo')).minimized === false, { timeoutMs: 6000 });
    t.check('the first instance is still running its POS page', (await run.mainPage()).url().startsWith(pos.origin));
    run.sampleFocus('after the second instance');
  });

  await scenario('19', 'Updates (SPEC 13): electron-updater loads at the first check, the test feed is applied, and the flow reaches Settings, a native question and quitAndInstall(true, true)', async (t) => {
    const before = await run.cmd('updater');
    t.check('electron-updater was not asked for at start (it loads lazily: at the first check, or 10 s after the POS loaded)', before.loads === 0, before);
    await run.cmd('menuClick', { id: 'help.updates' });
    const settings = await run.waitPage(isSettingsUrl, 'the Settings window opened by Help > Check for updates');
    await waitFor(() => settings.evaluate(() => document.body && document.body.dataset.state === 'ready').catch(() => false), 'the Settings page to be ready', { timeoutMs: 15_000 });
    t.check('Help > Check for updates opens Settings on the About tab', (await settings.$eval('#tab-about', (tab) => tab.getAttribute('aria-selected'))) === 'true');

    const seen = [];
    await t.eventually('the page follows the update by itself: it shows the download and then "ready" (pushed by the app, no reload)', async () => {
      const status = await settings.$eval('#update', (element) => element.dataset.status);
      if (seen.at(-1) !== status) seen.push(status);
      return status === 'ready' && seen.includes('downloading');
    }, { timeoutMs: 15_000, intervalMs: 40 });
    t.note(`the About tab showed: ${seen.join(' > ')}`);
    t.check('with the version in the headline and the Restart and install button', /2\.0\.1 is ready to install/.test((await textOf(settings, '#update-headline')) || '') && (await isShown(settings, '#update-install')), await textOf(settings, '#update-headline'));

    const after = await run.cmd('updater');
    t.check('electron-updater was loaded exactly once, by the check', after.loads === 1, after);
    t.check('the test feed (https, from GADGETSPOS_UPDATE_URL) was applied with forceDevUpdateConfig, as SPEC 13 allows for an unpackaged app only', after.feedUrl === 'https://updates.example.test/gadgetspos/' && after.forceDevUpdateConfig === true, after);
    t.check('the updater was configured as SPEC 13 says: autoDownload, autoInstallOnAppQuit and disableWebInstaller on; allowDowngrade and allowPrerelease off', after.autoDownload === true && after.autoInstallOnAppQuit === true && after.disableWebInstaller === true && after.allowDowngrade === false && after.allowPrerelease === false, after);
    const box = await t.eventually('the app asks natively "Restart now" or "Later" once the update is downloaded', async () => (await run.state()).dialogs.find((entry) => entry.title === 'Update ready') || null);
    if (box) t.check('worded for version 2.0.1; "Later" was chosen, so nothing was installed yet', /2\.0\.1 is ready to install/.test(box.message) && JSON.stringify(box.buttons) === JSON.stringify(['Restart now', 'Later']) && box.response === 1 && after.quitAndInstallCalls.length === 0, { box, calls: after.quitAndInstallCalls });

    await settings.click('#update-install');
    await t.eventually('"Restart and install" calls quitAndInstall(true, true): the silent installer, then the app starts again', async () => JSON.stringify((await run.cmd('updater')).quitAndInstallCalls) === '[[true,true]]');
    await closeWindowOf(run, settings, 'Settings');
  });

  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run C: an installed (packaged) app
// ---------------------------------------------------------------------------------------------------------------------------

async function runPackaged(servers, runs) {
  const pos = await startFakePos();
  servers.push(pos);
  const userData = makeDir('user-data-packaged');
  // An installed app takes its POS address from the settings only (the start URL variable is ignored), and trusts https only.
  fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({ schemaVersion: 2, serverUrl: pos.smokeUrl })}\n`, { mode: 0o600 });
  const run = new AppRun({ name: 'packaged', userData, startUrl: '', packaged: true });
  runs.push(run);
  await run.start();
  const page = await waitForPos(run, pos);
  run.sampleFocus('after the installed app started');

  await scenario('15b', 'In an installed app: no Developer Tools menu item, no Inspect element, and an http POS address is not trusted (SPEC 12)', async (t) => {
    const info = await evalIn(page, () => window.__pos.inspect());
    t.check('production trusts https only: the http fake POS gets no window.electron and no window.desktop', info.electron === 'undefined' && info.desktop === 'undefined', info);
    const menu = JSON.stringify(await run.cmd('menu'));
    t.check('the application menu has View > Reload but no Toggle Developer Tools', menu.includes('"label":"Reload"') && !menu.includes('Toggle Developer Tools'), menu.length);
    const labelsOf = (popup) => popup.template.map((item) => item.label || item.type);
    const editable = (await run.cmd('contextMenu', { params: { isEditable: true, editFlags: {}, x: 1, y: 1, mediaType: 'none', linkURL: '', selectionText: '' } }))[0];
    t.check('right-click on an editable field: the editing items and NO Inspect element', editable && JSON.stringify(labelsOf(editable)) === JSON.stringify(['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'separator', 'Select all']), editable && labelsOf(editable));
    const empty = await run.cmd('contextMenu', { params: { isEditable: false, selectionText: '', linkURL: '', mediaType: 'none', x: 1, y: 1 } });
    t.check('right-click on an empty area shows no menu at all', empty.length === 0, empty);
  });

  // This scenario runs in the installed (packaged) run on purpose: a development run never touches the login item (it would register
  // the bare Electron program, which then opens an empty window at every login), so the fake app.setLoginItemSettings only hears from an installed app.
  await scenario('13', 'General settings are wired: start at login, keep awake, start in full screen reach the OS fakes and the saved settings', async (t) => {
    const initial = await run.state();
    t.check('keep-awake is on by default: the (fake) power blocker started with prevent-app-suspension', initial.power.calls.length === 1 && initial.power.calls[0].op === 'start' && initial.power.calls[0].type === 'prevent-app-suspension' && initial.power.active.length === 1, initial.power);
    t.check('"start with the computer" is off by default: the login item was never touched', initial.login.calls.length === 0, initial.login);
    const settings = await openSettings(run, 'settings.general');
    run.sampleFocus('after Settings opened (installed app)');
    const onDisk = () => readJson(path.join(userData, 'config.json'));

    await settings.click('#sw-login');
    await t.eventually('switching "Start GadgetsPOS when this computer starts" on gives the fake app.setLoginItemSettings({ openAtLogin: true })', async () => (await run.state()).login.calls.at(-1) && (await run.state()).login.calls.at(-1).openAtLogin === true);
    t.check('and the setting is saved', onDisk().startup.openAtLogin === true, onDisk().startup);
    await settings.click('#sw-login');
    await t.eventually('switching it off gives { openAtLogin: false }', async () => (await run.state()).login.calls.at(-1).openAtLogin === false);
    t.check('exactly two calls were made, no more', (await run.state()).login.calls.length === 2, (await run.state()).login.calls);

    await settings.click('#sw-awake');
    await t.eventually('switching keep-awake off stops the (fake) power blocker', async () => (await run.state()).power.active.length === 0 && (await run.state()).power.calls.at(-1).op === 'stop');
    t.check('and the setting is saved', onDisk().power.keepAwake === false, onDisk().power);
    await settings.click('#sw-awake');
    await t.eventually('switching it on starts a new blocker (prevent-app-suspension again)', async () => (await run.state()).power.active.length === 1 && (await run.state()).power.calls.at(-1).op === 'start' && (await run.state()).power.calls.at(-1).type === 'prevent-app-suspension');

    await settings.click('#sw-fullscreen');
    await t.eventually('switching "Start in full screen" on is saved as window.startFullScreen', async () => onDisk().window.startFullScreen === true);
    t.check('and it does not put the running window in full screen (it applies at the next start)', (await run.cmd('mainInfo')).fullScreen === false);

    // what the window itself must remember across the restart: its place, its size and the zoom
    await run.cmd('menuClick', { id: 'view.zoom-in' });
    await run.cmd('menuClick', { id: 'view.zoom-in' });
    await run.cmd('setMainBounds', { bounds: { x: 80, y: 90, width: 1234, height: 777 } });
    await t.eventually('the window position and size are saved after a short pause (window.bounds)', async () => {
      const bounds = onDisk().window.bounds;
      return bounds && bounds.x === 80 && bounds.y === 90 && bounds.width === 1234 && bounds.height === 777;
    }, { timeoutMs: 6000 });
    await t.eventually('and so is the zoom level (window.zoomLevel 1)', async () => onDisk().window.zoomLevel === 1);

    // hardware acceleration and the restart
    await settings.click('#sw-accel');
    await t.eventually('the Hardware acceleration switch shows "Restart to apply this change"', () => isShown(settings, '#restart-notice'));
    t.check('flags.json says disableGpu (reason manual)', readJson(path.join(userData, 'flags.json')).disableGpu === true);
    await settings.evaluate(() => document.getElementById('restart-notice').scrollIntoView({ block: 'center' }));
    await sleep(250);
    await screenshot(settings, 'settings-general');
    await settings.click('#restart-now');
    const exit = await Promise.race([run.exited, sleep(20_000).then(() => null)]);
    t.check('"Restart now" quits gracefully (exit code 0)', exit !== null && exit.code === 0, exit);
    const events = run.events();
    const relaunch = events.find((event) => event.type === 'relaunch');
    const quit = events.find((event) => event.type === 'before-quit');
    t.check('and asks the (fake) app.relaunch() once, before the quit', Boolean(relaunch) && events.filter((event) => event.type === 'relaunch').length === 1 && quit && relaunch.n < quit.n, events.map((event) => event.type));
    t.check('the power blocker was released on the way out', events.filter((event) => event.type === 'power-blocker').at(-1).op === 'stop');
  });

  await run.stop();
  return { userData, pos, page };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run D: the next start of the installed app's data folder
// ---------------------------------------------------------------------------------------------------------------------------

async function runFullScreen(shared, servers, runs) {
  const pos = await startFakePos();
  servers.push(pos);
  const run = new AppRun({ name: 'fullscreen', userData: shared.userData, startUrl: pos.smokeUrl, fullScreenSpy: true });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);

  await scenario('13b', 'The next start applies what Settings saved: full screen at start, compatibility mode (hardware acceleration off)', async (t) => {
    const state = await run.state();
    t.check('start in full screen: the window asked for full screen at start (recorded instead of performed, see launch-app.js)', state.fullScreen.length >= 1 && state.fullScreen[0].flag === true, state.fullScreen);
    t.check('and its state is full screen', (await run.cmd('mainInfo')).fullScreen === true);
    const config = () => readJson(path.join(shared.userData, 'config.json'));
    await t.eventually('the full-screen state is remembered (window.fullScreen true)', async () => config().window.fullScreen === true);
    const info = await run.cmd('mainInfo');
    t.check('the window comes back where it was and as big as it was (window.bounds restored, within 2 px)', [[info.bounds.x, 80], [info.bounds.y, 90], [info.bounds.width, 1234], [info.bounds.height, 777]].every(([actual, wanted]) => Math.abs(actual - wanted) <= 2), info.bounds);
    t.check('and the zoom level of the last run (1) is applied again', info.zoomLevel === 1, info.zoomLevel);
    t.check('the flags.json of the last run is honoured: this run started in compatibility mode (GPU compositing disabled)', /^disabled/.test((await run.cmd('gpu')).gpu_compositing), await run.cmd('gpu'));
    const log = fs.readFileSync(path.join(shared.userData, 'logs', 'main.log'), 'utf8');
    t.check('the log says hardware acceleration is off', /hardware acceleration off/.test(log), log.split('\n').filter((line) => /is starting/.test(line)).at(-1));
    const help = JSON.stringify(await run.cmd('menu'));
    t.check('Help > Compatibility mode is a checked checkbox', /"id":"help.compatibility"[^}]*"checked":true/.test(help));

    await run.cmd('menuClick', { id: 'view.full-screen' });
    await t.eventually('View > Toggle full screen leaves full screen and remembers it', async () => (await run.state()).fullScreen.at(-1).flag === false && config().window.fullScreen === false);
    await run.cmd('menuClick', { id: 'view.full-screen' });
    await t.eventually('and toggles back in', async () => (await run.state()).fullScreen.at(-1).flag === true && config().window.fullScreen === true);

    const settings = await openSettings(run, 'settings.general');
    t.check('Settings > General shows hardware acceleration OFF with the compatibility notice and its reason', !(await settings.$eval('#sw-accel', (input) => input.checked)) && (await isShown(settings, '#compat-notice')) && /Help menu/.test((await textOf(settings, '#compat-text')) || ''), await textOf(settings, '#compat-text'));
    await closeWindowOf(run, settings, 'Settings');

    const boxes = (await run.state()).dialogs.length;
    await run.cmd('menuClick', { id: 'help.compatibility', checked: false });
    const box = await t.eventually('un-checking Help > Compatibility mode shows the native restart question', async () => (await run.state()).dialogs.slice(boxes).find((entry) => /Compatibility mode/.test(entry.message)) || null);
    if (box) t.check('"Compatibility mode will be switched off the next time GadgetsPOS starts." with Restart now and Later; Later was chosen', /switched off/.test(box.message) && JSON.stringify(box.buttons) === JSON.stringify(['Restart now', 'Later']) && box.response === 1, box);
    const flags = readJson(path.join(shared.userData, 'flags.json'));
    t.check('flags.json is back to disableGpu false', flags.disableGpu === false, flags);
    await t.eventually('the menu was rebuilt with the checkbox unchecked', async () => /"id":"help.compatibility"[^}]*"checked":false/.test(JSON.stringify(await run.cmd('menu'))));
    t.check('no restart happened', (await run.state()).relaunches.length === 0);
  });

  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Run E: quitting with unsaved changes in Settings
// ---------------------------------------------------------------------------------------------------------------------------

async function runUnsavedQuit(servers, runs) {
  const pos = await startFakePos();
  servers.push(pos);
  const run = new AppRun({ name: 'unsaved', userData: makeDir('user-data-unsaved'), startUrl: pos.smokeUrl });
  runs.push(run);
  await run.start();
  await waitForPos(run, pos);
  run.sampleFocus('after the unsaved-changes run started');

  await scenario('20', 'Quitting with unsaved changes in Settings asks the same single question: Keep editing keeps the app and Settings, Discard changes quits it', async (t) => {
    const quitId = process.platform === 'darwin' ? 'app.quit' : 'quit';
    const questions = () => run.events().filter((event) => event.type === 'dialog' && /unsaved changes/.test(event.message));
    const settings = await openSettings(run, 'settings.connection');
    await typeInto(settings, '#conn-url', 'https://pos.mygadgetshop.co.uk/point-of-sale');
    t.check('the Connection tab has unsaved changes', await isShown(settings, '#tab-connection .nav__dot'));

    await run.cmd('answerDialogs', { responses: [0] });
    await run.cmd('menuClick', { id: quitId });
    await t.eventually('Quit asks the question', () => questions().length === 1, { timeoutMs: 8000 });
    await sleep(1500); // a quit that carried on in spite of the answer would have started its shutdown by now
    t.check('Keep editing: the app is still running and answers', (await run.state()).ready === true && run.exit === null);
    t.check('no shutdown began (there was no before-quit)', !run.events().some((event) => event.type === 'before-quit'));
    t.check('Settings and the POS window are both still open', (await run.cmd('windows')).filter((win) => isSettingsUrl(win.url) || win.url.startsWith(pos.origin)).length === 2);

    await run.cmd('answerDialogs', { responses: [1] });
    await run.cmd('menuClick', { id: quitId });
    const exit = await Promise.race([run.exited, sleep(20_000).then(() => null)]);
    t.check('Discard changes: the app quits by itself, with code 0', exit !== null && exit.code === 0, exit);
    t.check('and the question was asked once more, no more than that', questions().length === 2 && questions()[1].response === 1, questions());
    t.check('the quit ran its shutdown', run.events().some((event) => event.type === 'before-quit'));
  });

  await run.stop();
}

// ---------------------------------------------------------------------------------------------------------------------------
// The rest: quiet checks
// ---------------------------------------------------------------------------------------------------------------------------

async function quietScenario() {
  await scenario('F', 'Nothing took focus, no app page logged an error, no main process threw, nothing is left running', async (t) => {
    if (quiet.focus.length === 0) t.note('no focus samples were taken (lsappinfo is macOS only)');
    else {
      const stolen = quiet.focus.filter((sample) => sample.ours);
      t.check(`the app was never the frontmost application (${quiet.focus.length} samples over all runs)`, stolen.length === 0, stolen);
      const apps = [...new Set(quiet.focus.map((sample) => sample.front.name))];
      t.note(`the application in front during the run: ${apps.join(', ')}`);
    }
    t.check('no console error or page error on the app\'s own pages (loading, offline, Settings, password)', quiet.consoleErrors.length === 0, quiet.consoleErrors);
    t.check('no uncaught exception or unhandled rejection in any main process', quiet.uncaught.length === 0, quiet.uncaught);
    const alive = [...everSpawned].filter((pid) => isAlive(pid));
    t.check('every Electron process the run started has ended', alive.length === 0, alive);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------------------------------

function printTable() {
  const sorted = [...scenarios].sort((a, b) => idOrder(a.id) - idOrder(b.id));
  const idWidth = Math.max(2, ...sorted.map((entry) => entry.id.length));
  const titleWidth = Math.min(100, Math.max(20, ...sorted.map((entry) => entry.title.length)));
  const line = '-'.repeat(idWidth + titleWidth + 34);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`${'#'.padEnd(idWidth)}  ${'Scenario'.padEnd(titleWidth)}  Result  Checks  Time\n${line}\n`);
  for (const entry of sorted) {
    const passed = entry.checks.filter((check) => check.ok).length;
    const title = entry.title.length > titleWidth ? `${entry.title.slice(0, titleWidth - 3)}...` : entry.title;
    process.stdout.write(`${entry.id.padEnd(idWidth)}  ${title.padEnd(titleWidth)}  ${entry.passed ? 'PASS  ' : 'FAIL  '}  ${`${passed}/${entry.checks.length}`.padEnd(6)}  ${seconds(entry.ms)}\n`);
  }
  process.stdout.write(`${line}\n`);
  const failed = sorted.filter((entry) => !entry.passed);
  for (const entry of failed) {
    process.stdout.write(`\nFAILED [${entry.id}] ${entry.title}\n`);
    if (entry.error) process.stdout.write(`  error: ${entry.error.message}\n`);
    for (const check of entry.checks.filter((item) => !item.ok)) process.stdout.write(`  - ${check.name}\n      ${shorten(JSON.stringify(check.detail), 500)}\n`);
  }
  const checks = sorted.reduce((sum, entry) => sum + entry.checks.length, 0);
  process.stdout.write(`\n${sorted.length - failed.length} of ${sorted.length} scenarios passed (${checks} checks)\n`);
  return failed.length === 0;
}

function writeReport() {
  const report = {
    when: new Date().toISOString(),
    electron: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    scenarios: [...scenarios]
      .sort((a, b) => idOrder(a.id) - idOrder(b.id))
      .map((entry) => ({ id: entry.id, title: entry.title, passed: entry.passed, ms: entry.ms, error: entry.error ? entry.error.message : null, notes: entry.notes, checks: entry.checks })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const watchdog = setTimeout(() => {
    process.stderr.write('WATCHDOG: the smoke run took too long, ending everything it started\n');
    for (const pid of tracked) killTree(pid);
    process.exit(2);
  }, WATCHDOG_MS);
  const servers = [];
  const runs = [];
  let ok = false;
  // SMOKE_RUNS=B,C runs only those app runs (default: all). D needs the data folder of C, so asking for D runs C first.
  const wanted = new Set((process.env.SMOKE_RUNS || 'A,B,C,D,E').split(',').map((name) => name.trim().toUpperCase()));
  try {
    if (wanted.has('A')) await guardRun('A', 'the development run', () => runDevelopment(servers, runs));
    if (wanted.has('B')) await guardRun('B', 'the migration run', () => runMigration(servers, runs));
    let shared = null;
    if (wanted.has('C') || wanted.has('D')) {
      await guardRun('C', 'the installed-app run', async () => {
        shared = await runPackaged(servers, runs);
      });
    }
    if (shared && wanted.has('D')) await guardRun('D', 'the second start of the installed app', () => runFullScreen(shared, servers, runs));
    if (wanted.has('E')) await guardRun('E', 'the unsaved-changes quit run', () => runUnsavedQuit(servers, runs));
  } finally {
    clearTimeout(watchdog);
    for (const run of runs) await run.stop({ timeoutMs: 8000 }).catch(() => {});
    for (const server of servers) await server.stop().catch(() => {});
    await quietScenario();
    ok = printTable();
    writeReport();
    for (const pid of tracked) killTree(pid);
    if (ok) fs.rmSync(RUN_DIR, { recursive: true, force: true });
    else process.stdout.write(`\nThe data folders of the run were kept in ${RUN_DIR}\n`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`the smoke run broke: ${error && error.stack ? error.stack : error}\n`);
  for (const pid of tracked) killTree(pid);
  process.exit(2);
});
