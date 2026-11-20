'use strict';

/**
 * Turns the raw samples of a benchmark run (tests/perf/benchmark.js) into the analysis, the findings and the markdown table
 * (tests/perf/out/benchmark.md, quoted by docs/PERFORMANCE.md). Pure: it only reads `data`. Unit tested in tests/perf/benchmark-lib.test.js.
 * Not named *.test.js: node --test must not run it.
 */

const stats = require('./stats');
const analyze = require('./analyze');

const { fmt, spread, worseText, verdictOf, table, BUDGETS } = analyze;

const usable = (runs) => (runs || []).filter((run) => !run.error);

/** @returns {boolean|null} whether `value <= limit`; null (no verdict) when either is not a number, e.g. a phase that produced no data */
function atMost(value, limit) {
  return Number.isFinite(value) && Number.isFinite(limit) ? value <= limit : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------------------

/** @param {object} start data.start @returns {object} */
function analyzeStart(start) {
  const summary = {
    v1: analyze.summarizeStart(usable(start.v1)),
    v2: analyze.summarizeStart(usable(start.v2)),
    v2lean: analyze.summarizeStart(usable(start.v2lean)),
  };
  const comparisons = analyze.compareStart(summary.v1, summary.v2);
  const leanComparisons = analyze.compareStart(summary.v1, summary.v2lean);
  /** The loading screen: v2 from its own marks, against v1's first window. */
  const loadingScreen = analyze.compareMetric({ id: 'loading-screen', label: 'Time to the loading screen (v2: loading-visible mark) vs v1 first window', unit: 'ms', better: 'lower', v1: summary.v1.firstWindowMs.values, v2: summary.v2.loadingVisibleMs.values });

  const v1First = summary.v1.firstWindowMs.median;
  const budgets = [
    {
      id: 'loading-screen',
      spec: 'Time to the loading screen <= 0.75 x the v1 time to its first window',
      limit: `${fmt(BUDGETS.loadingScreenVsV1FirstWindow * v1First)} ms (0.75 x ${fmt(v1First)} ms)`,
      measured: `${fmt(summary.v2.loadingVisibleMs.median)} ms (range ${fmt(summary.v2.loadingVisibleMs.min)}-${fmt(summary.v2.loadingVisibleMs.max)}); ratio ${fmt(stats.ratio(summary.v2.loadingVisibleMs.median, v1First), 2)}`,
      pass: atMost(summary.v2.loadingVisibleMs.median, BUDGETS.loadingScreenVsV1FirstWindow * v1First),
      ratio: stats.ratio(summary.v2.loadingVisibleMs.median, v1First),
    },
    {
      id: 'main-boot',
      spec: 'Main-process boot (app-ready to loading-visible) <= 400 ms',
      limit: `${BUDGETS.mainBootMs} ms`,
      measured: `${fmt(summary.v2.bootMs.median)} ms (range ${fmt(summary.v2.bootMs.min)}-${fmt(summary.v2.bootMs.max)})`,
      pass: atMost(summary.v2.bootMs.median, BUDGETS.mainBootMs),
    },
    {
      id: 'rss',
      spec: 'Summed RSS of all app processes after 30 s idle <= 0.85 x v1',
      limit: `${fmt(BUDGETS.rssVsV1 * summary.v1.rss30Mb.median, 1)} MB (0.85 x ${fmt(summary.v1.rss30Mb.median, 1)} MB)`,
      measured: `${fmt(summary.v2.rss30Mb.median, 1)} MB (range ${fmt(summary.v2.rss30Mb.min, 1)}-${fmt(summary.v2.rss30Mb.max, 1)}); ratio ${fmt(stats.ratio(summary.v2.rss30Mb.median, summary.v1.rss30Mb.median), 2)}`,
      pass: atMost(summary.v2.rss30Mb.median, BUDGETS.rssVsV1 * summary.v1.rss30Mb.median),
      ratio: stats.ratio(summary.v2.rss30Mb.median, summary.v1.rss30Mb.median),
    },
  ];
  return { summary, comparisons, leanComparisons, loadingScreen, budgets };
}

/** @param {object} fps data.fps @returns {object} */
function analyzeFps(fps) {
  const summary = { v1: analyze.summarizeFps(usable(fps.v1)), v2: analyze.summarizeFps(usable(fps.v2)), v2sw: analyze.summarizeFps(usable(fps.v2sw)) };
  const make = (id, label, other) => [
    analyze.compareMetric({ id: `${id}-fps`, label: `${label}: frames per second`, unit: 'fps', better: 'higher', v1: summary.v1.fps.values, v2: summary[other].fps.values }),
    analyze.compareMetric({ id: `${id}-p95`, label: `${label}: p95 frame time`, unit: 'frameMs', better: 'lower', v1: summary.v1.frameMsP95.values, v2: summary[other].frameMsP95.values }),
  ];
  const gpuStatus = (mode) => {
    const run = usable(fps[mode])[0];
    return run && run.gpu ? run.gpu : null;
  };
  return {
    summary,
    comparisons: [...make('stress-v2-gpu', 'Stress page, v2 hardware acceleration vs v1', 'v2'), ...make('stress-v2-software', 'Stress page, v2 compatibility mode vs v1', 'v2sw')],
    gpu: { v1: gpuStatus('v1'), v2: gpuStatus('v2'), v2sw: gpuStatus('v2sw') },
  };
}

/**
 * @param {Array<object>} runs print records of one variant
 * @param {'receipt'|'label'} kind
 * @param {'burst'|'sequential'} mode
 * @param {'printer'|'ack'|'latency'} level
 * @param {string} key a field of the batch metrics
 * @returns {number[]} one value per run
 */
function printValues(runs, kind, mode, level, key) {
  return usable(runs).map((run) => {
    const batch = run.batches.find((item) => item.kind === kind && item.mode === mode);
    return batch && batch[level] ? batch[level][key] : NaN;
  }).filter(Number.isFinite);
}

/** @param {Record<string, object[]>} print data.print @returns {object} */
function analyzePrint(print) {
  const summary = {};
  for (const [variant, runs] of Object.entries(print)) {
    summary[variant] = {};
    for (const kind of ['receipt', 'label']) {
      for (const mode of ['burst', 'sequential']) {
        const entry = {};
        for (const [level, keys] of [['printer', ['firstJobMs', 'makespanMs', 'perJobMs', 'serviceMedianMs', 'serviceP95Ms']], ['ack', ['firstJobMs', 'makespanMs', 'perJobMs', 'serviceMedianMs', 'serviceP95Ms']], ['latency', ['latencyMedianMs', 'latencyP95Ms', 'latencyMaxMs']]]) {
          for (const key of keys) {
            const values = printValues(runs, kind, mode, level, key);
            if (values.length > 0) (entry[level] = entry[level] || {})[key] = { values, ...stats.summarize(values) };
          }
        }
        if (Object.keys(entry).length > 0) summary[variant][`${kind}-${mode}`] = entry;
      }
    }
  }

  const comparisons = [];
  // A batch is `count` jobs: its total only counts as different when it differs by more than the per-job floor for every job.
  const count = (usable(Object.values(print).find((runs) => usable(runs).length > 0)).flatMap((run) => run.batches)[0] || {}).count || 50;
  const compare = (id, label, a, b, floor = analyze.FLOORS.printMs) => {
    if (!a || !b || a.values.length === 0 || b.values.length === 0) return;
    comparisons.push(analyze.compareMetric({ id, label, unit: 'printMs', better: 'lower', v1: a.values, v2: b.values, floor }));
  };
  const totalFloor = analyze.FLOORS.printMs * count;
  const field = (variant, kind, mode, level, key) => summary[variant] && summary[variant][`${kind}-${mode}`] && summary[variant][`${kind}-${mode}`][level] && summary[variant][`${kind}-${mode}`][level][key];
  for (const kind of ['receipt', 'label']) {
    const plural = kind === 'receipt' ? 'receipts' : 'labels';
    compare(`print-${kind}-legacy-total`, `50 ${plural}, fire-and-forget, total time: v1 handler vs v2 legacy path (real raw printer)`, field('v1-legacy', kind, 'burst', 'printer', 'makespanMs'), field('v2-legacy-real', kind, 'burst', 'printer', 'makespanMs'), totalFloor);
    compare(`print-${kind}-legacy-first`, `First of 50 ${plural}, fire-and-forget: v1 handler vs v2 legacy path`, field('v1-legacy', kind, 'burst', 'printer', 'firstJobMs'), field('v2-legacy-real', kind, 'burst', 'printer', 'firstJobMs'), 2);
    compare(`print-${kind}-ack-real-total`, `50 ${plural}, total time to the last answer: v1 handler vs v2 acknowledged path (real raw printer)`, field('v1-legacy', kind, 'burst', 'printer', 'makespanMs'), field('v2-ack-real', kind, 'burst', 'ack', 'makespanMs'), totalFloor);
    compare(`print-${kind}-ack-fake-total`, `50 ${plural}, total time to the last answer: v1 handler vs v2 acknowledged path (fake printers)`, field('v1-legacy', kind, 'burst', 'printer', 'makespanMs'), field('v2-ack-fake', kind, 'burst', 'ack', 'makespanMs'), totalFloor);
    compare(`print-${kind}-ack-real-first`, `First of 50 ${plural}, to the answer: v1 handler vs v2 acknowledged path`, field('v1-legacy', kind, 'burst', 'printer', 'firstJobMs'), field('v2-ack-real', kind, 'burst', 'ack', 'firstJobMs'), 2);
  }

  // L1: the overhead of the 2nd and later jobs of the acknowledged path must stay below 150 ms (the Windows PowerShell host's budget;
  // here the printer is a stub, so this is the app's own overhead).
  const worstLater = [
    ...['receipt', 'label'].map((kind) => field('v2-ack-real', kind, 'burst', 'ack', 'serviceP95Ms')),
    ...['receipt', 'label'].map((kind) => field('v2-ack-real', kind, 'sequential', 'latency', 'latencyP95Ms')),
  ].filter(Boolean).map((entry) => entry.max);
  const worst = worstLater.length > 0 ? Math.max(...worstLater) : NaN;
  const budgets = [{
    id: 'later-job-overhead',
    spec: 'Overhead of the 2nd and later print jobs < 150 ms excluding the printer (L1; measured with the printer stubbed)',
    limit: `${BUDGETS.laterJobOverheadMs} ms`,
    measured: `${fmt(worst, 2)} ms (the largest p95 over the runs, receipts and labels, burst and sequential)`,
    pass: Number.isFinite(worst) ? worst < BUDGETS.laterJobOverheadMs : null,
  }];
  return { summary, comparisons, budgets };
}

/**
 * @param {Record<string, object[]>} diag data.diag: v2 lean with hardware acceleration and in compatibility mode, times only
 * @returns {{ summary: Record<string, object>, gpuCostMs: Record<string, number> }}
 */
function analyzeDiag(diag) {
  const summary = {};
  for (const [variant, runs] of Object.entries(diag)) summary[variant] = analyze.summarizeStart(usable(runs));
  const gpu = summary['v2lean-gpu'];
  const software = summary['v2lean-nogpu'];
  const delta = (key) => (gpu && software ? gpu[key].median - software[key].median : NaN);
  return {
    summary,
    gpuCostMs: {
      firstWindow: delta('firstWindowMs'),
      windowCreated: delta('windowCreatedMs'),
      loadingVisible: delta('loadingVisibleMs'),
      showGap: delta('showGapMs'),
      boot: delta('bootMs'),
      posLoaded: delta('posLoadedMs'),
    },
  };
}

/** The drift phase counts memory and CPU from this many seconds after the load (the start-up burst is over by then). */
const DRIFT_SETTLE_S = 60;
/** A process role that gains at least this much memory between two samples is reported as a one-time step. */
const DRIFT_STEP_MB = 1;

/**
 * @param {Record<string, object[]>} drift data.drift: per variant, runs of { samples: [{ t, atMs, totalMb, roles }] }
 * @returns {Record<string, object>} per variant: memory when the settle time was reached and at the end, the biggest one-time step, and the
 *   idle CPU after the settle time (in total and by role). `spoiled` is true when the screen was locked at one sample and unlocked at another:
 *   a person came back during the run, and what the app did afterwards is not idle behaviour.
 */
function analyzeDrift(drift) {
  const out = {};
  for (const [variant, runs] of Object.entries(drift)) {
    const run = usable(runs).find((item) => Array.isArray(item.samples) && item.samples.length >= 3);
    if (!run) continue;
    const { samples } = run;
    const lockStates = new Set(samples.map((sample) => sample.screenLocked).filter((state) => state !== undefined && state !== null));
    const settle = samples.find((sample) => sample.t >= DRIFT_SETTLE_S) || samples[1];
    const last = samples[samples.length - 1];
    const roleNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.roles)))];
    const rssOf = (sample, role) => (sample.roles[role] ? sample.roles[role].rssMb : 0);
    const cpuOf = (sample, role) => (sample.roles[role] ? sample.roles[role].cpuSec : 0);
    const seconds = (last.atMs - settle.atMs) / 1000;
    const cpuByRole = Object.fromEntries(roleNames.map((role) => [role, stats.round(Math.max(0, cpuOf(last, role) - cpuOf(settle, role)), 2)]));
    const cpuTotal = Object.values(cpuByRole).reduce((sum, value) => sum + value, 0);
    let step = null;
    for (let i = 1; i < samples.length; i += 1) {
      for (const role of roleNames) {
        const delta = rssOf(samples[i], role) - rssOf(samples[i - 1], role);
        if (delta >= DRIFT_STEP_MB && (!step || delta > step.mb)) step = { role, mb: stats.round(delta, 1), fromS: samples[i - 1].t, toS: samples[i].t };
      }
    }
    out[variant] = {
      samples,
      spoiled: lockStates.size > 1,
      settleS: settle.t,
      lastS: last.t,
      rssAtSettleMb: settle.totalMb,
      rssLastMb: last.totalMb,
      rssGrowthSinceSettleMb: stats.round(last.totalMb - settle.totalMb, 1),
      idleCpuPct: seconds > 0 ? stats.round((cpuTotal / seconds) * 100, 3) : NaN,
      idleCpuSeconds: stats.round(cpuTotal, 2),
      idleWindowS: Math.round(seconds),
      cpuByRole,
      step,
    };
  }
  return out;
}

/**
 * What the drift phase says about an idle CPU regression: a sentence for the finding (empty without drift data).
 *
 * @param {Record<string, any>|undefined} drift analysis.drift
 * @returns {string}
 */
function driftNote(drift) {
  const v1 = drift && drift.v1;
  const v2 = drift && drift['v2lean-gpu'];
  if (!v1 || !v2 || v1.spoiled || v2.spoiled || !Number.isFinite(v1.idleCpuPct) || !Number.isFinite(v2.idleCpuPct)) return '';
  const flat = Math.abs(v2.rssGrowthSinceSettleMb) < 2 && v2.idleCpuPct <= v1.idleCpuPct * 1.5 + 0.05;
  const step = v2.step ? `a one-time ${v2.step.mb} MB step of the ${v2.step.role} process between ${v2.step.fromS} and ${v2.step.toS} s after the load` : 'no one-time memory step';
  return ` Drift diagnostic (the drift phase, one run each): from ${v2.settleS} s to ${v2.lastS} s v2 idles at ${fmt(v2.idleCpuPct, 3)} % of a core against v1's ${fmt(v1.idleCpuPct, 3)} % (${v2.idleWindowS} s window), and v2's total memory moved ${v2.rssGrowthSinceSettleMb} MB over that time (v1: ${v1.rssGrowthSinceSettleMb} MB); v2 shows ${step}. ${flat ? 'So the extra CPU of the 30-60 s window is a one-time event, not a timer and not a leak.' : 'The extra idle CPU or memory continues after the settle time: look for a timer or a leak.'}`;
}

/** Which options belong to which phase: a merge takes them from the run that produced the phase. */
const PHASE_OPTION_KEYS = Object.freeze({
  start: ['runs', 'idleSeconds', 'warmup'],
  fps: ['fpsRuns', 'fpsSeconds', 'stressQuery'],
  print: ['printRuns', 'printCount'],
  diag: ['diagRuns'],
  drift: ['driftRuns', 'driftTimes'],
});
const PHASES = Object.freeze(['start', 'fps', 'print', 'diag', 'drift']);

/**
 * Puts the phases of a new run into the data of an earlier one (`--merge`: re-run one phase, keep the rest, rebuild the report). Without an
 * earlier run it only adds the bookkeeping. `meta.runs` lists every run that contributed, with the build it measured, so numbers that
 * come from different builds can be told apart.
 *
 * @param {object|null} previous the earlier benchmark.json (or null)
 * @param {object} fresh the new run: { meta, start?, fps?, print?, diag?, focus, cleanup, phaseErrors }
 * @param {{ phases: string[] } & Record<string, any>} options the options of the new run
 * @returns {object} the merged data
 */
function mergeData(previous, fresh, options) {
  const ran = PHASES.filter((phase) => fresh[phase] !== undefined || (options.phases || []).includes(phase));
  const pick = (source, phases) => Object.fromEntries(phases.flatMap((phase) => PHASE_OPTION_KEYS[phase]).filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  const thisRun = {
    phases: ran,
    startedAt: fresh.meta.startedAt,
    finishedAt: fresh.meta.finishedAt,
    durationMinutes: fresh.meta.durationMinutes,
    options: pick(options, ran),
    v2: fresh.meta.host && fresh.meta.host.v2,
    noiseBefore: fresh.meta.noiseBefore,
    noiseAfter: fresh.meta.noiseAfter,
    ...(fresh.meta.note ? { note: fresh.meta.note } : {}),
  };
  if (!previous) return { ...fresh, meta: { ...fresh.meta, options: { ...fresh.meta.options }, runs: [thisRun] } };

  const merged = { ...previous };
  for (const phase of ran) merged[phase] = fresh[phase];
  const earlier = previous.meta.runs || [{ phases: PHASES.filter((phase) => previous[phase] !== undefined), startedAt: previous.meta.startedAt, finishedAt: previous.meta.finishedAt, durationMinutes: previous.meta.durationMinutes, options: pick(previous.meta.options || {}, PHASES), v2: previous.meta.host && previous.meta.host.v2 }];
  const runs = [...earlier, thisRun];
  merged.meta = {
    ...previous.meta,
    finishedAt: fresh.meta.finishedAt,
    durationMinutes: stats.round(runs.reduce((sum, run) => sum + (Number(run.durationMinutes) || 0), 0), 1),
    options: { ...previous.meta.options, ...pick(options, ran) },
    noiseAfter: fresh.meta.noiseAfter,
    runs,
  };
  merged.phaseErrors = { ...Object.fromEntries(Object.entries(previous.phaseErrors || {}).filter(([phase]) => !ran.includes(phase))), ...fresh.phaseErrors };
  merged.focus = { samples: (previous.focus ? previous.focus.samples : 0) + (fresh.focus ? fresh.focus.samples : 0), stolen: [...(previous.focus ? previous.focus.stolen : []), ...(fresh.focus ? fresh.focus.stolen : [])], apps: [...new Set([...(previous.focus ? previous.focus.apps : []), ...(fresh.focus ? fresh.focus.apps : [])])] };
  merged.cleanup = { spawned: (previous.cleanup ? previous.cleanup.spawned : 0) + (fresh.cleanup ? fresh.cleanup.spawned : 0), strays: [...(previous.cleanup ? previous.cleanup.strays : []), ...(fresh.cleanup ? fresh.cleanup.strays : [])] };
  delete merged.analysis;
  delete merged.findings;
  return merged;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------------------

const REPRO = {
  start: 'node tests/perf/benchmark.js --phases=start (5 cold starts each, v1 and v2 alternating, fresh --user-data-dir per start)',
  fps: 'node tests/perf/benchmark.js --phases=fps (the stress page, 8 s per run, 5 runs per mode)',
  print: 'node tests/perf/benchmark.js --phases=print (50 receipts and 50 labels per run, 5 runs per variant)',
};

/** @param {{ id: string }} comparison @returns {{ area: string, file: string, phase: string }} where a regression of this metric most likely lives */
function whereIs(comparison) {
  if (comparison.id.startsWith('print')) return { area: 'electron-printing', file: 'src/main/printing/jobs.js', phase: 'print' };
  if (comparison.id.startsWith('stress')) return { area: 'electron-main', file: 'src/main/platform.js', phase: 'fps' };
  if (comparison.id.startsWith('cpu') || comparison.id.startsWith('rss')) return { area: 'electron-main', file: 'src/main/index.js', phase: 'start' };
  return { area: 'electron-main', file: 'src/main/index.js', phase: 'start' };
}

/** @param {object} comparison @returns {string} the numbers of a comparison on one line */
function numbers(comparison) {
  const digits = comparison.unit === 'cpuPct' || comparison.unit === 'printMs' || comparison.unit === 'frameMs' ? 2 : 0;
  const unitName = { ms: 'ms', mb: 'MB', cpuPct: '% of a core', fps: 'fps', printMs: 'ms', frameMs: 'ms' }[comparison.unit];
  return `v1 median ${fmt(comparison.v1.median, digits)} (${fmt(comparison.v1.min, digits)}-${fmt(comparison.v1.max, digits)}), v2 median ${fmt(comparison.v2.median, digits)} (${fmt(comparison.v2.min, digits)}-${fmt(comparison.v2.max, digits)}) ${unitName}, ratio v2/v1 ${fmt(comparison.ratio, 2)}, ${worseText(comparison.worsePct)} worse (an absolute difference of ${fmt(Math.abs(comparison.absDiff), digits)} ${unitName})`;
}

/** @param {object} comparison @returns {string} how a regression reads in a finding: the numbers, the size against the practical floor, and whether the runs overlap */
function describeRegression(comparison) {
  const unitName = { ms: 'ms', mb: 'MB', cpuPct: '% of a core', fps: 'fps', printMs: 'ms', frameMs: 'ms' }[comparison.unit];
  const floor = comparison.smallerThanFloor ? ` (smaller than ${fmt(comparison.floor, comparison.floor < 10 ? 2 : 0)} ${unitName}, the size at which it is noticeable: real, but small)` : '';
  return `${comparison.label}. ${numbers(comparison)}${floor}. The samples ${comparison.confirmed ? 'do not overlap (a real difference, not run-to-run noise)' : 'overlap (a smaller or noisier difference: run again before acting)'}.`;
}

/**
 * The findings of a run in the report schema: every regression of more than 10 percent (one finding per metric, except the print rows,
 * which share one cause and become one finding) and every missed budget.
 *
 * @param {object} analysis
 * @returns {object[]}
 */
function buildFindings(analysis) {
  const findings = [];
  const comparisons = [
    ...(analysis.start ? [...analysis.start.comparisons, analysis.start.loadingScreen] : []),
    ...(analysis.fps ? analysis.fps.comparisons : []),
  ];
  for (const comparison of comparisons) {
    if (!comparison.regression) continue;
    const place = whereIs(comparison);
    findings.push({
      id: `perf-${comparison.id}`,
      severity: 'high',
      area: place.area,
      file: place.file,
      title: comparison.worsePct === Infinity ? `v2 is worse than v1 (v1 measured zero): ${comparison.label}` : `v2 is ${worseText(comparison.worsePct)} worse than v1: ${comparison.label}`,
      description: describeRegression(comparison) + (comparison.id === 'cpu-idle' ? driftNote(analysis.drift) : ''),
      repro: `${REPRO[place.phase]}. ${numbers(comparison)}.`,
    });
  }

  const printRegressions = analysis.print ? analysis.print.comparisons.filter((comparison) => comparison.regression) : [];
  if (printRegressions.length > 0) {
    const worst = printRegressions.reduce((a, b) => (b.worsePct > a.worsePct ? b : a));
    findings.push({
      id: 'perf-print-overhead',
      severity: 'high',
      area: 'electron-printing',
      file: 'src/main/printing/jobs.js',
      title: `v2's print path is up to ${worseText(worst.worsePct)} slower than v1's handler in ${printRegressions.length} of ${analysis.print.comparisons.length} print comparisons (about 1 ms more per job)`,
      description: printRegressions.map(describeRegression).join(' '),
      repro: `${REPRO.print}. ${printRegressions.map((comparison) => `${comparison.label}: ${numbers(comparison)}`).join(' | ')}.`,
    });
  }

  const budgets = [...(analysis.start ? analysis.start.budgets : []), ...(analysis.print ? analysis.print.budgets : [])];
  for (const budget of budgets) {
    if (budget.pass !== false) continue;
    const place = budget.id === 'later-job-overhead' ? { area: 'electron-printing', file: 'src/main/printing/transports/index.js', phase: 'print' } : { area: 'electron-main', file: budget.id === 'rss' ? 'src/main/index.js' : 'src/main/windows/main.js', phase: 'start' };
    findings.push({
      id: `budget-${budget.id}`,
      severity: 'high',
      area: place.area,
      file: place.file,
      title: `SPEC 18b budget missed: ${budget.spec}`,
      description: `${budget.spec}. Limit ${budget.limit}. Measured ${budget.measured}.`,
      repro: `${REPRO[place.phase]}. Limit ${budget.limit}; measured ${budget.measured}.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------------------

function startRows(analysis) {
  const { v1, v2, v2lean } = analysis.start.summary;
  const rows = [];
  const row = (label, key, digits, compare) => rows.push([
    label,
    spread(v1[key], digits),
    spread(v2[key], digits),
    spread(v2lean[key], digits),
    compare ? fmt(compare.ratio, 2) : '-',
    compare ? verdictOf(compare) : '-',
  ]);
  const byId = (id) => analysis.start.comparisons.find((item) => item.id === id);
  row('Time to first window, ms (spawn to first DevTools page target)', 'firstWindowMs', 0, byId('first-window'));
  const loadingBudget = analysis.start.budgets.find((budget) => budget.id === 'loading-screen');
  rows.push(['Time to the loading screen, ms (v2: its loading-visible mark; v1: its first window)', spread(v1.firstWindowMs), spread(v2.loadingVisibleMs), spread(v2lean.loadingVisibleMs), fmt(analysis.start.loadingScreen.ratio, 2), loadingBudget && loadingBudget.pass === false ? 'budget MISSED (needs 0.75)' : verdictOf(analysis.start.loadingScreen)]);
  rows.push(['Window shown on screen, ms (v1: its blank window, `showInactive()` at creation; v2: window-created mark, hidden until the loading page paints)', spread(v1.windowShownMs), spread(v2.windowCreatedMs), spread(v2lean.windowCreatedMs), '-', '-']);
  row('Main-process boot, ms (app-ready to loading-visible; v2 only)', 'bootMs', 0, null);
  row('   of which app-ready to window created, ms (v2 only)', 'readyToWindowMs', 0, null);
  row('   of which window created to the loading screen shown, ms (v2 only: renderer start and first paint)', 'showGapMs', 0, null);
  row('Time to POS loaded, ms (the page\'s load event)', 'posLoadedMs', 0, byId('pos-loaded'));
  row('Process-tree RSS after 30 s idle, MB', 'rss30Mb', 1, byId('rss-30s'));
  row('Process-tree RSS after 60 s idle, MB', 'rss60Mb', 1, byId('rss-60s'));
  row('Processes in the tree', 'processes30', 0, null);
  row('Idle CPU 30-60 s after load, percent of one core', 'cpuIdlePct', 2, byId('cpu-idle'));
  row('CPU 0-30 s after load, percent of one core', 'cpuFirstPct', 2, byId('cpu-first-30s'));
  return rows;
}

function printRows(analysis) {
  const rows = [];
  const variants = [
    ['v1-legacy', 'v1.6.1 handler, `exec` stubbed'],
    ['v2-legacy-real', 'v2 legacy path, real raw printer'],
    ['v2-ack-real', 'v2 acknowledged path, real raw printer'],
    ['v2-ack-fake', 'v2 acknowledged path, fake printers (launch-app.js)'],
  ];
  const summary = analysis.print.summary;
  for (const kind of ['receipt', 'label']) {
    for (const [id, title] of variants) {
      const burst = summary[id] && summary[id][`${kind}-burst`];
      const sequential = summary[id] && summary[id][`${kind}-sequential`];
      if (!burst && !sequential) continue;
      const printer = burst && burst.printer;
      const ack = burst && burst.ack;
      rows.push([
        `${kind}s: ${title}`,
        printer ? spread(printer.firstJobMs, 2) : '-',
        printer ? spread(printer.makespanMs, 1) : '-',
        printer ? spread(printer.serviceMedianMs, 2) : '-',
        ack ? spread(ack.firstJobMs, 2) : '-',
        ack ? spread(ack.makespanMs, 1) : '-',
        sequential && sequential.latency ? spread(sequential.latency.latencyMedianMs, 2) : '-',
      ]);
    }
  }
  return rows;
}

/** @param {object} data @returns {object[]} every run record of every phase */
function allRuns(data) {
  return PHASES.flatMap((phase) => Object.values(data[phase] || {}).flat()).filter(Boolean);
}

/**
 * The conditions and limits that belong next to the numbers: what was measured with what, and what a macOS run on a local server cannot show.
 *
 * @param {object} data
 * @returns {string[]}
 */
function limitNotes(data) {
  const runs = allRuns(data);
  const known = runs.filter((run) => run.machine && typeof run.machine.screenLocked === 'boolean');
  const locked = known.filter((run) => run.machine.screenLocked === true).length;
  const displayOff = known.filter((run) => run.machine.displayOn === false).length;
  const hidden = runs.filter((run) => [run.pageLoad && run.pageLoad.visibility, run.pageEnd && run.pageEnd.visibility, run.info && run.info.visibility, run.result && run.result.visibilityAtStart].some((value) => value && value !== 'visible')).length;
  const skews = runs.flatMap((run) => (run.batches || []).map((batch) => batch.clockSkewMinMs)).filter(Number.isFinite);
  const repeated = ['fps'].flatMap((phase) => Object.values(data[phase] || {}).flat()).filter((run) => run && run.firstAttempt).length;
  const idle = data.meta.options.idleSeconds;
  const notes = [
    `Windows is the target platform; this run is macOS (Intel, ${data.meta.host.memoryGb} GB). The Windows-only parts (the persistent PowerShell print host, the native window occlusion switch, installer and updater) are covered by the unit tests, not by these numbers. The L1 budget is measured here as the app's own overhead per job with the printer stubbed.`,
    'Both versions run UNPACKAGED (`electron <folder>`): the benchmark needs the development start URL, which an installed app ignores. v2 therefore runs with its development logging and development origin rules, and neither has the installer\'s asar archive. The POS is a local server, so the connection setup that `preconnect` (S2) saves on a real network (DNS, TCP, TLS: 50 to 300 ms) is NOT visible in these numbers.',
    `"Cold" means a fresh --user-data-dir (no profile, HTTP cache, GPU cache or settings); the operating system's file cache is warm, because one throw-away start of each version runs first. Versions take turns and the order rotates from round to round.`,
    `Idle protocol: the harness holds no debugger connection and sends nothing while the app idles. RSS is read ${idle} s after the page's load event; idle CPU is the CPU time of the whole process tree over the next ${idle} s (ps reports 10 ms steps, so ${stats.round(0.01 / idle * 100, 3)} percent of a core per step). The process tree is the app, its helpers, and any process that carries the run's data folder (the crash reporter).`,
    'v1 runs the SAME Electron binary from a `git archive` copy with five small patches (the benchmark URL, no focus stealing, a window size knob, `exec` stubbed, the receipt platform check). Its software rendering, its 81 KB single index.js with pdfkit loaded at boot, and its 1600x900 window are v1\'s own.',
    '"v2 (launch-app.js)" is the e2e harness: it adds a control server and a synchronous events file to the app. "v2 lean" is the same `bootstrap()` with nothing else, so the difference between the two columns is what the harness itself costs.',
    `The print runs send ${data.meta.options.printCount} jobs back to back. v1 is fire-and-forget (its handler never answers), so its time is taken at the (stubbed) printer program; v2's acknowledged path answers when the job is done. "v2 real raw printer" runs v2's real temp file, queue and CUPS transport with only \`lp\` stubbed, the same thing v1's patch does to \`exec\`. A real Windows print adds the printer's own time (hundreds of ms) to every job in both versions.`,
    `Screen state: ${locked} of the ${known.length} runs whose screen state was recorded started while the screen was locked${displayOff ? ` (${displayOff} with the display off)` : ' (the display stayed on)'}${runs.length > known.length ? `; ${runs.length - known.length} runs have no record` : ''}; ${hidden === 0 ? 'every page reported visibilityState "visible" (a locked screen with the display on did not change the frame rate: the same stress numbers were measured before and during the lock)' : `${hidden} runs saw a page that was not visible`}.`,
    `The stress page is deliberately heavy so that drawing on the CPU shows (24 translucent shadowed cards moved by CSS transforms over a scrolling 3000-row list); on this display the hardware path is capped by the 60 Hz refresh. ${repeated === 0 ? 'No stress run had to be repeated.' : `${repeated} stress run(s) were repeated once because the window was not visible or produced no frames (the first attempt is kept in benchmark.json).`}`,
  ];
  if (skews.length > 0) notes.push(`Page and main process timestamps come from two clocks: the smallest (job reached the printer stub minus page sent it) over every job was ${stats.round(Math.min(...skews), 2)} ms (negative would mean the clocks disagree).`);
  if (data.meta.host.lowPowerMode) notes.push('macOS Low Power Mode was ON: the machine may run slower than normal, for BOTH versions alike. Absolute numbers are therefore lower bounds; the ratios between the versions are what to read.');
  return notes;
}

/**
 * @param {object} data the raw run (meta, start, fps, print, focus, cleanup)
 * @param {object} analysis
 * @param {object[]} findings
 * @returns {string}
 */
function renderMarkdown(data, analysis, findings) {
  const out = [];
  const host = data.meta.host;
  out.push('# GadgetsPOS Desktop 2.0 against v1.6.1: benchmark', '');
  out.push(`Run ${data.meta.startedAt} to ${data.meta.finishedAt} (${data.meta.durationMinutes} min). Medians with (min-max) over ${data.meta.options.runs} cold starts per version, the versions taking turns, a fresh \`--user-data-dir\` for every start, the same Electron ${host.electron} binary, a local server, no window ever took focus.`, '');
  if ((data.meta.runs || []).length > 1) out.push(`Assembled from ${data.meta.runs.length} runs (\`--merge\`): ${data.meta.runs.map((run) => `${run.phases.join('+')} on ${run.startedAt}${run.v2 ? ` (v2 ${run.v2.commit}${run.v2.dirty ? ', uncommitted changes' : ''})` : ''}${run.note ? ` [${run.note}]` : ''}`).join('; ')}.`, '');
  out.push('## Machine and builds', '');
  out.push(table(['Item', 'Value'], [
    ['Computer', `${host.cpu}, ${host.logicalCores} logical cores, ${host.memoryGb} GB, macOS ${host.macos} (${host.arch})`],
    ['Power', `${host.power}; low power mode ${host.lowPowerMode ? 'ON (the machine may throttle)' : 'off'}${host.thermal ? `; ${host.thermal}` : ''}`],
    ['Load before / after', `${JSON.stringify(data.meta.noiseBefore.machine)} / ${JSON.stringify(data.meta.noiseAfter && data.meta.noiseAfter.machine)}`],
    ['Busiest other processes (before)', data.meta.noiseBefore.busiest.map((item) => `${item.command} ${item.cpuPct}%`).join(', ')],
    ['v1', `${host.v1.version}, commit ${host.v1.commit}, \`git archive\` copy, ${host.v1.patches.length} patches (${host.v1.patches.join('; ')})`],
    ['v2', `${host.v2.branch} @ ${host.v2.commit}${host.v2.dirty ? ' (uncommitted changes in the worktree)' : ''}`],
  ].map(([a, b]) => [a, b])), '');

  if (analysis.start) {
    out.push('## Start-up, memory and idle CPU', '');
    out.push(table(['Metric', 'v1', 'v2 (launch-app.js)', 'v2 lean (no harness)', 'v2/v1', 'Verdict'], startRows(analysis)), '');
    out.push('RSS by role after 30 s idle (median, MB): ' + ['v1', 'v2', 'v2lean'].map((kind) => `${kind}: ${Object.entries(analysis.start.summary[kind].rssByRoleMb).map(([role, mb]) => `${role} ${mb}`).join(', ')}`).join('; ') + '.', '');
    out.push('## SPEC 18b budgets', '');
    out.push(table(['Budget', 'Limit', 'Measured', 'Result'], [...analysis.start.budgets, ...(analysis.print ? analysis.print.budgets : [])].map((budget) => [budget.spec, budget.limit, budget.measured, budget.pass === null ? 'no data' : budget.pass ? 'PASS' : 'MISSED'])), '');
  }

  if (analysis.fps) {
    out.push('## Frames per second of the stress page (3000 rows, 24 moving translucent cards, scrolling, 8 s)', '');
    const { summary, gpu } = analysis.fps;
    const gpuText = (info) => (info && info.featureStatus ? `gpu_compositing ${info.featureStatus.gpu_compositing}, rasterization ${info.featureStatus.rasterization}` : '-');
    out.push(table(['Mode', 'FPS', 'p95 frame ms', 'Slow frames (>25 ms)', 'CPU cores used', 'GPU status'], [
      ['v1 (software rendering)', spread(summary.v1.fps, 1), spread(summary.v1.frameMsP95, 1), spread(summary.v1.slowFrames, 0), spread(summary.v1.cpuCores, 2), gpuText(gpu.v1)],
      ['v2 default (hardware acceleration)', spread(summary.v2.fps, 1), spread(summary.v2.frameMsP95, 1), spread(summary.v2.slowFrames, 0), spread(summary.v2.cpuCores, 2), gpuText(gpu.v2)],
      ['v2 compatibility mode (disableGpu)', spread(summary.v2sw.fps, 1), spread(summary.v2sw.frameMsP95, 1), spread(summary.v2sw.slowFrames, 0), spread(summary.v2sw.cpuCores, 2), gpuText(gpu.v2sw)],
    ]), '');
    out.push(table(['Comparison with v1', 'v2/v1', 'Verdict'], analysis.fps.comparisons.map((item) => [item.label, fmt(item.ratio, 2), verdictOf(item)])), '');
  }

  if (analysis.print) {
    out.push('## Print-job latency, 50 jobs per batch, fake printers', '');
    out.push('All times in ms, median (min-max) over the runs. 50 jobs are sent back to back; "at the printer" is when the (stubbed) printer program was reached (main process), "answer" is when the page got the acknowledgement; "per job" is the median gap between two finished jobs; "one by one" is the answer time of a job sent after the previous one was answered (how a v2 web loop prints).', '');
    out.push(table(['Batch', 'At the printer: first job', 'At the printer: total (50)', 'At the printer: per job', 'Answer: first job', 'Answer: total (50)', 'Answer: one by one'], printRows(analysis)), '');
    out.push(table(['Comparison with v1', 'v2/v1', 'Verdict'], analysis.print.comparisons.map((item) => [item.label, fmt(item.ratio, 2), verdictOf(item)])), '');
  }

  if (analysis.diag) {
    out.push('## Where the loading screen\'s time goes (v2 lean, hardware acceleration on and off, times only)', '');
    const gpu = analysis.diag.summary['v2lean-gpu'];
    const soft = analysis.diag.summary['v2lean-nogpu'];
    const cost = analysis.diag.gpuCostMs;
    const line = (label, key, costKey) => [label, spread(gpu[key]), spread(soft[key]), `${Number.isFinite(cost[costKey]) ? (cost[costKey] > 0 ? '+' : '') + fmt(cost[costKey]) : '-'} ms`];
    out.push(table(['Moment (ms since the spawn unless noted)', 'GPU on (default)', 'Compatibility mode (GPU off)', 'GPU minus compatibility'], [
      line('First DevTools page target', 'firstWindowMs', 'firstWindow'),
      line('Window created (mark)', 'windowCreatedMs', 'windowCreated'),
      line('Loading screen shown (mark)', 'loadingVisibleMs', 'loadingVisible'),
      line('Window created to loading screen shown (ms)', 'showGapMs', 'showGap'),
      line('Main-process boot, app-ready to loading screen (ms)', 'bootMs', 'boot'),
      line('POS loaded', 'posLoadedMs', 'posLoaded'),
    ]), '');
  }

  if (analysis.drift && Object.keys(analysis.drift).length > 0) {
    out.push('## Idle drift: the app left alone (one run per variant)', '');
    const variants = [['v1', 'v1'], ['v2lean-gpu', 'v2 GPU on'], ['v2lean-nogpu', 'v2 GPU off']].filter(([id]) => analysis.drift[id]);
    const times = analysis.drift[variants[0][0]].samples.map((sample) => sample.t);
    const cell = (id, t) => {
      const sample = analysis.drift[id].samples.find((item) => item.t === t);
      return sample ? `${fmt(sample.totalMb, 1)} (${fmt(sample.roles.renderer ? sample.roles.renderer.rssMb : NaN, 1)})` : '-';
    };
    out.push(table(['Seconds after the POS loaded', ...variants.map(([, title]) => `${title}: total MB (renderer MB)`)], times.map((t) => [String(t), ...variants.map(([id]) => cell(id, t))])), '');
    out.push(table(['Variant', 'Memory at the settle time to the end, MB', 'Biggest one-time step', 'Idle CPU after the settle time', 'CPU seconds by role'], variants.map(([id, title]) => {
      const item = analysis.drift[id];
      return [
        item.spoiled ? `${title} (SPOILED: the screen was unlocked during this run, do not read it)` : title,
        `${fmt(item.rssAtSettleMb, 1)} to ${fmt(item.rssLastMb, 1)} (${item.rssGrowthSinceSettleMb > 0 ? '+' : ''}${item.rssGrowthSinceSettleMb})`,
        item.step ? `${item.step.role} +${item.step.mb} MB between ${item.step.fromS} and ${item.step.toS} s` : 'none',
        `${fmt(item.idleCpuPct, 3)} % of a core over ${item.idleWindowS} s (${fmt(item.settleS)}-${fmt(item.lastS)} s)`,
        Object.entries(item.cpuByRole).map(([role, value]) => `${role} ${value}`).join(', '),
      ];
    })), '');
  }

  out.push('## Findings', '');
  if (findings.length === 0) out.push('No metric is worse than v1 by more than 10 percent and no budget is missed.', '');
  for (const finding of findings) out.push(`- **${finding.title}** (${finding.severity}): ${finding.description}`);
  if (findings.length > 0) out.push('');

  out.push('## How to read this, and what it cannot show', '');
  for (const note of limitNotes(data)) out.push(`- ${note}`);
  out.push('');

  out.push('## Checks', '');
  out.push(`- Focus: ${data.focus ? `${data.focus.samples} samples of the frontmost application (${(data.focus.apps || []).join(', ')}); ${data.focus.stolen.length} of them were one of the benchmark's own processes.` : 'not sampled.'}`);
  out.push(`- Cleanup: ${data.cleanup ? `${data.cleanup.spawned} processes started, ${data.cleanup.strays.length} still running at the end.` : 'not checked.'}`);
  const errors = PHASES.flatMap((phase) => Object.values((data[phase] || {})).flat().filter((run) => run && run.error).map((run) => `${phase}/${run.kind || run.mode || run.variant} ${run.index}: ${run.error}`));
  out.push(`- Runs that failed: ${errors.length === 0 ? 'none.' : errors.join('; ')}`);
  for (const [phase, error] of Object.entries(data.phaseErrors || {})) out.push(`- Phase ${phase} failed: ${String(error).split('\n')[0]}`);
  return out.join('\n');
}

/**
 * @param {object} data the raw run
 * @returns {{ analysis: object, findings: object[], markdown: string }}
 */
function buildReport(data) {
  const analysis = {};
  if (data.start) analysis.start = analyzeStart(data.start);
  if (data.fps) analysis.fps = analyzeFps(data.fps);
  if (data.print) analysis.print = analyzePrint(data.print);
  if (data.diag) analysis.diag = analyzeDiag(data.diag);
  if (data.drift) analysis.drift = analyzeDrift(data.drift);
  const findings = buildFindings(analysis);
  return { analysis, findings, markdown: renderMarkdown(data, analysis, findings) };
}

module.exports = { buildReport, analyzeStart, analyzeFps, analyzePrint, analyzeDiag, analyzeDrift, driftNote, buildFindings, renderMarkdown, printValues, mergeData };
