'use strict';

/**
 * The text Settings > About > "Copy diagnostics" puts on the clipboard (SPEC 6.2 `copyDiagnostics`, 18b S3).
 *
 * It is written for a support person who has no access to the till: versions, folders, the printers and drawer settings, the
 * connection and update state, how the screen is rendered and the startup timings. It never contains a secret: the drawer
 * password is reported only as "set" or "not set" (never its hash), and the server address is cut to host and path (a query
 * string can carry a token).
 *
 * Pure: everything it needs is passed in.
 */

/** @param {unknown} url @returns {string} origin and path of an address, '' when it is not a URL */
function describeServer(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '';
  }
}

/** @param {unknown} printer `{ transport, printerName, port }` @returns {string} */
function describePrinter(printer) {
  const value = printer !== null && typeof printer === 'object' ? printer : {};
  if (value.transport === 'port') return value.port ? `port ${value.port}` : 'not set up';
  return value.printerName ? `"${value.printerName}"` : 'not set up';
}

/** @param {unknown} printer `{ printerName }` @returns {string} */
function describeDymo(printer) {
  const name = printer !== null && typeof printer === 'object' ? printer.printerName : '';
  return name ? `"${name}"` : 'automatic';
}

/** @param {unknown} value @returns {string} "on" or "off" */
function onOff(value) {
  return value ? 'on' : 'off';
}

/**
 * @param {object} info
 * @param {string} info.appName
 * @param {string} info.version
 * @param {string} info.platform
 * @param {string} info.arch
 * @param {string} [info.osRelease]
 * @param {{ electron?: string, chrome?: string, node?: string }} [info.versions]
 * @param {boolean} [info.packaged]
 * @param {{ userData?: string, configFile?: string, logsDir?: string }} [info.paths]
 * @param {object} info.config the settings as a window may see them (`config.publicState()`)
 * @param {boolean} [info.online]
 * @param {{ status?: string, version?: string, message?: string }} [info.update]
 * @param {{ hardwareAcceleration?: boolean, compatibilityReason?: string, startup?: { marks?: object, summary?: string } }} [info.performance]
 * @param {Date} [info.date]
 * @returns {string} plain text, one fact per line
 */
function buildDiagnostics(info) {
  const { config = {}, versions = {}, paths = {}, update = {}, performance = {} } = info;
  const drawer = config.drawer || {};
  const printers = config.printers || {};
  const extra = Array.isArray(config.extraAllowedOrigins) ? config.extraAllowedOrigins : [];
  const marks = performance.startup && performance.startup.marks ? performance.startup.marks : {};
  const markText = Object.entries(marks).map(([name, at]) => `${name} ${at} ms`).join(', ');

  const lines = [
    `${info.appName} ${info.version}${info.packaged === false ? ' (development build)' : ''}`,
    `Created: ${(info.date || new Date()).toISOString()}`,
    `System: ${info.platform} ${info.arch}${info.osRelease ? `, ${info.osRelease}` : ''}`,
    `Electron ${versions.electron || '?'}, Chromium ${versions.chrome || '?'}, Node ${versions.node || '?'}`,
    '',
    `Data folder: ${paths.userData || '?'}`,
    `Settings file: ${paths.configFile || '?'}`,
    `Logs folder: ${paths.logsDir || '?'}`,
    '',
    `Server: ${describeServer(config.serverUrl) || '?'}`,
    `Extra allowed domains: ${extra.length > 0 ? extra.join(', ') : 'none'}`,
    `Connection: ${info.online === false ? 'offline' : 'online'}`,
    `Updates: ${update.status || 'unknown'}${update.version ? ` (${update.version})` : ''}${update.message ? ` - ${update.message}` : ''}`,
    '',
    `Receipt printer: ${describePrinter(printers.receipt)}`,
    `Label printer: ${describePrinter(printers.label)}`,
    `DYMO printer: ${describeDymo(printers.dymo)}`,
    `Cash drawer: ${drawer.enabled === false ? 'off' : 'on'}, pin ${drawer.pin === 5 ? 5 : 2}, pulse ${drawer.onTimeMs ?? '?'}/${drawer.offTimeMs ?? '?'} ms, password ${drawer.passwordSet ? 'set' : 'not set'}${drawer.passwordWeak ? ' (older rules)' : ''}, ask for it before Settings ${onOff(drawer.requirePasswordForSettings)}`,
    '',
    `Hardware acceleration: ${performance.hardwareAcceleration === false ? `off (compatibility mode${performance.compatibilityReason ? `: ${performance.compatibilityReason}` : ''})` : 'on'}`,
    `Start with the computer: ${onOff(config.startup && config.startup.openAtLogin)}`,
    `Start in full screen: ${onOff(config.window && config.window.startFullScreen)}`,
    `Keep the computer awake: ${onOff(config.power ? config.power.keepAwake !== false : true)}`,
    '',
    `Startup: ${markText || 'not recorded'}`,
  ];
  const summary = performance.startup && performance.startup.summary;
  if (summary) lines.push(summary);
  return `${lines.join('\n')}\n`;
}

module.exports = { buildDiagnostics, describeServer };
