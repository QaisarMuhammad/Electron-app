# GadgetsPOS Desktop 2.0 — build specification

Status: FROZEN contract for the implementation wave. Interfaces in sections 6-8 may be *extended* but never *changed* without
the integration owner's sign-off; the review pass logged in section 20 made the last signature corrections before the freeze (`createConfig`,
`createUpdater`, `isTrustedSender`, `buildLabelPlan`, the `savePrinter`/`testPrint` roles). Everything is CommonJS, Node 20 (Electron 32.3.3), no new runtime dependencies beyond
`electron-store` (ESM, `await import()`), `electron-log`, `electron-updater` (all already installed in this worktree).

## 1. What we are building and why

The desktop app is a thin shell around the web POS (`DGshop_vendor`) that adds hardware printing: ESC/POS receipts, Zebra (ZPL)
labels, DYMO labels, and a cash drawer. A review of v1.6.1 found these defects, ALL of which this release fixes:

1. DYMO labels fail silently when a product name contains `"`, a backslash or a line break (the title is pasted into a script string).
2. Zebra labels share one temp file `label.zpl` and an async `cmd /c copy`: batches (serial/IMEI labels) can print wrong or repeated labels.
3. Everything is fire-and-forget: the cashier never learns that a print failed.
4. DYMO always prints to `printers[0]`, ignores the configured label printer; the hidden DYMO window is used before it has loaded.
5. Label text: Quick Add sends `processor`, the app reads `Processor`; `£` is hard-coded (the web sends `currency`); empty condition prints `GRADE `.
6. Offline / server down => BLANK WINDOW (an unused `offline.html` exists). No loading screen, no error screen, no reconnect.
7. Printer config is free-text "name" + "port" (Windows `copy /B file port`); no printer picker; Windows only; no test print.
8. Cash drawer password stored in plain text, changeable without the old password; the web's `cashDrawerForm.jsx` calls
   `window.electron.sendOpenDrawerCommand`, which does not exist in the app, but that dialog is never opened (its open state is never set to true,
   `pos-card-items-bottom.jsx` lines 236 and 1687-1690): the live manual route is the Open button, `sendReceiptData({ openCashDrawer:true, order:false })`,
   which opens the app's password window.
9. The remote POS page (and any page opened by `window.open`) gets the full IPC bridge incl. printer-config channels; no origin checks;
   printer port is pasted into a shell command.
10. DevTools for everyone, no auto-update, no single-instance lock, dead A4 generator (~480 lines), duplicate functions, 514 MB of unused
    dependencies (puppeteer, react, serialport, usb, escpos, winston, ...).

Non-goals: no changes to POS business logic; no QZ Tray integration (documented as an alternative only); no new printer languages.

## 2. Rules for every implementer

- Work ONLY inside the worktree you are given (absolute paths). Never touch `/Users/muhammadqaisar/Documents/projects/donesol/Electron-app`
  or `DGshop_vendor` (the owner's live checkouts). NEVER commit, push, stash, run `npm install`/`npm ci`/`electron-builder`, or start dev servers.
- Root-level legacy files (`index.js`, `preload.js`, `dymo-preload.js`, `*.html`, `renderer.js`, `receipt.txt`, `undefined`, ...) are READ-ONLY REFERENCE
  during the build wave. New code goes under `src/`, tests under `tests/`. The integration step deletes the legacy files.
- Exact legacy behaviour is the source of truth for things we do not intentionally change: read `index.js` (v1.6.1) and `git show 14df69a:index.js`.
- No `exec`, no `execSync`, no `shell: true`, no `eval`/`new Function` outside tests, no string-built JavaScript with raw values: use
  `execFile` with an argv array and `JSON.stringify` for every value that goes into a script.
- Every module is dependency-injected (factory functions) so it can be unit-tested under plain `node --test` with fakes. Only `src/main/index.js`
  and the window factories touch the real `electron` module.
- Tests: `node --test "tests/**/*.test.js"` must pass with NO Electron runtime (Node 22: quote the glob; passing a bare directory does NOT work). Unit test files MUST be named `*.test.js`; helpers, fixtures and e2e scripts must NOT end in `.test.js`. Run only the test files you touch while working, e.g. `node --test "tests/dymo/*.test.js"`.
- Preload scripts run sandboxed: ONE self-contained file each, `require('electron')` only (no local requires; a sandboxed preload can load only `electron`, `events`,
  `timers` and `url`, and `__dirname` is undefined, so a preload holds no origin list and no path logic). Which preload runs in which window is defined in 6.3.
- English UI copy; plain, short sentences; no jargon in user-visible text.
- Leave `package.json` alone unless you own it (integration owns it). If you need a dependency or a `build.files` entry, say so in your report.

## 3. Layout and file ownership

```
package.json                      (INTEGRATE) main -> src/main/index.js, v2.0.0, trimmed deps, build.files/asarUnpack/publish
src/main/index.js                 (INTEGRATE) bootstrap(overrides), the only place with side effects
src/main/ipc.js                   (INTEGRATE) registers every ipcMain handler (legacy + new) and applies isTrustedSender
src/main/errors.js                (T1)  PrintError, ERROR_CODES, ok(), toResult(), userMessage()
src/main/printing/queue.js        (T1)
src/main/printing/transports/     (T1)  index.js, win32-spooler.js, win32-port.js (also exports the pure classifyPort, 9.1), posix-cups.js
scripts/raw-print.ps1             (T1)  Windows RAW spooler helper, one-shot (PowerShell + winspool P/Invoke)
scripts/raw-print-host.ps1        (T1)  same, PERSISTENT host: JSON command per stdin line, JSON answer per stdout line (18b L1)
scripts/after-pack-fuses.js       (2nd pass)  electron-builder afterPack hook: flips the Electron fuses (15); a build tool, kept out of the installer
src/main/printing/dymo/           (T2)  index.js (service), plan.js, script.js, printers.js, window.js
src/main/printing/currency.js     (T2)  currencySymbol(iso)
src/main/printing/labelText.js    (T2)  text helpers shared with the plan builder
src/main/printing/zebra.js        (T1)  ZPL job -> rawPrinter
src/main/printing/receipt.js      (T1)  ESC/POS job -> rawPrinter, test receipt bytes
src/main/printing/jobs.js         (INTEGRATE) createPrintService: ties receipt/zebra/dymo/drawer together
src/main/config.js                (T3)  electron-store wrapper, schema v2, legacy migration
src/main/flags.js                 (T3)  flags.json (userData) read SYNCHRONOUSLY before app ready: disableGpu, disableBrotli (18b R1)
src/main/perf.js                  (INTEGRATE) startup marks and summary (18b S3)
src/main/password.js              (T3)  scrypt hash/verify, throttle
src/main/printing/drawer.js       (T3)  drawer pulse bytes + openDrawer() orchestration
src/main/security.js              (T4)  origin allowlist, NAVIGATION_ONLY_ORIGINS, isTrustedSender, navigation and window-open guards
src/main/sharedSuffixes.js        (2nd pass)  the public suffixes and shared hosting domains that no allow-list wildcard may cover (12); a list, no code of its own
src/main/connectivity.js          (T4)  online probe + backoff controller
src/main/updater.js               (T4)  electron-updater wiring (no-op when unpackaged / feed not configured)
src/main/windows/                 (T4)  main.js, settings.js, password.js (BrowserWindow factories), menu.js (12b), contextMenu.js (18b D1)
src/preload/app.js                (T4)  preload of the MAIN window and every window it opens: window.electron on allowed origins + offline banner; the small window.desktop connection subset on its local pages (6.3)
src/preload/local.js              (T4)  preload of the settings and password windows: the full window.desktop API (6.3)
src/preload/dymo.js               (T2)  preload for the hidden DYMO window
src/renderer/                     (T5)  loading.html, offline.html, settings.html, password.html, dymo-loader.html, shared/tokens.css, shared/*.js|css
labels/*.dymo                     (done) DYMO templates (already moved here)
assets/                           existing icons, logo.jpg, no-internet.svg, dymo.connect.framework.js
tests/                            each owner adds tests/<area>/*.test.js ; tests/helpers/ shared fakes (first writer wins, extend don't rewrite)
tests/perf/                       (PERF lens) benchmark.js + out/ : v1 versus v2 measurements (18b)
tests/release/                    (2nd pass)  the owner release gates, `npm run release:check` (15); files named *.check.js, so `npm test` does not run them
tests/fixtures/legacy-index.js    (T2)  copy of v1.6.1 index.js used ONLY by the golden harness
docs/                             SPEC.md (this), RELEASE.md, SHOP-SETUP.md (DOCS step)
```

## 4. Compatibility rules (non-negotiable)

- Old web app + NEW desktop app: every legacy entry point keeps working with the legacy payloads:
  `window.electron.sendReceiptData(p)`, `window.electron.sendBarcodeData(p)`, `window.electron.sendOpenDrawerCommand(p)` (the last one is new but is what
  the existing web code already calls), IPC channels `send-receipt-data`, `send-barcode-data`. Failures on these fire-and-forget paths are shown to the cashier by the
  app itself (one native error box per 5 s per error code, coalesced), because the old web cannot show them.
- NEW web app + OLD desktop app (v1.x, no ack API): the web feature-detects `typeof window.electron.printBarcode === 'function'`; if absent it uses the legacy
  functions, and for DYMO label payloads it strips characters that break v1's script (`"`, `\`, line breaks) so labels print. v1.x has no `sendOpenDrawerCommand`
  either: the web's drawer call falls back to `sendReceiptData({ openCashDrawer: true })` (section 18).
- Stored v1 configuration survives the upgrade (section 5.2). A shop that has a working `printerPort` must keep printing through that port after updating, with no action: every form that can print (a UNC printer share, `LPT`/`COM`/`PRN`) is accepted by `classifyPort` (9.1); any other string only ever made v1's `copy` write a file, and now gets a clear INVALID_SETTINGS message instead of a silent no-op.
- Existing store keys are never deleted before they are migrated successfully.

## 5. Configuration (electron-store, file `config.json`)

### 5.1 Schema v2 (`schemaVersion: 2`)

```js
{
  schemaVersion: 2,                                         // written ONLY by migrateLegacy(), never part of the store `defaults` (5.2)
  serverUrl: 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy',   // legacy default; editable in Settings > Connection
  extraAllowedOrigins: [],                                  // strings like 'https://shop.example.com' or '*.example.com'
  printers: {
    receipt: { transport: 'system' | 'port', printerName: '', port: '' },
    label:   { transport: 'system' | 'port', printerName: '', port: '' },   // RAW labels only (Zebra ZPL and other raw label printers)
    dymo:    { printerName: '' },                                            // '' = automatic; exact, then contains, case-insensitive (9.4). Separate from `label` because
                                                                             // label_printer_type (zebra | dymo) is a per-USER setting of the web app while this file is per PC
  },
  drawer: {
    enabled: true,
    pin: 2,                       // 2 or 5 (ESC p m ...: m = 0 for pin 2, 1 for pin 5)
    onTimeMs: 50, offTimeMs: 510, // both converted to units of 2 ms: units = min(255, max(1, round(ms / 2))); 50 -> 0x19 and 510 -> 0xFF are v1's bytes 1B 70 00 19 FF
    passwordRecord: null,         // {algo:'scrypt', N, r, p, keylen, salt:b64, hash:b64} -- see password.js
    passwordWeak: false,          // true only for a migrated v1 password that breaks the 4..64 policy of 10
    requirePasswordForSettings: false,
    lock: { failures, remainingMs, writtenAt }   // absent unless wrong passwords are being counted: the password throttle's saved state (10), never sent to a window
  },
  window: { bounds: null, maximized: false, zoomLevel: 0, fullScreen: false, startFullScreen: false },
  updates: { autoDownload: true },
  startup: { openAtLogin: false },          // 18b D3
  power: { keepAwake: true }                // 18b R2 (powerSaveBlocker prevent-app-suspension)
}
```

### 5.2 Legacy migration (runs at startup, idempotent, wrapped in try/catch; logs a summary, never the password)

- Trigger. `createConfig` must NOT pass `schemaVersion`, or any other default, to the `Store` constructor: electron-store (conf 13) merges `defaults` into the stored object and
  WRITES the merge to disk inside the constructor (verified against electron-store 10.0.1), so a v1 file would report schema 2 before `migrateLegacy()` runs, the migration would be
  skipped for good, and the printer ports and the password would be lost. `schemaVersion` is written ONLY by `migrateLegacy()`, as its last step. `migrateLegacy()` runs when the
  persisted store has no `schemaVersion` or one below 2; it reads the raw store (`store.get('schemaVersion')`, never `config.get('schemaVersion', 2)` with defaults). v1 used
  `new ElectronStore()`: the file is `config.json` in userData (no name, no encryptionKey) and the legacy keys sit at its root; each stays in place until it has been migrated.
- Backup. Before the first migration write `config.v1-backup.json` (mode 0600) next to `config.json`, holding the old file WITHOUT its `password` key.
- `printerName`/`printerPort` -> `printers.receipt`: `transport: 'port'` if `printerPort` is non-empty else `'system'`; copy both fields.
- `labelPrinterName`/`labelPrinterPort` -> `printers.label` ONLY, likewise (v1 never used the stored label printer for DYMO, so `printers.dymo.printerName` starts empty).
- `password` (plain text) -> `drawer.passwordRecord = hashPassword(password)`. v1 required only a non-empty password and compared it with `===`, so `hashPassword` hashes ANY non-empty
  string exactly as stored (no trim, no length policy). If it breaks the 4..64 policy of 10, the record is stored with `drawer.passwordWeak: true` and Settings > Cash drawer shows
  "Your password does not meet the new length rule (4 to 64 characters). Change it when convenient." without blocking the drawer. Only after the record is saved, delete the plain key.
- Cleanup. Delete only the plain `password` (after its record is saved) and the obsolete keys `a4PrinterName`, `a4PrinterPort`, `a4Password` (never used by anything) and `printerBrand`
  (written by older builds). The legacy `printerName`, `printerPort`, `labelPrinterName` and `labelPrinterPort` stay in place, so a downgrade to v1.6.1 still prints.
- Set `schemaVersion: 2` last. A failing step (for example the password hash) leaves `schemaVersion` unwritten and the legacy key in place, so the next start retries.
- Tests are listed in section 16 (config).

## 6. Preload APIs

### 6.1 Remote POS page: `window.electron` (src/preload/app.js)

The preload contains NO origin list: it is a sandboxed single file (section 2) and the rule depends on runtime config (`serverUrl`, `extraAllowedOrigins`, `isPackaged`). On every page that is
not a `file:` page (those are covered by 6.3) it asks main synchronously, at document start: `const allowed = ipcRenderer.sendSync('app:origin-allowed')`. Main answers from the REAL sender
frame, never from data the page supplied: `try { event.returnValue = security.isAllowedOrigin(event.senderFrame.origin) } catch { event.returnValue = false }`. The handler ALWAYS sets
`returnValue` (an unset one blocks the renderer forever) and is registered before the first window is created. The preload calls `contextBridge.exposeInMainWorld('electron', api)` only when the
answer is `true`; on other origins it exposes nothing. Rules: compare ORIGIN strings only (`frame.origin` in main), never `location.origin` (the string `'null'` in an `about:blank` popup, which 12
allows) and never the URL protocol (`blob:https://host/uuid` has protocol `blob:`); `isAllowedOrigin(x)` accepts an origin or a URL, normalises with `new URL(x).origin` and returns false for
`'null'` (data:, sandboxed frames); there is no `window === window.top` test (the preload does not run in sub-frames). Origin list/rules are in section 12.
Test (the preload run against a fake `ipcRenderer` backed by the real handler): with `extraAllowedOrigins: ['https://shop.example.com']` a document on that origin gets `window.electron`; on
`https://evil.example.com` it does not; after `serverUrl` is changed in Settings a document loaded later sees the new answer; an `about:blank` popup of an allowed origin gets it.

```js
window.electron = {
  // ---- legacy, fire-and-forget (kept for the old web) ----
  sendReceiptData(payload),        // ipcRenderer.send('send-receipt-data', payload)
  sendBarcodeData(payload),        // ipcRenderer.send('send-barcode-data', payload)
  sendOpenDrawerCommand(payload),  // ipcRenderer.send('open-drawer-legacy', payload)   payload: { cashDrawerOpenPassword }
  // ---- new, acknowledged: each returns Promise<Result> ----
  printReceipt(payload),           // invoke('print-receipt', payload)
  printBarcode(payload),           // invoke('print-barcode', payload)
  openCashDrawer(payload),         // invoke('open-drawer', payload)   payload: { password }
  getAppInfo(),                    // invoke('app-info') -> { name, version, platform, apiVersion: 2, features: ['ack-print','drawer','printer-list'] }
  getPrinters(),                   // invoke('list-printers') -> { system:[{name,displayName,isDefault,status}], dymo:[{name,modelName,isConnected}] }
}
```
`apiVersion` starts at 2. Never remove a function; add new ones.

The preload also owns the OFFLINE BANNER (section 11.3): a Shadow-DOM overlay driven by `online`/`offline` events and a main-process message `connectivity:status`.

### 6.2 Local pages: `window.desktop` (src/preload/local.js)

Exposed only on `file:` pages (the preload checks `location.protocol === 'file:'`; the real boundary is main's per-window area check, 6.3). `src/preload/app.js` carries a copy of the small `connection` + `window` part for the main window (6.3).

```js
window.desktop = {
  platform, version,
  settings: {
    getState(),                      // -> { config(sanitized: no passwordRecord, with drawer.passwordSet:boolean), platform, version, online, update: {...}, performance: { hardwareAcceleration, compatibilityReason, startup: {marks, summary} } }
    listPrinters(),                  // -> { system:[...], dymo:[...], dymoError?: string }
    savePrinter(role, settings),     // role 'receipt'|'label'|'dymo'; settings = printers.<role> shape -> Result (a `port` is checked with classifyPort, 9.1)
    testPrint(role, options),        // -> Result  (receipt: ESC/POS test slip; label: ZPL test label on printers.label, options.kind 'zebra'; dymo: DYMO test label on printers.dymo)
    setDrawerPassword({current, next}),   // -> Result (current required when one is set)
    saveDrawerSettings({enabled, pin, onTimeMs, offTimeMs, requirePasswordForSettings, password}), // password required when one is set
    openDrawerTest({password}),      // -> Result
    saveConnection({serverUrl, extraAllowedOrigins, password}), // password if requirePasswordForSettings
    setGeneral({openAtLogin, startFullScreen, keepAwake}),     // -> Result (18b D2/D3/R2)
    setPerformance({hardwareAcceleration}),                    // -> { ok:true, restartRequired:true } (writes flags.json, 18b R1)
    restartApp(),                                              // relaunch + quit
    checkForUpdates(),               // -> { status: 'disabled'|'checking'|'none'|'available'|'downloading'|'ready'|'error', version?, message? }
    installUpdate(),
    openLogsFolder(), copyDiagnostics(),   // copyDiagnostics -> string (also copied to clipboard by main)
    resetAll({password}),            // factory reset incl. password; requires the password when set
    onState(cb)                      // main pushes state/update changes; returns an unsubscribe function
  },
  connection: { getStatus(), retryNow(), openSettings(), onStatus(cb) },   // offline page; status: {online, attempt, nextRetryInMs, lastError:{code,description}, url, reason:'offline'|'dns'|'refused'|'timeout'|'tls'|'server'|'other'}
  password: { submit(password), cancel(), getLockout(), onLockout(cb) },   // password prompt window
  window: { close() }
}
```
All of these are `ipcRenderer.invoke` calls on channels `desktop:<area>:<name>`; main verifies the sender per 6.3 and 12 (registry of allowed areas per window, page inside the app's `src/renderer` directory).

### 6.3 Which preload runs where

A BrowserWindow has exactly ONE `webPreferences.preload`, and the main window shows `loading.html`, the remote POS and `offline.html` in the SAME window (section 11), so preloads are assigned per window:
- The main window, and every window it opens with `window.open` (12), use ONLY `src/preload/app.js`. On an allowed origin it exposes `window.electron` (6.1). On `file:` pages under `src/renderer`
  (`loading.html` and `offline.html`) it exposes ONLY `window.desktop = { platform, version, connection: { getStatus, retryNow, openSettings, onStatus }, window: { close } }` (channels
  `desktop:connection:*` and `desktop:window:close`): the offline page needs "Retry now", the countdown and "Printer settings" (11.4) to work. It never exposes the `settings` or `password` APIs
  there, and on any other origin it exposes nothing. The `connection`/`window` subset is duplicated inside `app.js` (about 20 lines) because preloads are self-contained single files (section 2);
  a test asserts that the two copies (app.js and local.js) are identical.
- The settings window and the password window (own BrowserWindows, created on demand, destroyed on close) use `src/preload/local.js`, the full `window.desktop` of 6.2.
- Main keeps a registry `webContentsId -> allowed areas`: main window `connection, window`; settings window `settings, connection, window` (its Connection tab shows the status chip and "Reload POS");
  password window `password, window`; windows opened with `window.open` get none. `isTrustedSender(event, registry, area)` (12) rejects a `desktop:<area>:*` call whose area is not in the sender
  window's set, or whose frame is not a `file:` page inside `<rendererDir>` + path.sep. So even though `local.js` exposes the whole API in both of its windows, main enforces the area.
- Local pages are privileged, so they are locked down: each carries a Content-Security-Policy meta tag `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`, has no
  inline script and no style attributes, and writes every query-string value (`reason`, `code`, `desc`, `url`: they come from the network) with `textContent` only.
- Tests (an ipc test with fake windows, and `tests/e2e/ui-shots.js`): the offline page loaded in the main window can call `retryNow` and `openSettings`; a remote-origin page in the same window cannot
  see `window.desktop`; `desktop:settings:*` from the main window and `desktop:password:*` from the settings window are rejected; a hostile `desc` in the offline query string renders as text.

## 7. Result and errors (src/main/errors.js)

```js
Result = { ok: true } | { ok: false, code: string, message: string, details?: object }
ERROR_CODES = {
  INVALID_PAYLOAD, UNTRUSTED_SENDER, NO_PRINTER_CONFIGURED, PRINTER_NOT_FOUND, UNSUPPORTED_PLATFORM,
  SPOOLER_ERROR, PORT_WRITE_FAILED, PRINT_TIMEOUT,
  DYMO_UNAVAILABLE, DYMO_NO_PRINTER, DYMO_TEMPLATE_MISSING, DYMO_PRINT_FAILED,
  DRAWER_DISABLED, DRAWER_PASSWORD_NOT_SET, DRAWER_WRONG_PASSWORD, DRAWER_LOCKED_OUT, DRAWER_FAILED,
  PASSWORD_REQUIRED, PASSWORD_WRONG, PASSWORD_TOO_SHORT, PASSWORD_LOCKED_OUT,
  INVALID_SETTINGS, UPDATE_UNAVAILABLE, UNKNOWN
}
class PrintError extends Error { code, details }
ok() ; toResult(errOrPrintError) ; userMessage(code, details)   // always plain English a cashier understands
```
Messages are action oriented, e.g. DYMO_NO_PRINTER: "No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on." Lockout results carry `details.retryAfterSec`.

## 8. Module interfaces (factories; all arguments injected)

```js
// printing/queue.js
createJobQueue({ defaultTimeoutMs = 30000, log }) => {
  drain(timeoutMs) => Promise<boolean>                        // resolves true when every queue is idle, false after timeoutMs (18b L3)
  enqueue(key, jobFn, { label, timeoutMs }) => Promise<any>   // strictly serial per key; rejects PrintError(PRINT_TIMEOUT); one stuck key never blocks another key
  size(key) => number
}
// printing/transports/index.js
createRawPrinter({ platform, fs, execFile, tmpDir, resourcesPath, queue, log, now }) => {
  printRaw({ target:{ transport:'system'|'port', printerName, port }, data: Buffer|Uint8Array|string, label }) => Promise<{ok:true}>   // rejects PrintError
}
// printing/transports/win32-port.js (pure part)   classifyPort(raw) => { kind:'unc'|'device'|'invalid', path, reason? }   // 9.1: a bad port never reaches the file system or cmd.exe
// printing/dymo/index.js
createDymoService({ createHiddenWindow, labelsDir, readFile, getConfig, log, currencySymbol }) => {
  print(payload) => Promise<Result>          // payload = the legacy send-barcode-data envelope; chooses plan, printer, runs script
  listPrinters() => Promise<{ printers: [...], error?: string }>
  dispose()
}
// printing/dymo/plan.js (pure)       buildLabelPlan(payload, { currencySymbol }) => { plans: [{ templateFile, ops:[{kind:'text'|'qr'|'qr-embed', name, value}] }] }
//                                    always an array of 1..n plans (a repair message gives one per order item); there is NO `repeats` field and `payload.prints` is never read (9.4)
// printing/dymo/script.js (pure)     buildPrintScript({ labelXml, ops, printerName }) => string     // JSON literals only
// printing/dymo/printers.js (pure)   pickDymoPrinter(printers, configuredName) => { printer, reason } | { printer: null, reason }
// config.js
createConfig({ Store, log, defaults }) => { get(path, fallback), set(path, value), all(), publicState(), migrateLegacy(), onDidChange(cb), reset() }   // rules below
// password.js
hashPassword(plain) => record            // any non-empty string, exactly as given: no trim, no length policy (5.2)
validatePasswordPolicy(plain) => Result  // the 4..64 policy of 10; called ONLY by the set/change flows
verifyPassword(plain, record) => boolean (timing safe; false at once for a candidate over MAX_CANDIDATE_LENGTH, 10) ; createThrottle({maxFailures:5, baseLockMs:30000, maxLockMs:300000, now, monotonic, load, save}) => { check(), fail(), success(), state() }   // `monotonic` defaults to `now`; `load`/`save` persist the lock (10)
// printing/drawer.js
buildDrawerPulse({ pin, onTimeMs, offTimeMs }) => Buffer ; createDrawer({ config, rawPrinter, password, throttle, log }) => { open({ password, source }) => Promise<Result> }
// security.js
createSecurity({ getConfig, isPackaged, devOrigins, rendererDir, now, log }) => { isAllowedOrigin(url), isTrustedSender(event, registry, area), attachGuards(webContents, { openExternal, onBlocked }), configureSession(session) }   // `now`: the clock of the open rate limit (12); `log.warn`: told once about an ignored wildcard
// security.js also exports the constant NAVIGATION_ONLY_ORIGINS (12)
// connectivity.js
createConnectivity({ net, probe, timers, onStatus, log }) => { start(url, { mode }), stop(), retryNow(), status() }     // mode 'page' (default: the full-screen offline page, 11.2) | 'banner' (mid-session, 11.3)
                                                                                                                    // exponential backoff 3s,6s,12s,24s,30s(cap) + jitter; probes with HEAD; reacts to online/offline
// updater.js
createUpdater({ autoUpdater, app, getConfig, dialog, log, isPackaged, readFeedUrl }) => { init(), checkNow(), install(), status() }
// `autoUpdater` may be the object OR a zero-argument function returning require('electron-updater').autoUpdater; it is only called inside init() (10 s after the POS finished loading),
// which is what makes the lazy-require test (16) meaningful. `readFeedUrl` is injected (13).
// windows/menu.js (pure)
buildMenuTemplate({ platform, isDev, handlers }) => Electron menu template   // 12b
```

`config.js` rules (verified against electron-store 10.0.1 / conf 13.1.0):
- Build the store as `new Store({ configFileMode: 0o600 })` WITHOUT the `defaults` option (conf's default file mode is 0o666). Defaults live inside `createConfig`, not in the store (5.2).
- `get(path, fallback)`: the stored value, else the same dot path in `defaults` (deep: conf does not deep-merge nested defaults), else `fallback`. `set(path, undefined)` is mapped to delete (conf throws
  on `undefined`). `onDidChange(cb)` is `store.onDidAnyChange(cb)` (conf's `onDidChange` needs a key).
- Keep an in-memory snapshot, refreshed after every set/delete/reset; IPC, navigation and permission checks read the snapshot, never the disk (every conf `get` re-reads and parses the file).
- Wrap construction: on a SyntaxError (corrupt or 0-byte `config.json`) rename the file to `config.corrupt-<timestamp>.json`, log it, and start from defaults, so the app still starts.
- `migrateLegacy()` is the only code that writes `schemaVersion` (5.2).

## 9. Printing behaviour

### 9.1 Raw transports (replaces `cmd /c copy`)
- `system` transport, Windows: `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', <resources>/scripts/raw-print.ps1, '-PrinterName', name, '-FilePath', file])` — the script opens the printer, starts a RAW document, writes the bytes, closes; exit codes: 0 ok, 2 printer not found, 3 open failed, 4 write failed, 5 bad arguments. No shell. The script file must live outside the asar (`asarUnpack`).
- `system` transport, macOS/Linux: `execFile('lp', ['-d', name, '-o', 'raw', file])`; parse errors from stderr; PRINTER_NOT_FOUND when `lp` says the destination is unknown.
- `port` transport (legacy), Windows only. The port is free text from a settings file, so it is validated BEFORE anything is opened or spawned. `classifyPort(raw)` (pure, exported by `win32-port.js`;
  `savePrinter` calls it too, so Settings refuses a bad port with INVALID_SETTINGS) trims the string and accepts ONLY: (a) a UNC printer share `\\<host>\<share>` (host: letters, digits, `.`, `-`, `_`;
  share: letters, digits, space, `.`, `_`, `-`, `(`, `)`; nothing deeper), e.g. `\\localhost\ZebraZD420`; (b) a DOS device name `LPT1`-`LPT9`, `COM1`-`COM256` or `PRN` (any case; one trailing `:` is dropped;
  `\\.\LPT1` is accepted too), which is ALWAYS opened as `\\.\<NAME>`, the explicit device namespace. Everything else is `invalid` -> INVALID_SETTINGS ("This port name cannot be used. Choose the installed
  printer, or a shared printer address such as \\localhost\ZebraZD420."): a bare name that is not a DOS device (`USB001` is a spooler port name, not a device), file paths of any kind (`C:\x`, `..\x`,
  `\\?\C:\x`), and any string with a control character or one of `" ' & | < > ^ % ! , ; =`.
  Why a bare name is never opened: `fs.promises.open(name, 'w')` is CREATE_ALWAYS on Windows, so a name that is not a device silently creates a regular file in the working directory and reports success
  (nothing prints, and the fallback below never runs). A device is opened existing-only (flag `O_WRONLY` without `O_CREAT`/`O_TRUNC`), so a missing device fails with ENOENT instead of creating a file; a UNC
  share is opened with `'w'`, as `copy` does.
  Write: DIRECT write to the validated path (open -> write -> close). If it throws one of ENOENT/EINVAL/EPERM/EACCES, FALL BACK ONCE to the legacy `copy`, so shops whose setup only worked with `copy` keep
  working: `execFile('cmd.exe', ['/d','/c','copy','/B', <fileName>, <port>], { cwd: <tmpDir> })`. There is no `shell` option, but `cmd.exe` IS a shell: it re-parses `& | < > ^ % ! ( ) , ;` in any argument that
  Node does not quote (Node quotes only arguments that contain spaces or quotes). So only a port that passed `classifyPort` and contains no `(` or `)` reaches it, and the file argument is the generated NAME
  (`gpos-<pid>-<timestamp>-<seq>.<ext>`) resolved through `cwd`, never a path built from the user's profile name. On non-Windows -> UNSUPPORTED_PLATFORM.
- Every job: unique temp file `gpos-<pid>-<timestamp>-<seq>.<ext>` created with mode 0o600 in the OS temp dir, ALWAYS deleted in `finally`. Per-target serial queue (key `system:<name>` / `port:<path>`), 30 s timeout per job (configurable), result returned to the caller.

### 9.2 Receipts
Payload `{ receiptFileBinary, ... }` (Uint8Array/Buffer/ArrayBuffer view/`{type:'Buffer',data:[...]}`): coerce to Buffer (rules and limits in 12), reject empty with INVALID_PAYLOAD, send to `printers.receipt`. NO_PRINTER_CONFIGURED if neither `printerName` nor `port`. The old web may also send `{ openCashDrawer: true }` with no `order`: that is a drawer request (password prompt window, see 10).

### 9.3 Zebra (ZPL)
Legacy envelope: `barcodefinal` is a ZPL string and `barcodefinal.printer` is undefined. New: `{ barcodefinal: { printer:'zebra', zpl } }` is also accepted. UTF-8 bytes to `printers.label` via the raw transport.

### 9.4 DYMO
`payload` is the outer legacy envelope and `bf` is `payload.barcodefinal`. A DYMO message needs `bf` to be an object whose `printer` is `'dymo'`; a string, or any other `printer` value, is the Zebra path of 9.3.
Which field is read from which object: 9.4a.
- Labels per message. One message prints exactly one physical label, EXCEPT a repair message (`bf.design === 'repair'`, size other than `25x25`) whose `bf.orderItems` is a non-empty array: it prints one label
  per element, in array order (a lone `bf.orderItem` is one label). The web sends one message per label and loops `prints` itself, so `prints` is NEVER a copy count (v1 computes `NumberOfPrints` and never
  uses it); using it would print prints x prints labels. A multi-label message stops at the first failure and answers `{ ok:false, code, message, details:{ printed, total } }`; it answers `{ ok:true }` only
  when every label printed.
- Input normalisation (v1 parity plus intended difference (e)):
  - `size`: exactly `'25x25'` or `'70x54'` select those templates; every other value (`'32x57'`, `'57x32'`, `'57x35'`, `''`, undefined) is the `32x57` default and is NEVER an error.
  - `design = bf.design === 'repair' ? 'repair' : parseInt(payload.design, 10)`. `'1'` and `1` are the same design; `''`, undefined and unlisted values (`5`, `'x'`) are NaN.
  - NaN design at 32x57 or 70x54: use the design-1 template of the requested size, and the sale template when `isSale === true && off > 0` (`off`: 9.4a). Sale = the design-1 sale fill. No sale = v1's
    final-else fill: `TEXT_4`/`TEXT`/`TEXT_1`/`TEXT_5` = `specs[0..3]`, `TEXT__1` = the RAW (not upper-cased) Processor, `TEXT_3` = price, `BARCODE`, `TextObject1` = masked barcode. At 25x25 a NaN design is
    exactly as in v1: designs 1 and 3 print the 25x25 barcode label, every other value (NaN included) the 25x25 QR label.
- Template selection, object names and values: reproduce v1 behaviour for every `size` (`32x57` default, `25x25`, `70x54`) x `design` (1, 2, 3, 4, `'repair'`, 7 = sale+design 2) x sale (`isSale === true && regular_price - salePrice > 0`) and `type === 'lab'`.
  The golden harness (T2) proves equality with v1 for a matrix of inputs, at the comparison level described in section 16; intended differences are only:
  (a) the currency symbol comes from the currency code (`payload.currency ?? bf.currency`, default `£` when absent/unknown) via `currencySymbol` (rule below), (b) processor reads `Processor ?? processor`,
  (c) empty condition prints no `GRADE ` entry, (d) every value is escaped properly, so quotes, backslashes, line breaks, backticks, `${}` print correctly,
  (e) at 32x57 and 70x54, v1 prints NOTHING for a NaN design with a sale (its sale fill sets `Text_was`, which the default template `Labeldesign1_1.dymo` does not contain, so DYMO throws) and opens the
  32x57 template for a NaN design at 70x54; v2 prints the proper design-1 label of the requested size. No print parameters are sent: v1's `createLabelWriterPrintParamsXml(BarcodeAndGraphics, darkness -1)` exists only in
  that broken branch and is dropped.
  `currencySymbol(iso)` trims and upper-cases its input and returns `£` for `GBP` and for anything that is not a three-letter code (missing, `''`, `'$'`, `'pounds'`); for every other code it returns the code
  followed by one space (`'AED '`, `'USD '`), the same rule as the web's thermal receipts (`utils/receiptMoney.js`) and Zebra labels (`lib.js` `printZebraBarcodes`). It never returns glyphs such as $, euro,
  rupee or riyal signs. Price digits stay as sent (v1 parity).
- Text cleanup for label objects: normalise CR/LF/TAB/U+2028/U+2029 to a single space, collapse runs of spaces, trim, remove NUL/control chars. Do NOT alter quotes (they are escaped, not removed).
- The script that runs in the hidden window is produced by `buildPrintScript` with `JSON.stringify` for labelXml, every op value, and the printer name; the barcode value goes through a replacer FUNCTION
  (never a replacement string, `$` is special).
- QR objects. Design 4, the `'repair'` label and the 25x25 QR label use the `_forceQRCodeUpdate` prototype patch exactly as v1 (op kind `'qr'`). Designs 2 and 7 ('Name + Attributes + QR'; 7 = design 2 on
  sale) do NOT use it in v1: they rewrite the template XML before `openLabelXml` (the `DataString` of `QRCodeObject0` and its `TextDataHolder` Value), rename that object to `QRCodeObject0_<Date.now()>` and
  install a `Label.prototype.setObjectText` wrapper. v2 reproduces designs 2 and 7 as op kind `'qr-embed'` (`{ name:'QRCodeObject0', value }`): `buildPrintScript` performs the same two replacements with replacer
  FUNCTIONS (value XML-escaped), the same rename (the suffix is injected, so tests are deterministic) and installs the same wrapper once. Using `_forceQRCodeUpdate` for designs 2 and 7 instead is a
  deviation that needs the integration owner's sign-off and, before release, printing one design-2 and one design-7 label on a real DYMO and scanning both QR codes (RELEASE.md checklist).
- Printer choice: `pickDymoPrinter(getPrinters(), config.printers.dymo.printerName)` (`''` = automatic; `printers.label` is for raw ZPL only): exact name match (case-insensitive, trimmed) -> unique "contains" match -> first connected LabelWriter -> first connected printer -> first printer. No printer => DYMO_NO_PRINTER.
- Hidden window manager: ONE shared load promise; every caller awaits it; ready means `did-finish-load` AND the framework object exists (poll up to 5 s); `did-fail-load`, `render-process-gone`, `closed` reset the manager so the next call recreates it; 15 s overall load timeout => DYMO_UNAVAILABLE. Remove the duplicate `loadDymoFramework` of v1. The window is created LAZILY on the first DYMO label (never at startup), reused, and disposed after 10 minutes without labels (constant `DYMO_IDLE_DISPOSE_MS`, timer `unref()`'d); the printer list is cached for 30 s (any failure invalidates it) and template XML is cached in memory after the first read (18b L2).
- Missing template file => DYMO_TEMPLATE_MISSING. A thrown script error => DYMO_PRINT_FAILED with the framework message.

### 9.4a Where each DYMO field is read from
`payload` = the outer envelope, `bf` = `payload.barcodefinal`. Merging the envelope into `bf`, or reading the outer `title` for normal labels, changes the output.
- From `payload`: `size`, `design` (numeric part) and `type`; and ONLY when `type == 'lab'` also `barcode` and `title`.
- `type == 'lab'` (any size or design): template `labitemdesign.dymo`; `BarcodeObject1` = `payload.barcode`, `TextObject12` = `payload.title`; nothing else is read.
- Otherwise from `bf`: `title`, `barcode`, `storage`, `network`, `ram`, `misc_color`, `warranty`, `Processor ?? processor`, `conditionObject.grade`, `price`, `salePrice`, `regular_price`, `isSale`;
  the currency code is `payload.currency ?? bf.currency`.
  - Every text value is `String()`-coerced (null/undefined -> `''`; numbers and booleans never throw, unlike v1's `toUpperCase` and `slice`) before the rules of 9.4.
  - `price` prints only when `Number(price) > 0` (a non-numeric price, such as the container number BoxLabelPrint sends, prints nothing, as in v1).
  - A sale needs `isSale === true` (strict) and `Number(regular_price) - Number(salePrice) > 0`; `off` = that difference `toFixed(2)`.
  - `warranty` prints only when its length is > 3, as `<warranty> WARRANTY` upper-cased.
- Repair (`bf.design === 'repair'`, size not `25x25`): one label per item of `bf.orderItems` (an array) or of `[bf.orderItem]`; an empty array prints nothing and answers INVALID_PAYLOAD. `ItemNameVal` =
  `item.product_name`; `TEXT`, `TEXT8`, `TEXT9` = the values of the 1st, 2nd and 3rd entries of `item.custom_field_value` (position kept; an entry whose value has no length > 0 gives `''`);
  `TextObject5` = `bf.customer.name`; `TextObject6` = `bf.customer.cell_no`; `TextObject7` = `''`; `TEXT_5` = `<business.business_name> <business.branch_name>` (`bf.business`); `TextObject1` = `bf.orderDate`;
  `TEXT4` = `bf.barcode`; `QRCodeObject0` = `bf.barcode` (op kind `'qr'`). v1 also reads `item.current_price`, `item.product_sn_imei_description` and `business.post_code` but never prints them; v2 must not
  print them either.
- With size `'25x25'` a repair design prints the 25x25 QR label like any other design (v1 checks the size first), not the repair loop.
- `bf = { printer:'dymo', barcode }` only (BarcodePDFGenerator's single-barcode path): a NaN-design label (9.4) with an empty title and, per (c), no GRADE entry.

### 9.5 Test prints (Settings)
- Receipt test: ESC/POS init, centred app name, a few sample lines with the printer name, `£`-free ASCII, feed, full cut.
- Label test: role `dymo` => `32x57` design 1 with sample values, printed on `printers.dymo`; role `label` => a small ZPL label with the text "TEST" and a sample barcode, printed on `printers.label`. Both go through the exact production code path.

## 10. Cash drawer and password

- Pulse: `ESC p m t1 t2` = `[0x1B, 0x70, pin === 5 ? 1 : 0, units(onTimeMs), units(offTimeMs)]` with `units(ms) = min(255, max(1, round(ms / 2)))`, sent through the RECEIPT printer's transport; Settings accepts 2..510 ms for both fields. The default config (50 ms, 510 ms) reproduces v1 bytes `1B 70 00 19 FF`.
- Entry points, all verified by the same `drawer.open({ password, source })`: Menu/Ctrl+D (opens the password prompt window), web `printReceipt`/`sendReceiptData({openCashDrawer:true})` without `order` (prompt window), web `openCashDrawer({password})` / `sendOpenDrawerCommand({cashDrawerOpenPassword})` (password arrives with the call), Settings test button.
- Receipt bytes are sent verbatim. The `ESC p` kick the web embeds in receipts and the 7-byte buffer built by the web's `opencashdrawer()` (sent as `receiptFileBinary`, with an `order` field) go through
  `printReceipt`/`sendReceiptData` like any receipt. `drawer.enabled`, `drawer.pin`, `onTimeMs`/`offTimeMs`, the password and the throttle apply ONLY to `drawer.open()` (Ctrl+D, the prompt window,
  `openCashDrawer`, `sendOpenDrawerCommand`, the Settings test button). Settings > Cash drawer says so in one line: "Drawer commands that are part of a receipt are not affected by these settings."
- Live web entry: `printReceipt({ openCashDrawer:true })` / `sendReceiptData({ openCashDrawer:true, order:false })` (`openCashDrawer === true` and a falsy `order`) is what the web's Open button sends. Its Result
  is `{ ok:true, details:{ prompted:true } }` as soon as the prompt window is shown. The prompt window shows wrong-password and lockout messages inline and closes on success; a pulse failure after a correct
  password is shown in the prompt window (and by the native error box on the legacy path). `openCashDrawer({ password })` and `sendOpenDrawerCommand` serve future callers.
- If no password is set: DRAWER_PASSWORD_NOT_SET (message tells the manager to set one in Settings). `drawer.enabled === false` => DRAWER_DISABLED.
- Policy (`validatePasswordPolicy`, applied only when a password is SET or CHANGED): minimum 4 characters, maximum 64; scrypt (N=16384, r=8, p=1, keylen 32, random 16-byte salt); constant-time compare; never
  log or return the hash or the password. `hashPassword` itself accepts any non-empty string, so a migrated v1 password that breaks the policy keeps working (`drawer.passwordWeak`, 5.2).
  A candidate handed to a check (the web page can send any size to the drawer channels) is hashed only up to `MAX_CANDIDATE_LENGTH` = 4096 UTF-16 units: a longer one is a wrong password (counted by the throttle like any other, with the same non-revealing answer) and never reaches the hash function; `validatePasswordPolicy` rejects a string of more than 128 units as too long without walking it.
- Throttle: 5 consecutive wrong passwords => locked 30 s, then 60 s, 120 s ... capped at 5 min; the lock applies to ALL password checks (drawer, change password, settings, reset); the Result carries `retryAfterSec`; success resets it.
  The running lock is a deadline on a MONOTONIC clock (`clock.monotonic`, `performance.now()` in the app), so setting the PC's clock back or forward neither shortens nor ends it. It is saved as `drawer.lock = { failures, remainingMs, writtenAt }` (`writtenAt` is the wall-clock moment of the write) after every change and read once at start, so closing and opening the app does not give five new guesses and a count of 3 wrong stays 3. After a restart only the wall clock is left: the time left is `remainingMs - (now - writtenAt)`, capped at 5 min, so a clock moved BACK since the write only lengthens the lock (never shortens it) and a clock moved far FORWARD while the app was closed shortens it (accepted: it cannot be told apart from time that really passed). A record that is not usable is ignored. Deleting `config.json` (the recovery below) removes it with the password.
- Changing/removing the password requires the current one. `resetAll` requires it when set. `requirePasswordForSettings` makes the Settings window ask for the password before opening (the prompt window is reused).
- Recovery. Settings > Cash drawer has a "Forgot the password?" disclosure: "Close GadgetsPOS, delete config.json in <userData path> (this also clears the printer settings), start the app and set a new password."
  SHOP-SETUP.md carries the same steps with the Windows path (`productName` is unchanged, so the folder is v1's; Settings > About shows the exact path). The recovery is a file deletion done outside the app;
  there is NO in-app or remote bypass, and the current-password rule and the throttle above are unchanged.

## 11. Connection, loading and offline experience

### 11.1 Loading
The main window shows `loading.html` (logo + spinner + "Starting GadgetsPOS...") instantly, then loads `serverUrl`. The window is created with `show:false` and shown on `ready-to-show` of the loading page.
First run (`window.bounds` null): width = min(1600, workArea.width) and height = min(900, workArea.height) of the primary display, and the window starts maximized when `workArea.width < 1400` (v1 always opened
a fixed 1600x900 window, partly off-screen on a smaller display). Saved bounds are restored only when they intersect a connected display by at least 200x100 px (otherwise the default is used, for example after
a second monitor was unplugged); `maximized` and `fullScreen` are applied after the bounds. Test with a fake `screen` (small display, unplugged second monitor).

### 11.2 Failures
- `did-fail-load` for the MAIN frame (ignore errorCode -3 ERR_ABORTED and sub-frames) -> show `offline.html` in the same window with `?reason=&code=&desc=&url=` and start the connectivity controller. Map codes: ERR_INTERNET_DISCONNECTED / ERR_NETWORK_CHANGED => offline; ERR_NAME_NOT_RESOLVED => dns; ERR_CONNECTION_REFUSED / RESET / CLOSED => refused; ERR_TIMED_OUT / ERR_CONNECTION_TIMED_OUT => timeout; ERR_CERT_* / ERR_SSL_* => tls (tell the user to check the PC date and time); other => other.
- HTTP status >= 500 on the main-frame navigation to `serverUrl` (`did-navigate` -> `httpResponseCode`) => the same screen with reason `server`.
- `render-process-gone` / `unresponsive` on the POS window -> a small "The page stopped responding" screen with Reload; never a blank window.
- Auto retry: probe with exponential backoff (3, 6, 12, 24, 30 s cap, +-20 % jitter); when the probe succeeds `loadURL(serverUrl)` automatically; "Retry now" is always available. The page shows attempt number and a live countdown.

### 11.3 Mid-session connection loss
The app preload shows a non-blocking banner (Shadow DOM, top centre, `pointer-events:none` except its button): "No internet connection. We'll keep trying — your work on this page is not lost." On `online`: "Back online" for 3 s then it disappears. The banner never covers more than 48 px of height and does not shift layout.
Detection without idle cost. Main listens with `session.webRequest.onErrorOccurred` (a notification, no timer) for requests to allowed origins. After two network errors from different requests within 10 s
(ERR_INTERNET_DISCONNECTED, ERR_NETWORK_CHANGED, ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED/RESET/CLOSED/TIMED_OUT, ERR_ADDRESS_UNREACHABLE; ERR_ABORTED is ignored) it starts the connectivity controller in
`'banner'` mode: it probes with the normal backoff and sends `connectivity:status` to the preload. On the first successful probe it sends `online` and stops; the page is NOT reloaded (only the full-screen
offline page of 11.2 reloads). The `online`/`offline` window events alone are not enough: they stay `online` when the router is up but the ISP is down, the usual shop outage. Test: fake session errors start and
then stop the controller; no timer exists before the first error.

### 11.4 `offline.html` content
Logo, illustration (reuse `assets/no-internet.svg` or an inline SVG), headline per reason, 2-3 plain checklist steps, status chip with attempt/countdown, buttons "Retry now" (primary), "Printer settings", "Change server address", and "Technical details" (disclosure: code, description, URL, time). The Printer settings button must work offline: `src/preload/app.js` exposes the `connection` subset on this page, and the page is locked down as described in 6.3.

## 12. Security model

- Main window (and every window it opens with `window.open`): `contextIsolation:true, sandbox:true, nodeIntegration:false, webSecurity:true, allowRunningInsecureContent:false, spellcheck:false` (memory, startup and no dictionary downloads; see 18b R2), preload `src/preload/app.js`. Settings and password windows: same flags, preload `src/preload/local.js`. DYMO window: hidden, same flags, preload `src/preload/dymo.js`. What each preload exposes, and how local pages are locked down, is defined in 6.3.
- `isAllowedOrigin(url)`: https only in production. Allowed: the origin of `serverUrl`; `https://gadgetspos.com` and any `https://*.gadgetspos.com`; `https://*.societyfiles.com` (the subdomains only: the bare domain `societyfiles.com` is NOT trusted, `BUILT_IN_ORIGINS` has no entry for it); entries of `extraAllowedOrigins` (exact origin or `*.domain`). Unpackaged dev additionally allows `http://localhost:*` and `http://127.0.0.1:*`.
  A wildcard over a PUBLIC SUFFIX or a SHARED HOSTING domain would trust every site anybody has there, so it is refused: bare top-level domains (already by the two-label rule), country registry suffixes (a two-letter country domain under `co`, `com`, `org`, `net`, `ac`, `gov`, `edu`, `or`, `ne`, `go`, `gob`, `ltd`, `plc`, `me`: `co.uk`, `com.au`, `co.nz`, `com.br`, `co.jp` ...) and the hosting platforms of `src/main/sharedSuffixes.js` (`github.io`, `herokuapp.com`, `vercel.app`, `netlify.app`, `pages.dev`, `web.app`, `amazonaws.com`, `blogspot.com`, ...). Settings (`validateConnection`) answers INVALID_SETTINGS in plain English ("*.co.uk" would allow every website that ends in co.uk, not only yours ...); `isAllowedOrigin` ignores such an entry even when it is already in config.json, and logs it once by name. An EXACT address on such a domain (`https://api.partner.co.uk`) is one site and stays valid, and so does a wildcard over a company's own domain (`*.myshop.co.uk`). The list is built in (no network, no dependency) and is not the full Public Suffix List.
- Provider hops. Main-frame navigation to `https://*.squareup.com` and `https://*.squareupsandbox.com`, and the redirect chain between them and the allowed origins, is allowed, so "Connect with Square"
  (`window.location.assign(authorize_url)`) completes inside the app and in the same session; opened in the system browser, Square's return would land where the cashier is not signed in (the token is in
  localStorage) and the connection would fail. These hosts live in one constant `NAVIGATION_ONLY_ORIGINS` in `security.js`: they are navigation-only, never part of `isAllowedOrigin`, never receive
  `window.electron`, never trusted IPC senders, and get no permissions.
- `will-navigate` / `will-redirect`: block navigation of the main frame to an origin that is neither allowed nor navigation-only; instead `shell.openExternal` for `https:`/`mailto:`/`tel:` only; everything else
  is silently denied. Whenever an https link is sent to the system browser, the app shows a one-line native notice "Opened in your browser: <host>".
- `setWindowOpenHandler(details)`: for a URL on an allowed origin, `about:blank` (opened from a page on an allowed origin), or a `blob:` URL whose origin is allowed, return `{ action: 'allow',
  overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: <the same secure flags and the app preload as the main window, passed explicitly> } }` (`width`/`height` features are honoured).
  The opener must get a real WindowProxy: pdfMake sets `win.location.href` to a blob URL and throws on null, popups are filled with `document.write` and `print()`, and the named `'pos-window'` receives
  `focus()`; v1 answered `deny` and created the window itself, so `window.open` returned null. With `allow`, Chromium also reuses an already open window of the same name for the same opener instead of
  opening another. Any other URL: `shell.openExternal` for https/mailto/tel only, then `{ action: 'deny' }`.
  Rate limit (`OPEN_LIMITS` in `security.js`): popups and system-browser opens (from `window.open` and from a blocked `will-navigate` / `will-redirect`) share ONE budget of 3 per 10 s per webContents and 20 per minute for the whole app, on a clock that only moves forward (injectable `now`); the rest are refused (a blocked navigation is still cancelled, a popup is answered `deny`). Only what was allowed counts, and what opens nothing (an unsafe link, an opener that is not allowed) costs nothing. A refused burst is reported ONCE through `onBlocked` (`reason: 'rate-limited'`, no URL: the host only, because a query string can carry a token) and a new burst after the next allowed open is reported again.
- The guards (this handler, `will-navigate`, `will-redirect`) are installed for EVERY webContents through `app.on('web-contents-created')`, children included; the permission handlers live on the session
  (`configureSession`). Windows opened with `window.open` get no `desktop:*` area (6.3): their remote channels are origin-checked like the main window's. Tests with the fake: handler results for `about:blank`, `blob:` (allowed and foreign origin),
  allowed https, foreign https, `javascript:`, `file:` and `mailto:`.
- `isTrustedSender(event, registry, area)` is applied by EVERY `ipcMain.on/handle` in `ipc.js` (except `app:origin-allowed`, which is itself the origin test, 6.1). The sender must be the main frame: `event.senderFrame === event.sender.mainFrame` is the fast path, and
  `senderFrame.parent === null` is the authoritative test (distinct WebFrameMain objects can refer to the same frame). Remote channels: the frame ORIGIN (`senderFrame.origin`) must pass `isAllowedOrigin`.
  `desktop:<area>:*` channels: the sender's webContents id must be registered with that `area` (6.3) AND the frame must be a `file:` page inside `<rendererDir>` + path.sep: take `frame.url`, strip search and
  hash, convert with `fileURLToPath` (for `file:` pages `senderFrame.origin` is just `file://`, and the offline page's URL carries a query string). The frame is read inside try/catch (a disposed frame
  throws): any throw means untrusted. Otherwise return `{ ok:false, code:'UNTRUSTED_SENDER' }` (invoke) or drop the message (send).
- `session.setPermissionRequestHandler`: allow `notifications`, `fullscreen`, `clipboard-sanitized-write`, `media` (the POS plays sounds) and `window-management` only for allowed origins; deny the rest. Never add a certificate-error bypass.
- DevTools only when `!app.isPackaged` or the app is started with `--devtools`. No "Toggle Developer Tools" menu item in production.
- `app.requestSingleInstanceLock()`; on `second-instance` focus the existing window.
- Payload validation at the IPC boundary checks ONLY the fields the app reads: `receiptFileBinary` (a Buffer, a Uint8Array or another ArrayBuffer view, or `{type:'Buffer', data}`; a view is copied with
  `Buffer.from(view.buffer, view.byteOffset, view.byteLength)`; empty -> INVALID_PAYLOAD; more than 5 MB -> INVALID_PAYLOAD), `openCashDrawer`, the presence of `order`, `password`, and the DYMO/Zebra fields of
  9.4a. A label text longer than 2 KB is truncated to 2 KB, not rejected, and the 256 KB label limit applies to the fields read, not to the whole envelope. Unread properties are never inspected, copied or
  logged: legacy receipt payloads carry whole `order`, `business`, `businessData` and `settings` objects (free-text notes included) and the repair label carries the whole order item, and v1 printed them all.
  Tests: a legacy receipt payload with a 10 KB string inside `settings` prints; a repair label with a 300 KB unread property prints.
- Logs (`electron-log`, file rotation): never log passwords, receipt bytes, full payloads or customer data; log job kind, label (e.g. "label dymo 32x57 design 1"), outcome, duration, error code.

## 12b. Application menu (`src/main/windows/menu.js`)

`buildMenuTemplate({ platform, isDev, handlers })` is pure and unit-tested. v1's menu had Open Drawer, View (zoom, DevTools), Settings and Quit, and no Reload (a hung POS page could only be fixed by quitting);
v2 keeps those and adds the missing ones. Top level, in this order:
1. `Open Drawer (Ctrl+D)`: accelerator `CmdOrCtrl+D`; opens the password window (kept at top level, as in v1).
2. `View`: Reload (`CmdOrCtrl+R`; a hidden item adds `F5`), Force reload (`CmdOrCtrl+Shift+R`), Zoom in (`CmdOrCtrl+Plus`; a hidden item adds `CmdOrCtrl+=`), Zoom out (`CmdOrCtrl+-`), Actual size
   (`CmdOrCtrl+0`), Toggle full screen (`F11`; `Ctrl+Cmd+F` on macOS), and Toggle Developer Tools (`CmdOrCtrl+Shift+I`) ONLY when `isDev` or the app was started with `--devtools`. Zoom uses `handlers`, not the
   built-in zoom roles, so the level is saved as `window.zoomLevel` (clamped -3..5) and re-applied on every main-frame `did-finish-load` (v1's `newWindow.zoomLevel = 1` was a no-op property).
3. `Settings`: Printers, Cash drawer, Connection, General; each opens the single Settings window on that tab (`requirePasswordForSettings` applies). Replaces v1's Configure Receipt / A4 / Label Printer items.
4. `Help`: About GadgetsPOS (Settings > About), Open logs folder, Copy diagnostics, Compatibility mode (a checkbox, see 18b R1b).
5. `Quit` (`CmdOrCtrl+Q`): graceful quit (18b D5). On macOS the standard app menu comes first and Quit is not repeated.
Tests: the template shape per platform and `isDev`, accelerators unique, DevTools absent when packaged, every handler invoked.

## 13. Auto-update

`electron-updater` with `autoDownload: true` (`config.updates.autoDownload`), `autoInstallOnAppQuit: true`, `disableWebInstaller: true`, `allowDowngrade: false`, `allowPrerelease: false`, `logger: log`. `init()` runs
10 s after the POS finished loading (18b S1); the first check follows at once (never earlier than 30 s after start), then every 4 h. Every `checkForUpdates()` is awaited inside try/catch: it both rejects and
emits `error`.
- Feed URL = the `url:` line of `<process.resourcesPath>/app-update.yml` (quotes optional), which electron-builder writes from `build.publish[0]` (one regex, no YAML dependency; `readFeedUrl` is injected).
  NEVER read `package.json`'s `build` key at runtime: electron-builder strips it from the packaged package.json, so the updater would be permanently disabled in production.
- `GADGETSPOS_UPDATE_URL` (https only) is honoured ONLY when `!app.isPackaged` (through `setFeedURL`); a packaged app ignores it, because an environment variable must not be able to redirect an installer download.
- Status `disabled` (a no-op) when the app is packaged but `app-update.yml` is missing or its url is not https or contains `CHANGE-ME`, and when it is not packaged unless `GADGETSPOS_UPDATE_URL` is set (a test hook).
- `install()` = `autoUpdater.quitAndInstall(true, true)` (silent, then restart); the default call opens the NSIS wizard.
- On `update-downloaded` show a native dialog (Restart now / Later) and a Settings > About status line. All updater events are logged. Unsigned macOS builds cannot self-update: document it in RELEASE.md. On Windows
  electron-updater verifies the installer's signature only when `build.win.publisherName` is set (which needs a code-signing certificate): RELEASE.md lists it under what the owner must provide.
- v1.x has no updater, so the first v2 install is a manual run of the installer (same appId; userData is kept): RELEASE.md says so.

## 14. UI design system (T5)

Brand: primary `#C12126` (buttons, focus accent), logo navy `#16355E` (headings, brand details). Surfaces `#FFFFFF` / `#F6F7FB`, borders `#E3E5EC`, text `#1C1F2A` / muted `#5B6070`.
BRAND ASSETS (owner instruction 2026-11-19: the desktop app carries the GadgetsPOS identity; the old "Gadgets Market" logo must not appear anywhere): the official lockup (laptop + phone with the words GADGETS POS) is `src/renderer/shared/logo.png` (full colour, 640x340, aspect 1.882) and `src/renderer/shared/logo-white.png` (reversed for dark surfaces); the application icon is the official square mark (`assets/icon.png` 512, `assets/icon.ico` 16-256, `assets/icon.icns`); `assets/logo.jpg` and `assets/icon-small.ico` (old brand) were deleted and must not come back. Palette from gadgetspos.com: brand red `#C12126`, logo navy `#16355E`, paper `#F6F7FB`, ink `#2B3445`, muted `#6B7484`, line `#DAE1E7`. UI text and alt attributes say "GadgetsPOS". Do NOT rename `package.json` name / `build.productName` / `build.appId` (the user-data folder and installer upgrades depend on them). Sources: gadgetspos-video/videos/gadgetspos-intro/capture/assets/gadgets-pos-logo.png and favicon.svg.
Semantic colours are separate from the brand: success `#1B873F`, warning `#B76E00`, danger `#B42318`, info `#1F5FBF`.
Type: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; 14/16 px body, 20/28 px headings; 8 px spacing grid; 12 px card radius; one soft shadow. Light theme + automatic dark theme (`prefers-color-scheme`); `prefers-reduced-motion` respected; no external fonts/CDNs (must work offline); inline SVG icons only.
Accessibility: visible focus rings, `aria-live` regions for status/results, labelled controls, 44 px touch targets, Enter submits / Escape closes where it makes sense, contrast >= 4.5:1.
Tokens live in `src/renderer/shared/tokens.css`; every page imports it. No framework, no build step: plain HTML/CSS/JS modules.

Screens: `loading.html`; `offline.html`; `settings.html` (left tab list: Printers, Cash drawer, Connection, General, About & updates); `password.html` (compact modal window).
- Printers tab: two cards (Receipt printer, Label printer). The Receipt card has a connection type selector ("Installed printer (recommended)" / "Advanced: port or network share"; a port is checked with `classifyPort`, 9.1), a printer picker (radio list of installed printers with default badge and status, refresh button, search when > 8), a Test button with inline result (success/failure message from the Result), a Save button and an unsaved-changes indicator. The Label card has two sections, each with its own Test and Save: "Zebra / raw label printer" (role `label`: the same selector and picker as the receipt card) and "DYMO printer" (role `dymo`: the list detected via DYMO Connect with a connected badge, default "Automatic (recommended)", and a hint when DYMO Connect is not running).
- Cash drawer tab: password status + Set/Change password dialog (current, new, confirm, strength hint), the notice for a weak migrated password (`drawer.passwordWeak`, 5.2), drawer settings (enable, pin 2/5, pulse length 2..510 ms, require password for settings) with the one-line help "Drawer commands that are part of a receipt are not affected by these settings.", "Open drawer (test)" with password field, lockout countdown, and the "Forgot the password?" disclosure (10).
- General tab (18b): switches "Start GadgetsPOS when this computer starts" (hidden on Linux), "Start in full screen", "Keep this computer awake while GadgetsPOS is open", and the "Hardware acceleration" switch (recommended; with the explanation "Turn this off only if the screen flickers or stays blank"; shows a Restart now button after a change and a notice when the app switched itself to compatibility mode, with the reason).
- Connection tab: server address (validated https URL), extra allowed domains list (add/remove), current status chip, "Reload POS".
- About tab: version, a collapsible "Startup details" with the startup marks (18b S3), update status + Check/Install buttons, open logs folder, copy diagnostics, factory reset (type the word RESET and password).
- Password window: single password field, show/hide toggle, inline error, lockout countdown, Enter submits, Esc cancels.
- Unsaved changes in Settings: while a tab has edits that are not saved the Settings page asks to stay (`beforeunload`), and the main process answers Electron's `will-prevent-unload` on that window (`src/main/windows/settings.js`) with the native question "You have unsaved changes. Discard them and close?", buttons "Keep editing" (the default and the answer to Escape: the window stays) and "Discard changes" (`event.preventDefault()`: the window closes). A page with nothing unsaved asks nothing and closes at once. Quit, Restart and closing the POS window (Windows and Linux; on macOS closing the window does not quit) close an open Settings window FIRST through the same path (`confirmClose`): there is exactly one question, "Keep editing" cancels the quit or restart before anything is shut down (a relaunch is never scheduled), and "Discard changes" lets it go on. Without that the Settings window, a child of the main window, would be taken down with its parent and the question could not be answered.
- Each page must look finished at 1280x800 and 960x600, and the settings window at 100% and 150% text zoom.

## 15. Packaging rules (INTEGRATE)

- `package.json`: `main: "src/main/index.js"`, `version: "2.0.0"`, KEEP `build.appId` and `productName` (changing them breaks upgrades), runtime deps only `electron-store`, `electron-log`, `electron-updater`; devDeps `electron`, `electron-builder`, `@electron/fuses` (for the afterPack hook). Remove everything else (puppeteer, react, react-dom, serialport, usb, escpos*, winston, pdfkit, bwip-js, iconv-lite, dotenv, child_process, webpack/babel/rebuild/packager and `@types/*`), the `postinstall`, `package` and `build` webpack scripts. Add scripts `start`, `test` (`node --test "tests/**/*.test.js"`), `release:check` (`node --test tests/release/release.check.js`: a file, not a glob, because the build PC may run a Node that does not expand globs for `--test`), `predist` (`npm run release:check`: `npm run dist` builds only when every owner release gate is closed) and `dist` (`electron-builder`).
- Owner release gates (`tests/release/gates.js`, run by `npm run release:check`, NOT by `npm test`; commands and what each protects are in RELEASE.md section 2): a supported Electron major (installed and declared), `build.win.publisherName`, the Electron fuses flipped (the hook below AND `@electron/fuses` installed), `package-lock.json` not git-ignored, present and written for this package.json, and a real (not `CHANGE-ME`) https update feed address. They are open on purpose until the owner has a network, a certificate and a feed; they are unit tested against fake projects (`tests/packaging/release-gates.test.js`).
- `build.afterPack` is `./scripts/after-pack-fuses.js`: it flips, with `@electron/fuses` and before signing, `RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableNodeOptionsEnvironmentVariable` off, `OnlyLoadAppFromAsar` on, and `EnableEmbeddedAsarIntegrityValidation` on only on macOS (electron-builder 24 embeds the digest only there). It fails the build with the way out when the package is not installed. It is a build tool, so `build.files` excludes it (`!scripts/after-pack-fuses.js`); `.gitignore` no longer lists `package-lock.json`.
- `build.files`: `src/**`, `labels/**`, `assets/**`, `scripts/**`, `!scripts/after-pack-fuses.js` (a build tool, below), `package.json` (nothing else); `asarUnpack: ["scripts/**"]`; `publish: [{ provider: 'generic', url: 'https://CHANGE-ME.example.com/gadgetspos-desktop/' }]` (electron-builder writes it to `resources/app-update.yml`, the only place the updater reads the feed from, 13); NSIS `oneClick: false`, per-machine optional (v1's builder config has no `nsis` block, i.e. electron-builder's one-click per-user installer; if the upgrade checklist of 19.6 shows two installs side by side, keep `oneClick: true` for the first v2 release and record the finding in RELEASE.md). A TEST must check that every file `require`d from `src/main/index.js` (recursively) and every renderer/preload/label/asset file referenced from code is matched by `build.files`.
- Delete legacy files only after nothing references them: `index.js`, `preload.js`, `dymo-preload.js`, `dymo-config.html`, `dymo-loader.html` (replaced by `src/renderer/dymo-loader.html`), `printer-*.html`, `password-prompt.html`, `reset-password.html`, `offline.html`, `renderer.js`, `webpack.config.js`, `receipt.txt`, `receipt-pdf.pdf`, `undefined`, the root `dymo.connect.framework.js` if `assets/` has the same file.

## 16. Test requirements (minimum)

- queue: strict order per key, independent keys do not block each other, timeout, results/rejections propagate, no leaked temp files (inject fake fs).
- transports: exact argv arrays (no shell), unique temp names under concurrency, deletion in finally, direct-write -> copy fallback (the argv has `cwd` = the temp dir and a bare generated file NAME), a `classifyPort` table (`LPT1`, `lpt1:`, `\\.\COM3`, `COM257`, `\\localhost\Zebra ZD420`, `USB001`, `LPT1&calc`, `C:\x`, `..\x`, `\\?\C:\x`, `\\host\a\b`, a name containing `%`), a bare non-device name never reaches `open` or `cmd.exe` (fake fs and execFile), a device is opened as `\\.\<NAME>` without create/truncate, platform branches, error code mapping.
- dymo: golden matrix vs v1 (sizes x designs x sale x repair x lab x missing fields, plus design `''`, `'x'`, undefined and 5, each with sale true/false at sizes 32x57 and 70x54, and repair messages with `orderItems`) with intended differences (a)-(e) of 9.4 listed explicitly, including the v1 outcomes "prints nothing" and "wrong-size template". The comparison level is: the template file, the ordered (object name, text) pairs, the QR (object name, text) and the printer recovered from v1's script text run with benign inputs; XML-level equality is NOT claimed for the QR designs, which v1 handles by two different mechanisms (9.4). Also: hostile strings (`MacBook Air 13" M1`, newline, backslash, backtick, `${x}`, `</script>`, U+2028, `$&`, very long text) all produce parseable scripts and the fake framework receives the exact original text; template object names exist in the XML; `currencySymbol` cases (`'GBP'`, `'gbp'`, `' usd '`, `''`, undefined, `'$'`, `'AED'`); a repair message stops at its first failed label and reports `details.printed`/`total`; `pickDymoPrinter` cases; window manager readiness/race/reset with a fake window.
- config: the fake `Store` reproduces conf's constructor (`Object.assign({}, defaults, fileContents)`, then writes the result back), so a `defaults` bug is caught; plus one test against the real `electron-store` with an explicit `cwd` in a temp dir (it imports under plain Node). A fixture written by v1.6.1 (`printerName`, `printerPort`, `password`, `labelPrinterName`, `labelPrinterPort`, `a4PrinterName`) opened through the REAL `createConfig` with the full v2 `defaults` migrates every key; a second start changes nothing; a file already at `schemaVersion` 2 is untouched; a failing password hash leaves `schemaVersion` unwritten and the legacy `password` in place; `config.v1-backup.json` has no `password`; the legacy printer keys are still there afterwards; a corrupt and a 0-byte `config.json` are renamed and the app starts from defaults; `set(path, undefined)` deletes; nested defaults resolve through `get`. Legacy passwords `'1'`, `'123'`, a 65-character string, `' 1234 '` and `'päss'` all verify after migration, with `passwordWeak` set exactly when the 4..64 policy is broken. Password hashing, throttle clock. Drawer bytes: the default config yields exactly `1B 70 00 19 FF`; pin 5 yields `1B 70 01 19 FF`; 2 ms -> `01`; 510 ms -> `FF`; 1000 ms -> `FF` (clamped).
- security: origin matrix (production vs dev), wildcard rules, `blob:`/`about:blank`, navigation guards (including the `NAVIGATION_ONLY_ORIGINS` hosts: allowed for `will-navigate`/`will-redirect`, rejected by `isAllowedOrigin` and by `isTrustedSender`), the window-open handler results (12), `app:origin-allowed` (6.1), `isTrustedSender` with the per-window area registry (6.3).
- connectivity: backoff schedule, jitter bounds, retryNow, transition callbacks, banner mode started and stopped by session errors (11.3) (fake timers/net).
- updater: no-op conditions (packaged without `app-update.yml`, http or `CHANGE-ME` url, unpackaged with and without `GADGETSPOS_UPDATE_URL`, a packaged app ignoring the variable), the feed url parsed from a sample `app-update.yml` (quoted and unquoted), `install()` calls `quitAndInstall(true, true)`, a rejecting `checkForUpdates` is caught, events -> status.
- ipc (integration): every legacy channel with legacy payloads, every new channel, untrusted sender rejection, area enforcement (6.3), payload limits (12: only the fields read; legacy receipts and repair labels with large unread properties still print), `printReceipt({ openCashDrawer:true })` answers `{ ok:true, details:{ prompted:true } }` (10).
- flags: read/write/atomic write/corrupt file/defaults, the GPU safety-net decision function (two GPU crashes within 60 s, early POS renderer crash), `--disable-gpu` precedence, the `gpuChecked` answer is stored and the question is never asked again (18b R1b).
- perf: startup marks order and summary; lazy-require of electron-updater (module not loaded before the POS finished loading); DYMO window never created at startup and disposed after the idle time (fake timers); persistent PowerShell host protocol with a fake child process (ONE spawn for 50 jobs, respawn after crash, idle shutdown, fallback to one-shot, per-command timeout); queue.drain.
- native: context menu templates for editable/selection/link/image/dev cases; application menu templates per platform and `isDev` (12b); login item wiring through a fake `app`; full screen persistence; first-run and restored window bounds with a fake `screen` (11.1); graceful quit order.
- vendor (T6): the tests of section 18, including the existing golden receipt tests (`thermalReceiptsAllCurrencies`, `loadLib`, `moneyGolden`) which must stay green.
- packaging manifest test (see 15).
- UI: screenshots of every screen/state produced by a harness (section 17) and reviewed.

## 17. Harnesses

- `tests/helpers/fake-electron.js`: stub of `electron` (app, BrowserWindow, ipcMain, dialog, shell, session including `webRequest`, net, Menu, screen) usable through `Module._load` interception so legacy `index.js` can be executed for golden tests.
- `tests/e2e/ui-shots.js` (T5): `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/e2e/ui-shots.js` opens every page with a stub `window.desktop` and writes PNGs to `tests/e2e/out/` through `webContents.capturePage()`. States: loading, offline (each reason, with countdown), settings tabs (empty config, populated printers, DYMO not running, test success/failure, password dialogs, lockout), password window (idle, wrong, locked).
- `tests/e2e/fake-pos.js` (INTEGRATE): a tiny local HTTP server serving a page that calls every `window.electron.*` function and records results, used with the real app via `GADGETSPOS_START_URL` (honoured ONLY when `!app.isPackaged`) and `bootstrap({ overrides })` fakes for printers. It also proves 6.3 in the real app: with the server stopped, the offline page's `window.desktop.connection` works; on the POS page `window.electron` exists and `window.desktop` does not.

## 18. Vendor (web app) integration — worktree `DGshop_vendor-labelprint` (T6)

Goal: one choke point for desktop printing in the web app, with feedback. No business-logic changes. Follow the vendor `CLAUDE.md` for anything visual.

- New `src/utils/desktop/`: `index.js` (public API), `bridge.js` (feature detection and calls), `legacyLabelText.js` (sanitiser for v1 desktops), `feedback.js` (CustomEvent `dg:desktop-print` with `{ level, code, message }`, de-duplicated within 4 s per code+message).
  - `isDesktopApp()`; `getDesktopInfo()` (cached `getAppInfo()` or `{ apiVersion: 1 }`);
  - `sendReceipt(payload)` -> uses `window.electron.printReceipt` when present, else `sendReceiptData`; with the new API send ONLY `{ receiptFileBinary }` (or `{ openCashDrawer: true }`), not the whole business/settings object; returns Promise<Result>; shows a feedback event on failure.
  - `OverAllReport.jsx` (the `sendReceiptData` call at line 381) and `StockReports.jsx` (line 440) keep `handlePrint` a `const` arrow function that builds `receiptFileBinary` and hands `{ receiptFileBinary, businessData, business, isDuplicate: true, settings: posCurrencyExit }` to `sendReceipt`: the repo's golden receipt tests extract that closure from the source (Babel parser) and run it with a scope made of the exports of `lib.js`, `thermalMoney.js` and `receiptMoney.js`. Update `loadCategoryPrint` in `src/utils/__tests__/helpers/loadLib.mjs` (lines 107-128) so the extracted closure's scope also contains `sendReceipt: (payload) => (sent = payload)` (keep the `window.electron.sendReceiptData` stub for files that still use it). The golden receipt bytes must not change; run `thermalReceiptsAllCurrencies.test.mjs`, `loadLib.test.mjs` and `moneyGolden.test.mjs` in the vendor test pass.
  - `sendLabel(payload)` -> `printBarcode` when present, else `sendBarcodeData` with `legacyLabelText` applied to DYMO payloads. ALWAYS (both paths) normalise the processor key of an OBJECT `barcodefinal`: set `Processor` and `processor` to the same value when either exists. `sendLabel` never invents a `currency`: every site that prints a price already passes it, and lab, appointment and box labels print none (the desktop defaults to `£`, 9.4).
  - `legacyLabelText` walks the whole `barcodefinal` object DEEPLY (nested objects and arrays: `orderItem`/`orderItems[]`, `custom_field_value[].value`, `customer`, `business`, `orderDate`) and the outer `title` and `barcode`, and applies `"` -> `''`, `\` -> `/`, CR/LF/TAB/U+2028/2029 -> space and collapsed spaces to every string leaf, leaving numbers, booleans, null and undefined untouched (v1 interpolates all of them into double-quoted script strings). A `barcodefinal` that is a string (Zebra ZPL) is never modified.
  - If `barcodefinal` is null or undefined (`lib.js` `printBarcodes` returns undefined unless `label_printer_type` is `'zebra'` or `'dymo'`), `sendLabel` does not call the desktop: it returns `{ ok:false, code:'INVALID_PAYLOAD', message:'No label printer type is chosen. Open Account settings and choose Zebra or DYMO.' }` and raises the feedback event.
  - `openCashDrawer({ password })` -> `window.electron.openCashDrawer({ password })` when present (v2 desktop). Otherwise (a v1.x desktop, whose preload exposes only `sendReceiptData` and `sendBarcodeData`) -> `window.electron.sendReceiptData({ openCashDrawer: true })`, which opens the app's own password window; the `password` argument is ignored there and the util resolves `{ ok:true, details:{ prompted:true } }`. The util never calls `sendOpenDrawerCommand` (it exists only on v2 desktops, which also have `openCashDrawer`). On `DRAWER_WRONG_PASSWORD` / `DRAWER_LOCKED_OUT` the caller (cashDrawerForm) shows the message inline. No util function ever throws because a bridge function is missing: each returns a Result and raises the feedback event on failure.
- New non-visual component `src/components/PrintFeedbackBridge.jsx` mounted once inside `SnackbarProvider` in `pages/_app.jsx`; it turns `dg:desktop-print` events into notistack snackbars (error/warning/success), using the existing snackbar conventions.
- Replace EVERY direct use of `window.electron.sendBarcodeData`, `sendReceiptData`, `sendOpenDrawerCommand` (list: BarcodeModal, BarcodePDFGenerator x2, BarcodePanelTab, QuickProductWithPurchaseOrder, BoxLabelPrint, orders/{repair,buy,sell}/OrderDetails, appointmentDetail, labItemLabel.js default `send`, directPrint.js, ReceiptIcons, CompletedOrderReceipts, AllSalesCompletedOrderReceipts, CustomerOrderReceipt, ReturnCompleteOrderReceipt, RemainingOrderAmountReceipt, PendingAndProgressReceipt, drawerpurchaseprint, progress/pending order list + card views, useBulkOrderComplete, pos-card-items-bottom (3 sites), DailyClosing, StockReports, OverAllReport, cashDrawerForm). Gating checks like `window.electron && ...` that decide whether to SHOW a print button may stay.
- Multi-label loops (`for i < prints`, serial/IMEI loops): keep their behaviour (the web loops `prints` itself, 9.4) but `await` each `sendLabel`. A returned Result with `ok === false` counts as ONE failed label and ends the loop (the remaining copies are neither attempted nor counted); the single failure message is shown by the feedback event. A thrown error while building the label keeps today's behaviour (logged, counted as failed, loop continues). `printLabItemLabels` keeps its return shape `{ printed, failed }` exactly, and a `deliver` result that is not an object (the existing test stubs return undefined or a number) counts as success. Quick Add's `handlePrint` counts a Result with `ok === false` as `failedLabels += 1`, so it still throws at the end and `reportLabelFailures` keeps its "product was saved, but N labels could not be printed" warning; `feedback.js` de-duplicates the identical per-loop messages. Add one test for the stop case; the existing `labItemLabel` tests stay unchanged.
- `BarcodeModal.jsx`: no payload change. Its size selector appears only when `label_printer_type !== 'dymo'` and holds PDF page sizes (57x35, 57x32, 57x25, 32x25); for DYMO the modal offers only the layout radios, so the desktop default 32x57 is correct, and Zebra ZPL ignores size. Do not send `size` from this modal. (An empty layout choice, design `''`, is normal input there and in `BarcodePanelTab.jsx`: the desktop prints design 1, 9.4.)
- `BarcodePanelTab.jsx`: its `size` state starts from the localStorage key `labelSize`, shared with the PDF selector, so a DYMO shop can send `'57x35'`. When `label_printer_type === 'dymo'`, send `size` only if it is `'32x57'`, `'70x54'` or `'25x25'`, otherwise `'32x57'` (the stored value is left untouched). The desktop maps any other value to 32x57 anyway (9.4).
- Tests under `src/utils/__tests__/` (node:test style used by the repo): sanitiser (deep walk; a Zebra string untouched), API selection (new vs legacy, including the drawer fallback on a desktop that has only `sendReceiptData`), payload normalisation, feedback de-duplication, and a SOURCE-SCAN test that fails if any file other than `src/utils/desktop/*` still calls `window.electron.send(Barcode|Receipt)Data` / `sendOpenDrawerCommand`.
- Run existing related tests (labItemLabel etc.) and lint the changed files with the repo's eslint; do NOT run `next build` or a dev server.

## 18b. Performance and native-desktop requirements (owner request 2026-11-19: "proper desktop, beautiful, improved performance, better performance")

Performance is a feature with budgets. v1 baseline problems: software rendering forced on (`app.disableHardwareAcceleration()` since 2025-11, commit unexplained), PDFKit plus a 1900-line main file loaded at boot, a hidden DYMO renderer process created at startup, a PowerShell/cmd process spawned per print, spellcheck on, background throttling of the POS window (timers, sockets and order sounds slow down when it is minimised), no HTTP preconnect, no graceful quit.
Each item below names its owner (T1..T6 as in section 3; INTEGRATE = the integrator).

### Startup
- S1 (INTEGRATE, T3 for flags.js). Boot order: `flags.json` (sync) -> command-line switches -> `app.whenReady` -> create the main window and show `loading.html` IMMEDIATELY -> then config, services, menu, IPC, connectivity, updater. Never `require` heavy modules before the window exists. The one handler registered BEFORE the first window is created is `app:origin-allowed` (6.1): a preload's `sendSync` that nobody answers would block its page (it answers from the config snapshot, defaults while the config is still loading). Lazy: `electron-updater` is required 10 s after the POS finished loading (13); the DYMO service/window on the first DYMO label; `electron-store` is imported while the loading page renders.
- S2 (INTEGRATE). `session.defaultSession.preconnect({ url: <serverUrl origin>, numSockets: 4 })` as soon as the URL is known (in parallel with loading.html) and again before each reconnect attempt.
- S3 (INTEGRATE). `src/main/perf.js`: `createPerf({ now, log })` -> `mark(name)`, `measures()`, `summary()`. Marks: process-start (from `process.uptime()`), app-ready, window-created, loading-visible, config-ready, services-ready, pos-dom-ready, pos-loaded. Logged once as a single line, shown in Settings > About "Startup details" and included in copyDiagnostics.
- Budgets measured by the benchmark: time to the loading screen <= 0.75 x the v1 time to its first window; main-process boot (app-ready -> loading-visible) <= 400 ms; summed RSS of all app processes after 30 s idle <= 0.85 x v1.

### Rendering and runtime
- R1 (T3 flags.js, INTEGRATE wiring, T5 UI). Hardware acceleration ON by default. v1 turned it off globally, which makes a heavy POS UI scroll and animate on the CPU. Escape hatch: `flags.json` in userData `{ "disableGpu": false, "disableBrotli": true, "reason": "", "gpuChecked": false }`, read synchronously by `src/main/flags.js` BEFORE app ready (atomic writes: temp file + rename; a corrupt file is ignored and replaced by defaults). Settings > General switch writes it and offers Restart now (`app.relaunch()` + quit). Safety net (pure, tested decision function `shouldFallBackToSoftware(events, now)`): a `child-process-gone` of type GPU (reason other than clean-exit) twice within 60 s, or a `render-process-gone` of the POS window within 20 s of start with reason crashed/launch-failed/integrity-failure -> write `{ disableGpu: true, reason }` and show a native dialog "The screen had a problem. GadgetsPOS will use compatibility mode." with Restart now / Later. A `--disable-gpu` argument always wins. Chromium's GPU blocklist stays active (never pass ignore-gpu-blocklist). `disableBrotli` keeps v1's `disable-brotli` switch (added 2026-09-17, reason unrecorded): default true to preserve behaviour; documented in docs/PERFORMANCE.md as something to test turning off.
- R1b (T3 flags.js, T4b menu, INTEGRATE). Recovery that does not depend on web rendering: `shouldFallBackToSoftware` only sees crashes, but blank, black or garbled rendering crashes no process, and Settings, the loading page and the offline page use the same compositor, so a till showing a blank POS could not reach the switch. (1) Help > Compatibility mode is a NATIVE menu checkbox that writes `{ "disableGpu": true, "reason": "manual" }` to flags.json and shows a native restart dialog. (2) On the first launch after a v1 -> v2 migration (`migrateLegacy` ran) and once the POS window has been visible for 20 s, show a native (non-web) message box "Does the screen look right?" with "Yes" and "No, use compatibility mode"; "No" writes the flag and relaunches; either answer sets `"gpuChecked": true`, so the question is never asked again. (3) SHOP-SETUP.md documents the `--disable-gpu` shortcut argument.
- R2 (T4b window options, INTEGRATE switches). POS window webPreferences: `backgroundThrottling: false` (order sounds, sockets and timers keep running while minimised), `spellcheck: false`, `v8CacheOptions: 'bypassHeatCheck'`. `app.commandLine.appendSwitch('disk-cache-size', '536870912')`; on Windows also `disable-features=CalculateNativeWinOcclusion`. `powerSaveBlocker.start('prevent-app-suspension')` while the POS window exists and `power.keepAwake` is true (display sleep is NOT prevented).
- R3 (everyone). No timers while idle: connectivity probes run only while offline (the full-screen offline page of 11.2, or banner mode after request errors, 11.3, which starts from a notification, not a timer); updater and idle-dispose timers are `unref()`'d; nothing polls.
- R4 (T2, INTEGRATE). Memory: lazy DYMO window with idle disposal (9.4); settings and password windows are created on demand and DESTROYED on close (never hidden); electron-log rotates at 5 MB x 3 files.

### Printing latency
- L1 (T1). Windows `system` transport uses a persistent PowerShell print host: `scripts/raw-print-host.ps1` is started lazily on the first job, reads ONE JSON command per line on stdin (`{ "id", "printerName", "filePath" }`), answers ONE JSON line per command on stdout (`{ "id", "ok", "code", "message" }`, codes as in 9.1), is re-used for all later jobs, respawned after a crash or a per-command timeout, shut down after 10 minutes idle, and the manager falls back to the one-shot `raw-print.ps1` when the host cannot start or does not answer its first job within 10 s. Printer names are JSON data, never code. Budget: overhead of the 2nd and later jobs < 150 ms excluding the printer; a fake-child-process test proves ONE spawn for 50 jobs.
- L2 (T2). DYMO: printer-list cache (30 s), template XML cache, no hidden-window re-creation per label.
- L3 (T1 queue.drain, INTEGRATE wiring). On `before-quit` wait up to 5 s for queued print jobs (`queue.drain(5000)`) so the last receipt is not lost.

### Native desktop behaviour
- D1 (T4b). Right-click context menu in the POS window: `src/main/windows/contextMenu.js` `buildContextMenuTemplate(params, { isDev })` and the `context-menu` hookup. Editable fields: Undo, Redo, Cut, Copy, Paste, Select all; text selection: Copy; links: Open link in browser (safe URLs only per isSafeExternalUrl), Copy link address; images: Copy image, Save image as...; Inspect element only when !isPackaged. English labels, standard accelerators.
- D2 (T4b menu, T3 config, INTEGRATE). View > Toggle full screen (F11 on Windows/Linux, Ctrl+Cmd+F on macOS), remembered in `window.fullScreen`; Settings > General "Start in full screen" (default off).
- D3 (T3 config, T5 UI, INTEGRATE). "Start GadgetsPOS when this computer starts" -> `app.setLoginItemSettings({ openAtLogin })` (Windows and macOS; hidden on Linux); config `startup.openAtLogin`.
- D4 (T4b, T5). Window title follows the page title with the fallback "GadgetsPOS"; Help > About opens Settings on the About tab (version, Electron and Chromium versions, config/log paths, startup details, Copy diagnostics).
- D5 (INTEGRATE). Graceful quit: drain the print queue (L3), dispose hidden windows and timers, flush logs.
- D6 (T4b, T5). Native look: `nativeTheme.themeSource = 'system'` for native dialogs, the platform application icon, no custom title bar (the native frame is the robust choice).

### Benchmark (PERF lens, using the INTEGRATE hooks)
`tests/perf/benchmark.js` (a plain node script, not a unit test) compares v1.6.1 (a temp copy from `git archive 14df69a` of the owner's Electron-app checkout, symlinked node_modules, its default URL patched to the benchmark server and macOS accessory policy added) with v2 under identical conditions: 5 cold starts each with a fresh `--user-data-dir`; time to first window, time to POS loaded, process-tree RSS after 30 s idle, idle CPU over 30 s, frames per second of a stress page (animated list plus scrolling) in each rendering mode, and print-job latency with fake printers (v1 handler with a stubbed exec versus the v2 ack path). Output `tests/perf/out/benchmark.json` plus a markdown table quoted by docs/PERFORMANCE.md. Harnesses must NOT steal focus on macOS: `app.setActivationPolicy('accessory')` and `showInactive()` for every window they open.

## 19. Definition of done

1. `node --test "tests/**/*.test.js"` green in the Electron worktree (the owner release gates are not part of it: `npm run release:check`, section 15); vendor tests for the touched areas green (including the existing golden receipt tests, 18); eslint clean on changed vendor files; `node --check` on every main-process file.
2. The golden harness proves v1 parity for all label designs, at the comparison level of section 16, except the listed intended differences (9.4 (a)-(e)).
3. The real app starts under Electron on this Mac against `tests/e2e/fake-pos.js`, shows the loading screen, the offline screen when the server is down (auto-reconnects when it returns), the settings window with printer lists from fakes, password flows with lockout, and every legacy + new IPC call returns the documented result.
4. Screenshots of every screen were produced and reviewed (no clipped text, no overflow, readable contrast).
5. No `exec(`/`execSync(`/`shell: true`/`eval(` anywhere under `src/`; no raw interpolation into scripts; `package.json` has only the three runtime deps; packaging manifest test green.
6. `docs/RELEASE.md` (build, sign, publish, update feed, what the owner must provide including the code-signing certificate and `build.win.publisherName`, that the first v2 install is a manual run of the installer because v1.x has no updater, the real-DYMO QR scan checklist of 9.4 when it applies, and a manual Windows upgrade checklist), `docs/SHOP-SETUP.md` (plain-language printer setup for shop staff: the accepted port formats of 9.1, the password recovery steps of 10, the `--disable-gpu` shortcut argument of 18b R1b) and `docs/PERFORMANCE.md` (what was optimised, the measured v1 versus v2 table, how to re-run the benchmark, the compatibility switches) exist. The manual Windows upgrade checklist cannot run in CI: install v1.6.1, configure a printer port and a drawer password, sign in to the POS, then run the v2 installer over it; expected: a single entry in Apps & features (also when the per-machine scope is chosen), the same userData folder, the user still signed in (same default session), the old port still prints receipts and Zebra labels, the old password opens the drawer, a DYMO label prints, and the offline screen shows when the network is unplugged.
7. Every item of section 18b is implemented, tested and listed; the benchmark (tests/perf/benchmark.js) ran for v1 and v2 under identical conditions and v2 meets the 18b budgets; the numbers are reported.
8. No Electron harness steals focus on macOS (accessory activation policy, `showInactive()`).

## 20. Amendments log

The review amendments (numbered 1-30 in the order the SPEC editor received them) were applied to the sections above. ACCEPTED = the substance is in the text; REJECTED = not applied as written (what is still adopted from it is named); "merged" = two amendments covered the same rule and became one. Amendment 30 arrived cut off (see its line). New sections are 6.3, 9.4a, 12b and this one; R1b was added in 18b instead of renumbering R2-R4.
Checked directly against the files while editing: electron-store 10.0.1 / conf 13.1.0 (defaults written at construction, `undefined`, `onDidChange`, file mode; reproduced under plain Node), electron-builder (`build` stripped from the packaged package.json), electron-updater 6.8.11 (`app-update.yml`, `quitAndInstall`, `publisherName`, `forceDevUpdateConfig`), the Electron 32.3.3 type definitions, the v1 sources (menu, window, preload, drawer, receipt handler, the whole DYMO dispatch, the `Text_was` templates) and the vendor worktree (BarcodeModal, BarcodePanelTab, cashDrawerForm, pos-card-items-bottom, SquareOAuthConnect, loadLib, labItemLabel, lib.js, window.open callers, receiptMoney, the two report files). Taken from the critics' own runs without re-running them here: the sandboxed-preload module list, `location.origin` in `about:blank` popups, `senderFrame.url` carrying the query string, and the pdfMake lines.

1. ACCEPTED (merged with 29) - 6.3 new, 3, 12: the main window uses only `app.js`, which on its `file:` pages (loading, offline) exposes just `window.desktop.connection` + `window.close`, so "Retry now", the countdown and "Printer settings" work offline; `local.js` stays for the settings and password windows.
2. ACCEPTED (merged with 26) - 5.2, 8: `createConfig` never passes `schemaVersion` (or any default) to the Store because conf writes defaults at construction; only `migrateLegacy()` writes it, deciding from the raw store.
3. ACCEPTED - 5.1, 10: `offTimeMs` default 255 -> 510 and `units(ms) = min(255, max(1, round(ms / 2)))`, so the default really is `1B 70 00 19 FF` (255 ms would give 0x80); fields accept 2..510 ms; byte tests added.
4. ACCEPTED - 8, 9.4: `buildLabelPlan` returns `{ plans }` only, no `repeats`; `prints` is never a copy count; a repair message prints one label per `orderItems` element and stops at the first failure with `details.printed/total` (v1 loop checked).
5. ACCEPTED - 9.4: input normalisation (`size` other than 25x25/70x54 is 32x57, `design` via `parseInt`, NaN design = the design-1 template of the size) and intended difference (e): v1 prints nothing for NaN design + sale (`Text_was` exists only in the `*_sale` templates, checked) and uses the 32x57 template at 70x54; the print parameters live only in that broken branch and are dropped. Editor correction: at 25x25 a NaN design stays v1's QR label (the amendment's wording would have changed it silently).
6. ACCEPTED - 9.4a new: which object each field comes from (outer `size`/`design`/`type`, lab `barcode`/`title`, the rest from `barcodefinal`), String() coercion, price/sale/warranty rules, repair fields, the 25x25 exception. Editor addition: an empty `orderItems` answers INVALID_PAYLOAD instead of silently printing nothing.
7. ACCEPTED - 9.4, 16, 19: designs 2 and 7 are reproduced as op kind `'qr-embed'` (v1 rewrites the XML and wraps `setObjectText`, checked); `_forceQRCodeUpdate` stays for design 4, repair and 25x25. Replacing it is a deviation that needs sign-off plus a real-DYMO scan (the amendment offered it as a free choice); the golden harness compares template, (object, text) pairs, QR pair and printer, not XML.
8. ACCEPTED - 18: `legacyLabelText` walks `barcodefinal` deeply and leaves non-strings and Zebra strings alone; a null/undefined `barcodefinal` returns INVALID_PAYLOAD with a plain message (`printBarcodes` returns undefined for other printer types, checked); `sendLabel` never invents a `currency`.
9. ACCEPTED - 18, 4: on a v1.x desktop `openCashDrawer` falls back to `sendReceiptData({ openCashDrawer:true })` and never calls `sendOpenDrawerCommand`, which v1's preload does not expose (checked); no util function throws for a missing bridge function.
10. ACCEPTED - 1 (item 8), 10: the web's drawer dialog is dead UI (its open state is never set, checked); the live route is the Open button, `sendReceiptData({ openCashDrawer:true, order:false })`, answered `{ ok:true, details:{ prompted:true } }`; receipt-embedded kick bytes (including the web's 7-byte `opencashdrawer()` buffer, checked) are sent verbatim and ignore the drawer settings; Settings says so in one line.
11. ACCEPTED - 12: `setWindowOpenHandler` returns `allow` with explicit secure options because openers need a real WindowProxy (pdfMake, `document.write` popups, named `pos-window`; vendor call sites checked), `deny` only for other URLs; the guards are installed on every webContents via `web-contents-created`; handler tests. Editor additions: `about:blank` only from a page on an allowed origin; the permission handlers stay on the session.
12. ACCEPTED - 12: provider hops: `NAVIGATION_ONLY_ORIGINS` (`*.squareup.com`, `*.squareupsandbox.com`) may be navigated to in the main frame so "Connect with Square" completes in the signed-in session (`window.location.assign`, checked; v1 had no guard); they never get `window.electron`, IPC trust or permissions; a one-line notice when a link goes to the system browser.
13. REJECTED (its idea and tests are adopted through 28) - 6.1: as written it makes the preload send `location.origin` to main, which is page-supplied data and the string `'null'` in the `about:blank` popups that section 12 allows; that contradicts amendment 28, which answers from `senderFrame.origin` in main and is the better evidenced of the two.
14. ACCEPTED - 12: payload validation covers only the fields the app reads; label text over 2 KB is truncated, not rejected; the whole `order`/`business`/`settings`/order-item objects of legacy payloads are never inspected (the Open button's real payload carries `business` and `settings`, checked).
15. ACCEPTED - 18, 16, 19: `handlePrint` in `OverAllReport.jsx` and `StockReports.jsx` stays a `const` arrow; `loadCategoryPrint` gets a `sendReceipt` stub so the golden receipt tests keep passing (the helper builds its scope from lib/thermalMoney/receiptMoney and a fake `window`, checked).
16. ACCEPTED - 18: no `size` from `BarcodeModal.jsx` (its selector holds PDF page sizes and shows only for non-DYMO, checked); `BarcodePanelTab.jsx` sends `size` only when it is 32x57, 70x54 or 25x25 (its state starts from the shared `labelSize` localStorage key, checked). Replaces the old "sends no size" bullet.
17. ACCEPTED - 5.1, 5.2, 6.2, 9.4, 9.5, 14: `printers.dymo.printerName` is separate from the raw-label `printers.label`; roles `receipt`/`label`/`dymo` for `savePrinter`/`testPrint`; two sections in the Label card (the `label_printer_type` choice is per user, the config is per PC).
18. ACCEPTED - 5.1, 5.2, 8, 10, 14: `hashPassword` hashes any non-empty string and the 4..64 policy moves to `validatePasswordPolicy` (set/change only); a migrated weak password keeps working with `drawer.passwordWeak`; recovery is deleting `config.json` (UI disclosure and SHOP-SETUP.md), with no in-app bypass, so the current-password rule and the throttle are unchanged.
19. ACCEPTED - 12b new, 3: application menu content (Open Drawer, View with Reload and handler-based zoom saved as `window.zoomLevel`, Settings tabs, Help, Quit), DevTools only in dev; v1's menu checked.
20. ACCEPTED - 18b: new R1b: native Help > Compatibility mode, a one-time native "Does the screen look right?" question after a v1 -> v2 migration, the `--disable-gpu` shortcut in SHOP-SETUP.md. Editor addition: the answer is stored as `gpuChecked` in flags.json.
21. ACCEPTED - 9.4: `currencySymbol` returns `£` for GBP or anything unusable and `<CODE> ` for every other code, the web's own rule for receipts and Zebra labels (`receiptMoney.js`, checked).
22. ACCEPTED - 18: multi-label loops: a Result with `ok === false` is one failed label and ends the loop; build errors keep continuing; `printLabItemLabels` keeps `{ printed, failed }` and its existing tests; Quick Add keeps its failure warning (`labItemLabel.js` contract checked).
23. ACCEPTED - 11.3, 18b R3, 8: mid-session loss is detected from `session.webRequest.onErrorOccurred` (a notification, no timer) and starts 'banner' mode probing; R3 reworded to match. Editor change: errors count for any allowed origin, not only the `serverUrl` origin (API calls go to other allowed hosts).
24. ACCEPTED - 11.1: first-run window size from the primary work area, maximized below 1400 px wide, saved bounds restored only when visible; fake `screen` test (v1's fixed 1600x900 checked).
25. ACCEPTED - 15, 19: manual Windows upgrade checklist for RELEASE.md and the `oneClick: true` fallback (v1 has no `nsis` block, checked).
26. ACCEPTED (merged with 2) - 5.2, 8, 16: `config.js` rules: Store built without `defaults` and with file mode 0600, deep default lookup, `undefined` -> delete, `onDidAnyChange`, in-memory snapshot, corrupt-file recovery, `config.v1-backup.json` without the password, legacy printer keys kept so a downgrade still prints; the fake Store must mimic conf's constructor.
27. ACCEPTED - 13, 8, 15, 19: the updater reads the feed from `resources/app-update.yml` (electron-builder strips `build`, checked), takes `autoUpdater` as an object or a lazy function, installs with `quitAndInstall(true, true)`, awaits its checks, and honours the env override only when unpackaged. Editor reconciliations: an unpackaged app is disabled unless the env var is set (the amendment's two rules conflicted), `init()` timing aligned with S1, and the Windows signature check needs `publisherName` (checked in `NsisUpdater.js`).
28. ACCEPTED (absorbs 13's tests) - 2, 6.1, 12: the preload holds no origin list and asks main (`app:origin-allowed`); main answers from `senderFrame.origin`, never `location.origin` or a URL protocol; `isAllowedOrigin` is false for `'null'`; the main frame is decided by `senderFrame.parent === null`; `desktop:*` senders are checked on the URL without query and hash.
29. ACCEPTED (merged with 1) - 6.3, 12: per-window area registry, locked-down local pages (CSP meta tag, no inline script or style attributes, `textContent` for query-string values), a test that the two copies of the `connection` block are identical. Editor addition: the settings window's areas also include `connection` (its Connection tab shows the status chip and "Reload POS"); `app:origin-allowed` is registered before the first window (S1).
30. ACCEPTED IN PART, NEEDS RE-CONFIRMATION - 9.1, 3, 8, 14, 16: the `port` transport validates the port with `classifyPort` (UNC share or DOS device only; devices opened as `\\.\NAME` existing-only; a bare non-device name such as `USB001` is refused instead of silently creating a file), and the `cmd.exe` fallback receives only a validated port and a bare generated file name with `cwd` set to the temp dir, because `cmd.exe` is a shell. This amendment arrived cut off mid-sentence (no evidence, no proposed text); its visible claims are correct on their own, so the fix text is the editor's. If the critic meant more, it still has to be sent. Consequence to confirm with the owner: a port that is a plain file path (a "hot folder") is refused; it never printed through the OS, and widening `classifyPort` needs the integration owner's sign-off.

### Second pass (2026-11-20)

The open findings of the verification wave, closed in the code with the smallest change each. One line per change; the tests are named in the section they belong to. Not changed on purpose: the loading-screen 0.75x budget (measured limit of the machine it ran on), the Electron version, the label and receipt output, the vendor worktree.

31. ACCEPTED - 14: UX-09 main-process half. The Settings window answers `will-prevent-unload` with "You have unsaved changes. Discard them and close?" ("Keep editing" default and Escape, "Discard changes" overrides the page); before this a Settings window with unsaved edits silently refused to close. `createSettingsWindow` takes the injected `dialog`; tests/windows/settings-unsaved.test.js, smoke scenario 8c.
32. ACCEPTED - 14, 18b D5: Quit, Restart ("Restart now", the GPU dialog) and closing the POS window with Settings open (Windows, Linux) close Settings first through `confirmClose`, so the one question is asked before anything is shut down and "Keep editing" cancels the quit and schedules no relaunch. Found with the real Electron: a child window is closed with its parent without asking, so the question alone could not keep it. tests/boot/boot.test.js, smoke scenario 20.
33. ACCEPTED - 10: SEC-02, password half. `MAX_CANDIDATE_LENGTH` = 4096: a longer candidate is a wrong password, counted by the throttle and never hashed; `validatePasswordPolicy` no longer walks a huge string. tests/password, tests/drawer/password.test.js, tests/verify/security-label-dos.test.js.
34. ACCEPTED - 10, 5.1, 8: the drawer lock survives a change of the system clock (monotonic deadline) and a restart (`drawer.lock`, remaining time plus the wall-clock moment, the longer reading after a clock moved back, a clock moved far forward may shorten it: documented). `createThrottle` takes `monotonic`, `load` and `save`; `bootstrap` takes `clock.monotonic`; `publicState()` hides the record. tests/password/throttle.test.js, tests/boot/boot.test.js, tests/verify/security-throttle.test.js.
35. ACCEPTED - 12: popups and system-browser opens are rate limited (`OPEN_LIMITS`: 3 per 10 s per webContents, 20 per minute overall), refusals logged once per burst with the host only. tests/security/open-limit.test.js, tests/verify/security-window-open.test.js.
36. ACCEPTED - 12, 14: a wildcard over a public suffix or a shared hosting domain is refused by Settings and ignored (and logged once) by `isAllowedOrigin` (`src/main/sharedSuffixes.js`); the Settings hint says "the sites under societyfiles.com". tests/security/shared-suffix.test.js, tests/verify/security-allowlist.test.js.
37. ACCEPTED - 12: the bare domain societyfiles.com is no longer trusted by default, exactly as 12 lists it (`*.societyfiles.com` only): `BUILT_IN_ORIGINS` carried the bare domain as well and tests/security/origins.test.js pinned it. The default server address (vendor.societyfiles.com) still loads. tests/security/origins.test.js, tests/verify/security-allowlist.test.js.
38. ACCEPTED - 15, 19: the four findings that need a network or a certificate (supported Electron, `build.win.publisherName`, fuses, lock file) plus the update feed address are OWNER RELEASE GATES: `npm run release:check` (tests/release), run first by `npm run dist` (`predist`), strict while any is open; out of `npm test`. tests/packaging/release-gates.test.js.
39. ACCEPTED - 15: `scripts/after-pack-fuses.js` (`build.afterPack`, `@electron/fuses` in devDependencies, not installed here) flips the fuses and fails the build when the package is missing; the file is excluded from the installer (`!scripts/after-pack-fuses.js`); `.gitignore` no longer lists package-lock.json. The Windows integrity fuse stays off with electron-builder 24 (it embeds the digest on macOS only).
40. ACCEPTED - 18b D1: "Copy link address" is not offered for `about:` links: Chromium reports a `javascript:` link as `about:blank#blocked`. DYMO window manager (9.4): a late rejection of `loadFile` resets only a window that is still loading. 18b D4: choosing the Settings tab that is already shown does not load the page again (a same-address load is a reload). The three todo tests became tests. R4 (Settings opening lists the printers and so starts the DYMO window) is left as it was: its fix means mounting the tabs lazily.
