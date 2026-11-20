'use strict';

/**
 * Builds the v1.6.1 side of the benchmark (SPEC 18b "Benchmark"): a temp copy of the OWNER'S Electron app at commit 14df69a, taken
 * with `git archive` (a read-only operation: the owner's checkout is never touched), with the worktree's node_modules symlinked in
 * (so v1 runs on exactly the same Electron binary as v2) and five small patches to index.js. Nothing else of v1 is changed: its
 * start-up, its software rendering (`app.disableHardwareAcceleration()`), its single `index.js` with `pdfkit` loaded at boot and its
 * 1600x900 window are all the real v1.6.1 behaviour.
 *
 *   1. default URL      `defaultURL` is the benchmark server (the run's own address comes from GPOS_BENCH_URL)
 *   2. activation       macOS `setActivationPolicy('accessory')` right after Electron is loaded, and every window shown with `showInactive()`
 *                       (the policy alone still lets a window take focus), so v1 never takes focus either
 *   3. window size      `GPOS_BENCH_W` / `GPOS_BENCH_H` (the stress runs put both versions' windows at one size); default is v1's 1600x900
 *   4. exec stand-in    `exec` (the Windows `copy /B` command) is replaced by a stub that records when v1 would have started it and
 *                       answers at once, printing one `BENCHJOB {json}` line per job. v1's own temp-file writing, queue and callbacks run.
 *   5. platform check   `printDirectReceipt` refuses to print off Windows; with GPOS_BENCH_PRINT set it goes on, so the receipt handler
 *                       can be measured on this Mac. It is not set in the start-up runs.
 *
 * Every patch must match exactly once: a v1 that does not look as expected stops the benchmark instead of measuring something else.
 * Not named *.test.js: node --test must not run it (its tests are in tests/perf/benchmark-lib.test.js).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const V1_COMMIT = '14df69a';

/**
 * The activation patch (patch 2). The accessory policy alone is NOT enough: Electron's `show: true` (v1's default) activates the app
 * even under that policy (measured: v1 became the frontmost application). So, like v2's test mode (`createQuietWindowClass`), a window
 * is created hidden and shown with `showInactive()` at once; a window v1 itself creates with `show: false` (the DYMO one) stays hidden.
 */
const QUIET_WINDOWS = `const electron = require('electron');
const { app, ipcMain, Menu, dialog, session } = electron;
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
// Benchmark: windows are shown without taking focus; the moment the first one is shown is reported (v1 shows a blank window at once).
class BrowserWindow extends electron.BrowserWindow {
    constructor(options) {
        super({ ...options, show: false });
        if (!options || options.show !== false) {
            this.showInactive();
            if (!global.__benchWindowShown) {
                global.__benchWindowShown = true;
                process.stdout.write('BENCHWINDOW ' + JSON.stringify({ at: Date.now() }) + '\\n');
            }
        }
    }

    show() { this.showInactive(); }

    focus() {}
}
Object.defineProperty(BrowserWindow, 'name', { value: 'BrowserWindow' });`;

/** The exec stand-in (patch 4). `kind` comes from the command text: v1's label file is always `label.zpl`, a receipt is `receipt-<pid>-...bin`. */
const EXEC_STUB = `const { performance: __benchPerformance } = require('perf_hooks');
const __benchNow = () => __benchPerformance.timeOrigin + __benchPerformance.now();
let __benchSeq = 0;
// Benchmark stand-in for child_process.exec: v1 would start \`cmd /c copy /B <file> <port>\` here. Record the moment, answer at once.
const exec = (command, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const job = { seq: ++__benchSeq, kind: /label\\.zpl/.test(String(command)) ? 'label' : 'receipt', execAt: __benchNow() };
    setImmediate(() => {
        job.doneAt = __benchNow();
        if (typeof done === 'function') done(null, '', '');
        process.stdout.write('BENCHJOB ' + JSON.stringify(job) + '\\n');
    });
};`;

/**
 * The patches, in order. `find` is a string that must occur exactly once in v1's index.js.
 *
 * @param {string} benchOrigin the benchmark server's origin (http://127.0.0.1:<port>)
 * @returns {Array<{ name: string, find: string, replace: string }>}
 */
function v1Patches(benchOrigin) {
  return [
    {
      name: 'default URL',
      find: "const defaultURL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';",
      replace: `const defaultURL = process.env.GPOS_BENCH_URL || '${benchOrigin}/pos';`,
    },
    {
      name: 'macOS accessory activation policy and showInactive windows',
      find: "const { app, BrowserWindow, ipcMain, Menu, dialog, session } = require('electron');",
      replace: QUIET_WINDOWS,
    },
    {
      name: 'window size',
      find: 'width: 1600,\n        height: 900,',
      replace: 'width: Number(process.env.GPOS_BENCH_W) || 1600,\n        height: Number(process.env.GPOS_BENCH_H) || 900,',
    },
    {
      name: 'exec stand-in',
      find: "const { exec } = require('child_process');",
      replace: EXEC_STUB,
    },
    {
      name: 'receipt platform check',
      find: "if (process.platform !== 'win32') {",
      replace: "if (process.platform !== 'win32' && !process.env.GPOS_BENCH_PRINT) {",
    },
  ];
}

/** @param {string} text @param {string} find @returns {number} how many times `find` occurs in `text` */
function countOccurrences(text, find) {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) count += 1;
  return count;
}

/**
 * Applies the patches to v1's index.js text.
 *
 * @param {string} source v1's index.js
 * @param {string} benchOrigin
 * @returns {{ source: string, applied: string[] }}
 * @throws {Error} when a patch does not match exactly once
 */
function patchV1Source(source, benchOrigin) {
  let patched = source;
  const applied = [];
  for (const patch of v1Patches(benchOrigin)) {
    const found = countOccurrences(patched, patch.find);
    if (found !== 1) throw new Error(`v1 patch "${patch.name}" matched ${found} times (it must match exactly once): v1's index.js is not the expected 1.6.1 source`);
    patched = patched.replace(patch.find, () => patch.replace);
    applied.push(patch.name);
  }
  return { source: patched, applied };
}

/**
 * Extracts v1 into `destDir`, links node_modules and patches index.js.
 *
 * @param {object} options
 * @param {string} options.repo the owner's Electron app checkout (only `git archive` is run on it)
 * @param {string} options.destDir an empty folder
 * @param {string} options.nodeModules the node_modules folder to link (the v2 worktree's, which has Electron 32.3.3 and every v1 dependency)
 * @param {string} options.benchOrigin
 * @param {string} [options.commit]
 * @returns {{ dir: string, commit: string, version: string, applied: string[] }}
 */
function buildV1Copy({ repo, destDir, nodeModules, benchOrigin, commit = V1_COMMIT }) {
  fs.mkdirSync(destDir, { recursive: true });
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', commit], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', destDir], { input: archive });
  fs.symlinkSync(nodeModules, path.join(destDir, 'node_modules'), 'dir');

  const manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'));
  if (manifest.main !== 'index.js') throw new Error(`v1 package.json main is ${manifest.main}, expected index.js`);
  const indexFile = path.join(destDir, 'index.js');
  const { source, applied } = patchV1Source(fs.readFileSync(indexFile, 'utf8'), benchOrigin);
  fs.writeFileSync(indexFile, source);
  return { dir: destDir, commit, version: manifest.version, applied };
}

module.exports = { buildV1Copy, patchV1Source, v1Patches, V1_COMMIT, EXEC_STUB };
