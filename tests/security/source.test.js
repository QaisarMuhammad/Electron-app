'use strict';

/**
 * Source scans for the rules of SPEC 2 and 19.5 that apply to the three modules of this area: no shell, no eval, no
 * certificate-error bypass, and no import of Electron or electron-updater (everything is injected, SPEC 2 and 13).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', '..', 'src', 'main');
const MODULES = ['security.js', 'connectivity.js', 'updater.js'];

/** The source without comments, so the scans look at code only. */
function readCode(file) {
  const source = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

for (const file of MODULES) {
  test(`${file}: no shell, no eval, no dynamic code`, () => {
    const code = readCode(file);
    // A bare call is a child_process function; `regexp.exec(...)` (a method call) is not.
    for (const pattern of [/(?<![.\w$])exec\s*\(/, /(?<![.\w$])execSync\s*\(/, /execFile(?:Sync)?\s*\(/, /(?<![.\w$])spawn(?:Sync)?\s*\(/, /(?<![.\w$])fork\s*\(/, /shell\s*:\s*true/, /(?<![.\w$])eval\s*\(/, /new\s+Function\b/, /child_process/, /\bvm\./]) {
      assert.doesNotMatch(code, pattern, `${file} must not match ${pattern}`);
    }
  });

  test(`${file}: does not import electron or electron-updater and touches no process-wide state`, () => {
    const code = readCode(file);
    assert.doesNotMatch(code, /require\(\s*['"]electron['"]\s*\)/);
    assert.doesNotMatch(code, /require\(\s*['"]electron-updater['"]\s*\)/);
    assert.doesNotMatch(code, /from\s+['"]electron/);
    assert.doesNotMatch(code, /\bimport\s*\(/, 'no dynamic import either');
    assert.doesNotMatch(code, /process\.(?:on|once|exit|chdir|env\s*=)/);
  });

  test(`${file}: requires only Node built-ins (and sharedSuffixes.js, a list with no code of its own, in security.js)`, () => {
    const code = readCode(file);
    const required = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    for (const name of required) assert.ok(name.startsWith('node:') || (file === 'security.js' && name === './sharedSuffixes'), `${file} requires ${name}`);
  });
}

test('security.js: no certificate-error bypass of any kind (the comments may say so, the code may not do it)', () => {
  const code = readCode('security.js');
  for (const word of ['certificate-error', 'setCertificateVerifyProc', 'ignore-certificate-errors', 'allowInsecureLocalhost', 'allowRunningInsecureContent: true', 'webSecurity: false']) {
    assert.ok(!code.includes(word), `security.js must not use ${word}`);
  }
});

test('security.js: URLs are never judged by string prefix, includes or regexp-on-host tests', () => {
  const code = readCode('security.js');
  // startsWith/endsWith on a hostname is the wildcard test and is label-aware (matchesPattern); nothing else may do it.
  const hostTests = [...code.matchAll(/\.(startsWith|endsWith|includes|indexOf)\(/g)].length;
  assert.ok(hostTests > 0);
  assert.doesNotMatch(code, /href\.(?:startsWith|includes|indexOf)/);
  assert.doesNotMatch(code, /\b(?:url|input|origin)\.(?:startsWith|indexOf)\(\s*['"]https?:/);
});

test('updater.js: electron-updater is reached only through the injected autoUpdater', () => {
  const code = readCode('updater.js');
  assert.match(code, /typeof autoUpdater === 'function' \? autoUpdater\(\) : autoUpdater/);
  assert.doesNotMatch(code, /electron-updater/);
});
