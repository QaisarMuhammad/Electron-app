'use strict';

/**
 * Real-framework check for the DYMO scripts. NOT a unit test (the name does not end in .test.js, so
 * `node --test "tests/**\/*.test.js"` never runs it): it needs the Electron binary.
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/dymo/real-framework-check.js        (macOS)
 *   node_modules\electron\dist\electron.exe tests\dymo\real-framework-check.js                                (Windows)
 *
 * It loads the real src/renderer/dymo-loader.html (so the relative path to assets/dymo.connect.framework.js is
 * proved) in a hidden, sandboxed window, replaces the label's print call with a recorder (no DYMO software or
 * printer is needed) and runs the scripts the DYMO service generates. For every label it compares the text of every
 * object in the framework's label document at print time with the plan. It also shows what the real framework
 * answers when a label cannot be printed, and reports (INFO lines, never a failure) how the framework's own
 * serialiser treats a template with and without line breaks.
 *
 * Phase 2 runs the real service (src/main/printing/dymo/index.js) on a REAL hidden BrowserWindow, with only the
 * framework's printer list and print call stubbed in the page: the window is created lazily on the first label, one
 * window serves many labels, it is destroyed after the idle time, a crashed renderer is replaced, and the cold and
 * warm label latencies are measured.
 *
 * The window is never shown and the app never takes focus (macOS accessory activation policy).
 * Exit code 0 = every check passed. Run one Electron process at a time.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const { buildLabelPlan } = require(path.join(ROOT, 'src/main/printing/dymo/plan'));
const { buildPrintScript, prepareLabelXml, LIST_PRINTERS_SCRIPT, FRAMEWORK_PROBE_SCRIPT } = require(path.join(ROOT, 'src/main/printing/dymo/script'));
const { DYMO_LOADER_FILE } = require(path.join(ROOT, 'src/main/printing/dymo/window'));
const { createDymoService, createTestLabelPayload } = require(path.join(ROOT, 'src/main/printing/dymo/index'));

if (process.platform === 'darwin') app.setActivationPolicy('accessory');
// Without a listener Electron quits when the last window is destroyed, and a window created after that fails to load.
// The check destroys windows between its steps on purpose (the service does it too, after the idle time).
app.on('window-all-closed', () => {});
const hardStop = setTimeout(() => {
  console.log('REAL-FRAMEWORK CHECK: timed out');
  app.exit(2);
}, 60_000);
hardStop.unref();

const PRINTER = 'DYMO LabelWriter 450 "Front" \\ desk';
const SUFFIX = '1700000000000';

const product = (extra = {}) => ({
  printer: 'dymo',
  title: 'MacBook Air 13" M1 \\ `${x}` $& </script>',
  barcode: 'ABCDEFGH123456',
  storage: '256GB',
  network: 'Unlocked',
  ram: '8GB',
  misc_color: 'Space Grey',
  warranty: '12 Months',
  conditionObject: { grade: 'A+' },
  Processor: 'M1',
  price: '749.99',
  salePrice: '699.99',
  regular_price: '749.99',
  isSale: false,
  ...extra,
});

const repairItem = (name) => ({ product_name: name, custom_field_value: [{ value: 'Screen "cracked"' }, { value: 'Rush' }, { value: 'Back glass' }] });

const CASES = [
  { name: 'design 1', payload: { size: '32x57', design: '1', barcodefinal: product() } },
  { name: 'design 1 on sale', payload: { size: '32x57', design: '1', barcodefinal: product({ isSale: true }) } },
  { name: 'design 2 (QR written into the XML)', payload: { size: '32x57', design: '2', barcodefinal: product() } },
  { name: 'design 2 on sale = 7', payload: { size: '32x57', design: '2', barcodefinal: product({ isSale: true }) } },
  { name: 'design 3', payload: { size: '32x57', design: '3', barcodefinal: product() } },
  { name: 'design 4 (3 QR codes)', payload: { size: '32x57', design: '4', barcodefinal: product() } },
  { name: 'unlisted design on sale (v1 printed nothing)', payload: { size: '32x57', design: '', barcodefinal: product({ isSale: true }) } },
  { name: '70x54 design 2 on sale', payload: { size: '70x54', design: '2', barcodefinal: product({ isSale: true }) } },
  { name: '25x25 barcode', payload: { size: '25x25', design: '1', barcodefinal: product() } },
  { name: '25x25 QR', payload: { size: '25x25', design: '2', barcodefinal: product() } },
  { name: 'lab item', payload: { type: 'lab', design: '1', barcode: '636400', title: 'iPhone 15 "OLED" screen', barcodefinal: { printer: 'dymo' } } },
  {
    name: 'repair, two items',
    payload: {
      barcodefinal: {
        printer: 'dymo',
        design: 'repair',
        barcode: 'R-1042',
        orderDate: '2026-11-19',
        customer: { name: 'Jo "JJ" Smith', cell_no: '07123 456789' },
        business: { business_name: 'T&R Mobile', branch_name: 'Main' },
        orderItems: [repairItem('iPhone 13'), repairItem('iPad Air')],
      },
    },
  },
];

/** Page script: compares the label XML that was "printed" with the expected texts, using Chromium's DOMParser. Returns a JSON array of problems. */
const VERIFY = `(function (input) {
  var problems = [];
  var doc = new DOMParser().parseFromString(input.xml, 'application/xml');
  var parseError = doc.getElementsByTagName('parsererror');
  if (parseError.length) return JSON.stringify(['the label XML does not parse: ' + parseError[0].textContent.slice(0, 160)]);
  var types = ['TextObject', 'BarcodeObject', 'QRCodeObject'];
  function find(name) {
    for (var t = 0; t < types.length; t++) {
      var list = doc.getElementsByTagName(types[t]);
      for (var i = 0; i < list.length; i++) {
        var nameEl = list[i].getElementsByTagName('Name')[0];
        if (nameEl && nameEl.textContent === name) return list[i];
      }
    }
    return null;
  }
  function first(el, tag) { var l = el.getElementsByTagName(tag); return l.length ? l[0] : null; }
  input.ops.forEach(function (op) {
    var name = op.kind === 'qr-embed' ? op.name + '_' + input.suffix : op.name;
    var el = find(name);
    if (!el) { problems.push('object ' + name + ' not found in the printed XML'); return; }
    var actual;
    if (el.tagName === 'QRCodeObject') {
      var data = first(el, 'DataString'), holder = first(el, 'Value');
      actual = data ? data.textContent : null;
      if (!holder || holder.textContent !== op.value) problems.push(name + ': TextDataHolder value is ' + JSON.stringify(holder && holder.textContent) + ', expected ' + JSON.stringify(op.value));
      if (el.getElementsByTagName('RenderCache').length) problems.push(name + ': a cached QR picture is still there');
    } else if (el.tagName === 'BarcodeObject') {
      var barcodeData = first(el, 'Data');
      actual = barcodeData ? barcodeData.textContent : null;
    } else {
      var span = first(el, 'TextSpan');
      var text = span ? first(span, 'Text') : null;
      actual = text ? text.textContent : null;
    }
    if (actual !== op.value) problems.push(name + ': printed ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(op.value));
  });
  return JSON.stringify(problems);
})`;

const results = [];
function record(name, problems) {
  results.push({ name, problems });
  console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
}


const WEB_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false };

/** Stands in for DYMO Connect inside the page: one connected LabelWriter, and a recorder instead of the real print call. */
const STUB_DYMO = `(function () {
  window.__printed = [];
  dymo.label.framework.getPrinters = function () {
    return [{ name: 'Stub LabelWriter "450"', modelName: 'Stub', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true }];
  };
  dymo.label.framework.Label.prototype.print = function (printer) {
    window.__printed.push({ printer: printer, xml: new XMLSerializer().serializeToString(this._doc) });
  };
})()`;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Phase 2: the real service on real hidden windows. */
async function checkService() {
  const windows = [];
  const logged = [];
  const service = createDymoService({
    createHiddenWindow() {
      const win = new BrowserWindow({ show: false, webPreferences: WEB_PREFERENCES });
      windows.push(win);
      // runs before the manager's own did-finish-load handler, so the stub is in place before its first script
      win.webContents.once('did-finish-load', () => win.webContents.executeJavaScript(STUB_DYMO).catch(() => {}));
      return win;
    },
    labelsDir: path.join(ROOT, 'labels'),
    readFile: fs.promises.readFile,
    getConfig: () => ({}),
    log: { info: (message) => logged.push(message), warn: (message) => logged.push(message), error: (message) => logged.push(message) },
    idleDisposeMs: 500,
  });
  const message = (extra = {}) => ({ size: '32x57', design: '1', barcodefinal: { printer: 'dymo', title: 'MacBook Air 13" M1', barcode: 'ABCDEFGH123456', price: '749.99', conditionObject: { grade: 'New' }, ...extra } });
  const printedIn = async (win) => {
    if (win.isDestroyed()) throw new Error(`the window is already destroyed; service log: ${JSON.stringify(logged)}`);
    return JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__printed.splice(0))'));
  };

  record('service: no window exists until the first label', windows.length === 0 ? [] : [`${windows.length} window(s) at startup`]);

  let t = Date.now();
  const first = await service.print(message());
  const cold = Date.now() - t;
  const problems = [];
  if (first.ok !== true) problems.push(`first label answered ${JSON.stringify(first)}`);
  if (windows.length !== 1) problems.push(`${windows.length} windows after the first label`);
  const firstPrinted = windows[0] ? await printedIn(windows[0]) : [];
  if (firstPrinted.length !== 1 || firstPrinted[0].printer !== 'Stub LabelWriter "450"') problems.push(`print call was ${JSON.stringify(firstPrinted.map((entry) => entry.printer))}`);
  else if (!firstPrinted[0].xml.includes('MacBook Air 13&quot; M1') && !firstPrinted[0].xml.includes('MacBook Air 13" M1')) problems.push('the hostile title is not in the printed label');
  record(`service: first label prints on a real window (cold: ${cold} ms)`, problems);

  t = Date.now();
  const burst = await Promise.all(Array.from({ length: 20 }, (_, index) => service.print(message({ title: `Item ${index}` }))));
  const warm = (Date.now() - t) / 20;
  const burstPrinted = windows[0] ? await printedIn(windows[0]) : [];
  record(
    `service: 20 labels at once reuse the window (about ${warm.toFixed(1)} ms each)`,
    [
      ...(burst.every((result) => result.ok === true) ? [] : ['a label failed']),
      ...(windows.length === 1 ? [] : [`${windows.length} windows`]),
      ...(burstPrinted.length === 20 ? [] : [`${burstPrinted.length} labels reached the printer`]),
    ]
  );

  const listed = await service.listPrinters();
  record('service: listPrinters reads the printer list from the real page', listed.printers.length === 1 && listed.printers[0].name === 'Stub LabelWriter "450"' ? [] : [JSON.stringify(listed)]);

  await pause(900); // the idle time is 500 ms here (10 minutes in the app)
  record('service: an idle window is destroyed', windows[0].isDestroyed() ? [] : ['the window is still alive after the idle time']);

  const second = await service.print(message());
  record('service: the next label builds a new window', second.ok === true && windows.length === 2 && !windows[1].isDestroyed() ? [] : [`ok=${second.ok} windows=${windows.length}`]);
  await printedIn(windows[1]);

  const gone = new Promise((resolve) => windows[1].webContents.once('render-process-gone', resolve));
  windows[1].webContents.forcefullyCrashRenderer();
  await gone;
  await pause(50);
  const afterCrash = await service.print(message());
  record(
    'service: after a renderer crash the next label gets a new window',
    afterCrash.ok === true && windows.length === 3 && windows[1].isDestroyed() ? [] : [`ok=${afterCrash.ok} windows=${windows.length} crashedDestroyed=${windows[1].isDestroyed()}`]
  );

  const test = await service.print(createTestLabelPayload());
  record('service: the Settings test label prints', test.ok === true ? [] : [JSON.stringify(test)]);

  service.dispose();
  record('service: dispose() destroys the window', windows.every((win) => win.isDestroyed()) ? [] : ['a window is still alive']);
  console.log(`INFO  service log: ${logged.length} lines, e.g. "${logged.find((line) => /printed in/.test(line)) || ''}"`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false },
  });
  const exec = (code) => win.webContents.executeJavaScript(code);
  try {
    const started = Date.now();
    await win.loadFile(DYMO_LOADER_FILE);
    record('loader page loads and the framework script is found from src/renderer', (await exec(FRAMEWORK_PROBE_SCRIPT)) === true ? [] : ['the framework object does not exist after the page loaded']);
    const listed = JSON.parse(await exec(LIST_PRINTERS_SCRIPT));
    record('printer list script answers JSON (no DYMO service here, so an empty list)', Array.isArray(listed.printers) ? [] : [`unexpected answer ${JSON.stringify(listed)}`]);

    // run: real framework everywhere, only Label.print is a recorder. It captures the label DOM as it is at print time
    // (the framework's own getLabelXml() is not used: see the INFO lines at the end).
    await exec(
      '(function () { window.__printed = []; dymo.label.framework.Label.prototype.print = function (printer) { window.__printed.push({ printer: printer, xml: new XMLSerializer().serializeToString(this._doc) }); }; })()'
    );

    for (const testCase of CASES) {
      const problems = [];
      let plans;
      try {
        plans = buildLabelPlan(testCase.payload).plans;
      } catch (error) {
        record(testCase.name, [`plan failed: ${error.message}`]);
        continue;
      }
      for (const plan of plans) {
        const labelXml = prepareLabelXml(fs.readFileSync(path.join(ROOT, 'labels', plan.templateFile), 'utf8'));
        const answer = JSON.parse(await exec(buildPrintScript({ labelXml, ops: plan.ops, printerName: PRINTER, nameSuffix: SUFFIX })));
        if (answer.ok !== true) {
          problems.push(`script answered ${JSON.stringify(answer)}`);
          continue;
        }
        const printed = JSON.parse(await exec('JSON.stringify(window.__printed.splice(0))'));
        if (printed.length !== 1) {
          problems.push(`expected one print call, got ${printed.length}`);
          continue;
        }
        if (printed[0].printer !== PRINTER) problems.push(`printer name changed: ${JSON.stringify(printed[0].printer)}`);
        const found = JSON.parse(await exec(`${VERIFY}(${JSON.stringify({ xml: printed[0].xml, ops: plan.ops, suffix: SUFFIX })})`));
        problems.push(...found);
      }
      record(`${testCase.name} (${plans.length} label${plans.length > 1 ? 's' : ''})`, problems);
    }

    // what the real framework answers when a label cannot be printed
    const missing = buildPrintScript({
      labelXml: prepareLabelXml(fs.readFileSync(path.join(ROOT, 'labels', 'Labeldesign1_1.dymo'), 'utf8')),
      ops: [{ kind: 'text', name: 'Text_was', value: '1' }],
      printerName: PRINTER,
    });
    const missingAnswer = JSON.parse(await exec(missing));
    record(
      'a missing label object comes back as the framework message (not the generic Electron text)',
      missingAnswer.ok === false && /no object with name 'Text_was' was found/.test(missingAnswer.message) ? [] : [`got ${JSON.stringify(missingAnswer)}`]
    );

    // INFO: the framework's own serialiser, with and without line breaks in the template (v1 removed them)
    const serialiserProbe = (xml) =>
      `(function (xml) { var out = dymo.label.framework.openLabelXml(xml).getLabelXml(); var doc = new DOMParser().parseFromString(out, 'application/xml'); return doc.getElementsByTagName('parsererror').length === 0; })(${JSON.stringify(xml)})`;
    const rawTemplate = fs.readFileSync(path.join(ROOT, 'labels', 'Labeldesign1_1.dymo'), 'utf8');
    console.log(`INFO  getLabelXml() well-formed with line breaks removed (what v1 sends): ${await exec(serialiserProbe(prepareLabelXml(rawTemplate)))}`);
    console.log(`INFO  getLabelXml() well-formed with line breaks kept (stripLineBreaks: false): ${await exec(serialiserProbe(prepareLabelXml(rawTemplate, { stripLineBreaks: false })))}`);

    // the real printLabel: no printer is installed here
    await win.loadFile(DYMO_LOADER_FILE); // a fresh page: the recorder is gone
    const unknown = JSON.parse(
      await exec(
        buildPrintScript({
          labelXml: prepareLabelXml(fs.readFileSync(path.join(ROOT, 'labels', 'Labeldesign1_1.dymo'), 'utf8')),
          ops: [{ kind: 'text', name: 'ItemNameVal', value: 'x' }],
          printerName: PRINTER,
        })
      )
    );
    record(
      'the real printLabel reports an unknown printer as a message',
      unknown.ok === false && /unknown printer/.test(unknown.message) ? [] : [`got ${JSON.stringify(unknown)}`]
    );
    console.log(`(phase 1: ${Date.now() - started} ms)`);
    win.destroy();
    await checkService();
  } catch (error) {
    record('the check itself', [String(error && error.stack ? error.stack : error)]);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    const failed = results.filter((result) => result.problems.length > 0).length;
    console.log(`REAL-FRAMEWORK CHECK: ${results.length - failed} passed, ${failed} failed`);
    clearTimeout(hardStop);
    app.exit(failed === 0 ? 0 : 1);
  }
});
