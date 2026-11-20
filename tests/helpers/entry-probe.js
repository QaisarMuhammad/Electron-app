'use strict';

/**
 * A child process for tests/boot/entry.test.js (not a test file itself: it does not end in `.test.js`). It loads src/main/index.js
 * the way Electron's two loaders do, with a stub `electron` module whose single-instance lock answers "another instance is running"
 * (so the boot stops right there, touching nothing), and prints `BOOTSTRAP-RAN` when `bootstrap()` ran.
 *
 *   node entry-probe.js <installed|default-app|required|plain-node>
 *
 *   installed    `Module._load(file, Module, true)`: what Electron runs for an INSTALLED app (resources/app.asar). The file's
 *                `module.parent` is the Module class and `require.main` is the module itself.
 *   default-app  no parent module and `require.main` undefined: `electron .`, `electron <folder>`, `electron <archive>`.
 *   required     `require(file)` from another module: a test or a harness. It must stay inert.
 *   plain-node   the installed shape, but without `process.versions.electron`: running the file with plain Node must not start it.
 *
 * Environment: PROBE_INDEX (absolute path of src/main/index.js) and PROBE_USER_DATA (an empty folder).
 */

const Module = require('node:module');

const mode = process.argv[2];
const indexFile = process.env.PROBE_INDEX;

if (mode !== 'plain-node') Object.defineProperty(process.versions, 'electron', { value: '32.3.3', enumerable: true, configurable: true });

const electron = {
  app: {
    isPackaged: true,
    commandLine: { appendSwitch() {} },
    getPath: () => process.env.PROBE_USER_DATA,
    setAppUserModelId() {},
    requestSingleInstanceLock() {
      process.stdout.write('BOOTSTRAP-RAN\n');
      return false;
    },
    quit() {},
  },
  ipcMain: { on() {}, removeListener() {} },
};

const load = Module._load;
Module._load = function patched(request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

if (mode === 'installed' || mode === 'plain-node') {
  Module._load(indexFile, Module, true);
} else if (mode === 'default-app') {
  process.mainModule = undefined; // `require.main` of a module compiled from now on
  Module._load(indexFile, undefined, false);
} else if (mode === 'required') {
  require(indexFile);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
