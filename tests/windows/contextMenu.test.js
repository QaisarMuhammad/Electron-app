'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildContextMenuTemplate, attachContextMenu, mailtoAddress } = require('../../src/main/windows/contextMenu');
const { createFakeLog, createFakeMenu } = require('../helpers/fake-window');

const isSafeExternalUrl = (url) => /^(https:|mailto:|tel:)/i.test(url);

function actionsRecorder() {
  const calls = [];
  return {
    calls,
    actions: {
      openExternal: (url) => calls.push(['openExternal', url]),
      copyText: (text) => calls.push(['copyText', text]),
      copyImage: (x, y) => calls.push(['copyImage', x, y]),
      saveImage: (url) => calls.push(['saveImage', url]),
      inspect: (x, y) => calls.push(['inspect', x, y]),
    },
  };
}

const build = (params, { isDev = false } = {}) => {
  const recorder = actionsRecorder();
  const template = buildContextMenuTemplate({ x: 10, y: 20, ...params }, { isDev, isSafeExternalUrl, actions: recorder.actions });
  return { template, calls: recorder.calls };
};
const labels = (template) => template.map((item) => (item.type === 'separator' ? '|' : item.label));

test('an editable field offers Undo, Redo, Cut, Copy, Paste and Select all, as standard roles', () => {
  const { template } = build({ isEditable: true, editFlags: {} });
  assert.deepEqual(labels(template), ['Undo', 'Redo', '|', 'Cut', 'Copy', 'Paste', '|', 'Select all']);
  assert.deepEqual(template.filter((item) => item.role).map((item) => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
});

test('the edit items follow the edit flags: nothing to cut, nothing to paste', () => {
  const { template } = build({ isEditable: true, editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  const enabled = Object.fromEntries(template.filter((item) => item.role).map((item) => [item.role, item.enabled]));
  assert.deepEqual(enabled, { undo: false, redo: false, cut: false, copy: false, paste: true, selectAll: true });
});

test('a text selection outside a field offers Copy only', () => {
  const { template } = build({ isEditable: false, selectionText: 'ORD-10042' });
  assert.deepEqual(labels(template), ['Copy']);
  assert.equal(template[0].role, 'copy');
});

test('a selection made only of spaces offers nothing', () => {
  assert.deepEqual(build({ isEditable: false, selectionText: '   \n ' }).template, []);
});

test('a safe link offers Open link in browser and Copy link address; the clicks use the injected actions', () => {
  const { template, calls } = build({ linkURL: 'https://shop.example.com/orders/1' });
  assert.deepEqual(labels(template), ['Open link in browser', 'Copy link address']);
  template[0].click();
  template[1].click();
  assert.deepEqual(calls, [['openExternal', 'https://shop.example.com/orders/1'], ['copyText', 'https://shop.example.com/orders/1']]);
});

test('an unsafe link is never offered to the system browser, only copied', () => {
  for (const linkURL of ['file:///C:/Windows/System32/calc.exe', 'ftp://example.com/x', 'smb://host/share']) {
    const { template, calls } = build({ linkURL });
    assert.deepEqual(labels(template), ['Copy link address'], linkURL);
    template[0].click();
    assert.deepEqual(calls, [['copyText', linkURL]]);
  }
});

test('a javascript: link gets no link items at all', () => {
  assert.deepEqual(build({ linkURL: 'javascript:alert(1)' }).template, []);
  assert.deepEqual(build({ linkURL: 'JavaScript:void(0)' }).template, []);
});

test('a mailto: link copies just the address', () => {
  const { template, calls } = build({ linkURL: 'mailto:sales%40shop.example.com?subject=Hello' });
  assert.deepEqual(labels(template), ['Open link in browser', 'Copy email address']);
  template[1].click();
  assert.deepEqual(calls, [['copyText', 'sales@shop.example.com']]);
  assert.equal(mailtoAddress('mailto:a@b.com'), 'a@b.com');
  assert.equal(mailtoAddress('mailto:%E0%A4%A@b.com'), '%E0%A4%A@b.com', 'a broken escape is kept as is');
});

test('an image offers Copy image and Save image as; they pass the position and the source', () => {
  const { template, calls } = build({ mediaType: 'image', srcURL: 'https://cdn.example.com/p.png', x: 33, y: 44 });
  assert.deepEqual(labels(template), ['Copy image', 'Save image as\u2026']);
  template[0].click();
  template[1].click();
  assert.deepEqual(calls, [['copyImage', 33, 44], ['saveImage', 'https://cdn.example.com/p.png']]);
});

test('an image without a source address cannot be saved, so the group is left out', () => {
  assert.deepEqual(build({ mediaType: 'image', srcURL: '' }).template, []);
  assert.deepEqual(build({ mediaType: 'video', srcURL: 'https://x/y.mp4' }).template, []);
});

test('Inspect element appears only in development', () => {
  const dev = build({ x: 7, y: 8 }, { isDev: true });
  assert.deepEqual(labels(dev.template), ['Inspect element']);
  dev.template[0].click();
  assert.deepEqual(dev.calls, [['inspect', 7, 8]]);
  assert.deepEqual(build({ x: 7, y: 8 }, { isDev: false }).template, []);
});

test('groups are separated by one divider each and never start or end with one', () => {
  const { template } = build(
    { isEditable: true, editFlags: {}, linkURL: 'https://a.example.com/', mediaType: 'image', srcURL: 'https://a.example.com/i.png' },
    { isDev: true },
  );
  assert.equal(template[0].type === 'separator', false);
  assert.equal(template[template.length - 1].type === 'separator', false);
  for (let i = 1; i < template.length; i += 1) {
    assert.equal(template[i].type === 'separator' && template[i - 1].type === 'separator', false, 'no double dividers');
  }
  // two dividers inside the edit group, three between the four groups (edit, link, image, inspect)
  assert.equal(labels(template).filter((label) => label === '|').length, 5);
  assert.equal(labels(template).at(-1), 'Inspect element');
});

// -- the hook-up -----------------------------------------------------------------------------------------------------

function hookup(overrides = {}) {
  const webContents = new EventEmitter();
  const calls = [];
  Object.assign(webContents, {
    isDestroyed: () => false,
    copyImageAt: (x, y) => calls.push(['copyImageAt', x, y]),
    downloadURL: (url) => calls.push(['downloadURL', url]),
    inspectElement: (x, y) => calls.push(['inspectElement', x, y]),
  });
  const Menu = createFakeMenu();
  const clipboard = { writes: [], writeText(text) { this.writes.push(text); } };
  const opened = [];
  const log = createFakeLog();
  const ownerWindow = { name: 'window' };
  attachContextMenu({
    webContents,
    ownerWindow,
    Menu,
    clipboard,
    isDev: true,
    isSafeExternalUrl,
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    log,
    ...overrides,
  });
  return { webContents, Menu, clipboard, opened, log, calls, ownerWindow };
}

test('context-menu pops the built menu up in the owner window', () => {
  const { webContents, Menu, ownerWindow } = hookup();
  webContents.emit('context-menu', {}, { isEditable: true, editFlags: {}, x: 1, y: 2 });
  assert.equal(Menu.built.length, 1);
  assert.deepEqual(Menu.built[0].popups, [{ window: ownerWindow }]);
});

test('the clicks reach the real sinks: system browser, clipboard, image copy, image download, inspector', () => {
  const { webContents, Menu, clipboard, opened, calls } = hookup();
  webContents.emit('context-menu', {}, { linkURL: 'https://a.example.com/x', mediaType: 'image', srcURL: 'https://a.example.com/i.png', x: 5, y: 6 });
  const click = (label) => Menu.built[0].template.find((item) => item.label === label).click();
  click('Open link in browser');
  click('Copy link address');
  click('Copy image');
  click('Save image as\u2026');
  click('Inspect element');
  assert.deepEqual(opened, ['https://a.example.com/x']);
  assert.deepEqual(clipboard.writes, ['https://a.example.com/x']);
  assert.deepEqual(calls, [['copyImageAt', 5, 6], ['downloadURL', 'https://a.example.com/i.png'], ['inspectElement', 5, 6]]);
});

test('an action that fails, even asynchronously, is logged and never thrown at the user', async () => {
  const { webContents, Menu, log } = hookup({
    openExternal: () => Promise.reject(new Error('no browser')),
    clipboard: { writeText: () => { throw new Error('clipboard busy'); } },
  });
  webContents.emit('context-menu', {}, { linkURL: 'https://a.example.com/x' });
  const { template } = Menu.built[0];
  assert.doesNotThrow(() => template[0].click());
  assert.doesNotThrow(() => template[1].click());
  await new Promise((resolve) => setImmediate(resolve));
  const errors = log.texts('error').join('\n');
  assert.match(errors, /open link failed/);
  assert.match(errors, /copy failed/);
});

test('an empty template shows no menu, and a destroyed webContents is ignored', () => {
  const { webContents, Menu } = hookup({ isDev: false });
  webContents.emit('context-menu', {}, { isEditable: false, x: 1, y: 1 });
  assert.equal(Menu.built.length, 0);

  const gone = hookup();
  gone.webContents.isDestroyed = () => true;
  gone.webContents.emit('context-menu', {}, { isEditable: true, x: 1, y: 1 });
  assert.equal(gone.Menu.built.length, 0);
});

test('a menu that cannot be built is logged', () => {
  const { webContents, log } = hookup({ Menu: { buildFromTemplate: () => { throw new Error('bad template'); } } });
  assert.doesNotThrow(() => webContents.emit('context-menu', {}, { isEditable: true, x: 1, y: 1 }));
  assert.match(log.texts('error').join('\n'), /could not be shown/);
});

test('attachContextMenu refuses to start without its injected classes', () => {
  assert.throws(() => attachContextMenu({ webContents: new EventEmitter() }), /missing: ownerWindow, Menu, clipboard, isSafeExternalUrl, openExternal, log/);
});
