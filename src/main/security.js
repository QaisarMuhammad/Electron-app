'use strict';

/**
 * The security model of the desktop shell (SPEC 6.1, 6.3 and 12): which web origins are trusted,
 * which IPC senders may call the main process, what a page may navigate to or open, and which
 * browser permissions it may use.
 *
 * Rules that hold for every decision in this file:
 *  - A URL is judged on the parts the WHATWG URL parser (`new URL`) returns (scheme, host, port, credentials),
 *    never by a prefix or substring test on the raw string, so `https://gadgetspos.com.evil.com`,
 *    `https://gadgetspos.com@evil.com` and `https://evilgadgetspos.com` cannot pass for `https://gadgetspos.com`.
 *    A wildcard compares whole labels of the parsed host.
 *  - The string handed to the parser must already be canonical: printable ASCII, no spaces or control
 *    characters, and for http(s) a plain `host[:port]` authority (CANONICAL_ORIGIN_START). Chromium serialises
 *    every URL and origin that way, so a real caller never trips this rule, and raw Unicode, embedded line
 *    breaks, encoded hosts and empty userinfo are refused before they can reach a parser quirk.
 *  - Everything fails closed: an unparseable value, a missing frame, a getter that throws, all mean "no".
 *
 * Pure Node: no Electron import. `src/main/index.js` and the window factories hand the real objects in.
 */

const nodePath = require('node:path');
const { performance } = require('node:perf_hooks');
const { fileURLToPath } = require('node:url');

const { isSharedSuffix } = require('./sharedSuffixes');

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/**
 * Origins the shop software itself runs on (SPEC 12). `*.` matches subdomains of any depth and never the bare
 * domain, so `gadgetspos.com` is listed as well; `societyfiles.com` is not: only its subdomains (the vendor application runs on
 * `vendor.societyfiles.com`) are trusted, the bare domain is not.
 */
const BUILT_IN_ORIGINS = Object.freeze([
  'https://gadgetspos.com',
  'https://*.gadgetspos.com',
  'https://*.societyfiles.com',
]);

/**
 * Provider hops (SPEC 12). The main frame may NAVIGATE to these hosts, and follow redirects between them and the
 * allowed origins, so "Connect with Square" completes inside the app, in the signed-in session. They are never part
 * of `isAllowedOrigin`: they never receive `window.electron`, are never trusted IPC senders and get no permissions.
 * The bare domains are listed as well as the subdomains: a provider's login or consent page may be served from the
 * apex domain, and a navigation-only origin carries no privileges, so the wider list costs nothing.
 */
const NAVIGATION_ONLY_ORIGINS = Object.freeze([
  'https://squareup.com',
  'https://*.squareup.com',
  'https://squareupsandbox.com',
  'https://*.squareupsandbox.com',
]);

/** Unpackaged development builds additionally trust the local dev servers, on any port (SPEC 12). */
const DEV_ORIGINS = Object.freeze(['http://localhost:*', 'http://127.0.0.1:*']);

/** The only browser permissions an allowed origin may use (SPEC 12). Everything else is denied. */
const ALLOWED_PERMISSIONS = Object.freeze([
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write',
  'media',
  'window-management',
]);
const ALLOWED_PERMISSION_SET = new Set(ALLOWED_PERMISSIONS);

/**
 * Web preferences pinned onto every window a page opens (SPEC 12). They are applied AFTER whatever the window
 * factory supplies, so a factory can add a preload but can never weaken these.
 */
const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
});

/**
 * The native window options of a window a page opens with `window.open` (SPEC 12). The page may choose its SIZE (`width` and
 * `height`, validated by `sizeFromFeatures`) and nothing else about the window.
 *
 * Why this table exists: Electron builds the options of a popup as
 * `{ show: true, width: 800, height: 600, ...whatTheFeaturesStringAskedFor, ...overrideBrowserWindowOptions }`, and turns every
 * `key=value` of the page's `features` string into an option. Without an entry here, `window.open(url, '_blank',
 * 'alwaysOnTop=yes,kiosk=yes,closable=no,frame=no,opacity=0.05,x=-5000')` gives a popup that sits above the till, covers the whole
 * screen, cannot be closed or moved, or cannot be seen: a spoofed "enter the manager password" window the cashier cannot get rid
 * of. A third-party frame inside the POS page gets the same popup, because the opener is judged by the main frame.
 *
 * Every option of Electron's `BrowserWindowConstructorOptions` is named here, with the value of an ordinary window or `undefined`
 * (Electron's own default); the app's own options (`webPreferences`, `autoHideMenuBar`, the factory's `icon`) are applied on top.
 * tests/security/popup-options.test.js reads the option names from electron.d.ts, so an option that a newer Electron adds fails
 * that test until it has been added here.
 */
const PINNED_POPUP_OPTIONS = Object.freeze({
  // Where the window is and whether it is there at all.
  show: true,
  x: undefined,
  y: undefined,
  center: false,
  enableLargerThanScreen: false,
  skipTaskbar: false,
  hiddenInMissionControl: false,
  alwaysOnTop: false,
  type: undefined,
  parent: undefined,
  modal: false,
  // How big it may be: the size is the page's to ask for, and only through `width` and `height`.
  minWidth: undefined,
  minHeight: undefined,
  maxWidth: undefined,
  maxHeight: undefined,
  useContentSize: false,
  // Full screen and kiosk: a page must not cover the whole screen.
  fullscreen: false,
  fullscreenable: true,
  simpleFullscreen: false,
  kiosk: false,
  // What the cashier can do with it: close, move, resize, switch to it.
  closable: true,
  movable: true,
  resizable: true,
  minimizable: true,
  maximizable: true,
  focusable: true,
  acceptFirstMouse: false,
  // What it looks like: a native frame that says this is a window of a web page, fully opaque.
  frame: true,
  thickFrame: true,
  titleBarStyle: 'default',
  titleBarOverlay: false,
  trafficLightPosition: undefined,
  transparent: false,
  opacity: 1,
  hasShadow: true,
  roundedCorners: true,
  backgroundColor: undefined,
  backgroundMaterial: undefined,
  vibrancy: undefined,
  visualEffectState: undefined,
  darkTheme: undefined,
  title: undefined,
  icon: undefined,
  // Behaviour that belongs to the app, not to a page.
  disableAutoHideCursor: false,
  tabbingIdentifier: undefined,
  zoomToPageWidth: false,
  paintWhenInitiallyHidden: true,
  // Options Electron added after 32 (checked against Electron 45): a popup of a page gets Electron's default for each, never a page's value.
  accentColor: undefined,
  appShim: undefined,
  name: undefined,
  windowStatePersistence: undefined,
});

/** Schemes `shell.openExternal` may be given (SPEC 12). Everything else is silently denied. */
const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:']);

/** Printable ASCII without the space: the only characters a canonical URL or origin string contains. */
const NON_CANONICAL = /[^\x21-\x7e]/;

/**
 * The start of a canonical http(s) URL or origin as Chromium serialises it: `scheme://host[:port]` followed by
 * nothing, `/`, `?` or `#`. The authority (capture group 1) may hold only letters, digits, `.`, `-`, `_`, `:` and
 * IPv6 brackets, so `@` (userinfo, even an empty one), `%` (an encoded host), `\` and `*` are refused before the
 * parser sees them.
 */
const CANONICAL_ORIGIN_START = /^https?:\/\/([a-z0-9._:[\]-]+)(?:[/?#]|$)/i;

/** A host that ends in a dot, with or without a port. The parser would drop it from an IP address (`127.0.0.1.`). */
const TRAILING_DOT_HOST = /\.(?::\d*)?$/;

/** Upper bounds that keep hostile input cheap to reject. */
const MAX_EXTERNAL_URL_LENGTH = 8192;
const MAX_PATTERN_LENGTH = 255;
const MAX_EXTRA_ORIGINS = 100;
const MAX_WINDOW_SIZE = 10000;

/**
 * How much a page may make the app open (SPEC 12): popup windows and tabs of the system browser share one budget. A web page gets
 * 3 of them per 10 seconds from one webContents and 20 per minute from all of them together; the rest are refused. A cashier's
 * clicks stay far below this, a script that loops `window.open` or assigns `location` in a loop does not.
 */
const OPEN_LIMITS = Object.freeze({ perContents: 3, perContentsMs: 10 * 1000, overall: 20, overallMs: 60 * 1000 });

// ---------------------------------------------------------------------------------------------
// URL and origin pattern helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} input
 * @returns {URL|null} the parsed URL, or null when `input` is not a canonical absolute URL
 */
function parseCanonicalUrl(input) {
  if (typeof input !== 'string' || input === '' || NON_CANONICAL.test(input)) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * @param {string} hostname hostname as serialised by the URL parser
 * @returns {boolean} false for an empty host, a trailing dot, a leading dot or an empty label (`a..b`)
 */
function hasValidLabels(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  if (hostname.startsWith('[')) return true; // IPv6 literal
  return hostname.split('.').every((label) => label.length > 0);
}

/**
 * @param {string} hostname hostname as serialised by the URL parser
 * @returns {boolean} true for an IPv6 literal or a dotted IPv4 address
 */
function isIpHost(hostname) {
  return hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * One entry of an allow-list: an exact origin or a wildcard host.
 *
 * @typedef {Object} OriginPattern
 * @property {'https:'|'http:'} protocol
 * @property {string} hostname exact host, or the domain after `*.` for a wildcard
 * @property {boolean} wildcard true when the entry started with `*.` (subdomains only, never the bare domain)
 * @property {string} port '' = the scheme's default port, '*' = any port, otherwise the digits
 * @property {string} text canonical text form of the entry
 */

/**
 * Reads one allow-list entry as written in Settings > Connection or in a constant of this file.
 *
 * Accepted: `https://shop.example.com`, `shop.example.com` (https assumed), `https://shop.example.com:8443`,
 * `*.example.com`, `https://*.example.com`, and with an explicit `:*` any port (`http://localhost:*`).
 * Refused (null): anything with a path, query, fragment or credentials, a scheme other than http/https, a
 * wildcard anywhere but the first label, a wildcard over a single label (`*.com`) or an IP address, and empty
 * labels. Settings uses it to validate what the manager types, so the same grammar applies at runtime.
 *
 * @param {unknown} entry
 * @returns {OriginPattern|null}
 */
function parseOriginPattern(entry) {
  if (typeof entry !== 'string') return null;
  let rest = entry.trim();
  if (rest === '' || rest.length > MAX_PATTERN_LENGTH || NON_CANONICAL.test(rest)) return null;

  let protocol = 'https:';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    protocol = `${scheme[1].toLowerCase()}:`;
    rest = rest.slice(scheme[0].length);
  }
  if (protocol !== 'https:' && protocol !== 'http:') return null;

  rest = rest.replace(/\/$/, '');
  if (/[/?#@\\]/.test(rest)) return null;

  const wildcard = rest.startsWith('*.');
  if (wildcard) rest = rest.slice(2);
  const anyPort = rest.endsWith(':*');
  if (anyPort) rest = rest.slice(0, -2);
  if (rest === '' || rest.includes('*')) return null;

  let url;
  try {
    url = new URL(`${protocol}//${rest}`);
  } catch {
    return null;
  }
  const hostname = url.hostname;
  if (!hasValidLabels(hostname)) return null;
  if (wildcard && (isIpHost(hostname) || hostname.split('.').length < 2)) return null;

  const port = anyPort ? '*' : url.port;
  const portText = port === '*' ? ':*' : port ? `:${port}` : '';
  return { protocol, hostname, wildcard, port, text: `${protocol}//${wildcard ? '*.' : ''}${hostname}${portText}` };
}

/**
 * @param {unknown} value the configured `serverUrl`
 * @returns {OriginPattern|null} the exact origin of the URL (its own port included), or null when unusable
 */
function patternFromServerUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !hasValidLabels(url.hostname)) return null;
  return { protocol: url.protocol, hostname: url.hostname, wildcard: false, port: url.port, text: url.origin };
}

/**
 * @param {URL} url
 * @param {OriginPattern} pattern
 * @returns {boolean} true when scheme, port and host all match; a wildcard needs at least one extra label
 */
function matchesPattern(url, pattern) {
  if (url.protocol !== pattern.protocol) return false;
  if (pattern.port !== '*' && url.port !== pattern.port) return false;
  if (pattern.wildcard) {
    return url.hostname.length > pattern.hostname.length + 1 && url.hostname.endsWith(`.${pattern.hostname}`);
  }
  return url.hostname === pattern.hostname;
}

/**
 * @param {unknown} entries
 * @param {boolean} allowHttp keep `http:` entries (development builds only)
 * @param {(pattern: OriginPattern) => void} [onSharedSuffix] told about every wildcard over a public suffix or a shared hosting
 *   domain (`*.co.uk`, `*.github.io`), which is dropped: it would trust every site anybody has on that domain
 * @returns {OriginPattern[]} the usable entries; unusable ones are dropped, never thrown
 */
function compilePatterns(entries, allowHttp, onSharedSuffix) {
  if (!Array.isArray(entries)) return [];
  const patterns = [];
  for (const entry of entries.slice(0, MAX_EXTRA_ORIGINS)) {
    const pattern = parseOriginPattern(entry);
    if (!pattern || (pattern.protocol !== 'https:' && !allowHttp)) continue;
    if (pattern.wildcard && isSharedSuffix(pattern.hostname)) {
      if (onSharedSuffix) onSharedSuffix(pattern);
      continue;
    }
    patterns.push(pattern);
  }
  return patterns;
}

/**
 * The shared origin test.
 *
 * @param {unknown} input an origin or a URL
 * @param {OriginPattern[]} patterns
 * @param {boolean} allowHttp whether `http:` may match (development builds only)
 * @returns {boolean}
 */
function matchesOrigin(input, patterns, allowHttp) {
  const start = typeof input === 'string' ? CANONICAL_ORIGIN_START.exec(input) : null;
  if (!start || TRAILING_DOT_HOST.test(start[1])) return false;
  const url = parseCanonicalUrl(input);
  if (!url) return false;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return false;
  if (url.username !== '' || url.password !== '') return false;
  if (!hasValidLabels(url.hostname)) return false;
  return patterns.some((pattern) => matchesPattern(url, pattern));
}

const NAVIGATION_ONLY_PATTERNS = compilePatterns(NAVIGATION_ONLY_ORIGINS, false);

/**
 * @param {unknown} input
 * @returns {boolean} true for a `https:` URL on one of the provider hosts of NAVIGATION_ONLY_ORIGINS
 */
function isNavigationOnlyOrigin(input) {
  return matchesOrigin(input, NAVIGATION_ONLY_PATTERNS, false);
}

/**
 * Whether a URL may be handed to `shell.openExternal` (SPEC 12): `https:`, `mailto:` and `tel:` only.
 * An https URL must be in canonical `https://host[:port]/...` form: a host, no credentials (not even an empty
 * `@`), no encoded host. Anything else (`http:`, `javascript:`, `file:`, `data:`, `ms-msdt:` and every other
 * protocol handler) is refused.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
function isSafeExternalUrl(input) {
  if (typeof input === 'string' && input.length > MAX_EXTERNAL_URL_LENGTH) return false;
  const url = parseCanonicalUrl(input);
  if (!url || !SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  if (url.protocol === 'https:') {
    return CANONICAL_ORIGIN_START.test(input) && url.hostname !== '' && url.username === '' && url.password === '';
  }
  return true;
}

/**
 * Whether a URL is one of the app's own local pages: a `file:` URL strictly INSIDE `rendererDir`, after the URL
 * parser and `path.resolve` have removed every `..`. The query string and hash are ignored (the offline page URL
 * carries a query). The directory itself, a sibling that merely starts with the same letters
 * (`renderer-evil`), another drive, and a UNC share all fail. Percent-encoded separators make Node throw, which
 * also fails.
 *
 * @param {unknown} url
 * @param {unknown} rendererDir absolute path of `src/renderer`
 * @param {{ platform?: string }} [options] path rules to apply; defaults to the running platform
 * @returns {boolean}
 */
function isLocalPageUrl(url, rendererDir, { platform = process.platform } = {}) {
  if (typeof rendererDir !== 'string' || rendererDir === '') return false;
  const parsed = parseCanonicalUrl(url);
  if (!parsed || parsed.protocol !== 'file:') return false;

  const windows = platform === 'win32';
  const pathApi = windows ? nodePath.win32 : nodePath.posix;
  if (!pathApi.isAbsolute(rendererDir)) return false;

  let filePath;
  try {
    filePath = fileURLToPath(parsed, { windows });
  } catch {
    return false;
  }
  if (filePath.includes('\u0000')) return false;
  const relative = pathApi.relative(pathApi.resolve(rendererDir), pathApi.resolve(filePath));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

/**
 * @param {unknown} input
 * @returns {boolean} true for `about:blank` (a fragment or query on it does not change what it is)
 */
function isAboutBlank(input) {
  const url = parseCanonicalUrl(input);
  return url !== null && url.protocol === 'about:' && url.pathname === 'blank';
}

/**
 * @param {unknown} input the address a window was opened for
 * @returns {boolean} true for an http or https address (a page of the software): such a window fills the screen. `about:blank` and
 *   `blob:` documents (receipts, PDFs, print previews) are not web addresses and keep the size their page asked for.
 */
function isWebAddress(input) {
  const url = parseCanonicalUrl(input);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
}

/**
 * @param {unknown} features the `features` string of `window.open`
 * @returns {{ width?: number, height?: number }} the sizes the page asked for
 */
function sizeFromFeatures(features) {
  const size = {};
  if (typeof features !== 'string') return size;
  for (const match of features.matchAll(/(?:^|[,;\s])(width|height)\s*=\s*(\d+)/gi)) {
    const value = Number.parseInt(match[2], 10);
    if (value > 0) size[match[1].toLowerCase()] = Math.min(value, MAX_WINDOW_SIZE);
  }
  return size;
}

/**
 * Calls a hook that belongs to someone else and must never break a security decision.
 *
 * @param {Function|undefined} hook
 * @param {...unknown} args
 */
function callHook(hook, ...args) {
  if (typeof hook !== 'function') return;
  try {
    hook(...args);
  } catch {
    // A failing log or notice must not change the outcome of the guard that called it.
  }
}

/**
 * @param {unknown} url
 * @returns {{ protocol: string, host: string }} the parts of a URL that are safe to log (no path, no query)
 */
function describeUrl(url) {
  const parsed = parseCanonicalUrl(url);
  return parsed ? { protocol: parsed.protocol, host: parsed.host } : { protocol: '', host: '' };
}

/**
 * The rate limit of OPEN_LIMITS. `forContents()` gives the budget of one webContents; every budget also draws on the one shared
 * count of the whole app. Only what was allowed counts, so a refused attempt never extends the wait.
 *
 * @param {() => number} now a clock in milliseconds that only moves forward
 * @returns {{ forContents: () => { take: () => { allowed: boolean, firstRefusal: boolean } } }}
 *   `take()` asks for one popup or system-browser open; `firstRefusal` is true for the first refusal of a burst, so a loop of
 *   hundreds of calls is logged once (the next allowed call starts a new burst)
 */
function createOpenBudget(now) {
  const overall = [];
  const expire = (stamps, windowMs, at) => {
    while (stamps.length > 0 && at - stamps[0] >= windowMs) stamps.shift();
  };
  return {
    forContents() {
      const own = [];
      let refused = false;
      return {
        take() {
          const at = now();
          expire(own, OPEN_LIMITS.perContentsMs, at);
          expire(overall, OPEN_LIMITS.overallMs, at);
          if (own.length >= OPEN_LIMITS.perContents || overall.length >= OPEN_LIMITS.overall) {
            const firstRefusal = !refused;
            refused = true;
            return { allowed: false, firstRefusal };
          }
          refused = false;
          own.push(at);
          overall.push(at);
          return { allowed: true, firstRefusal: false };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The security object
// ---------------------------------------------------------------------------------------------

/**
 * Details of something the guards refused. Do not log `url` as a whole (a query string can carry a token): log
 * `protocol` and `host`.
 *
 * @typedef {Object} BlockedInfo
 * @property {'will-navigate'|'will-redirect'|'window-open'} source
 * @property {string} reason 'unsafe-url' | 'opener-not-allowed' | 'no-opener' | 'external-failed' | 'rate-limited' | 'error'
 * @property {string} url
 * @property {string} protocol
 * @property {string} host
 */

/**
 * @typedef {Object} GuardHooks
 * @property {(url: string) => (void|Promise<void>)} [openExternal] sends a URL to the system browser; only ever
 *   called with a URL that passed `isSafeExternalUrl`
 * @property {(info: BlockedInfo) => void} [onBlocked] called for everything that was silently denied
 * @property {(message: string) => void} [notify] shows the one-line native notice "Opened in your browser: <host>"
 * @property {(details: object) => object} [createChildWindow] returns the `BrowserWindow` options for a window a
 *   page opened (the app preload and the secure web preferences of the main window, passed explicitly). The
 *   secure flags of SECURE_WEB_PREFERENCES are forced on top of the result, every other window option is pinned
 *   (PINNED_POPUP_OPTIONS), and `width`/`height` come from the page's `window.open` features only.
 */

/**
 * @param {Object} options
 * @param {(() => object|null|undefined)|object|null} [options.getConfig] returns the config (`get(path, fallback)`
 *   or a plain snapshot with `serverUrl` and `extraAllowedOrigins`); `null`/failing means "defaults"
 * @param {boolean|(() => boolean)} [options.isPackaged] production build; the default is the strict `true`
 * @param {string[]} [options.devOrigins] extra origins trusted only when unpackaged; default DEV_ORIGINS
 * @param {string} [options.rendererDir] absolute path of `src/renderer`, needed for `isTrustedSender` on local pages
 * @param {() => number} [options.now] clock for the open rate limit (OPEN_LIMITS); default `performance.now()`, which only moves forward
 * @param {{ warn?: Function }} [options.log] told once about each allowed-domain entry that is ignored (a wildcard over a shared suffix)
 * @returns {{
 *   isAllowedOrigin: (url: unknown) => boolean,
 *   isNavigationOnlyOrigin: (url: unknown) => boolean,
 *   isAllowedWindowTarget: (url: unknown) => boolean,
 *   isSafeExternalUrl: (url: unknown) => boolean,
 *   isLocalPageUrl: (url: unknown, rendererDir?: string) => boolean,
 *   isTrustedSender: (event: object, registry: object|undefined, area: string) => boolean,
 *   attachGuards: (webContents: object, hooks?: GuardHooks) => void,
 *   configureSession: (session: object) => void
 * }}
 */
function createSecurity({ getConfig, isPackaged = true, devOrigins = DEV_ORIGINS, rendererDir, now = () => performance.now(), log } = {}) {
  const packaged = () => (typeof isPackaged === 'function' ? Boolean(isPackaged()) : Boolean(isPackaged));
  const openBudget = createOpenBudget(now);
  const reportedSuffixes = new Set();

  /** An entry of `extraAllowedOrigins` that is ignored because it would trust every site on a shared domain: said once, by name. */
  function reportSharedSuffix(pattern) {
    if (reportedSuffixes.has(pattern.text)) return;
    reportedSuffixes.add(pattern.text);
    callHook(log && log.warn && log.warn.bind(log), `security: the allowed domain ${pattern.text} is ignored: it would trust every website on ${pattern.hostname}`);
  }

  /** @returns {unknown} one config value, or `fallback` while the config is missing, loading or broken */
  function readSetting(key, fallback) {
    try {
      const config = typeof getConfig === 'function' ? getConfig() : getConfig;
      if (!config) return fallback;
      const value = typeof config.get === 'function' ? config.get(key, fallback) : config[key];
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  // The compiled allow-list is rebuilt only when serverUrl, extraAllowedOrigins or the build type change, so a
  // value edited in Settings is seen by the very next check while a busy IPC channel does not re-parse every call.
  let cache = { key: null, patterns: [] };

  /** @returns {OriginPattern[]} */
  function allowedPatterns() {
    const production = packaged();
    const serverUrl = readSetting('serverUrl', '');
    const extra = readSetting('extraAllowedOrigins', []);
    const key = [production ? 'production' : 'development', String(serverUrl), ...(Array.isArray(extra) ? extra.map(String) : [])].join('\n');
    if (cache.key !== key) {
      const patterns = compilePatterns(BUILT_IN_ORIGINS, false);
      const server = patternFromServerUrl(serverUrl);
      if (server && (server.protocol === 'https:' || !production)) patterns.push(server);
      patterns.push(...compilePatterns(extra, !production, reportSharedSuffix));
      if (!production) patterns.push(...compilePatterns(devOrigins, true));
      cache = { key, patterns };
    }
    return cache.patterns;
  }

  /**
   * SPEC 12: https only in production; the origin of `serverUrl`, gadgetspos.com and its subdomains, the subdomains of
   * societyfiles.com, the entries of `extraAllowedOrigins` (but not a wildcard over a public suffix or a shared hosting domain,
   * such as `*.co.uk` or `*.github.io`), and in development the local dev servers. Userinfo,
   * non-default ports (unless an entry names them), trailing dots, look-alike hosts and every other scheme
   * (`blob:`, `data:`, `file:`, `javascript:`, `about:`) are refused; so is the string `'null'` (an opaque origin).
   *
   * @param {unknown} input an origin (`frame.origin`) or a URL
   * @returns {boolean}
   */
  function isAllowedOrigin(input) {
    return matchesOrigin(input, allowedPatterns(), !packaged());
  }

  /**
   * @param {unknown} url
   * @returns {boolean} true for `blob:<origin>/<id>` whose embedded origin is allowed; the embedded part is judged
   *   as a URL of its own, so credentials inside it (which the blob origin silently drops) fail
   */
  function isBlobOfAllowedOrigin(url) {
    const parsed = parseCanonicalUrl(url);
    return parsed !== null && parsed.protocol === 'blob:' && isAllowedOrigin(parsed.pathname);
  }

  /**
   * Whether `window.open` may create a window for this URL (SPEC 12): an allowed origin, `about:blank`, or a
   * `blob:` URL whose origin is allowed. For `about:blank` the opener is checked separately by the guard.
   *
   * @param {unknown} url
   * @returns {boolean}
   */
  function isAllowedWindowTarget(url) {
    return isAboutBlank(url) || isBlobOfAllowedOrigin(url) || isAllowedOrigin(url);
  }

  /**
   * What the main frame may navigate to (and be redirected to): an allowed origin, a provider hop, or a blob of
   * an allowed origin (pdfMake assigns a blob URL to `location.href`). Local `file:` pages are never reached by
   * navigation: the app loads them itself, which does not raise `will-navigate`.
   *
   * @param {unknown} url
   * @returns {boolean}
   */
  function isNavigationAllowed(url) {
    return isAllowedOrigin(url) || isNavigationOnlyOrigin(url) || isBlobOfAllowedOrigin(url);
  }

  /**
   * SPEC 12. The sender must be the main frame. `senderFrame === sender.mainFrame` is the fast path;
   * `senderFrame.parent === null` is the authoritative test (distinct WebFrameMain objects can be one frame).
   *
   *  - `area === 'remote'`: the frame ORIGIN (never `location.origin`) must pass `isAllowedOrigin`.
   *  - any other `area` (`settings`, `connection`, `window`, `password`) or `'local'` (any registered window): the
   *    sender's webContents id must be registered with that area AND the frame must be a `file:` page inside
   *    `rendererDir`. So even though `local.js` exposes the whole API in two windows, main enforces the area.
   *
   * The frame is read inside try/catch because a disposed frame throws: any throw means untrusted.
   *
   * @param {{ sender?: { id: number, mainFrame?: object, isDestroyed?: () => boolean },
   *           senderFrame?: { origin: string, url: string, parent: object|null } }} event an IPC event
   * @param {Map<number, Iterable<string>>|{ get: (id: number) => (Iterable<string>|undefined), rendererDir?: string }|undefined} registry
   *   webContents id -> the areas that window may call; ignored for `'remote'`
   * @param {string} area
   * @returns {boolean}
   */
  function isTrustedSender(event, registry, area) {
    try {
      const sender = event && event.sender;
      const frame = event && event.senderFrame;
      if (!sender || !frame) return false;
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false;
      if (frame !== sender.mainFrame && frame.parent !== null) return false;

      if (area === 'remote') return isAllowedOrigin(frame.origin);

      const areas = registry && typeof registry.get === 'function' ? registry.get(sender.id) : undefined;
      if (!areas) return false;
      const allowed = new Set(areas);
      if (allowed.size === 0 || (area !== 'local' && !allowed.has(area))) return false;
      return isLocalPageUrl(frame.url, rendererDir || (registry && registry.rendererDir));
    } catch {
      return false;
    }
  }

  /**
   * Installs the guards of SPEC 12 on one webContents: `will-navigate`, `will-redirect` and the window-open
   * handler. `src/main/index.js` calls this for EVERY webContents through `app.on('web-contents-created')`.
   *
   * - Main-frame navigation or redirect to an origin that is neither allowed nor a provider hop is cancelled; an
   *   https, mailto or tel link goes to the system browser instead (https also shows the "Opened in your
   *   browser: <host>" notice), everything else is denied. Sub-frames (embedded widgets) are left alone.
   * - `window.open`: an allowed origin, `about:blank` from a page on an allowed origin, or a blob URL of an
   *   allowed origin gets a real window (the opener needs a WindowProxy: pdfMake and `document.write` popups) that is an
   *   ordinary window of the page's chosen size (PINNED_POPUP_OPTIONS); any other URL is handled like a navigation, then denied.
   * - A page gets only so many popups and system-browser opens in a row (OPEN_LIMITS); the rest are refused and logged once per burst.
   *
   * Never throws into Electron: an error inside a guard fails closed.
   *
   * @param {{ on: Function, setWindowOpenHandler: Function, mainFrame?: { origin: string }, getURL?: () => string }} webContents
   * @param {GuardHooks} [hooks]
   */
  function attachGuards(webContents, hooks = {}) {
    const { openExternal, onBlocked, notify, createChildWindow } = hooks;
    const budget = openBudget.forContents();

    /** @param {BlockedInfo['source']} source @param {string} reason @param {unknown} url */
    function deny(source, reason, url) {
      callHook(onBlocked, { source, reason, url: typeof url === 'string' ? url : '', ...describeUrl(url) });
    }

    /** Sends a URL that passed `isSafeExternalUrl` to the system browser. */
    function sendToBrowser(source, url) {
      if (typeof openExternal !== 'function') {
        deny(source, 'no-opener', url);
        return;
      }
      try {
        const pending = openExternal(url);
        if (pending && typeof pending.catch === 'function') pending.catch(() => deny(source, 'external-failed', url));
      } catch {
        deny(source, 'external-failed', url);
        return;
      }
      const target = new URL(url);
      if (target.protocol === 'https:') callHook(notify, `Opened in your browser: ${target.hostname}`);
    }

    /**
     * Asks for one of the few popups or system-browser opens a page gets (OPEN_LIMITS). A refusal is reported once per burst, with the
     * host only: the address of a page that loops is no business of the log.
     *
     * @param {BlockedInfo['source']} source
     * @param {string} url
     * @returns {boolean} whether the page may open it now
     */
    function mayOpen(source, url) {
      const turn = budget.take();
      if (!turn.allowed && turn.firstRefusal) callHook(onBlocked, { source, reason: 'rate-limited', url: '', ...describeUrl(url) });
      return turn.allowed;
    }

    /** What happens to something the app will not show itself. */
    function refuse(source, url) {
      if (!isSafeExternalUrl(url)) deny(source, 'unsafe-url', url);
      else if (mayOpen(source, url)) sendToBrowser(source, url);
    }

    /** @returns {boolean} whether the page that is opening a window is on an allowed origin */
    function isOpenerAllowed() {
      const frame = webContents.mainFrame;
      if (frame && typeof frame.origin === 'string') return isAllowedOrigin(frame.origin);
      return typeof webContents.getURL === 'function' && isAllowedOrigin(webContents.getURL());
    }

    /** @param {BlockedInfo['source']} source */
    function guardNavigation(source) {
      return (event, ...legacy) => {
        try {
          // Electron 25+ puts url/isMainFrame on the event; older positional arguments are the fallback.
          const url = typeof event.url === 'string' ? event.url : legacy[0];
          const isMainFrame = typeof event.isMainFrame === 'boolean' ? event.isMainFrame : legacy[2] !== false;
          if (!isMainFrame) return;
          if (isNavigationAllowed(url)) return;
          event.preventDefault();
          refuse(source, url);
        } catch {
          try {
            event.preventDefault();
          } catch {
            // Nothing more can be done for an event that cannot be cancelled.
          }
          deny(source, 'error', '');
        }
      };
    }

    /**
     * The options of a window the page opens. Electron merges them over what the page's `features` string asked for, so the
     * pinned table comes first: it names every window option, the factory's own options (the app preload, the icon) replace the
     * entries they name, and only the size is taken from the page.
     *
     * @param {object} details the `setWindowOpenHandler` details
     */
    function childWindowOptions(details) {
      const base = (typeof createChildWindow === 'function' && createChildWindow(details)) || {};
      // The size is the page's to ask for (`width`/`height` features), not the main window's to hand down.
      const options = { ...base };
      delete options.width;
      delete options.height;
      return {
        ...PINNED_POPUP_OPTIONS,
        ...options,
        ...sizeFromFeatures(details.features),
        autoHideMenuBar: true,
        webPreferences: { ...base.webPreferences, ...SECURE_WEB_PREFERENCES },
      };
    }

    webContents.on('will-navigate', guardNavigation('will-navigate'));
    webContents.on('will-redirect', guardNavigation('will-redirect'));

    // A window opened for a real web address (the dashboard from the POS screen, a report, an image) fills the screen like the main
    // window does, instead of Electron's small 800 x 600 default. A blank or blob document (a receipt, a PDF, a print preview) keeps the
    // size its page asked for. The app's own windows (Settings, the password prompt) are not made by `window.open` and are not touched.
    // `maximize()` keeps the window an ordinary one: the cashier can still restore it, move it and close it.
    webContents.on('did-create-window', (childWindow, details) => {
      try {
        if (!isWebAddress(details && details.url)) return;
        if (childWindow && typeof childWindow.maximize === 'function') childWindow.maximize();
      } catch {
        // The window simply stays the size it was opened with.
      }
    });

    webContents.setWindowOpenHandler((details) => {
      try {
        const url = details && details.url;
        if (isAllowedWindowTarget(url)) {
          if (isAboutBlank(url) && !isOpenerAllowed()) {
            deny('window-open', 'opener-not-allowed', url);
            return { action: 'deny' };
          }
          if (!mayOpen('window-open', url)) return { action: 'deny' };
          return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions(details) };
        }
        refuse('window-open', url);
      } catch {
        deny('window-open', 'error', '');
      }
      return { action: 'deny' };
    });
  }

  /**
   * SPEC 12: a page gets a permission only when the permission is in ALLOWED_PERMISSIONS and the requesting frame
   * is on an allowed origin. Both the request handler and the check handler are set: most web APIs check first and
   * only then request, and Electron grants a check by default when no handler exists. No certificate-error
   * bypass is ever installed.
   *
   * @param {{ setPermissionRequestHandler: Function, setPermissionCheckHandler: Function }} session
   */
  function configureSession(session) {
    const decide = (permission, origin) => ALLOWED_PERMISSION_SET.has(permission) && isAllowedOrigin(origin);

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      let granted = false;
      try {
        const origin = (details && details.requestingUrl) || (webContents && webContents.getURL && webContents.getURL());
        granted = decide(permission, origin);
      } catch {
        granted = false;
      }
      callback(granted);
    });

    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      try {
        return decide(permission, requestingOrigin || (details && details.requestingUrl));
      } catch {
        return false;
      }
    });
  }

  return {
    isAllowedOrigin,
    isNavigationOnlyOrigin,
    isAllowedWindowTarget,
    isSafeExternalUrl,
    isLocalPageUrl: (url, dir = rendererDir) => isLocalPageUrl(url, dir),
    isTrustedSender,
    attachGuards,
    configureSession,
  };
}

module.exports = {
  createSecurity,
  parseOriginPattern,
  isSafeExternalUrl,
  isLocalPageUrl,
  BUILT_IN_ORIGINS,
  NAVIGATION_ONLY_ORIGINS,
  DEV_ORIGINS,
  ALLOWED_PERMISSIONS,
  SECURE_WEB_PREFERENCES,
  PINNED_POPUP_OPTIONS,
  OPEN_LIMITS,
};
