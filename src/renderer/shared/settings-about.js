/*
 * Settings > About & updates (SPEC 13, 14, 18b S3): version details, every update state with the right button, the collapsible
 * "Startup details" table, logs / diagnostics for support, and the guarded factory reset (type RESET, plus the drawer password
 * when one is set). Update status arrives from getState(), from onState pushes and from the Check button.
 */
import { $, h, icon, call, messageOf, setBusy, createDialog, setFieldError, announce } from './ui.js';
import { formatMs, normalizeStartup, isWrongPasswordCode } from './format.mjs';
import { attachDialogLockout } from './settings-common.js';

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** What each update status says. `percent` is 0..100 or null. */
function describeUpdate(update) {
  if (!update || !update.status) {
    return { status: 'unknown', icon: 'info', title: 'Not checked yet', sub: 'Press Check for updates to look for a new version.', check: true };
  }
  const status = String(update.status);
  const version = update && update.version ? `version ${update.version}` : 'a new version';
  const percent = [update && update.percent, update && update.progress && update.progress.percent, update && update.progress]
    .map(Number)
    .find((value) => Number.isFinite(value));
  switch (status) {
    case 'disabled':
      return { status, icon: 'info', title: 'Automatic updates are off', sub: 'This copy of GadgetsPOS is not set up to update itself. Ask your support team for the newest installer.' };
    case 'checking':
      return { status, spinner: true, title: 'Checking for updates...', sub: 'This takes a few seconds.', bar: 'indeterminate' };
    case 'available':
      return { status, icon: 'download', title: `${cap(version)} is available`, sub: 'It is being downloaded in the background.', bar: 'indeterminate' };
    case 'downloading':
      return {
        status,
        icon: 'download',
        title: `Downloading ${version}...`,
        sub: Number.isFinite(percent) ? `${Math.round(Math.min(100, Math.max(0, percent)))}% done` : 'Please keep GadgetsPOS open.',
        bar: Number.isFinite(percent) ? 'determinate' : 'indeterminate',
        percent,
      };
    case 'ready':
      return { status, icon: 'check-circle', title: `${cap(version)} is ready to install`, sub: 'GadgetsPOS closes and opens again. Your work in the POS is saved on the server.', install: true };
    case 'error':
      return { status, icon: 'alert-circle', title: "Couldn't check for updates", sub: (update && update.message) || 'Check your internet connection and try again.', check: true };
    default:
      return { status: 'none', icon: 'check-circle', title: 'GadgetsPOS is up to date', sub: '', check: true };
  }
}

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function mountAbout(ctx) {
  const el = {
    version: $('#about-version'),
    list: $('#about-list'),
    update: $('#update'),
    updateIcon: $('#update-icon'),
    headline: $('#update-headline'),
    sub: $('#update-sub'),
    barTrack: $('#update-bar-track'),
    bar: $('#update-bar'),
    actions: $('#update-actions'),
    install: $('#update-install'),
    check: $('#update-check'),
    startupBody: $('#startup-body'),
    logs: $('#open-logs'),
    diag: $('#copy-diag'),
    reset: $('#reset-open'),
  };
  let passwordSet = false;
  let currentVersion = '';
  let barAnimation = null;
  let barScale = 0;

  /** Moves the determinate bar with a Web Animation (transform only; no style attribute is ever written). */
  function setProgress(fraction) {
    const next = Math.min(1, Math.max(0, fraction));
    if (barAnimation) barAnimation.cancel();
    barAnimation = el.bar.animate([{ transform: `scaleX(${barScale})` }, { transform: `scaleX(${next})` }], { duration: 320, easing: 'ease-out', fill: 'forwards' });
    barScale = next;
  }
  function clearProgress() {
    if (barAnimation) barAnimation.cancel();
    barAnimation = null;
    barScale = 0;
  }

  function renderInfo(state) {
    currentVersion = state.version || (ctx.desktop && ctx.desktop.version) || '';
    el.version.textContent = currentVersion ? `Version ${currentVersion}` : 'Version unknown';
    const platform = PLATFORM_NAMES[state.platform] || state.platform || '';
    const rows = [
      ['Operating system', [platform, state.arch].filter(Boolean).join(' '), false],
      ['Electron', state.versions && state.versions.electron, false],
      ['Chromium', state.versions && state.versions.chrome, false],
      ['Data folder', state.paths && state.paths.userData, true],
      ['Settings file', state.paths && state.paths.configFile, true],
      ['Logs folder', state.paths && state.paths.logsDir, true],
    ].filter(([, value]) => value);
    el.list.replaceChildren(...rows.flatMap(([label, value, mono]) => [h('dt', { text: label }), h('dd', { class: mono ? 'mono' : '', text: String(value) })]));
  }

  function renderUpdate(update) {
    const info = describeUpdate(update);
    el.update.dataset.status = info.status;
    el.updateIcon.replaceChildren(info.spinner ? h('span', { class: 'spinner' }) : icon(info.icon));
    el.headline.textContent = info.title;
    el.sub.textContent = info.sub || (info.status === 'none' && currentVersion ? `You have version ${currentVersion}.` : '');
    el.barTrack.hidden = !info.bar;
    el.barTrack.classList.toggle('progress--indeterminate', info.bar === 'indeterminate');
    if (info.bar === 'determinate') setProgress(info.percent / 100);
    else clearProgress();
    el.install.hidden = !info.install;
    el.check.hidden = !info.check;
    el.actions.hidden = el.install.hidden && el.check.hidden;
  }

  function renderStartup(state) {
    const { rows, summary } = normalizeStartup(state.performance && state.performance.startup);
    if (!rows.length) {
      el.startupBody.replaceChildren(h('p', { class: 'muted', text: 'No startup details yet. They are recorded each time GadgetsPOS starts.' }));
      return;
    }
    const table = h(
      'table',
      { class: 'startup-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Step' }), h('th', { scope: 'col', text: 'Since start' }), h('th', { scope: 'col', text: 'Step took' }))),
      h('tbody', null, rows.map((row) => h('tr', null, h('td', { text: row.label }), h('td', { text: formatMs(row.at) }), h('td', { text: row.delta ? formatMs(row.delta) : '-' })))),
    );
    el.startupBody.replaceChildren(summary ? h('p', { text: summary }) : null, h('div', { class: 'table-wrap' }, table), h('p', { class: 'small muted', text: 'These times help your support team find slow starts.' }));
  }

  ctx.store.subscribe((state) => {
    passwordSet = !!(state.config && state.config.drawer && state.config.drawer.passwordSet);
    renderInfo(state);
    renderUpdate(state.update);
    renderStartup(state);
  });

  el.check.addEventListener('click', async () => {
    setBusy(el.check, true);
    ctx.store.merge({ update: { status: 'checking' } });
    const response = await call(ctx.desktop.settings.checkForUpdates);
    setBusy(el.check, false);
    // The answer is { status, ... } (or a Result carrying it); anything else is settled by reading the state again.
    const answer = response.value && typeof response.value === 'object' ? response.value : response;
    if (answer && answer.status) ctx.store.merge({ update: answer });
    else if (!response.ok) ctx.store.merge({ update: { status: 'error', message: messageOf(response) } });
    else await ctx.reloadState();
    announce(el.headline.textContent);
  });
  el.install.addEventListener('click', async () => {
    setBusy(el.install, true);
    const response = await call(ctx.desktop.settings.installUpdate);
    setBusy(el.install, false);
    if (!response.ok) ctx.toast.error(messageOf(response));
  });

  el.logs.addEventListener('click', async () => {
    setBusy(el.logs, true);
    const response = await call(ctx.desktop.settings.openLogsFolder);
    setBusy(el.logs, false);
    if (!response.ok) ctx.toast.error(messageOf(response, 'The logs folder could not be opened.'));
  });
  el.diag.addEventListener('click', async () => {
    setBusy(el.diag, true);
    const response = await call(ctx.desktop.settings.copyDiagnostics);
    setBusy(el.diag, false);
    if (response.ok) ctx.toast.success('Diagnostics copied. Paste them into your message to support.');
    else ctx.toast.error(messageOf(response, 'The diagnostics could not be copied.'));
  });

  /* ---- guarded factory reset ---- */
  async function openResetDialog() {
    const dialog = createDialog({
      title: 'Reset all settings?',
      description: 'This cannot be undone.',
      icon: 'trash2',
      danger: true,
      submitLabel: 'Reset everything',
    });
    const typed = h('input', { class: 'input input--mono', id: 'reset-word', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': 'reset-word-hint' });
    const typedField = h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'reset-word' }, 'Type ', h('code', { text: 'RESET' }), ' to confirm'),
      typed,
      h('p', { class: 'field__hint', id: 'reset-word-hint', text: 'Capital letters, exactly as shown.' }),
    );
    const pwInput = h('input', { class: 'input', id: 'reset-pw', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'reset-pw-err' });
    const pwError = h('div', { class: 'field__error', id: 'reset-pw-err', hidden: true });
    const pwField = passwordSet ? h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'reset-pw', text: 'Drawer password' }), pwInput, pwError) : null;

    dialog.body.append(
      h(
        'ul',
        { class: 'reset-list' },
        h('li', { text: 'Printer settings for receipts and labels' }),
        h('li', { text: 'The cash drawer password' }),
        h('li', { text: 'The server address and allowed domains' }),
      ),
      h('p', { class: 'muted', text: 'Your shop data in the POS is not touched.' }),
      typedField,
      pwField,
    );
    const stopLockout = attachDialogLockout(dialog, ctx.lockout);
    const armed = () => typed.value === 'RESET';
    const sync = () => {
      const locked = ctx.lockout.locked;
      dialog.submitBtn.setAttribute('aria-disabled', String(!armed() || locked));
    };
    typed.addEventListener('input', sync);
    const stopSync = ctx.lockout.subscribe(sync);
    dialog.submitBtn.setAttribute('aria-disabled', 'true');
    pwInput.addEventListener('input', () => setFieldError(pwInput, pwError, null));

    dialog.onSubmit(async () => {
      if (!armed()) return;
      if (passwordSet && !pwInput.value) {
        setFieldError(pwInput, pwError, 'Enter the drawer password.');
        pwInput.focus();
        return;
      }
      const response = ctx.guard(await call(ctx.desktop.settings.resetAll, { password: passwordSet ? pwInput.value : '' }));
      if (!response.ok && ctx.lockout.locked) {
        setFieldError(pwInput, pwError, null);
        return;
      }
      if (response.ok) {
        dialog.close(true);
        await ctx.reloadState();
        ctx.toast.show({ kind: 'success', message: 'All settings were reset. Restart GadgetsPOS to start fresh.', actionLabel: 'Restart now', onAction: () => call(ctx.desktop.settings.restartApp) });
        return;
      }
      if (isWrongPasswordCode(response.code) && pwField) {
        setFieldError(pwInput, pwError, messageOf(response));
        pwInput.focus();
        pwInput.select();
      } else if (!ctx.lockout.locked) {
        dialog.setError(messageOf(response));
      }
    });
    await dialog.open();
    stopLockout();
    stopSync();
    if (el.reset.isConnected) el.reset.focus();
  }
  el.reset.addEventListener('click', openResetDialog);
}
