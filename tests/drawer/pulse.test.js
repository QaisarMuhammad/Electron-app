'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDrawerPulse } = require('../../src/main/printing/drawer');
const { DEFAULTS } = require('../../src/main/config');

const hex = (buffer) => buffer.toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1 ');

test('the default config yields exactly the v1 bytes 1B 70 00 19 FF (SPEC 10)', () => {
  assert.equal(hex(buildDrawerPulse({ pin: 2, onTimeMs: 50, offTimeMs: 510 })), '1B 70 00 19 FF');
  assert.equal(hex(buildDrawerPulse(DEFAULTS.drawer)), '1B 70 00 19 FF', 'the defaults of config.js, not just literal numbers');
  assert.deepEqual([...buildDrawerPulse({ pin: 2, onTimeMs: 50, offTimeMs: 510 })], [0x1b, 0x70, 0x00, 0x19, 0xff]);
});

test('it is a 5-byte Buffer: ESC p m t1 t2', () => {
  const pulse = buildDrawerPulse({ pin: 2, onTimeMs: 50, offTimeMs: 510 });
  assert.ok(Buffer.isBuffer(pulse));
  assert.equal(pulse.length, 5);
  assert.equal(pulse[0], 0x1b, 'ESC');
  assert.equal(pulse[1], 0x70, 'p');
});

test('pin 5 sets m to 1: 1B 70 01 19 FF', () => {
  assert.equal(hex(buildDrawerPulse({ pin: 5, onTimeMs: 50, offTimeMs: 510 })), '1B 70 01 19 FF');
});

test('any pin other than 5 is pin 2', () => {
  for (const pin of [2, 0, 1, 3, 4, 6, '5', '2', null, undefined, Number.NaN, {}, [5], true]) {
    assert.equal(buildDrawerPulse({ pin, onTimeMs: 50, offTimeMs: 510 })[2], 0, String(pin));
  }
});

test('lengths are counted in units of 2 ms and clamped to 1..255: 2 ms -> 01, 510 ms -> FF, 1000 ms -> FF (SPEC 16)', () => {
  const on = (ms) => buildDrawerPulse({ pin: 2, onTimeMs: ms, offTimeMs: 510 })[3];
  const off = (ms) => buildDrawerPulse({ pin: 2, onTimeMs: 50, offTimeMs: ms })[4];
  const table = [
    [2, 0x01],
    [4, 0x02],
    [50, 0x19],
    [100, 0x32],
    [254, 0x7f],
    [255, 0x80], // 127.5 rounds up
    [256, 0x80],
    [508, 0xfe],
    [510, 0xff],
    [511, 0xff],
    [1000, 0xff],
    [100000, 0xff],
  ];
  for (const [ms, expected] of table) {
    assert.equal(on(ms), expected, `on ${ms} ms`);
    assert.equal(off(ms), expected, `off ${ms} ms`);
  }
});

test('lengths below 2 ms are raised to the smallest unit (0 would mean "no pulse" to a printer)', () => {
  for (const ms of [1, 0, -1, -1000, 0.4]) {
    assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: ms, offTimeMs: ms })[3], 0x01, String(ms));
    assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: ms, offTimeMs: ms })[4], 0x01, String(ms));
  }
});

test('odd lengths round to the nearest unit (round half up), as SPEC 5.1 says: round(ms / 2)', () => {
  assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: 3, offTimeMs: 51 })[3], 2);
  assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: 3, offTimeMs: 51 })[4], 26);
  assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: 49, offTimeMs: 509 })[3], 25);
  assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: 49, offTimeMs: 509 })[4], 255);
});

test('the on time and the off time are independent bytes', () => {
  assert.equal(hex(buildDrawerPulse({ pin: 5, onTimeMs: 100, offTimeMs: 400 })), '1B 70 01 32 C8');
  assert.equal(hex(buildDrawerPulse({ pin: 2, onTimeMs: 2, offTimeMs: 2 })), '1B 70 00 01 01');
  assert.equal(hex(buildDrawerPulse({ pin: 5, onTimeMs: 510, offTimeMs: 510 })), '1B 70 01 FF FF');
});

test('missing settings fall back to the defaults (so the result is still v1\'s bytes)', () => {
  for (const settings of [undefined, null, {}, { pin: undefined }, 5, 'x', []]) {
    assert.equal(hex(buildDrawerPulse(settings)), '1B 70 00 19 FF', JSON.stringify(settings));
  }
  assert.equal(hex(buildDrawerPulse({ pin: 5 })), '1B 70 01 19 FF');
  assert.equal(hex(buildDrawerPulse({ onTimeMs: 100 })), '1B 70 00 32 FF');
  assert.equal(hex(buildDrawerPulse({ offTimeMs: 100 })), '1B 70 00 19 32');
});

test('a length that is not a usable number falls back to its default', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, '100', null, undefined, {}, [100], true]) {
    assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: bad, offTimeMs: bad })[3], 0x19, `on ${String(bad)}`);
    assert.equal(buildDrawerPulse({ pin: 2, onTimeMs: bad, offTimeMs: bad })[4], 0xff, `off ${String(bad)}`);
  }
});

test('each call returns a new Buffer', () => {
  const a = buildDrawerPulse({});
  const b = buildDrawerPulse({});
  assert.notEqual(a, b);
  a[2] = 9;
  assert.equal(b[2], 0);
});
