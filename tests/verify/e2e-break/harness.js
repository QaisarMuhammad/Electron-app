'use strict';

/**
 * Shared pieces of the runtime-e2e lens (tests/verify/e2e-break): process helpers, the scenario report, `AppRun` (one run of the REAL app
 * under the REAL Electron through tests/verify/e2e-break/launch-break.js) and small page helpers. Style and mechanics follow
 * tests/e2e/run-smoke.js (which stays untouched): the app never takes focus (accessory activation policy, showInactive()), nothing is left
 * running (every process this lens starts is ended by pid), and a full-screen request is recorded instead of performed.
 *
 * Not named *.test.js: node --test must not run it.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const LAUNCH_SCRIPT = path.join(__dirname, 'launch-break.js');
const EGL_NOISE = /EGL Driver message|gl_display\.cc/;

/** puppeteer-core is the library of choice (it only attaches to the app; a browser is never launched and `browser.close()` is never called). */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Polls `fn` until it answers something truthy and returns that; throws, naming `label`, after `timeoutMs`. */
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

/** All descendants of a process, from the process table. */
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

/** Ends a process and everything below it. Only ever called with pids this lens started. */
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

/** The application that is in front right now (macOS `lsappinfo`; null elsewhere). */
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

/** A harness started from an Electron-based terminal inherits ELECTRON_RUN_AS_NODE, which would make a child plain Node. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-break-'));
function makeDir(name) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------------

function shorten(text, max = 400) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

class Scenario {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.notes = [];
    this.data = {};
    this.error = null;
    this.ms = 0;
  }

  /** One check. `detail` is kept (and printed) only when it fails. */
  check(name, ok, detail) {
    const passed = Boolean(ok);
    this.checks.push(passed ? { name, ok: true } : { name, ok: false, detail });
    process.stdout.write(`  ${passed ? 'ok   ' : 'FAIL '} ${name}${passed ? '' : `   -> ${shorten(JSON.stringify(detail))}`}\n`);
    return passed;
  }

  /** A check that waits. */
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

  /** Something worth reading that is not pass or fail. */
  note(text) {
    this.notes.push(text);
    process.stdout.write(`  note  ${text}\n`);
  }

  /** Raw measurements, kept in the JSON report. */
  record(key, value) {
    this.data[key] = value;
  }

  get passed() {
    return this.error === null && this.checks.length > 0 && this.checks.every((entry) => entry.ok);
  }
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

/** What every run collects and the final scenario judges. */
const quiet = { consoleErrors: [], uncaught: [], focus: [], logProblems: [], logErrors: [] };
const tracked = new Set();
const everSpawned = new Set();

/** Lines of an app's stdout/stderr that point at a crash, an unhandled rejection or an error nobody handled. */
const PROBLEM_LINE = /Error occurred in handler|UnhandledPromiseRejection|Unhandled promise|Uncaught|TypeError|ReferenceError|RangeError|FATAL|Check failed|crashed|GadgetsPOS failed to start|could not start/i;

// ---------------------------------------------------------------------------------------------------------------------------
// One run of the app
// ---------------------------------------------------------------------------------------------------------------------------

class AppRun {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {string} [options.userData]  a fresh folder by default
   * @param {string} [options.startUrl]
   * @param {boolean} [options.packaged]
   * @param {boolean} [options.realRaw]  the app's real raw printer with a fake execFile (see launch-break.js)
   * @param {string} [options.execMode]  notfound | ok | hang
   * @param {Record<string, string>} [options.env]
   */
  constructor({ name, userData, startUrl = '', packaged = false, realRaw = false, realDymo = false, realPrinters = false, execMode = 'notfound', env = {} }) {
    this.name = name;
    this.userData = userData || makeDir(`user-data-${name}`);
    this.startUrl = startUrl;
    this.packaged = packaged;
    this.realRaw = realRaw;
    this.realDymo = realDymo;
    this.realPrinters = realPrinters;
    this.execMode = execMode;
    this.extraEnv = env;
    this.eventsFile = path.join(RUN_DIR, `events-${name}.jsonl`);
    this.logFile = path.join(OUT_DIR, `break-run-${name}.log`);
    this.child = null;
    this.exit = null;
    this.exitedAt = null;
    this.browser = null;
    this.controlPort = 0;
    this.debugPort = 0;
    this.startedAt = 0;
  }

  /** Starts the app and waits for its control server. The POS may still be loading, or down: that is for the scenario to judge. */
  async start({ attach = false, timeoutMs = 40_000 } = {}) {
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
      GPOS_E2E_FULLSCREEN_SPY: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ...(this.packaged ? { GPOS_E2E_PACKAGED: '1' } : {}),
      ...(this.realRaw ? { GPOS_E2E_REAL_RAW: '1', GPOS_E2E_EXEC_MODE: this.execMode } : {}),
      ...(this.realDymo ? { GPOS_E2E_REAL_DYMO: '1' } : {}),
      ...(this.realPrinters ? { GPOS_E2E_REAL_PRINTERS: '1' } : {}),
      ...this.extraEnv,
    };
    this.startedAt = Date.now();
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
        this.exitedAt = Date.now();
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
    }, 'the app to start', { timeoutMs, intervalMs: 120 });
    if (attach) await this.attach();
  }

  /** Attaches the debugger (again). */
  async attach() {
    if (this.browser) await this.browser.disconnect().catch(() => {});
    this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${this.debugPort}`, defaultViewport: null, protocolTimeout: 30_000 });
    this.browser.on('targetcreated', (target) => void this.watchConsole(target));
    for (const page of await this.browser.pages()) this.watchPage(page);
  }

  /** Console errors of the app's OWN pages (file:) are collected: they must stay empty. */
  watchPage(page) {
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

  /** The events of the launcher so far (read from its file, which also survives the quit). */
  events() {
    try {
      return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async jobs(label) {
    const { rawJobs } = await this.state();
    return label ? rawJobs.filter((job) => job.label === label) : rawJobs;
  }

  /**
   * Runs a function BODY in the POS page (from the main process, so it does not depend on the debugger) and answers
   * `{ ok, value }` or `{ ok: false, error }`. The body may use `await` and must `return` something JSON-friendly.
   */
  async page(body, timeoutMs = 20_000) {
    const code = `(async () => { try { return { ok: true, value: await (async () => { ${body} })() }; } catch (error) { return { ok: false, error: String(error && error.message || error) }; } })()`;
    return this.cmd('evalIn', { code }, timeoutMs);
  }

  /** One call of the fake POS page (window.__pos.call), answering the entry it recorded. */
  async pos(name, args = {}, timeoutMs = 20_000) {
    const answer = await this.page(`return await window.__pos.call(${JSON.stringify(name)}, ${JSON.stringify(args)});`, timeoutMs);
    return answer.ok ? answer.value : { ok: false, error: answer.error };
  }

  /** The whole page of a screenshot: what the window shows now, as a file. */
  async shot(name) {
    const file = path.join(OUT_DIR, `break-${name}.png`);
    const result = await this.cmd('capturePng', { file });
    return { file, ...result };
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

  /** Sum of the resident memory (KB) of the app and its helpers. */
  rssKb() {
    const pids = this.pids();
    if (pids.length === 0) return 0;
    try {
      const table = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
      return table.split('\n').map((line) => Number(line.trim())).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    } catch {
      return 0;
    }
  }

  /** Quits the app through the same action as the menu item and waits for the process to end; ends it by force when it does not. */
  async stop({ graceful = true, timeoutMs = 20_000 } = {}) {
    if (!this.child) return { forced: false, ms: 0 };
    const began = Date.now();
    if (this.browser) {
      await this.browser.disconnect().catch(() => {});
      this.browser = null;
    }
    if (graceful && !this.exit) await this.cmd('quit', {}, 5000).catch(() => {});
    const result = await Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
    let forced = false;
    if (result === null) {
      forced = true;
      killTree(this.child.pid);
      await this.exited;
    }
    for (const event of this.events().filter((entry) => ['uncaught', 'unhandled-rejection', 'launch-failed'].includes(entry.type))) {
      quiet.uncaught.push(`${this.name}: ${event.type}: ${event.message}`);
    }
    try {
      for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n')) {
        if (PROBLEM_LINE.test(line) && !/E2E \{/.test(line)) quiet.logProblems.push(`${this.name}: ${shorten(line, 300)}`);
      }
    } catch {
      // no log
    }
    // The app's own log (<userData>/logs/main.log): every line it wrote at level error, for the report (many are expected: a crash scenario logs one).
    try {
      for (const line of fs.readFileSync(path.join(this.userData, 'logs', 'main.log'), 'utf8').split('\n')) {
        if (/\] \[error\]/.test(line)) quiet.logErrors.push(`${this.name}: ${shorten(line.replace(/^\[[^\]]*\] /, ''), 260)}`);
      }
    } catch {
      // no log file
    }
    killTree(this.child.pid);
    tracked.delete(this.child.pid);
    return { forced, ms: Date.now() - began, exit: this.exit };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------------------------------------

/** Waits until the POS window shows a page of `origin` that has the fake POS (window.__pos) loaded. */
async function waitForPos(run, origin, timeoutMs = 30_000) {
  return waitFor(async () => {
    const info = await run.cmd('mainInfo').catch(() => null);
    if (!info || !info.url || !info.url.startsWith(origin)) return null;
    const probe = await run.page('return Boolean(window.__pos);').catch(() => null);
    return probe && probe.ok && probe.value === true ? info : null;
  }, `the POS page of ${origin}`, { timeoutMs, intervalMs: 120 });
}

/** The URL the POS window shows now (null when there is no window). */
async function mainUrl(run) {
  const info = await run.cmd('mainInfo').catch(() => null);
  return info ? info.url : null;
}

const isOfflineUrl = (url) => /\/src\/renderer\/offline\.html/.test(url || '');
const isLoadingUrl = (url) => /\/src\/renderer\/loading\.html/.test(url || '');

/** The text of the offline screen: headline, status line, details. Read from inside the page (the preload of the main window is not needed). */
async function readOffline(run) {
  const answer = await run.page(`
    const text = (selector) => { const element = document.querySelector(selector); return element ? element.textContent.trim() : null; };
    return {
      url: location.href,
      headline: text('#headline'),
      sub: text('#connect-sub'),
      body: document.body ? document.body.innerText.slice(0, 600) : '',
      buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()),
    };`);
  return answer.ok ? answer.value : null;
}

// puppeteer-side helpers (offline emulation, closed shadow root of the banner) ---------------------------------------------------

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
 * Reads the offline banner of the app preload (a CLOSED shadow root: only the DevTools protocol can see it).
 * @returns {Promise<null|{ state: string, text: string, hosts: number }>} null when no banner exists
 */
async function readBanner(client) {
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  let hosts = 0;
  let pill = null;
  let text = null;
  walk(root, (node) => {
    if (node.nodeType !== 1) return;
    if (node.nodeName.toLowerCase() === 'gadgetspos-banner') hosts += 1;
    if (hosts && attributeOf(node, 'class') === 'pill') pill = node;
    if (hosts && attributeOf(node, 'class') === 'text') text = node;
  });
  if (!hosts || !pill) return null;
  return { state: attributeOf(pill, 'data-state'), text: text ? textOfNode(text) : '', hosts };
}

/** The page of the POS window (not Settings, the password window or a popup), by the debugger. */
async function posPage(run, origin) {
  return waitFor(async () => {
    const pages = await run.browser.pages();
    return pages.find((page) => page.target().url().startsWith(origin)) || null;
  }, 'the POS page in the debugger', { timeoutMs: 15_000 });
}

module.exports = {
  ROOT, OUT_DIR, RUN_DIR, puppeteer, sleep, seconds, waitFor, freePort, killTree, isAlive, frontApp, makeDir, shorten,
  Scenario, scenarios, scenario, quiet, tracked, everSpawned, AppRun, waitForPos, mainUrl, isOfflineUrl, isLoadingUrl, readOffline,
  readBanner, posPage, walk, attributeOf,
};
