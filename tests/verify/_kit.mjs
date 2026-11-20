// Throwaway verification kit for the "contract-matrix" lens (not a unit test: no *.test.js in the name, `node --test` of the suite never picks it up).
//
// It wires the REAL code of both sides together, in plain Node:
//   web side      DGshop_vendor-labelprint/src/utils/desktop/*  (the util), labItemLabel.js, lib.js (printBarcodes, receipt builders) and the REAL handlers cut out of the
//                 components' source with @babel/parser (the loops of BarcodeModal, BarcodePanelTab, Quick Add, BarcodePDFGenerator, the drawer dialog ...)
//   desktop side  src/preload/app.js (the real preload, so window.electron is the real object) -> a fake ipcRenderer with structured-clone semantics ->
//                 the real src/main (ipc.js, jobs.js, dymo service, drawer, config, security ...) booted by tests/helpers/fake-boot.js
//   v1 side       tests/fixtures/legacy-index.js: the REAL v1.6.1 listeners, run in the golden harness way (fake electron, fake DYMO framework)
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESK = path.resolve(HERE, '..', '..');
export const WEB = '/Users/muhammadqaisar/Documents/projects/donesol/DGshop_vendor-labelprint';

const D = (rel) => path.join(DESK, rel);
const imp = (abs) => import(pathToFileURL(abs).href);

// ---- desktop side -------------------------------------------------------------------------------------------------------------------------
export const { createBootWorld, POS_ORIGIN } = require('../helpers/fake-boot');
export const vm = require('../helpers/vm-dymo');
export const fakeElectronKit = require('../helpers/fake-electron');
export const { createDymoService } = require(D('src/main/printing/dymo'));
export const { buildLabelPlan } = require(D('src/main/printing/dymo/plan'));
export const passwordTools = require(D('src/main/password'));
export const { runPreload } = require('../preload/harness');
export const { PrintError } = require(D('src/main/errors'));
const { resolveTarget } = require(D('src/main/printing/transports'));

// ---- web side ---------------------------------------------------------------------------------------------------------------------------
export const web = {
  index: await imp(path.join(WEB, 'src/utils/desktop/index.js')),
  bridge: await imp(path.join(WEB, 'src/utils/desktop/bridge.js')),
  feedback: await imp(path.join(WEB, 'src/utils/desktop/feedback.js')),
  legacy: await imp(path.join(WEB, 'src/utils/desktop/legacyLabelText.js')),
  payloads: await imp(path.join(WEB, 'src/utils/desktop/payloads.js')),
  labItem: await imp(path.join(WEB, 'src/utils/labItemLabel.js')),
  cut: await imp(path.join(WEB, 'src/utils/__tests__/helpers/cutFunction.mjs')),
  loader: await imp(path.join(WEB, 'src/utils/__tests__/helpers/loadLib.mjs')),
};
export const lib = await web.loader.loadLib();
export const receiptMoney = await web.loader.loadSrc('utils/receiptMoney.js');

const webRequire = createRequire(path.join(WEB, 'package.json'));
export const babelParse = webRequire('@babel/parser').parse;
const babelTraverse = webRequire('@babel/traverse').default;

/** The free (unresolved) names a function source uses, by Babel scope analysis. */
export const freeNamesOf = (source) => {
  const ast = babelParse(`(${source})`, { sourceType: 'module', plugins: ['jsx'] });
  let names = [];
  babelTraverse(ast, { Program(path_) { names = Object.keys(path_.scope.globals); path_.stop(); } });
  return names;
};

/** The source text of the function `const <name> = <function>` in a file of the web app (current worktree). */
export const cutWeb = (relFile, name) => web.cut.cutFunctionFromSource(fs.readFileSync(path.join(WEB, relFile), 'utf8'), name);
/** The same function cut from the ORIGINAL branch point (origin/main). */
export const cutWebOriginal = (relFile, name, execFileSync) => web.cut.cutFunctionFromSource(execFileSync('git', ['-C', WEB, 'show', `origin/main:${relFile}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), name);

/**
 * Turns the source text of a function into a callable. Every free name it uses must be in `scope` (or be a real global): an unknown name throws a
 * ReferenceError that names it, so a handler can never silently read something that was not supplied.
 */
export function instantiate(source, scope) {
  const proxy = new Proxy(scope, {
    has: (_t, key) => typeof key === 'string',
    get: (target, key) => {
      if (typeof key !== 'string') return undefined; // Symbol.unscopables and friends
      if (key in target) return target[key];
      if (key in globalThis) return globalThis[key];
      throw new ReferenceError(`free name "${key}" was not supplied to the extracted function`);
    },
  });
  return new Function('__scope', `with (__scope) { return (${source}); }`)(proxy);
}

// ---- IPC realism ------------------------------------------------------------------------------------------------------------------------
/** What Electron does to every argument and answer that crosses between the page and the main process (the structured clone algorithm). */
export const cloned = (value) => structuredClone(value);

// ---- the new desktop: the real app booted on fakes, plus the real preload connected to it ---------------------------------------------------
/**
 * @param {object} [o]
 * @param {object} [o.dymoWindow]     options of the fake DYMO framework window (see createWindowFactory)
 * @param {object} [o.dymoFramework]  options of the fake DYMO framework itself (printers, ...)
 * @param {string|false} [o.password] the drawer password to set (false: none)
 * @param {boolean} [o.printers]      configure a receipt and a label printer (default true)
 * @param {object} [o.world]          options for createBootWorld
 */
export async function bootNewDesktop({ dymoWindow = {}, dymoFramework, password = 'tills-pw', printers = true, world: worldOptions = {} } = {}) {
  const factory = vm.createWindowFactory(dymoFramework ? { ...dymoWindow, dymo: dymoFramework } : dymoWindow);
  const reads = [];
  const world = createBootWorld(worldOptions);
  world.overrides.dymo = createDymoService({
    createHiddenWindow: factory.createHiddenWindow,
    labelsDir: vm.LABELS_DIR,
    readFile: (file, encoding) => {
      reads.push(path.basename(file));
      return fs.promises.readFile(file, encoding);
    },
    // as src/main/index.js passes it: the real config, read on every label
    getConfig: () => (world.handle && world.handle.services ? world.handle.services.config : {}),
    timers: world.clock,
  });
  // the REAL raw printer validates its target before anything else (transports/index.js prepare -> resolveTarget): the fake of fake-boot does not, so it is added here
  const recordJob = world.rawPrinter.printRaw;
  world.rawPrinter.printRaw = async (job) => {
    resolveTarget(job && job.target);
    return recordJob(job);
  };
  await world.boot();
  await world.settle();
  const { config } = world.services();
  if (printers) {
    config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON TM-T20', port: '' });
    config.setPrinter('label', { transport: 'system', printerName: 'ZDesigner ZD420', port: '' });
  }
  if (password) config.setPasswordRecord(passwordTools.hashPassword(password));
  return { world, factory, reads, config, password };
}

/**
 * The real src/preload/app.js running against the booted app: `electron` is what a page of an allowed origin sees as window.electron. Every
 * argument and every answer is structured-cloned, like Electron does between a page and the main process. `send` (fire-and-forget) is delivered
 * to the real listener at once; `settle()` waits for the work it started.
 */
export function connectPage(world, { origin = POS_ORIGIN, url } = {}) {
  const event = () => world.events.pos(origin);
  const sandbox = runPreload('app.js', {
    url: url || `${origin}/vendor/point-of-sale?active=buy`,
    // the REAL question to the REAL main-process security (not the stand-in of the preload tests)
    syncHandler: (channel) => (channel === 'app:origin-allowed' ? world.ipc.sendSync(channel, event()) : undefined),
    invokeHandler: async (channel, args) => cloned(await world.ipc.invoke(channel, event(), ...cloned(args))),
  });
  const pending = [];
  const sent = [];
  sandbox.ipc.send = (channel, ...args) => {
    sent.push({ channel, args });
    pending.push(world.ipc.send(channel, event(), ...cloned(args)));
  };
  return {
    electron: sandbox.exposed.electron,
    exposed: sandbox.exposed,
    sandbox,
    sent,
    /** waits for every fire-and-forget message sent so far to be fully handled */
    settle: async () => {
      await Promise.all(pending.splice(0));
      await world.settle(20);
    },
  };
}

/** A web-side desktop bridge over a window whose `electron` is the given object, with its own feedback channel and clock (the events it raised are in `events`). */
export function makeWebDesktop(electron, { now = () => 0 } = {}) {
  const events = [];
  const feedback = web.feedback.createFeedback({ dispatch: (detail) => events.push(detail), now });
  const desktop = web.index.createDesktop({ getWindow: () => (electron === undefined ? undefined : { electron }), raise: feedback.raise });
  return { desktop, events, feedback };
}

// ---- the OLD desktop (v1.x) -----------------------------------------------------------------------------------------------------------------
/** window.electron of v1.6.1: exactly what its preload.js exposes (sendReceiptData, sendBarcodeData), recording what it is given. */
export function oldDesktopStub({ throwOn } = {}) {
  const calls = [];
  const electron = {
    sendReceiptData: (payload) => {
      calls.push({ name: 'sendReceiptData', payload });
      if (throwOn === 'sendReceiptData') throw new Error('boom');
    },
    sendBarcodeData: (payload) => {
      calls.push({ name: 'sendBarcodeData', payload });
      if (throwOn === 'sendBarcodeData') throw new Error('boom');
    },
  };
  return { electron, calls };
}

/**
 * Runs the REAL v1.6.1 listener of `channel` (tests/fixtures/legacy-index.js) once, with a fake electron and the fake DYMO framework
 * (the way vm-dymo.js goldenOps does for send-barcode-data) and reports what it did: native boxes, windows it opened, and the DYMO calls.
 */
export async function runV1(channel, payload, { printers } = {}) {
  const fake = fakeElectronKit.createFakeElectron();
  const dymo = vm.createFakeDymo({ printers });
  const scripts = [];
  const scriptErrors = [];
  fake.hooks.onWindowCreated = (win) => {
    win.webContents.executeJavaScript = (code) =>
      new Promise((resolve, reject) => {
        scripts.push(String(code));
        try {
          resolve(dymo.run(code));
        } catch (error) {
          scriptErrors.push(`${error.name}: ${error.message}`);
          const rejection = new Error(vm.GENERIC_SCRIPT_ERROR);
          rejection.cause = error;
          reject(rejection);
        }
      });
  };
  const reads = [];
  const realFs = fs;
  const redirect = (file) => (typeof file === 'string' && file.endsWith('.dymo') ? path.join(vm.LABELS_DIR, path.basename(file)) : file);
  const fsStub = Object.assign(Object.create(realFs), {
    existsSync: (file) => realFs.existsSync(redirect(file)),
    readFileSync(file, ...rest) {
      if (typeof file === 'string' && file.endsWith('.dymo')) reads.push(path.basename(file));
      return realFs.readFileSync(redirect(file), ...rest);
    },
  });
  const stubs = {
    electron: fake.electron,
    pdfkit: class PDFDocument {},
    'electron-store': class ElectronStore {},
    child_process: { exec() {}, execFile() {} },
    fs: fsStub,
  };
  const restoreModules = fakeElectronKit.interceptModules((request, parent) =>
    parent && parent.filename === vm.LEGACY_INDEX && Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : undefined);
  const restoreQuiet = fakeElectronKit.silenceConsole();
  const consoleErrors = [];
  const originalError = console.error;
  console.error = (...args) => consoleErrors.push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '));
  const restoreConsole = () => { console.error = originalError; restoreQuiet(); };
  let handlerError = null;
  try {
    delete require.cache[vm.LEGACY_INDEX];
    require(vm.LEGACY_INDEX);
    await fake.ipcMain.simulateSend(channel, payload);
    for (let i = 0; i < 5; i += 1) await fakeElectronKit.flush();
  } catch (error) {
    handlerError = error && error.message ? error.message : String(error);
  } finally {
    restoreConsole();
    restoreModules();
    delete require.cache[vm.LEGACY_INDEX];
  }
  const summary = vm.summarizeCalls(dymo.calls);
  const first = summary[0];
  return {
    channel,
    handlerError,
    errorBoxes: fake.state.errorBoxes,
    windows: fake.state.windows.map((w) => ({ loadedFile: w.loadedFile && path.basename(w.loadedFile), options: { modal: w.options.modal } })),
    labels: summary,
    template: reads[reads.length - 1] || null,
    ops: first ? first.ops : [],
    printed: summary.length > 0 && summary.every((label) => label.printed),
    printer: first ? first.printer : null,
    scripts,
    scriptErrors,
    consoleErrors,
    error: summary.map((label) => label.error).find(Boolean) || scriptErrors[0] || null,
  };
}

// ---- observation helpers ------------------------------------------------------------------------------------------------------------------
export const pairs = (ops) => ops.map((op) => `${op.kind}:${op.name}=${op.value}`);
export const opValue = (label, name) => label.ops.find((op) => op.name === name)?.value;
export const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** The DYMO labels the new desktop printed, as the fake framework saw them: [{ ops, printed, printer, error }]. */
export const dymoLabelsOf = (factory) => factory.windows.flatMap((win) => vm.summarizeCalls(win.fake.calls));

// a tiny, honest way to see which assertions of a script ran
export const tally = () => {
  const rows = [];
  return { rows, note: (name, value) => rows.push([name, value]) };
};
