'use strict';

/*
 * Contrast of the solid buttons in every state and in both themes, computed from the shipped CSS (SPEC 14: text >= 4.5:1).
 *
 * tests/e2e/ui-shots.js audits the pages in their resting state with the colours Chromium computes. It never sees :hover and
 * :active, and the destructive button is inactive in its screenshots, so those states are checked here without an Electron
 * runtime: the colours are read from tokens.css and components.css and resolved the way the browser does (var() and light-dark()).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHARED = path.join(__dirname, '..', '..', 'src', 'renderer', 'shared');
const readCss = (file) => fs.readFileSync(path.join(SHARED, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `--name: value;` pairs of one rule body. */
function declarations(body) {
  const out = new Map();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(match[1], match[2].trim());
  return out;
}

const tokens = declarations(/:root\s*\{([^}]*)\}/.exec(readCss('tokens.css'))[1]);
const components = readCss('components.css');

/** The custom properties set by the first rule whose selector is exactly `selector` (a grouped or longer selector does not match). */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(components);
  assert.ok(match, `components.css has a rule for ${selector}`);
  return declarations(match[1]);
}

/** Resolves var(--token) and light-dark(a, b) to the colour for `theme`. */
function resolve(value, theme, depth = 0) {
  assert.ok(depth < 8, `var() nests too deeply in ${value}`);
  const text = value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    assert.ok(tokens.has(name), `tokens.css defines ${name}`);
    return resolve(tokens.get(name), theme, depth + 1);
  });
  const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(text.trim());
  return pair ? (theme === 'light' ? pair[1] : pair[2]) : text.trim();
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the contrast helper reproduces the WCAG reference values', () => {
  assert.equal(contrast('#FFFFFF', '#000000').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#FFFFFF').toFixed(2), '4.48');
});

test('the colours are read from the CSS the way the browser resolves them', () => {
  assert.equal(resolve('var(--brand)', 'light'), '#C12126');
  assert.equal(resolve('var(--brand-hover)', 'light'), '#A91D21');
  assert.equal(resolve('var(--brand-hover)', 'dark'), '#D52D33');
  assert.equal(resolve('light-dark(#B42318, #D9483C)', 'dark'), '#D9483C');
});

const BUTTONS = [
  { name: 'primary', state: '.btn--primary', variant: '.btn--primary' },
  { name: 'primary hover', state: '.btn--primary:hover', variant: '.btn--primary' },
  { name: 'primary pressed', state: '.btn--primary:active', variant: '.btn--primary' },
  { name: 'destructive', state: '.btn--danger-solid', variant: '.btn--danger-solid' },
  { name: 'destructive hover', state: '.btn--danger-solid:hover', variant: '.btn--danger-solid' },
];

for (const theme of ['light', 'dark']) {
  for (const { name, state, variant } of BUTTONS) {
    test(`${name} button text is at least 4.5:1 in the ${theme} theme`, () => {
      const own = rule(state);
      const base = rule(variant);
      const background = resolve(own.get('--btn-bg') || base.get('--btn-bg'), theme);
      const text = resolve(own.get('--btn-fg') || base.get('--btn-fg'), theme);
      const ratio = contrast(text, background);
      assert.ok(ratio >= 4.5, `${text} on ${background} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
    });
  }
}
