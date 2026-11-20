'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'label-design', 'catalog.json'), 'utf8'));

test('the committed label catalog is exactly what scripts/label-design/export-catalog.js writes now (run it again after changing a template or plan.js)', () => {
  const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')), 'catalog.json');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'label-design', 'export-catalog.js'), temp], { stdio: 'pipe' });
  assert.deepEqual(JSON.parse(fs.readFileSync(temp, 'utf8')), committed);
});

test('every design the picker offers has a plan at every size, with the object roles filled from the real plan', () => {
  for (const size of Object.keys(committed.sizes)) {
    for (const design of committed.designs) {
      const entry = committed.plans[size][design.id];
      assert.ok(entry && entry.plain, `${size} design ${design.id}`);
      for (const variant of Object.values(entry)) {
        assert.ok(committed.templates[variant.template], `${variant.template} has geometry`);
        const names = new Set(committed.templates[variant.template].objects.map((object) => object.name));
        for (const name of Object.keys(variant.roles)) assert.ok(names.has(name), `${variant.template}: ${name} is an object of the template`);
      }
    }
  }
});

test('catalog version: designs newer than version 0 name the version that introduced them, and the catalog says its own version', () => {
  assert.equal(committed.catalogVersion, 1);
  assert.ok(committed.designs.every((design) => Number.isInteger(design.since) && design.since <= committed.catalogVersion));
  assert.deepEqual(committed.designs.filter((design) => design.since === 0).map((design) => design.id), [1, 2, 3, 4, 'repair']);
});

test('the defaults are the existing behaviour: design 1 at 32x57', () => {
  assert.deepEqual(committed.defaults, { size: '32x57', design: 1 });
});

test('every shop design is grouped, named and explained in plain words', () => {
  for (const design of committed.designs) {
    assert.ok(design.group && design.name && design.hint.length > 20, String(design.id));
    assert.ok(design.hint.length < 140, `${design.id}: a hint fits under a thumbnail`);
  }
});

test('the Desktop app announces the catalog version it prints (feature label-designs-<version>), so the dashboard can offer only designs the app supports', () => {
  const { FEATURES } = require('../../src/main/ipc');
  assert.ok(FEATURES.includes(`label-designs-${committed.catalogVersion}`));
});
