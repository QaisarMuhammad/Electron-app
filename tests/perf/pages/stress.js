/*
 * The stress page of the benchmark (tests/perf/benchmark.js): a heavy POS-like screen, the kind of UI that is slow when the page
 * is drawn on the CPU. A list of 3000 product rows (each with an avatar, a shadow, a badge, a bar and a button), 24 translucent
 * shadowed cards that move with CSS transforms on top of it, and a scrolling animation driven from requestAnimationFrame.
 * (?rows=, ?chips=, ?rowfx= and ?blur=1 change the weight: they are for calibrating the page, the benchmark uses the defaults.
 * Moving 18 list rows with transforms made the MAIN thread the limit, 30 fps in every mode; the cards are what separates drawing
 * on the CPU from drawing on the GPU.) The page
 * counts the frames it was given over the measured window: frames per second is what the user sees.
 *
 * It builds itself, reports `ready` to the server and waits for the harness's `stress` command (so the harness can put every app
 * window at the same size first). Nothing runs before that command: no animation, no timer.
 */
(function stressPage() {
  'use strict';

  const params = new URLSearchParams(location.search);
  const ROWS = Number(params.get('rows')) || 3000;
  const CHIPS = params.has('chips') ? Number(params.get('chips')) : 24;
  const BLUR = params.get('blur') === '1';
  const ROW_FX = Number(params.get('rowfx')) || 0;
  const ROW_HEIGHT = 56;
  const list = document.getElementById('list');

  const builtAt = performance.now();
  let html = '';
  for (let i = 0; i < ROWS; i += 1) {
    html += `<div class="row" role="listitem"><span class="avatar"></span><span class="name">Product ${i} Apple iPhone 13 Pro 256GB Sierra Blue unlocked</span>`
      + `<span class="sku">SKU-${100000 + i}</span><span class="badge">${i % 3 ? 'In stock' : 'Low stock'}</span>`
      + `<span class="bar"><i style="width:${(i * 37) % 100}%"></i></span><span class="qty">${(i * 7) % 50}</span>`
      + `<span class="price">&pound;${(5 + ((i * 13) % 900)).toFixed(2)}</span><button class="btn" type="button">Add</button></div>`;
  }
  list.innerHTML = html;

  const chips = [];
  for (let k = 0; k < CHIPS; k += 1) {
    const chip = document.createElement('div');
    chip.className = BLUR ? 'chip blur' : 'chip';
    chip.innerHTML = `<b>Order #${4000 + k}</b>Payment received, receipt sent`;
    chip.baseX = 40 + (k % 8) * 160;
    chip.baseY = 30 + Math.floor(k / 8) * 110;
    chip.style.left = '0px';
    chip.style.top = '0px';
    document.body.appendChild(chip);
    chips.push(chip);
  }
  const buildMs = Math.round(performance.now() - builtAt);

  /**
   * Runs the animation: `warmupMs` that is not counted, then `durationMs` that is.
   *
   * @param {{ warmupMs?: number, durationMs?: number, speed?: number }} options speed is in px/s
   * @returns {Promise<object>} the frames, frames per second and the frame-time spread
   */
  function run({ warmupMs = 1000, durationMs = 8000, speed = 2400 } = {}) {
    return new Promise((resolve) => {
      const rows = list.children;
      const maxScroll = list.scrollHeight - list.clientHeight;
      const visibilityAtStart = document.visibilityState;
      const stamps = [];
      const scriptMs = [];
      let startTs = null;
      let measureFrom = null;

      function frame(ts) {
        const scriptStart = performance.now();
        if (startTs === null) startTs = ts;
        const elapsed = ts - startTs;
        const travelled = (elapsed / 1000) * speed;
        const cycle = travelled % (2 * maxScroll);
        list.scrollTop = cycle < maxScroll ? cycle : 2 * maxScroll - cycle;

        for (let k = 0; k < chips.length; k += 1) {
          const chip = chips[k];
          const a = ts / 600 + k * 0.7;
          chip.style.transform = `translate3d(${(chip.baseX + Math.sin(a) * 60).toFixed(1)}px, ${(chip.baseY + Math.cos(a * 0.8) * 30).toFixed(1)}px, 0) `
            + `rotate(${(Math.sin(a * 0.5) * 6).toFixed(2)}deg) scale(${(1 + Math.sin(a) * 0.08).toFixed(3)})`;
        }
        if (ROW_FX > 0) {
          const first = Math.floor(list.scrollTop / ROW_HEIGHT);
          for (let r = first; r < first + ROW_FX && r < rows.length; r += 1) rows[r].style.transform = `translateX(${(Math.sin(ts / 300 + r) * 10).toFixed(1)}px)`;
        }

        if (elapsed >= warmupMs) {
          if (measureFrom === null) measureFrom = ts;
          stamps.push(ts);
          scriptMs.push(performance.now() - scriptStart);
        }
        if (measureFrom !== null && ts - measureFrom >= durationMs) {
          const intervals = [];
          for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
          const sorted = intervals.slice().sort((x, y) => x - y);
          const at = (fraction) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0);
          const seconds = (stamps[stamps.length - 1] - stamps[0]) / 1000;
          resolve({
            frames: stamps.length,
            seconds: Math.round(seconds * 1000) / 1000,
            fps: seconds > 0 ? Math.round(((stamps.length - 1) / seconds) * 100) / 100 : 0,
            frameMsP50: Math.round(at(0.5) * 10) / 10,
            frameMsP95: Math.round(at(0.95) * 10) / 10,
            frameMsP99: Math.round(at(0.99) * 10) / 10,
            frameMsMax: Math.round((sorted[sorted.length - 1] || 0) * 10) / 10,
            slowFrames: intervals.filter((interval) => interval > 25).length,
            scriptMsMean: Math.round((scriptMs.reduce((sum, value) => sum + value, 0) / Math.max(1, scriptMs.length)) * 100) / 100,
            scriptMsMax: Math.round(Math.max(0, ...scriptMs) * 100) / 100,
            visibilityAtStart,
            visibilityAtEnd: document.visibilityState,
            hasFocus: document.hasFocus(),
            rows: ROWS,
            chips: CHIPS,
            speed,
          });
          return;
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  window.__bench.onCommand('stress', run);
  void window.__bench.post('ready', {
    rows: ROWS,
    nodes: document.getElementsByTagName('*').length,
    buildMs,
    viewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    visibility: document.visibilityState,
  });
  window.__bench.startCommands();
})();
