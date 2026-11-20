'use strict';

/**
 * Runs a sandboxed preload (src/preload/app.js or local.js) the way Electron does: the file is compiled as the body of
 * a function whose parameters are the globals a sandboxed preload sees, and `require` can load `electron` only.
 * Everything the preload touches is a fake: electron (contextBridge, ipcRenderer), window, document (a small DOM with
 * closed Shadow DOM support), location, navigator and timers. Not a test file (SPEC 2), so `node --test` skips it.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createFakeTimers, createFakeSecurity, createOriginAllowedHandler } = require('../helpers/fake-window');

const PRELOAD_DIR = path.join(__dirname, '..', '..', 'src', 'preload');

// ---------------------------------------------------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------------------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.className = '';
    this.type = '';
    this.disabled = false;
    this.ownText = '';
    this.shadowMode = null;
    this.shadow = null;
    /** A closed shadow root is not reachable through `shadowRoot`, exactly like in a browser. */
    this.shadowRoot = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  attachShadow({ mode }) {
    this.shadowMode = mode;
    this.shadow = new FakeElement('#shadow-root');
    if (mode === 'open') this.shadowRoot = this.shadow;
    return this.shadow;
  }

  addEventListener(type, listener) {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  /** A mouse click: ignored on a disabled button, like in a browser. */
  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.click || []) listener({ type: 'click', target: this });
  }

  /** Depth-first search of this element and everything below it (the shadow root included). */
  findAll(predicate) {
    const found = [];
    const visit = (node) => {
      if (predicate(node)) found.push(node);
      if (node.shadow) visit(node.shadow);
      node.children.forEach(visit);
    };
    visit(this);
    return found;
  }

  find(predicate) {
    return this.findAll(predicate)[0] || null;
  }
}

/**
 * @param {{ ready?: boolean }} [options]  `ready: false` starts with no <html> element, as at document start.
 */
function createFakeDocument({ ready = true } = {}) {
  const listeners = {};
  const doc = {
    documentElement: ready ? new FakeElement('html') : null,
    created: [],
    createElement(tag) {
      const element = new FakeElement(tag);
      doc.created.push(element);
      return element;
    },
    addEventListener(type, listener, options) {
      (listeners[type] = listeners[type] || []).push({ listener, once: Boolean(options && options.once) });
    },
    /** The parser has built the document: <html> exists and DOMContentLoaded fires. */
    makeReady() {
      if (!doc.documentElement) doc.documentElement = new FakeElement('html');
      for (const entry of listeners.DOMContentLoaded || []) entry.listener({ type: 'DOMContentLoaded' });
      listeners.DOMContentLoaded = [];
    },
    listenerCount: (type) => (listeners[type] || []).length,
  };
  return doc;
}

/** The banner host element and its closed shadow root, once the preload has created them. */
function findBanner(document) {
  const host = document.documentElement && document.documentElement.children.find((child) => child.localName === 'gadgetspos-banner');
  if (!host) return null;
  const root = host.shadow;
  const pill = root.find((node) => node.className === 'pill');
  const text = root.find((node) => node.className === 'text');
  const button = root.find((node) => node.localName === 'button');
  const style = root.find((node) => node.localName === 'style');
  return {
    host,
    root,
    pill,
    text,
    button,
    css: style.textContent,
    state: pill.getAttribute('data-state'),
    message: text.textContent,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake electron
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A fake ipcRenderer. `invokeHandler(channel, args)` answers invoke(); `syncHandler(channel, args)` answers sendSync().
 * `emitFromMain(channel, payload)` delivers a push message to the subscribed listeners (with a fake IPC event first).
 */
function createFakeIpcRenderer({ invokeHandler, syncHandler } = {}) {
  const listeners = new Map();
  const ipc = {
    sent: [],
    invoked: [],
    syncs: [],
    listeners,
    send(channel, ...args) {
      ipc.sent.push({ channel, args });
    },
    invoke(channel, ...args) {
      ipc.invoked.push({ channel, args });
      try {
        return Promise.resolve(invokeHandler ? invokeHandler(channel, args) : undefined);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    sendSync(channel, ...args) {
      ipc.syncs.push({ channel, args });
      return syncHandler ? syncHandler(channel, args) : undefined;
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
      return ipc;
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return ipc;
    },
    listenerCount: (channel) => (listeners.get(channel) || []).length,
    /** Delivers a main -> page message the way Electron does: the listener gets (event, payload). */
    emitFromMain(channel, payload) {
      for (const listener of [...(listeners.get(channel) || [])]) listener({ sender: { id: 1 } }, payload);
    },
  };
  return ipc;
}

// ---------------------------------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------------------------------

const SANDBOX_PARAMS = ['require', 'process', 'window', 'document', 'location', 'navigator', 'setTimeout', 'clearTimeout', 'console'];

/**
 * Builds a handler for `sendSync('app:origin-allowed')` that behaves like the main process (SPEC 6.1): the answer comes
 * from the REAL origin of the sender frame, not from anything the page passed.
 * @param {{ isAllowedOrigin: Function }} security
 * @param {string} frameOrigin  The origin Chromium reports for the page's frame.
 */
function originSyncHandler(security, frameOrigin) {
  const handler = createOriginAllowedHandler(security);
  return (channel) => {
    if (channel !== 'app:origin-allowed') return undefined;
    const event = { senderFrame: { origin: frameOrigin }, returnValue: undefined };
    handler(event);
    return event.returnValue;
  };
}

/**
 * Runs a preload file against fakes.
 * @param {'app.js'|'local.js'} file
 * @param {object} options
 * @param {string} options.url                 The page address (`https://...`, `about:blank`, `file:///...`).
 * @param {string} [options.frameOrigin]       What the main process would see as the sender's origin (defaults to `new URL(url).origin`).
 * @param {{ isAllowedOrigin: Function }} [options.security]  Stand-in used to answer `app:origin-allowed`.
 * @param {Function} [options.syncHandler]     Overrides the answer of sendSync entirely (a missing handler, an exception ...).
 * @param {Function} [options.invokeHandler]
 * @param {boolean} [options.inIframe=false]   `window.top !== window`.
 * @param {boolean} [options.topThrows=false]  Reading `window.top` throws.
 * @param {boolean} [options.online=true]      `navigator.onLine`.
 * @param {boolean} [options.documentReady=true]
 * @param {string[]} [options.argv]            `process.argv` of the renderer.
 * @param {string} [options.platform='win32']
 */
function runPreload(file, options = {}) {
  const {
    url,
    frameOrigin,
    security = createFakeSecurity(),
    syncHandler,
    invokeHandler,
    inIframe = false,
    topThrows = false,
    online = true,
    documentReady = true,
    argv = ['electron', '--gadgetspos-version=2.0.0-test'],
    platform = 'win32',
  } = options;

  const source = fs.readFileSync(path.join(PRELOAD_DIR, file), 'utf8');
  const parsed = new URL(url);
  const origin = frameOrigin !== undefined ? frameOrigin : parsed.origin;

  const exposed = {};
  const required = [];
  const timers = createFakeTimers();
  const document = createFakeDocument({ ready: documentReady });
  const ipc = createFakeIpcRenderer({ invokeHandler, syncHandler: syncHandler || originSyncHandler(security, origin) });
  const contextBridge = {
    exposeInMainWorld(name, api) {
      if (name in exposed) throw new Error(`already exposed: ${name}`);
      exposed[name] = api;
    },
  };

  const windowListeners = {};
  const topWindow = {};
  const window = {
    addEventListener(type, listener) {
      (windowListeners[type] = windowListeners[type] || []).push(listener);
    },
    /** Fires a window event such as 'online' or 'offline'. `extra` adds fields to the event (`{ isTrusted: false }` is what a page-made event has). */
    dispatch(type, extra = {}) {
      for (const listener of windowListeners[type] || []) listener({ type, ...extra });
    },
    listenerCount: (type) => (type ? (windowListeners[type] || []).length : Object.values(windowListeners).flat().length),
  };
  if (topThrows) {
    Object.defineProperty(window, 'top', {
      get() {
        throw new Error('window.top is not readable');
      },
    });
  } else {
    window.top = inIframe ? topWindow : window;
  }

  const consoleErrors = [];
  const fakeConsole = { error: (...args) => consoleErrors.push(args), log() {}, warn() {} };
  const location = { protocol: parsed.protocol, href: parsed.href, origin: parsed.origin };
  const navigator = { onLine: online };
  const fakeRequire = (name) => {
    required.push(name);
    if (name === 'electron') return { contextBridge, ipcRenderer: ipc };
    throw new Error(`A sandboxed preload can only require electron, not "${name}"`);
  };

  const run = vm.compileFunction(source, SANDBOX_PARAMS, { filename: file });
  run(fakeRequire, { platform, argv }, window, document, location, navigator, timers.setTimeout, timers.clearTimeout, fakeConsole);

  return { exposed, ipc, window, document, location, navigator, timers, required, consoleErrors, security };
}

/** Collects every value reachable from `root` (objects and functions), for "nothing leaks ipcRenderer" checks. */
function reachableValues(root) {
  const seen = new Set();
  const visit = (value) => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) visit(value[key]);
  };
  visit(root);
  return seen;
}

module.exports = {
  runPreload,
  findBanner,
  createFakeDocument,
  createFakeIpcRenderer,
  originSyncHandler,
  reachableValues,
  PRELOAD_DIR,
};
