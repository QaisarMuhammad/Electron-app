'use strict';

/**
 * Group A of the runtime-e2e lens: the REAL app started on damaged, odd and hostile settings files (config.json, flags.json).
 * For every variant a fresh userData folder holds the file, the real app starts against a healthy fake POS, and the checks ask: did it
 * start, did the POS load, was no "could not start" box shown, did nothing throw, is a damaged file quarantined, does Settings open and
 * paint, can a setting still be saved, and is config.json valid JSON again after the quit.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createBreakServer } = require('./break-server');
const {
  AppRun, scenario, sleep, waitFor, waitForPos, makeDir, OUT_DIR,
} = require('./harness');

const MB = 1024 * 1024;

/** The odd v1 file: every legacy key with a value v1 could never have written. */
const V1_ODD = { printerName: 123, printerPort: null, password: '', labelPrinterName: {}, labelPrinterPort: ['x'], a4Password: 'p', printerBrand: 5 };

const VARIANTS = [
  { id: 'empty', note: '0-byte file', quarantined: true, write: () => '' },
  { id: 'garbage', note: 'not JSON', quarantined: true, write: () => '{this is not json' },
  { id: 'truncated', note: 'JSON cut in the middle', quarantined: true, write: () => '{"serverUrl":"https://vendor.societyfiles.com/vendor/point-of-sale?active=buy","printers":{"receipt":{"transport":"sys' },
  { id: 'nul-bytes', note: '64 NUL bytes', quarantined: true, write: () => Buffer.alloc(64) },
  { id: 'array', note: 'valid JSON: []', write: () => '[]' },
  { id: 'null', note: 'valid JSON: null', write: () => 'null' },
  { id: 'string', note: 'valid JSON: a string', write: () => '"hello"' },
  { id: 'number', note: 'valid JSON: 123', write: () => '123' },
  { id: 'bom', note: 'UTF-8 BOM before valid JSON', write: () => `﻿${JSON.stringify({ schemaVersion: 2, printers: { receipt: { transport: 'system', printerName: 'BOM-Printer', port: '' } } })}` },
  { id: 'v1-odd', note: 'v1 file with odd values', settings: true, write: () => JSON.stringify(V1_ODD) },
  { id: 'v1-password-number', note: 'v1 file whose password is a number', write: () => JSON.stringify({ printerName: 'P', password: 12345 }) },
  { id: 'v1-password-huge', note: 'v1 file with a 1 MB password', write: () => JSON.stringify({ printerName: 'P', password: 'x'.repeat(MB) }) },
  {
    id: 'v2-wrong-types',
    note: 'schema 2 with a wrong type everywhere',
    settings: true,
    write: () => JSON.stringify({
      schemaVersion: 2,
      serverUrl: 12345,
      extraAllowedOrigins: 'https://evil.example.com',
      printers: 'x',
      drawer: [],
      window: { bounds: { x: 'a', y: null, width: -5, height: 1e12 }, zoomLevel: 'big', maximized: 'yes', fullScreen: 'no', startFullScreen: 5 },
      updates: [],
      startup: null,
      power: 5,
    }),
  },
  {
    id: 'v2-offscreen',
    note: 'window far off every display, zoom 99, huge size',
    settings: true,
    offscreen: true,
    write: () => JSON.stringify({ schemaVersion: 2, window: { bounds: { x: 99999, y: -99999, width: 50000, height: 40000 }, zoomLevel: 99, maximized: false, fullScreen: false } }),
  },
  { id: 'huge', note: '10 MB of unknown keys', write: () => JSON.stringify({ schemaVersion: 2, junk: 'j'.repeat(10 * MB) }) },
  { id: 'directory', note: 'config.json is a FOLDER', directory: true, write: () => null },
  { id: 'unreadable', note: 'config.json has no read permission (chmod 000)', chmod: 0o000, write: () => JSON.stringify({ schemaVersion: 2 }) },
  { id: 'flags-garbage', note: 'flags.json is not JSON', flags: '{{{{', write: () => JSON.stringify({ schemaVersion: 2 }) },
  { id: 'flags-wrong-types', note: 'flags.json with wrong types', flags: JSON.stringify({ disableGpu: 'yes', disableBrotli: 7, reason: {}, gpuChecked: 'maybe' }), write: () => JSON.stringify({ schemaVersion: 2 }) },
];

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runConfigGroup(only) {
  const wants = (id) => !only || only.includes(id) || only.includes('A');
  for (const variant of VARIANTS) {
    if (!wants(`A-${variant.id}`)) continue;
    await scenario(`A-${variant.id}`, `Startup on a damaged or odd settings file: ${variant.note}`, async (t) => {
      const server = await createBreakServer();
      const userData = makeDir(`config-${variant.id}`);
      const file = path.join(userData, 'config.json');
      if (variant.directory) fs.mkdirSync(file);
      else {
        fs.writeFileSync(file, variant.write());
        if (variant.chmod !== undefined) fs.chmodSync(file, variant.chmod);
      }
      if (variant.flags !== undefined) fs.writeFileSync(path.join(userData, 'flags.json'), variant.flags);
      const run = new AppRun({ name: `a-${variant.id}`, userData, startUrl: server.smokeUrl });
      let started = false;
      try {
        try {
          await run.start();
          started = true;
        } catch (error) {
          t.check('the app starts', false, error.message);
          return;
        }
        t.check('the app starts', true);
        const pos = await waitForPos(run, server.origin, 30_000).catch(() => null);
        const events = run.events();
        const state = await run.cmd('state').catch(() => null);
        t.check('the POS page loads (no blank window, no error screen)', Boolean(pos), await run.cmd('mainInfo').catch(() => null));
        t.check('no "could not start" box was shown', !(state && state.dialogs.some((box) => /could not start/i.test(box.message))), state && state.dialogs);
        t.check('no uncaught exception or unhandled rejection', !events.some((event) => ['uncaught', 'unhandled-rejection', 'launch-failed'].includes(event.type)), events.filter((event) => ['uncaught', 'unhandled-rejection', 'launch-failed'].includes(event.type)));
        const electron = await run.page('return typeof window.electron;').catch(() => ({}));
        t.check('window.electron is available on the POS page', electron.ok && electron.value === 'object', electron);

        const config = await run.cmd('config').catch((error) => ({ error: error.message }));
        t.check('the settings the app works with are complete objects (printers, drawer, window)', config && config.printers && typeof config.printers.receipt === 'object' && config.drawer && typeof config.drawer === 'object' && config.window && typeof config.window === 'object', config);
        t.record('config', config);

        if (variant.quarantined) {
          const moved = fs.readdirSync(userData).filter((name) => /^config\.corrupt-.*\.json$/.test(name));
          t.check('the damaged file was moved to config.corrupt-<time>.json', moved.length === 1, fs.readdirSync(userData));
        }

        // can a setting still be saved?
        const saved = await run.cmd('desktopApi', { name: 'savePrinter', args: ['receipt', { transport: 'system', printerName: 'E2E-Receipt-58', port: '' }] }).catch((error) => ({ error: error.message }));
        t.check('saving a printer still works', saved && saved.ok === true, saved);

        if (variant.offscreen) {
          const info = await run.cmd('mainInfo');
          const displays = await run.cmd('displays');
          const inside = displays.some((display) => {
            const w = display.workArea;
            return info.bounds.x < w.x + w.width && info.bounds.x + info.bounds.width > w.x && info.bounds.y < w.y + w.height && info.bounds.y + info.bounds.height > w.y;
          });
          t.check('the window is on a connected display (not lost far off screen)', inside, { bounds: info.bounds, displays });
          t.check('and its size is sane (not 50000 x 40000)', info.bounds.width <= displays[0].workArea.width + 50 && info.bounds.height <= displays[0].workArea.height + 50, info.bounds);
          t.check('the zoom is clamped (-3 to 5), not 99', info.zoomLevel >= -3 && info.zoomLevel <= 5, info.zoomLevel);
        }

        if (variant.settings) {
          await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
          const win = await waitFor(async () => (await run.cmd('windows')).find((w) => /settings\.html/.test(w.url)) || null, 'the Settings window', { timeoutMs: 15_000 });
          await sleep(1800);
          const shot = await run.cmd('captureWindow', { id: win.id, file: path.join(OUT_DIR, `break-settings-${variant.id}.png`) });
          t.check('Settings opens and paints on this file', shot.ok, shot);
        }
      } finally {
        await run.stop({ timeoutMs: 15_000 }).catch(() => {});
        await server.stop();
        if (variant.chmod !== undefined) {
          try { fs.chmodSync(file, 0o600); } catch { /* the file may be gone */ }
        }
      }
      if (started && !variant.directory && variant.chmod === undefined) {
        const after = readJsonOrNull(file);
        t.check('after the quit config.json is valid JSON again', after !== null && typeof after === 'object' && !Array.isArray(after), fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 120) : 'file missing');
      }
    });
  }
}

module.exports = { runConfigGroup, VARIANTS };
