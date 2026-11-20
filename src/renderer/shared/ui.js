/*
 * GadgetsPOS Desktop - small DOM toolkit for the local pages: element builder, toast, modal dialog, accessible tab list,
 * lockout countdown, form and status helpers. No framework, no build step, no global state beyond one live region.
 *
 * Text is only ever written with textContent / text nodes (h() never parses HTML), so printer names, query-string
 * values and error messages cannot inject markup. Nothing here sets a style attribute (the page CSP forbids them).
 */
import { icon, hydrateIcons } from './icons.js';

export { icon, hydrateIcons };

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let uidCounter = 0;
/** Unique, stable-per-page id for aria wiring. */
const uid = (prefix = 'id') => `${prefix}-${++uidCounter}`;

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'indeterminate']);

/**
 * Hyperscript: h('button', { class: 'btn', on: { click } }, 'Save').
 * props: class, text, dataset {}, on {event: fn}, value/checked/disabled/hidden (properties), anything else is an
 * attribute (null, undefined and false are skipped, true becomes an empty attribute). Children: strings, numbers, Nodes,
 * arrays (flattened); null/undefined/false are skipped.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'on') for (const [name, fn] of Object.entries(value)) el.addEventListener(name, fn);
      else if (PROPERTY_KEYS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendAll(el, children);
  return el;
}

function appendAll(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendAll(parent, child);
    else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replaces the children of `el` with `children` (same rules as h()). */
export function replaceChildrenOf(el, ...children) {
  const frag = document.createDocumentFragment();
  appendAll(frag, children);
  el.replaceChildren(frag);
}

/**
 * Calls a window.desktop function and always returns a Result. A rejected call or a missing result becomes a friendly
 * failure instead of an unhandled error (the raw error goes to the console for support).
 * @param {(...args:any[]) => Promise<any>|any} fn
 */
export async function call(fn, ...args) {
  let out;
  try {
    out = await fn(...args);
  } catch (error) {
    console.warn('desktop call failed', error);
    return { ok: false, code: 'UNKNOWN', message: 'Something went wrong. Please try again.' };
  }
  if (out && typeof out === 'object' && 'ok' in out) return out;
  return { ok: true, value: out };
}

/** Plain-English fallback when a failed Result has no message. */
export const messageOf = (result, fallback = 'Something went wrong. Please try again.') =>
  (result && typeof result.message === 'string' && result.message.trim()) || fallback;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Live region                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

let liveRegion = null;

/** Speaks a short message to screen readers without showing anything. */
export function announce(message) {
  if (!liveRegion) {
    liveRegion = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveRegion);
  }
  liveRegion.textContent = '';
  setTimeout(() => {
    liveRegion.textContent = message;
  }, 30);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Buttons and status lines                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Shows or hides the spinner of a .btn (the spinner element is created on first use). */
export function setBusy(button, busy) {
  if (!button) return;
  if (busy && !button.querySelector(':scope > .spinner')) {
    button.prepend(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  }
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

const TONE_ICON = { success: 'check-circle', danger: 'alert-circle', warning: 'alert', info: 'info' };

/**
 * Fills a persistent aria-live slot with an icon + message, or empties it. The slot itself is never hidden, so screen
 * readers announce the change.
 * @param {HTMLElement} slot
 * @param {'success'|'danger'|'warning'|'info'|'neutral'|null} tone null clears the slot
 * @param {string} [text]
 */
export function showStatus(slot, tone, text = '') {
  if (!slot) return;
  if (!tone || !text) {
    slot.replaceChildren();
    return;
  }
  const line = h('span', { class: `status status--${tone}` });
  if (TONE_ICON[tone]) line.append(icon(TONE_ICON[tone]));
  line.append(h('span', { class: 'status__text', text }));
  slot.replaceChildren(line);
}

/**
 * Shows or clears the error line under a field and keeps aria-invalid / aria-describedby in step. A shown error is an
 * alert (an assertive live region), so a screen reader speaks it even when focus does not move, which is the usual case:
 * the person is already in the field that failed. The body-level live region of announce() would stay silent here, because
 * everything outside an open modal dialog is inert.
 * @param {HTMLInputElement} input
 * @param {HTMLElement} slot an element with a stable id, usually class "field__error"
 * @param {string|null} message
 */
export function setFieldError(input, slot, message) {
  if (!input || !slot) return;
  const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (message) {
    slot.replaceChildren(icon('alert-circle'), h('span', { text: message }));
    slot.setAttribute('role', 'alert');
    slot.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    ids.add(slot.id);
  } else {
    slot.replaceChildren();
    slot.hidden = true;
    input.removeAttribute('aria-invalid');
    ids.delete(slot.id);
  }
  if (ids.size) input.setAttribute('aria-describedby', [...ids].join(' '));
  else input.removeAttribute('aria-describedby');
}

/** Wires a show/hide button to a password input (aria-pressed, label and icon follow the state). */
export function bindReveal(input, button) {
  const render = () => {
    const shown = input.type === 'text';
    button.setAttribute('aria-pressed', String(shown));
    button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    button.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
  };
  button.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    render();
    input.focus();
  });
  render();
}

/** Copies text to the clipboard; falls back to execCommand because file pages may not be granted the Clipboard API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  const area = h('textarea', { class: 'sr-only', 'aria-hidden': 'true', tabindex: '-1', readOnly: true, value: text });
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Toasts                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const TOAST_ICON = { success: 'check-circle', danger: 'alert-circle', warning: 'alert', info: 'info' };
const TOAST_MS = { success: 4000, info: 5000, warning: 8000, danger: 10000 };

/**
 * Toast stack. `container` should be <div class="toasts" aria-live="polite">. Toasts pause while hovered or focused,
 * errors use role="alert" so they are announced at once, at most three are kept.
 * @param {HTMLElement} container
 */
export function createToaster(container) {
  const dismiss = (toast) => {
    if (!toast.isConnected || toast.dataset.leaving) return;
    toast.dataset.leaving = 'true';
    setTimeout(() => toast.remove(), 220);
  };

  function show({ kind = 'info', message, actionLabel = '', onAction = null, timeout = 0 }) {
    const toast = h('div', { class: `toast toast--${kind}`, role: kind === 'danger' ? 'alert' : null });
    toast.append(h('span', { class: 'toast__icon' }, icon(TOAST_ICON[kind] || 'info')), h('span', { class: 'toast__text', text: message }));
    if (actionLabel && onAction) {
      toast.append(
        h('button', {
          type: 'button',
          class: 'toast__action',
          text: actionLabel,
          on: {
            click: () => {
              dismiss(toast);
              onAction();
            },
          },
        }),
      );
    }
    toast.append(
      h('button', { type: 'button', class: 'toast__close', 'aria-label': 'Dismiss', on: { click: () => dismiss(toast) } }, icon('x', 'icon--sm')),
    );

    let timer = 0;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => dismiss(toast), timeout || (actionLabel ? 10000 : TOAST_MS[kind] || 5000));
    };
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('focusin', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('focusout', arm);

    container.append(toast);
    while (container.children.length > 3) container.firstElementChild.remove();
    arm();
    return { dismiss: () => dismiss(toast), el: toast };
  }

  return {
    show,
    success: (message, extra = {}) => show({ kind: 'success', message, ...extra }),
    error: (message, extra = {}) => show({ kind: 'danger', message, ...extra }),
    warn: (message, extra = {}) => show({ kind: 'warning', message, ...extra }),
    info: (message, extra = {}) => show({ kind: 'info', message, ...extra }),
    clear: () => container.replaceChildren(),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Dialog                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A modal <dialog> with a header, a body you fill, an error banner and Cancel / submit buttons.
 *
 *   const d = createDialog({ title: 'Change password', icon: 'key', submitLabel: 'Change password' });
 *   d.body.append(field1, field2);
 *   d.onSubmit(async () => { const r = await save(); if (r.ok) d.close(true); else d.setError(r.message); });
 *   const done = await d.open();          // resolves with the value given to close(), or null for Esc/Cancel
 *
 * Escape and Cancel close it (not while busy); a click on the backdrop does NOT, so a typo cannot lose what was typed.
 * showModal() traps focus and restores it to the opener when the dialog closes.
 * @param {{title:string, description?:string, icon?:string, submitLabel?:string, cancelLabel?:string, danger?:boolean, hideCancel?:boolean}} options
 */
export function createDialog({ title, description = '', icon: iconName = '', submitLabel = 'OK', cancelLabel = 'Cancel', danger = false, hideCancel = false }) {
  const titleId = uid('dlg-title');
  const descId = uid('dlg-desc');
  let busy = false;
  let submitHandler = null;
  let result = null;
  let settle = () => {};

  const submitBtn = h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger-solid' : 'btn--primary'}` }, h('span', { text: submitLabel }));
  const cancelBtn = h('button', { type: 'button', class: 'btn', text: cancelLabel });
  const errorBox = h('div', { class: 'banner banner--danger', role: 'alert', hidden: true });
  const body = h('div', { class: 'dialog__body' });
  const form = h(
    'form',
    { class: 'dialog__form', novalidate: true },
    h(
      'div',
      { class: 'dialog__head' },
      iconName ? h('span', { class: `tile${danger ? ' tile--danger' : ''}` }, icon(iconName)) : null,
      h('div', null, h('h2', { class: 'dialog__title', id: titleId, text: title }), description ? h('p', { class: 'dialog__desc', id: descId, text: description }) : null),
    ),
    body,
    h('div', { class: 'dialog__foot' }, hideCancel ? null : cancelBtn, submitBtn),
  );
  const el = h('dialog', { class: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': description ? descId : null }, form);

  const api = {
    el,
    body,
    submitBtn,
    cancelBtn,
    get busy() {
      return busy;
    },
    /** Marks the dialog as working: spinner on the submit button, Cancel and Escape paused. */
    setBusy(value) {
      busy = value;
      setBusy(submitBtn, value);
      cancelBtn.disabled = value;
    },
    /** Shows an error banner above the buttons (null hides it). */
    setError(message) {
      if (!message) {
        errorBox.hidden = true;
        errorBox.replaceChildren();
        return;
      }
      errorBox.replaceChildren(
        h('span', { class: 'banner__icon' }, icon('alert-circle')),
        h('div', { class: 'banner__body' }, h('p', { class: 'banner__text', text: message })),
      );
      errorBox.hidden = false;
      if (!errorBox.isConnected) body.append(errorBox);
    },
    onSubmit(fn) {
      submitHandler = fn;
    },
    open() {
      body.append(errorBox);
      document.body.append(el);
      el.showModal();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    close(value = true) {
      result = value;
      if (el.open) el.close();
    },
  };

  el.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  cancelBtn.addEventListener('click', () => api.close(null));
  el.addEventListener('close', () => {
    el.remove();
    settle(result);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !submitHandler || submitBtn.getAttribute('aria-disabled') === 'true') return;
    api.setError(null);
    api.setBusy(true);
    try {
      await submitHandler(api);
    } catch (error) {
      console.warn('dialog submit failed', error);
      api.setError('Something went wrong. Please try again.');
    }
    api.setBusy(false);
  });
  return api;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Tabs                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Accessible tab list (WAI-ARIA tabs pattern, automatic activation): roving tabindex, Arrow keys move and select,
 * Home / End jump to the ends, selection wraps. Both arrow axes work so the same list is usable vertically (side rail)
 * and horizontally (narrow window).
 * @param {{tablist:HTMLElement, tabs:HTMLElement[], panels:Record<string, HTMLElement>, initial:string, onChange?:(id:string)=>void}} options
 *   Each tab needs data-tab="<id>"; panels are keyed by the same id.
 */
export function createTabs({ tablist, tabs, panels, initial, onChange = () => {} }) {
  let current = '';
  const ids = tabs.map((t) => t.dataset.tab);

  function select(id, { focus = false, silent = false } = {}) {
    if (!ids.includes(id)) id = ids[0];
    for (const tab of tabs) {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
    const changed = id !== current;
    current = id;
    if (changed && !silent) onChange(id);
  }

  tablist.addEventListener('keydown', (event) => {
    const index = ids.indexOf(current);
    let next = -1;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (index + 1) % ids.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (index - 1 + ids.length) % ids.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(ids[next], { focus: true });
  });
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.tab));

  select(initial, { silent: true });
  return { select, get current() { return current; }, ids };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Lockout                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Shared "too many wrong passwords" countdown. The throttle in the main process applies to every password check, so the
 * whole page shares one of these. The 1-second timer exists only while the lock is active.
 * @param {{now?:()=>number}} [options]
 */
export function createLockout({ now = () => Date.now() } = {}) {
  let until = 0;
  let timer = 0;
  const subscribers = new Set();

  const remainingSec = () => Math.max(0, Math.ceil((until - now()) / 1000));
  const snapshot = () => ({ locked: remainingSec() > 0, remainingSec: remainingSec() });
  const emit = () => {
    const state = snapshot();
    for (const fn of subscribers) fn(state);
    return state;
  };
  const tick = () => {
    if (!emit().locked) {
      clearInterval(timer);
      timer = 0;
    }
  };

  return {
    /** Starts (or replaces) a lock for `seconds`. 0 or less clears it. */
    start(seconds) {
      clearInterval(timer);
      timer = 0;
      until = seconds > 0 ? now() + seconds * 1000 : 0;
      emit();
      if (seconds > 0) timer = setInterval(tick, 1000);
    },
    clear() {
      this.start(0);
    },
    get locked() {
      return remainingSec() > 0;
    },
    remainingSec,
    /** Calls fn immediately and on every change; returns an unsubscribe function. */
    subscribe(fn) {
      subscribers.add(fn);
      fn(snapshot());
      return () => subscribers.delete(fn);
    },
  };
}
