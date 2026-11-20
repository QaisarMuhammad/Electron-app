'use strict';
/*
 * UI screenshot + behaviour harness for the local pages (SPEC 16, 17, 19.4, 18b).
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/e2e/ui-shots.js [options]
 *
 * It runs as an Electron MAIN script and has four parts:
 *   1. logic    fixtures/logic.js checks the pure helpers of src/renderer/shared/format.mjs.
 *   2. shots    every entry of the plan in fixtures/index.js (and fixtures/settings.js) opens a page from src/renderer in a
 *               frameless BrowserWindow with the production security flags (sandbox, contextIsolation, webSecurity) and
 *               tests/e2e/stub-desktop-preload.js, which exposes a MOCK window.desktop driven by `?fixture=<name>`. The page is
 *               driven (clicks, keys, pushes), audited (fixtures/audit.js) and written to
 *               tests/e2e/out/<page>-<fixture>-<theme>[-<WxH>][-z<zoom>][-rm][-fc].png through webContents.capturePage()
 *               (-rm = reduced motion, -fc = forced colours / Windows High Contrast).
 *   3. scenarios  fixtures/scenarios.js drives the pages with real mouse and keyboard events and asserts on the DOM and on the
 *               calls the page made to the mock (tabs, printers, drawer, lockout, connection, general, about, offline, password,
 *               keyboard focus rings, idle cost).
 *   4. paint    first-paint measurement (performance.now): a brand-new window (includes the renderer starting up) and a warm
 *               renderer (what the page itself costs), against a blank-page baseline.
 *
 * Input goes through the DevTools protocol (Input.dispatchMouseEvent / dispatchKeyEvent / insertText), which is acknowledged;
 * webContents.sendInputEvent is fire-and-forget and was dropped when the machine was busy. Page focus and the colour scheme
 * are emulated (Emulation.setFocusEmulationEnabled, nativeTheme), so nothing needs the OS to give the window focus.
 *
 * What fails the run (exit code 1): did-fail-load, console errors, uncaught exceptions, a crashed renderer, any audit issue
 * (CSP lock-down, 44 px targets, accessible names, contrast, overlap, clipping, motion, reduced motion), a failed scenario
 * assertion or logic check, an image over 60 KB shipped in a page, a warm first paint far above the 100 ms target (250 ms).
 *
 * It never steals focus: macOS activation policy "accessory", windows are focusable:false and shown with showInactive(),
 * and the pointer is parked outside the page before every capture so no element shows a stray hover state.
 *
 * Options
 *   --only=<text>     run only shots / scenarios whose id contains <text> (comma separated alternatives); skips the paint part
 *   --theme=<t>       light | dark | both (default: what each shot declares)
 *   --zoom=<n>        page zoom factor for every shot that does not set its own (1.5 = 150 percent text)
 *   --hidpi           keep device pixels (2x on Retina) instead of writing 1x PNGs
 *   --no-audit        skip the DOM audit
 *   --no-timing       skip the first-paint measurement
 *   --timing-only     run only the first-paint measurement
 *   --runs=<n>        loads per page in the first-paint measurement (default 7)
 *   --verbose         log every step, the mock calls and the page text of each shot
 *   --fail-test       record one deliberate failure (proves that the exit code turns non-zero)
 *   --list            print the shot ids and exit
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

if (process.platform === 'darwin') app.setActivationPolicy('accessory');
app.commandLine.appendSwitch('log-level', '3');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-ui-shots-'));
app.setPath('userData', SCRATCH);

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(__dirname, 'out');
const PRELOAD = path.join(__dirname, 'stub-desktop-preload.js');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:";
const MAX_IMAGE_BYTES = 60 * 1024;

const { FIXTURES, SHOTS, SCENARIOS } = require('./fixtures');
const { pageAudit } = require('./fixtures/audit');
const { runLogicChecks } = require('./fixtures/logic');

/* ------------------------------------------------------------------------------------------------------------------ */
/* Options and results                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};
const ONLY = opt('only').split(',').map((s) => s.trim()).filter(Boolean);
const THEME = opt('theme');
const ZOOM = Number(opt('zoom', '1')) || 1;
const HIDPI = opt('hidpi') === 'true';
const NO_AUDIT = opt('no-audit') === 'true';
const TIMING_ONLY = opt('timing-only') === 'true';
const NO_TIMING = opt('no-timing') === 'true' || (ONLY.length > 0 && !TIMING_ONLY);
const RUNS = Number(opt('runs', '7')) || 7;

const results = { shots: [], failures: [], warnings: [], timings: [], checks: 0, written: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const VERBOSE = process.argv.includes('--verbose');
const log = (...parts) => VERBOSE && console.log('[ui-shots]', ...parts);

/** Rejects when `promise` takes longer than `ms`, so a stuck window becomes a reported failure instead of a hang. */
function within(ms, label, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const fail = (where, message) => results.failures.push({ where, message });
const wanted = (id) => !ONLY.length || ONLY.some((o) => id.includes(o));

process.on('uncaughtException', (error) => fail('main', `uncaught exception: ${error && error.stack ? error.stack : error}`));
process.on('unhandledRejection', (error) => fail('main', `unhandled rejection: ${error && error.stack ? error.stack : error}`));

ipcMain.on('e2e:fixture', (event, request) => {
  const set = FIXTURES[request.page] || {};
  event.returnValue = set[request.name] || set.default || null;
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Page driver                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Keys the harness presses (CDP Input.dispatchKeyEvent: key, code, Windows virtual key code, optional text). */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

class Page {
  /**
   * @param {{id:string, page:string, fixture?:string, size?:[number,number], theme?:string, zoom?:number, reducedMotion?:boolean, hash?:string, query?:object}} spec
   */
  constructor(spec) {
    this.spec = spec;
    this.id = spec.id;
    this.size = spec.size || [1280, 800];
    this.theme = spec.theme || 'light';
    this.zoom = spec.zoom || 1;
    this.consoleErrors = [];
  }

  get wc() {
    return this.win.webContents;
  }

  async open() {
    const [width, height] = this.size;
    // The colour scheme comes from the OS-level theme, exactly as in the app, so the very first frame is already themed.
    nativeTheme.themeSource = this.theme;
    this.win = new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      x: 60,
      y: 40,
      backgroundColor: this.theme === 'dark' ? '#0D1720' : '#F6F7FB',
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const wc = this.wc;
    // Electron 32 passes (event, level, message, line, sourceId); level 3 is an error.
    wc.on('console-message', (_event, level, message, line, source) => {
      if (level >= 3) this.consoleErrors.push(`${message} (${path.basename(String(source))}:${line})`);
      else if (level === 2) results.warnings.push({ where: this.id, message: `console warning: ${message}` });
    });
    wc.on('did-fail-load', (_e, code, desc, url) => fail(this.id, `did-fail-load ${code} ${desc} ${url}`));
    wc.on('render-process-gone', (_e, details) => fail(this.id, `renderer gone: ${details.reason}`));
    log(this.id, 'window created');
    wc.debugger.attach('1.3');
    this.win.showInactive();
    const file = path.join(RENDERER, `${this.spec.page}.html`);
    await within(15000, `load ${this.id}`, this.win.loadFile(file, { query: { fixture: this.spec.fixture || 'default', ...(this.spec.query || {}) }, hash: this.spec.hash || '' }));
    log(this.id, 'loaded');
    await within(5000, 'focus emulation', wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }));
    const features = [];
    if (this.spec.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    if (this.spec.forcedColors) features.push({ name: 'forced-colors', value: 'active' });
    if (features.length) await within(5000, 'media emulation', wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features }));
    await this.parkMouse();
    log(this.id, 'emulation set');
    // Chromium remembers a page zoom per page address (file: pages use the whole URL), so a later window for the same address
    // would open zoomed. Always set it, also to 1.
    wc.setZoomFactor(this.zoom);
    await this.settle();
  }

  async close() {
    try {
      this.wc.debugger.detach();
    } catch {
      // already detached
    }
    this.win.destroy();
    for (const message of this.consoleErrors) fail(this.id, `console error: ${message}`);
  }

  eval(code) {
    return this.wc.executeJavaScript(code, true);
  }

  /** Two frames, (optionally) no pending mock calls, then `extra` ms. */
  async settle(extra = 0, { pending = true } = {}) {
    const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
    await this.eval(frames);
    for (let i = 0; pending && i < 80; i += 1) {
      if (!(await this.eval('window.__e2e ? window.__e2e.pending() : 0'))) break;
      await sleep(25);
    }
    await this.eval(frames);
    if (extra) await sleep(extra);
  }

  async wait(ms) {
    await sleep(ms);
  }

  async waitFor(selector, timeout = 4000) {
    const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(code)) return true;
      await sleep(30);
    }
    throw new Error(`waitFor timed out: ${selector}`);
  }

  async has(selector) {
    return this.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
  }

  async count(selector) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async text(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  }

  async attr(selector, name) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`);
  }

  async calls(prefix = '') {
    const all = await this.eval('window.__e2e.calls()');
    return prefix ? all.filter((c) => c.name.startsWith(prefix)) : all;
  }

  /** Sends a DevTools protocol command to this page (these are acknowledged, unlike webContents.sendInputEvent). */
  cdp(method, params) {
    return this.wc.debugger.sendCommand(method, params);
  }

  /** A real mouse click at the centre of the element (hover, focus and click all happen as for a user). */
  async click(selector, { wait = true } = {}) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`click: no element ${selector}`);
    await this.mouseClick(box, { wait });
  }

  /** Clicks the first element matching `scope` whose text contains `text` (printers are found by name). */
  async clickText(scope, text) {
    const box = await this.eval(`(() => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find((e) => e.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`clickText: no "${text}" in ${scope}`);
    await this.mouseClick(box);
  }

  /** Coordinates are CSS pixels of the page (what getBoundingClientRect returns); the protocol applies the page zoom. */
  async mouseClick(box, { wait = true } = {}) {
    const point = { x: Math.round(box.x * 100) / 100, y: Math.round(box.y * 100) / 100 };
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    if (wait) await this.settle();
  }

  /** Moves the pointer out of the page so no element shows a hover state in the next capture. */
  async parkMouse() {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -20, y: -20 });
  }

  async hover(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`hover: no element ${selector}`);
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.settle();
  }

  /** Sets the value of an input the way typing does (input + change events). */
  async fill(selector, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`fill: no element ${selector}`);
    await this.settle();
  }

  async focus(selector) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`);
    if (!ok) throw new Error(`focus: no element ${selector}`);
  }

  /** A real key press: "Tab", "Shift+Tab", "Enter", "Escape", "ArrowDown", ... */
  async press(combo, times = 1) {
    const parts = combo.split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((bits, m) => bits | (MODIFIER_BITS[m.toLowerCase()] || 0), 0);
    const spec = KEYS[name] || { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, vk: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0, text: name.length === 1 ? name : undefined };
    for (let i = 0; i < times; i += 1) {
      const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
      await this.cdp('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text, unmodifiedText: spec.text });
      await this.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
    await this.settle();
  }

  /** Types text into the focused element (insertText fires the same input events typing does). */
  async type(text) {
    await this.cdp('Input.insertText', { text });
    await this.settle();
  }

  async emit(kind, payload) {
    await this.eval(`window.__e2e.emit(${JSON.stringify(kind)}, ${JSON.stringify(payload)})`);
    await this.settle();
  }

  async activeElement() {
    return this.eval(`(() => { const a = document.activeElement; if (!a || a === document.body) return null; return a.id || a.getAttribute('data-act') || a.getAttribute('aria-label') || a.tagName.toLowerCase(); })()`);
  }

  async audit() {
    const code = `(${pageAudit.toString()})(${JSON.stringify({ reducedMotion: !!this.spec.reducedMotion, csp: CSP })})`;
    const out = await this.eval(code);
    for (const issue of out.issues) fail(this.id, `audit ${issue.kind}: ${issue.message} [${issue.where}]`);
    for (const img of out.metrics.images) {
      const file = decodeURIComponent(new URL(img.src).pathname);
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
      if (bytes > MAX_IMAGE_BYTES) fail(this.id, `image ${path.basename(file)} is ${bytes} bytes (limit ${MAX_IMAGE_BYTES})`);
    }
    return out.metrics;
  }

  async timing() {
    return this.eval(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { fcp: fcp ? Math.round(fcp.startTime) : null, responseStart: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) };
    })()`);
  }

  /** Captures the page. `full` grows the window to the tallest scrollable content first. */
  async shot(file, { full = false } = {}) {
    if (full) {
      const extra = await this.eval(`(() => {
        let extra = 0;
        for (const el of document.querySelectorAll('*')) {
          const o = getComputedStyle(el).overflowY;
          if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
        }
        return Math.max(extra, document.documentElement.scrollHeight - document.documentElement.clientHeight);
      })()`);
      if (extra > 0) {
        this.win.setContentSize(this.size[0], Math.min(4200, Math.ceil((this.size[1] + extra) * this.zoom)));
        await this.settle(120);
      }
    }
    const image = await this.wc.capturePage();
    const size = image.getSize();
    const scale = size.width / Math.round(this.size[0] * 1);
    const out = HIDPI || scale <= 1.01 ? image : image.resize({ width: Math.round(size.width / scale), quality: 'best' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.toPNG());
    results.written.push(path.basename(file));
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Step runner for declarative shots                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

async function runStep(page, step) {
  const [name, value] = Object.entries(step)[0];
  switch (name) {
    case 'click':
      return page.click(value);
    case 'clickNow':
      return page.click(value, { wait: false });
    case 'clickText':
      return page.clickText(value[0], value[1]);
    case 'hover':
      return page.hover(value);
    case 'fill':
      return page.fill(value[0], value[1]);
    case 'press':
      return page.press(value);
    case 'tab':
      return page.press('Tab', value);
    case 'type':
      return page.type(value);
    case 'focus':
      return page.focus(value);
    case 'scrollTo':
      return page.eval(`(() => { const el = document.querySelector(${JSON.stringify(value)}); if (el) el.scrollIntoView({ block: 'start' }); })()`);
    case 'wait':
      return page.wait(value);
    case 'waitFor':
      return page.waitFor(value);
    case 'eval':
      return page.eval(value);
    case 'emit':
      return page.emit(value[0], value[1]);
    case 'expect': {
      const text = await page.text(value[0]);
      if (text == null || !text.includes(value[1])) fail(page.id, `expected "${value[1]}" in ${value[0]}, found ${JSON.stringify(text)}`);
      return undefined;
    }
    default:
      throw new Error(`unknown step ${name}`);
  }
}

const sizeTag = (size) => (size[0] === 1280 && size[1] === 800 ? '' : `-${size[0]}x${size[1]}`);

function shotFile(shot, theme) {
  const size = shot.size || [1280, 800];
  const zoom = shot.zoom || ZOOM;
  return path.join(OUT, `${shot.page}-${shot.fixture || 'default'}-${theme}${shot.sizeTag === false ? '' : sizeTag(size)}${zoom !== 1 ? `-z${Math.round(zoom * 100)}` : ''}${shot.reducedMotion ? '-rm' : ''}${shot.forcedColors ? '-fc' : ''}.png`);
}

async function runShot(shot, theme) {
  const file = shotFile(shot, theme);
  const id = path.basename(file, '.png');
  const page = new Page({ ...shot, id, theme, zoom: shot.zoom || ZOOM });
  try {
    await page.open();
    for (const step of shot.steps || []) await runStep(page, step);
    await page.settle(shot.settleMs ?? 120, { pending: !shot.busy });
    await page.parkMouse();
    await page.settle(0, { pending: !shot.busy });
    if (VERBOSE) {
      const calls = await page.calls();
      log(id, 'calls:', calls.map((c) => c.name).join(', ') || '(none)');
      log(id, 'text:', (await page.eval('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 260));
      log(id, 'active:', await page.activeElement());
    }
    const timing = await page.timing();
    const metrics = NO_AUDIT ? { elements: 0 } : await page.audit();
    await page.shot(file, { full: !!shot.full });
    results.shots.push({ id, elements: metrics.elements });
    results.timings.push({ id, page: shot.page, ...timing });
  } catch (error) {
    fail(id, `shot failed: ${error && error.stack ? error.stack : error}`);
  }
  await page.close();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Scenarios: behaviour checks that drive the real page                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** JSON with sorted keys, so object equality does not depend on key order. */
function stable(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}

function makeChecker(id) {
  return {
    ok(condition, message) {
      results.checks += 1;
      if (!condition) fail(id, `check failed: ${message}`);
    },
    equal(actual, expected, message) {
      results.checks += 1;
      if (stable(actual) !== stable(expected)) fail(id, `check failed: ${message} (expected ${stable(expected)}, got ${stable(actual)})`);
    },
    includes(text, part, message) {
      results.checks += 1;
      if (typeof text !== 'string' || !text.includes(part)) fail(id, `check failed: ${message} (expected to contain ${JSON.stringify(part)}, got ${JSON.stringify(text)})`);
    },
  };
}

async function runScenario(scenario, theme) {
  const id = `scenario-${scenario.name}${theme === 'dark' ? '-dark' : ''}`;
  const page = new Page({ ...scenario, id, theme, size: scenario.size || [1280, 800], zoom: scenario.zoom || 1 });
  const t = makeChecker(id);
  t.shot = async (name) => {
    const file = path.join(OUT, `${scenario.name}-${name}-${theme}.png`);
    if (!NO_AUDIT) await page.audit();
    await page.shot(file, { full: !!scenario.full });
  };
  try {
    await page.open();
    await scenario.run(page, t);
  } catch (error) {
    fail(id, `scenario failed: ${error && error.stack ? error.stack : error}`);
  }
  await page.close();
}


/* ------------------------------------------------------------------------------------------------------------------ */
/* First-paint measurement (18b): how long until the page paints its first frame                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

const PAINT_PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const ready = performance.getEntriesByName('gp-ready')[0];
  return JSON.stringify({ fcp: fcp ? fcp.startTime : null, respStart: nav.responseStart, dcl: nav.domContentLoadedEventEnd, ready: ready ? ready.startTime : null });
})()`;

async function readPaint(win) {
  for (let i = 0; i < 100; i += 1) {
    const out = JSON.parse(await win.webContents.executeJavaScript(PAINT_PROBE));
    if (out.fcp != null) return out;
    await sleep(20);
  }
  return null;
}

function newMeasureWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    x: 60,
    y: 40,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  win.showInactive();
  return win;
}

const stats = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? { min: Math.round(v[0]), median: Math.round(v[Math.floor(v.length / 2)]), max: Math.round(v[v.length - 1]) } : { min: null, median: null, max: null };
};

/**
 * cold = a brand-new BrowserWindow per load (includes the renderer starting up, which the main process owns);
 * warm = the same window and renderer navigating between local pages (what the page itself costs: parse, CSS, first frame).
 * The mock answers instantly (latency 0), so "ready" is the page's own work, not the mock's delay.
 */
async function measurePaint() {
  nativeTheme.themeSource = 'light';
  const targets = [
    { name: 'loading', file: 'loading.html', fixture: 'default', query: {} },
    { name: 'offline', file: 'offline.html', fixture: 'timing', query: { reason: 'offline', code: '-106', desc: 'ERR_INTERNET_DISCONNECTED', url: 'https://vendor.societyfiles.com/' } },
    { name: 'password', file: 'password.html', fixture: 'timing', query: {} },
    { name: 'settings', file: 'settings.html', fixture: 'timing', query: {}, hash: 'printers' },
  ];
  const urlOf = (t) => ({ file: path.join(RENDERER, t.file), options: { query: { fixture: t.fixture, ...t.query }, hash: t.hash || '' } });
  const rows = [];

  const baseline = { cold: [], warm: [] };
  for (let i = 0; i < RUNS; i += 1) {
    const win = newMeasureWindow();
    await win.loadURL('data:text/html,<!doctype html><title>b</title><p>hello</p>');
    const out = await readPaint(win);
    if (out) baseline.cold.push(out.fcp);
    win.destroy();
  }
  const baseWin = newMeasureWindow();
  await baseWin.loadURL('data:text/html,<!doctype html><title>b</title><p>hello</p>');
  for (let i = 0; i < RUNS; i += 1) {
    await baseWin.loadURL(`data:text/html,<!doctype html><title>b</title><p>hello ${i}</p>`);
    const out = await readPaint(baseWin);
    if (out) baseline.warm.push(out.fcp);
  }
  baseWin.destroy();
  rows.push({ page: 'blank page', cold: stats(baseline.cold), warm: stats(baseline.warm), readyCold: null, readyWarm: null });

  for (const target of targets) {
    const cold = [];
    const coldReady = [];
    for (let i = 0; i < RUNS; i += 1) {
      const win = newMeasureWindow();
      const u = urlOf(target);
      await win.loadFile(u.file, u.options);
      const out = await readPaint(win);
      if (out) {
        cold.push(out.fcp);
        if (out.ready != null) coldReady.push(out.ready);
      }
      win.destroy();
      await sleep(60);
    }
    const warm = [];
    const warmReady = [];
    const win = newMeasureWindow();
    const neutral = path.join(RENDERER, target.file === 'password.html' ? 'loading.html' : 'password.html');
    await win.loadFile(neutral, { query: { fixture: 'timing' } });
    await sleep(150);
    for (let i = 0; i < RUNS; i += 1) {
      const u = urlOf(target);
      await win.loadFile(u.file, u.options);
      const out = await readPaint(win);
      if (out) {
        warm.push(out.fcp);
        if (out.ready != null) warmReady.push(out.ready);
      }
      await win.loadFile(neutral, { query: { fixture: 'timing', i } });
      await sleep(60);
    }
    win.destroy();
    rows.push({ page: target.name, cold: stats(cold), warm: stats(warm), readyCold: coldReady.length ? stats(coldReady) : null, readyWarm: warmReady.length ? stats(warmReady) : null });
  }
  return rows;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Main                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const themesOf = (item) => (THEME === 'both' ? ['light', 'dark'] : THEME ? [THEME] : item.themes || ['light']);

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

async function main() {
  const plan = [];
  for (const shot of SHOTS) for (const theme of themesOf(shot)) plan.push({ shot, theme, id: path.basename(shotFile(shot, theme), '.png') });
  const scenarios = [];
  for (const scenario of SCENARIOS) for (const theme of THEME ? (THEME === 'both' ? scenario.themes || ['light'] : [THEME]) : scenario.themes || ['light']) scenarios.push({ scenario, theme });

  if (opt('list') === 'true') {
    for (const p of plan) console.log(p.id);
    for (const s of scenarios) console.log(`scenario-${s.scenario.name}`);
    app.quit();
    return;
  }

  await app.whenReady();
  if (opt('fail-test') === 'true') fail('self-test', 'deliberate failure requested with --fail-test');
  fs.mkdirSync(OUT, { recursive: true });
  // A full run replaces the previous set of PNGs; partial runs (--only, --timing-only) leave the others alone.
  if (!ONLY.length && !TIMING_ONLY) for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));

  // Warm-up window so the first measured page does not pay for starting the GPU process.
  const warm = new BrowserWindow({ width: 200, height: 120, show: false, focusable: false, frame: false });
  await warm.loadURL('about:blank');
  warm.showInactive();
  await sleep(150);
  warm.destroy();

  if (!TIMING_ONLY) {
    console.log('logic checks...');
    await runLogicChecks(makeChecker('logic'), pathToFileURL(path.join(RENDERER, 'shared', 'format.mjs')).href);
  }

  console.log(`shots: ${TIMING_ONLY ? 0 : plan.filter((p) => wanted(p.id)).length}`);
  for (const p of TIMING_ONLY ? [] : plan) {
    if (wanted(p.id)) await runShot(p.shot, p.theme);
  }
  console.log(`scenarios: ${TIMING_ONLY ? 0 : scenarios.filter((s) => wanted(`scenario-${s.scenario.name}`)).length}`);
  for (const s of TIMING_ONLY ? [] : scenarios) {
    if (wanted(`scenario-${s.scenario.name}`)) {
      log('scenario', s.scenario.name, s.theme);
      await runScenario(s.scenario, s.theme);
    }
  }
  if (!NO_TIMING) {
    console.log(`first-paint measurement (${RUNS} loads per page, cold and warm)...`);
    try {
      results.paint = await measurePaint();
      for (const row of results.paint) {
        if (row.page !== 'blank page' && row.warm.median != null && row.warm.median > 250) fail(`timing-${row.page}`, `warm first paint median ${row.warm.median} ms is far above the 100 ms target`);
      }
    } catch (error) {
      fail('timing', `measurement failed: ${error && error.stack ? error.stack : error}`);
    }
  }
}

function report() {
  const byPage = {};
  for (const t of results.timings) (byPage[t.page] ||= []).push(t);
  const timingRows = Object.entries(byPage).map(([name, rows]) => ({
    page: name,
    shots: rows.length,
    fcpMedianMs: median(rows.map((r) => r.fcp)),
    fcpMaxMs: Math.max(...rows.map((r) => r.fcp || 0)),
    pageCostMedianMs: median(rows.map((r) => (r.fcp != null ? r.fcp - r.responseStart : null))),
    pageCostMaxMs: Math.max(...rows.map((r) => (r.fcp != null ? r.fcp - r.responseStart : 0))),
    domContentLoadedMedianMs: median(rows.map((r) => r.dcl)),
  }));
  fs.mkdirSync(OUT, { recursive: true });
  // report.json always describes a full run; partial runs (--only, --timing-only) write report-partial.json instead.
  const reportFile = ONLY.length || TIMING_ONLY ? 'report-partial.json' : 'report.json';
  fs.writeFileSync(path.join(OUT, reportFile), JSON.stringify({ ...results, timingSummary: timingRows }, null, 2));
  console.log(`\nPNGs written: ${results.written.length}   checks: ${results.checks}   failures: ${results.failures.length}   warnings: ${results.warnings.length}`);
  if (timingRows.length) {
    console.log('\nfirst paint (ms): fcp = from navigation start (includes renderer start-up); page cost = fcp - responseStart (what the page itself controls)');
    for (const r of timingRows) {
      console.log(`  ${r.page.padEnd(9)} fcp median ${String(r.fcpMedianMs).padStart(4)}  max ${String(r.fcpMaxMs).padStart(4)}   page cost median ${String(r.pageCostMedianMs).padStart(4)}  max ${String(r.pageCostMaxMs).padStart(4)}   (${r.shots} loads)`);
    }
  }
  if (results.paint) {
    console.log('\nfirst paint, ms (fcp = first-contentful-paint measured with performance.now; ready = state shown):');
    console.log('  page          cold window (min/median/max)     warm renderer (min/median/max)     ready warm (median)');
    for (const r of results.paint) {
      const fmt = (s) => (s ? `${s.min}/${s.median}/${s.max}` : '-');
      console.log(`  ${r.page.padEnd(12)}  ${fmt(r.cold).padEnd(28)}     ${fmt(r.warm).padEnd(28)}     ${r.readyWarm ? r.readyWarm.median : '-'}`);
    }
  }
  const seen = new Set();
  for (const f of results.failures) {
    const line = `FAIL [${f.where}] ${f.message}`;
    if (!seen.has(line)) {
      seen.add(line);
      console.log(line);
    }
  }
  for (const w of results.warnings.slice(0, 20)) console.log(`warn [${w.where}] ${w.message}`);
}

const watchdog = setTimeout(() => {
  console.error('ui-shots: watchdog timeout (30 minutes)');
  process.exit(3);
}, 30 * 60 * 1000);
watchdog.unref();

app.on('window-all-closed', () => {
  // Windows are opened and closed one after another; closing the last one must not quit the app.
});

main()
  .catch((error) => fail('main', `harness error: ${error && error.stack ? error.stack : error}`))
  .finally(() => {
    report();
    const code = results.failures.length ? 1 : 0;
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true });
    } catch {
      // temp profile cleanup is best effort
    }
    app.once('quit', () => process.exit(code));
    app.quit();
  });
