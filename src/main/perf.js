'use strict';

/**
 * Startup marks and the one-line summary of how fast the app came up (SPEC 18b S3).
 *
 * Every mark is "milliseconds since the process started": the clock origin is `now() - uptimeMs()`, and
 * `process-start` is always 0. That makes the time Electron spent before our first line of JavaScript part of the
 * numbers, which is what the owner (and the benchmark) actually experience.
 *
 * Marks, in the order the app reaches them: process-start, app-ready, window-created, loading-visible (the window is on screen,
 * in the colour of the page), loading-painted (the loading screen has been drawn, about 300 ms later: Chromium starts the page's
 * renderer in between), config-ready, services-ready, pos-dom-ready, pos-loaded. A mark is recorded ONCE (the first call
 * wins): pos-dom-ready and pos-loaded fire again after every reload and must not move the startup numbers.
 *
 * Pure Node: the clock and the logger are injected.
 */

/** The marks the app records, in startup order. Other names are accepted too (they sort by time). */
const MARK_NAMES = Object.freeze([
  'process-start',
  'app-ready',
  'window-created',
  'loading-visible',
  'loading-painted',
  'config-ready',
  'services-ready',
  'pos-dom-ready',
  'pos-loaded',
]);

const MAX_MARKS = 32;
const MAX_NAME_LENGTH = 40;

/** @param {unknown} value @returns {number} a finite number of at least 0, else 0 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @param {number} ms
 * @returns {string} "402 ms" below one second, "2.4 s" above
 */
function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now=Date.now] wall clock in milliseconds
 * @param {() => number} [options.uptimeMs] milliseconds since the process started; defaults to `process.uptime() * 1000`
 * @param {{ info?: Function }} [options.log]
 * @returns {{
 *   mark: (name: string) => number|undefined,
 *   has: (name: string) => boolean,
 *   marks: () => Record<string, number>,
 *   measures: () => Array<{ name: string, at: number, delta: number }>,
 *   summary: () => string,
 *   startup: () => { marks: Record<string, number>, summary: string },
 *   logOnce: () => boolean
 * }}
 */
function createPerf({ now = Date.now, uptimeMs = () => process.uptime() * 1000, log } = {}) {
  const origin = now() - nonNegative(uptimeMs());
  /** @type {Map<string, number>} */
  const recorded = new Map([['process-start', 0]]);
  let logged = false;

  /**
   * Records the moment a startup step was reached. Repeated calls with the same name change nothing.
   *
   * @param {string} name
   * @returns {number|undefined} milliseconds since the process started; undefined for an unusable name
   */
  function mark(name) {
    if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_LENGTH) return undefined;
    if (recorded.has(name)) return recorded.get(name);
    if (recorded.size >= MAX_MARKS) return undefined;
    const at = Math.max(0, Math.round(now() - origin));
    recorded.set(name, at);
    return at;
  }

  /** @returns {Record<string, number>} a copy of every mark, in the order they were recorded */
  function marks() {
    return Object.fromEntries(recorded);
  }

  /** @returns {Array<{ name: string, at: number, delta: number }>} the marks by time, with the time since the previous one */
  function measures() {
    const sorted = [...recorded].sort((a, b) => a[1] - b[1]);
    return sorted.map(([name, at], index) => ({ name, at, delta: index === 0 ? 0 : at - sorted[index - 1][1] }));
  }

  /** @returns {string} for example "Loading screen in 402 ms. POS ready in 2.4 s." ('' until a step beyond the start was reached) */
  function summary() {
    const parts = [];
    if (recorded.has('loading-visible')) parts.push(`Loading screen in ${formatDuration(recorded.get('loading-visible'))}.`);
    if (recorded.has('pos-loaded')) parts.push(`POS ready in ${formatDuration(recorded.get('pos-loaded'))}.`);
    return parts.join(' ');
  }

  /** @returns {{ marks: Record<string, number>, summary: string }} what Settings > About shows and the diagnostics carry */
  function startup() {
    return { marks: marks(), summary: summary() };
  }

  /**
   * Writes the startup numbers to the log as ONE line, the first time it is called.
   * @returns {boolean} true when the line was written now
   */
  function logOnce() {
    if (logged) return false;
    logged = true;
    const line = measures().map(({ name, at }) => `${name} ${at} ms`).join(', ');
    if (log && typeof log.info === 'function') log.info(`startup: ${line}${summary() ? ` | ${summary()}` : ''}`);
    return true;
  }

  return { mark, has: (name) => recorded.has(name), marks, measures, summary, startup, logOnce };
}

module.exports = { createPerf, MARK_NAMES, formatDuration };
