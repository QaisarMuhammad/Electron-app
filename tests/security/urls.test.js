'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity, isSafeExternalUrl, isLocalPageUrl } = require('../../src/main/security');

const UUID = '0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11';

function makeSecurity({ packaged = true, rendererDir } = {}) {
  return createSecurity({
    getConfig: () => ({ serverUrl: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy', extraAllowedOrigins: [] }),
    isPackaged: packaged,
    rendererDir,
  });
}

// ---------------------------------------------------------------------------------------------
// isAllowedWindowTarget
// ---------------------------------------------------------------------------------------------

test('isAllowedWindowTarget: allowed https origins, about:blank, and blob URLs of an allowed origin', () => {
  const { isAllowedWindowTarget } = makeSecurity();
  const allowed = [
    'https://gadgetspos.com',
    'https://gadgetspos.com/path?q=1#x',
    'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy',
    'about:blank',
    'about:blank#section',
    'about:blank?x=1',
    `blob:https://gadgetspos.com/${UUID}`,
    `blob:https://vendor.societyfiles.com/${UUID}`,
    `blob:https://app.gadgetspos.com/${UUID}#page=2`,
  ];
  for (const url of allowed) assert.equal(isAllowedWindowTarget(url), true, url);
});

test('isAllowedWindowTarget: everything else is refused', () => {
  const { isAllowedWindowTarget } = makeSecurity();
  const refused = [
    // foreign https and look-alikes
    'https://evil.com',
    'https://gadgetspos.com.evil.com',
    'https://gadgetspos.com@evil.com',
    'https://gadgetspos.com:8443',
    'http://gadgetspos.com',
    // about: other than blank
    'about:srcdoc',
    'about:config',
    'about:blank/../x',
    'about:blankx',
    'about:',
    // blobs of the wrong origin or built to confuse
    `blob:https://evil.com/${UUID}`,
    `blob:https://gadgetspos.com@evil.com/${UUID}`,
    `blob:https://user@gadgetspos.com/${UUID}`,
    `blob:https://gadgetspos.com.evil.com/${UUID}`,
    `blob:https://evil.com/https://gadgetspos.com/${UUID}`,
    `blob:http://gadgetspos.com/${UUID}`,
    `blob:null/${UUID}`,
    'blob:data:text/html,x',
    'blob:file:///etc/passwd',
    'blob:',
    'blob:blob:https://gadgetspos.com/x',
    // other schemes
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/calc.exe',
    'mailto:a@gadgetspos.com',
    'tel:+441234567890',
    'chrome://gpu',
    // not URLs
    '',
    undefined,
    null,
    42,
    {},
    ' about:blank',
    'about:blank\n',
  ];
  for (const url of refused) assert.equal(isAllowedWindowTarget(url), false, String(url));
});

test('isAllowedWindowTarget: dev servers are targets only while developing', () => {
  assert.equal(makeSecurity({ packaged: true }).isAllowedWindowTarget('http://localhost:3000/receipt'), false);
  assert.equal(makeSecurity({ packaged: false }).isAllowedWindowTarget('http://localhost:3000/receipt'), true);
  assert.equal(makeSecurity({ packaged: false }).isAllowedWindowTarget('blob:http://localhost:3000/' + UUID), true);
  assert.equal(makeSecurity({ packaged: true }).isAllowedWindowTarget('blob:http://localhost:3000/' + UUID), false);
});

// ---------------------------------------------------------------------------------------------
// isSafeExternalUrl
// ---------------------------------------------------------------------------------------------

test('isSafeExternalUrl: https, mailto and tel only', () => {
  const safe = [
    'https://example.com',
    'https://example.com/path?q=a%20b&r=1#frag',
    'HTTPS://EXAMPLE.COM/X',
    'https://sub.example.co.uk:8443/x',
    'https://203.0.113.7/',
    'https://[2001:db8::1]/',
    'https://xn--bcher-kva.example/',
    'mailto:support@example.com',
    'mailto:a@example.com,b@example.com?subject=Hello%20there&body=Line%201%0ALine%202',
    'MAILTO:support@example.com',
    'tel:+441234567890',
    'tel:01234567890',
    'tel:+44-123-456-7890',
  ];
  for (const url of safe) assert.equal(isSafeExternalUrl(url), true, url);
});

test('isSafeExternalUrl: every other protocol handler, and anything malformed, is refused', () => {
  const unsafe = [
    'http://example.com',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/calc.exe',
    'file:///etc/passwd',
    'blob:https://example.com/' + UUID,
    'about:blank',
    'ms-msdt:/id PCWDiagnostic /skip force /param "IT_RebrowseForFile=?"',
    'ms-msdt:-id PCWDiagnostic',
    'search-ms:query=x&crumb=location:\\\\evil\\share',
    'smb://evil/share',
    'ssh://evil.example',
    'steam://run/1',
    'slack://open',
    'chrome://settings',
    'view-source:https://example.com',
    'sms:+441234567890',
    'skype:echo123?call',
    '\\\\evil\\share\\file.exe',
    'C:\\Windows\\System32\\calc.exe',
    'https://user:pass@example.com',
    'https://example.com@evil.com',
    'https://@example.com',
    'https://',
    'https:///',
    'https:example.com/x',
    '//example.com',
    'example.com',
    '',
    ' https://example.com',
    'https://example.com ',
    'https://example.com/a b',
    'https://example.com/\r\nHost: evil.com',
    'https://example.com/\u0000',
    'https://exämple.com/',
    'mailto:a@example.com\r\nBcc: x@evil.com',
    'tel:+44 123',
    undefined,
    null,
    42,
    {},
    ['https://example.com'],
  ];
  for (const url of unsafe) assert.equal(isSafeExternalUrl(url), false, JSON.stringify(url));
});

test('isSafeExternalUrl: a URL over 8192 characters is refused', () => {
  assert.equal(isSafeExternalUrl(`https://example.com/${'a'.repeat(8000)}`), true);
  assert.equal(isSafeExternalUrl(`https://example.com/${'a'.repeat(9000)}`), false);
  assert.equal(isSafeExternalUrl(`mailto:a@example.com?body=${'a'.repeat(9000)}`), false);
});

test('isSafeExternalUrl: the same function is on the security object', () => {
  assert.equal(makeSecurity().isSafeExternalUrl, isSafeExternalUrl);
});

// ---------------------------------------------------------------------------------------------
// isLocalPageUrl
// ---------------------------------------------------------------------------------------------

const POSIX_DIR = '/Applications/Gadgets POS.app/Contents/Resources/app.asar/src/renderer';
const POSIX_URL = 'file:///Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/renderer';

test('isLocalPageUrl (posix): pages and assets strictly inside the renderer directory', () => {
  const inside = [
    `${POSIX_URL}/offline.html`,
    `${POSIX_URL}/loading.html`,
    `${POSIX_URL}/offline.html?reason=dns&code=-105&desc=ERR_NAME_NOT_RESOLVED&url=https%3A%2F%2Fvendor.societyfiles.com%2F`,
    `${POSIX_URL}/offline.html#details`,
    `${POSIX_URL}/offline.html?reason=dns#details`,
    `${POSIX_URL}/shared/tokens.css`,
    `${POSIX_URL}/a/b/c/d.js`,
    `${POSIX_URL}/dir/../offline.html`,
    `${POSIX_URL}/./offline.html`,
    `${POSIX_URL}//offline.html`,
    'file://localhost/Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/renderer/offline.html',
  ];
  for (const url of inside) assert.equal(isLocalPageUrl(url, POSIX_DIR, { platform: 'linux' }), true, url);
});

test('isLocalPageUrl (posix): the directory itself, its siblings, parents and traversals are refused', () => {
  const outside = [
    POSIX_URL,
    `${POSIX_URL}/`,
    `${POSIX_URL}/..`,
    `${POSIX_URL}/../main/index.js`,
    `${POSIX_URL}/../../index.html`,
    `${POSIX_URL}/%2e%2e/main/index.js`,
    `${POSIX_URL}/%2E%2E/%2E%2E/secret.html`,
    `${POSIX_URL}/..%2fmain/index.js`,
    `${POSIX_URL}/%2e%2e%2fmain/index.js`,
    `${POSIX_URL}%2F..%2Fmain%2Findex.js`,
    `${POSIX_URL}/sub/..%2f..%2fmain/x`,
    `${POSIX_URL}-evil/offline.html`,
    `${POSIX_URL}evil/offline.html`,
    'file:///Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/main/index.js',
    'file:///Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/renderer.html',
    'file:///Applications/Gadgets%20POS.app/Contents/Resources/app.asar/package.json',
    'file:///etc/passwd',
    'file:///',
    'file://evil.example/Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/renderer/offline.html',
    'file://server/share/offline.html',
    'https://gadgetspos.com/offline.html',
    'https://evil.example/Applications/Gadgets%20POS.app/Contents/Resources/app.asar/src/renderer/offline.html',
    'http://localhost/offline.html',
    `blob:${POSIX_URL}/offline.html`,
    'data:text/html,<script>1</script>',
    'javascript:alert(1)',
    'about:blank',
    '',
    undefined,
    null,
    42,
    {},
    ` ${POSIX_URL}/offline.html`,
    `${POSIX_URL}/offline.html `,
    `${POSIX_URL}/offline\n.html`,
  ];
  for (const url of outside) assert.equal(isLocalPageUrl(url, POSIX_DIR, { platform: 'linux' }), false, String(url));
});

test('isLocalPageUrl (posix): the renderer directory itself may be written in any equivalent form', () => {
  const url = `${POSIX_URL}/offline.html`;
  for (const dir of [POSIX_DIR, `${POSIX_DIR}/`, `${POSIX_DIR}/../renderer`, '/Applications/Gadgets POS.app/Contents/Resources/app.asar/src/./renderer']) {
    assert.equal(isLocalPageUrl(url, dir, { platform: 'linux' }), true, dir);
  }
});

test('isLocalPageUrl: an unusable renderer directory refuses everything', () => {
  const url = `${POSIX_URL}/offline.html`;
  for (const dir of [undefined, null, '', '   ', 'relative/dir', './renderer', 42, {}, ['/x']]) {
    assert.equal(isLocalPageUrl(url, dir, { platform: 'linux' }), false, String(dir));
  }
  assert.equal(isLocalPageUrl('file:///anything/at/all.html', '/', { platform: 'linux' }), true, 'the root contains everything below it');
});

const WIN_DIR = 'C:\\Program Files\\Gadgets POS\\resources\\app.asar\\src\\renderer';
const WIN_URL = 'file:///C:/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer';

test('isLocalPageUrl (win32): the real install path with spaces and the asar, any case of the drive and folders', () => {
  const inside = [
    `${WIN_URL}/offline.html`,
    `${WIN_URL}/offline.html?reason=offline&code=-106`,
    `${WIN_URL}/shared/tokens.css`,
    'file:///c:/program%20files/gadgets%20pos/resources/app.asar/src/renderer/offline.html',
    'file:///C:/PROGRAM%20FILES/GADGETS%20POS/RESOURCES/APP.ASAR/SRC/RENDERER/offline.html',
    `${WIN_URL}/sub/../offline.html`,
    `${WIN_URL}\\offline.html`,
    `${WIN_URL}/%2e%2e/renderer/offline.html`,
  ];
  for (const url of inside) assert.equal(isLocalPageUrl(url, WIN_DIR, { platform: 'win32' }), true, url);
});

test('isLocalPageUrl (win32): traversal, other drives, UNC shares and encoded separators are refused', () => {
  const outside = [
    WIN_URL,
    `${WIN_URL}/`,
    `${WIN_URL}/../main/index.js`,
    `${WIN_URL}\\..\\main\\index.js`,
    `${WIN_URL}/%2e%2e/main/index.js`,
    `${WIN_URL}/%5c..%5cmain%5cindex.js`,
    `${WIN_URL}/..%5cmain/index.js`,
    `${WIN_URL}/..%2fmain/index.js`,
    `${WIN_URL}-evil/offline.html`,
    'file:///D:/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer/offline.html',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'file:///C:/Program%20Files/Gadgets%20POS/resources/app.asar/src/main/index.js',
    'file://server/share/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer/offline.html',
    'file://evil/c$/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer/offline.html',
    'file:///C:/Program%20Files/Gadgets%20POS/resources/app.asar/src/renderer/%00.html',
  ];
  for (const url of outside) assert.equal(isLocalPageUrl(url, WIN_DIR, { platform: 'win32' }), false, url);
});

test('isLocalPageUrl (win32): a renderer directory on a UNC share works for pages on that share only', () => {
  const dir = '\\\\fileserver\\apps\\GadgetsPOS\\resources\\app.asar\\src\\renderer';
  assert.equal(isLocalPageUrl('file://fileserver/apps/GadgetsPOS/resources/app.asar/src/renderer/offline.html', dir, { platform: 'win32' }), true);
  assert.equal(isLocalPageUrl('file://other/apps/GadgetsPOS/resources/app.asar/src/renderer/offline.html', dir, { platform: 'win32' }), false);
  assert.equal(isLocalPageUrl('file:///C:/apps/GadgetsPOS/resources/app.asar/src/renderer/offline.html', dir, { platform: 'win32' }), false);
});

test('isLocalPageUrl (win32): a posix-looking directory is not absolute for Windows', () => {
  assert.equal(isLocalPageUrl(`${POSIX_URL}/offline.html`, 'src/renderer', { platform: 'win32' }), false);
});

test('isLocalPageUrl: the platform defaults to the running one and the security object binds the directory', () => {
  const dir = process.platform === 'win32' ? 'C:\\app\\src\\renderer' : '/app/src/renderer';
  const url = process.platform === 'win32' ? 'file:///C:/app/src/renderer/offline.html' : 'file:///app/src/renderer/offline.html';
  assert.equal(isLocalPageUrl(url, dir), true);

  const security = makeSecurity({ rendererDir: dir });
  assert.equal(security.isLocalPageUrl(url), true);
  assert.equal(security.isLocalPageUrl(url, dir + 'x'), false);
  assert.equal(makeSecurity().isLocalPageUrl(url), false, 'no directory configured: nothing is local');
});
