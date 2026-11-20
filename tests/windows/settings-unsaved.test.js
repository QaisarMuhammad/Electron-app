'use strict';

/**
 * Unsaved changes in the Settings window (SPEC 14). While a tab has edits that are not saved the page asks to stay (`beforeunload`).
 * Electron then refuses to close the window and says nothing, unless the main process answers `will-prevent-unload`: the window must
 * ask "You have unsaved changes. Discard them and close?" ("Keep editing" is the default, "Discard changes" lets the window go), and a
 * page with nothing unsaved must close without a question. `confirmClose` is the same path for quit and restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsWindow, UNSAVED_QUESTION } = require('../../src/main/windows/settings');
const { createFakeEnv, createFakeDialog, makePageAskToStay: pageAsksToStay } = require('../helpers/fake-window');

/** A Settings window over a fake dialog that answers `answers` (button numbers) to its questions, one after the other. */
function setup(answers = []) {
  const env = createFakeEnv();
  env.dialog = createFakeDialog([], answers);
  const settings = createSettingsWindow({ ...env.localDeps(), dialog: env.dialog });
  return { env, settings, dialog: env.dialog };
}

test('a window with unsaved changes asks the question once: Keep editing is the default and the answer to Escape', () => {
  const { settings, dialog } = setup([0]);
  const win = settings.open();
  const seen = pageAsksToStay(win);
  settings.close();

  assert.equal(seen.unloadEvents, 1);
  assert.equal(dialog.syncCalls.length, 1, 'one question, not two');
  const [call] = dialog.syncCalls;
  assert.equal(call.window, win, 'it belongs to the Settings window');
  assert.equal(call.options, UNSAVED_QUESTION);
  assert.deepEqual({ ...call.options, buttons: [...call.options.buttons] }, {
    type: 'question',
    title: 'GadgetsPOS',
    message: 'You have unsaved changes. Discard them and close?',
    buttons: ['Keep editing', 'Discard changes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  assert.equal(settings.isOpen(), true, 'Keep editing: the window stays');
});

test('Keep editing, Escape and a question that was closed leave the page\'s refusal alone, so the window stays', () => {
  for (const answer of [0, undefined, 2, -1]) {
    const { settings, dialog } = setup([answer]);
    const win = settings.open();
    pageAsksToStay(win);
    settings.close();
    assert.equal(dialog.syncCalls.length, 1, String(answer));
    assert.equal(win.isDestroyed(), false, `answer ${answer}`);
    assert.equal(settings.isOpen(), true);
  }
});

test('Discard changes overrides the page and the window closes', () => {
  const { settings, dialog } = setup([1]);
  const win = settings.open();
  pageAsksToStay(win);
  settings.close();
  assert.equal(dialog.syncCalls.length, 1);
  assert.equal(win.isDestroyed(), true);
  assert.equal(settings.isOpen(), false);
  assert.equal(settings.getWindow(), null);
});

test('after Keep editing the window can be closed again, and it asks again', () => {
  const { settings, dialog } = setup([0, 1]);
  const win = settings.open();
  pageAsksToStay(win);
  settings.close();
  assert.equal(settings.isOpen(), true);
  settings.close();
  assert.equal(dialog.syncCalls.length, 2);
  assert.equal(settings.isOpen(), false);
});

test('a window with nothing unsaved closes at once and asks nothing', () => {
  const { settings, dialog } = setup([1]);
  const win = settings.open();
  settings.close(); // the fake's own close(): no will-prevent-unload, as with a page that does not ask to stay
  assert.equal(win.isDestroyed(), true);
  assert.equal(dialog.syncCalls.length, 0);
  assert.equal(settings.isOpen(), false);
});

test('a question that cannot be shown is logged and the window stays (nothing is lost)', () => {
  const env = createFakeEnv();
  env.dialog = createFakeDialog();
  env.dialog.showMessageBoxSync = () => {
    throw new Error('no window to attach to');
  };
  const settings = createSettingsWindow({ ...env.localDeps(), dialog: env.dialog });
  const win = settings.open();
  pageAsksToStay(win);
  assert.doesNotThrow(() => settings.close());
  assert.equal(settings.isOpen(), true);
  assert.match(env.log.texts('error').join('\n'), /Settings could not ask about the unsaved changes/);
});

test('every window gets its own listener, and only the Settings window asks (not the windows the page opens)', () => {
  const { env, settings, dialog } = setup([1, 1]);
  const first = settings.open();
  pageAsksToStay(first);
  settings.close();
  const second = settings.open();
  assert.notEqual(second, first);
  pageAsksToStay(second);
  settings.close();
  assert.equal(dialog.syncCalls.length, 2, 'one question for each window, none repeated');
  assert.equal(first.webContents.listenerCount('will-prevent-unload'), 1);
  assert.equal(second.webContents.listenerCount('will-prevent-unload'), 1);

  const other = new env.BrowserWindow({});
  assert.equal(other.webContents.listenerCount('will-prevent-unload'), 0);
});

test('asking for a tab, or for the window again, does not stack listeners', () => {
  const { settings } = setup();
  const win = settings.open({ tab: 'general' });
  settings.open({ tab: 'about' });
  settings.open();
  assert.equal(win.webContents.listenerCount('will-prevent-unload'), 1);
});

test('without a dialog the factory refuses to start (the question could never be asked)', () => {
  const env = createFakeEnv();
  const deps = env.localDeps();
  delete deps.dialog;
  assert.throws(() => createSettingsWindow(deps), /missing: dialog/);
});

// -- confirmClose: the same path for quit and restart ---------------------------------------------------------------------

test('confirmClose: no window is nothing to ask, and answers true', async () => {
  const { settings, dialog } = setup();
  assert.equal(await settings.confirmClose(), true);
  assert.equal(dialog.syncCalls.length, 0);
});

test('confirmClose: a clean window is closed silently and answers true', async () => {
  const { settings, dialog } = setup();
  const win = settings.open();
  assert.equal(await settings.confirmClose(), true);
  assert.equal(win.isDestroyed(), true);
  assert.equal(dialog.syncCalls.length, 0);
});

test('confirmClose: Keep editing answers false and the window stays; Discard changes answers true and it goes', async () => {
  const { settings, dialog } = setup([0, 1]);
  const win = settings.open();
  pageAsksToStay(win);
  assert.equal(await settings.confirmClose(), false);
  assert.equal(settings.isOpen(), true);
  assert.equal(dialog.syncCalls.length, 1);
  assert.equal(await settings.confirmClose(), true, 'asked again, and this time discarded');
  assert.equal(dialog.syncCalls.length, 2);
  assert.equal(win.isDestroyed(), true);
});

test('confirmClose: two askers at the same time get the same answer and the cashier sees one question', async () => {
  const { settings, dialog } = setup([0]);
  const win = settings.open();
  const seen = pageAsksToStay(win, { later: true });
  const [first, second] = await Promise.all([settings.confirmClose(), settings.confirmClose()]);
  assert.deepEqual([first, second], [false, false]);
  assert.equal(seen.closeEvents, 1, 'the window was asked to close once');
  assert.equal(dialog.syncCalls.length, 1);
});

test('confirmClose: a window that closes later (the page answers asynchronously) is waited for', async () => {
  const { settings } = setup();
  const win = settings.open();
  win.close = () => setImmediate(() => win.destroy()); // Chromium runs beforeunload in the renderer first
  let answered = false;
  const pending = settings.confirmClose().then((closed) => {
    answered = true;
    return closed;
  });
  await Promise.resolve();
  assert.equal(answered, false, 'not before the window is gone');
  assert.equal(await pending, true);
});
