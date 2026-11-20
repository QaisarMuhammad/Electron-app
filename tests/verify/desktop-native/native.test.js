'use strict';

/**
 * DESKTOP-NATIVE verification, the plain-Node half (SPEC 18b S1-S3, R1-R4, D1-D6, L3). Run it with
 *
 *   node --test "tests/verify/desktop-native/*.test.js"
 *
 * Independent of the builders' own tests: it re-derives each rule from the SPEC and checks the REAL modules of src/main against the
 * fakes of tests/helpers. What a fake cannot prove (real Chromium parameters, real sockets, a real minimised window, a real Menu) is
 * proved by tests/verify/desktop-native/run-native.js under the real Electron.
 *
 * A test marked `todo` asserts what the SPEC says and DOES NOT PASS today: it is a repro of a deviation (the reason is in its name), and
 * it keeps the suite green. When the deviation is fixed the test starts to pass and the `todo` can be removed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { createBootWorld } = require('../../helpers/fake-boot');
const { createFakeEnv, createFakeMenu } = require('../../helpers/fake-window');
const { createManualClock } = require('../../helpers/fake-electron');

const { createMainWindow, createLocalWindowHost, windowTitleFor, resolveWindowState } = require('../../../src/main/windows/main');
const { createSettingsWindow } = require('../../../src/main/windows/settings');
const { createPasswordWindow } = require('../../../src/main/windows/password');
const { buildContextMenuTemplate } = require('../../../src/main/windows/contextMenu');
const { buildMenuTemplate } = require('../../../src/main/windows/menu');
const { createLoginItem, createPowerKeeper, applyCommandLineSwitches } = require('../../../src/main/platform');
const { readFlagsSync, writeFlags, fallbackReason, resolveGpuDisabled, DEFAULT_FLAGS } = require('../../../src/main/flags');
const { isSafeExternalUrl } = require('../../../src/main/security');
const { UPDATER_DELAY_MS } = require('../../../src/main/index');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

async function boot(options = {}) {
  const world = createBootWorld(options);
  await world.boot();
  await world.settle();
  return world;
}

/** The application menu item with this id, from the template the real bootstrap installed. */
function menuItem(world, id) {
  const find = (items) => {
    for (const item of items || []) {
      if (item.id === id) return item;
      const inner = find(item.submenu);
      if (inner) return inner;
    }
    return undefined;
  };
  return find(world.Menu.applications.at(-1).template);
}

/** Every `.js` file under a folder. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []));
}

// ======================================================================================================================
// S1 / R3: lazy loading, proved with Module._load, and the timers of the app
// ======================================================================================================================

test('S1: electron-updater is required in exactly one place of src, inside a function, and nothing else loads it', () => {
  const hits = [];
  for (const file of sourceFiles(SRC)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) return; // comments may name the module
      if (/electron-updater/.test(code) && /require\(|import\(|from\s+['"]/.test(code)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${code}`);
    });
  }
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /src\/main\/index\.js/);
  assert.match(hits[0], /=>\s*require\('electron-updater'\)\.autoUpdater/, 'inside an arrow function, so nothing is loaded when the file is');
});

test('S1: with the real default loader, `require("electron-updater")` is requested not at boot, not at pos-loaded, and exactly once at +10 s (Module._load instrumentation)', async () => {
  const requested = [];
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (/^electron-updater$|[\\/]electron-updater[\\/]/.test(String(request))) requested.push(String(request));
    // eslint-disable-next-line prefer-rest-params
    return original.apply(this, [request, ...rest]);
  };
  let world;
  try {
    world = createBootWorld({ withUpdater: false });
    await world.boot();
    await world.settle();
    assert.deepEqual(requested, [], 'not at boot');
    await world.clock.advance(120_000);
    assert.deepEqual(requested, [], 'not while the POS has not finished loading, however long that takes');
    await world.loadPos();
    assert.deepEqual(requested, [], 'not at pos-loaded');
    await world.clock.advance(UPDATER_DELAY_MS - 1);
    assert.deepEqual(requested, [], 'not one millisecond before the delay is over');
    await world.clock.advance(1);
    assert.equal(requested.filter((request) => request === 'electron-updater').length, 1, 'exactly once, at +10 s (the real default loader ran)');
    await world.loadPos();
    await world.clock.advance(5 * UPDATER_DELAY_MS);
    assert.equal(requested.filter((request) => request === 'electron-updater').length, 1, 'a reload of the POS never loads it a second time');
    assert.equal(UPDATER_DELAY_MS, 10_000);
  } finally {
    Module._load = original;
    if (world) world.cleanup();
  }
});

test('R3: after the boot and the POS load every timer the app holds is unref()ed, one-shot, and none polls', async () => {
  const world = await boot();
  await world.loadPos();
  assert.equal(world.clock.pendingRefed(), 0, 'nothing keeps the process alive');
  const before = world.clock.timers().length;
  await world.clock.advance(6 * 60 * 60 * 1000);
  assert.ok(world.clock.timers().length <= before + 3, 'six hours of idle create no polling timers (only the updater schedule: first check, then the 4 h repeat)');
  assert.equal(world.clock.pendingRefed(), 0);
  world.cleanup();
});

// ======================================================================================================================
// R1: the GPU flag
// ======================================================================================================================

test('R1: flags.json is read synchronously and never throws: BOM, corrupt, wrong types, empty, a directory', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gpos-v-flags-'));
  try {
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'missing file: the defaults');
    fs.writeFileSync(path.join(dir, 'flags.json'), '﻿{"disableGpu":true,"reason":"manual"}');
    assert.equal(readFlagsSync(dir).disableGpu, true, 'a BOM (Notepad) is ignored');
    fs.writeFileSync(path.join(dir, 'flags.json'), '{not json');
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'corrupt: the defaults');
    fs.writeFileSync(path.join(dir, 'flags.json'), '');
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'empty: the defaults');
    fs.writeFileSync(path.join(dir, 'flags.json'), '[true]');
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'an array is not a flags object');
    fs.writeFileSync(path.join(dir, 'flags.json'), JSON.stringify({ disableGpu: 'yes', disableBrotli: 0, gpuChecked: 'maybe', reason: 7 }));
    assert.deepEqual(readFlagsSync(dir), { disableGpu: true, disableBrotli: false, reason: '', gpuChecked: false }, 'clear meanings are coerced, nonsense falls back');
    fs.rmSync(path.join(dir, 'flags.json'));
    fs.mkdirSync(path.join(dir, 'flags.json'));
    assert.deepEqual(readFlagsSync(dir), DEFAULT_FLAGS, 'a directory in its place: the defaults');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1: the write is atomic (temp file + rename), private (0600), merges, and leaves no temp file when the rename fails', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gpos-v-flags-'));
  try {
    writeFlags(dir, { disableGpu: true, reason: 'manual' });
    assert.equal((fs.statSync(path.join(dir, 'flags.json')).mode & 0o777).toString(8), '600');
    writeFlags(dir, { gpuChecked: true });
    assert.deepEqual(readFlagsSync(dir), { disableGpu: true, disableBrotli: true, reason: 'manual', gpuChecked: true }, 'a patch merges into what is stored');
    const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
    assert.throws(() => writeFlags(dir, { disableGpu: false }, { fs: failing }), /locked/);
    assert.equal(fs.readdirSync(dir).filter((name) => name !== 'flags.json').length, 0, 'the temp file is removed');
    assert.equal(readFlagsSync(dir).disableGpu, true, 'the old content is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1: the safety-net decision at its boundaries and in mixed streams', () => {
  const gpu = (at, reason = 'crashed') => ({ event: 'child-process-gone', processType: 'GPU', reason, at });
  const renderer = (at, startedAt, reason = 'crashed') => ({ event: 'render-process-gone', reason, at, startedAt });
  assert.equal(fallbackReason([gpu(0), gpu(60_000)], 60_000), 'gpu-crashes', 'two crashes exactly 60 s apart count');
  assert.equal(fallbackReason([gpu(0), gpu(60_001)], 60_001), null, 'one millisecond more does not');
  assert.equal(fallbackReason([gpu(0), gpu(30_000), gpu(95_000)], 95_000), null, 'only 30 s + 65 s: never two inside one minute at the time of the decision');
  assert.equal(fallbackReason([gpu(0), gpu(30_000), gpu(61_000)], 61_000), 'gpu-crashes', 'the 30 s and 61 s crashes are 31 s apart');
  assert.equal(fallbackReason([gpu(10, 'clean-exit'), gpu(20, 'clean-exit')], 30), null, 'clean exits are not crashes');
  assert.equal(fallbackReason([gpu(10), { ...gpu(20), processType: 'Utility' }], 30), null, 'only the GPU process counts');
  assert.equal(fallbackReason([renderer(20_000, 0)], 20_000), 'renderer-crash-at-start', 'a renderer crash exactly 20 s after the window started counts');
  assert.equal(fallbackReason([renderer(20_001, 0)], 20_001), null, '20.001 s does not');
  assert.equal(fallbackReason([renderer(5_000, 0, 'oom')], 5_000), null, 'out of memory is not a graphics problem');
  assert.equal(fallbackReason([renderer(5_000, 0, 'killed')], 5_000), null, 'killed (by the user, the OS) is not either');
  assert.equal(fallbackReason([renderer(5_000, 6_000)], 5_000), null, 'a crash before the window started is nonsense and is ignored');
  assert.equal(fallbackReason([renderer(30_000, 0), gpu(100), gpu(200)], 30_000), 'gpu-crashes', 'two GPU crashes win over an old renderer crash');
  assert.equal(fallbackReason(null, 0), null);
  assert.equal(fallbackReason([null, undefined, 3, 'x'], 0), null, 'junk entries are skipped');
});

test('R1: --disable-gpu always wins, and flags.json decides otherwise; hardware acceleration is on by default', () => {
  assert.equal(resolveGpuDisabled({ argv: [], flags: DEFAULT_FLAGS }), false, 'on by default');
  assert.equal(resolveGpuDisabled({ argv: ['--disable-gpu'], flags: { disableGpu: false } }), true, 'the argument wins over disableGpu:false');
  assert.equal(resolveGpuDisabled({ argv: ['--disable-gpu'], flags: { disableGpu: true } }), true);
  assert.equal(resolveGpuDisabled({ argv: [], flags: { disableGpu: true } }), true, 'the flag alone');
  assert.equal(resolveGpuDisabled({ argv: ['--DISABLE-GPU', '--disable-gpus', 'disable-gpu'], flags: { disableGpu: false } }), false, 'only the exact argument');
});

test('R1 boot: flags.json and --disable-gpu are applied BEFORE the app is ready, and the GPU blocklist is never overridden', async () => {
  for (const [name, options, expected] of [
    ['default', {}, false],
    ['flags.json disableGpu', { flags: { disableGpu: true, reason: 'manual', disableBrotli: false } }, true],
    ['--disable-gpu with flags false', { argv: ['--disable-gpu'], flags: { disableGpu: false } }, true],
  ]) {
    const world = createBootWorld({ deferReady: true, ...options });
    const booting = world.boot();
    await world.settle();
    const beforeReady = world.order.slice(0, world.order.includes('ready') ? world.order.indexOf('ready') : undefined);
    assert.equal(beforeReady.includes('switch:disable-hardware-acceleration'), expected, `${name}: disableHardwareAcceleration() before ready = ${expected}`);
    assert.equal(world.order.includes('ready'), false, 'the app was still not ready');
    world.ready();
    await booting;
    assert.equal(world.appCalls.switches.some(([switchName]) => switchName === 'ignore-gpu-blocklist'), false, `${name}: ignore-gpu-blocklist is never passed`);
    world.cleanup();
  }
});

test('R2: the switches per platform: 512 MB disk cache everywhere, the occlusion switch only on win32, brotli follows flags.json, hardware acceleration stays on', () => {
  const run = (platform, flags, gpuDisabled = false) => {
    const switches = [];
    let disabled = 0;
    const applied = applyCommandLineSwitches({ app: { disableHardwareAcceleration: () => { disabled += 1; }, commandLine: { appendSwitch: (name, value) => switches.push([name, value]) } }, platform, flags, gpuDisabled });
    return { switches, disabled, applied };
  };
  assert.deepEqual(run('win32', { disableBrotli: true }).switches, [['disk-cache-size', '536870912'], ['disable-features', 'CalculateNativeWinOcclusion'], ['disable-brotli', undefined]]);
  assert.deepEqual(run('darwin', { disableBrotli: false }).switches, [['disk-cache-size', '536870912']]);
  assert.deepEqual(run('linux', { disableBrotli: true }).switches, [['disk-cache-size', '536870912'], ['disable-brotli', undefined]]);
  assert.equal(run('win32', {}).disabled, 0, 'hardware acceleration stays on');
  assert.equal(run('win32', {}, true).disabled, 1, 'compatibility mode turns it off');
});

// ======================================================================================================================
// R2: the POS window
// ======================================================================================================================

test('R2: the POS window options: spellcheck off, v8 cache eager, secure flags; throttling is switched off at run time, only for the POS page', () => {
  const env = createFakeEnv();
  const controller = createMainWindow(env.mainDeps({ getServerUrl: () => 'https://vendor.societyfiles.com/vendor/point-of-sale' }));
  const prefs = controller.window.options.webPreferences;
  assert.equal(prefs.spellcheck, false);
  assert.equal(prefs.v8CacheOptions, 'bypassHeatCheck');
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.backgroundThrottling, undefined, 'NOT set at creation: a window created with false never paints its first offline screen (proved under real Electron, run C)');
  const contents = controller.window.webContents;
  const throttleCalls = () => contents.calls.filter(([name]) => name === 'setBackgroundThrottling');
  contents.url = 'file:///app/src/renderer/loading.html';
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(throttleCalls(), [], 'the loading screen is left alone');
  contents.url = 'https://vendor.societyfiles.com/vendor/point-of-sale';
  contents.emit('dom-ready');
  assert.deepEqual(throttleCalls(), [['setBackgroundThrottling', false]], 'switched off when the POS has its DOM');
  contents.emit('did-finish-load');
  assert.equal(throttleCalls().length, 2, 'and again when it finished loading');
  contents.url = 'file:///app/src/renderer/offline.html?reason=refused';
  contents.emit('dom-ready');
  assert.equal(throttleCalls().length, 2, 'the offline screen does not touch it');
});

test('R2: every window of the app has spellcheck off; the settings and password windows have the local preload and the same secure flags', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const password = createPasswordWindow(env.localDeps());
  const a = settings.open().options.webPreferences;
  const b = password.open().options.webPreferences;
  for (const prefs of [a, b]) {
    assert.equal(prefs.spellcheck, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.match(prefs.preload, /local\.js$/);
  }
  const main = createMainWindow(env.mainDeps());
  assert.equal(main.window.options.webPreferences.spellcheck, false);
});

// ======================================================================================================================
// R4: windows are destroyed on close
// ======================================================================================================================

test('R4: Settings and the password window are CREATED on demand and DESTROYED on close, 25 cycles, never hidden, one at a time', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const password = createPasswordWindow(env.localDeps());
  for (let cycle = 0; cycle < 25; cycle += 1) {
    const first = settings.open({ tab: 'general' });
    assert.equal(settings.open({ tab: 'general' }), first, 'a second request focuses the open window');
    assert.equal(env.windows.filter((win) => !win.destroyed).length, 1);
    settings.close();
    assert.equal(first.destroyed, true, 'destroyed, not hidden');
    assert.ok(!first.calls.includes('hide'));
    const prompt = password.open({ purpose: 'drawer' });
    assert.equal(env.windows.filter((win) => !win.destroyed).length, 1);
    password.close();
    assert.equal(prompt.destroyed, true);
  }
  assert.equal(env.windows.length, 50, 'every open created a new window');
  assert.equal(env.windows.filter((win) => !win.destroyed).length, 0, 'none is left over');
  assert.equal(env.registry.size, 0, 'the registry entries went with the web contents');
});

test('R4: the DYMO helper window is created by the first thing that needs it, never by boot, and a Settings open on the About tab is such a thing (printer lists)', async () => {
  const world = await boot({ overrides: { dymo: undefined } });
  assert.equal(world.windows.length, 1, 'boot: only the POS window');
  await world.loadPos();
  assert.equal(world.windows.length, 1, 'the POS page loaded: still only the POS window');
  // The real service asks for the hidden window when the printer list is wanted; Settings asks for it when its Printers code mounts.
  const settingsSource = fs.readFileSync(path.join(SRC, 'renderer', 'shared', 'settings-printers.js'), 'utf8');
  assert.match(settingsSource, /^\s*refresh\(\);\s*$/m, 'mountPrinters() calls refresh() unconditionally at the end');
  const settingsMain = fs.readFileSync(path.join(SRC, 'renderer', 'shared', 'settings.js'), 'utf8');
  assert.match(settingsMain, /mountPrinters\(ctx\);/, 'and settings.js mounts every tab at once, whatever tab was asked for');
  world.cleanup();
});

test('R4 (deviation, SPEC 18b S1/9.4: the DYMO window is created by the first DYMO label): opening Settings on a tab that shows no printer does not list printers', { todo: 'Settings mounts every tab at once and mountPrinters() refreshes the printer lists (system + DYMO) unconditionally, which starts the hidden DYMO renderer (about 55-70 MB for 10 minutes)' }, () => {
  const settingsSource = fs.readFileSync(path.join(SRC, 'renderer', 'shared', 'settings-printers.js'), 'utf8');
  assert.doesNotMatch(settingsSource, /^\s*refresh\(\);\s*$/m);
});

// ======================================================================================================================
// L3 / D5: graceful quit with a hung job, in the real bootstrap and the real queue
// ======================================================================================================================

test('L3/D5: a HUNG print job holds the quit for 5 s (the drain), then DYMO and the print helper are disposed IN THAT ORDER, then the app quits', async () => {
  const world = await boot();
  const steps = [];
  world.dymo.dispose = () => steps.push('dymo dispose');
  world.rawPrinter.dispose = () => steps.push('print helper dispose');
  // What the real raw printer does with a job: it runs on the app's own queue, under the printer's key. This one never finishes.
  const { queue } = world.services();
  void queue.enqueue('system:EPSON TM-T20', () => new Promise(() => {}), { label: 'receipt', timeoutMs: 5700 }).catch(() => {});
  assert.equal(queue.size('system:EPSON TM-T20'), 1);
  const started = Date.now();
  world.app.quit();
  await world.settle(20);
  assert.equal(world.quit, false, 'held back by the first before-quit');
  assert.deepEqual(steps, [], 'nothing is disposed while the queue is still busy');
  world.app.quit(); // a second request while draining changes nothing
  await world.settle(20);
  assert.equal(world.quit, false, 'a second quit request does not let the app go early');
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 5250 - (Date.now() - started))));
  await world.settle(40);
  assert.deepEqual(steps, ['dymo dispose', 'print helper dispose'], 'drain first (it ran out after 5 s), then the disposals in order');
  assert.equal(world.quit, true);
  assert.ok(Date.now() - started >= 4900, 'the quit waited for the drain');
  assert.equal(queue.size('system:EPSON TM-T20'), 1, 'the hung job is still there: the quit did not wait for its own 30 s timeout');
  world.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 600)); // let the job's own timer end, so no timer outlives the test
});

// ======================================================================================================================
// D1: the right-click menu
// ======================================================================================================================

const click = (item) => item.click();
const labels = (template) => template.filter((item) => item.type !== 'separator').map((item) => item.label);
const actionsStub = () => {
  const calls = [];
  return { calls, actions: { openExternal: (u) => calls.push(['open', u]), copyText: (t) => calls.push(['copy', t]), copyImage: (x, y) => calls.push(['copyImage', x, y]), saveImage: (u) => calls.push(['save', u]), inspect: (x, y) => calls.push(['inspect', x, y]) } };
};

test('D1: the template of every context, with parameters shaped like the ones Chromium sends', () => {
  const { actions } = actionsStub();
  const params = (extra) => ({ x: 10, y: 20, linkURL: '', linkText: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: false, selectionText: '', editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false }, ...extra });
  const build = (extra, isDev = false) => buildContextMenuTemplate(params(extra), { isDev, isSafeExternalUrl, actions });
  assert.deepEqual(labels(build({ isEditable: true })), ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all']);
  assert.equal(build({ isEditable: true }).find((item) => item.label === 'Cut').enabled, false, 'nothing selected: Cut is greyed out');
  assert.equal(build({ isEditable: true }).find((item) => item.label === 'Paste').enabled, true);
  assert.deepEqual(labels(build({ selectionText: 'order 12345' })), ['Copy']);
  assert.deepEqual(labels(build({ selectionText: '   ' })), [], 'a selection of blanks offers nothing');
  assert.deepEqual(labels(build({ linkURL: 'https://shop.example.com/a' })), ['Open link in browser', 'Copy link address']);
  assert.deepEqual(labels(build({ linkURL: 'http://insecure.example.com/' })), ['Copy link address'], 'http is never handed to the system browser');
  assert.deepEqual(labels(build({ linkURL: 'file:///etc/passwd' })), ['Copy link address']);
  assert.deepEqual(labels(build({ linkURL: 'ftp://x/y' })), ['Copy link address']);
  assert.deepEqual(labels(build({ linkURL: 'mailto:a@b.co?subject=x' })), ['Open link in browser', 'Copy email address']);
  assert.deepEqual(labels(build({ linkURL: 'tel:+441234' })), ['Open link in browser', 'Copy link address']);
  assert.deepEqual(labels(build({ linkURL: 'javascript:alert(1)' })), []);
  assert.deepEqual(labels(build({ mediaType: 'image', srcURL: 'https://x/y.png' })), ['Copy image', 'Save image as…']);
  assert.deepEqual(labels(build({ mediaType: 'image', srcURL: 'https://x/y.png', linkURL: 'https://x/z' })), ['Open link in browser', 'Copy link address', 'Copy image', 'Save image as…']);
  assert.deepEqual(labels(build({ mediaType: 'image', srcURL: '' })), []);
  assert.deepEqual(labels(build({})), [], 'an empty area of an installed app: no menu at all');
  assert.deepEqual(labels(build({}, true)), ['Inspect element'], 'in development: only Inspect element');
  assert.deepEqual(labels(build({ isEditable: true, linkURL: 'https://a.b/c' }, true)), ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all', 'Open link in browser', 'Copy link address', 'Inspect element']);
  const dividers = build({ isEditable: true, linkURL: 'https://a.b/c', mediaType: 'image', srcURL: 'https://x/y.png' }, true);
  assert.notEqual(dividers[0].type, 'separator');
  assert.notEqual(dividers.at(-1).type, 'separator');
  assert.ok(!dividers.some((item, index) => item.type === 'separator' && dividers[index + 1] && dividers[index + 1].type === 'separator'), 'never two dividers in a row');
});

test('D1: the roles are the standard ones (so the platform supplies the accelerators), and the edit items follow Chromium\'s edit flags', () => {
  const { actions } = actionsStub();
  const template = buildContextMenuTemplate({ isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: false, canSelectAll: true } }, { isSafeExternalUrl, actions });
  assert.deepEqual(template.filter((item) => item.role).map((item) => [item.role, item.enabled]), [['undo', true], ['redo', false], ['cut', true], ['copy', true], ['paste', false], ['selectAll', true]]);
});

test('D1: the clicks reach the sinks with the position Chromium reported', () => {
  const { actions, calls } = actionsStub();
  const template = buildContextMenuTemplate({ x: 31, y: 47, linkURL: 'https://a.b/c', mediaType: 'image', srcURL: 'https://a.b/i.png' }, { isDev: true, isSafeExternalUrl, actions });
  for (const item of template.filter((entry) => entry.click)) click(item);
  assert.deepEqual(calls, [['open', 'https://a.b/c'], ['copy', 'https://a.b/c'], ['copyImage', 31, 47], ['save', 'https://a.b/i.png'], ['inspect', 31, 47]]);
});

test('D1: a javascript: link, as real Chromium reports it (about:blank#blocked), offers nothing: not "Copy link address" either', () => {
  const { actions } = actionsStub();
  const template = buildContextMenuTemplate({ linkURL: 'about:blank#blocked', x: 1, y: 1 }, { isSafeExternalUrl, actions });
  assert.deepEqual(labels(template), [], 'a blocked javascript: link has nothing worth copying');
});

test('D1 hookup: the context-menu event of the real window code passes the params through and pops up in the owner window; isDev follows the build', () => {
  for (const isDev of [false, true]) {
    const env = createFakeEnv();
    env.Menu = createFakeMenu();
    const controller = createMainWindow(env.mainDeps({ Menu: env.Menu, isDev }));
    const params = { x: 5, y: 6, linkURL: 'https://shop.example.com/x', mediaType: 'none', isEditable: false, selectionText: '', editFlags: {} };
    controller.window.webContents.emit('context-menu', {}, params);
    const popped = env.Menu.built.at(-1);
    assert.deepEqual(labels(popped.template), isDev ? ['Open link in browser', 'Copy link address', 'Inspect element'] : ['Open link in browser', 'Copy link address']);
    assert.equal(popped.popups[0].window, controller.window, 'popped up in the window it belongs to');
    click(popped.template.find((item) => item.label === 'Copy link address'));
    assert.deepEqual(env.clipboard.writes, ['https://shop.example.com/x']);
    click(popped.template.find((item) => item.label === 'Open link in browser'));
    assert.deepEqual(env.opened, ['https://shop.example.com/x']);
    if (isDev) {
      click(popped.template.find((item) => item.label === 'Inspect element'));
      assert.deepEqual(controller.window.webContents.calls.filter(([name]) => name === 'inspectElement'), [['inspectElement', 5, 6]]);
    }
  }
});

test('D1 + SPEC 12: the real bootstrap shows "Inspect element" and the DevTools menu item when unpackaged OR started with --devtools (D1 says "only when !isPackaged": the SPEC texts differ)', async () => {
  const seen = {};
  for (const [name, options] of [['installed', { packaged: true }], ['installed --devtools', { packaged: true, argv: ['--devtools'] }], ['development', { packaged: false }]]) {
    const world = createBootWorld(options);
    await world.boot();
    await world.settle();
    const popups = [];
    world.Menu.buildFromTemplate = (template) => ({ template, popup: (popupOptions) => popups.push({ template, popupOptions }) });
    world.mainWindow().webContents.emit('context-menu', {}, { x: 1, y: 2, linkURL: '', mediaType: 'none', isEditable: false, selectionText: '', editFlags: {} });
    seen[name] = { inspect: popups.length > 0 && popups[0].template.some((item) => item.label === 'Inspect element'), devToolsItem: Boolean(menuItem(world, 'view.devtools')), devTools: world.mainWindow().options.webPreferences.devTools };
    world.cleanup();
  }
  assert.deepEqual(seen['installed'], { inspect: false, devToolsItem: false, devTools: false });
  assert.deepEqual(seen['installed --devtools'], { inspect: true, devToolsItem: true, devTools: true }, 'consistent with SPEC 12 (DevTools with --devtools), and with the DevTools menu item');
  assert.deepEqual(seen['development'], { inspect: true, devToolsItem: true, devTools: true });
});

// ======================================================================================================================
// D2: full screen
// ======================================================================================================================

test('D2: the accelerator is F11 on Windows and Linux and Ctrl+Cmd+F on macOS, and it calls the handler that saves the state', () => {
  const calls = [];
  const handlers = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  for (const [platform, accelerator] of [['win32', 'F11'], ['linux', 'F11'], ['darwin', 'Ctrl+Cmd+F']]) {
    const template = buildMenuTemplate({ platform, isDev: false, handlers });
    const view = template.find((item) => item.id === 'view');
    const full = view.submenu.find((item) => item.id === 'view.full-screen');
    assert.equal(full.accelerator, accelerator);
    full.click();
  }
  assert.equal(calls.filter(([name]) => name === 'toggleFullScreen').length, 3);
});

test('D2: toggling full screen from the menu or the system is saved at once; close saves it; the next window starts in it; "Start in full screen" forces it', () => {
  const env = createFakeEnv();
  const controller = createMainWindow(env.mainDeps());
  const win = controller.window;
  win.emit('ready-to-show');
  assert.equal(env.config.get('window.fullScreen', null), null, 'never saved yet');
  controller.toggleFullScreen();
  assert.equal(win.fullScreen, true);
  assert.equal(env.config.get('window.fullScreen'), true, 'saved the moment it entered');
  win.setFullScreen(false); // the system (Esc, green button)
  assert.equal(env.config.get('window.fullScreen'), false);
  controller.toggleFullScreen();
  win.close();
  assert.equal(env.config.get('window.fullScreen'), true, 'still true when the window closes in full screen');

  const next = createMainWindow(createFakeEnv({ config: { window: { fullScreen: true } } }).mainDeps());
  next.window.emit('ready-to-show');
  assert.ok(next.window.calls.includes('setFullScreen:true'), 'the next start is in full screen');
  assert.ok(next.window.calls.indexOf('setFullScreen:true') < next.window.calls.indexOf('show'), 'before it is shown (no flash of a normal window)');

  const forced = createMainWindow(createFakeEnv({ config: { window: { fullScreen: false, startFullScreen: true } } }).mainDeps());
  forced.window.emit('ready-to-show');
  assert.ok(forced.window.calls.includes('setFullScreen:true'), '"Start in full screen" forces it');
  const normal = createMainWindow(createFakeEnv().mainDeps());
  normal.window.emit('ready-to-show');
  assert.ok(!normal.window.calls.includes('setFullScreen:true'), 'off by default');
  assert.deepEqual(resolveWindowState({ bounds: null, maximized: false, fullScreen: false, startFullScreen: false }, createFakeEnv().screen).fullScreen, false);
});

// ======================================================================================================================
// D3: start with the computer
// ======================================================================================================================

test('D3: the login item is touched only on Windows and macOS, only for an installed app, only when it differs, and a refusing system is survived', () => {
  const matrix = [];
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const isPackaged of [true, false]) {
      for (const system of [false, true]) {
        const calls = [];
        const app = { getLoginItemSettings: () => ({ openAtLogin: system }), setLoginItemSettings: (settings) => calls.push(settings) };
        const item = createLoginItem({ app, platform, isPackaged, log: {} });
        const changed = item.apply(true);
        matrix.push({ platform, isPackaged, system, changed, calls });
      }
    }
  }
  for (const row of matrix) {
    const expected = row.platform !== 'linux' && row.isPackaged && row.system === false;
    assert.equal(row.changed, expected, JSON.stringify(row));
    assert.deepEqual(row.calls, expected ? [{ openAtLogin: true }] : [], JSON.stringify(row));
  }
  const throwing = createLoginItem({ app: { getLoginItemSettings: () => { throw new Error('no registry'); }, setLoginItemSettings() {} }, platform: 'win32', isPackaged: true, log: { warn() {} } });
  assert.equal(throwing.apply(true), false, 'a system that refuses is survived');
});

test('D3 boot: the saved setting is applied at start (system off, setting on), and the Settings switch follows through the real channel; never on Linux', async () => {
  const world = await boot({ platform: 'win32', config: { schemaVersion: 2, startup: { openAtLogin: true } } });
  assert.deepEqual(world.appCalls.loginItem, [{ openAtLogin: true }], 'applied once at boot');
  const settings = world.services().settingsWindow;
  settings.open({ tab: 'general' });
  await world.ipc.invoke('desktop:settings:setGeneral', world.events.settings(), { openAtLogin: false });
  assert.deepEqual(world.appCalls.loginItem, [{ openAtLogin: true }, { openAtLogin: false }]);
  await world.ipc.invoke('desktop:settings:setGeneral', world.events.settings(), { keepAwake: false });
  assert.equal(world.appCalls.loginItem.length, 2, 'another switch does not touch the login item');
  world.cleanup();
  const linux = await boot({ platform: 'linux', config: { schemaVersion: 2, startup: { openAtLogin: true } } });
  linux.services().settingsWindow.open({ tab: 'general' });
  await linux.ipc.invoke('desktop:settings:setGeneral', linux.events.settings(), { openAtLogin: true });
  assert.deepEqual(linux.appCalls.loginItem, [], 'never on Linux');
  linux.cleanup();
});

test('D3: the Settings page hides the login row on Linux and nowhere else (source of settings-general.js)', () => {
  const source = fs.readFileSync(path.join(SRC, 'renderer', 'shared', 'settings-general.js'), 'utf8');
  assert.match(source, /el\.loginRow\.hidden\s*=\s*ctx\.platform === 'linux'/);
  assert.doesNotMatch(source, /platform === 'win32'|platform === 'darwin'/);
});

// ======================================================================================================================
// D4: title, About
// ======================================================================================================================

test('D4: windowTitleFor: a page title is followed, everything else falls back to GadgetsPOS', () => {
  const url = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
  const cases = [
    ['Orders | POS', true, 'Orders | POS'],
    ['  Orders  ', true, 'Orders'],
    ['', true, 'GadgetsPOS'],
    ['   ', true, 'GadgetsPOS'],
    [undefined, true, 'GadgetsPOS'],
    [null, true, 'GadgetsPOS'],
    [42, true, 'GadgetsPOS'],
    [url, true, 'GadgetsPOS'],
    ['vendor.societyfiles.com/vendor/point-of-sale?active=buy', true, 'GadgetsPOS'],
    ['https://anything.example.com', true, 'GadgetsPOS'],
    ['made up from the file', false, 'GadgetsPOS'],
    ['GadgetsPOS - Can\'t connect', true, 'GadgetsPOS - Can\'t connect'],
  ];
  for (const [title, explicit, expected] of cases) assert.equal(windowTitleFor(title, explicit, url), expected, JSON.stringify([title, explicit]));
  assert.equal(windowTitleFor('vendor.societyfiles.com/', true, 'https://vendor.societyfiles.com/'), 'GadgetsPOS', 'a bare host with the trailing slash');
});

test('D4: the real window prevents Electron\'s own title update and sets the computed title (never a URL in the title bar)', () => {
  const env = createFakeEnv();
  const controller = createMainWindow(env.mainDeps());
  assert.equal(controller.window.options.title, 'GadgetsPOS', 'the window starts as GadgetsPOS');
  const send = (title, explicit, url) => {
    controller.window.webContents.url = url;
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    controller.window.emit('page-title-updated', event, title, explicit);
    return event.prevented;
  };
  assert.equal(send('Sales', true, 'https://vendor.societyfiles.com/x'), true, 'the default update is prevented');
  assert.equal(controller.window.title, 'Sales');
  send('vendor.societyfiles.com/x', false, 'https://vendor.societyfiles.com/x');
  assert.equal(controller.window.title, 'GadgetsPOS');
});

test('D4: every page of the app has a title of its own that starts with GadgetsPOS', () => {
  for (const [file, expected] of [['loading.html', /GadgetsPOS/], ['offline.html', /^GadgetsPOS/], ['settings.html', /^GadgetsPOS/], ['password.html', /^GadgetsPOS/]]) {
    const html = fs.readFileSync(path.join(SRC, 'renderer', file), 'utf8');
    assert.match(/<title>([^<]*)<\/title>/.exec(html)[1], expected, file);
  }
});

test('D4 About routing in the real bootstrap: Help > About and the macOS app-menu About open Settings on the About tab; a protected Settings asks for the password first', async () => {
  const world = await boot({ platform: 'win32' });
  menuItem(world, 'help.about').click();
  await world.settle();
  const settings = world.services().settingsWindow.getWindow();
  assert.match(settings.webContents.getURL(), /settings\.html\?tab=about$/);
  world.services().settingsWindow.close();
  world.cleanup();

  const mac = await boot({ platform: 'darwin' });
  menuItem(mac, 'app.about').click();
  await mac.settle();
  assert.match(mac.services().settingsWindow.getWindow().webContents.getURL(), /tab=about/);
  mac.cleanup();

  const protectedWorld = await boot({ platform: 'win32' });
  protectedWorld.services().drawer.setPassword({ current: undefined, next: 'drawer-1234' });
  protectedWorld.services().config.setDrawer({ requirePasswordForSettings: true });
  menuItem(protectedWorld, 'help.about').click();
  await protectedWorld.settle();
  assert.equal(protectedWorld.services().settingsWindow.getWindow(), null, 'no Settings yet');
  assert.match(protectedWorld.services().passwordWindow.getWindow().webContents.getURL(), /purpose=settings/);
  assert.equal((await protectedWorld.services().passwordPrompt.submit('wrong')).ok, false);
  assert.equal(protectedWorld.services().settingsWindow.getWindow(), null, 'a wrong password opens nothing');
  assert.equal((await protectedWorld.services().passwordPrompt.submit('drawer-1234')).ok, true);
  assert.match(protectedWorld.services().settingsWindow.getWindow().webContents.getURL(), /tab=about/, 'the tab that was asked for');
  protectedWorld.cleanup();
});

test('D4 About routing: choosing the tab that is already shown does not reload the page', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'general' });
  win.webContents.url = win.webContents.url.replace(/#.*$/, '') + '#about'; // the page has replaced its address with the tab it shows
  win.webContents.calls.length = 0;
  settings.open({ tab: 'about' });
  const loads = win.webContents.calls.filter(([name]) => name === 'loadURL');
  assert.ok(loads.every(([, loaded]) => loaded !== win.webContents.getURL()) || loads.length === 0, `loadURL was called with the address the page already has: ${JSON.stringify(loads)}`);
});

// ======================================================================================================================
// Power
// ======================================================================================================================

test('Power: the blocker follows the POS window and the keep-awake setting (start, stop, restart on activate), prevent-app-suspension only', async () => {
  const world = await boot({ platform: 'darwin' });
  assert.deepEqual(world.powerSaveBlocker.started, ['prevent-app-suspension']);
  assert.deepEqual(world.powerSaveBlocker.stopped, []);
  world.mainWindow().close();
  await world.settle();
  assert.deepEqual(world.powerSaveBlocker.stopped, [1], 'stopped when the window closed (macOS keeps the app)');
  world.app.emit('activate');
  await world.settle();
  assert.deepEqual(world.powerSaveBlocker.started, ['prevent-app-suspension', 'prevent-app-suspension'], 'started again for the new window');
  world.services().config.setGeneral({ keepAwake: false });
  assert.equal(world.powerSaveBlocker.stopped.length, 2);
  world.services().config.setGeneral({ keepAwake: true });
  assert.equal(world.powerSaveBlocker.started.length, 3);
  assert.ok(world.powerSaveBlocker.started.every((type) => type === 'prevent-app-suspension'), 'never the display');
  world.cleanup();
});

test('Power: dispose() and double sync() never leak or double-stop; a failing blocker does not throw', () => {
  const calls = [];
  const keeper = createPowerKeeper({ powerSaveBlocker: { start: () => { calls.push('start'); return 7; }, stop: (id) => calls.push(`stop ${id}`) } });
  keeper.sync(true);
  keeper.sync(true);
  assert.deepEqual(calls, ['start']);
  keeper.dispose();
  keeper.dispose();
  assert.deepEqual(calls, ['start', 'stop 7']);
  const broken = createPowerKeeper({ powerSaveBlocker: { start() { throw new Error('boom'); }, stop() {} }, log: { warn() {} } });
  assert.doesNotThrow(() => broken.sync(true));
  assert.equal(broken.isActive(), false);
});

// ======================================================================================================================
// S2: preconnect, S3: marks
// ======================================================================================================================

test('S2: the manual clock proves that nothing is preconnected to a changed address except the new origin, with 4 sockets, and again before every reconnect', async () => {
  const world = await boot();
  assert.deepEqual(world.defaultSession.preconnects, [{ url: 'https://vendor.societyfiles.com', numSockets: 4 }], 'at the first moment the URL is known: the origin only (no path), 4 sockets');
  world.services().config.setConnection({ serverUrl: 'https://shop.example.com/pos', extraAllowedOrigins: [] });
  await world.settle();
  assert.deepEqual(world.defaultSession.preconnects.at(-1), { url: 'https://shop.example.com', numSockets: 4 }, 'a changed server address is preconnected at once');
  world.cleanup();
});

test('S3: perf marks are first-call-wins and ordered; the marks reach Settings state, the diagnostics and the log, once', async () => {
  const world = await boot();
  await world.loadPos();
  await world.loadPos();
  const marks = world.services().desktopApi.getState().performance.startup.marks;
  assert.deepEqual(Object.keys(marks), ['process-start', 'app-ready', 'window-created', 'loading-visible', 'loading-painted', 'config-ready', 'services-ready', 'pos-dom-ready', 'pos-loaded']);
  const text = world.services().desktopApi.copyDiagnostics();
  assert.match(text, /^Startup: process-start 0 ms, app-ready/m);
  assert.equal(world.log.texts('info').filter((line) => line.startsWith('startup:')).length, 1, 'one line, once, however often the POS reloads');
  world.cleanup();
});
