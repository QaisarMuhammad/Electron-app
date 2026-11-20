'use strict';

/**
 * The Electron support gate (audit finding SEC-03, tests/packaging/check-electron-support.js): `npm run dist` must not build an
 * installer around an Electron major that no longer receives Chromium and V8 security fixes.
 *
 * The decisions are pinned with a fixed day and, mostly, a table of their own, so these tests keep their meaning when the real table is
 * refreshed and do not depend on the day they run (the gate itself does: that is its job). They never start Electron and never use the
 * network.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, 'check-electron-support.js');
const ROOT = path.join(__dirname, '..', '..');
const { SUPPORT_TABLE, majorOf, assessElectron, check, main } = require(GATE);

/** Electron's schedule as it stood on DAY: 43, 44 and 45 were the three supported majors. */
const TABLE = Object.freeze({ checkedOn: '2026-11-19', endOfSupport: Object.freeze({ 43: '2027-01-05', 44: '2027-03-02', 45: '2027-04-27' }) });
const DAY = '2026-11-19';

const assess = (version, today = DAY, table = TABLE) => assessElectron(version, { today, table });

// ---- majorOf -------------------------------------------------------------------------------------------------------------------------

test('majorOf reads the one major that a version or a range names', () => {
  const named = [['45.4.1', 45], ['^45.0.0', 45], ['~44.1.0', 44], ['v45.4.1', 45], ['45.x', 45], ['45', 45], ['45.0.0-beta.2', 45], ['  ^32.1.2 ', 32], ['=43.0.0', 43]];
  for (const [text, major] of named) assert.equal(majorOf(text), major, text);
});

test('majorOf refuses everything that could mean several majors, so the gate fails closed', () => {
  for (const text of ['*', 'x', 'latest', '>=43', '>43 <46', '43 - 45', '^43 || ^44', '', '   ', 'file:../electron', 'github:electron/electron', undefined, null]) {
    assert.equal(majorOf(text), null, String(text));
  }
});

// ---- assessElectron ------------------------------------------------------------------------------------------------------------------

test('the Electron of v1.6.1 and of this worktree (32.3.3, declared ^32.1.2) is refused, and the reason says why', () => {
  for (const version of ['32.3.3', '^32.1.2']) {
    const verdict = assess(version);
    assert.equal(verdict.ok, false, version);
    assert.match(verdict.message, /Electron 32 is older than 43, the oldest major that still gets security fixes/);
  }
});

test('every major below the table is refused, including 38 to 42, which the earlier hard-coded floor of 38 let through', () => {
  for (let major = 28; major <= 42; major += 1) {
    const verdict = assess(`${major}.0.0`);
    assert.equal(verdict.ok, false, `Electron ${major}`);
    assert.match(verdict.message, /older than 43/, `Electron ${major}`);
  }
});

test('the three supported majors pass on the day the table was checked, and the verdict says until when', () => {
  for (const [version, endsOn] of [['43.0.0', '2027-01-05'], ['44.7.2', '2027-03-02'], ['45.4.1', '2027-04-27'], ['^45.0.0', '2027-04-27']]) {
    const verdict = assess(version);
    assert.equal(verdict.ok, true, version);
    assert.equal(verdict.endsOn, endsOn, version);
    assert.match(verdict.message, new RegExp(`supported until ${endsOn}`), version);
  }
});

test('a major is out on its end date itself, while the majors above it stay in', () => {
  assert.equal(assess('43.0.0', '2027-01-04').ok, true);
  const ended = assess('43.0.0', '2027-01-05');
  assert.equal(ended.ok, false);
  assert.match(ended.message, /Electron 43 no longer gets security fixes \(its support ended on 2027-01-05\)/);
  assert.equal(assess('44.0.0', '2027-01-05').ok, true, '43 ending does not end 44');
  assert.equal(assess('45.0.0', '2027-03-02').ok, true, '44 ending does not end 45');
  assert.equal(assess('44.0.0', '2027-03-02').ok, false);
  assert.equal(assess('45.0.0', '2027-04-27').ok, false);
});

test('a major newer than the table is refused until the table is updated, and the message says where the dates come from', () => {
  const verdict = assess('46.0.0');
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /Electron 46 is not in the support table \(it lists 43, 44, 45, checked on 2026-11-19\)/);
  assert.match(verdict.message, /https:\/\/releases\.electronjs\.org\/schedule/);
});

test('a version that does not name one major is refused, with an example of what to write', () => {
  for (const version of ['latest', '>=43', '*', '', undefined]) {
    const verdict = assess(version);
    assert.equal(verdict.ok, false, String(version));
    assert.match(verdict.message, /does not name one Electron major/, String(version));
    assert.match(verdict.message, /such as \^45\.0\.0/, String(version));
  }
});

test('the decision comes from the table that is passed in, not from numbers in the code', () => {
  const table = { checkedOn: '2030-01-01', endOfSupport: { 60: '2031-01-01', 61: '2031-03-01', 62: '2031-05-01' } };
  assert.equal(assessElectron('61.2.0', { today: '2030-06-01', table }).ok, true);
  const old = assessElectron('45.4.1', { today: '2030-06-01', table });
  assert.equal(old.ok, false);
  assert.match(old.message, /older than 60/);
});

// ---- the real table ------------------------------------------------------------------------------------------------------------------

test('the support table is well formed: consecutive majors, rising end dates, every one after the day the table was checked', () => {
  const { checkedOn, endOfSupport } = SUPPORT_TABLE;
  const isDay = (text) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text));
  assert.ok(isDay(checkedOn), checkedOn);
  const entries = Object.entries(endOfSupport).map(([major, endsOn]) => [Number(major), endsOn]);
  assert.ok(entries.length >= 1, 'the table lists at least one major');
  entries.forEach(([major, endsOn], index) => {
    assert.ok(isDay(endsOn), `${major}: ${endsOn}`);
    assert.ok(endsOn > checkedOn, `${major} ends on ${endsOn}, which is not after ${checkedOn}: a major that has ended is removed from the table`);
    if (index > 0) {
      assert.equal(major, entries[index - 1][0] + 1, `${major} follows ${entries[index - 1][0]}: no major may be missing`);
      assert.ok(endsOn > entries[index - 1][1], `${major} ends after ${entries[index - 1][0]}`);
    }
  });
});

test('the real table refuses the Electron of v1.6.1 and every major that the earlier floor of 38 let through, on any day', () => {
  for (const version of ['32.3.3', '^32.1.2', '38.0.0', '39.8.0', '40.0.0', '41.0.0', '42.0.0']) {
    for (const today of [SUPPORT_TABLE.checkedOn, '2030-01-01']) assert.equal(assessElectron(version, { today }).ok, false, `${version} on ${today}`);
  }
});

// ---- check: what electron-builder would package, and what package.json declares ------------------------------------------------------

const folders = [];
after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });

/** A project folder with the parts the gate reads: package.json, and the installed electron package when `installed` is given. */
function makeProject({ declared, installed, electronVersion } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-electron-gate-'));
  folders.push(root);
  const manifest = { name: 'fixture', version: '0.0.0' };
  if (declared !== undefined) manifest.devDependencies = { electron: declared };
  if (electronVersion !== undefined) manifest.build = { electronVersion };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  if (installed !== undefined) {
    fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', version: installed }));
  }
  return root;
}

const judge = (project) => check({ root: makeProject(project), today: DAY, table: TABLE });
const summary = (result) => result.results.map(({ source, version, ok }) => [source, version, ok]);

test('a supported Electron, installed and declared, passes both checks', () => {
  const result = judge({ installed: '45.4.1', declared: '^45.0.0' });
  assert.equal(result.ok, true);
  assert.deepEqual(summary(result), [['node_modules/electron', '45.4.1', true], ['package.json devDependencies.electron', '^45.0.0', true]]);
});

test('the shipped state (32.3.3 installed, ^32.1.2 declared) fails, and both places are named', () => {
  const result = judge({ installed: '32.3.3', declared: '^32.1.2' });
  assert.equal(result.ok, false);
  assert.deepEqual(summary(result), [['node_modules/electron', '32.3.3', false], ['package.json devDependencies.electron', '^32.1.2', false]]);
  for (const { message } of result.results) assert.match(message, /Electron 32 is older than 43/);
});

test('a supported range over an old install fails on the install only: what gets packaged is the install', () => {
  const result = judge({ installed: '32.3.3', declared: '^45.0.0' });
  assert.equal(result.ok, false);
  assert.deepEqual(summary(result), [['node_modules/electron', '32.3.3', false], ['package.json devDependencies.electron', '^45.0.0', true]]);
});

test('an old range over a new install fails on the range only: a clean npm install would bring the old Electron back', () => {
  const result = judge({ installed: '45.4.1', declared: '^32.1.2' });
  assert.equal(result.ok, false);
  assert.deepEqual(summary(result), [['node_modules/electron', '45.4.1', true], ['package.json devDependencies.electron', '^32.1.2', false]]);
});

test('build.electronVersion is what electron-builder packages, so it takes the place of the installed copy', () => {
  const moved = judge({ installed: '32.3.3', declared: '^45.0.0', electronVersion: '45.4.1' });
  assert.equal(moved.ok, true);
  assert.deepEqual(summary(moved), [['package.json build.electronVersion', '45.4.1', true], ['package.json devDependencies.electron', '^45.0.0', true]]);

  const pinnedOld = judge({ installed: '45.4.1', declared: '^45.0.0', electronVersion: '32.3.3' });
  assert.equal(pinnedOld.ok, false);
  assert.deepEqual(summary(pinnedOld), [['package.json build.electronVersion', '32.3.3', false], ['package.json devDependencies.electron', '^45.0.0', true]]);
});

test('an Electron that is not installed fails closed, and so does a package.json that does not declare it', () => {
  const notInstalled = judge({ declared: '^45.0.0' });
  assert.equal(notInstalled.ok, false);
  assert.equal(notInstalled.results[0].ok, false);
  assert.match(notInstalled.results[0].message, /node_modules\/electron is missing.*npm install/);

  const notDeclared = judge({ installed: '45.4.1' });
  assert.equal(notDeclared.ok, false);
  assert.equal(notDeclared.results[1].ok, false);
  assert.match(notDeclared.results[1].message, /declares no Electron/);
});

test('the gate finds the installed and the declared Electron of THIS repository (the verdict on them depends on the day)', () => {
  const installedFile = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  const installed = fs.existsSync(installedFile) ? JSON.parse(fs.readFileSync(installedFile, 'utf8')).version : undefined;
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies.electron;
  const { results } = check({ root: ROOT, today: DAY });
  assert.deepEqual(results.map(({ source, version }) => [source, version]), [['node_modules/electron', installed], ['package.json devDependencies.electron', declared]]);
});

// ---- main: the program npm runs before the installer is built -----------------------------------------------------------------------

/** Runs `main` with the table of this file and collects what it prints. */
function run(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (line) => out.push(line), err: (line) => err.push(line), table: TABLE, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('main exits 0 and prints one line per check when the Electron is supported', () => {
  const result = run([`--root=${makeProject({ installed: '45.4.1', declared: '^45.0.0' })}`, `--today=${DAY}`]);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /node_modules\/electron 45\.4\.1: Electron 45 is supported until 2027-04-27/);
  assert.match(result.out, /package\.json devDependencies\.electron \^45\.0\.0: Electron 45 is supported until 2027-04-27/);
});

test('main exits 1 for the shipped state, says the installer was not built, and says what to do', () => {
  const result = run([`--root=${makeProject({ installed: '32.3.3', declared: '^32.1.2' })}`, `--today=${DAY}`]);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /node_modules\/electron 32\.3\.3: Electron 32 is older than 43/);
  assert.match(result.err, /package\.json devDependencies\.electron \^32\.1\.2: Electron 32 is older than 43/);
  assert.match(result.err, /The installer was not built/);
  assert.match(result.err, /43 \(until 2027-01-05\), 44 \(until 2027-03-02\), 45 \(until 2027-04-27\)/);
  assert.match(result.err, /npm install --save-dev electron@45/);
  assert.match(result.err, /tests\/packaging\/check-electron-support\.js/);
});

test('main judges by the clock of the build machine when --today is not given: the end date is the first unsupported day', () => {
  const root = makeProject({ installed: '43.0.0', declared: '^43.0.0' });
  assert.equal(run([`--root=${root}`], { now: () => new Date('2027-01-04T23:59:59Z') }).code, 0);
  assert.equal(run([`--root=${root}`], { now: () => new Date('2027-01-05T00:00:00Z') }).code, 1);
});

test('once every major in the table has ended, main says to update the table instead of listing nothing', () => {
  const result = run([`--root=${makeProject({ installed: '45.4.1', declared: '^45.0.0' })}`, '--today=2027-05-01']);
  assert.equal(result.code, 1);
  assert.match(result.err, /Every major in the support table has ended/);
  assert.doesNotMatch(result.err, /npm install --save-dev electron@/);
});

test('main reports a bad argument as a usage error (exit 2) and a project it cannot read as a failure (exit 1)', () => {
  assert.equal(run(['--colour=red']).code, 2);
  assert.match(run(['--colour=red']).err, /Unknown argument "--colour=red"/);
  const badDay = run(['--today=yesterday']);
  assert.equal(badDay.code, 2);
  assert.match(badDay.err, /--today must look like 2026-11-19/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-electron-gate-'));
  folders.push(empty);
  const unreadable = run([`--root=${empty}`, `--today=${DAY}`]);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.err, /could not run/);
});

test('run as a program it exits with the verdict: 1 for an unsupported Electron (what `npm run dist` sees), 0 for a supported one', () => {
  const { checkedOn, endOfSupport } = SUPPORT_TABLE;
  const newest = Math.max(...Object.keys(endOfSupport).map(Number));
  const program = (root) => spawnSync(process.execPath, [GATE, `--root=${root}`, `--today=${checkedOn}`], { encoding: 'utf8' });

  const old = program(makeProject({ installed: '32.3.3', declared: '^32.1.2' }));
  assert.equal(old.status, 1, old.stdout);
  assert.match(old.stderr, /Electron 32 is older than/);
  assert.match(old.stderr, /The installer was not built/);

  const current = program(makeProject({ installed: `${newest}.0.0`, declared: `^${newest}.0.0` }));
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, new RegExp(`Electron ${newest} is supported until ${endOfSupport[newest]}`));
});
