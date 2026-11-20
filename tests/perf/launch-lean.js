'use strict';

/**
 * A lean Electron main script for the benchmark: the REAL `bootstrap()` of src/main/index.js with the real settings store, log, windows,
 * preloads and print service, and NOTHING else of a test harness (no control server, no events file, no fake printer, no fake dialogs).
 * It exists for two measurements that tests/e2e/launch-app.js cannot give cleanly:
 *
 *   - the start-up cost of the product itself, without the harness's own work (the control server, a synchronous events file);
 *   - the print path with the app's REAL raw printer (a real temp file, the real queue, the real CUPS transport) and only the
 *     `lp` process stubbed: the same thing v1's benchmark copy does to `exec`, so the two are measured the same way.
 *
 *   Electron --remote-debugging-port=<port> --user-data-dir=<dir> tests/perf/launch-lean.js
 *
 * Environment:
 *   GPOS_BENCH_USER_DATA   the userData folder (required)
 *   GADGETSPOS_START_URL   the POS address (required; honoured because the app runs unpackaged)
 *   GPOS_BENCH_STUB_LP     "1": `lp` is replaced by a stub that records the job and answers at once (one `BENCHJOB {json}` line each)
 *
 * It prints one `BENCHMARKS {json}` line when the POS has loaded: the app's own start-up marks and the epoch time of its process start.
 * Like the e2e harness it never takes focus (`testMode`: macOS accessory activation policy and `showInactive()` for every window).
 * Not named *.test.js: node --test must not run it.
 */

const realElectron = require('electron');

if (process.platform === 'darwin' && typeof realElectron.app.setActivationPolicy === 'function') realElectron.app.setActivationPolicy('accessory');

const { performance } = require('node:perf_hooks');
const { bootstrap } = require('../../src/main/index');

const userDataPath = process.env.GPOS_BENCH_USER_DATA;
const startUrl = process.env.GADGETSPOS_START_URL;
if (!userDataPath || !startUrl) {
  process.stderr.write('launch-lean.js: GPOS_BENCH_USER_DATA and GADGETSPOS_START_URL are required\n');
  process.exit(2);
}

const benchNow = () => performance.timeOrigin + performance.now();
let jobSeq = 0;

/** `execFile` for the CUPS transport: records when `lp` would have started and answers at once. */
function stubExecFile(file, args, options, callback) {
  const target = String(args[args.length - 1]);
  const job = { seq: (jobSeq += 1), kind: target.endsWith('.zpl') ? 'label' : 'receipt', execAt: benchNow() };
  setImmediate(() => {
    job.doneAt = benchNow();
    callback(null, '', '');
    process.stdout.write(`BENCHJOB ${JSON.stringify(job)}\n`);
  });
}

bootstrap({
  testMode: true,
  userDataPath,
  env: { ...process.env, GADGETSPOS_START_URL: startUrl },
  devOrigins: [new URL(startUrl).origin],
  ...(process.env.GPOS_BENCH_STUB_LP === '1' ? { execFile: stubExecFile } : {}),
}).then((handle) => {
  if (handle === null) return;
  let reported = false;
  const report = () => {
    if (reported) return; // the POS loads again after a reload; the start-up numbers are the first load's
    reported = true;
    process.stdout.write(`BENCHMARKS ${JSON.stringify({ marks: handle.perf.marks(), epochOrigin: Date.now() - process.uptime() * 1000 })}\n`);
  };
  if (handle.perf.has('pos-loaded')) report();
  else handle.controller().on('pos-loaded', report);
}).catch((error) => {
  process.stderr.write(`launch-lean.js: ${(error && error.stack) || error}\n`);
  process.exitCode = 1;
  realElectron.app.exit(1);
});
