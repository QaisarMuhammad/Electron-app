#!/usr/bin/env node
'use strict';

/**
 * Release gate (audit finding SEC-03): the installer is not built while the Electron it would contain is out of support.
 *
 *   node tests/packaging/check-electron-support.js [--root=<project folder>] [--today=YYYY-MM-DD]
 *
 * `npm run dist` runs it first (package.json `predist`). Exit code 0: supported. 1: not supported, or it could not be checked. 2: bad argument.
 *
 * Why a gate. Electron supports only the latest three major versions (https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
 * A major leaves that window on a fixed date, so a version that was right when it was chosen becomes a security hole without any change in
 * this repository: v1.6.1 shipped Electron 32, which lost support on 2025-03-03. The till renders a remote web page, so every public
 * Chromium bug of an unsupported major applies to it. A hard-coded "oldest acceptable major" rots the same way (the floor of 38 that an
 * earlier test used already let through the five ended majors 38 to 42), so the table below carries the END DATE of every supported major
 * and the gate compares it with the day it runs.
 *
 * What is judged. The Electron that electron-builder would package, which is `build.electronVersion` when that is set and otherwise the
 * installed `node_modules/electron`; and the Electron that package.json declares, which is what a clean `npm install` brings. Both must be
 * inside the window.
 *
 * Why it lives in tests/packaging. This runs on the build machine only. `scripts/**` is packed into the installer (SPEC 15, `build.files`),
 * so a release tool placed there would be shipped to every till; `tests/**` never is.
 *
 * Keeping the table current is the only maintenance. Open https://releases.electronjs.org/schedule, copy the "End of Life" date of every
 * major that has not ended yet into `endOfSupport` (drop the ones that have), and set `checkedOn` to the day you looked. Dates that the
 * schedule marks tentative can move, so look again when you release. A major that the table does not list is refused, which forces that
 * edit in the same commit as a move to a newer major.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEDULE_URL = 'https://releases.electronjs.org/schedule';
const THIS_FILE = 'tests/packaging/check-electron-support.js';
const USAGE = `node ${THIS_FILE} [--root=<project folder>] [--today=YYYY-MM-DD]`;

/**
 * Electron major -> the first day it is NOT supported any more ("End of Life" in the schedule, which is the day the major three above it
 * ships). Every major that was supported on `checkedOn`, and no other.
 */
const SUPPORT_TABLE = Object.freeze({
  checkedOn: '2026-11-19',
  endOfSupport: Object.freeze({ 43: '2027-01-05', 44: '2027-03-02', 45: '2027-04-27' }),
});

/**
 * The one Electron major that a version or a range names: "45.4.1", "^45.0.0", "~44.1.0", "v45.4.1", "45.x" and "45" all do. Anything that
 * could mean several majors ("*", ">=43", "latest", "43 - 45", "") gives null, so the gate fails closed.
 * @param {unknown} text
 * @returns {number|null}
 */
function majorOf(text) {
  const match = /^[\^~=v\s]*(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9a-z.-]+)?\s*$/i.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Is this Electron version inside the support window on this day?
 * @param {string} version an exact version or a range that names one major
 * @param {{ today: string, table?: typeof SUPPORT_TABLE }} context `today` as YYYY-MM-DD
 * @returns {{ ok: boolean, kind: 'supported'|'ended'|'older'|'unlisted'|'unreadable', major?: number, endsOn?: string, message: string }}
 */
function assessElectron(version, { today, table = SUPPORT_TABLE }) {
  const { checkedOn, endOfSupport } = table;
  const majors = Object.keys(endOfSupport).map(Number).sort((a, b) => a - b);
  const major = majorOf(version);
  if (major === null) {
    return { ok: false, kind: 'unreadable', message: `"${version}" does not name one Electron major, so it cannot be checked. Use an exact version or a range such as ^${majors[majors.length - 1]}.0.0.` };
  }
  const endsOn = endOfSupport[major];
  if (endsOn === undefined && major < majors[0]) {
    return { ok: false, kind: 'older', major, message: `Electron ${major} is older than ${majors[0]}, the oldest major that still gets security fixes.` };
  }
  if (endsOn === undefined) {
    return { ok: false, kind: 'unlisted', major, message: `Electron ${major} is not in the support table (it lists ${majors.join(', ')}, checked on ${checkedOn}). Add it from ${SCHEDULE_URL}.` };
  }
  if (today >= endsOn) {
    return { ok: false, kind: 'ended', major, endsOn, message: `Electron ${major} no longer gets security fixes (its support ended on ${endsOn}).` };
  }
  return { ok: true, kind: 'supported', major, endsOn, message: `Electron ${major} is supported until ${endsOn}.` };
}

/** The parsed JSON file, or null when it does not exist. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file}: ${error.message}`);
  }
}

/** The Electron electron-builder packages: `build.electronVersion` when set, otherwise the installed copy (app-builder-lib/out/electron/electronVersion.js). */
function packagedElectron(root, manifest) {
  const pinned = manifest.build && manifest.build.electronVersion;
  if (pinned) return { source: 'package.json build.electronVersion', version: pinned };
  const installed = readJson(path.join(root, 'node_modules', 'electron', 'package.json'));
  return { source: 'node_modules/electron', version: installed && installed.version, missing: 'node_modules/electron is missing, so there is nothing to package. Run npm install first.' };
}

/** The Electron that a clean `npm install` would bring. */
function declaredElectron(manifest) {
  for (const field of ['devDependencies', 'dependencies']) {
    const version = manifest[field] && manifest[field].electron;
    if (version) return { source: `package.json ${field}.electron`, version };
  }
  return { source: 'package.json devDependencies.electron', version: undefined, missing: 'package.json declares no Electron, so a clean npm install would not bring one.' };
}

/**
 * Judges what would be packaged and what package.json declares.
 * @param {{ root: string, today: string, table?: typeof SUPPORT_TABLE }} options
 * @returns {{ ok: boolean, results: Array<{ source: string, version?: string, ok: boolean, kind: string, message: string }> }}
 */
function check({ root, today, table = SUPPORT_TABLE }) {
  const manifest = readJson(path.join(root, 'package.json'));
  if (manifest === null) throw new Error(`there is no package.json in ${root}`);
  const results = [packagedElectron(root, manifest), declaredElectron(manifest)].map(({ source, version, missing }) => (
    version
      ? { source, version, ...assessElectron(version, { today, table }) }
      : { source, version, ok: false, kind: 'missing', message: missing }
  ));
  return { ok: results.every((result) => result.ok), results };
}

/** @returns {{ options?: { root?: string, today?: string }, error?: string }} */
function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(root|today)=(.+)$/.exec(argument);
    if (!match) return { error: `Unknown argument "${argument}". Usage: ${USAGE}` };
    if (match[1] === 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(match[2])) return { error: `--today must look like 2026-11-19, not "${match[2]}".` };
    options[match[1]] = match[2];
  }
  return { options };
}

/**
 * The program: prints the verdict and returns the exit code.
 * @param {string[]} argv the arguments after the script name
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, now?: () => Date, table?: typeof SUPPORT_TABLE }} [deps]
 * @returns {number} 0 supported, 1 not supported or not checkable, 2 bad argument
 */
function main(argv, { out = (line) => console.log(line), err = (line) => console.error(line), now = () => new Date(), table = SUPPORT_TABLE } = {}) {
  const { options, error } = parseArguments(argv);
  if (error) {
    err(error);
    return 2;
  }
  const today = options.today || now().toISOString().slice(0, 10);
  const root = options.root ? path.resolve(options.root) : path.join(__dirname, '..', '..');

  let result;
  try {
    result = check({ root, today, table });
  } catch (problem) {
    err(`The Electron support check could not run: ${problem.message}`);
    return 1;
  }

  const describe = (entry) => {
    const label = entry.version ? `${entry.source} ${entry.version}` : entry.source;
    return `  ${(entry.ok ? 'ok' : 'FAIL').padEnd(5)}${label}: ${entry.message}`;
  };
  if (result.ok) {
    out(`Electron support check passed (dates checked on ${table.checkedOn}).`);
    result.results.forEach((entry) => out(describe(entry)));
    return 0;
  }

  err('Electron support check failed. The installer was not built.');
  result.results.forEach((entry) => err(describe(entry)));
  if (result.results.some((entry) => entry.kind === 'ended' || entry.kind === 'older')) {
    const supported = Object.keys(table.endOfSupport).map(Number).filter((major) => today < table.endOfSupport[major]).sort((a, b) => a - b);
    if (supported.length === 0) {
      err(`Every major in the support table has ended on ${today}: update the table from ${SCHEDULE_URL} first.`);
    } else {
      err(`Supported on ${today}: Electron ${supported.map((major) => `${major} (until ${table.endOfSupport[major]})`).join(', ')}.`);
      err(`Move to one of them (for example npm install --save-dev electron@${supported[supported.length - 1]}), re-run the end-to-end checks in tests/e2e and tests/verify, then build again.`);
    }
  }
  err(`The dates behind this check are in ${THIS_FILE} (source: ${SCHEDULE_URL}).`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SUPPORT_TABLE, majorOf, assessElectron, check, main };
