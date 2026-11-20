/*
 * GadgetsPOS Desktop - inline SVG icon set (no external files, no fonts).
 *
 * 24x24 grid, 1.75 stroke, round caps. `icon(name)` returns a ready <svg class="icon">; `hydrateIcons(root)` replaces
 * every <i data-icon="name" class="..."></i> placeholder with the svg (the placeholder's classes are kept), so static
 * HTML can mention an icon without any inline markup. Icons are cloned from one cached template per name.
 */

const PATHS = {
  printer: '<path d="M7 8V4h10v4"/><rect x="3.5" y="8" width="17" height="9" rx="2"/><path d="M7 14h10v6.5H7z"/><path d="M16.5 11.5h.01"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  label: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.5 9.5v5M10 9.5v5M12.5 9.5v5M14.5 9.5v5M16.8 9.5v5"/>',
  roll: '<circle cx="8.5" cy="12" r="5.5"/><circle cx="8.5" cy="12" r="1.75"/><path d="M14 8h6.5v8H14"/>',
  drawer: '<path d="M4 13h16v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><path d="M5.5 13L7 6.5a1.5 1.5 0 0 1 1.45-1.1h7.1A1.5 1.5 0 0 1 17 6.5L18.5 13"/><path d="M10 16.25h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  plug: '<path d="M9 3.5V8M15 3.5V8"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v3.5"/>',
  unplug: '<path d="M9 3.5V8M15 3.5V8"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v3.5"/><path d="M3.5 3.5l17 17"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.75h.01"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8 5.5-5.6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  alert: '<path d="M12 3.8l9 15.7H3z"/><path d="M12 10v4.2M12 17.2h.01"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.2M12 16.2h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.8v2"/>',
  key: '<circle cx="8" cy="15.5" r="3.5"/><path d="M10.6 13l8.4-8.4M15.5 8.1l2.4 2.4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.75"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.7a9.6 9.6 0 0 1 2.1-.2c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.3M6.6 7.6A15.7 15.7 0 0 0 2.5 12S6 18.5 12 18.5c1.4 0 2.7-.3 3.8-.9"/><path d="M10 10.2a2.75 2.75 0 0 0 3.8 3.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5.5M14 11v5.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15.5V6A1.5 1.5 0 0 1 7 4.5h9.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  download: '<path d="M12 4.5v10.5M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
  'shield-alert': '<path d="M12 3l7.5 2.8v5.7c0 4.6-3.2 7.9-7.5 9.5-4.3-1.6-7.5-4.9-7.5-9.5V5.8z"/><path d="M12 8.5v4M12 15.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.3 2"/>',
  'wifi-off': '<path d="M3.5 3.5l17 17"/><path d="M2.5 9.2A15.2 15.2 0 0 1 8 6.2M21.5 9.2A15.2 15.2 0 0 0 12 5.8"/><path d="M5.8 12.6a10 10 0 0 1 3.6-2M18.2 12.6a10 10 0 0 0-3-2"/><path d="M9 16.2a4.6 4.6 0 0 1 5.9-.4"/><path d="M12 19.5h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.4c-.8.4-1.2 1-1.2 1.9M12 16.8h.01"/>',
  bolt: '<path d="M13 3L5.5 13.5H11L10 21l7.5-10.5H12z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  power: '<path d="M12 3.5v8"/><path d="M7 6.5a7.5 7.5 0 1 0 10 0"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
  fullscreen: '<path d="M4.5 9V5.5H8M16 5.5h3.5V9M19.5 15v3.5H16M8 18.5H4.5V15"/>',
  timer: '<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.7l2.2 1.5M9.5 3.5h5"/>',
  file: '<path d="M7 3.5h7.5L19 8v12.5H7z"/><path d="M14.5 3.5V8H19M9.5 12.5h6M9.5 16h6"/>',
  laptop: '<rect x="5" y="5.5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
  'chevron-down': '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  'chevron-right': '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  shield: '<path d="M12 3l7.5 2.8v5.7c0 4.6-3.2 7.9-7.5 9.5-4.3-1.6-7.5-4.9-7.5-9.5V5.8z"/><path d="M8.8 12l2.2 2.2 4.2-4.4"/>',
  trash2: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7"/>',
};

const cache = new Map();

/** Returns the markup template for an icon, building it once. */
function template(name) {
  let tpl = cache.get(name);
  if (!tpl) {
    const body = PATHS[name] || PATHS['alert-circle'];
    tpl = document.createElement('template');
    tpl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
    cache.set(name, tpl);
  }
  return tpl;
}

/**
 * Creates an icon element.
 * @param {string} name icon key (see PATHS)
 * @param {string} [extraClass] extra classes, for example "icon--sm"
 * @returns {SVGElement}
 */
export function icon(name, extraClass = '') {
  const svg = template(name).content.firstChild.cloneNode(true);
  if (extraClass) svg.setAttribute('class', `icon ${extraClass}`);
  return svg;
}

/**
 * Replaces every <i data-icon="name"></i> placeholder below `root` with its svg, keeping the placeholder's classes.
 * @param {ParentNode} [root]
 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const svg = icon(el.dataset.icon, el.className);
    el.replaceWith(svg);
  }
}

