# Releasing GadgetsPOS Desktop

How to build, sign, publish, test and roll back a release of the desktop app. Written for version 2.0.0 and checked on 2026-11-19
against the code in this repository and the sources of the installed `electron-builder` 24.13.3 and `electron-updater` 6.8.11.

**Read this first.** Version 2 was developed on a Mac, and the app has only ever run there unpackaged (`electron .`, the end-to-end
harnesses in `tests/e2e`, and an emulated installed layout, `tests/verify/packaging-installed-layout.js`). The Windows installer has
not been built, signed, installed or updated in this environment. Where this guide says what a build produces or what the installer
does, that comes from the tools' own sources, and the manual checklist in section 9 is what turns it into fact. Five owner release
gates are open and stop a public release (section 2); `npm run release:check` lists them.

## Contents

1. [A release in one page](#1-a-release-in-one-page)
2. [Before the first release: the owner release gates and what the owner must provide](#2-before-the-first-release-the-owner-release-gates-and-what-the-owner-must-provide)
3. [Versioning](#3-versioning)
4. [Building](#4-building)
5. [Code signing](#5-code-signing)
6. [The update feed](#6-the-update-feed)
7. [Allowed domains](#7-allowed-domains)
8. [Where files live](#8-where-files-live)
9. [The first v2 install and the manual Windows upgrade checklist](#9-the-first-v2-install-and-the-manual-windows-upgrade-checklist)
10. [Printing smoke test and the DYMO QR check](#10-printing-smoke-test-and-the-dymo-qr-check)
11. [Rollback](#11-rollback)

## 1. A release in one page

1. Decide the version number (section 3), write the entry in `CHANGELOG.md`, replace "not released yet" with the date.
2. `npm test` passes, and `npm run release:check` passes: every owner release gate of section 2 is closed.
3. `npm run dist` on a Windows PC with the signing certificate (section 4). It runs `npm run release:check` first and refuses to build
   while a gate is open.
4. Look inside `dist\win-unpacked\resources` (section 4.3), then install the build on a clean Windows PC and run the checks of
   sections 9 and 10.
5. Upload the installer and its `.blockmap` to the feed, then upload `latest.yml` last (section 6.4).
6. Watch a test till pick the update up (section 6.5). Tills check 30 seconds or more after they start and then every 4 hours.
7. Keep every installer you publish, and the previous `latest.yml` (section 11).

The first v2 install on a till that runs 1.x is a manual run of the installer, because 1.x has no updater (section 9).

## 2. Before the first release: the owner release gates and what the owner must provide

Five things stop a public release and cannot be done by application code: they need a network, a certificate or the owner's own
`npm install`. They are the **owner release gates**. They are NOT in `npm test` (that would keep the unit suite red for good); they
live in a separate, strict command:

```
npm run release:check
```

It prints every gate that is open, what it protects and how to close it, and exits with 1 while any is open. **`npm run dist` runs it
first** (the `predist` script) and builds nothing until it passes. Today all five are open. The gates are defined in
`tests/release/gates.js` and are judged against fake projects in `tests/packaging/release-gates.test.js`, so the check itself stays
tested while the real gates are open.

### 2.0 The owner release gates, in the order to work through them

1. **Electron is a supported major.** Protects the till from every public Chromium bug of an unsupported Electron (it shows a remote
   web page). Close it with `npm install --save-dev electron@45`, then re-run the checks of 2.1.
2. **`build.win.publisherName` is set (a signed Windows build).** Protects every till from an installer that is not the company's: without
   it the updater installs whatever the update feed serves. Close it with a code-signing certificate (5.1): set `build.win.publisherName`
   in `package.json` to the certificate's subject name, and on the build PC set the certificate variables, for example in PowerShell
   `$env:CSC_LINK = 'C:\keys\company.pfx'` and `$env:CSC_KEY_PASSWORD = '<password>'` (`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for Windows
   builds only). The repository has no certificate and none is invented: the option is left unset.
3. **The Electron fuses are flipped.** Protects the drawer password check: with the fuses as shipped the signed executable is a Node
   interpreter and a debugger can attach to the main process. `scripts/after-pack-fuses.js` (the `build.afterPack` hook, already wired and
   already declared as the devDependency `@electron/fuses`) flips them in every build and **fails the build when the package is missing**.
   Close the gate with the install below. After a build, read the fuses back: `npx @electron/fuses read --app "dist\win-unpacked\Gadgets POS.exe"`
   must show RunAsNode, EnableNodeCliInspectArguments and EnableNodeOptionsEnvironmentVariable as disabled and OnlyLoadAppFromAsar as enabled.
4. **`package-lock.json` is committed and matches `package.json`.** Protects the build from drifting: without a lock file two builds of one
   commit can hold different code and no build can be audited. `.gitignore` no longer lists it. The `package-lock.json` in the working
   folder is a leftover of 1.6.1 (it lists puppeteer and 800 other packages); the gate says so. Delete it, let `npm install` write the real
   one and commit it; build releases with `npm ci`.
5. **The update feed address is real.** Protects the rollout: while `build.publish[0].url` still holds `CHANGE-ME` the installed app turns
   its updater off. Close it with the https address of 6.3.

The exact commands, from the project folder, on a computer with internet:

```
del package-lock.json                                   (macOS/Linux: rm package-lock.json) the stale 1.6.1 file
npm install --save-dev electron@45 @electron/fuses      new Electron, the fuses package, and the real package-lock.json
npm test                                                the unit suite
node tests/e2e/run-smoke.js                             and the end-to-end checks, on the new Electron (2.1)
git add package.json package-lock.json .gitignore       commit the lock file
npm run release:check                                   what is still open: the publisher name (2) and the feed address (5)
```

`npm install --save-dev electron@45 @electron/fuses` also moves the range of `@electron/fuses` in `package.json` to its newest version;
the hook loads it with `import()`, so both the 1.x and the later ES module builds work. Use `npm install --save-dev electron@45` and then
`npm install` to keep `^1.8.0`.

Everything below says the same in more detail, one gate per subsection.

### 2.1 Electron is out of support, so `npm run dist` refuses to build

Gate 1 of `npm run release:check` (which `npm run dist` runs first) is `node tests/packaging/check-electron-support.js`, and you can
run that script alone for this part of the answer. It compares the Electron that would be packaged, and the one `package.json`
declares, with a table of end-of-support dates kept inside that script. On 2026-11-19 it answers (exit code 1):

```
Electron support check failed. The installer was not built.
  FAIL node_modules/electron 32.3.3: Electron 32 is older than 43, the oldest major that still gets security fixes.
  FAIL package.json devDependencies.electron ^32.1.2: Electron 32 is older than 43, ...
Supported on 2026-11-19: Electron 43 (until 2027-01-05), 44 (until 2027-03-02), 45 (until 2027-04-27).
```

Why it matters: the till shows a remote web page, so every published Chromium bug of an unsupported Electron applies to it. Version
1.6.1 shipped the same Electron 32.

What to do:

- Move to one of the supported majors, for example `npm install --save-dev electron@45`.
- Version 2 was built and checked only on Electron 32.3.3. Some behaviour was measured on that version and must be re-checked on the
  new one: the offline screen painting (comment in `src/main/windows/main.js`), the module list of a sandboxed preload and
  `senderFrame.origin` for `file:` pages (SPEC 6.3), and how an installed app is started (`isAppEntry` in `src/main/index.js`). Run
  `npm test`, `tests/e2e/run-app.js`, `tests/e2e/ui-shots.js` and the scripts in `tests/verify` on the new version before you build.
  The Node version inside Electron changes with it.
- Keep the gate honest (`tests/packaging/check-electron-support.js`, which gate 1 of `npm run release:check` runs). Its dates come from https://releases.electronjs.org/schedule. At every release copy the "End of Life" date of
  each major that has not ended into `SUPPORT_TABLE` in the script and set `checkedOn` (the script's own header explains it). A major
  that is not in the table is refused on purpose, which forces that edit.

### 2.2 Windows: a code-signing certificate and `build.win.publisherName`

`build.win.publisherName` is not set and there is no certificate. Without a publisher name the updater does not check who signed a
downloaded installer: it trusts the file because its hash is in a `latest.yml` served from the same place. The installer then runs
silently, so whoever can write to the update host controls every till. (A signed build gets the certificate's name written into
`app-update.yml` by electron-builder even without the option; an unsigned build gets none.) Section 5.1 says what to obtain and how to
set it. The gate, and the regression test
`tests/verify/security-packaging.test.js` (which also fails any commit that replaces the `CHANGE-ME` address with a real one while
`publisherName` is still missing), both ask for it. electron-builder's schema does not require the option, so the repository leaves it
unset until there is a certificate: no placeholder name is invented.

### 2.3 Electron fuses: the hook is written, the package has to be installed

In the shipped executable Electron's `RunAsNode`, `--inspect` and `NODE_OPTIONS` stay switched on. That makes the app binary a general
Node interpreter and lets anything that can start it attach a debugger to the main process, where the drawer password is checked.
`scripts/after-pack-fuses.js` is wired in `package.json` (`build.afterPack`) and flips, before signing: RunAsNode off,
EnableNodeCliInspectArguments off, EnableNodeOptionsEnvironmentVariable off, OnlyLoadAppFromAsar on, and (macOS only)
EnableEmbeddedAsarIntegrityValidation on. The integrity fuse stays off on Windows because electron-builder 24.13.3 embeds the archive
digest only into the macOS bundle, and a Windows executable with the fuse on and no digest does not start; with electron-builder 25 or
later, check that the first Windows build starts and read the fuses back, then add `win32` to `ASAR_INTEGRITY_PLATFORMS` in the hook.
Cookie encryption is not touched (turning it on would sign every till out of the POS). The hook is a build tool: `build.files` excludes
it from the installer. What is left is `npm install`, because `@electron/fuses` is declared but not installed in this folder; the hook
stops the build with that message until it is.

### 2.4 `package-lock.json`: not ignored any more, but the real one still has to be written and committed

`.gitignore` no longer lists `package-lock.json`. Without a committed lock file every release build resolves the `^` ranges of
`electron`, `electron-builder`, `electron-updater` and the rest afresh: two builds of the same commit can contain different code, and a
build cannot be audited later. The file that sits in this working folder was written for 1.6.1 and does not match `package.json`
(the gate compares the two), so committing it as it is would make `npm ci` fail: delete it, run `npm install`, commit the new one and
build with `npm ci`. The gate cannot see git, so committing is on the owner.

### 2.5 The update feed address is a placeholder

`build.publish[0].url` is `https://CHANGE-ME.example.com/gadgetspos-desktop/`. While it contains `CHANGE-ME` the installed app turns its
updater off (and gate 5 stays open). Section 6.3 explains how to replace it.

### What the owner must provide

| What | For | Section |
| --- | --- | --- |
| A computer with internet to run `npm install` (new Electron, `@electron/fuses`, the real `package-lock.json`) and a commit of the lock file | gates 1, 3 and 4 | 2.0 |
| A decision to move to a supported Electron major, and someone to re-run the checks on it | the build runs at all | 2.1 |
| A Windows code-signing certificate (and its name for `publisherName`) | signed installer, publisher check in the updater | 5.1 |
| A public https address to host the update files, and a way to upload to it | updates | 6 |
| A Windows PC (or a virtual machine with snapshots) that has never had GadgetsPOS | the upgrade checklist, the update test | 9 |
| A receipt printer, a Zebra (or other ZPL) printer, a DYMO LabelWriter with DYMO Connect, and a cash drawer | the printing smoke test | 10 |
| For macOS builds only: an Apple Developer ID certificate and notarisation credentials, and a Mac | signed, notarised, self-updating Mac builds | 5.2 |

## 3. Versioning

- The version is `version` in `package.json` (2.0.0). It is shown in Settings > About & updates and Help > About, it is what
  `window.electron.getAppInfo()` reports, it is in the installer's file name and it is the number tills compare with `latest.yml`.
- Use semantic versioning: a patch for fixes, a minor for features that change nothing for existing shops, a major for anything that
  breaks them (the settings file format, the `window.electron` functions the web app calls).
- Updates only go up. The updater is configured with `allowDowngrade: false` and `allowPrerelease: false`, so a till never installs a
  lower version, and never offers a pre-release such as `2.1.0-beta.1`. Hand a beta to a tester as an installer, or serve it from a
  separate test feed.
- Never reuse a version number for different code. A till that has that version will never fetch it again.
- As of 2026-11-19 `tests/packaging/manifest.test.js` pins `version` to `2.0.0`. Change that line in the same commit as the version.
- Never change `name` (`electron-app`), `productName` (`Gadgets POS`) or `build.appId` (`com.example.gadgetspos`). They decide the
  install registration, the data folder, the updater's cache folder and the Windows notification identity, and every upgrade depends
  on them being the same as in 1.x. The same test pins them.
- The function list of `window.electron` only grows (`apiVersion` is 2). The settings file has `schemaVersion` 2 (`SCHEMA_VERSION` in
  `src/main/config.js`); a change to its shape needs a migration, and old keys are not deleted before they are migrated.

## 4. Building

### 4.1 Prerequisites

- A Windows PC to build the Windows installer on, so that it can be signed with a Windows certificate. electron-builder can in
  principle build for other systems from one machine, but this guide does not rely on it and nothing here has tried it. It builds
  for the PC's own architecture (64-bit on a 64-bit PC).
- Node.js 20 or newer and npm, and Git. None of the three runtime packages has a native part, so no compiler is needed.
- Internet access on the first build: electron-builder downloads Electron and its NSIS and signing tools into its cache.
- The certificate (section 5.1).

### 4.2 Building the Windows installer

```
git checkout <the commit you mean to ship>
npm install                 # npm ci once package-lock.json is committed (2.4)
npm test
npm run dist                # the owner release gates (npm run release:check), then electron-builder and the fuses hook
```

`npm run dist` builds for the system it runs on. To say it explicitly: `npm run dist -- --win --x64`.

`npm run dist` refuses to run while a gate is open, which includes the certificate. A throw-away installer for the upgrade checklist
of section 9, before the certificate exists, is built with `npx electron-builder --win --x64`, which skips the gates (the fuses hook
still runs): such an installer is for the test PC only and is never published.

The end-to-end run against the fake POS page is worth doing on the build PC too:
`node_modules\electron\dist\electron.exe tests\e2e\run-app.js` (exit code 0 means every check passed). So far it has been run on macOS
only.

The installer is NSIS and assisted (`nsis.oneClick` is `false`). It asks "Anyone who uses this computer (all users)" or "Only for
me". Tell shops to choose "Only for me", as 1.x installed; section 9 says why (an update of an all-users install makes Windows ask
for administrator approval).

electron-builder does not upload anything with the `generic` provider (its code returns before it schedules an upload), so uploading
is always a manual step (section 6.4).

### 4.3 What a Windows build should produce, and what to check

Expected in `dist\` (from the electron-builder sources, not yet observed):

| File | What it is |
| --- | --- |
| `Gadgets POS Setup 2.0.0.exe` | the installer (`${productName} Setup ${version}.${ext}`, with the spaces) |
| `Gadgets POS Setup 2.0.0.exe.blockmap` | lets a till download only the parts that changed |
| `latest.yml` | the feed file that tells tills the newest version and the installer's SHA-512 |
| `win-unpacked\` | the unpacked app, what the installer installs; use it for the checks below |
| `builder-debug.yml`, `builder-effective-config.yaml` | diagnostics; never published |

After every build, look inside `dist\win-unpacked\resources`:

1. `app-update.yml` has your real feed address in its `url:` line (no `CHANGE-ME`) and, for a signed build, a `publisherName:` entry.
   This is the only place the installed app takes its feed from. electron-builder strips the `build` key from the `package.json` it
   ships, so the app cannot read it from there.
2. `app.asar.unpacked\scripts\raw-print.ps1` and `raw-print-host.ps1` exist. PowerShell cannot run a file inside `app.asar`, which is
   why `build.asarUnpack` is `["scripts/**"]`.
3. In PowerShell: `Get-AuthenticodeSignature "dist\Gadgets POS Setup 2.0.0.exe" | Format-List` shows `Status : Valid` and your company
   as the signer.

Printing to an installed printer on Windows starts Windows PowerShell 5.1 with `-ExecutionPolicy Bypass`, and the script compiles a
small C# helper when it starts (`Add-Type`). Software that blocks PowerShell, or blocks that compile, stops printing to installed
printers (the legacy `LPT`, `COM` and share ports do not use PowerShell). Include a print in the checks on the test PC.

### 4.4 macOS and Linux

Windows is the target. macOS and Linux run the app and print through CUPS (`lp`) but have only been exercised unpackaged.

```
npm run dist -- --mac                  # on a Mac: dmg and zip
npm run dist -- --linux AppImage       # on Linux
```

Name the Linux target: electron-builder's default for Linux is `snap` and `appimage`, and `snap` needs Snapcraft. The macOS feed file
is `latest-mac.yml` and the Linux one `latest-linux.yml`. A macOS update is downloaded from the `zip`, so the zip must be in the feed
as well as the dmg.

## 5. Code signing

### 5.1 Windows

What the owner must provide:

1. A code-signing certificate issued to the company. The name on it is the publisher name that Windows shows. Many authorities now
   deliver the key on a hardware token or as a cloud signing service rather than as a `.pfx` file; check what you will receive,
   because it decides how the build PC signs.
2. The build PC set up to sign with it. For a `.pfx` file, set the environment variables `CSC_LINK` (path or URL of the file) and
   `CSC_KEY_PASSWORD` on the build PC; `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` apply them to Windows builds only. A certificate on a
   token or in the Windows certificate store is chosen with `build.win.certificateSubjectName` or `build.win.certificateSha1`, with the
   token plugged in. Keep the certificate and its password out of the repository folder.
3. `build.win.publisherName` in `package.json`: the common name of the certificate's subject, exactly as it appears in the
   certificate. When the updater downloads an installer it then checks the Authenticode signature against that name and refuses a
   mismatch. It reads the name from `resources\app-update.yml`, which electron-builder writes. (When it signs, electron-builder falls
   back to the certificate's own common name if the option is missing; set it explicitly anyway, because the repository's test
   requires it and because it is then visible in review.)

electron-builder timestamps signatures with `http://timestamp.digicert.com` by default, so the build PC needs internet access and
the signature stays valid after the certificate expires. Windows SmartScreen can still warn about a newly signed installer until the
certificate has built a reputation; that is Microsoft's behaviour, not the app's.

### 5.2 macOS

What the owner must provide: membership of the Apple Developer Program, a "Developer ID Application" certificate in the build Mac's
keychain, and notarisation credentials.

- `build.mac.identity` is `null` in `package.json`. That tells electron-builder to skip signing ("skipped macOS code signing:
  identity explicitly is set to null" in its log), so notarisation is not possible either. Remove that line, or set it to the
  certificate's name, for a signed build.
- Notarisation runs only when credentials are in the environment: either `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
  (the route electron-builder recommends), or `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`, or `APPLE_KEYCHAIN_PROFILE` (and
  optionally `APPLE_KEYCHAIN`). For the Apple-ID route also set `build.mac.notarize` to `{ "teamId": "<your team id>" }`. Without credentials
  electron-builder skips notarisation and says so in its log.
- **Unsigned macOS builds cannot update themselves.** macOS updates go through Electron's native Squirrel.Mac updater, which only
  applies an update to a signed app. With `identity: null` (today) a Mac has to be reinstalled by hand for every version.
- No signed Mac build has been made in this repository. Run one on a clean Mac before publishing it.

## 6. The update feed

### 6.1 How the app updates itself

- The feed address is `build.publish[0].url`. electron-builder writes it into `resources\app-update.yml` when it builds, and the
  installed app reads the `url:` line of that file. Nothing else decides where updates come from.
- Updates are off (Settings > About & updates says "Automatic updates are off") when the app is installed and `app-update.yml` is
  missing or has no URL, when the URL is not `https://`, and while it contains `CHANGE-ME`. Help > Copy diagnostics then has a line
  such as `Updates: disabled - The update server has not been set up yet.`, and the log has `updater: disabled (placeholder-feed)`
  (the other reasons are `no-feed` and `insecure-feed`).
- `electron-updater` is not even loaded until 10 seconds after the POS page has finished loading. The first check is at least 30
  seconds after the app started, then one every 4 hours. Help > Check for updates and the button in Settings check at once.
- A found update is downloaded in the background (`updates.autoDownload`, default `true`; it is in `config.json` but not in Settings).
  When it is downloaded the app shows a native box, "Update ready", with "Restart now" and "Later", once per version. "Later" means
  it is installed the next time GadgetsPOS is closed. Settings > About & updates then shows "Restart and install".
- "Restart now" runs `quitAndInstall(true, true)`: a silent installer, then GadgetsPOS starts again. For a per-user install nothing
  else is asked of the cashier. For an all-users install Windows asks for administrator approval (section 9).
- The updater is configured with `disableWebInstaller`, `allowDowngrade: false` and `allowPrerelease: false`.
- It checks the download against the SHA-512 in `latest.yml`. It checks the publisher's signature only when `publisherName` is set
  (section 2.2).
- A failed check (server down, 404) is caught. Settings shows "Couldn't check for updates" and the POS is not affected.

### 6.2 The feed layout

The `generic` provider is a plain folder of files on an https server:

```
https://updates.example.com/gadgetspos-desktop/        <- build.publish[0].url
    latest.yml                                         <- the one file tills ask for, replaced by every release
    Gadgets POS Setup 2.0.1.exe                        <- the installer, named exactly as electron-builder wrote it
    Gadgets POS Setup 2.0.1.exe.blockmap               <- optional but recommended
    Gadgets POS Setup 2.0.0.exe                        <- older versions: keep them (section 11)
    Gadgets POS Setup 2.0.0.exe.blockmap
```

What `latest.yml` looks like (an example of the shape; yours is generated, never written by hand):

```yaml
version: 2.0.1
files:
  - url: Gadgets POS Setup 2.0.1.exe
    sha512: <base64 hash>
    size: <bytes>
path: Gadgets POS Setup 2.0.1.exe
sha512: <base64 hash>
releaseDate: '2026-11-25T10:00:00.000Z'
```

Rules:

- The address must be `https://`, readable by anyone (the app sends no credentials), and every file must be served unchanged.
- The `url:` lines are relative to the feed address and use the real file name, spaces included; the updater asks for them
  URL-encoded (`Gadgets%20POS%20Setup%202.0.1.exe`). Upload each file under exactly the name electron-builder wrote. A tool that
  renames files (for instance to `Gadgets-POS-Setup-2.0.1.exe`) breaks the feed, because `latest.yml` names the original.
- The blockmap lets a till download only what changed when the server supports HTTP range requests. If it does not, or anything goes
  wrong with the partial download, the updater logs it and downloads the whole installer.
- macOS and Linux need `latest-mac.yml` and `latest-linux.yml` next to it, with the files they name (4.4).

### 6.3 Replacing `CHANGE-ME`

1. Choose the address once, and choose it for good. A till reads the address from its own installed copy, so an address that you
   later abandon cannot be corrected remotely. To move the feed, publish one release at the OLD address whose installer carries the NEW
   address.
2. Edit `package.json`:

   ```json
   "publish": [
     { "provider": "generic", "url": "https://updates.example.com/gadgetspos-desktop/" }
   ]
   ```

3. In the same commit set `build.win.publisherName` (section 5.1). The test `tests/verify/security-packaging.test.js` fails otherwise.
4. Build, and check `dist\win-unpacked\resources\app-update.yml` (section 4.3).

`GADGETSPOS_UPDATE_URL` is not an alternative to that. It is a test hook for a development run (`npm start`): it takes an https
address and is honoured only when the app is not installed. An installed app ignores it, because an environment variable must not be
able to redirect an installer download.

### 6.4 Publishing a release

1. Build, sign and check the installer (section 4).
2. Upload `Gadgets POS Setup <version>.exe` and its `.blockmap` to the feed folder.
3. Upload `latest.yml` last. It is the switch that offers the update, and it must never point at a file that is not there yet.
4. Check from another computer: `latest.yml` shows the new version, and the installer's URL as written in `latest.yml` (spaces as
   `%20`) downloads, with a size equal to `size:`.
5. Keep a copy of the previous `latest.yml` outside the feed folder, and leave the older installers where they are.

### 6.5 Testing an update

Three levels, from cheap to complete. Do the third before the first real release and after any change to the updater, the installer or
the feed host.

1. **Unit tests.** `node --test "tests/updater/*.test.js"` covers the gate (installed or not, missing or placeholder address, http),
   the parsing of `app-update.yml`, the status machine and `install()`.
2. **A development run against a test feed.** The feed must offer a version higher than the one in `package.json`.

   ```
   set GADGETSPOS_UPDATE_URL=https://test.example.com/feed/
   npm start
   ```

   (PowerShell: `$env:GADGETSPOS_UPDATE_URL = 'https://test.example.com/feed/'`.) Wait at least 30 seconds, then open Settings > About
   & updates: it should go from checking to "available", "downloading" and "ready to install". Do not press "Restart and install"
   in a development run: that would run the real installer on this PC.
3. **A full test on a Windows test PC.** Build version N with the TEST feed address and install it. Build N+1 with the same test
   address and upload it to the test feed as in 6.4. On the test PC choose Help > Check for updates (or wait). Expect: the
   "Update ready" box, "Restart now", the installer running silently, GadgetsPOS opening again, and the new number in Settings > About &
   updates. Production builds then carry the production address, so this test installer is never reused. As a shortcut on a test PC
   you can edit the `url:` line of `resources\app-update.yml` in an installed copy instead of rebuilding (the right-click menu of the
   Start menu shortcut has "Open file location").

   The log (`logs\main.log`) tells the story:

   ```
   updater: ready (version 2.0.0, feed from app-update.yml)
   updater: checking for an update
   updater: version 2.0.1 is available
   updater: downloaded 100 %
   updater: version 2.0.1 is downloaded
   updater: restarting to install the update
   ```

   `updater: no update available` means the feed does not offer anything newer. Note whether Windows asks for administrator approval
   when the update installs; that is expected for an all-users install and is worth knowing before rolling out (section 9).

## 7. Allowed domains

The app gives the POS page its printing functions (`window.electron`), trusts its calls and allows it a short list of browser
permissions (notifications, full screen, writing to the clipboard, media, window management) only when the page comes
from an allowed address. Everything else that loads in the window is not trusted, and a link to another site opens in the system
browser.

Allowed addresses (a page is allowed if it matches any of them):

1. The origin of the saved server address (Settings > Connection). Changing the address changes this automatically.
2. Built in: `https://gadgetspos.com`, `https://*.gadgetspos.com` and `https://*.societyfiles.com` (`BUILT_IN_ORIGINS` in
   `src/main/security.js`). The bare domain `societyfiles.com` is not on the list, only its subdomains such as `vendor.societyfiles.com`.
3. The extra domains saved on this PC (Settings > Connection > Allowed domains).
4. In a development run only: `http://localhost:*` and `http://127.0.0.1:*`.

To add a domain:

- **For one PC**: Settings > Connection > "Add a domain". Enter `https://shop.example.com` (an exact origin, port allowed) or
  `*.example.com` (every subdomain, not the bare domain), then Save. At most 50 entries; `http://` is refused. A `*.` entry over a
  public suffix or a shared hosting domain (`*.co.uk`, `*.github.io`, `*.herokuapp.com`, `*.vercel.app` ...) is refused with a message,
  because it would trust every site anybody has there; add the exact address (`https://myapp.herokuapp.com`) or a wildcard over your own
  domain (`*.myshop.co.uk`) instead. An entry like that that is already in `config.json` is ignored and the log says so once. If the shop turned on
  "Ask for the password before Settings opens", the drawer password is needed to save. It is stored as `extraAllowedOrigins` in
  `config.json`.
- **For every PC**: add the entry to `BUILT_IN_ORIGINS` in `src/main/security.js`, update the tests that pin the list
  (`tests/security/origins.test.js`, `tests/verify/security-allowlist.test.js`) and release a new version.

Only add a domain you own. Anything on an allowed domain can print, open the drawer (with the password) and read the printer list.

A page may open at most 3 popups or system-browser tabs per 10 seconds from one window, and 20 per minute from all of them; more are
refused and the log says so once per burst, naming the host only (`window-open blocked (rate-limited): example.org`).

`NAVIGATION_ONLY_ORIGINS` in the same file (`squareup.com`, `squareupsandbox.com` and their subdomains) lists sites the window may
navigate to, so that "Connect with Square" completes inside the app and in the signed-in session. Those sites never get
`window.electron` or any permission, and they are not a way to allow a domain.

## 8. Where files live

`<data>` is Electron's `userData` folder. The product name is unchanged from 1.x, so it is the same folder as version 1's.
Settings > About & updates shows the exact path (Data folder, Settings file, Logs folder), as does Help > Copy diagnostics.

| What | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `<data>` (settings, POS sign-in) | `%APPDATA%\Gadgets POS` | `~/Library/Application Support/Gadgets POS` | `~/.config/Gadgets POS` |
| Settings | `<data>\config.json` | `<data>/config.json` | `<data>/config.json` |
| Copy of the 1.x settings, made on upgrade | `<data>\config.v1-backup.json` | same | same |
| A damaged settings file, set aside | `<data>\config.corrupt-<time>.json` | same | same |
| Compatibility switches (section 5 of PERFORMANCE.md) | `<data>\flags.json` | same | same |
| Log | `<data>\logs\main.log` | `<data>/logs/main.log` | `<data>/logs/main.log` |
| Older logs | `main.old.log`, `main.old2.log` | same | same |
| Downloaded updates | `%LOCALAPPDATA%\electron-app-updater\pending` | `~/Library/Caches/electron-app-updater/pending` | `~/.cache/electron-app-updater/pending` |
| Installed app, this user only | `%LOCALAPPDATA%\Programs\Gadgets POS` | | |
| Installed app, all users | `C:\Program Files\Gadgets POS` | | |
| Print jobs, briefly | `gpos-<pid>-<time>-<n>.bin` or `.zpl` in the system temp folder, deleted when the job ends | same | same |

Notes:

- The log is rotated at 5 MB across three files and is readable only by the account that runs the app. By design it holds job kinds,
  outcomes, timings and error codes, never passwords, receipt contents or customer details.
- `config.json` is written with mode 0600. A copy of the 1.x settings is made once, without the old password.
- The POS sign-in lives in the browser storage inside `<data>`, so deleting `config.json` does not sign the POS out, and deleting
  the whole folder does.
- The installer's uninstaller leaves `<data>` in place (electron-builder deletes it only when asked to, and only for one-click
  installers).
- The "Installed app" rows for Windows are the defaults of electron-builder's NSIS template. The Start menu shortcut's "Open file
  location" shows the real folder.

## 9. The first v2 install and the manual Windows upgrade checklist

**The first v2 install on a till is a manual run of the installer.** 1.x has no updater, so nothing can push 2.0.0 to it. The
installer has the same `appId` and product name as 1.x, and it keeps the data folder (settings, drawer password, POS sign-in). From
2.0.0 onwards the app updates itself (section 6), provided the feed is set up.

How the installer treats an older install (read from the NSIS template inside electron-builder 24.13.3, not observed):

- It looks in the registry for an earlier install of the same app. When there is exactly one, it starts in that install's scope (per
  user or all users); with none, or both, it starts per user.
- Before it copies anything it runs the old uninstaller silently, with the data folder kept (`/S /KEEP_APP_DATA`), for the scope it is
  installing into. When the scope is "all users" it also removes the per-user install of the Windows account that runs the installer.
  So an upgrade should leave one entry in Apps & features, also when the scope differs from 1.x's (1.x installed per user, as
  electron-builder's default one-click installer does). A per-user install that belongs to a different Windows account is not touched.
- The installer understands `/S` (silent) and `/currentuser` or `/allusers` (skip the scope question) on its command line.
- A shop that runs 1.x from a folder made with `electron-packager` (v1's `package.json` has such a script, and `.gitignore` lists its
  output) has nothing the installer knows about, and has to remove that folder by hand.

**Tell shops to choose "Only for me".** A per-user install lives in `%LOCALAPPDATA%\Programs\Gadgets POS` and updates itself silently. An
all-users install lives in `C:\Program Files\Gadgets POS`, and the NSIS script asks Windows for administrator approval whenever it
installs silently over an all-users install, which is what every automatic update is. On a till whose Windows account is not an
administrator that prompt asks for an administrator's password, so the update waits for someone who has it.

**None of this has been run on Windows yet.** Run the checklist.

### The checklist

It cannot run in CI. Use a Windows PC or a virtual machine with snapshots. Run it twice from the same snapshot: once choosing "Only for
me" in the installer and once choosing "Anyone who uses this computer (all users)".

Set up:

1. Install 1.6.1 the way the shops did. Note its entry in Apps & features and its install folder.
2. In 1.6.1 set a receipt printer port (for example `\\localhost\ReceiptPrinter` or `LPT1`), a label printer port, and a drawer
   password. Sign in to the POS and leave the sign-in in place. Close 1.6.1 and copy the data folder aside.
3. Run the v2 installer over it.

Expected, and what to write down if it is not so:

| # | Check | Expected |
| --- | --- | --- |
| 1 | Apps & features | one entry, "Gadgets POS", at version 2.0.0, also after the all-users run |
| 2 | Shortcuts | no duplicate Desktop or Start menu shortcuts |
| 3 | Start GadgetsPOS | the loading screen, then the POS, **still signed in** (same data folder, same session) |
| 4 | Settings > About & updates | "Data folder" is the same folder as 1.6.1's; version 2.0.0 |
| 5 | Settings > Printers | the old receipt and label settings are there |
| 6 | Receipts and Zebra labels | a receipt and a Zebra label print through the OLD ports, with no action |
| 7 | Drawer | the OLD password opens the drawer (Ctrl+D). If it was shorter than 4 or longer than 64 characters, Settings > Cash drawer shows the length notice |
| 8 | DYMO | a DYMO label prints (DYMO Connect running) |
| 9 | Network unplugged | the offline screen appears, "Printer settings" opens Settings on it, and plugging the cable back in returns to the POS by itself |
| 10 | `config.v1-backup.json` | exists next to `config.json` and has no `password` key |
| 11 | Screen question | about 20 seconds after the first start a native box asks "Does the screen look right?"; after you answer it is not asked again |
| 12 | Administrator approval | note whether Windows asked for it during the install (expected for all users) |

Upgrade findings: **not run yet** (2026-11-19). When it has been run, write the date, the Windows version, the installer scope and any
difference from the table here. If a run shows two entries in Apps & features, keep `nsis.oneClick` at `true` (what 1.x used) for the
first v2 release instead of `false`, and record the finding here.

## 10. Printing smoke test and the DYMO QR check

The unit tests use fake printers. Before a release, on the Windows test PC with real devices:

- A receipt through an installed printer (the first print after a start starts PowerShell and is slower than the later ones), and a
  receipt through a legacy port if any shop uses one.
- A Zebra label, and a run of 20 labels in a row from the POS (serial or IMEI labels): all 20 come out, in order, once each.
- DYMO labels of each layout the shops use (sizes `25x25`, `32x57`, `70x54`; designs 1, 2, 3, 4, 7, repair and lab items).
- The cash drawer opens from the POS Open button, Ctrl+D and Settings > Cash drawer > Open drawer (test).
- Switch the receipt printer off and print: a native box says what to do, once, not once per receipt.

**DYMO QR check.** Version 2 builds the QR codes of designs 2 and 7 the way 1.6.1 did (it writes the code into the label XML before
DYMO opens it), and those of design 4, the repair label and the 25x25 QR label with 1.6.1's `_forceQRCodeUpdate` patch. The golden tests
prove that each label object gets the same text as in 1.6.1; they cannot prove what DYMO draws. So print one design-2, one design-7,
one design-4 and one repair label on a real DYMO and scan each QR code with a phone. This is required if anyone ever changes designs 2
and 7 to use the patch (a deviation from the SPEC that needs the owner's sign-off, SPEC 9.4), and sensible before the first release
either way, because no DYMO hardware was available while version 2 was built.

## 11. Rollback

These routes follow from how electron-updater and the installer work. None has been tried on a Windows PC yet.

**A bad release is in the feed but few tills have it.** Put the previous `latest.yml` back (and leave its installer in place). Tills
that have not updated see nothing newer and stay where they are. Tills that already updated stay on the bad version: the updater never
goes down (`allowDowngrade: false`), so putting an older `latest.yml` back does not move them.

**Tills that already have the bad version.** Publish a higher version number: a fix, or the old code released again under a new number
(for example 2.0.2 built from the 2.0.0 commit, with the version raised). Tills pick it up at their next check (within 4 hours, 30
seconds after the next start, or Help > Check for updates) and show the "Update ready" box.

**Stopping a rollout.** There is no remote switch: a till reads its feed address from its own installed file. Replace `latest.yml`
with the previous one, or remove it (tills then show "Couldn't check for updates" in Settings and carry on working).

**One till, by hand.** Uninstall from Apps & features, or run an older installer, then install the version you want. The data folder
stays, so settings and the POS sign-in stay. Test on a spare PC first that an older installer installs over a newer version; if it
refuses, uninstall first. Keep every installer you ever publish for this.

**Back to 1.6.1.** The legacy printer and port settings stay in `config.json` on purpose, so 1.6.1 still prints. The drawer password does
not come back: 1.6.1 cannot read the hash that replaced it, and the old password is deliberately not in `config.v1-backup.json`. Set
a new one in 1.6.1's own screen. 1.6.1 has no updater and no offline screen.

**The new version will not start properly.**

- The screen is blank, black or garbled: Help > Compatibility mode, or start with `--disable-gpu` (PERFORMANCE.md, section 5).
- A damaged `config.json` does not stop the app: it is set aside as `config.corrupt-<time>.json` and the app starts from defaults.
- A damaged download is refused (the SHA-512 does not match) and shows as a failed update check.
- Send `logs\main.log` and the output of Help > Copy diagnostics to whoever supports the release.
