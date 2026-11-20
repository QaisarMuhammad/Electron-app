'use strict';

/**
 * SECURITY lens, IPC sender validation on EVERY handler (SPEC 6.3 and 12). REGRESSION GUARD (passes today). The channel list is
 * read from what the real bootstrap registered on the fake `ipcMain`, so a handler added later without a trust check fails here
 * even when nobody remembers to add a test for it.
 *
 * For each remote channel (the POS page's `window.electron`) the hostile senders are a foreign origin, a sub-frame of the POS
 * page, a destroyed sender, an opaque (`null`) origin and the app's own local page. For each `desktop:<area>:*` channel they are
 * the POS page itself, a window the POS page opened, a foreign page, a window registered for other areas, and a page that is not
 * inside src/renderer. Every answer must be UNTRUSTED_SENDER, and nothing may have happened: no print job, no DYMO label, no
 * relaunch, no clipboard write, no folder opened, no change of the settings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const nodePath = require('node:path');

const { createBootWorld, pageEvent, POS_ORIGIN, RENDERER_DIR } = require('../helpers/fake-boot');

const IGNORED = new Set(['app:origin-allowed', 'security:isAllowedOrigin']); // the origin questions answer from the frame itself

test('every handler refuses every kind of untrusted sender, and none of them does anything', async (t) => {
  const world = createBootWorld();
  t.after(() => world.cleanup());
  await world.boot();
  await world.loadPos();
  const { settingsWindow, passwordWindow, config } = world.services();
  settingsWindow.open();
  passwordWindow.open({ purpose: 'generic' });
  await world.settle();

  const settingsContents = settingsWindow.getWindow().webContents;
  const passwordContents = passwordWindow.getWindow().webContents;
  const mainContents = world.mainWindow().webContents;
  const localAt = (contents, file) => pageEvent({ contents, origin: 'file://', url: pathToFileURL(file).href });
  const outside = (contents) => localAt(contents, nodePath.join(nodePath.dirname(RENDERER_DIR), 'renderer-evil', 'settings.html'));

  const remoteHostile = {
    'a foreign origin': () => world.events.foreign(),
    'a sub-frame of the POS page': () => world.events.subFrame(),
    'a destroyed sender': () => { const event = pageEvent({ id: 9001, origin: POS_ORIGIN }); event.sender.isDestroyed = () => true; return event; },
    'an opaque origin': () => pageEvent({ contents: mainContents, origin: 'null', url: 'about:blank' }),
    "the app's own offline page": () => world.events.offline(),
    'a look-alike host': () => pageEvent({ contents: mainContents, origin: 'https://vendor.societyfiles.com.evil.example' }),
  };
  const desktopHostile = (area) => ({
    'the POS page in the main window': () => world.events.pos(),
    'a window opened by the POS page': () => world.events.popup(),
    'a foreign page': () => world.events.foreign(),
    'a local page outside src/renderer': () => outside(area === 'password' ? passwordContents : settingsContents),
    ...(area === 'settings' ? { 'the offline page (main window)': () => world.events.offline(), 'the password window': () => world.events.password() } : {}),
    ...(area === 'connection' ? { 'the password window': () => world.events.password() } : {}),
    ...(area === 'password' ? { 'the offline page (main window)': () => world.events.offline(), 'the Settings window': () => world.events.settings() } : {}),
  });

  const handlers = [...world.ipc.handlers.keys()].filter((channel) => !IGNORED.has(channel));
  const listeners = [...world.ipc.listeners.keys()].filter((channel) => !IGNORED.has(channel));
  // the three legacy messages of the POS page and the two network-back notices (one from the POS page, one from the offline screen)
  assert.ok(handlers.length >= 25 && listeners.length === 5, `the matrix must see the whole table (${handlers.length} handlers, ${listeners.length} messages)`);

  // An outage that is being tracked: a notice that was not refused would probe at once, and the fake network would see the request.
  world.services().connectivity.start('https://vendor.societyfiles.com/vendor/point-of-sale?active=buy', { mode: 'page', reason: 'offline' });
  const before = JSON.stringify(config.all());
  const dialogsBefore = world.dialog.calls.length;
  let checked = 0;
  for (const channel of handlers) {
    const desktop = /^desktop:([a-z]+):/.exec(channel);
    const senders = desktop ? desktopHostile(desktop[1]) : remoteHostile;
    for (const [who, makeEvent] of Object.entries(senders)) {
      const result = await world.ipc.invoke(channel, makeEvent(), {}, {});
      assert.equal(result && result.code, 'UNTRUSTED_SENDER', `${channel} answered ${JSON.stringify(result)} to ${who}`);
      assert.equal(result.ok, false);
      checked += 1;
    }
  }
  for (const channel of listeners) {
    const desktop = /^desktop:([a-z]+):/.exec(channel);
    for (const [who, makeEvent] of Object.entries(desktop ? desktopHostile(desktop[1]) : remoteHostile)) {
      await world.ipc.send(channel, makeEvent(), { receiptFileBinary: new Uint8Array([0x1b, 0x70, 0, 25, 255]), barcodefinal: '^XA^XZ', cashDrawerOpenPassword: 'x', openCashDrawer: true });
      checked += 1;
      assert.equal(world.dialog.calls.length, dialogsBefore, `${channel} from ${who} showed a box: the message was not dropped silently`);
    }
  }
  assert.equal(world.net.requests.length, 0, 'a refused network-back notice probed the server');

  assert.ok(checked > 150, `${checked} refusals checked`);
  assert.equal(world.rawPrinter.jobs.length, 0, 'a refused call printed something');
  assert.equal(world.dymo.prints.length, 0, 'a refused call printed a DYMO label');
  assert.equal(world.appCalls.relaunches, 0, 'a refused call restarted the app');
  assert.equal(world.clipboard.writes.length, 0);
  assert.equal(world.shell.paths.length + world.shell.opened.length, 0);
  assert.equal(JSON.stringify(config.all()), before, 'a refused call changed the settings');

  // positive controls: the table is not simply refusing everyone
  await world.ipc.send('desktop:connection:networkOnline', world.events.offline());
  await world.settle();
  assert.equal(world.net.requests.length, 1, 'the offline screen\'s notice does probe');
  assert.equal((await world.ipc.invoke('app-info', world.events.pos())).apiVersion, 2);
  assert.ok((await world.ipc.invoke('desktop:settings:getState', world.events.settings())).config);
  assert.equal((await world.ipc.invoke('desktop:password:getLockout', world.events.password())).locked, false);
  assert.equal((await world.ipc.invoke('desktop:connection:getStatus', world.events.offline())).online !== undefined, true);
});
