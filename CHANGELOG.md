# Changelog

All notable changes to GadgetsPOS Desktop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
follow [Semantic Versioning](https://semver.org/) (see `docs/RELEASE.md`, section 3).

## 2.0.0 - not released yet

The desktop app rebuilt from version 1.6.1's single `index.js`, to the contract in `docs/SPEC.md`. It is installed by hand over 1.x (1.x
has no updater); the printer settings and the drawer password are carried over. It is not ready for a public release until the owner
release gates in `docs/RELEASE.md` (section 2) are closed: a supported Electron, a signed installer (`build.win.publisherName`), the
Electron fuses (`npm install` for `@electron/fuses`), a committed `package-lock.json` and a real update feed address.
`npm run release:check` lists the open ones and `npm run dist` refuses to build while any is open.

### Fixed

- DYMO labels no longer fail silently when a product name contains a quote, a backslash or a line break: every value reaches DYMO as
  data, never as script text. A label with no design chosen now prints the right layout: 1.6.1 printed nothing when it was on sale,
  and used the 32x57 layout at 70x54.
- Receipts, Zebra labels and the drawer kick no longer share one temp file. Every job has its own file, and the jobs of one printer run
  strictly one after the other, so a batch (serial or IMEI labels) comes out complete, in order, once each.
- DYMO prints on the printer chosen in Settings (Automatic is a connected LabelWriter), not always the first one, and waits until DYMO
  is ready.
- Label text: the processor shows whichever key the web sends; the currency comes from the order (`£` when there is none, other
  currencies as their code, such as `USD `); an empty condition no longer prints `GRADE `.
- A server that is down, no internet, or a page that crashes no longer leaves a blank window.
- The cash drawer password is no longer stored as plain text and can no longer be changed without the old one.
- The POS page (and every window it opens) no longer gets the printer-settings channels, and a printer port is no longer pasted into
  a shell command.
- A Settings window with unsaved changes no longer refuses to close without a word: closing it asks "You have unsaved changes. Discard
  them and close?" ("Keep editing" or "Discard changes"). Quit, Restart and closing the POS window ask the same single question first,
  and "Keep editing" cancels them. Choosing the Settings tab that is already shown no longer reloads the page.
- The drawer password lock can no longer be ended by changing the PC's clock, or by closing and opening the app: it runs on a clock
  nobody can set and is saved with the settings. A password of more than 4096 characters is a wrong password and is never hashed.
- A web page can no longer open windows and browser tabs without limit (3 per 10 seconds from one window, 20 per minute overall).
- An allowed domain such as `*.co.uk` or `*.github.io` (every site anybody has on that domain) is refused by Settings and ignored when
  it is already saved. `societyfiles.com` itself is no longer trusted by default, only its subdomains such as `vendor.societyfiles.com`.
- Right-clicking a blocked `javascript:` link no longer offers "Copy link address".

### Added

- **A reliable print queue.** One queue per printer, a time limit per job, jobs always in the order sent, temp files always deleted. On
  quit the queue is given up to 5 s to finish, so the last receipt is not lost.
- **Feedback to the cashier.** The new functions `printReceipt`, `printBarcode` and `openCashDrawer` answer with `{ ok }` or
  `{ ok: false, code, message }`, in plain English; `getAppInfo` and `getPrinters` report the version and the printers. The old
  fire-and-forget functions still work; for them the app shows a native box itself (one per error code per 5 seconds).
- **A printer picker and test prints.** Settings > Printers lists the installed printers (default, status, refresh, search), saves the
  choice, and prints a test receipt, a Zebra test label or a DYMO test label. DYMO has its own printer choice, with Automatic.
- **Cross-platform raw printing.** Windows installed printers through the spooler (one long-lived PowerShell process); legacy ports
  (`LPT`, `COM`, `\\host\share`) are validated and written directly; macOS and Linux through CUPS (`lp`).
- **Loading and offline screens.** A loading screen at once; an offline screen that says why, retries by itself (3, 6, 12, 24, then
  every 30 s), and offers Retry now, Printer settings and Change server address; a bar when the connection drops mid-session; a screen
  when the page stops responding.
- **Cash drawer security.** The password is hashed (scrypt), 4 to 64 characters, and the current one is needed to change it. Five wrong
  tries pause every password check (30 s, doubling to 5 min). Optional password before Settings opens. Pin and pulse settings. A
  forgotten password is recovered by deleting `config.json`; there is no bypass.
- **A locked-down bridge.** `window.electron` exists only on an allowed address (the server address, `gadgetspos.com`,
  `societyfiles.com`, and domains added in Settings > Connection). Every message from a page is checked for who sent it. Navigation to
  other sites goes to the system browser or is refused, and no certificate error is ever bypassed.
- **Release gates.** `npm run release:check` lists what the owner still has to do before a release (supported Electron, publisher name,
  fuses, lock file, update feed address) and `npm run dist` runs it first. `scripts/after-pack-fuses.js` flips the Electron fuses in
  every build (RunAsNode, the Node inspect arguments and NODE_OPTIONS off, archive-only loading on) and stops the build when
  `@electron/fuses` is not installed.
- **Auto-update** (electron-updater, generic feed). A check at least 30 s after start and every 4 hours, a download in the background,
  an "Update ready" box, a silent install. It stays off until a real https feed address is built in.
- **Settings and native behaviour.** A Settings window (Printers, Cash drawer, Connection, General, About & updates), an application
  menu with Reload, zoom and full screen (F11), a right-click menu, start with the computer, start in full screen, keep awake, one
  instance only, a window title that follows the page, Help > Open logs folder and Copy diagnostics, and logs that rotate at 5 MB.
- **Performance.** Hardware acceleration on by default, with a compatibility mode (Settings, Help menu, `--disable-gpu`, an automatic
  fallback and a one-time question after the upgrade); the loading screen first and heavy parts loaded later; an early connection to
  the server; a larger cache; no spellcheck; no throttling of the POS in the background; startup timings in Settings > About. See
  `docs/PERFORMANCE.md` for what was measured, including the two start-up budgets that were missed.

### Changed

- The window opens at most 1600 x 900 (maximised on a display narrower than 1400 px), remembers its place and is brought back on screen
  if its display is gone.
- Settings are kept as schema 2 in `config.json`. The 1.x settings are migrated once; a copy is kept as `config.v1-backup.json` (without
  the password) and the old printer keys stay, so a downgrade to 1.6.1 still prints.
- The free-text "printer name and port" became a printer chosen from a list, or a validated port. A port that is not a share
  (`\\host\share`) or a device (`LPT1`, `COM3`, `PRN`) is refused with a clear message instead of silently writing a file.
- The DYMO label files moved to `labels/`. The GadgetsPOS logo and icon replace the old ones.
- The first install over 1.x is manual; the app updates itself from then on.

### Removed

- The dead A4 receipt generator (about 480 lines), duplicate functions and the unused 1.x pages.
- 14 of the 16 runtime packages of 1.6.1, about 500 MB on disk: puppeteer, react, react-dom, serialport, usb, escpos, escpos-usb,
  winston, pdfkit, bwip-js, iconv-lite, dotenv, `@types/dymo-label-framework` and the `child_process` package, with the webpack and
  Babel tooling. The runtime packages are now `electron-store` and `electron-log` (kept) and `electron-updater` (new).
- Developer tools in an installed app (they remain in a development run, or with `--devtools`).

### Compatibility

- The old web app keeps working with 2.0.0 (`sendReceiptData`, `sendBarcodeData`, `sendOpenDrawerCommand` are all there). The updated
  web app uses the new functions when they exist and falls back to the old ones on a 1.x desktop.
- `build.appId`, `productName` and the data folder are unchanged from 1.x, so an upgrade is meant to happen in place and keep the POS
  sign-in. That has not been tried on Windows yet (`docs/RELEASE.md`, section 9).
