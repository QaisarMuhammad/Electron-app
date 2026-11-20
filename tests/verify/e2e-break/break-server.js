'use strict';

/**
 * A programmable fake POS for the runtime-e2e lens (tests/verify/e2e-break/run-break.js). Like tests/e2e/fake-pos.js it is a local
 * server on 127.0.0.1 that the REAL app loads through GADGETSPOS_START_URL and that can be stopped and started again on the same
 * port, and it serves the same smoke page (tests/e2e/smoke-fixtures: window.__pos), but every answer is a programmable BEHAVIOUR so a
 * scenario can make the server slow, silent, broken, redirecting, or answer 503 to the page while the app's HEAD probe sees 200.
 *
 * Behaviours (`server.get(behaviour)` for the page, `server.head(behaviour)` for the app's connection probe, `server.path(path, behaviour)`
 * for one address):
 *   { kind: 'ok' }                      the smoke page
 *   { kind: 'status', status, body? }   an HTTP status with a small HTML body
 *   { kind: 'slow', ms, then? }         wait `ms`, then answer `then` (default: ok)
 *   { kind: 'hang' }                    accept the request and never answer
 *   { kind: 'close' }                   destroy the connection without an answer
 *   { kind: 'garbage' }                 write something that is not HTTP and close
 *   { kind: 'redirect', location, status? }
 *   { kind: 'empty200' }                200 with an empty body (a blank page)
 *   { kind: 'partial' }                 headers and half a body, then the connection is cut
 *
 * `/ping` always answers 200 (while listening), `/report` records the page's call reports, `/favicon.ico` 204, `/assets/*` the fixtures.
 * HTTPS: pass `tls: { key, cert }`.
 *
 * Not named *.test.js: node --test must not run it. Plain Node, no dependencies.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'e2e', 'smoke-fixtures');
const POS_PATH = '/vendor/point-of-sale';
const ASSETS = Object.freeze({
  '/assets/pos.js': { file: 'pos.js', type: 'text/javascript; charset=utf-8' },
  '/assets/pos.css': { file: 'pos.css', type: 'text/css; charset=utf-8' },
});

const readFixture = (file) => fs.readFileSync(path.join(FIXTURES_DIR, file));

/**
 * @param {object} [options]
 * @param {number} [options.port=0]
 * @param {{ key: string|Buffer, cert: string|Buffer }} [options.tls]
 * @param {string} [options.label] a name for messages
 */
async function createBreakServer({ port = 0, tls = null, label = 'server' } = {}) {
  let getBehaviour = { kind: 'ok' };
  let headBehaviour = { kind: 'status', status: 200 };
  const pathBehaviours = new Map();
  const requests = [];
  const reports = [];
  const timers = new Set();
  const connections = new Set();
  let server = null;
  let boundPort = port;
  const scheme = tls ? 'https' : 'http';

  function later(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  function page(response, status = 200) {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(readFixture('pos.html'));
  }

  function behave(request, response, behaviour) {
    switch (behaviour.kind) {
      case 'status':
        response.writeHead(behaviour.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : (behaviour.body === undefined ? `<!doctype html><title>Server error</title><h1>Server error ${behaviour.status}</h1>` : behaviour.body));
        break;
      case 'slow':
        later(behaviour.ms, () => {
          if (!response.destroyed && !request.socket.destroyed) behave(request, response, behaviour.then || { kind: 'ok' });
        });
        break;
      case 'hang':
        break;
      case 'close':
        request.socket.destroy();
        break;
      case 'garbage':
        request.socket.write('THIS IS NOT HTTP\r\n\r\n');
        request.socket.destroy();
        break;
      case 'redirect':
        response.writeHead(behaviour.status || 302, { location: behaviour.location, 'cache-control': 'no-store' });
        response.end();
        break;
      case 'empty200':
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '0', 'cache-control': 'no-store' });
        response.end();
        break;
      case 'partial':
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '100000' });
        response.write('<!doctype html><title>partial</title><p>half a page');
        later(50, () => request.socket.destroy());
        break;
      default:
        page(response);
    }
  }

  function serve(request, response) {
    requests.push({ method: request.method, url: request.url, at: Date.now() });
    const target = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'HEAD') {
        behave(request, response, headBehaviour);
      } else if (target.pathname === '/report') {
        try {
          reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          // not JSON: ignored
        }
        response.end('ok');
      } else if (target.pathname === '/ping') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('pong');
      } else if (target.pathname === '/favicon.ico') {
        response.writeHead(204).end();
      } else if (Object.hasOwn(ASSETS, target.pathname)) {
        response.writeHead(200, { 'content-type': ASSETS[target.pathname].type, 'cache-control': 'no-store' });
        response.end(readFixture(ASSETS[target.pathname].file));
      } else if (target.pathname === '/iframe.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(IFRAME_PAGE);
      } else if (pathBehaviours.has(target.pathname)) {
        behave(request, response, pathBehaviours.get(target.pathname));
      } else {
        behave(request, response, getBehaviour);
      }
    });
  }

  async function start() {
    if (server) return;
    const next = tls ? https.createServer(tls, serve) : http.createServer(serve);
    next.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    next.on('secureConnection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    next.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => {
      next.once('error', reject);
      next.listen(boundPort, '127.0.0.1', resolve);
    });
    boundPort = next.address().port;
    server = next;
  }

  function stop() {
    const closing = server;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (!closing) return Promise.resolve();
    server = null;
    return new Promise((resolve) => {
      for (const socket of connections) socket.destroy();
      closing.close(() => resolve());
    });
  }

  await start();

  return {
    label,
    get port() { return boundPort; },
    get origin() { return `${scheme}://127.0.0.1:${boundPort}`; },
    get url() { return `${scheme}://127.0.0.1:${boundPort}${POS_PATH}`; },
    get smokeUrl() { return `${scheme}://127.0.0.1:${boundPort}${POS_PATH}?harness=smoke`; },
    requests,
    reports,
    isListening: () => server !== null,
    hits: (prefix, method) => requests.filter((entry) => entry.url.startsWith(prefix) && (!method || entry.method === method)).length,
    /** Sets what the page (every non-probe request) gets. */
    get: (behaviour) => { getBehaviour = behaviour; },
    /** Sets what the app's HEAD probe gets. */
    head: (behaviour) => { headBehaviour = behaviour; },
    /** Sets the answer for one path (null removes it). */
    path: (pathname, behaviour) => {
      if (behaviour === null) pathBehaviours.delete(pathname);
      else pathBehaviours.set(pathname, behaviour);
    },
    /** Back to a healthy server. */
    healthy: () => {
      getBehaviour = { kind: 'ok' };
      headBehaviour = { kind: 'status', status: 200 };
      pathBehaviours.clear();
    },
    start,
    stop,
  };
}

/**
 * A page of the FOREIGN origin that the POS page embeds in an iframe: it opens an about:blank popup and reports what bridge that popup
 * has, then tries the same on the top window. Reported to /report of its OWN server.
 */
const IFRAME_PAGE = `<!doctype html>
<meta charset="utf-8"><title>foreign iframe</title>
<script>
(function () {
  var out = { kind: 'iframe', origin: location.origin, ownElectron: typeof window.electron, ownDesktop: typeof window.desktop };
  try {
    var popup = window.open('about:blank');
    out.popup = popup === null ? 'null' : 'window';
    if (popup) {
      out.popupElectron = typeof popup.electron;
      out.popupDesktop = typeof popup.desktop;
      try { popup.close(); } catch (e) {}
    }
  } catch (error) {
    out.popupError = String(error);
  }
  try { out.parentElectron = typeof window.parent.electron; } catch (error) { out.parentElectron = 'blocked: ' + error.name; }
  fetch('/report', { method: 'POST', body: JSON.stringify(out) });
})();
</script>`;

module.exports = { createBreakServer, POS_PATH };
