/*
 * Settings > Connection (SPEC 14): live status chip + "Reload POS", the server address (https only) and the extra allowed
 * domains editor. Saving asks for the drawer password only when "ask for the password before Settings opens" is on.
 * Quick client-side checks give friendly messages; the main process validates again and its Result.message wins.
 */
import { $, h, icon, call, messageOf, setBusy, showStatus, setFieldError, announce } from './ui.js';
import { hostOf, sameJson, validateOrigin, validateServerUrl, isWrongPasswordCode } from './format.mjs';
import { failureText } from './settings-common.js';

const unsavedIndicator = () => h('span', { class: 'status status--warning status--dot' }, h('span', { class: 'dot dot--warning' }), h('span', { class: 'status__text', text: 'Unsaved changes' }));

export function mountConnection(ctx) {
  const el = {
    chip: $('#conn-chip'),
    dot: $('#conn-dot'),
    chipText: $('#conn-chip-text'),
    statusText: $('#conn-status-text'),
    reload: $('#reload-pos'),
    reloadStatus: $('#reload-status'),
    form: $('#conn-form'),
    url: $('#conn-url'),
    urlErr: $('#conn-url-err'),
    domains: $('#domains'),
    domainsEmpty: $('#domains-empty'),
    domainInput: $('#domain-input'),
    domainAdd: $('#domain-add'),
    domainErr: $('#domain-err'),
    pwField: $('#conn-pw-field'),
    pw: $('#conn-pw'),
    pwErr: $('#conn-pw-err'),
    status: $('#conn-status'),
    save: $('#conn-save'),
  };

  let saved = { serverUrl: '', domains: [] };
  let filled = false;
  let domains = [];
  let online = true;
  let attempt = 0;
  let result = null;
  let busy = false;

  const isDirty = () => el.url.value.trim() !== saved.serverUrl || !sameJson(domains, saved.domains);

  function renderStatus() {
    if (result) showStatus(el.status, result.tone, result.text);
    else if (isDirty()) el.status.replaceChildren(unsavedIndicator());
    else showStatus(el.status, null);
    el.save.setAttribute('aria-disabled', String(!isDirty() || busy));
    ctx.setDirty('connection', isDirty());
  }

  function renderConnection() {
    const host = hostOf(saved.serverUrl);
    el.chip.className = `chip chip--${online ? 'success' : 'danger'}`;
    el.dot.className = `dot dot--${online ? 'success' : 'danger'}`;
    el.chipText.textContent = online ? 'Connected' : 'Offline';
    el.statusText.textContent = online
      ? host
        ? `GadgetsPOS is connected to ${host}.`
        : 'GadgetsPOS is connected.'
      : `GadgetsPOS can't reach the server right now. It keeps trying by itself${attempt > 0 ? ` (attempt ${attempt})` : ''}.`;
  }

  function renderDomains() {
    el.domains.replaceChildren(
      ...domains.map((domain) =>
        h(
          'li',
          { class: 'domain-row' },
          h('code', { text: domain }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--quiet btn--icon',
              'aria-label': `Remove ${domain}`,
              on: {
                click: () => {
                  domains = domains.filter((d) => d !== domain);
                  result = null;
                  renderDomains();
                  renderStatus();
                  announce(`${domain} removed.`);
                  el.domainInput.focus();
                },
              },
            },
            icon('trash'),
          ),
        ),
      ),
    );
    el.domainsEmpty.hidden = domains.length > 0;
  }

  ctx.store.subscribe((state) => {
    const config = state.config || {};
    const wasDirty = filled && isDirty();
    filled = true;
    saved = { serverUrl: config.serverUrl || '', domains: Array.isArray(config.extraAllowedOrigins) ? [...config.extraAllowedOrigins] : [] };
    if (!wasDirty) {
      el.url.value = saved.serverUrl;
      domains = [...saved.domains];
      renderDomains();
    }
    online = state.online !== false;
    el.pwField.hidden = !(config.drawer && config.drawer.requirePasswordForSettings && config.drawer.passwordSet);
    renderConnection();
    renderStatus();
  });

  /** Live connection state: the offline page and this chip read the same push. */
  if (ctx.desktop.connection && ctx.desktop.connection.onStatus) {
    ctx.desktop.connection.onStatus((status) => {
      if (status && typeof status === 'object') {
        online = status.online !== false;
        attempt = Number(status.attempt) || 0;
        renderConnection();
      }
    });
  }

  el.reload.addEventListener('click', async () => {
    setBusy(el.reload, true);
    showStatus(el.reloadStatus, 'info', 'Reloading the POS...');
    const response = await call(ctx.desktop.connection.retryNow);
    setBusy(el.reload, false);
    if (response.ok) showStatus(el.reloadStatus, 'success', 'The POS is reloading.');
    else showStatus(el.reloadStatus, 'danger', messageOf(response));
    announce(el.reloadStatus.textContent);
  });

  el.url.addEventListener('input', () => {
    result = null;
    setFieldError(el.url, el.urlErr, null);
    renderStatus();
  });
  el.url.addEventListener('blur', () => {
    if (el.url.value.trim()) {
      const check = validateServerUrl(el.url.value);
      setFieldError(el.url, el.urlErr, check.ok ? null : check.message);
    }
  });

  function addDomain() {
    const check = validateOrigin(el.domainInput.value);
    if (!check.ok) {
      setFieldError(el.domainInput, el.domainErr, check.message);
      el.domainInput.focus();
      return;
    }
    if (domains.includes(check.value)) {
      setFieldError(el.domainInput, el.domainErr, 'This domain is already in the list.');
      el.domainInput.focus();
      return;
    }
    domains = [...domains, check.value];
    el.domainInput.value = '';
    setFieldError(el.domainInput, el.domainErr, null);
    result = null;
    renderDomains();
    renderStatus();
    announce(`${check.value} added.`);
    el.domainInput.focus();
  }
  el.domainAdd.addEventListener('click', addDomain);
  el.domainInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDomain();
    }
  });
  el.domainInput.addEventListener('input', () => setFieldError(el.domainInput, el.domainErr, null));
  el.pw.addEventListener('input', () => setFieldError(el.pw, el.pwErr, null));

  async function save() {
    if (busy || !isDirty()) return;
    const check = validateServerUrl(el.url.value);
    if (!check.ok) {
      setFieldError(el.url, el.urlErr, check.message);
      el.url.focus();
      return;
    }
    const needsPassword = !el.pwField.hidden;
    if (needsPassword && !el.pw.value) {
      setFieldError(el.pw, el.pwErr, 'Enter the drawer password to save.');
      el.pw.focus();
      return;
    }
    if (ctx.lockout.locked) {
      result = { tone: 'danger', text: 'Password checks are paused. Please wait for the countdown to end.' };
      renderStatus();
      return;
    }
    busy = true;
    setBusy(el.save, true);
    renderStatus();
    const urlChanged = check.value !== saved.serverUrl;
    const response = ctx.guard(await call(ctx.desktop.settings.saveConnection, { serverUrl: check.value, extraAllowedOrigins: [...domains], password: needsPassword ? el.pw.value : '' }));
    busy = false;
    setBusy(el.save, false);
    if (response.ok) {
      saved = { serverUrl: check.value, domains: [...domains] };
      el.url.value = check.value;
      el.pw.value = '';
      result = { tone: 'success', text: urlChanged ? 'Saved. Press Reload POS to open the new address.' : 'Saved' };
      renderConnection();
      announce(result.text);
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
}
