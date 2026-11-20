'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMainWindow, VERSION_ARG_PREFIX } = require('../../src/main/windows/main');
const { createSettingsWindow, SETTINGS_TABS, SETTINGS_AREAS } = require('../../src/main/windows/settings');
const { createPasswordWindow, PASSWORD_PURPOSES, PASSWORD_AREAS } = require('../../src/main/windows/password');
const { MENU_SETTINGS_TABS } = require('../../src/main/windows/menu');
const { createFakeEnv } = require('../helpers/fake-window');

const lastLoadFile = (win) => [...win.webContents.calls].reverse().find((call) => call[0] === 'loadFile');

function withMainWindow(envOptions) {
  const env = createFakeEnv({ config: { serverUrl: 'https://vendor.societyfiles.com/' }, ...envOptions });
  const main = createMainWindow(env.mainDeps());
  main.window.bounds = { x: 100, y: 100, width: 1600, height: 900 };
  return { env, main };
}

// -- settings --------------------------------------------------------------------------------------------------------

test('Settings opens as a 960x640 content area (minimum 880x560), hidden until its page is ready, with the local preload', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open();

  assert.equal(win.options.width, 960);
  assert.equal(win.options.height, 640);
  assert.equal(win.options.useContentSize, true, 'the page gets the same viewport on every platform');
  assert.equal(win.options.minWidth, 880);
  assert.equal(win.options.minHeight, 560);
  assert.equal(win.options.resizable, true);
  assert.equal(win.options.minimizable, true);
  assert.equal(win.options.maximizable, false);
  assert.equal(win.options.fullscreenable, false);
  assert.equal(win.options.show, false);
  assert.equal(win.options.title, 'GadgetsPOS Settings');
  assert.equal(win.options.backgroundColor, '#F6F7FB');
  assert.equal('modal' in win.options, false, 'without a main window there is nothing to block');
  assert.equal('parent' in win.options, false);
  assert.deepEqual(
    { ...win.options.webPreferences },
    {
      preload: path.join(env.paths.preloadDir, 'local.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
      additionalArguments: [`${VERSION_ARG_PREFIX}2.0.0-test`],
    },
  );

  assert.equal(win.visible, false);
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
});

test('the Settings page is settings.html from the renderer folder, on the requested tab', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'about' });
  const [, file, options] = lastLoadFile(win);
  assert.equal(file, path.join(env.paths.rendererDir, 'settings.html'));
  assert.deepEqual(options, { query: { tab: 'about' } });

  settings.close();
  const plain = settings.open();
  assert.deepEqual(lastLoadFile(plain)[2], { query: {} });
  settings.close();
  assert.deepEqual(lastLoadFile(settings.open({ tab: 'nonsense' }))[2], { query: {} }, 'an unknown tab is ignored');
});

test('Settings is registered with the settings, connection and window areas, and unregistered when destroyed', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open();
  const id = win.webContents.id;
  assert.deepEqual(env.registry.get(id), ['settings', 'connection', 'window']);
  assert.deepEqual([...SETTINGS_AREAS], ['settings', 'connection', 'window']);
  win.close();
  assert.equal(env.registry.has(id), false);
});

test('a second request focuses the open window (restoring it when minimized) instead of opening another', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const first = settings.open();
  first.minimized = true;
  const second = settings.open();
  assert.equal(second, first);
  assert.equal(env.windows.length, 1);
  assert.deepEqual(first.calls.slice(-3), ['restore', 'show', 'focus']);
  assert.equal(settings.isOpen(), true);
  assert.equal(settings.getWindow(), first);
});

test('asking for a tab while Settings is open changes only the address fragment, so the page keeps its unsaved edits', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'printers' });
  const loadedAs = win.webContents.url; // what the first load made the address
  assert.match(loadedAs, /settings\.html\?tab=printers$/);

  settings.open({ tab: 'drawer' });
  const loads = (name) => win.webContents.calls.filter((call) => call[0] === name);
  assert.deepEqual(loads('loadURL').map((call) => call[1]), [`${loadedAs}#drawer`], 'a fragment-only navigation: same document, hashchange');
  assert.equal(loads('loadFile').length, 1, 'the page was loaded once');

  settings.open({ tab: 'about' });
  assert.equal(loads('loadURL').at(-1)[1], `${loadedAs}#about`, 'a later change replaces the fragment');
});

test('no tab, or an unknown tab, leaves an open Settings window alone', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'printers' });
  settings.open();
  settings.open({ tab: 'bogus' });
  settings.open({ tab: undefined });
  assert.equal(win.webContents.calls.filter((call) => call[0] === 'loadURL').length, 0);
  assert.equal(win.webContents.sent.length, 0);
});

test('a tab request before the page has an address, or after the window is closed, does nothing', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'printers' });
  win.webContents.url = ''; // the first load has not committed
  assert.doesNotThrow(() => settings.open({ tab: 'drawer' }));
  assert.equal(win.webContents.calls.filter((call) => call[0] === 'loadURL').length, 0);

  settings.close();
  const fresh = settings.open({ tab: 'general' });
  assert.notEqual(fresh, win);
  assert.match(lastLoadFile(fresh)[2].query.tab, /general/);
});

test('a failing fragment navigation is logged, not thrown', async () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const win = settings.open({ tab: 'printers' });
  win.webContents.loadFailures.push(new Error('ERR_FAILED'));
  settings.open({ tab: 'drawer' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(env.log.texts('warn').join('\n'), /settings\.html could not change its tab/);
});

test('closing destroys the window (never hides it) and the next open creates a fresh one', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  const first = settings.open();
  settings.close();
  assert.equal(first.isDestroyed(), true);
  assert.equal(settings.isOpen(), false);
  assert.equal(settings.getWindow(), null);
  const second = settings.open();
  assert.notEqual(second, first);
  assert.equal(env.windows.length, 2);
  assert.doesNotThrow(() => settings.close() || settings.close());
});

test('send pushes a message to the open Settings page and is ignored while it is closed', () => {
  const env = createFakeEnv();
  const settings = createSettingsWindow(env.localDeps());
  assert.doesNotThrow(() => settings.send('desktop:state', { a: 1 }));
  const win = settings.open();
  settings.send('desktop:state', { a: 1 });
  assert.deepEqual(win.webContents.sent, [{ channel: 'desktop:state', args: [{ a: 1 }] }]);
});

test('Settings has no menu bar on Windows and Linux, and keeps the macOS menu', () => {
  for (const [platform, removed] of [['win32', true], ['linux', true], ['darwin', false]]) {
    const env = createFakeEnv({ platform });
    const win = createSettingsWindow(env.localDeps({ platform })).open();
    assert.equal(win.menuRemoved, removed, platform);
    assert.equal(win.options.icon, platform === 'win32' ? path.join(env.paths.assetsDir, 'icon.ico') : platform === 'linux' ? path.join(env.paths.assetsDir, 'icon.png') : undefined, platform);
  }
});

test('Settings belongs to the main window: it is centred over it, above it, and does not block it', () => {
  const { env, main } = withMainWindow();
  const settings = createSettingsWindow(env.localDeps({ getParent: () => main.window }));
  const win = settings.open();
  assert.equal(win.options.parent, main.window);
  assert.equal(win.options.modal, false);
  // the main window is 1600x900 at (100,100): the child (content 960x640 plus the allowance for its frame) is centred over it
  assert.equal(win.options.x, 100 + (1600 - (960 + 16)) / 2);
  assert.equal(win.options.y, 100 + (900 - (640 + 48)) / 2);
});

test('a destroyed or missing main window is not used as a parent', () => {
  const { env, main } = withMainWindow();
  main.destroy();
  const settings = createSettingsWindow(env.localDeps({ getParent: () => main.window }));
  assert.equal('parent' in settings.open().options, false);
});

test('on a small display the content size, the minimum size and the position leave room for the window frame', () => {
  const env = createFakeEnv({ workAreas: [{ x: 0, y: 0, width: 900, height: 600 }] });
  const win = createSettingsWindow(env.localDeps()).open();
  assert.equal(win.options.width, 900 - 16);
  assert.equal(win.options.height, 600 - 48);
  assert.equal(win.options.minWidth, 880);
  assert.equal(win.options.minHeight, 552);
  assert.deepEqual([win.options.x, win.options.y], [0, 0], 'content plus frame fills the work area exactly');
});

test('a display that fits the window leaves its size alone', () => {
  const env = createFakeEnv({ workAreas: [{ x: 0, y: 0, width: 1366, height: 728 }] });
  const win = createSettingsWindow(env.localDeps()).open();
  assert.deepEqual([win.options.width, win.options.height], [960, 640]);
  assert.ok(win.options.y + 640 + 48 <= 728, 'the whole frame is on the screen');
});

test('a minimized parent is positioned from its normal bounds', () => {
  const { env, main } = withMainWindow();
  main.window.minimized = true;
  main.window.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
  main.window.normalBounds = { x: 200, y: 100, width: 1400, height: 800 };
  const win = createSettingsWindow(env.localDeps({ getParent: () => main.window })).open();
  assert.equal(win.options.x, 200 + (1400 - (960 + 16)) / 2);
});

test('the Settings tab list matches the tabs the menu opens, plus About', () => {
  for (const tab of MENU_SETTINGS_TABS) assert.ok(SETTINGS_TABS.includes(tab.id), tab.id);
  assert.ok(SETTINGS_TABS.includes('about'));
});

test('Settings in development gets DevTools; the settings window is registered even without a main window', () => {
  const env = createFakeEnv();
  const win = createSettingsWindow(env.localDeps({ isDev: true })).open();
  assert.equal(win.options.webPreferences.devTools, true);
  assert.deepEqual(env.registry.get(win.webContents.id), ['settings', 'connection', 'window']);
});

test('a page that fails to load is logged', async () => {
  const env = createFakeEnv();
  env.BrowserWindow.prototype.loadFile = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));
  createSettingsWindow(env.localDeps()).open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(env.log.texts('error').join('\n'), /settings\.html could not be loaded/);
});

test('both factories refuse to start without their injected classes', () => {
  const env = createFakeEnv();
  const deps = env.localDeps();
  delete deps.BrowserWindow;
  delete deps.getParent;
  assert.throws(() => createSettingsWindow(deps), /BrowserWindow, getParent/);
  assert.throws(() => createPasswordWindow(deps), /BrowserWindow, getParent/);
});

// -- the registry sees the right entry even though web-contents-created runs first -----------------------------------

test('the areas of a local window replace the empty entry that web-contents-created gave it', () => {
  const { env, main } = withMainWindow();
  const win = createSettingsWindow(env.localDeps({ getParent: () => main.window })).open();
  const id = win.webContents.id;
  const calls = env.registry.calls.filter((call) => call[1] === id);
  assert.deepEqual(calls, [
    ['set', id, []],
    ['set', id, ['settings', 'connection', 'window']],
  ]);
  assert.deepEqual(env.registry.get(id), ['settings', 'connection', 'window']);
  assert.equal(env.security.attached.some((entry) => entry.webContents === win.webContents), true, 'the guards cover local windows too');
  win.destroy();
  assert.equal(env.registry.has(id), false);
  assert.equal(env.registry.calls.filter((call) => call[0] === 'delete' && call[1] === id).length, 1, 'one clean-up');
});

// -- password --------------------------------------------------------------------------------------------------------

test('the password window is a fixed-size modal over the main window, 420 x 380 of content so every state of its page fits', () => {
  const { env, main } = withMainWindow();
  const win = createPasswordWindow(env.localDeps({ getParent: () => main.window })).open();
  assert.equal(win.options.width, 420);
  assert.equal(win.options.height, 380, 'the real page needs 279 px idle, 303 px with an error and 368 px while locked');
  assert.equal(win.options.useContentSize, true);
  assert.equal(win.options.resizable, false);
  assert.equal(win.options.minimizable, false);
  assert.equal(win.options.maximizable, false);
  assert.equal(win.options.fullscreenable, false);
  assert.equal(win.options.parent, main.window);
  assert.equal(win.options.modal, true);
  assert.equal(win.options.show, false);
  assert.equal(win.options.webPreferences.preload, path.join(env.paths.preloadDir, 'local.js'));
  assert.equal(win.options.x, 100 + (1600 - (420 + 16)) / 2);
  assert.equal(win.options.y, 100 + (900 - (380 + 48)) / 2);
  assert.equal('minWidth' in win.options, false);
  assert.equal(win.menuRemoved, true);
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
});

test('without a main window the password window is not modal and is centred on the screen', () => {
  const env = createFakeEnv();
  const win = createPasswordWindow(env.localDeps()).open();
  assert.equal('modal' in win.options, false);
  assert.equal('parent' in win.options, false);
  assert.deepEqual([win.options.x, win.options.y], [742, 306], 'centred in the work area, frame included');
});

test('the password window loads password.html with its purpose, defaulting to the drawer', () => {
  const env = createFakeEnv();
  const password = createPasswordWindow(env.localDeps());
  const file = path.join(env.paths.rendererDir, 'password.html');

  let win = password.open();
  assert.deepEqual(lastLoadFile(win).slice(1), [file, { query: { purpose: 'drawer' } }]);
  password.close();
  win = password.open({ purpose: 'settings' });
  assert.deepEqual(lastLoadFile(win).slice(1), [file, { query: { purpose: 'settings' } }]);
  password.close();
  win = password.open({ purpose: 'anything else' });
  assert.deepEqual(lastLoadFile(win)[2], { query: { purpose: 'drawer' } });
  assert.deepEqual([...PASSWORD_PURPOSES], ['drawer', 'settings', 'generic']);
  password.close();
  assert.deepEqual(lastLoadFile(password.open({ purpose: 'generic' }))[2], { query: { purpose: 'generic' } });
});

test('the password window is registered with the password and window areas only', () => {
  const env = createFakeEnv();
  const win = createPasswordWindow(env.localDeps()).open();
  assert.deepEqual(env.registry.get(win.webContents.id), ['password', 'window']);
  assert.deepEqual([...PASSWORD_AREAS], ['password', 'window']);
});

test('a second password request focuses the open prompt; close destroys it; lockout messages reach the page', () => {
  const env = createFakeEnv();
  const password = createPasswordWindow(env.localDeps());
  const first = password.open({ purpose: 'drawer' });
  const second = password.open({ purpose: 'settings' });
  assert.equal(second, first);
  assert.deepEqual(lastLoadFile(first)[2], { query: { purpose: 'drawer' } }, 'the purpose of the open prompt is kept');
  assert.equal(env.windows.length, 1);

  password.send('desktop:password:lockout', { retryAfterSec: 30 });
  assert.deepEqual(first.webContents.sent, [{ channel: 'desktop:password:lockout', args: [{ retryAfterSec: 30 }] }]);

  password.close();
  assert.equal(first.isDestroyed(), true);
  assert.equal(password.isOpen(), false);
});

test('the password window has no menu bar on Windows and Linux only', () => {
  for (const [platform, removed] of [['win32', true], ['linux', true], ['darwin', false]]) {
    const env = createFakeEnv({ platform });
    assert.equal(createPasswordWindow(env.localDeps({ platform })).open().menuRemoved, removed, platform);
  }
});
