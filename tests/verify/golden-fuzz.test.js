'use strict';

/**
 * GOLDEN FUZZ (verification lens "dymo-golden"): an INDEPENDENT second harness for the DYMO plan + script.
 *
 * What is independent of the T2 golden harness (tests/dymo/golden.test.js, tests/helpers/vm-dymo.js):
 *   - the framework: the REAL assets/dymo.connect.framework.js runs in a Node vm over a small STRICT XML DOM (golden-fuzz-lib/mini-dom.js, built on `sax`:
 *     ill-formed label XML throws, as Chromium's parser refuses it), not the hand-written fake. tests/verify/golden-fuzz-electron.js repeats the same
 *     run on real Chromium (Electron) and requires the vm harness to see exactly what Chromium sees;
 *   - the v1 driver: tests/verify/golden-fuzz-lib/legacy-v1.js runs the pristine v1.6.1 listener through the fake-electron hook;
 *   - the v2 path: the real createDymoService (plan -> template cache -> printer choice -> script -> hidden window manager) on a window of its own;
 *   - the inputs: 300 SEEDED pseudo-random envelopes (sizes, designs 1-4, 7 and repair, sale on/off, missing and odd fields, currencies, unicode,
 *     quotes, numbers as strings and as numbers) instead of a hand-picked matrix;
 *   - the oracle: written from SPEC 9.4/9.4a and v1's source (golden-fuzz-lib/oracle.js), importing nothing from plan.js, labelText.js or currency.js.
 *
 * A difference is EXPLAINED when it is one of SPEC 9.4 (a)-(e), one of the two clarifications the golden harness lists ((f) design 7 sent
 * directly, (g) a repair message without items), or the String() coercion of SPEC 9.4a. Anything else fails the test and is printed.
 *
 * Needs only `sax` (a dependency of electron-updater, so present everywhere). GOLDEN_FUZZ_SEED / GOLDEN_FUZZ_COUNT override the run for experiments;
 * GOLDEN_FUZZ_SRC points the harness at a mutated copy of src/ (how the harness itself was proved to catch planted bugs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generateAll, generatePayload, SIZE_CLASSES, DESIGN_CLASSES } = require('./golden-fuzz-lib/payload-fuzz');
const { analyse, createV2Rig, observeV1, makeTwin, shapeOf, kindOf, PRICE_OPS, ownFinal, POUND } = require('./golden-fuzz-lib/oracle');
const { templateInventory, LABELS_DIR } = require('./golden-fuzz-lib/real-dymo');
const { buildLabelPlan, LabelPayloadError } = require('../../src/main/printing/dymo/plan');

const SEED = Number(process.env.GOLDEN_FUZZ_SEED || 0x5eed1234);
const COUNT = Number(process.env.GOLDEN_FUZZ_COUNT || 300);
const HEAVY = { timeout: 240_000 };

const nameOf = (item) => `#${item.meta.index} ${JSON.stringify(item.meta)}`;

/* ---------------------------------------------------------------------------------------------------------- */
/* The run (computed once, shared by the tests below)                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason && reason.stack ? reason.stack : String(reason));

let cold = null;
/** Every payload through v1 (on its twin) and v2 (the real service), each on a fresh real framework. */
function coldRun() {
  if (!cold) {
    cold = (async () => {
      process.on('unhandledRejection', onUnhandled);
      try {
        const results = [];
        for (const item of generateAll(SEED, COUNT)) {
          const r = await analyse(item.payload);
          results.push({
            ...item,
            tags: r.tags,
            unexplained: r.unexplained,
            kind: r.kind,
            symbol: r.symbol,
            v1Names: r.v1.labels.map((label) => ({ template: r.v1.template, names: label.ops.map((op) => ({ kind: op.kind, name: op.name })) })),
            v2Ok: r.v2.result.ok === true,
            v2Code: r.v2.result.ok === true ? null : r.v2.result.code,
            v2Shapes: r.v2.labels.map((label) => shapeOf(label, r.v2.templates[0])),
            v2Templates: r.v2.templates,
            v2ObjectNames: r.v2.labels.map((label) => label.objects.map((object) => object.name.replace(/_\d+$/, '_<ts>'))),
            v1Printed: r.v1.labels.length > 0 && r.v1.labels.every((label) => label.printed),
          });
        }
        return results;
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    })();
  }
  return cold;
}

const failures = (results) => results.filter((r) => r.unexplained.length > 0);

function describeFailures(results) {
  return failures(results)
    .slice(0, 12)
    .map((r) => `${nameOf(r)} kind=${r.kind} tags=[${[...r.tags].join(', ')}]\n      ${r.unexplained.slice(0, 5).join('\n      ')}`)
    .join('\n');
}

/* ---------------------------------------------------------------------------------------------------------- */
/* The generator                                                                                               */
/* ---------------------------------------------------------------------------------------------------------- */

const stable = (value) => JSON.stringify(value, (key, entry) => (entry === undefined ? '__undefined__' : typeof entry === 'number' && !Number.isFinite(entry) ? `__${entry}__` : entry));

test('the generator is deterministic, covers every size x design x sale combination, lab and repair, and never emits private-use characters', () => {
  const first = generateAll(SEED, COUNT);
  const second = generateAll(SEED, COUNT);
  assert.equal(first.length, COUNT);
  assert.equal(stable(first), stable(second), 'the same seed gives the same payloads');
  assert.equal(stable(generatePayload(SEED, 37)), stable(first[37]), 'one payload can be replayed on its own');

  const seen = new Set(first.filter(({ meta }) => !meta.lab).map(({ meta }) => `${meta.sizeClass}|${meta.designClass}|${meta.sale}`));
  const wanted = [];
  for (const size of SIZE_CLASSES) for (const design of DESIGN_CLASSES) for (const sale of [false, true]) wanted.push(`${size}|${design}|${sale}`);
  if (COUNT >= 300) assert.deepEqual(wanted.filter((key) => !seen.has(key)), [], 'every size x design x sale combination was generated at least once');
  assert.ok(first.some(({ meta }) => meta.lab), 'lab labels');
  assert.ok(first.some(({ meta }) => meta.repair), 'repair labels');
  for (const { payload } of first) assert.doesNotMatch(stable(payload), /[\ue000-\uf8ff]/u, 'no private-use characters (the oracle uses them as placeholders)');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* v1 versus v2                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('FUZZ: every payload prints the same labels in v2 as in v1, except for the deliberate differences of SPEC 9.4', HEAVY, async (t) => {
  const results = await coldRun();
  assert.equal(results.length, COUNT);
  assert.equal(failures(results).length, 0, `unexplained differences between v1 and v2:\n${describeFailures(results)}`);

  // everything that is not a repair message without items printed in v2
  for (const r of results) {
    if (r.tags.has('(g) repair without items')) assert.equal(r.v2Code, 'INVALID_PAYLOAD', nameOf(r));
    else assert.equal(r.v2Ok, true, `${nameOf(r)} v2 answered ${r.v2Code}`);
  }

  const counts = new Map();
  for (const r of results) for (const tag of r.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  const rawFailed = results.filter((r) => !r.v1Printed && !r.tags.has('(g) repair without items')).length;
  const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => `${String(count).padStart(4)}  ${tag}`);
  const parity = results.filter((r) => r.tags.size === 0).length;
  t.diagnostic(
    `${results.length} payloads, seed 0x${SEED.toString(16)}: 0 unexplained differences.\n` +
      `${String(parity).padStart(4)}  payloads on which no deliberate difference applies (identical before any adjustment: pure parity)\n${lines.join('\n')}\n` +
      `(v1 on the twin printed all labels for ${results.length - rawFailed} payloads)`
  );
  assert.ok(parity >= 15, `the pure-parity class must be exercised (${parity} payloads)`);
  assert.deepEqual(unhandled, [], 'no unhandled promise rejection during the run');
});

test('FUZZ: every deliberate difference (a)-(g) and the 9.4a coercion actually occurs in the run, so "no unexplained difference" is not vacuous', HEAVY, async () => {
  const results = await coldRun();
  const seen = new Set(results.flatMap((r) => [...r.tags]));
  const need = COUNT >= 300
    ? [
        '(a) currency symbol', '(b) processor key', '(c) empty condition', '(d) hostile characters', '(d) cleaned text', '(e) unlisted design on sale',
        '(e) unlisted design at 70x54', '(f) design 7 sent directly', '(g) repair without items', '9.4a coercion', '9.4a nullish text',
      ]
    : [];
  assert.deepEqual(need.filter((tag) => !seen.has(tag)), [], 'a rule the oracle knows about never fired');

  const kinds = new Set(results.map((r) => r.kind));
  if (COUNT >= 300) assert.deepEqual(['bc25', 'default', 'design1', 'design1sale', 'design2', 'design3', 'design4', 'design7', 'lab', 'qr25', 'repair'].filter((kind) => !kinds.has(kind)), [], 'every label kind was printed');
});

test('FUZZ: the labels carry the right QR objects: names and values of every QR mechanism, read from the printed label document', HEAVY, async () => {
  const results = await coldRun();
  const expectedQr = {
    design4: ['QRCodeObject0', 'QRCodeObject1', 'QRCodeObject2'],
    design2: ['QRCodeObject0_<ts>'],
    design7: ['QRCodeObject0_<ts>'],
    qr25: ['QRCodeObject2'],
    repair: ['QRCodeObject0'],
  };
  const byKind = new Map();
  for (const r of results) {
    if (!r.v2Ok || !(r.kind in expectedQr)) continue;
    for (const shape of r.v2Shapes) {
      const names = shape.qr.map((object) => object.name);
      assert.deepEqual(names, expectedQr[r.kind], `${nameOf(r)} ${r.kind}: the QR objects of the printed label`);
      const written = shape.ops.filter((op) => op.kind !== 'text');
      assert.equal(written.length, names.length, `${nameOf(r)}: one QR op per QR object`);
      for (const object of shape.qr) {
        assert.equal(object.renderCache, false, `${nameOf(r)}: no cached QR picture is left behind`);
        assert.equal(object.data, object.holder, `${nameOf(r)}: DataString and the value holder agree`);
      }
    }
    byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
  }
  if (COUNT >= 300) for (const kind of Object.keys(expectedQr)) assert.ok(byKind.get(kind) > 0, `${kind} was exercised`);
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Warm window, older framework                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

test('FUZZ: ONE service and ONE page for all payloads in a row (the production lifetime) print exactly what a fresh page prints', HEAVY, async () => {
  const results = await coldRun();
  const rig = createV2Rig();
  try {
    for (const [index, r] of results.entries()) {
      if (index === Math.floor(results.length / 2)) {
        rig.service.dispose(); // the idle disposal / a crash in the middle of the day: the next label builds a new window and a new page state
      }
      const { result, labels, templates } = await rig.print(r.payload);
      const label = nameOf(r);
      assert.equal(result.ok === true, r.v2Ok, `${label}: ok`);
      assert.equal(result.ok === true ? null : result.code, r.v2Code, `${label}: code`);
      // the template XML is cached after its first read, so a warm service reads nothing: the template is identified by the objects of the printed label
      assert.deepEqual(labels.map((l) => l.objects.map((object) => object.name.replace(/_\d+$/, '_<ts>'))), r.v2ObjectNames, `${label}: the same template`);
      assert.deepEqual(labels.map((l) => shapeOf(l, null)), r.v2Shapes.map((shape) => ({ ...shape, template: null })), `${label}: a warm page prints what a fresh page prints`);
      for (const l of labels) assert.deepEqual(l.applied, [], `${label}: every op is in the printed document`);
    }
  } finally {
    rig.dispose();
  }
});

test('FUZZ: with an older framework (no native _setQRCodeObjectText) designs 2 and 7 still print the same labels as v1', HEAVY, async () => {
  const results = await coldRun();
  const subset = results.filter((r) => r.kind === 'design2' || r.kind === 'design7');
  assert.ok(subset.length >= (COUNT >= 300 ? 15 : 0), `${subset.length} design 2/7 payloads`);
  for (const r of subset) {
    const old = await analyse(r.payload, { nativeQrSetter: false });
    assert.deepEqual(old.unexplained, [], `${nameOf(r)} (older framework)`);
    assert.deepEqual(old.v2.labels.map((label) => shapeOf(label, old.v2.templates[0])), r.v2Shapes, `${nameOf(r)}: v2 prints the same with or without the native setter`);
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Every written object name exists in the matching template                                                   */
/* ---------------------------------------------------------------------------------------------------------- */

test('templates: every label file lists its objects to a plain regular expression, with unique names (the framework takes the first match)', () => {
  const files = fs.readdirSync(LABELS_DIR).filter((file) => file.endsWith('.dymo'));
  assert.equal(files.length, 44);
  for (const file of files) {
    const inventory = templateInventory(file);
    assert.ok(inventory.complete, `${file}: ${inventory.objects.length} objects found, ${inventory.opened} object elements opened (an object does not start with <Name>)`);
    assert.ok(inventory.objects.length > 0, file);
    const names = inventory.objects.map((object) => object.name);
    assert.equal(new Set(names).size, names.length, `${file} repeats an object name`);
  }
});

test('templates: EVERY setObjectText / QR name a plan writes (all payloads) exists in the template that plan opens, with the right object type; v1 wrote the same names', HEAVY, async (t) => {
  const results = await coldRun();
  const written = new Map(); // template -> Set of names written by some plan
  const typeFor = { text: ['TextObject', 'BarcodeObject'], qr: ['QRCodeObject'], 'qr-embed': ['QRCodeObject'] };
  let plans = 0;
  let ops = 0;
  for (const r of results) {
    if (r.tags.has('(g) repair without items')) continue;
    const { plans: built } = buildLabelPlan(r.payload);
    for (const plan of built) {
      plans += 1;
      assert.ok(fs.existsSync(path.join(LABELS_DIR, plan.templateFile)), `${nameOf(r)}: ${plan.templateFile} is not in the labels folder`);
      const inventory = templateInventory(plan.templateFile);
      for (const op of plan.ops) {
        ops += 1;
        const object = inventory.objects.find((candidate) => candidate.name === op.name);
        assert.ok(object, `${nameOf(r)}: ${plan.templateFile} has no object named ${op.name} (${op.kind})`);
        assert.ok(typeFor[op.kind].includes(object.type), `${nameOf(r)}: ${op.kind} op on a ${object.type} ${plan.templateFile}/${op.name}`);
        if (!written.has(plan.templateFile)) written.set(plan.templateFile, new Set());
        written.get(plan.templateFile).add(op.name);
      }
    }
    // what v1 wrote must exist in the template v1 opened (wrong-size templates of v1's unlisted designs included)
    for (const label of r.v1Names) {
      if (!label.template) continue;
      const inventory = templateInventory(label.template);
      for (const op of label.names) assert.ok(inventory.objects.some((object) => object.name === op.name), `${nameOf(r)}: v1 wrote ${op.name}, which ${label.template} does not have`);
    }
  }
  const untouched = [];
  for (const [file, names] of written) {
    const never = templateInventory(file).objects.filter((object) => !names.has(object.name) && object.type !== 'ShapeObject').map((object) => object.name);
    if (never.length > 0) untouched.push(`${file}: ${never.join(', ')}`);
  }
  t.diagnostic(`${plans} plans and ${ops} object writes checked against ${written.size} templates.\nobjects no plan ever writes (static artwork or sample text):\n${untouched.join('\n')}`);
  if (COUNT >= 300) assert.ok(written.size >= 16, 'all 16 templates in use were reached');
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Branches a matrix could miss, one by one (v1 lines 1041-1790)                                               */
/* ---------------------------------------------------------------------------------------------------------- */

const FULL = {
  printer: 'dymo', title: 'iPhone 13 128GB', barcode: 'ABCDEFGH123456', storage: '128GB', network: 'Unlocked', ram: '4GB', misc_color: 'Blue', warranty: '12 Months',
  conditionObject: { grade: 'A+' }, Processor: 'A15', price: 499.99, salePrice: 449.99, regular_price: 499.99, isSale: false,
};
const envelope = (barcodefinal, extra = {}) => ({ barcodefinal, barcode: barcodefinal.barcode, title: barcodefinal.title, price: barcodefinal.price, prints: 1, ...extra });
const REPAIR_ITEM = { product_name: 'iPhone 13 screen', custom_field_value: [{ value: 'iPhone 13' }, { value: 'Screen' }, { value: 'Rush' }] };
const REPAIR = (extra = {}) => ({
  printer: 'dymo', design: 'repair', barcode: 'R-1042', orderDate: '2026-11-19', customer: { name: 'Jo Smith', cell_no: '07123 456789' },
  business: { business_name: 'T&R Mobile', branch_name: 'Main' }, orderItem: REPAIR_ITEM, ...extra,
});

async function expectNoUnexplained(payload, label) {
  const r = await analyse(payload);
  assert.deepEqual(r.unexplained, [], label);
  return r;
}

test('branch: v1 final else (an unlisted design) with a sale threw inside v1 (Text_was missing, printParamsXml branch): v2 prints the design-1 sale label of the requested size, no print parameters', async () => {
  for (const size of ['32x57', '70x54']) {
    for (const design of ['', undefined, 'x', 15, 7, '7', 0, -1]) {
      const payload = envelope({ ...FULL, isSale: true }, { size, design });
      const r = await expectNoUnexplained(payload, `${size} design ${JSON.stringify(design)} on sale`);
      const raw = await observeV1(payload); // v1 on the REAL payload
      assert.equal(raw.labels.some((label) => label.printed), false, `v1 printed nothing for an unlisted design on sale (${size}, ${JSON.stringify(design)})`);
      assert.ok(raw.labels.every((label) => label.error), 'v1 failed inside the framework (a missing label object)');
      assert.equal(r.v2.labels.length, 1);
      assert.equal(r.v2.labels[0].params, false, 'v2 never sends print parameters');
      assert.equal(r.v2.templates[0], size === '70x54' ? '70_54_Labeldesign_sale.dymo' : 'Labeldesign_sale.dymo');
      assert.deepEqual(r.v2.labels[0].ops.map((op) => op.name), ['ItemNameVal', 'TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TextObject11', 'TEXT_3', 'TEXT__1', 'Text_was', 'BARCODE', 'TextObject1']);
    }
  }
});

test('branch: v1 final else WITHOUT a sale prints 4 spec slots and the RAW processor in TEXT__1; at 70x54 v1 opened the 32x57 template', async () => {
  for (const size of ['32x57', '70x54']) {
    const r = await expectNoUnexplained(envelope(FULL, { size, design: '' }), size);
    const ops = Object.fromEntries(r.v2.labels[0].ops.map((op) => [op.name, op.value]));
    assert.equal(ops.TEXT__1, 'A15', 'the processor is not upper-cased here');
    assert.equal(ops.TEXT_5, '4GB');
    assert.equal(r.v2.templates[0], size === '70x54' ? '70_54_Labeldesign1_2_22.dymo' : 'Labeldesign1_1.dymo');
    const raw = await observeV1(envelope(FULL, { size, design: '' }));
    assert.equal(raw.template, 'Labeldesign1_1.dymo', 'v1 always opened the 32x57 template here');
  }
  const lowerCase = envelope({ ...FULL, Processor: undefined, processor: 'a15 bionic' }, { size: '32x57', design: '' });
  const r = await expectNoUnexplained(lowerCase, 'processor in lower case');
  assert.equal(r.v2.labels[0].ops.find((op) => op.name === 'TEXT__1').value, 'a15 bionic', 'raw, as sent');
});

test('branch: lab labels at every size and design read the OUTER barcode and title only, whatever barcodefinal holds', async () => {
  for (const size of ['32x57', '70x54', '25x25', undefined, '57x32']) {
    for (const design of ['1', '2', '4', 'repair', '', undefined]) {
      const payload = { type: 'lab', size, design, barcode: '636400', title: 'iphone 15 oled screen', price: '', prints: 3, barcodefinal: { ...FULL, title: 'NOT THIS', barcode: 'NOR THIS', design: design === 'repair' ? 'repair' : undefined } };
      const r = await expectNoUnexplained(payload, `lab ${size} ${design}`);
      assert.equal(r.kind, 'lab');
      assert.deepEqual(r.v2.labels[0].ops, [{ kind: 'text', name: 'BarcodeObject1', value: '636400' }, { kind: 'text', name: 'TextObject12', value: 'iphone 15 oled screen' }]);
      assert.equal(r.v2.templates[0], 'labitemdesign.dymo');
    }
  }
});

test('branch: the 25x25 QR label (every QR design and an unlisted one; the barcode designs 1, 3, 5, 8, 10-13 print the barcode label and a repair label has its own template) forces QRCodeObject2 and prints the short number; v1 pre-edited its XML with a regexp that matches no DYMO Connect template', async () => {
  for (const design of [2, '2', 4, 7, '', undefined, 15, 0, -1, 'x']) {
    const payload = envelope(design === 'repair' ? { ...FULL, design: 'repair' } : FULL, { size: '25x25', design: design === 'repair' ? 'repair' : design });
    const r = await expectNoUnexplained(payload, `25x25 design ${JSON.stringify(design)}`);
    assert.equal(r.kind, 'qr25');
    assert.deepEqual(r.v2.labels[0].ops.map((op) => `${op.kind}:${op.name}`), ['qr:QRCodeObject2', 'text:TextObject2', 'text:TextObject3']);
    assert.equal(r.v2.labels[0].ops[2].value, '**123456');
    assert.equal(r.v2.templates[0], '25_25_qrcode.dymo');
  }
  for (const design of [1, '1', 3, '3']) {
    const r = await expectNoUnexplained(envelope(FULL, { size: '25x25', design }), `25x25 design ${design}`);
    assert.equal(r.kind, 'bc25');
    assert.equal(r.v2.templates[0], '25_25_barcode.dymo');
  }
  // v1's ObjectInfo regexp never matches, so its XML is the template's: the claim the above rests on
  for (const file of ['25_25_qrcode.dymo', 'multipleQRCODE.dymo', '70_54_multipleQRCODE.dymo']) assert.equal(fs.readFileSync(path.join(LABELS_DIR, file), 'utf8').includes('<ObjectInfo'), false, file);
});

test('branch: a repair message prints one label per order item in array order, at 32x57 and 70x54; a lone orderItem, no item at all, and a non-array orderItems behave as in v1', async () => {
  const item = (name, values) => ({ product_name: name, custom_field_value: values.map((value) => ({ value })) });
  const cases = [
    REPAIR(),
    REPAIR({ orderItem: undefined, orderItems: [item('A', ['x', 'y', 'z']), item('B', ['only']), item('C', [])] }),
    REPAIR({ orderItem: undefined, orderItems: [item('A', ['1']), item('B', ['2']), item('C', ['3']), item('D', ['4']), item('E', ['5'])] }),
    REPAIR({ orderItem: undefined }),
    REPAIR({ orderItems: 'not an array' }),
    REPAIR({ orderItems: [null, undefined, REPAIR_ITEM] }),
  ];
  for (const size of ['32x57', '70x54', undefined]) {
    for (const [index, barcodefinal] of cases.entries()) {
      const r = await expectNoUnexplained(envelope(barcodefinal, { size, design: 'repair' }), `repair case ${index} at ${size}`);
      const items = Array.isArray(barcodefinal.orderItems) ? barcodefinal.orderItems : [barcodefinal.orderItem];
      assert.equal(r.v2.labels.length, items.length, `case ${index}: one label per item`);
      assert.equal(r.v2.templates.length, 1);
      assert.equal(r.v2.templates[0], size === '70x54' ? '70_54_LabeldesignRepair.dymo' : 'LabeldesignRepair.dymo');
      assert.deepEqual(r.v2.labels.map((label) => label.ops.find((op) => op.name === 'ItemNameVal').value), items.map((entry) => (entry && entry.product_name) || ''));
    }
  }
});

test('branch: design 2 on sale is label design 7 (sale QR template, QR text written into the XML, was/now/off prices); design 7 sent directly is unlisted', async () => {
  for (const size of ['32x57', '70x54']) {
    const onSale = await expectNoUnexplained(envelope({ ...FULL, isSale: true }, { size, design: 2 }), `${size} design 2 on sale`);
    assert.equal(onSale.kind, 'design7');
    assert.equal(onSale.v2.templates[0], size === '70x54' ? '70_54_Labeldesign3.dymo' : 'Labeldesign3.dymo');
    assert.deepEqual(onSale.v2.labels[0].ops.map((op) => op.name), ['QRCodeObject0', 'ItemNameVal', 'TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1', 'TextObject11', 'TEXT_3', 'TextObject1', 'TextObject9', 'Text_barcode']);
    assert.equal(onSale.v2.labels[0].ops.find((op) => op.name === 'TextObject1').value, `${POUND}50.00 OFF`);
    assert.equal(onSale.v2.labels[0].ops[0].kind, 'qr-embed');
    assert.deepEqual(onSale.v2.labels[0].qr.map((object) => [object.name, object.data, object.holder]), [['QRCodeObject0_<ts>', 'ABCDEFGH123456', 'ABCDEFGH123456']]);
    const direct = await expectNoUnexplained(envelope({ ...FULL, isSale: true }, { size, design: 7 }), `${size} design 7 sent directly`);
    assert.ok(direct.tags.has('(f) design 7 sent directly'));
    const raw = await observeV1(envelope({ ...FULL, isSale: true }, { size, design: 7 }));
    assert.equal(raw.labels.some((label) => label.printed), false, 'v1 never printed a design 7 sent directly');
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Deterministic edge matrices (what a random run reaches only by luck)                                        */
/* ---------------------------------------------------------------------------------------------------------- */

test('matrix: the sale rule (isSale strictly true AND the difference, to 2 decimals, above zero) at the boundaries, for every design that reads it', HEAVY, async () => {
  const pairs = [[100, 99.996], [100, 99.994], [100, 99.995], [100, 99.99], [100, 100], [100, 120], [100, null], [undefined, 5], ['', ''], [10.5, 8]];
  let count = 0;
  for (const size of ['32x57', '70x54']) {
    for (const design of [1, 2, '']) {
      for (const [regular_price, salePrice] of pairs) {
        for (const isSale of [true, 'true']) {
          const payload = envelope({ ...FULL, regular_price, salePrice, isSale }, { size, design });
          const r = await analyse(payload);
          assert.deepEqual(r.unexplained, [], `${size} design ${JSON.stringify(design)} ${JSON.stringify({ regular_price, salePrice, isSale })}`);
          // a sub-penny difference (0.004 -> "0.00") is no sale in v1 and in v2: the ordinary design-1 / design-2 / final-else template
          if (isSale === true && typeof regular_price === 'number' && typeof salePrice === 'number' && regular_price - salePrice > 0 && (regular_price - salePrice).toFixed(2) === '0.00') {
            assert.ok(!r.kind.endsWith('sale') && r.kind !== 'design7', `${r.kind}: a difference of ${regular_price - salePrice} rounds to 0.00 and is no sale`);
          }
          count += 1;
        }
      }
    }
  }
  assert.equal(count, 2 * 3 * pairs.length * 2);
});

test('matrix: Processor ?? processor: an empty, zero or false Processor is a value; null and undefined fall back to processor', async () => {
  for (const Processor of [undefined, null, '', 0, false, 'A15']) {
    for (const processor of [undefined, null, '', 'lower']) {
      for (const design of [1, '']) {
        const r = await expectNoUnexplained(envelope({ ...FULL, Processor, processor }, { size: '32x57', design }), `Processor ${JSON.stringify(Processor)} processor ${JSON.stringify(processor)} design ${JSON.stringify(design)}`);
        const printed = r.v2.labels[0].ops.map((op) => op.value).join('|');
        const wanted = Processor !== undefined && Processor !== null ? String(Processor) : processor === undefined || processor === null ? '' : String(processor);
        if (wanted !== '') assert.ok(printed.toUpperCase().includes(wanted.toUpperCase()), `the label shows ${wanted}`);
      }
    }
  }
});

test('matrix: currency in the envelope, in barcodefinal, in both and in neither, for every kind of label that prints a price', async () => {
  const kinds = [
    { size: '32x57', design: 1 }, { size: '32x57', design: 3 }, { size: '70x54', design: 4 }, { size: '32x57', design: '' },
    { size: '70x54', design: 2, sale: true }, { size: '32x57', design: 1, sale: true }, { size: '25x25', design: 2 },
  ];
  const currencies = [undefined, 'GBP', ' usd ', 'AED', '$', null, 123];
  for (const { sale, ...rest } of kinds) {
    for (const outer of currencies) {
      for (const inner of [undefined, 'SAR']) {
        const bf = { ...FULL, isSale: Boolean(sale), ...(inner === undefined ? {} : { currency: inner }) };
        const payload = envelope(bf, { ...rest, ...(outer === undefined ? {} : { currency: outer }) });
        const r = await analyse(payload);
        assert.deepEqual(r.unexplained, [], `${JSON.stringify(rest)} sale=${sale} outer ${JSON.stringify(outer)} inner ${JSON.stringify(inner)}`);
        const priced = r.v2.labels[0].ops.filter((op) => PRICE_OPS[r.kind].includes(op.name) && op.value !== '');
        assert.ok(priced.length > 0 || r.kind === 'repair', 'the label prints a price');
        const wanted = r.symbol;
        for (const op of priced) assert.ok(op.value.startsWith(wanted), `${op.name} starts with ${JSON.stringify(wanted)}: ${op.value}`);
      }
    }
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Differences that are NOT among (a)-(g): what they are, so the owner can decide                              */
/* ---------------------------------------------------------------------------------------------------------- */

async function bothOn(payload) {
  const v1 = await observeV1(payload);
  const rig = createV2Rig();
  try {
    return { v1, v2: await rig.print(payload) };
  } finally {
    rig.dispose();
  }
}

test('extra 1: a design written as a hex string ("0x2") is design 2 in v1 (parseInt without a radix) and an unlisted design in v2 (parseInt(.., 10)); the web never sends one', async () => {
  const { v1, v2 } = await bothOn(envelope(FULL, { size: '32x57', design: '0x2' }));
  assert.equal(v1.template, 'Labeldesign2.dymo');
  assert.equal(v2.templates[0], 'Labeldesign1_1.dymo');
});

test('extra 2: `type` is compared with == in v1 ("lab" array, String object) and with === in v2; only the string "lab" is ever sent', async () => {
  const { v1, v2 } = await bothOn({ ...envelope(FULL, { size: '32x57', design: '1' }), type: ['lab'] });
  assert.equal(v1.template, 'labitemdesign.dymo', 'v1 chose the lab template for ["lab"] ...');
  assert.equal(v1.labels.some((label) => label.printed), false, '... then filled it as a product label (strict === "lab" failed), which threw');
  assert.equal(v2.templates[0], 'Labeldesign1_1.dymo', 'v2: not a lab label, an ordinary design 1 label');
  assert.equal(v2.result.ok, true);
});

test('extra 3: v2 refuses a repair message with more than 100 order items (INVALID_PAYLOAD, nothing printed); v1 printed every item. SPEC 9.4 does not mention the cap', async () => {
  const items = Array.from({ length: 101 }, (_, index) => ({ product_name: `Item ${index}` }));
  const payload = envelope(REPAIR({ orderItem: undefined, orderItems: items }), { size: '32x57', design: 'repair' });
  const { v1, v2 } = await bothOn(payload);
  assert.equal(v1.labels.filter((label) => label.printed).length, 101);
  assert.equal(v2.result.ok, false);
  assert.equal(v2.result.code, 'INVALID_PAYLOAD');
  assert.equal(v2.labels.length, 0);
  assert.throws(() => buildLabelPlan(payload), LabelPayloadError);
  assert.equal(buildLabelPlan(envelope(REPAIR({ orderItem: undefined, orderItems: items.slice(0, 100) }), { size: '32x57', design: 'repair' })).plans.length, 100, 'exactly 100 is allowed');
});

test('extra 4: a spec value that is only blanks: v1 keeps it as a blank entry in its slot, v2 drops it and the later specs move up (SPEC 9.4 says trim; it does not say a blank entry is no entry)', async () => {
  const { v1, v2 } = await bothOn(envelope({ ...FULL, storage: '   ', conditionObject: { grade: 'New' } }, { size: '32x57', design: 1 }));
  const slot = (labels, name) => labels[0].ops.find((op) => op.name === name).value;
  assert.deepEqual(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((name) => slot(v1.labels, name)), ['NEW', '   ', 'UNLOCKED', '4GB', 'A15']);
  assert.deepEqual(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'].map((name) => slot(v2.labels, name)), ['NEW', 'UNLOCKED', '4GB', 'A15', 'BLUE']);
});

test('extra 5: the printed barcode number (the mask) is made from the CLEANED barcode in v2 and from the raw one in v1 (they differ only for a barcode with blanks or control characters)', async () => {
  const { v1, v2 } = await bothOn(envelope({ ...FULL, barcode: ' AB CD  EF1234 ' }, { size: '32x57', design: 1 }));
  const mask = (labels) => labels[0].ops.find((op) => op.name === 'TextObject1').value;
  assert.equal(mask(v1.labels), `${'*'.repeat(9)}F1234 `, 'v1: 15 raw characters, 9 stars and the last 6 (the last one is a blank)');
  assert.equal(mask(v2.labels), `${'*'.repeat(6)}EF1234`, 'v2: 12 cleaned characters, 6 stars and the last 6');
});

test('extra 6: a barcode ending in an emoji: the last-6 mask cuts the surrogate pair (v1 sends a lone surrogate to the label, v2 removes it)', async () => {
  const { v1, v2 } = await bothOn(envelope({ ...FULL, barcode: 'ABCDEFGH\u{1F600}12345' }, { size: '32x57', design: 1 }));
  const mask = (labels) => labels[0].ops.find((op) => op.name === 'TextObject1').value;
  assert.match(mask(v1.labels), /[\udc00-\udfff]/, 'v1 prints the low half of the emoji');
  assert.doesNotMatch(mask(v2.labels), /[\ud800-\udfff]/u, 'v2 drops the lone half');
  assert.equal(mask(v2.labels).length, mask(v1.labels).length - 1);
  assert.match(v1.labels[0].applied.join(' '), /not well-formed XML/, 'the label v1 sends cannot even be written as well-formed XML (DYMO Connect gets a replacement character)');
  assert.deepEqual(v2.labels[0].applied, []);
});

test('extra 7: numbers where v1 expects text: v1 prints nothing for a numeric RAM or colour (toUpperCase throws, even on lab, design 3, design 4 and 25x25 labels that never print a spec), v2 prints the number', async () => {
  for (const { size, design } of [{ size: '32x57', design: 1 }, { size: '32x57', design: 3 }, { size: '32x57', design: 4 }, { size: '25x25', design: 1 }]) {
    const { v1, v2 } = await bothOn(envelope({ ...FULL, ram: 8 }, { size, design }));
    assert.equal(v1.labels.length, 0, `v1 threw before opening a label (${size} design ${design})`);
    assert.equal(v2.result.ok, true);
  }
  const lab = await bothOn({ type: 'lab', size: '32x57', barcode: '1', title: 'Screen', barcodefinal: { printer: 'dymo', ram: 8 } });
  assert.equal(lab.v1.labels.length, 0);
  assert.equal(lab.v2.result.ok, true);
});

test('extra 8: a numeric warranty has no length in v1 (nothing printed); v2 String()s it first ("1234" prints "1234 WARRANTY")', async () => {
  const { v1, v2 } = await bothOn(envelope({ ...FULL, warranty: 1234 }, { size: '32x57', design: 1 }));
  assert.equal(v1.labels[0].ops.find((op) => op.name === 'TextObject11').value, '');
  assert.equal(v2.labels[0].ops.find((op) => op.name === 'TextObject11').value, '1234 WARRANTY');
});

test('extra 9: design 2 and 7 write the barcode into the label XML: with "&" or "<" in the barcode v1 sent ill-formed XML, the framework refused it and NOTHING printed (silently); v2 prints the exact barcode', async () => {
  for (const barcode of ['A&B', 'A<B>', 'A$&B', 'X"Y\'Z']) {
    const payload = envelope({ ...FULL, barcode }, { size: '32x57', design: 2 });
    const { v1, v2 } = await bothOn(payload);
    const hostile = barcode.includes('&') || barcode.includes('<');
    if (hostile) {
      assert.equal(v1.labels[0].printed, false, `v1 printed nothing for ${barcode}`);
      assert.match(v1.labels[0].error, /XML parse error/);
    }
    assert.equal(v2.result.ok, true);
    assert.deepEqual(v2.labels[0].qr.map((object) => [object.data, object.holder]), [[barcode, barcode]], `v2 carries ${barcode} exactly`);
  }
});

test('templates (DG-1, intended difference to v1.6.1): 70_54_Labeldesign2.dymo is a real non-sale template, so a NON-sale 70x54 design 2 label has no "was", no "OFF" and no strike-through line; the sale label (design 7) keeps all three', async () => {
  const read = (file) => fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');
  assert.notEqual(read('70_54_Labeldesign2.dymo'), read('70_54_Labeldesign3.dymo'), 'the 70x54 pair is a real pair (v1.6.1 shipped the sale template twice)');
  assert.notEqual(read('Labeldesign2.dymo'), read('Labeldesign3.dymo'), 'so is the 32x57 pair');

  // the strike-through rule over the old price is sale artwork: only the sale templates hold it (the framework cannot address a line, so the printed-object list below cannot show it)
  // (the thin divider under the title, LineTitle, is part of every label since 2026-11-20 and is not a strike-through: the strike-through is the object LineObject0)
  const strike = /<LineObject>(?:(?!<\/LineObject>)[\s\S])*?<Name>LineObject0<\/Name>/;
  for (const file of ['Labeldesign2.dymo', '70_54_Labeldesign2.dymo']) assert.doesNotMatch(read(file), strike, `${file}: no strike-through line on a normal label`);
  for (const file of ['Labeldesign3.dymo', '70_54_Labeldesign3.dymo']) assert.match(read(file), strike, `${file}: the sale label keeps its strike-through line`);

  // both harness sides open the same (fixed) file from the labels folder, so v1 and v2 still agree here
  for (const size of ['32x57', '70x54']) {
    const { v1, v2 } = await bothOn(envelope({ ...FULL, isSale: false }, { size, design: 2 }));
    for (const side of [v1, v2]) {
      const document = side.labels[0].objects;
      const printed = document.flatMap((object) => object.texts || []);
      assert.equal(document.some((object) => object.name === 'TextObject9' || object.name === 'TextObject1'), false, `${size}: the sale caption objects are not on a normal label`);
      assert.equal(printed.includes('was') || printed.includes('OFF'), false, `${size}: neither "was" nor "OFF" is printed`);
    }
  }

  // and the sale label still fills both captions with its own text
  for (const size of ['32x57', '70x54']) {
    const { v2 } = await bothOn(envelope({ ...FULL, isSale: true }, { size, design: 2 }));
    const text = (name) => v2.labels[0].objects.find((object) => object.name === name).texts[0];
    assert.equal(text('TextObject9'), `${POUND}499.99`, `${size}: the old price replaces "was"`);
    assert.equal(text('TextObject1'), `${POUND}50.00 OFF`, `${size}: the saving replaces "OFF"`);
  }
});

test('templates (intended difference to v1.6.1, 2026-11-20): the 70x54 design 3 and design 4 files are real 70x54 labels (landscape, label stock StorageS0722440) and no longer byte copies of the 32x57 ones', () => {
  const read = (file) => fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');
  assert.notEqual(read('70_54_mukltipleBarcode.dymo'), read('mukltipleBarcode.dymo'));
  assert.notEqual(read('70_54_multipleQRCODE.dymo'), read('multipleQRCODE.dymo'));
  for (const file of ['70_54_mukltipleBarcode.dymo', '70_54_multipleQRCODE.dymo']) {
    assert.match(read(file), /<LabelName>StorageS0722440/, file);
    assert.match(read(file), /<Orientation>Landscape/, file);
  }
  assert.match(read('mukltipleBarcode.dymo'), /<LabelName>S0722540 multipurpose/, 'the 32x57 file keeps the 32x57 stock');
});

test('the twin is faithful: a payload with nothing to change is its own twin, and the placeholders round-trip every hostile string', () => {
  const clean = envelope(FULL, { size: '32x57', design: 1 });
  const twin = makeTwin(clean);
  assert.equal(twin.tags.size, 0);
  assert.equal(stable(twin.encoded), stable(clean));
  const hostile = 'a"b\\c`d${e}$&<f>\n\r\t\u2028\u2029\u0000\ud800 \udc00\uffffz\u{1F600}';
  const roundTrip = makeTwin(envelope({ ...FULL, misc_color: hostile }, { size: '32x57', design: 1 }));
  assert.notEqual(roundTrip.encoded.barcodefinal.misc_color, hostile);
  assert.doesNotMatch(roundTrip.encoded.barcodefinal.misc_color, /["\\`$&<>\n\r\t\u2028\u2029\u0000\ud800\udc00\uffff]/u);
  assert.equal(kindOf(clean), 'design1');
  assert.equal(ownFinal('  a \n b\t\u0000c  '), 'a b c');
});
