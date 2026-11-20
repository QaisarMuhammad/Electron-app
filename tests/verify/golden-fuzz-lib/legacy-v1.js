'use strict';

/**
 * Runs the REAL v1.6.1 `send-barcode-data` listener (tests/fixtures/legacy-index.js, the pristine file) through the fake-electron hook
 * (tests/helpers/fake-electron.js) and hands every script it generates to `exec`, which a caller points at any framework (here: the real
 * DYMO framework in a vm, see real-dymo.js).
 *
 * This is deliberately NOT tests/helpers/vm-dymo.js `goldenOps`: it is the same mechanism written again, so a mistake in that helper
 * cannot hide a difference.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createFakeElectron, interceptModules, silenceConsole } = require('../../helpers/fake-electron');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LEGACY_INDEX = path.join(ROOT, 'tests', 'fixtures', 'legacy-index.js');
const LABELS_DIR = path.join(ROOT, 'labels');

/**
 * @param {object} payload the legacy envelope (it is structured-cloned first, as IPC does)
 * @param {(code: string) => Promise<any>} exec `webContents.executeJavaScript` of the hidden DYMO window
 * @returns {Promise<{ reads: string[], template: (string|null), scripts: string[], execErrors: string[], handlerError: (string|null) }>}
 */
async function runLegacyHandler(payload, exec) {
  const fake = createFakeElectron();
  const scripts = [];
  const execErrors = [];
  fake.hooks.onWindowCreated = (win) => {
    win.webContents.executeJavaScript = (code) => {
      scripts.push(String(code));
      return exec(code).catch((error) => {
        execErrors.push(String((error && error.cause && error.cause.message) || (error && error.message) || error));
        throw error;
      });
    };
  };

  const reads = [];
  const redirect = (file) => (typeof file === 'string' && file.endsWith('.dymo') ? path.join(LABELS_DIR, path.basename(file)) : file);
  const stubFs = Object.assign(Object.create(fs), {
    existsSync: (file) => fs.existsSync(redirect(file)),
    readFileSync(file, ...rest) {
      if (typeof file === 'string' && file.endsWith('.dymo')) reads.push(path.basename(file));
      return fs.readFileSync(redirect(file), ...rest);
    },
  });
  const stubs = {
    electron: fake.electron,
    pdfkit: class PDFDocument {},
    'electron-store': class ElectronStore {},
    child_process: { exec() {}, execFile() {} },
    fs: stubFs,
  };

  const restoreModules = interceptModules((request, parent) =>
    parent && parent.filename === LEGACY_INDEX && Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : undefined
  );
  const restoreConsole = silenceConsole();
  let handlerError = null;
  try {
    delete require.cache[LEGACY_INDEX];
    require(LEGACY_INDEX); // registers the ipc listeners; app.whenReady() never resolves, so no window is created
    await fake.ipcMain.simulateSend('send-barcode-data', structuredClone(payload));
  } catch (error) {
    handlerError = error && error.message ? error.message : String(error);
  } finally {
    restoreConsole();
    restoreModules();
    delete require.cache[LEGACY_INDEX];
  }
  return { reads, template: reads[reads.length - 1] || null, scripts, execErrors, handlerError };
}

module.exports = { LEGACY_INDEX, runLegacyHandler };
