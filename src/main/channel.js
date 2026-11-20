'use strict';

/**
 * The release CHANNEL of this build: where a fresh install points before anybody changes the address.
 *
 *   production  https://gadgetspos.com                the build downloaded from the live dashboard
 *   testing     https://vendor.societyfiles.com       the build downloaded from the testing dashboard
 *
 * The channel is written into the package.json inside the installed app when the installer is built
 * (`electron-builder --config.extraMetadata.gposChannel=production|testing`, see scripts/build-release.sh), so one source tree makes both
 * builds. A build without a channel (development, `npm start`) keeps the built-in defaults of config.js. The channel only decides the
 * DEFAULT: an address a person saved in Settings > Connection, or carried over from 1.x, always wins.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** The POS page each channel opens first (the same path as the built-in default). */
const CHANNEL_SERVER_URLS = Object.freeze({
  production: 'https://gadgetspos.com/vendor/point-of-sale?active=buy',
  testing: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy',
});

/** @returns {'production'|'testing'|null} the channel named by a package.json object, or null for anything else */
function channelOf(pkg) {
  const value = pkg && typeof pkg === 'object' ? pkg.gposChannel : undefined;
  return value === 'production' || value === 'testing' ? value : null;
}

/** @returns {'production'|'testing'|null} the channel of the package.json in `appRoot` (null when it cannot be read) */
function readChannel(appRoot, fs = nodeFs) {
  try {
    return channelOf(JSON.parse(fs.readFileSync(nodePath.join(appRoot, 'package.json'), 'utf8')));
  } catch {
    return null;
  }
}

/** The config defaults with this channel's address. Without a channel the defaults are returned as they are. Never mutates `defaults`. */
function defaultsForChannel(defaults, channel) {
  if (!channel || !CHANNEL_SERVER_URLS[channel]) return defaults;
  return Object.freeze({ ...defaults, serverUrl: CHANNEL_SERVER_URLS[channel] });
}

module.exports = { CHANNEL_SERVER_URLS, channelOf, readChannel, defaultsForChannel };
