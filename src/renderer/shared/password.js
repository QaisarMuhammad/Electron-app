/*
 * password.html - the small window that asks for the cash drawer password (SPEC 10, 14).
 *
 * Talks only to window.desktop.password and window.desktop.window (SPEC 6.2/6.3). Enter submits (a real form), Escape cancels,
 * a wrong password shows Result.message inline, "too many wrong passwords" shows a live countdown and locks the field until it
 * ends. Optional query ?purpose=drawer|settings|generic only chooses the wording from a fixed list; nothing from the query is
 * ever written to the page.
 */
import { $, hydrateIcons, call, messageOf, setBusy, setFieldError, showStatus, bindReveal, createLockout, announce } from './ui.js';
import { normalizeLockout, formatClock } from './format.mjs';

const PURPOSES = {
  drawer: { icon: 'drawer', title: 'Open cash drawer', desc: 'Enter the drawer password to open it.', submit: 'Open drawer', done: 'The drawer is opening.' },
  settings: { icon: 'lock', title: 'Settings are protected', desc: 'Enter the drawer password to open Settings.', submit: 'Continue', done: 'Opening Settings.' },
  generic: { icon: 'lock', title: 'Enter password', desc: 'Enter the password to continue.', submit: 'Continue', done: 'Done.' },
};

const desktop = window.desktop;
const requested = new URLSearchParams(location.search).get('purpose');
const purpose = PURPOSES[Object.hasOwn(PURPOSES, requested) ? requested : 'drawer'];

const el = {
  form: $('#form'),
  icon: $('#pw-icon'),
  title: $('#pw-title'),
  desc: $('#pw-desc'),
  input: $('#pw-input'),
  reveal: $('#pw-reveal'),
  error: $('#pw-error'),
  status: $('#pw-status'),
  banner: $('#lock-banner'),
  lockTime: $('#lock-time'),
  cancel: $('#pw-cancel'),
  submit: $('#pw-submit'),
  submitLabel: $('#pw-submit-label'),
};

const lockout = createLockout();
let busy = false;
let finished = false;
let wasLocked = false;

el.icon.dataset.icon = purpose.icon;
hydrateIcons(document);
el.title.textContent = purpose.title;
el.desc.textContent = purpose.desc;
el.submitLabel.textContent = purpose.submit;
document.title = `GadgetsPOS - ${purpose.title}`;
bindReveal(el.input, el.reveal);

/** Locks or unlocks the form and shows the countdown while locked. */
function renderLock({ locked, remainingSec }) {
  el.banner.hidden = !locked;
  el.input.disabled = locked || finished;
  el.submit.setAttribute('aria-disabled', String(locked || finished));
  el.reveal.disabled = locked;
  if (locked) {
    el.lockTime.textContent = formatClock(remainingSec);
    setFieldError(el.input, el.error, null);
    showStatus(el.status, null);
    if (!wasLocked) announce(`Too many wrong passwords. Try again in ${formatClock(remainingSec)}.`);
  } else if (wasLocked) {
    announce('You can try again now.');
    if (!finished) el.input.focus();
  }
  wasLocked = locked;
}
lockout.subscribe(renderLock);

function applyLockout(raw) {
  const next = normalizeLockout(raw);
  lockout.start(next.locked ? next.retryAfterSec : 0);
}

async function submit() {
  if (busy || finished || lockout.locked) return;
  const value = el.input.value;
  if (!value) {
    setFieldError(el.input, el.error, 'Enter the password.');
    el.input.focus();
    return;
  }
  busy = true;
  setFieldError(el.input, el.error, null);
  showStatus(el.status, null);
  setBusy(el.submit, true);
  el.input.readOnly = true;

  const result = await call(desktop.password.submit, value);

  setBusy(el.submit, false);
  el.input.readOnly = false;
  busy = false;

  if (result.ok) {
    finished = true;
    el.input.value = '';
    el.input.disabled = true;
    el.submit.setAttribute('aria-disabled', 'true');
    showStatus(el.status, 'success', purpose.done);
    // Main closes this window on success; if it is still open a moment later, close it from here.
    setTimeout(() => call(desktop.window.close), 1500);
    return;
  }
  const lock = normalizeLockout(result);
  if (lock.locked) {
    el.input.value = '';
    applyLockout(result);
    return;
  }
  if (result.code === 'DRAWER_FAILED' || result.code === 'PORT_WRITE_FAILED' || result.code === 'SPOOLER_ERROR' || result.code === 'NO_PRINTER_CONFIGURED') {
    showStatus(el.status, 'danger', messageOf(result));
    return;
  }
  setFieldError(el.input, el.error, messageOf(result, 'That password is not correct. Please try again.'));
  el.input.select();
  el.input.focus();
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
el.input.addEventListener('input', () => {
  if (el.input.getAttribute('aria-invalid')) setFieldError(el.input, el.error, null);
});
el.cancel.addEventListener('click', () => call(desktop.password.cancel));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    call(desktop.password.cancel);
  }
});

if (desktop && desktop.password) {
  desktop.password.onLockout(applyLockout);
  call(desktop.password.getLockout).then((result) => {
    applyLockout(result.value !== undefined ? result.value : result);
  });
}
el.input.focus();
performance.mark('gp-ready');
