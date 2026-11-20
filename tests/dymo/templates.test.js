'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractObjects, LABELS_DIR } = require('../helpers/vm-dymo');
const { buildLabelPlan, TEMPLATES } = require('../../src/main/printing/dymo/plan');
const fixture = require('../fixtures/templates.json');

const files = fs.readdirSync(LABELS_DIR).filter((file) => file.endsWith('.dymo')).sort();

/* ---------------------------------------------------------------------------------------------------------- */
/* The fixture                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

test('templates.json lists exactly the .dymo files in the labels folder', () => {
  assert.equal(files.length, 25);
  assert.deepEqual(Object.keys(fixture), files);
});

test('templates.json is in step with the label files: every object name and type matches a fresh read of the XML', () => {
  for (const file of files) {
    assert.deepEqual(fixture[file], extractObjects(fs.readFileSync(path.join(LABELS_DIR, file), 'utf8')), file);
  }
});

test('the fixture only holds the object types the framework can address, and every object has a name', () => {
  const types = new Set();
  for (const objects of Object.values(fixture)) {
    for (const object of objects) {
      types.add(object.type);
      assert.ok(object.name.length > 0);
    }
  }
  assert.deepEqual([...types].sort(), ['BarcodeObject', 'QRCodeObject', 'ShapeObject', 'TextObject']);
});

test('every template is a DYMO Connect label (<DYMOLabel>, the format the framework\'s text and QR setters handle) starting with a byte order mark', () => {
  for (const file of files) {
    const xml = fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');
    assert.ok(xml.includes('</DYMOLabel>'), file);
    assert.equal(xml.charCodeAt(0), 0xfeff, `${file} starts with a BOM`);
  }
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Plans against the fixture                                                                                   */
/* ---------------------------------------------------------------------------------------------------------- */

const FIELDS = {
  title: 'iPhone 13',
  barcode: 'ABCDEFGH123456',
  storage: '128GB',
  network: 'Unlocked',
  ram: '4GB',
  misc_color: 'Blue',
  warranty: '12 Months',
  conditionObject: { grade: 'A+' },
  Processor: 'A15',
  price: 499.99,
  salePrice: 449.99,
  regular_price: 499.99,
};

/** Every kind of message the web can send, and the odd ones v1 also accepted. */
function* payloads() {
  for (const size of ['32x57', '70x54', '25x25', undefined, '57x32']) {
    for (const design of [1, '1', 2, '2', 3, 4, 7, 5, '', undefined, 'x', 'repair']) {
      for (const isSale of [false, true]) {
        const barcodefinal = { printer: 'dymo', ...FIELDS, isSale };
        if (design === 'repair') {
          Object.assign(barcodefinal, {
            design: 'repair',
            customer: { name: 'Jo', cell_no: '0700' },
            business: { business_name: 'Shop', branch_name: 'Main' },
            orderDate: '2026-11-19',
            orderItems: [{ product_name: 'A', custom_field_value: [{ value: 'x' }, { value: 'y' }, { value: 'z' }] }, { product_name: 'B' }],
          });
        }
        yield { name: `${size} design ${JSON.stringify(design)} sale=${isSale}`, payload: { size, design, barcodefinal } };
      }
    }
    yield { name: `${size} lab`, payload: { type: 'lab', size, design: '1', barcode: '636400', title: 'Screen', barcodefinal: { printer: 'dymo' } } };
  }
}

const allPlans = [];
for (const { name, payload } of payloads()) {
  for (const plan of buildLabelPlan(payload).plans) allPlans.push({ name, plan });
}

test('the matrix covers sizes, designs, sale, lab and repair', () => {
  assert.ok(allPlans.length >= 130, `${allPlans.length} plans`);
  const kinds = new Set(allPlans.flatMap(({ plan }) => plan.ops.map((op) => op.kind)));
  assert.deepEqual([...kinds].sort(), ['qr', 'qr-embed', 'text']);
});

test('every template a plan names exists as a file and in the fixture', () => {
  for (const { name, plan } of allPlans) {
    assert.ok(files.includes(plan.templateFile), `${name}: ${plan.templateFile}`);
    assert.ok(fixture[plan.templateFile], `${name}: ${plan.templateFile} is in templates.json`);
  }
});

test('every op of every plan names an object that exists in its template', () => {
  for (const { name, plan } of allPlans) {
    const objects = fixture[plan.templateFile];
    for (const op of plan.ops) {
      assert.ok(
        objects.some((object) => object.name === op.name),
        `${name}: ${plan.templateFile} has no object ${op.name} (${op.kind})`
      );
    }
  }
});

test('the object type matches the op: text ops fill text and barcode objects, qr and qr-embed ops fill QR objects, and never the other way round', () => {
  for (const { name, plan } of allPlans) {
    const typeOf = (objectName) => fixture[plan.templateFile].find((object) => object.name === objectName).type;
    for (const op of plan.ops) {
      if (op.kind === 'text') assert.ok(['TextObject', 'BarcodeObject'].includes(typeOf(op.name)), `${name}: text op on a ${typeOf(op.name)} ${op.name}`);
      else assert.equal(typeOf(op.name), 'QRCodeObject', `${name}: ${op.kind} op on ${op.name}`);
    }
  }
});

test('an object name is unique inside each template the plans use (the framework takes the first match)', () => {
  for (const file of new Set(allPlans.map(({ plan }) => plan.templateFile))) {
    const objectNames = fixture[file].map((object) => object.name);
    assert.equal(new Set(objectNames).size, objectNames.length, `${file} repeats an object name`);
  }
});

test('the QR objects the plans write to carry the Data and TextDataHolder structure the QR mechanisms edit', () => {
  for (const file of new Set(allPlans.filter(({ plan }) => plan.ops.some((op) => op.kind !== 'text')).map(({ plan }) => plan.templateFile))) {
    const xml = fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');
    assert.match(xml, /<QRCodeObject>[\s\S]*?<Data>\s*<DataString>[\s\S]*?<\/DataString>\s*<\/Data>/, `${file} has Data/DataString`);
    assert.match(xml, /<QRCodeObject>[\s\S]*?<TextDataHolder>\s*<Value>[\s\S]*?<\/Value>\s*<\/TextDataHolder>/, `${file} has TextDataHolder/Value`);
  }
});

test('the templates the plans can name are the 16 in use; the other 9 files in the folder are spare copies no message reaches', () => {
  const used = new Set(allPlans.map(({ plan }) => plan.templateFile));
  const declared = new Set(
    [TEMPLATES.lab, TEMPLATES.repair, ...Object.values(TEMPLATES['25x25']), ...Object.values(TEMPLATES['32x57']), ...Object.values(TEMPLATES['70x54'])]
  );
  assert.deepEqual([...used].sort(), [...declared].sort(), 'the matrix reaches every declared template and nothing else');
  assert.equal(used.size, 16);
  assert.deepEqual(
    files.filter((file) => !used.has(file)),
    [
      '70_54_Labeldesign1_2_22 - Copy.dymo',
      '70_54_LabeldesignRepair.dymo',
      '70_54_LabeldesignRepair_2.dymo',
      '70_54_Labeldesignqr2.dymo',
      'Labeldesign1_2_22.dymo',
      'Labeldesign_1_2.dymo',
      'Labeldesignqr2.dymo',
      'qr.dymo',
      'test.dymo',
    ]
  );
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Sale artwork stays on the sale templates (DG-1)                                                             */
/* ---------------------------------------------------------------------------------------------------------- */

const readTemplate = (file) => fs.readFileSync(path.join(LABELS_DIR, file), 'utf8');

test('every object of a design 2 template (non-sale and sale, both sizes) is filled by its plan: an object the plan skips would print the text it was drawn with', () => {
  for (const size of ['32x57', '70x54']) {
    for (const isSale of [false, true]) {
      const { plans } = buildLabelPlan({ size, design: 2, barcodefinal: { printer: 'dymo', ...FIELDS, isSale } });
      const [plan] = plans;
      assert.equal(plan.templateFile, isSale ? TEMPLATES[size].design2Sale : TEMPLATES[size].design2, `${size} sale=${isSale}`);
      const filled = new Set(plan.ops.map((op) => op.name));
      const skipped = fixture[plan.templateFile].map((object) => object.name).filter((name) => !filled.has(name));
      assert.deepEqual(skipped, [], `${size} sale=${isSale}: ${plan.templateFile} keeps its own text for ${skipped.join(', ')}`);
    }
  }
});

test('the "was" and "OFF" captions and the strike-through line belong to the sale design 2 templates only: a normal 70x54 label no longer prints them (DG-1)', () => {
  for (const size of ['32x57', '70x54']) {
    const normal = TEMPLATES[size].design2;
    const sale = TEMPLATES[size].design2Sale;
    assert.notEqual(readTemplate(normal), readTemplate(sale), `${size}: the pair is a real pair (v1.6.1 shipped the 70x54 sale template twice)`);
    assert.doesNotMatch(readTemplate(normal), /<LineObject>/, `${normal}: no strike-through line on a normal label`);
    assert.match(readTemplate(sale), /<LineObject>/, `${sale}: the sale label keeps its strike-through line`);
    const captions = (file) => fixture[file].map((object) => object.name).filter((name) => name === 'TextObject1' || name === 'TextObject9');
    assert.deepEqual(captions(normal), [], `${normal}: no caption objects`);
    assert.deepEqual(captions(sale), ['TextObject1', 'TextObject9'], `${sale}: the old price and the saving`);
  }
});
