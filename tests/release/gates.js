'use strict';

/**
 * The OWNER RELEASE GATES: what must be true before an installer is published, and what the code of this repository cannot do on its
 * own (a network, a certificate, a lock file written by npm). Each gate answers `{ ok, detail }` for a project folder; `detail` says
 * what is open. docs/RELEASE.md ("Owner release gates") has the commands that close each one and what it protects.
 *
 *   npm run release:check     lists every open gate and exits with 1 while any is open (tests/release/release.check.js)
 *   npm run dist              runs that first (package.json `predist`) and builds only when it passes
 *
 * `npm test` does NOT run them: they are about the machine and the accounts of the owner, not about the code, so they would keep the
 * unit suite red for good. They live here, strict, and are unit tested in tests/packaging/release-gates.test.js against fake projects.
 * Build-machine tools live under tests/, never under scripts/, which is packed into the installer.
 */

const fs = require('node:fs');
const path = require('node:path');

const { check: checkElectronSupport } = require('../packaging/check-electron-support');

const readText = (root, relative) => {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const readJson = (root, relative) => {
  const text = readText(root, relative);
  return text === null ? null : JSON.parse(text);
};

/** @typedef {{ ok: boolean, detail: string }} GateResult */

/**
 * @typedef {object} Gate
 * @property {string} id
 * @property {string} title       what must be true
 * @property {string} protects    what goes wrong when it is not
 * @property {string} fix         the commands or steps that close it (also in docs/RELEASE.md)
 * @property {(root: string, context: { today: string }) => GateResult} check
 */

/** @type {Gate[]} */
const GATES = [
  {
    id: 'electron',
    title: 'Electron is a supported major version (installed and declared)',
    protects: 'the till shows a remote web page, so every published Chromium bug of an unsupported Electron applies to it',
    fix: 'npm install --save-dev electron@45   (then run tests/e2e/run-smoke.js and tests/verify on it, RELEASE.md 2.1)',
    check(root, { today }) {
      const { ok, results } = checkElectronSupport({ root, today });
      return { ok, detail: results.filter((entry) => !entry.ok).map((entry) => `${[entry.source, entry.version].filter(Boolean).join(' ')}: ${entry.message}`).join(' ') };
    },
  },
  {
    id: 'publisher',
    title: 'Windows builds are signed and the updater checks the publisher (build.win.publisherName)',
    protects: 'without a publisher name electron-updater installs whatever the update feed serves, silently, so whoever can write to the feed host owns every till',
    fix: 'obtain a code-signing certificate, set build.win.publisherName to its subject name and CSC_LINK / CSC_KEY_PASSWORD on the build PC (RELEASE.md 5.1)',
    check(root) {
      const pkg = readJson(root, 'package.json');
      const publisher = pkg.build && pkg.build.win && pkg.build.win.publisherName;
      const names = Array.isArray(publisher) ? publisher : [publisher];
      const ok = names.length > 0 && names.every((name) => typeof name === 'string' && name.trim() !== '');
      return { ok, detail: ok ? '' : 'build.win.publisherName is not set.' };
    },
  },
  {
    id: 'fuses',
    title: 'Electron fuses are flipped in the packaged app (RunAsNode off, Node CLI inspect off, NODE_OPTIONS off, asar-only)',
    protects: 'with the fuses in their shipped state the signed executable is a Node interpreter and anything that can start it can attach a debugger to the process that checks the drawer password',
    fix: 'npm install   (installs @electron/fuses, which scripts/after-pack-fuses.js needs; the build fails without it)',
    check(root) {
      const pkg = readJson(root, 'package.json');
      const hook = pkg.build && pkg.build.afterPack;
      if (typeof hook !== 'string') return { ok: false, detail: 'package.json build.afterPack is not set: nothing flips the fuses.' };
      const source = readText(root, hook);
      if (source === null) return { ok: false, detail: `build.afterPack names ${hook}, which does not exist.` };
      if (!/@electron\/fuses/.test(source) || !/flipFuses/.test(source)) return { ok: false, detail: `${hook} does not use @electron/fuses.` };
      if (!(pkg.devDependencies && pkg.devDependencies['@electron/fuses'])) return { ok: false, detail: '@electron/fuses is not in devDependencies.' };
      if (readText(root, path.join('node_modules', '@electron', 'fuses', 'package.json')) === null) {
        return { ok: false, detail: '@electron/fuses is declared but not installed (node_modules/@electron/fuses is missing): the build would stop at the afterPack hook.' };
      }
      return { ok: true, detail: '' };
    },
  },
  {
    id: 'lockfile',
    title: 'package-lock.json is committed and matches package.json (the build is reproducible and auditable)',
    protects: 'without a lock file every release build resolves the ^ ranges afresh: two builds of one commit can hold different code, and a build cannot be audited later',
    fix: 'delete a stale package-lock.json, run npm install (it writes the lock file), commit package-lock.json and build with npm ci (RELEASE.md 2.4)',
    check(root) {
      const ignored = (readText(root, '.gitignore') || '').split(/\r?\n/).map((line) => line.trim());
      if (ignored.includes('package-lock.json')) return { ok: false, detail: '.gitignore lists package-lock.json, so it can never be committed.' };
      const lock = readJson(root, 'package-lock.json');
      if (lock === null) return { ok: false, detail: 'there is no package-lock.json.' };
      const pkg = readJson(root, 'package.json');
      const locked = (lock.packages && lock.packages['']) || {};
      for (const field of ['dependencies', 'devDependencies']) {
        const wanted = JSON.stringify(Object.entries(pkg[field] || {}).sort());
        const found = JSON.stringify(Object.entries(locked[field] || {}).sort());
        if (wanted !== found) return { ok: false, detail: `package-lock.json does not match package.json (${field} differ): it was written for another version of the project.` };
      }
      return { ok: true, detail: '' };
    },
  },
  {
    id: 'feed',
    title: 'The update feed address is real (not the CHANGE-ME placeholder) and https',
    protects: 'while the placeholder is in place the installed app turns its updater off, so no till is ever updated',
    fix: 'edit build.publish[0].url in package.json to the https address that will host the update files (RELEASE.md 6.3)',
    check(root) {
      const pkg = readJson(root, 'package.json');
      const url = pkg.build && Array.isArray(pkg.build.publish) && pkg.build.publish[0] && pkg.build.publish[0].url;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { ok: false, detail: 'build.publish[0].url is not an https address.' };
      const ok = !/CHANGE-ME/i.test(url);
      return { ok, detail: ok ? '' : `build.publish[0].url is still the placeholder (${url}).` };
    },
  },
];

/** @returns {string} today as YYYY-MM-DD (the Electron gate compares it with the end-of-support dates) */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Runs every gate.
 * @param {string} root the project folder
 * @param {{ today?: string }} [options]
 * @returns {Array<Gate & GateResult>}
 */
function runGates(root, { today: day = today() } = {}) {
  return GATES.map((gate) => {
    try {
      return { ...gate, ...gate.check(root, { today: day }) };
    } catch (error) {
      return { ...gate, ok: false, detail: `the gate could not be checked: ${error.message}` };
    }
  });
}

module.exports = { GATES, runGates, today };
