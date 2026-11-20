#!/usr/bin/env node
'use strict';

/**
 * The runtime-e2e lens: tries to BREAK the real desktop app under the real Electron (Electron 32.3.3 on this Mac), in the style of
 * tests/e2e/run-smoke.js (which it does not touch). Each scenario starts the real app through tests/verify/e2e-break/launch-break.js
 * against a programmable fake POS (break-server.js) and reports checks; a FAILED check is a lead that is then triaged by hand.
 *
 *   node tests/verify/e2e-break/run-break.js                       every group
 *   BREAK_GROUPS=server,print node tests/verify/e2e-break/run-break.js
 *   BREAK_ONLY=D1,D5 BREAK_GROUPS=server node tests/verify/e2e-break/run-break.js
 *
 * Groups: server (D: slow, silent, 503, TLS, DNS, redirects, blank pages), print (B and F: floods, big payloads, hung printers, the real
 * raw transport), config (A: corrupt and odd config files), network (C: the server dying and coming back, offline toggles), windows
 * (E: Settings twice, closing the POS window with a job queued, wrong-origin pages, popups, a hung renderer, quitting).
 *
 * Nothing here steals focus (macOS accessory activation policy, showInactive()), and every process it starts is ended by pid.
 * Exit code: 0 when every check passed, 1 when one failed, 2 when the harness itself broke.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  OUT_DIR, RUN_DIR, scenario, scenarios, quiet, tracked, everSpawned, isAlive, killTree, seconds,
} = require('./harness');

const WATCHDOG_MS = 40 * 60 * 1000;

const GROUPS = {
  server: () => require('./group-server').runServerGroup,
  print: () => require('./group-print').runPrintGroup,
  config: () => require('./group-config').runConfigGroup,
  network: () => require('./group-network').runNetworkGroup,
  windows: () => require('./group-windows').runWindowsGroup,
};

function idOrder(id) {
  const [, letter, number, suffix] = /^([A-Z]+)(\d+)(.*)$/.exec(id) || [null, 'Z', '999', id];
  return letter.charCodeAt(0) * 100000 + Number(number) * 100 + (suffix ? suffix.charCodeAt(0) - 96 : 0);
}

function printTable() {
  const sorted = [...scenarios].sort((a, b) => idOrder(a.id) - idOrder(b.id));
  const idWidth = Math.max(2, ...sorted.map((entry) => entry.id.length));
  const titleWidth = Math.min(96, Math.max(20, ...sorted.map((entry) => entry.title.length)));
  const line = '-'.repeat(idWidth + titleWidth + 34);
  process.stdout.write(`\n${line}\n${'#'.padEnd(idWidth)}  ${'Scenario'.padEnd(titleWidth)}  Result  Checks  Time\n${line}\n`);
  for (const entry of sorted) {
    const passed = entry.checks.filter((check) => check.ok).length;
    const title = entry.title.length > titleWidth ? `${entry.title.slice(0, titleWidth - 3)}...` : entry.title;
    process.stdout.write(`${entry.id.padEnd(idWidth)}  ${title.padEnd(titleWidth)}  ${entry.passed ? 'PASS  ' : 'FAIL  '}  ${`${passed}/${entry.checks.length}`.padEnd(6)}  ${seconds(entry.ms)}\n`);
  }
  process.stdout.write(`${line}\n`);
  const failed = sorted.filter((entry) => !entry.passed);
  for (const entry of failed) {
    process.stdout.write(`\nFAILED [${entry.id}] ${entry.title}\n`);
    if (entry.error) process.stdout.write(`  error: ${entry.error.message}\n`);
    for (const check of entry.checks.filter((item) => !item.ok)) process.stdout.write(`  - ${check.name}\n      ${String(JSON.stringify(check.detail)).slice(0, 600)}\n`);
  }
  const checks = sorted.reduce((sum, entry) => sum + entry.checks.length, 0);
  process.stdout.write(`\n${sorted.length - failed.length} of ${sorted.length} scenarios passed (${checks} checks)\n`);
  return failed.length === 0;
}

function writeReport(tag) {
  const report = {
    when: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    quiet: { consoleErrors: quiet.consoleErrors, uncaught: quiet.uncaught, logProblems: quiet.logProblems, logErrors: quiet.logErrors, focus: quiet.focus.length },
    scenarios: [...scenarios]
      .sort((a, b) => idOrder(a.id) - idOrder(b.id))
      .map((entry) => ({ id: entry.id, title: entry.title, passed: entry.passed, ms: entry.ms, error: entry.error ? entry.error.message : null, notes: entry.notes, data: entry.data, checks: entry.checks })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `break-report-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const watchdog = setTimeout(() => {
    process.stderr.write('WATCHDOG: the run took too long, ending everything it started\n');
    for (const pid of tracked) killTree(pid);
    process.exit(2);
  }, WATCHDOG_MS);
  const wanted = (process.env.BREAK_GROUPS || Object.keys(GROUPS).join(',')).split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const only = process.env.BREAK_ONLY ? process.env.BREAK_ONLY.split(',').map((name) => name.trim()).filter(Boolean) : null;
  let ok = false;
  try {
    for (const name of wanted) {
      if (!GROUPS[name]) throw new Error(`unknown group ${name}`);
      process.stdout.write(`\n==== group ${name} ====\n`);
      await GROUPS[name]()(only);
    }
  } finally {
    clearTimeout(watchdog);
    await scenario('Q', 'Nothing took focus, no app page logged an error, no main process threw, nothing is left running', async (t) => {
      if (quiet.focus.length === 0) t.note('no focus samples were taken');
      else {
        const stolen = quiet.focus.filter((sample) => sample.ours);
        t.check(`the app was never the frontmost application (${quiet.focus.length} samples)`, stolen.length === 0, stolen);
        t.note(`the application in front during the run: ${[...new Set(quiet.focus.map((sample) => sample.front.name))].join(', ')}`);
      }
      t.check('no console error or page error on the app\'s own pages (loading, offline, Settings, password)', quiet.consoleErrors.length === 0, quiet.consoleErrors);
      t.check('no uncaught exception or unhandled rejection in any main process', quiet.uncaught.length === 0, quiet.uncaught);
      t.check('no crash, handler error or unhandled rejection line in any app log', quiet.logProblems.length === 0, quiet.logProblems.slice(0, 12));
      t.note(`${quiet.logErrors.length} line(s) at level error in the apps' own logs (see the report; most are the deliberate crashes and failures of the scenarios)`);
      for (const line of [...new Set(quiet.logErrors)].slice(0, 40)) process.stdout.write(`        log error: ${line}\n`);
      const alive = [...everSpawned].filter((pid) => isAlive(pid));
      t.check('every Electron process this run started has ended', alive.length === 0, alive);
    });
    ok = printTable();
    writeReport(wanted.join('-') + (only ? `-${only.join('-')}` : ''));
    for (const pid of tracked) killTree(pid);
    if (ok) fs.rmSync(RUN_DIR, { recursive: true, force: true });
    else process.stdout.write(`\nThe data folders of the run were kept in ${RUN_DIR}\n`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`the run broke: ${error && error.stack ? error.stack : error}\n`);
  for (const pid of tracked) killTree(pid);
  process.exit(2);
});
