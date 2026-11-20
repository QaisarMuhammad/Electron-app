'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdater, FIRST_CHECK_MIN_UPTIME_MS, CHECK_INTERVAL_MS, UPDATE_URL_ENV, STATUSES } = require('../../src/main/updater');
const { createFakeClock, settle } = require('../helpers/fake-net');

const FEED = 'https://updates.example.com/gadgetspos-desktop/';
const DEV_FEED = 'https://dev-updates.example.com/feed/';

/**
 * A stand-in for electron-updater's `autoUpdater`: an EventEmitter with the properties and methods the updater
 * uses. `checkForUpdates` is scripted per test and, like the real library, answers through events AND a promise.
 */
function makeAutoUpdater() {
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    autoDownload: undefined,
    autoInstallOnAppQuit: false,
    disableWebInstaller: false,
    allowDowngrade: true,
    allowPrerelease: true,
    forceDevUpdateConfig: false,
    logger: undefined,
    feedUrls: [],
    quitCalls: [],
    downloads: 0,
    checks: 0,
    checkImpl: async () => ({ isUpdateAvailable: false, updateInfo: { version: '2.0.0' } }),
    setFeedURL(url) {
      this.feedUrls.push(url);
    },
    quitAndInstall(...args) {
      this.quitCalls.push(args);
    },
    downloadUpdate() {
      this.downloads += 1;
      return Promise.resolve(['/tmp/GadgetsPOS-Setup-2.0.1.exe']);
    },
    checkForUpdates() {
      this.checks += 1;
      return this.checkImpl();
    },
  });
  return autoUpdater;
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.packaged]
 * @param {string|null|Function} [options.feed] what readFeedUrl returns (a function is used as readFeedUrl itself)
 * @param {object} [options.env]
 * @param {object|Function} [options.config] updater config; `null` = no config at all
 * @param {number} [options.uptimeMs]
 * @param {object} [options.overrides] extra createUpdater options
 */
function setup({ packaged = true, feed = FEED, env = {}, config = {}, uptimeMs = 5000, overrides = {} } = {}) {
  const clock = createFakeClock();
  const autoUpdater = makeAutoUpdater();
  const log = { lines: [] };
  for (const level of ['info', 'warn', 'error']) log[level] = (...args) => log.lines.push(`${level}: ${args.map(String).join(' ')}`);
  const dialog = {
    calls: [],
    answer: { response: 1 },
    showMessageBox: async (...args) => {
      dialog.calls.push(args);
      return dialog.answer;
    },
  };
  const loads = { count: 0 };
  const statuses = [];

  const updater = createUpdater({
    autoUpdater: () => {
      loads.count += 1;
      return autoUpdater;
    },
    app: { isPackaged: packaged, getVersion: () => '2.0.0' },
    isPackaged: packaged,
    getConfig: () => (config === null ? null : { get: (path, fallback) => (path in config ? config[path] : fallback) }),
    dialog,
    log,
    readFeedUrl: typeof feed === 'function' ? feed : () => feed,
    env,
    timers: clock,
    uptimeMs: () => uptimeMs,
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
  return { updater, autoUpdater, clock, dialog, log, loads, statuses };
}

const UPDATE_INFO = { version: '2.0.1', releaseDate: '2026-11-20T10:00:00.000Z' };

// ---------------------------------------------------------------------------------------------
// when it is a no-op (SPEC 13)
// ---------------------------------------------------------------------------------------------

/** [label, options, expected message fragment] */
const DISABLED_CASES = [
  ['packaged, app-update.yml missing', { feed: null }, 'no update server set up'],
  ['packaged, app-update.yml has no usable url', { feed: '' }, 'no update server set up'],
  ['packaged, readFeedUrl throws', { feed: () => { throw new Error('EACCES'); } }, 'no update server set up'],
  ['packaged, no readFeedUrl at all', { overrides: { readFeedUrl: undefined } }, 'no update server set up'],
  ['packaged, feed is http', { feed: 'http://updates.example.com/feed/' }, 'not secure'],
  ['packaged, feed is ftp', { feed: 'ftp://updates.example.com/feed/' }, 'not secure'],
  ['packaged, feed is not a url', { feed: 'updates.example.com/feed' }, 'not secure'],
  ['packaged, feed has no host', { feed: 'https:///feed/' }, 'not secure'],
  ['packaged, feed still has the placeholder', { feed: 'https://CHANGE-ME.example.com/gadgetspos-desktop/' }, 'not been set up'],
  ['packaged, placeholder in lower case', { feed: 'https://updates.example.com/change-me/' }, 'not been set up'],
  ['unpackaged, no GADGETSPOS_UPDATE_URL', { packaged: false }, 'development builds'],
  ['unpackaged, variable present but empty', { packaged: false, env: { [UPDATE_URL_ENV]: '' } }, 'development builds'],
  ['unpackaged, variable is only spaces', { packaged: false, env: { [UPDATE_URL_ENV]: '   ' } }, 'development builds'],
  ['unpackaged, variable is not a string', { packaged: false, env: { [UPDATE_URL_ENV]: 1 } }, 'development builds'],
  ['unpackaged, variable is http', { packaged: false, env: { [UPDATE_URL_ENV]: 'http://dev.example.com/feed/' } }, 'not secure'],
  ['unpackaged, variable is not a url', { packaged: false, env: { [UPDATE_URL_ENV]: 'dev.example.com' } }, 'not secure'],
  ['unpackaged, variable still has the placeholder', { packaged: false, env: { [UPDATE_URL_ENV]: 'https://CHANGE-ME.example.com/' } }, 'not been set up'],
  ['packaged: the variable is ignored even when app-update.yml is missing', { feed: null, env: { [UPDATE_URL_ENV]: DEV_FEED } }, 'no update server set up'],
  ['packaged: the variable is ignored even when the feed is http', { feed: 'http://updates.example.com/', env: { [UPDATE_URL_ENV]: DEV_FEED } }, 'not secure'],
];

for (const [label, options, fragment] of DISABLED_CASES) {
  test(`disabled: ${label}`, async () => {
    const { updater, autoUpdater, clock, loads, statuses, dialog } = setup(options);

    assert.equal(updater.status().status, 'disabled', 'before init');
    assert.ok(updater.status().message.includes(fragment), updater.status().message);

    assert.equal(updater.init().status, 'disabled');
    const checked = await updater.checkNow();
    assert.equal(checked.status, 'disabled');
    assert.equal(updater.install(), false);

    assert.equal(loads.count, 0, 'electron-updater is never loaded for a disabled updater');
    assert.equal(autoUpdater.checks, 0);
    assert.equal(clock.pending(), 0, 'no timers either');
    assert.equal(dialog.calls.length, 0);
    assert.equal(statuses.length, 0, 'nothing changed, so nobody is told');
  });
}

test('disabled: the status never changes afterwards', async () => {
  const { updater } = setup({ feed: null });
  for (let i = 0; i < 3; i += 1) {
    await updater.checkNow();
    updater.init();
  }
  assert.deepEqual(updater.status(), { status: 'disabled', message: 'This installation has no update server set up.' });
});

// ---------------------------------------------------------------------------------------------
// when it is enabled
// ---------------------------------------------------------------------------------------------

test('enabled (packaged): the settings of SPEC 13 are applied and the feed is left to app-update.yml', () => {
  const { updater, autoUpdater, loads, log } = setup();
  assert.equal(loads.count, 0, 'not at creation');
  assert.equal(updater.status().status, 'none');
  assert.equal(loads.count, 0, 'not for a status read either');

  assert.equal(updater.init().status, 'none');
  assert.equal(loads.count, 1);
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.disableWebInstaller, true);
  assert.equal(autoUpdater.allowDowngrade, false);
  assert.equal(autoUpdater.allowPrerelease, false);
  assert.equal(autoUpdater.logger, log);
  assert.equal(autoUpdater.forceDevUpdateConfig, false);
  assert.deepEqual(autoUpdater.feedUrls, [], 'a packaged app reads its feed from app-update.yml itself');
});

test('enabled (unpackaged with GADGETSPOS_UPDATE_URL): the variable is the feed, through setFeedURL', () => {
  const { updater, autoUpdater } = setup({ packaged: false, feed: null, env: { [UPDATE_URL_ENV]: `  ${DEV_FEED}  ` } });
  assert.equal(updater.status().status, 'none');
  updater.init();
  assert.deepEqual(autoUpdater.feedUrls, [DEV_FEED]);
  assert.equal(autoUpdater.forceDevUpdateConfig, true, 'without it electron-updater skips an unpackaged app');
  assert.equal(autoUpdater.allowDowngrade, false);
});

test('packaged: GADGETSPOS_UPDATE_URL is ignored, the app-update.yml feed stays in charge', () => {
  const { updater, autoUpdater } = setup({ packaged: true, env: { [UPDATE_URL_ENV]: DEV_FEED } });
  updater.init();
  assert.deepEqual(autoUpdater.feedUrls, []);
  assert.equal(autoUpdater.forceDevUpdateConfig, false);
});

test('isPackaged falls back to app.isPackaged, and to the strict "packaged" when nothing says', () => {
  const dev = setup({ overrides: { isPackaged: undefined, app: { isPackaged: false } }, env: { [UPDATE_URL_ENV]: DEV_FEED } });
  assert.equal(dev.updater.status().status, 'none');
  dev.updater.init();
  assert.deepEqual(dev.autoUpdater.feedUrls, [DEV_FEED]);

  const unknown = setup({ overrides: { isPackaged: undefined, app: undefined }, feed: null, env: { [UPDATE_URL_ENV]: DEV_FEED } });
  assert.equal(unknown.updater.status().status, 'disabled', 'unknown build: the environment variable must not redirect updates');
  assert.equal(unknown.autoUpdater.feedUrls.length, 0);
});

test('config: updates.autoDownload false turns the automatic download off, anything else leaves it on', () => {
  const off = setup({ config: { 'updates.autoDownload': false } });
  off.updater.init();
  assert.equal(off.autoUpdater.autoDownload, false);

  for (const config of [{}, { 'updates.autoDownload': true }, { 'updates.autoDownload': undefined }, null]) {
    const on = setup({ config });
    on.updater.init();
    assert.equal(on.autoUpdater.autoDownload, true, JSON.stringify(config));
  }

  const broken = setup({
    overrides: {
      getConfig: () => {
        throw new Error('config not ready');
      },
    },
  });
  broken.updater.init();
  assert.equal(broken.autoUpdater.autoDownload, true);
});

test('config: a plain snapshot works too, including the nested path', () => {
  const snapshot = setup({ overrides: { getConfig: () => ({ updates: { autoDownload: false } }) } });
  snapshot.updater.init();
  assert.equal(snapshot.autoUpdater.autoDownload, false);

  const objectItself = setup({ overrides: { getConfig: { updates: { autoDownload: false } } } });
  objectItself.updater.init();
  assert.equal(objectItself.autoUpdater.autoDownload, false);
});

test('the logger handed to electron-updater is the app logger, or null without one', () => {
  const none = setup({ overrides: { log: undefined } });
  none.updater.init();
  assert.equal(none.autoUpdater.logger, null);
});

test('autoUpdater may be the object itself, not only a function returning it', () => {
  const { autoUpdater, clock, log } = setup();
  const updater = createUpdater({ autoUpdater, isPackaged: true, readFeedUrl: () => FEED, timers: clock, uptimeMs: () => 0, log });
  updater.init();
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.listenerCount('error'), 1);
});

test('init(): is idempotent, loads electron-updater once, wires every event once', async () => {
  const { updater, autoUpdater, loads, clock } = setup();
  updater.init();
  updater.init();
  await updater.checkNow();
  await updater.checkNow();
  assert.equal(loads.count, 1);
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-cancelled', 'error']) {
    assert.equal(autoUpdater.listenerCount(event), 1, event);
  }
  assert.equal(clock.pending(), 1, 'one first-check timer (the interval starts when the first check runs)');
});

test('init(): a failing autoUpdater function (module missing) becomes the error status and never throws', async () => {
  const { updater, clock, log } = setup({
    overrides: {
      autoUpdater: () => {
        throw new Error("Cannot find module 'electron-updater'");
      },
    },
  });
  assert.doesNotThrow(() => updater.init());
  assert.equal(updater.status().status, 'error');
  assert.match(updater.status().message, /Cannot find module/);
  assert.ok(log.lines.some((line) => line.startsWith('error:')));
  assert.equal(clock.pending(), 0);
  assert.equal((await updater.checkNow()).status, 'error');
  assert.equal(updater.install(), false);
});

test('init(): setFeedURL throwing (a bad development feed) becomes the error status', () => {
  const { updater, autoUpdater } = setup({ packaged: false, env: { [UPDATE_URL_ENV]: DEV_FEED } });
  autoUpdater.setFeedURL = () => {
    throw new Error('bad feed');
  };
  assert.doesNotThrow(() => updater.init());
  assert.equal(updater.status().status, 'error');
});

test('init(): a failure while wiring the events detaches what was already attached', () => {
  const { updater, autoUpdater, clock } = setup();
  const realOn = autoUpdater.on.bind(autoUpdater);
  let calls = 0;
  autoUpdater.on = (event, handler) => {
    calls += 1;
    if (calls === 4) throw new Error('emitter broke');
    return realOn(event, handler);
  };

  assert.doesNotThrow(() => updater.init());
  assert.equal(updater.status().status, 'error');
  assert.match(updater.status().message, /emitter broke/);
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-cancelled', 'error']) {
    assert.equal(autoUpdater.listenerCount(event), 0, event);
  }
  assert.equal(clock.pending(), 0, 'no timers for an updater that failed to start');
});

// ---------------------------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------------------------

test('timing: the first check is never earlier than 30 s after the start, then every 4 hours', async () => {
  assert.equal(FIRST_CHECK_MIN_UPTIME_MS, 30000);
  assert.equal(CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000);

  const { updater, autoUpdater, clock } = setup({ uptimeMs: 12000 });
  updater.init();
  assert.equal(clock.pending(), 1);
  assert.equal(clock.nextDelay(), 18000, 'init ran 12 s after the start: 18 s are left of the 30');

  await clock.tick(17999);
  assert.equal(autoUpdater.checks, 0);
  await clock.tick(1);
  assert.equal(autoUpdater.checks, 1);

  await clock.tick(CHECK_INTERVAL_MS - 1);
  assert.equal(autoUpdater.checks, 1);
  await clock.tick(1);
  assert.equal(autoUpdater.checks, 2);
  await clock.tick(CHECK_INTERVAL_MS);
  assert.equal(autoUpdater.checks, 3);
});

test('timing: when init runs after the 30 s mark the first check follows at once', async () => {
  for (const uptimeMs of [30000, 45000, 600000]) {
    const { updater, autoUpdater, clock } = setup({ uptimeMs });
    updater.init();
    assert.equal(clock.nextDelay(), 0);
    assert.equal(autoUpdater.checks, 0, 'init itself does not check, the timer does');
    await clock.tick(0);
    assert.equal(autoUpdater.checks, 1, String(uptimeMs));
  }
});

test('timing: an uptime of 0 waits the full 30 s; a broken uptime reading also waits 30 s', async () => {
  const zero = setup({ uptimeMs: 0 });
  zero.updater.init();
  assert.equal(zero.clock.nextDelay(), 30000);

  const broken = setup({ overrides: { uptimeMs: () => NaN } });
  broken.updater.init();
  assert.equal(broken.clock.nextDelay(), 30000);
});

test('timing: without an injected uptime the 30 s are counted from init()', async () => {
  const { updater, autoUpdater, clock } = setup({ overrides: { uptimeMs: undefined } });
  updater.init();
  assert.equal(clock.nextDelay(), 30000, 'never earlier than 30 s after the start, because it is 30 s after init()');
  await clock.tick(29999);
  assert.equal(autoUpdater.checks, 0);
  await clock.tick(1);
  assert.equal(autoUpdater.checks, 1);
});

test('timing: with only setTimeout injected, the 4 h repetition re-arms itself and one timer exists at any moment', async () => {
  const full = createFakeClock();
  const minimal = { now: full.now, setTimeout: full.setTimeout, clearTimeout: full.clearTimeout };
  const { updater, autoUpdater, clock } = setup({ uptimeMs: 0, overrides: { timers: minimal } });
  updater.init();
  assert.equal(full.pending(), 1);

  await full.tick(30000);
  assert.equal(autoUpdater.checks, 1);
  assert.equal(full.pending(), 1, 'the next 4 h timer');
  await full.tick(CHECK_INTERVAL_MS);
  assert.equal(autoUpdater.checks, 2);
  await full.tick(CHECK_INTERVAL_MS);
  assert.equal(autoUpdater.checks, 3);
  assert.equal(full.pending(), 1);
  assert.ok(full.created.every((handle) => handle.unrefCalled));

  updater.dispose();
  assert.equal(full.pending(), 0);
  await full.tick(CHECK_INTERVAL_MS * 2);
  assert.equal(autoUpdater.checks, 3);
  assert.equal(clock.pending(), 0, 'the clock the setup made is untouched');
});

test('timing: a clock with setInterval but no clearInterval is still cancelled by dispose()', async () => {
  const full = createFakeClock();
  const noClear = { now: full.now, setTimeout: full.setTimeout, clearTimeout: full.clearTimeout, setInterval: full.setInterval };
  const { updater, autoUpdater } = setup({ uptimeMs: 0, overrides: { timers: noClear } });
  updater.init();
  await full.tick(30000);
  assert.equal(full.pending(), 1);
  updater.dispose();
  assert.equal(full.pending(), 0);
  await full.tick(CHECK_INTERVAL_MS * 2);
  assert.equal(autoUpdater.checks, 1);
});

test('timing: every timer is unref()ed so it never keeps the app alive (R3)', async () => {
  const { updater, clock } = setup({ uptimeMs: 0 });
  updater.init();
  await clock.tick(30000);
  assert.equal(clock.created.length, 2, 'the first-check timer and the interval');
  assert.ok(clock.created.every((handle) => handle.unrefCalled));
});

test('timing: dispose() stops the timers and detaches from electron-updater', async () => {
  const { updater, autoUpdater, clock, statuses } = setup({ uptimeMs: 0 });
  updater.init();
  await clock.tick(30000);
  assert.equal(autoUpdater.checks, 1);
  assert.equal(clock.pending(), 1, 'the 4 h interval');

  updater.dispose();
  assert.equal(clock.pending(), 0);
  assert.equal(autoUpdater.listenerCount('error'), 0);
  assert.equal(autoUpdater.listenerCount('update-downloaded'), 0);

  await clock.tick(CHECK_INTERVAL_MS * 3);
  assert.equal(autoUpdater.checks, 1);
  const told = statuses.length;
  autoUpdater.emit('checking-for-update');
  assert.equal(statuses.length, told);
  assert.doesNotThrow(() => updater.dispose());
});

test('timing: dispose() before the first check cancels it', async () => {
  const { updater, autoUpdater, clock } = setup({ uptimeMs: 0 });
  updater.init();
  updater.dispose();
  await clock.tick(60000);
  assert.equal(autoUpdater.checks, 0);
  assert.equal(clock.pending(), 0);
});

// ---------------------------------------------------------------------------------------------
// the status machine
// ---------------------------------------------------------------------------------------------

test('the statuses are the seven of SPEC 6.2', () => {
  assert.deepEqual([...STATUSES], ['disabled', 'checking', 'none', 'available', 'downloading', 'ready', 'error']);
});

test('events: checking -> none', async () => {
  const { updater, autoUpdater, statuses } = setup();
  autoUpdater.checkImpl = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available', UPDATE_INFO);
    return { isUpdateAvailable: false, updateInfo: UPDATE_INFO };
  };
  const result = await updater.checkNow();
  assert.deepEqual(result, { status: 'none' });
  assert.deepEqual(statuses.map((status) => status.status), ['checking', 'none']);
});

test('events: a found update downloads, becomes ready and asks to restart', async () => {
  const { updater, autoUpdater, statuses, dialog } = setup();
  autoUpdater.checkImpl = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', UPDATE_INFO);
    return { isUpdateAvailable: true, updateInfo: UPDATE_INFO };
  };
  assert.deepEqual(await updater.checkNow(), { status: 'available', version: '2.0.1' });

  autoUpdater.emit('download-progress', { percent: 0.4, bytesPerSecond: 1, total: 100, transferred: 0 });
  autoUpdater.emit('download-progress', { percent: 42.9 });
  autoUpdater.emit('download-progress', { percent: 42.1 });
  autoUpdater.emit('download-progress', { percent: 100 });
  autoUpdater.emit('update-downloaded', { ...UPDATE_INFO, downloadedFile: '/tmp/x.exe' });
  await settle();

  assert.deepEqual(statuses, [
    { status: 'checking' },
    { status: 'available', version: '2.0.1' },
    { status: 'downloading', version: '2.0.1', percent: 0 },
    { status: 'downloading', version: '2.0.1', percent: 42 },
    { status: 'downloading', version: '2.0.1', percent: 100 },
    { status: 'ready', version: '2.0.1' },
  ]);
  assert.deepEqual(updater.status(), { status: 'ready', version: '2.0.1' });
  assert.equal(dialog.calls.length, 1);
});

test('events: odd progress values are clamped and never throw', () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  for (const progress of [undefined, null, {}, { percent: 'abc' }, { percent: -5 }, { percent: 250 }, { percent: NaN }]) {
    assert.doesNotThrow(() => autoUpdater.emit('download-progress', progress));
  }
  autoUpdater.emit('download-progress', { percent: 250 });
  assert.equal(updater.status().percent, 100);
  autoUpdater.emit('download-progress', { percent: -5 });
  assert.equal(updater.status().percent, 0);
});

test('events: an error event becomes a plain-English error status, and the next good check recovers', async () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('error', new Error('Cannot find latest.yml in the latest release artifacts'));
  assert.deepEqual(updater.status(), { status: 'error', message: 'The update check failed: Cannot find latest.yml in the latest release artifacts' });

  autoUpdater.checkImpl = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available', UPDATE_INFO);
    return { isUpdateAvailable: false, updateInfo: UPDATE_INFO };
  };
  assert.deepEqual(await updater.checkNow(), { status: 'none' });
});

test('events: a cancelled download returns to "none"', () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('download-progress', { percent: 10 });
  autoUpdater.emit('update-cancelled', UPDATE_INFO);
  assert.equal(updater.status().status, 'none');
});

test('events: every updater event is logged', async () => {
  const { updater, autoUpdater, log } = setup();
  updater.init();
  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('update-available', UPDATE_INFO);
  autoUpdater.emit('download-progress', { percent: 10 });
  autoUpdater.emit('download-progress', { percent: 11 });
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  autoUpdater.emit('update-not-available', UPDATE_INFO);
  autoUpdater.emit('update-cancelled', UPDATE_INFO);
  autoUpdater.emit('error', new Error('boom'));
  await settle();

  const text = log.lines.join('\n');
  for (const fragment of ['checking for an update', 'version 2.0.1 is available', 'downloaded 10 %', 'version 2.0.1 is downloaded', 'no update available', 'download was cancelled', 'error: updater: error:']) {
    assert.ok(text.includes(fragment), `missing "${fragment}" in:\n${text}`);
  }
  assert.ok(!text.includes('downloaded 11 %'), 'progress is logged in steps of 10, not on every event');
});

test('status(): returns a copy, so a caller cannot change the machine', () => {
  const { updater } = setup();
  const status = updater.status();
  status.status = 'ready';
  status.version = '9.9.9';
  assert.deepEqual(updater.status(), { status: 'none' });
});

test('subscribe / onStatus: every change is reported once, unsubscribing works, a failing listener is harmless', () => {
  const { updater, autoUpdater, statuses, log } = setup();
  const seen = [];
  const unsubscribe = updater.subscribe((status) => seen.push(status.status));
  updater.subscribe(() => {
    throw new Error('listener bug');
  });
  updater.init();

  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('update-not-available', UPDATE_INFO);
  assert.deepEqual(seen, ['checking', 'none']);
  assert.deepEqual(statuses.map((status) => status.status), ['checking', 'none']);
  assert.ok(log.lines.some((line) => line.includes('listener bug')));

  unsubscribe();
  autoUpdater.emit('checking-for-update');
  assert.deepEqual(seen, ['checking', 'none']);
});

test('subscribers receive copies', () => {
  const { updater, autoUpdater } = setup();
  const received = [];
  updater.subscribe((status) => {
    received.push(status);
    status.status = 'hacked';
  });
  updater.init();
  autoUpdater.emit('update-available', UPDATE_INFO);
  assert.equal(updater.status().status, 'available');
  assert.equal(received.length, 1);
});

// ---------------------------------------------------------------------------------------------
// checkNow
// ---------------------------------------------------------------------------------------------

test('checkNow: a check that finds nothing and emits no events still ends in "none"', async () => {
  const { updater } = setup();
  assert.deepEqual(await updater.checkNow(), { status: 'none' });
});

test('checkNow: the result is used when the library emitted no events', async () => {
  const { updater, autoUpdater } = setup();
  autoUpdater.checkImpl = async () => ({ isUpdateAvailable: true, updateInfo: UPDATE_INFO });
  assert.deepEqual(await updater.checkNow(), { status: 'available', version: '2.0.1' });
});

test('checkNow: a rejecting checkForUpdates is caught: the promise resolves with the error status', async () => {
  const { updater, autoUpdater, log } = setup();
  autoUpdater.checkImpl = async () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED');
  };
  const result = await updater.checkNow();
  assert.deepEqual(result, { status: 'error', message: 'Could not reach the update server. Check the internet connection and try again.' });
  assert.ok(log.lines.some((line) => line.startsWith('error: updater: error:')));
});

test('checkNow: the library emits "error" AND rejects; the status machine reports one error, not two', async () => {
  const { updater, autoUpdater, statuses } = setup();
  const failure = new Error('HttpError: 503');
  autoUpdater.checkImpl = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('error', failure, failure.stack);
    throw failure;
  };
  const result = await updater.checkNow();
  assert.equal(result.status, 'error');
  assert.deepEqual(statuses.map((status) => status.status), ['checking', 'error']);
});

test('checkNow: a checkForUpdates that throws synchronously is caught too', async () => {
  const { updater, autoUpdater } = setup();
  autoUpdater.checkForUpdates = () => {
    throw new Error('sync failure');
  };
  const result = await updater.checkNow();
  assert.equal(result.status, 'error');
});

test('checkNow: a null result (the library says it is inactive) is "disabled"', async () => {
  const { updater, autoUpdater } = setup();
  autoUpdater.checkImpl = async () => null;
  assert.deepEqual(await updater.checkNow(), { status: 'disabled', message: 'Updates are not available in this build.' });
});

test('checkNow: calls made while a check runs share it', async () => {
  const { updater, autoUpdater } = setup();
  let release;
  autoUpdater.checkImpl = () => new Promise((resolve) => {
    release = () => resolve({ isUpdateAvailable: false, updateInfo: UPDATE_INFO });
  });
  const first = updater.checkNow();
  const second = updater.checkNow();
  assert.equal(first, second);
  await settle();
  assert.equal(autoUpdater.checks, 1);
  assert.equal(updater.status().status, 'checking');
  release();
  assert.equal((await first).status, 'none');

  autoUpdater.checkImpl = async () => ({ isUpdateAvailable: false, updateInfo: UPDATE_INFO });
  await updater.checkNow();
  assert.equal(autoUpdater.checks, 2, 'a later check runs again');
});

test('checkNow: nothing is checked while an update is downloading or ready', async () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('download-progress', { percent: 30 });
  assert.equal((await updater.checkNow()).status, 'downloading');
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  assert.equal((await updater.checkNow()).status, 'ready');
  assert.equal(autoUpdater.checks, 0);
});

test('checkNow: the 4 h timer is skipped while an update is ready', async () => {
  const { updater, autoUpdater, clock } = setup({ uptimeMs: 0 });
  updater.init();
  await clock.tick(30000);
  assert.equal(autoUpdater.checks, 1);
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await clock.tick(CHECK_INTERVAL_MS * 2);
  assert.equal(autoUpdater.checks, 1);
});

test('checkNow: before init it initialises first (Settings can be opened early)', async () => {
  const { updater, autoUpdater, loads } = setup();
  assert.equal(loads.count, 0);
  await updater.checkNow();
  assert.equal(loads.count, 1);
  assert.equal(autoUpdater.checks, 1);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
});

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

test('install(): quitAndInstall(true, true) once the update is ready', () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('update-downloaded', UPDATE_INFO);

  assert.equal(updater.install(), true);
  assert.deepEqual(autoUpdater.quitCalls, [[true, true]]);
});

test('install(): does nothing when there is nothing to install', () => {
  const { updater, autoUpdater } = setup();
  assert.equal(updater.install(), false, 'before init');
  updater.init();
  for (const event of [['checking-for-update'], ['update-not-available', UPDATE_INFO], ['download-progress', { percent: 50 }], ['error', new Error('x')]]) {
    autoUpdater.emit(...event);
    assert.equal(updater.install(), false, event[0]);
  }
  assert.deepEqual(autoUpdater.quitCalls, []);
  assert.equal(autoUpdater.downloads, 0);
});

test('install(): a quitAndInstall that throws is caught and reported', () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  autoUpdater.quitAndInstall = () => {
    throw new Error('installer could not start');
  };
  assert.equal(updater.install(), false);
  assert.equal(updater.status().status, 'error');
  assert.match(updater.status().message, /installer could not start/);
});

test('install(): with automatic download off, an available update is downloaded on request', async () => {
  const { updater, autoUpdater } = setup({ config: { 'updates.autoDownload': false } });
  updater.init();
  autoUpdater.emit('update-available', UPDATE_INFO);
  assert.equal(updater.install(), true);
  await settle();
  assert.equal(autoUpdater.downloads, 1);
  assert.deepEqual(autoUpdater.quitCalls, []);
});

test('install(): with automatic download on, "available" means the download is already under way', () => {
  const { updater, autoUpdater } = setup();
  updater.init();
  autoUpdater.emit('update-available', UPDATE_INFO);
  assert.equal(updater.install(), false);
  assert.equal(autoUpdater.downloads, 0);
});

test('install(): a failing manual download becomes the error status', async () => {
  const { updater, autoUpdater } = setup({ config: { 'updates.autoDownload': false } });
  updater.init();
  autoUpdater.emit('update-available', UPDATE_INFO);
  autoUpdater.downloadUpdate = () => Promise.reject(new Error('disk full'));
  assert.equal(updater.install(), true);
  await settle();
  assert.equal(updater.status().status, 'error');
});

// ---------------------------------------------------------------------------------------------
// the restart dialog
// ---------------------------------------------------------------------------------------------

test('dialog: "Restart now" installs, "Later" does not', async () => {
  const restart = setup();
  restart.updater.init();
  restart.dialog.answer = { response: 0 };
  restart.autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.deepEqual(restart.autoUpdater.quitCalls, [[true, true]]);

  const later = setup();
  later.updater.init();
  later.dialog.answer = { response: 1 };
  later.autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.deepEqual(later.autoUpdater.quitCalls, []);
  assert.equal(later.updater.status().status, 'ready', 'still ready: Settings > About keeps the Install button');
});

test('dialog: the wording and buttons', async () => {
  const { updater, autoUpdater, dialog } = setup();
  updater.init();
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();

  assert.equal(dialog.calls.length, 1);
  const [options] = dialog.calls[0];
  assert.equal(options.type, 'info');
  assert.deepEqual(options.buttons, ['Restart now', 'Later']);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 1);
  assert.equal(options.message, 'GadgetsPOS 2.0.1 is ready to install.');
  assert.match(options.detail, /Restart now to finish the update, or choose Later/);
  assert.match(options.detail, /installed the next time you close GadgetsPOS/);
});

test('dialog: without a version the message still reads well', async () => {
  const { updater, autoUpdater, dialog } = setup();
  updater.init();
  autoUpdater.emit('update-downloaded', {});
  await settle();
  assert.equal(dialog.calls[0][0].message, 'A new version of GadgetsPOS is ready to install.');
});

test('dialog: shown once per version, again for a newer one', async () => {
  const { updater, autoUpdater, dialog } = setup();
  updater.init();
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.equal(dialog.calls.length, 1, 'the same download reported twice is one question');

  autoUpdater.emit('update-downloaded', { version: '2.0.2' });
  await settle();
  assert.equal(dialog.calls.length, 2);
  assert.equal(dialog.calls[1][0].message, 'GadgetsPOS 2.0.2 is ready to install.');
});

test('dialog: attaches to the window getWindow() returns, otherwise stands alone', async () => {
  const win = { id: 'main-window' };
  const withWindow = setup({ overrides: { getWindow: () => win } });
  withWindow.updater.init();
  withWindow.autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.equal(withWindow.dialog.calls[0].length, 2);
  assert.equal(withWindow.dialog.calls[0][0], win);

  const noWindow = setup({ overrides: { getWindow: () => null } });
  noWindow.updater.init();
  noWindow.autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.equal(noWindow.dialog.calls[0].length, 1);
});

test('dialog: a dialog that fails, or is missing, never breaks the updater', async () => {
  const failing = setup();
  failing.updater.init();
  failing.dialog.showMessageBox = async () => {
    throw new Error('no window to attach to');
  };
  failing.autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.equal(failing.updater.status().status, 'ready');
  assert.ok(failing.log.lines.some((line) => line.includes('the restart dialog failed')));

  for (const dialog of [undefined, null, {}, { showMessageBox: 'nope' }]) {
    const missing = setup({ overrides: { dialog } });
    missing.updater.init();
    assert.doesNotThrow(() => missing.autoUpdater.emit('update-downloaded', UPDATE_INFO));
    await settle();
    assert.equal(missing.updater.status().status, 'ready');
  }
});

test('dialog: a "Restart now" whose install fails is reported, not thrown', async () => {
  const { updater, autoUpdater, dialog } = setup();
  updater.init();
  dialog.answer = { response: 0 };
  autoUpdater.quitAndInstall = () => {
    throw new Error('locked');
  };
  autoUpdater.emit('update-downloaded', UPDATE_INFO);
  await settle();
  assert.equal(updater.status().status, 'error');
});

// ---------------------------------------------------------------------------------------------
// error messages
// ---------------------------------------------------------------------------------------------

test('error messages: network failures read as one plain sentence, others carry their first line', () => {
  const messages = new Map([
    [new Error('getaddrinfo ENOTFOUND updates.example.com'), 'Could not reach the update server. Check the internet connection and try again.'],
    [new Error('connect ECONNREFUSED 203.0.113.7:443'), 'Could not reach the update server. Check the internet connection and try again.'],
    [new Error('net::ERR_NAME_NOT_RESOLVED'), 'Could not reach the update server. Check the internet connection and try again.'],
    [new Error('ETIMEDOUT'), 'Could not reach the update server. Check the internet connection and try again.'],
    [new Error('net::ERR_CONNECTION_RESET'), 'Could not reach the update server. Check the internet connection and try again.'],
    [new Error('Cannot find latest.yml\nstack line 2\nstack line 3'), 'The update check failed: Cannot find latest.yml'],
    ['plain string failure', 'The update check failed: plain string failure'],
    [new Error(''), 'The update check failed.'],
    [undefined, 'The update check failed.'],
    [null, 'The update check failed.'],
  ]);
  for (const [error, expected] of messages) {
    const { updater, autoUpdater } = setup();
    updater.init();
    autoUpdater.emit('error', error);
    assert.equal(updater.status().message, expected, String(error));
  }
});

test('error messages: long messages are cut and the stack never reaches the status', () => {
  const { updater, autoUpdater, log } = setup();
  updater.init();
  const error = new Error('x'.repeat(500));
  autoUpdater.emit('error', error);
  const { message } = updater.status();
  assert.equal(message, `The update check failed: ${'x'.repeat(160)}`);
  assert.ok(!message.includes('at '), 'no stack frames');
  assert.ok(log.lines.some((line) => line.includes('updater: error:') && line.includes('Error: xxx')), 'the full error, stack included, goes to the log');
});
