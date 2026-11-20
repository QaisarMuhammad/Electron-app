'use strict';

/**
 * Choosing the DYMO printer a label goes to (SPEC 9.4 "Printer choice").
 *
 * v1 always printed to the first printer DYMO listed and ignored the configured one. v2 follows
 * `config.printers.dymo.printerName` and falls back to a sensible automatic choice.
 *
 * Pure module: no electron, no fs.
 */

/**
 * @typedef {object} DymoPrinter
 * @property {string} name
 * @property {string} [modelName]
 * @property {string} [printerType]   "LabelWriterPrinter", "TapePrinter", ...
 * @property {boolean} [isConnected]
 */

const normalise = (value) => String(value ?? '').trim().toLowerCase();

/** A LabelWriter: the printer family the shipped label files are made for. A tape printer cannot print them. */
function isLabelWriter(printer) {
  const type = normalise(printer.printerType);
  if (type !== '') return type.includes('labelwriter');
  return normalise(printer.modelName || printer.name).includes('labelwriter');
}

/**
 * Picks the printer for a label, in this order:
 *  1. `configuredName` ('' = automatic): an exact name match (case-insensitive, trimmed);
 *  2. the only printer whose name contains `configuredName` (several matches are ambiguous, so none is chosen here);
 *  3. the first connected LabelWriter;
 *  4. the first connected printer;
 *  5. the first printer.
 * `reason` says which rule chose it: 'exact', 'contains', 'connected-labelwriter', 'connected', 'first', or 'none'.
 * A configured name that matched nothing still falls through to rules 3-5, so the caller can tell a fallback
 * from a match by the reason.
 *
 * @param {DymoPrinter[] | null | undefined} printers
 * @param {string} [configuredName]
 * @returns {{ printer: DymoPrinter, reason: string } | { printer: null, reason: 'none' }}
 */
function pickDymoPrinter(printers, configuredName = '') {
  const list = Array.isArray(printers) ? printers.filter((printer) => printer && typeof printer.name === 'string') : [];
  if (list.length === 0) return { printer: null, reason: 'none' };

  const wanted = normalise(configuredName);
  if (wanted !== '') {
    const exact = list.find((printer) => normalise(printer.name) === wanted);
    if (exact) return { printer: exact, reason: 'exact' };
    const partial = list.filter((printer) => normalise(printer.name).includes(wanted));
    if (partial.length === 1) return { printer: partial[0], reason: 'contains' };
  }

  const connectedLabelWriter = list.find((printer) => printer.isConnected === true && isLabelWriter(printer));
  if (connectedLabelWriter) return { printer: connectedLabelWriter, reason: 'connected-labelwriter' };
  const connected = list.find((printer) => printer.isConnected === true);
  if (connected) return { printer: connected, reason: 'connected' };
  return { printer: list[0], reason: 'first' };
}

module.exports = { pickDymoPrinter };
