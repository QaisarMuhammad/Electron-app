'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createDeferredLog, createLogArchiver, configureLogging, installProcessLogging, LOG_MAX_BYTES, LOG_FILES_KEPT } = require('../../src/main/logging');

function recorder() {
  const entries = [];
  const make = (level) => (...args) => entries.push([level, ...args]);
  return { entries, debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

test('the deferred log keeps entries until the real logger is attached, then writes them in order and forwards the rest at once', () => {
  const log = createDeferredLog();
  log.info('first');
  log.warn('second', 2);
  log.error('third');
  assert.equal(log.isAttached(), false);
  const real = recorder();
  log.attach(real);
  assert.deepEqual(real.entries, [['info', 'first'], ['warn', 'second', 2], ['error', 'third']]);
  log.debug('after');
  assert.deepEqual(real.entries.at(-1), ['debug', 'after']);
  assert.equal(log.isAttached(), true);
});

test('the buffer is bounded (the oldest entries go first) and a failing real logger never breaks the caller', () => {
  const log = createDeferredLog(3);
  for (let i = 1; i <= 5; i += 1) log.info(`entry ${i}`);
  const real = recorder();
  log.attach(real);
  assert.deepEqual(real.entries.map((entry) => entry[1]), ['entry 3', 'entry 4', 'entry 5']);

  const broken = createDeferredLog();
  broken.info('kept');
  assert.doesNotThrow(() => broken.attach({ info() { throw new Error('disk full'); } }));
  assert.doesNotThrow(() => broken.info('later'));
});

test('rotation keeps three files: main.log becomes main.old.log, the old archive becomes main.old2.log, the oldest is deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-log-'));
  try {
    const current = path.join(dir, 'main.log');
    fs.writeFileSync(current, 'newest');
    fs.writeFileSync(path.join(dir, 'main.old.log'), 'older');
    fs.writeFileSync(path.join(dir, 'main.old2.log'), 'oldest');
    createLogArchiver({ keepFiles: LOG_FILES_KEPT })({ toString: () => current, crop() { assert.fail('must not crop'); } });
    assert.equal(fs.existsSync(current), false, 'electron-log creates a fresh file itself');
    assert.equal(fs.readFileSync(path.join(dir, 'main.old.log'), 'utf8'), 'newest');
    assert.equal(fs.readFileSync(path.join(dir, 'main.old2.log'), 'utf8'), 'older');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['main.old.log', 'main.old2.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the first rotation has nothing to shift, and a locked file falls back to cropping instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpos-log-'));
  try {
    const current = path.join(dir, 'main.log');
    fs.writeFileSync(current, 'only');
    createLogArchiver()({ toString: () => current, crop() { assert.fail('must not crop'); } });
    assert.equal(fs.readFileSync(path.join(dir, 'main.old.log'), 'utf8'), 'only');

    const warned = [];
    const cropped = [];
    const lockedFs = { rmSync() {}, existsSync: () => false, renameSync() { throw new Error('EBUSY'); } };
    createLogArchiver({ fs: lockedFs, log: { warn: (text) => warned.push(text) } })({ toString: () => current, crop: (bytes) => cropped.push(bytes) });
    assert.deepEqual(cropped, [256 * 1024]);
    assert.match(warned[0], /EBUSY/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configureLogging puts the log in <userData>/logs, rotates at 5 MB and keeps the console quiet in an installed app', () => {
  const log = { transports: { file: {}, console: {} } };
  const file = configureLogging({ log, logsDir: path.join('data', 'logs'), verbose: false });
  assert.equal(file, path.join('data', 'logs', 'main.log'));
  assert.equal(log.transports.file.resolvePathFn(), file);
  assert.equal(log.transports.file.maxSize, 5 * 1024 * 1024);
  assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(typeof log.transports.file.archiveLogFn, 'function');
  assert.equal(log.transports.file.level, 'info');
  assert.deepEqual(log.transports.file.writeOptions, { flag: 'a', mode: 0o600, encoding: 'utf8' });
  assert.equal(log.transports.console.level, false);

  configureLogging({ log, logsDir: 'logs', verbose: true });
  assert.equal(log.transports.console.level, 'info');
});

test('uncaught exceptions and unhandled rejections go to the log, and the listeners can be removed again', () => {
  const proc = new EventEmitter();
  const real = recorder();
  const remove = installProcessLogging({ proc, log: real });
  proc.emit('uncaughtException', new Error('boom'));
  proc.emit('unhandledRejection', 'plain reason');
  assert.equal(real.entries.length, 2);
  assert.match(real.entries[0][2], /boom/);
  assert.equal(real.entries[1][2], 'plain reason');
  remove();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
});
