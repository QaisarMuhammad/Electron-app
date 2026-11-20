'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEarlyConfigSync, createDeferredConfig } = require('../../src/main/earlyConfig');
const { DEFAULTS } = require('../../src/main/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-early-'));
}

test('readEarlyConfigSync reads config.json, ignores a byte-order mark, and answers {} for anything unusable', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readEarlyConfigSync(dir), {}, 'no file');
    fs.writeFileSync(path.join(dir, 'config.json'), '﻿{"serverUrl":"https://pos.example.com/","window":{"maximized":true}}');
    assert.deepEqual(readEarlyConfigSync(dir), { serverUrl: 'https://pos.example.com/', window: { maximized: true } });
    for (const text of ['{ broken', '', '[1,2]', 'null', '"text"']) {
      fs.writeFileSync(path.join(dir, 'config.json'), text);
      assert.deepEqual(readEarlyConfigSync(dir), {}, `content ${JSON.stringify(text)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('before the real config exists a setting comes from what was written, then the file, then the default, then the fallback', () => {
  const early = createDeferredConfig({ early: { window: { maximized: true, bounds: { x: 1, y: 2, width: 800, height: 600 } } }, defaults: DEFAULTS });
  assert.equal(early.get('window.maximized', false), true, 'from the file');
  assert.deepEqual(early.get('window.bounds', null), { x: 1, y: 2, width: 800, height: 600 });
  assert.equal(early.get('window.zoomLevel', 9), 0, 'the default of the schema wins over the fallback');
  assert.equal(early.get('serverUrl'), DEFAULTS.serverUrl, 'a fresh install still knows its server');
  assert.equal(early.get('no.such.setting', 'fallback'), 'fallback');
  assert.equal(early.get('__proto__.x', 'safe'), 'safe');
  early.set('window.maximized', false);
  assert.equal(early.get('window.maximized', true), false, 'a write is visible at once');
});

test('values are copies: changing one never changes what the next read returns', () => {
  const early = createDeferredConfig({ early: { window: { bounds: { x: 1, y: 2, width: 3, height: 4 } } }, defaults: {} });
  const bounds = early.get('window.bounds');
  bounds.x = 99;
  assert.equal(early.get('window.bounds').x, 1);
});

test('attach replays, in order, what was written before the real config existed, then everything is the real config', () => {
  const early = createDeferredConfig({ early: {}, defaults: DEFAULTS });
  assert.deepEqual(early.set('window.bounds', { x: 5, y: 6, width: 700, height: 500 }), { ok: true });
  early.set('window.maximized', true);
  early.set('window.maximized', false);
  assert.equal(early.isAttached(), false);

  const calls = [];
  const real = { get: (key, fallback) => (key === 'serverUrl' ? 'https://real.example.com/' : fallback), set: (key, value) => (calls.push([key, value]), { ok: true, from: 'real' }) };
  early.attach(real);
  assert.deepEqual(calls, [['window.bounds', { x: 5, y: 6, width: 700, height: 500 }], ['window.maximized', true], ['window.maximized', false]]);
  assert.equal(early.isAttached(), true);
  assert.equal(early.get('serverUrl'), 'https://real.example.com/');
  assert.deepEqual(early.set('window.zoomLevel', 1), { ok: true, from: 'real' }, 'after attach the answer is the real one');
  assert.deepEqual(calls.at(-1), ['window.zoomLevel', 1]);
  early.attach(real);
  assert.equal(calls.length, 4, 'a second attach replays nothing');
});

test('a write that cannot be remembered is refused instead of being lost', () => {
  const early = createDeferredConfig({ early: {}, defaults: {} });
  assert.equal(early.set('', 1).ok, false);
  assert.equal(early.set('a.__proto__.b', 1).ok, false);
  assert.equal(early.set('window.zoomLevel', undefined).ok, false);
});
