'use strict';

/**
 * Text helpers shared by the DYMO label plan builder (SPEC 9.4 and 9.4a).
 *
 * Pure module: no electron, no fs, no timers. Every function takes plain values and never throws, because
 * label data comes from a web page and must not be able to stop a print by being odd.
 */

/** A label text longer than this many UTF-8 bytes is cut (not rejected), SPEC 12. */
const MAX_TEXT_BYTES = 2048;

/**
 * A raw value is read only up to this many UTF-16 units, before any cleaning. Every cleaning pass is O(length) and runs
 * synchronously in the Electron main process, so a title of several megabytes (one oversized web page call is enough)
 * would freeze printing, the drawer and every window for seconds, only to be cut to 2 KB afterwards. 16 K units is eight
 * times what a 2 KB text can need: the cleaning drops only blanks, line breaks and control characters.
 */
const MAX_RAW_CHARS = 16 * 1024;

/** Control characters (C0 and C1, NUL included; TAB, CR and LF are turned into spaces before this runs) and the Unicode non-characters (U+FFFE, U+FFFF ...) that XML forbids. */
const CONTROL_CHARS = /[\p{Cc}\p{Noncharacter_Code_Point}]/gu;

/** A surrogate half with no partner (\p{Cs} in unicode mode only matches unpaired ones): it cannot be written to the label XML. */
const LONE_SURROGATE = /\p{Cs}/gu;

/** CR, LF, TAB and the Unicode line and paragraph separators (U+2028, U+2029). */
const LINE_BREAKS = /[\r\n\t\p{Zl}\p{Zp}]/gu;

/**
 * `String(value)` that maps null and undefined to '' and never throws (an object whose toString throws counts as '').
 * v1 interpolated raw values into a script, so `undefined` printed as the word "undefined".
 *
 * This is the one place where a raw value becomes text, so it is also where the size is bounded: only the first
 * MAX_RAW_CHARS units are returned and everything after them is never looked at. A cut that splits a surrogate pair
 * leaves a lone surrogate, which `cleanText` removes.
 * @param {unknown} value
 * @returns {string} at most MAX_RAW_CHARS UTF-16 units
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  try {
    const text = String(value);
    return text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text;
  } catch {
    return '';
  }
}

/**
 * Cleans one label text: CR, LF, TAB, U+2028 and U+2029 become a space, control characters (including NUL) and
 * lone surrogates are removed, runs of spaces collapse to one and the ends are trimmed. Quotes, backslashes and
 * every other printable character are left alone: they are carried as data and never pasted into code (SPEC 9.4).
 * Only the first MAX_RAW_CHARS units of the value are cleaned (see `toText`), so the cost never depends on how much
 * the caller sent.
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return toText(value)
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(LONE_SURROGATE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Cuts a text to at most `maxBytes` UTF-8 bytes without splitting a character.
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
function truncateText(text, maxBytes = MAX_TEXT_BYTES) {
  if (text.length * 3 <= maxBytes) return text; // cannot be longer than the limit, whatever the characters are
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1; // the first byte left out is the middle of a character: step back to its start
  return bytes.toString('utf8', 0, end);
}

/**
 * Reads one text field of a label payload: coerced to a string, cleaned and cut to the 2 KB limit.
 * @param {unknown} value
 * @returns {string}
 */
function readField(value) {
  return truncateText(cleanText(value));
}

/**
 * v1 rule for the printed barcode number: up to 6 characters as they are, longer ones keep the last 6 and show
 * a star for every character before them ("*****123456").
 * @param {unknown} barcode
 * @returns {string}
 */
function maskBarcodeText(barcode) {
  const text = toText(barcode);
  if (text.length <= 6) return text;
  return '*'.repeat(text.length - 6) + text.slice(-6);
}

/**
 * v1 rule for the short number under a QR code (design 4 and the 25x25 QR label): two stars and the last 6
 * characters when the text is longer than 6, otherwise the text itself.
 * @param {unknown} barcode
 * @returns {string}
 */
function maskBarcodeShort(barcode) {
  const text = toText(barcode);
  return text.length > 6 ? `**${text.slice(-6)}` : text;
}

/**
 * The condition entry of the spec list: New -> NEW, A+ -> Like New, any other grade -> "GRADE <grade>".
 * An empty grade gives nothing (v1 printed a bare "GRADE " there, SPEC 9.4 difference (c)). A grade made only
 * of blanks counts as empty: it would print as the bare word "GRADE".
 * @param {unknown} grade
 * @returns {string}
 */
function conditionLabel(grade) {
  const text = toText(grade);
  if (text.trim() === '') return '';
  if (text === 'New') return 'NEW';
  if (text === 'A+') return 'Like New';
  return `GRADE ${text}`;
}

/**
 * The spec list of a product label, in v1 order: condition, storage, network, RAM, processor, colour. Every entry
 * is cleaned and upper-cased and entries with no text are dropped, so the slots (TEXT_4, TEXT, TEXT_1, TEXT_5,
 * TEXT__1) fill from the first one without gaps.
 * @param {{ grade?: unknown, storage?: unknown, network?: unknown, ram?: unknown, processor?: unknown, color?: unknown }} fields
 * @returns {string[]}
 */
function buildSpecs({ grade, storage, network, ram, processor, color } = {}) {
  return [conditionLabel(grade), storage, network, ram, processor, color]
    .map((entry) => readField(entry).toUpperCase())
    .filter((entry) => entry !== '');
}

/** The most spec lines a message can carry (the templates print the first 4 or 5). */
const MAX_SPEC_ENTRIES = 8;

/**
 * An ordered spec list sent by the dashboard (barcodefinal.specs: condition, storage, ... chosen for the kind of device, most important first):
 * every entry is cleaned and upper-cased like buildSpecs does, entries with no text are dropped and the list is cut to MAX_SPEC_ENTRIES.
 * @param {unknown[]} specs
 * @returns {string[]}
 */
function cleanSpecList(specs) {
  return specs
    .map((entry) => readField(entry).toUpperCase())
    .filter((entry) => entry !== '')
    .slice(0, MAX_SPEC_ENTRIES);
}

module.exports = {
  MAX_TEXT_BYTES,
  MAX_SPEC_ENTRIES,
  cleanSpecList,
  MAX_RAW_CHARS,
  toText,
  cleanText,
  truncateText,
  readField,
  maskBarcodeText,
  maskBarcodeShort,
  conditionLabel,
  buildSpecs,
};
