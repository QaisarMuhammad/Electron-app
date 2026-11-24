'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurity, SECURE_WEB_PREFERENCES, PINNED_POPUP_OPTIONS } = require('../../src/main/security');
const { settle } = require('../helpers/fake-net');

const POS_URL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
const POS_ORIGIN = 'https://vendor.societyfiles.com';
const UUID = '0d2e1f0c-0b3f-4f4a-9d0f-2f3f1d6b7c11';
const APP_PRELOAD = '/app/src/preload/app.js';

/** A clock that is 11 s further on at every look, so the open rate limit never applies to a test that is about something else. */
function steadyClock() {
  let time = 0;
  return () => (time += 11_000);
}

function makeSecurity({ packaged = true, rendererDir, now = steadyClock() } = {}) {
  return createSecurity({
    getConfig: () => ({ serverUrl: POS_URL, extraAllowedOrigins: [] }),
    isPackaged: packaged,
    rendererDir,
    now,
  });
}

/** A fake webContents that records what the guards register on it. */
function makeWebContents({ origin = POS_ORIGIN, url } = {}) {
  const listeners = new Map();
  const webContents = {
    mainFrame: { origin },
    getURL: () => url || `${origin}/`,
    listeners,
    openHandler: null,
    on(event, listener) {
      listeners.set(event, listener);
      return webContents;
    },
    setWindowOpenHandler(handler) {
      webContents.openHandler = handler;
    },
  };
  return webContents;
}

/** An Electron 25+ style navigation event: url and isMainFrame sit on the event itself. */
function navigation(url, extra = {}) {
  return {
    url,
    isMainFrame: true,
    isSameDocument: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
}

/** Hooks that record every call. */
function makeHooks(overrides = {}) {
  const record = { opened: [], blocked: [], notices: [], childRequests: [] };
  const hooks = {
    openExternal: (url) => record.opened.push(url),
    onBlocked: (info) => record.blocked.push(info),
    notify: (message) => record.notices.push(message),
    createChildWindow: (details) => {
      record.childRequests.push(details);
      return { icon: '/app/assets/icon.png', webPreferences: { preload: APP_PRELOAD } };
    },
    ...overrides,
  };
  return { record, hooks };
}

function setup({ packaged = true, origin, hooks: hookOverrides, now } = {}) {
  const security = makeSecurity({ packaged, now });
  const webContents = makeWebContents({ origin });
  const { record, hooks } = makeHooks(hookOverrides);
  security.attachGuards(webContents, hooks);
  return {
    webContents,
    record,
    navigate: (url, extra) => {
      const event = navigation(url, extra);
      webContents.listeners.get('will-navigate')(event);
      return event;
    },
    redirect: (url, extra) => {
      const event = navigation(url, extra);
      webContents.listeners.get('will-redirect')(event);
      return event;
    },
    open: (url, details = {}) => webContents.openHandler({ url, frameName: '', features: '', disposition: 'new-window', referrer: {}, ...details }),
  };
}

// ---------------------------------------------------------------------------------------------
// what is installed
// ---------------------------------------------------------------------------------------------

test('attachGuards installs will-navigate, will-redirect, did-create-window (a web page window fills the screen) and the window-open handler, and nothing else', () => {
  const { webContents } = setup();
  assert.deepEqual([...webContents.listeners.keys()].sort(), ['did-create-window', 'will-navigate', 'will-redirect']);
  assert.equal(typeof webContents.openHandler, 'function');
});

// ---------------------------------------------------------------------------------------------
// will-navigate and will-redirect
// ---------------------------------------------------------------------------------------------

const GUARDED = [['will-navigate', 'navigate'], ['will-redirect', 'redirect']];

for (const [eventName, key] of GUARDED) {
  test(`${eventName}: allowed origins and provider hops pass untouched`, () => {
    const ctx = setup();
    const passes = [
      POS_URL,
      'https://vendor.societyfiles.com/vendor/orders',
      'https://gadgetspos.com/x',
      'https://app.gadgetspos.com/receipt?id=1',
      'https://connect.squareup.com/oauth2/authorize?client_id=sq0idp-x&scope=PAYMENTS_WRITE&state=abc',
      'https://connect.squareupsandbox.com/oauth2/authorize?client_id=sandbox-x',
      'https://app.squareup.com/login',
      'https://squareup.com/login',
      'https://app.squareupsandbox.com/login',
      `blob:https://vendor.societyfiles.com/${UUID}`,
    ];
    for (const url of passes) {
      const event = ctx[key](url);
      assert.equal(event.prevented, false, url);
    }
    assert.deepEqual(ctx.record.opened, []);
    assert.deepEqual(ctx.record.blocked, []);
    assert.deepEqual(ctx.record.notices, []);
  });

  test(`${eventName}: a foreign https link is cancelled and sent to the system browser with a one-line notice`, () => {
    const ctx = setup();
    const event = ctx[key]('https://example.com/docs/guide?x=1#top');
    assert.equal(event.prevented, true);
    assert.deepEqual(ctx.record.opened, ['https://example.com/docs/guide?x=1#top']);
    assert.deepEqual(ctx.record.notices, ['Opened in your browser: example.com']);
    assert.deepEqual(ctx.record.blocked, []);
  });

  test(`${eventName}: mailto and tel go to the system browser without a notice`, () => {
    const ctx = setup();
    for (const url of ['mailto:support@example.com?subject=Help', 'tel:+441234567890']) {
      assert.equal(ctx[key](url).prevented, true, url);
    }
    assert.deepEqual(ctx.record.opened, ['mailto:support@example.com?subject=Help', 'tel:+441234567890']);
    assert.deepEqual(ctx.record.notices, []);
  });

  test(`${eventName}: look-alikes of allowed and provider hosts are foreign`, () => {
    const ctx = setup();
    const lookalikes = [
      'https://gadgetspos.com.evil.com/x',
      'https://evilgadgetspos.com',
      'https://squareup.com.evil.com/login',
      'https://connect.squareup.com@evil.com/',
      'https://vendor.societyfiles.com:8443/x',
    ];
    for (const url of lookalikes) assert.equal(ctx[key](url).prevented, true, url);
    // Foreign https links are shown in the browser, not in the app; the one with credentials is not opened at all.
    assert.deepEqual(ctx.record.opened, lookalikes.filter((url) => !url.includes('@')));
    assert.deepEqual(ctx.record.blocked.map((info) => info.url), ['https://connect.squareup.com@evil.com/']);
  });

  test(`${eventName}: everything that is not https, mailto or tel is cancelled and silently denied`, () => {
    const ctx = setup();
    const denied = [
      'http://example.com/',
      'http://vendor.societyfiles.com/',
      'file:///etc/passwd',
      'file:///app/src/renderer/offline.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'ftp://example.com/',
      'ms-msdt:/id PCWDiagnostic',
      'chrome://gpu',
      `blob:https://evil.example/${UUID}`,
      'vbscript:msgbox(1)',
      'smb://evil/share',
      '',
    ];
    for (const url of denied) assert.equal(ctx[key](url).prevented, true, url);
    assert.deepEqual(ctx.record.opened, []);
    assert.deepEqual(ctx.record.notices, []);
    assert.equal(ctx.record.blocked.length, denied.length);
    assert.ok(ctx.record.blocked.every((info) => info.source === eventName && info.reason === 'unsafe-url'));
  });

  test(`${eventName}: sub-frames are not policed (embedded widgets keep working)`, () => {
    const ctx = setup();
    const event = ctx[key]('https://js.stripe.com/v3/', { isMainFrame: false });
    assert.equal(event.prevented, false);
    assert.deepEqual(ctx.record.opened, []);
    assert.deepEqual(ctx.record.blocked, []);
  });

  test(`${eventName}: the positional arguments of older Electron versions are understood`, () => {
    const ctx = setup();
    const listener = ctx.webContents.listeners.get(eventName);

    const foreign = { prevented: false, preventDefault() { this.prevented = true; } };
    listener(foreign, 'https://example.com/', false, true, 1, 2);
    assert.equal(foreign.prevented, true);
    assert.deepEqual(ctx.record.opened, ['https://example.com/']);

    const allowed = { prevented: false, preventDefault() { this.prevented = true; } };
    listener(allowed, POS_URL, false, true, 1, 2);
    assert.equal(allowed.prevented, false);

    const subframe = { prevented: false, preventDefault() { this.prevented = true; } };
    listener(subframe, 'https://example.com/', false, false, 1, 2);
    assert.equal(subframe.prevented, false);
  });

  test(`${eventName}: a malformed event fails closed without throwing`, () => {
    const ctx = setup();
    const listener = ctx.webContents.listeners.get(eventName);
    const noUrl = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.doesNotThrow(() => listener(noUrl));
    assert.equal(noUrl.prevented, true);
    assert.doesNotThrow(() => listener(undefined));
    assert.doesNotThrow(() => listener(null, 'https://example.com'));
    assert.doesNotThrow(() => listener({ url: 42, preventDefault() {} }));
    assert.deepEqual(ctx.record.opened, []);
  });
}

test('navigation: a navigation to a local file page is denied (the app loads its own pages without will-navigate)', () => {
  const ctx = setup();
  const event = ctx.navigate('file:///app/src/renderer/settings.html');
  assert.equal(event.prevented, true);
  assert.deepEqual(ctx.record.opened, []);
});

test('navigation: the main frame can follow a redirect chain between a provider and the allowed origins', () => {
  const ctx = setup();
  // POS -> Square authorize -> Square login -> back to the POS with the code
  for (const url of [
    'https://connect.squareup.com/oauth2/authorize?client_id=x',
    'https://app.squareup.com/login?return_to=%2Foauth2%2Fauthorize',
    `${POS_ORIGIN}/vendor/payments?code=abc&state=xyz`,
  ]) {
    assert.equal(ctx.navigate(url).prevented, false, url);
    assert.equal(ctx.redirect(url).prevented, false, url);
  }
  assert.deepEqual(ctx.record.opened, []);
});

test('navigation: dev servers pass only while unpackaged', () => {
  assert.equal(setup({ packaged: false }).navigate('http://localhost:3000/pos').prevented, false);
  assert.equal(setup({ packaged: true }).navigate('http://localhost:3000/pos').prevented, true);
});

test('navigation: the https notice names the host, IDN hosts in their ASCII form', () => {
  const ctx = setup();
  ctx.navigate('https://xn--bcher-kva.example/page');
  ctx.navigate('https://EXAMPLE.COM:8443/Path');
  assert.deepEqual(ctx.record.notices, ['Opened in your browser: xn--bcher-kva.example', 'Opened in your browser: example.com']);
});

test('navigation: BlockedInfo carries the source, reason and only the parts of the URL that are safe to log', () => {
  const ctx = setup();
  ctx.navigate('javascript:alert(1)');
  ctx.redirect('http://example.com/pay?token=SECRET');
  const [first, second] = ctx.record.blocked;
  assert.deepEqual(first, { source: 'will-navigate', reason: 'unsafe-url', url: 'javascript:alert(1)', protocol: 'javascript:', host: '' });
  assert.deepEqual(second, { source: 'will-redirect', reason: 'unsafe-url', url: 'http://example.com/pay?token=SECRET', protocol: 'http:', host: 'example.com' });
});

// ---------------------------------------------------------------------------------------------
// window.open
// ---------------------------------------------------------------------------------------------

const SECURE = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
};

test('window.open: an allowed origin gets a real window with the app preload and the secure flags', () => {
  const ctx = setup();
  const result = ctx.open('https://vendor.societyfiles.com/vendor/receipt?id=7');
  assert.deepEqual(result, {
    action: 'allow',
    overrideBrowserWindowOptions: {
      ...PINNED_POPUP_OPTIONS,
      icon: '/app/assets/icon.png',
      autoHideMenuBar: true,
      webPreferences: { preload: APP_PRELOAD, ...SECURE },
    },
  });
  assert.equal(ctx.record.childRequests.length, 1);
  assert.equal(ctx.record.childRequests[0].url, 'https://vendor.societyfiles.com/vendor/receipt?id=7');
  assert.deepEqual(ctx.record.opened, []);
});

test('window.open: the secure web preferences are the ones of SPEC 12', () => {
  assert.deepEqual({ ...SECURE_WEB_PREFERENCES }, SECURE);
  assert.ok(Object.isFrozen(SECURE_WEB_PREFERENCES));
});

test('window.open: about:blank from a page on an allowed origin is a real window (pdfMake, document.write popups)', () => {
  const ctx = setup();
  assert.equal(ctx.open('about:blank').action, 'allow');
  assert.equal(ctx.open('').action, 'deny', 'window.open() with no URL arrives as the resolved URL, and an empty one is not a target');
  assert.equal(ctx.open('about:blank', { frameName: 'pos-window' }).action, 'allow', 'the named window of the POS');
});

test('window.open: about:blank needs an opener on an allowed origin', () => {
  for (const origin of ['https://evil.example', 'null', 'file://', '']) {
    const ctx = setup({ origin });
    assert.deepEqual(ctx.open('about:blank'), { action: 'deny' }, JSON.stringify(origin));
    assert.equal(ctx.record.blocked[0].reason, 'opener-not-allowed');
  }
});

test('window.open: the opener falls back to getURL() when the main frame is unavailable', () => {
  const security = makeSecurity();
  const webContents = makeWebContents({ url: POS_URL });
  delete webContents.mainFrame;
  security.attachGuards(webContents, makeHooks().hooks);
  assert.equal(webContents.openHandler({ url: 'about:blank' }).action, 'allow');

  const foreign = makeWebContents({ url: 'https://evil.example/' });
  delete foreign.mainFrame;
  security.attachGuards(foreign, makeHooks().hooks);
  assert.equal(foreign.openHandler({ url: 'about:blank' }).action, 'deny');
});

test('window.open: a blob URL of an allowed origin is a real window; a foreign blob is denied', () => {
  const ctx = setup();
  assert.equal(ctx.open(`blob:https://vendor.societyfiles.com/${UUID}`).action, 'allow');
  assert.equal(ctx.open(`blob:https://gadgetspos.com/${UUID}`).action, 'allow');
  assert.deepEqual(ctx.open(`blob:https://evil.example/${UUID}`), { action: 'deny' });
  assert.deepEqual(ctx.open(`blob:https://gadgetspos.com@evil.example/${UUID}`), { action: 'deny' });
  assert.deepEqual(ctx.open(`blob:null/${UUID}`), { action: 'deny' });
  assert.deepEqual(ctx.record.opened, [], 'a blob is not a link the system browser could open');
});

test('window.open: a foreign https URL goes to the system browser, with the notice, and no window is created', () => {
  const ctx = setup();
  assert.deepEqual(ctx.open('https://example.com/help'), { action: 'deny' });
  assert.deepEqual(ctx.record.opened, ['https://example.com/help']);
  assert.deepEqual(ctx.record.notices, ['Opened in your browser: example.com']);
  assert.equal(ctx.record.childRequests.length, 0);
});

test('window.open: mailto and tel go to the system browser without a notice', () => {
  const ctx = setup();
  assert.deepEqual(ctx.open('mailto:support@example.com'), { action: 'deny' });
  assert.deepEqual(ctx.open('tel:+441234567890'), { action: 'deny' });
  assert.deepEqual(ctx.record.opened, ['mailto:support@example.com', 'tel:+441234567890']);
  assert.deepEqual(ctx.record.notices, []);
});

test('window.open: javascript, file, data and other schemes are denied silently', () => {
  const ctx = setup();
  const denied = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'file:///app/src/renderer/settings.html',
    'data:text/html,<script>alert(1)</script>',
    'http://example.com',
    'http://vendor.societyfiles.com',
    'ftp://example.com',
    'ms-msdt:/id PCWDiagnostic',
    'about:srcdoc',
    'about:config',
    'chrome://gpu',
    'https://connect.squareup.com/oauth2/authorize',
    undefined,
    null,
    42,
  ];
  for (const url of denied) {
    const result = ctx.webContents.openHandler({ url, features: '' });
    assert.deepEqual(result, url === 'https://connect.squareup.com/oauth2/authorize' ? { action: 'deny' } : { action: 'deny' }, String(url));
  }
  // The provider hop is a foreign https link here: window.open of it goes to the system browser, not to a window.
  assert.deepEqual(ctx.record.opened, ['https://connect.squareup.com/oauth2/authorize']);
  assert.equal(ctx.record.childRequests.length, 0);
});

test('window.open: a malformed details object is a deny, never a throw', () => {
  const ctx = setup();
  for (const details of [undefined, null, {}, 'url', 42]) {
    assert.doesNotThrow(() => ctx.webContents.openHandler(details));
    assert.deepEqual(ctx.webContents.openHandler(details), { action: 'deny' });
  }
});

test('window.open: the window factory can add a preload but can never weaken the secure flags', () => {
  const ctx = setup({
    hooks: {
      createChildWindow: () => ({
        webPreferences: {
          preload: APP_PRELOAD,
          nodeIntegration: true,
          sandbox: false,
          contextIsolation: false,
          webSecurity: false,
          allowRunningInsecureContent: true,
          spellcheck: true,
          webviewTag: false,
          partition: 'persist:pos',
        },
        autoHideMenuBar: false,
      }),
    },
  });
  const { overrideBrowserWindowOptions: options } = ctx.open(POS_URL);
  assert.deepEqual(options.webPreferences, { preload: APP_PRELOAD, webviewTag: false, partition: 'persist:pos', ...SECURE });
  assert.equal(options.autoHideMenuBar, true);
});

test('window.open: without a window factory the child still gets the pinned secure flags', () => {
  const ctx = setup({ hooks: { createChildWindow: undefined } });
  assert.deepEqual(ctx.open(POS_URL), {
    action: 'allow',
    overrideBrowserWindowOptions: { ...PINNED_POPUP_OPTIONS, autoHideMenuBar: true, webPreferences: { ...SECURE } },
  });
});

test('window.open: width and height features are honoured; the main window size is not handed down', () => {
  const ctx = setup({ hooks: { createChildWindow: () => ({ width: 1600, height: 900, webPreferences: { preload: APP_PRELOAD } }) } });

  const sized = ctx.open(POS_URL, { features: 'width=900,height=700,left=10,top=20' }).overrideBrowserWindowOptions;
  assert.equal(sized.width, 900);
  assert.equal(sized.height, 700);

  const none = ctx.open(POS_URL, { features: '' }).overrideBrowserWindowOptions;
  assert.equal('width' in none, false, 'the page asked for no size, so Electron applies its default');
  assert.equal('height' in none, false);

  const oneSide = ctx.open(POS_URL, { features: 'popup,height=480' }).overrideBrowserWindowOptions;
  assert.equal(oneSide.height, 480);
  assert.equal('width' in oneSide, false);

  const odd = ctx.open(POS_URL, { features: 'WIDTH = 640 ; Height=480px' }).overrideBrowserWindowOptions;
  assert.equal(odd.width, 640);
  assert.equal(odd.height, 480);

  const bad = ctx.open(POS_URL, { features: 'width=0,height=-5,innerWidth=500,outerHeight=300,width=abc' }).overrideBrowserWindowOptions;
  assert.equal('width' in bad, false);
  assert.equal('height' in bad, false);

  const huge = ctx.open(POS_URL, { features: 'width=99999999,height=20000' }).overrideBrowserWindowOptions;
  assert.equal(huge.width, 10000);
  assert.equal(huge.height, 10000);

  assert.equal('width' in ctx.open(POS_URL, { features: undefined }).overrideBrowserWindowOptions, false);
});

test('window.open: a window factory that throws is a deny, not a crash', () => {
  const ctx = setup({
    hooks: {
      createChildWindow: () => {
        throw new Error('factory bug');
      },
    },
  });
  assert.deepEqual(ctx.open(POS_URL), { action: 'deny' });
  assert.equal(ctx.record.blocked[0].reason, 'error');
});

// ---------------------------------------------------------------------------------------------
// the hooks
// ---------------------------------------------------------------------------------------------

test('hooks: all of them are optional', () => {
  const security = makeSecurity();
  const webContents = makeWebContents();
  security.attachGuards(webContents);
  const event = navigation('https://example.com/');
  assert.doesNotThrow(() => webContents.listeners.get('will-navigate')(event));
  assert.equal(event.prevented, true, 'still cancelled');
  assert.deepEqual(webContents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(webContents.openHandler({ url: POS_URL }).action, 'allow');
  assert.doesNotThrow(() => webContents.openHandler({ url: 'javascript:alert(1)' }));
});

test('hooks: without openExternal an external link is denied and reported', () => {
  const ctx = setup({ hooks: { openExternal: undefined } });
  assert.equal(ctx.navigate('https://example.com/').prevented, true);
  assert.deepEqual(ctx.record.notices, [], 'no notice for a browser that was never opened');
  assert.equal(ctx.record.blocked[0].reason, 'no-opener');
});

test('hooks: openExternal that throws is reported as external-failed, and no notice is shown', () => {
  const ctx = setup({
    hooks: {
      openExternal: () => {
        throw new Error('no default browser');
      },
    },
  });
  assert.equal(ctx.navigate('https://example.com/').prevented, true);
  assert.deepEqual(ctx.open('https://example.com/'), { action: 'deny' });
  assert.deepEqual(ctx.record.notices, []);
  assert.deepEqual(ctx.record.blocked.map((info) => info.reason), ['external-failed', 'external-failed']);
});

test('hooks: openExternal that returns a rejecting promise is reported as external-failed', async () => {
  const ctx = setup({ hooks: { openExternal: () => Promise.reject(new Error('shell failure')) } });
  assert.equal(ctx.navigate('https://example.com/').prevented, true);
  await settle();
  assert.deepEqual(ctx.record.blocked.map((info) => info.reason), ['external-failed']);
});

test('hooks: openExternal that returns a resolving promise is a success', async () => {
  const ctx = setup({ hooks: { openExternal: () => Promise.resolve() } });
  ctx.navigate('https://example.com/');
  await settle();
  assert.deepEqual(ctx.record.blocked, []);
  assert.deepEqual(ctx.record.notices, ['Opened in your browser: example.com']);
});

test('hooks: a throwing onBlocked or notify never changes the outcome of a guard', () => {
  const ctx = setup({
    hooks: {
      onBlocked: () => {
        throw new Error('log failure');
      },
      notify: () => {
        throw new Error('notification failure');
      },
    },
  });
  assert.equal(ctx.navigate('javascript:alert(1)').prevented, true);
  assert.equal(ctx.navigate('https://example.com/').prevented, true);
  assert.deepEqual(ctx.open('javascript:alert(1)'), { action: 'deny' });
  assert.deepEqual(ctx.open('https://example.com/'), { action: 'deny' });
});

test('hooks: openExternal is only ever called with a URL that passed isSafeExternalUrl', () => {
  const security = makeSecurity();
  const ctx = setup();
  const attempts = [
    'https://example.com/',
    'mailto:a@example.com',
    'tel:+441234567890',
    'http://example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'https://user:pw@example.com/',
    'https://example.com@evil.com/',
    'ms-msdt:/id x',
    'https:example.com',
    '',
  ];
  for (const url of attempts) {
    ctx.navigate(url);
    ctx.redirect(url);
    ctx.open(url);
  }
  assert.ok(ctx.record.opened.length > 0);
  for (const url of ctx.record.opened) assert.equal(security.isSafeExternalUrl(url), true, url);
});
