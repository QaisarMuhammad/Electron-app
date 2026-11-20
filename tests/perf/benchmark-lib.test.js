'use strict';

/**
 * Tests of the benchmark's own code (tests/perf/*.js): the statistics, the process-table parsing, the v1 patcher, the analysis and report
 * and the benchmark server. Plain Node, no Electron, no running app: the benchmark itself is `node tests/perf/benchmark.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const stats = require('./stats');
const procs = require('./procs');
const analyze = require('./analyze');
const { buildReport, buildFindings, mergeData, analyzeDiag, analyzeDrift, driftNote } = require('./report');
const { patchV1Source, v1Patches, buildV1Copy } = require('./v1-copy');
const { startBenchServer } = require('./bench-server');
const { parseOptions } = require('./benchmark');

// ---------------------------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------------------------

test('stats: median, percentile, mean and stdev', () => {
  assert.equal(stats.median([3, 1, 2]), 2);
  assert.equal(stats.median([1, 2, 3, 4]), 2.5);
  assert.equal(stats.percentile([10, 20, 30, 40, 50], 0.95), 48);
  assert.equal(stats.mean([2, 4, 6]), 4);
  assert.equal(stats.stdev([5]), 0);
  assert.ok(Math.abs(stats.stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
  assert.ok(Number.isNaN(stats.median([])));
  assert.equal(stats.median([1, NaN, 3, undefined, Infinity]), 2, 'values that are not finite numbers are ignored');
});

test('stats: summarize, ratio, round and rangesSeparate', () => {
  const summary = stats.summarize([4, 1, 3, 2, 5]);
  assert.deepEqual({ n: summary.n, min: summary.min, median: summary.median, max: summary.max }, { n: 5, min: 1, median: 3, max: 5 });
  assert.equal(stats.ratio(3, 4), 0.75);
  assert.ok(Number.isNaN(stats.ratio(3, 0)));
  assert.ok(Number.isNaN(stats.ratio(NaN, 2)));
  assert.equal(stats.round(1.23456, 2), 1.23);
  assert.equal(stats.rangesSeparate([1, 2, 3], [4, 5, 6]), true);
  assert.equal(stats.rangesSeparate([1, 2, 5], [4, 5, 6]), false, 'overlapping ranges are not clearly apart');
  assert.equal(stats.rangesSeparate([], [1]), false);
});

// ---------------------------------------------------------------------------------------------------------------------------
// procs
// ---------------------------------------------------------------------------------------------------------------------------

test('procs: parseCpuTime reads the ps TIME column in every shape', () => {
  assert.equal(procs.parseCpuTime('0:00.01'), 0.01);
  assert.equal(procs.parseCpuTime('21:19.48'), 21 * 60 + 19.48);
  assert.equal(procs.parseCpuTime('1:23:45'), 3600 + 23 * 60 + 45);
  assert.equal(procs.parseCpuTime('2-01:00:00'), 2 * 86400 + 3600);
  assert.ok(Number.isNaN(procs.parseCpuTime('garbage')));
});

const SAMPLE_TABLE = [
  '    1     0  20576   8:16.98 /sbin/launchd',
  '  100     1 117000   0:03.20 /x/Electron.app/Contents/MacOS/Electron --remote-debugging-port=1 --user-data-dir=/t/gpos-bench-aa11 /x/launch.js',
  '  101   100 105000   0:01.50 /x/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process --user-data-dir=/t/gpos-bench-aa11',
  '  102   100  25000   0:00.40 /x/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService',
  '  103   100 104000   0:02.00 /x/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer',
  '  104     1   2000   0:00.02 /x/chrome_crashpad_handler --database=/t/gpos-bench-aa11/Crashpad',
  '  200     1   9000   0:01.00 /Applications/Other.app/Contents/MacOS/Other',
  'not a process line',
].join('\n');

test('procs: parseProcessTable keeps well-formed lines and the whole command', () => {
  const rows = procs.parseProcessTable(SAMPLE_TABLE);
  assert.equal(rows.length, 7);
  assert.deepEqual({ pid: rows[1].pid, ppid: rows[1].ppid, rssKb: rows[1].rssKb, cpuSec: rows[1].cpuSec }, { pid: 100, ppid: 1, rssKb: 117000, cpuSec: 3.2 });
  assert.match(rows[1].command, /--user-data-dir=\/t\/gpos-bench-aa11 \/x\/launch\.js$/);
});

test('procs: appProcesses takes the tree and the detached helpers that carry the run marker, nothing else', () => {
  const rows = procs.parseProcessTable(SAMPLE_TABLE);
  const mine = procs.appProcesses(rows, 100, 'gpos-bench-aa11');
  assert.deepEqual(mine.map((row) => row.pid).sort(), [100, 101, 102, 103, 104]);
  assert.deepEqual(procs.appProcesses(rows, 100).map((row) => row.pid).sort(), [100, 101, 102, 103], 'without a marker only the tree');
  assert.deepEqual(procs.appProcesses(rows, -1, 'gpos-bench-zz99'), [], 'an unknown marker matches nothing');
});

test('procs: classifyProcess and memoryOf', () => {
  const rows = procs.appProcesses(procs.parseProcessTable(SAMPLE_TABLE), 100, 'gpos-bench-aa11');
  assert.deepEqual(rows.map((row) => procs.classifyProcess(row.command)), ['main', 'gpu', 'network', 'renderer', 'crashpad']);
  const memory = procs.memoryOf(rows);
  assert.equal(memory.processes, 5);
  assert.equal(memory.rssMb, Math.round(((117000 + 105000 + 25000 + 104000 + 2000) / 1024) * 10) / 10);
  assert.equal(memory.byRole.gpu.processes, 1);
});

test('procs: byRole adds memory and CPU up per process role', () => {
  const rows = procs.appProcesses(procs.parseProcessTable(SAMPLE_TABLE), 100, 'gpos-bench-aa11');
  const roles = procs.byRole(rows);
  assert.deepEqual(Object.keys(roles).sort(), ['crashpad', 'gpu', 'main', 'network', 'renderer']);
  assert.deepEqual(roles.gpu, { processes: 1, rssMb: Math.round((105000 / 1024) * 10) / 10, cpuSec: 1.5 });
  assert.equal(roles.renderer.cpuSec, 2);
});

test('procs: cpuBetween counts differences, new processes in full, and reports the ones that ended', () => {
  const before = [{ pid: 1, cpuSec: 10, rssKb: 0, ppid: 0, command: '' }, { pid: 2, cpuSec: 5, rssKb: 0, ppid: 0, command: '' }];
  const after = [{ pid: 1, cpuSec: 10.5, rssKb: 0, ppid: 0, command: '' }, { pid: 3, cpuSec: 0.25, rssKb: 0, ppid: 0, command: '' }];
  assert.deepEqual(procs.cpuBetween(before, after), { cpuSec: 0.75, started: 1, ended: 1 });
});

test('procs: parseCpuUsage reads the last sample of top, parseScreenLocked reads ioreg', () => {
  const top = 'CPU usage: 50.0% user, 20.0% sys, 30.0% idle\nProcesses: 1\nCPU usage: 1.5% user, 2.5% sys, 96.0% idle\n';
  assert.deepEqual(procs.parseCpuUsage(top), { user: 1.5, sys: 2.5, idle: 96 });
  assert.equal(procs.parseCpuUsage('nothing'), null);
  assert.equal(procs.parseScreenLocked('"kCGSSessionOnConsoleKey" = true\n"CGSSessionScreenIsLocked" = Yes'), true);
  assert.equal(procs.parseScreenLocked('"kCGSSessionOnConsoleKey" = true'), false, 'no lock key while a user is on the console means not locked');
  assert.equal(procs.parseScreenLocked(''), null);
});

// ---------------------------------------------------------------------------------------------------------------------------
// the v1 patcher
// ---------------------------------------------------------------------------------------------------------------------------

/** The five lines of v1's index.js that the benchmark patches, in a file that is otherwise unlike v1. */
const V1_FIXTURE = [
  "const { exec } = require('child_process');",
  "const { app, BrowserWindow, ipcMain, Menu, dialog, session } = require('electron');",
  "const defaultURL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';",
  'function createWindow() {',
  '    const newWindow = new BrowserWindow({',
  '        width: 1600,',
  '        height: 900,',
  '    });',
  '    return newWindow;',
  '}',
  'function printDirectReceipt() {',
  "    if (process.platform !== 'win32') {",
  '        return;',
  '    }',
  '}',
  '',
].join('\n');

test('v1 patcher: applies every patch exactly once and the result is valid JavaScript', () => {
  const { source, applied } = patchV1Source(V1_FIXTURE, 'http://127.0.0.1:4321');
  assert.equal(applied.length, v1Patches('x').length);
  new vm.Script(source, { filename: 'v1-patched.js' }); // throws on a syntax error (an unescaped newline in the generated text, for example)
  assert.match(source, /process\.env\.GPOS_BENCH_URL \|\| 'http:\/\/127\.0\.0\.1:4321\/pos'/);
  assert.match(source, /setActivationPolicy\('accessory'\)/);
  assert.match(source, /this\.showInactive\(\)/);
  assert.match(source, /GPOS_BENCH_W/);
  assert.match(source, /BENCHJOB/);
  assert.match(source, /process\.env\.GPOS_BENCH_PRINT/);
  assert.doesNotMatch(source, /const \{ exec \} = require/, 'the real exec is replaced');
});

test('v1 patcher: a v1 that does not look as expected stops the benchmark, naming the patch', () => {
  assert.throws(() => patchV1Source(V1_FIXTURE.replace('width: 1600', 'width: 1500'), 'http://127.0.0.1:1'), /window size.*matched 0 times/);
  assert.throws(() => patchV1Source(`${V1_FIXTURE}\n${V1_FIXTURE}`, 'http://127.0.0.1:1'), /matched 2 times/);
});

test('v1 patcher: the exec stand-in answers at once and reports the job on stdout', () => {
  const { source } = patchV1Source(V1_FIXTURE, 'http://127.0.0.1:1');
  const written = [];
  const sandbox = {
    require: (name) => (name === 'perf_hooks' ? require('node:perf_hooks') : { app: { setActivationPolicy() {} }, BrowserWindow: class {} }),
    process: { platform: 'linux', env: {}, stdout: { write: (text) => written.push(text) } },
    setImmediate,
    global: {},
    Object,
    JSON,
    Number,
    String,
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.__exec = exec;`, sandbox);
  let answered = null;
  sandbox.__exec('cmd /c copy /B "C:\\tmp\\label.zpl" "LPT2"', { shell: true }, (error, out) => {
    answered = { error, out };
  });
  return new Promise((resolve) => setImmediate(() => setImmediate(() => {
    assert.deepEqual(answered, { error: null, out: '' });
    const job = JSON.parse(written.find((line) => line.startsWith('BENCHJOB ')).slice('BENCHJOB '.length));
    assert.equal(job.kind, 'label');
    assert.ok(job.doneAt >= job.execAt);
    resolve();
  })));
});

test('v1 copy: git archive, symlinked node_modules and the patches, from a throw-away repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-bench-test-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), V1_FIXTURE);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'v1', version: '1.6.1', main: 'index.js' }));
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    fs.mkdirSync(path.join(dir, 'modules'));
    const copy = buildV1Copy({ repo, destDir: path.join(dir, 'copy'), nodeModules: path.join(dir, 'modules'), benchOrigin: 'http://127.0.0.1:99', commit: 'HEAD' });
    assert.equal(copy.version, '1.6.1');
    assert.equal(copy.applied.length, 5);
    assert.ok(fs.lstatSync(path.join(copy.dir, 'node_modules')).isSymbolicLink());
    assert.match(fs.readFileSync(path.join(copy.dir, 'index.js'), 'utf8'), /GPOS_BENCH_URL/);
    assert.equal(fs.readFileSync(path.join(repo, 'index.js'), 'utf8'), V1_FIXTURE, 'the source repository is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------------------------------------------------------

test('analyze: a metric is a regression only beyond 10 percent AND beyond the resolution floor', () => {
  const clear = analyze.compareMetric({ id: 'a', label: 'a', unit: 'ms', better: 'lower', v1: [100, 102, 101], v2: [150, 152, 151] });
  assert.equal(clear.regression, true);
  assert.equal(clear.confirmed, true, 'the samples do not overlap');
  assert.ok(Math.abs(clear.worsePct - 50) < 1);

  const noisy = analyze.compareMetric({ id: 'b', label: 'b', unit: 'ms', better: 'lower', v1: [1000, 1200, 1400], v2: [1400, 1500, 900] });
  assert.equal(noisy.regression, true);
  assert.equal(noisy.confirmed, false, 'overlapping samples are not called confirmed');

  const tiny = analyze.compareMetric({ id: 'c', label: 'c', unit: 'cpuPct', better: 'lower', v1: [0.2, 0.3], v2: [0.3, 0.4] });
  assert.equal(tiny.regression, false, '+40 percent but 0.1 of a core, inside the noise: below the resolution of ps');
  assert.equal(tiny.belowResolution, true);

  const tinyButReal = analyze.compareMetric({ id: 'c2', label: 'c2', unit: 'cpuPct', better: 'lower', v1: [0, 0, 0], v2: [0.1, 0.13, 0.1] });
  assert.equal(tinyButReal.regression, true, 'every v2 run is above every v1 run: a real difference, however small');
  assert.equal(tinyButReal.confirmed, true);
  assert.equal(tinyButReal.smallerThanFloor, true, 'and it is reported as smaller than the practical floor');

  const within = analyze.compareMetric({ id: 'd', label: 'd', unit: 'ms', better: 'lower', v1: [100], v2: [108] });
  assert.equal(within.regression, false, '8 percent is within the 10 percent rule');
});

test('analyze: a v1 value of zero makes any v2 value above it infinitely worse (lower is better)', () => {
  const comparison = analyze.compareMetric({ id: 'z', label: 'z', unit: 'cpuPct', better: 'lower', v1: [0, 0, 0], v2: [0.1, 0.13, 0.1] });
  assert.equal(comparison.worsePct, Infinity);
  assert.equal(comparison.regression, true);
  assert.equal(analyze.worseText(comparison.worsePct), 'from zero');
  const same = analyze.compareMetric({ id: 'z2', label: 'z2', unit: 'cpuPct', better: 'lower', v1: [0, 0], v2: [0, 0] });
  assert.equal(same.regression, false);
  assert.equal(analyze.verdictOf(same), 'same');
});

test('analyze: for frames per second HIGHER is better', () => {
  const worse = analyze.compareMetric({ id: 'f', label: 'f', unit: 'fps', better: 'higher', v1: [60, 60], v2: [40, 41] });
  assert.equal(worse.regression, true);
  assert.ok(worse.worsePct > 30);
  const better = analyze.compareMetric({ id: 'g', label: 'g', unit: 'fps', better: 'higher', v1: [16, 16], v2: [60, 60] });
  assert.equal(better.regression, false);
  assert.ok(better.worsePct < 0);
  assert.equal(analyze.verdictOf(better), 'better');
});

test('analyze: a larger floor can be given per comparison (a total of 50 jobs)', () => {
  const total = analyze.compareMetric({ id: 't', label: 't', unit: 'printMs', better: 'lower', v1: [40, 44, 48], v2: [43, 49, 55], floor: 25 });
  assert.equal(total.regression, false, '+11 percent, but 5 ms in 50 jobs and the runs overlap');
  assert.equal(total.belowResolution, true);
});

test('analyze: batch and latency metrics', () => {
  const sent = [0, 0, 0, 0];
  const done = [5, 3, 4, 6];
  const metrics = analyze.batchMetrics(sent, done);
  assert.deepEqual({ count: metrics.count, firstJobMs: metrics.firstJobMs, makespanMs: metrics.makespanMs, perJobMs: metrics.perJobMs, serviceMedianMs: metrics.serviceMedianMs }, { count: 4, firstJobMs: 3, makespanMs: 6, perJobMs: 1.5, serviceMedianMs: 1 });
  assert.equal(analyze.batchMetrics([], []), null);
  const latency = analyze.latencyMetrics([0, 10, 20], [2, 14, 23]);
  assert.equal(latency.latencyMedianMs, 3);
  assert.equal(latency.latencyMaxMs, 4);
});

test('analyze: marks become "since the spawn" and the boot is app-ready to loading-visible', () => {
  assert.equal(analyze.markFromSpawn(1000320, 783, 1000000), 1103);
  assert.deepEqual(analyze.bootOf({ 'app-ready': 250, 'loading-visible': 770 }), { bootMs: 520 });
  assert.deepEqual(analyze.bootOf({ 'app-ready': 250 }), { bootMs: null });
  assert.deepEqual(analyze.bootOf(null), { bootMs: null });
});

// ---------------------------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------------------------

/** A start-up record shaped like the ones benchmark.js writes. */
function startRun(kind, { first, loaded, visible, boot, rss, cpu }) {
  return {
    kind,
    index: 1,
    firstTargetMs: first,
    loadedMs: loaded,
    loadingVisibleMs: visible,
    windowCreatedMs: visible ? visible - 300 : undefined,
    bootMs: boot,
    idle: {
      rss30: { processes: 4, rssMb: rss, byRole: { main: { processes: 1, rssMb: rss / 2 } } },
      rss60: { processes: 4, rssMb: rss, byRole: {} },
      cpuFirst: { percentOfCore: cpu * 3 },
      cpuIdle: { percentOfCore: cpu },
    },
  };
}

function syntheticData({ v2Visible, v2Boot, v2Rss }) {
  const runs = (kind, spec) => [0, 1, 2].map((n) => startRun(kind, Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, value === undefined ? undefined : value + n]))));
  return {
    meta: {
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:30:00.000Z',
      durationMinutes: 30,
      options: { runs: 3 },
      host: { cpu: 'Test CPU', logicalCores: 8, memoryGb: 16, macos: '15', arch: 'x64', electron: '32.3.3', power: 'AC', lowPowerMode: false, thermal: '', v1: { version: '1.6.1', commit: 'abc1234', patches: ['a'] }, v2: { branch: 'b', commit: 'def5678', dirty: false } },
      noiseBefore: { machine: { loadavg1: 1 }, busiest: [{ command: 'x', cpuPct: 1 }] },
      noiseAfter: { machine: { loadavg1: 1 } },
    },
    start: {
      v1: runs('v1', { first: 1000, loaded: 1100, boot: undefined, rss: 350, cpu: 0.3 }),
      v2: runs('v2', { first: 700, loaded: 1150, visible: v2Visible, boot: v2Boot, rss: v2Rss, cpu: 0.3 }),
      v2lean: runs('v2lean', { first: 700, loaded: 1150, visible: v2Visible, boot: v2Boot, rss: v2Rss, cpu: 0.3 }),
    },
    focus: { samples: 3, stolen: [], apps: ['Google Chrome'] },
    cleanup: { spawned: 9, strays: [] },
    phaseErrors: {},
  };
}

test('report: a v2 that meets every budget has no findings', () => {
  const { analysis, findings, markdown } = buildReport(syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 }));
  assert.deepEqual(findings, []);
  assert.ok(analysis.start.budgets.every((budget) => budget.pass === true));
  assert.match(markdown, /## Start-up, memory and idle CPU/);
  assert.match(markdown, /No metric is worse than v1 by more than 10 percent and no budget is missed\./);
});

test('report: missed budgets and regressions become findings with the numbers in them', () => {
  const data = syntheticData({ v2Visible: 1000, v2Boot: 500, v2Rss: 340 });
  data.start.v2.forEach((run) => { run.loadedMs += 800; });
  const findings = buildReport(data).findings;
  const ids = findings.map((finding) => finding.id);
  assert.ok(ids.includes('budget-loading-screen'), ids.join());
  assert.ok(ids.includes('budget-main-boot'));
  assert.ok(ids.includes('budget-rss'));
  assert.ok(ids.includes('perf-pos-loaded'), 'time to POS loaded is 800 ms (73 percent) worse');
  const posLoaded = findings.find((finding) => finding.id === 'perf-pos-loaded');
  assert.equal(posLoaded.severity, 'high');
  assert.match(posLoaded.repro, /v1 median 1101.*v2 median 1951/);
  assert.match(posLoaded.repro, /absolute difference of 850 ms/);
  for (const finding of findings) {
    assert.ok(finding.id && finding.area && finding.file && finding.title && finding.description && finding.repro, `${finding.id} is complete`);
  }
});

test('report: a phase without data gives "no data", never a failed budget', () => {
  const data = syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 });
  data.start.v2 = [{ kind: 'v2', index: 1, error: 'the app did not start' }];
  const { analysis, findings } = buildReport(data);
  assert.ok(analysis.start.budgets.every((budget) => budget.pass === null));
  assert.equal(findings.filter((finding) => finding.id.startsWith('budget-')).length, 0);
});

test('report: print comparisons use the per-job floor, so 5 ms over 50 jobs is not a finding', () => {
  const batch = (kind, level, makespanMs) => ({ kind, mode: 'burst', count: 50, [level]: { firstJobMs: 5, makespanMs, perJobMs: makespanMs / 50, serviceMedianMs: 1, serviceP95Ms: 2 } });
  const print = {
    'v1-legacy': [{ batches: [batch('receipt', 'printer', 44)] }],
    'v2-ack-fake': [{ batches: [batch('receipt', 'ack', 49.5)] }],
    'v2-ack-real': [{ batches: [batch('receipt', 'ack', 140)] }],
    'v2-legacy-real': [],
  };
  const findings = buildFindings({ print: require('./report').analyzePrint(print) });
  const ids = findings.map((finding) => finding.id);
  assert.ok(!ids.includes('perf-print-receipt-ack-fake-total'), '5 ms in 50 jobs is below 0.5 ms per job');
  assert.ok(ids.some((id) => id.startsWith('perf-print')), '96 ms in 50 jobs is about 2 ms per job and 3x');
});

// ---------------------------------------------------------------------------------------------------------------------------
// the benchmark server
// ---------------------------------------------------------------------------------------------------------------------------

test('bench server: pages, a timestamped report and a command round trip', async () => {
  const server = await startBenchServer();
  try {
    const page = await (await fetch(server.url('pos', 'r1'))).text();
    assert.match(page, /<title>Benchmark POS<\/title>/);
    assert.equal((page.match(/class="card"/g) || []).length, 150);
    assert.ok(page.length < 120 * 1024, 'the light page stays light');
    assert.match(await (await fetch(server.url('stress', 'r1'))).text(), /id="list"/);
    assert.equal((await fetch(`${server.origin}/anything`, { method: 'HEAD' })).status, 200, 'the v2 connection probe is answered');

    const waiting = server.waitReport('r1', 'loaded', 2000);
    await fetch(`${server.origin}/__bench/report?run=r1&kind=loaded`, { method: 'POST', body: JSON.stringify({ visibility: 'visible' }) });
    const entry = await waiting;
    assert.equal(entry.data.visibility, 'visible');
    assert.ok(Number.isFinite(entry.at));
    assert.equal(server.getReport('r1', 'loaded').data.visibility, 'visible');

    // A page asks for its next command (a long poll), runs it and posts the answer.
    const pagePart = (async () => {
      const command = await (await fetch(`${server.origin}/__bench/next?run=r1`)).json();
      await fetch(`${server.origin}/__bench/report?run=r1&kind=result-${command.id}`, { method: 'POST', body: JSON.stringify({ echoed: command.args.value }) });
    })();
    assert.deepEqual(await server.command('r1', 'echo', { value: 7 }, 2000), { echoed: 7 });
    await pagePart;
    await assert.rejects(server.waitReport('r2', 'ready', 50), /no "ready" report/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------------------------------------------------------

test('options: defaults follow the SPEC, --quick shrinks everything, a bad argument stops the run', () => {
  const defaults = parseOptions([]);
  assert.deepEqual({ runs: defaults.runs, idle: defaults.idleSeconds, fpsRuns: defaults.fpsRuns, fps: defaults.fpsSeconds, count: defaults.printCount }, { runs: 5, idle: 30, fpsRuns: 5, fps: 8, count: 50 });
  const quick = parseOptions(['--quick']);
  assert.deepEqual({ runs: quick.runs, idle: quick.idleSeconds, quick: quick.quick }, { runs: 1, idle: 5, quick: true });
  assert.equal(parseOptions(['--runs=3', '--phases=start']).runs, 3);
  assert.deepEqual(parseOptions(['--phases=start,print']).phases, ['start', 'print']);
  assert.deepEqual(defaults.phases, ['start', 'fps', 'print', 'diag']);
  assert.equal(defaults.diagRuns, 5, 'the diagnosis runs as often as the comparison by default');
  assert.equal(defaults.merge, false);
  assert.equal(parseOptions(['--merge', '--phases=fps']).merge, true);
  assert.equal(parseOptions(['--runs=3']).diagRuns, 3);
  assert.equal(defaults.driftRuns, 1);
  assert.deepEqual(defaults.driftTimes, [10, 30, 60, 90, 120, 180, 240]);
  assert.deepEqual(parseOptions(['--phases=drift', '--drift-times=5,10,20']).driftTimes, [5, 10, 20]);
  assert.throws(() => parseOptions(['--drift-times=5,10']), /at least three/);
  assert.throws(() => parseOptions(['--drift-times=5,20,10']), /increasing/);
  assert.equal(parseOptions(['--runs=3', '--diag-runs=2']).diagRuns, 2);
  assert.throws(() => parseOptions(['--runs=abc']), /positive number/);
  assert.throws(() => parseOptions(['--phases=nope']), /unknown phase/);
  assert.throws(() => parseOptions(['runs=3']), /unknown argument/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// the diagnosis and --merge
// ---------------------------------------------------------------------------------------------------------------------------

test('diagnosis: the cost of hardware acceleration is the difference of the medians', () => {
  const run = (visible, created, ready, loaded) => ({ kind: 'v2lean', index: 1, firstTargetMs: created + 40, windowCreatedMs: created, loadingVisibleMs: visible, appReadyMs: ready, bootMs: visible - ready, loadedMs: loaded });
  const diag = {
    'v2lean-gpu': [run(1100, 770, 570, 1300), run(1120, 780, 580, 1320), run(1110, 775, 575, 1310)],
    'v2lean-nogpu': [run(900, 770, 570, 1250), run(920, 780, 580, 1270), run(910, 775, 575, 1260)],
  };
  const { gpuCostMs, summary } = analyzeDiag(diag);
  assert.equal(gpuCostMs.loadingVisible, 200);
  assert.equal(gpuCostMs.windowCreated, 0);
  assert.equal(gpuCostMs.showGap, 200, 'window created to loading screen shown');
  assert.equal(summary['v2lean-gpu'].showGapMs.median, 335);
  const { markdown } = buildReport({ ...syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 }), diag });
  assert.match(markdown, /## Where the loading screen's time goes/);
  assert.match(markdown, /Window created to loading screen shown \(ms\) \| 335 \(330-340\) \| 135 \(130-140\) \| \+200 ms/);
});

test('merge: a re-run phase replaces its old data, the other phases and the bookkeeping are kept', () => {
  const stamp = (startedAt, commit) => ({ startedAt, finishedAt: startedAt, durationMinutes: 10, host: { v2: { commit, dirty: false } }, noiseBefore: { machine: {} }, noiseAfter: { machine: {} }, options: {} });
  const first = { meta: { ...stamp('t1', 'aaa'), options: { runs: 5, idleSeconds: 30, fpsRuns: 5, fpsSeconds: 8 } }, start: { v1: [{ index: 1 }] }, fps: { v1: [{ index: 1 }] }, focus: { samples: 4, stolen: [], apps: ['Chrome'] }, cleanup: { spawned: 10, strays: [] }, phaseErrors: { fps: 'it broke' } };
  const base = mergeData(null, first, { phases: ['start', 'fps'], runs: 5, idleSeconds: 30, fpsRuns: 5, fpsSeconds: 8 });
  assert.equal(base.meta.runs.length, 1);
  assert.deepEqual(base.meta.runs[0].phases, ['start', 'fps']);

  const rerun = { meta: { ...stamp('t2', 'bbb'), options: {} }, fps: { v1: [{ index: 9 }] }, focus: { samples: 2, stolen: [], apps: ['Chrome', 'loginwindow'] }, cleanup: { spawned: 3, strays: [] }, phaseErrors: {} };
  const merged = mergeData({ ...base, analysis: { stale: true }, findings: [{ stale: true }] }, rerun, { phases: ['fps'], fpsRuns: 2, fpsSeconds: 4 });
  assert.deepEqual(merged.start, first.start, 'the phase that was not re-run is kept');
  assert.deepEqual(merged.fps, rerun.fps, 'the phase that was re-run is replaced');
  assert.equal(merged.analysis, undefined, 'a stale analysis is dropped; the report is rebuilt');
  assert.equal(merged.findings, undefined);
  assert.deepEqual({ runs: merged.meta.options.runs, fpsRuns: merged.meta.options.fpsRuns, fpsSeconds: merged.meta.options.fpsSeconds }, { runs: 5, fpsRuns: 2, fpsSeconds: 4 }, 'each phase keeps the options it was run with');
  assert.deepEqual(merged.meta.runs.map((run) => run.phases.join('+')), ['start+fps', 'fps']);
  assert.deepEqual(merged.meta.runs.map((run) => run.v2.commit), ['aaa', 'bbb'], 'the build of every contributing run is on record');
  assert.equal(merged.meta.durationMinutes, 20);
  assert.equal(merged.meta.startedAt, 't1');
  assert.equal(merged.meta.finishedAt, 't2');
  assert.deepEqual(merged.phaseErrors, {}, 'the error of the re-run phase is gone');
  assert.deepEqual({ samples: merged.focus.samples, spawned: merged.cleanup.spawned, apps: merged.focus.apps }, { samples: 6, spawned: 13, apps: ['Chrome', 'loginwindow'] });
});

test('drift: a one-time step and a steady idle CPU are told apart from a leak', () => {
  const sample = (t, renderer, main, cpuMain, cpuRenderer) => ({ t, atMs: t * 1000 + 3, totalMb: renderer + main, roles: { renderer: { rssMb: renderer, cpuSec: cpuRenderer, processes: 1 }, main: { rssMb: main, cpuSec: cpuMain, processes: 1 } } });
  const flatAfterStep = [sample(10, 63.8, 105, 1.0, 0.5), sample(30, 63.8, 100, 1.1, 0.5), sample(60, 65.2, 100, 1.1, 0.53), sample(120, 65.2, 100.2, 1.12, 0.53), sample(240, 65.2, 100.4, 1.2, 0.53)];
  const v1Flat = [sample(10, 104, 114, 1.0, 0.5), sample(30, 104, 107, 1.1, 0.5), sample(60, 104, 107, 1.1, 0.5), sample(120, 104, 107.2, 1.13, 0.5), sample(240, 104, 107.2, 1.2, 0.5)];
  const analysis = analyzeDrift({ v1: [{ samples: v1Flat }], 'v2lean-gpu': [{ samples: flatAfterStep }] });
  const v2 = analysis['v2lean-gpu'];
  assert.deepEqual(v2.step, { role: 'renderer', mb: 1.4, fromS: 30, toS: 60 });
  assert.equal(v2.settleS, 60);
  assert.equal(v2.rssGrowthSinceSettleMb, 0.4);
  assert.equal(v2.idleCpuSeconds, 0.1);
  assert.ok(Math.abs(v2.idleCpuPct - (0.1 / 180.0) * 100) < 0.002, String(v2.idleCpuPct));
  assert.equal(analysis.v1.step, null, 'v1 never gains a megabyte in one step');
  assert.match(driftNote(analysis), /one-time event, not a timer and not a leak/);

  const leaking = [sample(10, 60, 100, 1, 0.5), sample(30, 62, 100, 1, 0.5), sample(60, 66, 100, 1.1, 0.6), sample(120, 74, 100, 1.5, 0.9), sample(240, 90, 100, 2.5, 1.9)];
  assert.match(driftNote(analyzeDrift({ v1: [{ samples: v1Flat }], 'v2lean-gpu': [{ samples: leaking }] })), /continues after the settle time: look for a timer or a leak/);
  assert.equal(driftNote(undefined), '');
  assert.deepEqual(analyzeDrift({ v1: [{ error: 'did not start' }] }), {}, 'a variant without a usable run is left out');
});

test('drift: the report shows the drift tables and a merge keeps them', () => {
  const sample = (t, total) => ({ t, atMs: t * 1000, totalMb: total, roles: { renderer: { rssMb: total / 3, cpuSec: t / 100, processes: 1 } } });
  const drift = { v1: [{ variant: 'v1', samples: [sample(10, 300), sample(60, 290), sample(120, 291)] }], 'v2lean-gpu': [{ variant: 'v2lean-gpu', samples: [sample(10, 240), sample(60, 234), sample(120, 235)] }] };
  const data = { ...syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 }), drift };
  const { markdown, analysis } = buildReport(data);
  assert.match(markdown, /## Idle drift: the app left alone/);
  assert.match(markdown, /\| 60 \| 290\.0 \(96\.7\) \| 234\.0 \(78\.0\) \|/);
  assert.ok(analysis.drift.v1 && analysis.drift['v2lean-gpu']);
  const fresh = { meta: { startedAt: 't2', finishedAt: 't2', durationMinutes: 13, host: { v2: { commit: 'x', dirty: false } }, options: {} }, drift, focus: { samples: 1, stolen: [], apps: [] }, cleanup: { spawned: 3, strays: [] }, phaseErrors: {} };
  const merged = mergeData({ ...data, meta: { ...data.meta, runs: [{ phases: ['start'], durationMinutes: 30 }] } }, fresh, { phases: ['drift'], driftRuns: 1, driftTimes: [10, 60, 120] });
  assert.deepEqual(merged.meta.options.driftTimes, [10, 60, 120]);
  assert.ok(merged.start, 'the start phase is kept');
  assert.equal(merged.meta.runs.length, 2);
});

test('drift: a run during which the screen was unlocked is marked spoiled and gives no verdict', () => {
  const sample = (t, locked, cpu) => ({ t, atMs: t * 1000, totalMb: 240, screenLocked: locked, roles: { main: { rssMb: 100, cpuSec: cpu, processes: 1 } } });
  const spoiled = [sample(10, true, 1), sample(60, true, 1.1), sample(120, false, 3), sample(240, false, 6)];
  const clean = [sample(10, true, 1), sample(60, true, 1.1), sample(120, true, 1.12), sample(240, true, 1.2)];
  const analysis = analyzeDrift({ v1: [{ samples: clean }], 'v2lean-gpu': [{ samples: spoiled }] });
  assert.equal(analysis.v1.spoiled, false);
  assert.equal(analysis['v2lean-gpu'].spoiled, true);
  assert.equal(driftNote(analysis), '', 'a spoiled run explains nothing');
  const { markdown } = buildReport({ ...syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 }), drift: { v1: [{ samples: clean }], 'v2lean-gpu': [{ samples: spoiled }] } });
  assert.match(markdown, /SPOILED: the screen was unlocked during this run/);
  const quiet = analyzeDrift({ v1: [{ samples: clean.map(({ screenLocked, ...rest }) => rest) }] });
  assert.equal(quiet.v1.spoiled, false, 'samples without a lock state (an older file) are not called spoiled');
});

test('merge: a note on a run is kept and shown', () => {
  const data = syntheticData({ v2Visible: 600, v2Boot: 300, v2Rss: 250 });
  const fresh = { meta: { startedAt: 't2', finishedAt: 't3', durationMinutes: 13, note: 'screen locked throughout', host: { v2: { commit: 'x', dirty: false } }, options: {} }, drift: {}, focus: { samples: 0, stolen: [], apps: [] }, cleanup: { spawned: 0, strays: [] }, phaseErrors: {} };
  const merged = mergeData({ ...data, meta: { ...data.meta, runs: [{ phases: ['start'], durationMinutes: 30 }] } }, fresh, { phases: ['drift'], driftRuns: 1, driftTimes: [10, 60, 120] });
  assert.equal(merged.meta.runs[1].note, 'screen locked throughout');
  assert.match(buildReport(merged).markdown, /\[screen locked throughout\]/);
});
