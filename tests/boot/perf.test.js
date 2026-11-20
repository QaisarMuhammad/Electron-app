'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPerf, MARK_NAMES, formatDuration } = require('../../src/main/perf');

/** A wall clock and an uptime that the test moves by hand: the process "started" `uptime` ms before `clock.time`. */
function setup({ uptime = 120 } = {}) {
  const clock = { time: 1_000_000 };
  const logged = [];
  const perf = createPerf({ now: () => clock.time, uptimeMs: () => uptime, log: { info: (line) => logged.push(line) } });
  return { clock, logged, perf };
}

test('process-start is always 0 and every other mark counts from the start of the process, not from the first line of JavaScript', () => {
  const { clock, perf } = setup({ uptime: 120 });
  assert.deepEqual(perf.marks(), { 'process-start': 0 });
  clock.time += 200;
  assert.equal(perf.mark('app-ready'), 320, '120 ms of Electron start-up plus 200 ms of ours');
  clock.time += 80;
  assert.equal(perf.mark('window-created'), 400);
});

test('the first mark of a name wins: pos-dom-ready and pos-loaded fire again after every reload and must not move the startup numbers', () => {
  const { clock, perf } = setup({ uptime: 0 });
  clock.time += 100;
  perf.mark('pos-loaded');
  clock.time += 5000;
  assert.equal(perf.mark('pos-loaded'), 100);
  assert.equal(perf.marks()['pos-loaded'], 100);
});

test('unusable names are refused and the number of marks is bounded', () => {
  const { perf } = setup();
  for (const bad of [undefined, null, 5, '', 'x'.repeat(41), {}]) assert.equal(perf.mark(bad), undefined);
  for (let i = 0; i < 100; i += 1) perf.mark(`extra-${i}`);
  assert.ok(Object.keys(perf.marks()).length <= 32);
  assert.equal(perf.has('process-start'), true);
  assert.equal(perf.has('never'), false);
});

test('measures are sorted by time and carry the time since the previous mark', () => {
  const { clock, perf } = setup({ uptime: 0 });
  clock.time += 300;
  perf.mark('app-ready');
  clock.time += 50;
  perf.mark('window-created');
  clock.time += 100;
  perf.mark('loading-visible');
  assert.deepEqual(perf.measures(), [
    { name: 'process-start', at: 0, delta: 0 },
    { name: 'app-ready', at: 300, delta: 300 },
    { name: 'window-created', at: 350, delta: 50 },
    { name: 'loading-visible', at: 450, delta: 100 },
  ]);
});

test('the marks of the app are named in startup order (SPEC 18b S3; loading-painted is the mark of the drawn loading screen)', () => {
  assert.deepEqual([...MARK_NAMES], ['process-start', 'app-ready', 'window-created', 'loading-visible', 'loading-painted', 'config-ready', 'services-ready', 'pos-dom-ready', 'pos-loaded']);
});

test('the summary says how fast the loading screen and the POS came up, in plain units', () => {
  const { clock, perf } = setup({ uptime: 0 });
  assert.equal(perf.summary(), '');
  clock.time += 402;
  perf.mark('loading-visible');
  assert.equal(perf.summary(), 'Loading screen in 402 ms.');
  clock.time += 1978;
  perf.mark('pos-loaded');
  assert.equal(perf.summary(), 'Loading screen in 402 ms. POS ready in 2.4 s.');
  assert.deepEqual(perf.startup(), { marks: perf.marks(), summary: 'Loading screen in 402 ms. POS ready in 2.4 s.' });
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1.0 s');
});

test('the startup numbers are logged as ONE line, once', () => {
  const { clock, logged, perf } = setup({ uptime: 0 });
  clock.time += 400;
  perf.mark('loading-visible');
  assert.equal(perf.logOnce(), true);
  assert.equal(perf.logOnce(), false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^startup: process-start 0 ms, loading-visible 400 ms \| Loading screen in 400 ms\.$/);
});

test('a missing or broken clock input never produces a negative or NaN mark', () => {
  const perf = createPerf({ now: () => 50, uptimeMs: () => Number.NaN });
  assert.equal(perf.mark('app-ready'), 0);
  const early = createPerf({ now: () => 10, uptimeMs: () => 500 });
  assert.equal(early.mark('app-ready'), 500, 'the clock origin is the start of the process');
});
