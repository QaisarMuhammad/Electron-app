/*
 * Settings > Cash drawer (SPEC 10, 14): password status with a Set/Change dialog, the drawer settings (enable, pin, pulse length,
 * ask for the password before Settings opens), "Open drawer (test)", the lockout countdown and the "Forgot the password?" help.
 *
 * The controls are the draft; "saved" is what the main process has. Saving needs the drawer password when one is set, and every
 * password check shares one lockout (SPEC 10), so a wrong password only ever shows Result.message and a pause countdown.
 */
import { $, h, icon, call, messageOf, setBusy, showStatus, setFieldError, createDialog, announce, copyText } from './ui.js';
import { passwordStrength, sameJson, isWrongPasswordCode } from './format.mjs';
import { attachDialogLockout, failureText } from './settings-common.js';

const PULSE_MESSAGE = 'Enter a whole number from 2 to 510.';
const unsavedIndicator = () => h('span', { class: 'status status--warning status--dot' }, h('span', { class: 'dot dot--warning' }), h('span', { class: 'status__text', text: 'Unsaved changes' }));

export function mountDrawer(ctx) {
  const el = {
    badge: $('#pw-badge'),
    text: $('#pw-text'),
    open: $('#pw-open'),
    openLabel: $('#pw-open-label'),
    weak: $('#pw-weak'),
    form: $('#drawer-form'),
    enabled: $('#drawer-enabled'),
    protect: $('#drawer-protect'),
    pin2: $('#drawer-pin-2'),
    pin5: $('#drawer-pin-5'),
    on: $('#drawer-on'),
    onErr: $('#drawer-on-err'),
    off: $('#drawer-off'),
    offErr: $('#drawer-off-err'),
    pwField: $('#drawer-pw-field'),
    pw: $('#drawer-pw'),
    pwErr: $('#drawer-pw-err'),
    status: $('#drawer-status'),
    save: $('#drawer-save'),
    testForm: $('#drawer-test-form'),
    testField: $('#drawer-test-field'),
    testPw: $('#drawer-test-pw'),
    test: $('#drawer-test'),
    testStatus: $('#drawer-test-status'),
    forgotPath: $('#forgot-path'),
    forgotBody: $('#forgot .disclosure__body'),
  };

  let saved = { enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, requirePasswordForSettings: false };
  let filled = false;
  let passwordSet = false;
  let result = null;
  let busy = false;
  let copyButton = null;
  let testHintShown = false;

  const readForm = () => ({
    enabled: el.enabled.checked,
    pin: el.pin5.checked ? 5 : 2,
    onTimeMs: el.on.value === '' ? Number.NaN : Number(el.on.value),
    offTimeMs: el.off.value === '' ? Number.NaN : Number(el.off.value),
    requirePasswordForSettings: el.protect.checked,
  });
  const isDirty = () => !sameJson(readForm(), saved);
  const validPulse = (value) => Number.isInteger(value) && value >= 2 && value <= 510;

  function writeForm(values) {
    el.enabled.checked = !!values.enabled;
    el.protect.checked = !!values.requirePasswordForSettings;
    el.pin2.checked = values.pin !== 5;
    el.pin5.checked = values.pin === 5;
    el.on.value = String(values.onTimeMs);
    el.off.value = String(values.offTimeMs);
  }

  function renderStatus() {
    if (result) showStatus(el.status, result.tone, result.text);
    else if (isDirty()) el.status.replaceChildren(unsavedIndicator());
    else showStatus(el.status, null);
    el.save.setAttribute('aria-disabled', String(!isDirty() || busy));
    ctx.setDirty('drawer', isDirty());
  }

  function renderPassword(state) {
    const drawer = (state.config && state.config.drawer) || {};
    passwordSet = !!drawer.passwordSet;
    el.badge.className = `badge badge--${passwordSet ? 'success' : 'warning'}`;
    el.badge.replaceChildren(icon(passwordSet ? 'check' : 'alert'), passwordSet ? 'Password set' : 'No password');
    el.text.textContent = passwordSet
      ? 'Only people who know it can open the drawer or change these settings.'
      : 'No password is set yet. Set one before the drawer can be opened.';
    el.openLabel.textContent = passwordSet ? 'Change password' : 'Set password';
    el.weak.hidden = !(passwordSet && drawer.passwordWeak);
    el.pwField.hidden = !passwordSet;
    el.testField.hidden = !passwordSet;
    el.test.setAttribute('aria-disabled', String(!passwordSet));
    if (!passwordSet) {
      showStatus(el.testStatus, 'info', 'Set a password first, then you can test the drawer.');
      testHintShown = true;
    } else if (testHintShown) {
      showStatus(el.testStatus, null);
      testHintShown = false;
    }
  }

  function renderPath(state) {
    const folder = state.paths && state.paths.userData;
    if (!folder) return;
    el.forgotPath.textContent = folder;
    if (!copyButton) {
      copyButton = h(
        'button',
        {
          type: 'button',
          class: 'btn',
          on: {
            click: async () => {
              const ok = await copyText(el.forgotPath.textContent);
              ctx.toast[ok ? 'success' : 'error'](ok ? 'Folder path copied.' : 'Could not copy. Select the path and copy it by hand.');
            },
          },
        },
        icon('copy'),
        h('span', { text: 'Copy folder path' }),
      );
      el.forgotBody.insertBefore(h('div', { class: 'row' }, copyButton), el.forgotBody.lastElementChild);
    }
  }

  ctx.store.subscribe((state) => {
    const drawer = (state.config && state.config.drawer) || {};
    const wasDirty = filled && isDirty();
    filled = true;
    saved = {
      enabled: drawer.enabled !== false,
      pin: drawer.pin === 5 ? 5 : 2,
      onTimeMs: Number.isFinite(drawer.onTimeMs) ? drawer.onTimeMs : 50,
      offTimeMs: Number.isFinite(drawer.offTimeMs) ? drawer.offTimeMs : 510,
      requirePasswordForSettings: !!drawer.requirePasswordForSettings,
    };
    if (!wasDirty) writeForm(saved);
    renderPassword(state);
    renderPath(state);
    renderStatus();
  });

  /* ---- drawer settings form ---- */
  const touched = () => {
    result = null;
    setFieldError(el.on, el.onErr, null);
    setFieldError(el.off, el.offErr, null);
    renderStatus();
  };
  for (const control of [el.enabled, el.protect, el.pin2, el.pin5, el.on, el.off]) control.addEventListener('input', touched);
  for (const control of [el.enabled, el.protect, el.pin2, el.pin5]) control.addEventListener('change', touched);

  async function save() {
    if (busy || !isDirty()) return;
    const form = readForm();
    let invalid = null;
    if (!validPulse(form.onTimeMs)) {
      setFieldError(el.on, el.onErr, PULSE_MESSAGE);
      invalid = invalid || el.on;
    }
    if (!validPulse(form.offTimeMs)) {
      setFieldError(el.off, el.offErr, PULSE_MESSAGE);
      invalid = invalid || el.off;
    }
    if (!invalid && passwordSet && !el.pw.value) {
      setFieldError(el.pw, el.pwErr, 'Enter the drawer password to save.');
      invalid = el.pw;
    }
    if (invalid) {
      invalid.focus();
      return;
    }
    if (ctx.lockout.locked) {
      result = { tone: 'danger', text: 'Password checks are paused. Please wait for the countdown to end.' };
      renderStatus();
      return;
    }
    busy = true;
    setBusy(el.save, true);
    setFieldError(el.pw, el.pwErr, null);
    renderStatus();
    const response = ctx.guard(await call(ctx.desktop.settings.saveDrawerSettings, { ...form, password: passwordSet ? el.pw.value : '' }));
    busy = false;
    setBusy(el.save, false);
    if (response.ok) {
      saved = form;
      el.pw.value = '';
      result = { tone: 'success', text: 'Saved' };
      announce('Drawer settings saved.');
    } else if (isWrongPasswordCode(response.code)) {
      setFieldError(el.pw, el.pwErr, messageOf(response));
      el.pw.focus();
      el.pw.select();
    } else {
      result = { tone: 'danger', text: failureText(ctx, response) };
    }
    renderStatus();
  }
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  el.pw.addEventListener('input', () => setFieldError(el.pw, el.pwErr, null));

  /* ---- test the drawer ---- */
  async function testDrawer() {
    if (!passwordSet || busy) return;
    if (!el.testPw.value) {
      showStatus(el.testStatus, 'danger', 'Enter the drawer password.');
      el.testPw.focus();
      return;
    }
    if (ctx.lockout.locked) {
      showStatus(el.testStatus, 'danger', 'Password checks are paused. Please wait for the countdown to end.');
      return;
    }
    setBusy(el.test, true);
    showStatus(el.testStatus, null);
    const response = ctx.guard(await call(ctx.desktop.settings.openDrawerTest, { password: el.testPw.value }));
    setBusy(el.test, false);
    if (response.ok) {
      el.testPw.value = '';
      showStatus(el.testStatus, 'success', 'Open command sent. The drawer should open now.');
    } else {
      showStatus(el.testStatus, 'danger', failureText(ctx, response));
      if (isWrongPasswordCode(response.code)) el.testPw.select();
    }
    announce(el.testStatus.textContent);
  }
  el.testForm.addEventListener('submit', (event) => {
    event.preventDefault();
    testDrawer();
  });

  /* ---- set / change password ---- */
  function passwordField(id, label, hint) {
    const input = h('input', { class: 'input', id, type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-hint ${id}-err` });
    const error = h('div', { class: 'field__error', id: `${id}-err`, hidden: true });
    const node = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id, text: label }), input, hint ? h('p', { class: 'field__hint', id: `${id}-hint`, text: hint }) : null, error);
    return { node, input, error };
  }

  async function openPasswordDialog(opener) {
    const changing = passwordSet;
    const dialog = createDialog({
      title: changing ? 'Change drawer password' : 'Set drawer password',
      description: changing ? 'Enter the current password, then choose a new one.' : 'Choose a password for the cash drawer. You will need it to open the drawer.',
      icon: 'key',
      submitLabel: changing ? 'Change password' : 'Set password',
    });
    const current = changing ? passwordField('dlg-current', 'Current password') : null;
    const next = passwordField('dlg-new', 'New password', 'Use 4 to 64 characters. A longer password is safer.');
    const confirm = passwordField('dlg-confirm', 'Confirm new password');
    const meter = h('div', { class: 'meter', 'data-level': '0', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    const meterText = h('p', { class: 'field__hint', 'aria-live': 'polite' });
    const reveal = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id: 'dlg-reveal' });
    const revealRow = h('label', { class: 'switch-row switch-row--compact' }, h('span', { class: 'switch-row__text' }, h('span', { class: 'switch-row__title', text: 'Show passwords' })), reveal);

    const inputs = [current && current.input, next.input, confirm.input].filter(Boolean);
    reveal.addEventListener('change', () => {
      for (const input of inputs) input.type = reveal.checked ? 'text' : 'password';
    });
    next.input.addEventListener('input', () => {
      const strength = passwordStrength(next.input.value);
      meter.dataset.level = String(strength.level);
      meterText.textContent = strength.label ? `Strength: ${strength.label}` : '';
      setFieldError(next.input, next.error, null);
    });
    confirm.input.addEventListener('input', () => setFieldError(confirm.input, confirm.error, null));
    if (current) current.input.addEventListener('input', () => setFieldError(current.input, current.error, null));

    dialog.body.append(...[current && current.node, next.node, meter, meterText, confirm.node, revealRow].filter(Boolean));
    const stopLockout = attachDialogLockout(dialog, ctx.lockout);

    dialog.onSubmit(async () => {
      let invalid = null;
      const flag = (field, message) => {
        setFieldError(field.input, field.error, message);
        invalid = invalid || field.input;
      };
      if (current && !current.input.value) flag(current, 'Enter your current password.');
      const value = next.input.value;
      if (value.length < 4 || value.length > 64) flag(next, 'The new password must be 4 to 64 characters long.');
      else if (current && value === current.input.value) flag(next, 'Choose a different password from the current one.');
      if (!invalid && confirm.input.value !== value) flag(confirm, 'The two new passwords are not the same.');
      if (invalid) {
        invalid.focus();
        return;
      }
      if (ctx.lockout.locked) return;
      const response = ctx.guard(await call(ctx.desktop.settings.setDrawerPassword, { current: current ? current.input.value : '', next: value }));
      if (!response.ok && ctx.lockout.locked) {
        for (const field of [current, next, confirm]) if (field) setFieldError(field.input, field.error, null);
        return;
      }
      if (response.ok) {
        dialog.close(true);
        ctx.toast.success(changing ? 'Drawer password changed.' : 'Drawer password set.');
        return;
      }
      if (isWrongPasswordCode(response.code) && current) {
        setFieldError(current.input, current.error, messageOf(response));
        current.input.focus();
        current.input.select();
      } else if (response.code === 'PASSWORD_TOO_SHORT') {
        setFieldError(next.input, next.error, messageOf(response));
        next.input.focus();
      } else if (!ctx.lockout.locked) {
        dialog.setError(messageOf(response));
      }
    });

    await dialog.open();
    stopLockout();
    if (opener && opener.isConnected) opener.focus();
  }

  el.open.addEventListener('click', () => openPasswordDialog(el.open));
}
