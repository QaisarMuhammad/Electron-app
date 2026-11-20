'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyLoadFailure, httpStatusToReason, describeNetError, REASONS, NET_ERROR_CODES } = require('../../src/main/connectivity');

/** SPEC 11.2, one row per case: [code, description, expected reason]. */
const LOAD_FAILURES = [
  // offline
  [-106, 'ERR_INTERNET_DISCONNECTED', 'offline'],
  [-21, 'ERR_NETWORK_CHANGED', 'offline'],
  // dns
  [-105, 'ERR_NAME_NOT_RESOLVED', 'dns'],
  // refused
  [-102, 'ERR_CONNECTION_REFUSED', 'refused'],
  [-101, 'ERR_CONNECTION_RESET', 'refused'],
  [-100, 'ERR_CONNECTION_CLOSED', 'refused'],
  // timeout
  [-7, 'ERR_TIMED_OUT', 'timeout'],
  [-118, 'ERR_CONNECTION_TIMED_OUT', 'timeout'],
  // tls: the certificate family -200..-299 and the SSL errors
  [-200, 'ERR_CERT_COMMON_NAME_INVALID', 'tls'],
  [-201, 'ERR_CERT_DATE_INVALID', 'tls'],
  [-202, 'ERR_CERT_AUTHORITY_INVALID', 'tls'],
  [-206, 'ERR_CERT_REVOKED', 'tls'],
  [-214, 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED', 'tls'],
  [-299, 'ERR_CERT_END', 'tls'],
  [-107, 'ERR_SSL_PROTOCOL_ERROR', 'tls'],
  [-113, 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'tls'],
  // other
  [-2, 'ERR_FAILED', 'other'],
  [-109, 'ERR_ADDRESS_UNREACHABLE', 'other'],
  [-324, 'ERR_EMPTY_RESPONSE', 'other'],
  [-20, 'ERR_BLOCKED_BY_CLIENT', 'other'],
  [-300, 'ERR_INVALID_URL', 'other'],
  [-3, 'ERR_ABORTED', 'other'],
  [-1000, 'ERR_SOMETHING_NEW', 'other'],
];

test('classifyLoadFailure: the SPEC 11.2 table, by numeric code and by name together', () => {
  for (const [code, description, reason] of LOAD_FAILURES) {
    assert.deepEqual(classifyLoadFailure(code, description), { reason }, `${code} ${description}`);
  }
});

test('classifyLoadFailure: the numeric code alone is enough for the codes of the table', () => {
  assert.equal(classifyLoadFailure(-106).reason, 'offline');
  assert.equal(classifyLoadFailure(-21).reason, 'offline');
  assert.equal(classifyLoadFailure(-105).reason, 'dns');
  assert.equal(classifyLoadFailure(-102).reason, 'refused');
  assert.equal(classifyLoadFailure(-101).reason, 'refused');
  assert.equal(classifyLoadFailure(-100).reason, 'refused');
  assert.equal(classifyLoadFailure(-7).reason, 'timeout');
  assert.equal(classifyLoadFailure(-118).reason, 'timeout');
  assert.equal(classifyLoadFailure(-107).reason, 'tls');
  for (let code = -200; code >= -299; code -= 1) assert.equal(classifyLoadFailure(code).reason, 'tls', String(code));
});

test('classifyLoadFailure: the name alone is enough, with or without ERR_ and net::, in any case', () => {
  const names = [
    ['ERR_NAME_NOT_RESOLVED', 'dns'],
    ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
    ['NAME_NOT_RESOLVED', 'dns'],
    ['err_connection_refused', 'refused'],
    ['  net::ERR_INTERNET_DISCONNECTED  ', 'offline'],
    ['ERR_CERT_AUTHORITY_INVALID', 'tls'],
    ['ERR_CERTIFICATE_TRANSPARENCY_REQUIRED', 'tls'],
    ['ERR_SSL_BAD_PEER_PUBLIC_KEY', 'tls'],
    ['ERR_SSL_SOMETHING_FUTURE', 'tls'],
    ['ERR_CERT_SOMETHING_FUTURE', 'tls'],
  ];
  for (const [description, reason] of names) {
    assert.equal(classifyLoadFailure(undefined, description).reason, reason, description);
  }
});

test('classifyLoadFailure: the code can arrive as a numeric string', () => {
  assert.equal(classifyLoadFailure('-106').reason, 'offline');
  assert.equal(classifyLoadFailure(' -105 ').reason, 'dns');
});

test('classifyLoadFailure: unknown, missing and malformed input is "other", never a throw', () => {
  const inputs = [
    [undefined, undefined],
    [null, null],
    [0, ''],
    [NaN, 'not an error'],
    [1.5, undefined],
    [{}, []],
    ['abc', 'The Internet connection appears to be offline.'],
    [Infinity, 'ERR_'],
    [-9999, 'ERR_NOT_A_REAL_ERROR'],
  ];
  for (const [code, description] of inputs) {
    assert.deepEqual(classifyLoadFailure(code, description), { reason: 'other' }, `${String(code)} ${String(description)}`);
  }
  assert.deepEqual(classifyLoadFailure(), { reason: 'other' });
});

test('classifyLoadFailure: a certificate lookalike that is not an ERR_CERT/ERR_SSL name stays "other"', () => {
  for (const description of ['ERR_NOT_A_CERT_ERROR', 'ERR_BAD_SSL_CLIENT_AUTH_CERT', 'ERR_PROXY_CERTIFICATE_INVALID', 'ERR_CONNECTION_TIMEOUT']) {
    assert.equal(classifyLoadFailure(undefined, description).reason, 'other', description);
  }
});

test('every reason that classifyLoadFailure returns is a documented value of the status', () => {
  for (const [code, description] of LOAD_FAILURES) {
    assert.ok(REASONS.includes(classifyLoadFailure(code, description).reason));
  }
  assert.deepEqual([...REASONS], ['offline', 'dns', 'refused', 'timeout', 'tls', 'server', 'other']);
});

test('httpStatusToReason: 500 and above is "server", everything else is not a failure', () => {
  for (const status of [500, 501, 502, 503, 504, 520, 599, '503', ' 502 ']) assert.equal(httpStatusToReason(status), 'server', String(status));
  for (const status of [100, 200, 204, 301, 302, 304, 400, 401, 403, 404, 429, 499]) assert.equal(httpStatusToReason(status), null, String(status));
  for (const status of [undefined, null, '', 'abc', NaN, {}, [], -1, 0]) assert.equal(httpStatusToReason(status), null, String(status));
});

test('describeNetError: the shapes a failed request can have', () => {
  assert.deepEqual(describeNetError(new Error('net::ERR_NAME_NOT_RESOLVED')), { code: -105, description: 'ERR_NAME_NOT_RESOLVED' });
  assert.deepEqual(describeNetError('net::ERR_CONNECTION_REFUSED'), { code: -102, description: 'ERR_CONNECTION_REFUSED' });
  assert.deepEqual(describeNetError('ERR_CERT_DATE_INVALID'), { code: -201, description: 'ERR_CERT_DATE_INVALID' });
  assert.deepEqual(describeNetError({ code: -106, description: 'ERR_INTERNET_DISCONNECTED' }), { code: -106, description: 'ERR_INTERNET_DISCONNECTED' });
  assert.deepEqual(describeNetError({ code: '-7' }), { code: -7, description: 'ERR_TIMED_OUT' });
  assert.deepEqual(describeNetError({ code: 503, description: 'HTTP 503' }), { code: 503, description: 'HTTP 503' });
  // A name this table does not know keeps its text and has no code.
  assert.deepEqual(describeNetError('net::ERR_SOMETHING_NEW'), { code: null, description: 'ERR_SOMETHING_NEW' });
  // A bare word is free text, not an error name, unless this table knows it.
  assert.deepEqual(describeNetError(new Error('boom')), { code: null, description: 'boom' });
  assert.deepEqual(describeNetError('NAME_NOT_RESOLVED'), { code: -105, description: 'ERR_NAME_NOT_RESOLVED' });
  // Free text is kept, trimmed and capped.
  assert.deepEqual(describeNetError(new Error('getaddrinfo ENOTFOUND vendor.example')), { code: null, description: 'getaddrinfo ENOTFOUND vendor.example' });
  assert.equal(describeNetError('x'.repeat(500) + ' y').description.length, 200);
  assert.deepEqual(describeNetError(undefined), { code: null, description: 'Unknown error' });
  assert.deepEqual(describeNetError(null), { code: null, description: 'Unknown error' });
  assert.deepEqual(describeNetError(''), { code: null, description: 'Unknown error' });
});

test('the code table agrees with the numbers of SPEC 11.2', () => {
  assert.equal(NET_ERROR_CODES.INTERNET_DISCONNECTED, -106);
  assert.equal(NET_ERROR_CODES.NAME_NOT_RESOLVED, -105);
  assert.equal(NET_ERROR_CODES.CONNECTION_REFUSED, -102);
  assert.equal(NET_ERROR_CODES.CONNECTION_RESET, -101);
  assert.equal(NET_ERROR_CODES.CONNECTION_CLOSED, -100);
  assert.equal(NET_ERROR_CODES.TIMED_OUT, -7);
  assert.equal(NET_ERROR_CODES.CONNECTION_TIMED_OUT, -118);
  assert.equal(NET_ERROR_CODES.NETWORK_CHANGED, -21);
  assert.equal(NET_ERROR_CODES.SSL_PROTOCOL_ERROR, -107);
  assert.equal(NET_ERROR_CODES.ABORTED, -3);
  // No two names share a code (the reverse lookup depends on it).
  const codes = Object.values(NET_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
});
