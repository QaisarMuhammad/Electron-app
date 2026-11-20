'use strict';

/**
 * Settings before the settings store exists (SPEC 18b S1).
 *
 * `electron-store` (and the `conf` and `ajv` modules under it) takes about 170 ms to load, and the main window needs
 * a few settings at the moment it is created: where it was last, whether it was maximised, the zoom and the server
 * address. So the loading screen is shown first, with what a small synchronous read of `config.json` says, and the
 * real store is loaded while that page renders.
 *
 *  - `readEarlyConfigSync`   parses `<userData>/config.json` once and never throws.
 *  - `createDeferredConfig`  the `get`/`set` pair the window code uses. Until `attach(realConfig)` it answers from the
 *                            file (then the defaults) and remembers what is written; after it, everything is the real
 *                            config's, and the remembered writes are replayed into it first.
 *
 * Pure Node: the file system is injected.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const CONFIG_FILE_NAME = 'config.json';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {unknown} value @returns {boolean} true for `{}`-like objects, false for null and arrays */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @template T @param {T} value @returns {T} a deep copy of JSON-like data */
function clone(value) {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

/**
 * @param {unknown} path a dot path such as 'window.bounds'
 * @returns {string[]|null} its parts, or null when it is not usable
 */
function splitPath(path) {
  if (typeof path !== 'string' || path === '') return null;
  const parts = path.split('.');
  return parts.every((part) => part !== '' && !FORBIDDEN_KEYS.has(part)) ? parts : null;
}

/** @param {unknown} root @param {string[]} parts @returns {unknown} the value at the path, or undefined */
function readPath(root, parts) {
  let current = root;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Reads `config.json` of the userData folder synchronously. A missing, unreadable or damaged file gives `{}`: the
 * real config module deals with a damaged file properly when it opens the store.
 *
 * @param {string} userDataDir
 * @param {{ fs?: typeof nodeFs }} [deps]
 * @returns {object} the stored settings exactly as saved (legacy v1 keys included), or `{}`
 */
function readEarlyConfigSync(userDataDir, { fs = nodeFs } = {}) {
  try {
    const text = fs.readFileSync(nodePath.join(userDataDir, CONFIG_FILE_NAME), 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {object} [options.early] the object `readEarlyConfigSync` returned
 * @param {object} [options.defaults] the schema defaults (`DEFAULTS` of config.js)
 * @returns {{
 *   get: (path: string, fallback?: any) => any,
 *   set: (path: string, value: any) => {ok: true}|{ok: false, code: string, message: string},
 *   attach: (config: { get: Function, set: Function }) => void,
 *   isAttached: () => boolean
 * }}
 */
function createDeferredConfig({ early = {}, defaults = {} } = {}) {
  const written = {};
  /** @type {Array<[string, any]>} */
  let pending = [];
  let target = null;

  /** Writes into the overlay that is read before the file's content. */
  function remember(parts, value) {
    let node = written;
    for (const part of parts.slice(0, -1)) {
      if (!isPlainObject(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = clone(value);
  }

  return {
    /** The setting at a dot path: what was written meanwhile, else the file, else the default, else `fallback`. */
    get(path, fallback) {
      if (target) return target.get(path, fallback);
      const parts = splitPath(path);
      if (!parts) return fallback;
      for (const source of [written, early, defaults]) {
        const value = readPath(source, parts);
        if (value !== undefined) return clone(value);
      }
      return fallback;
    },

    /** Remembers the write until the real config is attached; afterwards it IS the real config's `set`. */
    set(path, value) {
      if (target) return target.set(path, value);
      const parts = splitPath(path);
      if (!parts || value === undefined) {
        return { ok: false, code: 'INVALID_SETTINGS', message: 'This setting cannot be saved yet.' };
      }
      remember(parts, value);
      pending.push([path, clone(value)]);
      return { ok: true };
    },

    /** Hands over to the real config and replays, in order, what was written before it existed. */
    attach(config) {
      target = config;
      const replay = pending;
      pending = [];
      for (const [path, value] of replay) config.set(path, value);
    },

    isAttached: () => target !== null,
  };
}

module.exports = { readEarlyConfigSync, createDeferredConfig };
