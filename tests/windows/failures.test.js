'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMainWindow } = require('../../src/main/windows/main');
const { createFakeEnv, createFakeDialog } = require('../helpers/fake-window');

const SERVER_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ overrides = {}, config = {} } = {}) {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL, ...config } });
  const controller = createMainWindow(env.mainDeps(overrides));
  return { env, controller, win: controller.window, contents: controller.window.webContents };
}

/** The offline pages loaded so far, as their query objects. */
const offlineLoads = (env, contents) =>
  contents.calls.filter((call) => call[0] === 'loadFile' && call[1] === path.join(env.paths.rendererDir, 'offline.html')).map((call) => call[2].query);

const failLoad = (contents, code, description, url = SERVER_URL, isMainFrame = true) =>
  contents.emit('did-fail-load', {}, code, description, url, isMainFrame, 1, 1);

// -- did-fail-load: every reason -------------------------------------------------------------------------------------

test('a failed main-frame load shows offline.html with the reason, code, description and address, and starts reconnecting', async () => {
  const table = [
    [-106, 'ERR_INTERNET_DISCONNECTED', 'offline'],
    [-21, 'ERR_NETWORK_CHANGED', 'offline'],
    [-105, 'ERR_NAME_NOT_RESOLVED', 'dns'],
    [-102, 'ERR_CONNECTION_REFUSED', 'refused'],
    [-101, 'ERR_CONNECTION_RESET', 'refused'],
    [-100, 'ERR_CONNECTION_CLOSED', 'refused'],
    [-7, 'ERR_TIMED_OUT', 'timeout'],
    [-118, 'ERR_CONNECTION_TIMED_OUT', 'timeout'],
    [-202, 'ERR_CERT_AUTHORITY_INVALID', 'tls'],
    [-107, 'ERR_SSL_PROTOCOL_ERROR', 'tls'],
    [-2, 'ERR_FAILED', 'other'],
  ];
  for (const [code, description, reason] of table) {
    const { env, contents } = setup();
    failLoad(contents, code, description);
    await flush();
    const queries = offlineLoads(env, contents);
    assert.equal(queries.length, 1, description);
    assert.deepEqual(queries[0], { reason, code: String(code), desc: description, url: 'https://vendor.societyfiles.com/vendor/point-of-sale' }, description);
    assert.deepEqual(
      env.connectivity.starts,
      [{ url: SERVER_URL, options: { mode: 'page', reason, lastError: { code, description } } }],
      `${description}: the probe is told what failed`,
    );
  }
});

test('the query string carries text only: control characters are removed, long text is shortened, the address has no query', async () => {
  const { env, contents } = setup();
  failLoad(contents, -2, `bad\nline\u0007<script>alert(1)</script>${'x'.repeat(400)}`, 'https://user:pass@vendor.societyfiles.com/cb?code=SECRET#frag');
  await flush();
  const [query] = offlineLoads(env, contents);
  assert.doesNotMatch(query.desc, /[\u0000-\u001F]/);
  assert.ok(query.desc.length <= 200);
  assert.equal(query.url, 'https://vendor.societyfiles.com/cb', 'no credentials, query or fragment');
});

test('ERR_ABORTED, sub-frame failures and failures of the app\'s own pages are ignored', async () => {
  const { env, contents } = setup();
  failLoad(contents, -3, 'ERR_ABORTED');
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example.com/frame', false);
  failLoad(contents, -6, 'ERR_FILE_NOT_FOUND', pathToFileURL('/app/src/renderer/offline.html').href);
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
  assert.equal(env.connectivity.starts.length, 0);
  assert.match(env.log.texts('error').join('\n'), /a local page could not be loaded/, 'a missing local page is reported, without looping');
});

test('a second failure during an outage shows the new reason and tells the probe, which merges it into one loop', async () => {
  const { env, contents } = setup();
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  failLoad(contents, -102, 'ERR_CONNECTION_REFUSED');
  await flush();
  assert.deepEqual(offlineLoads(env, contents).map((query) => query.reason), ['dns', 'refused']);
  assert.deepEqual(
    env.connectivity.starts.map((entry) => [entry.options.mode, entry.options.reason, entry.options.lastError.code]),
    [['page', 'dns', -105], ['page', 'refused', -102]],
  );
});

test('a probe that cannot be started is logged and does not break the screen', async () => {
  const { env, contents } = setup();
  env.connectivity.start = () => {
    throw new Error('probe broken');
  };
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  await flush();
  assert.equal(offlineLoads(env, contents).length, 1);
  assert.match(env.log.texts('error').join('\n'), /could not start the connectivity probe/);
});

// -- HTTP 5xx --------------------------------------------------------------------------------------------------------

test('an HTTP 5xx answer from the POS server shows the same screen with reason "server"', async () => {
  const { env, contents } = setup();
  contents.emit('did-navigate', {}, 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy', 503, 'Service Unavailable');
  await flush();
  assert.deepEqual(offlineLoads(env, contents), [{ reason: 'server', code: '503', desc: 'Service Unavailable', url: 'https://vendor.societyfiles.com/vendor/point-of-sale' }]);
  assert.deepEqual(env.connectivity.starts, [{ url: SERVER_URL, options: { mode: 'page', reason: 'server', lastError: { code: 503, description: 'Service Unavailable' } } }]);
});

test('only server errors of the POS origin count: 200, 404, other origins and local pages do not', async () => {
  const { env, contents } = setup();
  contents.emit('did-navigate', {}, SERVER_URL, 200, 'OK');
  contents.emit('did-navigate', {}, SERVER_URL, 404, 'Not Found');
  contents.emit('did-navigate', {}, SERVER_URL, 499, '');
  contents.emit('did-navigate', {}, 'https://other.example.com/', 500, 'Internal Server Error');
  contents.emit('did-navigate', {}, pathToFileURL('/app/src/renderer/offline.html').href, -1, '');
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
});

test('a 500 without a status text still gets a plain description', async () => {
  const { env, contents } = setup();
  contents.emit('did-navigate', {}, SERVER_URL, 500, '');
  await flush();
  assert.equal(offlineLoads(env, contents)[0].desc, 'Server error');
});

// -- a redirect to an address the app does not trust -----------------------------------------------------------------

const loadingUrl = (env) => pathToFileURL(path.join(env.paths.rendererDir, 'loading.html')).href;
const offlineUrl = (env) => pathToFileURL(path.join(env.paths.rendererDir, 'offline.html')).href;

/**
 * A will-redirect event as Electron 25+ delivers it. `cancelled` is what the navigation guards did before this listener ran: they
 * are attached when the window is created, so they always run first and have already called preventDefault() (SPEC 12).
 */
const redirect = (url, { cancelled = true, isMainFrame = true } = {}) => ({
  url,
  isMainFrame,
  defaultPrevented: cancelled,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

test('a redirect the guards cancelled while the loading screen is on display shows a plain screen instead of "Starting GadgetsPOS..." for ever', async () => {
  const { env, contents } = setup();
  contents.url = loadingUrl(env);
  contents.emit('will-redirect', redirect('https://www.example.com/login?next=pos&token=SECRET'));
  await flush();

  const queries = offlineLoads(env, contents);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].reason, 'other');
  assert.equal(queries[0].code, 'REDIRECT_BLOCKED');
  assert.match(queries[0].desc, /leads to www\.example\.com, which GadgetsPOS does not open\. Check the address in Settings > Connection\./);
  assert.equal(queries[0].url, 'https://vendor.societyfiles.com/vendor/point-of-sale', 'the address of the POS, not the one it was sent to');
  assert.doesNotMatch(JSON.stringify(queries), /SECRET|token|login/, 'nothing of the foreign address but its host');
  assert.deepEqual(env.connectivity.starts, [], 'no reconnection: the server answers, so a probe would reload the page into the same redirect for ever');
  assert.equal(env.connectivity.running, false);
});

test('a reload that the server sends away again stops the reconnection and says why, instead of staying on the offline screen', async () => {
  const { env, controller, contents } = setup();
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  await flush();
  assert.equal(env.connectivity.running, true);

  controller.handleConnectivityStatus({ online: true }); // the probe got an answer: the POS is loaded again ...
  await flush();
  contents.url = offlineUrl(env); // ... and the old page stays up until the new one is committed, which a cancelled redirect never is
  contents.emit('will-redirect', redirect('https://www.example.com/'));
  await flush();

  const last = offlineLoads(env, contents).pop();
  assert.equal(last.code, 'REDIRECT_BLOCKED');
  assert.equal(env.connectivity.running, false);
  assert.equal(env.connectivity.starts.length, 1, 'only the first outage started a probe');
});

test('"Retry now" on that screen loads the POS again, and View > Reload does the same', async () => {
  const { env, controller, contents } = setup();
  contents.url = loadingUrl(env);
  contents.emit('will-redirect', redirect('https://www.example.com/'));
  await flush();
  contents.calls.length = 0;
  await controller.retryNow();
  assert.deepEqual(contents.calls, [['loadURL', SERVER_URL]], 'nothing is retrying, so Retry now loads the POS');
  contents.url = offlineUrl(env);
  contents.calls.length = 0;
  await controller.reload();
  assert.deepEqual(contents.calls, [['loadURL', SERVER_URL]]);
});

test('a redirect that is not cancelled, one in a sub-frame, and a cancelled one while the POS itself is on display change nothing', async () => {
  const { env, contents } = setup();
  contents.url = loadingUrl(env);
  contents.emit('will-redirect', redirect('https://vendor.societyfiles.com/vendor/orders', { cancelled: false }));
  contents.emit('will-redirect', redirect('https://ads.example.com/frame', { isMainFrame: false }));
  contents.url = SERVER_URL; // a link inside the running POS: the page stays, and the guard already sent an https link to the browser
  contents.emit('will-redirect', redirect('https://www.example.com/'));
  contents.url = '';
  contents.emit('will-redirect', redirect('https://www.example.com/'));
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
  assert.equal(env.connectivity.starts.length, 0);
});

test('the older positional arguments of will-redirect (url, isInPlace, isMainFrame) are read too, and an unusable address still gives a sentence', async () => {
  const { env, contents } = setup();
  contents.url = loadingUrl(env);
  contents.emit('will-redirect', { defaultPrevented: true }, 'https://shop.example.org/home', false, true);
  contents.emit('will-redirect', { defaultPrevented: true }, 'https://shop.example.org/home', false, false);
  contents.emit('will-redirect', { defaultPrevented: true });
  await flush();
  const queries = offlineLoads(env, contents);
  assert.equal(queries.length, 2, 'the sub-frame one is ignored');
  assert.match(queries[0].desc, /leads to shop\.example\.org, which/);
  assert.match(queries[1].desc, /leads to another website, which/);
});

test('the sentence names the host only: no credentials, no path, and a very long host still leaves the whole sentence readable', async () => {
  const { env, contents } = setup();
  contents.url = loadingUrl(env);
  contents.emit('will-redirect', redirect('https://user:hunter2@login.example.org:8443/a/b?c=d'));
  contents.emit('will-redirect', redirect(`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.org/`));
  await flush();
  const [first, long] = offlineLoads(env, contents);
  assert.match(first.desc, /^The server address leads to login\.example\.org:8443, which GadgetsPOS does not open\./);
  assert.doesNotMatch(first.desc, /hunter2|user|\/a\/b/);
  assert.match(long.desc, /which GadgetsPOS does not open\. Check the address in Settings > Connection\.$/, 'the instruction survives the 200 character limit');
});

test('a destroyed window, and a listener that fails, never throw into Electron', async () => {
  const { env, controller, contents } = setup();
  contents.url = loadingUrl(env);
  assert.doesNotThrow(() => contents.emit('will-redirect', null));
  controller.destroy();
  assert.doesNotThrow(() => contents.emit('will-redirect', redirect('https://www.example.com/')));
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
});

// -- automatic reconnection ------------------------------------------------------------------------------------------

test('a successful probe stops the probe and reloads the POS; later "online" statuses do not reload again', async () => {
  const { env, controller, contents } = setup();
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  await flush();
  contents.calls.length = 0;

  controller.handleConnectivityStatus({ online: false, attempt: 1, nextRetryInMs: 3000 });
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, 0, 'an offline status changes nothing');

  controller.handleConnectivityStatus({ online: true, attempt: 2 });
  await flush();
  assert.deepEqual(contents.calls.filter((call) => call[0] === 'loadURL'), [['loadURL', SERVER_URL]]);
  assert.equal(env.connectivity.stops, 1);
  assert.equal(env.connectivity.running, false);

  controller.handleConnectivityStatus({ online: true, attempt: 3 });
  await flush();
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, 1);
});

test('every status is forwarded to the page: the countdown of the offline screen and the banner of the app preload', () => {
  const { controller, contents } = setup();
  const status = { online: false, attempt: 2, nextRetryInMs: 6000, lastError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' }, url: SERVER_URL, reason: 'dns' };
  controller.handleConnectivityStatus(status);
  assert.deepEqual(contents.sent, [
    { channel: 'desktop:connection:status', args: [status] },
    { channel: 'connectivity:status', args: [status] },
  ]);
});

test('in banner mode (no offline screen) a successful probe is forwarded but the page is NOT reloaded', () => {
  const { env, controller, contents } = setup();
  contents.url = SERVER_URL;
  controller.handleConnectivityStatus({ online: true });
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, 0);
  assert.equal(env.connectivity.stops, 0);
  assert.equal(contents.channels().length, 2);
});

test('statuses that are not objects are ignored', () => {
  const { controller, contents } = setup();
  for (const junk of [null, undefined, 'online', 42]) controller.handleConnectivityStatus(junk);
  assert.equal(contents.sent.length, 0);
});

test('"Retry now" reloads the POS once the server answers, after a server error too', async () => {
  const { env, controller, contents } = setup();
  contents.emit('did-navigate', {}, SERVER_URL, 502, 'Bad Gateway');
  await flush();
  controller.handleConnectivityStatus({ online: true });
  await flush();
  assert.deepEqual(lastLoad(contents), ['loadURL', SERVER_URL]);
  assert.equal(env.connectivity.running, false);
});

function lastLoad(contents) {
  return [...contents.calls].reverse().find((call) => call[0] === 'loadURL');
}

test('the full flow: loading, then the POS, a failure, the offline screen, a successful probe, the POS again', async () => {
  const { env, controller, win, contents } = setup();
  await controller.showLoading();
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  await controller.loadPos();
  failLoad(contents, -102, 'ERR_CONNECTION_REFUSED');
  await flush();
  assert.equal(offlineLoads(env, contents).length, 1);
  controller.handleConnectivityStatus({ online: true });
  await flush();
  assert.deepEqual(contents.calls.map((call) => call[0]), ['loadFile', 'loadURL', 'loadFile', 'loadURL']);
  assert.equal(contents.url, SERVER_URL);
});

// -- crashes and hangs -----------------------------------------------------------------------------------------------

test('a crashed page renderer shows the offline screen with reason "crashed" and reconnects', async () => {
  const { env, contents } = setup();
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
  await flush();
  assert.deepEqual(offlineLoads(env, contents), [{ reason: 'crashed', code: 'crashed', desc: 'The page stopped responding.', url: 'https://vendor.societyfiles.com/vendor/point-of-sale' }]);
  assert.deepEqual(env.connectivity.starts, [{ url: SERVER_URL, options: { mode: 'page' } }], 'a crash is no connection problem: no reason, no error');
  assert.match(env.log.texts('error').join('\n'), /the page process is gone \(crashed\)/);
});

test('a clean exit of the renderer is not a crash', async () => {
  const { env, contents } = setup();
  contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
});

test('three crashes within a minute stop the automatic reload; a calm minute resets the count', async () => {
  const { env, contents } = setup();
  const crash = () => contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });

  crash();
  env.timers.advance(20000);
  crash();
  env.timers.advance(20000);
  crash(); // 40 s after the first: three within 60 s
  await flush();
  const queries = offlineLoads(env, contents);
  assert.equal(queries.length, 3);
  assert.equal(queries[1].desc, 'The page stopped responding.');
  assert.match(queries[2].desc, /keeps stopping.*View > Reload/);
  assert.equal(env.connectivity.stops >= 1, true, 'the probe that would reload the page is stopped');
  assert.equal(env.connectivity.running, false);

  // a probe answer now does not reload the page
  const before = contents.calls.filter((call) => call[0] === 'loadURL').length;
  contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
  await flush();
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, before);

  // far later: the old crashes no longer count
  env.timers.advance(120000);
  crash();
  await flush();
  const last = offlineLoads(env, contents).pop();
  assert.equal(last.desc, 'The page stopped responding.');
  assert.equal(env.connectivity.running, true);
});

test('the View > Reload path always works from the crash screen', async () => {
  const { controller, contents } = setup();
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await flush();
  await controller.reload();
  assert.deepEqual(lastLoad(contents), ['loadURL', SERVER_URL]);
});

test('a hung page asks Wait or Reload; Wait leaves it alone, and only one question is open at a time', async () => {
  let answer;
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog([() => new Promise((resolve) => (answer = resolve))]);
  const controller = createMainWindow(env.mainDeps({ dialog: env.dialog }));
  const { window: win } = controller;

  win.emit('unresponsive');
  win.emit('unresponsive'); // the same hang reported again
  await flush();
  assert.equal(env.dialog.calls.length, 1);
  const { options } = env.dialog.calls[0];
  assert.equal(options.message, 'The page stopped responding.');
  assert.deepEqual(options.buttons, ['Wait', 'Reload']);
  assert.equal(options.defaultId, 0, 'Wait is the default');

  answer({ response: 0 });
  await flush();
  assert.equal(win.webContents.calls.filter((call) => call[0] === 'forcefullyCrashRenderer').length, 0);
  assert.equal(win.webContents.calls.filter((call) => call[0] === 'loadURL').length, 0);
});

test('choosing Reload ends the hung renderer and loads the POS; the renderer-gone event that follows is not treated as a crash', async () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog([1]);
  const controller = createMainWindow(env.mainDeps({ dialog: env.dialog }));
  const { webContents: contents } = controller.window;

  controller.window.emit('unresponsive');
  await flush();
  assert.deepEqual(contents.calls.map((call) => call[0]), ['forcefullyCrashRenderer', 'loadURL']);

  contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0, 'the deliberate kill shows no crash screen');

  contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
  await flush();
  assert.equal(offlineLoads(env, contents).length, 1, 'a later crash is handled again');
});

test('a hang that is answered can be asked about again later', async () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog([0, 0]);
  const controller = createMainWindow(env.mainDeps({ dialog: env.dialog }));
  controller.window.emit('unresponsive');
  await flush();
  controller.window.emit('unresponsive');
  await flush();
  assert.equal(env.dialog.calls.length, 2);
});

test('a dialog that fails is logged and the question can be asked again', async () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog([() => Promise.reject(new Error('dialog broke')), 0]);
  const controller = createMainWindow(env.mainDeps({ dialog: env.dialog }));
  controller.window.emit('unresponsive');
  await flush();
  assert.match(env.log.texts('error').join('\n'), /unresponsive failed/);
  controller.window.emit('unresponsive');
  await flush();
  assert.equal(env.dialog.calls.length, 2);
});

test('events on a destroyed window are ignored', async () => {
  const { env, controller, win, contents } = setup();
  controller.destroy();
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  win.emit('unresponsive');
  await flush();
  assert.equal(offlineLoads(env, contents).length, 0);
  assert.equal(env.dialog.calls.length, 0);
  await assert.doesNotReject(controller.showOffline({ reason: 'dns' }));
  await assert.doesNotReject(controller.loadPos());
  await assert.doesNotReject(controller.reload());
  await assert.doesNotReject(controller.showLoading());
});

// -- a page that asks to stay (beforeunload) -------------------------------------------------------------------------

function unloadEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

test('a page that tries to cancel an unload gets a Leave / Stay question instead of silently refusing', () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog([], [0]);
  const { webContents } = createMainWindow(env.mainDeps({ dialog: env.dialog })).window;
  const event = unloadEvent();
  webContents.emit('will-prevent-unload', event);

  assert.equal(env.dialog.syncCalls.length, 1);
  const { options } = env.dialog.syncCalls[0];
  assert.equal(options.message, 'Leave this page?');
  assert.equal(options.detail, 'Changes you made may not be saved.');
  assert.deepEqual(options.buttons, ['Leave', 'Stay']);
  assert.equal(options.defaultId, 1, 'Stay is the default: nothing is lost by a stray Enter');
  assert.equal(options.cancelId, 1);
  assert.equal(event.prevented, true, 'Leave overrides the page, so the window can close, quit or reload');
});

test('choosing Stay (or closing the question) leaves the page\'s refusal in place', () => {
  for (const answer of [1, 2, undefined]) {
    const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
    env.dialog = createFakeDialog([], [answer]);
    const { webContents } = createMainWindow(env.mainDeps({ dialog: env.dialog })).window;
    const event = unloadEvent();
    webContents.emit('will-prevent-unload', event);
    assert.equal(event.prevented, false, String(answer));
  }
});

test('a failing question is logged and the page keeps its refusal', () => {
  const env = createFakeEnv({ config: { serverUrl: SERVER_URL } });
  env.dialog = createFakeDialog();
  env.dialog.showMessageBoxSync = () => {
    throw new Error('no window to attach to');
  };
  const { webContents } = createMainWindow(env.mainDeps({ dialog: env.dialog })).window;
  const event = unloadEvent();
  assert.doesNotThrow(() => webContents.emit('will-prevent-unload', event));
  assert.equal(event.prevented, false);
  assert.match(env.log.texts('error').join('\n'), /will-prevent-unload failed/);
});

// -- "Retry now" -----------------------------------------------------------------------------------------------------

test('Retry now probes at once while reconnecting and leaves the page to the probe', async () => {
  const { env, controller, contents } = setup();
  env.connectivity.retryNow = () => {
    env.connectivity.retries += 1;
    return Promise.resolve({ online: false, attempt: 2 });
  };
  failLoad(contents, -105, 'ERR_NAME_NOT_RESOLVED');
  await flush();
  contents.calls.length = 0;
  assert.deepEqual(await controller.retryNow(), { online: false, attempt: 2 });
  assert.equal(env.connectivity.retries, 1);
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, 0, 'the probe decides when the POS loads');
});

test('Retry now loads the POS again when no probe is running: after repeated crashes and for an invalid address', async () => {
  const { env, controller, contents } = setup();
  const crash = () => contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  crash();
  crash();
  crash(); // the third within a minute stops the automatic reload
  await flush();
  assert.equal(env.connectivity.running, false);
  contents.calls.length = 0;
  await controller.retryNow();
  assert.equal(env.connectivity.retries, 0, 'there is no outage for the connectivity controller to retry');
  assert.deepEqual(contents.calls, [['loadURL', SERVER_URL]]);

  env.config.set('serverUrl', 'not a url');
  contents.calls.length = 0;
  await controller.retryNow();
  assert.equal(contents.calls.filter((call) => call[0] === 'loadURL').length, 0);
  assert.equal(contents.calls[0][1], path.join(env.paths.rendererDir, 'offline.html'), 'the address is checked again and the screen says so');
  env.config.set('serverUrl', SERVER_URL);
  contents.calls.length = 0;
  await controller.retryNow();
  assert.deepEqual(contents.calls, [['loadURL', SERVER_URL]], 'once the address is fixed, Retry now loads the POS');
});

test('Retry now on a destroyed window does nothing', async () => {
  const { env, controller } = setup();
  controller.destroy();
  await assert.doesNotReject(controller.retryNow());
  assert.equal(env.connectivity.retries, 0);
});
