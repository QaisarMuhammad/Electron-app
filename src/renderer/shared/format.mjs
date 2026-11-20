/*
 * GadgetsPOS Desktop - pure helpers shared by the local pages (no DOM, no timers, no window.desktop).
 *
 * Everything here is deterministic and is exercised by tests/e2e/ui-shots.js (the "logic" group), because the
 * harness imports this file straight into the Electron main process.
 *
 * Several shapes below are read leniently on purpose (lockout state, printer status, startup marks): SPEC 6.2 fixes the
 * method names of window.desktop but leaves those payloads open, so the UI accepts every sensible shape instead of
 * guessing one.
 */

/** @param {number} n @param {string} one @param {string} many */
export function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

/** 27 -> "0:27", 65 -> "1:05", 3700 -> "1:01:40". Used for lockout countdowns. */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 1 -> "1 second", 27 -> "27 seconds", 65 -> "1 minute 5 seconds". Used in sentences. */
export function formatSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (s < 60) return `${s} ${plural(s, 'second')}`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  const mins = `${m} ${plural(m, 'minute')}`;
  return rest ? `${mins} ${rest} ${plural(rest, 'second')}` : mins;
}

/** Milliseconds as a short human string: 412 -> "412 ms", 1830 -> "1.8 s". */
export function formatMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v)) return '';
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} s`;
}

/** Local clock time such as "2:14:05 PM" for the technical details lists. */
export function formatTime(date) {
  try {
    return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Lockout results and pushes can carry the wait in several shapes; this returns { locked, retryAfterSec }.
 * Accepted: a number of seconds; { locked, retryAfterSec | retryAfterMs | remainingMs | remainingSec | lockedUntil(ms epoch) };
 * a Result { ok:false, details:{ retryAfterSec } }.
 * @param {unknown} raw
 * @param {number} [now]
 */
export function normalizeLockout(raw, now = Date.now()) {
  const none = { locked: false, retryAfterSec: 0 };
  if (raw == null) return none;
  if (typeof raw === 'number') return raw > 0 ? { locked: true, retryAfterSec: Math.ceil(raw) } : none;
  if (typeof raw !== 'object') return none;
  const src = /** @type {Record<string, any>} */ (raw.details && typeof raw.details === 'object' ? raw.details : raw);
  let sec = 0;
  if (Number.isFinite(src.retryAfterSec)) sec = src.retryAfterSec;
  else if (Number.isFinite(src.remainingSec)) sec = src.remainingSec;
  else if (Number.isFinite(src.retryAfterMs)) sec = src.retryAfterMs / 1000;
  else if (Number.isFinite(src.remainingMs)) sec = src.remainingMs / 1000;
  else if (Number.isFinite(src.lockedUntil)) sec = (src.lockedUntil - now) / 1000;
  if (src.locked === false) return none;
  return sec > 0 ? { locked: true, retryAfterSec: Math.ceil(sec) } : none;
}

/** True for the codes that mean "that password was wrong" (not locked out yet). */
export function isWrongPasswordCode(code) {
  return code === 'DRAWER_WRONG_PASSWORD' || code === 'PASSWORD_WRONG';
}

/** Deep, order-insensitive equality for plain JSON values (used for unsaved-change tracking). */
export function sameJson(a, b) {
  return stable(a) === stable(b);
}

function stable(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(',')}}`;
}

/** Deep clone of plain JSON data. */
export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Case-insensitive search over a printer list by name, display name and model. */
export function filterPrinters(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    [p.name, p.displayName, p.modelName, p.description].some((s) => typeof s === 'string' && s.toLowerCase().includes(q)),
  );
}

const WIN_STATUS_FLAGS = [
  [0x1, 'Paused', 'warning'],
  [0x2, 'Error', 'danger'],
  [0x8, 'Paper jam', 'danger'],
  [0x10, 'Out of paper', 'danger'],
  [0x40, 'Not ready', 'warning'],
  [0x80, 'Offline', 'danger'],
  [0x400, 'Printing', 'info'],
  [0x1000, 'Not available', 'danger'],
  [0x40000, 'Door open', 'warning'],
];

/**
 * Turns a printer status into a badge { label, tone } or null (show nothing).
 * Strings are used as given ("Ready", "Offline", ...). Numbers are decoded as Windows spooler flags on win32 and as CUPS
 * states (3 idle, 4 printing, 5 stopped) elsewhere.
 * @param {unknown} status
 * @param {string} [platform]
 * @returns {{label:string, tone:'success'|'warning'|'danger'|'info'|'neutral'}|null}
 */
export function describePrinterStatus(status, platform = '') {
  if (status == null || status === '') return null;
  if (typeof status === 'number') {
    if (platform === 'win32') {
      if (status === 0) return { label: 'Ready', tone: 'success' };
      const hit = WIN_STATUS_FLAGS.find(([bit]) => (status & bit) !== 0);
      return hit ? { label: hit[1], tone: hit[2] } : null;
    }
    if (status === 3) return { label: 'Ready', tone: 'success' };
    if (status === 4) return { label: 'Printing', tone: 'info' };
    if (status === 5) return { label: 'Stopped', tone: 'warning' };
    return null;
  }
  const text = String(status).trim();
  if (!text) return null;
  const s = text.toLowerCase();
  const label = text.length > 28 ? `${text.slice(0, 27)}...` : text[0].toUpperCase() + text.slice(1);
  if (/^(ready|idle|online|normal|ok|available)$/.test(s)) return { label: 'Ready', tone: 'success' };
  if (/(offline|not available|unavailable|disconnected|unplugged|error|jam|out of|toner|fault|problem)/.test(s)) {
    return { label, tone: 'danger' };
  }
  if (/(paused|stopped|door|not ready|warming|waiting)/.test(s)) return { label, tone: 'warning' };
  if (/(printing|busy|processing|spooling)/.test(s)) return { label, tone: 'info' };
  return { label, tone: 'neutral' };
}

/** Friendly names for the startup marks of SPEC 18b S3. Unknown names are prettified. */
const MARK_LABELS = {
  'process-start': 'Program started',
  'app-ready': 'Electron ready',
  'window-created': 'Window created',
  'loading-visible': 'Loading screen shown',
  'config-ready': 'Settings loaded',
  'services-ready': 'Services ready',
  'pos-dom-ready': 'POS page ready to use',
  'pos-loaded': 'POS page fully loaded',
};

/**
 * Normalises performance.startup into rows { name, label, at, delta } (ms since the program started, ms since the
 * previous mark) plus a one-line summary. Accepts marks as an object { name: ms }, an array of { name, ms|at|time|t|value }
 * or an array of [name, ms] pairs. Returns { rows: [], summary: '' } when there is nothing to show.
 * @param {any} startup
 */
export function normalizeStartup(startup) {
  const empty = { rows: [], summary: '' };
  if (!startup || typeof startup !== 'object') return empty;
  const raw = startup.marks;
  const entries = [];
  const push = (name, value) => {
    const at = Number(value);
    if (typeof name === 'string' && name && Number.isFinite(at)) entries.push({ name, at });
  };
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (Array.isArray(m)) push(m[0], m[1]);
      else if (m && typeof m === 'object') push(m.name, m.ms ?? m.at ?? m.time ?? m.t ?? m.value);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) push(name, value && typeof value === 'object' ? (value.ms ?? value.at) : value);
  }
  entries.sort((a, b) => a.at - b.at);
  const rows = entries.map((e, i) => ({
    name: e.name,
    label: MARK_LABELS[e.name] || e.name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    at: e.at,
    delta: i === 0 ? 0 : e.at - entries[i - 1].at,
  }));
  let summary = '';
  if (typeof startup.summary === 'string') summary = startup.summary.trim();
  else if (startup.summary && typeof startup.summary === 'object') {
    summary = Object.entries(startup.summary)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
      .map(([k, v]) => `${k} ${typeof v === 'number' ? formatMs(v) : v}`)
      .join(' - ');
  }
  return { rows, summary };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks a server address typed by the user. https is required; http is accepted only for localhost (development).
 * The main process validates again, so this only produces a quick, friendly message.
 * @returns {{ok:true, value:string}|{ok:false, message:string}}
 */
export function validateServerUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'Enter the server address.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'This is not a web address. It should look like https://shop.example.com' };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { ok: false, message: 'The address must start with https://' };
  }
  if (!url.hostname || url.username || url.password || /\s/.test(text)) {
    return { ok: false, message: 'This is not a valid web address.' };
  }
  return { ok: true, value: text };
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Checks an extra allowed domain: "https://shop.example.com", "https://shop.example.com:8443", "*.example.com" or a bare
 * "shop.example.com" (https:// is added). Returns the normalised value.
 * @returns {{ok:true, value:string}|{ok:false, message:string}}
 */
export function validateOrigin(raw) {
  let text = String(raw ?? '').trim().toLowerCase();
  const bad = { ok: false, message: 'Use a domain such as https://shop.example.com or *.example.com' };
  if (!text) return { ok: false, message: 'Enter a domain first.' };
  if (text.startsWith('http://')) return { ok: false, message: 'Only https:// addresses can be allowed.' };
  if (text.startsWith('*.')) return HOST_RE.test(text.slice(2)) ? { ok: true, value: text } : bad;
  if (!text.includes('://')) text = `https://${text}`;
  const m = /^https:\/\/([^/\s:?#]+)(?::(\d{1,5}))?\/?$/.exec(text);
  if (!m || !HOST_RE.test(m[1])) return bad;
  return { ok: true, value: `https://${m[1]}${m[2] ? `:${m[2]}` : ''}` };
}

/**
 * A simple, honest strength hint for the drawer password dialog (policy itself is 4..64 characters).
 * @returns {{level:0|1|2|3, label:string}}
 */
export function passwordStrength(text) {
  const t = String(text ?? '');
  if (t.length < 4) return { level: 0, label: t.length ? 'Too short' : '' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(t)).length;
  if (t.length >= 12 && classes >= 2) return { level: 3, label: 'Strong' };
  if (t.length >= 10 && classes >= 3) return { level: 3, label: 'Strong' };
  if (t.length >= 8 || (t.length >= 6 && classes >= 3)) return { level: 2, label: 'Okay' };
  return { level: 1, label: 'Weak' };
}

/** Host name of a URL for sentences ("vendor.societyfiles.com"), or '' when it cannot be parsed. */
export function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}
