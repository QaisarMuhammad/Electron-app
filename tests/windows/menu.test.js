'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMenuTemplate, buildMenu, MENU_SETTINGS_TABS, REQUIRED_HANDLERS } = require('../../src/main/windows/menu');
const { createFakeMenu } = require('../helpers/fake-window');

/** Handlers that record every call as [name, ...args]. */
function recordingHandlers(extra = []) {
  const calls = [];
  const handlers = {};
  for (const name of [...REQUIRED_HANDLERS, ...extra]) {
    handlers[name] = (...args) => calls.push([name, ...args]);
  }
  return { handlers, calls };
}

/** Every item of a template, depth first, with its path of labels. */
function flatten(template, trail = []) {
  const items = [];
  for (const item of template) {
    const here = [...trail, item.label || item.role || item.type];
    items.push({ item, trail: here });
    if (Array.isArray(item.submenu)) items.push(...flatten(item.submenu, here));
  }
  return items;
}

const topLevel = (template) => template.map((entry) => entry.label || entry.role);
const find = (template, id) => flatten(template).map((entry) => entry.item).find((item) => item.id === id);

test('Windows and Linux: Open Drawer, View, Settings, Help, Quit, in that order (SPEC 12b)', () => {
  for (const platform of ['win32', 'linux']) {
    const { handlers } = recordingHandlers();
    const template = buildMenuTemplate({ platform, isDev: false, handlers });
    assert.deepEqual(topLevel(template), ['Open Drawer (Ctrl+D)', 'View', 'Settings', 'Help', 'Quit'], platform);
    assert.equal(template[0].accelerator, 'CmdOrCtrl+D');
    assert.equal(template[4].accelerator, 'CmdOrCtrl+Q');
  }
});

test('macOS: the standard app menu first, Quit only there, Open Drawer under File, Edit and Window menus', () => {
  const { handlers } = recordingHandlers();
  const template = buildMenuTemplate({ platform: 'darwin', isDev: false, handlers });
  assert.deepEqual(topLevel(template), ['GadgetsPOS', 'File', 'editMenu', 'View', 'Settings', 'windowMenu', 'Help']);
  const appMenu = template[0].submenu;
  assert.equal(appMenu[0].label, 'About GadgetsPOS');
  assert.ok(appMenu.some((item) => item.accelerator === 'CmdOrCtrl+,'), 'the settings shortcut lives in the app menu');
  assert.ok(appMenu.some((item) => item.role === 'hide'));
  assert.equal(find(template, 'app.quit').accelerator, 'CmdOrCtrl+Q');
  assert.equal(flatten(template).filter(({ item }) => /^Quit/.test(item.label || '')).length, 1, 'Quit is not repeated');
  assert.deepEqual(find(template, 'drawer').accelerator, 'CmdOrCtrl+D');
  assert.deepEqual(flatten(template.slice(4, 5)).map(({ item }) => item.accelerator).filter(Boolean), [], 'the Settings menu has no second ⌘, on macOS');
});

test('View: reload, force reload, zoom, actual size and full screen, with their accelerators', () => {
  const { handlers } = recordingHandlers();
  const view = buildMenuTemplate({ platform: 'win32', isDev: false, handlers })[1];
  const entries = view.submenu.filter((item) => item.type !== 'separator').map((item) => [item.label, item.accelerator, item.visible === false ? 'hidden' : 'shown']);
  assert.deepEqual(entries, [
    ['Reload', 'CmdOrCtrl+R', 'shown'],
    ['Reload', 'F5', 'hidden'],
    ['Force reload', 'CmdOrCtrl+Shift+R', 'shown'],
    ['Zoom in', 'CmdOrCtrl+Plus', 'shown'],
    ['Zoom in', 'CmdOrCtrl+=', 'hidden'],
    ['Zoom out', 'CmdOrCtrl+-', 'shown'],
    ['Actual size', 'CmdOrCtrl+0', 'shown'],
    ['Toggle full screen', 'F11', 'shown'],
  ]);
});

test('Toggle full screen is F11 on Windows and Linux and Ctrl+Cmd+F on macOS', () => {
  const { handlers } = recordingHandlers();
  assert.equal(find(buildMenuTemplate({ platform: 'win32', handlers }), 'view.full-screen').accelerator, 'F11');
  assert.equal(find(buildMenuTemplate({ platform: 'linux', handlers }), 'view.full-screen').accelerator, 'F11');
  assert.equal(find(buildMenuTemplate({ platform: 'darwin', handlers }), 'view.full-screen').accelerator, 'Ctrl+Cmd+F');
});

test('Settings lists Printers, Cash drawer, Connection and General, each opening its tab; the shortcut item opens the default tab', () => {
  const { handlers, calls } = recordingHandlers();
  const settings = buildMenuTemplate({ platform: 'win32', handlers })[2];
  assert.equal(settings.submenu[0].label, 'Printer and Settings…');
  assert.equal(settings.submenu[0].accelerator, 'CmdOrCtrl+,');
  const tabs = settings.submenu.filter((item) => item.id && item.id !== 'settings.open');
  assert.deepEqual(tabs.map((item) => item.label), ['Printers', 'Cash drawer', 'Connection', 'General']);
  assert.deepEqual(MENU_SETTINGS_TABS.map((tab) => tab.id), ['printers', 'drawer', 'connection', 'general']);
  settings.submenu[0].click();
  tabs.forEach((item) => item.click());
  assert.deepEqual(calls, [['openSettings'], ['openSettings', 'printers'], ['openSettings', 'drawer'], ['openSettings', 'connection'], ['openSettings', 'general']]);
});

test('Help: updates, logs, diagnostics, the native Compatibility mode checkbox and About', () => {
  const { handlers, calls } = recordingHandlers();
  const help = buildMenuTemplate({ platform: 'win32', handlers, compatibilityMode: true })[3];
  assert.deepEqual(help.submenu.filter((item) => item.type !== 'separator').map((item) => item.label), [
    'Check for updates…',
    'Open logs folder',
    'Copy diagnostics',
    'Compatibility mode',
    'About GadgetsPOS',
  ]);
  const compat = help.submenu.find((item) => item.id === 'help.compatibility');
  assert.equal(compat.type, 'checkbox');
  assert.equal(compat.checked, true);
  compat.click({ checked: false });
  compat.click({ checked: true });
  compat.click(undefined);
  assert.deepEqual(calls, [['setCompatibilityMode', false], ['setCompatibilityMode', true], ['setCompatibilityMode', false]]);
  assert.equal(buildMenuTemplate({ platform: 'win32', handlers })[3].submenu.find((item) => item.id === 'help.compatibility').checked, false, 'unchecked by default');
});

test('Help > About calls the injected handler that opens Settings on the About tab', () => {
  for (const platform of ['win32', 'darwin']) {
    const { handlers, calls } = recordingHandlers();
    const template = buildMenuTemplate({ platform, handlers });
    find(template, 'help.about').click();
    assert.deepEqual(calls, [['about']], platform);
  }
});

test('Toggle Developer Tools exists only in development', () => {
  for (const platform of ['win32', 'darwin']) {
    const packaged = recordingHandlers();
    assert.equal(find(buildMenuTemplate({ platform, isDev: false, handlers: packaged.handlers }), 'view.devtools'), undefined, `${platform} packaged`);
    assert.equal(flatten(buildMenuTemplate({ platform, isDev: false, handlers: packaged.handlers })).some(({ item }) => /DevTools|Developer/i.test(item.label || '')), false);

    const dev = recordingHandlers(['toggleDevTools']);
    const item = find(buildMenuTemplate({ platform, isDev: true, handlers: dev.handlers }), 'view.devtools');
    assert.equal(item.label, 'Toggle Developer Tools');
    assert.equal(item.accelerator, 'CmdOrCtrl+Shift+I');
    item.click();
    assert.deepEqual(dev.calls, [['toggleDevTools']]);
  }
});

test('accelerators are unique within every menu template', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const isDev of [false, true]) {
      const { handlers } = recordingHandlers(['toggleDevTools']);
      const accelerators = flatten(buildMenuTemplate({ platform, isDev, handlers })).map(({ item }) => item.accelerator).filter(Boolean);
      assert.equal(new Set(accelerators).size, accelerators.length, `${platform} dev=${isDev}: ${accelerators.join(' ')}`);
    }
  }
});

test('item ids are unique and every clickable item has a label', () => {
  for (const platform of ['win32', 'darwin']) {
    const { handlers } = recordingHandlers(['toggleDevTools']);
    const items = flatten(buildMenuTemplate({ platform, isDev: true, handlers })).map(({ item }) => item);
    const ids = items.map((item) => item.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, platform);
    for (const item of items.filter((entry) => typeof entry.click === 'function')) assert.ok(item.label, `${platform}: ${item.id}`);
  }
});

test('every handler is invoked by some menu item, with no stray arguments, on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const { handlers, calls } = recordingHandlers(['toggleDevTools']);
    const items = flatten(buildMenuTemplate({ platform, isDev: true, handlers })).map(({ item }) => item);
    for (const item of items) {
      // Electron calls click(menuItem, window, event); the handlers must receive none of that
      if (typeof item.click === 'function') item.click({ checked: true }, {}, {});
    }
    const invoked = new Set(calls.map((call) => call[0]));
    for (const name of [...REQUIRED_HANDLERS, 'toggleDevTools']) assert.ok(invoked.has(name), `${platform}: ${name} is never called`);
    for (const call of calls) {
      if (call[0] === 'openSettings') assert.ok(call.length <= 2);
      else if (call[0] === 'setCompatibilityMode') assert.deepEqual(call, ['setCompatibilityMode', true]);
      else assert.equal(call.length, 1, `${platform}: ${call[0]} received arguments`);
    }
  }
});

test('a missing handler fails when the template is built, naming all of them', () => {
  const { handlers } = recordingHandlers();
  delete handlers.reload;
  delete handlers.quit;
  assert.throws(() => buildMenuTemplate({ platform: 'win32', handlers }), /missing handlers: reload, quit/);
  assert.throws(() => buildMenuTemplate({ platform: 'win32', isDev: true, handlers: recordingHandlers().handlers }), /toggleDevTools/);
  assert.throws(() => buildMenuTemplate({ platform: 'win32' }), /missing handlers/);
});

test('buildMenu builds the native menu and enables developer tools for an unpackaged app or --devtools', () => {
  const Menu = createFakeMenu();
  const { handlers } = recordingHandlers(['toggleDevTools']);
  const has = (menu) => flatten(menu.template).some(({ item }) => item.id === 'view.devtools');

  assert.equal(has(buildMenu({ app: { isPackaged: true }, Menu, handlers, platform: 'win32', argv: [] })), false);
  assert.equal(has(buildMenu({ app: { isPackaged: false }, Menu, handlers, platform: 'win32', argv: [] })), true);
  assert.equal(has(buildMenu({ app: { isPackaged: true }, Menu, handlers, platform: 'win32', argv: ['GadgetsPOS.exe', '--devtools'] })), true);
  assert.equal(has(buildMenu({ app: { isPackaged: false }, Menu, handlers, isPackaged: true, platform: 'win32', argv: [] })), false, 'isPackaged overrides app.isPackaged');
  assert.equal(Menu.built.length, 4);
});

test('buildMenu returns the Menu object made from the template', () => {
  const Menu = createFakeMenu();
  const { handlers } = recordingHandlers();
  const menu = buildMenu({ app: { isPackaged: true }, Menu, handlers, platform: 'win32', argv: [], compatibilityMode: true });
  assert.equal(menu, Menu.built[0]);
  assert.deepEqual(topLevel(menu.template), ['Open Drawer (Ctrl+D)', 'View', 'Settings', 'Help', 'Quit']);
  assert.equal(find(menu.template, 'help.compatibility').checked, true);
});
