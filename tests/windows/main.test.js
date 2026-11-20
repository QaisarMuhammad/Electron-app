'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMainWindow, VERSION_ARG_PREFIX } = require('../../src/main/windows/main');
const { createFakeEnv } = require('../helpers/fake-window');

const SERVER_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';

function setup({ config = {}, overrides = {}, env: envOptions = {} } = {}) {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL, ...config }, ...envOptions });
  const controller = createMainWindow(env.mainDeps(overrides));
  return { env, controller, win: controller.window, contents: controller.window.webContents };
}

const rendererFile = (env, name) => path.join(env.paths.rendererDir, name);
const lastCall = (contents, name) => [...contents.calls].reverse().find((call) => call[0] === name);

// -- creation -------------------------------------------------------------------------------------------------------

test('the main window is created hidden, with the secure flags, the app preload and the performance options', () => {
  const { env, win } = setup();
  const { options } = win;
  assert.equal(options.show, false);
  assert.equal(options.title, 'GadgetsPOS');
  assert.equal(options.minWidth, 800);
  assert.equal(options.minHeight, 500);
  assert.equal(options.backgroundColor, '#F6F7FB');
  assert.equal(options.icon, path.join(env.paths.assetsDir, 'icon.ico'));
  assert.deepEqual(
    { ...options.webPreferences },
    {
      preload: path.join(env.paths.preloadDir, 'app.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
      additionalArguments: [`${VERSION_ARG_PREFIX}2.0.0-test`],
      v8CacheOptions: 'bypassHeatCheck',
    },
    'background throttling is not a webPreference: a POS window created with it off never paints its offline screen after a failed first load',
  );
});

test('DevTools are enabled only when the app runs in development', () => {
  const { win, controller, contents } = setup({ overrides: { isDev: true } });
  assert.equal(win.options.webPreferences.devTools, true);
  controller.toggleDevTools();
  assert.deepEqual(lastCall(contents, 'toggleDevTools'), ['toggleDevTools']);

  const packaged = setup();
  packaged.controller.toggleDevTools();
  assert.equal(lastCall(packaged.contents, 'toggleDevTools'), undefined, 'no toggle in a packaged app');
});

test('macOS gets no window icon option (it uses the app bundle icon)', () => {
  const { win } = setup({ overrides: { platform: 'darwin' } });
  assert.equal('icon' in win.options, false);
});

test('the native theme stays on "system" and the background follows a dark system', () => {
  const env = createFakeEnv({ themeSource: 'dark', config: { serverUrl: SERVER_URL } });
  env.nativeTheme.shouldUseDarkColors = true;
  const controller = createMainWindow(env.mainDeps());
  assert.equal(env.nativeTheme.themeSource, 'system');
  assert.equal(controller.window.options.backgroundColor, '#0D1720');
});

test('missing injected classes fail loudly at creation, naming every one of them', () => {
  const env = createFakeEnv();
  const deps = env.mainDeps();
  delete deps.Menu;
  delete deps.registry;
  assert.throws(() => createMainWindow(deps), (err) => err instanceof TypeError && /Menu, registry|registry, Menu/.test(err.message));
});

test('the window is registered with the connection and window areas (its local pages: loading and offline)', () => {
  const { env, contents } = setup();
  assert.deepEqual(env.registry.get(contents.id), ['connection', 'window']);
});

test('every webContents gets the guards and a registry entry without areas; the entry goes when it is destroyed', () => {
  const { env, contents } = setup();
  assert.equal(env.security.attached.length, 1);
  assert.equal(env.security.attached[0].webContents, contents);

  const child = new env.BrowserWindow({ x: 0, y: 0, width: 400, height: 300 });
  assert.equal(env.security.attached.length, 2, 'children are guarded too');
  assert.deepEqual(env.registry.get(child.webContents.id), [], 'a window.open child may call no desktop:* area');
  child.destroy();
  assert.equal(env.registry.has(child.webContents.id), false);
});

test('the guards receive openExternal, notify, the options for windows the page opens, and a logging onBlocked', () => {
  const notices = [];
  const notify = (message) => notices.push(message);
  const { env } = setup({ overrides: { notify } });
  const { options } = env.security.attached[0];
  assert.equal(options.openExternal, env.openExternal);
  assert.equal(options.notify, notify);

  const child = options.createChildWindow({ url: 'about:blank' });
  assert.equal(child.autoHideMenuBar, true);
  assert.equal(child.icon, path.join(env.paths.assetsDir, 'icon.ico'));
  assert.equal(child.webPreferences.preload, path.join(env.paths.preloadDir, 'app.js'));
  assert.equal(child.webPreferences.sandbox, true);
  assert.equal(child.webPreferences.contextIsolation, true);
  assert.equal(child.webPreferences.nodeIntegration, false);
  assert.equal(child.webPreferences.backgroundThrottling, undefined, 'only the POS window itself is never throttled');

  options.onBlocked({ source: 'will-navigate', reason: 'unsafe-url', url: 'https://evil.example.com/steal?token=secret', protocol: 'https:', host: 'evil.example.com' });
  options.onBlocked({ source: 'window-open', reason: 'unsafe-url', url: 'javascript:alert(1)' });
  options.onBlocked('not an info object');
  const logged = env.log.texts('info').join('\n');
  assert.match(logged, /will-navigate blocked \(unsafe-url\): https:\/\/evil\.example\.com\/steal/);
  assert.doesNotMatch(logged, /token=secret/, 'a query string is never logged');
  assert.doesNotMatch(logged, /alert/, 'a javascript: URL is never logged');
});

test('without a notify function the guards simply get none', () => {
  const { env } = setup();
  assert.equal(env.security.attached[0].options.notify, undefined);
});

test('a guard that fails to attach, or a registry that fails, is logged and neither stops the other nor the window', () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.security.attachGuards = () => {
    throw new Error('guard broke');
  };
  const registryAfter = new Map();
  env.registry.set = (id, areas) => {
    if (areas.length === 0) throw new Error('registry broke');
    registryAfter.set(id, areas);
  };
  let controller;
  assert.doesNotThrow(() => {
    controller = createMainWindow(env.mainDeps());
  });
  const errors = env.log.texts('error').join('\n');
  assert.match(errors, /could not attach the navigation guards/);
  assert.match(errors, /could not register a new window/);
  assert.deepEqual(registryAfter.get(controller.window.webContents.id), ['connection', 'window'], 'the main window is still registered with its areas');
});

test('the guard listener is installed once per app, even when the main window is created again', () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  createMainWindow(env.mainDeps());
  createMainWindow(env.mainDeps());
  assert.equal(env.app.listenerCount('web-contents-created'), 1);
  assert.equal(env.security.attached.length, 2, 'one guard call per webContents, not two');
});

// -- showing ---------------------------------------------------------------------------------------------------------

test('the window is shown on ready-to-show, once, and announces it', () => {
  const { env, controller, win } = setup();
  let visible = 0;
  controller.on('visible', () => {
    visible += 1;
  });
  assert.equal(win.visible, false);
  assert.equal(env.timers.pendingCount(), 1, 'only the show fallback timer exists');

  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  assert.deepEqual(win.calls.filter((call) => call === 'show'), ['show']);
  assert.equal(visible, 1);
  assert.equal(env.timers.pendingCount(), 0, 'the fallback timer is cleared');

  win.emit('ready-to-show');
  env.timers.advance(10000);
  assert.equal(visible, 1);
  assert.equal(win.calls.filter((call) => call === 'show').length, 1);
});

test('the window is shown after 4 s even when ready-to-show never arrives', () => {
  const { env, win } = setup();
  env.timers.advance(3999);
  assert.equal(win.visible, false);
  env.timers.advance(1);
  assert.equal(win.visible, true);
});

test('showLoading puts the window on screen at once, before the page has been drawn: the loading screen is requested first, ready-to-show only announces "painted"', () => {
  const { env, controller, win, contents } = setup();
  const order = [];
  const loadFile = contents.loadFile.bind(contents);
  contents.loadFile = (...args) => {
    order.push('loadFile');
    return loadFile(...args);
  };
  const show = win.show.bind(win);
  win.show = () => {
    order.push('show');
    show();
  };
  const events = [];
  controller.on('visible', () => events.push('visible'));
  controller.on('painted', () => events.push('painted'));
  assert.equal(win.visible, false);

  const loading = controller.showLoading();
  assert.equal(win.visible, true, 'on screen before the renderer has drawn anything: the window shows the colour of the page meanwhile');
  assert.deepEqual(order, ['loadFile', 'show'], 'the page is requested first, so the renderer starts while the window comes up');
  assert.deepEqual(events, ['visible']);
  assert.equal(env.timers.pendingCount(), 0, 'the fallback that shows a window nobody showed is gone');

  win.emit('ready-to-show');
  assert.deepEqual(events, ['visible', 'painted']);
  assert.deepEqual(order, ['loadFile', 'show'], 'ready-to-show shows nothing a second time');
  win.emit('ready-to-show');
  assert.deepEqual(events, ['visible', 'painted'], 'painted is announced once');
  return loading;
});

test('a loading screen that is requested again shows nothing again, and one that was never requested is shown by ready-to-show as before', async () => {
  const { controller, win } = setup();
  await controller.showLoading();
  await controller.showLoading();
  assert.equal(win.calls.filter((call) => call === 'show').length, 1);

  const other = setup();
  let visible = 0;
  other.controller.on('visible', () => {
    visible += 1;
  });
  other.win.emit('ready-to-show');
  assert.equal(other.win.visible, true);
  assert.equal(visible, 1);
});

test('showLoading applies maximized and full screen first, like any other first show', async () => {
  const { controller, win } = setup({ config: { window: { maximized: true, fullScreen: true } } });
  assert.deepEqual(win.calls, []);
  await controller.showLoading();
  assert.deepEqual(win.calls, ['maximize', 'setFullScreen:true', 'show']);
});

test('maximized and full screen are applied when the window is shown, in that order and before show()', () => {
  const { win } = setup({ config: { window: { maximized: true, fullScreen: true } } });
  assert.deepEqual(win.calls, [], 'a hidden window is not maximized early: maximize() would show it before it is ready');
  win.emit('ready-to-show');
  assert.deepEqual(win.calls, ['maximize', 'setFullScreen:true', 'show']);
});

test('"start in full screen" starts the window in full screen', () => {
  const { win } = setup({ config: { window: { startFullScreen: true } } });
  win.emit('ready-to-show');
  assert.ok(win.calls.includes('setFullScreen:true'));
  assert.equal(win.fullScreen, true);
});

test('a first run on a small display starts maximized with the work-area size', () => {
  const { win } = setup({ env: { workAreas: [{ x: 0, y: 0, width: 1366, height: 728 }] } });
  assert.deepEqual({ x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height }, { x: 0, y: 0, width: 1366, height: 728 });
  win.emit('ready-to-show');
  assert.equal(win.maximized, true);
});

test('saved bounds are restored; bounds from a monitor that is gone are not', () => {
  const saved = setup({ config: { window: { bounds: { x: 300, y: 120, width: 1280, height: 720 } } } });
  assert.deepEqual({ x: saved.win.options.x, y: saved.win.options.y, width: saved.win.options.width, height: saved.win.options.height }, { x: 300, y: 120, width: 1280, height: 720 });

  const gone = setup({ config: { window: { bounds: { x: 3000, y: 120, width: 1280, height: 720 } } } });
  assert.deepEqual({ x: gone.win.options.x, y: gone.win.options.y, width: gone.win.options.width, height: gone.win.options.height }, { x: 160, y: 70, width: 1600, height: 900 });
});

// -- state persistence -----------------------------------------------------------------------------------------------

test('resize and move are saved once, 500 ms after the last event, from the NORMAL bounds', () => {
  const { env, win } = setup();
  win.emit('ready-to-show'); // the show fallback timer is gone, so only the save timer is left to count
  win.normalBounds = { x: 10, y: 20, width: 1111, height: 777 };
  for (let i = 0; i < 20; i += 1) {
    win.emit('resize');
    env.timers.advance(100);
  }
  assert.deepEqual(env.config.sets, [], 'nothing is written while the drag continues');
  env.timers.advance(500);
  assert.deepEqual(env.config.sets, [
    ['window.bounds', { x: 10, y: 20, width: 1111, height: 777 }],
    ['window.maximized', false],
    ['window.fullScreen', false],
  ]);
  assert.equal(env.timers.pendingCount(), 0);
});

test('an unchanged window state is never written again', () => {
  const { env, win } = setup();
  win.emit('move');
  env.timers.advance(500);
  const writes = env.config.sets.length;
  win.emit('move');
  env.timers.advance(500);
  assert.equal(env.config.sets.length, writes);
});

test('maximize, full screen and close are saved at once, close from the normal bounds', () => {
  const { env, win } = setup();
  win.maximize();
  assert.ok(env.config.sets.some(([key, value]) => key === 'window.maximized' && value === true));

  win.emit('move'); // a debounced save is waiting ...
  win.normalBounds = { x: 5, y: 6, width: 1000, height: 700 };
  win.emit('close', { preventDefault() {} });
  assert.deepEqual(env.config.get('window.bounds'), { x: 5, y: 6, width: 1000, height: 700 });
  assert.equal(env.timers.pendingCount(), 1, 'only the show fallback is left: close cancelled the waiting save');
});

test('toggling full screen is remembered in window.fullScreen, from the menu and from the system', () => {
  const { env, controller, win } = setup();
  controller.toggleFullScreen();
  assert.equal(win.fullScreen, true);
  assert.equal(env.config.get('window.fullScreen'), true);
  controller.toggleFullScreen();
  assert.equal(win.fullScreen, false);
  assert.equal(env.config.get('window.fullScreen'), false);

  win.setFullScreen(true); // the system's own button
  assert.equal(env.config.get('window.fullScreen'), true);
});

test('a failing config write is logged, never thrown into the window event', () => {
  const { env, win } = setup();
  env.config.set = () => {
    throw new Error('disk full');
  };
  assert.doesNotThrow(() => win.emit('maximize'));
  assert.match(env.log.texts('error').join('\n'), /save window state failed/);
});

// -- zoom ------------------------------------------------------------------------------------------------------------

test('the saved zoom is applied as soon as the DOM is ready and again after every load, without redundant calls', () => {
  const { contents } = setup({ config: { window: { zoomLevel: 1 } } });
  contents.emit('dom-ready');
  assert.deepEqual(contents.calls.filter((call) => call[0] === 'setZoomLevel'), [['setZoomLevel', 1]]);
  contents.emit('did-finish-load');
  contents.emit('did-finish-load');
  assert.equal(contents.calls.filter((call) => call[0] === 'setZoomLevel').length, 1);
  contents.zoomLevel = 0; // a navigation to another origin resets Chromium's level
  contents.emit('did-finish-load');
  assert.equal(contents.zoomLevel, 1);
});

test('zoom in and out move in steps of 0.5, stay within -3..5 and are saved', () => {
  const { env, controller, contents } = setup();
  controller.zoomIn();
  assert.equal(env.config.get('window.zoomLevel'), 0.5);
  assert.equal(contents.zoomLevel, 0.5);
  for (let i = 0; i < 20; i += 1) controller.zoomIn();
  assert.equal(env.config.get('window.zoomLevel'), 5);
  for (let i = 0; i < 30; i += 1) controller.zoomOut();
  assert.equal(env.config.get('window.zoomLevel'), -3);
  assert.equal(contents.zoomLevel, -3);
  controller.resetZoom();
  assert.equal(env.config.get('window.zoomLevel'), 0);
  assert.equal(contents.zoomLevel, 0);
});

test('a hand-edited zoom level outside the range is clamped when applied', () => {
  const { contents } = setup({ config: { window: { zoomLevel: 99 } } });
  contents.emit('did-finish-load');
  assert.equal(contents.zoomLevel, 5);
});

// -- title -----------------------------------------------------------------------------------------------------------

test('the title follows the page and falls back to GadgetsPOS', () => {
  const { win } = setup();
  const update = (title, explicitSet) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    win.emit('page-title-updated', event, title, explicitSet);
    return event.prevented;
  };
  assert.equal(update('New order - Society Files', true), true, 'the default title update is replaced');
  assert.equal(win.title, 'New order - Society Files');
  update('', true);
  assert.equal(win.title, 'GadgetsPOS');
  update('loading.html', false);
  assert.equal(win.title, 'GadgetsPOS');
});

// -- loading and the POS ---------------------------------------------------------------------------------------------

test('showLoading loads loading.html from the renderer folder', async () => {
  const { env, controller, contents } = setup();
  await controller.showLoading();
  const [, file, options] = lastCall(contents, 'loadFile');
  assert.equal(file, rendererFile(env, 'loading.html'));
  assert.equal(options, undefined);
});

test('loadPos loads the current serverUrl, read again on every call', async () => {
  const { env, controller, contents } = setup();
  await controller.loadPos();
  assert.deepEqual(lastCall(contents, 'loadURL'), ['loadURL', SERVER_URL]);
  env.config.set('serverUrl', 'https://shop.example.com/pos');
  await controller.loadPos();
  assert.deepEqual(lastCall(contents, 'loadURL'), ['loadURL', 'https://shop.example.com/pos']);
});

test('getServerUrl overrides the configured address (development start URL)', async () => {
  const { controller, contents } = setup({ overrides: { getServerUrl: () => 'http://127.0.0.1:4000/pos' } });
  await controller.loadPos();
  assert.deepEqual(lastCall(contents, 'loadURL'), ['loadURL', 'http://127.0.0.1:4000/pos']);
});

test('loadPos never rejects when the navigation fails (did-fail-load shows the offline screen)', async () => {
  const { controller, contents, env } = setup();
  contents.loadFailures.push(new Error('ERR_CONNECTION_REFUSED (-102) loading https://vendor.societyfiles.com/'));
  await assert.doesNotReject(controller.loadPos());
  assert.match(env.log.texts('info').join('\n'), /POS page did not finish/);
});

test('an invalid serverUrl shows the offline screen with a clear message and does not start reconnecting', async () => {
  for (const serverUrl of ['', 'not a url', 'ftp://example.com/', 'javascript:alert(1)', 42, undefined]) {
    const { env, controller, contents } = setup({ config: { serverUrl } });
    await controller.loadPos();
    assert.equal(lastCall(contents, 'loadURL'), undefined, String(serverUrl));
    const [, file, options] = lastCall(contents, 'loadFile');
    assert.equal(file, rendererFile(env, 'offline.html'));
    assert.equal(options.query.reason, 'other');
    assert.equal(options.query.code, 'INVALID_URL');
    assert.match(options.query.desc, /server address is not valid/);
    assert.equal(env.connectivity.starts.length, 0);
  }
});

// -- reload, focus, events -------------------------------------------------------------------------------------------

test('reload reloads the POS page in place, loads the POS from a local page, and force reload skips the cache', async () => {
  const { controller, contents } = setup();
  contents.url = 'https://vendor.societyfiles.com/vendor/orders';
  await controller.reload();
  assert.deepEqual(lastCall(contents, 'reload'), ['reload']);
  await controller.reload({ force: true });
  assert.deepEqual(lastCall(contents, 'reloadIgnoringCache'), ['reloadIgnoringCache']);
  assert.equal(lastCall(contents, 'loadURL'), undefined);

  contents.url = pathToFileURL('/app/src/renderer/loading.html').href;
  await controller.reload();
  assert.deepEqual(lastCall(contents, 'loadURL'), ['loadURL', SERVER_URL]);
});

test('focus restores a minimized window, shows and focuses it', () => {
  const { controller, win } = setup();
  win.minimized = true;
  controller.focus();
  assert.deepEqual(win.calls.slice(-3), ['restore', 'show', 'focus']);
  assert.equal(win.minimized, false);
});

test('pos-dom-ready and pos-loaded fire for the POS but not for the app\'s own pages', () => {
  const { controller, contents } = setup();
  const seen = [];
  controller.on('pos-dom-ready', () => seen.push('dom'));
  controller.on('pos-loaded', () => seen.push('loaded'));

  contents.url = pathToFileURL('/app/src/renderer/loading.html').href;
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, []);

  contents.url = SERVER_URL;
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, ['dom', 'loaded']);
});

test('pos-dom-ready and pos-loaded do not fire for the error page Chromium shows after a failed load or a server error', () => {
  const { env, controller, contents } = setup();
  const seen = [];
  controller.on('pos-dom-ready', () => seen.push('dom'));
  controller.on('pos-loaded', () => seen.push('loaded'));

  // a refused connection: did-fail-load first, then Chromium finishes loading its own error page (URL = the failed address)
  contents.url = SERVER_URL;
  contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', SERVER_URL, true, 1, 1);
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, []);

  // a 503 page: did-navigate first, then the page finishes loading
  contents.emit('did-navigate', {}, SERVER_URL, 503, 'Service Unavailable');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, []);
  assert.equal(env.connectivity.starts.length, 2);

  // the POS answers again: loadPos() ends the offline state, so the next load counts
  controller.loadPos();
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, ['dom', 'loaded']);
});

test('R2: the POS is never throttled once it is on screen; the loading screen, the offline screen and an error page are left alone', () => {
  const { controller, contents } = setup();
  const throttling = () => contents.calls.filter((call) => call[0] === 'setBackgroundThrottling');

  contents.url = pathToFileURL('/app/src/renderer/loading.html').href;
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(throttling(), [], 'the app\'s own pages keep Electron\'s default, so they paint even after a failed first load');

  contents.url = SERVER_URL;
  contents.emit('dom-ready');
  assert.deepEqual(throttling(), [['setBackgroundThrottling', false]], 'switched off as soon as the POS document is ready');
  contents.emit('did-finish-load');
  assert.equal(throttling().length, 2, 'and again when it has loaded: a load can swap the renderer, so the setting is applied after every one');
  assert.ok(throttling().every((call) => call[1] === false));

  contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', SERVER_URL, true, 1, 1);
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.equal(throttling().length, 2, 'the error page Chromium shows after a failed load does not count as the POS');
  controller.destroy();
});

test('R2: a web contents without setBackgroundThrottling, or one that throws, does not break the page load', () => {
  const { env, controller, contents } = setup();
  const seen = [];
  controller.on('pos-loaded', () => seen.push('loaded'));
  contents.setBackgroundThrottling = () => {
    throw new Error('gone');
  };
  contents.url = SERVER_URL;
  contents.emit('dom-ready');
  contents.emit('did-finish-load');
  assert.deepEqual(seen, ['loaded'], 'pos-loaded still fires');
  assert.match(env.log.texts('warn').join('\n'), /could not stop the page from being throttled/);

  delete contents.setBackgroundThrottling;
  contents.emit('did-finish-load');
  assert.deepEqual(seen, ['loaded', 'loaded']);
});

test('a listener that throws is logged and does not break the window', () => {
  const { controller, contents, env } = setup();
  controller.on('pos-loaded', () => {
    throw new Error('listener bug');
  });
  contents.url = SERVER_URL;
  assert.doesNotThrow(() => contents.emit('did-finish-load'));
  assert.match(env.log.texts('error').join('\n'), /listener of "pos-loaded" failed/);
  // and off() removes a listener
  const handler = () => {
    throw new Error('never');
  };
  controller.on('pos-loaded', handler).off('pos-loaded', handler);
});

test('destroy saves the state, stops the timers and the probe and destroys the window; calling it twice is harmless', () => {
  const { env, controller, win } = setup();
  controller.showOffline({ reason: 'dns' });
  assert.equal(env.connectivity.running, true);
  win.normalBounds = { x: 1, y: 2, width: 900, height: 600 };
  controller.destroy();
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(env.config.get('window.bounds'), { x: 1, y: 2, width: 900, height: 600 });
  assert.equal(env.connectivity.running, false);
  assert.equal(env.timers.pendingCount(), 0);
  assert.doesNotThrow(() => controller.destroy());
  // a destroyed controller ignores everything
  assert.doesNotThrow(() => {
    controller.zoomIn();
    controller.focus();
    controller.toggleFullScreen();
    controller.handleConnectivityStatus({ online: true });
  });
});

// -- right-click menu ------------------------------------------------------------------------------------------------

test('a right click pops up the context menu in the window, and nothing in an empty area', () => {
  const { env, win, contents } = setup();
  contents.emit('context-menu', {}, { isEditable: true, editFlags: {}, x: 1, y: 2 });
  assert.equal(env.Menu.built.length, 1);
  assert.deepEqual(env.Menu.built[0].popups, [{ window: win }]);
  assert.ok(env.Menu.built[0].template.some((item) => item.role === 'paste'));

  contents.emit('context-menu', {}, { isEditable: false, selectionText: '', linkURL: '', mediaType: 'none', x: 1, y: 2 });
  assert.equal(env.Menu.built.length, 1, 'no menu for an empty template');
});

test('in development the right-click menu offers Inspect element', () => {
  const { env, contents } = setup({ overrides: { isDev: true } });
  contents.emit('context-menu', {}, { isEditable: false, x: 3, y: 4 });
  const item = env.Menu.built[0].template.find((entry) => entry.label === 'Inspect element');
  assert.ok(item);
  item.click();
  assert.deepEqual(lastCall(contents, 'inspectElement'), ['inspectElement', 3, 4]);
});
