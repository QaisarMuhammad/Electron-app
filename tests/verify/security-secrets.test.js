'use strict';

/**
 * SECURITY lens, password handling and secrets (SPEC 10 and 12 "Logs"). REGRESSION GUARDS (these pass today). The real bootstrap
 * runs a legacy v1 settings file with a plain-text password, then the password flows of every entry point (the web's open-drawer,
 * the Settings dialogs, reset, a change of password). Afterwards NOTHING the app produced may contain a password (the old one, the
 * new one, a wrong guess), the stored hash or its salt: not the log, not a native dialog, not an answer to a page, not the
 * diagnostics text, not the state the Settings window reads. On disk the plain-text key is gone and the backup of the v1 file has
 * no password.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBootWorld } = require('../helpers/fake-boot');
const { makeV1Fixture } = require('../helpers/fake-store');

const LEGACY = 'LegacyPass-77';
const NEXT = 'Brand-New-Pass-8899';
const GUESS = 'wrong-guess-4411';

test('no password, hash or salt ends up in a log line, a dialog, an answer, the diagnostics or the Settings state', async (t) => {
  const world = createBootWorld({ config: makeV1Fixture({ password: LEGACY }) });
  t.after(() => world.cleanup());
  await world.boot();
  await world.settle();
  const { drawer, desktopApi, config } = world.services();

  const answers = [];
  const pos = () => world.events.pos();
  answers.push(await world.ipc.invoke('open-drawer', pos(), { password: GUESS }));
  answers.push(await world.ipc.invoke('open-drawer', pos(), { password: LEGACY }));
  world.ipc.send('open-drawer-legacy', pos(), { cashDrawerOpenPassword: GUESS });
  answers.push(desktopApi.setDrawerPassword({ current: GUESS, next: NEXT }));
  answers.push(desktopApi.setDrawerPassword({ current: LEGACY, next: NEXT }));
  answers.push(await world.ipc.invoke('open-drawer', pos(), { password: NEXT }));
  answers.push(desktopApi.saveDrawerSettings({ password: GUESS, enabled: true }));
  answers.push(desktopApi.resetAll({ password: GUESS }));
  await world.settle();

  const record = config.all().drawer.passwordRecord;
  assert.ok(record && record.hash && record.salt, 'the new password is stored as a record');
  const secrets = [LEGACY, NEXT, GUESS, record.hash, record.salt];

  const produced = [
    ['log', JSON.stringify(world.log.entries)],
    ['dialogs', JSON.stringify(world.dialog.calls.map((call) => call.options))],
    ['answers', JSON.stringify(answers)],
    ['Settings state', JSON.stringify(desktopApi.getState())],
    ['diagnostics', desktopApi.copyDiagnostics()],
    ['clipboard', JSON.stringify(world.clipboard.writes)],
  ];
  for (const [what, text] of produced) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${what} contains a secret: ${secret.slice(0, 6)}...`);
  }
});

test('on disk: the plain-text v1 password is gone from config.json, and the v1 backup never had it', async (t) => {
  const world = createBootWorld({ config: makeV1Fixture({ password: LEGACY }) });
  t.after(() => world.cleanup());
  await world.boot();
  await world.settle();

  const config = world.store.readText();
  assert.ok(!config.includes(LEGACY), 'config.json still holds the plain-text password');
  assert.ok(!Object.hasOwn(JSON.parse(config), 'password'));
  assert.ok(JSON.parse(config).drawer.passwordRecord.hash, 'the password lives on as a scrypt record');
  assert.ok(world.store.list().includes('config.v1-backup.json'));
  assert.ok(!world.store.readText('config.v1-backup.json').includes(LEGACY), 'the backup of the v1 file holds the password');
  assert.equal(world.store.mode('config.v1-backup.json') & 0o777, 0o600);
});

test('the throttle answers with the number of attempts left and the wait, and nothing that helps a guess', async (t) => {
  const world = createBootWorld();
  t.after(() => world.cleanup());
  await world.boot();
  await world.settle();
  world.services().drawer.setPassword({ next: NEXT });
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push(await world.ipc.invoke('open-drawer', world.events.pos(), { password: `${GUESS}-${i}` }));
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'details', 'message', 'ok']);
    assert.ok(Object.keys(result.details).every((key) => ['attemptsLeft', 'retryAfterSec'].includes(key)), JSON.stringify(result.details));
  }
  assert.equal(results[5].code, 'DRAWER_LOCKED_OUT');
});
