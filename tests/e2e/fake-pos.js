'use strict';

/**
 * A tiny fake of the web POS for the end-to-end runs (SPEC 17): a local HTTP server on 127.0.0.1 that the REAL app loads through
 * `GADGETSPOS_START_URL` (honoured only when the app is not packaged). It can be stopped and started again on the same address
 * whenever a scenario needs "the server is down", and it serves two pages:
 *
 *  - the SMOKE page (`/vendor/point-of-sale?harness=smoke`, tests/e2e/smoke-fixtures/pos.html + pos.js): a POS-like screen that
 *    exposes `window.__pos`, with which tests/e2e/run-smoke.js calls every `window.electron` function (legacy and new) with a
 *    realistic payload. Each call is recorded in the DOM, in `window.__pos.results` and as a POST to `/report` (kept in `reports`);
 *  - the LEGACY page (the same address without `harness`, `PAGE` below): the self-running page of tests/e2e/run-app.js, which
 *    announces itself (`/ready`), waits for the harness to say go (`/go`) and reports once (`/report`).
 *
 * Other addresses: `/ping` answers 200 (a request the page can make to see the server go away), `/assets/*` serves the smoke
 * fixtures, a HEAD request answers 200 (the app's connection probe), `/favicon.ico` answers 204.
 *
 * Not named *.test.js: node --test must not run it. Plain Node, no dependencies.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, 'smoke-fixtures');
const POS_PATH = '/vendor/point-of-sale';

/** The files of the smoke page, by address. */
const ASSETS = Object.freeze({
  '/assets/pos.js': { file: 'pos.js', type: 'text/javascript; charset=utf-8' },
  '/assets/pos.css': { file: 'pos.css', type: 'text/css; charset=utf-8' },
});

/** The legacy page. It runs inside the real Electron window, so `window.electron` and `window.desktop` are the real preload's. */
const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake POS</title></head>
<body>
<h1>Fake POS</h1>
<p id="status">waiting for the harness</p>
<script>
(async () => {
  const e = window.electron;
  const out = {
    electron: typeof e,
    desktop: typeof window.desktop,
    functions: e ? Object.keys(e).sort() : [],
    userAgentHasElectron: /Electron/.test(navigator.userAgent),
  };
  await fetch('/ready', { method: 'POST', body: JSON.stringify(out) });
  await fetch('/go');
  if (e) {
    const bytes = new Uint8Array([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00]);
    e.sendReceiptData({ receiptFileBinary: bytes, order: { id: 1, notes: 'x'.repeat(10240) }, business: {}, settings: { currency: 'GBP' } });
    e.sendBarcodeData({ barcodefinal: '^XA^FDLegacy^FS^XZ', barcode: '1', title: 'legacy' });
    out.printReceipt = await e.printReceipt({ receiptFileBinary: bytes });
    out.printReceiptEmpty = await e.printReceipt({ receiptFileBinary: new Uint8Array(0) });
    out.printBarcodeZebra = await e.printBarcode({ barcodefinal: '^XA^FDAck^FS^XZ' });
    out.printBarcodeDymo = await e.printBarcode({ barcodefinal: { printer: 'dymo', title: 'iPhone 13', barcode: 'ABC123' }, size: '32x57', design: '1', currency: 'GBP' });
    out.openDrawerWrong = await e.openCashDrawer({ password: 'not-the-password' });
    out.openDrawerRight = await e.openCashDrawer({ password: 'e2e-password' });
    out.openButton = await e.printReceipt({ openCashDrawer: true, order: false, business: {}, settings: {} });
    out.appInfo = await e.getAppInfo();
    out.printers = await e.getPrinters();
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(out) });
  document.getElementById('status').textContent = 'done';
})().catch((error) => fetch('/report', { method: 'POST', body: JSON.stringify({ error: String(error) }) }));
</script>
</body>
</html>`;

/** @param {string} file a file name inside smoke-fixtures @returns {Buffer} */
function readFixture(file) {
  return fs.readFileSync(path.join(FIXTURES_DIR, file));
}

/**
 * @typedef {object} FakePos
 * @property {string} url                 the legacy page: http://127.0.0.1:<port>/vendor/point-of-sale
 * @property {string} smokeUrl            the smoke page: the same address with ?harness=smoke
 * @property {string} origin              http://127.0.0.1:<port>
 * @property {number} port
 * @property {string[]} requests          "METHOD /path?query" of every request, in order (kept across stop and start)
 * @property {object[]} reports           the records the smoke page POSTed to /report, in order
 * @property {() => boolean} isListening
 * @property {(prefix: string) => number} hits  how many requests had a path starting with `prefix`
 * @property {(name: string, options?: { since?: number, timeoutMs?: number }) => Promise<object>} waitForReport
 *   the first record called `name` with an index of at least `since`
 * @property {() => Promise<void>} stop   closes the listening socket and every open connection, so the app sees the server vanish
 * @property {() => Promise<void>} start  listens again on the SAME port (does nothing while it listens)
 * @property {() => Promise<object>} ready     legacy page: resolves with what the page saw once it has loaded
 * @property {() => void} release              legacy page: lets the page go on with its calls
 * @property {() => Promise<object>} report    legacy page: resolves with the page's final report
 */

/**
 * Starts the fake POS.
 *
 * @param {object} [options]
 * @param {number} [options.port=0] 0 picks a free port; pass the old port to bring a stopped server back at the same address
 * @returns {Promise<FakePos>}
 */
async function startFakePos({ port = 0 } = {}) {
  const requests = [];
  const reports = [];
  /** @type {Array<{ name: string, since: number, resolve: Function }>} */
  const reportWaiters = [];
  let resolveReady;
  let resolveReport;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const report = new Promise((resolve) => { resolveReport = resolve; });
  const waiting = [];
  let released = false;

  /** A POST to /report: a smoke record (it has a `kind`) or the legacy page's one final report. */
  function takeReport(text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    if (body && body.kind === 'call') {
      reports.push(body);
      for (const waiter of [...reportWaiters]) {
        if (waiter.name === body.name && reports.length - 1 >= waiter.since) {
          reportWaiters.splice(reportWaiters.indexOf(waiter), 1);
          waiter.resolve(body);
        }
      }
    } else {
      resolveReport(body);
    }
  }

  function serve(request, response) {
    requests.push(`${request.method} ${request.url}`);
    const target = new URL(request.url, 'http://127.0.0.1');
    const body = [];
    request.on('data', (chunk) => body.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(body).toString('utf8');
      if (request.method === 'HEAD') {
        response.writeHead(200).end();
      } else if (target.pathname === '/ready') {
        resolveReady(JSON.parse(text));
        response.end('ok');
      } else if (target.pathname === '/go') {
        if (released) response.end('go');
        else waiting.push(response);
      } else if (target.pathname === '/report') {
        takeReport(text);
        response.end('ok');
      } else if (target.pathname === '/ping') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('pong');
      } else if (target.pathname === '/favicon.ico') {
        response.writeHead(204).end();
      } else if (Object.hasOwn(ASSETS, target.pathname)) {
        const asset = ASSETS[target.pathname];
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        response.end(readFixture(asset.file));
      } else if (target.searchParams.get('harness') === 'smoke') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(readFixture('pos.html'));
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
      }
    });
  }

  /** @type {http.Server|null} */
  let server = null;
  const connections = new Set();
  let boundPort = port;

  async function start() {
    if (server) return;
    const next = http.createServer(serve);
    next.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
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
      for (const socket of connections) socket.destroy();
      closing.close(() => resolve());
    });
  }

  await start();

  const fake = {
    get port() { return boundPort; },
    get origin() { return `http://127.0.0.1:${boundPort}`; },
    get url() { return `http://127.0.0.1:${boundPort}${POS_PATH}`; },
    get smokeUrl() { return `http://127.0.0.1:${boundPort}${POS_PATH}?harness=smoke`; },
    requests,
    reports,
    isListening: () => server !== null,
    hits: (prefix) => requests.filter((entry) => entry.split(' ')[1].startsWith(prefix)).length,
    waitForReport(name, { since = 0, timeoutMs = 10_000 } = {}) {
      const found = reports.findIndex((entry, index) => index >= since && entry.name === name);
      if (found >= 0) return Promise.resolve(reports[found]);
      return new Promise((resolve, reject) => {
        const waiter = { name, since, resolve };
        const timer = setTimeout(() => {
          reportWaiters.splice(reportWaiters.indexOf(waiter), 1);
          reject(new Error(`no report called ${name} within ${timeoutMs} ms`));
        }, timeoutMs);
        waiter.resolve = (entry) => {
          clearTimeout(timer);
          resolve(entry);
        };
        reportWaiters.push(waiter);
      });
    },
    start,
    stop,
    ready: () => ready,
    report: () => report,
    release() {
      released = true;
      for (const response of waiting.splice(0)) response.end('go');
    },
  };
  return fake;
}

module.exports = { startFakePos, PAGE, POS_PATH };
