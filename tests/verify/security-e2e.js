'use strict';

/**
 * Security verification against the REAL app under real Electron (the security lens of the v2 build). Run it with
 *
 *     node tests/verify/security-e2e.js
 *
 * It starts `electron tests/verify/security-main.js` (the real `bootstrap()` of src/main/index.js with fake printers), attaches
 * puppeteer-core through the remote debugging port (a browser is never launched, never closed) and asks a local page to attack the
 * app the way a hostile or compromised page, or a third-party iframe inside the POS page, could:
 *
 *   R1-R6  REGRESSION GUARDS (these pass today): window.electron only in the top frame of an allowed origin; nothing in iframes or in
 *          popups of foreign frames; foreign and file: navigation blocked; popups keep the secure web preferences whatever the
 *          window.open features string says; a foreign https link goes to the system browser.
 *   V1-V3  FINDINGS (these FAIL until the source is fixed, each names its finding):
 *          V1  window.open features reach the native window options (always-on-top, kiosk, not closable, ...)
 *          V2  no limit on popups and on system-browser tabs a page can open
 *          V3  a 16 MB label title stalls the main process for seconds (any size: for as long as the page likes)
 *
 * The app never takes focus: macOS "accessory" policy, and every popup is created hidden (see security-main.js). Exit code 0 when
 * every check passes, 1 otherwise. Not named *.test.js: node --test must not run it (it starts Electron).
 */

const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));

function electronBinary() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const results = [];
function check(id, title, passed, detail) {
  results.push({ id, title, passed: Boolean(passed), detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${id}  ${title}${passed || !detail ? '' : `\n        -> ${detail}`}\n`);
}

/** A page of the "POS" (trusted: it is the start URL) and of a foreign origin (IPv6 loopback, which is not trusted). */
function startServer(label, host, port) {
  const server = http.createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>${label}</title><body>${label}</body>`);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-verify-'));
  const portA = await freePort();
  const portB = await freePort();
  const serverA = await startServer('POS', '127.0.0.1', portA);
  const serverB = await startServer('foreign widget', '::1', portB);
  const originA = `http://127.0.0.1:${portA}`;
  const originB = `http://[::1]:${portB}`;

  const debugPort = await freePort();
  const controlPort = await freePort();
  const userData = path.join(work, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const env = {
    ...process.env,
    GPOS_VERIFY_USER_DATA: userData,
    GPOS_VERIFY_CONTROL_PORT: String(controlPort),
    GADGETSPOS_START_URL: `${originA}/vendor/point-of-sale`,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  delete env.ELECTRON_RUN_AS_NODE; // a terminal started from an Electron app would make the child plain Node
  const child = spawn(electronBinary(), [`--remote-debugging-port=${debugPort}`, path.join(__dirname, 'security-main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const stop = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  process.on('exit', stop);
  const watchdog = setTimeout(() => { process.stderr.write('security-e2e: watchdog (150 s)\n'); stop(); process.exit(2); }, 150000);
  watchdog.unref();

  const cmd = async (name, args = {}) => (await (await fetch(`http://127.0.0.1:${controlPort}/cmd`, { method: 'POST', body: JSON.stringify({ name, args }) })).json()).value;
  let browser = null;
  try {
    for (let i = 0; i < 200; i += 1) {
      try {
        const answer = await fetch(`http://127.0.0.1:${controlPort}/health`, { signal: AbortSignal.timeout(500) });
        if ((await answer.json()).ready) break;
      } catch { /* not up yet */ }
      await sleep(150);
    }
    for (let i = 0; i < 100; i += 1) {
      const windows = await cmd('windows').catch(() => []);
      if (windows[0] && windows[0].url && !/loading\.html/.test(windows[0].url)) break;
      await sleep(150);
    }
    await sleep(600);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null });
    let page = null;
    for (let i = 0; i < 100 && !page; i += 1) {
      page = (await browser.pages()).find((candidate) => candidate.url().startsWith(originA)) || null;
      if (!page) await sleep(150);
    }
    if (!page) throw new Error('the POS page did not load');

    const popupOf = () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      browser.once('targetcreated', async (target) => {
        clearTimeout(timer);
        try { resolve(await target.page()); } catch { resolve(null); }
      });
    });
    const secure = (prefs) => prefs.contextIsolation === true && prefs.sandbox === true && !prefs.nodeIntegration
      && !prefs.nodeIntegrationInSubFrames && !prefs.nodeIntegrationInWorker && prefs.webSecurity === true
      && !prefs.allowRunningInsecureContent && !prefs.webviewTag && !prefs.enableBlinkFeatures && !prefs.experimentalFeatures;

    // ---- R1 -------------------------------------------------------------------------------------------------------------------
    const top = await page.evaluate(() => ({ electron: typeof window.electron, desktop: typeof window.desktop, keys: window.electron ? Object.keys(window.electron).sort() : [] }));
    check('R1', 'the top frame of the POS origin has window.electron (8 functions) and no window.desktop',
      top.electron === 'object' && top.desktop === 'undefined' && top.keys.length === 8, JSON.stringify(top));

    // ---- R2 -------------------------------------------------------------------------------------------------------------------
    await page.evaluate((a, b) => new Promise((resolve) => {
      let loaded = 0;
      for (const src of [`${a}/frame.html`, `${b}/frame.html`]) {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.onload = () => { loaded += 1; if (loaded === 2) resolve(); };
        document.body.appendChild(frame);
      }
    }), originA, originB);
    const frames = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      frames.push(await frame.evaluate(() => ({ origin: location.origin, electron: typeof window.electron, desktop: typeof window.desktop })));
    }
    check('R2', 'iframes (same origin and foreign origin) get neither window.electron nor window.desktop',
      frames.length === 2 && frames.every((entry) => entry.electron === 'undefined' && entry.desktop === 'undefined'), JSON.stringify(frames));

    // ---- R3 -------------------------------------------------------------------------------------------------------------------
    const foreignFrame = page.frames().find((frame) => frame.url().startsWith(originB));
    let pending = popupOf();
    await foreignFrame.evaluate(() => { window.__popup = window.open('about:blank'); });
    let popup = await pending;
    const fromIframe = popup ? await popup.evaluate(() => typeof window.electron) : 'no popup';
    if (popup) await popup.close().catch(() => {});
    await cmd('closePopups');
    pending = popupOf();
    await page.evaluate(() => { window.__popup = window.open('about:blank'); });
    popup = await pending;
    const fromTop = popup ? await popup.evaluate(() => typeof window.electron) : 'no popup';
    await cmd('closePopups');
    check('R3', 'an about:blank popup of a FOREIGN iframe gets no window.electron; one of the POS page does',
      fromIframe === 'undefined' && fromTop === 'object', `from the foreign iframe: ${fromIframe}, from the top frame: ${fromTop}`);

    // ---- R4 -------------------------------------------------------------------------------------------------------------------
    const before = page.url();
    await page.evaluate((b) => { location.href = `${b}/x`; }, originB).catch(() => {});
    await sleep(700);
    const afterForeign = page.url();
    await page.evaluate(() => { location.href = 'file:///etc/hosts'; }).catch(() => {});
    await sleep(500);
    check('R4', 'top-level navigation to a foreign origin and to a file: URL is blocked', afterForeign === before && page.url() === before, `${before} -> ${afterForeign} -> ${page.url()}`);

    // ---- R5 -------------------------------------------------------------------------------------------------------------------
    const HOSTILE = 'nodeIntegration=yes,contextIsolation=no,sandbox=no,webSecurity=no,nodeIntegrationInWorker=yes,nodeIntegrationInSubFrames=yes,webviewTag=yes,plugins=yes,preload=/tmp/evil.js,enableBlinkFeatures=Foo,allowRunningInsecureContent=yes,devTools=yes';
    await cmd('closePopups');
    await page.evaluate((features) => { window.__popup = window.open('about:blank', '_blank', features); }, HOSTILE);
    await sleep(900);
    const hostile = (await cmd('windows')).filter((win) => win.id !== 1);
    check('R5', 'a popup keeps the secure web preferences whatever the window.open features string says',
      hostile.length === 1 && secure(hostile[0].prefs), JSON.stringify(hostile.map((win) => win.prefs)));

    // ---- R6 -------------------------------------------------------------------------------------------------------------------
    await cmd('closePopups');
    await cmd('clearExternal');
    await page.evaluate(() => { window.open('https://example.com/docs'); });
    await sleep(600);
    const afterLink = await cmd('state');
    const popupsAfterLink = (await cmd('windows')).filter((win) => win.id !== 1);
    check('R6', 'a foreign https link goes to the system browser and creates no window',
      afterLink.openExternal.length === 1 && afterLink.openExternal[0] === 'https://example.com/docs' && popupsAfterLink.length === 0,
      JSON.stringify({ external: afterLink.openExternal, windows: popupsAfterLink.length }));

    // ---- V1 -------------------------------------------------------------------------------------------------------------------
    // The popup is opened by a FOREIGN iframe: nothing but the iframe's own origin is involved.
    await cmd('closePopups');
    const NATIVE = 'alwaysOnTop=yes,fullscreen=yes,kiosk=yes,closable=no,movable=no,frame=no,focusable=no,opacity=0.05,width=300,height=200';
    await foreignFrame.evaluate((features) => { window.__popup = window.open('about:blank', '_blank', features); }, NATIVE);
    await sleep(1000);
    const spoof = (await cmd('windows')).filter((win) => win.id !== 1)[0];
    const honoured = spoof ? [
      spoof.alwaysOnTop && 'alwaysOnTop',
      (spoof.kiosk || spoof.fullScreen) && 'kiosk/fullscreen',
      !spoof.closable && 'not closable',
      !spoof.movable && 'not movable',
      spoof.frameless && 'frameless',
      !spoof.focusable && 'not focusable',
      spoof.opacity < 1 && `opacity ${spoof.opacity}`,
    ].filter(Boolean) : ['no popup'];
    check('V1', 'FINDING: native window options from a window.open features string are NOT honoured (always-on-top, kiosk, closable, opacity, ...)',
      spoof && honoured.length === 0, `a foreign iframe got a popup that is: ${honoured.join(', ')}`);
    await cmd('closePopups');

    // ---- V2 -------------------------------------------------------------------------------------------------------------------
    await cmd('clearExternal');
    await page.evaluate(() => {
      for (let i = 0; i < 60; i += 1) window.open('about:blank');
      for (let i = 0; i < 100; i += 1) window.open(`https://example.com/spam${i}`);
    });
    await sleep(3000);
    const flood = await cmd('state');
    const floodWindows = (await cmd('windows')).filter((win) => win.id !== 1).length;
    check('V2', 'FINDING: one page cannot open dozens of windows or system-browser tabs without a user gesture',
      floodWindows <= 10 && flood.openExternal.length <= 10, `60 window.open('about:blank') created ${floodWindows} windows; 100 foreign https window.open calls opened ${flood.openExternal.length} browser tabs`);
    await cmd('closePopups');

    // ---- V3 -------------------------------------------------------------------------------------------------------------------
    let maxGap = 0;
    let last = Date.now();
    let running = true;
    const pinger = (async () => {
      while (running) {
        try { await fetch(`http://127.0.0.1:${controlPort}/health`, { signal: AbortSignal.timeout(60000) }); } catch { /* ignore */ }
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        await sleep(25);
      }
    })();
    await page.evaluate(() => window.electron.printBarcode({ size: '32x57', design: '1', barcodefinal: { printer: 'dymo', title: 'a b\n'.repeat(4 * 1024 * 1024), barcode: '1' } }));
    running = false;
    await pinger;
    check('V3', 'FINDING: a label with a 16 MB title does not stall the main process (limit 250 ms)', maxGap <= 250, `the main process did not answer for ${maxGap} ms`);
  } catch (error) {
    check('ERR', 'the verification run itself', false, String((error && error.stack) || error));
    process.stdout.write(`${output.slice(-1500)}\n`);
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    stop();
    serverA.close();
    serverB.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp folder: best effort */ }
  }
  const failed = results.filter((entry) => !entry.passed);
  process.stdout.write(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `; failing: ${failed.map((entry) => entry.id).join(', ')}` : ''}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
