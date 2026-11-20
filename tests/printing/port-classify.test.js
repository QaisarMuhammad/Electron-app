'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPort, PORT_INVALID_MESSAGE, MAX_TARGET_LENGTH } = require('../../src/main/printing/transports/win32-port');

test('DOS devices are accepted in any case and always returned in the \\\\.\\ device namespace', () => {
  const cases = [
    ['LPT1', '\\\\.\\LPT1'],
    ['lpt1:', '\\\\.\\LPT1'],
    ['  LPT9  ', '\\\\.\\LPT9'],
    ['LPT1\n', '\\\\.\\LPT1'],
    ['Lpt5', '\\\\.\\LPT5'],
    ['PRN', '\\\\.\\PRN'],
    ['prn:', '\\\\.\\PRN'],
    ['COM1', '\\\\.\\COM1'],
    ['com9', '\\\\.\\COM9'],
    ['COM10', '\\\\.\\COM10'],
    ['COM99', '\\\\.\\COM99'],
    ['COM100', '\\\\.\\COM100'],
    ['COM255', '\\\\.\\COM255'],
    ['com256', '\\\\.\\COM256'],
    ['\\\\.\\COM3', '\\\\.\\COM3'],
    ['\\\\.\\lpt1', '\\\\.\\LPT1'],
    ['\\\\.\\LPT1:', '\\\\.\\LPT1'],
    ['\\\\.\\prn', '\\\\.\\PRN'],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(classifyPort(raw), { kind: 'device', path: expected }, raw);
  }
});

test('UNC printer shares are accepted as typed (trimmed)', () => {
  const shares = [
    '\\\\localhost\\ZebraZD420',
    '\\\\localhost\\Zebra ZD420',
    '\\\\192.168.1.20\\TM-T20',
    '\\\\SHOP-PC\\EPSON_TM (USB)',
    '\\\\shop.example.local\\Label.Printer',
    '\\\\k\u00fcche\\Dr\u00fccker',
    '\\\\host\\\u30d7\u30ea\u30f3\u30bf\u30fc',
  ];
  for (const share of shares) {
    assert.deepEqual(classifyPort(share), { kind: 'unc', path: share }, share);
    assert.deepEqual(classifyPort(`  ${share}\t`), { kind: 'unc', path: share }, `padded ${share}`);
  }
});

test('everything else is invalid and yields an empty path', () => {
  const invalid = [
    'COM257', 'COM0', 'COM01', 'COM1000', 'LPT0', 'LPT10', 'LPT', 'COM', 'PR', 'PRN1',
    'USB001', 'USB', 'DOT4_001', 'Zebra ZD420', 'NUL', 'CON', 'AUX', 'FILE:',
    'LPT1&calc', 'LPT1;calc', 'LPT1|x', 'LPT1>x', 'LPT1<x', 'LPT1^x', 'LPT1%', 'LPT1!', 'LPT1,x', 'LPT1=x', 'LPT1\'', 'LPT1"',
    'C:\\x', 'C:\\Windows\\System32\\drivers\\etc\\hosts', '..\\x', '.\\x', '\\x', '/dev/lp0', '~/x',
    '\\\\?\\C:\\x', '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\x', '\\\\.\\C:', '\\\\.\\.', '\\\\.\\PhysicalDrive0', '\\\\.\\LPT1\\x', '\\\\.\\LPT10',
    '\\\\host\\a\\b', '\\\\host\\', '\\\\host', '\\\\\\share', '\\\\..\\share', '\\\\host\\.', '\\\\host\\..', '\\\\host\\ ', '\\\\ho st\\share',
    '\\\\host\\100%', '\\\\host\\%TEMP%', '\\\\host\\a&b', '\\\\host\\a|b', '\\\\host\\a;b', '\\\\host\\a,b', '\\\\host\\a=b', '\\\\host\\a!b',
    '\\\\host\\a^b', '\\\\host\\a<b', '\\\\host\\a>b', '\\\\host\\a"b', '\\\\host\\a\'b', '\\\\host\\a$b', '\\\\host\\a`b',
    'LPT1\r\ncalc', 'LP\nT1', 'LPT1\0', '\\\\host\\sh\u0007are', '\\\\host\\sh\u0085are',
  ];
  for (const raw of invalid) {
    const result = classifyPort(raw);
    assert.equal(result.kind, 'invalid', JSON.stringify(raw));
    assert.equal(result.path, '', JSON.stringify(raw));
    assert.equal(typeof result.reason, 'string', JSON.stringify(raw));
  }
});

test('non-strings and blank values are invalid with reason "empty"', () => {
  for (const raw of [undefined, null, 42, {}, [], true, '', '   ', '\t\n']) {
    assert.deepEqual(classifyPort(raw), { kind: 'invalid', path: '', reason: 'empty' });
  }
});

test('the reason says why a port was refused', () => {
  assert.equal(classifyPort('x'.repeat(MAX_TARGET_LENGTH + 1)).reason, 'too-long');
  assert.equal(classifyPort(`\\\\host\\${'a'.repeat(MAX_TARGET_LENGTH)}`).reason, 'too-long');
  assert.equal(classifyPort('LPT1\ncalc').reason, 'control-character');
  assert.equal(classifyPort('LPT1\0').reason, 'control-character');
  assert.equal(classifyPort('LPT1&calc').reason, 'forbidden-character');
  assert.equal(classifyPort('\\\\host\\100%').reason, 'forbidden-character');
  assert.equal(classifyPort('USB001').reason, 'unsupported-form');
  assert.equal(classifyPort('C:\\x').reason, 'unsupported-form');
});

test('a share name of exactly the maximum length is still checked by shape, not cut', () => {
  const host = '\\\\h\\';
  const share = host + 'a'.repeat(MAX_TARGET_LENGTH - host.length);
  assert.equal(share.length, MAX_TARGET_LENGTH);
  assert.equal(classifyPort(share).kind, 'unc');
});

test('every forbidden character is refused in every position of both accepted shapes', () => {
  for (const char of '"\'&|<>^%!,;=') {
    for (const raw of [`LPT1${char}`, `${char}LPT1`, `\\\\host\\sh${char}are`, `\\\\ho${char}st\\share`, `\\\\.\\LPT1${char}`]) {
      assert.equal(classifyPort(raw).kind, 'invalid', JSON.stringify(raw));
    }
  }
});

test('an accepted result never contains a character that cmd.exe would re-parse', () => {
  const samples = ['LPT1', 'com3:', '\\\\.\\COM12', '\\\\localhost\\Zebra ZD420', '\\\\SHOP-PC\\TM_T20.v2'];
  for (const raw of samples) {
    const { kind, path } = classifyPort(raw);
    assert.notEqual(kind, 'invalid');
    assert.doesNotMatch(path, /["'&|<>^%!,;=\u0000-\u001f]/);
  }
});

test('the refusal message is the SPEC text and is plain English', () => {
  assert.equal(
    PORT_INVALID_MESSAGE,
    'This port name cannot be used. Choose the installed printer, or a shared printer address such as \\\\localhost\\ZebraZD420.',
  );
});
