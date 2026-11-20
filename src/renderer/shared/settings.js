/*
 * settings.html - entry point. Builds the shell (tabs, toasts, lockout banner, rail status), loads the state once, mounts the
 * five tabs and keeps them in step with the main process (onState / onStatus pushes).
 *
 * Talks only to window.desktop (settings, connection, window areas; SPEC 6.2/6.3). The first paint is the static shell; the
 * cards fade in when the state arrives, the printer lists show skeletons until the system answers.
 */
import { $, $$, hydrateIcons, createToaster, createTabs, call, messageOf, setBusy } from './ui.js';
import { createStore, createContext, bindLockoutBanner } from './settings-common.js';
import { mountPrinters } from './settings-printers.js';
import { mountDrawer } from './settings-drawer.js';
import { mountConnection } from './settings-connection.js';
import { mountGeneral } from './settings-general.js';
import { mountAbout } from './settings-about.js';

const TAB_IDS = ['printers', 'drawer', 'connection', 'general', 'about'];
const desktop = window.desktop;

hydrateIcons(document);

/* ---- tabs: arrow keys, deep link through #tab or ?tab=, hash changes from the main process ---- */
const fromLocation = () => {
  const wanted = (location.hash.slice(1) || new URLSearchParams(location.search).get('tab') || '').toLowerCase();
  return TAB_IDS.includes(wanted) ? wanted : TAB_IDS[0];
};
const tabs = createTabs({
  tablist: $('#tablist'),
  tabs: $$('.nav__item'),
  panels: Object.fromEntries(TAB_IDS.map((id) => [id, $(`#panel-${id}`)])),
  initial: fromLocation(),
  onChange: (id) => {
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {
      // some embedders block history changes on file pages; the tab still works
    }
    $('#content').scrollTop = 0;
  },
});
window.addEventListener('hashchange', () => tabs.select(fromLocation(), { focus: false }));

/* The side rail turns into a top bar on narrow windows, so the tab list changes direction with it. */
const narrow = matchMedia('(max-width: 759px)');
const syncOrientation = () => $('#tablist').setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
narrow.addEventListener('change', syncOrientation);
syncOrientation();

/*
 * Tabs with unsaved edits. While there is one, the page asks to stay when its window is closed: Chromium hands that to the main
 * process as `will-prevent-unload`, which is where the question "Discard your unsaved changes?" is asked (and where quitting
 * the app is let through). Electron refuses to close a window whose page asks to stay unless that event is answered, so the
 * main process must listen for it on this window. Switching tabs is a same-document change, so it never gets here; a clean page
 * asks nothing.
 */
const dirtyTabs = new Set();

/** Unsaved dot on a tab, and the list of tabs that make the window ask before it closes. */
function setDirty(tab, dirty) {
  const dot = $(`#tab-${tab} .nav__dot`);
  if (dot) dot.hidden = !dirty;
  if (dirty) dirtyTabs.add(tab);
  else dirtyTabs.delete(tab);
}

window.addEventListener('beforeunload', (event) => {
  if (!dirtyTabs.size) return;
  event.preventDefault();
  event.returnValue = '';
});

/* ---- rail: version and connection state ---- */
function renderRail(online) {
  const known = typeof online === 'boolean';
  $('#rail-dot').className = known ? `dot dot--${online ? 'success' : 'danger'}` : 'dot';
  $('#rail-online').textContent = known ? (online ? 'Online' : 'Offline') : 'Status unknown';
}
$('#rail-version').textContent = desktop && desktop.version ? `Version ${desktop.version}` : '';

/* ---- state ---- */
const store = createStore({});
const toaster = createToaster($('#toasts'));
let mounted = false;

async function loadState() {
  const response = await call(desktop.settings.getState);
  const state = response.ok ? (response.value ?? response) : null;
  if (!state || typeof state !== 'object' || !state.config) return { ok: false, message: messageOf(response, 'Close this window and open Settings again.') };
  store.set(state);
  return { ok: true };
}

const ctx = createContext({
  desktop,
  toaster,
  store,
  setDirty,
  reloadState: async () => {
    await loadState();
  },
});
bindLockoutBanner(ctx.lockout);
store.subscribe((state) => {
  renderRail(state.online);
  if (state.version) $('#rail-version').textContent = `Version ${state.version}`;
});

function mountAll() {
  if (mounted) return;
  mounted = true;
  mountPrinters(ctx);
  mountDrawer(ctx);
  mountConnection(ctx);
  mountGeneral(ctx);
  mountAbout(ctx);
  document.body.dataset.state = 'ready';
  performance.mark('gp-ready');
  desktop.settings.onState((patch) => store.merge(patch));
  if (desktop.connection && desktop.connection.onStatus) {
    desktop.connection.onStatus((status) => {
      if (status && typeof status.online === 'boolean') {
        renderRail(status.online);
        store.merge({ online: status.online });
      }
    });
  }
}

async function boot() {
  const banner = $('#load-error');
  const outcome = await loadState();
  if (outcome.ok) {
    banner.hidden = true;
    mountAll();
    return;
  }
  document.body.dataset.state = 'error';
  $('#load-error-text').textContent = outcome.message;
  banner.hidden = false;
}

$('#load-retry').addEventListener('click', async () => {
  const button = $('#load-retry');
  setBusy(button, true);
  await boot();
  setBusy(button, false);
});

if (desktop && desktop.settings) boot();
else {
  $('#load-error-text').textContent = 'This page works only inside the GadgetsPOS app.';
  $('#load-error').hidden = false;
}
