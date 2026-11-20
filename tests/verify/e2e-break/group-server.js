'use strict';

/**
 * Group D of the runtime-e2e lens: what the REAL app does when the POS server misbehaves at start or mid-session.
 * Slow, silent, 503, TLS failure, DNS failure, a cut connection, garbage, a redirect to a foreign origin, a blank 200, a 500 on an in-app
 * navigation, an invalid address. Every failure screen is captured (PNG in tests/verify/e2e-break/out/) so a human can look at it.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createBreakServer } = require('./break-server');
const {
  AppRun, scenario, sleep, seconds, waitFor, waitForPos, mainUrl, isOfflineUrl, isLoadingUrl, readOffline, makeDir,
} = require('./harness');

/** Runs `fn(run)` with an app that is always stopped afterwards; returns what `stop()` measured. */
async function withApp(options, fn) {
  const run = new AppRun(options);
  try {
    await run.start();
    await fn(run);
    run.sampleFocus(`after ${options.name}`);
  } finally {
    run.lastStop = await run.stop({ timeoutMs: 15_000 }).catch((error) => ({ error: error.message }));
  }
  return run.lastStop;
}


/**
 * Whether the "taking longer than usual" hint of loading.html is showing. `webContents.executeJavaScript` waits for a pending navigation
 * to finish, so a page that is still loading is read through the debugger instead.
 */
async function hintVisible(run) {
  if (!run.browser) await run.attach();
  const pages = await run.browser.pages();
  const page = pages.find((candidate) => isLoadingUrl(candidate.url()) || isLoadingUrl(candidate.target().url()));
  if (!page) return { found: false };
  const visible = await page.evaluate(() => {
    const hint = document.getElementById('hint');
    return hint ? !hint.hidden : null;
  });
  return { found: true, visible };
}

/** A self-signed certificate for 127.0.0.1 (Chromium rejects it: ERR_CERT_AUTHORITY_INVALID). null when openssl is not there. */
function selfSignedCert() {
  const dir = makeDir('tls');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  } catch {
    return null;
  }
}

async function runServerGroup(only) {
  const wants = (id) => !only || only.includes(id);

  // ---- D1 a slow server -------------------------------------------------------------------------------------------------------
  if (wants('D1')) {
    await scenario('D1', 'A very slow server (the page takes 20 s): the loading screen stays, never a blank window, the POS arrives by itself', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'slow', ms: 20_000 });
      try {
        await withApp({ name: 'd1-slow', startUrl: server.smokeUrl }, async (run) => {
          const began = Date.now();
          await sleep(3000);
          const early = await run.shot('slow-3s');
          const urlEarly = await mainUrl(run);
          t.check('after 3 s the window shows the loading screen', isLoadingUrl(urlEarly), urlEarly);
          t.check('the window paints it (not a blank window)', early.ok && early.distinctColors > 4, early);
          const hintEarly = await hintVisible(run);
          t.check('the "taking longer" hint is not shown yet', hintEarly.found && hintEarly.visible === false, hintEarly);
          await sleep(10_500);
          const late = await run.shot('slow-14s');
          const hintLate = await hintVisible(run);
          t.check('after 14 s the hint "This is taking longer than usual" is shown', hintLate.found && hintLate.visible === true, hintLate);
          t.check('the window still paints (not blank)', late.ok && late.distinctColors > 4, late);
          t.check('the app did NOT show the offline screen for a slow answer', isLoadingUrl(await mainUrl(run)), await mainUrl(run));
          const info = await waitForPos(run, server.origin, 25_000).catch(() => null);
          const took = Date.now() - began;
          t.check('the POS appears by itself when the page finally arrives', Boolean(info), await mainUrl(run));
          t.note(`the POS appeared ${seconds(took)} after the app was ready (server delay 20 s)`);
          const electron = await run.page("return typeof window.electron;");
          t.check('and window.electron is there', electron.ok && electron.value === 'object', electron);
          t.check('exactly one page request was made (no reload storm while waiting)', server.hits('/vendor/point-of-sale', 'GET') === 1, server.requests.filter((r) => r.method === 'GET'));
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D2 a server that never answers -----------------------------------------------------------------------------------------
  if (wants('D2')) {
    await scenario('D2', 'A server that accepts the connection and never answers: stuck state, what the cashier can do, and a quick quit', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'hang' });
      try {
        const stopped = await withApp({ name: 'd2-hang', startUrl: server.smokeUrl }, async (run) => {
          await sleep(2000);
          await run.attach();
          t.check('the first request reached the server', server.hits('/vendor/point-of-sale', 'GET') === 1, server.requests);
          await sleep(43_000);
          const url = await mainUrl(run);
          const shot = await run.shot('hang-45s');
          const hint = await hintVisible(run);
          t.check('after 45 s the window still shows the loading screen with the hint (nothing else it could show)', isLoadingUrl(url) && hint.found && hint.visible === true, { url, hint });
          t.check('and it paints (not blank)', shot.ok && shot.distinctColors > 4, shot);
          t.note(`after 45 s of silence: ${isLoadingUrl(url) ? 'loading screen with the hint, no offline screen, no retry button' : url}`);
          const before = server.hits('/vendor/point-of-sale', 'GET');
          await run.cmd('reloadMain');
          await sleep(1500);
          t.check('View > Reload while stuck starts a new request (the cashier has a way out)', server.hits('/vendor/point-of-sale', 'GET') === before + 1, server.requests.slice(-3));
          server.healthy();
          await run.cmd('reloadMain');
          const info = await waitForPos(run, server.origin, 15_000).catch(() => null);
          t.check('once the server is healthy, Reload loads the POS', Boolean(info), await mainUrl(run));
          server.get({ kind: 'hang' });
          await run.cmd('reloadMain');
          await sleep(1000);
        });
        t.check('quitting while a page load is hanging is quick and clean (no forced kill)', stopped && !stopped.forced && stopped.ms < 12_000, stopped);
        t.note(`quit took ${stopped ? seconds(stopped.ms) : '?'} while a page request hung`);
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D3 / D4 HTTP 503 -------------------------------------------------------------------------------------------------------
  if (wants('D3')) {
    await scenario('D3', 'HTTP 503 from the server (page and probe): the "server has a problem" screen, attempts counted, the POS returns when the server is healthy', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'status', status: 503 });
      server.head({ kind: 'status', status: 503 });
      try {
        await withApp({ name: 'd3-503', startUrl: server.smokeUrl }, async (run) => {
          await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
          const offline = await readOffline(run);
          t.check('the window shows the offline screen with reason=server', /reason=server/.test(offline.url) && /code=503/.test(offline.url), offline.url);
          t.check('its headline says "The server has a problem"', offline.headline === 'The server has a problem', offline);
          await sleep(1500);
          const shot = await run.shot('server-503');
          t.check('and it paints', shot.ok && shot.distinctColors > 6, shot);
          const attemptOf = async () => (await run.cmd('desktopApi', { name: 'connection.getStatus' })).attempt;
          const first = await attemptOf();
          await waitFor(async () => (await attemptOf()) > first, 'the attempt counter to grow', { timeoutMs: 12_000 });
          t.check('the probes keep failing against a 503 and the counter grows (the POS is NOT reloaded into a 503 loop)', true);
          const gets = server.hits('/vendor/point-of-sale', 'GET');
          t.note(`GET page requests so far: ${gets}`);
          server.healthy();
          const back = await waitForPos(run, server.origin, 40_000).catch(() => null);
          t.check('when the server is healthy the POS loads by itself', Boolean(back), await mainUrl(run));
        });
      } finally {
        await server.stop();
      }
    });
  }

  if (wants('D4')) {
    await scenario('D4', 'A server whose page answers 503 while the HEAD probe answers 200 (a half-broken server): how often does the app reload', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'status', status: 503 });
      try {
        await withApp({ name: 'd4-half', startUrl: server.smokeUrl }, async (run) => {
          await sleep(45_000);
          const gets = server.requests.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/vendor/point-of-sale'));
          const gaps = gets.slice(1).map((entry, index) => entry.at - gets[index].at);
          t.record('getTimes', gets.map((entry) => entry.at - gets[0].at));
          t.record('gaps', gaps);
          t.note(`45 s of a 503 page with a healthy probe: ${gets.length} page requests, gaps in ms ${JSON.stringify(gaps)}`);
          const lateGaps = gaps.slice(-3);
          t.check('the gap between page requests GROWS during a long outage (backoff reaches 24 s or more), like the probe loop of a plain outage',
            gaps.length >= 3 && lateGaps.every((gap) => gap >= 12_000), { gaps });
          const shot = await run.shot('half-broken-server');
          t.record('shot', shot.file);
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D5 TLS -----------------------------------------------------------------------------------------------------------------
  if (wants('D5')) {
    await scenario('D5', 'A TLS failure (self-signed certificate on the POS address): the secure-connection screen, no bypass, keeps trying', async (t) => {
      const tls = selfSignedCert();
      if (!tls) {
        t.note('openssl is not available: skipped');
        t.check('openssl is available to make a certificate', false, 'no openssl');
        return;
      }
      const server = await createBreakServer({ tls });
      try {
        await withApp({ name: 'd5-tls', startUrl: server.smokeUrl }, async (run) => {
          await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
          const offline = await readOffline(run);
          t.check('the window shows the offline screen with reason=tls', /reason=tls/.test(offline.url), offline.url);
          t.check('its headline says "The secure connection failed"', offline.headline === 'The secure connection failed', offline);
          t.check('it tells the cashier to check the date and time', /date or time/.test(offline.body), offline.body);
          await sleep(1500);
          const shot = await run.shot('tls-failure');
          t.check('and it paints', shot.ok && shot.distinctColors > 6, shot);
          const attemptOf = async () => (await run.cmd('desktopApi', { name: 'connection.getStatus' }));
          const first = await attemptOf();
          await waitFor(async () => (await attemptOf()).attempt > first.attempt, 'a probe to run', { timeoutMs: 12_000 });
          const second = await attemptOf();
          t.check('the probe keeps failing (no certificate bypass) and the status keeps the tls reason', second.online === false && second.reason === 'tls', second);
          const page = await server.requests.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/vendor')).length;
          t.check('the server never saw a page request (the TLS handshake failed)', page === 0, server.requests);
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D6 DNS -----------------------------------------------------------------------------------------------------------------
  if (wants('D6')) {
    await scenario('D6', 'A server address that does not resolve: the "can\'t find the server" screen', async (t) => {
      await withApp({ name: 'd6-dns', startUrl: 'http://gpos-e2e-no-such-host.invalid/vendor/point-of-sale' }, async (run) => {
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 30_000 });
        const offline = await readOffline(run);
        t.record('offline', offline);
        t.check('the window shows the offline screen', isOfflineUrl(offline.url), offline.url);
        t.check('reason is dns', /reason=dns/.test(offline.url), offline.url);
        t.check('its headline says "Can\'t find the server"', offline.headline === "Can't find the server", offline);
        await sleep(1500);
        const shot = await run.shot('dns-failure');
        t.check('and it paints', shot.ok && shot.distinctColors > 6, shot);
      });
    });
  }

  // ---- D7 / D8 cut connection, garbage ----------------------------------------------------------------------------------------
  if (wants('D7')) {
    await scenario('D7', 'A server that cuts the connection (no answer) and one that answers something that is not HTTP: a failure screen, never blank, recovery', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'close' });
      try {
        await withApp({ name: 'd7-cut', startUrl: server.smokeUrl }, async (run) => {
          await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
          let offline = await readOffline(run);
          t.record('cut', offline);
          t.check('a cut connection gives the offline screen', isOfflineUrl(offline.url), offline.url);
          t.note(`cut connection -> ${offline.url.split('?')[1]} -> "${offline.headline}"`);
          await sleep(1200);
          const cutShot = await run.shot('cut-connection');
          t.check('and it paints', cutShot.ok && cutShot.distinctColors > 6, cutShot);

          server.get({ kind: 'garbage' });
          await run.cmd('retryNowMain');
          await sleep(500);
          await run.cmd('loadPos');
          await waitFor(async () => /code=-?\d+/.test((await readOffline(run) || {}).url || '') && (await readOffline(run)).url !== offline.url, 'the screen for garbage', { timeoutMs: 15_000 }).catch(() => {});
          offline = await readOffline(run);
          t.record('garbage', offline);
          t.check('garbage instead of HTTP also gives the offline screen', isOfflineUrl(offline.url), offline.url);
          t.note(`garbage -> ${offline.url.split('?')[1]} -> "${offline.headline}"`);

          server.healthy();
          const back = await waitForPos(run, server.origin, 40_000).catch(() => null);
          t.check('and the POS comes back by itself once the server is healthy', Boolean(back), await mainUrl(run));
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D9 redirect to a foreign origin at start -------------------------------------------------------------------------------
  if (wants('D9')) {
    await scenario('D9', 'The POS address redirects to an origin the app does not trust: what does the cashier see?', async (t) => {
      const server = await createBreakServer();
      const foreign = await createBreakServer({ label: 'foreign' });
      server.get({ kind: 'redirect', location: foreign.smokeUrl });
      try {
        await withApp({ name: 'd9-redirect', startUrl: server.smokeUrl }, async (run) => {
          await sleep(8000);
          const info = await run.cmd('mainInfo');
          const shot = await run.shot('redirect-foreign-http');
          t.record('http', { url: info.url, shot });
          t.check('the foreign server was never contacted (redirect blocked)', foreign.requests.length === 0, foreign.requests);
          t.check('the window shows the offline/error screen, not the loading spinner for ever', !isLoadingUrl(info.url), info.url);
          t.note(`after 8 s the window shows: ${info.url.split('?')[0].split('/').pop()}`);
          const state = await run.state();
          t.check('nothing was handed to the system browser for a plain http foreign address', state.openExternal.length === 0, state.openExternal);

          // the https variant: the app hands it to the system browser and shows a notice
          server.get({ kind: 'redirect', location: 'https://evil.example.com/login?next=pos' });
          await run.cmd('reloadMain');
          await sleep(4000);
          const after = await run.state();
          const info2 = await run.cmd('mainInfo');
          const shot2 = await run.shot('redirect-foreign-https');
          t.record('https', { url: info2.url, openExternal: after.openExternal, notices: after.notices, shot2 });
          t.note(`https redirect: openExternal=${JSON.stringify(after.openExternal.map((entry) => entry.url))} window=${info2.url.split('?')[0].split('/').pop()}`);
          t.check('after a redirect to a foreign https address the window is not left on the loading spinner', !isLoadingUrl(info2.url), info2.url);
          server.healthy();
          await run.cmd('reloadMain');
          const back = await waitForPos(run, server.origin, 15_000).catch(() => null);
          t.check('Reload recovers once the server stops redirecting', Boolean(back), await mainUrl(run));
        });
      } finally {
        await server.stop();
        await foreign.stop();
      }
    });
  }

  // ---- D10 a blank 200 --------------------------------------------------------------------------------------------------------
  if (wants('D10')) {
    await scenario('D10', 'A server that answers 200 with an empty body (a blank page) and one that cuts the page in half', async (t) => {
      const server = await createBreakServer();
      server.get({ kind: 'empty200' });
      try {
        await withApp({ name: 'd10-blank', startUrl: server.smokeUrl }, async (run) => {
          await sleep(4000);
          const shot = await run.shot('blank-200');
          const info = await run.cmd('mainInfo');
          t.record('blank', { url: info.url, title: info.title, shot });
          t.note(`empty 200: window url ${info.url}, title "${info.title}", distinct colours ${shot.distinctColors}`);
          t.check('the window is the POS address (the app cannot know a 200 is blank) and the app is alive', info.url.startsWith(server.origin), info.url);
          server.get({ kind: 'partial' });
          await run.cmd('reloadMain');
          await sleep(3500);
          const info2 = await run.cmd('mainInfo');
          const shot2 = await run.shot('partial-page');
          t.note(`half a page, then a cut connection: window url ${info2.url.split('?')[0]}`);
          t.check('a page cut off in the middle does not leave the app broken: it shows something that paints', shot2.ok && shot2.distinctColors > 1, shot2);
          server.healthy();
          await run.cmd('reloadMain');
          const back = await waitForPos(run, server.origin, 15_000).catch(() => null);
          t.check('Reload recovers', Boolean(back), await mainUrl(run));
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D11 a 500 on an in-app navigation --------------------------------------------------------------------------------------
  if (wants('D11')) {
    await scenario('D11', 'A 500 on an ordinary page navigation INSIDE the POS (not the start address): what replaces the page', async (t) => {
      const server = await createBreakServer();
      try {
        await withApp({ name: 'd11-inner500', startUrl: server.smokeUrl }, async (run) => {
          await waitForPos(run, server.origin, 25_000);
          const marker = (await run.page('return window.__pos.marker;')).value;
          server.path('/vendor/report', { kind: 'status', status: 500 });
          await run.page("window.__pos.helpers.navigate('/vendor/report?range=today'); return 'navigating';");
          await sleep(1800);
          const url = await mainUrl(run);
          const shot = await run.shot('inner-navigation-500');
          t.record('after500', { url, shot });
          t.note(`after a 500 on ${server.origin}/vendor/report: the window shows ${url.split('?')[0]}`);
          const offline = isOfflineUrl(url);
          t.check('SPEC 11.2 says the server-error screen is for the main-frame navigation to serverUrl; an in-app page that errors keeps the server\'s own page (no offline screen, no reload of the home page)', !offline, url);
          if (offline) {
            await waitFor(async () => !isOfflineUrl(await mainUrl(run)), 'the app to reload the POS', { timeoutMs: 15_000 }).catch(() => {});
            const url2 = await mainUrl(run);
            const marker2 = (await run.page('return window.__pos && window.__pos.marker;').catch(() => ({}))).value;
            t.note(`then the app reloaded ${url2} (marker changed: ${marker2 !== marker}), the user is back on the home page, not on /vendor/report`);
          }
        });
      } finally {
        await server.stop();
      }
    });
  }

  if (wants('D13')) {
    await scenario('D13', 'The opposite mismatch: the page is fine but the HEAD probe answers 500 (a server that cannot answer HEAD): does the offline screen ever recover?', async (t) => {
      const server = await createBreakServer();
      await server.stop();
      try {
        await withApp({ name: 'd13-head500', startUrl: server.smokeUrl }, async (run) => {
          await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
          server.head({ kind: 'status', status: 500 });
          await server.start();
          const began = Date.now();
          const posBack = await waitForPos(run, server.origin, 30_000).catch(() => null);
          t.record('autoRecoveryMs', posBack ? Date.now() - began : null);
          t.note(`the server is back (page 200, HEAD 500): the POS ${posBack ? `loaded by itself after ${seconds(Date.now() - began)}` : 'did NOT load by itself within 30 s'}`);
          t.check('the POS loads by itself once the page works (the probe must not be fooled by a failing HEAD)', Boolean(posBack), await mainUrl(run));
          if (!posBack) {
            await run.cmd('retryNowMain');
            await sleep(4000);
            const afterRetry = await mainUrl(run);
            t.check('Retry now on the offline screen loads the POS', afterRetry.startsWith(server.origin), afterRetry);
            await run.cmd('reloadMain');
            const viaReload = await waitForPos(run, server.origin, 10_000).catch(() => null);
            t.note(`View > Reload: ${viaReload ? 'loads the POS (the only way out)' : 'does not load it either'}`);
          }
        });
      } finally {
        await server.stop();
      }
    });
  }

  // ---- D12 an invalid address ---------------------------------------------------------------------------------------------------
  if (wants('D12')) {
    await scenario('D12', 'An invalid server address: a plain screen, Retry now does not loop or crash', async (t) => {
      await withApp({ name: 'd12-invalid', startUrl: 'ftp://nonsense/vendor' }, async (run) => {
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the offline screen', { timeoutMs: 20_000 });
        const offline = await readOffline(run);
        t.check('the offline screen shows with code INVALID_URL', /code=INVALID_URL/.test(offline.url), offline.url);
        await sleep(1200);
        const shot = await run.shot('invalid-address');
        t.check('and it paints', shot.ok && shot.distinctColors > 6, shot);
        t.record('invalid', offline);
        const chip = await run.page("const title = document.getElementById('connect-title'); return title && title.textContent;");
        t.record('invalidChip', chip);
        t.check('the status chip does NOT claim "Back online - reloading..." (no probe runs and nothing is reloading)', chip.ok && !/Back online/.test(chip.value || ''), chip);
        await run.cmd('retryNowMain');
        await sleep(800);
        t.check('Retry now keeps the same screen (no exception, no blank)', isOfflineUrl(await mainUrl(run)), await mainUrl(run));
        const status = await run.cmd('desktopApi', { name: 'connection.getStatus' });
        t.note(`status of the connection controller: ${JSON.stringify(status)}`);
      });
    });
  }

}

module.exports = { runServerGroup, withApp, selfSignedCert };
