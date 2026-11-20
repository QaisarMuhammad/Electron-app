'use strict';

/**
 * Application menu (SPEC 12b, 18b D2/D4/R1b).
 *
 * `buildMenuTemplate` is pure: it returns the Electron template and runs nothing. Every click calls one injected
 * handler, so the menu knows nothing about windows, printers or config and is tested with plain functions.
 *
 * Windows and Linux, top level in this order (as in v1 the first and last entries are plain buttons, so their labels
 * carry the shortcut, which a menu bar does not display):
 *   Open Drawer (Ctrl+D) | View | Settings | Help | Quit
 * macOS cannot show a clickable entry in the menu bar, so it gets the standard layout instead:
 *   GadgetsPOS (About, Settings, Services, Hide..., Quit) | File (Open Drawer) | Edit | View | Settings | Window | Help
 * The Edit menu is required there: macOS only routes Cmd+C / Cmd+V to a web page through it.
 *
 * Zoom, reload and full screen go through the handlers, not the built-in roles, because the controller saves the zoom
 * level and the full-screen state. "Toggle Developer Tools" exists only when `isDev` (SPEC 12).
 */

const APP_NAME = 'GadgetsPOS';

/** Settings tabs that have their own menu entry (the About tab is reached through Help > About). */
const MENU_SETTINGS_TABS = Object.freeze([
  Object.freeze({ id: 'printers', label: 'Printers' }),
  Object.freeze({ id: 'drawer', label: 'Cash drawer' }),
  Object.freeze({ id: 'connection', label: 'Connection' }),
  Object.freeze({ id: 'general', label: 'General' }),
]);

/** Handlers every menu needs. `toggleDevTools` is added to the list when `isDev`. */
const REQUIRED_HANDLERS = Object.freeze([
  'openDrawer',
  'reload',
  'forceReload',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'toggleFullScreen',
  'openSettings',
  'about',
  'checkForUpdates',
  'openLogsFolder',
  'copyDiagnostics',
  'setCompatibilityMode',
  'quit',
]);

/** A fresh object every time: Electron reads a template entry, but a shared instance invites accidents. */
const separator = () => ({ type: 'separator' });

/**
 * @typedef {Object} MenuHandlers
 * @property {() => void} openDrawer           Opens the cash drawer password window.
 * @property {() => void} reload               Reloads the POS page (or loads it when an offline screen is showing).
 * @property {() => void} forceReload          Reloads ignoring the cache.
 * @property {() => void} zoomIn
 * @property {() => void} zoomOut
 * @property {() => void} resetZoom
 * @property {() => void} toggleFullScreen
 * @property {(tab?: string) => void} openSettings  Opens the single Settings window, on a tab when one is given.
 * @property {() => void} about                Opens Settings on the About tab.
 * @property {() => void} checkForUpdates
 * @property {() => void} openLogsFolder
 * @property {() => void} copyDiagnostics
 * @property {(enabled: boolean) => void} setCompatibilityMode  Writes the manual software-rendering flag (18b R1b).
 * @property {() => void} quit                 Graceful quit (18b D5).
 * @property {() => void} [toggleDevTools]     Required only when `isDev`.
 */

/**
 * Fails early, with every missing name at once, when the integrator forgot a handler.
 * @param {MenuHandlers} handlers
 * @param {boolean} isDev
 */
function assertHandlers(handlers, isDev) {
  const needed = isDev ? [...REQUIRED_HANDLERS, 'toggleDevTools'] : REQUIRED_HANDLERS;
  const missing = needed.filter((name) => !handlers || typeof handlers[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`buildMenuTemplate is missing handlers: ${missing.join(', ')}`);
  }
}

/**
 * The View menu: reload, zoom, full screen and (development only) the developer tools.
 * The two hidden entries add the second shortcut people expect (F5 and Ctrl+=) without showing a duplicate line.
 * @param {{ isMac: boolean, isDev: boolean, handlers: MenuHandlers }} options
 */
function viewMenu({ isMac, isDev, handlers }) {
  const submenu = [
    { id: 'view.reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => handlers.reload() },
    { id: 'view.reload-f5', label: 'Reload', accelerator: 'F5', visible: false, click: () => handlers.reload() },
    { id: 'view.force-reload', label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => handlers.forceReload() },
    separator(),
    { id: 'view.zoom-in', label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => handlers.zoomIn() },
    { id: 'view.zoom-in-equals', label: 'Zoom in', accelerator: 'CmdOrCtrl+=', visible: false, click: () => handlers.zoomIn() },
    { id: 'view.zoom-out', label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => handlers.zoomOut() },
    { id: 'view.zoom-reset', label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => handlers.resetZoom() },
    separator(),
    {
      id: 'view.full-screen',
      label: 'Toggle full screen',
      accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
      click: () => handlers.toggleFullScreen(),
    },
  ];
  if (isDev) {
    submenu.push(separator(), {
      id: 'view.devtools',
      label: 'Toggle Developer Tools',
      accelerator: 'CmdOrCtrl+Shift+I',
      click: () => handlers.toggleDevTools(),
    });
  }
  return { id: 'view', label: 'View', submenu };
}

/**
 * The Help menu. The Compatibility mode checkbox is native on purpose (18b R1b): it must stay reachable when the web
 * rendering of the app itself is broken.
 * @param {{ handlers: MenuHandlers, compatibilityMode: boolean }} options
 */
function helpMenu({ handlers, compatibilityMode }) {
  return {
    id: 'help',
    label: 'Help',
    submenu: [
      { id: 'help.updates', label: 'Check for updates\u2026', click: () => handlers.checkForUpdates() },
      separator(),
      { id: 'help.logs', label: 'Open logs folder', click: () => handlers.openLogsFolder() },
      { id: 'help.diagnostics', label: 'Copy diagnostics', click: () => handlers.copyDiagnostics() },
      separator(),
      {
        id: 'help.compatibility',
        label: 'Compatibility mode',
        type: 'checkbox',
        checked: Boolean(compatibilityMode),
        click: (menuItem) => handlers.setCompatibilityMode(Boolean(menuItem && menuItem.checked)),
      },
      separator(),
      { id: 'help.about', label: `About ${APP_NAME}`, click: () => handlers.about() },
    ],
  };
}

/**
 * Builds the application menu template.
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {boolean} [options.isDev=false]          Adds Toggle Developer Tools. Never true in a packaged app without --devtools.
 * @param {MenuHandlers} options.handlers
 * @param {boolean} [options.compatibilityMode=false]  Initial state of Help > Compatibility mode.
 * @returns {object[]} A template for `Menu.buildFromTemplate`.
 */
function buildMenuTemplate({ platform, isDev = false, handlers, compatibilityMode = false }) {
  assertHandlers(handlers, isDev);
  const isMac = platform === 'darwin';

  const settingsEntry = {
    id: 'settings.open',
    label: 'Printer and Settings\u2026',
    accelerator: 'CmdOrCtrl+,',
    click: () => handlers.openSettings(),
  };
  const tabEntries = MENU_SETTINGS_TABS.map((tab) => ({
    id: `settings.${tab.id}`,
    label: tab.label,
    click: () => handlers.openSettings(tab.id),
  }));
  // On macOS the shortcut belongs to the app menu, so the Settings menu lists only the tabs there.
  const settingsMenu = {
    id: 'settings',
    label: 'Settings',
    submenu: isMac ? tabEntries : [settingsEntry, separator(), ...tabEntries],
  };

  const view = viewMenu({ isMac, isDev, handlers });
  const help = helpMenu({ handlers, compatibilityMode });

  if (isMac) {
    return [
      {
        id: 'app',
        label: APP_NAME,
        submenu: [
          { id: 'app.about', label: `About ${APP_NAME}`, click: () => handlers.about() },
          separator(),
          settingsEntry,
          separator(),
          { role: 'services' },
          separator(),
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          separator(),
          { id: 'app.quit', label: `Quit ${APP_NAME}`, accelerator: 'CmdOrCtrl+Q', click: () => handlers.quit() },
        ],
      },
      {
        id: 'file',
        label: 'File',
        submenu: [{ id: 'drawer', label: 'Open Drawer', accelerator: 'CmdOrCtrl+D', click: () => handlers.openDrawer() }],
      },
      { role: 'editMenu' },
      view,
      settingsMenu,
      { role: 'windowMenu' },
      help,
    ];
  }

  return [
    { id: 'drawer', label: 'Open Drawer (Ctrl+D)', accelerator: 'CmdOrCtrl+D', click: () => handlers.openDrawer() },
    view,
    settingsMenu,
    help,
    { id: 'quit', label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => handlers.quit() },
  ];
}

/**
 * Builds the native menu object for `Menu.setApplicationMenu`.
 * Developer tools are offered only when the app is not packaged or was started with `--devtools` (SPEC 12).
 * @param {object} options
 * @param {{ isPackaged?: boolean }} [options.app]
 * @param {typeof Electron.Menu} options.Menu
 * @param {MenuHandlers} options.handlers
 * @param {boolean} [options.isPackaged]           Overrides `app.isPackaged`.
 * @param {NodeJS.Platform} [options.platform=process.platform]
 * @param {string[]} [options.argv=process.argv]   Searched for `--devtools`.
 * @param {boolean} [options.compatibilityMode=false]
 * @returns {Electron.Menu}
 */
function buildMenu({ app, Menu, handlers, isPackaged, platform = process.platform, argv = process.argv, compatibilityMode = false }) {
  const packaged = typeof isPackaged === 'boolean' ? isPackaged : Boolean(app && app.isPackaged);
  const isDev = !packaged || (Array.isArray(argv) && argv.includes('--devtools'));
  return Menu.buildFromTemplate(buildMenuTemplate({ platform, isDev, handlers, compatibilityMode }));
}

module.exports = { buildMenuTemplate, buildMenu, MENU_SETTINGS_TABS, REQUIRED_HANDLERS, APP_NAME };
