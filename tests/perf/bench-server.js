'use strict';

/**
 * The benchmark server (tests/perf/benchmark.js): a local HTTP server on 127.0.0.1 that both versions of the app load as their POS.
 *
 *   GET  /pos?run=<id>             a light POS-like page (a product grid and a cart, about 60 KB). It reports `loaded` from its `load`
 *                                  event and does nothing afterwards, so an idle run is idle. With `&mode=cmd` it also takes commands.
 *   GET  /stress?run=<id>          the stress page (3000 rows, 24 moving translucent cards, a scrolling animation); it takes commands.
 *   GET  /bench-client.js, /stress.js   the page scripts (tests/perf/pages)
 *   HEAD *                         200 (the v2 app's connection probe)
 *   POST /__bench/report?run&kind  a report from a page; the server timestamps it on arrival with the harness's own monotonic clock
 *   GET  /__bench/next?run         a long poll: answers the next command the harness queued for this run
 *
 * The harness and this server are ONE process, so `performance.now()` at the moment a report arrives is on the same clock as the
 * `performance.now()` taken just before the app was spawned: "time to POS loaded" is a plain subtraction.
 * Not named *.test.js: node --test must not run it.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const PAGES_DIR = path.join(__dirname, 'pages');
const CARD_COUNT = 150;

/** @param {number} count @returns {string} the static product cards of the light page */
function productCards(count) {
  const names = ['Apple iPhone 13 Pro 256GB', 'Samsung Galaxy S22 128GB', 'Google Pixel 7 Pro', 'Apple iPad Air 64GB', 'USB-C cable 1m', 'Screen protector'];
  let html = '';
  for (let i = 0; i < count; i += 1) {
    html += `    <article class="card"><div class="thumb"></div><h3>${names[i % names.length]} #${i}</h3>`
      + `<p class="meta">SKU GP-${100000 + i} &middot; Grade ${'ABC'[i % 3]}</p>`
      + `<div class="line"><span class="price">&pound;${(9 + ((i * 17) % 700)).toFixed(2)}</span><span class="stock">${1 + (i % 14)} in stock</span></div>`
      + '<button class="add" type="button">Add to cart</button></article>\n';
  }
  return html;
}

/**
 * Starts the server.
 *
 * @param {{ port?: number }} [options]
 * @returns {Promise<{
 *   origin: string,
 *   port: number,
 *   url: (page: 'pos'|'stress', runId: string, extra?: Record<string, string>) => string,
 *   waitReport: (runId: string, kind: string, timeoutMs?: number) => Promise<{ data: any, at: number }>,
 *   getReport: (runId: string, kind: string) => ({ data: any, at: number }|undefined),
 *   command: (runId: string, name: string, args?: object, timeoutMs?: number) => Promise<any>,
 *   requestCount: () => number,
 *   close: () => Promise<void>
 * }>}
 */
async function startBenchServer({ port = 0 } = {}) {
  const posHtml = fs.readFileSync(path.join(PAGES_DIR, 'pos.html'), 'utf8').replace('<!--CARDS-->', productCards(CARD_COUNT));
  const files = {
    '/stress': { body: fs.readFileSync(path.join(PAGES_DIR, 'stress.html')), type: 'text/html; charset=utf-8' },
    '/pos': { body: Buffer.from(posHtml), type: 'text/html; charset=utf-8' },
    '/bench-client.js': { body: fs.readFileSync(path.join(PAGES_DIR, 'bench-client.js')), type: 'text/javascript; charset=utf-8' },
    '/stress.js': { body: fs.readFileSync(path.join(PAGES_DIR, 'stress.js')), type: 'text/javascript; charset=utf-8' },
  };

  /** @type {Map<string, { reports: Map<string, { data: any, at: number }>, waiters: Array<{ kind: string, resolve: Function }>, queue: object[], poller: null|object, pending: Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }> }>} */
  const runs = new Map();
  let commandSeq = 0;
  let requests = 0;

  function runOf(id) {
    if (!runs.has(id)) runs.set(id, { reports: new Map(), waiters: [], queue: [], poller: null, pending: new Map() });
    return runs.get(id);
  }

  /** Hands the next queued command to a waiting long poll. */
  function dispatch(run) {
    if (run.poller && run.queue.length > 0) {
      const response = run.poller;
      run.poller = null;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(run.queue.shift()));
    }
  }

  function takeReport(run, kind, text) {
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    const entry = { data, at: performance.now() };
    const result = /^result-(\d+)$/.exec(kind);
    if (result) {
      const pending = run.pending.get(Number(result[1]));
      if (pending) {
        run.pending.delete(Number(result[1]));
        clearTimeout(pending.timer);
        pending.resolve(data);
      }
      return;
    }
    run.reports.set(kind, entry);
    for (const waiter of run.waiters.filter((item) => item.kind === kind)) {
      run.waiters.splice(run.waiters.indexOf(waiter), 1);
      waiter.resolve(entry);
    }
  }

  const server = http.createServer((request, response) => {
    requests += 1;
    const target = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'HEAD') {
      response.writeHead(200).end();
      return;
    }
    if (target.pathname === '/__bench/next') {
      const run = runOf(target.searchParams.get('run') || 'none');
      if (run.poller) run.poller.destroy();
      run.poller = response;
      response.on('close', () => {
        if (run.poller === response) run.poller = null;
      });
      dispatch(run);
      return;
    }
    if (request.method === 'POST' && target.pathname === '/__bench/report') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        takeReport(runOf(target.searchParams.get('run') || 'none'), target.searchParams.get('kind') || '', Buffer.concat(chunks).toString('utf8'));
        response.writeHead(204).end();
      });
      return;
    }
    if (target.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const file = files[target.pathname];
    if (file) {
      response.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' });
      response.end(file.body);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const boundPort = server.address().port;
  const origin = `http://127.0.0.1:${boundPort}`;

  return {
    origin,
    port: boundPort,
    url(page, runId, extra = {}) {
      const query = new URLSearchParams({ run: runId, ...extra });
      return `${origin}/${page}?${query}`;
    },
    waitReport(runId, kind, timeoutMs = 60_000) {
      const run = runOf(runId);
      if (run.reports.has(kind)) return Promise.resolve(run.reports.get(kind));
      return new Promise((resolve, reject) => {
        const waiter = { kind, resolve: null };
        const timer = setTimeout(() => {
          run.waiters.splice(run.waiters.indexOf(waiter), 1);
          reject(new Error(`no "${kind}" report from run ${runId} within ${timeoutMs} ms`));
        }, timeoutMs);
        waiter.resolve = (entry) => {
          clearTimeout(timer);
          resolve(entry);
        };
        run.waiters.push(waiter);
      });
    },
    getReport: (runId, kind) => runOf(runId).reports.get(kind),
    command(runId, name, args = {}, timeoutMs = 60_000) {
      const run = runOf(runId);
      commandSeq += 1;
      const id = commandSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          run.pending.delete(id);
          reject(new Error(`command ${name} of run ${runId} was not answered within ${timeoutMs} ms`));
        }, timeoutMs);
        run.pending.set(id, { resolve, reject, timer });
        run.queue.push({ id, cmd: name, args });
        dispatch(run);
      });
    },
    requestCount: () => requests,
    close: () => new Promise((resolve) => {
      for (const run of runs.values()) if (run.poller) run.poller.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

module.exports = { startBenchServer, productCards };
