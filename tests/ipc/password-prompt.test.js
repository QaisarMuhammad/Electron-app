'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPasswordPrompt, CLOSE_DELAY_MS } = require('../../src/main/passwordPrompt');
const { createConfig } = require('../../src/main/config');
const { createDrawer } = require('../../src/main/printing/drawer');
const passwordTools = require('../../src/main/password');
const { createFakeStoreEnv } = require('../helpers/fake-store');
const { createManualClock } = require('../helpers/fake-electron');

const PASSWORD = 'open-sesame';

/** A local window host: `open()` returns a window that can be closed, `send()` records what the page is told. */
function fakeWindowHost() {
  const host = { windows: [], opens: [], sent: [], closes: 0 };
  host.open = (options) => {
    host.opens.push(options);
    if (host.current && !host.current.closed) return host.current;
    const window = Object.assign(new EventEmitter(), { closed: false });
    host.current = window;
    host.windows.push(window);
    return window;
  };
  host.isOpen = () => Boolean(host.current) && !host.current.closed;
  host.close = () => {
    host.closes += 1;
    if (host.isOpen()) {
      host.current.closed = true;
      host.current.emit('closed');
    }
  };
  host.send = (channel, payload) => host.sent.push([channel, payload]);
  return host;
}

function setup({ password = PASSWORD, enabled = true } = {}) {
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store });
  if (password) config.setPasswordRecord(passwordTools.hashPassword(password));
  config.setDrawer({ enabled });
  const pulses = [];
  const rawPrinter = { printRaw: async (job) => { pulses.push(Buffer.from(job.data)); return { ok: true }; } };
  config.setPrinter('receipt', { transport: 'system', printerName: 'EPSON', port: '' });
  const throttle = passwordTools.createThrottle();
  const drawer = createDrawer({ config, rawPrinter, password: passwordTools, throttle });
  const clock = createManualClock();
  const passwordWindow = fakeWindowHost();
  const settingsWindow = { opens: [], open(options) { settingsWindow.opens.push(options); } };
  const prompt = createPasswordPrompt({ passwordWindow, settingsWindow, drawer, throttle, timers: clock });
  return { prompt, passwordWindow, settingsWindow, drawer, throttle, clock, pulses, cleanup: () => env.cleanup() };
}

test('the drawer prompt opens the password window with its purpose, and the right password sends the pulse and closes the window shortly after', async () => {
  const { prompt, passwordWindow, clock, pulses, cleanup } = setup();
  prompt.show('drawer');
  assert.deepEqual(passwordWindow.opens, [{ purpose: 'drawer' }]);
  assert.deepEqual(await prompt.submit(PASSWORD), { ok: true });
  assert.deepEqual([...pulses[0]], [0x1b, 0x70, 0x00, 0x19, 0xff]);
  assert.equal(passwordWindow.closes, 0, 'the page first shows its "done" state');
  await clock.advance(CLOSE_DELAY_MS);
  assert.equal(passwordWindow.closes, 1);
  assert.equal(prompt.isOpen(), false);
  cleanup();
});

test('a wrong password answers the drawer code, keeps the window open and counts towards the lockout', async () => {
  const { prompt, passwordWindow, pulses, cleanup } = setup();
  prompt.show('drawer');
  const wrong = await prompt.submit('nope');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'DRAWER_WRONG_PASSWORD');
  assert.equal(wrong.details.attemptsLeft, 4);
  assert.equal(pulses.length, 0);
  assert.equal(passwordWindow.closes, 0);
  assert.equal(prompt.isOpen(), true);
  cleanup();
});

test('five wrong passwords lock the prompt: the Result and a push to the page carry the wait, and the lock is shared with getLockout', async () => {
  const { prompt, passwordWindow, cleanup } = setup();
  prompt.show('drawer');
  assert.deepEqual(prompt.getLockout(), { locked: false, retryAfterSec: 0 });
  let last;
  for (let i = 0; i < 5; i += 1) last = await prompt.submit('wrong');
  assert.equal(last.details.retryAfterSec, 30);
  assert.deepEqual(prompt.getLockout(), { locked: true, retryAfterSec: 30 });
  assert.deepEqual(passwordWindow.sent.at(-1), ['desktop:password:lockout', { locked: true, retryAfterSec: 30 }]);
  const refused = await prompt.submit(PASSWORD);
  assert.equal(refused.code, 'DRAWER_LOCKED_OUT');
  assert.equal(refused.details.retryAfterSec, 30);
  cleanup();
});

test('a pulse that fails after a correct password is shown in the prompt: the window stays open', async () => {
  const { prompt, passwordWindow, drawer, cleanup } = setup();
  prompt.show('drawer');
  drawer.open = async () => ({ ok: false, code: 'PORT_WRITE_FAILED', message: 'Nothing could be sent to the printer port.' });
  const result = await prompt.submit(PASSWORD);
  assert.equal(result.code, 'PORT_WRITE_FAILED');
  assert.equal(passwordWindow.closes, 0);
  cleanup();
});

test('the settings prompt checks the password only, opens Settings on the asked tab, and then closes', async () => {
  const { prompt, settingsWindow, passwordWindow, clock, pulses, cleanup } = setup();
  prompt.show('settings', { tab: 'connection' });
  assert.deepEqual(passwordWindow.opens, [{ purpose: 'settings' }]);
  assert.deepEqual(await prompt.submit(PASSWORD), { ok: true });
  assert.deepEqual(settingsWindow.opens, [{ tab: 'connection' }]);
  assert.equal(pulses.length, 0, 'no drawer pulse for a Settings prompt');
  await clock.advance(CLOSE_DELAY_MS);
  assert.equal(passwordWindow.closes, 1);
  cleanup();
});

test('the settings prompt answers with the settings codes (PASSWORD_WRONG / PASSWORD_LOCKED_OUT), never with the drawer ones', async () => {
  const { prompt, settingsWindow, cleanup } = setup();
  prompt.show('settings');
  const wrong = await prompt.submit('nope');
  assert.equal(wrong.code, 'PASSWORD_WRONG');
  for (let i = 0; i < 4; i += 1) await prompt.submit('nope');
  assert.equal((await prompt.submit(PASSWORD)).code, 'PASSWORD_LOCKED_OUT');
  assert.equal(settingsWindow.opens.length, 0);
  cleanup();
});

test('a second request while the prompt is open only brings it forward: its purpose never changes', async () => {
  const { prompt, passwordWindow, settingsWindow, cleanup } = setup();
  prompt.show('drawer');
  prompt.show('settings', { tab: 'general' });
  assert.equal(passwordWindow.windows.length, 1);
  assert.deepEqual((await prompt.submit(PASSWORD)).ok, true);
  assert.equal(settingsWindow.opens.length, 0, 'the prompt was, and stayed, a drawer prompt');
  cleanup();
});

test('an unknown purpose means the drawer; a submit with no prompt open, or after success, is refused', async () => {
  const { prompt, passwordWindow, cleanup } = setup();
  assert.equal((await prompt.submit(PASSWORD)).ok, false, 'no prompt is open');
  prompt.show('mystery');
  assert.deepEqual(passwordWindow.opens, [{ purpose: 'drawer' }]);
  assert.equal((await prompt.submit(PASSWORD)).ok, true);
  assert.equal((await prompt.submit(PASSWORD)).ok, false, 'a second submit after success');
  cleanup();
});

test('cancel closes the window, and a closed window forgets the prompt', async () => {
  const { prompt, passwordWindow, cleanup } = setup();
  prompt.show('drawer');
  assert.deepEqual(prompt.cancel(), { ok: true });
  assert.equal(passwordWindow.closes, 1);
  assert.equal((await prompt.submit(PASSWORD)).ok, false, 'the prompt is gone with its window');
  cleanup();
});

test('a lockout caused elsewhere reaches an open prompt, and nothing is pushed when no window is open', async () => {
  const { prompt, passwordWindow, cleanup } = setup();
  prompt.notifyLockout({ ok: false, code: 'PASSWORD_LOCKED_OUT', details: { retryAfterSec: 30 } });
  assert.equal(passwordWindow.sent.length, 0, 'no prompt open');
  prompt.show('drawer');
  prompt.notifyLockout({ ok: true });
  prompt.notifyLockout({ ok: false, code: 'PASSWORD_WRONG' });
  prompt.notifyLockout(undefined);
  assert.equal(passwordWindow.sent.length, 0);
  prompt.notifyLockout({ ok: false, code: 'PASSWORD_LOCKED_OUT', details: { retryAfterSec: 30 } });
  assert.equal(passwordWindow.sent.length, 1);
  assert.equal(passwordWindow.sent[0][0], 'desktop:password:lockout');
  cleanup();
});

test('the close timer never keeps the app alive and can be cancelled on quit', async () => {
  const { prompt, clock, passwordWindow, cleanup } = setup();
  prompt.show('drawer');
  await prompt.submit(PASSWORD);
  assert.equal(clock.pending(), 1);
  assert.equal(clock.pendingRefed(), 0);
  prompt.dispose();
  assert.equal(clock.pending(), 0);
  assert.equal(passwordWindow.closes, 0);
  cleanup();
});
