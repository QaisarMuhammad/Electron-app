'use strict';

/**
 * SECURITY lens, payload size limits (SPEC 12). The limits exist on paper ("a label text longer than 2 KB is truncated", the
 * receipt is capped at 5 MB, the password has 4..64 characters), but for label text and for the password a caller hands in, the work
 * is done on the WHOLE string first and the limit is applied to the result. Everything runs synchronously in the Electron MAIN
 * process, so one hostile (or runaway) page call freezes printing, the drawer, every window event and every other page's
 * synchronous IPC for as long as it likes. Measured in the real app (tests/verify/security-e2e.js V3): a 24 MB title stalls the main
 * process for 3.2 s and the label still "prints" `{ ok: true }`; a loop of such calls keeps it frozen.
 *
 * The time limits below are far above what a correct implementation needs (a pre-slice or an early length check costs about a
 * millisecond) and far below what the current code takes on any development machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLabelPlan } = require('../../src/main/printing/dymo/plan');
const { hashPassword, verifyPassword } = require('../../src/main/password');

const LIMIT_MS = 250;
const FOUR_MB = 4 * 1024 * 1024;
const EIGHT_MB = 8 * 1024 * 1024;

/** Runs `fn` and returns how long it took, in milliseconds. */
function timed(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const dymo = (barcodefinal, extra = {}) => ({ size: '32x57', design: '1', barcodefinal: { printer: 'dymo', barcode: '1', ...barcodefinal }, ...extra });

test('label text: an 8 MB title costs no more than a normal one (the 2 KB cut is applied before the cleaning, not after)', () => {
  const title = 'a b\n'.repeat(EIGHT_MB / 4);
  let plan;
  const ms = timed(() => { plan = buildLabelPlan(dymo({ title })); });
  assert.equal(plan.plans[0].ops[0].value.length, 2048, 'the value itself is cut to 2 KB, as SPEC 12 says');
  assert.ok(ms < LIMIT_MS, `buildLabelPlan took ${ms.toFixed(0)} ms for an 8 MB title: the whole string is cleaned (five regexp passes) before it is cut to 2 KB`);
});

test('label text: the same holds for every other field the plan reads (warranty, price, processor, repair order item, lab title)', () => {
  const big = 'x y\n'.repeat(FOUR_MB / 4);
  const digits = '1'.repeat(FOUR_MB);
  const cases = {
    warranty: dymo({ title: 't', warranty: big }),
    'numeric price': dymo({ title: 't', price: digits }),
    processor: dymo({ title: 't', Processor: big }),
    'repair item': dymo({ design: 'repair', orderItems: [{ product_name: big }], customer: {}, business: {} }, { design: 'x' }),
    'lab title': { type: 'lab', barcode: '1', title: big, barcodefinal: { printer: 'dymo' } },
  };
  const slow = [];
  for (const [name, payload] of Object.entries(cases)) {
    const ms = timed(() => buildLabelPlan(payload));
    if (ms >= LIMIT_MS) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, [], `buildLabelPlan must not take ${LIMIT_MS} ms or more for a 4 MB value in any field`);
});

test('drawer password: a huge candidate is refused without hashing all of it', () => {
  const record = hashPassword('1234');
  const candidate = 'x'.repeat(64 * 1024 * 1024);
  let accepted;
  const ms = timed(() => { accepted = verifyPassword(candidate, record); });
  assert.equal(accepted, false);
  assert.ok(ms < LIMIT_MS, `verifyPassword took ${ms.toFixed(0)} ms for a 64 MB candidate (a policy password has at most 64 characters; the web page can send any size to open-drawer)`);
});
