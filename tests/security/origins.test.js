'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSecurity,
  parseOriginPattern,
  BUILT_IN_ORIGINS,
  NAVIGATION_ONLY_ORIGINS,
  DEV_ORIGINS,
} = require('../../src/main/security');

const DEFAULT_SERVER_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';

/**
 * A security object over a config the test can change afterwards (Settings changes it while the app runs).
 *
 * @param {{ serverUrl?: unknown, extraAllowedOrigins?: unknown }} [config]
 * @param {Object} [options] createSecurity options
 */
function makeSecurity(config = {}, options = {}) {
  const settings = { serverUrl: DEFAULT_SERVER_URL, extraAllowedOrigins: [], ...config };
  const security = createSecurity({
    getConfig: () => ({ get: (key, fallback) => (settings[key] === undefined ? fallback : settings[key]) }),
    isPackaged: true,
    ...options,
  });
  return { security, settings };
}

const production = () => makeSecurity().security;
const development = (config) => makeSecurity(config, { isPackaged: false }).security;

// ---------------------------------------------------------------------------------------------
// The attack table: production, default config (serverUrl = vendor.societyfiles.com, no extra origins)
// ---------------------------------------------------------------------------------------------

/** [label, input]. Every one of these must be refused by isAllowedOrigin in production. */
const REFUSED = [
  // look-alike hosts
  ['suffix glued to another word', 'https://evilgadgetspos.com'],
  ['the domain as a subdomain of another', 'https://gadgetspos.com.evil.com'],
  ['the domain as a subdomain of another, explicit port', 'https://gadgetspos.com.evil.com:443'],
  ['one letter prepended', 'https://xgadgetspos.com'],
  ['top-level domain cut short', 'https://gadgetspos.co'],
  ['top-level domain extended', 'https://gadgetspos.comm'],
  ['dot replaced by a hyphen', 'https://gadgetspos-com.evil.com'],
  ['hyphen then another domain', 'https://gadgetspos.com-evil.com'],
  ['a different subdomain of an evil host', 'https://gadgetspos.evil.com'],
  ['second allowed domain glued to a word', 'https://notsocietyfiles.com'],
  ['second allowed domain with another tld', 'https://societyfiles.com.au'],
  ['second allowed domain under an evil host', 'https://societyfiles.evil.com'],
  ['allowed name in the path', 'https://evil.com/gadgetspos.com'],
  ['allowed name in the query', 'https://evil.com/?https://gadgetspos.com'],
  ['allowed name in the fragment', 'https://evil.com#gadgetspos.com'],
  ['allowed name in the query of a bare host', 'https://evil.com?gadgetspos.com'],
  // empty labels and trailing dots
  ['trailing dot', 'https://gadgetspos.com.'],
  ['trailing dot on a subdomain', 'https://vendor.societyfiles.com.'],
  ['trailing dot with an explicit port', 'https://gadgetspos.com.:443'],
  ['leading dot', 'https://.gadgetspos.com'],
  ['two leading dots', 'https://..gadgetspos.com'],
  ['empty label inside a subdomain', 'https://a..gadgetspos.com'],
  ['empty label inside the domain', 'https://gadgetspos..com'],
  // userinfo
  ['allowed host as the username', 'https://gadgetspos.com@evil.com'],
  ['evil username on an allowed host', 'https://evil.com@gadgetspos.com'],
  ['username and password', 'https://user:pass@gadgetspos.com'],
  ['allowed host and port as the username', 'https://gadgetspos.com:443@evil.com'],
  ['allowed host and password', 'https://gadgetspos.com:password@evil.com'],
  ['empty userinfo', 'https://@gadgetspos.com'],
  ['empty username and password', 'https://:@gadgetspos.com'],
  ['backslash before the at sign', 'https://gadgetspos.com\\@evil.com'],
  ['evil host before a backslash and an at sign', 'https://evil.com\\@gadgetspos.com'],
  // ports
  ['non-default https port', 'https://gadgetspos.com:8443'],
  ['plain-http port on https', 'https://gadgetspos.com:80'],
  ['non-default port on a subdomain', 'https://sub.gadgetspos.com:4443/x'],
  ['non-default port on the second domain', 'https://vendor.societyfiles.com:444'],
  ['port out of range', 'https://gadgetspos.com:65536'],
  ['negative port', 'https://gadgetspos.com:-1'],
  ['non-numeric port', 'https://gadgetspos.com:abc'],
  // schemes
  ['plain http', 'http://gadgetspos.com'],
  ['plain http on the second domain', 'http://vendor.societyfiles.com'],
  ['plain http upper case', 'HTTP://GADGETSPOS.COM'],
  ['ftp', 'ftp://gadgetspos.com'],
  ['websocket', 'ws://gadgetspos.com'],
  ['secure websocket', 'wss://gadgetspos.com'],
  ['blob of an allowed origin', 'blob:https://gadgetspos.com/0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11'],
  ['blob of an evil origin', 'blob:https://evil.com/0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11'],
  ['data url naming an allowed host', 'data:text/html,https://gadgetspos.com'],
  ['file url naming an allowed host in the path', 'file:///C:/gadgetspos.com'],
  ['file url with an allowed host', 'file://gadgetspos.com/x'],
  ['javascript url naming an allowed host', "javascript:alert('https://gadgetspos.com')"],
  ['about:blank', 'about:blank'],
  ['chrome internal page', 'chrome://gpu'],
  ['view-source', 'view-source:https://gadgetspos.com'],
  ['filesystem url', 'filesystem:https://gadgetspos.com/temporary/x'],
  ['mailto', 'mailto:a@gadgetspos.com'],
  ['protocol-relative', '//gadgetspos.com'],
  ['no scheme', 'gadgetspos.com'],
  ['scheme without slashes', 'https:gadgetspos.com'],
  ['scheme with one slash', 'https:/gadgetspos.com'],
  // unicode, punycode, encoding
  ['Cyrillic a', 'https://gаdgetspos.com'],
  ['Cyrillic o', 'https://gadgetspоs.com'],
  ['Latin script g', 'https://ɡadgetspos.com'],
  ['the punycode form of a lookalike', 'https://xn--gdgetspos-0yh.com'],
  ['fullwidth letters', 'https://ｇａｄｇｅｔｓｐｏｓ.ｃｏｍ'],
  ['ideographic full stop', 'https://gadgetspos。com'],
  ['soft hyphen', 'https://gadget\u00adspos.com'],
  ['percent-encoded dot then another domain', 'https://gadgetspos.com%2eevil.com'],
  ['percent-encoded dot inside the domain', 'https://gadgetspos%2ecom'],
  ['percent-encoded null byte', 'https://gadgetspos.com%00.evil.com'],
  ['percent-encoded at sign', 'https://gadgetspos.com%40evil.com'],
  ['wildcard character in the host', 'https://*.gadgetspos.com'],
  // whitespace and control characters
  ['leading space', ' https://gadgetspos.com'],
  ['trailing space', 'https://gadgetspos.com '],
  ['trailing newline', 'https://gadgetspos.com\n'],
  ['trailing tab', 'https://gadgetspos.com\t'],
  ['newline inside the host', 'https://gadget\nspos.com'],
  ['newline before a second domain', 'https://gadgetspos.com\n.evil.com'],
  ['leading null byte', '\u0000https://gadgetspos.com'],
  ['trailing null byte', 'https://gadgetspos.com\u0000'],
  ['line separator', 'https://gadgetspos.com\u2028'],
  ['carriage return and line feed', 'https://gadgetspos.com\r\nHost: evil.com'],
  // not URLs at all
  ['empty string', ''],
  ['the string null (an opaque origin)', 'null'],
  ['a space', ' '],
  ['bare scheme', 'https://'],
  ['three slashes', 'https:///'],
  ['only a query', 'https://?'],
  ['only a port', 'https://:443'],
  ['unterminated ipv6 literal', 'https://[::1'],
  ['undefined', undefined],
  ['null value', null],
  ['a number', 123],
  ['an object', {}],
  ['an array', ['https://gadgetspos.com']],
  ['a boolean', true],
  ['a URL object', new URL('https://gadgetspos.com')],
  // dev hosts in production
  ['localhost over http', 'http://localhost:3000'],
  ['loopback over http', 'http://127.0.0.1:3000'],
  ['localhost over https', 'https://localhost'],
  ['loopback over https', 'https://127.0.0.1'],
  ['ipv6 loopback', 'https://[::1]'],
  ['a public ip address', 'https://1.2.3.4'],
  ['the unspecified address', 'https://0.0.0.0'],
  // SPEC 12 lists only the SUBDOMAINS of societyfiles.com; the bare domain is not trusted
  ['the bare domain of the second built-in domain', 'https://societyfiles.com'],
  ['the bare domain with a slash and a path', 'https://societyfiles.com/vendor/point-of-sale'],
  ['the bare domain with the default port', 'https://societyfiles.com:443'],
  // provider hops are navigation-only, never an origin
  ['square api host', 'https://connect.squareup.com'],
  ['square bare domain', 'https://squareup.com'],
  ['square oauth url', 'https://connect.squareupsandbox.com/oauth2/authorize?client_id=x'],
  ['square sandbox dashboard', 'https://app.squareupsandbox.com'],
];

/** [label, input]. Every one of these must be allowed in production with the default config. */
const ALLOWED = [
  ['the bare domain', 'https://gadgetspos.com'],
  ['the bare domain with a slash', 'https://gadgetspos.com/'],
  ['a path, query and fragment', 'https://gadgetspos.com/path/to?q=1&r=2#frag'],
  ['an at sign in the path is not userinfo', 'https://gadgetspos.com/users/a@b.example'],
  ['www', 'https://www.gadgetspos.com'],
  ['a deep subdomain', 'https://a.b.c.gadgetspos.com'],
  ['the default serverUrl', DEFAULT_SERVER_URL],
  ['a subdomain of the second domain', 'https://anything.societyfiles.com'],
  ['upper-case host', 'https://GADGETSPOS.COM'],
  ['upper-case scheme and mixed-case host', 'HTTPS://Vendor.SocietyFiles.Com/Path'],
  ['the explicit default port', 'https://gadgetspos.com:443'],
  ['the explicit default port on a subdomain', 'https://app.gadgetspos.com:443/x'],
  ['an origin as Chromium reports it', 'https://vendor.societyfiles.com'],
];

test(`isAllowedOrigin (production): ${REFUSED.length} refused inputs`, () => {
  assert.ok(REFUSED.length >= 60, 'the table is meant to stay large');
  const security = production();
  for (const [label, input] of REFUSED) {
    assert.equal(security.isAllowedOrigin(input), false, `${label}: ${JSON.stringify(input)}`);
  }
});

test(`isAllowedOrigin (production): ${ALLOWED.length} allowed inputs`, () => {
  const security = production();
  for (const [label, input] of ALLOWED) {
    assert.equal(security.isAllowedOrigin(input), true, `${label}: ${JSON.stringify(input)}`);
  }
});

test('isAllowedOrigin: never throws, whatever it is given', () => {
  const security = production();
  const hostile = [undefined, null, NaN, Symbol('x'), () => {}, 10n, { toString: () => 'https://gadgetspos.com' }, Object.create(null), 'a'.repeat(100000), `https://gadgetspos.com/${'a'.repeat(100000)}`];
  for (const input of hostile) assert.doesNotThrow(() => security.isAllowedOrigin(input), String(typeof input));
  assert.equal(security.isAllowedOrigin('a'.repeat(100000)), false);
  assert.equal(security.isAllowedOrigin({ toString: () => 'https://gadgetspos.com' }), false, 'an object is never coerced');
});

test('the built-in list is gadgetspos.com with its subdomains and the subdomains of societyfiles.com (not its bare domain, SPEC 12)', () => {
  assert.deepEqual([...BUILT_IN_ORIGINS], ['https://gadgetspos.com', 'https://*.gadgetspos.com', 'https://*.societyfiles.com']);
  assert.ok(Object.isFrozen(BUILT_IN_ORIGINS));
  assert.ok(Object.isFrozen(NAVIGATION_ONLY_ORIGINS));
  assert.ok(Object.isFrozen(DEV_ORIGINS));
});

// ---------------------------------------------------------------------------------------------
// serverUrl
// ---------------------------------------------------------------------------------------------

test('serverUrl: its origin is allowed, with its own port, and only that', () => {
  const { security } = makeSecurity({ serverUrl: 'https://pos.shop.example/vendor/point-of-sale?active=buy' });
  assert.equal(security.isAllowedOrigin('https://pos.shop.example'), true);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example/anything?x=1'), true);
  assert.equal(security.isAllowedOrigin('https://POS.SHOP.EXAMPLE:443/'), true);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example:8443'), false);
  assert.equal(security.isAllowedOrigin('https://other.shop.example'), false);
  assert.equal(security.isAllowedOrigin('https://shop.example'), false);
  assert.equal(security.isAllowedOrigin('https://sub.pos.shop.example'), false, 'the origin, not its subdomains');
  assert.equal(security.isAllowedOrigin('http://pos.shop.example'), false);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example.'), false);
});

test('serverUrl with a port: that port is the allowed origin', () => {
  const { security } = makeSecurity({ serverUrl: 'https://pos.shop.example:8443/x' });
  assert.equal(security.isAllowedOrigin('https://pos.shop.example:8443'), true);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example:8443/deep/path?q=1'), true);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example'), false);
  assert.equal(security.isAllowedOrigin('https://pos.shop.example:9443'), false);
});

test('serverUrl on a LAN address is allowed as an exact origin', () => {
  const { security } = makeSecurity({ serverUrl: 'https://192.168.1.10:8443/pos' });
  assert.equal(security.isAllowedOrigin('https://192.168.1.10:8443'), true);
  assert.equal(security.isAllowedOrigin('https://192.168.1.11:8443'), false);
  assert.equal(security.isAllowedOrigin('https://192.168.1.10'), false);
});

test('serverUrl over http is ignored in production and honoured while developing', () => {
  const lan = { serverUrl: 'http://192.168.1.10:3000/pos' };
  assert.equal(makeSecurity(lan).security.isAllowedOrigin('http://192.168.1.10:3000'), false);
  assert.equal(makeSecurity(lan, { isPackaged: false }).security.isAllowedOrigin('http://192.168.1.10:3000'), true);
});

test('serverUrl that is unusable adds nothing and breaks nothing', () => {
  for (const serverUrl of ['', '   ', 'not a url', 'javascript:alert(1)', 'ftp://files.example', 'file:///etc/passwd', 'https://', 42, null, {}, ['https://x.example'], 'https://trailing.dot.example.']) {
    const { security } = makeSecurity({ serverUrl });
    assert.equal(security.isAllowedOrigin('https://gadgetspos.com'), true, String(serverUrl));
    assert.equal(security.isAllowedOrigin('https://evil.example'), false, String(serverUrl));
    assert.equal(security.isAllowedOrigin('https://trailing.dot.example.'), false, String(serverUrl));
    assert.equal(security.isAllowedOrigin('https://files.example'), false, String(serverUrl));
  }
});

test('serverUrl changed in Settings: the very next check sees the new answer, and the old one is gone', () => {
  const { security, settings } = makeSecurity({ serverUrl: 'https://old.shop.example/pos' });
  assert.equal(security.isAllowedOrigin('https://old.shop.example'), true);
  assert.equal(security.isAllowedOrigin('https://new.shop.example'), false);

  settings.serverUrl = 'https://new.shop.example/pos';
  assert.equal(security.isAllowedOrigin('https://new.shop.example'), true);
  assert.equal(security.isAllowedOrigin('https://old.shop.example'), false);
});

// ---------------------------------------------------------------------------------------------
// extraAllowedOrigins
// ---------------------------------------------------------------------------------------------

test('extraAllowedOrigins: an exact origin allows that origin only', () => {
  const { security } = makeSecurity({ extraAllowedOrigins: ['https://shop.example.com'] });
  assert.equal(security.isAllowedOrigin('https://shop.example.com'), true);
  assert.equal(security.isAllowedOrigin('https://shop.example.com/path'), true);
  assert.equal(security.isAllowedOrigin('https://www.shop.example.com'), false);
  assert.equal(security.isAllowedOrigin('https://example.com'), false);
  assert.equal(security.isAllowedOrigin('http://shop.example.com'), false);
  assert.equal(security.isAllowedOrigin('https://shop.example.com:8443'), false);
  assert.equal(security.isAllowedOrigin('https://shop.example.com.evil.com'), false);
  assert.equal(security.isAllowedOrigin('https://evilshop.example.com'), false);
});

test('extraAllowedOrigins: a bare host means https, the entry is case-insensitive and may end in a slash', () => {
  const { security } = makeSecurity({ extraAllowedOrigins: ['shop.example.com', 'HTTPS://Till.Example.NET/'] });
  assert.equal(security.isAllowedOrigin('https://shop.example.com'), true);
  assert.equal(security.isAllowedOrigin('https://till.example.net'), true);
  assert.equal(security.isAllowedOrigin('http://shop.example.com'), false);
});

test('extraAllowedOrigins: an entry that names a port allows exactly that port', () => {
  const { security } = makeSecurity({ extraAllowedOrigins: ['https://shop.example.com:8443', 'till.example.net:9443'] });
  assert.equal(security.isAllowedOrigin('https://shop.example.com:8443'), true);
  assert.equal(security.isAllowedOrigin('https://shop.example.com'), false);
  assert.equal(security.isAllowedOrigin('https://shop.example.com:8444'), false);
  assert.equal(security.isAllowedOrigin('https://till.example.net:9443/x'), true);
  assert.equal(security.isAllowedOrigin('https://till.example.net'), false);
});

test('extraAllowedOrigins: *.domain matches subdomains of any depth and never the bare domain', () => {
  for (const entry of ['*.example.org', 'https://*.example.org']) {
    const { security } = makeSecurity({ extraAllowedOrigins: [entry] });
    assert.equal(security.isAllowedOrigin('https://a.example.org'), true, entry);
    assert.equal(security.isAllowedOrigin('https://a.b.example.org/x?y=1'), true, entry);
    assert.equal(security.isAllowedOrigin('https://example.org'), false, `${entry}: the bare domain needs its own entry`);
    assert.equal(security.isAllowedOrigin('https://evilexample.org'), false, entry);
    assert.equal(security.isAllowedOrigin('https://example.org.evil.com'), false, entry);
    assert.equal(security.isAllowedOrigin('https://a.example.org.evil.com'), false, entry);
    assert.equal(security.isAllowedOrigin('https://a.example.org:8443'), false, entry);
    assert.equal(security.isAllowedOrigin('http://a.example.org'), false, entry);
    assert.equal(security.isAllowedOrigin('https://a.example.org.'), false, entry);
    assert.equal(security.isAllowedOrigin('https://.example.org'), false, entry);
    assert.equal(security.isAllowedOrigin('https://a..example.org'), false, entry);
    assert.equal(security.isAllowedOrigin('https://x@a.example.org'), false, entry);
  }
});

test('extraAllowedOrigins: a wildcard entry may name a port', () => {
  const { security } = makeSecurity({ extraAllowedOrigins: ['*.example.org:8443'] });
  assert.equal(security.isAllowedOrigin('https://a.example.org:8443'), true);
  assert.equal(security.isAllowedOrigin('https://a.example.org'), false);
});

test('extraAllowedOrigins: junk entries are ignored without a throw and never widen anything', () => {
  const junk = [
    '*', '*.com', 'https://*.com', '*.co', '*.localhost', '', '   ', 42, null, undefined, {}, [], true,
    'javascript:alert(1)', 'ftp://evil.example', 'file:///etc/passwd', 'data:text/html,x', 'blob:https://evil.example/x',
    'https://user@evil.example', 'https://user:pw@evil.example', 'https://evil.example/path', 'https://evil.example?x=1', 'https://evil.example#x',
    'https://*.*.evil.example', 'https://exa*mple.example', 'https://*evil.example', 'https://*.127.0.0.1', 'https://*.[::1]', 'https://[::1',
    'https://evil.example\\@good.example', 'https://evil..example', 'https://.evil.example', 'https://evil.example.', 'https://evil example',
    'https://evil.example:99999', 'https://evil.example:abc', 'http://*:3000', 'x'.repeat(1000),
  ];
  const { security } = makeSecurity({ extraAllowedOrigins: junk });
  assert.doesNotThrow(() => security.isAllowedOrigin('https://gadgetspos.com'));
  for (const probe of ['https://evil.example', 'https://a.evil.example', 'https://anything.com', 'https://example.com', 'https://evil.co', 'https://a.localhost', 'https://127.0.0.1', 'https://good.example', 'https://x.example', 'https://evil.example:99999']) {
    assert.equal(security.isAllowedOrigin(probe), false, probe);
  }
  assert.equal(security.isAllowedOrigin('https://gadgetspos.com'), true);
});

test('extraAllowedOrigins: not an array means no extras', () => {
  for (const value of ['https://shop.example.com', {}, 42, null]) {
    const { security } = makeSecurity({ extraAllowedOrigins: value });
    assert.equal(security.isAllowedOrigin('https://shop.example.com'), false, String(value));
  }
});

test('extraAllowedOrigins: only the first 100 entries count', () => {
  const entries = Array.from({ length: 101 }, (_, index) => `https://host${index}.example`);
  const { security } = makeSecurity({ extraAllowedOrigins: entries });
  assert.equal(security.isAllowedOrigin('https://host0.example'), true);
  assert.equal(security.isAllowedOrigin('https://host99.example'), true);
  assert.equal(security.isAllowedOrigin('https://host100.example'), false);
});

test('extraAllowedOrigins: an http entry is ignored in production and honoured while developing', () => {
  const entries = { extraAllowedOrigins: ['http://dev.shop.example:3000', 'http://*.lab.example'] };
  const prod = makeSecurity(entries).security;
  assert.equal(prod.isAllowedOrigin('http://dev.shop.example:3000'), false);
  assert.equal(prod.isAllowedOrigin('http://a.lab.example'), false);
  const dev = makeSecurity(entries, { isPackaged: false }).security;
  assert.equal(dev.isAllowedOrigin('http://dev.shop.example:3000'), true);
  assert.equal(dev.isAllowedOrigin('http://dev.shop.example:3001'), false);
  assert.equal(dev.isAllowedOrigin('http://a.lab.example'), true);
});

test('extraAllowedOrigins: edited in place or replaced, the next check sees it', () => {
  const extras = ['https://one.example'];
  const { security, settings } = makeSecurity({ extraAllowedOrigins: extras });
  assert.equal(security.isAllowedOrigin('https://one.example'), true);
  assert.equal(security.isAllowedOrigin('https://two.example'), false);

  extras.push('https://two.example');
  assert.equal(security.isAllowedOrigin('https://two.example'), true, 'the same array, edited in place');

  settings.extraAllowedOrigins = [];
  assert.equal(security.isAllowedOrigin('https://one.example'), false);
  assert.equal(security.isAllowedOrigin('https://two.example'), false);
});

// ---------------------------------------------------------------------------------------------
// Development builds
// ---------------------------------------------------------------------------------------------

test('development: the local dev servers are allowed on any port, over http', () => {
  const security = development();
  for (const origin of ['http://localhost:3000', 'http://localhost:5173/x?y=1', 'http://localhost', 'http://LOCALHOST:8080', 'http://127.0.0.1:3000', 'http://127.0.0.1:8080/path', 'http://127.0.0.1']) {
    assert.equal(security.isAllowedOrigin(origin), true, origin);
  }
  // The production rules still hold next to them.
  assert.equal(security.isAllowedOrigin('https://gadgetspos.com'), true);
  assert.equal(security.isAllowedOrigin('https://evil.com'), false);
});

test('development: look-alikes of the dev hosts are still refused', () => {
  const security = development();
  for (const origin of [
    'http://localhost.evil.com', 'http://localhost.evil.com:3000', 'http://evil.com@localhost:3000', 'http://localhost@evil.com', 'http://localhostx:3000',
    'http://xlocalhost:3000', 'http://0.0.0.0:3000', 'http://[::1]:3000', 'http://127.0.0.2:3000', 'http://127.0.0.1.evil.com', 'http://127.0.0.1.:3000',
    'http://localhost.:3000', 'https://localhost:3000', 'https://127.0.0.1:3000', 'ws://localhost:3000', 'http://sub.localhost:3000', 'http://localhost:abc',
    'http://localhost:3000@evil.com',
  ]) {
    assert.equal(security.isAllowedOrigin(origin), false, origin);
  }
});

test('development: a built-in domain is not weakened to http', () => {
  const security = development();
  assert.equal(security.isAllowedOrigin('http://gadgetspos.com'), false);
  assert.equal(security.isAllowedOrigin('http://vendor.societyfiles.com'), false);
});

test('development: the dev origins can be replaced, and only exist while unpackaged', () => {
  const narrow = makeSecurity({}, { isPackaged: false, devOrigins: ['http://localhost:4000'] }).security;
  assert.equal(narrow.isAllowedOrigin('http://localhost:4000'), true);
  assert.equal(narrow.isAllowedOrigin('http://localhost:3000'), false);
  assert.equal(narrow.isAllowedOrigin('http://127.0.0.1:4000'), false);

  const none = makeSecurity({}, { isPackaged: false, devOrigins: [] }).security;
  assert.equal(none.isAllowedOrigin('http://localhost:3000'), false);

  const packaged = makeSecurity({}, { isPackaged: true, devOrigins: ['http://localhost:4000'] }).security;
  assert.equal(packaged.isAllowedOrigin('http://localhost:4000'), false);
});

test('isPackaged may be a function and is read on every call', () => {
  let packaged = true;
  const { security } = makeSecurity({}, { isPackaged: () => packaged });
  assert.equal(security.isAllowedOrigin('http://localhost:3000'), false);
  packaged = false;
  assert.equal(security.isAllowedOrigin('http://localhost:3000'), true);
});

test('the default is the strict production behaviour', () => {
  const security = createSecurity({});
  assert.equal(security.isAllowedOrigin('http://localhost:3000'), false);
  assert.equal(security.isAllowedOrigin('https://gadgetspos.com'), true);
  assert.equal(createSecurity().isAllowedOrigin('https://gadgetspos.com'), true);
});

// ---------------------------------------------------------------------------------------------
// The config object itself
// ---------------------------------------------------------------------------------------------

test('getConfig may return a plain snapshot instead of an object with get()', () => {
  const security = createSecurity({
    getConfig: () => ({ serverUrl: 'https://pos.shop.example/x', extraAllowedOrigins: ['*.example.org'] }),
    isPackaged: true,
  });
  assert.equal(security.isAllowedOrigin('https://pos.shop.example'), true);
  assert.equal(security.isAllowedOrigin('https://a.example.org'), true);
});

test('getConfig may be the config object itself', () => {
  const security = createSecurity({ getConfig: { get: (key, fallback) => (key === 'serverUrl' ? 'https://direct.shop.example/' : fallback) }, isPackaged: true });
  assert.equal(security.isAllowedOrigin('https://direct.shop.example'), true);
});

test('a missing, loading or broken config means the defaults, never a throw', () => {
  const broken = [
    undefined,
    () => null,
    () => undefined,
    () => {
      throw new Error('config not ready');
    },
    () => ({
      get() {
        throw new Error('store failure');
      },
    }),
    () => ({ get: () => undefined }),
  ];
  for (const getConfig of broken) {
    const security = createSecurity({ getConfig, isPackaged: true });
    assert.equal(security.isAllowedOrigin('https://gadgetspos.com'), true);
    assert.equal(security.isAllowedOrigin('https://vendor.societyfiles.com'), true);
    assert.equal(security.isAllowedOrigin('https://evil.example'), false);
  }
});

// ---------------------------------------------------------------------------------------------
// Provider hops
// ---------------------------------------------------------------------------------------------

test('NAVIGATION_ONLY_ORIGINS: the provider hosts are recognised and are never an allowed origin', () => {
  const security = production();
  const hops = [
    'https://connect.squareup.com/oauth2/authorize?client_id=x&state=y',
    'https://connect.squareupsandbox.com/oauth2/authorize',
    'https://app.squareup.com/login',
    'https://squareup.com/login',
    'https://squareupsandbox.com/login',
    'https://a.b.squareup.com',
  ];
  for (const url of hops) {
    assert.equal(security.isNavigationOnlyOrigin(url), true, url);
    assert.equal(security.isAllowedOrigin(url), false, url);
    assert.equal(security.isAllowedWindowTarget(url), false, url);
  }
  assert.deepEqual([...NAVIGATION_ONLY_ORIGINS], ['https://squareup.com', 'https://*.squareup.com', 'https://squareupsandbox.com', 'https://*.squareupsandbox.com']);
});

test('NAVIGATION_ONLY_ORIGINS: look-alikes, other schemes and userinfo are not provider hosts', () => {
  const security = production();
  for (const url of [
    'https://squareup.com.evil.com', 'https://evilsquareup.com', 'https://squareup.com@evil.com', 'https://connect.squareup.com@evil.com',
    'http://connect.squareup.com', 'https://connect.squareup.com:8443', 'https://connect.squareup.com.', 'https://.squareup.com', 'https://squareup.co',
    'https://gadgetspos.com', 'https://vendor.societyfiles.com', 'blob:https://connect.squareup.com/x', '', null, undefined, 'null', 'https://sq uareup.com',
  ]) {
    assert.equal(security.isNavigationOnlyOrigin(url), false, String(url));
  }
});

// ---------------------------------------------------------------------------------------------
// parseOriginPattern
// ---------------------------------------------------------------------------------------------

test('parseOriginPattern: the accepted spellings and their canonical text', () => {
  const cases = [
    ['https://shop.example.com', 'https://shop.example.com'],
    ['shop.example.com', 'https://shop.example.com'],
    ['  Shop.Example.COM  ', 'https://shop.example.com'],
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['https://shop.example.com:8443', 'https://shop.example.com:8443'],
    ['https://shop.example.com:443', 'https://shop.example.com'],
    ['shop.example.com:8443', 'https://shop.example.com:8443'],
    ['*.example.org', 'https://*.example.org'],
    ['https://*.example.org', 'https://*.example.org'],
    ['*.example.org:8443', 'https://*.example.org:8443'],
    ['http://localhost:*', 'http://localhost:*'],
    ['http://127.0.0.1:*', 'http://127.0.0.1:*'],
    ['http://dev.example:3000', 'http://dev.example:3000'],
    ['https://192.168.1.10:8443', 'https://192.168.1.10:8443'],
  ];
  for (const [entry, text] of cases) {
    const pattern = parseOriginPattern(entry);
    assert.ok(pattern, entry);
    assert.equal(pattern.text, text, entry);
  }
});

test('parseOriginPattern: structure of a wildcard, an exact and an any-port entry', () => {
  assert.deepEqual(parseOriginPattern('*.example.org:8443'), { protocol: 'https:', hostname: 'example.org', wildcard: true, port: '8443', text: 'https://*.example.org:8443' });
  assert.deepEqual(parseOriginPattern('https://shop.example.com'), { protocol: 'https:', hostname: 'shop.example.com', wildcard: false, port: '', text: 'https://shop.example.com' });
  assert.deepEqual(parseOriginPattern('http://localhost:*'), { protocol: 'http:', hostname: 'localhost', wildcard: false, port: '*', text: 'http://localhost:*' });
});

test('parseOriginPattern: everything unusable is null', () => {
  const refused = [
    undefined, null, 42, {}, [], '', '   ', '*', '*.com', '*.localhost', 'https://*.com', 'https://*.*.example.org', 'https://exa*mple.org', 'https://*example.org',
    'https://*.127.0.0.1', 'https://*.[::1]', 'javascript:alert(1)', 'ftp://example.org', 'file:///x', 'data:text/html,x', 'https://user@example.org',
    'https://example.org/path', 'https://example.org?x', 'https://example.org#x', 'https://example.org\\x', 'https://example.org.', 'https://.example.org',
    'https://a..example.org', 'https://exa mple.org', 'https://example.org:99999', 'https://example.org:abc', 'https://[::1', 'x'.repeat(300),
  ];
  for (const entry of refused) assert.equal(parseOriginPattern(entry), null, String(entry));
});
