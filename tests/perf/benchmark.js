#!/usr/bin/env node
'use strict';

/**
 * The performance benchmark of GadgetsPOS Desktop 2.0 against v1.6.1 (SPEC 18b "Benchmark", 19.7). A plain Node script, not a unit test:
 *
 *   node tests/perf/benchmark.js                 the full run (about 40 minutes: keep the machine quiet while it runs)
 *   node tests/perf/benchmark.js --quick         a short smoke run of every phase (about 4 minutes), for checking the harness
 *
 * Options (--name=value): runs (5), idle (30, seconds), fps-runs (5), fps-seconds (8), print-runs (5), print-count (50), diag-runs (= runs),
 * drift-runs (1), drift-times (10,30,60,90,120,180,240), phases (start,fps,print,diag by default; drift is opt-in),
 * merge (keep the other phases of an earlier benchmark.json: re-run one phase and rebuild the report),
 * v1-repo (the sibling Electron-app checkout), out (tests/perf/out), no-warmup, stress-query (for calibrating the stress page only,
 * e.g. chips=24&blur=1; the benchmark uses the page's defaults).
 *
 * WHAT IS COMPARED, under identical conditions (the same Electron binary 32.3.3, the same local server, a fresh --user-data-dir for
 * every start, the versions taking turns and the order rotating from round to round so that drift cancels out, nothing ever takes focus):
 *
 *   v1       the owner's v1.6.1 (commit 14df69a) from `git archive` in a temp folder, node_modules linked to this worktree's, five small
 *            patches (tests/perf/v1-copy.js): the benchmark URL, no focus stealing, a window size knob, `exec` stubbed for the print runs
 *   v2       this worktree through tests/e2e/launch-app.js (the real `bootstrap()` with `testMode`: fake printers and dialogs, a control server)
 *   v2lean   this worktree through tests/perf/launch-lean.js (the real `bootstrap()` and nothing else): shows what the e2e harness itself costs
 *
 * PHASES
 *   start    5 cold starts of each: time to the first window (spawn to the first DevTools page target), time to the loading screen (v2: from its own
 *            start-up marks), time to POS loaded (the page's load event, timestamped by this process), then the summed RSS of the whole process
 *            tree after 30 s idle and the CPU of the tree over the next 30 s
 *   fps      the stress page (a 3000-row list, 24 moving translucent cards, a scrolling animation, counted with requestAnimationFrame over 8 s) in v1
 *            (software rendering), v2 with the default hardware acceleration, and v2 with `disableGpu` (compatibility mode)
 *   print    50 receipts and 50 labels per run: v1's handler with `exec` stubbed, v2's acknowledged path with the fake printers of launch-app.js,
 *            and v2's REAL raw printer (real temp file, real queue, real CUPS transport) with only `lp` stubbed, legacy and acknowledged
 *   diag     v2 lean with hardware acceleration on and off, times only: where the loading screen's time goes (explains the start-up budgets)
 *   drift    (opt-in) v1, v2 lean with the GPU on and off, each left idle for 4 minutes with the process tree sampled every 30 to 60 s: does the
 *            memory keep growing, and which process role uses the idle CPU
 *
 * Output: tests/perf/out/benchmark.json (every raw sample) and tests/perf/out/benchmark.md (the table quoted by docs/PERFORMANCE.md).
 * Every process this script starts is ended by pid (or by the unique name of its data folder) and checked at the end.
 * Exit code: 0 when it ran, 1 when a phase failed, 2 when the harness itself broke. It does not decide pass or fail on the numbers:
 * the findings are in the report.
 */

const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const stats = require('./stats');
const procs = require('./procs');
const analyze = require('./analyze');
const { buildReport, mergeData } = require('./report');
const { startBenchServer } = require('./bench-server');
const { buildV1Copy, V1_COMMIT } = require('./v1-copy');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const LAUNCH_APP = path.join(ROOT, 'tests', 'e2e', 'launch-app.js');
const LAUNCH_LEAN = path.join(__dirname, 'launch-lean.js');
const WATCHDOG_MS = 100 * 60 * 1000;

/** The window every version has in the stress runs (outer size, in points). */
const STRESS_BOUNDS = Object.freeze({ x: 60, y: 60, width: 1400, height: 800 });
const LINE_NOISE = /EGL Driver message|gl_display\.cc/;

function electronBinary() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
}

const ELECTRON = electronBinary();

/**
 * The phases, in the order they run. `diag` explains the start-up numbers and `drift` watches an idle app for minutes (memory growth, which
 * process uses the idle CPU); neither is part of the v1 comparison. `drift` is opt-in: it adds about 13 minutes (--phases=drift --merge).
 */
const PHASES = Object.freeze(['start', 'fps', 'print', 'diag', 'drift']);
const DEFAULT_PHASES = Object.freeze(['start', 'fps', 'print', 'diag']);
/** Seconds after the POS loaded at which the drift phase samples the process tree. */
const DRIFT_TIMES = Object.freeze([10, 30, 60, 90, 120, 180, 240]);

// ---------------------------------------------------------------------------------------------------------------------------
// Options and small utilities
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ runs: number, idleSeconds: number, fpsRuns: number, fpsSeconds: number, printRuns: number, printCount: number, diagRuns: number, driftRuns: number, driftTimes: number[], phases: string[], v1Repo: string, outDir: string, warmup: boolean, quick: boolean, stressQuery: string, merge: boolean }}
 */
function parseOptions(argv) {
  const options = {
    runs: 5, idleSeconds: 30, fpsRuns: 5, fpsSeconds: 8, printRuns: 5, printCount: 50,
    phases: [...DEFAULT_PHASES], v1Repo: path.resolve(ROOT, '..', 'Electron-app'), outDir: OUT_DIR, warmup: true, quick: false, stressQuery: '', merge: false, diagRuns: 0, driftRuns: 1, driftTimes: [...DRIFT_TIMES],
  };
  const values = {};
  for (const arg of argv) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    values[match[1]] = match[2] === undefined ? true : match[2];
  }
  if (values.quick) Object.assign(options, { quick: true, runs: 1, idleSeconds: 5, fpsRuns: 1, fpsSeconds: 3, printRuns: 1, diagRuns: 1, driftTimes: [5, 10, 15] });
  const number = (key, target) => {
    if (values[key] === undefined) return;
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} needs a positive number`);
    options[target] = value;
  };
  number('runs', 'runs');
  number('idle', 'idleSeconds');
  number('fps-runs', 'fpsRuns');
  number('fps-seconds', 'fpsSeconds');
  number('print-runs', 'printRuns');
  number('print-count', 'printCount');
  number('diag-runs', 'diagRuns');
  number('drift-runs', 'driftRuns');
  if (typeof values['drift-times'] === 'string') {
    const times = values['drift-times'].split(',').map(Number);
    if (times.length < 3 || times.some((time, i) => !Number.isFinite(time) || time <= 0 || (i > 0 && time <= times[i - 1]))) throw new Error('--drift-times needs at least three increasing positive numbers of seconds');
    options.driftTimes = times;
  }
  if (typeof values.phases === 'string') options.phases = values.phases.split(',').filter(Boolean);
  if (typeof values['v1-repo'] === 'string') options.v1Repo = path.resolve(values['v1-repo']);
  if (typeof values.out === 'string') options.outDir = path.resolve(values.out);
  if (values['no-warmup']) options.warmup = false;
  if (values.merge) options.merge = true;
  if (!options.diagRuns) options.diagRuns = options.runs;
  if (typeof values['stress-query'] === 'string') options.stressQuery = values['stress-query'];
  for (const phase of options.phases) if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the harness clock `performance.now()` reaches `mono`. */
const sleepUntil = (mono) => sleep(Math.max(0, mono - performance.now()));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The environment of a child that must run as Electron: a harness started from an Electron-based terminal inherits ELECTRON_RUN_AS_NODE. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return '';
  }
}

const log = (message) => process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${message}\n`);

/** Every process this script started and has not seen end: pid -> the unique marker of its data folder. The final cleanup ends exactly these. */
const tracked = new Map();
const everSpawned = new Set();
/** The application in front, sampled during the runs: it must never be one of ours. */
const focusSamples = [];

function killTracked() {
  for (const [pid, marker] of tracked) {
    procs.killTree(pid);
    for (const row of procs.appProcesses(procs.readProcessTable(), -1, marker)) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  tracked.clear();
}

// ---------------------------------------------------------------------------------------------------------------------------
// One run of an app
// ---------------------------------------------------------------------------------------------------------------------------

class AppRun {
  /**
   * @param {object} options
   * @param {'v1'|'v2'|'v2lean'} options.kind
   * @param {string} options.userData a fresh folder whose name is unique to this run (it is the run's process marker)
   * @param {string} options.url the POS address of this run
   * @param {string} options.runId
   * @param {string} [options.v1Dir] the patched v1 copy (kind v1)
   * @param {Record<string, string>} [options.env] extra environment
   */
  constructor({ kind, userData, url, runId, v1Dir, env = {} }) {
    this.kind = kind;
    this.userData = userData;
    this.marker = path.basename(userData);
    this.url = url;
    this.runId = runId;
    this.v1Dir = v1Dir;
    this.extraEnv = env;
    this.eventsFile = path.join(path.dirname(userData), `${this.marker}.events.jsonl`);
    this.child = null;
    this.exit = null;
    this.exited = null;
    this.debugPort = 0;
    this.controlPort = 0;
    this.spawnEpoch = 0;
    this.t0 = 0;
    this.jobs = { receipt: [], label: [] };
    this.benchmarks = null;
    this.windowShownEpoch = null;
    this.tail = [];
    this.pending = { out: '', err: '' };
    this.firstTarget = null;
  }

  /** Starts the app. `t0` is the harness clock right before the spawn: every start-up time is measured from it. */
  async launch() {
    fs.mkdirSync(this.userData, { recursive: true });
    this.debugPort = await freePort();
    const env = { ...cleanEnv(), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...this.extraEnv };
    let script;
    if (this.kind === 'v1') {
      script = this.v1Dir;
      env.GPOS_BENCH_URL = this.url;
    } else if (this.kind === 'v2') {
      script = LAUNCH_APP;
      this.controlPort = await freePort();
      Object.assign(env, {
        GPOS_E2E_USER_DATA: this.userData,
        GPOS_E2E_EVENTS_FILE: this.eventsFile,
        GPOS_E2E_CONTROL_PORT: String(this.controlPort),
        GADGETSPOS_START_URL: this.url,
      });
    } else {
      script = LAUNCH_LEAN;
      Object.assign(env, { GPOS_BENCH_USER_DATA: this.userData, GADGETSPOS_START_URL: this.url });
    }
    const args = [`--remote-debugging-port=${this.debugPort}`, `--user-data-dir=${this.userData}`, script];
    this.spawnEpoch = Date.now();
    this.t0 = performance.now();
    this.child = spawn(ELECTRON, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    tracked.set(this.child.pid, this.marker);
    everSpawned.add(this.child.pid);
    this.child.stdout.on('data', (chunk) => this.consume(chunk, 'out'));
    this.child.stderr.on('data', (chunk) => this.consume(chunk, 'err'));
    this.child.once('error', (error) => this.tail.push(`spawn error: ${error.message}`));
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
    });
    this.firstTarget = this.pollFirstTarget();
  }

  /** Splits the app's output into lines: BENCHJOB and BENCHMARKS lines are data, the rest is kept (a short tail) for a failure report. */
  consume(chunk, stream) {
    this.pending[stream] += chunk.toString('utf8');
    let at = this.pending[stream].indexOf('\n');
    while (at >= 0) {
      const line = this.pending[stream].slice(0, at);
      this.pending[stream] = this.pending[stream].slice(at + 1);
      this.onLine(line);
      at = this.pending[stream].indexOf('\n');
    }
  }

  onLine(line) {
    if (line.startsWith('BENCHJOB ')) {
      try {
        const job = JSON.parse(line.slice('BENCHJOB '.length));
        (this.jobs[job.kind] = this.jobs[job.kind] || []).push(job);
      } catch {
        // a damaged line is ignored; the count check in the print phase notices a missing job
      }
      return;
    }
    if (line.startsWith('BENCHWINDOW ')) {
      try {
        if (this.windowShownEpoch === null) this.windowShownEpoch = JSON.parse(line.slice('BENCHWINDOW '.length)).at;
      } catch {
        // see above
      }
      return;
    }
    if (line.startsWith('BENCHMARKS ')) {
      try {
        this.benchmarks = JSON.parse(line.slice('BENCHMARKS '.length));
      } catch {
        // see above
      }
      return;
    }
    if (line && !LINE_NOISE.test(line)) {
      this.tail.push(line.slice(0, 300));
      if (this.tail.length > 40) this.tail.shift();
    }
  }

  /** Polls the DevTools list until the first page target exists. @returns {Promise<{ ms: number, url: string }|null>} */
  async pollFirstTarget(timeoutMs = 60_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline && !this.exit) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(500) });
        const page = (await response.json()).find((target) => target.type === 'page');
        if (page) return { ms: performance.now() - this.t0, url: page.url };
      } catch {
        // the debugging port is not open yet
      }
      await sleep(8);
    }
    return null;
  }

  /** @returns {Promise<string>} the browser version the DevTools endpoint reports, e.g. "Chrome/128.0.6613.186" */
  async browserVersion() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`, { signal: AbortSignal.timeout(2000) });
      return String((await response.json()).Browser || '');
    } catch {
      return '';
    }
  }

  /** One command to launch-app.js's control server (kind v2). */
  async cmd(name, args = {}, timeoutMs = 20_000) {
    const response = await fetch(`http://127.0.0.1:${this.controlPort}/cmd`, { method: 'POST', body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(timeoutMs) });
    const answer = await response.json();
    if (!answer.ok) throw new Error(`control command ${name} failed: ${answer.error}`);
    return answer.value;
  }

  /** @returns {object[]} the events launch-app.js has written so far */
  events() {
    try {
      return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * The app's own start-up marks, with the epoch time of its process start (so a mark can be turned into "since the spawn").
   * v2 through launch-app.js: the marks come from the control server, the anchor from the `ready` event (written right after
   * `services-ready`). v2lean: the app prints both itself. v1 has none.
   *
   * @returns {Promise<{ marks: Record<string, number>, processStartEpoch: number }|null>}
   */
  async startMarks() {
    if (this.kind === 'v2') {
      const ready = this.events().find((event) => event.type === 'ready');
      if (!ready || !ready.marks || !Number.isFinite(ready.marks['services-ready'])) return null;
      const state = await this.cmd('state');
      return { marks: state.marks, processStartEpoch: ready.t - ready.marks['services-ready'] };
    }
    if (this.kind === 'v2lean') {
      for (let waited = 0; waited < 3000 && !this.benchmarks; waited += 50) await sleep(50);
      return this.benchmarks ? { marks: this.benchmarks.marks, processStartEpoch: this.benchmarks.epochOrigin } : null;
    }
    return null;
  }

  /** @returns {object[]} every process of this run right now */
  snapshot() {
    return procs.appProcesses(procs.readProcessTable(), this.child.pid, this.marker);
  }

  /** Records which application is in front: it must never be this run's. */
  sampleFocus(label) {
    const front = procs.frontApp();
    if (front === null) return;
    const ours = this.snapshot().some((row) => row.pid === front.pid);
    focusSamples.push({ run: `${this.kind}/${this.marker}`, label, front, ours });
  }

  /** Quits the app (v2: the way a menu item does; the others: SIGTERM), then ends whatever is left of it, by pid and by marker. */
  async stop() {
    if (!this.child) return;
    if (!this.exit) {
      try {
        if (this.kind === 'v2') await this.cmd('quit', {}, 3000);
        else process.kill(this.child.pid, 'SIGTERM');
      } catch {
        // already on its way out
      }
    }
    await Promise.race([this.exited, sleep(4000)]);
    procs.killTree(this.child.pid);
    for (const row of procs.appProcesses(procs.readProcessTable(), -1, this.marker)) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    tracked.delete(this.child.pid);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The harness: what every phase needs
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * @param {object} options
 * @returns {Promise<object>} the context: the server, the v1 copy, a run factory and the machine snapshot
 */
async function createContext(options) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-bench-'));
  const server = await startBenchServer();
  const v1 = buildV1Copy({ repo: options.v1Repo, destDir: path.join(runDir, 'v1'), nodeModules: path.join(ROOT, 'node_modules'), benchOrigin: server.origin });
  let counter = 0;

  return {
    options,
    runDir,
    server,
    v1,
    /**
     * @param {object} spec
     * @param {'v1'|'v2'|'v2lean'} spec.kind
     * @param {string} spec.phase
     * @param {number} spec.index
     * @param {'pos'|'stress'} spec.page
     * @param {Record<string, string>} [spec.pageQuery]
     * @param {Record<string, string>} [spec.env]
     * @param {(userData: string) => void} [spec.seed] writes files into the fresh user-data folder before the app starts
     * @returns {AppRun}
     */
    newRun({ kind, phase, index, page, pageQuery, env, seed }) {
      counter += 1;
      const marker = `gpos-bench-${crypto.randomBytes(4).toString('hex')}`;
      const userData = path.join(runDir, marker);
      fs.mkdirSync(userData, { recursive: true });
      if (seed) seed(userData);
      const runId = `${phase}-${kind}-${index}-${counter}`;
      return new AppRun({ kind, userData, url: server.url(page, runId, pageQuery), runId, v1Dir: v1.dir, env });
    },
    async close() {
      killTracked();
      await server.close();
      fs.rmSync(runDir, { recursive: true, force: true });
    },
  };
}

/** The state of the machine, so a noisy run can be told apart from a quiet one. */
function machineNow() {
  const usage = procs.systemCpuUsage();
  const screen = procs.screenState();
  return { loadavg1: stats.round(os.loadavg()[0], 2), cpuUser: usage && usage.user, cpuSys: usage && usage.sys, cpuIdle: usage && usage.idle, screenLocked: screen.locked, displayOn: screen.displayOn };
}

/** @template T @param {T[]} items @param {number} by @returns {T[]} the items rotated left, so the run order differs from round to round and no version always goes first */
function rotate(items, by) {
  const shift = ((by % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** Seeds a fresh user-data folder with compatibility mode (hardware acceleration off): what Settings > General writes. */
function gpuOffSeed(userData) {
  fs.writeFileSync(path.join(userData, 'flags.json'), `${JSON.stringify({ disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: true })}\n`);
}

/** The processes that use the most CPU right now, outside this benchmark (the evidence of how quiet the machine was). */
function busiestProcesses(limit = 5) {
  const out = runCommand('ps', ['-A', '-r', '-o', 'pcpu=,rss=,comm=']);
  return out.split('\n').slice(0, limit).map((line) => {
    const match = /^\s*([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { cpuPct: Number(match[1]), rssMb: Math.round(Number(match[2]) / 1024), command: path.basename(match[3]) } : { raw: line.trim() };
  });
}

/** The facts about this machine and the two builds under test. */
function describeHost(ctx) {
  const gitValue = (repo, args) => runCommand('git', ['-C', repo, ...args]);
  const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  return {
    platform: `${os.platform()} ${os.release()}`,
    macos: runCommand('sw_vers', ['-productVersion']),
    arch: os.arch(),
    cpu: os.cpus()[0] && os.cpus()[0].model,
    logicalCores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    electron: electronVersion,
    power: runCommand('pmset', ['-g', 'batt']).split('\n')[0],
    lowPowerMode: /lowpowermode\s+1/.test(runCommand('pmset', ['-g'])),
    thermal: runCommand('pmset', ['-g', 'therm']).split('\n').filter((line) => /CPU_(Speed|Scheduler)_Limit/.test(line)).map((line) => line.replace(/\s+/g, ' ').trim()).join(', '),
    v1: { commit: ctx.v1.commit, version: ctx.v1.version, patches: ctx.v1.applied },
    v2: { branch: gitValue(ROOT, ['branch', '--show-current']), commit: gitValue(ROOT, ['rev-parse', '--short', 'HEAD']), dirty: gitValue(ROOT, ['status', '--porcelain']).length > 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase 1: cold starts, memory and idle CPU
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * One cold start of `kind`: times, then the idle protocol (unless `idle` is false: the diagnostic runs only need the times). The harness
 * holds no debugger connection and sends nothing during the idle windows, so what is measured is the app. `t=0` is the moment the page
 * reported its load event.
 *
 * @returns {Promise<object>} the record of the run (an `error` field when it failed)
 */
async function measureStart(ctx, { kind, index, idle = true, phase = 'start', seed }) {
  const { server, options } = ctx;
  const idleMs = options.idleSeconds * 1000;
  const run = ctx.newRun({ kind, phase, index, page: 'pos', seed });
  const record = { kind, index, machine: machineNow() };
  await sleep(1000);
  try {
    await run.launch();
    const first = await run.firstTarget;
    record.firstTargetMs = first ? first.ms : null;
    record.firstTargetUrl = first ? first.url : null;
    const loaded = await server.waitReport(run.runId, 'loaded', 60_000);
    const loadedMono = loaded.at;
    record.loadedMs = loaded.at - run.t0;
    record.pageLoad = loaded.data;
    record.browser = await run.browserVersion();
    if (run.windowShownEpoch !== null) record.windowShownMs = run.windowShownEpoch - run.spawnEpoch;

    const started = await run.startMarks();
    if (started) {
      const { marks, processStartEpoch } = started;
      record.appMarks = marks;
      const fromSpawn = (name) => (Number.isFinite(marks[name]) ? analyze.markFromSpawn(processStartEpoch, marks[name], run.spawnEpoch) : null);
      record.windowCreatedMs = fromSpawn('window-created');
      record.loadingVisibleMs = fromSpawn('loading-visible');
      record.appReadyMs = fromSpawn('app-ready');
      record.posLoadedMarkMs = fromSpawn('pos-loaded');
      record.bootMs = analyze.bootOf(marks).bootMs;
      record.processStartOffsetMs = processStartEpoch - run.spawnEpoch;
    }

    if (idle) {
      const first0 = run.snapshot();
      const t0 = performance.now();
      await sleepUntil(loadedMono + 1500);
      run.sampleFocus('after load');
      await sleepUntil(loadedMono + idleMs);
      const at30 = performance.now();
      const sample30 = run.snapshot();
      run.sampleFocus('after idle');
      await sleepUntil(loadedMono + 2 * idleMs);
      const at60 = performance.now();
      const sample60 = run.snapshot();

      const cpuFirst = procs.cpuBetween(first0, sample30);
      const cpuIdle = procs.cpuBetween(sample30, sample60);
      const percent = (cpuSec, elapsedMs) => stats.round((cpuSec / (elapsedMs / 1000)) * 100, 3);
      record.idle = {
        rss30: procs.memoryOf(sample30),
        rss60: procs.memoryOf(sample60),
        cpuFirst: { ...cpuFirst, elapsedMs: Math.round(at30 - t0), percentOfCore: percent(cpuFirst.cpuSec, at30 - t0) },
        cpuIdle: { ...cpuIdle, elapsedMs: Math.round(at60 - at30), percentOfCore: percent(cpuIdle.cpuSec, at60 - at30) },
      };
    } else {
      await sleepUntil(loadedMono + 1000);
      run.sampleFocus('after load');
    }
    record.pageEnd = await readPageState(run).catch((error) => ({ error: error.message }));
    if (run.exit) record.error = `the app exited during the run (${JSON.stringify(run.exit)})`;
  } catch (error) {
    record.error = error.message;
    record.tail = run.tail.slice(-12);
  } finally {
    await run.stop();
  }
  return record;
}

/** Starts the app once and quits it: primes the operating system's file cache and the first-run costs, so no measured run pays them. */
async function warmUp(ctx, kind) {
  const run = ctx.newRun({ kind, phase: 'warmup', index: 0, page: 'pos' });
  try {
    await run.launch();
    await ctx.server.waitReport(run.runId, 'loaded', 60_000);
    await sleep(1500);
  } finally {
    await run.stop();
  }
}

async function phaseStart(ctx) {
  const { options } = ctx;
  const kinds = ['v1', 'v2', 'v2lean'];
  if (options.warmup) {
    log('start: warm-up (one throw-away start of each)');
    for (const kind of kinds) await warmUp(ctx, kind);
  }
  const runs = { v1: [], v2: [], v2lean: [] };
  for (let index = 1; index <= options.runs; index += 1) {
    for (const kind of rotate(kinds, index - 1)) {
      log(`start: ${kind} cold start ${index}/${options.runs}`);
      const record = await measureStart(ctx, { kind, index });
      runs[kind].push(record);
      log(`start: ${kind} ${index}: first window ${analyze.fmt(record.firstTargetMs)} ms, POS loaded ${analyze.fmt(record.loadedMs)} ms, RSS ${analyze.fmt(record.idle && record.idle.rss30.rssMb)} MB, idle CPU ${analyze.fmt(record.idle && record.idle.cpuIdle.percentOfCore, 2)} %${record.error ? `  ERROR ${record.error}` : ''}`);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase 4 (diagnosis): where the loading screen's time goes
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * v2 lean started with hardware acceleration (the default) and in compatibility mode (`disableGpu`), times only. The first window of a
 * GPU run is shown when the compositor has painted its first frame, which needs the GPU process: if the loading screen is late because of
 * that, the two variants differ by it. The numbers explain the start-up budgets; they are not part of the comparison with v1.
 */
async function phaseDiag(ctx) {
  const { options } = ctx;
  const variants = [
    { id: 'v2lean-gpu', seed: undefined },
    { id: 'v2lean-nogpu', seed: gpuOffSeed },
  ];
  const runs = { 'v2lean-gpu': [], 'v2lean-nogpu': [] };
  for (let index = 1; index <= options.diagRuns; index += 1) {
    for (const variant of rotate(variants, index - 1)) {
      log(`diag: ${variant.id} start ${index}/${options.diagRuns}`);
      const record = await measureStart(ctx, { kind: 'v2lean', index, idle: false, phase: `diag-${variant.id}`, seed: variant.seed });
      runs[variant.id].push(record);
      log(`diag: ${variant.id} ${index}: first window ${analyze.fmt(record.firstTargetMs)} ms, loading screen ${analyze.fmt(record.loadingVisibleMs)} ms, boot ${analyze.fmt(record.bootMs)} ms, POS loaded ${analyze.fmt(record.loadedMs)} ms${record.error ? `  ERROR ${record.error}` : ''}`);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase 5 (opt-in): idle drift
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * One app left idle after its POS loaded, the process tree sampled at `options.driftTimes` seconds after the load: memory and CPU by role.
 * Nothing is attached or sent while it idles; the page state is read once, at the very end.
 */
async function measureDrift(ctx, { variant, index }) {
  const { server, options } = ctx;
  const run = ctx.newRun({ kind: variant.kind, phase: `drift-${variant.id}`, index, page: 'pos', seed: variant.seed });
  const record = { variant: variant.id, index, machine: machineNow(), samples: [] };
  await sleep(1000);
  try {
    await run.launch();
    const loaded = await server.waitReport(run.runId, 'loaded', 60_000);
    for (const t of options.driftTimes) {
      await sleepUntil(loaded.at + t * 1000);
      const rows = run.snapshot();
      const memory = procs.memoryOf(rows);
      // The lock state is read with every sample: a person unlocking the screen mid-run (mouse over the window, the display waking) spoils it.
      record.samples.push({ t, atMs: Math.round(performance.now() - loaded.at), processes: rows.length, totalMb: memory.rssMb, screenLocked: procs.screenState().locked, roles: procs.byRole(rows) });
    }
    run.sampleFocus('after drift');
    record.pageEnd = await readPageState(run).catch((error) => ({ error: error.message }));
    if (run.exit) record.error = `the app exited during the run (${JSON.stringify(run.exit)})`;
  } catch (error) {
    record.error = error.message;
    record.tail = run.tail.slice(-12);
  } finally {
    await run.stop();
  }
  return record;
}

async function phaseDrift(ctx) {
  const { options } = ctx;
  const variants = [
    { id: 'v1', kind: 'v1', seed: undefined },
    { id: 'v2lean-gpu', kind: 'v2lean', seed: undefined },
    { id: 'v2lean-nogpu', kind: 'v2lean', seed: gpuOffSeed },
  ];
  const runs = { v1: [], 'v2lean-gpu': [], 'v2lean-nogpu': [] };
  for (let index = 1; index <= options.driftRuns; index += 1) {
    for (const variant of rotate(variants, index - 1)) {
      log(`drift: ${variant.id} idle run ${index}/${options.driftRuns} (${options.driftTimes[options.driftTimes.length - 1]} s)`);
      const record = await measureDrift(ctx, { variant, index });
      runs[variant.id].push(record);
      const first = record.samples[0];
      const last = record.samples[record.samples.length - 1];
      log(`drift: ${variant.id} ${index}: RSS ${analyze.fmt(first && first.totalMb, 1)} MB at ${first && first.t} s, ${analyze.fmt(last && last.totalMb, 1)} MB at ${last && last.t} s${record.error ? `  ERROR ${record.error}` : ''}`);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase 2: frames per second of the stress page
// ---------------------------------------------------------------------------------------------------------------------------

/** What the main page says about itself, over the DevTools protocol (asked after every sample was taken, so the connection cannot disturb them). */
async function readPageState(run) {
  const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${run.debugPort}`, defaultViewport: null, protocolTimeout: 15_000 });
  try {
    const [page] = await browser.pages();
    return await page.evaluate(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus(), viewport: [window.innerWidth, window.innerHeight] }));
  } finally {
    await browser.disconnect();
  }
}

/** Reads the GPU feature status over the DevTools protocol (after the measurement, so the connection cannot disturb it). */
async function readGpuInfo(run) {
  const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${run.debugPort}`, defaultViewport: null, protocolTimeout: 15_000 });
  try {
    const session = await browser.target().createCDPSession();
    const info = await session.send('SystemInfo.getInfo');
    const gpu = info.gpu || {};
    return {
      featureStatus: gpu.featureStatus || null,
      devices: (gpu.devices || []).map((device) => device.deviceString),
      commandLine: String(info.commandLine || '').match(/--(?:disable-gpu\S*|disable-hardware-acceleration|use-gl=\S+|use-angle=\S+|disk-cache-size=\S+|disable-brotli)/g) || [],
    };
  } finally {
    await browser.disconnect();
  }
}

/**
 * @param {'v1'|'v2'|'v2sw'} mode v1 (software rendering), v2 (default: hardware acceleration), v2sw (compatibility mode: `disableGpu` in flags.json)
 * @returns {Promise<object>}
 */
async function measureFps(ctx, { mode, index }) {
  const { server, options } = ctx;
  const kind = mode === 'v1' ? 'v1' : 'v2';
  const run = ctx.newRun({
    kind,
    phase: `fps-${mode}`,
    index,
    page: 'stress',
    pageQuery: Object.fromEntries(new URLSearchParams(options.stressQuery)),
    env: mode === 'v1' ? { GPOS_BENCH_W: String(STRESS_BOUNDS.width), GPOS_BENCH_H: String(STRESS_BOUNDS.height) } : {},
    seed: mode === 'v2sw' ? gpuOffSeed : undefined,
  });
  const record = { mode, index, machine: machineNow() };
  await sleep(1000);
  try {
    await run.launch();
    const ready = await server.waitReport(run.runId, 'ready', 90_000);
    record.page = ready.data;
    if (kind === 'v2') record.bounds = await run.cmd('setMainBounds', { bounds: STRESS_BOUNDS });
    await sleep(1500);
    record.info = await server.command(run.runId, 'info', {}, 15_000);
    run.sampleFocus('stress');

    const before = run.snapshot();
    const startedAt = performance.now();
    record.result = await server.command(run.runId, 'stress', { warmupMs: 1500, durationMs: options.fpsSeconds * 1000, speed: 2400 }, options.fpsSeconds * 1000 + 20_000);
    const elapsedMs = performance.now() - startedAt;
    const after = run.snapshot();
    const cpu = procs.cpuBetween(before, after);
    record.cpu = { ...cpu, elapsedMs: Math.round(elapsedMs), percentOfCore: stats.round((cpu.cpuSec / (elapsedMs / 1000)) * 100, 1) };
    record.rssMb = procs.memoryOf(after).rssMb;
    run.sampleFocus('after stress');
    record.gpu = await readGpuInfo(run).catch((error) => ({ error: error.message }));
    record.browser = await run.browserVersion();
    if (run.exit) record.error = `the app exited during the run (${JSON.stringify(run.exit)})`;
  } catch (error) {
    record.error = error.message;
    record.tail = run.tail.slice(-12);
  } finally {
    await run.stop();
  }
  return record;
}

/** A run whose window was not visible (the page's frames are throttled then), or that produced next to no frames, is not a measurement of rendering: it is repeated once. */
const usableFps = (record) => record.result && record.result.visibilityAtStart === 'visible' && record.result.visibilityAtEnd === 'visible' && record.result.frames >= 5;

async function phaseFps(ctx) {
  const { options } = ctx;
  const modes = ['v1', 'v2', 'v2sw'];
  const runs = { v1: [], v2: [], v2sw: [] };
  for (let index = 1; index <= options.fpsRuns; index += 1) {
    for (const mode of rotate(modes, index - 1)) {
      log(`fps: ${mode} stress run ${index}/${options.fpsRuns}`);
      let record = await measureFps(ctx, { mode, index });
      if (!usableFps(record)) {
        log(`fps: ${mode} ${index} was not a usable measurement (${record.error || 'window not visible'}): repeating once`);
        const retry = await measureFps(ctx, { mode, index });
        retry.firstAttempt = { error: record.error || null, info: record.info || null, result: record.result || null, page: record.page || null };
        record = retry;
      }
      runs[mode].push(record);
      log(`fps: ${mode} ${index}: ${record.result ? `${record.result.fps} fps (p95 frame ${record.result.frameMsP95} ms, ${record.result.slowFrames} slow frames)` : 'no result'}, CPU ${analyze.fmt(record.cpu && record.cpu.percentOfCore)} %${record.error ? `  ERROR ${record.error}` : ''}`);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase 3: print-job latency with fake printers
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * The print variants. `printerLevel`: the main process reports when each job reached the (stubbed) printer program (BENCHJOB lines).
 * `v2` runs launch-app.js whose fake raw printer replaces the transports; `v2lean` runs the real raw printer with only `lp` stubbed.
 */
const PRINT_VARIANTS = Object.freeze([
  { id: 'v1-legacy', kind: 'v1', api: 'legacy', modes: ['burst'], printerLevel: true, title: 'v1.6.1 handler, `exec` stubbed (fire-and-forget)' },
  { id: 'v2-ack-fake', kind: 'v2', api: 'ack', modes: ['burst', 'sequential'], printerLevel: false, title: 'v2 acknowledged path, launch-app.js fake printers' },
  { id: 'v2-ack-real', kind: 'v2lean', api: 'ack', modes: ['burst', 'sequential'], printerLevel: true, title: 'v2 acknowledged path, real raw printer, `lp` stubbed' },
  { id: 'v2-legacy-real', kind: 'v2lean', api: 'legacy', modes: ['burst'], printerLevel: true, title: 'v2 legacy path (old web), real raw printer, `lp` stubbed' },
]);

/** The printers a run is configured with (so a job is not refused for want of one). */
function seedPrinters(kind) {
  return (userData) => {
    const file = path.join(userData, 'config.json');
    const content = kind === 'v1'
      ? { printerName: 'Bench Receipt', printerPort: 'LPT1', labelPrinterName: 'Bench Label', labelPrinterPort: 'LPT2', password: '1234' }
      : { schemaVersion: 2, printers: { receipt: { transport: 'system', printerName: 'E2E-Receipt-58', port: '' }, label: { transport: 'system', printerName: 'E2E-Zebra-ZD420', port: '' }, dymo: { printerName: '' } } };
    fs.writeFileSync(file, `${JSON.stringify(content)}\n`, { mode: 0o600 });
  };
}

/** Waits until `check()` is true. @returns {Promise<boolean>} false after the timeout */
async function waitUntil(check, timeoutMs, intervalMs = 20) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

/**
 * One batch of `count` jobs of one kind, and its numbers.
 *
 * @returns {Promise<object>} the metrics of the batch (see analyze.batchMetrics / latencyMetrics)
 */
async function runBatch(ctx, run, variant, { kind, mode }) {
  const { options } = ctx;
  const count = options.printCount;
  const before = run.jobs[kind].length;
  const sent = await ctx.server.command(run.runId, 'print', { api: variant.api, kind, count, mode }, 90_000);
  if (sent.error) throw new Error(`the page could not print: ${sent.error}`);
  const batch = { kind, mode, count };
  if (variant.api === 'ack') {
    batch.failed = sent.results.filter((result) => !result || result.ok !== true).length;
    batch.ack = analyze.batchMetrics(sent.sentAt, sent.ackAt);
    batch.latency = analyze.latencyMetrics(sent.sentAt, sent.ackAt);
  }
  if (variant.printerLevel) {
    const arrived = await waitUntil(() => run.jobs[kind].length >= before + count, 30_000);
    const jobs = run.jobs[kind].slice(before, before + count);
    batch.jobsSeen = jobs.length;
    if (!arrived) batch.warning = `only ${jobs.length} of ${count} jobs reached the printer stub`;
    batch.printer = analyze.batchMetrics(sent.sentAt, jobs.map((job) => job.doneAt));
    // Clock check: a job cannot reach the printer before the page sent it. A negative number means the two clocks disagree.
    batch.clockSkewMinMs = stats.round(Math.min(...jobs.map((job, i) => job.execAt - sent.sentAt[i])), 3);
  }
  return batch;
}

async function measurePrint(ctx, { variant, index }) {
  const run = ctx.newRun({
    kind: variant.kind,
    phase: `print-${variant.id}`,
    index,
    page: 'pos',
    pageQuery: { mode: 'cmd' },
    env: {
      ...(variant.kind === 'v1' ? { GPOS_BENCH_PRINT: '1' } : {}),
      ...(variant.kind === 'v2lean' ? { GPOS_BENCH_STUB_LP: '1' } : {}),
    },
    seed: seedPrinters(variant.kind),
  });
  const record = { variant: variant.id, index, machine: machineNow(), batches: [] };
  await sleep(1000);
  try {
    await run.launch();
    await ctx.server.waitReport(run.runId, 'loaded', 60_000);
    await sleep(1500);
    record.info = await ctx.server.command(run.runId, 'info', {}, 15_000);
    if (variant.api === 'ack' && !record.info.functions.includes('printReceipt')) throw new Error('window.electron has no printReceipt: this is not a v2 desktop');
    for (const mode of variant.modes) {
      for (const kind of ['receipt', 'label']) {
        record.batches.push(await runBatch(ctx, run, variant, { kind, mode }));
        await sleep(300);
      }
    }
    run.sampleFocus('after printing');
    if (run.exit) record.error = `the app exited during the run (${JSON.stringify(run.exit)})`;
  } catch (error) {
    record.error = error.message;
    record.tail = run.tail.slice(-12);
  } finally {
    await run.stop();
  }
  return record;
}

async function phasePrint(ctx) {
  const { options } = ctx;
  const runs = Object.fromEntries(PRINT_VARIANTS.map((variant) => [variant.id, []]));
  for (let index = 1; index <= options.printRuns; index += 1) {
    for (const variant of rotate([...PRINT_VARIANTS], index - 1)) {
      log(`print: ${variant.id} run ${index}/${options.printRuns}`);
      const record = await measurePrint(ctx, { variant, index });
      runs[variant.id].push(record);
      const receipts = record.batches.find((batch) => batch.kind === 'receipt' && batch.mode === 'burst');
      const level = receipts && (receipts.printer || receipts.ack);
      log(`print: ${variant.id} ${index}: 50 receipts in ${analyze.fmt(level && level.makespanMs, 1)} ms${record.error ? `  ERROR ${record.error}` : ''}`);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = new Date();
  fs.mkdirSync(options.outDir, { recursive: true });
  log(`GadgetsPOS benchmark: phases ${options.phases.join(', ')}; ${options.runs} cold starts each, ${options.idleSeconds} s idle windows`);

  const watchdog = setTimeout(() => {
    process.stderr.write('benchmark: the watchdog expired, ending everything\n');
    killTracked();
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref();
  process.on('exit', killTracked);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      killTracked();
      process.exit(130);
    });
  }

  const ctx = await createContext(options);
  const host = describeHost(ctx);
  const data = { meta: { startedAt: startedAt.toISOString(), options, host, noiseBefore: { machine: machineNow(), busiest: busiestProcesses() } }, phaseErrors: {} };

  try {
    for (const phase of options.phases) {
      try {
        if (phase === 'start') data.start = await phaseStart(ctx);
        if (phase === 'fps') data.fps = await phaseFps(ctx);
        if (phase === 'print') data.print = await phasePrint(ctx);
        if (phase === 'diag') data.diag = await phaseDiag(ctx);
        if (phase === 'drift') data.drift = await phaseDrift(ctx);
      } catch (error) {
        data.phaseErrors[phase] = error.stack || error.message;
        log(`phase ${phase} FAILED: ${error.message}`);
      }
    }
  } finally {
    data.meta.finishedAt = new Date().toISOString();
    data.meta.durationMinutes = stats.round((Date.now() - startedAt.getTime()) / 60000, 1);
    data.meta.noiseAfter = { machine: machineNow(), busiest: busiestProcesses() };
    data.focus = { samples: focusSamples.length, stolen: focusSamples.filter((sample) => sample.ours), apps: [...new Set(focusSamples.map((sample) => sample.front.name))] };
    await ctx.close();
  }

  // Nothing of ours may be left running.
  await sleep(500);
  const strays = [...everSpawned].filter((pid) => procs.isAlive(pid));
  data.cleanup = { spawned: everSpawned.size, strays };
  if (strays.length > 0) killTracked();

  const outFile = path.join(options.outDir, 'benchmark.json');
  const merged = options.merge && fs.existsSync(outFile) ? mergeData(JSON.parse(fs.readFileSync(outFile, 'utf8')), data, options) : mergeData(null, data, options);
  // The raw samples are saved FIRST: a bug in the report must never cost a run of half an hour.
  fs.writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
  const report = buildReport(merged);
  fs.writeFileSync(outFile, `${JSON.stringify({ ...merged, analysis: report.analysis, findings: report.findings }, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outDir, 'benchmark.md'), `${report.markdown}\n`);
  process.stdout.write(`\n${report.markdown}\n\nWritten: ${path.join(options.outDir, 'benchmark.json')} and benchmark.md\n`);
  process.exitCode = Object.keys(data.phaseErrors).length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`benchmark: the harness broke: ${error.stack || error}\n`);
    killTracked();
    process.exit(2);
  });
}

module.exports = { parseOptions, createContext, AppRun, PRINT_VARIANTS, STRESS_BOUNDS, V1_COMMIT, PHASES };
