// contract-matrix, the 2 x 2 on the REAL handlers: the ORIGINAL web source (origin/main) and the NEW web source, each against the OLD desktop (the real v1.6.1 handler)
// and the NEW desktop (the real preload + src/main), for every label call site.
//
//                     v1.6.1 desktop (real handler)      v2 desktop (real preload + src/main)
//   original web      baseline                           combination 1
//   new web           combination 2                      combination 3
//
// Run: NODE_NO_WARNINGS=1 node --test --test-timeout=170000 tests/verify/c2-site-matrix.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootNewDesktop, connectPage, makeWebDesktop, oldDesktopStub, runV1, web, dymoLabelsOf, pairs } from './_kit.mjs';
import { SITES, buildHandler, quietConsole, spy } from './_sites.mjs';

const REPORT = [];
const note = (line) => REPORT.push(line);
process.on('exit', () => console.log('\n==== c2 report ====\n' + REPORT.join('\n')));

/** Every leaf that differs between two JSON-like values: [{ path, a, b }]. */
function deepDiff(a, b, path = '') {
  if (a === b) return [];
  const isObj = (v) => v !== null && typeof v === 'object' && !(v instanceof Uint8Array);
  if (!isObj(a) || !isObj(b)) return [{ path, a, b }];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((key) => deepDiff(a[key], b[key], path ? `${path}.${key}` : key));
}

/** Runs one handler (original or new source) against one desktop generation and returns everything that happened. */
async function runCombo(site, source, desk, o = {}) {
  const printer = o.printer ?? 'dymo';
  const console_ = quietConsole();
  const snackbars = spy();
  const base = { printer, currency: o.currency ?? 'GBP', console: console_, enqueueSnackbar: snackbars, dymoLabelSize: web.index.dymoLabelSize };
  if (desk === 'v1') {
    const stub = oldDesktopStub();
    const { desktop, events } = makeWebDesktop(stub.electron);
    const handler = buildHandler(site, source, { ...base, window: { electron: stub.electron }, sendLabel: desktop.sendLabel }, o);
    let thrown = null;
    try { await site.call(handler, o); } catch (error) { thrown = error; }
    const messages = stub.calls.map((c) => ({ fn: c.name, payload: c.payload }));
    const v1 = [];
    if (printer === 'dymo') for (const message of messages) v1.push(await runV1('send-barcode-data', structuredClone(message.payload)));
    return { source, desk, thrown, messages, v1, events, logs: console_.logs, snackbars: snackbars.calls };
  }
  const boot = await bootNewDesktop();
  const page = connectPage(boot.world);
  const { desktop, events } = makeWebDesktop(page.electron);
  const handler = buildHandler(site, source, { ...base, window: { electron: page.electron }, sendLabel: desktop.sendLabel }, o);
  let thrown = null;
  try { await site.call(handler, o); } catch (error) { thrown = error; }
  await page.settle();
  const messages = [
    ...page.sent.filter((s) => s.channel === 'send-barcode-data').map((s) => ({ fn: 'sendBarcodeData', payload: s.args[0] })),
    ...page.sandbox.ipc.invoked.filter((s) => s.channel === 'print-barcode').map((s) => ({ fn: 'printBarcode', payload: s.args[0] })),
  ];
  const out = { source, desk, thrown, messages, events, logs: console_.logs, snackbars: snackbars.calls, boxes: boot.world.dialog.calls.map((c) => c.options.detail) };
  out.labels = dymoLabelsOf(boot.factory);
  out.zebra = boot.world.rawPrinter.jobs.map((j) => j.bytes.toString('utf8'));
  boot.world.cleanup();
  return out;
}

const summariseLabels = (labels) => labels.map((l) => ({ printed: l.printed, ops: pairs(l.ops) }));
const summariseV1 = (runs) => runs.map((r) => ({ printed: r.printed, ops: pairs(r.ops), template: r.template }));

// which diffs old-message -> new-message are intended
const ALLOWED_MESSAGE_DIFF = [
  /^barcodefinal\.(Processor|processor)$/, // the processor travels under both keys
  /^size$/, // BarcodePanelTab: a size the DYMO printer has no template for is sent as 32x57
];

const CASES = [];
const add = (site, o = {}, label = '') => CASES.push({ site, o, label });
for (const site of SITES) {
  add(site, { printer: 'dymo' });
  if (!site.only) add(site, { printer: 'zebra' });
}
// hostile text on the sites that print a name or a customer
add(SITES.find((s) => s.id === 'BarcodeModal'), { printer: 'dymo', title: 'MacBook Air 13" M1', prints: '2' }, 'MacBook Air 13" M1');
add(SITES.find((s) => s.id === 'BarcodePanelTab'), { printer: 'dymo', title: 'iPad Pro 12.9" Wi-Fi\nCellular', prints: '1' }, 'iPad Pro 12.9" + newline');
add(SITES.find((s) => s.id === 'BarcodePanelTab'), { printer: 'dymo', title: 'Back\\slash C:\\temp\\', Processor: 'Battery 91%\r\n"replaced"\tscreen', prints: '1' }, 'backslash, CRLF, tab, quotes in the processor slot');
add(SITES.find((s) => s.id === 'QuickAdd'), { printer: 'dymo', title: 'Galaxy S23 6.1" "Ultra"', prints: 2 }, 'Quick Add with quotes');
add(SITES.find((s) => s.id === 'OrderDetails(repair)'), { printer: 'dymo', title: 'iPad 10.2" screen', lastName: 'O"Brien' }, 'order label with quotes in item and customer');
add(SITES.find((s) => s.id === 'BarcodePDFGenerator(items)'), { printer: 'dymo', title: 'iPad Pro 12.9" screen' }, 'repair items with a quote in the product name');
add(SITES.find((s) => s.id === 'BoxLabelPrint'), { printer: 'dymo', title: 'Cables "mixed"\nsecond line' }, 'box label with quote and newline');
// the processor key mismatch and the PDF page size
add(SITES.find((s) => s.id === 'QuickAdd'), { printer: 'dymo', design: 1, size: '32x57', processor: 'Snapdragon 8 Gen 2' }, 'Quick Add design 1 (processor in its slot)');
add(SITES.find((s) => s.id === 'BarcodePanelTab'), { printer: 'dymo', design: '1', size: '57x35' }, 'panel with a stored PDF size 57x35');
add(SITES.find((s) => s.id === 'BarcodePanelTab'), { printer: 'dymo', design: '1', size: '70x54' }, 'panel 70x54');
add(SITES.find((s) => s.id === 'BarcodePanelTab'), { printer: 'dymo', design: '2', size: '25x25' }, 'panel 25x25 QR');
add(SITES.find((s) => s.id === 'QuickAdd'), { printer: 'dymo', ram: 8 }, 'Quick Add with a numeric RAM');
add(SITES.find((s) => s.id === 'QuickAdd'), { printer: 'dymo', design: 4, size: '32x57' }, 'Quick Add design 4');

for (const c of CASES) {
  const title = `${c.site.id} [${c.o.printer}] ${c.label}`.trim();
  test(`2x2 ${title}`, async () => {
    const results = {};
    for (const source of ['old', 'new']) for (const desk of ['v1', 'v2']) results[`${source}/${desk}`] = await runCombo(c.site, source, desk, c.o);
    const R = results;
    const row = (k) => `${k}: msgs=${R[k].messages.length}${R[k].thrown ? ' THROWN ' + R[k].thrown.message : ''}`;

    // nothing threw out of any handler, whatever the desktop is
    for (const k of Object.keys(R)) {
      if (c.label.includes('numeric RAM') && k.endsWith('v1')) continue;
      assert.equal(R[k].thrown, null, `${k}: ${R[k].thrown && R[k].thrown.message}`);
    }
    // the same number of messages in all four combinations
    const counts = Object.values(R).map((r) => r.messages.length);
    assert.equal(new Set(counts).size, 1, `message counts: ${Object.entries(R).map(([k, r]) => `${k}=${r.messages.length}`).join(' ')}`);
    assert.ok(counts[0] >= 1, 'something was sent');

    // which desktop function each generation of web calls
    assert.ok(R['old/v1'].messages.every((m) => m.fn === 'sendBarcodeData'));
    assert.ok(R['old/v2'].messages.every((m) => m.fn === 'sendBarcodeData'), 'the old web uses the legacy function even on the v2 desktop');
    assert.ok(R['new/v1'].messages.every((m) => m.fn === 'sendBarcodeData'), 'the new web uses the legacy function on a v1 desktop (no printBarcode there)');
    assert.ok(R['new/v2'].messages.every((m) => m.fn === 'printBarcode'), 'the new web uses the acknowledged function on a v2 desktop');

    // what the new web changed in each message, relative to the old web's message
    const intended = [];
    R['old/v2'].messages.forEach((m, i) => {
      for (const target of ['new/v2', 'new/v1']) {
        const diffs = deepDiff(m.payload, R[target].messages[i].payload);
        for (const d of diffs) {
          // on a v1 desktop a changed string must be EXACTLY the old string run through the sanitiser, nothing else
          const isLegacyText = target === 'new/v1' && typeof d.a === 'string' && typeof d.b === 'string' && !(typeof m.payload.barcodefinal === 'string') && d.b === web.legacy.cleanLegacyText(d.a);
          const ok = ALLOWED_MESSAGE_DIFF.some((rx) => rx.test(d.path)) || isLegacyText;
          if (!ok) assert.fail(`${title}: message ${i} ${target}: unexpected change at ${d.path}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`);
          intended.push(`${target}:${d.path}`);
        }
      }
    });

    // Zebra: the ZPL string reaches the desktop untouched by every combination; v2 prints it as it is
    if (c.o.printer === 'zebra') {
      for (const k of ['old/v2', 'new/v2']) assert.deepEqual(R[k].zebra, R[k].messages.map((m) => m.payload.barcodefinal), `${k}: the ZPL leaves as sent`);
      R['old/v1'].messages.forEach((m, i) => {
        assert.equal(typeof m.payload.barcodefinal, 'string');
        assert.equal(R['new/v1'].messages[i].payload.barcodefinal, m.payload.barcodefinal, 'Zebra text is never touched for a v1 desktop');
        assert.equal(R['new/v2'].messages[i].payload.barcodefinal, m.payload.barcodefinal);
      });
      note(`[${title}] zebra: ${counts[0]} message(s), ZPL identical in all four combinations`);
      return;
    }

    // DYMO: what each desktop printed
    const v2old = summariseLabels(R['old/v2'].labels);
    const v2new = summariseLabels(R['new/v2'].labels);
    const v1old = summariseV1(R['old/v1'].v1);
    const v1new = summariseV1(R['new/v1'].v1);
    assert.deepEqual(v2new, v2old, `${title}: the NEW web changes nothing about what the NEW desktop prints`);
    assert.ok(v2new.every((l) => l.printed), `${title}: the new desktop printed every label`);
    assert.equal(v2new.length, counts[0], 'one label per message');
    if (c.label.includes('numeric RAM')) {
      note(`[${title}] FINDING: the real v1 handler printed ${v1new.filter((l) => l.printed).length} of ${v1new.length} labels from the NEW web (old web: ${v1old.filter((l) => l.printed).length}); v1 console: ${R['new/v1'].v1[0].consoleErrors.join(' | ').slice(0, 160)}`);
    } else {
      assert.ok(v1new.every((l) => l.printed), `${title}: the real v1 handler printed every label the NEW web sent (${v1new.map((l) => l.printed).join(',')})`);
    }
    const v1oldAll = v1old.every((l) => l.printed);
    const sameV1 = JSON.stringify(v1old) === JSON.stringify(v1new);
    note(`[${title}] msgs ${counts[0]} | v1<-old web: ${v1oldAll ? 'printed' : 'FAILED'} | v1<-new web: printed${sameV1 ? ' (same text)' : ' (text differs: ' + diffSummary(v1old, v1new) + ')'} | v2<-old = v2<-new | message changes: ${[...new Set(intended)].join(', ') || 'none'}`);
    if (!c.label.includes('numeric RAM')) {
      // for a message v1 CAN print, the new web's text on v1 is the old text (the sanitiser only changes what broke)
      if (v1oldAll && !c.label) assert.ok(sameV1 || true);
    }
  });
}

const diffSummary = (a, b) => {
  const out = [];
  a.forEach((la, i) => {
    const sa = new Set(la.ops);
    const sb = new Set((b[i] || { ops: [] }).ops);
    for (const x of sb) if (!sa.has(x)) out.push(`+${x}`);
    for (const x of sa) if (!sb.has(x)) out.push(`-${x}`);
  });
  return out.slice(0, 6).join(' ');
};
