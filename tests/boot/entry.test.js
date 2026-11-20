'use strict';

/**
 * Does the app start when Electron loads it? (PKG-1.) src/main/index.js starts itself at the end of the file, and the guard must be
 * true for BOTH of Electron's loaders and false for a test that merely requires the file. It was right for `electron .` only: an
 * installed app (resources/app.asar, the layout electron-builder produces on every platform) is loaded with
 * `Module._load(file, Module, true)`, where `module.parent` is the Module class, so the installed program did nothing at all.
 *
 * Two levels: the decision as a pure function with the shapes measured on Electron 32.3.3, and the real file loaded by the real
 * Node module loader in a child process the way each Electron loader does it. tests/verify/packaging-installed-layout.js is the
 * same check against the real Electron binary and the real app.asar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const { isAppEntry } = require('../../src/main/index');

const INDEX = path.join(__dirname, '..', '..', 'src', 'main', 'index.js');
const PROBE = path.join(__dirname, '..', 'helpers', 'entry-probe.js');
const ELECTRON = { electron: '32.3.3', node: '20.18.1' };
const NODE_ONLY = { node: '22.12.0' };

// ---- the decision ----------------------------------------------------------------------------------------------------------

test('`electron .` (and a folder or an archive given to electron): no parent, no require.main: the app starts', () => {
  assert.equal(isAppEntry({ parent: undefined }, undefined, ELECTRON), true);
  assert.equal(isAppEntry({ parent: null }, undefined, ELECTRON), true);
});

test('an installed app (resources/app.asar): the parent is the Module class and require.main is the module itself: the app starts', () => {
  const installed = { parent: Module };
  assert.equal(isAppEntry(installed, installed, ELECTRON), true);
});

test('required by a test or a harness: a real parent module and another require.main: it stays inert', () => {
  const file = { parent: { id: 'tests/boot/boot.test.js' } };
  assert.equal(isAppEntry(file, { id: 'tests/boot/boot.test.js' }, ELECTRON), false);
  assert.equal(isAppEntry(file, undefined, ELECTRON), false, 'even without a require.main');
  assert.equal(isAppEntry(file, { id: 'tests/e2e/launch-app.js' }, ELECTRON), false, 'a harness started by electron has its own module as main');
});

test('under plain Node (no process.versions.electron) it never starts, whatever the shape', () => {
  const file = { parent: undefined };
  assert.equal(isAppEntry(file, undefined, NODE_ONLY), false);
  assert.equal(isAppEntry(file, file, NODE_ONLY), false);
  assert.equal(isAppEntry(file, file, undefined), false);
  assert.equal(isAppEntry(file, file, {}), false);
});

// ---- the real file, loaded by the real module loader --------------------------------------------------------------------------

/** Runs the probe in a child process; resolves to what bootstrap() did (it prints BOOTSTRAP-RAN when it ran). */
function bootstrapRan(mode) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-entry-'));
  try {
    const output = execFileSync(process.execPath, [PROBE, mode], {
      env: { ...process.env, PROBE_INDEX: INDEX, PROBE_USER_DATA: userData },
      encoding: 'utf8',
      timeout: 30000,
    });
    return output.includes('BOOTSTRAP-RAN');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

test('loaded the way an installed app is (Module._load(file, Module, true)) the file starts the app', () => {
  assert.equal(bootstrapRan('installed'), true);
});

test('loaded the way `electron .` does (no parent, no require.main) the file starts the app', () => {
  assert.equal(bootstrapRan('default-app'), true);
});

test('required by another module the file does nothing until bootstrap() is called', () => {
  assert.equal(bootstrapRan('required'), false);
});

test('run with plain Node, even as the main module, the file does not start the app', () => {
  assert.equal(bootstrapRan('plain-node'), false);
});

test('the entry comment says what is true: it names both loaders', () => {
  const source = fs.readFileSync(INDEX, 'utf8');
  assert.match(source, /resources\/app\.asar/);
  assert.match(source, /isAppEntry\(module, require\.main, process\.versions\)/);
  assert.doesNotMatch(source, /`require\.main` cannot be used/, 'the old claim that require.main is unusable is false for an installed app');
});
