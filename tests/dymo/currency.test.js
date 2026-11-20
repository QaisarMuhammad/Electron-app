'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currencySymbol, POUND } = require('../../src/main/printing/currency');

const POUND_SIGN = String.fromCharCode(0xa3);

test('the pound sign is U+00A3, a printable Latin-1 character the label fonts have', () => {
  assert.equal(POUND, POUND_SIGN);
  assert.equal(POUND.charCodeAt(0), 0xa3);
});

test('GBP in any case or with blanks is the pound sign', () => {
  for (const code of ['GBP', 'gbp', 'Gbp', ' gbp ', '\tGBP\n']) assert.equal(currencySymbol(code), POUND_SIGN, JSON.stringify(code));
});

test('anything that is not a three-letter code is the pound sign: missing, empty, signs, words, numbers, objects', () => {
  for (const value of [undefined, null, '', '   ', '$', POUND_SIGN, 'pounds', 'US', 'USDX', 'U5D', '123', 123, 0, true, {}, [], ['USD'], () => 'USD']) {
    assert.equal(currencySymbol(value), POUND_SIGN, `${String(typeof value)} ${JSON.stringify(value)}`);
  }
});

test('every other code is the code followed by one space (the web receipt and Zebra rule)', () => {
  assert.equal(currencySymbol('USD'), 'USD ');
  assert.equal(currencySymbol(' usd '), 'USD ');
  assert.equal(currencySymbol('AED'), 'AED ');
  assert.equal(currencySymbol('eur'), 'EUR ');
  assert.equal(currencySymbol('Inr\n'), 'INR ');
});

test('it never returns a glyph such as the dollar, euro, rupee or riyal sign', () => {
  for (const code of ['USD', 'EUR', 'INR', 'SAR', 'AED', 'JPY', 'CNY', 'KRW', 'RUB', 'TRY', 'PKR', 'CAD', 'AUD', 'CHF']) {
    assert.match(currencySymbol(code), /^[A-Z]{3} $/, code);
  }
});

test('the symbol is followed directly by the price digits: a code ends in exactly one space', () => {
  const price = `${currencySymbol('AED')}12.50`;
  assert.equal(price, 'AED 12.50');
  assert.equal(`${currencySymbol('GBP')}12.50`, `${POUND_SIGN}12.50`);
});
