'use strict';
/*
 * Settings window fixtures and screenshot plan (SPEC 14, 17): every tab with an empty config, populated printers (ten printers,
 * one default, search), DYMO not running, test success and failure, the saved indicator, password dialogs, wrong password,
 * lockout, every update state, startup details, the guarded reset, the General tab with acceleration on / off / restart needed /
 * automatic fallback / no startup data.
 */
const d = require('./data');

const WIDE = [1280, 800];
const SMALL = [960, 600];
const BOTH = ['light', 'dark'];

/** Common fixture frame. `over` is merged on top; `state` builds the getState() payload through data.stateOf(). */
function fx(over = {}, stateOver = {}) {
  return {
    platform: 'win32',
    version: '2.0.0',
    latency: 30,
    state: d.stateOf(stateOver),
    printers: { system: d.SYSTEM_PRINTERS, dymo: d.DYMO_PRINTERS },
    connection: { status: { online: true, attempt: 0, nextRetryInMs: 0, url: d.SERVER, reason: 'other' } },
    password: { correct: '1234', maxFailures: 3, lockSec: 30 },
    ...over,
  };
}

const empty = () => ({ config: d.configEmpty() });
const noPassword = () => {
  const c = d.configPopulated();
  c.drawer.passwordSet = false;
  return { config: c };
};
const withConfig = (mutate) => {
  const c = d.configPopulated();
  mutate(c);
  return { config: c };
};

function register(FIXTURES, SHOTS) {
  const F = FIXTURES.settings;
  const shot = (fixture, hash, opts = {}) => SHOTS.push({ page: 'settings', fixture, hash, size: WIDE, themes: ['light'], full: true, ...opts });

  /* ----------------------------------------------------------------------------------------------------------- */
  /* Printers                                                                                                    */
  /* ----------------------------------------------------------------------------------------------------------- */
  F.default = fx();
  F['printers-empty'] = fx({ printers: { system: d.FEW_PRINTERS, dymo: [], dymoError: d.DYMO_DOWN } }, empty());
  F['printers-populated'] = fx();
  F['printers-none'] = fx({ printers: { system: [], dymo: [], dymoError: d.DYMO_DOWN } }, empty());
  F['printers-loading'] = fx({ latencies: { 'settings.listPrinters': 6000 } });
  F['printers-error'] = fx({ printersError: 'The printer service did not answer.' });
  F['printers-missing'] = fx({ printers: { system: d.FEW_PRINTERS.filter((p) => p.name !== 'EPSON TM-T20III Receipt'), dymo: d.DYMO_PRINTERS } });
  F['printers-dymo-down'] = fx({ printers: { system: d.SYSTEM_PRINTERS, dymo: [], dymoError: d.DYMO_DOWN } }, withConfig((c) => (c.printers.dymo.printerName = 'DYMO LabelWriter 450 Turbo')));
  F['printers-test-failure'] = fx({ results: { 'settings.testPrint': { ok: false, code: 'PRINTER_NOT_FOUND', message: 'The printer did not answer. Check that it is switched on, the paper cover is closed and the cable is plugged in.' } } });
  F['printers-test-slow'] = fx({ latencies: { 'settings.testPrint': 60000 } });
  F['printers-port'] = fx({}, withConfig((c) => (c.printers.label = { transport: 'port', printerName: 'Zebra', port: '\\\\localhost\\ZebraZD420' })));
  F['printers-mac'] = fx({ platform: 'darwin' }, {});
  F['printers-mac'].state.platform = 'darwin';

  const w = (name, opts = {}) => shot(name, 'printers', opts);
  w('printers-empty', { themes: BOTH });
  w('printers-populated', { themes: BOTH });
  w('printers-populated', { size: SMALL });
  w('printers-none');
  w('printers-error');
  w('printers-missing');
  w('printers-dymo-down', { themes: BOTH });
  w('printers-loading', { full: false, steps: [{ wait: 350 }], settleMs: 0 });
  w('printers-test-slow', { full: false, busy: true, steps: [{ clickNow: '[data-role="receipt"] .role__buttons .btn:not(.btn--primary)' }, { wait: 250 }] });

  // interactions on the populated fixture
  const RECEIPT = '[data-role="receipt"]';
  const pick = (scope, text) => ({ clickText: [`${scope} .picker__row`, text] });
  F['printers-unsaved'] = fx();
  w('printers-unsaved', { steps: [pick(RECEIPT, 'Star TSP143III')] });
  F['printers-saved'] = fx();
  w('printers-saved', { steps: [pick(RECEIPT, 'Star TSP143III'), { click: `${RECEIPT} .role__buttons .btn--primary` }, { wait: 150 }] });
  F['printers-test-success'] = fx();
  w('printers-test-success', { steps: [{ click: `${RECEIPT} .role__buttons .btn:not(.btn--primary)` }, { wait: 200 }] });
  w('printers-test-failure', { steps: [{ click: `${RECEIPT} .role__buttons .btn:not(.btn--primary)` }, { wait: 200 }] });
  F['printers-search'] = fx();
  w('printers-search', { steps: [{ fill: [`${RECEIPT} .picker input[type="search"]`, 'zd'] }] });
  F['printers-search-none'] = fx();
  w('printers-search-none', { steps: [{ fill: [`${RECEIPT} .picker input[type="search"]`, 'laser x'] }] });
  w('printers-port', { steps: [{ fill: ['#label-port', 'USB001'] }, { click: '[data-role="label"] .role__buttons .btn--primary' }] });
  F['printers-port-new'] = fx();
  w('printers-port-new', { steps: [{ clickText: ['[data-role="label"] .choice', 'Advanced'] }, { fill: ['#label-port', 'USB001'] }, { click: '[data-role="label"] .role__buttons .btn--primary' }] });
  F['printers-dymo-saved'] = fx();
  w('printers-dymo-saved', { steps: [{ clickText: ['[data-role="dymo"] .picker__row', 'LabelWriter 450'] }, { click: '[data-role="dymo"] .role__buttons .btn--primary' }, { wait: 150 }] });
  F['printers-dymo-test'] = fx();
  w('printers-dymo-test', { steps: [{ click: '[data-role="dymo"] .role__buttons .btn:not(.btn--primary)' }, { wait: 200 }] });
  w('printers-mac');

  /* ----------------------------------------------------------------------------------------------------------- */
  /* Cash drawer                                                                                                 */
  /* ----------------------------------------------------------------------------------------------------------- */
  F['drawer-set'] = fx();
  F['drawer-none'] = fx({}, noPassword());
  F['drawer-weak'] = fx({}, withConfig((c) => (c.drawer.passwordWeak = true)));
  F['drawer-protected'] = fx({}, withConfig((c) => (c.drawer.requirePasswordForSettings = true)));
  const dr = (name, opts = {}) => shot(name, 'drawer', opts);
  dr('drawer-set', { themes: BOTH });
  dr('drawer-set', { size: SMALL });
  dr('drawer-none');
  dr('drawer-weak');

  F['drawer-dialog-set'] = fx({}, noPassword());
  dr('drawer-dialog-set', { full: false, themes: BOTH, steps: [{ click: '#pw-open' }, { wait: 250 }] });
  F['drawer-dialog-change'] = fx();
  dr('drawer-dialog-change', { full: false, steps: [{ click: '#pw-open' }, { wait: 250 }] });
  F['drawer-dialog-wrong'] = fx();
  dr('drawer-dialog-wrong', {
    full: false,
    steps: [{ click: '#pw-open' }, { fill: ['#dlg-current', 'nope'] }, { fill: ['#dlg-new', 'abcd1234'] }, { fill: ['#dlg-confirm', 'abcd1234'] }, { click: '.dialog .btn--primary' }, { wait: 150 }],
  });
  F['drawer-dialog-mismatch'] = fx();
  dr('drawer-dialog-mismatch', {
    full: false,
    steps: [{ click: '#pw-open' }, { fill: ['#dlg-current', '1234'] }, { fill: ['#dlg-new', 'Abcd1234!x'] }, { fill: ['#dlg-confirm', 'abcd'] }, { click: '.dialog .btn--primary' }, { wait: 150 }],
  });
  F['drawer-dialog-lockout'] = fx({ password: { correct: '1234', maxFailures: 2, lockSec: 30 } });
  dr('drawer-dialog-lockout', {
    full: false,
    themes: BOTH,
    steps: [
      { click: '#pw-open' },
      { fill: ['#dlg-current', 'bad1'] },
      { fill: ['#dlg-new', 'abcd1234'] },
      { fill: ['#dlg-confirm', 'abcd1234'] },
      { click: '.dialog .btn--primary' },
      { click: '.dialog .btn--primary' },
      { wait: 200 },
    ],
  });
  F['drawer-lockout'] = fx();
  dr('drawer-lockout', {
    steps: [
      { fill: ['#drawer-test-pw', 'x'] },
      { click: '#drawer-test' },
      { fill: ['#drawer-test-pw', 'y'] },
      { click: '#drawer-test' },
      { fill: ['#drawer-test-pw', 'z'] },
      { click: '#drawer-test' },
      { wait: 200 },
    ],
  });
  F['drawer-test-ok'] = fx();
  dr('drawer-test-ok', { steps: [{ fill: ['#drawer-test-pw', '1234'] }, { click: '#drawer-test' }, { wait: 150 }] });
  F['drawer-test-wrong'] = fx();
  dr('drawer-test-wrong', { steps: [{ fill: ['#drawer-test-pw', 'nope'] }, { click: '#drawer-test' }, { wait: 150 }] });
  F['drawer-unsaved'] = fx();
  dr('drawer-unsaved', { steps: [{ clickText: ['#drawer-form .choice', 'Pin 5'] }, { fill: ['#drawer-on', '80'] }] });
  F['drawer-invalid'] = fx();
  dr('drawer-invalid', { steps: [{ fill: ['#drawer-on', '900'] }, { fill: ['#drawer-pw', ''] }, { click: '#drawer-save' }] });
  F['drawer-saved'] = fx();
  dr('drawer-saved', { steps: [{ clickText: ['#drawer-form .choice', 'Pin 5'] }, { fill: ['#drawer-pw', '1234'] }, { click: '#drawer-save' }, { wait: 150 }] });
  F['drawer-forgot'] = fx();
  dr('drawer-forgot', { steps: [{ click: '#forgot > summary' }] });

  /* ----------------------------------------------------------------------------------------------------------- */
  /* Connection                                                                                                  */
  /* ----------------------------------------------------------------------------------------------------------- */
  F['connection-default'] = fx();
  F['connection-offline'] = fx({ connection: { status: { online: false, attempt: 3, nextRetryInMs: 12000, url: d.SERVER, reason: 'offline' } } }, { online: false });
  F['connection-protected'] = fx({}, withConfig((c) => (c.drawer.requirePasswordForSettings = true)));
  const cn = (name, opts = {}) => shot(name, 'connection', opts);
  cn('connection-default', { themes: BOTH });
  cn('connection-default', { size: SMALL });
  cn('connection-offline');
  cn('connection-protected');
  F['connection-invalid'] = fx();
  cn('connection-invalid', { steps: [{ fill: ['#conn-url', 'http://shop.example.com'] }, { eval: "document.getElementById('conn-url').blur()" }, { fill: ['#domain-input', 'not a domain'] }, { click: '#domain-add' }] });
  F['connection-domains'] = fx();
  cn('connection-domains', { steps: [{ fill: ['#domain-input', 'Pos.Mygadgetshop.co.uk'] }, { click: '#domain-add' }, { fill: ['#domain-input', 'https://shop.example.com'] }, { click: '#domain-add' }] });
  F['connection-saved'] = fx();
  cn('connection-saved', { steps: [{ fill: ['#conn-url', 'https://pos.mygadgetshop.co.uk/point-of-sale'] }, { click: '#conn-save' }, { wait: 150 }] });

  /* ----------------------------------------------------------------------------------------------------------- */
  /* General                                                                                                     */
  /* ----------------------------------------------------------------------------------------------------------- */
  const perf = (over) => ({ performance: { hardwareAcceleration: true, compatibilityReason: '', startup: d.STARTUP, ...over } });
  F['general-default'] = fx({}, perf({}));
  F['general-accel-off'] = fx({}, perf({ hardwareAcceleration: false }));
  F['general-fallback'] = fx({}, perf({ hardwareAcceleration: false, compatibilityReason: 'The graphics process stopped twice within a minute.' }));
  F['general-manual'] = fx({}, perf({ hardwareAcceleration: false, compatibilityReason: 'manual' }));
  F['general-linux'] = fx({ platform: 'linux' }, perf({}));
  F['general-linux'].state.platform = 'linux';
  const ge = (name, opts = {}) => shot(name, 'general', opts);
  ge('general-default', { themes: BOTH });
  ge('general-default', { size: SMALL });
  ge('general-accel-off');
  ge('general-fallback', { themes: BOTH });
  ge('general-manual');
  ge('general-linux');
  F['general-restart'] = fx({}, perf({}));
  ge('general-restart', { steps: [{ click: '#sw-accel' }, { wait: 150 }] });
  F['general-saved'] = fx({}, perf({}));
  ge('general-saved', { steps: [{ click: '#row-login' }, { wait: 150 }] });

  /* ----------------------------------------------------------------------------------------------------------- */
  /* About & updates                                                                                             */
  /* ----------------------------------------------------------------------------------------------------------- */
  const upd = (update, extra = {}) => fx({ checkResult: { status: 'none' } }, { update, ...extra });
  F['about-none'] = upd({ status: 'none' });
  F['about-checking'] = upd({ status: 'checking' });
  F['about-available'] = upd({ status: 'available', version: '2.1.0' });
  F['about-downloading'] = upd({ status: 'downloading', version: '2.1.0', percent: 42 });
  F['about-ready'] = upd({ status: 'ready', version: '2.1.0' });
  F['about-error'] = upd({ status: 'error', message: 'The update server did not answer. Check your internet connection.' });
  F['about-disabled'] = upd({ status: 'disabled' });
  F['about-nostartup'] = upd({ status: 'none' }, { performance: { hardwareAcceleration: true, compatibilityReason: '' }, paths: undefined, versions: undefined });
  F['about-unknown'] = upd(undefined);
  const ab = (name, opts = {}) => shot(name, 'about', opts);
  ab('about-none', { themes: BOTH });
  ab('about-none', { size: SMALL });
  ab('about-unknown', { full: false });
  for (const name of ['about-checking', 'about-available', 'about-downloading', 'about-ready', 'about-error', 'about-disabled']) ab(name, { full: false, size: WIDE });
  ab('about-ready', { themes: ['dark'], full: false });
  ab('about-error', { themes: ['dark'], full: false });
  F['about-startup'] = upd({ status: 'none' });
  ab('about-startup', { steps: [{ click: '#startup > summary' }] });
  ab('about-nostartup', { steps: [{ click: '#startup > summary' }] });
  F['about-reset'] = fx();
  ab('about-reset', { full: false, themes: BOTH, steps: [{ click: '#reset-open' }, { wait: 250 }] });
  F['about-reset-armed'] = fx();
  ab('about-reset-armed', { full: false, steps: [{ click: '#reset-open' }, { fill: ['#reset-word', 'RESET'] }, { wait: 100 }] });
  F['about-reset-wrong'] = fx();
  ab('about-reset-wrong', { full: false, steps: [{ click: '#reset-open' }, { fill: ['#reset-word', 'RESET'] }, { fill: ['#reset-pw', 'nope'] }, { click: '.dialog .btn--danger-solid' }, { wait: 150 }] });
  F['about-reset-lockout'] = fx({ password: { correct: '1234', maxFailures: 2, lockSec: 30 } });
  ab('about-reset-lockout', {
    full: false,
    steps: [{ click: '#reset-open' }, { fill: ['#reset-word', 'RESET'] }, { fill: ['#reset-pw', 'a'] }, { click: '.dialog .btn--danger-solid' }, { fill: ['#reset-pw', 'b'] }, { click: '.dialog .btn--danger-solid' }, { wait: 200 }],
  });
  F['about-reset-nopw'] = fx({}, noPassword());
  ab('about-reset-nopw', { full: false, steps: [{ click: '#reset-open' }, { fill: ['#reset-word', 'RESET'] }, { wait: 100 }] });

  /* A brand-new installation: every tab with the empty config (nothing chosen, no password, no extra domains). */
  F['drawer-empty'] = fx({}, empty());
  shot('drawer-empty', 'drawer', {});
  F['connection-empty'] = fx({}, empty());
  shot('connection-empty', 'connection', {});
  F['general-empty'] = fx({}, empty());
  shot('general-empty', 'general', { full: false });
  F['about-empty'] = fx({}, empty());
  shot('about-empty', 'about', { full: false });

  /* The state could not be read at all: only the error banner may show, never empty forms. */
  F['load-error'] = fx({ results: { 'settings.getState': { ok: false, code: 'UNKNOWN', message: 'The settings file could not be read. Close this window and open Settings again.' } } });
  shot('load-error', 'printers', { full: false, themes: BOTH });

  /* Toasts: success after a change, an error from the main process, a confirmation with an action. */
  F['drawer-toast'] = fx();
  dr('drawer-toast', {
    full: false,
    themes: BOTH,
    steps: [{ click: '#pw-open' }, { fill: ['#dlg-current', '1234'] }, { fill: ['#dlg-new', 'abcd1234'] }, { fill: ['#dlg-confirm', 'abcd1234'] }, { click: '.dialog .btn--primary' }, { wait: 350 }],
  });
  F['about-toast-error'] = fx({ results: { 'settings.openLogsFolder': { ok: false, code: 'UNKNOWN', message: 'The logs folder could not be opened. It may have been moved or deleted.' } } });
  ab('about-toast-error', { full: false, steps: [{ click: '#open-logs' }, { wait: 350 }] });
  F['about-toast-copied'] = fx();
  ab('about-toast-copied', { full: false, themes: BOTH, steps: [{ click: '#copy-diag' }, { wait: 350 }] });
  F['about-toast-reset'] = fx({}, noPassword());
  ab('about-toast-reset', { full: false, steps: [{ click: '#reset-open' }, { fill: ['#reset-word', 'RESET'] }, { click: '.dialog .btn--danger-solid' }, { wait: 350 }] });

  /* Keyboard focus rings, reached with Tab exactly as a cashier without a mouse would. */
  F['focus-printers'] = fx();
  shot('focus-printers', 'printers', { full: false, themes: BOTH, steps: [{ focus: '#tab-printers' }, { tab: 3 }] });
  F['focus-input'] = fx();
  shot('focus-input', 'drawer', { full: false, steps: [{ focus: '#tab-drawer' }, { tab: 4 }] });
  F['focus-switch'] = fx({}, { performance: { hardwareAcceleration: true, compatibilityReason: '', startup: d.STARTUP } });
  shot('focus-switch', 'general', { full: false, themes: BOTH, steps: [{ focus: '#tab-general' }, { tab: 2 }] });
  F['focus-tab'] = fx();
  shot('focus-tab', 'connection', { full: false, steps: [{ tab: 1 }] });

  /* Very long printer names must wrap inside the list instead of widening the page. */
  const LONG1 = 'ZDesigner ZD420-203dpi ZPL (Copy 2) on \\\\SHOP-FRONT-DESK-PC\\ZebraZD420Label_VeryLongShareName_ForTestingWrapping_0123456789';
  const LONG2 = 'EPSON TM-T20III Receipt (Back office counter, second floor, next to the stock room door)';
  F['printers-long'] = fx(
    {
      printers: {
        system: [
          { name: LONG1, displayName: LONG1, isDefault: true, status: 'Ready' },
          { name: LONG2, displayName: LONG2, isDefault: false, status: 'Printing a very long job that will take a while' },
          ...d.FEW_PRINTERS.slice(1),
        ],
        dymo: [{ name: 'DYMO LabelWriter 450 Twin Turbo (Extended Name Edition)', modelName: 'LabelWriter 450 Twin Turbo', isConnected: true }],
      },
    },
    withConfig((c) => (c.printers.receipt.printerName = LONG2)),
  );
  shot('printers-long', 'printers', { size: SMALL });
  shot('printers-long', 'printers', { size: SMALL, zoom: 1.5 });

  /* Thirty installed printers and twelve DYMO printers: every saved choice sits far down its list and must be on screen when the tab opens. */
  const MANY = Array.from({ length: 30 }, (_, i) => {
    const name = `Shop Printer ${String(i + 1).padStart(2, '0')}`;
    return { name, displayName: name, isDefault: i === 0, status: 'Ready' };
  });
  const MANY_DYMO = Array.from({ length: 12 }, (_, i) => ({ name: `DYMO LabelWriter 450 Unit ${i + 1}`, modelName: 'LabelWriter 450', isConnected: i % 3 === 0 }));
  F['printers-many'] = fx(
    { printers: { system: MANY, dymo: MANY_DYMO } },
    withConfig((c) => {
      c.printers.receipt.printerName = 'Shop Printer 25';
      c.printers.label.printerName = 'Shop Printer 28';
      c.printers.dymo.printerName = 'DYMO LabelWriter 450 Unit 10';
    }),
  );
  shot('printers-many', 'printers', { full: false });
  shot('printers-many', 'printers', { size: SMALL, zoom: 1.5, full: false, steps: [{ scrollTo: '[data-role="receipt"] .picker__list' }] });

  /* Windows High Contrast (forced colours): selection, switches and status must stay visible with system colours only. */
  shot('printers-populated', 'printers', { forcedColors: true, themes: BOTH, full: false });
  shot('general-fallback', 'general', { forcedColors: true, themes: ['dark'], full: false });
  shot('drawer-dialog-wrong', 'drawer', { forcedColors: true, themes: ['light'], full: false, steps: [{ click: '#pw-open' }, { fill: ['#dlg-current', 'nope'] }, { fill: ['#dlg-new', 'abcd1234'] }, { fill: ['#dlg-confirm', 'abcd1234'] }, { click: '.dialog .btn--primary' }, { wait: 150 }] });

  /* Reduced motion: loading skeletons and the update spinner must not loop. */
  shot('printers-loading', 'printers', { reducedMotion: true, full: false, steps: [{ wait: 350 }], settleMs: 0 });
  shot('about-checking', 'about', { reducedMotion: true, full: false });

  /* Text zoom 150 percent at 960x600 for every tab (SPEC 14: the settings window at 100% and 150%). */
  const zoomed = [
    ['printers-populated', 'printers'],
    ['drawer-set', 'drawer'],
    ['connection-default', 'connection'],
    ['general-default', 'general'],
    ['about-none', 'about'],
  ];
  for (const [name, hash] of zoomed) shot(name, hash, { size: SMALL, zoom: 1.5 });
  shot('drawer-dialog-wrong', 'drawer', { size: SMALL, zoom: 1.5, full: false, steps: [{ click: '#pw-open' }, { fill: ['#dlg-current', 'nope'] }, { fill: ['#dlg-new', 'abcd1234'] }, { fill: ['#dlg-confirm', 'abcd1234'] }, { click: '.dialog .btn--primary' }, { wait: 150 }] });
}

module.exports = { register, fx };
