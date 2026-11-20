/*
 * Settings > General (SPEC 14, 18b D2/D3/R1/R2): start with the computer (not on Linux), start in full screen, keep awake, and
 * hardware acceleration with its explanation, the compatibility-mode notice (with the reason) and a Restart now button after
 * a change. The three start-up switches save as soon as they are flipped (and flip back with a message if saving fails).
 */
import { $, call, messageOf, setBusy, showStatus, announce } from './ui.js';

export function mountGeneral(ctx) {
  const el = {
    loginRow: $('#row-login'),
    login: $('#sw-login'),
    full: $('#sw-fullscreen'),
    awake: $('#sw-awake'),
    status: $('#general-status'),
    accel: $('#sw-accel'),
    compat: $('#compat-notice'),
    compatText: $('#compat-text'),
    restart: $('#restart-notice'),
    restartNow: $('#restart-now'),
    restartLater: $('#restart-later'),
  };

  let saved = { openAtLogin: false, startFullScreen: false, keepAwake: true };
  let saving = false;
  let again = false;
  let restartNeeded = false;

  const readForm = () => ({ openAtLogin: el.login.checked, startFullScreen: el.full.checked, keepAwake: el.awake.checked });
  const writeForm = (values) => {
    el.login.checked = !!values.openAtLogin;
    el.full.checked = !!values.startFullScreen;
    el.awake.checked = !!values.keepAwake;
  };

  ctx.store.subscribe((state) => {
    const config = state.config || {};
    saved = {
      openAtLogin: !!(config.startup && config.startup.openAtLogin),
      startFullScreen: !!(config.window && config.window.startFullScreen),
      keepAwake: config.power ? config.power.keepAwake !== false : true,
    };
    if (!saving) writeForm(saved);
    el.loginRow.hidden = ctx.platform === 'linux';

    const performance = state.performance || {};
    const accelerated = performance.hardwareAcceleration !== false;
    el.accel.checked = accelerated;
    const reason = (performance.compatibilityReason || '').toString().trim();
    el.compat.hidden = accelerated || !reason;
    if (!el.compat.hidden) {
      const retry = 'Turn on hardware acceleration below to try the faster mode again.';
      el.compatText.textContent =
        reason === 'manual'
          ? `You switched it on from the Help menu. ${retry}`
          : `GadgetsPOS switched to it by itself. Reason: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${retry}`;
    }
    el.restart.hidden = !restartNeeded;
  });

  /** One save at a time; flips made while saving are sent right after with the latest values. */
  async function saveGeneral() {
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    showStatus(el.status, null);
    let response;
    do {
      again = false;
      const payload = readForm();
      response = await call(ctx.desktop.settings.setGeneral, payload);
      if (response.ok) saved = payload;
    } while (again);
    saving = false;
    if (response.ok) {
      showStatus(el.status, 'success', 'Saved');
      announce('Saved.');
    } else {
      writeForm(saved);
      showStatus(el.status, 'danger', messageOf(response));
    }
  }
  for (const input of [el.login, el.full, el.awake]) input.addEventListener('change', saveGeneral);

  el.accel.addEventListener('change', async () => {
    const wanted = el.accel.checked;
    showStatus(el.status, null);
    const response = await call(ctx.desktop.settings.setPerformance, { hardwareAcceleration: wanted });
    if (response.ok) {
      restartNeeded = response.restartRequired !== false;
      el.restart.hidden = !restartNeeded;
      announce('Restart GadgetsPOS to apply this change.');
    } else {
      el.accel.checked = !wanted;
      showStatus(el.status, 'danger', messageOf(response));
    }
  });

  el.restartNow.addEventListener('click', async () => {
    setBusy(el.restartNow, true);
    const response = await call(ctx.desktop.settings.restartApp);
    setBusy(el.restartNow, false);
    if (!response.ok) ctx.toast.error(messageOf(response));
  });
  el.restartLater.addEventListener('click', () => {
    restartNeeded = false;
    el.restart.hidden = true;
  });
}
