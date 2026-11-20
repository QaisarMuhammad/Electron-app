/*
 * Automation of the fake POS page (tests/e2e/fake-pos.js serves it when the address carries ?harness=smoke).
 *
 * `window.__pos` is what tests/e2e/run-smoke.js drives through the Chrome DevTools protocol:
 *   __pos.call(name, args)   runs one desktop call with a realistic payload and records what it answered
 *   __pos.inspect()          what the preload exposed on this page (window.electron, window.desktop, the sandbox)
 *   __pos.helpers            navigation, popups and requests that the security checks must judge
 * Every call is recorded three ways: in __pos.results, as a line in #results (so a screenshot shows it) and as a POST to
 * /report (so the harness can read it from the server side). Plain browser JavaScript: it is served to the real app window.
 */
(function fakePos() {
  'use strict';

  const results = [];

  // ---- payloads, shaped like the ones the real web POS sends ----------------------------------------------------------------

  /** ESC/POS bytes of a small receipt that ends with the cash drawer kick the web embeds (ESC p 0 25 255) and a partial cut. */
  function receiptBytes() {
    const text = (value) => Array.from(new TextEncoder().encode(value));
    return new Uint8Array([
      0x1b, 0x40, // initialise
      0x1b, 0x61, 0x01, ...text('GADGETS POS\n'), // centred title
      0x1b, 0x61, 0x00, ...text('Apple iPhone 13 Pro 256GB   549.99\nScreen protector x2          9.98\n'),
      ...text('--------------------------------\nTOTAL                       569.95\n\n\n'),
      0x1b, 0x70, 0x00, 0x19, 0xff, // open the drawer
      0x1d, 0x56, 0x42, 0x00, // partial cut
    ]);
  }

  /** A legacy receipt envelope: the whole order, business and settings travel with it, plus 10 KB of free text nobody reads. */
  function receiptEnvelope() {
    return {
      receiptFileBinary: receiptBytes(),
      order: { id: 1001, notes: 'x'.repeat(10 * 1024), items: [{ name: 'Apple iPhone 13 "Pro" 256GB', price: 549.99 }] },
      business: { business_name: 'Gadgets Market', branch_name: 'High Street' },
      settings: { currency: 'GBP', note: 'y'.repeat(10 * 1024) },
      isDuplicate: false,
    };
  }

  const ZEBRA_LABEL = '^XA^CI28^FO30,20^A0N,30,30^FDApple iPhone 13 Pro^FS^FO30,60^BY2^BCN,60,Y,N,N^FD352099001761481^FS^XZ';

  /** A DYMO label as BarcodePanelTab sends it. The title has quotes in it: v1 lost labels like this one. */
  function dymoPayload() {
    return {
      size: '32x57',
      design: '1',
      prints: 1,
      currency: 'GBP',
      title: 'Apple iPhone 13 "Pro" 256GB',
      barcode: '352099001761481',
      barcodefinal: {
        printer: 'dymo',
        title: 'Apple iPhone 13 "Pro" 256GB',
        barcode: '352099001761481',
        storage: '256GB',
        network: 'Unlocked',
        ram: '6GB',
        misc_color: 'Sierra Blue',
        warranty: '12 months',
        Processor: 'A15 Bionic',
        conditionObject: { grade: 'A' },
        price: '549.99',
        salePrice: '',
        regular_price: '549.99',
        isSale: false,
      },
    };
  }

  /** A lab item label: its barcode and title sit on the OUTER envelope. */
  function labPayload() {
    return { size: '32x57', design: '1', type: 'lab', barcode: 'LAB-000042', title: 'Lab item "Battery" 3.8V', barcodefinal: { printer: 'dymo' } };
  }

  /** A repair label message with two order items: it prints one label per item. */
  function repairPayload() {
    return {
      size: '70x54',
      design: 'repair',
      barcodefinal: {
        printer: 'dymo',
        design: 'repair',
        barcode: 'R-2026-1001',
        orderDate: '19/11/2026',
        customer: { name: 'A. Customer', cell_no: '07700 900123' },
        business: { business_name: 'Gadgets Market', branch_name: 'High Street' },
        orderItems: [
          { product_name: 'iPhone 13 screen', custom_field_value: [{ value: 'Black' }, { value: '12345' }, { value: 'No water damage' }] },
          { product_name: 'iPhone 13 battery', custom_field_value: [{ value: 'Black' }, { value: '12345' }, { value: '' }] },
        ],
      },
    };
  }

  // ---- the calls ---------------------------------------------------------------------------------------------------------------

  /** name -> (electron, args) => result. Fire-and-forget calls answer { sent: true }: that is all the old API tells a page. */
  const CALLS = {
    // legacy, fire-and-forget (kept for the old web)
    sendReceiptData: (e, a) => (e.sendReceiptData(a.payload || receiptEnvelope()), { sent: true }),
    'sendReceiptData:openButton': (e) => (e.sendReceiptData({ openCashDrawer: true, order: false, business: {}, settings: {} }), { sent: true }),
    sendBarcodeData: (e, a) => (e.sendBarcodeData(a.payload || { barcodefinal: ZEBRA_LABEL, barcode: '352099001761481', title: 'Apple iPhone 13 Pro' }), { sent: true }),
    'sendBarcodeData:dymo': (e, a) => (e.sendBarcodeData(a.payload || dymoPayload()), { sent: true }),
    sendOpenDrawerCommand: (e, a) => (e.sendOpenDrawerCommand({ cashDrawerOpenPassword: a.password || '' }), { sent: true }),
    // new, acknowledged: each answers a Result
    printReceipt: (e, a) => e.printReceipt(a.payload || { receiptFileBinary: receiptBytes() }),
    'printReceipt:empty': (e) => e.printReceipt({ receiptFileBinary: new Uint8Array(0) }),
    'printReceipt:openButton': (e) => e.printReceipt({ openCashDrawer: true, order: false, business: {}, settings: {} }),
    printBarcode: (e, a) => e.printBarcode(a.payload || { barcodefinal: ZEBRA_LABEL }),
    'printBarcode:dymo': (e, a) => e.printBarcode(a.payload || dymoPayload()),
    'printBarcode:lab': (e, a) => e.printBarcode(a.payload || labPayload()),
    'printBarcode:repair': (e, a) => e.printBarcode(a.payload || repairPayload()),
    openCashDrawer: (e, a) => e.openCashDrawer({ password: a.password === undefined ? '' : a.password }),
    getAppInfo: (e) => e.getAppInfo(),
    getPrinters: (e) => e.getPrinters(),
  };

  // ---- recording ---------------------------------------------------------------------------------------------------------------

  function show(entry) {
    const list = document.getElementById('results');
    if (!list) return;
    const item = document.createElement('li');
    item.dataset.name = entry.name;
    item.dataset.ok = String(entry.ok);
    const title = document.createElement('strong');
    title.textContent = entry.name;
    const body = document.createElement('code');
    body.textContent = entry.ok ? JSON.stringify(entry.result === undefined ? null : entry.result) : String(entry.error);
    const time = document.createElement('small');
    time.textContent = `${entry.ms} ms`;
    item.append(title, body, time);
    list.prepend(item);
  }

  function send(entry) {
    try {
      fetch('/report', { method: 'POST', body: JSON.stringify({ kind: 'call', ...entry }), keepalive: true }).catch(() => {});
    } catch {
      // The server may be down on purpose: the DOM and __pos.results still have the entry.
    }
  }

  async function call(name, args = {}) {
    const started = performance.now();
    const entry = { name, args: Object.keys(args), at: Date.now() };
    try {
      if (!window.electron) throw new Error('window.electron is not available on this page');
      if (!Object.prototype.hasOwnProperty.call(CALLS, name)) throw new Error(`unknown call ${name}`);
      entry.result = await CALLS[name](window.electron, args);
      entry.ok = true;
    } catch (error) {
      entry.ok = false;
      entry.error = String((error && error.message) || error);
    }
    entry.ms = Math.round(performance.now() - started);
    results.push(entry);
    show(entry);
    send(entry);
    return entry;
  }

  // ---- what the security checks must judge --------------------------------------------------------------------------------------

  const helpers = {
    /** Navigates the main frame (a link click or an assignment: the guard sees both the same way). */
    navigate(url) {
      window.location.href = url;
      return 'navigating';
    },
    /** window.open: `opened` is false when the app denied it (the opener then gets null, as in a blocked popup). */
    openWindow(url, name) {
      const child = window.open(url, name);
      return { opened: child !== null, isNull: child === null };
    },
    /** The pdfMake and print() pattern: an empty popup that the page fills itself. */
    openBlank(html) {
      const child = window.open('about:blank');
      if (!child) return { opened: false };
      child.document.write(html);
      child.document.close();
      return { opened: true, title: child.document.title };
    },
    /** The other pdfMake pattern: a blob URL of this origin. */
    openBlob(html) {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const child = window.open(url);
      return { opened: child !== null, url };
    },
    /** A request to this origin; it fails when the server is down, which is what the connection monitor listens for. */
    ping(n) {
      return fetch(`/ping?n=${n}`, { cache: 'no-store' }).then((response) => ({ status: response.status }), (error) => ({ error: String(error) }));
    },
  };

  // ---- what the preload gave this page -----------------------------------------------------------------------------------------

  function inspect() {
    const e = window.electron;
    return {
      electron: typeof e,
      desktop: typeof window.desktop,
      functions: e ? Object.keys(e).sort() : [],
      types: e ? Object.fromEntries(Object.keys(e).sort().map((key) => [key, typeof e[key]])) : {},
      sandbox: {
        require: typeof window.require,
        process: typeof window.process,
        ipcRenderer: typeof window.ipcRenderer,
        nodeBuffer: typeof window.Buffer,
      },
      title: document.title,
      url: location.href,
      marker,
    };
  }

  /** A value that only survives while the page is not reloaded. */
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** What the app's print jobs must contain, as hex, so the harness can compare bytes without re-implementing the payloads. */
  const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const expected = { receiptHex: toHex(receiptBytes()), zebraHex: toHex(new TextEncoder().encode(ZEBRA_LABEL)) };

  window.__pos = { version: 1, marker, call, inspect, helpers, results, expected, names: Object.keys(CALLS) };

  // ---- the page itself ---------------------------------------------------------------------------------------------------------

  function buildButtons() {
    const holder = document.getElementById('buttons');
    if (!holder) return;
    for (const name of Object.keys(CALLS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => call(name));
      holder.append(button);
    }
  }

  function describeBridge() {
    const env = document.getElementById('env');
    if (!env) return;
    env.textContent = window.electron
      ? `desktop bridge ready: ${Object.keys(window.electron).length} functions`
      : 'no desktop bridge on this page';
  }

  buildButtons();
  describeBridge();
})();
