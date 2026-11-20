'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHANNEL_SERVER_URLS, channelOf, readChannel, defaultsForChannel } = require('../../src/main/channel');
const { DEFAULTS } = require('../../src/main/config');

test('the two channels point at the production and the testing dashboard, on the POS buy page', () => {
  assert.equal(CHANNEL_SERVER_URLS.production, 'https://gadgetspos.com/vendor/point-of-sale?active=buy');
  assert.equal(CHANNEL_SERVER_URLS.testing, 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy');
  assert.equal(Object.isFrozen(CHANNEL_SERVER_URLS), true);
});

test('channelOf accepts only the two known channels', () => {
  assert.equal(channelOf({ gposChannel: 'production' }), 'production');
  assert.equal(channelOf({ gposChannel: 'testing' }), 'testing');
  for (const bad of [undefined, null, {}, { gposChannel: '' }, { gposChannel: 'staging' }, { gposChannel: 'PRODUCTION' }, { gposChannel: 1 }, 'testing', []]) {
    assert.equal(channelOf(bad), null, JSON.stringify(bad));
  }
});

test('readChannel reads the package.json of the app folder and is null for anything unreadable', () => {
  const files = { '/app/package.json': JSON.stringify({ name: 'x', gposChannel: 'testing' }) };
  const fs = { readFileSync: (file) => { if (file in files) return files[file]; throw new Error('ENOENT'); } };
  assert.equal(readChannel('/app', fs), 'testing');
  assert.equal(readChannel('/missing', fs), null);
  files['/app/package.json'] = '{ not json';
  assert.equal(readChannel('/app', fs), null);
});

test('this repository itself carries no channel (development and npm start keep the built-in default)', () => {
  assert.equal(readChannel(require('node:path').resolve(__dirname, '..', '..')), null);
});

test('defaultsForChannel changes only the server address, keeps the rest, never mutates the defaults', () => {
  const production = defaultsForChannel(DEFAULTS, 'production');
  const testing = defaultsForChannel(DEFAULTS, 'testing');
  assert.equal(production.serverUrl, CHANNEL_SERVER_URLS.production);
  assert.equal(testing.serverUrl, CHANNEL_SERVER_URLS.testing);
  assert.deepEqual({ ...production, serverUrl: 0 }, { ...DEFAULTS, serverUrl: 0 });
  assert.equal(production.printers, DEFAULTS.printers, 'the nested settings are the same frozen objects');
  assert.equal(DEFAULTS.serverUrl, 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy', 'DEFAULTS untouched');
  assert.equal(Object.isFrozen(production), true);
});

test('no channel (or an unknown one) returns the defaults unchanged', () => {
  assert.equal(defaultsForChannel(DEFAULTS, null), DEFAULTS);
  assert.equal(defaultsForChannel(DEFAULTS, undefined), DEFAULTS);
  assert.equal(defaultsForChannel(DEFAULTS, 'staging'), DEFAULTS);
});

test('a config created with the production defaults starts on the production address', () => {
  const { createConfig } = require('../../src/main/config');
  const { createFakeStoreEnv, createRecordingLog } = require('../helpers/fake-store');
  const env = createFakeStoreEnv();
  const config = createConfig({ Store: env.Store, log: createRecordingLog(), defaults: defaultsForChannel(DEFAULTS, 'production') });
  assert.equal(config.get('serverUrl'), 'https://gadgetspos.com/vendor/point-of-sale?active=buy');
  env.cleanup();
});
