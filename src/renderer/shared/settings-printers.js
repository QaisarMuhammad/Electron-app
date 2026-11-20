/*
 * Settings > Printers (SPEC 14): a Receipt printer card and a Label printers card (Zebra / raw label printer + DYMO printer).
 *
 * Each role keeps a saved copy (what the main process has) and a draft (what is on screen). Dirty = draft differs from saved,
 * shown as "Unsaved changes" and as a dot on the tab. Test always uses what is saved, so pressing Test with unsaved changes
 * saves first (and says so), instead of printing on the old printer. Messages for failures are Result.message, never invented.
 *
 * The tab repeats the same controls for each printer (Save, Test, Refresh, the printer list). Each section is a labelled group
 * and its buttons and list carry the printer's name for assistive technology (`who`), so no two controls sound alike.
 */
import { $, h, icon, call, messageOf, setBusy, showStatus, setFieldError, announce } from './ui.js';
import { clone, sameJson, plural } from './format.mjs';
import { createPicker } from './picker.js';

const EMPTY_RAW = { transport: 'system', printerName: '', port: '' };

const unsavedIndicator = () => h('span', { class: 'status status--warning status--dot' }, h('span', { class: 'dot dot--warning' }), h('span', { class: 'status__text', text: 'Unsaved changes' }));

/**
 * Receipt printer or raw label printer: connection type, installed printer picker or port field, Test and Save.
 * @param {any} ctx settings context
 * @param {{role:'receipt'|'label', who:string, testLabel:string, testName?:string, testOptions:object, what:string, onRefresh:()=>void, onDirty:()=>void}} options
 *   `who` names the printer for assistive technology ("receipt printer"); `testName` is the accessible name of the Test button
 *   when its visible text alone would be ambiguous.
 */
function createRawRole(ctx, { role, who, testLabel, testName, testOptions, what, onRefresh, onDirty }) {
  let saved = clone(EMPTY_RAW);
  let draft = clone(EMPTY_RAW);
  let busy = '';
  let result = null;

  const group = `transport-${role}`;
  const portId = `${role}-port`;
  const picker = createPicker({
    name: `printer-${role}`,
    title: 'Installed printers',
    who,
    kind: 'system',
    platform: ctx.platform,
    onChange: (value) => edit({ printerName: value }),
    onRefresh,
  });

  const radios = {
    system: h('input', { type: 'radio', class: 'radio', name: group, value: 'system', on: { change: () => edit({ transport: 'system' }) } }),
    port: h('input', { type: 'radio', class: 'radio', name: group, value: 'port', on: { change: () => edit({ transport: 'port' }) } }),
  };
  const portChoiceDesc = h('span', { class: 'choice__desc' });
  const choices = h(
    'fieldset',
    { class: 'fieldset' },
    h('legend', { class: 'field__label', text: 'How is it connected?' }),
    h(
      'div',
      { class: 'choice-grid' },
      h('label', { class: 'choice' }, radios.system, h('span', { class: 'choice__body' }, h('span', { class: 'choice__title', text: 'Installed printer (recommended)' }), h('span', { class: 'choice__desc', text: 'Pick a printer that is installed on this computer.' }))),
      h('label', { class: 'choice' }, radios.port, h('span', { class: 'choice__body' }, h('span', { class: 'choice__title', text: 'Advanced: port or network share' }), portChoiceDesc)),
    ),
  );

  const portInput = h('input', {
    class: 'input input--mono',
    id: portId,
    type: 'text',
    placeholder: '\\\\localhost\\ZebraZD420',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-describedby': `${portId}-hint`,
    on: {
      input: () => edit({ port: portInput.value }),
      keydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();
        }
      },
    },
  });
  const portError = h('div', { class: 'field__error', id: `${portId}-err`, hidden: true });
  const portField = h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: portId, text: 'Port or shared printer address' }),
    portInput,
    h('p', { class: 'field__hint', id: `${portId}-hint`, text: 'Examples: LPT1, COM3 or \\\\localhost\\ZebraZD420' }),
    portError,
  );

  const statusSlot = h('div', { class: 'role__foot-note', 'aria-live': 'polite' });
  const testBtn = h('button', { type: 'button', class: 'btn', 'aria-label': testName, on: { click: () => test() } }, icon('printer'), h('span', { text: testLabel }));
  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary', 'aria-label': `Save ${who}`, on: { click: () => save() } }, h('span', { text: 'Save' }));
  const el = h('div', { class: 'role', role: 'group', 'aria-label': who, dataset: { role } }, choices, picker.el, portField, h('div', { class: 'role__foot' }, statusSlot, h('div', { class: 'role__buttons' }, testBtn, saveBtn)));

  const isDirty = () => !sameJson(draft, saved);
  const target = () => (draft.transport === 'port' ? draft.port.trim() : draft.printerName);

  function renderStatus() {
    if (result) showStatus(statusSlot, result.tone, result.text);
    else if (isDirty()) statusSlot.replaceChildren(unsavedIndicator());
    else showStatus(statusSlot, null);
    saveBtn.setAttribute('aria-disabled', String(!isDirty() || !!busy));
    testBtn.setAttribute('aria-disabled', String(!!busy));
  }

  function render() {
    const onWindows = ctx.platform === 'win32';
    const portAllowed = onWindows || saved.transport === 'port';
    radios.system.checked = draft.transport !== 'port';
    radios.port.checked = draft.transport === 'port';
    radios.port.disabled = !portAllowed;
    portChoiceDesc.textContent = portAllowed ? 'For older setups that print to a port such as LPT1 or to a shared printer.' : 'Available on Windows only.';
    const usePort = draft.transport === 'port';
    picker.el.hidden = usePort;
    portField.hidden = !usePort;
    if (picker.selected !== draft.printerName) picker.setSelected(draft.printerName);
    if (portInput.value !== draft.port) portInput.value = draft.port;
    renderStatus();
  }

  function edit(patch) {
    Object.assign(draft, patch);
    result = null;
    setFieldError(portInput, portError, null);
    render();
    onDirty();
  }

  /** Checks only what must be present; the main process still validates the port itself (SPEC 9.1). */
  function validate() {
    if (draft.transport === 'port') {
      if (!draft.port.trim()) {
        setFieldError(portInput, portError, 'Enter a port or a shared printer address.');
        portInput.focus();
        return false;
      }
    } else if (!draft.printerName) {
      result = { tone: 'danger', text: 'Choose a printer first.' };
      renderStatus();
      return false;
    }
    return true;
  }

  async function save() {
    if (busy || !isDirty()) return { ok: false, code: 'NOTHING_TO_SAVE' };
    if (!validate()) return { ok: false, code: 'INVALID_SETTINGS' };
    busy = 'save';
    setBusy(saveBtn, true);
    renderStatus();
    const sent = clone(draft);
    sent.port = sent.port.trim();
    const response = await call(ctx.desktop.settings.savePrinter, role, sent);
    busy = '';
    setBusy(saveBtn, false);
    if (response.ok) {
      saved = clone(sent);
      draft.port = sent.port;
      result = { tone: 'success', text: 'Saved' };
      announce(`${what} printer saved.`);
    } else if (draft.transport === 'port') {
      setFieldError(portInput, portError, messageOf(response));
      portInput.focus();
    } else {
      result = { tone: 'danger', text: messageOf(response) };
    }
    render();
    onDirty();
    return response;
  }

  async function test() {
    if (busy) return;
    if (!validate()) return;
    const wasDirty = isDirty();
    if (wasDirty) {
      const response = await save();
      if (!response.ok) return;
    }
    busy = 'test';
    setBusy(testBtn, true);
    result = null;
    renderStatus();
    const response = await call(ctx.desktop.settings.testPrint, role, testOptions);
    busy = '';
    setBusy(testBtn, false);
    const where = target();
    result = response.ok
      ? { tone: 'success', text: `${wasDirty ? 'Saved. ' : ''}Test ${what} sent to ${where || 'the printer'}.` }
      : { tone: 'danger', text: messageOf(response) };
    renderStatus();
    announce(result.text);
  }

  return {
    el,
    picker,
    get dirty() {
      return isDirty();
    },
    /** New saved config from the main process; an untouched draft follows it, an edited draft is kept. */
    applySaved(next) {
      const wasDirty = isDirty();
      saved = { ...clone(EMPTY_RAW), ...clone(next || {}) };
      if (!wasDirty) draft = clone(saved);
      render();
      onDirty();
    },
  };
}

/** DYMO printer: "Automatic" plus the printers DYMO Connect reports, with a hint when DYMO Connect is not running. */
function createDymoRole(ctx, { who, onRefresh, onDirty }) {
  let saved = { printerName: '' };
  let draft = { printerName: '' };
  let busy = '';
  let result = null;

  const picker = createPicker({ name: 'printer-dymo', title: 'DYMO printers', who, kind: 'dymo', onChange: (value) => edit(value), onRefresh });
  const bannerTitle = h('p', { class: 'banner__title', text: 'DYMO Connect is not running' });
  const bannerText = h('p', { class: 'banner__text' });
  const banner = h('div', { class: 'banner banner--warning', role: 'status', hidden: true }, h('span', { class: 'banner__icon' }, icon('alert')), h('div', { class: 'banner__body' }, bannerTitle, bannerText));
  const statusSlot = h('div', { class: 'role__foot-note', 'aria-live': 'polite' });
  const testBtn = h('button', { type: 'button', class: 'btn', 'aria-label': `Print test label on the ${who}`, on: { click: () => test() } }, icon('roll'), h('span', { text: 'Print test label' }));
  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary', 'aria-label': `Save ${who}`, on: { click: () => save() } }, h('span', { text: 'Save' }));
  const el = h('div', { class: 'role', role: 'group', 'aria-label': who, dataset: { role: 'dymo' } }, banner, picker.el, h('div', { class: 'role__foot' }, statusSlot, h('div', { class: 'role__buttons' }, testBtn, saveBtn)));

  const isDirty = () => draft.printerName !== saved.printerName;

  function renderStatus() {
    if (result) showStatus(statusSlot, result.tone, result.text);
    else if (isDirty()) statusSlot.replaceChildren(unsavedIndicator());
    else showStatus(statusSlot, null);
    saveBtn.setAttribute('aria-disabled', String(!isDirty() || !!busy));
    testBtn.setAttribute('aria-disabled', String(!!busy));
  }

  function render() {
    if (picker.selected !== draft.printerName) picker.setSelected(draft.printerName);
    renderStatus();
  }

  function edit(printerName) {
    draft.printerName = printerName;
    result = null;
    render();
    onDirty();
  }

  async function save() {
    if (busy || !isDirty()) return { ok: false, code: 'NOTHING_TO_SAVE' };
    busy = 'save';
    setBusy(saveBtn, true);
    renderStatus();
    const sent = { printerName: draft.printerName };
    const response = await call(ctx.desktop.settings.savePrinter, 'dymo', sent);
    busy = '';
    setBusy(saveBtn, false);
    if (response.ok) {
      saved = { ...sent };
      result = { tone: 'success', text: 'Saved' };
      announce('DYMO printer saved.');
    } else {
      result = { tone: 'danger', text: messageOf(response) };
    }
    render();
    onDirty();
    return response;
  }

  async function test() {
    if (busy) return;
    const wasDirty = isDirty();
    if (wasDirty) {
      const response = await save();
      if (!response.ok) return;
    }
    busy = 'test';
    setBusy(testBtn, true);
    result = null;
    renderStatus();
    const response = await call(ctx.desktop.settings.testPrint, 'dymo', {});
    busy = '';
    setBusy(testBtn, false);
    result = response.ok
      ? { tone: 'success', text: `${wasDirty ? 'Saved. ' : ''}Test label sent to ${draft.printerName || 'the DYMO printer'}.` }
      : { tone: 'danger', text: messageOf(response) };
    renderStatus();
    announce(result.text);
  }

  return {
    el,
    picker,
    get dirty() {
      return isDirty();
    },
    setError(message) {
      banner.hidden = !message;
      bannerText.textContent = message ? dymoHint(message) : '';
    },
    applySaved(next) {
      const wasDirty = isDirty();
      saved = { printerName: (next && next.printerName) || '' };
      if (!wasDirty) draft = { ...saved };
      render();
      onDirty();
    },
  };
}

/** The banner title already says "DYMO Connect is not running", so the text keeps only what to do about it. */
function dymoHint(message) {
  const rest = String(message).replace(/^\s*DYMO Connect is not running\.?\s*/i, '').trim();
  const base = rest || 'Open DYMO Connect and make sure the printer is switched on.';
  return /refresh/i.test(base) ? base : `${base} Then press Refresh.`;
}

/** A card heading; `id` lets the card name itself after it (aria-labelledby), as the cards of settings.html do. */
function cardHead(iconName, title, description, id) {
  return h('div', { class: 'card__head' }, h('span', { class: 'tile' }, icon(iconName)), h('div', { class: 'card__heading' }, h('h2', { class: 'card__title', id, text: title }), h('p', { class: 'card__desc', text: description })));
}

/** Builds the Printers tab inside #printers-root and keeps it in step with the settings store. */
export function mountPrinters(ctx) {
  const root = $('#printers-root');
  let loadedOnce = false;
  let slowTimer = 0;

  const onDirty = () => ctx.setDirty('printers', receipt.dirty || zebra.dirty || dymo.dirty);
  const receipt = createRawRole(ctx, { role: 'receipt', who: 'receipt printer', testLabel: 'Print test receipt', testOptions: {}, what: 'receipt', onRefresh: () => refresh(), onDirty });
  const zebra = createRawRole(ctx, {
    role: 'label',
    who: 'Zebra printer',
    testLabel: 'Print test label',
    testName: 'Print test label on the Zebra printer',
    testOptions: { kind: 'zebra' },
    what: 'label',
    onRefresh: () => refresh(),
    onDirty,
  });
  const dymo = createDymoRole(ctx, { who: 'DYMO printer', onRefresh: () => refresh(), onDirty });
  const pickers = [receipt.picker, zebra.picker, dymo.picker];

  const labelCard = h(
    'article',
    { class: 'card', 'aria-labelledby': 'label-printers-title' },
    cardHead('label', 'Label printers', 'Product, serial number and repair labels. Set up the kind you use; your POS account setting decides which one prints.', 'label-printers-title'),
    h(
      'div',
      { class: 'card__body stack stack--loose' },
      h('div', { class: 'role__intro' }, h('h3', { text: 'Zebra or other raw label printer' }), h('p', { class: 'muted', text: 'For Zebra printers and other label printers that understand ZPL.' })),
      zebra.el,
    ),
    h(
      'div',
      { class: 'card__body stack stack--loose' },
      h('div', { class: 'role__intro' }, h('h3', { text: 'DYMO printer' }), h('p', { class: 'muted', text: 'For DYMO LabelWriter printers. DYMO Connect must be running.' })),
      dymo.el,
    ),
  );
  root.replaceChildren(
    h(
      'article',
      { class: 'card', 'aria-labelledby': 'receipt-printer-title' },
      cardHead('receipt', 'Receipt printer', 'The thermal printer for receipts and reports. It also opens the cash drawer.', 'receipt-printer-title'),
      h('div', { class: 'card__body' }, receipt.el),
    ),
    labelCard,
  );

  /** Reads the printer lists; the same call fills all three pickers. */
  async function refresh() {
    for (const p of pickers) p.setRefreshing(true);
    if (!loadedOnce) slowTimer = setTimeout(() => pickers.forEach((p) => p.setSlow(true)), 3000);
    let out = null;
    let failure = '';
    try {
      out = await ctx.desktop.settings.listPrinters();
      if (out && out.ok === false) failure = messageOf(out, 'The list of printers could not be read.');
    } catch (error) {
      console.warn('listPrinters failed', error);
      failure = 'The list of printers could not be read.';
    }
    clearTimeout(slowTimer);
    loadedOnce = true;
    const system = out && Array.isArray(out.system) ? out.system : [];
    const dymoList = out && Array.isArray(out.dymo) ? out.dymo : [];
    receipt.picker.setData({ items: system, error: failure, loading: false });
    zebra.picker.setData({ items: system, error: failure, loading: false });
    dymo.picker.setData({ items: dymoList, loading: false });
    dymo.setError(out && out.dymoError ? String(out.dymoError) : '');
    for (const p of pickers) {
      p.setSlow(false);
      p.setRefreshing(false);
    }
    if (!failure) ctx.announce(`${system.length} ${plural(system.length, 'printer')} found.`);
  }

  ctx.store.subscribe((state) => {
    const printers = (state.config && state.config.printers) || {};
    receipt.applySaved(printers.receipt);
    zebra.applySaved(printers.label);
    dymo.applySaved(printers.dymo);
  });
  refresh();
  return { refresh };
}
