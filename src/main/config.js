'use strict';

/**
 * Settings of the desktop app: an `electron-store` wrapper with schema v2, validated setters and the
 * one-time migration of the settings v1.6.1 saved (SPEC sections 5 and 8).
 *
 * Facts about electron-store 10 / conf 13 that shape this file (verified against the installed copy):
 * - The constructor MERGES its `defaults` into the stored object and WRITES the merge back to disk. If
 *   `schemaVersion` were a default, a v1 file would report schema 2 before `migrateLegacy()` ran, the
 *   migration would be skipped for good and the printer ports and the password would be lost. So the
 *   store is built WITHOUT `defaults`; they live here, and `schemaVersion` is written only by `migrateLegacy()`.
 * - `store.store` (getter) re-reads and parses the file on EVERY access. Everything else in the app reads
 *   an in-memory snapshot that is rebuilt after each write.
 * - `store.set(key, undefined)` throws; here, `set(path, undefined)` deletes.
 * - Nested defaults are not deep-merged by conf; here they are (stored values win, per path).
 * - The default file mode is 0o666; here it is 0o600.
 *
 * No method that writes ever throws: it returns a Result (`{ ok: true }` or `{ ok: false, code, message }`)
 * and logs the cause, so a full or write-protected disk can never crash the main process in a window event.
 * The validators are exported pure functions that return `{ ok: true, value }` or an INVALID_SETTINGS failure.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { isSharedSuffix } = require('./sharedSuffixes');

const SCHEMA_VERSION = 2;
const CONFIG_FILE_MODE = 0o600;
const BACKUP_FILE_NAME = 'config.v1-backup.json';

const INVALID_SETTINGS = 'INVALID_SETTINGS';
const UNKNOWN = 'UNKNOWN';

/** Schema v2 defaults (SPEC 5.1). `schemaVersion` is deliberately absent (see the header). */
const DEFAULTS = deepFreeze({
  serverUrl: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy',
  extraAllowedOrigins: [],
  printers: {
    receipt: { transport: 'system', printerName: '', port: '' },
    label: { transport: 'system', printerName: '', port: '' },
    dymo: { printerName: '' },
  },
  drawer: {
    enabled: true,
    pin: 2,
    onTimeMs: 50,
    offTimeMs: 510,
    passwordRecord: null,
    passwordWeak: false,
    requirePasswordForSettings: false,
  },
  window: { bounds: null, maximized: false, zoomLevel: 0, fullScreen: false, startFullScreen: false },
  updates: { autoDownload: true },
  startup: { openAtLogin: false },
  power: { keepAwake: true },
});

/** Every key v1.6.1 wrote at the root of config.json. They are never part of the v2 snapshot. */
const LEGACY_KEYS = Object.freeze([
  'printerName',
  'printerPort',
  'password',
  'labelPrinterName',
  'labelPrinterPort',
  'a4PrinterName',
  'a4PrinterPort',
  'a4Password',
  'printerBrand',
]);

/** Legacy keys nothing ever used (the A4 printer and the brand): removed by the migration. */
const OBSOLETE_LEGACY_KEYS = Object.freeze(['a4PrinterName', 'a4PrinterPort', 'a4Password', 'printerBrand']);

const PRINTER_ROLES = Object.freeze(['receipt', 'label', 'dymo']);
const MAX_TEXT_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_EXTRA_ORIGINS = 50;
const PULSE_MIN_MS = 2;
const PULSE_MAX_MS = 510;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const MAX_WINDOW_COORDINATE = 100000;

// U+2028 and U+2029 (line and paragraph separators) are built from their character codes: written as
// escapes inside a regex literal they are fragile in tooling, and a real one is a syntax error there.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL_CHARACTERS = new RegExp(`[\\u0000-\\u001f\\u007f${LINE_SEPARATORS}]`);
const CONTROL_CHARACTERS_EVERYWHERE = new RegExp(CONTROL_CHARACTERS.source, 'g');
const HOSTNAME_PATTERN = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INTERNAL_KEY = '__internal__';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** @template T @param {T} value @returns {T} the same value, frozen all the way down */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} value @returns {boolean} true for `{}`-like objects (also null-prototype ones), false for null and arrays */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @template T @param {T} value @returns {T} a deep copy of JSON-like data (primitives are returned as they are) */
function clone(value) {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

/** @param {object} object @param {string} key @returns {boolean} */
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** @param {unknown} error @returns {string} */
function describe(error) {
  return error && error.message ? String(error.message) : String(error);
}

/**
 * @param {unknown} path a dot path such as 'printers.receipt.port'
 * @returns {string[]|null} its parts, or null when it is not a usable path
 */
function splitPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const parts = path.split('.');
  return parts.every((part) => part.length > 0 && !FORBIDDEN_KEYS.has(part)) ? parts : null;
}

/** @param {unknown} root @param {string[]} parts @returns {unknown} the value at the path, or undefined */
function readPath(root, parts) {
  let current = root;
  for (const part of parts) {
    if (!isPlainObject(current) || !hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Set a value at a path of a plain object, replacing any non-object that is in the way. */
function writePath(root, parts, value) {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * The effective value of one setting: stored value merged over its default. Anything stored with the
 * wrong type (a hand-edited file) is replaced by the default, so callers always see the right shape.
 * A default of `null` means "free-form" (the window bounds, the password record): any stored value is kept.
 *
 * @param {unknown} defaultValue
 * @param {unknown} stored
 * @returns {unknown} a new value, never shared with `defaultValue` or `stored`
 */
function mergeWithDefaults(defaultValue, stored) {
  if (stored === undefined) return clone(defaultValue);
  if (defaultValue === null || defaultValue === undefined) return clone(stored);
  if (Array.isArray(defaultValue)) return Array.isArray(stored) ? clone(stored) : clone(defaultValue);
  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(stored)) return clone(defaultValue);
    const merged = {};
    for (const key of Object.keys(defaultValue)) merged[key] = mergeWithDefaults(defaultValue[key], stored[key]);
    for (const key of Object.keys(stored)) {
      if (!hasOwn(merged, key) && !FORBIDDEN_KEYS.has(key)) merged[key] = clone(stored[key]);
    }
    return merged;
  }
  return typeof stored === typeof defaultValue ? stored : defaultValue;
}

/**
 * The in-memory picture of the settings: `defaults` overlaid with what is stored. Legacy v1 keys are
 * left out (the plain-text `password` must never reach a caller).
 *
 * @param {object} defaults
 * @param {object} raw the stored object as electron-store returned it (always an object, even for an empty or `null` file)
 * @returns {object}
 */
function buildSnapshot(defaults, raw) {
  const snapshot = {};
  for (const key of Object.keys(defaults)) snapshot[key] = mergeWithDefaults(defaults[key], raw[key]);
  for (const key of Object.keys(raw)) {
    if (!hasOwn(snapshot, key) && !LEGACY_KEYS.includes(key) && !FORBIDDEN_KEYS.has(key)) {
      snapshot[key] = clone(raw[key]);
    }
  }
  return snapshot;
}

/** @param {unknown} log an electron-log style logger, or nothing @returns {{info: Function, error: Function}} the two levels this file uses; a missing logger or method is silent */
function withLogger(log) {
  const target = log !== null && typeof log === 'object' ? log : {};
  const bind = (level) => (typeof target[level] === 'function' ? (...args) => target[level](...args) : () => {});
  return { info: bind('info'), error: bind('error') };
}

// ---------------------------------------------------------------------------------------------
// Validators (pure). Each returns { ok: true, value } or { ok: false, code: 'INVALID_SETTINGS', message }.
// ---------------------------------------------------------------------------------------------

/** @param {string} message @returns {{ok: false, code: string, message: string}} */
function invalid(message) {
  return { ok: false, code: INVALID_SETTINGS, message };
}

/** @template T @param {T} value @returns {{ok: true, value: T}} */
function valid(value) {
  return { ok: true, value };
}

/** @param {string} text @returns {string} short, single-line, quoted: safe to repeat inside a message */
function quote(text) {
  return `"${text.slice(0, 60).replace(CONTROL_CHARACTERS_EVERYWHERE, ' ')}"`;
}

/**
 * @param {unknown} value
 * @param {string} label how the field is called in the message
 * @returns {{text: string}|{error: string}} the trimmed text, or why it cannot be used (missing counts as empty)
 */
function readText(value, label) {
  if (value === undefined || value === null) return { text: '' };
  if (typeof value !== 'string') return { error: `${label} must be text.` };
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) return { error: `${label} is too long. Use at most ${MAX_TEXT_LENGTH} characters.` };
  if (CONTROL_CHARACTERS.test(text)) return { error: `${label} contains characters that cannot be used.` };
  return { text };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{flag: boolean}|{error: string}}
 */
function readBoolean(value, label) {
  return typeof value === 'boolean' ? { flag: value } : { error: `${label} must be on or off.` };
}

/**
 * Printer settings for one role (SPEC 5.1). `receipt` and `label` are `{ transport, printerName, port }`,
 * `dymo` is `{ printerName }`. Text is trimmed, at most 512 characters, with no control characters.
 * A `port` is kept only when the transport is `port` (a stale one is dropped for `system`) and is then
 * required. Whether the port is a usable Windows port is `classifyPort`'s job (SPEC 9.1), not this function's.
 *
 * @param {unknown} role 'receipt' | 'label' | 'dymo'
 * @param {unknown} settings
 * @returns {{ok: true, value: object}|{ok: false, code: string, message: string}}
 */
function validatePrinter(role, settings) {
  if (!PRINTER_ROLES.includes(role)) return invalid('Choose the receipt printer, the label printer or the DYMO printer.');
  if (!isPlainObject(settings)) return invalid('The printer settings are missing.');
  const name = readText(settings.printerName, 'The printer name');
  if (name.error) return invalid(name.error);
  if (role === 'dymo') return valid({ printerName: name.text });

  if (settings.transport === 'system') return valid({ transport: 'system', printerName: name.text, port: '' });
  if (settings.transport !== 'port') return invalid('Choose how the printer is connected: an installed printer, or a port.');
  const port = readText(settings.port, 'The port');
  if (port.error) return invalid(port.error);
  if (port.text === '') return invalid('Enter the port or the shared printer address.');
  return valid({ transport: 'port', printerName: name.text, port: port.text });
}

/**
 * @param {string} text
 * @returns {{url: URL}|{error: string}} the parsed https URL, or why it cannot be used
 */
function parseHttpsUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'This is not a valid address. It should look like https://pos.example.com' };
  }
  if (url.protocol !== 'https:') return { error: 'The address must start with https://' };
  if (url.username !== '' || url.password !== '') return { error: 'The address cannot contain a user name or a password.' };
  if (!HOSTNAME_PATTERN.test(url.hostname) || url.hostname.includes('..')) {
    return { error: 'The domain name in this address cannot be used.' };
  }
  return { url };
}

/**
 * @param {unknown} raw
 * @returns {{ok: true, value: string}|{ok: false, code: string, message: string}} the normalised https address
 */
function normaliseServerUrl(raw) {
  if (typeof raw !== 'string') return invalid('The server address must be text.');
  const text = raw.trim();
  if (text === '') return invalid('Enter the server address, for example https://pos.example.com');
  if (text.length > MAX_URL_LENGTH) return invalid('The server address is too long.');
  const parsed = parseHttpsUrl(text);
  return parsed.error ? invalid(parsed.error) : valid(parsed.url.href);
}

/**
 * @param {string} text lower-case, starting with '*.'
 * @returns {{ok: true, value: string}|{ok: false, code: string, message: string}}
 */
function normaliseWildcard(text) {
  const wrong = invalid(`${quote(text)} is not a valid domain. Use a form such as *.example.com`);
  const base = text.slice(2);
  if (!/^[^\s/?#@:*]+$/.test(base)) return wrong;
  let hostname;
  try {
    hostname = new URL(`https://${base}`).hostname;
  } catch {
    return wrong;
  }
  if (!DOMAIN_PATTERN.test(hostname) || hostname.length > 253) return wrong;
  if (isSharedSuffix(hostname)) {
    return invalid(`${quote(text)} would allow every website that ends in ${hostname}, not only yours. Add your own address instead, such as https://shop.example.com or *.example.com.`);
  }
  return valid(`*.${hostname}`);
}

/**
 * One entry of `extraAllowedOrigins`: an https origin (any path, query or fragment is dropped) or a
 * `*.domain` wildcard of at least two labels that is not a public suffix or a shared hosting domain (sharedSuffixes.js).
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: string}|{ok: false, code: string, message: string}}
 */
function normaliseOrigin(raw) {
  if (typeof raw !== 'string') return invalid('Each extra domain must be text.');
  const text = raw.trim().toLowerCase();
  if (text === '') return invalid('One of the extra domains is empty.');
  if (text.length > MAX_URL_LENGTH) return invalid('One of the extra domains is too long.');
  if (text.startsWith('*.')) return normaliseWildcard(text);
  const parsed = parseHttpsUrl(text);
  if (parsed.error) return invalid(`${quote(text)} cannot be used. Use a form such as https://shop.example.com or *.example.com`);
  return valid(parsed.url.origin);
}

/**
 * @param {unknown} list
 * @returns {{ok: true, value: string[]}|{ok: false, code: string, message: string}} normalised, without duplicates
 */
function normaliseOrigins(list) {
  if (!Array.isArray(list)) return invalid('The extra domains must be a list.');
  if (list.length > MAX_EXTRA_ORIGINS) return invalid(`You can add at most ${MAX_EXTRA_ORIGINS} extra domains.`);
  const origins = new Set();
  for (const raw of list) {
    const checked = normaliseOrigin(raw);
    if (!checked.ok) return checked;
    origins.add(checked.value);
  }
  return valid([...origins]);
}

/**
 * Connection settings. Both fields are optional; only those present are validated and returned.
 * `serverUrl` must be an https address without credentials and is normalised by the URL parser;
 * `extraAllowedOrigins` is a list of https origins or `*.domain` wildcards (SPEC 12).
 *
 * @param {unknown} input {serverUrl?, extraAllowedOrigins?}
 * @returns {{ok: true, value: {serverUrl?: string, extraAllowedOrigins?: string[]}}|{ok: false, code: string, message: string}}
 */
function validateConnection(input) {
  if (!isPlainObject(input)) return invalid('The connection settings are missing.');
  const value = {};
  if (input.serverUrl !== undefined) {
    const checked = normaliseServerUrl(input.serverUrl);
    if (!checked.ok) return checked;
    value.serverUrl = checked.value;
  }
  if (input.extraAllowedOrigins !== undefined) {
    const checked = normaliseOrigins(input.extraAllowedOrigins);
    if (!checked.ok) return checked;
    value.extraAllowedOrigins = checked.value;
  }
  return valid(value);
}

/**
 * Cash drawer settings; every field is optional and anything else (such as the `password` the Settings
 * form sends along for authorisation) is ignored, never stored. `pin` is 2 or 5; both pulse lengths are
 * whole milliseconds from 2 to 510 (SPEC 10).
 *
 * @param {unknown} input {enabled?, pin?, onTimeMs?, offTimeMs?, requirePasswordForSettings?}
 * @returns {{ok: true, value: object}|{ok: false, code: string, message: string}}
 */
function validateDrawer(input) {
  if (!isPlainObject(input)) return invalid('The cash drawer settings are missing.');
  const value = {};
  for (const [key, label] of [['enabled', 'The drawer switch'], ['requirePasswordForSettings', 'The settings password switch']]) {
    if (input[key] === undefined) continue;
    const checked = readBoolean(input[key], label);
    if (checked.error) return invalid(checked.error);
    value[key] = checked.flag;
  }
  if (input.pin !== undefined) {
    if (input.pin !== 2 && input.pin !== 5) return invalid('The drawer connector must be pin 2 or pin 5.');
    value.pin = input.pin;
  }
  for (const [key, label] of [['onTimeMs', 'The pulse length'], ['offTimeMs', 'The pause between pulses']]) {
    if (input[key] === undefined) continue;
    const ms = input[key];
    if (!Number.isInteger(ms) || ms < PULSE_MIN_MS || ms > PULSE_MAX_MS) {
      return invalid(`${label} must be a whole number of milliseconds from ${PULSE_MIN_MS} to ${PULSE_MAX_MS}.`);
    }
    value[key] = ms;
  }
  return valid(value);
}

/**
 * The General tab: start with the computer, start in full screen, keep the computer awake (SPEC 18b D2, D3, R2).
 *
 * @param {unknown} input {openAtLogin?, startFullScreen?, keepAwake?}
 * @returns {{ok: true, value: {openAtLogin?: boolean, startFullScreen?: boolean, keepAwake?: boolean}}|{ok: false, code: string, message: string}}
 */
function validateGeneral(input) {
  if (!isPlainObject(input)) return invalid('The general settings are missing.');
  const value = {};
  const fields = [
    ['openAtLogin', 'Starting with the computer'],
    ['startFullScreen', 'Starting in full screen'],
    ['keepAwake', 'Keeping the computer awake'],
  ];
  for (const [key, label] of fields) {
    if (input[key] === undefined) continue;
    const checked = readBoolean(input[key], `${label} switch`);
    if (checked.error) return invalid(checked.error);
    value[key] = checked.flag;
  }
  return valid(value);
}

/**
 * @param {unknown} bounds
 * @returns {{ok: true, value: object|null}|{ok: false, code: string, message: string}} `null` clears the saved bounds
 */
function validateBounds(bounds) {
  if (bounds === null) return valid(null);
  if (!isPlainObject(bounds)) return invalid('The window position must be x, y, width and height, or empty.');
  const read = (key, min) => {
    const number = bounds[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
    const rounded = Math.round(number);
    return rounded >= min && rounded <= MAX_WINDOW_COORDINATE ? rounded : null;
  };
  const x = read('x', -MAX_WINDOW_COORDINATE);
  const y = read('y', -MAX_WINDOW_COORDINATE);
  const width = read('width', 1);
  const height = read('height', 1);
  if ([x, y, width, height].includes(null)) return invalid('The window position or size is not usable.');
  return valid({ x, y, width, height });
}

/**
 * What the main window remembers: its bounds, maximised and full-screen state, and zoom level.
 * `zoomLevel` is clamped to -3..5 (SPEC 12b) rather than rejected.
 *
 * @param {unknown} input {bounds?, maximized?, fullScreen?, zoomLevel?}
 * @returns {{ok: true, value: object}|{ok: false, code: string, message: string}}
 */
function validateWindowState(input) {
  if (!isPlainObject(input)) return invalid('The window settings are missing.');
  const value = {};
  if (input.bounds !== undefined) {
    const checked = validateBounds(input.bounds);
    if (!checked.ok) return checked;
    value.bounds = checked.value;
  }
  for (const [key, label] of [['maximized', 'The maximised state'], ['fullScreen', 'The full screen state']]) {
    if (input[key] === undefined) continue;
    const checked = readBoolean(input[key], label);
    if (checked.error) return invalid(checked.error);
    value[key] = checked.flag;
  }
  if (input.zoomLevel !== undefined) {
    if (typeof input.zoomLevel !== 'number' || !Number.isFinite(input.zoomLevel)) return invalid('The zoom level must be a number.');
    value.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(input.zoomLevel * 100) / 100));
  }
  return valid(value);
}

/** @param {string} prefix @param {object} fields @returns {object} `{ 'prefix.key': value }` for each field, ready for `store.set(object)` */
function prefixed(prefix, fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${prefix}.${key}`, value]));
}

// ---------------------------------------------------------------------------------------------
// Legacy migration (SPEC 5.2)
// ---------------------------------------------------------------------------------------------

/**
 * A v1 printer name or port as a clean string: non-strings (a damaged file), text over 512 characters
 * and text with control characters count as empty.
 * @param {unknown} value
 * @returns {string}
 */
function legacyText(value) {
  const checked = readText(value, 'value');
  return checked.error ? '' : checked.text;
}

/**
 * Turn v1's name and port into `printers.<role>`. Leaves an already stored `printers.<role>` alone, so a
 * retry after a failed start can never overwrite what the user chose in the meantime.
 *
 * @param {object} next the object being built
 * @param {'receipt'|'label'} role
 * @param {unknown} legacyName
 * @param {unknown} legacyPort
 * @returns {boolean} true when the printer was migrated
 */
function migratePrinter(next, role, legacyName, legacyPort) {
  const printerName = legacyText(legacyName);
  const port = legacyText(legacyPort);
  if ((printerName === '' && port === '') || readPath(next, ['printers', role]) !== undefined) return false;
  writePath(next, ['printers', role], { transport: port === '' ? 'system' : 'port', printerName, port });
  return true;
}

/**
 * Turn v1's plain-text password into `drawer.passwordRecord`. The plain key is removed only once a
 * record exists (just made, or already stored by an earlier attempt, which is never overwritten). A value
 * that is not a non-empty string is not a password and is left alone.
 *
 * @param {object} next the object being built
 * @param {unknown} legacyPassword
 * @param {{hashPassword: Function, validatePasswordPolicy: Function}} password
 * @returns {'none'|'migrated'|'weak'|'kept'} what happened; 'weak' = migrated but outside the 4..64 policy, 'kept' = a record was already stored
 * @throws when hashing fails: the caller leaves every legacy key in place and retries on the next start
 */
function migratePassword(next, legacyPassword, password) {
  if (typeof legacyPassword !== 'string' || legacyPassword.length === 0) return 'none';
  if (readPath(next, ['drawer', 'passwordRecord'])) {
    delete next.password;
    return 'kept';
  }
  const record = password.hashPassword(legacyPassword);
  const weak = !password.validatePasswordPolicy(legacyPassword).ok;
  writePath(next, ['drawer', 'passwordRecord'], record);
  writePath(next, ['drawer', 'passwordWeak'], weak);
  delete next.password;
  return weak ? 'weak' : 'migrated';
}

/**
 * Work out, WITHOUT touching the disk, the complete object that replaces the stored one.
 *
 * @param {object} raw the stored object
 * @param {{hashPassword: Function, validatePasswordPolicy: Function}} password
 * @returns {{next: object, hasLegacy: boolean, backup: object, summary: {receipt: boolean, label: boolean, password: string}}}
 * @throws when the password cannot be hashed
 */
function planMigration(raw, password) {
  const next = {};
  for (const key of Object.keys(raw)) {
    if (!FORBIDDEN_KEYS.has(key)) next[key] = clone(raw[key]);
  }
  const summary = {
    receipt: migratePrinter(next, 'receipt', raw.printerName, raw.printerPort),
    label: migratePrinter(next, 'label', raw.labelPrinterName, raw.labelPrinterPort),
    password: migratePassword(next, raw.password, password),
  };
  for (const key of OBSOLETE_LEGACY_KEYS) delete next[key];
  next.schemaVersion = SCHEMA_VERSION;

  const backup = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'password' && !FORBIDDEN_KEYS.has(key)) backup[key] = raw[key];
  }
  return { next, hasLegacy: LEGACY_KEYS.some((key) => hasOwn(raw, key)), backup, summary };
}

// ---------------------------------------------------------------------------------------------
// The config object
// ---------------------------------------------------------------------------------------------

/**
 * Move a damaged config.json out of the way, keeping its content, so nothing is lost and the app can start fresh.
 * A failure to move it is logged and otherwise ignored: the store then simply overwrites it on the first save.
 *
 * @param {{renameSync: Function}} fs
 * @param {string} filePath the damaged config.json
 * @param {number} time the moment of the damage, as the clock returned it (a bad value falls back to the real clock)
 * @param {{error: Function}} log
 */
function quarantineCorruptFile(fs, filePath, time, log) {
  const stamp = new Date(Number.isFinite(time) ? time : Date.now()).toISOString().replace(/[:.]/g, '-');
  const moved = nodePath.join(nodePath.dirname(filePath), `config.corrupt-${stamp}.json`);
  try {
    fs.renameSync(filePath, moved);
    log.error(`config: the settings file was damaged; moved it to ${moved} and started from the defaults`);
  } catch (error) {
    log.error(`config: the settings file was damaged and could not be moved (${describe(error)}); starting from the defaults`);
  }
}

/**
 * Open the store. A corrupt or empty `config.json` makes conf's constructor throw a SyntaxError: the file is
 * quarantined as `config.corrupt-<timestamp>.json` and the app starts from the defaults. Any other failure to
 * open the store is not hidden.
 */
function openStore(Store, { fs, now, log }) {
  try {
    return new Store({ configFileMode: CONFIG_FILE_MODE });
  } catch (error) {
    if (!(error instanceof SyntaxError || (error && error.name === 'SyntaxError'))) throw error;
    const store = new Store({ configFileMode: CONFIG_FILE_MODE, clearInvalidConfig: true });
    quarantineCorruptFile(fs, store.path, now(), log);
    return store;
  }
}

/**
 * Save the v1 file as `config.v1-backup.json` next to config.json (mode 0600), unless an earlier attempt already did:
 * that copy is the pristine v1 file and is never overwritten.
 *
 * @param {typeof nodeFs} fs
 * @param {string} configPath absolute path of config.json
 * @param {object} backup the old file's content without its password
 * @returns {boolean} true when written now, false when it already existed
 * @throws when the backup cannot be written (the migration must then not go on)
 */
function writeBackup(fs, configPath, backup) {
  const directory = nodePath.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(nodePath.join(directory, BACKUP_FILE_NAME), `${JSON.stringify(backup, null, '\t')}\n`, { mode: CONFIG_FILE_MODE, flag: 'wx' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * @typedef {object} Config
 * @property {(path: string, fallback?: any) => any} get the setting at a dot path from the in-memory snapshot (a copy): the stored value, else the default at that path, else `fallback`
 * @property {(path: string, value: any) => object} set raw write of one setting (`undefined` deletes it); prefer the validated setters
 * @property {() => object} all a copy of every effective setting, INCLUDING `drawer.passwordRecord` (main process only, never send it to a window)
 * @property {() => object} publicState a copy that is safe for a window: no `passwordRecord` and no `drawer.lock`, with `drawer.passwordSet`
 * @property {() => object} migrateLegacy one-time v1 -> v2 migration, see its own docs
 * @property {(callback: Function) => (() => void)} onDidChange `callback(newSnapshot, oldSnapshot)` after every real change; returns the unsubscribe function
 * @property {() => object} reset factory reset: erases every setting, the password included
 * @property {(role: string, settings: object) => object} setPrinter
 * @property {(input: object) => object} setConnection
 * @property {(input: object) => object} setDrawer
 * @property {(input: object) => object} setGeneral
 * @property {(input: object) => object} setWindowState
 * @property {(record: object|null) => object} setPasswordRecord store or (null) remove the drawer password record
 * @property {string} path absolute path of config.json
 */

/**
 * @param {object} deps
 * @param {Function} deps.Store the `electron-store` class (the caller imports it with `await import('electron-store')`)
 * @param {{info?: Function, error?: Function}} [deps.log] electron-log style logger
 * @param {object} [deps.defaults=DEFAULTS] schema v2 defaults, kept here and never handed to the Store
 * @param {{hashPassword: Function, validatePasswordPolicy: Function}} [deps.password] defaults to ./password
 * @param {typeof nodeFs} [deps.fs] defaults to node:fs (corrupt-file rename and the v1 backup)
 * @param {() => number} [deps.now] clock for the corrupt-file name, defaults to Date.now
 * @returns {Config}
 */
function createConfig({ Store, log, defaults = DEFAULTS, password = require('./password'), fs = nodeFs, now = Date.now } = {}) {
  if (typeof Store !== 'function') throw new TypeError('createConfig needs the electron-store class.');
  const logger = withLogger(log);
  const store = openStore(Store, { fs, now, log: logger });
  const listeners = new Set();
  let snapshot = buildSnapshot(defaults, {});

  /** Rebuild the snapshot from disk. A file that cannot be read keeps the last known settings. */
  function refresh() {
    try {
      snapshot = buildSnapshot(defaults, store.store);
    } catch (error) {
      logger.error(`config: could not read the settings file, keeping the last known settings (${describe(error)})`);
    }
  }

  /**
   * Tell the subscribers about a change, with copies of the sanitised snapshots. The raw store object is never
   * handed out: it carries the plain-text v1 password until the migration has run. Changes that only touch
   * legacy keys do not alter the snapshot and so notify nobody.
   */
  function notifyIfChanged(previous) {
    if (isDeepStrictEqual(previous, snapshot)) return;
    for (const listener of [...listeners]) {
      try {
        listener(clone(snapshot), clone(previous));
      } catch (error) {
        logger.error(`config: a change listener failed (${describe(error)})`);
      }
    }
  }

  /** Run one write, refresh the snapshot, notify subscribers, and turn a failure into a Result. */
  function save(what, write) {
    const previous = snapshot;
    let result = { ok: true };
    try {
      write();
    } catch (error) {
      logger.error(`config: could not save ${what} (${describe(error)})`);
      result = {
        ok: false,
        code: UNKNOWN,
        message: 'The settings could not be saved. Check that the disk is not full or write-protected, then try again.',
      };
    }
    refresh();
    notifyIfChanged(previous);
    return result;
  }

  /**
   * Hand an invalid request back as it is; otherwise write the entries `entriesOf(value)` in ONE write
   * (an empty request writes nothing).
   */
  function saveChecked(checked, what, entriesOf) {
    if (!checked.ok) return checked;
    const entries = entriesOf(checked.value);
    return Object.keys(entries).length === 0 ? { ok: true } : save(what, () => store.set(entries));
  }

  refresh();

  /**
   * Run the one-time v1 -> v2 migration (SPEC 5.2). Idempotent; never throws.
   *
   * It decides from the RAW stored object (never from defaults) and only when `schemaVersion` is absent or
   * below 2. The complete new object is built first (hashing the password can fail); the v1 file is saved
   * as `config.v1-backup.json` (mode 0600, without its `password`) once; then ONE atomic write replaces the
   * file with the new object, `schemaVersion` included. So any failure leaves the legacy keys exactly as
   * they were and the next start retries. v1's printer name/port keys stay in place so a downgrade still
   * prints; the plain `password` is removed only because its hashed record is saved in the same write.
   *
   * @returns {{migrated: false, reason: 'current'}
   *   |{migrated: false, error: Error}
   *   |{migrated: true, fromV1: boolean, backedUp: boolean, receipt: boolean, label: boolean, password: 'none'|'migrated'|'weak'|'kept'}}
   *   `fromV1` is true when v1 settings were found (a fresh install migrates nothing but still gets `schemaVersion`).
   */
  function migrateLegacy() {
    try {
      const raw = store.store;
      if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= SCHEMA_VERSION) return { migrated: false, reason: 'current' };

      const plan = planMigration(raw, password);
      const backedUp = plan.hasLegacy && writeBackup(fs, store.path, plan.backup);
      const previous = snapshot;
      store.store = plan.next;
      refresh();
      notifyIfChanged(previous);

      const result = { migrated: true, fromV1: plan.hasLegacy, backedUp, ...plan.summary };
      logger.info(`config: migrated to schema ${SCHEMA_VERSION} ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(`config: migration failed, the v1 settings were left as they were (${describe(error)})`);
      refresh();
      return { migrated: false, error };
    }
  }

  return {
    get(path, fallback) {
      const parts = splitPath(path);
      const value = parts ? readPath(snapshot, parts) : undefined;
      return value === undefined ? fallback : clone(value);
    },

    set(path, value) {
      const parts = splitPath(path);
      if (!parts || parts[0] === INTERNAL_KEY) return invalid(`${quote(String(path))} is not a valid setting name.`);
      const key = parts.join('.');
      return save(key, () => (value === undefined ? store.delete(key) : store.set(key, value)));
    },

    all: () => clone(snapshot),

    publicState() {
      const state = clone(snapshot);
      if (!isPlainObject(state.drawer)) state.drawer = {};
      state.drawer.passwordSet = Boolean(state.drawer.passwordRecord);
      delete state.drawer.passwordRecord;
      delete state.drawer.lock; // the password throttle's saved counters (password.js createThrottle): nothing a window needs
      return state;
    },

    migrateLegacy,

    onDidChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('onDidChange needs a function.');
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    reset: () => save('the factory reset', () => store.clear()),

    setPrinter: (role, settings) => saveChecked(validatePrinter(role, settings), `the ${role} printer`, (value) => ({ [`printers.${role}`]: value })),

    setConnection: (input) => saveChecked(validateConnection(input), 'the connection settings', (value) => value),

    setDrawer: (input) => saveChecked(validateDrawer(input), 'the cash drawer settings', (value) => prefixed('drawer', value)),

    setGeneral: (input) =>
      saveChecked(validateGeneral(input), 'the general settings', (value) => {
        const entries = {};
        if (value.openAtLogin !== undefined) entries['startup.openAtLogin'] = value.openAtLogin;
        if (value.startFullScreen !== undefined) entries['window.startFullScreen'] = value.startFullScreen;
        if (value.keepAwake !== undefined) entries['power.keepAwake'] = value.keepAwake;
        return entries;
      }),

    setWindowState: (input) => saveChecked(validateWindowState(input), 'the window settings', (value) => prefixed('window', value)),

    setPasswordRecord(record) {
      if (record !== null && !isPlainObject(record)) return invalid('The password record is not valid.');
      // A new password is never "weak" (it passed the policy), and a removed one cannot be asked for.
      const entries = { 'drawer.passwordRecord': record, 'drawer.passwordWeak': false };
      if (record === null) entries['drawer.requirePasswordForSettings'] = false;
      return save('the drawer password', () => store.set(entries));
    },

    get path() {
      return store.path;
    },
  };
}

module.exports = {
  createConfig,
  DEFAULTS,
  SCHEMA_VERSION,
  LEGACY_KEYS,
  BACKUP_FILE_NAME,
  PULSE_MIN_MS,
  PULSE_MAX_MS,
  validatePrinter,
  validateConnection,
  validateDrawer,
  validateGeneral,
  validateWindowState,
};
