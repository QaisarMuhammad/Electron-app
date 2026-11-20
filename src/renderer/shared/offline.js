/*
 * offline.html - what the cashier sees when the POS page cannot be loaded (SPEC 11.2, 11.4).
 *
 * Talks only to window.desktop.connection (SPEC 6.2/6.3). The query string (?reason=&code=&desc=&url=) gives the first picture
 * before getStatus() answers; every value from it is written with textContent only and the reason is checked against a list.
 * The countdown text changes once per second with ONE timeout that fires just after the displayed second changes; the bar is a
 * single Web Animation (transform), so nothing runs per frame and nothing runs at all once the page is idle.
 *
 * The connection controller reports `online: true` in two different situations, and only one of them is good news:
 *   - recovered: a probe got an answer (the controller counted at least one attempt), the POS is being opened;
 *   - at rest: nothing is retrying (the main process shows this page without reconnecting after a crash loop or for a server
 *     address that cannot be opened), so the cashier has to act. The controller then has no attempt, address or reason.
 * The page tells them apart by the attempt count (see isRecovered / isResting).
 */
import { $, h, icon, hydrateIcons, call, copyText, messageOf, announce, setBusy, replaceChildrenOf } from './ui.js';
import { formatSeconds, formatTime, hostOf } from './format.mjs';

/** Plain-language copy per reason (SPEC 11.2). `lede` receives the host name of the server, or '' when unknown. */
const REASONS = {
  offline: {
    icon: 'wifi-off',
    title: 'No internet connection',
    lede: () => "This computer is not connected to the internet, so GadgetsPOS can't open your shop.",
    steps: [
      'Check that the network cable is plugged in, or that Wi-Fi is switched on.',
      'If other devices are offline too, restart the router.',
      'GadgetsPOS reconnects by itself as soon as the internet is back.',
    ],
  },
  dns: {
    icon: 'globe',
    title: "Can't find the server",
    lede: (host) => (host ? `GadgetsPOS could not find ${host}. The internet may be down, or the server address may be wrong.` : 'GadgetsPOS could not find the server. The internet may be down, or the server address may be wrong.'),
    steps: [
      'Check that this computer is online by opening any website.',
      'Check the server address with "Change server address".',
      'Wait a moment. GadgetsPOS keeps trying by itself.',
    ],
  },
  refused: {
    icon: 'unplug',
    title: 'The server is not answering',
    lede: () => 'The server turned the connection away. It may be restarting or switched off.',
    steps: [
      'Wait a minute. GadgetsPOS keeps trying by itself.',
      'Check that the server address is correct.',
      'If this lasts more than a few minutes, contact your support team.',
    ],
  },
  timeout: {
    icon: 'clock',
    title: 'The server is taking too long',
    lede: () => 'The connection is slow, or the server is very busy.',
    steps: [
      'Check that other websites open normally.',
      'Restart the router if the internet is slow everywhere.',
      'Press "Retry now", or wait. GadgetsPOS keeps trying by itself.',
    ],
  },
  tls: {
    icon: 'shield-alert',
    title: 'The secure connection failed',
    lede: () => 'GadgetsPOS could not confirm that the server is safe. This often happens when the date or time on this computer is wrong.',
    steps: [
      'Check the date, time and time zone on this computer.',
      'Turn on automatic time in the system settings.',
      'If the problem stays, contact your support team.',
    ],
  },
  server: {
    icon: 'server',
    title: 'The server has a problem',
    lede: () => 'The server answered, but it reported an error. This is not a problem with this computer.',
    steps: [
      'Wait a minute. GadgetsPOS keeps trying by itself.',
      'Press "Retry now" to try again.',
      'If this lasts more than a few minutes, contact your support team.',
    ],
  },
  other: {
    icon: 'alert-circle',
    title: "Can't open GadgetsPOS",
    lede: () => 'Something went wrong while loading the page.',
    steps: [
      'Press "Retry now".',
      'Check your internet connection.',
      'If the problem stays, open "Technical details" and share them with your support team.',
    ],
  },
};

/** What the page says once the server answers again: the failure copy would contradict the status card. */
const RECOVERED = { icon: 'check-circle', title: 'Back online', lede: 'Opening your shop...', steps: [] };

const desktop = window.desktop;
const params = new URLSearchParams(location.search);
const clip = (value, max = 400) => String(value ?? '').slice(0, max);
const reasonFrom = (value) => (Object.hasOwn(REASONS, value) ? value : 'other');

const el = {
  art: $('.art'),
  headline: $('#headline'),
  lede: $('#lede'),
  steps: $('#steps'),
  connect: $('#connect'),
  connectIcon: $('#connect-icon'),
  connectTitle: $('#connect-title'),
  connectSub: $('#connect-sub'),
  bar: $('#connect-bar'),
  barTrack: $('.connect__bar'),
  retry: $('#retry'),
  printers: $('#open-printers'),
  server: $('#open-server'),
  note: $('#note'),
  techList: $('#tech-list'),
  copy: $('#copy-details'),
  copyNote: $('#copy-note'),
};

let status = {
  online: false,
  attempt: 0,
  nextRetryInMs: null,
  reason: reasonFrom(params.get('reason')),
  url: clip(params.get('url')),
  lastError: { code: clip(params.get('code'), 80), description: clip(params.get('desc')) },
};
let deadline = 0;
let timer = 0;
let barAnimation = null;
let retryHeld = false;
let shownCopy = '';
const openedAt = new Date();

/** A probe succeeded: the controller counted the attempt that got an answer. */
const isRecovered = () => status.online === true && Number(status.attempt) > 0;
/** `online: true` with no attempt: nothing is retrying (see the header), so this is not "back online". */
const isResting = () => status.online === true && !isRecovered();

/* ---------------------------------------------------------------------------------------------------------------- */
/* Rendering                                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * The words of the page for the current status: the copy of the failure, "Back online" once a probe succeeded, and, while
 * nothing retries by itself, the sentence the main process wrote about what to do (it is the only plain instruction on a crash
 * loop screen) in place of the generic paragraph.
 */
function currentCopy() {
  if (isRecovered()) return RECOVERED;
  const copy = REASONS[reasonFrom(status.reason)];
  const advice = isResting() && status.lastError ? status.lastError.description : '';
  return { ...copy, lede: advice || copy.lede(hostOf(status.url)) };
}

function renderReason() {
  const copy = currentCopy();
  const signature = [copy.icon, copy.title, copy.lede, ...copy.steps].join('|');
  if (signature === shownCopy) return;
  shownCopy = signature;
  el.headline.textContent = copy.title;
  el.lede.textContent = copy.lede;
  replaceChildrenOf(el.steps, copy.steps.map((text) => h('li', null, h('span', { text }))));
  el.steps.hidden = copy.steps.length === 0;
  el.art.querySelector('.art__icon').replaceWith(icon(copy.icon, 'art__icon'));
  document.title = `GadgetsPOS - ${copy.title}`;
  renderDetails();
}

function setBar(mode, ms = 0) {
  if (barAnimation) {
    barAnimation.cancel();
    barAnimation = null;
  }
  el.barTrack.classList.toggle('progress--indeterminate', mode === 'indeterminate');
  if (mode === 'countdown' && ms > 0) {
    barAnimation = el.bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: ms, easing: 'linear', fill: 'forwards' });
  }
}

function renderStatus() {
  const left = deadline - Date.now();
  const recovered = isRecovered();
  const state = recovered ? 'online' : isResting() ? 'idle' : left > 0 ? 'waiting' : 'probing';
  const attempt = Number(status.attempt) || 0;
  const changedState = el.connect.dataset.state !== state;
  el.connect.dataset.state = state;
  el.art.dataset.tone = recovered ? 'success' : 'warning';

  if (state === 'online') {
    el.connectTitle.textContent = 'Back online - reloading...';
    el.connectSub.textContent = 'Opening your shop';
  } else if (state === 'idle') {
    el.connectTitle.textContent = 'Not trying again by itself';
    el.connectSub.textContent = 'Press "Retry now" when you are ready.';
  } else if (state === 'waiting') {
    el.connectTitle.textContent = `Trying again in ${formatSeconds(Math.ceil(left / 1000))}`;
    el.connectSub.textContent = attempt > 0 ? `Attempt ${attempt}. This is automatic.` : 'This is automatic.';
  } else {
    el.connectTitle.textContent = 'Trying to connect...';
    el.connectSub.textContent = attempt > 0 ? `Attempt ${attempt}` : 'Checking the server';
  }

  if (changedState) {
    const glyphs = { online: () => icon('check-circle'), idle: () => icon('alert-circle'), waiting: () => icon('clock'), probing: () => h('span', { class: 'spinner' }) };
    el.connectIcon.replaceChildren(glyphs[state]());
    setBar(state === 'waiting' ? 'countdown' : state === 'idle' ? 'none' : 'indeterminate', state === 'waiting' ? left : 0);
  }
  const badge = $('#art-badge');
  badge.replaceChildren(icon(recovered ? 'check' : 'alert', 'icon--sm'));
}

function schedule() {
  clearTimeout(timer);
  if (status.online || !deadline) return;
  const left = deadline - Date.now();
  if (left <= 0) {
    renderStatus();
    return;
  }
  timer = setTimeout(() => {
    renderStatus();
    schedule();
  }, (left % 1000 || 1000) + 30);
}

function errorText() {
  const { code, description } = status.lastError || {};
  if (description && code) return `${description} (${code})`;
  return description || code || '';
}

function detailRows() {
  const copy = REASONS[reasonFrom(status.reason)];
  return [
    ['What happened', copy.title, false],
    ['Error', errorText(), true],
    ['Address', status.url, true],
    ['Time', formatTime(openedAt), false],
    ['Attempts', Number(status.attempt) > 0 ? String(status.attempt) : '', false],
    ['App version', desktop && desktop.version ? String(desktop.version) : '', false],
  ].filter(([, value]) => value);
}

function renderDetails() {
  const nodes = [];
  for (const [label, value, mono] of detailRows()) {
    nodes.push(h('dt', { text: label }), h('dd', { class: mono ? 'mono' : '', text: value }));
  }
  replaceChildrenOf(el.techList, nodes);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Status updates                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

function applyStatus(next) {
  if (!next || typeof next !== 'object') return;
  const wasRecovered = isRecovered();
  const lastAttempt = status.attempt;
  // The controller reports the address and the reason as null while it is at rest or after a recovery: keep what is known.
  status = { ...status, ...next, url: next.url ?? status.url, reason: next.reason ?? status.reason, lastError: { ...status.lastError, ...(next.lastError || {}) } };
  status.reason = reasonFrom(status.reason);
  status.url = clip(status.url);
  const wait = Number(status.nextRetryInMs);
  deadline = status.online !== true && wait > 0 ? Date.now() + wait : 0;
  retryHeld = false;
  setBusy(el.retry, false);
  renderReason();
  renderStatus();
  renderDetails();
  schedule();
  if (isRecovered() && !wasRecovered) announce('Back online. Reloading your shop.');
  else if (status.attempt !== lastAttempt && status.attempt > 0) announce(`Still offline. Attempt ${status.attempt}.`);
}

function showNote(text) {
  el.note.textContent = text || '';
}

async function runWithBusy(button, task) {
  setBusy(button, true);
  const result = await task();
  setBusy(button, false);
  return result;
}

async function retryNow() {
  if (retryHeld) return;
  retryHeld = true;
  showNote('');
  setBusy(el.retry, true);
  deadline = 0;
  renderStatus();
  announce('Trying now.');
  const [result] = await Promise.all([call(desktop.connection.retryNow), new Promise((resolve) => setTimeout(resolve, 700))]);
  if (!result.ok) showNote(messageOf(result));
  // A new status push normally ends this; make sure the button never stays locked.
  retryHeld = false;
  setBusy(el.retry, false);
}

async function openSettings(tab, button) {
  showNote('');
  const result = await runWithBusy(button, () => call(desktop.connection.openSettings, tab));
  if (!result.ok) showNote(messageOf(result, "Settings could not be opened. Please close and open GadgetsPOS again."));
}

async function copyDetails() {
  const text = detailRows()
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  const ok = await copyText(text);
  el.copyNote.textContent = ok ? 'Copied to the clipboard.' : 'Could not copy. Select the text and copy it by hand.';
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Boot                                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

hydrateIcons(document);
renderReason();
renderStatus();
renderDetails();
document.documentElement.classList.remove('pending');

performance.mark('gp-ready');

el.retry.addEventListener('click', retryNow);
el.printers.addEventListener('click', () => openSettings('printers', el.printers));
el.server.addEventListener('click', () => openSettings('connection', el.server));
el.copy.addEventListener('click', copyDetails);

if (desktop && desktop.connection) {
  desktop.connection.onStatus(applyStatus);
  call(desktop.connection.getStatus).then((result) => {
    const status = result.ok ? (result.value ?? result) : null;
    if (status && typeof status === 'object' && typeof status.online === 'boolean') applyStatus(status);
  });
} else {
  showNote('This page works only inside the GadgetsPOS app.');
}
