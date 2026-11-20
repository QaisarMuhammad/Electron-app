'use strict';

/**
 * SPEC 12: a wildcard in the allow-list over a public suffix (`*.co.uk`) or a shared hosting domain (`*.github.io`) would trust every
 * site anybody has on that domain with the print and drawer API. Settings refuses it with a plain message, and the allow-list ignores
 * it (and says so once) when it is already in config.json. Exact addresses and wildcards over a company's own domain are untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSharedSuffix, SHARED_HOSTING_SUFFIXES } = require('../../src/main/sharedSuffixes');
const { validateConnection } = require('../../src/main/config');
const { createSecurity } = require('../../src/main/security');

const REGISTRY_SUFFIXES = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'net.nz', 'co.za', 'com.br', 'co.jp', 'or.jp',
  'ne.jp', 'co.in', 'com.mx', 'com.tr', 'com.cn', 'co.il', 'com.sg', 'co.kr', 'com.ar', 'gob.mx', 'co.ke',
];

/** What the task listed, spelled out: these must all be refused. */
const HOSTING = [
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
  'cloudfront.net', 'amazonaws.com', 'blogspot.com', 'wordpress.com', 'wixsite.com', 'myshopify.com', 'weebly.com', 'glitch.me', 'repl.co', 'onrender.com',
  'fly.dev', 'appspot.com',
];

const TOP_LEVEL = ['com', 'net', 'org', 'io', 'dev', 'app', 'uk', 'au', 'nz', 'za', 'br', 'jp', 'in', 'mx', 'tr', 'de', 'london', 'xyz'];

test('isSharedSuffix: public suffixes and shared hosting domains are, a company domain is not', () => {
  for (const name of [...TOP_LEVEL, ...REGISTRY_SUFFIXES, ...HOSTING, ...SHARED_HOSTING_SUFFIXES]) assert.equal(isSharedSuffix(name), true, name);
  for (const name of [
    'example.com', 'myshop.co.uk', 'shop.example.co.uk', 'gadgetspos.com', 'rtech.gadgetspos.com', 'societyfiles.com', 'vendor.societyfiles.com', 'myapp.herokuapp.com',
    'mycompany.github.io', 'example.org', 'a.b.c.example.net',
  ]) {
    assert.equal(isSharedSuffix(name), false, name);
  }
  for (const odd of [undefined, null, 42, {}, [], '']) assert.equal(isSharedSuffix(odd), false, String(odd));
});

test('Settings refuses a wildcard over each of them, in plain English, naming the entry', () => {
  for (const suffix of [...REGISTRY_SUFFIXES, ...HOSTING]) {
    const result = validateConnection({ extraAllowedOrigins: [`*.${suffix}`] });
    assert.equal(result.ok, false, suffix);
    assert.equal(result.code, 'INVALID_SETTINGS');
    assert.match(result.message, new RegExp(`"\\*\\.${suffix.replace(/\./g, '\\.')}" would allow every website that ends in ${suffix.replace(/\./g, '\\.')}, not only yours`), result.message);
    assert.match(result.message, /Add your own address instead, such as https:\/\/shop\.example\.com or \*\.example\.com\.$/);
  }
  assert.equal(validateConnection({ extraAllowedOrigins: ['*.CO.UK'] }).ok, false, 'in any case');
  assert.equal(validateConnection({ extraAllowedOrigins: ['https://*.github.io'] }).ok, false, 'with a scheme');
  assert.equal(validateConnection({ extraAllowedOrigins: ['https://shop.example.com', '*.github.io'] }).ok, false, 'one bad entry refuses the whole save');
});

test('a bare top-level domain is refused too (the two-label rule), with the general message', () => {
  for (const tld of TOP_LEVEL) assert.equal(validateConnection({ extraAllowedOrigins: [`*.${tld}`] }).ok, false, tld);
});

test('Settings still accepts exact addresses and wildcards over a company domain', () => {
  const entries = [
    'https://shop.example.com', 'https://rtech.gadgetspos.com', 'https://api.partner.co.uk', 'https://myapp.herokuapp.com', 'https://mycompany.github.io',
    '*.myshop.co.uk', '*.myshop.example', '*.rtech.gadgetspos.com', '*.myapp.herokuapp.com', '*.example.com',
  ];
  const result = validateConnection({ extraAllowedOrigins: entries });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.value.extraAllowedOrigins, entries);
});

/** A security object over the given extra origins, with the log lines it writes. */
function securityWith(extra, extraOptions = {}) {
  const warnings = [];
  const security = createSecurity({ getConfig: () => ({ extraAllowedOrigins: extra }), isPackaged: true, log: { warn: (line) => warnings.push(line) }, ...extraOptions });
  return { security, warnings };
}

test('isAllowedOrigin ignores such a wildcard even when it is already in config.json, and the other entries keep working', () => {
  const { security } = securityWith([...REGISTRY_SUFFIXES, ...HOSTING].map((suffix) => `*.${suffix}`).concat(['https://shop.example.com', '*.myshop.co.uk']));
  for (const suffix of [...REGISTRY_SUFFIXES, ...HOSTING]) {
    assert.equal(security.isAllowedOrigin(`https://attacker.${suffix}`), false, suffix);
    assert.equal(security.isAllowedOrigin(`https://a.b.${suffix}`), false, suffix);
  }
  assert.equal(security.isAllowedOrigin('https://shop.example.com'), true);
  assert.equal(security.isAllowedOrigin('https://till.myshop.co.uk'), true, 'a wildcard over a company domain under co.uk is fine');
  assert.equal(security.isAllowedOrigin('https://myshop.co.uk'), false, 'and still never the bare domain');
});

test('an exact entry on a shared domain is one site and is honoured', () => {
  const { security } = securityWith(['https://api.partner.co.uk', 'https://myapp.herokuapp.com']);
  assert.equal(security.isAllowedOrigin('https://api.partner.co.uk'), true);
  assert.equal(security.isAllowedOrigin('https://myapp.herokuapp.com'), true);
  assert.equal(security.isAllowedOrigin('https://other.herokuapp.com'), false);
});

test('each ignored entry is logged once, by name, and nothing else is', () => {
  const extras = ['*.co.uk', '*.github.io', 'https://shop.example.com'];
  const settings = { extraAllowedOrigins: extras };
  const warnings = [];
  const security = createSecurity({ getConfig: () => settings, isPackaged: true, log: { warn: (line) => warnings.push(line) } });
  for (let i = 0; i < 5; i += 1) security.isAllowedOrigin('https://attacker.co.uk');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /https:\/\/\*\.co\.uk is ignored: it would trust every website on co\.uk/);
  assert.match(warnings[1], /\*\.github\.io is ignored/);

  settings.extraAllowedOrigins = [...extras, '*.herokuapp.com']; // a change of the settings rebuilds the list
  security.isAllowedOrigin('https://attacker.co.uk');
  assert.equal(warnings.length, 3, 'only the new entry is new');
  assert.match(warnings[2], /\*\.herokuapp\.com is ignored/);
});

test('without a logger, or with one that throws, the entry is ignored all the same', () => {
  const quiet = createSecurity({ getConfig: () => ({ extraAllowedOrigins: ['*.co.uk'] }), isPackaged: true });
  assert.equal(quiet.isAllowedOrigin('https://attacker.co.uk'), false);
  const broken = createSecurity({ getConfig: () => ({ extraAllowedOrigins: ['*.co.uk'] }), isPackaged: true, log: { warn() { throw new Error('log is down'); } } });
  assert.equal(broken.isAllowedOrigin('https://attacker.co.uk'), false);
  assert.equal(broken.isAllowedOrigin('https://vendor.societyfiles.com'), true);
});

test('the default list: the subdomains of societyfiles.com and everything of gadgetspos.com, and the default server address still loads', () => {
  const { security } = securityWith([]);
  for (const origin of ['https://vendor.societyfiles.com', 'https://a.b.societyfiles.com', 'https://gadgetspos.com', 'https://rtech.gadgetspos.com']) {
    assert.equal(security.isAllowedOrigin(origin), true, origin);
  }
  assert.equal(security.isAllowedOrigin('https://societyfiles.com'), false, 'not the bare domain');
  const withDefaultServer = createSecurity({ getConfig: () => ({ serverUrl: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy' }), isPackaged: true });
  assert.equal(withDefaultServer.isAllowedOrigin('https://vendor.societyfiles.com/vendor/point-of-sale?active=buy'), true);
});
