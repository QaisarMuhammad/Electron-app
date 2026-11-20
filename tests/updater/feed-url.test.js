'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFeedUrl, createFeedUrlReader } = require('../../src/main/updater');

/** What electron-builder writes into resources/app-update.yml for `publish: [{ provider: 'generic', url }]`. */
const GENERATED = ['provider: generic', 'url: https://updates.example.com/gadgetspos-desktop/', 'updaterCacheDirName: gadgetspos-updater', ''].join('\n');

test('parseFeedUrl: the file electron-builder generates (unquoted url)', () => {
  assert.equal(parseFeedUrl(GENERATED), 'https://updates.example.com/gadgetspos-desktop/');
});

test('parseFeedUrl: double-quoted, single-quoted and unquoted values', () => {
  assert.equal(parseFeedUrl('provider: generic\nurl: "https://updates.example.com/dq/"\n'), 'https://updates.example.com/dq/');
  assert.equal(parseFeedUrl("provider: generic\nurl: 'https://updates.example.com/sq/'\n"), 'https://updates.example.com/sq/');
  assert.equal(parseFeedUrl('provider: generic\nurl: https://updates.example.com/plain/\n'), 'https://updates.example.com/plain/');
});

test('parseFeedUrl: line endings, spacing and trailing comments', () => {
  assert.equal(parseFeedUrl('provider: generic\r\nurl: https://updates.example.com/crlf/\r\nupdaterCacheDirName: x\r\n'), 'https://updates.example.com/crlf/');
  assert.equal(parseFeedUrl('url:https://updates.example.com/tight/'), 'https://updates.example.com/tight/');
  assert.equal(parseFeedUrl('url   :    https://updates.example.com/wide/   \n'), 'https://updates.example.com/wide/');
  assert.equal(parseFeedUrl('url: https://updates.example.com/c/   # the feed\n'), 'https://updates.example.com/c/');
  assert.equal(parseFeedUrl('url: "https://updates.example.com/q/"   # the feed\n'), 'https://updates.example.com/q/');
  assert.equal(parseFeedUrl('url: https://updates.example.com/a#b\n'), 'https://updates.example.com/a#b', 'a # inside the value is not a comment');
  assert.equal(parseFeedUrl('\n\nprovider: generic\n\nurl: https://updates.example.com/blank-lines/\n'), 'https://updates.example.com/blank-lines/');
});

test('parseFeedUrl: the first top-level url key wins, nested or similarly named keys are not it', () => {
  assert.equal(parseFeedUrl('url: https://first.example.com/\nurl: https://second.example.com/\n'), 'https://first.example.com/');
  assert.equal(parseFeedUrl('  url: https://nested.example.com/\n'), null);
  assert.equal(parseFeedUrl('publishedUrl: https://x.example.com/\nurl2: https://y.example.com/\n'), null);
  assert.equal(parseFeedUrl('# url: https://commented.example.com/\n'), null);
  assert.equal(parseFeedUrl('provider: github\nowner: acme\nrepo: gadgetspos\n'), null, 'a github feed has no url line');
});

test('parseFeedUrl: nothing usable is null', () => {
  for (const text of ['', '\n', 'url:', 'url:   ', 'url: ""', "url: ''", 'url: #only a comment', undefined, null, 42, {}, []]) {
    assert.equal(parseFeedUrl(text), null, JSON.stringify(text));
  }
});

test('parseFeedUrl: returns the text as written, validation is the updater\'s job', () => {
  assert.equal(parseFeedUrl('url: http://updates.example.com/\n'), 'http://updates.example.com/');
  assert.equal(parseFeedUrl('url: https://CHANGE-ME.example.com/gadgetspos-desktop/\n'), 'https://CHANGE-ME.example.com/gadgetspos-desktop/');
});

test('createFeedUrlReader: reads <resourcesPath>/app-update.yml as utf8 and parses it', () => {
  const calls = [];
  const fs = {
    readFileSync(file, encoding) {
      calls.push([file, encoding]);
      return GENERATED;
    },
  };
  const readFeedUrl = createFeedUrlReader({ fs, resourcesPath: path.join('C:', 'Program Files', 'Gadgets POS', 'resources') });
  assert.equal(readFeedUrl(), 'https://updates.example.com/gadgetspos-desktop/');
  assert.deepEqual(calls, [[path.join('C:', 'Program Files', 'Gadgets POS', 'resources', 'app-update.yml'), 'utf8']]);
});

test('createFeedUrlReader: a missing, unreadable or empty file is null, never a throw', () => {
  const missing = createFeedUrlReader({
    fs: {
      readFileSync() {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      },
    },
    resourcesPath: '/resources',
  });
  assert.equal(missing(), null);

  const empty = createFeedUrlReader({ fs: { readFileSync: () => '' }, resourcesPath: '/resources' });
  assert.equal(empty(), null);

  const binary = createFeedUrlReader({ fs: { readFileSync: () => Buffer.from([0, 1, 2]) }, resourcesPath: '/resources' });
  assert.equal(binary(), null);
});

test('createFeedUrlReader: reads the file again on every call (the answer is the updater\'s to cache)', () => {
  let content = 'url: https://one.example.com/\n';
  const readFeedUrl = createFeedUrlReader({ fs: { readFileSync: () => content }, resourcesPath: '/resources' });
  assert.equal(readFeedUrl(), 'https://one.example.com/');
  content = 'url: https://two.example.com/\n';
  assert.equal(readFeedUrl(), 'https://two.example.com/');
});
