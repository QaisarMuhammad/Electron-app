'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createErrorBoxes, COALESCE_WINDOW_MS, HEADINGS } = require('../../src/main/errorBoxes');

/** A dialog whose boxes stay open until `answer()` is called, so "still open" can be tested. */
function setup({ withWindow = false } = {}) {
  const shown = [];
  const waiting = [];
  const dialog = {
    showMessageBox(...args) {
      const [window, options] = args.length === 1 ? [null, args[0]] : args;
      shown.push({ window, options });
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
  const clock = { time: 1000 };
  const window = withWindow ? { isDestroyed: () => false } : null;
  const boxes = createErrorBoxes({ dialog, getWindow: () => window, now: () => clock.time });
  return {
    boxes, clock, shown, window,
    answer: () => waiting.shift()({ response: 0 }),
  };
}

const failure = (code, message = `message of ${code}`) => ({ ok: false, code, message });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a failure opens a native error box with the heading of the job and the plain-English message', () => {
  const { boxes, shown } = setup();
  assert.equal(boxes.show(failure('SPOOLER_ERROR', 'The computer could not send the job to the printer.'), { kind: 'receipt' }), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.type, 'error');
  assert.equal(shown[0].options.message, 'The receipt could not be printed');
  assert.equal(shown[0].options.detail, 'The computer could not send the job to the printer.');
  assert.deepEqual(shown[0].options.buttons, ['OK']);
  assert.equal(HEADINGS.label, 'The label could not be printed');
  assert.equal(HEADINGS.drawer, 'The cash drawer did not open');
});

test('a success, nothing at all and a Result that is not a failure never show a box', () => {
  const { boxes, shown } = setup();
  assert.equal(boxes.show({ ok: true }), false);
  assert.equal(boxes.show({ ok: true, details: { prompted: true } }), false);
  assert.equal(boxes.show(undefined), false);
  assert.equal(boxes.show(null), false);
  assert.equal(boxes.show({}), false);
  assert.equal(shown.length, 0);
});

test('ONE box per error code per 5 seconds: twenty failed labels on a printer that is off open one box', async () => {
  const { boxes, clock, shown, answer } = setup();
  for (let i = 0; i < 20; i += 1) boxes.show(failure('PRINTER_NOT_FOUND'), { kind: 'label' });
  assert.equal(shown.length, 1);
  answer();
  await tick();
  clock.time += COALESCE_WINDOW_MS - 1;
  assert.equal(boxes.show(failure('PRINTER_NOT_FOUND'), { kind: 'label' }), false, 'dismissed, but still inside the 5 seconds');
  clock.time += 1;
  assert.equal(boxes.show(failure('PRINTER_NOT_FOUND'), { kind: 'label' }), true, 'after 5 seconds a new box may open');
  assert.equal(shown.length, 2);
});

test('a box that is still open for a code suppresses every further box for that code, however long it stays', () => {
  const { boxes, clock, shown } = setup();
  boxes.show(failure('NO_PRINTER_CONFIGURED'));
  clock.time += 60_000;
  assert.equal(boxes.show(failure('NO_PRINTER_CONFIGURED')), false);
  assert.equal(shown.length, 1);
});

test('different error codes do not suppress each other', () => {
  const { boxes, shown } = setup();
  assert.equal(boxes.show(failure('PRINTER_NOT_FOUND')), true);
  assert.equal(boxes.show(failure('DRAWER_FAILED')), true);
  assert.equal(boxes.show(failure('NO_PRINTER_CONFIGURED')), true);
  assert.equal(shown.length, 3);
});

test('a Result without a code counts as UNKNOWN and still opens one box', () => {
  const { boxes, shown } = setup();
  assert.equal(boxes.show({ ok: false }), true);
  assert.equal(boxes.show({ ok: false, code: '' }), false);
  assert.equal(shown[0].options.detail, 'Please try again.');
});

test('the box belongs to the main window when there is one, and stands alone when there is not', () => {
  const withWindow = setup({ withWindow: true });
  withWindow.boxes.show(failure('SPOOLER_ERROR'));
  assert.equal(withWindow.shown[0].window, withWindow.window);
  const alone = setup();
  alone.boxes.show(failure('SPOOLER_ERROR'));
  assert.equal(alone.shown[0].window, null);
});

test('a dialog that fails does not break the caller and does not lock the code out', () => {
  const warned = [];
  const clock = { time: 0 };
  let broken = true;
  const dialog = { showMessageBox: () => { if (broken) throw new Error('no display'); return new Promise(() => {}); } };
  const boxes = createErrorBoxes({ dialog, now: () => clock.time, log: { warn: (text) => warned.push(text) } });
  assert.equal(boxes.show(failure('SPOOLER_ERROR')), false);
  assert.match(warned[0], /no display/);
  broken = false;
  clock.time += COALESCE_WINDOW_MS;
  assert.equal(boxes.show(failure('SPOOLER_ERROR')), true);
});
