'use strict';

/**
 * GOLDEN FUZZ ON REAL CHROMIUM (lens "dymo-golden"). NOT a unit test (no .test.js in the name): it needs the Electron binary.
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/verify/golden-fuzz-electron.js        (macOS)
 *
 * tests/verify/golden-fuzz.test.js runs the real DYMO framework in a Node vm over a small strict XML DOM. This script runs the SAME
 * payloads (same seed, same twin, same oracle) with the real framework in REAL hidden Electron windows, where the DOM is Chromium's:
 *   - v1 (the pristine listener, through the fake-electron hook) executes its scripts in a real hidden window;
 *   - v2 is the real createDymoService creating real hidden windows (the manager, its readiness polling and its script runs included);
 *   - every payload is judged by the same oracle, and the observations of the two engines must be identical (that is what proves the vm
 *     harness sees what Chromium sees).
 * Only the two network calls of the framework (getPrinters, Label.print) are replaced, by recorders (no DYMO software or printer needed).
 *
 * The app never takes focus (macOS accessory activation policy, windows never shown). Exit code 0 = every check passed. One Electron process at a time.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

if (process.platform === 'darwin') app.setActivationPolicy('accessory');
// without a listener Electron quits when the last window is destroyed (the service destroys its window on dispose)
app.on('window-all-closed', () => {});
const hardStop = setTimeout(() => {
  console.log('GOLDEN FUZZ (Chromium): timed out');
  app.exit(2);
}, 900_000);
hardStop.unref();

const ROOT = path.resolve(__dirname, '..', '..');
const { generateAll } = require('./golden-fuzz-lib/payload-fuzz');
const oracle = require('./golden-fuzz-lib/oracle');
const real = require('./golden-fuzz-lib/real-dymo');
const { runLegacyHandler } = require('./golden-fuzz-lib/legacy-v1');
const { createDymoService } = require(path.join(ROOT, 'src', 'main', 'printing', 'dymo'));
const { DYMO_LOADER_FILE } = require(path.join(ROOT, 'src', 'main', 'printing', 'dymo', 'window'));

const SEED = Number(process.env.GOLDEN_FUZZ_SEED || 0x5eed1234);
const COUNT = Number(process.env.GOLDEN_FUZZ_COUNT || 300);
const WEB_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false };

const pageCalls = async (win) => {
  if (!win || win.isDestroyed()) return [];
  return real.callsFromRecords(JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__calls.splice(0))')));
};

const shapes = (labels, template) => labels.map((label) => oracle.shapeOf(label, template));
const { EventEmitter } = require('node:events');

/**
 * A window for the manager whose page is ONE shared real Chromium page: every payload gets a brand-new service (so a cold template cache and a
 * cold printer cache, as in the vm harness), and `destroy()` leaves the real page alone. The manager's readiness logic runs against this proxy;
 * what is real is the page: the framework, Chromium's DOM and XML parser, and the executeJavaScript round trip.
 */
class SharedPageWindow extends EventEmitter {
  constructor(page) {
    super();
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = (code) => page.webContents.executeJavaScript(code);
    this.webContents.isDestroyed = () => this.destroyed;
  }

  loadFile() {
    return new Promise((resolve) => setImmediate(() => {
      if (!this.destroyed) this.webContents.emit('did-finish-load');
      resolve();
    }));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  isDestroyed() {
    return this.destroyed;
  }
}

app.whenReady().then(async () => {
  const started = Date.now();
  let failed = 0;
  const problems = [];
  const note = (message) => {
    failed += 1;
    if (problems.length < 25) problems.push(message);
  };

  // v1's hidden window: the real loader page, the real framework, only the network calls replaced
  const v1Window = new BrowserWindow({ show: false, webPreferences: WEB_PREFERENCES });
  await v1Window.loadFile(DYMO_LOADER_FILE);
  await v1Window.webContents.executeJavaScript(real.browserPrelude());

  const reads = [];
  const readFile = (file, encoding) => {
    reads.push(path.basename(file));
    return fs.promises.readFile(file, encoding);
  };

  // (A) v2: a NEW real service per payload on the shared real page (cold caches, like the vm harness)
  const printCold = async (payload) => {
    reads.length = 0;
    const service = createDymoService({ createHiddenWindow: () => new SharedPageWindow(v1Window), labelsDir: real.LABELS_DIR, readFile, getConfig: () => ({}), log: {} });
    await v1Window.webContents.executeJavaScript('window.__calls.length = 0');
    const result = await service.print(structuredClone(payload));
    const labels = real.summarizeLabels(await pageCalls(v1Window));
    service.dispose();
    return { result, labels, templates: [...new Set(reads)] };
  };

  // (B) v2: ONE real service creating REAL hidden windows for the whole run (the production lifetime: warm page, warm caches)
  const windows = [];
  const warmService = createDymoService({
    createHiddenWindow() {
      const win = new BrowserWindow({ show: false, webPreferences: WEB_PREFERENCES });
      windows.push(win);
      // registered before the manager's own did-finish-load handler, so the recorders are in place before its first script
      win.webContents.once('did-finish-load', () => win.webContents.executeJavaScript(real.browserPrelude()).catch(() => {}));
      return win;
    },
    labelsDir: real.LABELS_DIR,
    readFile: (file, encoding) => fs.promises.readFile(file, encoding),
    getConfig: () => ({}),
    log: {},
  });

  const tagCounts = new Map();
  let compared = 0;
  const items = generateAll(SEED, COUNT);
  for (const { payload, meta } of items) {
    const where = `#${meta.index} ${JSON.stringify(meta)}`;
    try {
      const twin = oracle.makeTwin(payload);

      // ---- v1 on Chromium
      await v1Window.webContents.executeJavaScript('window.__calls.length = 0');
      const run = await runLegacyHandler(twin.encoded, (code) => v1Window.webContents.executeJavaScript(code));
      const v1 = { ...run, labels: real.summarizeLabels(await pageCalls(v1Window)) };

      // ---- v2 on Chromium: a cold service on the shared page
      const v2 = await printCold(payload);

      // ---- the verdict on Chromium
      const judged = oracle.evaluate(payload, twin, v1, v2);
      for (const tag of judged.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      if (judged.unexplained.length > 0) note(`${where}: ${judged.unexplained.slice(0, 3).join(' | ')}`);

      // ---- the same payload in the vm harness: the observations must be identical
      const vm = await oracle.analyse(payload);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(shapes(vm.v1.labels, vm.v1.template), shapes(v1.labels, v1.template))) note(`${where}: v1 differs between the vm harness and Chromium`);
      if (!same(shapes(vm.v2.labels, vm.v2.templates[0]), shapes(v2.labels, v2.templates[0]))) note(`${where}: v2 differs between the vm harness and Chromium`);
      if (vm.v2.result.ok !== v2.result.ok || vm.v2.result.code !== v2.result.code) note(`${where}: v2 result differs (${JSON.stringify(vm.v2.result)} vs ${JSON.stringify(v2.result)})`);

      // ---- v2 on real windows with warm caches: the same labels as the cold run (the template cache is warm, so the template is judged by the vm run)
      const active = windows[windows.length - 1];
      await pageCalls(active);
      const warmResult = await warmService.print(structuredClone(payload));
      const warmLabels = real.summarizeLabels(await pageCalls(windows[windows.length - 1]));
      if (warmResult.ok !== v2.result.ok || warmResult.code !== v2.result.code) note(`${where}: warm v2 result differs (${JSON.stringify(warmResult)} vs ${JSON.stringify(v2.result)})`);
      if (!same(shapes(warmLabels, null), shapes(v2.labels, null))) note(`${where}: the warm service on real windows prints something else than a cold one`);
      for (const label of warmLabels) for (const problem of label.applied) note(`${where}: warm label document: ${problem}`);
      compared += 1;
    } catch (error) {
      note(`${where}: the check threw ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' / ') : error}`);
    }
  }

  warmService.dispose();
  const tags = [...tagCounts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => `${String(count).padStart(4)}  ${tag}`);
  console.log(`GOLDEN FUZZ (Chromium ${process.versions.chrome}, Electron ${process.versions.electron}): ${items.length} payloads, ${compared} compared with the vm harness, seed 0x${SEED.toString(16)}, ${Date.now() - started} ms`);
  console.log(`windows the warm service created: ${windows.length} (one for the whole run, plus one for every recovery); destroyed after dispose: ${windows.filter((win) => win.isDestroyed()).length}`);
  console.log(tags.join('\n'));
  if (failed > 0) console.log(`FAILED: ${failed} problem(s)\n${problems.join('\n')}`);
  else console.log('PASS: no unexplained difference between v1 and v2 on real Chromium, and the vm harness sees exactly what Chromium sees');
  if (!v1Window.isDestroyed()) v1Window.destroy();
  clearTimeout(hardStop);
  app.exit(failed === 0 ? 0 : 1);
});
