'use strict';

/**
 * GadgetsPOS preload of the MAIN window and of every window it opens with window.open (SPEC 6.1, 6.3, 11.3).
 *
 * This is ONE self-contained file: a sandboxed preload can load only `electron` (SPEC 2), so it holds no origin list and
 * no path logic. It never exposes `ipcRenderer` itself, only fixed functions that each send one fixed channel.
 *
 *  - On a page of the app's own (`file:` pages under src/renderer: loading.html and offline.html) it exposes ONLY
 *    `window.desktop = { platform, version, connection, window }`, which the offline screen needs for "Retry now", the
 *    countdown and "Printer settings". The `settings` and `password` APIs are never exposed here (SPEC 6.3).
 *  - On any other page it asks the main process, synchronously and at document start, whether the page's origin is
 *    allowed: `ipcRenderer.sendSync('app:origin-allowed')`. Main answers from the REAL sender frame (never from data the
 *    page could supply). Only on `true` is `window.electron` exposed (SPEC 6.1); on any other answer, a missing answer
 *    or an exception nothing is exposed.
 *  - On an allowed page it also shows the mid-session offline banner (SPEC 11.3).
 *
 * Channels used: send `send-receipt-data`, `send-barcode-data`, `open-drawer-legacy`; invoke `print-receipt`,
 * `print-barcode`, `open-drawer`, `app-info`, `list-printers`, `desktop:connection:*`, `desktop:window:close`;
 * receive `connectivity:status` (banner) and `desktop:connection:status` (offline screen).
 * When the browser reports that the network is back (the window's `online` event) it also sends one notice, so a reconnection that
 * is waiting for its next retry probes at once: `connectivity:networkOnline` from the POS page and
 * `desktop:connection:networkOnline` from the offline screen. The notice carries no data.
 * `connection.openSettings(tab)` takes an optional tab id (`'printers'`, `'connection'` ...) that the offline screen's two
 * buttons use; anything that is not a string is sent as `undefined`.
 */
(function gadgetsPosAppPreload() {
  const { contextBridge, ipcRenderer } = require('electron');

  // ==== BEGIN SHARED: version, subscribe, connection and window controls (identical in app.js and local.js) ====
  const VERSION_ARG_PREFIX = '--gadgetspos-version=';

  /** The app version, which the main process passes to the renderer as a command-line argument. */
  function readAppVersion() {
    const args = Array.isArray(process.argv) ? process.argv : [];
    const entry = args.find((arg) => typeof arg === 'string' && arg.startsWith(VERSION_ARG_PREFIX));
    return entry ? entry.slice(VERSION_ARG_PREFIX.length) : '';
  }

  /**
   * Subscribes to a message the main process pushes. The page receives the payload only (never the IPC event, which
   * carries the sender) and a function that removes the subscription again.
   */
  function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error(err);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }

  const connection = Object.freeze({
    getStatus: () => ipcRenderer.invoke('desktop:connection:getStatus'),
    retryNow: () => ipcRenderer.invoke('desktop:connection:retryNow'),
    openSettings: (tab) => ipcRenderer.invoke('desktop:connection:openSettings', typeof tab === 'string' ? tab : undefined),
    onStatus: (callback) => subscribe('desktop:connection:status', callback),
  });

  const windowControls = Object.freeze({
    close: () => ipcRenderer.invoke('desktop:window:close'),
  });
  // ==== END SHARED ====

  /** True in the top frame. A preload does not run in sub-frames, so this only guards a future configuration change. */
  function isTopFrame() {
    try {
      return window === window.top;
    } catch (err) {
      return false;
    }
  }

  /**
   * Asks the main process whether this page's origin may use window.electron. The question carries no data from the
   * page: main reads the origin of the sender frame itself. Anything but `true` (no answer, an error) means no.
   */
  function isOriginAllowed() {
    try {
      return ipcRenderer.sendSync('app:origin-allowed') === true;
    } catch (err) {
      return false;
    }
  }

  const FAILED_REQUEST = Object.freeze({
    ok: false,
    code: 'UNKNOWN',
    message: 'GadgetsPOS could not complete the request. Please try again.',
  });

  /** Invokes a channel and always answers a Result: a transport error becomes `{ ok: false }` instead of a rejection. */
  async function invokeForResult(channel, payload) {
    try {
      return await ipcRenderer.invoke(channel, payload);
    } catch (err) {
      return { ...FAILED_REQUEST };
    }
  }

  /** window.electron, exactly as SPEC 6.1 lists it. Add functions here; never remove one. */
  function buildElectronApi() {
    return {
      // Legacy, fire-and-forget: kept for the old web app.
      sendReceiptData: (payload) => {
        ipcRenderer.send('send-receipt-data', payload);
      },
      sendBarcodeData: (payload) => {
        ipcRenderer.send('send-barcode-data', payload);
      },
      sendOpenDrawerCommand: (payload) => {
        ipcRenderer.send('open-drawer-legacy', payload);
      },
      // Acknowledged: each returns Promise<Result>.
      printReceipt: (payload) => invokeForResult('print-receipt', payload),
      printBarcode: (payload) => invokeForResult('print-barcode', payload),
      openCashDrawer: (payload) => invokeForResult('open-drawer', payload),
      getAppInfo: () => ipcRenderer.invoke('app-info'),
      getPrinters: () => ipcRenderer.invoke('list-printers'),
    };
  }

  /**
   * True for an event the browser itself raised. `online` tells the main process that the network is back, so a reconnection that
   * is waiting for its next retry looks at once instead of after up to 36 s (the notice carries no data, and the main process acts
   * on it only while an outage is being tracked). A page can dispatch a fake `online` event; `isTrusted` is false for those.
   */
  const isBrowserEvent = (event) => !event || event.isTrusted !== false;

  // -- offline banner (SPEC 11.3) --------------------------------------------------------------------------------------

  const OFFLINE_TEXT = "No internet connection. We'll keep trying \u2014 your work on this page is not lost.";
  const ONLINE_TEXT = 'Back online';
  const ONLINE_VISIBLE_MS = 3000;
  /** The text is set a moment after the banner appears, so screen readers announce it as a change. */
  const ANNOUNCE_DELAY_MS = 30;

  /**
   * Inline styles of the banner, which lives in a closed Shadow DOM so the page can neither style nor read it. Top
   * centre, `position: fixed` (no layout shift), at most 48 px high, and transparent to the mouse except its button.
   * Only opacity and transform are animated, and not at all under prefers-reduced-motion. It is hidden when printing.
   */
  const BANNER_CSS = [
    ':host { all: initial; }',
    '.wrap { position: fixed; top: 8px; left: 0; right: 0; z-index: 2147483647; display: flex; justify-content: center; padding: 0 8px; pointer-events: none; }',
    '.pill { box-sizing: border-box; display: flex; align-items: center; gap: 10px; min-height: 40px; max-height: 48px; max-width: 640px; overflow: hidden;' +
      ' padding: 2px 2px 2px 14px; border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 12px; background: #141850; color: #ffffff;' +
      ' font: 500 13px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 1px 2px rgba(20, 24, 80, 0.2), 0 8px 24px rgba(20, 24, 80, 0.3);' +
      ' opacity: 0; transform: translateY(-16px); transition: opacity 160ms cubic-bezier(0.2, 0.7, 0.2, 1), transform 160ms cubic-bezier(0.2, 0.7, 0.2, 1); }',
    '.pill[data-state="offline"], .pill[data-state="online"] { opacity: 1; transform: none; }',
    '.pill[data-state="online"] { padding-right: 14px; background: #146c32; }',
    '.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #ffb020; }',
    '.pill[data-state="online"] .dot { background: #9be7b4; }',
    '.text { flex: 1 1 auto; min-width: 0; }',
    'button { flex: none; width: 40px; height: 40px; margin: 0; padding: 0; border: 0; border-radius: 8px; background: transparent; color: inherit;' +
      ' font: 400 22px/1 system-ui, sans-serif; cursor: pointer; pointer-events: auto; }',
    'button:hover { background: rgba(255, 255, 255, 0.14); }',
    'button:focus-visible { outline: 2px solid #ffffff; outline-offset: -2px; }',
    'button:disabled { display: none; }',
    '@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }',
    // Receipts and invoices are printed from the page: the banner must never appear on paper.
    '@media print { .wrap { display: none; } }',
  ].join('\n');

  /**
   * Shows "No internet connection ..." while the page is offline and "Back online" for 3 s afterwards.
   * "Offline" means the browser says so (window events) OR the main process says so (`connectivity:status`): the browser
   * keeps saying "online" when the router is up but the provider is down, which is the usual shop outage.
   * The banner is created only when it is first needed, so a page that never goes offline gets no extra DOM.
   */
  function startConnectionBanner() {
    let osOnline = navigator.onLine !== false;
    let probeOnline = null; // what the main process reported last; null until it reports
    let phase = 'online'; // 'online' (nothing to show) | 'offline' | 'recovered' ("Back online" is showing)
    let dismissed = false;
    let parts = null;
    let textTimer = null;
    let hideTimer = null;

    const isOnline = () => osOnline && probeOnline !== false;

    /** The value of the banner's data-state attribute for the current phase. */
    function displayedState() {
      if (phase === 'offline') return dismissed ? 'hidden' : 'offline';
      return phase === 'recovered' ? 'online' : 'hidden';
    }

    function onDocumentReady(fn) {
      if (document.documentElement) fn();
      else document.addEventListener('DOMContentLoaded', fn, { once: true });
    }

    function mount() {
      if (parts) return;
      const host = document.createElement('gadgetspos-banner');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = BANNER_CSS;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.setAttribute('data-state', 'hidden');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'text';
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      text.setAttribute('aria-atomic', 'true');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', 'Dismiss');
      button.textContent = '\u00d7';
      button.disabled = true;
      button.addEventListener('click', () => {
        dismissed = true;
        render();
      });
      pill.appendChild(dot);
      pill.appendChild(text);
      pill.appendChild(button);
      wrap.appendChild(pill);
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);
      parts = { pill, text, button };
    }

    function render() {
      if (!parts && displayedState() === 'hidden') return; // nothing to show and nothing created yet
      onDocumentReady(() => {
        mount();
        const target = displayedState();
        if (parts.pill.getAttribute('data-state') === target) return;
        parts.pill.setAttribute('data-state', target);
        parts.button.disabled = target !== 'offline';
        clearTimeout(textTimer);
        if (target === 'hidden') return;
        parts.text.textContent = '';
        textTimer = setTimeout(() => {
          parts.text.textContent = target === 'offline' ? OFFLINE_TEXT : ONLINE_TEXT;
        }, ANNOUNCE_DELAY_MS);
      });
    }

    function update() {
      if (!isOnline() && phase !== 'offline') {
        clearTimeout(hideTimer);
        phase = 'offline';
        dismissed = false;
        render();
      } else if (isOnline() && phase === 'offline') {
        phase = 'recovered';
        render();
        hideTimer = setTimeout(() => {
          phase = 'online';
          render();
        }, ONLINE_VISIBLE_MS);
      }
    }

    window.addEventListener('offline', () => {
      osOnline = false;
      update();
    });
    window.addEventListener('online', (event) => {
      osOnline = true;
      update();
      if (isBrowserEvent(event)) ipcRenderer.send('connectivity:networkOnline');
    });
    ipcRenderer.on('connectivity:status', (_event, status) => {
      if (!status || typeof status.online !== 'boolean') return;
      probeOnline = status.online;
      update();
    });
    update();
  }

  // -- entry -----------------------------------------------------------------------------------------------------------

  if (!isTopFrame()) return;

  if (location.protocol === 'file:') {
    // The app's own pages (loading, offline): the connection part of window.desktop, and nothing else.
    contextBridge.exposeInMainWorld('desktop', {
      platform: process.platform,
      version: readAppVersion(),
      connection,
      window: windowControls,
    });
    // The offline screen reconnects as soon as the network is back, not at its next retry.
    window.addEventListener('online', (event) => {
      if (isBrowserEvent(event)) ipcRenderer.send('desktop:connection:networkOnline');
    });
    return;
  }

  if (!isOriginAllowed()) return;
  contextBridge.exposeInMainWorld('electron', buildElectronApi());
  startConnectionBanner();
})();
