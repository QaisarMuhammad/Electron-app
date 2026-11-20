'use strict';

/**
 * Right-click menu of the POS window (SPEC 18b D1).
 *
 * Electron shows NO context menu on its own, so without this module a right click does nothing: no Paste in a field,
 * no Copy for a selected order number. The template builder is pure (it only describes the menu); `attachContextMenu`
 * is the small hook-up that needs the injected `Menu`, `clipboard` and `webContents`.
 *
 * Cases, in this order, separated by one divider each:
 *   editable field -> Undo, Redo | Cut, Copy, Paste | Select all
 *   text selection -> Copy
 *   link           -> Open link in browser (only when `isSafeExternalUrl` accepts it), Copy link address
 *   image          -> Copy image, Save image as...
 *   development    -> Inspect element (only when `isDev`)
 * A right click on an empty area of a packaged app gives an empty template and no menu is shown.
 */

/** Labels are English and fixed: roles supply the standard accelerators of the platform. */
const LABELS = Object.freeze({
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  openLink: 'Open link in browser',
  copyLink: 'Copy link address',
  copyEmail: 'Copy email address',
  copyImage: 'Copy image',
  saveImage: 'Save image as\u2026',
  inspect: 'Inspect element',
});

/**
 * @typedef {Object} ContextMenuActions
 * @property {(url: string) => void} openExternal  Sends a link to the system browser.
 * @property {(text: string) => void} copyText     Puts text on the clipboard.
 * @property {(x: number, y: number) => void} copyImage  Copies the image under the pointer.
 * @property {(url: string) => void} saveImage     Starts the "save as" download of an image.
 * @property {(x: number, y: number) => void} inspect    Opens the developer tools on the element (development only).
 */

/**
 * Items for an editable field. `editFlags` come from Chromium, so Cut/Copy are greyed out without a selection and
 * Paste when the clipboard is empty. A missing flag means "enabled".
 * @param {object} [editFlags]
 * @returns {object[]}
 */
function editableItems(editFlags) {
  const flags = editFlags || {};
  const enabled = (key) => flags[key] !== false;
  return [
    { label: LABELS.undo, role: 'undo', enabled: enabled('canUndo') },
    { label: LABELS.redo, role: 'redo', enabled: enabled('canRedo') },
    { type: 'separator' },
    { label: LABELS.cut, role: 'cut', enabled: enabled('canCut') },
    { label: LABELS.copy, role: 'copy', enabled: enabled('canCopy') },
    { label: LABELS.paste, role: 'paste', enabled: enabled('canPaste') },
    { type: 'separator' },
    { label: LABELS.selectAll, role: 'selectAll', enabled: enabled('canSelectAll') },
  ];
}

/**
 * The address inside a `mailto:` link, without the scheme and the query (`mailto:a@b.com?subject=x` -> `a@b.com`).
 * @param {string} url
 * @returns {string}
 */
function mailtoAddress(url) {
  const raw = url.replace(/^mailto:/i, '').split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Items for a link. A `javascript:` link has nothing worth copying and is never offered to the system browser. Chromium does not
 * pass such a link on as it is: `params.linkURL` of a `javascript:` link is `about:blank#blocked`, so an `about:` address is
 * treated the same way.
 * @param {string} linkURL
 * @param {(url: string) => boolean} isSafeExternalUrl
 * @param {ContextMenuActions} actions
 * @returns {object[]}
 */
function linkItems(linkURL, isSafeExternalUrl, actions) {
  if (/^(?:javascript|about):/i.test(linkURL)) return [];
  const items = [];
  if (isSafeExternalUrl(linkURL)) {
    items.push({ label: LABELS.openLink, click: () => actions.openExternal(linkURL) });
  }
  const isMail = /^mailto:/i.test(linkURL);
  items.push({
    label: isMail ? LABELS.copyEmail : LABELS.copyLink,
    click: () => actions.copyText(isMail ? mailtoAddress(linkURL) : linkURL),
  });
  return items;
}

/**
 * Builds the menu template for one right click. Pure: nothing is executed until the cashier clicks an item.
 * @param {Electron.ContextMenuParams} params       The `context-menu` event parameters.
 * @param {object} options
 * @param {boolean} [options.isDev=false]           Adds "Inspect element" (never in a packaged build).
 * @param {(url: string) => boolean} options.isSafeExternalUrl  The app's rule for links that may leave the app.
 * @param {ContextMenuActions} options.actions      What the clickable items do.
 * @returns {object[]} A template for `Menu.buildFromTemplate`; empty when there is nothing to offer.
 */
function buildContextMenuTemplate(params, { isDev = false, isSafeExternalUrl, actions }) {
  const groups = [];

  if (params.isEditable) {
    groups.push(editableItems(params.editFlags));
  } else if (typeof params.selectionText === 'string' && params.selectionText.trim() !== '') {
    groups.push([{ label: LABELS.copy, role: 'copy' }]);
  }

  if (typeof params.linkURL === 'string' && params.linkURL !== '') {
    const links = linkItems(params.linkURL, isSafeExternalUrl, actions);
    if (links.length > 0) groups.push(links);
  }

  if (params.mediaType === 'image' && typeof params.srcURL === 'string' && params.srcURL !== '') {
    groups.push([
      { label: LABELS.copyImage, click: () => actions.copyImage(params.x, params.y) },
      { label: LABELS.saveImage, click: () => actions.saveImage(params.srcURL) },
    ]);
  }

  if (isDev) {
    groups.push([{ label: LABELS.inspect, click: () => actions.inspect(params.x, params.y) }]);
  }

  const template = [];
  groups.forEach((group, index) => {
    if (index > 0) template.push({ type: 'separator' });
    template.push(...group);
  });
  return template;
}

/**
 * Shows the context menu of a window. A failing action is logged and never reaches the user as a crash.
 * @param {object} deps
 * @param {Electron.WebContents} deps.webContents
 * @param {Electron.BrowserWindow} deps.ownerWindow         The window the menu pops up in.
 * @param {typeof Electron.Menu} deps.Menu
 * @param {Electron.Clipboard} deps.clipboard
 * @param {boolean} [deps.isDev=false]
 * @param {(url: string) => boolean} deps.isSafeExternalUrl
 * @param {(url: string) => (void|Promise<void>)} deps.openExternal  Opens a URL in the system browser.
 * @param {{ error: Function }} deps.log
 * @returns {void}
 */
function attachContextMenu({ webContents, ownerWindow, Menu, clipboard, isDev = false, isSafeExternalUrl, openExternal, log }) {
  const missing = Object.entries({ webContents, ownerWindow, Menu, clipboard, isSafeExternalUrl, openExternal, log })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new TypeError(`attachContextMenu is missing: ${missing.join(', ')}`);
  }

  /** Runs one action and keeps any failure inside the log. */
  const run = (label, fn) => {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error(`context menu: ${label} failed`, err && err.message));
      }
    } catch (err) {
      log.error(`context menu: ${label} failed`, err && err.message);
    }
  };

  const actions = {
    openExternal: (url) => run('open link', () => openExternal(url)),
    copyText: (text) => run('copy', () => clipboard.writeText(text)),
    copyImage: (x, y) => run('copy image', () => webContents.copyImageAt(x, y)),
    saveImage: (url) => run('save image', () => webContents.downloadURL(url)),
    inspect: (x, y) => run('inspect', () => webContents.inspectElement(x, y)),
  };

  webContents.on('context-menu', (_event, params) => {
    try {
      if (webContents.isDestroyed()) return;
      const template = buildContextMenuTemplate(params, { isDev, isSafeExternalUrl, actions });
      if (template.length === 0) return;
      Menu.buildFromTemplate(template).popup({ window: ownerWindow });
    } catch (err) {
      log.error('context menu: could not be shown', err && err.message);
    }
  });
}

module.exports = { buildContextMenuTemplate, attachContextMenu, mailtoAddress, LABELS };
