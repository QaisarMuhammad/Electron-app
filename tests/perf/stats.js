'use strict';

/**
 * Small statistics helpers for the benchmark (tests/perf/benchmark.js). Pure functions, no dependencies.
 * Not named *.test.js: node --test must not run it (its tests are in tests/perf/benchmark-lib.test.js).
 */

/** @param {number[]} values @returns {number[]} the finite numbers, ascending */
function sortedFinite(values) {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
}

/**
 * Linear-interpolated percentile.
 *
 * @param {number[]} values
 * @param {number} fraction 0..1 (0.5 is the median)
 * @returns {number} NaN when there are no finite values
 */
function percentile(values, fraction) {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return NaN;
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, fraction));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** @param {number[]} values @returns {number} */
function median(values) {
  return percentile(values, 0.5);
}

/** @param {number[]} values @returns {number} NaN when empty */
function mean(values) {
  const sorted = sortedFinite(values);
  return sorted.length === 0 ? NaN : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
}

/** @param {number[]} values @returns {number} sample standard deviation (0 for fewer than two values), NaN when empty */
function stdev(values) {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return 0;
  const average = mean(sorted);
  return Math.sqrt(sorted.reduce((sum, value) => sum + (value - average) ** 2, 0) / (sorted.length - 1));
}

/**
 * @param {number[]} values
 * @returns {{ n: number, min: number, median: number, mean: number, p95: number, max: number, stdev: number }}
 */
function summarize(values) {
  const sorted = sortedFinite(values);
  return {
    n: sorted.length,
    min: sorted.length ? sorted[0] : NaN,
    median: median(sorted),
    mean: mean(sorted),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
    stdev: stdev(sorted),
  };
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number} the value rounded to `digits` decimals (NaN and Infinity stay as they are)
 */
function round(value, digits = 1) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number} a / b, NaN when either is not a finite number or b is 0
 */
function ratio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return NaN;
  return a / b;
}

/**
 * Whether two samples are clearly apart: every value of one lies beyond every value of the other (the ranges do not overlap).
 * With five runs each this is a strict but honest test that a difference is more than run-to-run noise.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
function rangesSeparate(a, b) {
  const x = sortedFinite(a);
  const y = sortedFinite(b);
  if (x.length === 0 || y.length === 0) return false;
  return x[x.length - 1] < y[0] || y[y.length - 1] < x[0];
}

module.exports = { percentile, median, mean, stdev, summarize, round, ratio, rangesSeparate, sortedFinite };
