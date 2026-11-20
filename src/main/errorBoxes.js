'use strict';

/**
 * Native error boxes for failures the web page cannot show (SPEC 4 and 12).
 *
 * The old web app prints with `sendReceiptData`, `sendBarcodeData` and `sendOpenDrawerCommand`: fire-and-forget calls that
 * never learn the outcome. So when one of them fails, the APP tells the cashier, in a native box. A batch of 20 labels
 * on a printer that is switched off would otherwise open 20 boxes, so boxes are coalesced: at most ONE box per error
 * code per 5 seconds, and never a second one for a code whose box is still open.
 *
 * The box is asynchronous (`showMessageBox`), not `showErrorBox`: the latter blocks the whole main process, and with it
 * every other print job, until somebody clicks OK.
 *
 * Pure Node: the dialog, the window lookup and the clock are injected.
 */

/** Window in which a second box for the same error code is not shown. */
const COALESCE_WINDOW_MS = 5000;

/** What a failed job was doing, for the heading of the box. */
const HEADINGS = Object.freeze({
  receipt: 'The receipt could not be printed',
  label: 'The label could not be printed',
  drawer: 'The cash drawer did not open',
  other: 'GadgetsPOS could not finish that',
});

const MAX_TRACKED_CODES = 64;

/**
 * @param {object} deps
 * @param {{ showMessageBox: Function }} deps.dialog Electron's dialog
 * @param {() => (object|null|undefined)} [deps.getWindow] the window the box belongs to (the main window), when there is one
 * @param {() => number} [deps.now=Date.now]
 * @param {number} [deps.windowMs=5000]
 * @param {{ warn?: Function }} [deps.log]
 * @returns {{
 *   show: (result: {ok: boolean, code?: string, message?: string}, options?: {kind?: 'receipt'|'label'|'drawer'|'other'}) => boolean
 * }}
 */
function createErrorBoxes({ dialog, getWindow, now = Date.now, windowMs = COALESCE_WINDOW_MS, log }) {
  /** @type {Map<string, number>} error code -> when its last box was shown */
  const lastShown = new Map();
  /** @type {Set<string>} error codes whose box is on screen right now */
  const open = new Set();

  /** Drops the oldest entries, so a run of unusual codes cannot grow the map for ever. */
  function prune() {
    while (lastShown.size > MAX_TRACKED_CODES) lastShown.delete(lastShown.keys().next().value);
  }

  /**
   * Shows a failed Result to the cashier, unless a box for the same code was shown in the last 5 seconds or is still
   * open. A successful Result and anything that is not a failure show nothing.
   *
   * @param {{ok: boolean, code?: string, message?: string}} result
   * @param {{kind?: string}} [options] what the job was: 'receipt', 'label', 'drawer' or 'other'
   * @returns {boolean} true when a box was opened
   */
  function show(result, { kind = 'other' } = {}) {
    if (!result || result.ok !== false) return false;
    const code = typeof result.code === 'string' && result.code ? result.code : 'UNKNOWN';
    const time = now();
    const previous = lastShown.get(code);
    if (open.has(code) || (previous !== undefined && time - previous < windowMs)) return false;
    lastShown.set(code, time);
    prune();
    open.add(code);

    const options = {
      type: 'error',
      title: 'GadgetsPOS',
      message: HEADINGS[kind] || HEADINGS.other,
      detail: typeof result.message === 'string' && result.message ? result.message : 'Please try again.',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const release = () => open.delete(code);
    try {
      const window = typeof getWindow === 'function' ? getWindow() : null;
      const pending = window && !(typeof window.isDestroyed === 'function' && window.isDestroyed())
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options);
      Promise.resolve(pending).then(release, release);
    } catch (error) {
      release();
      if (log && typeof log.warn === 'function') log.warn(`could not show an error box (${error && error.message})`);
      return false;
    }
    return true;
  }

  return { show };
}

module.exports = { createErrorBoxes, COALESCE_WINDOW_MS, HEADINGS };
