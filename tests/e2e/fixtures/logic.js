'use strict';
/*
 * Logic checks for src/renderer/shared/format.mjs, run by tests/e2e/ui-shots.js inside the Electron main process (Node 20 there
 * can `import()` a .mjs file; the file has no DOM dependency). They guard the lenient payload readers the pages rely on.
 */

/**
 * @param {{ok:Function, equal:Function}} t assertion helper from the harness
 * @param {string} formatUrl file: URL of format.mjs
 */
async function runLogicChecks(t, formatUrl) {
  const f = await import(formatUrl);

  // clocks and sentences
  t.equal(f.formatClock(0), '0:00', 'formatClock(0)');
  t.equal(f.formatClock(27), '0:27', 'formatClock(27)');
  t.equal(f.formatClock(65), '1:05', 'formatClock(65)');
  t.equal(f.formatClock(3700), '1:01:40', 'formatClock(3700)');
  t.equal(f.formatClock(-5), '0:00', 'formatClock negative');
  t.equal(f.formatClock(Number.NaN), '0:00', 'formatClock NaN');
  t.equal(f.formatSeconds(1), '1 second', 'formatSeconds(1)');
  t.equal(f.formatSeconds(27), '27 seconds', 'formatSeconds(27)');
  t.equal(f.formatSeconds(60), '1 minute', 'formatSeconds(60)');
  t.equal(f.formatSeconds(65), '1 minute 5 seconds', 'formatSeconds(65)');
  t.equal(f.formatSeconds(120), '2 minutes', 'formatSeconds(120)');
  t.equal(f.formatMs(412), '412 ms', 'formatMs(412)');
  t.equal(f.formatMs(1830), '1.8 s', 'formatMs(1830)');
  t.equal(f.formatMs(12000), '12 s', 'formatMs(12000)');

  // lockout payloads (SPEC 6.2 leaves the shape open)
  const now = 1_000_000;
  t.equal(f.normalizeLockout(30), { locked: true, retryAfterSec: 30 }, 'lockout from a number');
  t.equal(f.normalizeLockout({ locked: true, retryAfterSec: 27 }), { locked: true, retryAfterSec: 27 }, 'lockout retryAfterSec');
  t.equal(f.normalizeLockout({ retryAfterMs: 1500 }), { locked: true, retryAfterSec: 2 }, 'lockout retryAfterMs rounds up');
  t.equal(f.normalizeLockout({ remainingMs: 4200 }), { locked: true, retryAfterSec: 5 }, 'lockout remainingMs');
  t.equal(f.normalizeLockout({ lockedUntil: now + 5000 }, now), { locked: true, retryAfterSec: 5 }, 'lockout lockedUntil');
  t.equal(f.normalizeLockout({ ok: false, code: 'PASSWORD_LOCKED_OUT', details: { retryAfterSec: 9 } }), { locked: true, retryAfterSec: 9 }, 'lockout from a Result');
  t.equal(f.normalizeLockout({ locked: false, retryAfterSec: 10 }), { locked: false, retryAfterSec: 0 }, 'locked:false wins');
  t.equal(f.normalizeLockout(null), { locked: false, retryAfterSec: 0 }, 'lockout null');
  t.equal(f.normalizeLockout(0), { locked: false, retryAfterSec: 0 }, 'lockout zero');
  t.equal(f.normalizeLockout('soon'), { locked: false, retryAfterSec: 0 }, 'lockout junk');
  t.ok(f.isWrongPasswordCode('PASSWORD_WRONG') && f.isWrongPasswordCode('DRAWER_WRONG_PASSWORD') && !f.isWrongPasswordCode('UNKNOWN'), 'isWrongPasswordCode');

  // dirty tracking
  t.ok(f.sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), 'sameJson ignores key order');
  t.ok(!f.sameJson({ a: [1, 2] }, { a: [2, 1] }), 'sameJson respects array order');
  t.ok(!f.sameJson({ a: undefined }, { a: null }), 'sameJson tells undefined from null');
  t.equal(f.clone({ x: [1, { y: 2 }] }), { x: [1, { y: 2 }] }, 'clone');

  // printers
  const list = [
    { name: 'EPSON TM-T20III Receipt' },
    { name: 'ZDesigner ZD420', displayName: 'Zebra label printer' },
    { name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450 Turbo' },
  ];
  t.equal(f.filterPrinters(list, 'zd').length, 1, 'filterPrinters by name');
  t.equal(f.filterPrinters(list, 'ZEBRA').length, 1, 'filterPrinters by display name, case-insensitive');
  t.equal(f.filterPrinters(list, 'turbo').length, 1, 'filterPrinters by model');
  t.equal(f.filterPrinters(list, '  ').length, 3, 'filterPrinters blank query keeps all');
  t.equal(f.filterPrinters(list, 'nothing').length, 0, 'filterPrinters no match');
  t.equal(f.describePrinterStatus('Ready'), { label: 'Ready', tone: 'success' }, 'status Ready');
  t.equal(f.describePrinterStatus('Offline'), { label: 'Offline', tone: 'danger' }, 'status Offline');
  t.equal(f.describePrinterStatus('Paused'), { label: 'Paused', tone: 'warning' }, 'status Paused');
  t.equal(f.describePrinterStatus('printing').tone, 'info', 'status printing');
  t.equal(f.describePrinterStatus('Spun around').tone, 'neutral', 'status unknown string');
  t.equal(f.describePrinterStatus(0, 'win32'), { label: 'Ready', tone: 'success' }, 'win32 status 0');
  t.equal(f.describePrinterStatus(0x80, 'win32'), { label: 'Offline', tone: 'danger' }, 'win32 offline flag');
  t.equal(f.describePrinterStatus(3, 'darwin'), { label: 'Ready', tone: 'success' }, 'cups idle');
  t.equal(f.describePrinterStatus(5, 'linux'), { label: 'Stopped', tone: 'warning' }, 'cups stopped');
  t.equal(f.describePrinterStatus(null), null, 'status null');
  t.equal(f.describePrinterStatus(''), null, 'status empty');

  // startup marks: object, array and pair forms
  const asObject = f.normalizeStartup({ marks: { 'app-ready': 300, 'process-start': 0, 'pos-loaded': 2100 }, summary: 'ok' });
  t.equal(asObject.rows.map((r) => r.name), ['process-start', 'app-ready', 'pos-loaded'], 'marks sorted by time');
  t.equal(asObject.rows.map((r) => r.delta), [0, 300, 1800], 'mark deltas');
  t.equal(asObject.rows[1].label, 'Electron ready', 'known mark label');
  t.equal(asObject.summary, 'ok', 'summary string');
  t.equal(f.normalizeStartup({ marks: [{ name: 'a-b', ms: 5 }, ['c_d', 9]] }).rows.map((r) => r.label), ['A b', 'C d'], 'array forms and prettified names');
  t.equal(f.normalizeStartup({ marks: [{ name: 'x', at: 'nope' }] }).rows, [], 'junk marks ignored');
  t.equal(f.normalizeStartup(null), { rows: [], summary: '' }, 'no startup data');
  t.equal(f.normalizeStartup({ marks: {}, summary: { total: 1200 } }).summary, 'total 1.2 s', 'summary object');

  // addresses
  t.ok(f.validateServerUrl('https://vendor.societyfiles.com/vendor/point-of-sale?active=buy').ok, 'https server url');
  t.ok(f.validateServerUrl('http://localhost:3000').ok, 'http localhost allowed for development');
  t.ok(!f.validateServerUrl('http://shop.example.com').ok, 'http remote refused');
  t.ok(!f.validateServerUrl('shop.example.com').ok, 'missing scheme refused');
  t.ok(!f.validateServerUrl('').ok, 'empty server url refused');
  t.ok(!f.validateServerUrl('https://user:secret@example.com').ok, 'credentials in url refused');
  t.equal(f.validateOrigin('Shop.Example.com'), { ok: true, value: 'https://shop.example.com' }, 'bare host gets https and lower case');
  t.equal(f.validateOrigin('https://shop.example.com:8443/'), { ok: true, value: 'https://shop.example.com:8443' }, 'origin with port');
  t.equal(f.validateOrigin('*.Example.com'), { ok: true, value: '*.example.com' }, 'wildcard domain');
  t.ok(!f.validateOrigin('*.com').ok, 'wildcard top-level domain refused');
  t.ok(!f.validateOrigin('http://shop.example.com').ok, 'http origin refused');
  t.ok(!f.validateOrigin('https://shop.example.com/path').ok, 'origin with path refused');
  t.ok(!f.validateOrigin('not a domain').ok, 'junk origin refused');
  t.ok(!f.validateOrigin('').ok, 'empty origin refused');
  t.equal(f.hostOf('https://vendor.societyfiles.com/x'), 'vendor.societyfiles.com', 'hostOf');
  t.equal(f.hostOf('nonsense'), '', 'hostOf junk');

  // password hint
  t.equal(f.passwordStrength('').level, 0, 'strength empty');
  t.equal(f.passwordStrength('ab').label, 'Too short', 'strength too short');
  t.equal(f.passwordStrength('abcd').level, 1, 'strength weak');
  t.equal(f.passwordStrength('abcdefgh').level, 2, 'strength okay');
  t.equal(f.passwordStrength('Abcdefgh12!x').level, 3, 'strength strong');
}

module.exports = { runLogicChecks };
