#!/usr/bin/env node
'use strict';

/**
 * Verification script (macOS, read-only for the project; not a unit test, so `node --test` never runs it): does the app START when it
 * is laid out the way an installer lays it out?
 *
 *   node tests/verify/packaging-installed-layout.js [--seconds=20] [--keep]
 *
 * Why it exists: Electron starts an app in two different ways. `electron .` (what `npm start` and every harness use) goes through the
 * "default app", which loads package.json `main` with no parent module. An INSTALLED app (`resources/app.asar`, the layout electron-builder
 * produces on every platform) is loaded by Electron's own init code with `Module._load(main, Module, true)`: there `module.parent` is the
 * Module class and `require.main === module`. A start-up guard that is right for one way can be wrong for the other, and nothing that runs
 * the app unpackaged can notice. This script runs the app the installed way:
 *
 *   1. builds, in a temp folder and WITHOUT electron-builder, the archive the installer would contain (the emulated `build.files`, the packaged
 *      package.json, the production node_modules chosen by `app-builder node-dep-tree`, `scripts/*.ps1` unpacked) with @electron/asar;
 *   2. makes a copy-on-write clone of node_modules/electron/dist/Electron.app and puts the archive at Contents/Resources/app.asar;
 *   3. starts that clone ONCE, with an unreachable POS address and a throw-away user-data folder, and looks at what the app wrote;
 *   4. stops only the process it started (SIGTERM, SIGKILL after 5 s) and deletes the temp folder (unless --keep).
 *
 * The scratch copy of src/main/index.js gets ONE extra first line that gives macOS windows the "accessory" activation policy and maps
 * show() to showInactive(), so the run can never take focus (SPEC 18b). The entry guard at the end of the file is not touched; the real
 * source is never modified.
 *
 * PASS: the log says GadgetsPOS is starting AND the offline screen was shown from inside app.asar. FAIL (exit 1): the app started but
 * bootstrap() never ran, which is what an installed app would do for the cashier: a process with no window.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const reach = require('./packaging-reach.js');

const ROOT = reach.ROOT;
const flag = (name) => process.argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SECONDS = Number(value('seconds', '20'));
const KEEP = flag('keep');

if (process.platform !== 'darwin') {
  console.log('SKIP: this script clones Electron.app and so runs on macOS only (the loader code it checks is the same on every platform).');
  process.exit(0);
}

const requireFromRoot = (name) => require(require.resolve(name, { paths: [ROOT] }));
const asar = requireFromRoot('@electron/asar');
const { appBuilderPath } = requireFromRoot('app-builder-bin');
const electronApp = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-installed-layout-'));
const APPDIR = path.join(WORK, 'appdir');
const CLONE = path.join(WORK, 'Electron.app');
const USER_DATA = path.join(WORK, 'user-data');

// ---- 1. the project part and the production node_modules (electron-builder's rules, read from app-builder-lib 24.13.3) ------------

function packagedPackageJson(source) {
  const data = JSON.parse(source);
  for (const key of ['scripts', 'keywords', 'build', 'devDependencies', 'jspm', 'electron-webpack']) delete data[key];
  return `${JSON.stringify(data, null, 2)}\n`;
}

const NO_FOCUS = '/* scratch-only (packaging verification): accessory activation policy, show() -> showInactive() */ (() => { const { app, BrowserWindow } = require("electron"); if (process.platform === "darwin") app.setActivationPolicy("accessory"); BrowserWindow.prototype.show = function show() { return this.showInactive(); }; })();\n';

for (const relative of reach.walkMainFileSet()) {
  const target = path.join(APPDIR, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (relative === 'package.json') fs.writeFileSync(target, packagedPackageJson(fs.readFileSync(path.join(ROOT, relative), 'utf8')));
  else if (relative === 'src/main/index.js') fs.writeFileSync(target, fs.readFileSync(path.join(ROOT, relative), 'utf8').replace("'use strict';\n", `'use strict';\n${NO_FOCUS}`));
  else fs.copyFileSync(path.join(ROOT, relative), target);
}

const EXCLUDED_NAMES = new Set(['.DS_Store', 'node_modules', 'CHANGELOG.md', 'ChangeLog', 'changelog.md', 'Changelog.md', 'Changelog', 'binding.gyp', '.npmignore',
  ...'.git,.hg,.svn,CVS,RCS,SCCS,__pycache__,.DS_Store,thumbs.db,.gitignore,.gitkeep,.gitattributes,.npmignore,.idea,.vs,.flowconfig,.jshintrc,.eslintrc,.circleci,.yarn-integrity,.yarn-metadata.json,yarn-error.log,yarn.lock,package-lock.json,npm-debug.log,appveyor.yml,.travis.yml,circle.yml,.nyc_output,.husky,.github,electron-builder.env'.split(',')]);
const TOP_LEVEL_EXCLUDED = new Set(['karma.conf.js', '.coveralls.yml', 'README.md', 'readme.markdown', 'README', 'readme.md', 'Readme.md', 'Readme', 'readme', 'test', 'tests', '__tests__', 'powered-test', 'example', 'examples', '.bin']);
const EXCLUDED_EXTS = ['.o', '.obj', ...'iml,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,suo,xproj,cc,d.ts,mk,a,o,forge-meta'.split(',').map((ext) => `.${ext}`), '.pdb', '.dll', '.exe'];

function copyModule(source, destination, topLevel) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (EXCLUDED_NAMES.has(name) || name.startsWith('._') || EXCLUDED_EXTS.some((ext) => name.endsWith(ext)) || (topLevel && TOP_LEVEL_EXCLUDED.has(name))) continue;
    const from = path.join(source, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyModule(from, path.join(destination, name), false);
    else if (stat.isFile()) fs.copyFileSync(from, path.join(destination, name));
  }
}

const tree = JSON.parse(execFileSync(appBuilderPath, ['node-dep-tree', '--dir', ROOT], { encoding: 'utf8' }));
for (const entry of tree) for (const dep of entry.deps) copyModule(path.join(entry.dir, dep.name), path.join(APPDIR, path.relative(ROOT, entry.dir), dep.name), true);

// ---- 2. the installed layout -------------------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let child = null;
  let exited = false;
  try {
    try {
      execFileSync('cp', ['-cR', electronApp, CLONE], { stdio: 'ignore' }); // APFS clone: instant, no extra disk space
    } catch {
      fs.rmSync(CLONE, { recursive: true, force: true });
      execFileSync('cp', ['-R', electronApp, CLONE]); // another volume or file system: a plain copy (about 240 MB)
    }
    const resources = path.join(CLONE, 'Contents', 'Resources');
    fs.rmSync(path.join(resources, 'app.asar'), { force: true });
    await asar.createPackageWithOptions(APPDIR, path.join(resources, 'app.asar'), { unpack: '*.ps1' });
    const unpacked = path.join(resources, 'app.asar.unpacked', 'scripts');
    const unpackedOk = fs.existsSync(path.join(unpacked, 'raw-print.ps1')) && fs.existsSync(path.join(unpacked, 'raw-print-host.ps1'));

    // ---- 3. start it once ------------------------------------------------------------------------------------------------------
    const closedPort = await freePort();
    fs.mkdirSync(USER_DATA, { recursive: true });
    let output = '';
    child = spawn(path.join(CLONE, 'Contents', 'MacOS', 'Electron'), [`--user-data-dir=${USER_DATA}`], {
      env: { ...process.env, GADGETSPOS_START_URL: `http://127.0.0.1:${closedPort}/` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', () => { exited = true; });

    const logFile = path.join(USER_DATA, 'logs', 'main.log');
    const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    const deadline = Date.now() + SECONDS * 1000;
    while (Date.now() < deadline && !exited && !/showing the offline screen/.test(readLog())) await sleep(250);
    await sleep(500);
    const log = readLog();

    // ---- 4. verdict ------------------------------------------------------------------------------------------------------------
    const started = /GadgetsPOS \S+ is starting/.test(log);
    const offline = /showing the offline screen/.test(log);
    console.log(`archive: ${path.join(resources, 'app.asar')} (${fs.statSync(path.join(resources, 'app.asar')).size} bytes); scripts unpacked next to it: ${unpackedOk}`);
    console.log(`bootstrap() ran (log says GadgetsPOS is starting): ${started}`);
    console.log(`offline screen served from inside app.asar: ${offline}`);
    console.log(`files the app wrote to its data folder: ${fs.readdirSync(USER_DATA).filter((name) => ['config.json', 'logs'].includes(name)).join(', ') || '(none)'}`);
    if (started && offline && unpackedOk) {
      console.log('PASS: the app starts from Contents/Resources/app.asar.');
    } else {
      console.log('FAIL: the app was started the way an installer lays it out and it did not come up.');
      if (!started) console.log('  bootstrap() never ran. The entry guard at the end of src/main/index.js is false in this layout: Electron loads resources/app.asar with\n  Module._load(main, Module, true), so module.parent is the Module class and require.main === module (under `electron .` both are undefined).');
      if (output.trim()) console.log(`  child output:\n${output.trim().split('\n').slice(0, 12).map((line) => `    ${line.slice(0, 200)}`).join('\n')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log(`ERROR: ${error.stack || error}`);
    process.exitCode = 2;
  } finally {
    if (child && !exited) {
      child.kill('SIGTERM');
      for (let waited = 0; !exited && waited < 5000; waited += 100) await sleep(100);
      if (!exited) child.kill('SIGKILL');
    }
    if (KEEP) console.log(`kept: ${WORK}`);
    else fs.rmSync(WORK, { recursive: true, force: true });
  }
})();
