'use strict';

/**
 * SECURITY lens, what ships (SPEC 13 and 15). Four findings that no application code can fix on its own were recorded here as failing
 * tests; they are now the OWNER RELEASE GATES of `npm run release:check` (tests/release/gates.js, docs/RELEASE.md "Owner release
 * gates"), which stays strict and which `npm run dist` runs first:
 *
 *  1. Electron 32.3.3 (Chromium 128) is out of support: Electron supports only the latest three major versions. The app loads remote
 *     web content, so every Chromium n-day applies to it.
 *  2. `build.win.publisherName` is not set. electron-updater verifies the Authenticode signature of a downloaded installer ONLY when
 *     it is set; without it the installer is trusted because its hash is in a `latest.yml` served from the same feed.
 *  3. No Electron fuses were flipped: `RunAsNode`, `--inspect` and NODE_OPTIONS stay on. scripts/after-pack-fuses.js now flips them;
 *     the gate stays open until `npm install` has installed @electron/fuses.
 *  4. package-lock.json was git-ignored, so a release build resolves `^` ranges afresh and is not reproducible.
 *
 * They are not in `npm test` because they depend on a network, a certificate and the owner's npm, not on the code; the machinery that
 * keeps them visible is tested in tests/packaging/release-gates.test.js. What stays here is the regression guard that is about the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('a real update feed address always comes with build.win.publisherName (regression guard)', () => {
  const [publish] = pkg.build.publish;
  assert.equal(publish.provider, 'generic');
  assert.match(publish.url, /^https:\/\//, 'the feed must be https');
  if (!/CHANGE-ME/i.test(publish.url)) {
    assert.ok(pkg.build.win && pkg.build.win.publisherName, 'the placeholder was replaced by a real feed: build.win.publisherName must be set in the same commit');
  }
});
