'use strict';

/**
 * The owner release gates (tests/release/gates.js, `npm run release:check`) and the afterPack hook that flips the Electron fuses
 * (scripts/after-pack-fuses.js). The gates themselves are open on this repository until the owner has run npm and has a certificate,
 * so they are judged here against FAKE project folders, in both states; what is tested for the real folder is that the machinery is
 * in place: five gates, each with a title, what it protects and how to close it, run by `release:check` and by `predist`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GATES, runGates } = require('../release/gates');
const { afterPack, loadFuses, fuseConfig, executableOf, FUSES } = require('../../scripts/after-pack-fuses');

const ROOT = path.join(__dirname, '..', '..');
const TODAY = '2026-11-20';

/** A fake project folder. `files` maps a relative path to its text (an object is written as JSON); the folder is removed after the test. */
function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-gates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const gate = (id) => GATES.find((entry) => entry.id === id);
const run = (id, root) => gate(id).check(root, { today: TODAY });

// ---- the machinery in place ---------------------------------------------------------------------------------------------------

test('there are five gates, each says what it protects and how to close it, and a broken fake project is reported, not thrown', (t) => {
  assert.deepEqual(GATES.map((entry) => entry.id), ['electron', 'publisher', 'fuses', 'lockfile', 'feed']);
  for (const entry of GATES) {
    for (const field of ['title', 'protects', 'fix']) assert.ok(typeof entry[field] === 'string' && entry[field].length > 20, `${entry.id}.${field}`);
  }
  const results = runGates(project(t, { 'package.json': '{ not json' }), { today: TODAY });
  assert.equal(results.length, 5);
  assert.ok(results.every((entry) => entry.ok === false && /could not be checked|is not set|does not|there is no|not an https/.test(entry.detail)), JSON.stringify(results.map((entry) => entry.detail)));
});

test('the gates are not in the unit suite (their file name does not match `tests/**/*.test.js`) and are run by release:check and by predist', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'tests', 'release', 'release.check.js')), true);
  assert.equal(/\.test\.js$/.test('release.check.js'), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['release:check'], 'node --test tests/release/release.check.js', 'a file, not a glob: the build PC may run a Node that does not expand globs for --test');
  assert.equal(pkg.scripts.predist, 'npm run release:check');
});

// ---- electron ---------------------------------------------------------------------------------------------------------------

test('gate electron: open on an unsupported major, closed on a supported one (installed and declared)', (t) => {
  const old = project(t, { 'package.json': { devDependencies: { electron: '^32.1.2' } }, 'node_modules/electron/package.json': { version: '32.3.3' } });
  const open = run('electron', old);
  assert.equal(open.ok, false);
  assert.match(open.detail, /Electron 32 is older than 43/);

  const current = project(t, { 'package.json': { devDependencies: { electron: '^45.0.0' } }, 'node_modules/electron/package.json': { version: '45.1.0' } });
  assert.deepEqual(run('electron', current), { ok: true, detail: '' });

  const mixed = project(t, { 'package.json': { devDependencies: { electron: '^45.0.0' } }, 'node_modules/electron/package.json': { version: '32.3.3' } });
  assert.equal(run('electron', mixed).ok, false, 'declared 45 but 32 still installed');
});

// ---- publisher --------------------------------------------------------------------------------------------------------------

test('gate publisher: needs a non-empty build.win.publisherName (a name or a list of names)', (t) => {
  for (const publisherName of [undefined, '', '   ', [], [''], null, 42]) {
    const root = project(t, { 'package.json': { build: { win: publisherName === undefined ? {} : { publisherName } } } });
    assert.equal(run('publisher', root).ok, false, JSON.stringify(publisherName));
  }
  assert.equal(run('publisher', project(t, { 'package.json': { build: {} } })).ok, false);
  assert.equal(run('publisher', project(t, { 'package.json': {} })).ok, false);
  for (const publisherName of ['Acme Ltd', ['Acme Ltd', 'Acme Limited']]) {
    assert.deepEqual(run('publisher', project(t, { 'package.json': { build: { win: { publisherName } } } })), { ok: true, detail: '' });
  }
});

// ---- fuses ------------------------------------------------------------------------------------------------------------------

test('gate fuses: closed only when the hook is wired, uses @electron/fuses, and the package is declared AND installed', (t) => {
  const hook = "const { flipFuses } = require('@electron/fuses');\nflipFuses();\n";
  const whole = {
    'package.json': { build: { afterPack: './scripts/after-pack-fuses.js' }, devDependencies: { '@electron/fuses': '^1.8.0' } },
    'scripts/after-pack-fuses.js': hook,
    'node_modules/@electron/fuses/package.json': { version: '1.8.0' },
  };
  assert.deepEqual(run('fuses', project(t, whole)), { ok: true, detail: '' });

  const without = (...keys) => Object.fromEntries(Object.entries(whole).filter(([key]) => !keys.includes(key)));
  assert.match(run('fuses', project(t, { ...whole, 'package.json': { devDependencies: whole['package.json'].devDependencies } })).detail, /build\.afterPack is not set/);
  assert.match(run('fuses', project(t, without('scripts/after-pack-fuses.js'))).detail, /does not exist/);
  assert.match(run('fuses', project(t, { ...whole, 'scripts/after-pack-fuses.js': 'module.exports = () => {};' })).detail, /does not use @electron\/fuses/);
  assert.match(run('fuses', project(t, { ...whole, 'package.json': { build: whole['package.json'].build } })).detail, /not in devDependencies/);
  const notInstalled = run('fuses', project(t, without('node_modules/@electron/fuses/package.json')));
  assert.equal(notInstalled.ok, false);
  assert.match(notInstalled.detail, /declared but not installed/, 'this is the state of the repository until the owner runs npm install');
});

// ---- lockfile ---------------------------------------------------------------------------------------------------------------

test('gate lockfile: not ignored by git, present, and written for THIS package.json (a stale lock file is as bad as none)', (t) => {
  const manifest = { dependencies: { 'electron-log': '^5.2.0' }, devDependencies: { electron: '^45.0.0' } };
  const lock = (dependencies, devDependencies) => ({ lockfileVersion: 3, packages: { '': { dependencies, devDependencies } } });
  const good = { 'package.json': manifest, '.gitignore': 'node_modules/\ndist\n', 'package-lock.json': lock(manifest.dependencies, manifest.devDependencies) };
  assert.deepEqual(run('lockfile', project(t, good)), { ok: true, detail: '' });

  assert.match(run('lockfile', project(t, { ...good, '.gitignore': 'node_modules/\n  package-lock.json \n' })).detail, /\.gitignore lists package-lock\.json/);
  const missing = { ...good };
  delete missing['package-lock.json'];
  assert.match(run('lockfile', project(t, missing)).detail, /there is no package-lock\.json/);
  const stale = run('lockfile', project(t, { ...good, 'package-lock.json': lock({ ...manifest.dependencies, puppeteer: '^1.0.0' }, manifest.devDependencies) }));
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /does not match package\.json \(dependencies differ\)/);
  assert.match(run('lockfile', project(t, { ...good, 'package-lock.json': lock(manifest.dependencies, { electron: '^32.0.0' }) })).detail, /devDependencies differ/);
});

// ---- feed -------------------------------------------------------------------------------------------------------------------

test('gate feed: open while the address is the CHANGE-ME placeholder or not https', (t) => {
  const feed = (url) => project(t, { 'package.json': { build: { publish: [{ provider: 'generic', url }] } } });
  assert.match(run('feed', feed('https://CHANGE-ME.example.com/gadgetspos-desktop/')).detail, /still the placeholder/);
  assert.match(run('feed', feed('http://updates.example.com/x/')).detail, /not an https address/);
  assert.equal(run('feed', project(t, { 'package.json': { build: {} } })).ok, false);
  assert.deepEqual(run('feed', feed('https://updates.example.com/gadgetspos-desktop/')), { ok: true, detail: '' });
});

// ---- the afterPack hook ------------------------------------------------------------------------------------------------------

/** A fake @electron/fuses: the option names map to numbers like the real enum, and flipFuses records what it was given. */
function fakeFuses() {
  const calls = [];
  const FuseV1Options = { RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 };
  return { calls, FuseVersion: { V1: 1 }, FuseV1Options, flipFuses: async (target, config) => { calls.push({ target, config }); } };
}

const context = (electronPlatformName, appOutDir = path.join(path.sep, 'out', 'win-unpacked')) => ({
  appOutDir,
  electronPlatformName,
  packager: { appInfo: { productFilename: 'Gadgets POS' }, executableName: 'gadgets-pos' },
});

test('the hook switches RunAsNode, the Node CLI inspect arguments and NODE_OPTIONS off and the asar-only rule on, on every platform', async () => {
  assert.deepEqual({ ...FUSES }, { RunAsNode: false, EnableNodeCliInspectArguments: false, EnableNodeOptionsEnvironmentVariable: false, OnlyLoadAppFromAsar: true });
  for (const platform of ['win32', 'linux', 'darwin']) {
    const fuses = fakeFuses();
    await afterPack(context(platform), { loadFuses: async () => fuses });
    assert.equal(fuses.calls.length, 1);
    const { config } = fuses.calls[0];
    assert.equal(config.version, 1);
    assert.equal(config[fuses.FuseV1Options.RunAsNode], false, platform);
    assert.equal(config[fuses.FuseV1Options.EnableNodeCliInspectArguments], false, platform);
    assert.equal(config[fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable], false, platform);
    assert.equal(config[fuses.FuseV1Options.OnlyLoadAppFromAsar], true, platform);
    assert.equal(config[fuses.FuseV1Options.EnableCookieEncryption], undefined, 'cookies are left as they are: the POS sign-in must survive an upgrade');
  }
});

test('the asar integrity fuse is on only where the packager embeds the digest (macOS with electron-builder 24); Windows would refuse to start', () => {
  const fuses = fakeFuses();
  assert.equal(fuseConfig('darwin', fuses)[fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(fuseConfig('win32', fuses)[fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation], undefined);
  assert.equal(fuseConfig('linux', fuses)[fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation], undefined);
  assert.equal(fuseConfig('darwin', fuses).resetAdHocDarwinSignature, true);
  assert.equal(fuseConfig('win32', fuses).resetAdHocDarwinSignature, false);
});

test('the hook flips the executable of each platform: the .exe, the .app bundle, the Linux binary', async () => {
  assert.equal(executableOf(context('win32')), path.join(path.sep, 'out', 'win-unpacked', 'Gadgets POS.exe'));
  assert.equal(executableOf(context('darwin', path.join(path.sep, 'out', 'mac'))), path.join(path.sep, 'out', 'mac', 'Gadgets POS.app'));
  assert.equal(executableOf(context('linux', path.join(path.sep, 'out', 'linux-unpacked'))), path.join(path.sep, 'out', 'linux-unpacked', 'gadgets-pos'));
  const fuses = fakeFuses();
  await afterPack(context('win32'), { loadFuses: async () => fuses });
  assert.equal(fuses.calls[0].target, path.join(path.sep, 'out', 'win-unpacked', 'Gadgets POS.exe'));
});

test('a build with @electron/fuses missing FAILS, with the way out; so does a version that lacks one of the fuses, and a failing flip', async () => {
  const missing = (code) => async () => {
    throw Object.assign(new Error("Cannot find package '@electron/fuses'"), { code });
  };
  for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']) {
    await assert.rejects(afterPack(context('win32'), { loadFuses: () => loadFuses(missing(code)) }), /package @electron\/fuses is not installed\. Run "npm install".*The installer was not built\./s);
  }
  await assert.rejects(loadFuses(async () => { throw new Error('something else broke'); }), /something else broke/, 'any other import error is not disguised');

  const old = fakeFuses();
  delete old.FuseV1Options.OnlyLoadAppFromAsar;
  await assert.rejects(afterPack(context('win32'), { loadFuses: async () => old }), /no fuse called OnlyLoadAppFromAsar/);

  const failing = fakeFuses();
  failing.flipFuses = async () => { throw new Error('cannot read the executable'); };
  await assert.rejects(afterPack(context('win32'), { loadFuses: async () => failing }), /cannot read the executable/, 'a flip that fails stops the build');
});

test('loadFuses accepts the module as an ES module namespace (later versions) or with a default export (CommonJS through import())', async () => {
  const fuses = fakeFuses();
  assert.equal(await loadFuses(async () => fuses), fuses);
  assert.equal(await loadFuses(async () => ({ default: fuses })), fuses);
});
