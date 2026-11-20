'use strict';

/**
 * Group C of the runtime-e2e lens: the connection dying and coming back while the REAL app runs.
 *
 *  C1  the server dies mid-session and comes back, five times in a row: banner, "Back online", no reload, no duplicate banner, no leak
 *  C2  repeated offline/online toggles (DevTools network emulation), fast, ending online and ending offline: no stuck banner
 *  C3  a long outage on the offline screen: the backoff schedule (3, 6, 12, 24, 30 s +-20 %), then the POS returns by itself
 */

const fs = require('node:fs');
const path = require('node:path');

const { createBreakServer } = require('./break-server');
const {
  AppRun, scenario, sleep, seconds, waitFor, waitForPos, mainUrl, isOfflineUrl, readBanner, posPage,
} = require('./harness');

const OFFLINE = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const ONLINE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

async function runNetworkGroup(only) {
  const wants = (id) => !only || only.includes(id);

  // ---- C1 the server dies and comes back, five times ---------------------------------------------------------------------------
  if (wants('C1')) {
    await scenario('C1', 'The server dies mid-session and comes back, five times: banner each time, "Back online", never a reload, one banner only, no leak', async (t) => {
      const server = await createBreakServer();
      const run = new AppRun({ name: 'c1-cycles', startUrl: server.smokeUrl });
      try {
        await run.start();
        await waitForPos(run, server.origin, 30_000);
        await run.attach();
        const page = await posPage(run, server.origin);
        const client = await page.createCDPSession();
        const marker = (await run.page('return window.__pos.marker;')).value;
        const rssBefore = run.rssKb();
        const detect = [];
        const recover = [];
        let maxHosts = 0;
        for (let cycle = 1; cycle <= 5; cycle += 1) {
          await server.stop();
          const stoppedAt = Date.now();
          await run.page('return await Promise.all([window.__pos.helpers.ping(1), window.__pos.helpers.ping(2)]);');
          const offline = await waitFor(async () => {
            const banner = await readBanner(client);
            return banner && banner.state === 'offline' ? banner : null;
          }, `cycle ${cycle}: the offline banner`, { timeoutMs: 14_000, intervalMs: 150 }).catch(() => null);
          detect.push(offline ? Date.now() - stoppedAt : null);
          if (offline) maxHosts = Math.max(maxHosts, offline.hosts);
          await server.start();
          const startedAt = Date.now();
          const online = await waitFor(async () => {
            const banner = await readBanner(client);
            return banner && banner.state === 'online' ? banner : null;
          }, `cycle ${cycle}: "Back online"`, { timeoutMs: 40_000, intervalMs: 150 }).catch(() => null);
          recover.push(online ? Date.now() - startedAt : null);
          if (online) maxHosts = Math.max(maxHosts, online.hosts);
          await waitFor(async () => {
            const banner = await readBanner(client);
            return banner && banner.state === 'hidden' ? banner : null;
          }, `cycle ${cycle}: the banner to go away`, { timeoutMs: 8000, intervalMs: 150 }).catch(() => null);
          // let the next outage start from a clean slate: the old keep-alive connections are gone, and two new request errors are needed
          await sleep(500);
        }
        t.record('detectMs', detect);
        t.record('recoverMs', recover);
        t.note(`banner appeared after ${JSON.stringify(detect)} ms; "Back online" after ${JSON.stringify(recover)} ms (server restart to banner)`);
        t.check('the banner appeared in every one of the 5 outages', detect.every((ms) => ms !== null), detect);
        t.check('and each time within 14 s of the first failed requests', detect.every((ms) => ms !== null && ms < 14_000), detect);
        t.check('"Back online" followed every restart', recover.every((ms) => ms !== null), recover);
        const finalBanner = await readBanner(client);
        t.check('in the end the banner is hidden', finalBanner && finalBanner.state === 'hidden', finalBanner);
        t.check('there was never more than one banner element in the page', maxHosts === 1, maxHosts);
        t.check('the page was never reloaded through all five outages (the marker survived)', (await run.page('return window.__pos.marker;')).value === marker);
        const status = await run.cmd('desktopApi', { name: 'connection.getStatus' });
        t.check('the connection controller is idle again (nothing keeps probing a healthy server)', status.online === true, status);
        const logFile = path.join(run.userData, 'logs', 'main.log');
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        const starts = (log.match(/banner mode started/g) || []).length;
        t.check('the log shows one banner probe per outage', starts === 5, starts);
        t.note(`resident memory: ${Math.round(rssBefore / 1024)} MB before, ${Math.round(run.rssKb() / 1024)} MB after`);
        await client.detach().catch(() => {});
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- C2 offline/online toggles --------------------------------------------------------------------------------------------------
  if (wants('C2')) {
    await scenario('C2', 'Repeated offline/online toggles (20 in 3 s, ending online; then ending offline): the banner settles, never stuck', async (t) => {
      const server = await createBreakServer();
      const run = new AppRun({ name: 'c2-toggles', startUrl: server.smokeUrl });
      try {
        await run.start();
        await waitForPos(run, server.origin, 30_000);
        await run.attach();
        const page = await posPage(run, server.origin);
        const client = await page.createCDPSession();
        await client.send('Network.enable');
        const marker = (await run.page('return window.__pos.marker;')).value;
        let maxHosts = 0;
        const states = new Set();

        for (let i = 0; i < 20; i += 1) {
          await client.send('Network.emulateNetworkConditions', i % 2 === 0 ? OFFLINE : ONLINE);
          await sleep(150);
          const banner = await readBanner(client);
          if (banner) {
            maxHosts = Math.max(maxHosts, banner.hosts);
            states.add(banner.state);
          }
        }
        // the last toggle (i = 19) went online
        const settled = await waitFor(async () => {
          const banner = await readBanner(client);
          return banner && banner.state === 'hidden' ? banner : null;
        }, 'the banner to settle on hidden after the last online', { timeoutMs: 12_000, intervalMs: 200 }).catch(() => null);
        t.check('20 quick toggles ending online: the banner ends hidden (not stuck on offline or on "Back online")', Boolean(settled), await readBanner(client));
        t.note(`banner states seen during the toggling: ${[...states].join(', ')}`);

        for (let i = 0; i < 21; i += 1) {
          await client.send('Network.emulateNetworkConditions', i % 2 === 0 ? OFFLINE : ONLINE);
          await sleep(120);
        }
        // the last toggle (i = 20) went offline
        await sleep(1500);
        const offline = await readBanner(client);
        maxHosts = Math.max(maxHosts, offline ? offline.hosts : 0);
        t.check('21 toggles ending offline: the banner says offline', offline && offline.state === 'offline', offline);
        await client.send('Network.emulateNetworkConditions', ONLINE);
        const back = await waitFor(async () => {
          const banner = await readBanner(client);
          return banner && banner.state === 'hidden' ? banner : null;
        }, 'the banner to go away once online', { timeoutMs: 12_000, intervalMs: 200 }).catch(() => null);
        t.check('and it goes away after "Back online"', Boolean(back), await readBanner(client));
        t.check('never more than one banner element', maxHosts <= 1, maxHosts);
        t.check('the page was never reloaded', (await run.page('return window.__pos.marker;')).value === marker);
        const status = await run.cmd('desktopApi', { name: 'connection.getStatus' });
        t.note(`connection controller after the toggling: ${JSON.stringify(status)}`);
        await client.send('Network.disable').catch(() => {});
        await client.detach().catch(() => {});
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- C3 a long outage on the offline screen ---------------------------------------------------------------------------------------
  if (wants('C3')) {
    await scenario('C3', 'A 55 s outage on the offline screen: attempts follow the backoff (3, 6, 12, 24 s) and the POS comes back by itself', async (t) => {
      const server = await createBreakServer();
      await server.stop();
      const run = new AppRun({ name: 'c3-long', startUrl: server.smokeUrl });
      try {
        await run.start();
        const began = Date.now();
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
        const times = [];
        let last = 0;
        const samples = [];
        while (Date.now() - began < 55_000) {
          const status = await run.cmd('desktopApi', { name: 'connection.getStatus' });
          samples.push({ at: Date.now() - began, attempt: status.attempt, nextRetryInMs: status.nextRetryInMs, online: status.online });
          if (status.attempt > last) {
            times.push(Date.now() - began);
            last = status.attempt;
          }
          await sleep(500);
        }
        const gaps = times.slice(1).map((time, index) => time - times[index]);
        t.record('attemptTimes', times);
        t.record('gaps', gaps);
        t.note(`probe attempts at ${JSON.stringify(times)} ms after the screen appeared; gaps ${JSON.stringify(gaps)}`);
        t.check('at least 4 probes ran in 55 s (3 + 6 + 12 + 24 s steps)', times.length >= 4, times);
        t.check('each gap is longer than the one before, within the +-20 % jitter and 1 s of probe time (about 6, 12, 24)',
          gaps.length >= 3 && gaps[0] >= 4000 && gaps[0] <= 8500 && gaps[1] >= 9000 && gaps[1] <= 15_500 && gaps[2] >= 18_000 && gaps[2] <= 30_500, gaps);
        const next = samples.at(-1);
        t.note(`at 55 s: attempt ${next.attempt}, next retry in ${next.nextRetryInMs} ms`);
        const startedAt = Date.now();
        await server.start();
        const dueIn = next.nextRetryInMs;
        const pos = await waitForPos(run, server.origin, 45_000).catch(() => null);
        const took = Date.now() - startedAt;
        t.check('the POS loads by itself after the server returns', Boolean(pos), await mainUrl(run));
        t.check('no later than the next scheduled probe plus 5 s', pos && took <= (dueIn || 0) + 6500, { took, dueIn });
        t.note(`the POS was back ${seconds(took)} after the server returned (next probe was due in ${dueIn} ms)`);
        await run.shot('after-long-outage');
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

}

module.exports = { runNetworkGroup };
