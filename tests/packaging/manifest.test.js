'use strict';

/**
 * The packaging manifest (SPEC 15): what electron-builder puts into the installer must contain everything the app loads, and
 * nothing of v1 may be left behind. Static checks only: no packaging tool is run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** The source without comments, so the scans look at code only. */
const code = (relative) => read(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** electron-builder's `files` patterns as a matcher: `**` crosses folders, `*` does not, a leading `!` excludes. */
function createMatcher(patterns) {
  const toRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  const rules = patterns.map((pattern) => ({ exclude: pattern.startsWith('!'), regexp: toRegExp(pattern.replace(/^!/, '')) }));
  return (relative) => {
    let included = false;
    for (const rule of rules) if (rule.regexp.test(relative)) included = !rule.exclude;
    return included;
  };
}

const inInstaller = createMatcher(pkg.build.files);
const unpacked = createMatcher(pkg.build.asarUnpack);

const toPosix = (file) => file.split(path.sep).join('/');

/** @returns {{ relative: string[], packages: string[] }} what a source file requires or imports, split into project files and packages */
function dependenciesOf(relativeFile) {
  const source = code(relativeFile);
  const specs = [...source.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  const relative = [];
  const packages = [];
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const base = path.join(path.dirname(relativeFile), spec);
      const found = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')].find((candidate) => exists(candidate) && fs.statSync(path.join(ROOT, candidate)).isFile());
      relative.push(found ? toPosix(found) : `MISSING:${toPosix(base)} (required by ${relativeFile})`);
    } else if (!spec.startsWith('node:') && !Module.builtinModules.includes(spec)) {
      packages.push(spec);
    }
  }
  return { relative, packages };
}

/** Every project file reachable from the app entry through require() and import(), and every package named on the way. */
function crawl(entry) {
  const files = new Set();
  const packages = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.js')) continue;
    const found = dependenciesOf(file);
    for (const spec of found.relative) queue.push(spec);
    for (const name of found.packages) packages.add(name);
  }
  return { files, packages };
}

const graph = crawl(toPosix(pkg.main));

test('main points at an existing file, and the version is 2.0.0 with the identity of v1 kept (upgrades and the user-data folder depend on it)', () => {
  assert.equal(pkg.main, 'src/main/index.js');
  assert.equal(exists(pkg.main), true);
  assert.equal(pkg.version, '2.0.0');
  assert.equal(pkg.name, 'electron-app');
  assert.equal(pkg.productName, 'Gadgets POS');
  assert.equal(pkg.build.appId, 'com.example.gadgetspos');
  assert.equal(pkg.build.productName, 'Gadgets POS');
});

test('the Windows AppUserModelId in the code IS build.appId (electron-builder removes `build` from the installed package.json, so it cannot be read there)', () => {
  const { APP_ID } = require('../../src/main/index');
  assert.equal(APP_ID, pkg.build.appId);
});

test('dependencies are exactly the three runtime packages, and dev dependencies the build tools (Electron, electron-builder and @electron/fuses for the afterPack hook) plus the packages only the tests import', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['electron-log', 'electron-store', 'electron-updater']);
  // puppeteer-core drives the real-Electron smoke, @babel/parser the call-site scans, sax the golden DOM, pdfkit the legacy PDF fixture: none of them ships in the app
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@babel/parser', '@electron/fuses', 'electron', 'electron-builder', 'pdfkit', 'puppeteer-core', 'sax']);
});

test('the scripts are start, test, release:check, predist and dist; the v1 webpack, package and postinstall scripts are gone', () => {
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['dist', 'predist', 'release:check', 'start', 'test']);
  assert.equal(pkg.scripts.start, 'electron .');
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.js"');
  assert.equal(pkg.scripts['release:check'], 'node --test tests/release/release.check.js');
  assert.equal(pkg.scripts.dist, 'electron-builder');
});

test('`npm run dist` runs the release gates first (predist = release:check, which lists every open gate), and the gates are build-machine tools that never ship in the installer', () => {
  assert.equal(pkg.scripts.predist, 'npm run release:check');
  for (const file of ['tests/release/gates.js', 'tests/release/release.check.js', 'tests/packaging/check-electron-support.js']) {
    assert.equal(exists(file), true, file);
    assert.equal(inInstaller(file), false, `${file}: scripts/** is packed into the installer; tests/** is not`);
  }
  assert.equal(inInstaller('scripts/after-pack-fuses.js'), false, 'the afterPack hook runs on the build machine and is kept out of the installer');
  assert.equal(pkg.build.afterPack, './scripts/after-pack-fuses.js');
  assert.equal(exists('scripts/after-pack-fuses.js'), true);
});

test('build.files is src, labels, assets, scripts (without the afterPack hook) and package.json, and nothing else; the PowerShell scripts are unpacked', () => {
  assert.deepEqual(pkg.build.files, ['src/**', 'labels/**', 'assets/**', 'scripts/**', '!scripts/after-pack-fuses.js', 'package.json']);
  assert.deepEqual(pkg.build.asarUnpack, ['scripts/**']);
  for (const script of ['scripts/raw-print.ps1', 'scripts/raw-print-host.ps1']) {
    assert.equal(exists(script), true, script);
    assert.equal(inInstaller(script), true, `${script} is in the installer`);
    assert.equal(unpacked(script), true, `${script} is unpacked next to the archive (PowerShell cannot run a file inside app.asar)`);
  }
  for (const excluded of ['tests/boot/boot.test.js', 'docs/SPEC.md', 'README.md', 'node_modules/x/index.js', 'dist/app.exe']) {
    assert.equal(inInstaller(excluded), false, `${excluded} stays out of the installer`);
  }
});

test('the update feed is the generic provider on the production dashboard (a testing build overrides the address at build time, scripts/build-release.sh)', () => {
  assert.deepEqual(pkg.build.publish, [{ provider: 'generic', url: 'https://gadgetspos.com/app-releases/desktop/' }]);
  assert.doesNotMatch(JSON.stringify(pkg.build.publish), /CHANGE-ME/);
});

test('the installers have fixed, space-free names (the download page and latest.yml refer to them), and the Mac build is a universal dmg plus the zip the Mac updater needs', () => {
  assert.equal(pkg.build.nsis.artifactName, 'Gadgets-POS-Setup-${version}.${ext}');
  assert.equal(pkg.build.mac.artifactName, 'Gadgets-POS-${version}-mac-${arch}.${ext}');
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }]);
});

test('the installer keeps the platform targets of v1 and the icons exist', () => {
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.nsis.oneClick, false);
  for (const icon of [pkg.build.icon, pkg.build.win.icon, pkg.build.mac.icon, pkg.build.linux.icon]) assert.equal(exists(icon), true, icon);
  assert.equal(pkg.build.mac.identity, null);
});

test('every file the main process requires, recursively from the entry, exists and is part of the installer', () => {
  assert.ok(graph.files.size >= 30, `the require graph has ${graph.files.size} files`);
  for (const file of graph.files) {
    assert.doesNotMatch(file, /^MISSING:/, file);
    assert.equal(exists(file), true, `${file} exists`);
    assert.equal(inInstaller(file), true, `${file} is matched by build.files`);
  }
});

test('every package the main process loads is a declared runtime dependency (or Electron itself)', () => {
  const declared = new Set(Object.keys(pkg.dependencies));
  for (const name of graph.packages) {
    if (name === 'electron') continue;
    assert.equal(declared.has(name), true, `${name} is required but not in dependencies`);
  }
  for (const name of ['electron-store', 'electron-log', 'electron-updater']) assert.ok(graph.packages.has(name), `${name} is used`);
});

test('the preload files, the windows pages and every file a page loads exist and are in the installer', () => {
  const windows = code('src/main/windows/main.js') + code('src/main/windows/settings.js') + code('src/main/windows/password.js') + code('src/main/printing/dymo/window.js');
  const named = new Set([...windows.matchAll(/['"]([\w.-]+\.(?:html|js))['"]/g)].map((match) => match[1]));
  for (const page of ['loading.html', 'offline.html', 'settings.html', 'password.html']) assert.ok(named.has(page), `${page} is opened by the window code`);
  for (const file of ['src/preload/app.js', 'src/preload/local.js', 'src/renderer/loading.html', 'src/renderer/offline.html', 'src/renderer/settings.html', 'src/renderer/password.html', 'src/renderer/dymo-loader.html']) {
    assert.equal(exists(file), true, file);
    assert.equal(inInstaller(file), true, file);
  }
  for (const page of fs.readdirSync(path.join(ROOT, 'src', 'renderer')).filter((name) => name.endsWith('.html'))) {
    const html = read(`src/renderer/${page}`);
    for (const match of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|data:)/.test(match[1])) assert.fail(`${page} loads ${match[1]} from outside the app (it must work offline)`);
      const target = toPosix(path.normalize(path.join('src/renderer', match[1])));
      assert.equal(exists(target), true, `${page} references ${target}`);
      assert.equal(inInstaller(target), true, `${target} is in the installer`);
    }
  }
  // the framework file the hidden DYMO page loads is in assets/, which the installer includes
  assert.equal(exists('assets/dymo.connect.framework.js'), true);
});

test('modules the shared renderer scripts import exist (a missing one would leave a window blank)', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'shared')).filter((name) => /\.(js|mjs)$/.test(name))) {
    for (const match of read(`src/renderer/shared/${file}`).matchAll(/from\s+'(\.[^']+)'/g)) {
      assert.equal(exists(toPosix(path.normalize(path.join('src/renderer/shared', match[1])))), true, `${file} imports ${match[1]}`);
    }
  }
});

test('every label template the app can choose exists in labels/ and is in the installer', () => {
  const { TEMPLATES } = require('../../src/main/printing/dymo/plan');
  const names = new Set();
  const collect = (value) => {
    if (typeof value === 'string') names.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(TEMPLATES);
  assert.ok(names.size >= 14, `${names.size} templates`);
  for (const name of names) {
    assert.equal(exists(`labels/${name}`), true, name);
    assert.equal(inInstaller(`labels/${name}`), true, name);
  }
});

test('the icons and pictures the code points at exist', () => {
  for (const file of ['assets/icon.ico', 'assets/icon.png', 'assets/icon.icns', 'src/renderer/shared/logo.png', 'src/renderer/shared/logo-white.png']) {
    assert.equal(exists(file), true, file);
    assert.equal(inInstaller(file), true, file);
  }
});

test('nothing of v1 is left behind: the root files are gone and nothing under src or in package.json mentions them', () => {
  const legacy = [
    'index.js', 'preload.js', 'dymo-preload.js', 'dymo-config.html', 'dymo-loader.html', 'printer-config.html', 'printer-a4-config.html',
    'printer-label-config.html', 'password-prompt.html', 'reset-password.html', 'offline.html', 'renderer.js', 'webpack.config.js',
    'receipt.txt', 'receipt-pdf.pdf', 'undefined', 'dymo.connect.framework.js',
  ];
  for (const file of legacy) assert.equal(exists(file), false, `${file} must be deleted`);
  const sources = [...graph.files].map((file) => code(file)).join('\n') + JSON.stringify(pkg);
  for (const file of legacy.filter((name) => name.includes('.') && !['index.js', 'offline.html', 'dymo-loader.html'].includes(name))) {
    assert.equal(sources.includes(file), false, `${file} is still mentioned`);
  }
});

test('no shell, no eval and no dynamic code anywhere under src (SPEC 2, 19.5): child processes are started with an argument list only', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(relative);
    }
  };
  walk('src');
  assert.ok(files.length >= 50, `${files.length} source files`);
  for (const file of files) {
    const source = code(file);
    // A bare call is a child_process function; `pattern.exec(text)` (a method call) is not.
    for (const pattern of [/(?<![.\w$])exec\s*\(/, /execSync\s*\(/, /execFileSync\s*\(/, /spawnSync\s*\(/, /shell\s*:\s*true/, /(?<![.\w$])eval\s*\(/, /new\s+Function\b/]) {
      assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
    }
  }
});

test('only the main process entry starts child processes, and the update library is required only inside a function', () => {
  const holders = [...graph.files].filter((file) => /child_process/.test(code(file)));
  assert.deepEqual(holders.sort(), ['src/main/index.js']);
  const source = code('src/main/index.js');
  const line = source.split('\n').find((text) => text.includes("require('electron-updater')"));
  assert.ok(line, 'index.js names the update library');
  assert.match(line, /^\s+autoUpdater:.*=>\s*require\('electron-updater'\)\.autoUpdater/, 'only inside the loader function that the updater calls after the POS has loaded');
  for (const file of graph.files) {
    if (file === 'src/main/index.js') continue;
    assert.doesNotMatch(code(file), /electron-updater/, `${file} must not mention the update library`);
  }
});
