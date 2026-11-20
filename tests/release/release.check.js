'use strict';

/**
 * `npm run release:check`: the owner release gates, one test each (tests/release/gates.js says what they are). It exits with 1 while any
 * gate is open and names every open one with what it protects and how to close it, so `npm run dist` (package.json `predist`) refuses
 * to build an installer that is not ready to be published. It is not part of `npm test`: the name ends in `.check.js`, which the
 * unit suite's glob does not match.
 *
 *   npm run release:check
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runGates } = require('./gates');

const ROOT = path.join(__dirname, '..', '..');

runGates(ROOT).forEach((gate, index) => {
  test(`owner release gate ${index + 1} (${gate.id}): ${gate.title}`, () => {
    assert.ok(gate.ok, `OPEN. ${gate.detail}\n  What it protects: ${gate.protects}.\n  To close it: ${gate.fix}.`);
  });
});
