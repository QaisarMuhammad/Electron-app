'use strict';

/**
 * The fake Store (tests/helpers/fake-store.js) must behave like the real electron-store, because the config and
 * migration tests are written against it. Each scenario below runs the SAME operations on the fake and on the real
 * class (conf 13, imported under plain Node with an explicit `cwd`) and compares what they leave on disk and what
 * they throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeStoreEnv } = require('../helpers/fake-store');

const WINDOWS = process.platform === 'win32';

/** Run `scenario(Store, dir)` for the fake and for the real electron-store, each in its own folder; returns both results. */
async function runBoth(t, scenario, { before } = {}) {
  const { default: RealStore } = await import('electron-store');

  const fakeEnv = createFakeStoreEnv();
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-real-store-'));
  t.after(() => {
    fakeEnv.cleanup();
    fs.rmSync(realDir, { recursive: true, force: true });
  });
  if (before) {
    before(fakeEnv.dir);
    before(realDir);
  }
  class DirStore extends RealStore {
    constructor(options) {
      super({ ...options, cwd: realDir });
    }
  }
  const fake = await scenario(fakeEnv.Store, fakeEnv.dir);
  const real = await scenario(DirStore, realDir);
  return { fake, real };
}

const readJson = (dir) => {
  const file = path.join(dir, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const errorOf = (action) => {
  try {
    action();
    return null;
  } catch (error) {
    return { name: error.name, message: error.message };
  }
};

test('constructor with defaults and no file: the merged defaults are WRITTEN (the trap SPEC 5.2 avoids)', async (t) => {
  const { fake, real } = await runBoth(t, (Store, dir) => {
    new Store({ defaults: { schemaVersion: 2, a: { x: 1 }, b: 2 } });
    return readJson(dir);
  });
  assert.deepEqual(real, { schemaVersion: 2, a: { x: 1 }, b: 2 });
  assert.deepEqual(fake, real);
});

test('constructor with defaults and a v1 file: stored values win per top-level key, nested objects are NOT merged, the file is rewritten', async (t) => {
  const { fake, real } = await runBoth(
    t,
    (Store, dir) => {
      new Store({ defaults: { schemaVersion: 2, a: { x: 1, y: 2 }, b: 2 } });
      return readJson(dir);
    },
    { before: (dir) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: { x: 9 }, printerName: 'EPSON' })) },
  );
  assert.deepEqual(real, { schemaVersion: 2, a: { x: 9 }, b: 2, printerName: 'EPSON' });
  assert.deepEqual(fake, real);
});

test('constructor WITHOUT defaults leaves an existing file byte for byte as it was, and creates nothing for a missing file', async (t) => {
  const original = '{"printerName":"EPSON",   "password":"1234"}';
  const { fake, real } = await runBoth(
    t,
    (Store, dir) => {
      const store = new Store({ configFileMode: 0o600 });
      return { text: fs.readFileSync(store.path, 'utf8'), file: path.basename(store.path), parsed: store.store };
    },
    { before: (dir) => fs.writeFileSync(path.join(dir, 'config.json'), original) },
  );
  assert.equal(real.text, original);
  assert.deepEqual(fake, real);

  const missing = await runBoth(t, (Store, dir) => {
    new Store({ configFileMode: 0o600 });
    return fs.existsSync(path.join(dir, 'config.json'));
  });
  assert.equal(missing.real, false);
  assert.equal(missing.fake, missing.real);
});

test('set, set with an object of dot paths (one write), delete (leaves the empty parent), clear and the store setter', async (t) => {
  const { fake, real } = await runBoth(t, (Store, dir) => {
    const store = new Store();
    const steps = [];
    store.set('a.b', 1);
    steps.push(readJson(dir));
    store.set({ 'c.d': 2, e: 3, 'a.f': 4 });
    steps.push(readJson(dir));
    store.set('a', { replaced: true });
    steps.push(readJson(dir));
    store.delete('c.d');
    steps.push(readJson(dir));
    store.delete('does.not.exist');
    steps.push(readJson(dir));
    store.store = { whole: { file: 'replaced' } };
    steps.push(readJson(dir));
    steps.push([store.get('whole.file'), store.get('whole.nope', 'fallback'), store.get('nope.deeper'), store.has('whole'), store.has('whole.file'), store.has('nope')]);
    store.clear();
    steps.push(readJson(dir));
    return steps;
  });
  assert.deepEqual(real[0], { a: { b: 1 } });
  assert.deepEqual(real[3], { a: { replaced: true }, c: {}, e: 3 });
  assert.deepEqual(real[6], ['replaced', 'fallback', undefined, true, true, false]);
  assert.deepEqual(fake, real);
});

test('what set() refuses, and the exact messages', async (t) => {
  const { fake, real } = await runBoth(t, (Store) => {
    const store = new Store();
    return {
      undefinedValue: errorOf(() => store.set('k', undefined)),
      fn: errorOf(() => store.set('k', () => {})),
      symbol: errorOf(() => store.set('k', Symbol('s'))),
      numberKey: errorOf(() => store.set(5, 1)),
      internal: errorOf(() => store.set('__internal__.x', 1)),
      internalObject: errorOf(() => store.set({ __internal__: 1 })),
      undefinedInObject: errorOf(() => store.set({ ok: 1, bad: undefined })),
    };
  });
  assert.equal(real.undefinedValue.name, 'TypeError');
  assert.match(real.undefinedValue.message, /delete/);
  assert.deepEqual(fake, real);
});

test('a corrupt file, and an empty (0-byte) file: SyntaxError, unless clearInvalidConfig is set (the file is then left alone)', async (t) => {
  for (const content of ['{ not json', '']) {
    const { fake, real } = await runBoth(
      t,
      (Store, dir) => {
        const error = errorOf(() => new Store());
        const cleared = new Store({ clearInvalidConfig: true });
        return { error, store: cleared.store, fileAfter: fs.readFileSync(path.join(dir, 'config.json'), 'utf8') };
      },
      { before: (dir) => fs.writeFileSync(path.join(dir, 'config.json'), content) },
    );
    assert.equal(real.error.name, 'SyntaxError');
    assert.deepEqual({ ...real.store }, {});
    assert.equal(real.fileAfter, content);
    assert.deepEqual(fake, real, JSON.stringify(content));
  }
});

test('onDidAnyChange: fires synchronously with (new, old) for real changes only', async (t) => {
  const { fake, real } = await runBoth(t, (Store) => {
    const store = new Store();
    const calls = [];
    const off = store.onDidAnyChange((next, old) => calls.push({ next: { ...next }, old: { ...old } }));
    store.set('a', 1);
    store.set('a', 1); // identical content: no callback
    store.set('a', 2);
    store.delete('a');
    off();
    store.set('a', 3); // unsubscribed
    return calls;
  });
  assert.equal(real.length, 3);
  assert.deepEqual(real[0], { next: { a: 1 }, old: {} });
  assert.deepEqual(fake, real);
});

test('the file mode requested with configFileMode is applied to the file, on every write', { skip: WINDOWS && 'POSIX file modes only' }, async (t) => {
  const { fake, real } = await runBoth(t, (Store, dir) => {
    const store = new Store({ configFileMode: 0o600 });
    store.set('a', 1);
    const first = fs.statSync(store.path).mode & 0o777;
    store.set('a', 2);
    return { first, second: fs.statSync(store.path).mode & 0o777 };
  });
  assert.deepEqual(real, { first: 0o600, second: 0o600 });
  assert.deepEqual(fake, real);
});

test('path is <folder>/config.json', async (t) => {
  const { fake, real } = await runBoth(t, (Store, dir) => path.relative(dir, new Store().path));
  assert.equal(real, 'config.json');
  assert.equal(fake, real);
});
