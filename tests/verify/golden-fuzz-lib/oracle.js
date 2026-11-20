'use strict';

/**
 * The comparison oracle of the golden fuzz (lens "dymo-golden"): how a v1 observation is turned into what v2 is EXPECTED to do, and
 * how the two are compared. Written from SPEC 9.4/9.4a and from reading v1's source (tests/fixtures/legacy-index.js lines 1041-1790),
 * not from the v2 sources: `src/main/printing/labelText.js`, `plan.js` and `currency.js` are never imported here for the expectation.
 *
 * Method (the "twin"):
 *   1. v1 is run on a TWIN of the payload: the same data with every deliberate difference of SPEC 9.4 pre-applied from the SPEC text,
 *      so that v1 behaves as a pure function of the data:
 *        (b) `Processor` takes the value of `Processor ?? processor`;
 *        (d) text values are cleaned like the SPEC says (line breaks and tabs to a space, control characters removed, runs of spaces
 *            collapsed, trimmed) and every character that would break v1's script or XML (" \ ` $ & < > line breaks, control characters,
 *            lone surrogates ...) is swapped for a private-use placeholder that survives v1 untouched, then swapped back in its output;
 *        9.4a  non-string text values are String()-coerced (v1 throws on `.toUpperCase()` / `.slice()` of a number);
 *        (e)/(f) an unlisted design (and a directly sent design 7) at 32x57 / 70x54: on sale it is design 1 (v1 prints nothing for it);
 *   2. what v1 printed for the twin is adjusted for the differences that cannot be pre-applied: (a) the currency symbol, (c) the missing
 *      "GRADE " entry, the 70x54 template of an unlisted design, `£null`, and the final clean + 2 KB cut of every value;
 *   3. the adjusted v1 result must equal v2's result EXACTLY (template, printer, ordered ops, QR objects, label count). Anything else is
 *      an UNEXPLAINED difference.
 * A payload on which none of the rules applies must in addition be identical before any adjustment (pure parity).
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRealDymo, summarizeLabels, LABELS_DIR } = require('./real-dymo');
const { runLegacyHandler } = require('./legacy-v1');

/** The source tree under test. GOLDEN_FUZZ_SRC points the harness at a mutated copy of src/ (used to prove the harness catches planted bugs). */
const SRC_ROOT = process.env.GOLDEN_FUZZ_SRC ? path.resolve(process.env.GOLDEN_FUZZ_SRC) : path.resolve(__dirname, '..', '..', '..', 'src');
const { createDymoService } = require(path.join(SRC_ROOT, 'main', 'printing', 'dymo'));

const POUND = '\u00a3';

/* ---------------------------------------------------------------------------------------------------------- */
/* SPEC 9.4 text cleanup, written from the SPEC sentence                                                       */
/* ---------------------------------------------------------------------------------------------------------- */

/** "normalise CR/LF/TAB/U+2028/U+2029 to a single space, collapse runs of spaces, trim, remove NUL/control chars" (+ what XML cannot hold). */
function ownClean(value) {
  return String(value)
    .replace(/[\r\n\t\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\ufdd0-\ufdef\ufffe\uffff]/g, '')
    .replace(/\p{Noncharacter_Code_Point}/gu, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
    .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** "A label text longer than 2 KB is truncated to 2 KB": at most 2048 UTF-8 bytes, cut between characters. */
function ownTruncate(text, limit = 2048) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) break;
    out += character;
    bytes += size;
  }
  return out;
}

const ownFinal = (value) => ownTruncate(ownClean(value));

/** SPEC 9.4 (a): `GBP` and anything that is not a three-letter code is the pound sign, every other code is the code and one space. */
function ownSymbol(iso) {
  const code = typeof iso === 'string' ? iso.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) && code !== 'GBP' ? `${code} ` : POUND;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Placeholders                                                                                                */
/* ---------------------------------------------------------------------------------------------------------- */

const SPECIAL = /["\\`$&<>\u0000-\u001f\u007f-\u009f\u2028\u2029\ufdd0-\ufdef\ufffe\uffff]|\p{Noncharacter_Code_Point}/u;

/** Swaps every character that breaks v1 for one private-use character each (and back). Single code units, so lengths never change. */
function createPlaceholders() {
  const forward = new Map();
  const backward = new Map();
  let next = 0xe000;
  const allocate = (character) => {
    if (!forward.has(character)) {
      const placeholder = String.fromCharCode(next);
      next += 1;
      forward.set(character, placeholder);
      backward.set(placeholder, character);
    }
    return forward.get(character);
  };
  return {
    encode(text) {
      let out = '';
      for (const character of text) {
        const lone = character.length === 1 && character >= '\ud800' && character <= '\udfff';
        out += lone || SPECIAL.test(character) ? allocate(character) : character;
      }
      return out;
    },
    decode(text) {
      return typeof text === 'string' ? text.replace(/[\ue000-\uf8ff]/g, (placeholder) => (backward.has(placeholder) ? backward.get(placeholder) : placeholder)) : text;
    },
    used: () => forward.size,
  };
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, fn)]));
  return value;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* v1 facts (read from the v1 source)                                                                          */
/* ---------------------------------------------------------------------------------------------------------- */

/** v1: `isSale === true && (regular_price - salePrice) > 0`, then `off > 0` on the toFixed(2) string. */
function v1IsSale(bf) {
  const off = bf.isSale === true && bf.regular_price - bf.salePrice > 0 ? parseFloat(bf.regular_price - bf.salePrice).toFixed(2) : 0;
  return bf.isSale === true && off > 0;
}

/** The kind of label v2 is expected to print, from the (twin) payload. */
function kindOf(p) {
  const bf = p.barcodefinal;
  if (p.type === 'lab') return 'lab';
  const size = p.size === '25x25' || p.size === '70x54' ? p.size : '32x57';
  const design = bf.design === 'repair' ? 'repair' : parseInt(p.design);
  if (size === '25x25') return design === 1 || design === 3 ? 'bc25' : 'qr25';
  if (design === 'repair') return 'repair';
  const sale = v1IsSale(bf);
  if (design === 4) return 'design4';
  if (design === 3) return 'design3';
  if (design === 2) return sale ? 'design7' : 'design2';
  if (design === 1) return sale ? 'design1sale' : 'design1';
  return sale ? 'defaultSale' : 'default';
}

/** How many of the five spec slots (TEXT_4, TEXT, TEXT_1, TEXT_5, TEXT__1) carry specs, per kind (v1 lines 1678-1777, 1584-1675, 1489-1583). */
const SPEC_SLOT_COUNT = { design1: 5, design1sale: 4, design2: 5, design7: 5, default: 4, defaultSale: 4, design3: 0, design4: 0, bc25: 0, qr25: 0, lab: 0, repair: 0 };
const SPEC_SLOT_NAMES = ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1'];

/** The ops that start with the currency symbol (`£${...}` in v1), per kind. */
const PRICE_OPS = {
  design1: ['TEXT_3'],
  design1sale: ['TEXT_3', 'TEXT__1', 'Text_was'],
  default: ['TEXT_3'],
  defaultSale: ['TEXT_3', 'TEXT__1', 'Text_was'],
  design2: ['TEXT_3'],
  design7: ['TEXT_3', 'TextObject1', 'TextObject9'],
  design3: ['TextObject1', 'TextObject12'],
  design4: ['TextObject12', 'TextObject1', 'TextObject2'],
  bc25: ['TextObject1'],
  qr25: ['TextObject2'],
  lab: [],
  repair: [],
};

/* ---------------------------------------------------------------------------------------------------------- */
/* The twin                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------- */

const TEXT_FIELDS_CLEANED = ['title', 'barcode', 'storage', 'network', 'ram', 'misc_color', 'Processor'];
const SPEC_FIELDS = ['storage', 'network', 'ram', 'Processor', 'misc_color'];
const PRICE_FIELDS = ['price', 'salePrice', 'regular_price'];

/**
 * @param {object} original the payload as the web sends it
 * @returns {{ readable: object, encoded: object, tags: Set<string>, placeholders: ReturnType<typeof createPlaceholders> }}
 *   `readable` has the real characters, `encoded` the placeholders (what v1 is run on)
 */
function makeTwin(original) {
  const tags = new Set();
  const twin = structuredClone(original);
  const bf = twin.barcodefinal;
  const size = twin.size === '25x25' || twin.size === '70x54' ? twin.size : '32x57';

  // (b) Processor ?? processor (v1 reads only `Processor`)
  if (bf.Processor === undefined || bf.Processor === null) {
    const lower = bf.processor;
    if (lower !== undefined && lower !== null) {
      bf.Processor = lower;
      tags.add('(b) processor key');
    }
  }

  // 9.4a: v1 builds its spec list BEFORE it looks at the label kind, and calls toUpperCase() on every truthy entry: a number, a boolean, an
  // array or an object in any of these fields makes v1 throw, and nothing prints, even for lab, repair, design 3, design 4 and 25x25 labels
  // that never print a spec. v2 coerces with String() and never reads a spec it does not print.
  for (const key of SPEC_FIELDS) {
    const value = bf[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      bf[key] = String(value);
      tags.add('9.4a coercion');
    }
  }

  if (twin.type === 'lab') {
    // v1 prints the words "undefined" and "null" for a missing lab barcode or title; v2 prints nothing (SPEC 9.4a)
    for (const key of ['barcode', 'title']) {
      if (twin[key] === undefined || twin[key] === null) {
        twin[key] = '';
        tags.add('9.4a nullish text');
      }
    }
  } else {
    // at 25x25 a repair design prints the 25x25 QR label like any design, not the repair loop
    const isRepair = bf.design === 'repair' && size !== '25x25';
    // v1 calls barcode.replace() in the repair loop and barcode.length/.slice() in the mask: a number throws
    if (bf.barcode !== undefined && bf.barcode !== null && typeof bf.barcode !== 'string') {
      bf.barcode = String(bf.barcode);
      tags.add('9.4a coercion');
    }
    if (!isRepair) {
      // `warranty?.length > 3` is undefined for a number, so v1 printed no warranty; v2 coerces first (SPEC 9.4a)
      if (bf.warranty !== undefined && bf.warranty !== null && typeof bf.warranty !== 'string') {
        bf.warranty = String(bf.warranty);
        tags.add('9.4a coercion');
      }
      // (d) the text is cleaned before v1 decides what to print (a blank spec entry is no entry; the barcode mask is of the cleaned barcode)
      for (const key of TEXT_FIELDS_CLEANED) {
        if (typeof bf[key] === 'string' && ownClean(bf[key]) !== bf[key]) {
          bf[key] = ownClean(bf[key]);
          tags.add('(d) cleaned text');
        }
      }
      // the price text is cleaned too, but only where that cannot change a decision made on the raw text (positive price, sale)
      for (const key of PRICE_FIELDS) {
        const value = bf[key];
        if (typeof value === 'string' && ownClean(value) !== value) {
          const cleaned = ownClean(value);
          if (Object.is(Number(cleaned), Number(value))) {
            bf[key] = cleaned;
            tags.add('(d) cleaned text');
          }
        }
      }
      // (e) and the design 7 clarification: an unlisted design at 32x57 / 70x54
      if (size !== '25x25') {
        let design = parseInt(twin.design);
        if (design === 7) {
          twin.design = '';
          design = NaN;
          tags.add('(f) design 7 sent directly');
        }
        if (![1, 2, 3, 4].includes(design)) {
          if (v1IsSale(bf)) {
            twin.design = 1;
            tags.add('(e) unlisted design on sale');
          } else if (size === '70x54') {
            tags.add('(e) unlisted design at 70x54');
          }
        }
      }
    }
  }

  const placeholders = createPlaceholders();
  const encoded = mapStrings(twin, placeholders.encode);
  if (placeholders.used() > 0) tags.add('(d) hostile characters');
  return { readable: twin, encoded, tags, placeholders };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Rigs: run v1 and v2 on the real framework                                                                   */
/* ---------------------------------------------------------------------------------------------------------- */

/** A BrowserWindow stand-in (written for this harness, not the one in tests/helpers) whose page is the real framework. */
class PageWindow extends EventEmitter {
  constructor(dymo) {
    super();
    this.dymo = dymo;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = (code) => (this.destroyed ? Promise.reject(new Error('Object has been destroyed')) : dymo.executeJavaScript(code));
    this.webContents.isDestroyed = () => this.destroyed;
  }

  loadFile() {
    return new Promise((resolve) => {
      setImmediate(() => {
        if (!this.destroyed) this.webContents.emit('did-finish-load');
        resolve();
      });
    });
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

/** A DYMO service (the real code) on the real framework. One rig = one page = one framework instance. */
function createV2Rig({ nativeQrSetter, printers, config } = {}) {
  const dymo = createRealDymo({ nativeQrSetter, printers });
  const reads = [];
  const windows = [];
  const service = createDymoService({
    createHiddenWindow: () => {
      const win = new PageWindow(dymo);
      windows.push(win);
      return win;
    },
    labelsDir: LABELS_DIR,
    readFile: (file, encoding) => {
      reads.push(path.basename(file));
      return fs.promises.readFile(file, encoding);
    },
    getConfig: () => config || {},
    log: {},
  });
  return {
    dymo,
    service,
    windows,
    /** Prints one message and reports what the framework saw. */
    async print(payload) {
      dymo.takeCalls();
      reads.length = 0;
      const result = await service.print(structuredClone(payload));
      return { result, labels: summarizeLabels(dymo.takeCalls()), templates: [...new Set(reads)] };
    },
    dispose: () => service.dispose(),
  };
}

/** v1 (the real listener) on the real framework. */
async function observeV1(payload, { nativeQrSetter } = {}) {
  const dymo = createRealDymo({ nativeQrSetter });
  const run = await runLegacyHandler(payload, (code) => dymo.executeJavaScript(code));
  return { ...run, labels: summarizeLabels(dymo.takeCalls()) };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Adjusting v1 and comparing                                                                                  */
/* ---------------------------------------------------------------------------------------------------------- */

const normalName = (name) => name.replace(/_\d+$/, '_<ts>');

/** The comparison shape of one label: what is observable, with the QR rename suffix normalised. */
function shapeOf(label, templateFile) {
  return {
    template: templateFile,
    printed: label.printed,
    printer: label.printer,
    params: label.params,
    ops: label.ops.map((op) => ({ kind: op.kind, name: op.name, value: op.value })),
    qr: label.qr.map((object) => ({ name: normalName(object.name), data: object.data, holder: object.holder, renderCache: object.renderCache })),
  };
}

/**
 * What v1 printed for the twin, turned into what v2 must print (the adjustments that cannot be pre-applied to the data).
 * @returns {{ labels: object[], tags: Set<string>, problems: string[] }}
 */
function adjustV1(v1, twin, original) {
  const tags = new Set();
  const problems = [];
  const readable = twin.readable;
  const decode = (text) => twin.placeholders.decode(text);
  const kind = kindOf(readable);
  const bf = readable.barcodefinal;

  // (a) the currency symbol (SPEC: `payload.currency ?? bf.currency`)
  const symbol = ownSymbol(original.currency ?? (original.barcodefinal && original.barcodefinal.currency));
  const priceOps = new Set(PRICE_OPS[kind] || []);

  // (c) an empty condition prints no "GRADE " entry: the spec entries v2 must print instead
  const grade = bf && bf.conditionObject ? bf.conditionObject.grade : undefined;
  const gradeEmpty = (grade === undefined || grade === null ? '' : String(grade)).trim() === '';
  const specCount = SPEC_SLOT_COUNT[kind] || 0;
  let v2Entries = null;
  if (specCount > 0 && gradeEmpty) {
    v2Entries = SPEC_FIELDS.map((key) => (bf[key] === undefined || bf[key] === null ? '' : String(bf[key])))
      .filter((entry) => entry !== '')
      .map((entry) => ownFinal(entry.toUpperCase()));
  }

  const labels = v1.labels.map((label) => {
    const shaped = shapeOf(label, v1.template);
    const ops = shaped.ops.map((op) => {
      let value = decode(op.value);
      if (value === `${POUND}null`) {
        value = POUND; // v1 printed the word "null" for a null price (SPEC 9.4a)
        tags.add('9.4a nullish text');
      }
      if (priceOps.has(op.name) && value.startsWith(POUND) && symbol !== POUND) {
        value = symbol + value.slice(1);
        tags.add('(a) currency symbol');
      }
      const final = ownFinal(value);
      if (final !== value) tags.add('(d) cleaned or cut value');
      return { ...op, value: final };
    });

    if (v2Entries) {
      // v1: slot 0 is the bare "GRADE" entry and the entries follow it; v2: no GRADE entry, so the entries move up
      const slots = SPEC_SLOT_NAMES.slice(0, specCount);
      const seen = slots.map((name) => ops.find((op) => op.name === name));
      if (seen.some((op) => !op)) problems.push(`v1 did not write every spec slot (${slots.join(', ')})`);
      else {
        if (seen[0].value !== 'GRADE') problems.push(`oracle: v1 slot 0 holds ${JSON.stringify(seen[0].value)}, expected a bare GRADE entry`);
        for (let index = 1; index < slots.length; index += 1) {
          const wanted = v2Entries[index - 1] || '';
          if (seen[index].value !== wanted) problems.push(`oracle: v1 slot ${slots[index]} holds ${JSON.stringify(seen[index].value)}, the oracle's entry is ${JSON.stringify(wanted)}`);
        }
        slots.forEach((name, index) => {
          seen[index].value = v2Entries[index] || '';
        });
        tags.add('(c) empty condition');
      }
    }

    const qr = shaped.qr.map((object) => ({ ...object, data: object.data === null ? null : ownFinal(decode(object.data)), holder: object.holder === null ? null : ownFinal(decode(object.holder)) }));

    // (e) v1 opened the 32x57 template for an unlisted design at 70x54: v2 opens the 70x54 design-1 template
    let template = shaped.template;
    if (kind === 'default' && (readable.size === '70x54') && template === 'Labeldesign1_1.dymo') {
      template = '70_54_Labeldesign1_2_22.dymo';
    }
    return { ...shaped, template, ops, qr };
  });

  return { labels, tags, problems, kind, symbol };
}

/** Compares two label lists and returns every difference as a readable line. */
function diffLabels(expected, actual, where) {
  const out = [];
  if (expected.length !== actual.length) {
    out.push(`${where}: ${expected.length} label(s) expected from v1, v2 printed ${actual.length}`);
    return out;
  }
  expected.forEach((want, index) => {
    const got = actual[index];
    const at = `${where} label ${index}`;
    for (const key of ['template', 'printed', 'printer', 'params']) {
      if (want[key] !== got[key]) out.push(`${at}: ${key} expected ${JSON.stringify(want[key])}, got ${JSON.stringify(got[key])}`);
    }
    const length = Math.max(want.ops.length, got.ops.length);
    for (let i = 0; i < length; i += 1) {
      const a = want.ops[i];
      const b = got.ops[i];
      if (!a || !b || a.kind !== b.kind || a.name !== b.name || a.value !== b.value) {
        out.push(`${at} op ${i}: expected ${a ? `${a.kind} ${a.name}=${JSON.stringify(a.value)}` : '(none)'}, got ${b ? `${b.kind} ${b.name}=${JSON.stringify(b.value)}` : '(none)'}`);
      }
    }
    const qrLength = Math.max(want.qr.length, got.qr.length);
    for (let i = 0; i < qrLength; i += 1) {
      const a = want.qr[i];
      const b = got.qr[i];
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${at} QR object ${i}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
    }
  });
  return out;
}

/**
 * Compares what v1 (run on the payload's twin) and v2 (run on the payload as sent) did, and says what differs beyond the deliberate differences.
 * Pure: it works on observations, so the same judgement serves the vm harness and the real-Chromium run (golden-fuzz-electron.js).
 *
 * @param {object} payload the payload as the web sends it
 * @param {ReturnType<typeof makeTwin>} twin
 * @param {{ labels: object[], template: (string|null), handlerError: (string|null) }} v1 observation of v1 on `twin.encoded`
 * @param {{ result: object, labels: object[], templates: string[] }} v2 observation of the v2 service on `payload`
 */
function evaluate(payload, twin, v1, v2) {
  const expected = adjustV1(v1, twin, payload);
  const tags = new Set([...twin.tags, ...expected.tags]);
  const unexplained = [...expected.problems];

  // v1 itself must have printed everything it opened (the twin is built so that it can)
  const v1Failed = v1.labels.some((label) => !label.printed) || v1.handlerError;
  const v2Result = v2.result;

  if (v2Result.ok !== true) {
    // (g): a repair message with an empty orderItems list prints nothing in v1 and is INVALID_PAYLOAD in v2
    const bf = payload.barcodefinal;
    const emptyRepair = bf.design === 'repair' && Array.isArray(bf.orderItems) && bf.orderItems.length === 0 && payload.type !== 'lab' && payload.size !== '25x25';
    if (emptyRepair && v2Result.code === 'INVALID_PAYLOAD' && v1.labels.length === 0) tags.add('(g) repair without items');
    else unexplained.push(`v2 failed (${v2Result.code}) but the payload is not a repair message without items; v1 opened ${v1.labels.length} label(s)`);
  } else if (v1Failed) {
    unexplained.push(`v1 did not print the twin (${v1.handlerError || v1.labels.map((l) => l.error).find(Boolean) || 'a label was opened but never printed'}) while v2 printed`);
  } else {
    unexplained.push(...diffLabels(expected.labels, v2.labels.map((label) => shapeOf(label, v2.templates[0])), 'v2 vs adjusted v1'));
    if (v2.templates.length !== 1 || v2.templates[0] !== expected.labels[0]?.template) unexplained.push(`template: v1 ${expected.labels[0]?.template}, v2 ${JSON.stringify(v2.templates)}`);
    for (const label of v2.labels) for (const problem of label.applied) unexplained.push(`v2 label document: ${problem}`);
    for (const label of v1.labels) for (const problem of label.applied) unexplained.push(`v1 label document: ${problem}`);
  }

  // a payload to which no rule applied must be identical BEFORE any adjustment: pure parity
  const noRule = tags.size === 0;
  if (noRule && v2Result.ok === true && !v1Failed) {
    const raw = v1.labels.map((label) => shapeOf(label, v1.template));
    unexplained.push(...diffLabels(raw, v2.labels.map((label) => shapeOf(label, v2.templates[0])), 'pure parity (no rule applies)'));
  }

  return { tags, unexplained, kind: expected.kind, symbol: expected.symbol, twin, v1, v2, expected };
}

/**
 * Runs one payload through v1 (on the twin) and v2 (as sent) on the real framework in a vm, and judges the result.
 *
 * @param {object} payload
 * @param {{ nativeQrSetter?: boolean, v2Rig?: ReturnType<typeof createV2Rig> }} [options]
 */
async function analyse(payload, options = {}) {
  const twin = makeTwin(payload);
  const v1 = await observeV1(twin.encoded, { nativeQrSetter: options.nativeQrSetter });
  const rig = options.v2Rig || createV2Rig({ nativeQrSetter: options.nativeQrSetter });
  const v2 = await rig.print(payload);
  if (!options.v2Rig) rig.dispose();
  return evaluate(payload, twin, v1, v2);
}

module.exports = {
  POUND,
  ownClean,
  ownTruncate,
  ownFinal,
  ownSymbol,
  createPlaceholders,
  makeTwin,
  kindOf,
  v1IsSale,
  SPEC_SLOT_COUNT,
  SPEC_SLOT_NAMES,
  PRICE_OPS,
  PageWindow,
  createV2Rig,
  observeV1,
  shapeOf,
  adjustV1,
  diffLabels,
  evaluate,
  analyse,
};
