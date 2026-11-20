'use strict';

/**
 * electron-builder `afterPack` hook (package.json `build.afterPack`): flips the Electron fuses of the packaged application before
 * it is signed. docs/RELEASE.md, "Owner release gates", says why and how to check the result.
 *
 * A fuse is a switch inside the Electron executable itself. The ones that ship switched on make the signed application a general
 * tool: with `RunAsNode` the executable is a Node interpreter (ELECTRON_RUN_AS_NODE), with `EnableNodeCliInspectArguments` and
 * `EnableNodeOptionsEnvironmentVariable` anything that can start it can attach a debugger to the main process, which is where
 * the drawer password is checked, and without `OnlyLoadAppFromAsar` an `app` folder next to the archive replaces the code. They are
 * switched off (and the last one on) here:
 *
 *   RunAsNode                                  off
 *   EnableNodeCliInspectArguments              off
 *   EnableNodeOptionsEnvironmentVariable       off
 *   OnlyLoadAppFromAsar                        on
 *   EnableEmbeddedAsarIntegrityValidation      on, on macOS only
 *
 * The last one checks the archive against a digest that the packager embeds. electron-builder 24 embeds it on macOS (Info.plist) and
 * does not on Windows, where the fuse would make the application refuse to start; switch it on for Windows when the packager in use
 * embeds the digest there (electron-builder 25 and later do; check the first build, RELEASE.md).
 *
 * It needs `@electron/fuses` (a devDependency). When it is not installed this hook FAILS the build with that message: an installer
 * with the fuses in their shipped state must never be made by accident.
 *
 * This file is a build tool: package.json keeps it out of the installer (`build.files`).
 */

const path = require('node:path');

/** Fuses and the state they are put in on every platform (names of `FuseV1Options`). */
const FUSES = Object.freeze({
  RunAsNode: false,
  EnableNodeCliInspectArguments: false,
  EnableNodeOptionsEnvironmentVariable: false,
  OnlyLoadAppFromAsar: true,
});

/** Platforms whose packager embeds the ASAR digest that EnableEmbeddedAsarIntegrityValidation checks (electron-builder's names). */
const ASAR_INTEGRITY_PLATFORMS = Object.freeze(['darwin']);

/**
 * @param {() => Promise<object>} [importModule] how the package is loaded (replaced by the tests)
 * @returns {Promise<object>} the `@electron/fuses` module (CommonJS in version 1, ES module in later ones: `import()` loads both)
 * @throws {Error} with the way out when the package is not installed
 */
async function loadFuses(importModule = () => import('@electron/fuses')) {
  let loaded;
  try {
    loaded = await importModule();
  } catch (error) {
    if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
      throw new Error(
        'The Electron fuses cannot be flipped because the package @electron/fuses is not installed. ' +
          'Run "npm install" in the project folder (it is a devDependency) and build again. The installer was not built.',
      );
    }
    throw error;
  }
  return typeof loaded.flipFuses === 'function' ? loaded : loaded.default;
}

/**
 * The file `flipFuses` is given: the executable on Windows and Linux, the application bundle on macOS.
 * @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string }, executableName?: string } }} context electron-builder's AfterPackContext
 * @returns {string}
 */
function executableOf({ appOutDir, electronPlatformName, packager }) {
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${name}.exe`);
  if (electronPlatformName === 'darwin') return path.join(appOutDir, `${name}.app`);
  return path.join(appOutDir, packager.executableName || name);
}

/**
 * The configuration `flipFuses` takes.
 * @param {string} platform electron-builder's `electronPlatformName` ('win32', 'darwin' or 'linux')
 * @param {{ FuseVersion: object, FuseV1Options: object }} fuses the `@electron/fuses` module
 * @returns {object}
 * @throws {Error} when the installed `@electron/fuses` has no fuse of one of the names above
 */
function fuseConfig(platform, { FuseVersion, FuseV1Options }) {
  const wanted = { ...FUSES };
  if (ASAR_INTEGRITY_PLATFORMS.includes(platform)) wanted.EnableEmbeddedAsarIntegrityValidation = true;
  // Flipping the binary invalidates a macOS ad-hoc signature; electron-builder signs after this hook, but an unsigned build needs it reset.
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin' };
  for (const [name, state] of Object.entries(wanted)) {
    if (FuseV1Options[name] === undefined) throw new Error(`The installed @electron/fuses has no fuse called ${name}: use a newer version of it.`);
    config[FuseV1Options[name]] = state;
  }
  return config;
}

/**
 * @param {object} context electron-builder's AfterPackContext
 * @param {{ loadFuses?: () => Promise<object> }} [options] `loadFuses` is replaced by the tests
 * @returns {Promise<void>}
 */
async function afterPack(context, { loadFuses: load = loadFuses } = {}) {
  const fuses = await load();
  const target = executableOf(context);
  await fuses.flipFuses(target, fuseConfig(context.electronPlatformName, fuses));
  process.stdout.write(`  • Electron fuses flipped in ${path.basename(target)} (${context.electronPlatformName})\n`);
}

module.exports = { afterPack, loadFuses, fuseConfig, executableOf, FUSES, ASAR_INTEGRITY_PLATFORMS };
