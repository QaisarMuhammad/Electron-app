/*
 * The browser half of the benchmark (tests/perf/benchmark.js). It runs inside the REAL app window, on the POS-like page and on
 * the stress page, so `window.electron` is whatever the app's preload exposed: v1's two fire-and-forget functions, or v2's
 * legacy functions plus the acknowledged ones.
 *
 *   __bench.now()               a fractional millisecond epoch time (the same clock family as the main process's perf_hooks)
 *   __bench.post(kind, data)    a report to the benchmark server (it timestamps it on arrival)
 *   __bench.onCommand(n, fn)    registers a command the harness can send through the long-poll channel
 *   __bench.startCommands()     starts asking the server for commands (the light page does NOT, so the idle runs stay idle)
 *
 * Built-in commands: `info` (what the preload exposed, visibility) and `print` (a burst or a sequence of receipts or labels).
 * Plain browser JavaScript, no dependencies, no timers while it waits.
 */
(function benchClient() {
  'use strict';

  const params = new URLSearchParams(location.search);
  const RUN = params.get('run') || 'none';
  const now = () => performance.timeOrigin + performance.now();
  const handlers = Object.create(null);

  function post(kind, data) {
    return fetch(`/__bench/report?run=${encodeURIComponent(RUN)}&kind=${encodeURIComponent(kind)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data === undefined ? {} : data),
      keepalive: true,
    }).catch(() => {});
  }

  // ---- payloads, shaped like the ones the real web POS sends -------------------------------------------------------------

  const encoder = new TextEncoder();

  /** About 1.4 KB of ESC/POS: initialise, centred title, 24 item lines, totals, feed, drawer kick, partial cut. */
  function receiptBytes() {
    const parts = [new Uint8Array([0x1b, 0x40, 0x1b, 0x61, 0x01]), encoder.encode('GADGETS POS\nHigh Street, London\n\n'), new Uint8Array([0x1b, 0x61, 0x00])];
    for (let i = 1; i <= 24; i += 1) parts.push(encoder.encode(`${String(i).padStart(2, '0')} Apple iPhone 13 Pro 256GB   ${(500 + i).toFixed(2).padStart(8)}\n`));
    parts.push(encoder.encode('--------------------------------\nTOTAL                       12924.00\n\n\n'));
    parts.push(new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xff, 0x1d, 0x56, 0x42, 0x00]));
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  }

  /** What the OLD web sends with a receipt: the whole order, business and settings travel along (about 6 KB of extras). */
  function legacyReceipt() {
    const items = Array.from({ length: 24 }, (_, i) => ({ id: i, name: 'Apple iPhone 13 "Pro" 256GB', price: 500 + i, qty: 1, notes: 'x'.repeat(80) }));
    return {
      receiptFileBinary: receiptBytes(),
      order: { id: 1001, items, notes: 'y'.repeat(2048) },
      business: { business_name: 'Gadgets Market', branch_name: 'High Street', address: 'z'.repeat(200) },
      settings: { currency: 'GBP', note: 'w'.repeat(1024) },
      isDuplicate: false,
    };
  }

  const ZPL = '^XA^CI28^PW464^LL320^FO30,20^A0N,30,30^FDApple iPhone 13 Pro 256GB^FS^FO30,70^BY2^BCN,80,Y,N,N^FD352099001761481^FS^FO30,190^A0N,40,40^FDGBP 549.99^FS^XZ';
  const labelEnvelope = () => ({ barcodefinal: ZPL, barcode: '352099001761481', title: 'Apple iPhone 13 Pro 256GB' });

  /**
   * Sends `count` receipts or labels. `api` 'legacy' is the fire-and-forget pair every desktop has (sendReceiptData, sendBarcodeData);
   * `api` 'ack' is the v2 acknowledged pair (printReceipt, printBarcode, each answers a Result). `mode` 'burst' sends them all
   * back to back (what an old web does, and what a loop without await does); 'sequential' waits for each answer first (a v2 web).
   */
  async function runPrint({ api, kind, count, mode }) {
    const electron = window.electron;
    if (!electron) return { error: 'window.electron is missing' };
    const payloads = Array.from({ length: count }, () => {
      if (api === 'ack') return kind === 'receipt' ? { receiptFileBinary: receiptBytes() } : labelEnvelope();
      return kind === 'receipt' ? legacyReceipt() : labelEnvelope();
    });
    const sendOne = (payload) => {
      if (api === 'legacy') {
        if (kind === 'receipt') electron.sendReceiptData(payload);
        else electron.sendBarcodeData(payload);
        return null;
      }
      return kind === 'receipt' ? electron.printReceipt(payload) : electron.printBarcode(payload);
    };
    const sentAt = new Array(count);
    const ackAt = new Array(count);
    const results = new Array(count);
    const startedAt = now();
    if (mode === 'sequential') {
      for (let i = 0; i < count; i += 1) {
        sentAt[i] = now();
        const result = await sendOne(payloads[i]);
        ackAt[i] = now();
        results[i] = result ? { ok: result.ok === true, code: result.code } : null;
      }
    } else {
      const pending = [];
      for (let i = 0; i < count; i += 1) {
        sentAt[i] = now();
        const answer = sendOne(payloads[i]);
        if (answer) {
          pending.push(answer.then((result) => {
            ackAt[i] = now();
            results[i] = { ok: result.ok === true, code: result.code };
          }));
        }
      }
      await Promise.all(pending);
    }
    return { api, kind, count, mode, startedAt, finishedAt: now(), sentAt, ackAt, results };
  }

  handlers.info = async () => ({
    electron: typeof window.electron,
    functions: window.electron ? Object.keys(window.electron).sort() : [],
    desktop: typeof window.desktop,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    dpr: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    userAgent: navigator.userAgent,
  });
  handlers.print = runPrint;

  // ---- the command channel (a long poll: no timers, nothing runs while it waits) ------------------------------------------

  async function commandLoop() {
    for (;;) {
      let command;
      try {
        const response = await fetch(`/__bench/next?run=${encodeURIComponent(RUN)}`, { cache: 'no-store' });
        command = await response.json();
      } catch {
        return; // the server or the app is going away
      }
      if (command.cmd === 'stop') return;
      let out;
      try {
        if (!handlers[command.cmd]) throw new Error(`unknown command ${command.cmd}`);
        out = await handlers[command.cmd](command.args || {});
      } catch (error) {
        out = { error: String((error && error.message) || error) };
      }
      await post(`result-${command.id}`, out);
    }
  }

  window.__bench = {
    run: RUN,
    now,
    post,
    onCommand(name, fn) {
      handlers[name] = fn;
    },
    startCommands() {
      void commandLoop();
    },
  };

  // The light page is "loaded" at its load event; the harness timestamps the report when it arrives.
  window.addEventListener('load', () => {
    void post('loaded', {
      loadedAt: now(),
      sinceNavigationMs: Math.round(performance.now()),
      visibility: document.visibilityState,
      electron: typeof window.electron,
      desktop: typeof window.desktop,
    });
    if (params.get('mode') === 'cmd') window.__bench.startCommands();
  });
})();
