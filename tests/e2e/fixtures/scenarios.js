'use strict';
/*
 * Behaviour scenarios for tests/e2e/ui-shots.js. Each one opens a page with a fixture, drives it with real mouse and key events
 * through the Page driver (clicks, Tab, arrows, Enter, Escape), then asserts on the DOM and on the calls the page made to the
 * mock window.desktop (recorded by tests/e2e/stub-desktop-preload.js).
 *
 *   scenario = { name, page, fixture, size?, hash?, query?, themes?, run: async (p, t) => void }
 *   p = Page driver (click, clickText, fill, type, press, text, attr, calls, eval, emit, wait ...)
 *   t = checker (ok, equal, includes, shot)
 */
const { focusProbe } = require('./audit');
const { axNode, axOutline } = require('./ax');
const d = require('./data');

const q = (selector) => JSON.stringify(selector);
const visible = (p, selector) =>
  p.eval(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })()`);
const isHidden = (p, selector) => p.eval(`(() => { const el = document.querySelector(${q(selector)}); return !el || el.hidden || el.closest('[hidden]') !== null; })()`);
const valueOf = (p, selector) => p.eval(`document.querySelector(${q(selector)}).value`);
const countOf = (p, selector) => p.count(selector);
const lastCall = async (p, name) => {
  const calls = await p.calls(name);
  return calls[calls.length - 1];
};

/** A field error must reach a screen reader even when focus does not move: its slot is an assertive, atomic live region (WCAG 4.1.3). */
async function expectAlert(p, t, selector, what) {
  const node = await axNode(p, selector);
  t.ok(node && node.role === 'alert' && node.live === 'assertive' && node.atomic, `${what} is announced to screen readers (an alert live region), found ${JSON.stringify(node && { role: node.role, live: node.live, atomic: node.atomic })}`);
}

/** Dispatches a cancelable beforeunload event at the page and says whether the page asked to stay (it prevented the default). */
const asksToStay = (p) =>
  p.eval(`(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);

const RECEIPT = '[data-role="receipt"]';
const LABEL = '[data-role="label"]';
const DYMO = '[data-role="dymo"]';
const SAVE = '.role__buttons .btn--primary';
const TEST = '.role__buttons .btn:not(.btn--primary)';
const NOTE = '.role__foot-note';

const SCENARIOS = [];
const add = (scenario) => SCENARIOS.push(scenario);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settings: tabs                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'settings-tabs-keyboard',
  page: 'settings',
  fixture: 'default',
  hash: 'printers',
  async run(p, t) {
    t.equal(await p.attr('#tab-printers', 'aria-selected'), 'true', 'Printers tab is selected first');
    t.equal(await countOf(p, '[role="tab"][tabindex="0"]'), 1, 'roving tabindex: exactly one tab stop');
    await p.focus('#tab-printers');
    await p.press('ArrowDown');
    t.equal(await p.attr('#tab-drawer', 'aria-selected'), 'true', 'ArrowDown selects the next tab');
    t.equal(await p.activeElement(), 'tab-drawer', 'ArrowDown moves focus with the selection');
    t.equal(await isHidden(p, '#panel-drawer'), false, 'the selected tab shows its panel');
    t.equal(await isHidden(p, '#panel-printers'), true, 'the other panels are hidden');
    t.equal(await p.eval('location.hash'), '#drawer', 'the hash follows the tab');
    await p.press('End');
    t.equal(await p.attr('#tab-about', 'aria-selected'), 'true', 'End goes to the last tab');
    await p.press('ArrowDown');
    t.equal(await p.attr('#tab-printers', 'aria-selected'), 'true', 'ArrowDown wraps to the first tab');
    await p.press('ArrowUp');
    t.equal(await p.attr('#tab-about', 'aria-selected'), 'true', 'ArrowUp wraps to the last tab');
    await p.press('Home');
    t.equal(await p.attr('#tab-printers', 'aria-selected'), 'true', 'Home goes to the first tab');
    t.equal(await p.attr('#tab-printers', 'aria-controls'), 'panel-printers', 'tab is wired to its panel');
    t.equal(await p.attr('#panel-printers', 'aria-labelledby'), 'tab-printers', 'panel is labelled by its tab');
    await p.press('Tab');
    t.ok(await p.eval("!!document.activeElement.closest('#panel-printers')"), 'Tab from the tab list enters the selected panel');
    await p.click('#tab-general');
    t.equal(await p.attr('#tab-general', 'aria-selected'), 'true', 'a click selects a tab');
  },
});

add({
  name: 'settings-deeplink',
  page: 'settings',
  fixture: 'default',
  hash: 'about',
  async run(p, t) {
    t.equal(await p.attr('#tab-about', 'aria-selected'), 'true', '#about opens the About tab');
    await p.eval("location.hash = '#connection'");
    await p.settle(100);
    t.equal(await p.attr('#tab-connection', 'aria-selected'), 'true', 'a hash change from the main process switches the tab');
    t.equal(await isHidden(p, '#panel-about'), true, 'the previous panel is hidden after a hash change');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settings: printers                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'settings-printers-flow',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    t.equal(await valueOf(p, `${RECEIPT} .picker__row input:checked`), 'EPSON TM-T20III Receipt', 'saved receipt printer is selected');
    t.equal(await p.attr(`${RECEIPT} ${SAVE}`, 'aria-disabled'), 'true', 'Save is inactive while nothing changed');
    t.equal(await isHidden(p, '#tab-printers .nav__dot'), true, 'no unsaved dot on a clean tab');
    t.ok((await countOf(p, `${RECEIPT} .picker__row`)) === 10, 'ten printers are listed');
    t.ok(await p.eval("!!document.querySelector('[data-role=\"receipt\"] .badge--default')"), 'the default printer carries a Default badge');

    await p.clickText(`${RECEIPT} .picker__row`, 'Star TSP143III');
    t.includes(await p.text(`${RECEIPT} ${NOTE}`), 'Unsaved changes', 'choosing another printer shows Unsaved changes');
    t.equal(await isHidden(p, '#tab-printers .nav__dot'), false, 'the tab shows an unsaved dot');
    t.equal(await p.attr(`${RECEIPT} ${SAVE}`, 'aria-disabled'), 'false', 'Save becomes active');

    await p.click(`${RECEIPT} ${SAVE}`);
    const save = await lastCall(p, 'settings.savePrinter');
    t.equal(save && save.args, ['receipt', { transport: 'system', printerName: 'Star TSP143III (STR_T-001)', port: '' }], 'Save sends the receipt settings');
    t.equal(await p.text(`${RECEIPT} ${NOTE}`), 'Saved', 'Save shows a Saved indicator');
    t.equal(await isHidden(p, '#tab-printers .nav__dot'), true, 'the unsaved dot disappears after saving');
    t.equal(await p.attr(`${RECEIPT} ${SAVE}`, 'aria-disabled'), 'true', 'Save is inactive again');

    await p.click(`${RECEIPT} ${TEST}`);
    const test = await lastCall(p, 'settings.testPrint');
    t.equal(test && test.args, ['receipt', {}], 'Test asks for a receipt test print');
    t.includes(await p.text(`${RECEIPT} ${NOTE}`), 'Test receipt sent to Star TSP143III (STR_T-001).', 'Test shows an inline success message');

    // Test with unsaved changes saves first, then prints
    await p.clickText(`${RECEIPT} .picker__row`, 'ZDesigner');
    await p.click(`${RECEIPT} ${TEST}`);
    const order = (await p.calls('settings.')).map((c) => c.name).filter((n) => /savePrinter|testPrint/.test(n));
    t.equal(order.slice(-2), ['settings.savePrinter', 'settings.testPrint'], 'Test with unsaved changes saves first, then prints');
    t.includes(await p.text(`${RECEIPT} ${NOTE}`), 'Saved. Test receipt sent to ZDesigner', 'the message says the choice was saved first');

    // Label roles
    await p.click(`${LABEL} ${TEST}`);
    const zebra = await lastCall(p, 'settings.testPrint');
    t.equal(zebra && zebra.args, ['label', { kind: 'zebra' }], 'the raw label test passes kind zebra');
    await p.clickText(`${DYMO} .picker__row`, 'LabelWriter 450 Turbo');
    await p.click(`${DYMO} ${SAVE}`);
    const dymo = await lastCall(p, 'settings.savePrinter');
    t.equal(dymo && dymo.args, ['dymo', { printerName: 'DYMO LabelWriter 450 Turbo' }], 'DYMO Save sends only the printer name');
    t.ok(await p.eval("!!document.querySelector('[data-role=\"dymo\"] .badge--success')"), 'a connected DYMO printer has a Connected badge');
    await p.click(`${DYMO} ${TEST}`);
    t.includes(await p.text(`${DYMO} ${NOTE}`), 'Test label sent to DYMO LabelWriter 450 Turbo.', 'DYMO test shows its result');
  },
});

add({
  name: 'settings-printers-port',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    t.equal(await isHidden(p, `${LABEL} .field input#label-port`), true, 'the port field is hidden for an installed printer');
    await p.clickText(`${LABEL} .choice`, 'Advanced');
    t.equal(await isHidden(p, `${LABEL} .picker`), true, 'choosing Advanced hides the printer list');
    t.equal(await visible(p, '#label-port'), true, 'and shows the port field');
    await p.click(`${LABEL} ${SAVE}`);
    t.includes(await p.text('#label-port-err'), 'Enter a port', 'an empty port is refused on the spot');
    t.equal((await p.calls('settings.savePrinter')).length, 0, 'nothing is sent for an empty port');
    await p.fill('#label-port', 'USB001');
    t.equal(await p.attr('#label-port', 'aria-invalid'), null, 'typing clears the error state');
    await p.click(`${LABEL} ${SAVE}`);
    t.includes(await p.text('#label-port-err'), 'This port name cannot be used.', 'the main process message is shown under the field');
    await expectAlert(p, t, '#label-port-err', 'the port error');
    t.equal(await p.attr('#label-port', 'aria-invalid'), 'true', 'the field is marked invalid');
    t.includes(await p.attr('#label-port', 'aria-describedby'), 'label-port-err', 'the error is linked to the field');
    await p.fill('#label-port', 'LPT1');
    await p.focus('#label-port');
    await p.press('Enter');
    const save = await lastCall(p, 'settings.savePrinter');
    t.equal(save && save.args, ['label', { transport: 'port', printerName: 'ZDesigner ZD420-203dpi ZPL', port: 'LPT1' }], 'Enter in the port field saves');
    t.equal(await p.text(`${LABEL} ${NOTE}`), 'Saved', 'the valid port is saved');
  },
});

add({
  name: 'settings-printers-search',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    const search = `${RECEIPT} .picker input[type="search"]`;
    t.equal(await visible(p, search), true, 'more than eight printers show a search box');
    await p.fill(search, 'zd');
    t.equal(await countOf(p, `${RECEIPT} .picker__row`), 1, 'searching narrows the list');
    await p.fill(search, 'laser x');
    t.includes(await p.text(`${RECEIPT} .picker__empty-title`), 'No printers match "laser x"', 'no match shows an empty state');
    await p.fill(search, '');
    t.equal(await countOf(p, `${RECEIPT} .picker__row`), 10, 'clearing the search restores the list');
    const before = (await p.calls('settings.listPrinters')).length;
    await p.click(`${RECEIPT} .picker__head .btn`);
    t.equal((await p.calls('settings.listPrinters')).length, before + 1, 'Refresh asks for the printers again');
  },
});

add({
  name: 'settings-printers-search-hidden',
  page: 'settings',
  fixture: 'printers-empty',
  hash: 'printers',
  async run(p, t) {
    t.equal(await isHidden(p, `${RECEIPT} .input-group--lead`), true, 'four printers need no search box');
    t.equal(await countOf(p, `${RECEIPT} .picker__row input:checked`), 0, 'an empty config selects nothing');
    t.equal(await p.attr(`${RECEIPT} ${SAVE}`, 'aria-disabled'), 'true', 'Save is inactive until a printer is chosen');
    await p.click(`${RECEIPT} ${TEST}`);
    t.includes(await p.text(`${RECEIPT} ${NOTE}`), 'Choose a printer first.', 'Test without a printer says what to do');
    t.equal((await p.calls('settings.testPrint')).length, 0, 'and sends nothing');
    t.equal(await isHidden(p, `${DYMO} .banner`), false, 'DYMO Connect not running shows a hint');
    t.includes(await p.text(`${DYMO} .banner__title`), 'DYMO Connect is not running', 'the hint names the problem');
    t.equal(await countOf(p, `${DYMO} .picker__row`), 1, 'only the Automatic choice is left without DYMO printers');
    t.equal(await valueOf(p, `${DYMO} .picker__row input:checked`), '', 'Automatic is the default DYMO choice');
  },
});

add({
  name: 'settings-printers-states',
  page: 'settings',
  fixture: 'printers-none',
  hash: 'printers',
  async run(p, t) {
    t.includes(await p.text(`${RECEIPT} .picker__empty-title`), 'No printers found', 'no printers shows an empty state');
    t.includes(await p.text(`${RECEIPT} .picker__empty`), 'press Refresh', 'and tells what to do');
  },
});

add({
  name: 'settings-printers-error',
  page: 'settings',
  fixture: 'printers-error',
  hash: 'printers',
  async run(p, t) {
    t.includes(await p.text(`${RECEIPT} .picker__empty-title`), "Couldn't read the printer list", 'a failing printer list shows an error state');
  },
});

add({
  name: 'settings-printers-missing',
  page: 'settings',
  fixture: 'printers-missing',
  hash: 'printers',
  async run(p, t) {
    t.includes(await p.text(`${RECEIPT} .picker__row`), 'EPSON TM-T20III Receipt', 'a saved printer that is no longer installed stays visible');
    t.includes(await p.text(`${RECEIPT} .badge--warning`), 'Not found', 'with a Not found badge');
    t.equal(await valueOf(p, `${RECEIPT} .picker__row input:checked`), 'EPSON TM-T20III Receipt', 'and stays selected');
  },
});

add({
  name: 'settings-printers-mac',
  page: 'settings',
  fixture: 'printers-mac',
  hash: 'printers',
  async run(p, t) {
    t.equal(await p.eval(`document.querySelector('[data-role="receipt"] input[value="port"]').disabled`), true, 'port printing is offered on Windows only');
    t.includes(await p.text(`${RECEIPT} .choice:last-child`), 'Available on Windows only.', 'and says so');
  },
});

/* Wheel scrolling must chain from a printer list that has reached its end to the page; a list that traps the wheel feels stuck. */
add({
  name: 'settings-printers-wheel-chains',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    const list = `${RECEIPT} .picker__list`;
    t.ok(await p.eval(`(() => { const el = document.querySelector(${q(list)}); return el.scrollHeight > el.clientHeight; })()`), 'the receipt list is a scroll box (ten printers)');
    const at = await p.eval(`(() => {
      const el = document.querySelector(${q(list)});
      el.scrollTop = el.scrollHeight;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, viewport: innerHeight };
    })()`);
    t.ok(at.y > 0 && at.y < at.viewport, `the middle of the list is on the first screen (y ${Math.round(at.y)} of ${at.viewport})`);
    const before = await p.eval("document.getElementById('content').scrollTop");
    for (let i = 0; i < 10; i += 1) await p.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 100 });
    await p.wait(500);
    const after = await p.eval("document.getElementById('content').scrollTop");
    t.ok(after > before, `wheeling over a list that is already at its end scrolls the page (${before} -> ${after})`);
  },
});

/*
 * A saved printer far down a long list used to be out of sight (the list opened at its top), so a manager could not see what is
 * configured. The list scrolls itself, never the page, to the checked row: when the tab opens, after Refresh, after a search is
 * cleared, and when the tab was hidden while the lists were built.
 */
const selectedRowInView = (p, scope) =>
  p.eval(`(() => {
    const list = document.querySelector(${q(`${scope} .picker__list`)});
    const row = list && list.querySelector('.picker__row:has(:checked)');
    if (!row) return null;
    const a = list.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    return { above: Math.round(b.top - a.top), below: Math.round(a.bottom - b.bottom), scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight, name: row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 48) };
  })()`);

const SAVED_CHOICES = [
  [RECEIPT, 'Shop Printer 25'],
  [LABEL, 'Shop Printer 28'],
  [DYMO, 'DYMO LabelWriter 450 Unit 10'],
];

async function expectSavedChoicesInView(p, t, when) {
  for (const [scope, name] of SAVED_CHOICES) {
    const row = await selectedRowInView(p, scope);
    t.ok(row && row.above >= 0 && row.below >= 0, `${when}: the saved choice in ${scope} is inside its list (${JSON.stringify(row)})`);
    t.includes(row && row.name, name, `${when}: and it is the saved one`);
  }
  t.equal(await p.eval("document.getElementById('content').scrollTop"), 0, `${when}: finding it does not scroll the page`);
}

add({
  name: 'settings-printers-reveals-saved',
  page: 'settings',
  fixture: 'printers-many',
  hash: 'printers',
  async run(p, t) {
    const first = await selectedRowInView(p, RECEIPT);
    t.ok(first && first.scrollHeight > 1000, `the receipt list is long (${first && first.scrollHeight} px of rows)`);
    await expectSavedChoicesInView(p, t, 'on open');

    await p.click(`${RECEIPT} .picker__head .btn`);
    await expectSavedChoicesInView(p, t, 'after Refresh');

    const search = `${RECEIPT} .picker input[type="search"]`;
    await p.fill(search, 'printer 3');
    t.ok((await countOf(p, `${RECEIPT} .picker__row`)) < 30, 'searching narrows the list');
    await p.fill(search, '');
    const cleared = await selectedRowInView(p, RECEIPT);
    t.ok(cleared && cleared.above >= 0 && cleared.below >= 0, `clearing the search shows the saved choice again (${JSON.stringify(cleared)})`);

    // A list the person has scrolled is not moved back by a window resize.
    await p.eval(`document.querySelector(${q(`${RECEIPT} .picker__list`)}).scrollTop = 0`);
    p.win.setContentSize(1120, 780);
    await p.settle(150);
    t.equal(await p.eval(`document.querySelector(${q(`${RECEIPT} .picker__list`)}).scrollTop`), 0, 'a resize does not scroll a list the person moved');
  },
});

add({
  name: 'settings-printers-reveals-saved-hidden-tab',
  page: 'settings',
  fixture: 'printers-many',
  hash: 'drawer',
  async run(p, t) {
    await p.click('#tab-printers');
    await expectSavedChoicesInView(p, t, 'after the tab is shown');
  },
});

/*
 * Controls that look alike must not sound alike: within one tab no two buttons, lists, search boxes, fields or switches share an
 * accessible name (the Printers tab repeated Save three times, the test-label button twice and the installed-printers list twice).
 * Names come from Chromium's accessibility tree, as a screen reader or a voice-control program gets them.
 */
async function expectUniqueNames(p, t, panel) {
  const outline = await axOutline(p, panel);
  for (const role of ['button', 'radiogroup', 'searchbox', 'textbox', 'switch']) {
    const names = outline.filter((node) => node.role === role).map((node) => node.name);
    const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
    t.equal(repeated, [], `${panel}: no two ${role}s share an accessible name`);
  }
  return outline;
}

add({
  name: 'settings-printers-names',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    const outline = await expectUniqueNames(p, t, '#panel-printers');
    const buttons = outline.filter((node) => node.role === 'button').map((node) => node.name);
    for (const name of ['Save receipt printer', 'Save Zebra printer', 'Save DYMO printer', 'Print test receipt', 'Print test label on the Zebra printer', 'Print test label on the DYMO printer']) {
      t.ok(buttons.includes(name), `a button is named "${name}" (found ${JSON.stringify(buttons)})`);
    }
    t.equal(
      outline.filter((node) => node.role === 'group' && /printer$/.test(node.name)).map((node) => node.name),
      ['receipt printer', 'Zebra printer', 'DYMO printer'],
      'each printer section is a labelled group',
    );
  },
});

for (const [tab, fixture] of [
  ['drawer', 'drawer-set'],
  ['connection', 'connection-default'],
  ['general', 'general-default'],
  ['about', 'about-none'],
]) {
  add({
    name: `settings-unique-names-${tab}`,
    page: 'settings',
    fixture,
    hash: tab,
    async run(p, t) {
      await expectUniqueNames(p, t, `#panel-${tab}`);
    },
  });
}

/* Unsaved edits: the page asks to stay while any tab is dirty; the main process answers that request (will-prevent-unload) with the question. */
add({
  name: 'settings-unsaved-guard',
  page: 'settings',
  fixture: 'printers-populated',
  hash: 'printers',
  async run(p, t) {
    t.equal(await asksToStay(p), false, 'a clean Settings page lets its window close without a question');
    await p.clickText(`${RECEIPT} .picker__row`, 'Star TSP143III');
    t.equal(await asksToStay(p), true, 'an unsaved printer choice makes the page ask before it is left');
    await p.click('#tab-drawer');
    t.equal(await asksToStay(p), true, 'it keeps asking while another tab is shown');
    await p.click('#tab-printers');
    await p.clickText(`${RECEIPT} .picker__row`, 'EPSON TM-T20III Receipt');
    t.equal(await asksToStay(p), false, 'choosing the saved printer again clears it');

    await p.clickText(`${RECEIPT} .picker__row`, 'Star TSP143III');
    await p.click('#tab-connection');
    await p.fill('#conn-url', 'https://pos.mygadgetshop.co.uk/point-of-sale');
    await p.click('#tab-printers');
    await p.click(`${RECEIPT} ${SAVE}`);
    t.equal(await isHidden(p, '#tab-printers .nav__dot'), true, 'saving clears the Printers tab');
    t.equal(await asksToStay(p), true, 'but the unsaved Connection tab still asks');
    await p.click('#tab-connection');
    await p.click('#conn-save');
    t.equal(await isHidden(p, '#tab-connection .nav__dot'), true, 'saving the Connection tab clears it too');
    t.equal(await asksToStay(p), false, 'when nothing is unsaved the window closes without a question');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settings: cash drawer                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'settings-drawer-flow',
  page: 'settings',
  fixture: 'drawer-set',
  hash: 'drawer',
  async run(p, t) {
    t.includes(await p.text('#pw-badge'), 'Password set', 'password status shows Password set');
    t.includes(await p.text('#pw-open-label'), 'Change password', 'the button says Change password');
    t.equal(await isHidden(p, '#pw-weak'), true, 'no weak-password notice for a good password');
    t.equal(await isHidden(p, '#tab-drawer .nav__dot'), true, 'a fresh drawer tab is not dirty');

    // dialog: Escape closes and returns focus
    await p.click('#pw-open');
    t.ok(await p.has('dialog[open]'), 'the password dialog opens');
    t.equal(await p.activeElement(), 'dlg-current', 'focus lands on the first field');
    await p.press('Escape');
    t.ok(!(await p.has('dialog[open]')), 'Escape closes the dialog');
    t.equal(await p.activeElement(), 'pw-open', 'focus returns to the button that opened it');

    // dialog: validation, wrong current password, success
    await p.click('#pw-open');
    await p.click('.dialog .btn--primary');
    t.equal(await p.attr('#dlg-current', 'aria-invalid'), 'true', 'an empty current password is flagged');
    t.equal(await p.attr('#dlg-new', 'aria-invalid'), 'true', 'a too short new password is flagged');
    t.equal((await p.calls('settings.setDrawerPassword')).length, 0, 'nothing is sent while the form is invalid');
    await p.fill('#dlg-current', 'nope');
    await p.fill('#dlg-new', 'abcd1234');
    await p.fill('#dlg-confirm', 'abcd');
    t.includes(await p.text('.meter + p'), 'Strength: Okay', 'a strength hint appears');
    await p.click('.dialog .btn--primary');
    t.includes(await p.text('#dlg-confirm-err'), 'The two new passwords are not the same.', 'a mismatch is flagged');
    await p.fill('#dlg-confirm', 'abcd1234');
    await p.click('.dialog .btn--primary');
    t.includes(await p.text('#dlg-current-err'), 'That password is not correct.', 'a wrong current password shows the main process message');
    await expectAlert(p, t, '#dlg-current-err', 'the wrong current password');
    t.ok(await p.has('dialog[open]'), 'the dialog stays open after a wrong password');
    await p.fill('#dlg-current', '1234');
    await p.click('#dlg-reveal');
    t.equal(await p.attr('#dlg-new', 'type'), 'text', 'Show passwords reveals the fields');
    await p.click('.dialog .btn--primary');
    t.ok(!(await p.has('dialog[open]')), 'the dialog closes after success');
    t.includes(await p.text('#toasts'), 'Drawer password changed.', 'a toast confirms it');
    t.equal(await p.activeElement(), 'pw-open', 'focus returns to the opener');

    // settings form
    await p.clickText('#drawer-form .choice', 'Pin 5');
    await p.fill('#drawer-on', '80');
    t.includes(await p.text('#drawer-status'), 'Unsaved changes', 'editing shows Unsaved changes');
    t.equal(await isHidden(p, '#tab-drawer .nav__dot'), false, 'and an unsaved dot on the tab');
    await p.click('#drawer-save');
    t.includes(await p.text('#drawer-pw-err'), 'Enter the drawer password to save.', 'saving needs the password');
    await p.fill('#drawer-on', '900');
    await p.click('#drawer-save');
    t.includes(await p.text('#drawer-on-err'), 'Enter a whole number from 2 to 510.', 'a pulse outside 2..510 is flagged');
    await expectAlert(p, t, '#drawer-on-err', 'the pulse length message');
    t.equal((await p.calls('settings.saveDrawerSettings')).length, 0, 'nothing is sent for an invalid form');
    await p.fill('#drawer-on', '80');
    await p.fill('#drawer-pw', 'wrong');
    await p.click('#drawer-save');
    t.includes(await p.text('#drawer-pw-err'), 'That password is not correct.', 'a wrong password shows under the password field');
    await expectAlert(p, t, '#drawer-pw-err', 'the wrong drawer password');
    await p.fill('#drawer-pw', 'abcd1234');
    await p.click('#drawer-save');
    const save = await lastCall(p, 'settings.saveDrawerSettings');
    t.equal(save && save.args[0], { enabled: true, pin: 5, onTimeMs: 80, offTimeMs: 510, requirePasswordForSettings: false, password: 'abcd1234' }, 'Save sends the drawer settings with the password');
    t.equal(await p.text('#drawer-status'), 'Saved', 'and shows Saved');

    // test card
    await p.fill('#drawer-test-pw', 'abcd1234');
    await p.click('#drawer-test');
    t.includes(await p.text('#drawer-test-status'), 'Open command sent.', 'Open drawer (test) reports success');
  },
});

add({
  name: 'settings-drawer-nopassword',
  page: 'settings',
  fixture: 'drawer-none',
  hash: 'drawer',
  async run(p, t) {
    t.includes(await p.text('#pw-badge'), 'No password', 'no password is shown as a warning');
    t.includes(await p.text('#pw-open-label'), 'Set password', 'the button says Set password');
    t.equal(await isHidden(p, '#drawer-pw-field'), true, 'no password field is needed to save');
    t.includes(await p.text('#drawer-test-status'), 'Set a password first', 'the test card explains what to do first');
    await p.click('#pw-open');
    t.equal(await p.text('.dialog__title'), 'Set drawer password', 'the dialog says Set drawer password');
    t.equal(await p.count('.dialog input[type="password"]'), 2, 'without a current password the dialog has two fields');
    await p.fill('#dlg-new', 'shop2026');
    await p.fill('#dlg-confirm', 'shop2026');
    await p.click('.dialog .btn--primary');
    const call = await lastCall(p, 'settings.setDrawerPassword');
    t.equal(call && call.args[0], { current: '', next: 'shop2026' }, 'setting the first password sends no current password');
    t.includes(await p.text('#pw-badge'), 'Password set', 'the status updates once the state arrives');
  },
});

add({
  name: 'settings-drawer-weak',
  page: 'settings',
  fixture: 'drawer-weak',
  hash: 'drawer',
  async run(p, t) {
    t.equal(await isHidden(p, '#pw-weak'), false, 'a migrated weak password shows the notice');
    t.includes(await p.text('#pw-weak'), 'Your password does not meet the new length rule (4 to 64 characters). Change it when convenient.', 'with the exact wording of SPEC 5.2');
  },
});

add({
  name: 'settings-drawer-lockout-short',
  page: 'settings',
  fixture: 'drawer-lockout-short',
  hash: 'drawer',
  async run(p, t) {
    for (const wrong of ['x', 'y', 'z']) {
      await p.fill('#drawer-test-pw', wrong);
      await p.click('#drawer-test');
    }
    t.equal(await isHidden(p, '#lock-banner'), false, 'three wrong passwords show the lockout banner');
    const first = await p.text('#lock-time');
    t.ok(/^0:0[1-4]$/.test(first), `the banner shows a countdown (${first})`);
    const attempts = (await p.calls('settings.openDrawerTest')).length;
    await p.fill('#drawer-test-pw', '1234');
    await p.click('#drawer-test');
    t.equal((await p.calls('settings.openDrawerTest')).length, attempts, 'no password check is sent during the lockout');
    t.includes(await p.text('#drawer-test-status'), 'paused', 'the test card says checks are paused');
    await p.click('#pw-open');
    t.equal(await p.attr('.dialog .btn--primary', 'aria-disabled'), 'true', 'the password dialog is paused too');
    t.equal(await isHidden(p, '.dialog .banner--warning'), false, 'and shows the countdown');
    await p.press('Escape');
    await p.wait(2000);
    const later = await p.text('#lock-time');
    t.ok(later !== first, `the countdown moves (${first} -> ${later})`);
    await p.wait(2600);
    t.equal(await isHidden(p, '#lock-banner'), true, 'the banner goes away when the lockout ends');
    await p.fill('#drawer-test-pw', '1234');
    await p.click('#drawer-test');
    t.includes(await p.text('#drawer-test-status'), 'Open command sent.', 'checks work again after the lockout');
  },
});

add({
  name: 'settings-drawer-forgot',
  page: 'settings',
  fixture: 'drawer-set',
  hash: 'drawer',
  async run(p, t) {
    await p.click('#forgot > summary');
    t.includes(await p.text('#forgot'), 'delete config.json', 'the recovery steps are shown');
    t.equal(await p.text('#forgot-path'), d.PATHS.userData, 'with the exact data folder path');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settings: connection, general, about                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'settings-connection-flow',
  page: 'settings',
  fixture: 'connection-default',
  hash: 'connection',
  async run(p, t) {
    t.includes(await p.text('#conn-chip'), 'Connected', 'the status chip says Connected');
    t.equal(await valueOf(p, '#conn-url'), d.SERVER, 'the server address is shown');
    t.equal(await countOf(p, '#domains li'), 2, 'extra domains are listed');
    await p.fill('#domain-input', 'not a domain');
    await p.click('#domain-add');
    t.includes(await p.text('#domain-err'), 'Use a domain such as', 'an invalid domain is flagged');
    await p.fill('#domain-input', 'https://shop.example.com');
    await p.click('#domain-add');
    t.includes(await p.text('#domain-err'), 'already in the list', 'a duplicate is flagged');
    await p.fill('#domain-input', 'Shop2.Example.com');
    await p.focus('#domain-input');
    await p.press('Enter');
    t.equal(await countOf(p, '#domains li'), 3, 'Enter adds a valid domain');
    t.includes(await p.text('#domains'), 'https://shop2.example.com', 'it is normalised to https and lower case');
    t.equal(await isHidden(p, '#tab-connection .nav__dot'), false, 'the tab shows an unsaved dot');
    await p.click('#domains li:first-child button');
    t.equal(await countOf(p, '#domains li'), 2, 'a domain can be removed');
    t.equal(await p.attr('#domains li:first-child button', 'aria-label'), 'Remove *.partner-pos.co.uk', 'the remove button names its domain');
    await p.fill('#conn-url', 'http://pos.example.com');
    await p.click('#conn-save');
    t.includes(await p.text('#conn-url-err'), 'The address must start with https://', 'a non-https address is refused');
    await expectAlert(p, t, '#conn-url-err', 'the server address error');
    t.equal((await p.calls('settings.saveConnection')).length, 0, 'nothing is sent for an invalid address');
    await p.fill('#conn-url', 'https://pos.mygadgetshop.co.uk/point-of-sale');
    await p.click('#conn-save');
    const save = await lastCall(p, 'settings.saveConnection');
    t.equal(save && save.args[0], { serverUrl: 'https://pos.mygadgetshop.co.uk/point-of-sale', extraAllowedOrigins: ['*.partner-pos.co.uk', 'https://shop2.example.com'], password: '' }, 'Save sends the address and the domains');
    t.includes(await p.text('#conn-status'), 'Press Reload POS', 'a changed address tells how to open it');
    await p.click('#reload-pos');
    t.equal((await p.calls('connection.retryNow')).length, 1, 'Reload POS calls retryNow');
    t.includes(await p.text('#reload-status'), 'The POS is reloading.', 'and says so');
    await p.emit('status', { online: false, attempt: 2, nextRetryInMs: 6000 });
    t.includes(await p.text('#conn-chip'), 'Offline', 'a status push turns the chip to Offline');
    t.includes(await p.text('#rail-online'), 'Offline', 'and the rail');
  },
});

add({
  name: 'settings-connection-protected',
  page: 'settings',
  fixture: 'connection-protected',
  hash: 'connection',
  async run(p, t) {
    t.equal(await isHidden(p, '#conn-pw-field'), false, 'a protected Settings window asks for the password to save');
    await p.fill('#conn-url', 'https://pos.mygadgetshop.co.uk');
    await p.click('#conn-save');
    t.includes(await p.text('#conn-pw-err'), 'Enter the drawer password to save.', 'saving without the password is refused');
    await p.fill('#conn-pw', 'wrong');
    await p.click('#conn-save');
    t.includes(await p.text('#conn-pw-err'), 'That password is not correct.', 'a wrong password shows the main process message');
    await p.fill('#conn-pw', '1234');
    await p.click('#conn-save');
    const save = await lastCall(p, 'settings.saveConnection');
    t.equal(save && save.args[0].password, '1234', 'the password travels with Save');
  },
});

add({
  name: 'settings-general-flow',
  page: 'settings',
  fixture: 'general-default',
  hash: 'general',
  async run(p, t) {
    t.equal(await p.eval("document.getElementById('sw-login').checked"), true, 'start with the computer reflects the config');
    t.equal(await p.eval("document.getElementById('sw-accel').checked"), true, 'hardware acceleration is on by default');
    await p.click('#row-login');
    let call = await lastCall(p, 'settings.setGeneral');
    t.equal(call && call.args[0], { openAtLogin: false, startFullScreen: false, keepAwake: true }, 'a switch saves at once with all three values');
    t.equal(await p.text('#general-status'), 'Saved', 'and shows Saved');
    await p.clickText('.switch-row', 'Start in full screen');
    call = await lastCall(p, 'settings.setGeneral');
    t.equal(call && call.args[0].startFullScreen, true, 'full screen is saved');
    t.equal(await isHidden(p, '#restart-notice'), true, 'no restart notice before a performance change');
    await p.click('#sw-accel');
    const perf = await lastCall(p, 'settings.setPerformance');
    t.equal(perf && perf.args[0], { hardwareAcceleration: false }, 'the acceleration switch writes the flag');
    t.equal(await isHidden(p, '#restart-notice'), false, 'a restart notice appears');
    t.equal(await isHidden(p, '#compat-notice'), false, 'and the compatibility notice follows');
    await p.click('#restart-later');
    t.equal(await isHidden(p, '#restart-notice'), true, 'Later hides the restart notice');
    await p.click('#sw-accel');
    await p.click('#restart-now');
    t.equal((await p.calls('settings.restartApp')).length, 1, 'Restart now restarts the app');
  },
});

add({
  name: 'settings-general-linux',
  page: 'settings',
  fixture: 'general-linux',
  hash: 'general',
  async run(p, t) {
    t.equal(await isHidden(p, '#row-login'), true, 'start with the computer is hidden on Linux');
    t.equal(await visible(p, '#sw-fullscreen'), true, 'the other switches stay');
  },
});

add({
  name: 'settings-general-fallback',
  page: 'settings',
  fixture: 'general-fallback',
  hash: 'general',
  async run(p, t) {
    t.equal(await isHidden(p, '#compat-notice'), false, 'an automatic fallback shows the compatibility notice');
    t.includes(await p.text('#compat-text'), 'The graphics process stopped twice within a minute.', 'with the reason');
    t.equal(await p.eval("document.getElementById('sw-accel').checked"), false, 'and the acceleration switch is off');
  },
});

add({
  name: 'settings-about-flow',
  page: 'settings',
  fixture: 'about-none',
  hash: 'about',
  async run(p, t) {
    t.equal(await p.text('#update-headline'), 'GadgetsPOS is up to date', 'the update state is shown');
    await p.click('#update-check');
    const calls = await p.calls('settings.checkForUpdates');
    t.equal(calls.length, 1, 'Check for updates asks the main process');
    t.equal(await p.text('#update-headline'), 'GadgetsPOS is up to date', 'and returns to the answer');
    await p.click('#startup > summary');
    t.equal(await countOf(p, '.startup-table tbody tr'), 8, 'Startup details lists the eight marks');
    t.equal(await p.text('.startup-table tbody tr:first-child td:first-child'), 'Program started', 'with friendly names');
    t.equal(await p.text('.startup-table tbody tr:last-child td:first-child'), 'POS page fully loaded', 'in order');
    t.includes(await p.text('#startup-body > p'), 'Loading screen in 402 ms', 'and the one-line summary');
    await p.click('#open-logs');
    t.equal((await p.calls('settings.openLogsFolder')).length, 1, 'Open logs folder calls the main process');
    await p.click('#copy-diag');
    t.equal((await p.calls('settings.copyDiagnostics')).length, 1, 'Copy diagnostics calls the main process');
    t.includes(await p.text('#toasts'), 'Diagnostics copied', 'and confirms with a toast');
  },
});

add({
  name: 'settings-about-reset',
  page: 'settings',
  fixture: 'about-reset',
  hash: 'about',
  async run(p, t) {
    await p.click('#reset-open');
    t.equal(await p.attr('.dialog .btn--danger-solid', 'aria-disabled'), 'true', 'Reset stays inactive until RESET is typed');
    await p.fill('#reset-word', 'reset');
    t.equal(await p.attr('.dialog .btn--danger-solid', 'aria-disabled'), 'true', 'lower case does not count');
    await p.fill('#reset-word', 'RESET');
    t.equal(await p.attr('.dialog .btn--danger-solid', 'aria-disabled'), 'false', 'RESET arms the button');
    await p.fill('#reset-pw', '');
    await p.click('.dialog .btn--danger-solid');
    t.includes(await p.text('#reset-pw-err'), 'Enter the drawer password.', 'the password is required when one is set');
    t.equal((await p.calls('settings.resetAll')).length, 0, 'nothing is reset without it');
    await p.fill('#reset-pw', 'nope');
    await p.click('.dialog .btn--danger-solid');
    t.includes(await p.text('#reset-pw-err'), 'That password is not correct.', 'a wrong password is refused with the main process message');
    await expectAlert(p, t, '#reset-pw-err', 'the wrong reset password');
    await p.fill('#reset-pw', '1234');
    const stateCalls = (await p.calls('settings.getState')).length;
    await p.click('.dialog .btn--danger-solid');
    const reset = await lastCall(p, 'settings.resetAll');
    t.equal(reset && reset.args[0], { password: '1234' }, 'the correct password resets');
    t.ok(!(await p.has('dialog[open]')), 'the dialog closes');
    t.includes(await p.text('#toasts'), 'All settings were reset.', 'a toast confirms it');
    t.ok((await p.calls('settings.getState')).length > stateCalls, 'the state is read again');
    t.equal(await p.activeElement(), 'reset-open', 'focus returns to the Reset button');
  },
});

add({
  name: 'settings-about-states',
  page: 'settings',
  fixture: 'about-ready',
  hash: 'about',
  async run(p, t) {
    t.equal(await isHidden(p, '#update-install'), false, 'a downloaded update shows Restart and install');
    t.includes(await p.text('#update-headline'), 'Version 2.1.0 is ready to install', 'with its version');
    t.equal(await isHidden(p, '#update-check'), true, 'and hides Check for updates');
    await p.click('#update-install');
    t.equal((await p.calls('settings.installUpdate')).length, 1, 'Restart and install calls the main process');
    await p.emit('state', { update: { status: 'downloading', version: '2.2.0', percent: 64 } });
    t.includes(await p.text('#update-headline'), 'Downloading version 2.2.0', 'a pushed download state is shown');
    t.includes(await p.text('#update-sub'), '64% done', 'with the percentage');
    await p.emit('state', { update: { status: 'error', message: 'No connection.' } });
    t.includes(await p.text('#update-sub'), 'No connection.', 'an error shows its message');
    t.equal(await isHidden(p, '#update-check'), false, 'and offers to try again');
    await p.emit('state', { update: { status: 'disabled' } });
    t.equal(await isHidden(p, '#update-check'), true, 'disabled updates hide the check button');
  },
});

add({
  name: 'settings-load-error',
  page: 'settings',
  fixture: 'load-error',
  hash: 'printers',
  async run(p, t) {
    t.equal(await isHidden(p, '#load-error'), false, 'an unreadable state shows the error banner');
    t.includes(await p.text('#load-error-text'), 'The settings file could not be read.', 'with the main process message');
    t.equal(await visible(p, '#panel-printers'), false, 'and no tab shows empty forms');
    await p.click('#load-retry');
    t.equal((await p.calls('settings.getState')).length, 2, 'Try again reads the state again');
  },
});

add({
  name: 'settings-about-unknown',
  page: 'settings',
  fixture: 'about-unknown',
  hash: 'about',
  async run(p, t) {
    t.equal(await p.text('#update-headline'), 'Not checked yet', 'a missing update state does not claim "up to date"');
    t.equal(await isHidden(p, '#update-check'), false, 'and offers the check');
    await p.click('#update-check');
    t.equal(await p.text('#update-headline'), 'GadgetsPOS is up to date', 'checking gives a real answer');
  },
});

add({
  name: 'settings-about-nostartup',
  page: 'settings',
  fixture: 'about-nostartup',
  hash: 'about',
  async run(p, t) {
    await p.click('#startup > summary');
    t.includes(await p.text('#startup-body'), 'No startup details yet.', 'missing startup data shows an empty state');
    t.equal(await countOf(p, '.startup-table'), 0, 'and no table');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Keyboard focus rings on every tab and theme                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

for (const [tab, fixture, min] of [
  ['printers', 'printers-populated', 12],
  ['drawer', 'drawer-set', 8],
  ['connection', 'connection-default', 6],
  ['general', 'general-default', 4],
  ['about', 'about-none', 6],
]) {
  add({
    name: `focus-rings-${tab}`,
    page: 'settings',
    fixture,
    hash: tab,
    themes: tab === 'printers' || tab === 'about' ? ['light', 'dark'] : ['light'],
    async run(p, t) {
      const stops = new Set();
      let checked = 0;
      await p.focus(`#tab-${tab}`);
      for (let i = 0; i < 60; i += 1) {
        await p.press('Tab');
        const probe = await p.eval(`(${focusProbe.toString()})()`);
        if (!probe) break;
        const key = probe.name + i;
        stops.add(key);
        checked += 1;
        t.ok(probe.ring, `${tab}: ${probe.name} shows a focus ring`);
        t.ok(!probe.ring || probe.ratio >= 3, `${tab}: ${probe.name} focus ring contrast ${probe.ratio.toFixed(2)}:1 is at least 3:1`);
        if (probe.name === `tab-${tab}`) break;
      }
      t.ok(checked >= min, `${tab}: Tab reaches at least ${min} controls (${checked})`);
    },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Offline page                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'offline-live',
  page: 'offline',
  fixture: 'dns',
  query: { reason: 'dns', code: '-105', desc: 'ERR_NAME_NOT_RESOLVED', url: d.SERVER },
  async run(p, t) {
    t.includes(await p.text('#headline'), "Can't find the server", 'the headline matches the reason');
    t.includes(await p.text('#lede'), 'vendor.societyfiles.com', 'the lede names the server');
    t.equal(await p.count('#steps li'), 3, 'three plain steps are listed');
    t.equal(await p.eval('typeof window.desktop.settings'), 'undefined', 'the offline page cannot see the settings API (SPEC 6.3)');
    t.equal(await p.eval('typeof window.desktop.password'), 'undefined', 'nor the password API');
    const first = await p.text('#connect-title');
    t.ok(/^Trying again in (\d+) seconds?$/.test(first), `a live countdown is shown (${first})`);
    t.includes(await p.text('#connect-sub'), 'Attempt 3', 'with the attempt number');
    await p.wait(1500);
    const second = await p.text('#connect-title');
    t.ok(Number(/(\d+)/.exec(second)[1]) < Number(/(\d+)/.exec(first)[1]), `the countdown moves (${first} -> ${second})`);
    await p.emit('status', { attempt: 4, nextRetryInMs: 24000 });
    t.equal(await p.text('#connect-title'), 'Trying again in 24 seconds', 'a status push restarts the countdown');
    t.includes(await p.text('#connect-sub'), 'Attempt 4', 'with the new attempt number');
    await p.emit('status', { nextRetryInMs: null });
    t.equal(await p.text('#connect-title'), 'Trying to connect...', 'no countdown means a try is under way');
    await p.click('#retry');
    t.equal((await p.calls('connection.retryNow')).length, 1, 'Retry now calls the main process');
    await p.click('#open-printers');
    await p.click('#open-server');
    t.equal((await p.calls('connection.openSettings')).map((c) => c.args[0]), ['printers', 'connection'], 'Printer settings and Change server address open the right tabs');
    await p.click('#tech > summary');
    t.includes(await p.text('#tech-list'), 'ERR_NAME_NOT_RESOLVED (-105)', 'Technical details show the error');
    t.includes(await p.text('#tech-list'), d.SERVER, 'and the address');
    await p.emit('status', { online: true });
    t.equal(await p.text('#connect-title'), 'Back online - reloading...', 'going online shows Back online - reloading...');
    t.equal(await p.attr('#connect', 'data-state'), 'online', 'the card turns to the online state');
    t.equal(await p.text('#headline'), 'Back online', 'and so does the headline: a push with only { online: true } keeps the attempt that was counted');
    t.equal(await isHidden(p, '#steps'), true, 'and the repair steps are hidden');
  },
});

add({
  name: 'offline-hostile',
  page: 'offline',
  fixture: 'hostile',
  query: { reason: 'dns', code: '<b>-105</b>', desc: '<img src=x onerror=alert(1)><script>alert(2)</script>', url: 'https://evil.example/<img src=x>' },
  async run(p, t) {
    await p.click('#tech > summary');
    t.equal(await p.eval('document.querySelectorAll("img").length'), 1, 'only the logo image exists: no markup was injected');
    t.equal(await p.eval('document.querySelectorAll("script:not([src])").length'), 0, 'no script was injected');
    t.includes(await p.text('#tech-list'), '<img src=x onerror=alert(1)>', 'the hostile text is shown as plain text');
  },
});

add({
  name: 'offline-reason-unknown',
  page: 'offline',
  fixture: 'other',
  query: { reason: '__proto__', code: '1', desc: 'x', url: 'nonsense' },
  async run(p, t) {
    t.equal(await p.text('#headline'), "Can't open GadgetsPOS", 'an unknown reason falls back to the generic screen');
  },
});

/*
 * A crash loop and an invalid server address: the main process shows this page WITHOUT reconnecting by itself, so the connection
 * controller is at rest. It reports `online: true` then (only "no outage is tracked", no attempt), which is not "back online":
 * nothing is reloading and the cashier has to act.
 */
for (const [name, fixture, query, hint] of [
  ['offline-resting-crash-loop', 'crash-loop', d.RESTING_QUERY.loop, 'Choose View > Reload'],
  ['offline-resting-bad-address', 'bad-address', d.RESTING_QUERY.address, 'Open Settings > Connection'],
]) {
  add({
    name,
    page: 'offline',
    fixture,
    query,
    async run(p, t) {
      t.equal(await p.attr('#connect', 'data-state'), 'idle', 'a controller at rest is shown as idle, not as online');
      t.equal(await p.text('#connect-title'), 'Not trying again by itself', 'the card says that nothing retries by itself');
      t.includes(await p.text('#connect-sub'), 'Retry now', 'and what to do');
      t.ok(!/Back online/.test(await p.eval('document.body.innerText')), 'nothing on the page claims "Back online"');
      t.equal(await p.attr('.art', 'data-tone'), 'warning', 'the picture keeps the warning tone');
      t.includes(await p.text('#lede'), hint, 'the sentence that says what to do is the first paragraph, not hidden in Technical details');
      t.equal(await p.count('.progress--indeterminate'), 0, 'no endless progress bar runs');
      t.equal(await p.eval("document.getAnimations().filter((a) => a.playState === 'running' && a.effect.getTiming().iterations === Infinity).length"), 0, 'nothing animates forever while nothing is happening');
      await p.click('#tech > summary');
      t.includes(await p.text('#tech-list'), query.url, 'the address from the page address stays in Technical details');
      await p.wait(150);
      t.ok(!/Back online/.test((await p.text('.sr-only[role="status"]')) || ''), 'and no screen reader is told "Back online"');
      t.equal(await p.eval("document.getElementById('retry').disabled"), false, 'Retry now is available');
      await p.click('#retry');
      t.equal((await p.calls('connection.retryNow')).length, 1, 'and calls the main process');
    },
  });
}

/* After a successful probe the whole page says so (the headline, the paragraph and the steps used to keep describing the failure). */
add({
  name: 'offline-recovered',
  page: 'offline',
  fixture: 'dns',
  query: { reason: 'dns', code: '-105', desc: 'ERR_NAME_NOT_RESOLVED', url: d.SERVER },
  async run(p, t) {
    t.equal(await p.text('#headline'), "Can't find the server", 'the failure headline shows while the server is unreachable');
    await p.emit('status', d.RECOVERED);
    t.equal(await p.attr('#connect', 'data-state'), 'online', 'a succeeded probe shows the online state');
    await p.wait(100);
    t.equal(await p.text('.sr-only[role="status"]'), 'Back online. Reloading your shop.', 'a screen reader is told once that the server is back');
    t.equal(await p.text('#connect-title'), 'Back online - reloading...', 'the card says the page is reloading');
    t.equal(await p.text('#headline'), 'Back online', 'the headline stops saying that the server cannot be found');
    t.includes(await p.text('#lede'), 'Opening your shop', 'the paragraph says what is happening');
    t.equal(await isHidden(p, '#steps'), true, 'the repair steps are gone while the shop opens');
    t.equal(await p.attr('.art', 'data-tone'), 'success', 'the picture turns to the success tone');
    t.equal(await p.eval("document.getElementById('retry').disabled"), false, 'Retry now stays available in case the POS page hangs');
    t.includes(await p.text('#tech-list'), d.SERVER, 'Technical details keep the address of the failed request');
    t.includes(await p.text('#tech-list'), 'ERR_NAME_NOT_RESOLVED', 'and the error');
    // the next failure brings the failure copy back
    await p.emit('status', { online: false, attempt: 5, nextRetryInMs: 6000, reason: 'dns', url: d.SERVER, lastError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } });
    t.equal(await p.text('#headline'), "Can't find the server", 'the next failure restores the failure headline');
    t.equal(await p.count('#steps li'), 3, 'and the three steps');
    t.equal(await isHidden(p, '#steps'), false, 'which are shown again');
    t.equal(await p.attr('#connect', 'data-state'), 'waiting', 'with the countdown');
    await p.wait(100);
    t.equal(await p.text('.sr-only[role="status"]'), 'Still offline. Attempt 5.', 'and a screen reader hears that it is still offline');
  },
});

/*
 * Below 780 CSS px (a zoomed small window, a small display) the page is one column. The live status and Retry now must come
 * before the checklist, or a cashier sees steps and no button on the first screen; a wide window keeps its two columns.
 */
for (const [size, zoom] of [
  [[960, 600], 1.5],
  [[1024, 768], 1.44],
]) {
  add({
    name: `offline-stacked-${size[0]}x${size[1]}-z${Math.round(zoom * 100)}`,
    page: 'offline',
    fixture: 'first',
    size,
    zoom,
    query: { reason: 'offline', code: '-106', desc: 'ERR_INTERNET_DISCONNECTED', url: d.SERVER },
    async run(p, t) {
      const m = await p.eval(`(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, connectTop: box('#connect').top, retryBottom: box('#retry').bottom, stepsTop: box('#steps').top };
      })()`);
      t.ok(m.width < 780, `the page is in its one-column layout (${Math.round(m.width)} CSS px wide)`);
      t.ok(m.retryBottom <= m.height, `Retry now ends at ${Math.round(m.retryBottom)} px, inside the first screen (${Math.round(m.height)} px high)`);
      t.ok(m.connectTop < m.stepsTop, 'the live status card comes before the checklist');
    },
  });
}

add({
  name: 'offline-two-columns',
  page: 'offline',
  fixture: 'first',
  size: [960, 600],
  query: { reason: 'offline', code: '-106', desc: 'ERR_INTERNET_DISCONNECTED', url: d.SERVER },
  async run(p, t) {
    const m = await p.eval(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      return { width: innerWidth, connectLeft: box('#connect').left, stepsRight: box('#steps').right };
    })()`);
    t.ok(m.width > 780, `the window is wide (${m.width} px)`);
    t.ok(m.connectLeft >= m.stepsRight, 'a wide window keeps two columns: the status card sits right of the checklist');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Password window                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

add({
  name: 'password-keys',
  page: 'password',
  fixture: 'idle',
  size: [420, 340],
  async run(p, t) {
    t.equal(await p.activeElement(), 'pw-input', 'the password field has focus on open');
    t.equal(await p.attr('#pw-input', 'type'), 'password', 'the field hides what is typed');
    await p.type('nope');
    await p.press('Enter');
    t.equal((await lastCall(p, 'password.submit')).args, ['nope'], 'Enter submits the typed password');
    t.includes(await p.text('#pw-error'), 'That password is not correct.', 'a wrong password shows the main process message inline');
    await expectAlert(p, t, '#pw-error', 'the wrong drawer password');
    t.equal(await p.attr('#pw-input', 'aria-invalid'), 'true', 'the field is marked invalid');
    t.equal(await p.activeElement(), 'pw-input', 'focus stays in the field for a retry');
    await p.press('Escape');
    t.equal((await p.calls('password.cancel')).length, 1, 'Escape cancels');
    await p.click('#pw-reveal');
    t.equal(await p.attr('#pw-input', 'type'), 'text', 'the eye button shows the password');
    t.equal(await p.attr('#pw-reveal', 'aria-pressed'), 'true', 'and reports its state');
    await p.click('#pw-reveal');
    await p.click('#pw-cancel');
    t.equal((await p.calls('password.cancel')).length, 2, 'the Cancel button cancels too');
  },
});

add({
  name: 'password-lockout',
  page: 'password',
  fixture: 'lockout-short',
  size: [420, 340],
  async run(p, t) {
    for (const wrong of ['a', 'b', 'c']) {
      await p.fill('#pw-input', wrong);
      await p.press('Enter');
    }
    t.equal(await isHidden(p, '#lock-banner'), false, 'three wrong passwords show the lockout');
    t.equal(await p.eval("document.getElementById('pw-input').disabled"), true, 'the field is locked');
    t.ok(/^0:0[1-4]$/.test(await p.text('#lock-time')), `a countdown is shown (${await p.text('#lock-time')})`);
    await p.wait(4800);
    t.equal(await isHidden(p, '#lock-banner'), true, 'the lock lifts when the time is up');
    t.equal(await p.eval("document.getElementById('pw-input').disabled"), false, 'the field works again');
    t.equal(await p.activeElement(), 'pw-input', 'and has focus');
    await p.type('1234');
    await p.press('Enter');
    t.includes(await p.text('#pw-status'), 'The drawer is opening.', 'the right password shows success');
    await p.wait(1800);
    t.equal((await p.calls('window.close')).length, 1, 'the window is closed from the page if the main process has not done it');
  },
});

add({
  name: 'password-locked-on-open',
  page: 'password',
  fixture: 'locked-ms',
  size: [420, 340],
  async run(p, t) {
    t.equal(await isHidden(p, '#lock-banner'), false, 'a lockout that is already active is shown on open');
    t.equal(await p.text('#lock-time'), '0:27', 'from a { retryAfterMs } payload as well');
    await p.emit('lockout', { locked: false });
    t.equal(await isHidden(p, '#lock-banner'), true, 'a pushed unlock hides it');
  },
});

add({
  name: 'password-purpose',
  page: 'password',
  fixture: 'settings',
  size: [420, 340],
  query: { purpose: 'settings' },
  async run(p, t) {
    t.equal(await p.text('#pw-title'), 'Settings are protected', 'purpose=settings changes the wording');
    t.equal(await p.text('#pw-submit-label'), 'Continue', 'and the button');
  },
});

add({
  name: 'password-purpose-hostile',
  page: 'password',
  fixture: 'idle',
  size: [420, 340],
  query: { purpose: '<img src=x onerror=alert(1)>' },
  async run(p, t) {
    t.equal(await p.text('#pw-title'), 'Open cash drawer', 'an unknown purpose falls back to the default wording');
    t.equal(await p.eval('document.querySelectorAll("img").length'), 0, 'and nothing is injected');
  },
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Idle cost                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

for (const [page, fixture, size] of [
  ['settings', 'printers-populated', [1280, 800]],
  ['password', 'idle', [420, 340]],
  ['loading', 'default', [1280, 800]],
]) {
  add({
    name: `idle-${page}`,
    page,
    fixture,
    size,
    hash: page === 'settings' ? 'printers' : '',
    async run(p, t) {
      await p.wait(700);
      const running = await p.eval("document.getAnimations().filter((a) => a.playState === 'running' && a.effect.getTiming().iterations === Infinity).map((a) => a.animationName || a.transitionProperty || 'animation')");
      // The loading page keeps its single spinner turning on purpose; every other idle page must be still.
      t.equal(running, page === 'loading' ? ['loading-spin'] : [], `${page}: idle animations`);
      const elements = await p.eval('document.getElementsByTagName("*").length');
      t.ok(elements < 1600, `${page}: DOM stays small (${elements} elements)`);
    },
  });
}

module.exports = { SCENARIOS };
