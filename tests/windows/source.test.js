'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'windows');
const FILES = ['main.js', 'settings.js', 'password.js', 'menu.js', 'contextMenu.js'];

const read = (file) => fs.readFileSync(path.join(WINDOWS_DIR, file), 'utf8');

test('the window modules never require electron: every Electron class is injected (SPEC 2)', () => {
  for (const file of FILES) {
    const requires = [...read(file).matchAll(/require\(([^)]*)\)/g)].map((match) => match[1]);
    for (const target of requires) {
      assert.doesNotMatch(target, /electron/, `${file} requires ${target}`);
    }
  }
});

test('no shell, eval or dynamic code in the window modules (SPEC 2, 19)', () => {
  for (const file of FILES) {
    const source = read(file);
    for (const forbidden of ['exec(', 'execSync', 'execFile', 'spawn(', 'shell: true', 'eval(', 'new Function', 'child_process']) {
      assert.equal(source.includes(forbidden), false, `${file} contains ${forbidden}`);
    }
  }
});

test('the window modules are strict, documented and free of leftovers', () => {
  for (const file of FILES) {
    const source = read(file);
    assert.match(source, /^'use strict';/, `${file} is strict`);
    assert.match(source, /\/\*\*[\s\S]*?\*\//, `${file} carries JSDoc`);
    assert.doesNotMatch(source, /\b(TODO|FIXME|XXX|HACK)\b/, `${file} has a leftover marker`);
    assert.doesNotMatch(source, /console\.(log|debug)\(/, `${file} prints to the console instead of the injected log`);
  }
});

test('the window modules export what the integration expects (SPEC 8, 12b, 18b)', () => {
  const main = require(path.join(WINDOWS_DIR, 'main.js'));
  for (const name of ['createMainWindow', 'createLocalWindowHost', 'installWebContentsGuards', 'registerWebContents', 'classifyLoadFailure', 'resolveWindowState', 'buildRemoteWebPreferences', 'buildLocalWebPreferences']) {
    assert.equal(typeof main[name], 'function', `main.${name}`);
  }
  assert.equal(typeof require(path.join(WINDOWS_DIR, 'settings.js')).createSettingsWindow, 'function');
  assert.equal(typeof require(path.join(WINDOWS_DIR, 'password.js')).createPasswordWindow, 'function');
  const menu = require(path.join(WINDOWS_DIR, 'menu.js'));
  assert.equal(typeof menu.buildMenuTemplate, 'function');
  assert.equal(typeof menu.buildMenu, 'function');
  const context = require(path.join(WINDOWS_DIR, 'contextMenu.js'));
  assert.equal(typeof context.buildContextMenuTemplate, 'function');
  assert.equal(typeof context.attachContextMenu, 'function');
});

test('the window modules load under plain Node, so no Electron runtime is needed to test them', () => {
  assert.equal(process.versions.electron, undefined);
  assert.doesNotThrow(() => FILES.forEach((file) => require(path.join(WINDOWS_DIR, file))));
});
