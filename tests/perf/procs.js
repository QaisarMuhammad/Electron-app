'use strict';

/**
 * Process-table helpers for the benchmark (tests/perf/benchmark.js): which processes belong to one app run, how much memory
 * and CPU they use, and how to end exactly the ones the benchmark started. macOS and Linux (`ps`); the focus check is macOS only.
 * Not named *.test.js: node --test must not run it (its tests are in tests/perf/benchmark-lib.test.js).
 */

const { execFileSync } = require('node:child_process');

/**
 * @typedef {object} ProcessRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} rssKb resident set size in KiB, as `ps` reports it
 * @property {number} cpuSec cumulative CPU time in seconds (user + system, 10 ms resolution)
 * @property {string} command the full command line
 */

/**
 * Parses the TIME column of `ps`: `M:SS.hh`, `H:MM:SS` or `D-H:MM:SS`.
 *
 * @param {string} text
 * @returns {number} seconds, NaN for text that is none of those
 */
function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text).trim());
  if (!match) return NaN;
  const [, days, hours, minutes, seconds] = match;
  return Number(days || 0) * 86400 + Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Parses the output of `ps -A -ww -o pid=,ppid=,rss=,time=,command=`.
 *
 * @param {string} text
 * @returns {ProcessRow[]} one row per line that has the expected shape
 */
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const cpuSec = parseCpuTime(match[4]);
    if (!Number.isFinite(cpuSec)) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpuSec, command: match[5] });
  }
  return rows;
}

/** @returns {ProcessRow[]} the whole process table right now (empty when `ps` cannot be run) */
function readProcessTable() {
  try {
    return parseProcessTable(execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return [];
  }
}

/**
 * Every process of one app run: the process itself and all of its descendants, plus any process whose command line carries
 * `marker` (the unique name of the run's user-data folder). The second rule catches helpers that Chromium detaches from the tree
 * (the crash reporter's handler is re-parented to launchd).
 *
 * @param {ProcessRow[]} table
 * @param {number} rootPid
 * @param {string} [marker]
 * @returns {ProcessRow[]}
 */
function appProcesses(table, rootPid, marker) {
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const wanted = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) || []) {
      if (!wanted.has(child)) {
        wanted.add(child);
        queue.push(child);
      }
    }
  }
  return table.filter((row) => wanted.has(row.pid) || (marker && row.command.includes(marker)));
}

/**
 * @param {string} command a command line
 * @returns {'main'|'gpu'|'renderer'|'network'|'utility'|'crashpad'|'other'} the role of an Electron/Chromium process
 */
function classifyProcess(command) {
  if (/crashpad_handler/.test(command)) return 'crashpad';
  const type = /--type=([\w-]+)/.exec(command);
  if (!type) return /Electron/.test(command) ? 'main' : 'other';
  if (type[1] === 'gpu-process') return 'gpu';
  if (type[1] === 'renderer') return 'renderer';
  if (type[1] === 'utility') return /network\.mojom\.NetworkService/.test(command) ? 'network' : 'utility';
  return 'other';
}

/**
 * Adds up the memory of one app run's processes, in total and by role.
 *
 * @param {ProcessRow[]} rows from appProcesses
 * @returns {{ processes: number, rssMb: number, byRole: Record<string, { processes: number, rssMb: number }> }}
 */
function memoryOf(rows) {
  const byRole = {};
  let total = 0;
  for (const row of rows) {
    const role = classifyProcess(row.command);
    byRole[role] = byRole[role] || { processes: 0, rssMb: 0 };
    byRole[role].processes += 1;
    byRole[role].rssMb += row.rssKb / 1024;
    total += row.rssKb;
  }
  for (const entry of Object.values(byRole)) entry.rssMb = Math.round(entry.rssMb * 10) / 10;
  return { processes: rows.length, rssMb: Math.round((total / 1024) * 10) / 10, byRole };
}

/**
 * Memory and CPU of one app run's processes, by role.
 *
 * @param {ProcessRow[]} rows from appProcesses
 * @returns {Record<string, { processes: number, rssMb: number, cpuSec: number }>}
 */
function byRole(rows) {
  const roles = {};
  for (const row of rows) {
    const role = classifyProcess(row.command);
    roles[role] = roles[role] || { processes: 0, rssMb: 0, cpuSec: 0 };
    roles[role].processes += 1;
    roles[role].rssMb += row.rssKb / 1024;
    roles[role].cpuSec += row.cpuSec;
  }
  for (const entry of Object.values(roles)) {
    entry.rssMb = Math.round(entry.rssMb * 10) / 10;
    entry.cpuSec = Math.round(entry.cpuSec * 100) / 100;
  }
  return roles;
}

/**
 * CPU used between two samples of the same app run. A process that is in both samples counts the difference of its CPU time;
 * one that appeared in between counts all of its CPU time (it was started inside the window); one that ended in between cannot be
 * counted (its last total is unknown) and is reported, so a window with exits can be told apart.
 *
 * @param {ProcessRow[]} before
 * @param {ProcessRow[]} after
 * @returns {{ cpuSec: number, started: number, ended: number }}
 */
function cpuBetween(before, after) {
  const earlier = new Map(before.map((row) => [row.pid, row.cpuSec]));
  const later = new Set(after.map((row) => row.pid));
  let cpuSec = 0;
  let started = 0;
  for (const row of after) {
    if (earlier.has(row.pid)) {
      cpuSec += Math.max(0, row.cpuSec - earlier.get(row.pid));
    } else {
      cpuSec += row.cpuSec;
      started += 1;
    }
  }
  const ended = before.filter((row) => !later.has(row.pid)).length;
  return { cpuSec: Math.round(cpuSec * 100) / 100, started, ended };
}

/** @param {number} rootPid @returns {number[]} every descendant of the process, deepest last */
function descendantsOf(rootPid) {
  const children = new Map();
  for (const row of readProcessTable()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) || []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Ends a process and everything below it. Only ever called with pids that this benchmark started.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 */
function killTree(pid, signal = 'SIGKILL') {
  for (const target of [...descendantsOf(pid).reverse(), pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }
}

/** @param {number} pid @returns {boolean} whether a process with this id exists */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** @returns {{ pid: number, name: string }|null} the application in front right now (macOS `lsappinfo`; null elsewhere or when unreadable) */
function frontApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    if (!asn) return null;
    const info = execFileSync('lsappinfo', ['info', '-only', 'pid', '-only', 'name', asn], { encoding: 'utf8' });
    const pid = Number((/"pid"=(\d+)/.exec(info) || [])[1]);
    const name = (/"LSDisplayName"="([^"]*)"/.exec(info) || [])[1] || '';
    return Number.isFinite(pid) ? { pid, name } : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} topOutput the output of `top -l 2 -n 0 -s 1`
 * @returns {{ user: number, sys: number, idle: number }|null} the LAST "CPU usage" line (the second sample covers a real interval), or null
 */
function parseCpuUsage(topOutput) {
  const lines = String(topOutput).split('\n').filter((line) => /CPU usage:/.test(line));
  const last = lines[lines.length - 1];
  const match = last && /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/.exec(last);
  return match ? { user: Number(match[1]), sys: Number(match[2]), idle: Number(match[3]) } : null;
}

/** @returns {{ user: number, sys: number, idle: number }|null} the machine's CPU use over the last second (macOS `top`) */
function systemCpuUsage() {
  if (process.platform !== 'darwin') return null;
  try {
    return parseCpuUsage(execFileSync('top', ['-l', '2', '-n', '0', '-s', '1'], { encoding: 'utf8', timeout: 15_000 }));
  } catch {
    return null;
  }
}

/**
 * @param {string} ioregOutput the output of `ioreg -n Root -d1 -l`
 * @returns {boolean|null} whether the login session's screen is locked (null when the output does not say)
 */
function parseScreenLocked(ioregOutput) {
  const match = /"CGSSessionScreenIsLocked"\s*=\s*(\w+)/.exec(String(ioregOutput));
  if (!match) return String(ioregOutput).includes('kCGSSessionOnConsoleKey') ? false : null;
  return match[1] === 'Yes' || match[1] === 'true';
}

/** @returns {{ locked: boolean|null, displayOn: boolean|null }} whether the screen is locked and the display is powered (macOS; nulls elsewhere) */
function screenState() {
  if (process.platform !== 'darwin') return { locked: null, displayOn: null };
  let locked = null;
  let displayOn = null;
  try {
    locked = parseScreenLocked(execFileSync('ioreg', ['-n', 'Root', '-d1', '-l'], { encoding: 'utf8', timeout: 5000 }));
  } catch {
    // unknown
  }
  try {
    const wrangler = execFileSync('ioreg', ['-r', '-c', 'IODisplayWrangler', '-d', '3'], { encoding: 'utf8', timeout: 5000 });
    const state = /"CurrentPowerState"\s*=\s*(\d+)/.exec(wrangler);
    displayOn = state ? Number(state[1]) >= 4 : null;
  } catch {
    // unknown
  }
  return { locked, displayOn };
}

module.exports = {
  parseScreenLocked,
  screenState,
  parseCpuTime,
  parseProcessTable,
  readProcessTable,
  appProcesses,
  classifyProcess,
  memoryOf,
  byRole,
  cpuBetween,
  descendantsOf,
  killTree,
  isAlive,
  frontApp,
  parseCpuUsage,
  systemCpuUsage,
};
