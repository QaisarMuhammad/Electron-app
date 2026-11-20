'use strict';
/*
 * Fixture table, screenshot plan and behaviour scenarios for tests/e2e/ui-shots.js.
 *
 *   FIXTURES[page][name]  JSON handed to the stub preload (tests/e2e/stub-desktop-preload.js) for `?fixture=<name>`.
 *   SHOTS                 declarative plan: one PNG per entry and theme (page, fixture, size, steps, themes ...).
 *   SCENARIOS             behaviour checks that drive the page with real mouse and key events (see ./scenarios.js).
 */
const data = require('./data');

const { SERVER } = data;
const WIDE = [1280, 800];
const SMALL = [960, 600];

const FIXTURES = { loading: { default: {} }, offline: {}, password: {}, settings: {} };
const SHOTS = [];

/* ---------------------------------------------------------------------------------------------------------------- */
/* Loading                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

SHOTS.push({ page: 'loading', fixture: 'default', size: WIDE, themes: ['light', 'dark'] });
SHOTS.push({ page: 'loading', fixture: 'default', size: SMALL, themes: ['light'] });
SHOTS.push({ page: 'loading', fixture: 'slow', size: WIDE, themes: ['light', 'dark'], steps: [{ eval: "document.getElementById('hint').hidden = false" }, { wait: 500 }] });
FIXTURES.loading.slow = {};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Offline: every reason of SPEC 11.2                                                                                */
/* ---------------------------------------------------------------------------------------------------------------- */

const REASONS = {
  offline: { code: '-106', desc: 'ERR_INTERNET_DISCONNECTED' },
  dns: { code: '-105', desc: 'ERR_NAME_NOT_RESOLVED' },
  refused: { code: '-102', desc: 'ERR_CONNECTION_REFUSED' },
  timeout: { code: '-7', desc: 'ERR_TIMED_OUT' },
  tls: { code: '-201', desc: 'ERR_CERT_DATE_INVALID' },
  server: { code: '503', desc: 'Service Unavailable' },
  other: { code: '-2', desc: 'ERR_FAILED' },
};

function offlineFixture(reason, status = {}, extra = {}) {
  const e = REASONS[reason];
  return {
    platform: 'win32',
    version: '2.0.0',
    connection: { status: { online: false, attempt: 3, nextRetryInMs: 12000, reason, url: SERVER, lastError: { code: e.code, description: e.desc }, ...status }, ...(extra.connection || {}) },
  };
}

const offlineQuery = (reason) => ({ reason, code: REASONS[reason].code, desc: REASONS[reason].desc, url: SERVER });

for (const reason of Object.keys(REASONS)) {
  FIXTURES.offline[reason] = offlineFixture(reason);
  SHOTS.push({ page: 'offline', fixture: reason, size: WIDE, query: offlineQuery(reason), themes: ['offline', 'dns', 'tls'].includes(reason) ? ['light', 'dark'] : ['light'] });
}
// first attempt, probe in flight, back online, small window, hostile and very long values
FIXTURES.offline.first = offlineFixture('offline', { attempt: 1, nextRetryInMs: 3000 });
SHOTS.push({ page: 'offline', fixture: 'first', size: SMALL, query: offlineQuery('offline'), themes: ['light'] });
FIXTURES.offline.connecting = offlineFixture('timeout', { attempt: 4, nextRetryInMs: null });
SHOTS.push({ page: 'offline', fixture: 'connecting', size: WIDE, query: offlineQuery('timeout'), themes: ['light'] });
// the push is the snapshot the real controller sends when a probe succeeded (reason and error cleared, attempt counted)
FIXTURES.offline['back-online'] = offlineFixture('offline', {}, { connection: { script: [{ at: 700, status: data.RECOVERED }] } });
SHOTS.push({ page: 'offline', fixture: 'back-online', size: WIDE, query: offlineQuery('offline'), themes: ['light', 'dark'], steps: [{ wait: 1000 }] });
// nothing retries by itself (crash loop, invalid address): the controller is at rest and must not be taken for "online"
for (const [name, query] of Object.entries({ 'crash-loop': data.RESTING_QUERY.loop, 'bad-address': data.RESTING_QUERY.address })) {
  FIXTURES.offline[name] = { platform: 'win32', version: '2.0.0', connection: { status: data.AT_REST } };
  SHOTS.push({ page: 'offline', fixture: name, size: WIDE, query, themes: name === 'crash-loop' ? ['light', 'dark'] : ['light'] });
}
SHOTS.push({ page: 'offline', fixture: 'dns', size: SMALL, query: offlineQuery('dns'), themes: ['light'] });
FIXTURES.offline.details = offlineFixture('dns');
SHOTS.push({ page: 'offline', fixture: 'details', size: SMALL, query: offlineQuery('dns'), themes: ['light'], full: true, steps: [{ click: '#tech > summary' }] });
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script> ERR_&lt;b&gt;';
FIXTURES.offline.hostile = offlineFixture('dns', { lastError: { code: '-105', description: HOSTILE }, url: `https://evil.example/${HOSTILE}` });
SHOTS.push({
  page: 'offline',
  fixture: 'hostile',
  size: WIDE,
  query: { reason: 'dns', code: '<b>-105</b>', desc: HOSTILE, url: `https://evil.example/?x=${HOSTILE}` },
  themes: ['light'],
  full: true,
  steps: [{ click: '#tech > summary' }],
});
const LONG = `https://vendor.societyfiles.com/vendor/point-of-sale/${'very-long-path-segment-'.repeat(10)}?active=buy`;
FIXTURES.offline.long = offlineFixture('refused', { url: LONG });
SHOTS.push({ page: 'offline', fixture: 'long', size: SMALL, query: { ...offlineQuery('refused'), url: LONG }, themes: ['light'], full: true, steps: [{ click: '#tech > summary' }] });


/* ---------------------------------------------------------------------------------------------------------------- */
/* Password window (compact modal)                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

const PW = [420, 340];
const pwFixture = (extra = {}) => ({ platform: 'win32', version: '2.0.0', password: { correct: '1234', maxFailures: 3, lockSec: 30 }, ...extra });
FIXTURES.password.idle = pwFixture();
FIXTURES.password.wrong = pwFixture();
FIXTURES.password.typed = pwFixture();
FIXTURES.password.locked = pwFixture({ lockout: { locked: true, retryAfterSec: 27 } });
FIXTURES.password.busy = pwFixture({ latencies: { 'password.submit': 60000 } });
FIXTURES.password.success = pwFixture();
FIXTURES.password.failed = pwFixture({ results: { 'password.submit': { ok: false, code: 'DRAWER_FAILED', message: 'The drawer did not respond. Check the cable between the drawer and the receipt printer.' } } });
FIXTURES.password.settings = pwFixture();
FIXTURES.password.default = pwFixture();

SHOTS.push({ page: 'password', fixture: 'idle', size: PW, themes: ['light', 'dark'] });
SHOTS.push({ page: 'password', fixture: 'wrong', size: PW, themes: ['light', 'dark'], steps: [{ fill: ['#pw-input', 'nope'] }, { click: '#pw-submit' }] });
SHOTS.push({ page: 'password', fixture: 'typed', size: PW, themes: ['light'], steps: [{ fill: ['#pw-input', 'hunter2'] }, { click: '#pw-reveal' }] });
SHOTS.push({ page: 'password', fixture: 'locked', size: PW, themes: ['light', 'dark'] });
SHOTS.push({ page: 'password', fixture: 'busy', size: PW, themes: ['light'], busy: true, steps: [{ fill: ['#pw-input', '1234'] }, { eval: "document.getElementById('form').requestSubmit()" }, { wait: 250 }] });
SHOTS.push({ page: 'password', fixture: 'success', size: PW, themes: ['light'], steps: [{ fill: ['#pw-input', '1234'] }, { click: '#pw-submit' }] });
SHOTS.push({ page: 'password', fixture: 'failed', size: PW, themes: ['light'], steps: [{ fill: ['#pw-input', '1234'] }, { click: '#pw-submit' }] });
SHOTS.push({ page: 'password', fixture: 'settings', size: PW, themes: ['light'], query: { purpose: 'settings' } });
SHOTS.push({ page: 'password', fixture: 'wrong', size: PW, themes: ['light'], zoom: 1.5, steps: [{ fill: ['#pw-input', 'nope'] }, { click: '#pw-submit' }], full: true });
SHOTS.push({ page: 'password', fixture: 'locked', size: [480, 380], themes: ['light'], zoom: 1.5, full: true });

require('./settings').register(FIXTURES, SHOTS);

// reduced motion (no endless animation may run) and 150 percent text zoom for the small pages
SHOTS.push({ page: 'loading', fixture: 'default', size: WIDE, themes: ['light'], reducedMotion: true });
SHOTS.push({ page: 'loading', fixture: 'default', size: SMALL, themes: ['light'], zoom: 1.5 });
SHOTS.push({ page: 'offline', fixture: 'connecting', size: WIDE, query: offlineQuery('timeout'), themes: ['light'], reducedMotion: true });
SHOTS.push({ page: 'offline', fixture: 'dns', size: SMALL, query: offlineQuery('dns'), themes: ['light'], zoom: 1.5, full: true });
SHOTS.push({ page: 'offline', fixture: 'details', size: SMALL, query: offlineQuery('dns'), themes: ['light'], zoom: 1.5, full: true, steps: [{ click: '#tech > summary' }] });
SHOTS.push({ page: 'offline', fixture: 'tls', size: SMALL, query: offlineQuery('tls'), themes: ['dark'], zoom: 1.5, full: true });
// the stacked layout of a zoomed small window as a plain viewport capture (no growing): status and Retry now must be on this first screen
SHOTS.push({ page: 'offline', fixture: 'first', size: SMALL, query: offlineQuery('offline'), themes: ['light', 'dark'], zoom: 1.5 });

SHOTS.push({ page: 'offline', fixture: 'dns', size: SMALL, query: offlineQuery('dns'), themes: ['light', 'dark'], forcedColors: true });
SHOTS.push({ page: 'password', fixture: 'wrong', size: PW, themes: ['light'], forcedColors: true, steps: [{ fill: ['#pw-input', 'nope'] }, { click: '#pw-submit' }] });

// instant mock for the first-paint measurement (the page's own work, not the mock's delay)
FIXTURES.offline.timing = { ...offlineFixture('offline'), latency: 0 };
FIXTURES.password.timing = pwFixture({ latency: 0 });
FIXTURES.settings.timing = { ...FIXTURES.settings.default, latency: 0 };

// short lockouts so the scenarios can watch a countdown end
FIXTURES.password['lockout-short'] = pwFixture({ password: { correct: '1234', maxFailures: 3, lockSec: 4 } });
FIXTURES.password['locked-ms'] = pwFixture({ lockout: { retryAfterMs: 27000 } });
FIXTURES.settings['drawer-lockout-short'] = { ...FIXTURES.settings.default, password: { correct: '1234', maxFailures: 3, lockSec: 4 } };

module.exports = { FIXTURES, SHOTS, SCENARIOS: require('./scenarios').SCENARIOS };
