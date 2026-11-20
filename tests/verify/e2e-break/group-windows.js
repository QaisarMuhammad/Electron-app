'use strict';

/**
 * Group E of the runtime-e2e lens: windows, security and process behaviour of the REAL app.
 *
 *  E1  Settings requested five times at once (and by four menu items at once): one window, destroyed on close
 *  E2  the same with "ask for the drawer password before Settings opens": one prompt, then one Settings window
 *  E3  a password prompt that is already open for one purpose, asked for another
 *  E4  the POS window closed with a print job queued, then the dock icon (activate)
 *  E5  wrong-origin pages: foreign iframe popups, navigations to javascript:/data:/file:/chrome:, window.open of the same, a popup flood
 *  E6  a hung page: Electron says "unresponsive"; "Wait" and "Reload"
 *  E7  a reload storm (30 reloads and 10 loads at once)
 *  E8  quitting with Settings and a password prompt open, and quitting on the offline screen
 *  E9  crash screens: one crash, then a crash loop (what the screen says)
 */

const fs = require('node:fs');
const path = require('node:path');

const { createBreakServer } = require('./break-server');
const {
  AppRun, scenario, sleep, seconds, waitFor, waitForPos, mainUrl, isOfflineUrl, readOffline,
} = require('./harness');

const PASSWORD = 'e2e-pass-1234';
const isSettings = (url) => /\/src\/renderer\/settings\.html/.test(url);
const isPassword = (url) => /\/src\/renderer\/password\.html/.test(url);

async function startPos(name, options = {}) {
  const server = await createBreakServer();
  const run = new AppRun({ name, startUrl: server.smokeUrl, ...options });
  await run.start();
  await waitForPos(run, server.origin, 30_000);
  return { server, run };
}

const windowsOf = async (run, test) => (await run.cmd('windows')).filter((win) => test(win.url));

/** A drawer password and "ask for it before Settings opens". */
async function protectSettings(run) {
  await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: 'E2E-Receipt-58', port: '' } });
  const set = await run.cmd('desktopApi', { name: 'setDrawerPassword', args: [{ next: PASSWORD }] });
  const save = await run.cmd('desktopApi', { name: 'saveDrawerSettings', args: [{ enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, requirePasswordForSettings: true, password: PASSWORD }] });
  return { set, save };
}

/** The text of an element of a page of the app (Settings, the password window), read through the debugger. */
async function textInWindow(run, test, selector) {
  if (!run.browser) await run.attach();
  const pages = await run.browser.pages();
  const page = pages.find((candidate) => test(candidate.target().url()));
  if (!page) return null;
  return page.$eval(selector, (element) => element.textContent.trim()).catch(() => null);
}

async function runWindowsGroup(only) {
  const wants = (id) => !only || only.includes(id);

  // ---- E1 Settings twice at once ---------------------------------------------------------------------------------------------------
  if (wants('E1')) {
    await scenario('E1', 'Settings requested 5 times in one tick and by 4 menu items at once: exactly one window; it is destroyed on close and a new one opens', async (t) => {
      const { server, run } = await startPos('e1-settings');
      try {
        const base = (await run.cmd('windows')).length;
        const answers = await run.cmd('openSettingsN', { n: 5, tab: 'printers' });
        t.check('all 5 requests answer { ok: true }', answers.every((answer) => answer.ok === true), answers);
        const first = await waitFor(async () => (await windowsOf(run, isSettings))[0] || null, 'the Settings window', { timeoutMs: 15_000 });
        await sleep(800);
        t.check('exactly ONE Settings window exists', (await windowsOf(run, isSettings)).length === 1, await run.cmd('windows'));
        const menuIds = ['settings.printers', 'settings.drawer', 'settings.connection', 'settings.general'];
        const clicks = await Promise.all(menuIds.map((id) => run.cmd('menuClick', { id }).then(() => 'ok', (error) => error.message)));
        t.note(`menu clicks: ${JSON.stringify(clicks)}`);
        await sleep(1500);
        t.check('four more concurrent menu clicks still leave exactly ONE Settings window', (await windowsOf(run, isSettings)).length === 1, await run.cmd('windows'));
        t.check('and it is the same window (focused, not recreated)', (await windowsOf(run, isSettings))[0].id === first.id, { first: first.id, now: (await windowsOf(run, isSettings)).map((win) => win.id) });
        await run.cmd('closeWindow', { id: first.id });
        await waitFor(async () => (await windowsOf(run, isSettings)).length === 0, 'the Settings window to close', { timeoutMs: 8000 });
        t.check('closing it destroys it (the window count is back to what it was)', (await run.cmd('windows')).length === base, { base, now: (await run.cmd('windows')).length });
        await run.cmd('openSettingsN', { n: 1, tab: 'about' });
        const second = await waitFor(async () => (await windowsOf(run, isSettings))[0] || null, 'a new Settings window', { timeoutMs: 15_000 });
        t.check('a request after the close creates a fresh window', second.id !== first.id, { first: first.id, second: second.id });
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0);
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E2 Settings behind the password, requested concurrently -------------------------------------------------------------------------
  if (wants('E2')) {
    await scenario('E2', 'Settings behind the drawer password, requested 3 times at once: one prompt, no Settings until the right password, then one Settings window', async (t) => {
      const { server, run } = await startPos('e2-protected');
      try {
        const setup = await protectSettings(run);
        t.check('the password and the protection are set', setup.set.ok === true && setup.save.ok === true, setup);
        const answers = await run.cmd('openSettingsN', { n: 3, tab: 'drawer' });
        t.check('every request answers "prompted"', answers.every((answer) => answer.ok === true && answer.details && answer.details.prompted === true), answers);
        await waitFor(async () => (await windowsOf(run, isPassword)).length >= 1, 'the password window', { timeoutMs: 15_000 });
        await sleep(600);
        t.check('exactly ONE password window', (await windowsOf(run, isPassword)).length === 1, await run.cmd('windows'));
        t.check('and no Settings window yet', (await windowsOf(run, isSettings)).length === 0, await run.cmd('windows'));
        const wrong = await run.cmd('desktopApi', { name: 'password.submit', args: ['not-the-password'] });
        t.check('a wrong password is refused', wrong.ok === false, wrong);
        t.check('still no Settings window', (await windowsOf(run, isSettings)).length === 0);
        const right = await run.cmd('desktopApi', { name: 'password.submit', args: [PASSWORD] });
        t.check('the right password is accepted', right.ok === true, right);
        await waitFor(async () => (await windowsOf(run, isSettings)).length === 1, 'the Settings window', { timeoutMs: 15_000 });
        await waitFor(async () => (await windowsOf(run, isPassword)).length === 0, 'the password window to close', { timeoutMs: 8000 });
        t.check('exactly one Settings window opened and the prompt closed itself', (await windowsOf(run, isSettings)).length === 1 && (await windowsOf(run, isPassword)).length === 0, await run.cmd('windows'));
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0);
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E3 a prompt that is already open for another purpose ------------------------------------------------------------------------------
  if (wants('E3')) {
    await scenario('E3', 'A password prompt already open for one purpose and another purpose asked: which one does the right password serve?', async (t) => {
      const { server, run } = await startPos('e3-purpose');
      try {
        await protectSettings(run);
        // (a) the drawer prompt is open (the web's Open button), then the manager chooses Settings
        await run.cmd('promptShow', { purpose: 'drawer' });
        await waitFor(async () => (await windowsOf(run, isPassword))[0] || null, 'the drawer prompt', { timeoutMs: 15_000 });
        await sleep(800);
        const title = await textInWindow(run, isPassword, '#pw-title');
        const asked = await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
        t.check('Settings is answered "prompted" (the app believes a Settings prompt is showing)', asked[0].ok === true && asked[0].details && asked[0].details.prompted === true, asked);
        await sleep(500);
        const titleAfter = await textInWindow(run, isPassword, '#pw-title');
        t.record('titleDrawerThenSettings', { title, titleAfter });
        t.note(`the visible prompt says "${titleAfter}" after Settings was requested (it said "${title}" before)`);
        const pulsesBefore = (await run.cmd('light')).jobs.length;
        const right = await run.cmd('desktopApi', { name: 'password.submit', args: [PASSWORD] });
        await sleep(1500);
        const pulses = (await run.cmd('light')).jobs.length - pulsesBefore;
        const settingsOpen = (await windowsOf(run, isSettings)).length;
        t.record('drawerThenSettings', { right, pulses, settingsOpen });
        t.note(`the right password: ${pulses} drawer pulse(s) sent, ${settingsOpen} Settings window(s) opened`);
        t.check('the manager who asked for Settings gets Settings (not a cash drawer pulse)', settingsOpen === 1 && pulses === 0, { pulses, settingsOpen, title: titleAfter });
        await sleep(800);
        for (const win of await windowsOf(run, isSettings)) await run.cmd('closeWindow', { id: win.id });
        await waitFor(async () => (await windowsOf(run, isPassword)).length === 0, 'the prompt to close', { timeoutMs: 8000 }).catch(() => {});
        await sleep(500);

        // (b) the Settings prompt is open, then the web's Open button asks for the drawer
        await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
        await waitFor(async () => (await windowsOf(run, isPassword)).length === 1, 'the Settings prompt', { timeoutMs: 15_000 });
        await sleep(800);
        const before = (await run.cmd('light')).jobs.length;
        const button = await run.pos('printReceipt:openButton');
        t.check('the Open button is answered "prompted"', button.result && button.result.ok === true && button.result.details && button.result.details.prompted === true, button);
        const title2 = await textInWindow(run, isPassword, '#pw-title');
        t.note(`the Open button was pressed while the Settings prompt was showing: the visible prompt says "${title2}"`);
        await run.cmd('desktopApi', { name: 'password.submit', args: [PASSWORD] });
        await sleep(1500);
        const pulses2 = (await run.cmd('light')).jobs.length - before;
        const settings2 = (await windowsOf(run, isSettings)).length;
        t.record('settingsThenDrawer', { pulses2, settings2 });
        t.note(`the right password: ${pulses2} drawer pulse(s), ${settings2} Settings window(s)`);
        t.check('the cashier who pressed Open gets the drawer (not a Settings window)', pulses2 === 1 && settings2 === 0, { pulses2, settings2, title: title2 });
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E4 the POS window closed with a job queued ---------------------------------------------------------------------------------------
  if (wants('E4')) {
    await scenario('E4', 'The POS window is closed while a receipt is queued; the dock icon (activate) brings the POS back', async (t) => {
      const { server, run } = await startPos('e4-close');
      try {
        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: 'E2E-Receipt-58', port: '' } });
        await run.cmd('delayPrinter', { ms: 2500 });
        await run.page('window.electron.sendReceiptData({ receiptFileBinary: new Uint8Array([27, 64, 49, 10]) }); return 1;');
        await sleep(400);
        await run.cmd('closeMain');
        const job = await waitFor(async () => (await run.cmd('light')).jobs.find((entry) => entry.ok === true) || null, 'the queued job to finish after the window closed', { timeoutMs: 10_000 }).catch(() => null);
        t.check('the queued receipt still printed after the window was closed', Boolean(job), (await run.cmd('light')).jobs);
        const health = await fetch(`http://127.0.0.1:${run.controlPort}/health`).then((response) => response.json()).catch(() => null);
        t.check('on macOS closing the window does not quit the app (it stays in the dock)', health && health.ok === true, health);
        t.check('no POS window is left', (await windowsOf(run, (url) => url.startsWith(server.origin) || /loading|offline/.test(url))).length === 0, await run.cmd('windows'));
        await run.cmd('delayPrinter', { ms: 0 });

        // Settings still opens with no main window behind it
        await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
        const settings = await waitFor(async () => (await windowsOf(run, isSettings))[0] || null, 'Settings with no POS window', { timeoutMs: 15_000 }).catch(() => null);
        t.check('Settings can still be opened with no POS window (no parent window to attach to)', Boolean(settings), await run.cmd('windows'));
        if (settings) await run.cmd('closeWindow', { id: settings.id });
        await sleep(500);

        // the dock icon
        await run.cmd('emitApp', { event: 'activate', details: false });
        const back = await waitForPos(run, server.origin, 30_000).catch(() => null);
        t.check('activate (the dock icon) opens a new POS window that loads the POS by itself', Boolean(back), await run.cmd('windows'));
        const electron = await run.page('return typeof window.electron;').catch(() => ({}));
        t.check('window.electron is available in the new window', electron.ok && electron.value === 'object', electron);
        const print = await run.pos('printReceipt');
        t.check('and a receipt prints from it', print.result && print.result.ok === true, print);
        await run.cmd('emitApp', { event: 'activate', details: true });
        await sleep(800);
        t.check('a second activate does not open a second POS window', (await windowsOf(run, (url) => url.startsWith(server.origin))).length === 1, await run.cmd('windows'));
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E5 wrong-origin pages -----------------------------------------------------------------------------------------------------------
  if (wants('E5')) {
    await scenario('E5', 'Wrong-origin pages: a foreign iframe opens popups, hostile navigations and window.open calls, and a popup flood', async (t) => {
      const foreign = await createBreakServer({ label: 'foreign' });
      const { server, run } = await startPos('e5-origins');
      try {
        const marker = (await run.page('return window.__pos.marker;')).value;
        const baseUrl = await mainUrl(run);

        // (a) a foreign iframe inside the POS page
        await run.page(`const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${foreign.origin}/iframe.html`)}; document.body.appendChild(frame); return 1;`);
        const report = await waitFor(() => foreign.reports.find((entry) => entry.kind === 'iframe') || null, 'the report of the foreign iframe', { timeoutMs: 15_000 }).catch(() => null);
        t.record('iframeReport', report);
        t.check('the foreign iframe has no window.electron and no window.desktop', report && report.ownElectron === 'undefined' && report.ownDesktop === 'undefined', report);
        t.check('a popup that the foreign iframe opens gets no window.electron and no window.desktop (or is refused)', report && (report.popup === 'null' || (report.popupElectron === 'undefined' && report.popupDesktop === 'undefined')), report);
        t.check('the iframe cannot read window.parent.electron (cross-origin)', report && /blocked/.test(report.parentElectron), report);

        // (b) the POS page's own sub-frame on the SAME origin
        const same = await run.page(`const frame = document.createElement('iframe'); frame.src = '/vendor/point-of-sale?harness=smoke'; document.body.appendChild(frame); await new Promise((resolve) => { frame.onload = resolve; setTimeout(resolve, 5000); }); return { electron: typeof frame.contentWindow.electron, desktop: typeof frame.contentWindow.desktop };`);
        t.check('a same-origin sub-frame has no window.electron either (the preload runs only in the top frame)', same.ok && same.value.electron === 'undefined' && same.value.desktop === 'undefined', same);

        // (c) hostile navigations of the main frame (about:blank is tried LAST and on its own: if it is not blocked it replaces the POS page)
        const before = await run.state();
        const hostile = ['javascript:window.__pwned=1', 'data:text/html,<h1>pwned</h1>', 'file:///etc/hosts', 'ftp://example.com/', 'chrome://gpu', `view-source:${server.origin}/`, 'blob:null/00000000-0000-0000-0000-000000000000'];
        const stays = [];
        for (const url of hostile) {
          await run.page(`window.__pos.helpers.navigate(${JSON.stringify(url)}); return 1;`).catch(() => {});
          await sleep(500);
          const now = await mainUrl(run);
          const markerNow = await run.page('return window.__pos && window.__pos.marker;', 5000).catch(() => ({}));
          stays.push({ url, now: String(now).slice(0, 60), same: now === baseUrl && markerNow.ok === true && markerNow.value === marker });
        }
        t.check('none of the 7 hostile navigations left the POS page (javascript:, data:, file:, ftp:, chrome:, view-source:, a foreign blob:)', stays.every((entry) => entry.same), stays.filter((entry) => !entry.same));
        const afterHostile = await run.state();
        t.check('and none was handed to the system browser (only https, mailto and tel may be)', afterHostile.openExternal.length === before.openExternal.length, afterHostile.openExternal.slice(before.openExternal.length));
        const mail = await run.page("window.__pos.helpers.navigate('mailto:help@example.com'); return 1;");
        await sleep(700);
        const tel = await run.page("window.__pos.helpers.navigate('tel:+441234567890'); return 1;");
        await sleep(700);
        const links = (await run.state()).openExternal.slice(afterHostile.openExternal.length).map((entry) => entry.url);
        t.record('mailtoTel', { links });
        t.note(`mailto: and tel: navigations reached openExternal as: ${JSON.stringify(links)}`);
        t.check('a mailto: and a tel: link go to the system browser (SPEC 12), the page stays', JSON.stringify(links) === JSON.stringify(['mailto:help@example.com', 'tel:+441234567890']) && (await mainUrl(run)) === baseUrl && mail.ok && tel.ok, links);

        // (d) window.open of hostile addresses. (A javascript: URL is not tried with alert(): Chromium opens about:blank and runs the script in the new
        // window, which shares the opener's renderer process, so an alert() box would block the POS page itself; that is the web platform, not the app.)
        const windowsBefore = (await run.cmd('windows')).length;
        const opened = [];
        for (const url of ['file:///etc/hosts', 'data:text/html,x', 'chrome://gpu', 'ftp://example.com/']) {
          const answer = await run.page(`return window.__pos.helpers.openWindow(${JSON.stringify(url)});`);
          opened.push({ url, isNull: answer.ok && answer.value.isNull });
        }
        await sleep(600);
        t.check('window.open of file:, data:, chrome: and ftp: gives the page null and creates no window', opened.every((entry) => entry.isNull) && (await run.cmd('windows')).length === windowsBefore, { opened, windows: (await run.cmd('windows')).length, windowsBefore });
        const js = await run.page("const w = window.open('javascript:void(0)'); const result = { opened: w !== null, origin: w ? w.origin : null, electron: w ? typeof w.electron : null }; if (w) w.close(); return result;");
        t.record('windowOpenJavascript', js);
        t.note(`window.open("javascript:void(0)") gives ${JSON.stringify(js.ok ? js.value : js)}: a same-origin about:blank window (the script runs there)`);
        await sleep(1500);
        t.check('that window is gone once the page closes it', (await run.cmd('windows')).length === windowsBefore, { windows: (await run.cmd('windows')).length, windowsBefore });

        // (e) a popup flood: 25 about:blank popups, written to and closed
        const rssBefore = run.rssKb();
        const flood = await run.page(`
          const popups = [];
          for (let i = 0; i < 25; i += 1) {
            const popup = window.open('about:blank', 'flood' + i);
            if (popup) { popup.document.write('<p>popup ' + i + '</p>'); popup.document.close(); popups.push(popup); }
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const alive = popups.length;
          const bridges = popups.filter((popup) => typeof popup.electron === 'object').length;
          popups.forEach((popup) => popup.close());
          return { alive, bridges };`, 30_000);
        t.check('25 popups opened and each had window.electron (about:blank of an allowed origin)', flood.ok && flood.value.alive === 25 && flood.value.bridges === 25, flood);
        await sleep(3000);
        const windowsAfter = (await run.cmd('windows')).length;
        t.check('after the page closes them all, the window count is back to what it was (no leaked windows)', windowsAfter === windowsBefore, { windowsBefore, windowsAfter });
        t.note(`resident memory: ${Math.round(rssBefore / 1024)} MB before the popup flood, ${Math.round(run.rssKb() / 1024)} MB after`);
        t.check('the POS page is untouched and the main process threw nothing', (await mainUrl(run)) === baseUrl && (await run.cmd('light')).uncaught.length === 0, { url: await mainUrl(run), uncaught: (await run.cmd('light')).uncaught });

        // (f) the page navigates its own main frame to about:blank: SPEC 12 lists about:blank only for window.open, so the guard should cancel it
        await run.page("window.__pos.helpers.navigate('about:blank'); return 1;").catch(() => {});
        await sleep(900);
        const blankUrl = await mainUrl(run);
        const blankShot = await run.shot('main-frame-about-blank');
        t.record('aboutBlankNavigation', { url: blankUrl, shot: blankShot.file });
        t.note(`after location.href = "about:blank" the main window shows: ${blankUrl}`);
        t.check('navigating the main frame to about:blank is blocked like any other non-allowed address (SPEC 12)', blankUrl === baseUrl, blankUrl);
        if (blankUrl !== baseUrl) {
          const bridge = await run.page("return { electron: typeof window.electron, origin: location.origin };", 5000).catch(() => ({}));
          t.note(`the about:blank document: ${JSON.stringify(bridge)}`);
          await run.cmd('reloadMain');
          await sleep(2500);
          const afterReload = await mainUrl(run);
          t.check('View > Reload gets the cashier out of a blank window (it must load the POS, not reload about:blank)', afterReload && afterReload.startsWith(server.origin), afterReload);
          if (!afterReload || !afterReload.startsWith(server.origin)) {
            await run.cmd('reloadMain', { force: true });
            await sleep(2000);
            t.note(`View > Force reload from about:blank: ${await mainUrl(run)}; only Retry now / Settings > Connection > Reload POS (loadPos) recovers it`);
            await run.cmd('retryNowMain');
            await waitForPos(run, server.origin, 20_000).catch(() => null);
          }
        }
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
        await foreign.stop();
      }
    });
  }

  // ---- E6 a hung page ----------------------------------------------------------------------------------------------------------------------
  for (const [id, label, answer] of [['E6a', 'Wait', 0], ['E6b', 'Reload', 1]]) {
    if (!wants(id)) continue;
    await scenario(id, `A hung POS page (32 s busy loop): Electron says "unresponsive", the cashier answers "${label}"`, async (t) => {
      const { server, run } = await startPos(`${id.toLowerCase()}-hang`);
      try {
        await run.cmd('dialogRules', { rules: [{ match: 'stopped responding', response: answer }] });
        const marker = (await run.page('return window.__pos.marker;')).value;
        await run.page('setTimeout(() => { const until = Date.now() + 32000; while (Date.now() < until); }, 50); return 1;');
        const began = Date.now();
        await sleep(600);
        let box = null;
        for (let i = 0; i < 40 && !box; i += 1) {
          await run.cmd('inputClick', { x: 200 + i, y: 200 }).catch(() => {});
          await sleep(1000);
          box = (await run.cmd('light')).dialogs.find((entry) => /stopped responding/.test(entry.message)) || null;
        }
        t.check('Electron reported the page as unresponsive and the app asked the cashier (a native box)', Boolean(box), (await run.cmd('light')).dialogs);
        if (box) {
          t.note(`the "page stopped responding" box appeared ${seconds(box.at - began)} after the hang began`);
          t.check('the box offers Wait and Reload', JSON.stringify(box.buttons) === JSON.stringify(['Wait', 'Reload']), box);
        }
        if (answer === 1) {
          const back = await waitFor(async () => {
            const info = await run.cmd('mainInfo').catch(() => null);
            if (!info || !info.url.startsWith(server.origin)) return null;
            const probe = await run.page('return window.__pos ? window.__pos.marker : null;', 5000).catch(() => null);
            return probe && probe.ok && probe.value && probe.value !== marker ? probe.value : null;
          }, 'the POS to be reloaded into a fresh page', { timeoutMs: 30_000, intervalMs: 400 }).catch(() => null);
          t.check('"Reload" ends the hung page and loads the POS again (new page, new marker)', Boolean(back), await run.cmd('mainInfo'));
          t.check('it did not leave the offline screen behind', !isOfflineUrl(await mainUrl(run)), await mainUrl(run));
        } else {
          const alive = await waitFor(async () => {
            const probe = await run.page('return window.__pos ? window.__pos.marker : null;', 5000).catch(() => null);
            return probe && probe.ok ? probe.value : null;
          }, 'the page to answer again after the loop ended', { timeoutMs: 40_000, intervalMs: 500 }).catch(() => null);
          t.check('"Wait" leaves the page alone: it answers again when the loop ends, the same page (marker unchanged)', alive === marker, alive);
          t.check('and the question was asked only once (no repeated boxes)', (await run.cmd('light')).dialogs.filter((entry) => /stopped responding/.test(entry.message)).length === 1, (await run.cmd('light')).dialogs.length);
        }
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await run.stop({ timeoutMs: 20_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E7 a reload storm --------------------------------------------------------------------------------------------------------------------
  if (wants('E7')) {
    await scenario('E7', 'A reload storm: 30 reloads (every third forced) and 10 loads at once, then the POS must be there and no offline screen may have flashed', async (t) => {
      const { server, run } = await startPos('e7-storm');
      try {
        const logFile = path.join(run.userData, 'logs', 'main.log');
        const offlineBefore = ((fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').match(/showing the offline screen/g) || []).length;
        let sawOffline = false;
        let polling = true;
        const poll = (async () => {
          while (polling) {
            if (isOfflineUrl(await mainUrl(run))) sawOffline = true;
            await sleep(60);
          }
        })();
        const calls = [];
        for (let i = 0; i < 30; i += 1) calls.push(run.cmd('reloadMain', { force: i % 3 === 0 }).catch((error) => error.message));
        for (let i = 0; i < 10; i += 1) calls.push(run.cmd('loadPos').catch((error) => error.message));
        await Promise.all(calls);
        const back = await waitForPos(run, server.origin, 25_000).catch(() => null);
        await sleep(1500);
        polling = false;
        await poll;
        t.check('after the storm the POS page is loaded', Boolean(back), await mainUrl(run));
        t.check('the offline screen never showed during the storm (an aborted load is not a failed load)', !sawOffline, 'the offline screen appeared');
        const offlineAfter = ((fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').match(/showing the offline screen/g) || []).length;
        t.check('and the log has no "showing the offline screen" line from it', offlineAfter === offlineBefore, { offlineBefore, offlineAfter });
        const electron = await run.page('return typeof window.electron;');
        t.check('window.electron works after the storm', electron.ok && electron.value === 'object', electron);
        t.note(`the server saw ${server.hits('/vendor/point-of-sale', 'GET')} page requests`);
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

  // ---- E8 quitting ----------------------------------------------------------------------------------------------------------------------------
  if (wants('E8')) {
    await scenario('E8', 'Quitting with Settings and a password prompt open, and quitting while the offline screen is probing', async (t) => {
      const { server, run } = await startPos('e8-quit-a');
      try {
        await protectSettings(run);
        await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
        await waitFor(async () => (await windowsOf(run, isPassword)).length === 1, 'the prompt', { timeoutMs: 15_000 });
        await run.cmd('desktopApi', { name: 'password.submit', args: [PASSWORD] });
        await waitFor(async () => (await windowsOf(run, isSettings)).length === 1, 'Settings', { timeoutMs: 15_000 });
        await run.cmd('promptShow', { purpose: 'drawer' });
        await waitFor(async () => (await windowsOf(run, isPassword)).length === 1, 'the drawer prompt', { timeoutMs: 15_000 });
        const stopped = await run.stop({ timeoutMs: 20_000 });
        t.check('quitting with Settings and a prompt open ends the app by itself, quickly', !stopped.forced && stopped.ms < 8000, stopped);
        t.check('with exit code 0', stopped.exit && stopped.exit.code === 0, stopped.exit);
        t.note(`quit with two windows open took ${seconds(stopped.ms)}`);
      } finally {
        await run.stop({ timeoutMs: 5000 }).catch(() => {});
        await server.stop();
      }

      const down = await createBreakServer();
      await down.stop();
      const offline = new AppRun({ name: 'e8-quit-b', startUrl: down.smokeUrl });
      try {
        await offline.start();
        await waitFor(async () => isOfflineUrl(await mainUrl(offline)), 'the offline screen', { timeoutMs: 20_000 });
        await sleep(4000);
        const stopped = await offline.stop({ timeoutMs: 20_000 });
        t.check('quitting from the offline screen while probes run is quick and clean', !stopped.forced && stopped.ms < 8000 && stopped.exit && stopped.exit.code === 0, stopped);
        t.note(`quit from the offline screen took ${seconds(stopped.ms)}`);
      } finally {
        await offline.stop({ timeoutMs: 5000 }).catch(() => {});
      }
    });
  }

  // ---- E9 crash screens ------------------------------------------------------------------------------------------------------------------------
  if (wants('E9')) {
    await scenario('E9', 'Crash screens: one crash recovers by itself; a crash loop stops the reload and the screen must not claim "Back online"', async (t) => {
      const { server, run } = await startPos('e9-crash');
      try {
        await run.cmd('crashMain');
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the crash screen', { timeoutMs: 15_000 });
        await sleep(1200);
        const first = await readOffline(run);
        const shot1 = await run.shot('crash-first');
        t.record('firstCrash', first);
        t.note(`first crash screen: "${first.headline}" ${first.url.split('?')[1]}`);
        t.check('the first crash shows a screen that paints', shot1.ok && shot1.distinctColors > 6, shot1);
        await waitForPos(run, server.origin, 30_000);
        t.check('and the POS comes back by itself', true);

        await run.cmd('crashMain');
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the second crash screen', { timeoutMs: 15_000 });
        await waitForPos(run, server.origin, 30_000);
        await run.cmd('crashMain');
        await waitFor(async () => isOfflineUrl(await mainUrl(run)), 'the third crash screen', { timeoutMs: 15_000 });
        await sleep(5000);
        t.check('after the third crash within a minute the POS is NOT reloaded again (the loop stops)', isOfflineUrl(await mainUrl(run)), await mainUrl(run));
        const loop = await readOffline(run);
        const chip = await run.page("const title = document.getElementById('connect-title'); const sub = document.getElementById('connect-sub'); return { title: title && title.textContent, sub: sub && sub.textContent, state: document.getElementById('connect') && document.getElementById('connect').dataset.state };");
        t.record('loopScreen', { loop, chip });
        const shot2 = await run.shot('crash-loop');
        t.check('the loop screen paints', shot2.ok && shot2.distinctColors > 6, shot2);
        t.note(`crash loop screen: headline "${loop.headline}", status chip ${JSON.stringify(chip.value)}`);
        t.check('the status chip does NOT say "Back online - reloading..." (nothing is reloading)', chip.ok && !/Back online/.test(chip.value.title || ''), chip);
        await run.cmd('reloadMain');
        const back = await waitForPos(run, server.origin, 30_000).catch(() => null);
        t.check('View > Reload recovers from the loop', Boolean(back), await mainUrl(run));
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
      }
    });
  }

}

module.exports = { runWindowsGroup };
