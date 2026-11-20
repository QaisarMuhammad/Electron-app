'use strict';

/**
 * What a DYMO label writes before a price (SPEC 9.4).
 *
 * The same rule as the web app's thermal receipts (utils/receiptMoney.js) and Zebra labels: the pound sign for
 * GBP, and for every other three-letter currency code the code itself followed by one space ("USD ", "AED ").
 * Never a glyph such as $, the euro sign, the rupee sign or the riyal sign: the label fonts cannot print them all,
 * and a code is unambiguous.
 *
 * Pure module: no electron, no fs.
 */

const POUND = '£';
const THREE_LETTERS = /^[A-Z]{3}$/;

/**
 * @param {unknown} iso a currency code such as "GBP", " usd " or "AED"; anything else (missing, '', '$', 'pounds', a number) means the pound sign
 * @returns {string} "£" or "<CODE> "
 */
function currencySymbol(iso) {
  const code = typeof iso === 'string' ? iso.trim().toUpperCase() : '';
  if (!THREE_LETTERS.test(code) || code === 'GBP') return POUND;
  return `${code} `;
}

module.exports = { currencySymbol, POUND };
