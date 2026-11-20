'use strict';

/**
 * The numbers behind tests/perf/benchmark.js: turns the raw samples of the runs into metrics, compares v2 with v1, checks the
 * SPEC 18b budgets and renders the markdown table. Pure functions (no Electron, no processes, no clock), so they are unit tested
 * in tests/perf/benchmark-lib.test.js. Not named *.test.js: node --test must not run it.
 *
 * The rule of the benchmark: a metric where v2 is WORSE than v1 by more than 10 percent, or a missed 18b budget, is a finding.
 * A difference is only called a regression when it is real: either it is larger than the resolution of the measurement (`FLOORS`, for
 * example `ps` reports CPU time in 10 ms steps), or the two samples do not overlap at all (with five runs each, the honest test that it is
 * more than run-to-run noise: 0.00 percent against 0.10 percent in every run is a real difference, even though it is tiny). A change that
 * is both small and inside the noise is reported as "within resolution", never as a defect.
 */

const stats = require('./stats');

/** "Worse by more than 10 percent". */
const REGRESSION_THRESHOLD = 0.1;

/** The smallest absolute difference that counts, per unit: below it a percentage is measurement resolution, not a result. */
const FLOORS = Object.freeze({ ms: 30, mb: 10, cpuPct: 0.15, fps: 2, printMs: 0.5, frameMs: 3 });

/** The SPEC 18b budgets that the benchmark measures. */
const BUDGETS = Object.freeze({
  loadingScreenVsV1FirstWindow: 0.75,
  mainBootMs: 400,
  rssVsV1: 0.85,
  laterJobOverheadMs: 150,
});

/** @param {Array<number|null|undefined>} values @returns {number[]} the finite numbers */
function finite(values) {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * @param {number} fromEpochMs the epoch time of the app's process start (from its start-up marks)
 * @param {number} markMs a mark: milliseconds since the process started
 * @param {number} spawnEpochMs the epoch time the harness spawned the process
 * @returns {number} the mark as milliseconds since the spawn
 */
function markFromSpawn(fromEpochMs, markMs, spawnEpochMs) {
  return fromEpochMs + markMs - spawnEpochMs;
}

/**
 * @param {Record<string, number>|null|undefined} marks the app's start-up marks (ms since its process start)
 * @returns {{ bootMs: number|null }} app-ready to loading-visible, the 18b "main-process boot"
 */
function bootOf(marks) {
  if (!marks || !Number.isFinite(marks['app-ready']) || !Number.isFinite(marks['loading-visible'])) return { bootMs: null };
  return { bootMs: marks['loading-visible'] - marks['app-ready'] };
}

/**
 * Summarises the start-up runs of one kind (v1, v2 or v2lean).
 *
 * @param {Array<object>} runs records of tests/perf/benchmark.js `measureStart`
 * @returns {Record<string, any>} a summary per metric (see `summarize` in stats.js) plus the raw values
 */
function summarizeStart(runs) {
  const metric = (read) => {
    const values = finite(runs.map(read));
    return { values, ...stats.summarize(values) };
  };
  const roleMedian = (role) => stats.median(finite(runs.map((run) => run.idle && run.idle.rss30 && run.idle.rss30.byRole[role] && run.idle.rss30.byRole[role].rssMb)));
  return {
    n: runs.length,
    firstWindowMs: metric((run) => run.firstTargetMs),
    windowShownMs: metric((run) => run.windowShownMs),
    loadingVisibleMs: metric((run) => run.loadingVisibleMs),
    windowCreatedMs: metric((run) => run.windowCreatedMs),
    bootMs: metric((run) => run.bootMs),
    readyToWindowMs: metric((run) => (Number.isFinite(run.windowCreatedMs) && Number.isFinite(run.appReadyMs) ? run.windowCreatedMs - run.appReadyMs : undefined)),
    showGapMs: metric((run) => (Number.isFinite(run.loadingVisibleMs) && Number.isFinite(run.windowCreatedMs) ? run.loadingVisibleMs - run.windowCreatedMs : undefined)),
    posLoadedMs: metric((run) => run.loadedMs),
    rss30Mb: metric((run) => run.idle && run.idle.rss30.rssMb),
    rss60Mb: metric((run) => run.idle && run.idle.rss60.rssMb),
    processes30: metric((run) => run.idle && run.idle.rss30.processes),
    cpuIdlePct: metric((run) => run.idle && run.idle.cpuIdle.percentOfCore),
    cpuFirstPct: metric((run) => run.idle && run.idle.cpuFirst.percentOfCore),
    rssByRoleMb: Object.fromEntries(['main', 'gpu', 'renderer', 'network', 'utility', 'crashpad', 'other'].map((role) => [role, stats.round(roleMedian(role), 1)]).filter(([, value]) => Number.isFinite(value))),
  };
}

/**
 * Compares one metric of v2 with the same metric of v1.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.label
 * @param {'ms'|'mb'|'cpuPct'|'fps'|'printMs'|'frameMs'} options.unit
 * @param {'lower'|'higher'} options.better which direction is an improvement
 * @param {number[]} options.v1 the v1 samples
 * @param {number[]} options.v2 the v2 samples
 * @param {number} [options.floor] the smallest absolute difference (in the metric's own unit) that counts; defaults to FLOORS[unit]
 * @returns {{ id: string, label: string, unit: string, better: string, v1: object, v2: object, ratio: number, worsePct: number, absDiff: number, floor: number, regression: boolean, confirmed: boolean, smallerThanFloor: boolean, belowResolution: boolean }}
 */
function compareMetric({ id, label, unit, better, v1, v2, floor: floorOverride }) {
  const a = stats.summarize(v1);
  const b = stats.summarize(v2);
  // A v1 median of exactly zero (an idle CPU that `ps` could not see) makes the ratio undefined: anything above it is infinitely worse
  // when lower is better, and anything above it is better when higher is better.
  const fromZero = a.median === 0 && Number.isFinite(b.median);
  const ratio = fromZero ? (b.median === 0 ? 1 : Infinity) : stats.ratio(b.median, a.median);
  let worsePct = Number.isFinite(ratio) ? (better === 'lower' ? ratio - 1 : 1 - ratio) * 100 : NaN;
  if (fromZero && b.median > 0) worsePct = better === 'lower' ? Infinity : -Infinity;
  const difference = Math.abs(b.median - a.median);
  const floor = Number.isFinite(floorOverride) ? floorOverride : FLOORS[unit];
  const beyondThreshold = !Number.isNaN(worsePct) && worsePct > REGRESSION_THRESHOLD * 100;
  const separate = stats.rangesSeparate(v1, v2);
  const belowResolution = beyondThreshold && difference <= floor && !separate;
  return {
    id,
    label,
    unit,
    better,
    v1: a,
    v2: b,
    ratio,
    worsePct,
    absDiff: b.median - a.median,
    floor,
    regression: beyondThreshold && !belowResolution,
    confirmed: beyondThreshold && !belowResolution && separate,
    smallerThanFloor: beyondThreshold && difference <= floor,
    belowResolution,
  };
}

/**
 * The start-up, memory and CPU comparisons (v1 against v2 started through tests/e2e/launch-app.js).
 *
 * @param {Record<string, any>} v1 summarizeStart of v1
 * @param {Record<string, any>} v2 summarizeStart of v2
 * @returns {object[]}
 */
function compareStart(v1, v2) {
  const cmp = (id, label, unit, key, other = key) => compareMetric({ id, label, unit, better: 'lower', v1: v1[key].values, v2: v2[other].values });
  return [
    cmp('first-window', 'Time to first window (spawn to first DevTools page target)', 'ms', 'firstWindowMs'),
    cmp('pos-loaded', 'Time to POS loaded (spawn to the page\'s load event)', 'ms', 'posLoadedMs'),
    cmp('rss-30s', 'Process-tree RSS after 30 s idle', 'mb', 'rss30Mb'),
    cmp('rss-60s', 'Process-tree RSS after 60 s idle', 'mb', 'rss60Mb'),
    cmp('cpu-idle', 'Idle CPU over 30 s (percent of one core, 30-60 s after load)', 'cpuPct', 'cpuIdlePct'),
    cmp('cpu-first-30s', 'CPU in the first 30 s after the POS loaded (percent of one core)', 'cpuPct', 'cpuFirstPct'),
  ];
}

/**
 * @param {Array<object>} runs records of `measureFps`
 * @returns {Record<string, any>} frames per second and frame-time spread, with the CPU used during the measured window
 */
function summarizeFps(runs) {
  const metric = (read) => {
    const values = finite(runs.map(read));
    return { values, ...stats.summarize(values) };
  };
  return {
    n: runs.length,
    fps: metric((run) => run.result && run.result.fps),
    frameMsP95: metric((run) => run.result && run.result.frameMsP95),
    slowFrames: metric((run) => run.result && run.result.slowFrames),
    cpuCores: metric((run) => run.cpu && run.cpu.percentOfCore / 100),
    rssMb: metric((run) => run.rssMb),
  };
}

/**
 * @param {number[]} sentAt when each message was sent (ms, one clock)
 * @param {number[]} doneAt when each job finished (ms, the same clock; any order)
 * @returns {{ count: number, firstJobMs: number, makespanMs: number, perJobMs: number, serviceMedianMs: number, serviceP95Ms: number }|null}
 */
function batchMetrics(sentAt, doneAt) {
  const sent = finite(sentAt);
  const done = finite(doneAt).sort((a, b) => a - b);
  if (sent.length === 0 || done.length === 0) return null;
  const gaps = [];
  for (let i = 1; i < done.length; i += 1) gaps.push(done[i] - done[i - 1]);
  const makespanMs = done[done.length - 1] - Math.min(...sent);
  return {
    count: done.length,
    firstJobMs: done[0] - sent[0],
    makespanMs,
    perJobMs: makespanMs / done.length,
    serviceMedianMs: stats.median(gaps),
    serviceP95Ms: stats.percentile(gaps, 0.95),
  };
}

/**
 * @param {number[]} sentAt
 * @param {number[]} ackAt
 * @returns {{ latencyMedianMs: number, latencyP95Ms: number, latencyMaxMs: number }}
 */
function latencyMetrics(sentAt, ackAt) {
  const latencies = sentAt.map((sent, index) => ackAt[index] - sent).filter(Number.isFinite);
  return { latencyMedianMs: stats.median(latencies), latencyP95Ms: stats.percentile(latencies, 0.95), latencyMaxMs: stats.summarize(latencies).max };
}

/**
 * Formats a number for a table.
 *
 * @param {number} value
 * @param {number} [digits]
 * @returns {string} "-" for anything that is not a finite number
 */
function fmt(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

/** @param {{ median: number, min: number, max: number }} summary @param {number} [digits] @returns {string} "median (min-max)" */
function spread(summary, digits = 0) {
  if (!summary || !Number.isFinite(summary.median)) return '-';
  return `${fmt(summary.median, digits)} (${fmt(summary.min, digits)}-${fmt(summary.max, digits)})`;
}

/** @param {number} worsePct @returns {string} a signed percentage where a positive number is WORSE */
function worseText(worsePct) {
  if (worsePct === Infinity) return 'from zero';
  if (!Number.isFinite(worsePct)) return '-';
  return `${worsePct > 0 ? '+' : ''}${worsePct.toFixed(0)}%`;
}

/** @param {{ regression: boolean, confirmed: boolean, belowResolution: boolean, worsePct: number }} comparison @returns {string} */
function verdictOf(comparison) {
  if (comparison.regression) return comparison.confirmed ? 'WORSE (confirmed)' : 'WORSE (ranges overlap)';
  if (comparison.belowResolution) return 'within resolution';
  return comparison.worsePct < -REGRESSION_THRESHOLD * 100 ? 'better' : 'same';
}

/**
 * A markdown table.
 *
 * @param {string[]} header
 * @param {string[][]} rows
 * @returns {string}
 */
function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

module.exports = {
  REGRESSION_THRESHOLD,
  FLOORS,
  BUDGETS,
  finite,
  markFromSpawn,
  bootOf,
  summarizeStart,
  compareMetric,
  compareStart,
  summarizeFps,
  batchMetrics,
  latencyMetrics,
  fmt,
  spread,
  worseText,
  verdictOf,
  table,
};
