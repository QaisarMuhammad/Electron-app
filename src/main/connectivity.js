'use strict';

/**
 * Connection recovery (SPEC 8, 11.2, 11.3): decide why a load failed, probe the server with exponential backoff
 * while it is unreachable, and tell the window when it is back.
 *
 *  - `classifyLoadFailure` / `httpStatusToReason`  the failure table of SPEC 11.2.
 *  - `createConnectivity`                          the retry controller. It runs ONLY while something is wrong
 *                                                  (R3: no timer exists while the POS is healthy).
 *  - `createNetProbe`                              the default probe: a HEAD request through Electron's `net`.
 *  - `createRequestErrorMonitor`                   the mid-session trigger of SPEC 11.3: two failed requests from
 *                                                  different requests within 10 s start the controller in
 *                                                  `'banner'` mode.
 *
 * Pure Node: Electron's `net`, the timers, the clock and the random source are all injected, so every part runs
 * under plain `node --test` with fakes (tests/helpers/fake-net.js).
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Base delay before each retry (SPEC 11.2). The last step repeats for as long as the outage lasts. */
const BACKOFF_STEPS_MS = Object.freeze([3000, 6000, 12000, 24000, 30000]);

/** Every delay is spread by +-20 % so a street of tills does not retry in the same second. */
const JITTER_RATIO = 0.2;

/** A probe that gets no answer for this long counts as a timeout. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** The values of `reason` (SPEC 6.2). */
const REASONS = Object.freeze(['offline', 'dns', 'refused', 'timeout', 'tls', 'server', 'other']);
const REASON_SET = new Set(REASONS);

/**
 * Chromium net error name (without `ERR_`) -> code. From `net/base/net_error_list.h`; every name was checked
 * against the table compiled into Electron 32.3.3 (`net::ErrorToShortString`, which lists the names in the
 * header's order). Only the codes that matter for connectivity and the certificate family are listed.
 */
const NET_ERROR_CODES = Object.freeze({
  FAILED: -2,
  ABORTED: -3,
  TIMED_OUT: -7,
  NETWORK_CHANGED: -21,
  CONNECTION_CLOSED: -100,
  CONNECTION_RESET: -101,
  CONNECTION_REFUSED: -102,
  CONNECTION_ABORTED: -103,
  CONNECTION_FAILED: -104,
  NAME_NOT_RESOLVED: -105,
  INTERNET_DISCONNECTED: -106,
  SSL_PROTOCOL_ERROR: -107,
  ADDRESS_INVALID: -108,
  ADDRESS_UNREACHABLE: -109,
  SSL_CLIENT_AUTH_CERT_NEEDED: -110,
  TUNNEL_CONNECTION_FAILED: -111,
  SSL_VERSION_OR_CIPHER_MISMATCH: -113,
  CONNECTION_TIMED_OUT: -118,
  PROXY_CONNECTION_FAILED: -130,
  NAME_RESOLUTION_FAILED: -137,
  CERT_COMMON_NAME_INVALID: -200,
  CERT_DATE_INVALID: -201,
  CERT_AUTHORITY_INVALID: -202,
  CERT_CONTAINS_ERRORS: -203,
  CERT_NO_REVOCATION_MECHANISM: -204,
  CERT_UNABLE_TO_CHECK_REVOCATION: -205,
  CERT_REVOKED: -206,
  CERT_INVALID: -207,
  CERT_WEAK_SIGNATURE_ALGORITHM: -208,
  CERT_NON_UNIQUE_NAME: -210,
  CERT_WEAK_KEY: -211,
  CERT_NAME_CONSTRAINT_VIOLATION: -212,
  CERT_VALIDITY_TOO_LONG: -213,
  CERTIFICATE_TRANSPARENCY_REQUIRED: -214,
});
const NET_ERROR_NAMES = new Map(Object.entries(NET_ERROR_CODES).map(([name, code]) => [code, name]));

/** The certificate errors of Chromium occupy -200..-299 (SPEC 11.2: `ERR_CERT_*` => tls). */
const CERTIFICATE_CODE_MIN = -299;
const CERTIFICATE_CODE_MAX = -200;

/** SPEC 11.2, by error name. `ERR_CERT_*` and `ERR_SSL_*` are matched by prefix in `reasonFromName`. */
const REASON_BY_NAME = new Map([
  ['INTERNET_DISCONNECTED', 'offline'],
  ['NETWORK_CHANGED', 'offline'],
  ['NAME_NOT_RESOLVED', 'dns'],
  ['CONNECTION_REFUSED', 'refused'],
  ['CONNECTION_RESET', 'refused'],
  ['CONNECTION_CLOSED', 'refused'],
  ['TIMED_OUT', 'timeout'],
  ['CONNECTION_TIMED_OUT', 'timeout'],
]);

/**
 * The request errors that mean "the network is down" for the mid-session banner (SPEC 11.3). ERR_ABORTED (a page
 * cancelling its own request) and everything not listed is ignored.
 */
const BANNER_ERROR_NAMES = new Set([
  'INTERNET_DISCONNECTED',
  'NETWORK_CHANGED',
  'NAME_NOT_RESOLVED',
  'CONNECTION_REFUSED',
  'CONNECTION_RESET',
  'CONNECTION_CLOSED',
  'CONNECTION_TIMED_OUT',
  'ADDRESS_UNREACHABLE',
]);

const BANNER_WINDOW_MS = 10 * 1000;
const BANNER_ERROR_THRESHOLD = 2;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} log an electron-log style logger, or nothing
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }} a logger that never throws
 */
function createLogger(log) {
  const call = (level) => (...args) => {
    try {
      if (log && typeof log[level] === 'function') log[level](...args);
    } catch {
      // Logging must never break the code that logs.
    }
  };
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') };
}

/**
 * Lets the process exit even while the timer is pending (R3: nothing may keep the app alive).
 *
 * @template T
 * @param {T} handle a timer handle; fakes may return a plain number
 * @returns {T}
 */
function unref(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/** @param {unknown} url @returns {string} the host of a URL, safe for a log line (no path, no query) */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value a number, or a string such as '-106'
 * @returns {number|null} the integer, or null
 */
function toErrorCode(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * @param {unknown} description `ERR_NAME_NOT_RESOLVED`, `net::ERR_NAME_NOT_RESOLVED` or `NAME_NOT_RESOLVED`
 * @returns {string} the bare upper-case name (`NAME_NOT_RESOLVED`), or '' when it is not a Chromium error name
 */
function normalizeErrorName(description) {
  if (typeof description !== 'string') return '';
  const name = description.trim().replace(/^net::/i, '').replace(/^ERR_/i, '').toUpperCase();
  return /^[A-Z0-9_]+$/.test(name) ? name : '';
}

/** @param {string} name @returns {string|null} the SPEC 11.2 reason for a bare error name */
function reasonFromName(name) {
  if (REASON_BY_NAME.has(name)) return REASON_BY_NAME.get(name);
  if (/^(?:CERT|SSL_)/.test(name)) return 'tls';
  return null;
}

/** @param {number} code @returns {string|null} the SPEC 11.2 reason for a numeric net error */
function reasonFromCode(code) {
  if (code >= CERTIFICATE_CODE_MIN && code <= CERTIFICATE_CODE_MAX) return 'tls';
  const name = NET_ERROR_NAMES.get(code);
  return name ? reasonFromName(name) : null;
}

/**
 * Why did the page not load? (SPEC 11.2)
 *
 *  - offline  ERR_INTERNET_DISCONNECTED (-106), ERR_NETWORK_CHANGED (-21)
 *  - dns      ERR_NAME_NOT_RESOLVED (-105)
 *  - refused  ERR_CONNECTION_REFUSED (-102), ERR_CONNECTION_RESET (-101), ERR_CONNECTION_CLOSED (-100)
 *  - timeout  ERR_TIMED_OUT (-7), ERR_CONNECTION_TIMED_OUT (-118)
 *  - tls      ERR_CERT_* (-200..-299), ERR_SSL_* (for example ERR_SSL_PROTOCOL_ERROR, -107)
 *  - other    anything else
 *
 * The numeric code decides when it is known; the name (with or without `net::` and `ERR_`) covers the rest.
 * These pairs were also checked against real Chromium 128 (Electron 32.3.3): a closed port reports -102, a reset
 * -101, a TLS server that hangs up -100, a non-TLS answer to a TLS request -107, a self-signed certificate -202.
 *
 * @param {number|string|undefined} errorCode the `errorCode` of `did-fail-load`
 * @param {string} [errorDescription] its `errorDescription`
 * @returns {{ reason: 'offline'|'dns'|'refused'|'timeout'|'tls'|'other' }}
 */
function classifyLoadFailure(errorCode, errorDescription) {
  const code = toErrorCode(errorCode);
  const reason =
    (code !== null ? reasonFromCode(code) : null) || reasonFromName(normalizeErrorName(errorDescription)) || 'other';
  return { reason };
}

/**
 * @param {number|string|null|undefined} status the HTTP status of the main-frame navigation to `serverUrl`
 * @returns {'server'|null} 'server' for a status of 500 or more (SPEC 11.2), otherwise null (not a failure)
 */
function httpStatusToReason(status) {
  const code = typeof status === 'string' && status.trim() !== '' ? Number(status) : status;
  return typeof code === 'number' && Number.isFinite(code) && code >= 500 ? 'server' : null;
}

/**
 * Turns whatever a failed request reports into the `{ code, description }` shape of SPEC 6.2.
 *
 * @param {unknown} input an Error whose message is `net::ERR_X`, the string `net::ERR_X`, or `{ code, description }`
 * @returns {{ code: number|null, description: string }} `description` is `ERR_X` when the name is known
 */
function describeNetError(input) {
  if (input && typeof input === 'object' && !(input instanceof Error) && ('code' in input || 'description' in input)) {
    const code = toErrorCode(input.code);
    const name = code !== null ? NET_ERROR_NAMES.get(code) : undefined;
    const description =
      typeof input.description === 'string' && input.description !== ''
        ? input.description
        : name
          ? `ERR_${name}`
          : 'Unknown error';
    return { code, description };
  }
  const text = typeof input === 'string' ? input : input && typeof input.message === 'string' ? input.message : '';
  const name = normalizeErrorName(text);
  // A bare word ("boom") is free text; only an ERR_/net:: spelling or a name this table knows is an error name.
  if (name && (/^(?:net::)?ERR_/i.test(text.trim()) || name in NET_ERROR_CODES)) {
    return { code: NET_ERROR_CODES[name] ?? null, description: `ERR_${name}` };
  }
  return { code: null, description: text.trim().slice(0, 200) || 'Unknown error' };
}

// ---------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok true when the server answered with anything below 500
 * @property {number} [status] the HTTP status, when there was an answer
 * @property {{ code: number|null, description: string }|unknown} [error] why the probe failed
 */

/** @param {unknown} status @returns {ProbeResult} */
function resultFromStatus(status) {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { ok: false, error: { code: null, description: 'No answer from the server' } };
  }
  if (status >= 500) return { ok: false, status, error: { code: status, description: `HTTP ${status}` } };
  return { ok: true, status };
}

/**
 * The default probe (SPEC 8: "probes with HEAD"): one HEAD request through Electron's `net`, without cookies and
 * without following redirects. A redirect or any status below 500 proves the server is up; 500 and above is
 * reported as a failure so a broken server keeps the retry loop going; a network error or a missing answer
 * within `timeoutMs` is a failure. Never rejects.
 *
 * @param {Object} options
 * @param {{ request: Function }} options.net Electron's `net` (or tests/helpers/fake-net.js)
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
 * @param {number} [options.timeoutMs]
 * @returns {(url: string) => Promise<ProbeResult>}
 */
function createNetProbe({ net, timers, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (!net || typeof net.request !== 'function') {
    throw new TypeError('createNetProbe needs Electron\'s net module (or a fake with request()).');
  }
  const clock = timers || { setTimeout, clearTimeout };

  return function probe(url) {
    return new Promise((resolve) => {
      let request = null;
      let timer = null;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        if (request) {
          try {
            request.abort();
          } catch {
            // The request already finished; there is nothing left to cancel.
          }
        }
        resolve(result);
      };

      try {
        request = net.request({ method: 'HEAD', url, redirect: 'manual', credentials: 'omit' });
      } catch (error) {
        finish({ ok: false, error: describeNetError(error) });
        return;
      }
      request.on('response', (response) => finish(resultFromStatus(response && response.statusCode)));
      request.on('redirect', (statusCode) => finish(resultFromStatus(statusCode)));
      request.on('error', (error) => finish({ ok: false, error: describeNetError(error) }));
      timer = unref(
        clock.setTimeout(() => finish({ ok: false, error: { code: NET_ERROR_CODES.TIMED_OUT, description: 'ERR_TIMED_OUT' } }), timeoutMs),
      );
      request.end();
    });
  };
}

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

/**
 * What the offline page, the banner and Settings show: the six fields of SPEC 6.2, nothing more. `online` is false
 * from `start()` until a probe succeeds; while no outage is being tracked it is true.
 *
 * @typedef {Object} ConnectionStatus
 * @property {boolean} online
 * @property {number} attempt probes completed since `start()` (0 = none yet); the one that succeeded counts too
 * @property {number|null} nextRetryInMs time left until the next probe, null while a probe runs or none is scheduled
 * @property {{ code: number|null, description: string }|null} lastError why the last probe failed
 * @property {string|null} url the URL being probed
 * @property {'offline'|'dns'|'refused'|'timeout'|'tls'|'server'|'other'|null} reason
 */

/**
 * The retry controller. `start(url)` begins probing `url` after 3 s, then 6, 12, 24 and 30 s (each +-20 %);
 * the first probe that gets an answer below 500 emits `online: true` and the controller stops itself. It reports
 * only real transitions: the start, the end of every probe, and the recovery. The controller never loads a page:
 * whoever owns the window reacts to `onStatus` (reload on `online` for the full-screen page, tell the preload for
 * the banner). While no outage is tracked no timer exists.
 *
 * @param {Object} options
 * @param {{ request?: Function, isOnline?: () => boolean }} [options.net] Electron's `net`; used for the default
 *   probe and as a hint (`isOnline() === false` turns a dns/timeout/other failure into `reason: 'offline'`)
 * @param {(url: string) => Promise<ProbeResult>|ProbeResult} [options.probe] replaces the HEAD probe
 * @param {{ setTimeout: Function, clearTimeout: Function, now?: () => number }} [options.timers]
 * @param {(status: ConnectionStatus) => void} [options.onStatus] called on every transition
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {() => number} [options.random] returns [0, 1); the jitter source
 * @param {() => number} [options.now] clock in ms (defaults to `timers.now`, then `Date.now`)
 * @param {number} [options.probeTimeoutMs] timeout of the default probe
 * @returns {{
 *   start: (url: string, options?: { mode?: 'page'|'banner', reason?: string, lastError?: object }) => ConnectionStatus,
 *   stop: () => void,
 *   retryNow: () => Promise<ConnectionStatus>,
 *   notifyNetworkChange: (online: boolean) => void,
 *   status: () => ConnectionStatus
 * }}
 */
function createConnectivity(options = {}) {
  const { net, probe, onStatus, log } = options;
  const timers = options.timers || { setTimeout, clearTimeout };
  const now = typeof options.now === 'function' ? options.now : typeof timers.now === 'function' ? () => timers.now() : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const logger = createLogger(log);
  const runProbe = typeof probe === 'function' ? probe : createNetProbe({ net, timers, timeoutMs: options.probeTimeoutMs });

  /** Bumped by every start() and stop(), so the answer of a probe that was overtaken can be recognised and dropped. */
  let generation = 0;
  let state = idleState();

  function idleState() {
    return {
      running: false,
      mode: null, // 'page' | 'banner': decides who may replace whom in start(); not part of the status
      url: null,
      online: true,
      attempt: 0,
      step: 0, // how many delays of the backoff have been scheduled
      timer: null,
      scheduledAt: null,
      nextRetryAt: null,
      lastError: null,
      reason: null,
      inFlight: null,
    };
  }

  /**
   * @param {number} [at] the moment to measure the countdown from; a status announced right after a delay was
   *   scheduled passes that moment, so it reads exactly the delay even when the clock ticks in between
   * @returns {ConnectionStatus}
   */
  function snapshot(at = now()) {
    return {
      online: state.online,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryAt === null ? null : Math.max(0, state.nextRetryAt - at),
      lastError: state.lastError ? { ...state.lastError } : null,
      url: state.url,
      reason: state.reason,
    };
  }

  function emit(at) {
    if (typeof onStatus !== 'function') return;
    try {
      onStatus(snapshot(at));
    } catch (error) {
      logger.error('connectivity: the status listener failed:', error && error.message);
    }
  }

  function clearTimer() {
    if (state.timer !== null) timers.clearTimeout(state.timer);
    state.timer = null;
    state.nextRetryAt = null;
  }

  /** Schedules the next probe: the next step of the backoff, spread by the jitter. */
  function scheduleNext() {
    const base = BACKOFF_STEPS_MS[Math.min(state.step, BACKOFF_STEPS_MS.length - 1)];
    state.step += 1;
    const sample = Number(random());
    const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
    const delay = Math.round(base * (1 - JITTER_RATIO + 2 * JITTER_RATIO * unit));
    state.scheduledAt = now();
    state.nextRetryAt = state.scheduledAt + delay;
    state.timer = unref(timers.setTimeout(() => {
      state.timer = null;
      state.nextRetryAt = null;
      void runAttempt();
    }, delay));
  }

  /**
   * @param {ProbeResult|undefined} result
   * @returns {{ error: { code: number|null, description: string }, reason: string }}
   */
  function describeFailure(result) {
    const status = result && typeof result.status === 'number' ? result.status : null;
    const error = result && result.error ? describeNetError(result.error) : resultFromStatus(status).error;
    let reason = httpStatusToReason(status) || classifyLoadFailure(error.code, error.description).reason;
    const osSaysOffline = net && typeof net.isOnline === 'function' && net.isOnline() === false;
    if (osSaysOffline && (reason === 'dns' || reason === 'timeout' || reason === 'other')) reason = 'offline';
    return { error, reason };
  }

  /**
   * Probes `url` once and records the answer, unless stop() or start() overtook the probe meanwhile.
   *
   * The probe is called from a microtask: a probe that throws SYNCHRONOUSLY would otherwise finish this whole
   * function before runAttempt() has registered it as in flight, leaving a stale promise there for good.
   */
  async function probeOnce(mine, url) {
    let result;
    try {
      result = await Promise.resolve().then(() => runProbe(url));
    } catch (error) {
      result = { ok: false, error };
    }
    if (mine !== generation) return snapshot(); // this answer belongs to an outage that is over
    state.inFlight = null;
    state.attempt += 1;
    if (result && result.ok === true) {
      state.running = false;
      state.online = true;
      state.lastError = null;
      state.reason = null;
      logger.info(`connectivity: ${state.mode} mode, ${hostOf(state.url)} answered after ${state.attempt} attempt(s)`);
      emit();
    } else {
      const failure = describeFailure(result);
      state.lastError = failure.error;
      state.reason = failure.reason;
      logger.warn(`connectivity: attempt ${state.attempt} failed (${failure.reason}: ${failure.error.description})`);
      scheduleNext();
      emit(state.scheduledAt);
    }
    return snapshot();
  }

  /** One probe. Joins the one already in flight instead of starting a second. */
  function runAttempt() {
    if (!state.running) return Promise.resolve(snapshot());
    if (state.inFlight) return state.inFlight;
    clearTimer();
    state.inFlight = probeOnce(generation, state.url);
    return state.inFlight;
  }

  /** Records what the caller already knows about the failure (the `did-fail-load` details, the request errors). */
  function applyDetails({ reason, lastError } = {}) {
    if (lastError) state.lastError = describeNetError(lastError);
    if (REASON_SET.has(reason)) state.reason = reason;
    else if (lastError) state.reason = classifyLoadFailure(state.lastError.code, state.lastError.description).reason;
  }

  function reset() {
    clearTimer();
    generation += 1;
    state = idleState();
  }

  /**
   * Starts probing `url`. Calling it again while it runs does not start a second loop: the same url and mode only
   * merge the new failure details; a banner request never downgrades a running full-screen page; anything else
   * restarts with the new url or mode.
   *
   * @param {string} url the `serverUrl`
   * @param {{ mode?: 'page'|'banner', reason?: string, lastError?: object }} [details] what is already known
   *   about the failure: `reason` from `classifyLoadFailure`, `lastError` as `{ code, description }`
   * @returns {ConnectionStatus}
   */
  function start(url, details = {}) {
    if (typeof url !== 'string' || url === '') {
      logger.warn('connectivity: start() was called without a URL');
      return snapshot();
    }
    const mode = details.mode === 'banner' ? 'banner' : 'page';
    if (state.running) {
      if (mode === 'banner' && state.mode === 'page') return snapshot();
      if (url === state.url && mode === state.mode) {
        applyDetails(details);
        emit();
        return snapshot();
      }
    }
    reset();
    state.running = true;
    state.mode = mode;
    state.url = url;
    state.online = false;
    applyDetails(details);
    scheduleNext();
    logger.info(`connectivity: ${mode} mode started for ${hostOf(url)}`);
    emit(state.scheduledAt);
    return snapshot(state.scheduledAt);
  }

  /** Stops probing and forgets the outage. Safe to call at any time, any number of times. */
  function stop() {
    reset();
  }

  /**
   * "Retry now". Probes at once (joining a probe already in flight) and resolves with the status when that probe
   * is done. Does nothing when no outage is being tracked.
   *
   * @returns {Promise<ConnectionStatus>}
   */
  function retryNow() {
    return runAttempt();
  }

  /**
   * The browser reports that the network is back (the page's `online` event: the preload forwards it, see
   * `desktop:connection:networkOnline` and `connectivity:networkOnline` in ipc.js). While an outage is tracked this probes at
   * once instead of waiting out the rest of the delay, and starts the delays again from the shortest one: a link that has just
   * come up often needs a few seconds before the first request gets through (DHCP, DNS), and the long delay of an old outage
   * (up to 36 s) would keep the till on the offline page long after the network was back. It never starts the controller (R3) and a
   * report of "offline" needs no action, the probes are already failing.
   *
   * @param {boolean} online
   */
  function notifyNetworkChange(online) {
    if (online !== true || !state.running) return;
    state.step = 0;
    if (state.inFlight === null) void runAttempt();
  }

  return { start, stop, retryNow, notifyNetworkChange, status: () => snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Mid-session detection (SPEC 11.3)
// ---------------------------------------------------------------------------------------------

/**
 * Watches `session.webRequest.onErrorOccurred` (a notification: no timer, no polling) and starts the controller in
 * `'banner'` mode after two network errors from DIFFERENT requests within 10 s on allowed origins. `ERR_ABORTED`
 * and every error outside the SPEC 11.3 list is ignored. The window of recent errors is pruned by the events
 * themselves, so nothing exists between errors.
 *
 * @param {Object} options
 * @param {{ start: Function }} options.connectivity the controller
 * @param {(url: string) => boolean} options.isAllowedOrigin `security.isAllowedOrigin`
 * @param {() => string|undefined} options.getUrl the current `serverUrl` (what to probe)
 * @param {() => number} [options.now]
 * @param {number} [options.windowMs]
 * @param {number} [options.threshold]
 * @param {{ info: Function }} [options.log]
 * @returns {{
 *   handle: (details: { id: number, url: string, error: string }) => void,
 *   attach: (session: { webRequest: { onErrorOccurred: Function } }) => (() => void),
 *   reset: () => void
 * }}
 */
function createRequestErrorMonitor({
  connectivity,
  isAllowedOrigin,
  getUrl,
  now = Date.now,
  windowMs = BANNER_WINDOW_MS,
  threshold = BANNER_ERROR_THRESHOLD,
  log,
} = {}) {
  const logger = createLogger(log);
  /** @type {{ id: number|string, at: number }[]} */
  let recent = [];

  /** WebSocket requests are judged by the http(s) origin they go to. */
  function toHttpUrl(url) {
    return typeof url === 'string' ? url.replace(/^ws(s?):/i, 'http$1:') : url;
  }

  /** @param {{ id: number|string, url: string, error: string }} details one `onErrorOccurred` notification */
  function handle(details) {
    try {
      if (!details || typeof details.error !== 'string') return;
      const name = normalizeErrorName(details.error);
      if (!BANNER_ERROR_NAMES.has(name)) return;
      if (!isAllowedOrigin(toHttpUrl(details.url))) return;
      const target = getUrl();
      if (!target) return;

      const at = now();
      recent = recent.filter((entry) => at - entry.at <= windowMs);
      if (!recent.some((entry) => entry.id === details.id)) recent.push({ id: details.id, at });
      if (recent.length < threshold) return;

      recent = [];
      logger.info(`connectivity: ${threshold} request errors in ${windowMs / 1000} s (last: ERR_${name}), starting the banner probe`);
      connectivity.start(target, { mode: 'banner', lastError: { code: NET_ERROR_CODES[name] ?? null, description: `ERR_${name}` } });
    } catch (error) {
      logger.error('connectivity: request error monitor failed:', error && error.message);
    }
  }

  /**
   * Electron keeps ONE `onErrorOccurred` listener per session: attaching replaces any other listener.
   *
   * @returns {() => void} detaches the monitor
   */
  function attach(session) {
    session.webRequest.onErrorOccurred(handle);
    return () => session.webRequest.onErrorOccurred(null);
  }

  return {
    handle,
    attach,
    reset() {
      recent = [];
    },
  };
}

module.exports = {
  createConnectivity,
  createNetProbe,
  createRequestErrorMonitor,
  classifyLoadFailure,
  httpStatusToReason,
  describeNetError,
  BACKOFF_STEPS_MS,
  JITTER_RATIO,
  REASONS,
  NET_ERROR_CODES,
};
