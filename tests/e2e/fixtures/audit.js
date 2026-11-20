'use strict';
/*
 * Page audit for tests/e2e/ui-shots.js. `pageAudit` is stringified and evaluated INSIDE the page under test, so it must be
 * fully self-contained (no references to anything outside its own body).
 *
 * It checks the written rules of SPEC 14 and 6.3 and the performance rules of 18b:
 *   csp, inline-style, inline-script, inline-handler, external-resource   page lock-down (6.3)
 *   target-size                                                            44 px touch targets
 *   name                                                                   every control has an accessible name
 *   contrast                                                               text >= 4.5:1 (3:1 for large text)
 *   overlap, clipped, h-scroll                                             no overlapping or clipped text, no sideways scroll
 *   animation, keyframes, transition                                       only transform / opacity move (18b)
 *   reduced-motion                                                         no endless animation under prefers-reduced-motion
 *   lang, title                                                            document basics
 *
 * While a modal <dialog> is open only the dialog is audited (the page behind it is inert and dimmed).
 *
 * @param {{reducedMotion?: boolean, csp: string}} options
 * @returns {{issues: {kind:string, message:string, where:string}[], metrics: object}}
 */
function pageAudit(options) {
  const issues = [];
  const doc = document;
  const modal = doc.querySelector('dialog[open]');
  const scope = modal || doc.body;

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const add = (kind, message, el) => issues.push({ kind, message, where: describe(el) });

  const isShown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isScreenReaderOnly = (el) => !!el.closest('.sr-only');
  /** Content of a closed <details> (other than its summary) is not on screen even though it keeps a layout box. */
  const inClosedDetails = (el) => {
    const details = el.closest('details');
    return !!details && !details.open && !el.closest('summary');
  };

  /* ---- colour helpers ---- */
  const parseColor = (str) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    const mix = (t, b) => (a === 0 ? 0 : (t * top.a + b * bottom.a * (1 - top.a)) / a);
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const backgroundOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 0.999) break;
    }
    let out = layers.pop() || { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) out = over(layers.pop(), out);
    return out;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return o;
  };
  const isDisabled = (el) => !!el.closest(':disabled, [aria-disabled="true"], [disabled]');

  /* ---- 6.3 page lock-down ---- */
  const cspMeta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!cspMeta) add('csp', 'No Content-Security-Policy meta tag', doc.head);
  else if (cspMeta.getAttribute('content') !== options.csp) add('csp', `CSP differs from SPEC 6.3: ${cspMeta.getAttribute('content')}`, cspMeta);
  for (const el of doc.querySelectorAll('[style]')) add('inline-style', 'style attribute is forbidden by the CSP', el);
  for (const el of doc.querySelectorAll('script:not([src])')) add('inline-script', 'inline script is forbidden by the CSP', el);
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) if (/^on/i.test(attr.name)) add('inline-handler', `inline handler ${attr.name}`, el);
  }
  for (const el of doc.querySelectorAll('link[href], script[src], img[src], source[srcset]')) {
    const ref = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('srcset') || '';
    if (/^(https?:)?\/\//i.test(ref)) add('external-resource', `external resource ${ref}`, el);
  }
  if (!doc.documentElement.lang) add('lang', 'html has no lang attribute', doc.documentElement);
  if (!doc.title.trim()) add('title', 'document has no title', doc.head);

  /* ---- 44 px targets and accessible names ---- */
  const nameOf = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => (doc.getElementById(id) || {}).textContent || '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((l) => l.textContent).join(' ').trim();
      if (text) return text;
    }
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    return (el.getAttribute('title') || '').trim();
  };
  const interactive = scope.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"], [role="switch"], [tabindex]:not([tabindex="-1"])',
  );
  for (const el of interactive) {
    if (isScreenReaderOnly(el) && !(el instanceof HTMLInputElement && /radio|checkbox/.test(el.type))) continue;
    if (inClosedDetails(el)) continue;
    const isChoice = el instanceof HTMLInputElement && /radio|checkbox/.test(el.type);
    const hit = isChoice ? el.closest('label') || el : el;
    if (!isShown(hit)) continue;
    if (el.tagName === 'DIALOG') continue;
    const r = hit.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) add('target-size', `target is ${Math.round(r.width)}x${Math.round(r.height)} px (needs 44)`, hit);
    if (!nameOf(el)) add('name', 'control has no accessible name', el);
  }

  /* ---- text: contrast, overlap, clipping ---- */
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const boxes = [];
  const seenContrast = new Set();
  let textNodes = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    const parent = node.parentElement;
    if (!parent || !text.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(parent.tagName)) continue;
    if (!isShown(parent) || isScreenReaderOnly(parent) || inClosedDetails(parent)) continue;
    textNodes += 1;

    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width <= 1 || r.height <= 1) continue;
      // Text scrolled out of a clipping ancestor (for example a long printer list) is not on screen: keep only what shows.
      let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let n = parent; n && n !== doc.body && box; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const c = n.getBoundingClientRect();
        box = {
          left: Math.max(box.left, c.left),
          top: Math.max(box.top, c.top),
          right: Math.min(box.right, c.right),
          bottom: Math.min(box.bottom, c.bottom),
        };
        if (box.right - box.left <= 1 || box.bottom - box.top <= 1) box = null;
      }
      if (!box) continue;
      boxes.push({ node, parent, r: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.right - box.left, height: box.bottom - box.top }, layer: parent.closest('dialog, .toasts, #lock-banner') || doc });
    }

    if (!isDisabled(parent) && !seenContrast.has(parent)) {
      seenContrast.add(parent);
      const cs = getComputedStyle(parent);
      const fg = parseColor(cs.color);
      if (fg) {
        const bg = backgroundOf(parent);
        const alpha = fg.a * opacityOf(parent);
        const eff = over({ r: fg.r, g: fg.g, b: fg.b, a: alpha }, bg);
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        const got = ratio(eff, bg);
        if (got < need - 0.01) add('contrast', `contrast ${got.toFixed(2)}:1 (needs ${need}:1)`, parent);
      }
    }
  }
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    if (a.r.right > doc.documentElement.clientWidth + 1 || a.r.left < -1) add('clipped', 'text lies outside the window', a.parent);
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      if (a.node === b.node || a.layer !== b.layer) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 2 && iy > 0.4 * Math.min(a.r.height, b.r.height)) {
        add('overlap', `text overlaps "${describe(b.parent)}"`, a.parent);
      }
    }
  }
  if (doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1) add('h-scroll', 'the page scrolls sideways', doc.documentElement);
  for (const el of scope.querySelectorAll('*')) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || isScreenReaderOnly(el) || el.closest('.progress, .skeleton') || inClosedDetails(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && isShown(el)) {
      add('clipped', `content is wider than its box (${el.scrollWidth} > ${el.clientWidth})`, el);
    }
  }

  /* ---- motion (18b: only transform and opacity) ---- */
  const MOVABLE = new Set(['transform', 'opacity', 'offset', 'easing', 'composite', 'computedOffset']);
  for (const animation of doc.getAnimations()) {
    const effect = animation.effect;
    const keyframes = effect && effect.getKeyframes ? effect.getKeyframes() : [];
    const props = new Set();
    for (const kf of keyframes) for (const key of Object.keys(kf)) if (!MOVABLE.has(key)) props.add(key);
    const label = animation.animationName || animation.transitionProperty || 'animation';
    if (props.size) add('animation', `${label} animates ${[...props].join(', ')}`, effect && effect.target);
    if (options.reducedMotion && effect && effect.getTiming().iterations === Infinity && animation.playState === 'running') {
      add('reduced-motion', `${label} loops forever under prefers-reduced-motion`, effect.target);
    }
  }
  const walkRules = (rules, visit) => {
    for (const rule of rules) {
      if (rule.cssRules && rule.type !== CSSRule.KEYFRAMES_RULE) walkRules(rule.cssRules, visit);
      else visit(rule);
    }
  };
  for (const sheet of doc.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    walkRules(rules, (rule) => {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        for (const kf of rule.cssRules) {
          for (const prop of Array.from(kf.style)) {
            if (!['transform', 'opacity', 'animation-timing-function'].includes(prop)) add('keyframes', `@keyframes ${rule.name} animates ${prop}`, doc.documentElement);
          }
        }
      } else if (rule.style) {
        const raw = rule.style.getPropertyValue('transition-property') || rule.style.getPropertyValue('transition');
        if (raw) {
          const names = raw
            .split(/,(?![^(]*\))/)
            .map((part) => part.trim().split(/\s+/)[0])
            .filter(Boolean);
          for (const name of names) {
            if (!['transform', 'opacity', 'none'].includes(name)) add('transition', `${rule.selectorText} transitions ${name}`, doc.documentElement);
          }
        }
      }
    });
  }

  /* ---- metrics ---- */
  const images = Array.from(doc.images).map((img) => ({
    src: img.currentSrc,
    natural: img.naturalWidth,
    rendered: Math.round(img.getBoundingClientRect().width),
  }));
  const metrics = {
    elements: doc.getElementsByTagName('*').length,
    textNodes,
    images,
    interactive: interactive.length,
  };
  return { issues, metrics };
}

/**
 * Describes the keyboard focus indicator of the currently focused element (stringified and evaluated INSIDE the page).
 * The indicator may sit on the control itself or on the card/row that wraps it (radios and switches are hidden-style inputs
 * whose label shows the ring). `ratio` is the contrast of the ring colour against the background behind it (needs 3:1).
 * @returns {null | {name:string, ring:boolean, width:number, color:string, ratio:number}}
 */
function focusProbe() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const parse = (str) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const backgroundOf = (node) => {
    const layers = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 0.999) break;
    }
    let out = layers.pop() || { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) {
      const top = layers.pop();
      const a = top.a + out.a * (1 - top.a);
      out = { r: (top.r * top.a + out.r * out.a * (1 - top.a)) / a, g: (top.g * top.a + out.g * out.a * (1 - top.a)) / a, b: (top.b * top.a + out.b * out.a * (1 - top.a)) / a, a };
    }
    return out;
  };
  const name = el.id || el.getAttribute('aria-label') || `${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(' ')[0]}`;
  const holders = [el, el.closest('label'), el.closest('summary'), el.closest('.choice'), el.closest('.picker__row'), el.closest('.switch-row')].filter(Boolean);
  for (const holder of holders) {
    const cs = getComputedStyle(holder);
    const width = parseFloat(cs.outlineWidth);
    if (cs.outlineStyle !== 'none' && width >= 2) {
      const ring = parse(cs.outlineColor);
      const bg = backgroundOf(holder.parentElement || holder);
      const a = lum(ring);
      const b = lum(bg);
      return { name, ring: true, width, color: cs.outlineColor, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    }
  }
  return { name, ring: false, width: 0, color: '', ratio: 0 };
}

module.exports = { pageAudit, focusProbe };
