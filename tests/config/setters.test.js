'use strict';

/**
 * The validators (pure) and the validated setters of config.js: setPrinter, setConnection, setDrawer, setGeneral,
 * setWindowState, setPasswordRecord. Each validator answers { ok: true, value } or
 * { ok: false, code: 'INVALID_SETTINGS', message }; each setter writes ONLY a valid request (one atomic write) and
 * answers a Result.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConfig,
  DEFAULTS,
  PULSE_MIN_MS,
  PULSE_MAX_MS,
  validatePrinter,
  validateConnection,
  validateDrawer,
  validateGeneral,
  validateWindowState,
} = require('../../src/main/config');
const { createFakeStoreEnv, createRecordingLog } = require('../helpers/fake-store');

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function setup(t, file) {
  const env = createFakeStoreEnv();
  t.after(env.cleanup);
  if (file !== undefined) env.writeRaw(file);
  const log = createRecordingLog();
  return { env, log, config: createConfig({ Store: env.Store, log }) };
}

/** Assert a validator refused: code INVALID_SETTINGS and a message a person can read. */
function assertRefused(result, label) {
  assert.equal(result.ok, false, label);
  assert.equal(result.code, 'INVALID_SETTINGS', label);
  assert.equal(typeof result.message, 'string', label);
  assert.ok(result.message.length > 8, label);
  assert.equal('value' in result, false, label);
}

// ---------------------------------------------------------------------------------------------
// validatePrinter
// ---------------------------------------------------------------------------------------------

test('validatePrinter: an installed printer is trimmed, and a stale port is dropped', () => {
  assert.deepEqual(validatePrinter('receipt', { transport: 'system', printerName: '  EPSON TM-T20  ' }), {
    ok: true,
    value: { transport: 'system', printerName: 'EPSON TM-T20', port: '' },
  });
  assert.deepEqual(validatePrinter('label', { transport: 'system', printerName: 'Zebra ZD420', port: 'LPT1' }).value, {
    transport: 'system',
    printerName: 'Zebra ZD420',
    port: '',
  });
});

test('validatePrinter: the port transport keeps a trimmed port; the name is optional', () => {
  assert.deepEqual(validatePrinter('receipt', { transport: 'port', printerName: '', port: ' \\\\localhost\\Zebra ' }).value, {
    transport: 'port',
    printerName: '',
    port: '\\\\localhost\\Zebra',
  });
  assert.deepEqual(validatePrinter('label', { transport: 'port', port: 'LPT1' }).value, { transport: 'port', printerName: '', port: 'LPT1' });
  assert.deepEqual(validatePrinter('receipt', { transport: 'port', printerName: 'My printer', port: 'COM3' }).value, {
    transport: 'port',
    printerName: 'My printer',
    port: 'COM3',
  });
});

test('validatePrinter: an empty name is allowed (it means "not set"), missing or null is empty', () => {
  assert.deepEqual(validatePrinter('receipt', { transport: 'system', printerName: '' }).value, { transport: 'system', printerName: '', port: '' });
  assert.deepEqual(validatePrinter('receipt', { transport: 'system' }).value.printerName, '');
  assert.deepEqual(validatePrinter('receipt', { transport: 'system', printerName: null }).value.printerName, '');
  assert.deepEqual(validatePrinter('receipt', { transport: 'system', printerName: '   ' }).value.printerName, '');
});

test('validatePrinter: DYMO has only a name; a transport or port sent along is ignored', () => {
  assert.deepEqual(validatePrinter('dymo', { printerName: ' DYMO LabelWriter 450 ' }), { ok: true, value: { printerName: 'DYMO LabelWriter 450' } });
  assert.deepEqual(validatePrinter('dymo', { printerName: 'X', transport: 'port', port: 'LPT1' }).value, { printerName: 'X' });
  assert.deepEqual(validatePrinter('dymo', { printerName: '' }).value, { printerName: '' });
  assert.deepEqual(validatePrinter('dymo', {}).value, { printerName: '' }, '"Automatic"');
});

test('validatePrinter: only the known fields are returned, so nothing else can be stored', () => {
  const value = validatePrinter('receipt', { transport: 'system', printerName: 'A', password: 'secret', extra: { a: 1 }, __proto__x: 1 }).value;
  assert.deepEqual(Object.keys(value), ['transport', 'printerName', 'port']);
});

test('validatePrinter: text limits are 512 characters, no control characters, trimmed first', () => {
  assert.equal(validatePrinter('receipt', { transport: 'system', printerName: 'x'.repeat(512) }).ok, true);
  assertRefused(validatePrinter('receipt', { transport: 'system', printerName: 'x'.repeat(513) }), 'name 513');
  assert.equal(validatePrinter('receipt', { transport: 'system', printerName: `  ${'x'.repeat(512)}  ` }).ok, true, 'padding does not count');
  assert.equal(validatePrinter('receipt', { transport: 'port', port: 'p'.repeat(512) }).ok, true);
  assertRefused(validatePrinter('receipt', { transport: 'port', port: 'p'.repeat(513) }), 'port 513');
  assert.equal(validatePrinter('dymo', { printerName: 'x'.repeat(512) }).ok, true);
  assertRefused(validatePrinter('dymo', { printerName: 'x'.repeat(513) }), 'dymo 513');

  for (const bad of ['a\u0000b', 'a\nb', 'a\rb', 'a\tb', 'a\u0007b', 'a\u007fb', `a${LINE_SEPARATOR}b`, `a${PARAGRAPH_SEPARATOR}b`, '\u0000']) {
    assertRefused(validatePrinter('receipt', { transport: 'system', printerName: bad }), `name ${JSON.stringify(bad)}`);
    assertRefused(validatePrinter('receipt', { transport: 'port', port: bad }), `port ${JSON.stringify(bad)}`);
    assertRefused(validatePrinter('dymo', { printerName: bad }), `dymo ${JSON.stringify(bad)}`);
  }
  assert.equal(validatePrinter('receipt', { transport: 'system', printerName: 'EPSON\n' }).value.printerName, 'EPSON', 'a trailing newline is trimmed away');
  assert.equal(validatePrinter('receipt', { transport: 'system', printerName: 'Zebra ZD420 – Büro "Café"' }).ok, true, 'ordinary Unicode and quotes are fine');
});

test('validatePrinter: unknown roles, missing or odd settings are refused', () => {
  for (const role of ['a4', 'Receipt', 'RECEIPT', '', undefined, null, 5, {}, '__proto__', 'constructor']) {
    assertRefused(validatePrinter(role, { transport: 'system', printerName: 'A' }), `role ${String(role)}`);
  }
  for (const settings of [undefined, null, 'EPSON', 5, true, [], [{ transport: 'system' }]]) {
    assertRefused(validatePrinter('receipt', settings), `settings ${JSON.stringify(settings)}`);
    assertRefused(validatePrinter('dymo', settings), `dymo settings ${JSON.stringify(settings)}`);
  }
});

test('validatePrinter: the transport is required for receipt and label, and must be system or port exactly', () => {
  for (const role of ['receipt', 'label']) {
    assertRefused(validatePrinter(role, { printerName: 'A' }), `${role} without transport`);
    for (const transport of ['usb', 'PORT', 'System', '', null, 5, true, {}, ['system']]) {
      assertRefused(validatePrinter(role, { transport, printerName: 'A' }), `${role} transport ${JSON.stringify(transport)}`);
    }
  }
});

test('validatePrinter: the port transport needs a port, and name and port must be text', () => {
  for (const port of [undefined, null, '', '   ']) {
    assertRefused(validatePrinter('receipt', { transport: 'port', printerName: 'A', port }), `port ${JSON.stringify(port)}`);
  }
  for (const text of [5, true, {}, ['A'], () => 'A']) {
    assertRefused(validatePrinter('receipt', { transport: 'system', printerName: text }), `name ${typeof text}`);
    assertRefused(validatePrinter('receipt', { transport: 'port', port: text }), `port ${typeof text}`);
    assertRefused(validatePrinter('dymo', { printerName: text }), `dymo name ${typeof text}`);
  }
});

test('setPrinter writes a valid printer in one write, keeps the other roles, and answers a plain { ok: true }', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.setPrinter('receipt', { transport: 'system', printerName: ' EPSON ' }), { ok: true });
  assert.deepEqual(config.setPrinter('dymo', { printerName: 'DYMO LabelWriter 450' }), { ok: true });
  assert.deepEqual(config.get('printers.receipt'), { transport: 'system', printerName: 'EPSON', port: '' });
  assert.deepEqual(config.get('printers.dymo'), { printerName: 'DYMO LabelWriter 450' });
  assert.deepEqual(config.get('printers.label'), DEFAULTS.printers.label);
  assert.deepEqual(env.readRaw().printers.receipt, { transport: 'system', printerName: 'EPSON', port: '' });
  assert.equal(env.stats.writes, 2);
});

test('setPrinter replaces the whole printer: nothing of the old settings survives', (t) => {
  const { config } = setup(t);
  config.setPrinter('receipt', { transport: 'port', printerName: 'Old', port: 'LPT1' });
  config.setPrinter('receipt', { transport: 'system', printerName: 'New' });
  assert.deepEqual(config.get('printers.receipt'), { transport: 'system', printerName: 'New', port: '' });
});

test('setPrinter refuses an invalid request without writing anything or changing the old settings', (t) => {
  const { env, config } = setup(t);
  config.setPrinter('receipt', { transport: 'system', printerName: 'Keep me' });
  const writes = env.stats.writes;
  for (const [role, settings] of [['receipt', { transport: 'port' }], ['a4', { transport: 'system' }], ['receipt', null], ['dymo', { printerName: 'a\u0000b' }]]) {
    assertRefused(config.setPrinter(role, settings), `${role} ${JSON.stringify(settings)}`);
  }
  assert.equal(env.stats.writes, writes);
  assert.equal(config.get('printers.receipt.printerName'), 'Keep me');
});

test('setPrinter reports a failing disk as a Result', (t) => {
  const { env, config } = setup(t);
  env.failWrite();
  const result = config.setPrinter('receipt', { transport: 'system', printerName: 'A' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(config.get('printers.receipt.printerName'), '');
});

// ---------------------------------------------------------------------------------------------
// validateConnection
// ---------------------------------------------------------------------------------------------

test('validateConnection: the server address is normalised by the URL parser', () => {
  const normalised = [
    ['https://Example.COM:443/pos?x=1#top', 'https://example.com/pos?x=1#top'],
    ['  https://example.com  ', 'https://example.com/'],
    ['HTTPS://EXAMPLE.COM', 'https://example.com/'],
    ['https://münchen.de/', 'https://xn--mnchen-3ya.de/'],
    ['https://example.com:8443/x', 'https://example.com:8443/x'],
    ['https://localhost:3001/', 'https://localhost:3001/'],
    ['https://192.168.1.10/', 'https://192.168.1.10/'],
    ['https://pos_1.local/', 'https://pos_1.local/'],
    [DEFAULTS.serverUrl, DEFAULTS.serverUrl],
  ];
  for (const [input, expected] of normalised) {
    assert.deepEqual(validateConnection({ serverUrl: input }), { ok: true, value: { serverUrl: expected } }, input);
  }
});

test('validateConnection: only an https address without credentials is accepted', () => {
  const bad = [
    'http://example.com', 'ftp://example.com', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)',
    'example.com', '//example.com', '', '   ', 'https://', 'https://exa mple.com', 'https://example.com:99999/',
    'https://user:pass@example.com', 'https://user@example.com',
    'https://*.example.com', 'https://[::1]/', 'https://a..b/', 'https://-bad.example.com', 'https://example.com./',
    `https://${'a'.repeat(2050)}.com/`,
    5, null, true, {}, [], ['https://example.com'],
  ];
  for (const serverUrl of bad) assertRefused(validateConnection({ serverUrl }), JSON.stringify(serverUrl)?.slice(0, 40));
});

test('validateConnection: extra domains are https origins (path dropped, host lower-cased) or *.domain wildcards, without duplicates', () => {
  const result = validateConnection({
    extraAllowedOrigins: ['https://Shop.Example.com/', '*.Example.com', 'https://shop.example.com', ' https://other.example.org:8443/x?y#z ', '*.EXAMPLE.com'],
  });
  assert.deepEqual(result, { ok: true, value: { extraAllowedOrigins: ['https://shop.example.com', '*.example.com', 'https://other.example.org:8443'] } });
  assert.deepEqual(validateConnection({ extraAllowedOrigins: ['https://localhost', 'https://127.0.0.1:3001', '*.münchen.de', '*.a.b.example.com'] }).value.extraAllowedOrigins, [
    'https://localhost',
    'https://127.0.0.1:3001',
    '*.xn--mnchen-3ya.de',
    '*.a.b.example.com',
  ]);
  assert.deepEqual(validateConnection({ extraAllowedOrigins: [] }), { ok: true, value: { extraAllowedOrigins: [] } }, 'an empty list clears them');
});

test('validateConnection: bad extra domains are refused, and the message names the entry', () => {
  const bad = [
    'http://shop.example.com', 'shop.example.com', '', ' ', 'https://*.example.com', 'https://user@shop.example.com',
    '*.com', '*.', '*.localhost', '*.example.com/path', '*.example.com:8443', '*.exa mple.com', '*.*.example.com', '*.example..com', '*.-bad.com', '*.bad-.com',
    5, null, {}, [], true,
  ];
  for (const entry of bad) assertRefused(validateConnection({ extraAllowedOrigins: [entry] }), JSON.stringify(entry));
  assert.match(validateConnection({ extraAllowedOrigins: ['https://good.example.com', 'shop.example.com'] }).message, /shop\.example\.com/);
  assertRefused(validateConnection({ extraAllowedOrigins: ['https://good.example.com', 'bad'] }), 'one bad entry spoils the list');
  for (const list of ['https://shop.example.com', {}, null, 5, true]) assertRefused(validateConnection({ extraAllowedOrigins: list }), `list ${JSON.stringify(list)}`);
});

test('validateConnection: wildcard domains with characters a host name cannot contain are refused', () => {
  for (const entry of ['*.exa[mple.com', '*.exa]mple.com', '*.exa<mple.com', '*.exa>mple.com', '*.exa|mple.com', '*.exa%mple.com', '*.exa\\mple.com', '*.exa^mple.com']) {
    assertRefused(validateConnection({ extraAllowedOrigins: [entry] }), entry);
  }
});

test('validateConnection: at most 50 extra domains', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `https://shop${i}.example.com`);
  assert.equal(validateConnection({ extraAllowedOrigins: many(50) }).ok, true);
  assertRefused(validateConnection({ extraAllowedOrigins: many(51) }), '51 entries');
});

test('validateConnection: an extra domain longer than 2048 characters is refused before anything else looks at it', () => {
  assert.equal(validateConnection({ extraAllowedOrigins: [`https://${'a'.repeat(2000)}.example.com`] }).ok, true, 'long but within the limit (the URL parser accepts it)');
  for (const entry of [`https://${'a'.repeat(3000)}.example.com`, `*.${'a'.repeat(3000)}.example.com`, 'x'.repeat(100000)]) {
    assertRefused(validateConnection({ extraAllowedOrigins: [entry] }), `${entry.length} characters`);
  }
});

test('validateConnection: a message echoing a bad entry is one safe line', () => {
  const result = validateConnection({ extraAllowedOrigins: [`evil\n${'x'.repeat(200)}`] });
  assertRefused(result, 'hostile entry');
  assert.ok(!result.message.includes('\n'));
  assert.ok(result.message.length < 200);
});

test('validateConnection: both fields are optional and only those present are returned; anything else is ignored', () => {
  assert.deepEqual(validateConnection({}), { ok: true, value: {} });
  assert.deepEqual(validateConnection({ serverUrl: 'https://a.example.com' }).value, { serverUrl: 'https://a.example.com/' });
  assert.deepEqual(validateConnection({ extraAllowedOrigins: ['*.example.com'] }).value, { extraAllowedOrigins: ['*.example.com'] });
  assert.deepEqual(validateConnection({ serverUrl: undefined, extraAllowedOrigins: undefined, password: 'secret' }).value, {});
  for (const input of [undefined, null, 'https://x.example.com', 5, [], true]) assertRefused(validateConnection(input), `input ${JSON.stringify(input)}`);
});

test('setConnection stores both fields in ONE write; an invalid request changes nothing', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.setConnection({ serverUrl: 'https://Pos.Example.com', extraAllowedOrigins: ['*.example.com'], password: 'x' }), { ok: true });
  assert.equal(config.get('serverUrl'), 'https://pos.example.com/');
  assert.deepEqual(config.get('extraAllowedOrigins'), ['*.example.com']);
  assert.equal(env.stats.writes, 1);
  assert.ok(!env.readText().includes('"password"'), 'the authorisation password is never stored');

  const writes = env.stats.writes;
  assertRefused(config.setConnection({ serverUrl: 'http://insecure.example.com', extraAllowedOrigins: [] }), 'http');
  assertRefused(config.setConnection({ serverUrl: 'https://fine.example.com', extraAllowedOrigins: ['bad'] }), 'second field bad: first not stored either');
  assert.equal(env.stats.writes, writes);
  assert.equal(config.get('serverUrl'), 'https://pos.example.com/');
  assert.deepEqual(config.get('extraAllowedOrigins'), ['*.example.com']);
});

test('setConnection with one field leaves the other alone, and an empty request writes nothing', (t) => {
  const { env, config } = setup(t);
  config.setConnection({ serverUrl: 'https://a.example.com', extraAllowedOrigins: ['*.example.com'] });
  assert.deepEqual(config.setConnection({ extraAllowedOrigins: [] }), { ok: true });
  assert.equal(config.get('serverUrl'), 'https://a.example.com/');
  assert.deepEqual(config.get('extraAllowedOrigins'), []);
  const writes = env.stats.writes;
  assert.deepEqual(config.setConnection({}), { ok: true });
  assert.equal(env.stats.writes, writes);
});

// ---------------------------------------------------------------------------------------------
// validateDrawer
// ---------------------------------------------------------------------------------------------

test('validateDrawer: all five fields', () => {
  const input = { enabled: false, pin: 5, onTimeMs: 100, offTimeMs: 400, requirePasswordForSettings: true };
  assert.deepEqual(validateDrawer(input), { ok: true, value: input });
  assert.deepEqual(validateDrawer({}), { ok: true, value: {} });
  assert.deepEqual(validateDrawer({ pin: 2 }).value, { pin: 2 });
});

test('validateDrawer: pulse lengths are whole milliseconds from 2 to 510 (SPEC 10)', () => {
  assert.equal(PULSE_MIN_MS, 2);
  assert.equal(PULSE_MAX_MS, 510);
  for (const key of ['onTimeMs', 'offTimeMs']) {
    for (const ms of [2, 3, 50, 255, 509, 510]) assert.equal(validateDrawer({ [key]: ms }).ok, true, `${key} ${ms}`);
    for (const ms of [-1, 0, 1, 511, 1000, 50.5, Number.NaN, Infinity, -Infinity, '50', null, true, {}, [50]]) {
      assertRefused(validateDrawer({ [key]: ms }), `${key} ${String(ms)}`);
    }
  }
});

test('validateDrawer: the connector pin is 2 or 5', () => {
  assert.equal(validateDrawer({ pin: 2 }).ok, true);
  assert.equal(validateDrawer({ pin: 5 }).ok, true);
  for (const pin of [0, 1, 3, 4, 6, 25, -2, 2.5, '2', '5', null, true, {}, [5]]) assertRefused(validateDrawer({ pin }), `pin ${JSON.stringify(pin)}`);
});

test('validateDrawer: the switches must be real booleans', () => {
  for (const key of ['enabled', 'requirePasswordForSettings']) {
    assert.deepEqual(validateDrawer({ [key]: true }).value, { [key]: true });
    assert.deepEqual(validateDrawer({ [key]: false }).value, { [key]: false });
    for (const flag of ['true', 'false', 1, 0, null, {}, []]) assertRefused(validateDrawer({ [key]: flag }), `${key} ${JSON.stringify(flag)}`);
  }
});

test('validateDrawer: anything else sent along (such as the authorisation password) is ignored and never returned', () => {
  const result = validateDrawer({ pin: 5, password: 'secret', passwordRecord: { a: 1 }, passwordWeak: true, extra: 1 });
  assert.deepEqual(result, { ok: true, value: { pin: 5 } });
  for (const input of [undefined, null, 5, 'x', [], true]) assertRefused(validateDrawer(input), `input ${JSON.stringify(input)}`);
});

test('setDrawer writes only the fields given, in one write, and never stores a password', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.setDrawer({ enabled: false, pin: 5, onTimeMs: 100, offTimeMs: 200, requirePasswordForSettings: true, password: 'secret-pw' }), { ok: true });
  assert.deepEqual(
    {
      enabled: config.get('drawer.enabled'),
      pin: config.get('drawer.pin'),
      onTimeMs: config.get('drawer.onTimeMs'),
      offTimeMs: config.get('drawer.offTimeMs'),
      requirePasswordForSettings: config.get('drawer.requirePasswordForSettings'),
    },
    { enabled: false, pin: 5, onTimeMs: 100, offTimeMs: 200, requirePasswordForSettings: true },
  );
  assert.equal(env.stats.writes, 1);
  assert.ok(!env.readText().includes('secret-pw'));
  assert.deepEqual(Object.keys(env.readRaw().drawer).sort(), ['enabled', 'offTimeMs', 'onTimeMs', 'pin', 'requirePasswordForSettings']);

  config.setDrawer({ pin: 2 });
  assert.equal(config.get('drawer.offTimeMs'), 200, 'the other fields keep their values');
});

test('setDrawer does not touch the password record or the weak flag', (t) => {
  const record = { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: 'AAAA', hash: 'BBBB' };
  const { config } = setup(t, { drawer: { passwordRecord: record, passwordWeak: true } });
  config.setDrawer({ enabled: false });
  assert.deepEqual(config.get('drawer.passwordRecord'), record);
  assert.equal(config.get('drawer.passwordWeak'), true);
});

test('setDrawer refuses an invalid request without writing anything', (t) => {
  const { env, config } = setup(t);
  assertRefused(config.setDrawer({ pin: 3, enabled: false }), 'bad pin');
  assertRefused(config.setDrawer({ onTimeMs: 1 }), 'too short');
  assert.equal(env.stats.writes, 0);
  assert.equal(config.get('drawer.enabled'), true, 'the valid field next to the bad one was not stored either');
});

// ---------------------------------------------------------------------------------------------
// validateGeneral
// ---------------------------------------------------------------------------------------------

test('validateGeneral: the three General switches are booleans, all optional', () => {
  const input = { openAtLogin: true, startFullScreen: true, keepAwake: false };
  assert.deepEqual(validateGeneral(input), { ok: true, value: input });
  assert.deepEqual(validateGeneral({}), { ok: true, value: {} });
  assert.deepEqual(validateGeneral({ keepAwake: true, other: 1 }).value, { keepAwake: true });
  for (const key of ['openAtLogin', 'startFullScreen', 'keepAwake']) {
    for (const flag of ['true', 1, 0, null, {}, []]) assertRefused(validateGeneral({ [key]: flag }), `${key} ${JSON.stringify(flag)}`);
  }
  for (const bad of [undefined, null, 'x', 5, []]) assertRefused(validateGeneral(bad), `input ${JSON.stringify(bad)}`);
});

test('setGeneral writes startup.openAtLogin, window.startFullScreen and power.keepAwake', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.setGeneral({ openAtLogin: true, startFullScreen: true, keepAwake: false }), { ok: true });
  assert.equal(config.get('startup.openAtLogin'), true);
  assert.equal(config.get('window.startFullScreen'), true);
  assert.equal(config.get('power.keepAwake'), false);
  assert.equal(env.stats.writes, 1);
  assert.deepEqual(env.readRaw(), { startup: { openAtLogin: true }, window: { startFullScreen: true }, power: { keepAwake: false } });
});

test('setGeneral changes only what it is given, and does not touch the remembered full-screen state', (t) => {
  const { config } = setup(t);
  config.setWindowState({ fullScreen: true });
  config.setGeneral({ startFullScreen: true });
  config.setGeneral({ keepAwake: false });
  assert.equal(config.get('window.startFullScreen'), true);
  assert.equal(config.get('window.fullScreen'), true, 'a different setting: the last state versus the wish for the next start');
  assert.equal(config.get('power.keepAwake'), false);
  assert.equal(config.get('startup.openAtLogin'), false);
});

test('setGeneral refuses an invalid request without writing anything', (t) => {
  const { env, config } = setup(t);
  assertRefused(config.setGeneral({ openAtLogin: 'yes', keepAwake: false }), 'bad value');
  assert.equal(env.stats.writes, 0);
  assert.equal(config.get('power.keepAwake'), true);
  assert.deepEqual(config.setGeneral({}), { ok: true });
  assert.equal(env.stats.writes, 0);
});

// ---------------------------------------------------------------------------------------------
// validateWindowState
// ---------------------------------------------------------------------------------------------

test('validateWindowState: booleans for maximised and full screen (the 18b D2 state)', () => {
  assert.deepEqual(validateWindowState({ maximized: true, fullScreen: true }), { ok: true, value: { maximized: true, fullScreen: true } });
  assert.deepEqual(validateWindowState({ fullScreen: false }).value, { fullScreen: false });
  assert.deepEqual(validateWindowState({}), { ok: true, value: {} });
  for (const key of ['maximized', 'fullScreen']) {
    for (const flag of ['true', 1, 0, null, {}]) assertRefused(validateWindowState({ [key]: flag }), `${key} ${JSON.stringify(flag)}`);
  }
  for (const bad of [undefined, null, 'x', 5, []]) assertRefused(validateWindowState(bad), `input ${JSON.stringify(bad)}`);
});

test('validateWindowState: bounds are whole numbers (rounded), or null to forget them', () => {
  assert.deepEqual(validateWindowState({ bounds: { x: 10, y: -20, width: 1280, height: 800 } }).value, { bounds: { x: 10, y: -20, width: 1280, height: 800 } });
  assert.deepEqual(validateWindowState({ bounds: { x: 1.4, y: -20.6, width: 800.5, height: 600 } }).value.bounds, { x: 1, y: -21, width: 801, height: 600 });
  assert.deepEqual(validateWindowState({ bounds: null }), { ok: true, value: { bounds: null } });
  assert.deepEqual(validateWindowState({ bounds: { x: 0, y: 0, width: 1, height: 1, extra: true } }).value.bounds, { x: 0, y: 0, width: 1, height: 1 });
  const bad = [
    'x', 5, [], { x: 0, y: 0, width: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -5 },
    { x: Number.NaN, y: 0, width: 10, height: 10 }, { x: '0', y: 0, width: 10, height: 10 }, { x: 0, y: Infinity, width: 10, height: 10 },
    { x: 0, y: 0, width: 100001, height: 10 }, { x: -100001, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: null, height: 10 },
  ];
  for (const bounds of bad) assertRefused(validateWindowState({ bounds }), JSON.stringify(bounds));
});

test('validateWindowState: the zoom level is clamped to -3..5 (SPEC 12b) and rounded to two decimals', () => {
  const zoom = (zoomLevel) => validateWindowState({ zoomLevel }).value.zoomLevel;
  assert.equal(zoom(0), 0);
  assert.equal(zoom(1), 1);
  assert.equal(zoom(-3), -3);
  assert.equal(zoom(5), 5);
  assert.equal(zoom(-10), -3);
  assert.equal(zoom(10), 5);
  assert.equal(zoom(1.234), 1.23);
  assert.equal(zoom(0.1 + 0.2), 0.3);
  assert.equal(zoom(4.999), 5);
  for (const bad of [Number.NaN, Infinity, -Infinity, '1', null, {}, true]) assertRefused(validateWindowState({ zoomLevel: bad }), String(bad));
});

test('setWindowState remembers full screen, maximised, bounds and zoom, in one write', (t) => {
  const { env, config } = setup(t);
  assert.deepEqual(config.setWindowState({ fullScreen: true, maximized: true, zoomLevel: 99, bounds: { x: 5, y: 6, width: 700, height: 500 } }), { ok: true });
  assert.equal(config.get('window.fullScreen'), true);
  assert.equal(config.get('window.maximized'), true);
  assert.equal(config.get('window.zoomLevel'), 5);
  assert.deepEqual(config.get('window.bounds'), { x: 5, y: 6, width: 700, height: 500 });
  assert.equal(env.stats.writes, 1);

  assert.deepEqual(config.setWindowState({ bounds: null, fullScreen: false }), { ok: true });
  assert.equal(config.get('window.bounds'), null);
  assert.equal(config.get('window.fullScreen'), false);
  assert.equal(config.get('window.maximized'), true, 'untouched');
});

test('setWindowState refuses an invalid request without writing anything', (t) => {
  const { env, config } = setup(t);
  assertRefused(config.setWindowState({ fullScreen: 'yes' }), 'bad value');
  assertRefused(config.setWindowState({ zoomLevel: 2, bounds: { x: 0 } }), 'a bad field next to a good one');
  assert.equal(env.stats.writes, 0);
  assert.equal(config.get('window.zoomLevel'), 0);
});

// ---------------------------------------------------------------------------------------------
// setPasswordRecord
// ---------------------------------------------------------------------------------------------

const RECORD = Object.freeze({ algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });

test('setPasswordRecord stores a record in one write and clears the weak flag (a new password passed the policy)', (t) => {
  const { env, config } = setup(t, { drawer: { passwordWeak: true } });
  assert.equal(config.get('drawer.passwordWeak'), true);
  assert.deepEqual(config.setPasswordRecord({ ...RECORD }), { ok: true });
  assert.deepEqual(config.get('drawer.passwordRecord'), RECORD);
  assert.equal(config.get('drawer.passwordWeak'), false);
  assert.equal(config.publicState().drawer.passwordSet, true);
  assert.equal(env.stats.writes, 1);
});

test('setPasswordRecord(null) removes the password, the weak flag, and "require the password for Settings"', (t) => {
  const { config } = setup(t);
  config.setDrawer({ requirePasswordForSettings: true });
  config.setPasswordRecord({ ...RECORD });
  assert.deepEqual(config.setPasswordRecord(null), { ok: true });
  assert.equal(config.get('drawer.passwordRecord'), null);
  assert.equal(config.get('drawer.passwordWeak'), false);
  assert.equal(config.get('drawer.requirePasswordForSettings'), false, 'a password that is gone cannot be asked for');
  assert.equal(config.publicState().drawer.passwordSet, false);
});

test('setPasswordRecord keeps "require the password for Settings" when the password is only changed', (t) => {
  const { config } = setup(t);
  config.setPasswordRecord({ ...RECORD });
  config.setDrawer({ requirePasswordForSettings: true });
  config.setPasswordRecord({ ...RECORD, salt: 'BBBBBBBBBBBBBBBBBBBBBB==' });
  assert.equal(config.get('drawer.requirePasswordForSettings'), true);
});

test('setPasswordRecord refuses anything that is not a record object or null', (t) => {
  const { env, config } = setup(t);
  for (const bad of ['scrypt', 5, true, [], [RECORD], undefined]) assertRefused(config.setPasswordRecord(bad), JSON.stringify(bad));
  assert.equal(env.stats.writes, 0);
});

test('setPasswordRecord reports a failing disk as a Result and keeps the old password', (t) => {
  const { env, config } = setup(t);
  config.setPasswordRecord({ ...RECORD });
  env.failWrite();
  const result = config.setPasswordRecord(null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.deepEqual(config.get('drawer.passwordRecord'), RECORD);
});
