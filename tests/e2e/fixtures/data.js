'use strict';
/*
 * Sample data for the UI screenshot harness (not a unit test: the name must not end in .test.js).
 * Everything here is plain JSON, because the stub preload receives it through an ipc round trip.
 */

const SERVER = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';

/*
 * The connection controller at rest, exactly as src/main/connectivity.js reports it when nothing is retrying: `online: true` (it
 * only means "no outage is tracked") with no attempt, address or reason. The main process shows the offline page in this state
 * when it must NOT reload by itself (src/main/windows/main.js showOffline with autoRetry false): after three crashes within a
 * minute and for a server address that cannot be opened. RESTING_QUERY is what it puts in the page address in those two cases.
 */
const AT_REST = { online: true, attempt: 0, nextRetryInMs: null, lastError: null, url: null, reason: null };
const RESTING_QUERY = {
  loop: { reason: 'crashed', code: 'crashed', desc: 'The page keeps stopping. Choose View > Reload, or close GadgetsPOS and open it again.', url: SERVER },
  address: { reason: 'other', code: 'INVALID_URL', desc: 'The server address is not valid. Open Settings > Connection and check it.', url: 'ftp://nonsense/vendor' },
};
/** The snapshot of a successful probe after four attempts: url stays, reason and lastError are cleared. */
const RECOVERED = { online: true, attempt: 4, nextRetryInMs: null, lastError: null, url: SERVER, reason: null };

/** Typical Windows PC of a phone shop: ten installed printers, one default, one offline. */
const SYSTEM_PRINTERS = [
  { name: 'EPSON TM-T20III Receipt', displayName: 'EPSON TM-T20III Receipt', isDefault: true, status: 'Ready' },
  { name: 'ZDesigner ZD420-203dpi ZPL', displayName: 'ZDesigner ZD420-203dpi ZPL', isDefault: false, status: 'Ready' },
  { name: 'DYMO LabelWriter 450 Turbo', displayName: 'DYMO LabelWriter 450 Turbo', isDefault: false, status: 'Ready' },
  { name: 'Star TSP143III (STR_T-001)', displayName: 'Star TSP143III (STR_T-001)', isDefault: false, status: 'Ready' },
  { name: 'Brother HL-L2350DW series', displayName: 'Brother HL-L2350DW series', isDefault: false, status: 'Offline' },
  { name: 'HP LaserJet Pro M404dn (Back office)', displayName: 'HP LaserJet Pro M404dn (Back office)', isDefault: false, status: 'Ready' },
  { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: false, status: 'Ready' },
  { name: 'Microsoft XPS Document Writer', displayName: 'Microsoft XPS Document Writer', isDefault: false, status: 'Ready' },
  { name: 'OneNote (Desktop)', displayName: 'OneNote (Desktop)', isDefault: false, status: 'Ready' },
  { name: 'Fax', displayName: 'Fax', isDefault: false, status: 'Paused' },
];

const FEW_PRINTERS = SYSTEM_PRINTERS.slice(0, 4);

const DYMO_PRINTERS = [
  { name: 'DYMO LabelWriter 450 Turbo', modelName: 'LabelWriter 450 Turbo', isConnected: true },
  { name: 'DYMO LabelWriter 550', modelName: 'LabelWriter 550', isConnected: false },
];

const DYMO_DOWN = 'DYMO Connect is not running. Open DYMO Connect and make sure the printer is switched on.';

const PATHS = {
  userData: 'C:\\Users\\Shop\\AppData\\Roaming\\Gadgets POS',
  configFile: 'C:\\Users\\Shop\\AppData\\Roaming\\Gadgets POS\\config.json',
  logsDir: 'C:\\Users\\Shop\\AppData\\Roaming\\Gadgets POS\\logs',
};

const VERSIONS = { electron: '32.3.3', chrome: '128.0.6613.186', node: '20.18.1' };

const STARTUP = {
  marks: {
    'process-start': 0,
    'app-ready': 318,
    'window-created': 341,
    'loading-visible': 402,
    'config-ready': 455,
    'services-ready': 538,
    'pos-dom-ready': 1620,
    'pos-loaded': 2380,
  },
  summary: 'Loading screen in 402 ms. POS ready in 2.4 s.',
};

function configEmpty() {
  return {
    serverUrl: SERVER,
    extraAllowedOrigins: [],
    printers: {
      receipt: { transport: 'system', printerName: '', port: '' },
      label: { transport: 'system', printerName: '', port: '' },
      dymo: { printerName: '' },
    },
    drawer: { enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 510, passwordSet: false, passwordWeak: false, requirePasswordForSettings: false },
    window: { startFullScreen: false },
    updates: { autoDownload: true },
    startup: { openAtLogin: false },
    power: { keepAwake: true },
  };
}

function configPopulated() {
  const c = configEmpty();
  c.extraAllowedOrigins = ['https://shop.example.com', '*.partner-pos.co.uk'];
  c.printers.receipt = { transport: 'system', printerName: 'EPSON TM-T20III Receipt', port: '' };
  c.printers.label = { transport: 'system', printerName: 'ZDesigner ZD420-203dpi ZPL', port: '' };
  c.drawer.passwordSet = true;
  c.startup.openAtLogin = true;
  return c;
}

/** Builds a full getState() payload. `over` is shallow-merged at the top level, `config` deep-merged one level. */
function stateOf(over = {}) {
  const base = {
    config: configPopulated(),
    platform: 'win32',
    version: '2.0.0',
    online: true,
    update: { status: 'none' },
    performance: { hardwareAcceleration: true, compatibilityReason: '', startup: STARTUP },
    paths: PATHS,
    versions: VERSIONS,
  };
  const out = { ...base, ...over };
  if (over.config) out.config = { ...base.config, ...over.config };
  return out;
}

module.exports = { SERVER, AT_REST, RESTING_QUERY, RECOVERED, SYSTEM_PRINTERS, FEW_PRINTERS, DYMO_PRINTERS, DYMO_DOWN, PATHS, VERSIONS, STARTUP, configEmpty, configPopulated, stateOf };
