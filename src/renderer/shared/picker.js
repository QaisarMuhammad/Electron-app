/*
 * Printer picker: a radio list of installed printers (or DYMO printers) with a default badge, status badges, a refresh button
 * with spinner, a search box when there are more than eight printers, and real empty / loading / error states.
 *
 * It owns no data: the page hands it items with setData() and the current choice with setSelected(); it reports a choice
 * through onChange(value). A saved printer that is no longer installed stays selected and is shown as "Not found" instead of
 * silently disappearing. Every label is written with textContent (printer names come from the operating system).
 *
 * A long list scrolls itself (never the page) to the checked row, so a saved printer far down the list is on screen when the
 * tab opens, after Refresh and after a search is cleared; a list built while its tab is hidden does it once the tab is shown.
 */
import { h, icon, setBusy } from './ui.js';
import { describePrinterStatus, filterPrinters, plural } from './format.mjs';

const SEARCH_FROM = 8;

const badge = (text, tone = '', iconName = '') => h('span', { class: `badge${tone ? ` badge--${tone}` : ''}` }, iconName ? icon(iconName) : null, text);

/**
 * @param {{name:string, title:string, who?:string, kind:'system'|'dymo', platform?:string, onChange:(value:string)=>void, onRefresh:()=>void}} options
 *   `who` names the printer this list is for ("receipt printer"). The page holds several lists with the same visible title, so
 *   it is added for assistive technology only: to the name of the list, of its Refresh button and of its search box.
 */
export function createPicker({ name, title, who = '', kind, platform = '', onChange, onRefresh }) {
  let items = [];
  let selected = '';
  let loading = true;
  let slow = false;
  let refreshing = false;
  let error = '';
  let query = '';
  let disabled = false;
  /** True while the list still has to be scrolled to the checked row: it was built before it had a layout (its tab is hidden). */
  let reveal = false;

  const titleId = `${name}-title`;
  const searchText = kind === 'dymo' ? 'Search DYMO printers' : 'Search printers';
  const countEl = h('span', { class: 'picker__count' });
  const refreshBtn = h(
    'button',
    { type: 'button', class: 'btn', 'aria-label': who ? `Refresh ${who} list` : null, 'aria-describedby': titleId, on: { click: () => onRefresh() } },
    icon('refresh'),
    h('span', { text: 'Refresh' }),
  );
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: searchText,
    'aria-label': who && kind === 'system' ? `${searchText} for the ${who}` : searchText,
    autocomplete: 'off',
    spellcheck: 'false',
    on: {
      input: () => {
        query = searchInput.value;
        renderList();
      },
    },
  });
  const searchWrap = h('div', { class: 'input-group input-group--lead', hidden: true }, h('span', { class: 'input-group__lead' }, icon('search')), searchInput);
  const box = h('div', { class: 'picker__box' });
  const liveNote = h('p', { class: 'small muted', hidden: true });
  const root = h(
    'div',
    { class: 'picker' },
    h('div', { class: 'picker__head' }, h('div', { class: 'picker__title', id: titleId }, who ? h('span', { class: 'sr-only', text: `${who}: ` }) : null, h('span', { text: title }), countEl), refreshBtn),
    searchWrap,
    box,
    liveNote,
  );

  function row({ value, label, sub = '', badges = [] }) {
    const input = h('input', { type: 'radio', class: 'radio', name, value, checked: value === selected, disabled });
    input.addEventListener('change', () => {
      selected = value;
      onChange(value);
    });
    return h(
      'label',
      { class: 'picker__row' },
      input,
      h('span', { class: 'picker__text' }, h('span', { class: 'picker__name', text: label }), sub ? h('span', { class: 'picker__sub', text: sub }) : null),
      badges.length ? h('span', { class: 'choice__aside' }, badges) : null,
    );
  }

  function emptyState({ iconName, heading, text }) {
    return h('div', { class: 'picker__empty' }, h('span', { class: 'tile' }, icon(iconName)), h('p', { class: 'picker__empty-title', text: heading }), h('p', { text }));
  }

  function skeletons(count) {
    return h('div', { class: 'picker__skeletons', 'aria-hidden': 'true' }, Array.from({ length: count }, () => h('div', { class: 'skeleton' })));
  }

  /** Rows for the current items, with "Automatic" first for DYMO and a "Not found" row for a vanished saved choice. */
  function rows() {
    const out = [];
    if (kind === 'dymo') {
      out.push(row({ value: '', label: 'Automatic (recommended)', sub: 'GadgetsPOS picks the connected DYMO printer for you.' }));
    }
    const names = new Set(items.map((p) => p.name));
    if (selected && !names.has(selected)) {
      out.push(
        row({
          value: selected,
          label: selected,
          sub: 'Saved earlier, but this computer does not list it now.',
          badges: [badge('Not found', 'warning', 'alert')],
        }),
      );
    }
    const visible = filterPrinters(items, query);
    for (const printer of visible) {
      if (kind === 'dymo') {
        const sub = printer.modelName && printer.modelName !== printer.name ? printer.modelName : '';
        out.push(row({ value: printer.name, label: printer.name, sub, badges: [printer.isConnected ? badge('Connected', 'success', 'check') : badge('Not connected')] }));
      } else {
        const shown = printer.displayName || printer.name;
        const state = describePrinterStatus(printer.status, platform);
        const badges = [];
        if (printer.isDefault) badges.push(badge('Default', 'default'));
        if (state) badges.push(badge(state.label, state.tone === 'neutral' ? '' : state.tone));
        out.push(row({ value: printer.name, label: shown, sub: printer.displayName && printer.displayName !== printer.name ? printer.name : '', badges }));
      }
    }
    if (query.trim() && visible.length === 0) {
      out.push(h('div', { class: 'picker__empty' }, h('p', { class: 'picker__empty-title', text: `No printers match "${query.trim()}"` }), h('p', { text: 'Check the spelling or clear the search.' })));
    }
    return out;
  }

  /**
   * Scrolls the list (not the page) so the checked row sits in the middle of it.
   * @returns {boolean} false when the list has no layout yet (its tab is hidden), so the caller has to try again once it has one
   */
  function revealSelected() {
    const list = box.querySelector('.picker__list');
    if (!list) return true;
    if (!list.clientHeight) return false;
    const row = list.querySelector('.picker__row:has(:checked)');
    if (row) {
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      list.scrollTop = Math.max(0, top - (list.clientHeight - row.offsetHeight) / 2);
    }
    return true;
  }

  function renderList() {
    const total = items.length;
    searchWrap.hidden = total <= SEARCH_FROM;
    countEl.textContent = loading ? '' : kind === 'dymo' ? `${total} found` : `${total} ${plural(total, 'printer')}`;
    box.setAttribute('aria-busy', String(loading || refreshing));
    liveNote.hidden = !(loading && slow);
    liveNote.textContent = 'Still looking for printers. This can take a few seconds.';

    let content;
    if (loading && kind === 'system') {
      content = skeletons(3);
    } else if (error && kind === 'system') {
      content = emptyState({ iconName: 'alert-circle', heading: "Couldn't read the printer list", text: `${error} Press Refresh to try again.` });
    } else if (kind === 'system' && total === 0 && !selected) {
      content = emptyState({ iconName: 'printer', heading: 'No printers found', text: 'Install your printer in the system settings, then press Refresh.' });
    } else {
      const list = h('div', { class: 'picker__list', role: 'radiogroup', 'aria-labelledby': titleId }, rows());
      content = loading ? h('div', null, list, skeletons(2)) : list;
    }
    box.replaceChildren(content);
    // A search shows its matches from the top; every other render lands on the checked row.
    reveal = !query.trim();
    if (reveal && revealSelected()) reveal = false;
  }

  renderList();
  // A list built inside a hidden tab has no layout: finish the job when the box first gets a size. It never fires again for
  // a list that was revealed, so a window resize does not move a list the person has scrolled.
  new ResizeObserver(() => {
    if (reveal && revealSelected()) reveal = false;
  }).observe(box);

  return {
    el: root,
    /** @param {{items?:any[], error?:string, loading?:boolean}} data */
    setData(data) {
      if ('items' in data) items = Array.isArray(data.items) ? data.items : [];
      if ('error' in data) error = data.error || '';
      if ('loading' in data) loading = !!data.loading;
      renderList();
    },
    setSelected(value) {
      selected = value || '';
      renderList();
    },
    /** Shows the "still looking" note when a slow first load drags on. */
    setSlow(value) {
      slow = !!value;
      renderList();
    },
    setRefreshing(value) {
      refreshing = !!value;
      setBusy(refreshBtn, refreshing);
      box.setAttribute('aria-busy', String(loading || refreshing));
    },
    setDisabled(value) {
      disabled = !!value;
      for (const input of box.querySelectorAll('input')) input.disabled = disabled;
    },
    get selected() {
      return selected;
    },
  };
}
