'use strict';

/**
 * SECURITY lens, property-based attack on the pure decision functions of SPEC 12 and 9.1 (REGRESSION GUARDS: these pass today).
 *
 * The existing tables (tests/security/*, tests/printing/port-classify.test.js) list attacks somebody thought of. This file generates
 * tens of thousands of hostile strings from the classic ingredients (userinfo, look-alike and dotted hosts, ports, IDN and
 * encoded forms, case, tabs and newlines, backslashes, NUL) with a seeded generator, and checks the SAFETY invariant of each function:
 * whenever it says yes, the input really is what the rule says. A yes that violates the invariant is a bypass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const { createSecurity, isSafeExternalUrl, isLocalPageUrl } = require('../../src/main/security');
const { classifyPort } = require('../../src/main/printing/transports/win32-port');

/** Seeded generator (mulberry32): the same attacks on every run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const SCHEMES = ['https', 'http', 'HTTPS', 'Https', 'javascript', 'blob', 'data', 'file', 'about', 'ftp', 'ws', 'wss', 'view-source', ''];
const USERINFO = ['', '', '', 'a@', '@', ':@', 'user:pass@', 'gadgetspos.com@', 'gadgetspos.com:443@', '%40', 'x%40', 'evil.com\\@', 'evil.com#@'];
const HOSTS = [
  'gadgetspos.com', 'GADGETSPOS.COM', 'GadgetsPOS.Com', 'gadgetspos.com.', 'gadgetspos.com..', '.gadgetspos.com', 'a.gadgetspos.com', 'a.b.gadgetspos.com',
  'a..gadgetspos.com', 'evilgadgetspos.com', 'gadgetspos.com.evil.com', 'gadgetspos.comevil.com', 'gadgetspos-com.evil.com', 'xn--gadgetspos-9wb.com',
  'gadgetspos.com%2eevil.com', 'gadgetspos.com%00.evil.com', 'gadgetspos.com%0d%0a', 'gadgetspos\u3002com', 'gadgetspos\uff0ecom', '\uff47adgetspos.com',
  'gadgetspos.com\\.evil.com', 'gadgetspos.com;.evil.com', 'gadgetspos.com&.evil.com', 'gadgetspos.com$.evil.com', 'gadgetspos.com*.evil.com',
  'vendor.societyfiles.com', 'societyfiles.com', 'evilsocietyfiles.com', 'societyfiles.com.evil.com', 'vendor.societyfiles.com.',
  'squareup.com', 'connect.squareup.com', 'squareup.com.evil.com', 'localhost', 'localhost.', '127.0.0.1', '127.0.0.1.', '127.1', '0x7f.1', '2130706433',
  '[::1]', '[::ffff:127.0.0.1]', '[::]', 'example.com', 'evil.com', '*.gadgetspos.com', 'a_b.gadgetspos.com', '',
];
const PORTS = ['', '', '', ':443', ':', ':0', ':80', ':8443', ':65535', ':65536', ':-1', ':4 43', '::', ':443:443', ':abc', ':443.'];
const PATHS = ['', '', '/', '/x', '/x?y=1', '?q', '#f', '/\\evil.com', '//evil.com', '/..;/', '/%2e%2e/', ' ', '\t', '\n', '\u0000', '/\u2028'];

function randomUrl(rand) {
  const scheme = rand() < 0.5 ? 'https' : pick(rand, SCHEMES);
  const sep = rand() < 0.7 ? '://' : pick(rand, [':/', ':///', ':\\\\', ':', '//']);
  let text = `${scheme}${sep}${pick(rand, USERINFO)}${pick(rand, HOSTS)}${pick(rand, PORTS)}${pick(rand, PATHS)}`;
  if (rand() < 0.2) { // a random single-character mutation
    const index = Math.floor(rand() * (text.length + 1));
    text = text.slice(0, index) + pick(rand, ['@', '\\', '%', ' ', '\t', '\n', '\u0000', '\u202e', '.', ':', '[', ']', '#', '?', '\uff0e']) + text.slice(index);
  }
  return text;
}

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

test('isAllowedOrigin: 40,000 hostile strings, and every yes is an https origin of gadgetspos.com or societyfiles.com or a subdomain, no credentials, default port', () => {
  const security = createSecurity({ getConfig: () => ({}), isPackaged: true });
  const rand = random(0xc0ffee);
  let yes = 0;
  for (let i = 0; i < 40000; i += 1) {
    const text = randomUrl(rand);
    let verdict;
    assert.doesNotThrow(() => { verdict = security.isAllowedOrigin(text); }, JSON.stringify(text));
    assert.equal(typeof verdict, 'boolean');
    if (!verdict) continue;
    yes += 1;
    assert.match(text, PRINTABLE_ASCII, `a yes for a string with spaces or control characters: ${JSON.stringify(text)}`);
    const url = new URL(text);
    assert.equal(url.protocol, 'https:', JSON.stringify(text));
    assert.equal(url.username + url.password, '', `credentials: ${JSON.stringify(text)}`);
    assert.equal(url.port, '', `non-default port: ${JSON.stringify(text)}`);
    assert.ok(!url.hostname.endsWith('.') && !url.hostname.includes('..') && !url.hostname.startsWith('.'), JSON.stringify(text));
    assert.ok(
      /^([a-z0-9_-]+\.)*(gadgetspos|societyfiles)\.com$/.test(url.hostname),
      `a yes for a host that is not (a subdomain of) a built-in domain: ${JSON.stringify(text)} -> ${url.hostname}`,
    );
  }
  assert.ok(yes > 50, `the generator must also produce legitimate origins (${yes})`);
});

test('isAllowedOrigin: with an extra origin and a wildcard configured, a yes still means exactly those origins', () => {
  const security = createSecurity({ getConfig: () => ({ serverUrl: 'https://pos.myshop.example:8443/x', extraAllowedOrigins: ['https://shop.example.org', '*.tills.example.net'] }), isPackaged: true });
  const hosts = ['pos.myshop.example', 'shop.example.org', 'a.tills.example.net', 'tills.example.net', 'evil.example.net', 'gadgetspos.com'];
  const rand = random(0xbadf00d);
  for (let i = 0; i < 20000; i += 1) {
    const text = `${pick(rand, ['https', 'http'])}://${pick(rand, USERINFO)}${pick(rand, hosts)}${pick(rand, PORTS)}${pick(rand, PATHS)}`;
    if (!security.isAllowedOrigin(text)) continue;
    const url = new URL(text);
    assert.equal(url.protocol, 'https:', JSON.stringify(text));
    assert.equal(url.username + url.password, '', JSON.stringify(text));
    const expected = (url.hostname === 'pos.myshop.example' && url.port === '8443')
      || (url.hostname === 'shop.example.org' && url.port === '')
      || (/^[a-z0-9-]+\.tills\.example\.net$/.test(url.hostname) && url.port === '')
      || (/^([a-z0-9_-]+\.)*gadgetspos\.com$/.test(url.hostname) && url.port === '');
    assert.ok(expected, `unexpected yes: ${JSON.stringify(text)}`);
  }
});

test('isSafeExternalUrl: 40,000 hostile strings, and every yes is https, mailto or tel in canonical form', () => {
  const rand = random(0xfeed);
  const ODD = ['', 'mailto:a@b.c', 'tel:+441234', 'mailto:', 'tel:', 'ms-msdt:/id', 'search-ms:query=x', 'vscode://x', 'file:///c:/windows/system32/calc.exe', 'smb://evil/share'];
  for (let i = 0; i < 40000; i += 1) {
    const text = rand() < 0.15 ? `${pick(rand, ODD)}${pick(rand, PATHS)}` : randomUrl(rand);
    let verdict;
    assert.doesNotThrow(() => { verdict = isSafeExternalUrl(text); }, JSON.stringify(text));
    if (!verdict) continue;
    assert.match(text, PRINTABLE_ASCII, JSON.stringify(text));
    assert.ok(text.length <= 8192);
    const url = new URL(text);
    assert.ok(['https:', 'mailto:', 'tel:'].includes(url.protocol), JSON.stringify(text));
    if (url.protocol === 'https:') {
      assert.equal(url.username + url.password, '', JSON.stringify(text));
      assert.match(text, /^https:\/\/[a-z0-9._:[\]-]+(?:[/?#]|$)/i, `authority with @, % or \\: ${JSON.stringify(text)}`);
    }
  }
});

test('classifyPort: 60,000 hostile strings, and every accepted port is a UNC share or a DOS device with no cmd.exe metacharacter', () => {
  const rand = random(0xdead);
  const PARTS = ['\\\\', '\\\\.\\', '\\\\?\\', '\\', 'LPT', 'COM', 'PRN', 'lpt', 'com', '1', '9', '10', '256', '257', ':', 'localhost', 'host', 'share', 'Zebra ZD420', 'a b', '..', '.', 'C:', 'USB001', '&', '|', '<', '>', '^', '%', '!', ',', ';', '=', '"', "'", '(', ')', '$', '`', '\n', '\r', '\t', '\u0000', ' ', '\u00e9', '\u202e', 'x'];
  let accepted = 0;
  for (let i = 0; i < 60000; i += 1) {
    let text = '';
    for (let n = 1 + Math.floor(rand() * 7); n > 0; n -= 1) text += pick(rand, PARTS);
    const result = classifyPort(text);
    assert.ok(['unc', 'device', 'invalid'].includes(result.kind));
    if (result.kind === 'invalid') {
      assert.equal(result.path, '');
      continue;
    }
    accepted += 1;
    assert.doesNotMatch(result.path, /["'&|<>^%!,;=\u0000-\u001f\u007f-\u009f]/, `a metacharacter in an accepted port: ${JSON.stringify(text)} -> ${JSON.stringify(result.path)}`);
    assert.ok(result.path.length <= 512);
    if (result.kind === 'device') assert.match(result.path, /^\\\\\.\\(LPT[1-9]|COM\d{1,3}|PRN)$/, JSON.stringify(text));
    else {
      const parts = result.path.slice(2).split('\\');
      assert.equal(parts.length, 2, `a UNC path deeper than \\\\host\\share: ${JSON.stringify(text)}`);
      assert.ok(parts.every((part) => part !== '' && part !== '.' && part !== '..'), JSON.stringify(text));
    }
  }
  assert.ok(accepted > 200, `the generator must also produce valid ports (${accepted})`);
});

test('isLocalPageUrl: only files strictly inside the renderer directory, for posix and Windows paths', () => {
  const rand = random(0xabcdef);
  const POSIX_DIR = '/opt/Gadgets POS/resources/app.asar/src/renderer';
  const WIN_DIR = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar\\src\\renderer';
  const TAILS = ['offline.html', 'shared/ui.js', '', '.', '..', '../renderer-evil/x.html', '%2e%2e/x', '..%2fx', '%2e%2e%2fx', 'a/../../x.html', 'a/./b.html', 'x.html?reason=dns', 'x.html#h', '%5c..%5cx', 'C:/x.html', '//host/share/x.html', 'x%00.html'];
  for (let i = 0; i < 20000; i += 1) {
    const windows = rand() < 0.5;
    const dir = windows ? WIN_DIR : POSIX_DIR;
    const base = windows ? pick(rand, ['file:///C:/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer/', 'file:///c:/program%20files/gadgets%20pos/resources/app.asar/src/renderer/', 'file://host/share/', 'file:///D:/x/', 'file:///C:/Program%20Files/Gadgets%20POS/resources/app.asar/src/']) : pick(rand, ['file:///opt/Gadgets%20POS/resources/app.asar/src/renderer/', 'file:///opt/Gadgets%20POS/resources/app.asar/src/', 'file:///etc/', 'file:///opt/Gadgets%20POS/resources/app.asar/src/renderer-evil/']);
    const text = `${base}${pick(rand, TAILS)}`;
    let verdict;
    assert.doesNotThrow(() => { verdict = isLocalPageUrl(text, dir, { platform: windows ? 'win32' : 'linux' }); }, JSON.stringify(text));
    if (!verdict) continue;
    const api = windows ? nodePath.win32 : nodePath.posix;
    const { fileURLToPath } = require('node:url');
    const file = fileURLToPath(new URL(text), { windows });
    const relative = api.relative(api.resolve(dir), api.resolve(file));
    assert.ok(relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative), `a yes for a file outside the renderer folder: ${JSON.stringify(text)} -> ${file}`);
  }
});
