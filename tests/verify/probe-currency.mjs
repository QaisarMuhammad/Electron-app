import { createRequire } from 'node:module';
import { web, receiptMoney } from './_kit.mjs';
const require = createRequire(import.meta.url);
const { currencySymbol } = require('../../src/main/printing/currency');
const catalog = await web.loader.loadSrc('utils/currencyCatalog.js');
console.log('catalog exports:', Object.keys(catalog).join(', '));
const codes = (catalog.CURRENCY_CODES || catalog.currencyCodes || catalog.CURRENCIES?.map?.((c) => c.code) || []);
let list = Array.isArray(codes) ? codes : Object.keys(codes);
if (!list.length) {
  const candidate = Object.values(catalog).find((v) => Array.isArray(v) && v.length > 50);
  list = candidate ? candidate.map((c) => (typeof c === 'string' ? c : c.code || c.value || c.iso)) : [];
}
console.log('codes:', list.length, list.slice(0, 8));
const bad = [];
for (const code of list) {
  const web_ = receiptMoney.receiptCurrencyPrefix(code);
  const desk = currencySymbol(receiptMoney.receiptIsoCode({ posCurrencyExit: { business_currency: code } }));
  if (web_ !== desk) bad.push([code, web_, desk]);
}
console.log('mismatches between the web\'s receipt prefix and the desktop label symbol:', bad.length, bad.slice(0, 10));
// odd business currency values the web may hold
for (const raw of [undefined, null, '', ' ', '£', '$', 'pounds', 'gbp', ' aed ', 'AEDX', 'US', 'US$', 'XYZ', 'ZZZ', 123, {}]) {
  const iso = receiptMoney.receiptIsoCode({ posCurrencyExit: { business_currency: raw } });
  console.log(JSON.stringify(raw ?? String(raw)).padEnd(10), '-> web iso', JSON.stringify(iso).padEnd(7), '-> desktop symbol', JSON.stringify(currencySymbol(iso)), '| web prefix', JSON.stringify(receiptMoney.receiptCurrencyPrefix(raw)));
}
