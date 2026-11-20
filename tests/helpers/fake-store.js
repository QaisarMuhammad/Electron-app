'use strict';

/**
 * Test kit for src/main/config.js: a fake of the `electron-store` class that behaves like the real one
 * (conf 13.1.0, read from node_modules/conf/dist/source/index.js), backed by a REAL file in a temp folder.
 *
 * What it reproduces on purpose, because config.js is written around each of these:
 * - the constructor builds `Object.assign({}, options.defaults, fileContents)` and WRITES it back when it differs,
 *   so passing `defaults` (a bug, SPEC 5.2) is visible in the file;
 * - a corrupt or empty file makes the constructor throw a SyntaxError unless `clearInvalidConfig` is true;
 * - `set(key, undefined)` throws, `set(object)` writes several dot paths in ONE write, `store` (getter) re-reads the
 *   file on every access and `store` (setter) replaces the whole file;
 * - `onDidAnyChange` calls back synchronously with (new, old) and only when the content really changed;
 * - every write is a temp file + rename with the requested file mode.
 *
 * Plus what the real class cannot do: counters (`stats`), failure injection (`failWrite`, `failReads`), and helpers
 * to prepare and inspect the file. Not named *.test.js: node --test must not run it.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const INTERNAL_KEY = '__internal__';

// dot-prop semantics for plain dotted keys (all this app uses)

function getProperty(object, key, defaultValue) {
  let current = object;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return defaultValue;
    current = current[part];
  }
  return current === undefined ? defaultValue : current;
}

function setProperty(object, key, value) {
  const parts = key.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === null || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function deleteProperty(object, key) {
  const parts = key.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(part in current)) return;
    current = current[part];
  }
  if (current !== null && typeof current === 'object') delete current[parts[parts.length - 1]];
}

function checkValueType(key, value) {
  const type = typeof value;
  if (type === 'undefined' || type === 'symbol' || type === 'function') {
    throw new TypeError(`Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`);
  }
}

/**
 * What v1.6.1 wrote (SPEC 16): the printer, its port, the plain-text password, the label printer, and
 * the junk keys nothing used. Windows-style names on purpose.
 */
const V1_FIXTURE = Object.freeze({
  printerName: 'EPSON TM-T20II Receipt',
  printerPort: '\\\\localhost\\EpsonTM',
  password: '4321',
  labelPrinterName: 'Zebra ZD420',
  labelPrinterPort: 'USB001',
  a4PrinterName: 'HP LaserJet',
});

/** @param {object} [overrides] keys to add or replace; a value of `undefined` removes the key @returns {object} a fresh v1 file content */
function makeV1Fixture(overrides = {}) {
  const content = { ...V1_FIXTURE, ...overrides };
  for (const key of Object.keys(content)) {
    if (content[key] === undefined) delete content[key];
  }
  return content;
}

/**
 * A logger that records instead of printing; `text()` is everything logged, for "never logs the password" checks.
 * @returns {{info: Function, warn: Function, error: Function, entries: Array<{level: string, args: any[]}>, text: () => string}}
 */
function createRecordingLog() {
  const entries = [];
  const record = (level) => (...args) => {
    entries.push({ level, args });
  };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    entries,
    text: () => entries.map((entry) => entry.args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')).join('\n'),
  };
}

/**
 * Build a fake `Store` class bound to a folder (a fresh temp folder unless `dir` is given).
 *
 * @param {{dir?: string}} [options]
 * @returns {{
 *   Store: Function, dir: string, file: string,
 *   stats: {constructed: object[], reads: number, writes: number},
 *   writeRaw: (content: string|object) => void, readRaw: () => object|null, readText: () => string|null,
 *   exists: (name: string) => boolean, list: () => string[], mode: (name?: string) => number|null,
 *   failWrite: (n?: number, error?: Error) => void, failReads: (error: Error|null, options?: {skip?: number}) => void,
 *   cleanup: () => void
 * }}
 */
function createFakeStoreEnv({ dir } = {}) {
  const directory = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-config-'));
  const stats = { constructed: [], reads: 0, writes: 0 };
  let pendingFailure = null; // { remaining, error }
  let readFailure = null;

  class FakeStore {
    #options;
    #seq = 0;

    constructor(partialOptions = {}) {
      stats.constructed.push({ ...partialOptions });
      const options = { configName: 'config', fileExtension: 'json', clearInvalidConfig: false, configFileMode: 0o666, ...partialOptions };
      this.#options = options;
      this.events = new EventTarget();
      this.path = path.resolve(options.cwd || directory, `${options.configName}.${options.fileExtension}`);
      const fileStore = this.store;
      const store = Object.assign(Object.create(null), options.defaults, fileStore);
      try {
        assert.deepEqual(fileStore, store);
      } catch {
        this.store = store;
      }
    }

    get(key, defaultValue) {
      return getProperty(this.store, key, defaultValue);
    }

    set(key, value) {
      if (typeof key !== 'string' && typeof key !== 'object') {
        throw new TypeError(`Expected \`key\` to be of type \`string\` or \`object\`, got ${typeof key}`);
      }
      if (typeof key !== 'object' && value === undefined) throw new TypeError('Use `delete()` to clear values');
      const first = typeof key === 'object' ? Object.keys(key)[0] : key;
      if (first === INTERNAL_KEY || (typeof first === 'string' && first.startsWith(`${INTERNAL_KEY}.`))) {
        throw new TypeError(`Please don't use the ${INTERNAL_KEY} key, as it's used to manage this module internal operations.`);
      }
      const { store } = this;
      const put = (name, content) => {
        checkValueType(name, content);
        setProperty(store, name, content);
      };
      if (typeof key === 'object') {
        for (const [name, content] of Object.entries(key)) put(name, content);
      } else {
        put(key, value);
      }
      this.store = store;
    }

    has(key) {
      return getProperty(this.store, key, undefined) !== undefined;
    }

    delete(key) {
      const { store } = this;
      deleteProperty(store, key);
      this.store = store;
    }

    clear() {
      this.store = Object.create(null);
    }

    onDidAnyChange(callback) {
      if (typeof callback !== 'function') throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
      let current = this.store;
      const onChange = () => {
        const old = current;
        const next = this.store;
        if (isDeepStrictEqual(next, old)) return;
        current = next;
        callback.call(this, next, old);
      };
      this.events.addEventListener('change', onChange);
      return () => this.events.removeEventListener('change', onChange);
    }

    get store() {
      stats.reads += 1;
      if (readFailure) {
        if (readFailure.skip > 0) readFailure.skip -= 1;
        else throw readFailure.error;
      }
      try {
        const data = fs.readFileSync(this.path, 'utf8');
        return Object.assign(Object.create(null), JSON.parse(data));
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          fs.mkdirSync(path.dirname(this.path), { recursive: true });
          return Object.create(null);
        }
        if (this.#options.clearInvalidConfig && error && error.name === 'SyntaxError') return Object.create(null);
        throw error;
      }
    }

    set store(value) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      if (pendingFailure) {
        pendingFailure.remaining -= 1;
        if (pendingFailure.remaining === 0) {
          const { error } = pendingFailure;
          pendingFailure = null;
          throw error;
        }
      }
      const temp = `${this.path}.${process.pid}.${(this.#seq += 1)}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value, undefined, '\t'), { mode: this.#options.configFileMode });
      fs.renameSync(temp, this.path);
      stats.writes += 1;
      this.events.dispatchEvent(new Event('change'));
    }
  }

  const file = path.join(directory, 'config.json');
  return {
    Store: FakeStore,
    dir: directory,
    file,
    stats,

    /** Put `content` in config.json: a string verbatim (also invalid JSON, or empty), an object as JSON. */
    writeRaw(content) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, undefined, '\t'));
    },
    /** @returns {object|null} config.json parsed, or null when it does not exist */
    readRaw() {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    readText: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
    exists: (name) => fs.existsSync(path.join(directory, name)),
    /** @returns {string[]} the files in the folder, sorted */
    list: () => (fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []),
    /** @returns {number|null} permission bits (e.g. 0o600) of a file in the folder, null when missing */
    mode(name = 'config.json') {
      const target = path.join(directory, name);
      return fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : null;
    },

    /** Make the n-th next write (1 = the very next one) throw `error` before it touches the file. */
    failWrite(n = 1, error = new Error('disk full')) {
      pendingFailure = { remaining: n, error };
    },
    /** Make every read of the file throw `error` (after letting the first `skip` reads through) until called with null. */
    failReads(error, { skip = 0 } = {}) {
      readFailure = error ? { error, skip } : null;
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

module.exports = { createFakeStoreEnv, createRecordingLog, V1_FIXTURE, makeV1Fixture };
