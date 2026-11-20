'use strict';

/**
 * SECURITY lens, the origin allow-list (SPEC 12). Two findings:
 *
 *  1. Settings > Connection and `isAllowedOrigin` accept a wildcard over a PUBLIC SUFFIX or a multi-tenant hosting domain
 *     (`*.co.uk`, `*.github.io`, `*.herokuapp.com`, `*.vercel.app` ...). Every site anybody can register under such a suffix then
 *     gets `window.electron`: it can print arbitrary receipts and labels, kick the drawer, brute-force the drawer password and
 *     list the printers. A manager who wants to reach a demo or staging deployment is likely to type exactly such an entry.
 *     (`*.com` is already refused, by the two-label rule; that rule is not enough.)
 *  2. The bare domain `societyfiles.com` is trusted. SPEC 12 lists `https://*.societyfiles.com` (subdomains only, which by the
 *     `*.` rule of security.js never matches the apex) next to BOTH forms for gadgetspos.com. src/main/security.js adds the apex
 *     on purpose (tests/security/origins.test.js pins it); confirm that is wanted, or drop it and that test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateConnection } = require('../../src/main/config');
const { createSecurity } = require('../../src/main/security');

const SHARED_SUFFIXES = [
  'co.uk', 'com.au', 'org.uk', 'co.jp', 'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'azurewebsites.net', 'blogspot.com', 'appspot.com',
];

test('Settings refuses a wildcard over a public suffix or a shared hosting domain', () => {
  const accepted = SHARED_SUFFIXES.filter((suffix) => validateConnection({ extraAllowedOrigins: [`*.${suffix}`] }).ok);
  assert.deepEqual(accepted, [], 'these wildcards were accepted: every site on such a suffix would get window.electron');
});

test('isAllowedOrigin does not honour such a wildcard even when it is already in config.json', () => {
  const trusted = SHARED_SUFFIXES.filter((suffix) => {
    const security = createSecurity({ getConfig: () => ({ extraAllowedOrigins: [`*.${suffix}`] }), isPackaged: true });
    return security.isAllowedOrigin(`https://attacker.${suffix}`);
  });
  assert.deepEqual(trusted, [], 'a site under these suffixes was trusted with the print and drawer API');
});

test('a wildcard over a company domain is still fine (the fix must not break the normal case)', () => {
  assert.equal(validateConnection({ extraAllowedOrigins: ['*.myshop.example'] }).ok, true);
  const security = createSecurity({ getConfig: () => ({ extraAllowedOrigins: ['*.myshop.example'] }), isPackaged: true });
  assert.equal(security.isAllowedOrigin('https://till.myshop.example'), true);
  assert.equal(security.isAllowedOrigin('https://myshop.example'), false);
});

test('SPEC 12: only the SUBDOMAINS of societyfiles.com are trusted by default, not the apex', () => {
  const security = createSecurity({ getConfig: () => ({}), isPackaged: true });
  assert.equal(security.isAllowedOrigin('https://vendor.societyfiles.com'), true);
  assert.equal(security.isAllowedOrigin('https://societyfiles.com'), false, 'the apex is not in the list of SPEC 12 (security.js BUILT_IN_ORIGINS adds it)');
});
