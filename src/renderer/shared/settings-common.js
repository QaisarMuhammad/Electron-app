/*
 * Shared plumbing for the settings tabs: a tiny state store, the page-wide lockout banner, dialog lockout notices and the
 * context object every tab receives. Tabs never talk to each other; they only read the store and call ctx helpers.
 */
import { h, icon, $, announce, createLockout, messageOf } from './ui.js';
import { formatClock, normalizeLockout } from './format.mjs';

/** Minimal observable state: set() replaces, merge() shallow-merges known top-level keys, subscribe() replays at once. */
export function createStore(initial = {}) {
  let state = initial;
  const subscribers = new Set();
  const emit = () => {
    for (const fn of subscribers) fn(state);
  };
  return {
    get: () => state,
    set(next) {
      state = next || {};
      emit();
    },
    /** main may push the whole state or only the part that changed (for example { update }) */
    merge(patch) {
      if (patch && typeof patch === 'object') {
        state = { ...state, ...patch };
        emit();
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      fn(state);
      return () => subscribers.delete(fn);
    },
  };
}

/**
 * Builds the context handed to every tab.
 * @param {{desktop:any, toaster:any, store:any, setDirty:(tab:string, dirty:boolean)=>void, reloadState:()=>Promise<void>}} deps
 */
export function createContext({ desktop, toaster, store, setDirty, reloadState }) {
  const lockout = createLockout();
  return {
    desktop,
    store,
    lockout,
    toast: toaster,
    setDirty,
    reloadState,
    announce,
    get platform() {
      return (store.get().platform || desktop.platform || '').toString();
    },
    /** Passes a Result through, starting the shared lockout countdown when it says "too many wrong passwords". */
    guard(result) {
      const lock = normalizeLockout(result);
      if (lock.locked) lockout.start(lock.retryAfterSec);
      return result;
    },
  };
}

/** Wires the page-wide banner that appears while password checks are paused. */
export function bindLockoutBanner(lockout) {
  const banner = $('#lock-banner');
  const time = $('#lock-time');
  let was = false;
  lockout.subscribe(({ locked, remainingSec }) => {
    banner.hidden = !locked;
    if (locked) {
      time.textContent = formatClock(remainingSec);
      if (!was) announce(`Too many wrong passwords. Password checks are paused for ${formatClock(remainingSec)}.`);
    } else if (was) {
      announce('You can try your password again now.');
    }
    was = locked;
  });
}

/**
 * Shows a countdown notice inside a dialog and pauses its submit button while the lockout lasts.
 * @returns {() => void} unsubscribe
 */
export function attachDialogLockout(dialog, lockout) {
  const time = h('strong', { class: 'tabular' });
  const notice = h(
    'div',
    { class: 'banner banner--warning', hidden: true },
    h('span', { class: 'banner__icon' }, icon('lock')),
    h('div', { class: 'banner__body' }, h('p', { class: 'banner__title', text: 'Too many wrong passwords' }), h('p', { class: 'banner__text' }, 'Try again in ', time, '.')),
  );
  dialog.body.prepend(notice);
  return lockout.subscribe(({ locked, remainingSec }) => {
    notice.hidden = !locked;
    time.textContent = formatClock(remainingSec);
    dialog.submitBtn.setAttribute('aria-disabled', String(locked));
  });
}

/**
 * Text for a failed password-protected action. While the lockout is active the main process message carries a number that is
 * already stale a second later, so the page says "wait" and the banner shows the live countdown instead.
 */
export const failureText = (ctx, result) => (ctx.lockout.locked ? 'Too many wrong passwords. Please wait for the countdown.' : messageOf(result));
