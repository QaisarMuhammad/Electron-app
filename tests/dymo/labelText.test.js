'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_TEXT_BYTES,
  MAX_RAW_CHARS,
  toText,
  cleanText,
  truncateText,
  readField,
  maskBarcodeText,
  maskBarcodeShort,
  conditionLabel,
  buildSpecs,
} = require('../../src/main/printing/labelText');

const code = (...points) => String.fromCharCode(...points);
const LS = code(0x2028);
const PS = code(0x2029);
const NUL = code(0);

test('toText: String() with null and undefined as an empty string, and it never throws', () => {
  assert.equal(toText(undefined), '');
  assert.equal(toText(null), '');
  assert.equal(toText(0), '0');
  assert.equal(toText(12.5), '12.5');
  assert.equal(toText(false), 'false');
  assert.equal(toText(['a', 'b']), 'a,b');
  assert.equal(toText({ toString: () => 'custom' }), 'custom');
  assert.equal(toText(Object.create(null)), '', 'an object with no toString does not throw');
  assert.equal(
    toText({
      toString() {
        throw new Error('boom');
      },
    }),
    ''
  );
});

test('toText: only the first MAX_RAW_CHARS units of a raw value are returned, whatever its type; the rest is never looked at (SEC-02)', () => {
  assert.equal(MAX_RAW_CHARS, 16 * 1024);
  const whole = 'a'.repeat(MAX_RAW_CHARS);
  assert.equal(toText(whole), whole, 'a value of exactly the limit is returned whole');
  assert.equal(toText(`${whole}TAIL`), whole, 'whatever lies beyond the limit is dropped');
  assert.equal(toText('b'.repeat(10 * 1024 * 1024)).length, MAX_RAW_CHARS, 'a 10 MB value costs a 16 K read');
  assert.equal(toText([whole, 'TAIL']), whole, 'a value that is not a string is converted first, then cut');
  assert.equal(toText({ toString: () => `${whole}TAIL` }), whole);
});

test('cleanText: a raw value is read only up to MAX_RAW_CHARS units, so the work on one value is bounded (SEC-02)', () => {
  const fits = `head${' '.repeat(MAX_RAW_CHARS - 8)}tail`; // exactly MAX_RAW_CHARS units
  assert.equal(fits.length, MAX_RAW_CHARS);
  assert.equal(cleanText(fits), 'head tail');
  assert.equal(cleanText(`${fits}!`), 'head tail', 'the unit after the limit is not read');
  assert.equal(cleanText(`${' '.repeat(MAX_RAW_CHARS)}late`), '', 'text that starts only beyond the limit is lost: the price of the bound');
  assert.equal(readField('a b\n'.repeat(MAX_RAW_CHARS)).length, MAX_TEXT_BYTES, 'what is left after the cleaning is still cut to 2 KB');
});

test('cleanText: a cut that falls inside a surrogate pair leaves no lone surrogate behind (SEC-02)', () => {
  const emoji = '\u{1F600}';
  assert.equal(cleanText(`${'a'.repeat(MAX_RAW_CHARS - 1)}${emoji}`), 'a'.repeat(MAX_RAW_CHARS - 1), 'the pair straddles the limit: its first half goes with the cut');
  const whole = `${'a'.repeat(MAX_RAW_CHARS - 2)}${emoji}`;
  assert.equal(cleanText(whole), whole, 'the pair ends exactly at the limit: it stays');
});

test('cleanText: CR, LF, TAB, U+2028 and U+2029 become one space; runs of spaces collapse; the ends are trimmed', () => {
  assert.equal(cleanText('a\nb'), 'a b');
  assert.equal(cleanText('a\r\nb'), 'a b');
  assert.equal(cleanText('a\rb'), 'a b');
  assert.equal(cleanText('a\tb'), 'a b');
  assert.equal(cleanText(`a${LS}b${PS}c`), 'a b c');
  assert.equal(cleanText('  a    b  '), 'a b');
  assert.equal(cleanText('\n\n  a \n\n b \t\t'), 'a b');
  assert.equal(cleanText('   '), '');
  assert.equal(cleanText(''), '');
});

test('cleanText: NUL and other control characters are removed, not turned into spaces', () => {
  assert.equal(cleanText(`a${NUL}b`), 'ab');
  assert.equal(cleanText(`a${code(7)}b${code(0x1b)}c${code(0x7f)}d`), 'abcd');
  assert.equal(cleanText(`a${code(0x85)}b${code(0x9f)}c`), 'abc', 'C1 controls too (NEL included)');
  assert.equal(cleanText(`a ${NUL} b`), 'a b', 'the blanks around a removed character still collapse');
  assert.equal(cleanText(`${NUL}${NUL}`), '');
});

test('cleanText: characters XML cannot hold are removed: non-characters and lone surrogates', () => {
  assert.equal(cleanText(`a${code(0xfffe)}b${code(0xffff)}c`), 'abc');
  assert.equal(cleanText(`a${code(0xd800)}b`), 'ab', 'a lone high surrogate');
  assert.equal(cleanText(`a${code(0xdc00)}b`), 'ab', 'a lone low surrogate');
  assert.equal(cleanText('smile \u{1F600} ok'), 'smile \u{1F600} ok', 'a surrogate PAIR (an emoji) stays');
});

test('cleanText: quotes, backslashes, backticks, ${}, $&, tags and unicode are data and stay exactly as typed', () => {
  for (const text of [
    'MacBook Air 13" M1',
    "O'Brien's",
    'C:\\temp\\x',
    'a`b`',
    '${x} ${process.exit(1)}',
    '$& $1 $$ $` $\'',
    '</script><script>alert(1)</script>',
    '<!-- c -->',
    '<a href="x">&amp; &lt; ]]></a>',
    'Café 日本語 \u{1F600} £5',
    '"); throw new Error("x"); ("',
  ]) {
    assert.equal(cleanText(text), text);
  }
});

test('cleanText: numbers, null and undefined', () => {
  assert.equal(cleanText(12.5), '12.5');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(0), '0');
});

test('cleanText is idempotent', () => {
  for (const text of [`  a${NUL}  b\n${LS}c  `, 'x', '   ', `${code(0xd800)}  y`]) assert.equal(cleanText(cleanText(text)), cleanText(text));
});

test('truncateText: cuts to the byte limit, never inside a character', () => {
  assert.equal(MAX_TEXT_BYTES, 2048);
  assert.equal(truncateText('abc'), 'abc');
  assert.equal(truncateText('a'.repeat(2048)).length, 2048);
  assert.equal(truncateText('a'.repeat(5000)).length, 2048);
  const euros = truncateText('\u20AC'.repeat(1000)); // 3 bytes each
  assert.equal(Buffer.byteLength(euros), 2046);
  assert.equal(euros.length, 682);
  assert.ok(!euros.includes('\uFFFD'));
  const emoji = truncateText('\u{1F600}'.repeat(1000)); // 4 bytes each
  assert.equal(Buffer.byteLength(emoji), 2048);
  assert.equal([...emoji].length, 512);
  assert.equal(truncateText('é'.repeat(2000), 11), 'ééééé', 'a custom limit; 2 bytes per character');
  assert.equal(truncateText('', 10), '');
});

test('readField: cleaned and cut', () => {
  assert.equal(readField('  a\nb  '), 'a b');
  assert.equal(readField('x'.repeat(5000)).length, 2048);
  assert.equal(readField(undefined), '');
});

test('maskBarcodeText: v1 rule, up to 6 characters unchanged, longer ones keep the last 6 behind stars', () => {
  assert.equal(maskBarcodeText(''), '');
  assert.equal(maskBarcodeText('123'), '123');
  assert.equal(maskBarcodeText('123456'), '123456');
  assert.equal(maskBarcodeText('1234567'), '*234567');
  assert.equal(maskBarcodeText('ABCDEFGH123456'), '********123456');
  assert.equal(maskBarcodeText(1234567), '*234567');
  assert.equal(maskBarcodeText(undefined), '');
  assert.equal(maskBarcodeText(null), '');
});

test('maskBarcodeShort: two stars and the last 6 characters above 6, else the text (designs 4 and the 25x25 QR label)', () => {
  assert.equal(maskBarcodeShort(''), '');
  assert.equal(maskBarcodeShort('123456'), '123456');
  assert.equal(maskBarcodeShort('1234567'), '**234567');
  assert.equal(maskBarcodeShort('ABCDEFGH123456'), '**123456');
  assert.equal(maskBarcodeShort(undefined), '');
});

test('conditionLabel: New is NEW, A+ is Like New, another grade is GRADE <grade>, empty is nothing', () => {
  assert.equal(conditionLabel('New'), 'NEW');
  assert.equal(conditionLabel('A+'), 'Like New');
  assert.equal(conditionLabel('A'), 'GRADE A');
  assert.equal(conditionLabel('B+'), 'GRADE B+');
  assert.equal(conditionLabel('Refurbished'), 'GRADE Refurbished');
  assert.equal(conditionLabel(5), 'GRADE 5');
  assert.equal(conditionLabel('new'), 'GRADE new', 'the comparison is exact, like v1');
  for (const empty of ['', '   ', '\n', undefined, null]) assert.equal(conditionLabel(empty), '', JSON.stringify(empty));
});

test('buildSpecs: condition, storage, network, RAM, processor, colour, upper-cased, empty entries dropped', () => {
  assert.deepEqual(buildSpecs({ grade: 'A+', storage: '128gb', network: 'Unlocked', ram: '4GB', processor: 'a15', color: 'Blue' }), [
    'LIKE NEW',
    '128GB',
    'UNLOCKED',
    '4GB',
    'A15',
    'BLUE',
  ]);
  assert.deepEqual(buildSpecs({ grade: 'New', color: 'Red' }), ['NEW', 'RED']);
  assert.deepEqual(buildSpecs({ storage: '64GB', ram: '2GB' }), ['64GB', '2GB'], 'no condition, no GRADE entry');
  assert.deepEqual(buildSpecs({ grade: 'B', network: 'EE' }), ['GRADE B', 'EE']);
  assert.deepEqual(buildSpecs({}), []);
  assert.deepEqual(buildSpecs(), []);
});

test('buildSpecs: blank entries do not take a slot, so later specs move up', () => {
  assert.deepEqual(buildSpecs({ grade: 'A', storage: '   ', network: '\n', ram: '4GB', processor: undefined, color: null }), ['GRADE A', '4GB']);
});

test('buildSpecs: values are cleaned before they are upper-cased and cut', () => {
  assert.deepEqual(buildSpecs({ storage: ' 128  gb\n' }), ['128 GB']);
  assert.equal(buildSpecs({ storage: 'x'.repeat(5000) })[0].length, 2048);
});

test('cleanSpecList: an ordered list from the dashboard is cleaned and upper-cased, empties dropped, cut to 8 entries', () => {
  const { cleanSpecList, MAX_SPEC_ENTRIES } = require('../../src/main/printing/labelText');
  assert.equal(MAX_SPEC_ENTRIES, 8);
  assert.deepEqual(cleanSpecList(['Grade A', '  256gb ', '', null, undefined, 'Intel   i7\n', 5]), ['GRADE A', '256GB', 'INTEL I7', '5']);
  assert.deepEqual(cleanSpecList([]), []);
  assert.equal(cleanSpecList(Array.from({ length: 20 }, (_, index) => `s${index}`)).length, 8);
});
