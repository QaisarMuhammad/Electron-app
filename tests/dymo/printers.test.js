'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickDymoPrinter } = require('../../src/main/printing/dymo/printers');

const writer450 = { name: 'DYMO LabelWriter 450', modelName: 'DYMO LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true };
const turbo = { name: 'DYMO LabelWriter 450 Turbo', modelName: 'DYMO LabelWriter 450 Turbo', printerType: 'LabelWriterPrinter', isConnected: true };
const fourXL = { name: 'DYMO LabelWriter 4XL', modelName: 'DYMO LabelWriter 4XL', printerType: 'LabelWriterPrinter', isConnected: false };
const tape = { name: 'DYMO LabelManager PnP', modelName: 'DYMO LabelManager PnP', printerType: 'TapePrinter', isConnected: true };

test('no printers: no printer and the reason "none"', () => {
  for (const list of [[], null, undefined, 'x', {}, [null], [{}], [{ name: 5 }]]) {
    assert.deepEqual(pickDymoPrinter(list, ''), { printer: null, reason: 'none' }, JSON.stringify(list));
    assert.deepEqual(pickDymoPrinter(list, 'DYMO'), { printer: null, reason: 'none' });
  }
});

test('configured name: an exact match wins, case-insensitive and trimmed', () => {
  const list = [writer450, turbo];
  assert.deepEqual(pickDymoPrinter(list, 'DYMO LabelWriter 450'), { printer: writer450, reason: 'exact' });
  assert.deepEqual(pickDymoPrinter(list, '  dymo labelwriter 450  '), { printer: writer450, reason: 'exact' });
  assert.deepEqual(pickDymoPrinter(list, 'DYMO LABELWRITER 450 TURBO'), { printer: turbo, reason: 'exact' });
});

test('configured name: an exact match beats a longer name that contains it', () => {
  assert.equal(pickDymoPrinter([turbo, writer450], 'DYMO LabelWriter 450').printer, writer450);
});

test('configured name: a unique "contains" match is used', () => {
  assert.deepEqual(pickDymoPrinter([writer450, turbo], 'turbo'), { printer: turbo, reason: 'contains' });
  assert.deepEqual(pickDymoPrinter([writer450, fourXL], '4xl'), { printer: fourXL, reason: 'contains' });
});

test('configured name: several "contains" matches are ambiguous, so the automatic rules decide', () => {
  const result = pickDymoPrinter([fourXL, writer450, turbo], 'dymo');
  assert.equal(result.printer, writer450);
  assert.equal(result.reason, 'connected-labelwriter');
});

test('configured name that matches nothing falls back to the automatic rules (the reason tells the caller)', () => {
  const result = pickDymoPrinter([tape, writer450], 'Zebra');
  assert.deepEqual(result, { printer: writer450, reason: 'connected-labelwriter' });
});

test('automatic: the first connected LabelWriter, even when a connected tape printer or a disconnected LabelWriter is listed first', () => {
  assert.deepEqual(pickDymoPrinter([tape, fourXL, writer450, turbo], ''), { printer: writer450, reason: 'connected-labelwriter' });
  assert.deepEqual(pickDymoPrinter([writer450, turbo]), { printer: writer450, reason: 'connected-labelwriter' }, 'no configured name at all');
  assert.equal(pickDymoPrinter([writer450], undefined).printer, writer450);
  assert.equal(pickDymoPrinter([writer450], null).printer, writer450);
  assert.equal(pickDymoPrinter([writer450], '   ').printer, writer450, 'a blank name is automatic');
});

test('automatic: with no connected LabelWriter, the first connected printer', () => {
  assert.deepEqual(pickDymoPrinter([fourXL, tape], ''), { printer: tape, reason: 'connected' });
});

test('automatic: with nothing connected, the first printer', () => {
  const second = { ...fourXL, name: 'DYMO LabelWriter 330' };
  assert.deepEqual(pickDymoPrinter([fourXL, second], ''), { printer: fourXL, reason: 'first' });
  assert.deepEqual(pickDymoPrinter([{ name: 'Unknown printer' }], ''), { printer: { name: 'Unknown printer' }, reason: 'first' }, 'no isConnected information at all');
});

test('a LabelWriter is recognised by its type, or by its model or name when the type is missing', () => {
  const noType = { name: 'Front desk', modelName: 'DYMO LabelWriter 450', isConnected: true };
  const noTypeTape = { name: 'Tape', modelName: 'DYMO LabelManager', isConnected: true };
  assert.equal(pickDymoPrinter([noTypeTape, noType], '').printer, noType);
  const nameOnly = { name: 'Office LabelWriter', isConnected: true };
  assert.equal(pickDymoPrinter([noTypeTape, nameOnly], '').printer, nameOnly);
  assert.equal(pickDymoPrinter([{ ...tape, name: 'LabelWriter lookalike' }, writer450], '').printer, writer450, 'the type wins over the name');
});

test('entries that are not printers are ignored; the input is not changed', () => {
  const list = [null, undefined, {}, { name: 5 }, 'x', writer450];
  const copy = [...list];
  assert.equal(pickDymoPrinter(list, '').printer, writer450);
  assert.deepEqual(list, copy);
});

test('a printer name with quotes or backslashes is returned untouched (it is data)', () => {
  const odd = { name: 'Front "desk" \\ DYMO', printerType: 'LabelWriterPrinter', isConnected: true };
  assert.equal(pickDymoPrinter([odd], 'front "desk" \\ dymo').printer, odd);
});
