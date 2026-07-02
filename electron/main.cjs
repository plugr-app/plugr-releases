// Electron main process for Plugr.
//
// Responsibilities:
//   - Create the main BrowserWindow and load the React renderer.
//   - Expose IPC endpoints (scan library, check updates, open in Finder, etc).
//   - All filesystem and network work happens here, never in the renderer.

const { app, BrowserWindow, ipcMain, shell, Menu, Tray, dialog, protocol, net, nativeImage, Notification } = require('electron');
const path = require('node:path');

// Register a privileged custom protocol for streaming local audio
// files into the renderer's <audio> elements. The renderer can't
// load file:// URLs directly (CSP / Electron security default), so
// we expose this protocol that maps plugr-file://<absolute-path> to
// a streamed file response. This MUST run before app.whenReady() —
// privileged-scheme registration only takes effect at startup.
//
// Privileges:
//   - secure:        treat plugr-file:// as an https-equivalent secure context
//   - standard:      parse URLs the standard way (host + path)
//   - stream:        allow streamed responses (audio scrubbing / seeking)
//   - bypassCSP:     skip the renderer's Content-Security-Policy block
//   - supportFetchAPI: let renderer-side fetch() / <audio> use it
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plugr-file',
    privileges: { secure: true, standard: true, stream: true, bypassCSP: true, supportFetchAPI: true },
  },
]);
const { scanLibrary } = require('./lib/scanners.cjs');
const { checkUpdatesForItems } = require('./lib/updateChecker.cjs');
const { loadCache, saveCache, clearCache, cacheFilePath } = require('./lib/cache.cjs');
const {
  loadProjectStore,
  patchProjectStore,
  projectStorePath,
  migrateFromLegacyCache,
} = require('./lib/projectStore.cjs');
const { discoverUpdateSource, deriveRegexFromVersion, deriveUrlTemplate, applyUrlTemplate, fetchText, stripHtml, findVersionInTextLoose, nameToSlugCandidates, nameVariants } = require('./lib/discoverUpdateSource.cjs');
const { cleanUrl } = require('./lib/httpFetch.cjs');
const community = require('./lib/community.cjs');
const supportConfig = require('./lib/supportConfig.cjs');
const priceHistory = require('./lib/priceHistory.cjs');
const exchangeRates = require('./lib/exchangeRates.cjs');
const dealsFetcher = require('./lib/dealsFetcher.cjs');
const { parseAbletonProject } = require('./lib/projectScanners/ableton.cjs');
const { parseFlStudioProject } = require('./lib/projectScanners/flstudio.cjs');
const { parseLogicProject } = require('./lib/projectScanners/logic.cjs');
const {
  buildBackup,
  summarizeBackup,
  applyBackup,
  writeBackupFile,
  readBackupFile,
} = require('./lib/backup.cjs');

// Release infrastructure — auto-updates + licensing + trial + entitlements.
// These run in production builds; trial + entitlements run in dev too so
// we can exercise the UI flows. Auto-update is dev-disabled inside its
// own init().
const autoUpdater   = require('./lib/autoUpdater.cjs');
const dealAlerts  = require('./lib/dealAlerts.cjs');
const trialModule   = require('./lib/trial.cjs');
const licenseModule = require('./lib/license.cjs');
const entitlements  = require('./lib/entitlements.cjs');

// File-extension to parser map. New DAW parsers slot in here.
//   - .als → Ableton Live set (gzipped XML)
//   - .alp → Ableton Live pack (also XML, same parser handles it)
//   - .flp → FL Studio project (chunked binary)
//   - .logicx → Logic Pro project (macOS bundle, treated as a single
//              "project file" even though it's a directory on disk)
const PROJECT_PARSERS = {
  '.als':    { dawType: 'ableton',  parse: parseAbletonProject },
  '.alp':    { dawType: 'ableton',  parse: parseAbletonProject },
  '.flp':    { dawType: 'flstudio', parse: parseFlStudioProject },
  '.logicx': { dawType: 'logic',    parse: parseLogicProject },
};

const PROJECT_EXTS = Object.keys(PROJECT_PARSERS);

// Folders to skip while walking project trees — they bloat the scan and
// never contain user-authored projects.
const PROJECT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'Backup', 'Backups',         // Ableton/Logic autosave backups
  'Bounces', 'Recorded',       // user-content folders rarely contain project files
  '.DS_Store',
]);

// Resolved-data-directory cache. The actual path depends on whether
// the user has iCloud sync turned on (sync-prefs.json lives in the
// always-local anchor dir and tells us where the main cache + project
// files live). We resolve it once on boot — and on every sync toggle
// — into this module-level variable so userDataDir() stays sync.
const fspEarly = require('node:fs/promises');
const {
  anchorDir, iCloudPlugrDir, iCloudAvailable,
  loadSyncPrefs, saveSyncPrefs,
} = require('./lib/syncPrefs.cjs');
let _currentDataDir = anchorDir();
async function refreshDataDir() {
  const prefs = await loadSyncPrefs();
  if (prefs.iCloudSync && iCloudAvailable()) {
    const target = iCloudPlugrDir();
    try { await fspEarly.mkdir(target, { recursive: true }); } catch { /* tolerate */ }
    _currentDataDir = target;
  } else {
    _currentDataDir = anchorDir();
  }
  return _currentDataDir;
}
function userDataDir() { return _currentDataDir; }

/**
 * Save a partial cache patch on top of whatever's already saved. Avoids the
 * trap of having to re-list every cache field at every call site whenever
 * the schema grows.
 */
// Serializes all cache writes through one promise chain. Without
// this, two patchCache() calls firing in quick succession (e.g. a
// project drop and a sort-pref change at the same time) would
// read-modify-write the cache concurrently and the later writer
// could lose the earlier writer's changes.
let cacheWriteChain = Promise.resolve();

async function patchCache(patch) {
  // Chain onto the previous write so they're guaranteed serial.
  const result = cacheWriteChain.then(async () => {
    const existing = (await loadCache(userDataDir())) || {};
    const merged = {
      library: existing.library || null,
      updates: existing.updates || {},
      updatesCheckedAt: existing.updatesCheckedAt || null,
      userOverrides: existing.userOverrides || {},
      userRegistryAdditions: existing.userRegistryAdditions || {},
      tutorialDismissed: existing.tutorialDismissed || false,
      themePreference: existing.themePreference || 'auto',
      categorySort: existing.categorySort || 'count',
      developerSort: existing.developerSort || 'count',
      formatSort: existing.formatSort || 'count',
      customFolders: existing.customFolders || [],
      columnWidths: existing.columnWidths || null,
      compatFilter: existing.compatFilter || 'all',
      userDeveloperCompanions: existing.userDeveloperCompanions || {},
      userCategories: existing.userCategories || {},
      sidebarSectionOrder: existing.sidebarSectionOrder || null,
      sortBy: existing.sortBy || null,
      sortDir: existing.sortDir || null,
      view: existing.view || null,
      communityShareConsent: existing.communityShareConsent || 'unknown',
      communityAdditions: existing.communityAdditions || null,
      // *** Project-scanning fields ***
      // These were missing from the preserve-list, so every cache
      // write triggered by something else (sort change, theme
      // change, library scan, plugin override, etc.) silently
      // wiped them — that's why projects disappeared on restart.
      projectLibrary: existing.projectLibrary || null,
      projectTags: existing.projectTags || {},
      projectNotes: existing.projectNotes || {},
      projectBounceOverrides: existing.projectBounceOverrides || {},
      projectRatings: existing.projectRatings || {},
      appView: existing.appView || null,
      // Global bounce playback volume (0..1). Missing from this
      // preserve-list meant any unrelated cache write (sort change,
      // theme switch, plugin override) silently reset the volume.
      // Same shape of bug as the project-fields issue above; same fix.
      audioVolume: typeof existing.audioVolume === 'number' ? existing.audioVolume : 0.8,
      // Plugin-deal feed cache. Survives unrelated writes so the
      // Deals tab opens instantly even after the user changes other
      // settings between deal fetches.
      deals: existing.deals || null,
      // User's saved/wishlisted deals — preserve across unrelated cache
      // writes so they don't get clobbered by a settings change.
      savedDeals: existing.savedDeals || {},
      // Outbound deal click counts — same preservation reasoning.
      clickCounts: existing.clickCounts || {},
      // Per-deal price history — collected data, never overwritten by
      // unrelated cache writes.
      priceHistory: existing.priceHistory || {},
      // User-dismissed deals — same preservation reasoning as the
      // other top-level user data fields.
      dismissedDeals: existing.dismissedDeals || {},
      // Currency preference + cached exchange rates — preserve so
      // unrelated cache writes don't reset to defaults.
      currencyPref: existing.currencyPref || 'USD',
      exchangeRates: existing.exchangeRates || null,
      // *** Newer fields — same pattern as project-fields fix above. ***
      // Missing any of these from this preserve-list would silently
      // wipe them on every unrelated cache write (theme change, sort
      // change, deal fetch, etc.). Each new top-level cache field
      // MUST be added here AND in saveCache's schema.
      projectStatuses: existing.projectStatuses || {},
      projectKeyOverrides: existing.projectKeyOverrides || {},
      customStatuses: Array.isArray(existing.customStatuses) ? existing.customStatuses : [],
      defaultTab: existing.defaultTab || 'library',
      // Deal alerts — preserve across unrelated cache writes so adding
      // a second alert (or any other cache write between adds) doesn't
      // wipe the first.
      dealAlerts: Array.isArray(existing.dealAlerts) ? existing.dealAlerts : [],
      // Timestamp of the last time the user opened the Deals tab. Used
      // to compute the "N new" badge on the TabBar. Lives outside
      // dealAlerts because resetting the badge shouldn't churn alerts.
      dealsLastViewedAt: typeof existing.dealsLastViewedAt === 'string' ? existing.dealsLastViewedAt : null,
      // Background-app preferences. Defaults to false so closing the
      // window quits Plugr (familiar behavior) and Plugr doesn't
      // auto-launch at login unless the user opts in.
      runInMenuBar:  typeof existing.runInMenuBar === 'boolean' ? existing.runInMenuBar : false,
      launchAtLogin: typeof existing.launchAtLogin === 'boolean' ? existing.launchAtLogin : false,
      // User-hidden tab ids (paid+trial feature). See cache.cjs comment
      // for why we preserve the list even when the entitlement isn't
      // active — re-upgrading should restore the prior layout.
      hiddenTabs:    Array.isArray(existing.hiddenTabs) ? existing.hiddenTabs : [],
      ...patch,
    };
    await saveCache(userDataDir(), merged);
    return merged;
  });
  // Always update the chain even on rejection so subsequent writes
  // don't stall, but swallow the error on the chain itself.
  cacheWriteChain = result.catch(() => {});
  return result;
}

const isDev = !app.isPackaged;

let mainWindow = null;

// ---------- Background / tray state ----------
// Plugr can optionally run as a menu-bar app: the user opts in via
// Preferences → "Run in menu bar". When enabled:
//   1. A Tray icon is created in the macOS menu bar.
//   2. Closing the window hides it instead of quitting.
//   3. Deal-alert notifications keep firing while the window is closed.
//
// `isQuitting` distinguishes "user clicked the close button" (which we
// intercept to hide-to-tray) from "user picked Quit Plugr" (which is
// a real quit). Without this flag, command+Q wouldn't actually quit
// when runInMenuBar is on.
let tray = null;
let isQuitting = false;
let backgroundPrefs = { runInMenuBar: false, launchAtLogin: false };

// Apply login-item registration. macOS-only — Windows/Linux fall back
// to silently no-op'ing since Plugr is mac-first today. Wrapping in a
// helper keeps the conditional out of every callsite.
function applyLoginItem(launchAtLogin) {
  if (process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!launchAtLogin });
  } catch (err) {
    console.warn('[login-item] setLoginItemSettings failed:', err.message);
  }
}

function showOrCreateWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// Build a static fallback tray menu (used when cache load fails).
function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Plugr', click: showOrCreateWindow },
    { label: 'My Deal Alerts…', click: () => {
        showOrCreateWindow();
        sendToRenderer('menu:openAlerts');
      } },
    { type: 'separator' },
    { label: 'Quit Plugr', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

// Build and pop up a dynamic tray menu that lists available software
// updates (plugins + apps) — similar to how MacUpdater surfaces them
// in its menu-bar icon. Loads the latest cache on every call so the
// list is always fresh without requiring a re-scan first.
async function showTrayUpdateMenu() {
  try {
    const data   = (await loadCache(userDataDir())) || {};
    const items  = (data.library && Array.isArray(data.library.items)) ? data.library.items : [];
    const updates = data.updates || {};

    // Collect outdated entries, sorted by name.
    const outdated = items
      .filter((it) => updates[it.id] && updates[it.id].status === 'outdated')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const MAX_VISIBLE = 18;
    const template = [];

    if (outdated.length === 0) {
      template.push({ label: 'All plugins up to date ✓', enabled: false });
    } else {
      template.push({
        label: `${outdated.length} update${outdated.length === 1 ? '' : 's'} available`,
        enabled: false,
      });
      template.push({ type: 'separator' });

      for (const it of outdated.slice(0, MAX_VISIBLE)) {
        const upd     = updates[it.id];
        const from    = it.version || '?';
        const to      = upd.latestVersion || '?';
        const arrow   = `${from} → ${to}`;
        // Show format tag for plugins that have multiple formats
        // (AU, VST3, AAX…) so the user can tell them apart.
        const fmtTag  = it.format ? ` [${it.format}]` : '';
        template.push({
          label: `${it.name || it.identifier || 'Unknown'}${fmtTag}  ${arrow}`,
          click: showOrCreateWindow,
        });
      }

      if (outdated.length > MAX_VISIBLE) {
        template.push({
          label: `  +${outdated.length - MAX_VISIBLE} more…`,
          click: showOrCreateWindow,
          enabled: true,
        });
      }
    }

    template.push({ type: 'separator' });
    template.push({ label: 'Open Plugr', click: showOrCreateWindow });
    template.push({
      label: 'My Deal Alerts…',
      click: () => { showOrCreateWindow(); sendToRenderer('menu:openAlerts'); },
    });
    template.push({ type: 'separator' });
    template.push({ label: 'Quit Plugr', click: () => { isQuitting = true; app.quit(); } });

    if (tray) tray.popUpContextMenu(Menu.buildFromTemplate(template));
  } catch (err) {
    console.warn('[tray] update menu failed:', err.message);
    if (tray) tray.popUpContextMenu(buildTrayContextMenu());
  }
}

function createTray() {
  if (tray) return tray;
  try {
    // Tray icon: prefer a dedicated 16x16 template asset (which macOS
    // tints automatically to match the menu bar). Fall back to the
    // bundled .icns if the template asset isn't shipped yet — looks a
    // little hot but works. Last-ditch fallback is an empty image so
    // we at least get a click target labeled "Plugr".
    const fs = require('fs');
    const candidates = [
      path.join(__dirname, '..', 'assets', 'plugr-tray-Template.png'),
      path.join(__dirname, '..', 'assets', 'plugr-tray.png'),
      path.join(__dirname, '..', 'build', 'icon.icns'),
    ];
    let icon = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        icon = nativeImage.createFromPath(p);
        if (icon && !icon.isEmpty()) break;
      }
    }
    if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
    // Template image: macOS will tint white/black to match the menu
    // bar appearance (dark mode vs light mode). Only applies on mac.
    if (process.platform === 'darwin' && typeof icon.setTemplateImage === 'function') {
      icon.setTemplateImage(true);
    }
    tray = new Tray(icon);
    tray.setToolTip('Plugr');
    // No static context menu — both left- and right-click build a
    // fresh menu from the cache so the update list is always current.
    // setContextMenu(null) prevents Electron from auto-showing a stale
    // menu on right-click before our async handler fires.
    tray.setContextMenu(null);
    tray.on('click',       () => showTrayUpdateMenu());
    tray.on('right-click', () => showTrayUpdateMenu());
  } catch (err) {
    console.warn('[tray] create failed:', err.message);
    tray = null;
  }
  return tray;
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch { /* tolerate */ }
  tray = null;
}

// Apply (or re-apply) background-mode + login-item prefs. Idempotent:
// safe to call multiple times. Called on boot from persisted prefs
// and on every user toggle from the renderer.
function applyBackgroundMode({ runInMenuBar, launchAtLogin }) {
  backgroundPrefs = {
    runInMenuBar:  !!runInMenuBar,
    launchAtLogin: !!launchAtLogin,
  };
  if (backgroundPrefs.runInMenuBar) createTray();
  else destroyTray();
  applyLoginItem(backgroundPrefs.launchAtLogin);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e0f12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Intercept the close button when the user has opted into menu-bar
  // mode. Without this, clicking the red traffic light would kill the
  // background process and stop deal-alert notifications — which is
  // exactly the opposite of what "Run in menu bar" implies.
  //
  // `isQuitting` is the escape hatch: command+Q / app.quit() / picking
  // "Quit Plugr" from the tray all set it, so a real quit still works.
  mainWindow.on('close', (event) => {
    if (backgroundPrefs.runInMenuBar && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Plugr Updates…', accelerator: 'CmdOrCtrl+U', click: () => sendToRenderer('menu:checkUpdates') },
        { type: 'separator' },
        { label: 'My Deal Alerts…', click: () => sendToRenderer('menu:openAlerts') },
        { type: 'separator' },
        { label: 'Show Tutorial…', click: () => sendToRenderer('menu:showTutorial') },
        { label: 'Help', accelerator: 'Cmd+,', click: () => sendToRenderer('menu:showHelp') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Library',
      submenu: [
        { label: 'Scan Library', accelerator: 'CmdOrCtrl+R', click: () => sendToRenderer('menu:scan') },
        { type: 'separator' },
        { label: 'Scan DAW Projects…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToRenderer('menu:scanProjects') },
        { type: 'separator' },
        { label: 'Open Companion Apps…', click: () => sendToRenderer('menu:openCompanionApps') },
        { type: 'separator' },
        { label: 'Export Library as CSV…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendToRenderer('menu:exportCsv') },
        { label: 'Export Backup…', click: () => sendToRenderer('menu:exportBackup') },
        { label: 'Import Backup…', click: () => sendToRenderer('menu:importBackup') },
        { type: 'separator' },
        { label: 'Reveal Registry File in Finder', click: () => ipcMain.emit && shell.showItemInFolder(path.join(__dirname, 'lib', 'developerRegistry.json')) },
        { label: 'Reveal Cache File in Finder', click: () => shell.showItemInFolder(cacheFilePath(userDataDir())) },
        { label: 'Reveal Project Store in Finder', click: () => shell.showItemInFolder(projectStorePath(userDataDir())) },
        { type: 'separator' },
        {
          label: 'Reset Cache…',
          click: async () => {
            const choice = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Cancel', 'Reset cache'],
              defaultId: 0,
              cancelId: 0,
              message: 'Reset Plugr cache?',
              detail:
                'This deletes saved scan results and update statuses. Your favorites, custom categories, custom developers, and saved update sources will also be cleared. Plugr will rescan from scratch.',
            });
            if (choice.response === 1) {
              await clearCache(userDataDir());
              sendToRenderer('menu:cacheCleared');
            }
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => sendToRenderer('menu:focusSearch') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Show Tutorial…', click: () => sendToRenderer('menu:showTutorial') },
        { label: 'How to add an update source…', click: () => sendToRenderer('menu:showHelp', { tab: 'updates' }) },
        { label: 'Tips && shortcuts', click: () => sendToRenderer('menu:showHelp', { tab: 'tips' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Audio-file MIME types for the plugr-file protocol. Browsers
// need an accurate Content-Type for <audio> to decide a decoder.
const AUDIO_MIME = {
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.aif':  'audio/aiff',
  '.aiff': 'audio/aiff',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/opus',
};

/**
 * Install the plugr-file://<absolute-path> handler. Translates the
 * URL into a file response. Simplest possible version: reads the
 * full file into memory and returns the buffer. Honors Range
 * requests so <audio> can seek without re-downloading.
 */
function installPlugrFileProtocol() {
  protocol.handle('plugr-file', async (request) => {
    const fsp = require('node:fs/promises');
    let filePath;
    try {
      const u = new URL(request.url);
      let p = decodeURIComponent(u.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      filePath = p;
    } catch (err) {
      console.error('[plugr-file] bad url:', request.url, err);
      return new Response('Bad URL', { status: 400 });
    }
    let stat, data;
    try {
      stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        console.error('[plugr-file] not a file:', filePath);
        return new Response('Not a file', { status: 404 });
      }
      data = await fsp.readFile(filePath);
    } catch (err) {
      console.error('[plugr-file] read failed for', filePath, '—', err.message);
      return new Response('Not found', { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = AUDIO_MIME[ext] || 'application/octet-stream';
    const total = data.length;
    const rangeHeader = request.headers.get('range');
    console.log('[plugr-file]', filePath, total, 'bytes,', contentType, 'range=', rangeHeader || '(none)');

    if (rangeHeader) {
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (m) {
        const start = Math.min(parseInt(m[1], 10), total - 1);
        const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
        const slice = data.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
    }
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

app.whenReady().then(async () => {
  // Resolve the data dir BEFORE anything else touches the cache:
  // if the user previously enabled iCloud sync, we need to read
  // library-cache.json from iCloud Drive, not from Application Support.
  // refreshDataDir() reads the tiny always-local sync-prefs.json,
  // creates the iCloud folder if needed, and points userDataDir() at
  // the right place.
  try { await refreshDataDir(); }
  catch (err) { console.warn('refreshDataDir failed, falling back to local:', err.message); }

  installPlugrFileProtocol();
  buildAppMenu();
  createWindow();

  // Trial + license bootstrapping. Order matters:
  //  1. Ensure the trial timestamp is written on the very first launch
  //     (idempotent — does nothing on subsequent launches).
  //  2. Kick off the background license-validation loop (re-validates
  //     every 7 days; falls into offline-grace on network failure).
  //  3. Initialize the auto-updater (no-ops in dev).
  try { await trialModule.ensureStarted(userDataDir()); }
  catch (err) { console.warn('trial bootstrap failed:', err.message); }
  try { licenseModule.startBackgroundValidation(userDataDir()); }
  catch (err) { console.warn('license validation worker failed to start:', err.message); }
  try { autoUpdater.init(); }
  catch (err) { console.warn('auto-updater init failed:', err.message); }

  // Apply persisted background prefs: tray icon + login item. Done
  // after window creation + auto-updater init so the tray menu shows
  // up against a fully-booted process. Best-effort — failures here
  // are non-fatal (the app just runs without tray / login-item).
  try {
    const existing = (await loadCache(userDataDir())) || {};
    applyBackgroundMode({
      runInMenuBar:  !!existing.runInMenuBar,
      launchAtLogin: !!existing.launchAtLogin,
    });
  } catch (err) {
    console.warn('[background] apply persisted prefs failed:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Stay alive when "Run in menu bar" is on — the user expects the
  // tray icon to keep Plugr around so deal alerts can fire even with
  // no open windows. Without this branch the default Electron
  // shutdown on Windows/Linux would kill the process and silence
  // notifications the moment they closed the window.
  if (backgroundPrefs.runInMenuBar) return;
  if (process.platform !== 'darwin') app.quit();
});

// Mark "this is a real quit" so the close-to-tray interceptor in
// createWindow() lets the close go through. Set on command+Q, the
// app menu Quit item, and the tray's "Quit Plugr" entry (which sets
// the flag directly before calling app.quit()).
app.on('before-quit', () => { isQuitting = true; });

// ---------- IPC ----------

/**
 * Get the actual macOS marketing version (e.g. "26.2.0", not "25.2.0").
 *
 * On macOS 26+ Apple introduced SystemVersionCompat.plist that returns
 * an older "compatibility" version (25.x) to apps built against older
 * SDKs — including Electron itself when its prebuilt binary predates
 * macOS 26. `app.getSystemVersion()` reads that compat version, so it
 * lies to us. The shell command `sw_vers -productVersion` always
 * returns the real version.
 */
function getRealMacOSVersion() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = require('node:child_process')
      .execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 })
      .trim();
    if (out) return out;
  } catch { /* fall through to electron */ }
  if (typeof app.getSystemVersion === 'function') return app.getSystemVersion();
  return require('node:os').release();
}

/**
 * Friendly OS string for bug reports + display. Returns something like
 * "macOS Tahoe 26.5.1" on Mac and "Windows 11.x" / "Linux 6.x" elsewhere.
 * Codenames cover Plugr's supported versions (macOS 12+) and a few above
 * for future-proofing.
 */
const MACOS_CODENAMES = {
  '27': 'Tahoe+1', // placeholder for whatever ships after Tahoe
  '26': 'Tahoe',
  '15': 'Sequoia',
  '14': 'Sonoma',
  '13': 'Ventura',
  '12': 'Monterey',
  '11': 'Big Sur',
};
function getFriendlyOSVersion() {
  if (process.platform === 'darwin') {
    const ver = getRealMacOSVersion() || '';
    const major = ver.split('.')[0];
    const name = MACOS_CODENAMES[major];
    return name ? `macOS ${name} ${ver}` : `macOS ${ver}`;
  }
  const ver = (typeof process.getSystemVersion === 'function')
    ? process.getSystemVersion() : require('node:os').release();
  if (process.platform === 'win32') return `Windows ${ver}`;
  if (process.platform === 'linux') return `Linux ${ver}`;
  return `${process.platform} ${ver}`;
}


// ─── Deal alerts IPC ──────────────────────────────────────────────
// Watches user has set up for plugins / developers / keywords. The
// matcher runs in the deal-fetch pipeline (Phase 2 — wired separately).
ipcMain.handle('alerts:list', async () => {
  try {
    const cache = (await loadCache(userDataDir())) || {};
    return { ok: true, alerts: dealAlerts.listAlerts(cache) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), alerts: [] };
  }
});
ipcMain.handle('alerts:add', async (_e, alert) => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...existing };
    const created = dealAlerts.addAlert(merged, alert);
    await saveCache(userDataDir(), merged);
    return { ok: true, alert: created };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('alerts:remove', async (_e, id) => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...existing };
    const removed = dealAlerts.removeAlert(merged, id);
    if (removed) await saveCache(userDataDir(), merged);
    return { ok: removed };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('alerts:update', async (_e, { id, patch }) => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...existing };
    const updated = dealAlerts.updateAlert(merged, id, patch);
    if (updated) await saveCache(userDataDir(), merged);
    return { ok: !!updated, alert: updated };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('library:scan', async (_event, options) => {
  try {
    const systemVersion = getRealMacOSVersion();
    // Apple-Silicon Macs report 'arm64'; Intel Macs report 'x64'. We pass
    // this in so the scanner can check each bundle's Mach-O architectures
    // against what the user can actually run.
    const systemArch = require('node:os').arch();
    // Pull customFolders from the cache so the renderer doesn't have to
    // pass them every scan.
    const existing = (await loadCache(userDataDir())) || {};
    const customFolders = Array.isArray(existing.customFolders) ? existing.customFolders : [];
    const onProgress = (p) => sendToRenderer('progress:scan', p);
    const result = await scanLibrary({ ...(options || {}), systemVersion, systemArch, customFolders, onProgress });
    // Persist library portion of the cache after every successful scan.
    try { await patchCache({ library: result }); }
    catch (e) { console.warn('cache save failed', e.message); }
    return { ok: true, data: result };
  } catch (err) {
    console.error('library:scan failed', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('updates:check', async (_event, items) => {
  try {
    const onProgress = (p) => sendToRenderer('progress:updates', p);
    const result = await checkUpdatesForItems(items || [], { onProgress });
    // Persist updates results so they survive a restart.
    try {
      const existing = (await loadCache(userDataDir())) || {};
      const updateMap = { ...(existing.updates || {}) };
      for (const r of result.results) updateMap[r.id] = r;
      await patchCache({ updates: updateMap, updatesCheckedAt: result.checkedAt });
    } catch (e) { console.warn('cache save (updates) failed', e.message); }
    return { ok: true, data: result };
  } catch (err) {
    console.error('updates:check failed', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('cache:load', async () => {
  try {
    const data = (await loadCache(userDataDir())) || {};
    // Project data lives in its own file (electron/lib/projectStore.cjs).
    // We read that here and splice it into the returned `data` so the
    // renderer's existing cache-load code path doesn't have to know
    // the difference. On first run after the schema migration, copy
    // any project data still living in the main cache into the new
    // file so we don't lose history.
    let store = await loadProjectStore(userDataDir());
    if (!store) {
      store = await migrateFromLegacyCache(userDataDir(), data);
    }
    if (store) {
      data.projectLibrary = store.projectLibrary;
      data.projectTags = store.projectTags;
      data.projectNotes = store.projectNotes;
      data.projectBounceOverrides = store.projectBounceOverrides;
      data.projectRatings = store.projectRatings;
      data.projectStatuses = store.projectStatuses;
      data.customStatuses = store.customStatuses;
      data.projectKeyOverrides = store.projectKeyOverrides;
      if (store.appView) data.appView = store.appView;
    }
    return { ok: true, data };
  } catch (err) {
    console.error('cache:load failed', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('cache:clear', async () => {
  try {
    const cleared = await clearCache(userDataDir());
    return { ok: true, cleared };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: report the current iCloud-sync state to the renderer so the
// UI toggle can show the right label / disabled state.
ipcMain.handle('sync:getStatus', async () => {
  try {
    const prefs = await loadSyncPrefs();
    return {
      ok: true,
      enabled: !!prefs.iCloudSync,
      available: iCloudAvailable(),
      currentPath: userDataDir(),
      iCloudPath: iCloudPlugrDir(),
      localPath: anchorDir(),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: toggle iCloud sync on/off. The expensive part is copying the
// existing cache + project store between the local and iCloud
// folders so the user doesn't lose state at the moment they enable
// sync. Conflict resolution = the cache in the SOURCE direction wins;
// if both files already exist at the destination, we move the existing
// one aside with a .pre-sync-toggle backup suffix.
ipcMain.handle('sync:setEnabled', async (_event, { enabled } = {}) => {
  try {
    const want = !!enabled;
    // Server-side gate — iCloud sync is a paid feature. We only block
    // ENABLING it; disabling stays free so an expired user can pull
    // their data back to local-only without being stuck.
    if (want) {
      const gate = await entitlements.requires(userDataDir(), 'icloudSync');
      if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    }
    if (want && !iCloudAvailable()) {
      return { ok: false, error: 'iCloud Drive is not available on this Mac. Enable iCloud Drive in System Settings.' };
    }
    const prefs = await loadSyncPrefs();
    if (prefs.iCloudSync === want) {
      return { ok: true, enabled: want, unchanged: true };
    }

    // Files we want to migrate. waveform cache is intentionally NOT
    // included — it's audio-file-path-specific and would be useless
    // on another Mac anyway; rebuilds lazily.
    const FILES = ['library-cache.json', 'projects.json'];

    const fromDir = userDataDir();   // currently active dir (pre-toggle)
    const toDir = want ? iCloudPlugrDir() : anchorDir();

    await fspEarly.mkdir(toDir, { recursive: true });

    for (const name of FILES) {
      const src = path.join(fromDir, name);
      const dst = path.join(toDir, name);
      if (!fsSync.existsSync(src)) continue;
      // If destination exists, set aside the old one rather than
      // silently overwriting — paranoid, but cheap insurance.
      if (fsSync.existsSync(dst)) {
        try {
          await fspEarly.rename(dst, dst + '.pre-sync-toggle-' + Date.now() + '.bak');
        } catch { /* tolerate */ }
      }
      try { await fspEarly.copyFile(src, dst); }
      catch (err) {
        return { ok: false, error: `Couldn't copy ${name} to ${toDir}: ${err.message}` };
      }
    }

    await saveSyncPrefs({ iCloudSync: want });
    await refreshDataDir();
    return {
      ok: true,
      enabled: want,
      currentPath: userDataDir(),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Merge a partial override into the user's saved overrides for a given item.
// `patch` is e.g. { favorite: true } or { category: 'Effect', subcategory: 'Reverb' }
// or { developer: 'Custom Name' } or { extraCategories: [...] }.
// Pass `patch: null` (or no patch) with the special key '__clear' to reset
// all overrides for that item.
ipcMain.handle('overrides:set', async (_event, { id, patch }) => {
  try {
    if (!id) return { ok: false, error: 'no id' };
    const existing = (await loadCache(userDataDir())) || {};
    const overrides = { ...(existing.userOverrides || {}) };
    if (patch && patch.__clear) {
      delete overrides[id];
    } else {
      overrides[id] = { ...(overrides[id] || {}), ...(patch || {}) };
      // Cleanup falsy / empty overrides so the file doesn't bloat.
      if (overrides[id].favorite === false) delete overrides[id].favorite;
      // Hidden flag: only persist when explicitly true. Unhide stores
      // `false`, we strip it so the override entry can collapse away
      // entirely if it was the only field.
      if (overrides[id].hidden === false) delete overrides[id].hidden;
      if (overrides[id].category === null) delete overrides[id].category;
      if (overrides[id].subcategory === null) delete overrides[id].subcategory;
      if (overrides[id].developer === null || overrides[id].developer === '') delete overrides[id].developer;
      // Free-text notes — null / empty string means "no note", strip
      // so the entry collapses away when there's nothing else on it.
      if (overrides[id].notes == null || overrides[id].notes === '') delete overrides[id].notes;
      // Free-form tags — empty array or null collapses to "no tags".
      // We also normalize: lowercase, trim, dedupe — so 'Trap', 'trap '
      // and 'TRAP' all collapse to one entry.
      if (Array.isArray(overrides[id].tags)) {
        const cleaned = [];
        const seen = new Set();
        for (const raw of overrides[id].tags) {
          if (typeof raw !== 'string') continue;
          const t = raw.trim().toLowerCase();
          if (!t || seen.has(t)) continue;
          seen.add(t);
          cleaned.push(t);
        }
        if (cleaned.length === 0) delete overrides[id].tags;
        else overrides[id].tags = cleaned;
      }
      if (Array.isArray(overrides[id].extraCategories) && overrides[id].extraCategories.length === 0) {
        delete overrides[id].extraCategories;
      }
      if (Object.keys(overrides[id]).length === 0) delete overrides[id];
    }
    await patchCache({ userOverrides: overrides });
    return { ok: true, overrides };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Move a bundle to the user's Trash. Reversible — does NOT permanently
// delete; the user can drag it back out of Trash if they change their mind.
ipcMain.handle('shell:trashItem', async (_event, fullPath) => {
  try {
    if (!fullPath) return { ok: false, error: 'no path' };
    await shell.trashItem(fullPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Look across the user's library (in-memory state via patchCache lookups)
// for a "known good" update URL belonging to another plugin by the same
// developer. If one exists, we can derive a URL template from it and
// try the template (with slug variations) BEFORE running the standard
// discoverUpdateSource flow. This means once one plugin from a vendor
// is wired up, every later plugin from that vendor benefits — instead
// of Plugr blindly guessing homepages each time.
// Normalize a developer name for fuzzy equality. Drops common business
// suffixes (Inc, LLC, SA, GmbH, Ltd, Co, Software), removes punctuation,
// collapses whitespace, lowercases. So "Arturia", "Arturia SA",
// "ARTURIA, Inc.", and "Arturia Software" all normalize to "arturia".
function normalizeDevForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|incorporated|llc|sa|sas|sarl|gmbh|kg|ltd|limited|co|company|corp|corporation|software|audio|plugins?|technology|technologies)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findSameDevTemplate(item) {
  if (!item || !item.developer) return null;
  const devNorm = normalizeDevForMatch(item.developer);
  if (!devNorm || devNorm === 'unknown') return null;

  // Sources of truth, in order of trust:
  //   1. User-saved additions (the user already vetted these)
  //   2. Bundled registry (curated)
  // We need at least the OTHER plugin's name to derive the template.
  // User additions are keyed by identifier; combine with the cached
  // library snapshot so we can map identifier → developer + name.
  try {
    const cache = (await loadCache(userDataDir())) || {};
    const additions = cache.userRegistryAdditions || {};
    const overrides = cache.userOverrides || {};
    const libItems = (cache.library && cache.library.items) || [];

    let scanned = 0;
    let devMatched = 0;
    let urlsExamined = 0;

    // Try user additions first.
    for (const [key, add] of Object.entries(additions)) {
      scanned++;
      if (!add || !add.updateUrl) continue;
      const sibling = libItems.find((x) => (x.identifier === key || x.id === key));
      if (!sibling) continue;
      // Apply the override's developer if present, since that's what the
      // user sees in the UI and what we want to match against.
      const ov = overrides[sibling.id] || {};
      const sibDevRaw = (ov.developer && String(ov.developer).trim()) || sibling.developer || '';
      const sibDevNorm = normalizeDevForMatch(sibDevRaw);
      if (!sibDevNorm) continue;
      // Match: exact normalized OR one is a substring of the other
      // (handles "Arturia" vs "Arturia Software Center" type variance).
      const matches = sibDevNorm === devNorm
        || sibDevNorm.includes(devNorm)
        || devNorm.includes(sibDevNorm);
      if (!matches) continue;
      devMatched++;
      if (sibling.id === item.id || sibling.identifier === item.identifier) continue;
      urlsExamined++;
      const tpl = deriveUrlTemplate(add.updateUrl, sibling.name);
      if (tpl) {
        console.log(`[same-dev] matched ${sibling.name} (${sibDevRaw}) → template ${tpl}`);
        return { template: tpl, source: sibling.name };
      }
    }
    console.log(`[same-dev] no template derivable for "${item.developer}" (norm="${devNorm}") — scanned ${scanned} additions, ${devMatched} dev-matches, ${urlsExamined} URLs examined`);
    // Fall back to the bundled registry's per-developer entries.
    const { loadRegistry } = require('./lib/registryLookup.cjs');
    const reg = loadRegistry();
    const devEntry = (reg.developers || {})[item.developer]
                  || (reg.developers || {})[Object.keys(reg.developers || {}).find((k) => normalizeDevForMatch(k) === devNorm) || ''];
    if (devEntry && Array.isArray(devEntry.productMatchers)) {
      for (const pm of devEntry.productMatchers) {
        if (!pm || !pm.updateUrl) continue;
        const sibName = pm.name || pm.match;
        if (!sibName || sibName === item.name) continue;
        const tpl = deriveUrlTemplate(pm.updateUrl, sibName);
        if (tpl) {
          console.log(`[same-dev] matched registry product ${sibName} → template ${tpl}`);
          return { template: tpl, source: sibName };
        }
      }
    }
  } catch (err) {
    console.warn('[same-dev] findSameDevTemplate error:', err && err.message);
  }
  return null;
}

// Auto-discover an update URL + version regex by scanning the developer's
// website. Used from the detail panel's "Find update source" button.
ipcMain.handle('updates:discover', async (_event, item) => {
  try {
    // If the user explicitly handed us a URL (via the "Re-test with
    // this URL" button), respect it and skip the same-dev predictor.
    // The predictor would otherwise hijack the re-test by finding a
    // template-derived URL from a sibling plugin, ignoring the page
    // the user actually wants to use.
    if (item && item.manualHomepage) {
      const cleaned = { ...item, manualHomepage: cleanUrl(item.manualHomepage) };
      const data = await discoverUpdateSource(cleaned);
      return { ok: true, data };
    }
    // Pass 1: try a URL template derived from another plugin by the
    // same developer that already has a working source. This catches
    // the natural pattern of "once Plugr learns one Arturia URL, it
    // can find pages for every other Arturia plugin automatically."
    const sameDev = await findSameDevTemplate(item || {});
    if (sameDev && sameDev.template) {
      const slugs = nameToSlugCandidates(item.name || '');
      for (const slug of slugs) {
        const candidateUrl = sameDev.template.replace('{slug}', slug);
        try {
          const html = await fetchText(candidateUrl);
          if (!html) continue;
          const cleaned = html.replace(/<[^>]+>/g, ' ').toLowerCase();
          // Accept the page if ANY variant of the plugin's name (or
          // its slug forms) appears. This unlocks Arturia-style URLs
          // where the page shows the latest version (e.g. "CS-80 V4")
          // but the user installed an older one ("CS-80 V3").
          let mentioned = cleaned.includes(slug);
          if (!mentioned) {
            for (const variant of nameVariants(item.name || '')) {
              const vNorm = variant.toLowerCase();
              if (vNorm.length >= 3 && cleaned.includes(vNorm)) { mentioned = true; break; }
            }
          }
          if (!mentioned) continue;
          // The page exists and mentions the plugin. Try the loose
          // version finder against EACH name variant — handles cases
          // like CS-80 V3 looking at a page that now shows CS-80 V4,
          // where the literal "CS-80 V3" isn't on the page but the
          // shared "CS-80 V" base is. Run discoverUpdateSource too as
          // a stronger first pass (it has trust-scored regex output).
          const test = await discoverUpdateSource({
            ...item,
            manualHomepage: candidateUrl,
            registry: { ...(item.registry || {}), homepage: candidateUrl },
          });
          if (test && test.url && test.versionRegex) {
            return { ok: true, data: { ...test, message: `Found via same-developer URL pattern (${sameDev.source}).` } };
          }
          const text = stripHtml(html);
          // Try each variant — first hit wins. This is the key step that
          // lets "CS-80 V3" pick up the version off "CS-80 V4"'s page.
          let loose = null;
          let usedVariant = item.name;
          for (const variant of nameVariants(item.name || '')) {
            const candidate = findVersionInTextLoose(text, variant);
            if (candidate && candidate.version && candidate.regex) {
              loose = candidate;
              usedVariant = variant;
              break;
            }
          }
          if (loose && loose.version && loose.regex) {
            return {
              ok: true,
              data: {
                url: candidateUrl,
                versionRegex: loose.regex,
                latestVersion: loose.version,
                tried: [candidateUrl],
                message: `Found "${usedVariant} v${loose.version}" via the URL pattern other ${item.developer} plugins use.`,
              },
            };
          }
          // The page loads + mentions the name but no version. Same
          // reasoning as the DiscoverModal: if this plugin is already
          // managed by a companion app, don't propose a URL-only save
          // (it would replace the Companion-app-only status with
          // Check-manually, which is strictly worse). Fall through to
          // the standard discover instead — that path returns "no
          // suitable page", leaving the companion-managed status
          // intact.
          const isCompanionManaged = !!(item && item.registry && item.registry.companionApp);
          if (!isCompanionManaged) {
            return {
              ok: true,
              data: {
                url: candidateUrl,
                versionRegex: null,
                latestVersion: null,
                tried: [candidateUrl],
                message: `Found a likely page at ${candidateUrl} via the URL pattern other ${item.developer} plugins use, but couldn't auto-detect the version. You can save URL-only and verify manually.`,
              },
            };
          }
          // Companion-managed + no version → fall through to standard
          // discover (which will likely also fail), so the user keeps
          // their Companion-app-only status untouched.
          break;
        } catch { /* network / 404 — try next slug */ }
      }
    }

    // Standard discover (homepage probing, candidate URL ranking, etc.)
    const data = await discoverUpdateSource(item || {});
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// "Skip the regex" manual flow: user pastes a URL and the version they see
// on the page; we fetch the page, locate the version, and synthesize a regex
// from the surrounding context. See deriveRegexFromVersion() for details.
ipcMain.handle('updates:deriveFromVersion', async (_event, payload) => {
  try {
    const { url, knownVersion, name } = payload || {};
    return await deriveRegexFromVersion({ url: cleanUrl(url), knownVersion, name });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/**
 * Build a best-guess homepage URL from a CFBundleIdentifier.
 *   com.fabfilter.proq3      → https://fabfilter.com
 *   com.u-he.diva            → https://u-he.com
 *   jp.aom-factory.foo       → https://aom-factory.jp
 *   io.spliceaudio.bar       → https://spliceaudio.io
 *   com.foo-bar.baz          → https://foo-bar.com
 *
 * Returns null if the identifier doesn't have at least two reverse-DNS
 * segments. The result is "best guess" — the discover module will still
 * fail gracefully if the domain doesn't exist or doesn't host the plugin
 * info we need.
 */
function deriveHomepageFromIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const parts = identifier.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const tld = parts[0].toLowerCase();
  const company = parts[1].toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!company || company.length < 2) return null;
  const knownTlds = new Set(['com', 'net', 'org', 'io', 'co', 'audio', 'jp', 'de', 'fr', 'it', 'nl', 'uk']);
  const useTld = knownTlds.has(tld) ? tld : 'com';
  return `https://${company}.${useTld}`;
}

// Bulk auto-discover: run discoverUpdateSource on every item that doesn't
// already have an update source. Falls back to an identifier-derived
// homepage when the registry has nothing for that developer.
ipcMain.handle('updates:discoverAll', async (_event, items) => {
  try {
    // Server-side gate — bulk discover is a paid feature. The
    // single-plugin discover endpoint (updates:discover) stays open
    // so trial users can still build a registry one at a time.
    const gate = await entitlements.requires(userDataDir(), 'bulkOperations');
    if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    const list = Array.isArray(items) ? items : [];

    // Build candidate list: skip items that already have a working update
    // source (Sparkle URL or registry updateUrl+regex). For everything
    // else, attach a homepage we can try — either from the registry or
    // derived from the bundle identifier.
    const candidates = [];
    let skippedNoIdentifier = 0;
    for (const it of list) {
      if (!it) continue;
      // Already has Sparkle: skip — Sparkle handles itself in updateChecker.
      if (it.sparkleFeedUrl) continue;
      const reg = it.registry || {};
      if (reg.updateUrl && reg.versionRegex) continue;

      const homepage = reg.homepage || deriveHomepageFromIdentifier(it.identifier);
      if (!homepage) { skippedNoIdentifier++; continue; }
      candidates.push({ item: it, homepage });
    }

    const total = candidates.length;
    let done = 0;
    let foundCount = 0;
    const newAdditions = {};

    // Process candidates in parallel batches. With ~3 candidate URLs per
    // item and a 5s fetch timeout, an 8-way batch should resolve a typical
    // 3,000-item library in 5-15 minutes instead of the previous all-day
    // sequential run.
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < candidates.length) {
        const idx = cursor++;
        const { item: it, homepage } = candidates[idx];
        sendToRenderer('progress:discoverAll', {
          phase: 'discoverAll', current: done, total,
          message: `Searching ${it.name}…`,
        });
        try {
          const result = await discoverUpdateSource({ ...it, manualHomepage: homepage });
          if (result && result.url && result.versionRegex) {
            const key = it.identifier || it.id;
            newAdditions[key] = {
              updateUrl: result.url,
              versionRegex: result.versionRegex,
              addedAt: new Date().toISOString(),
              addedBy: 'auto-discover-bulk',
            };
            foundCount++;
          }
        } catch (_e) { /* per-item errors silent */ }
        done++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
    );

    // Per-developer URL template propagation pass.
    //
    // Companies almost always use the same URL shape for every product —
    // fabfilter.com/products/pro-q-3, fabfilter.com/products/pro-c-3,
    // fabfilter.com/products/pro-r-2 etc. So once we've found one URL for
    // a developer, we derive a template (replace the plugin slug with a
    // placeholder) and try it against the slug of every other unmatched
    // plugin from that same developer. Often this picks up most of the
    // catalog in one pass.
    sendToRenderer('progress:discoverAll', {
      phase: 'discoverAll', current: total, total,
      message: 'Trying per-developer URL templates…',
    });

    // Group items found-by-discover and unmatched-after-discover, both
    // keyed by developer.
    const succeededByDev = new Map();
    const unmatchedByDev = new Map();
    for (const { item: it } of candidates) {
      const dev = (it.developer || '').toLowerCase().trim();
      if (!dev || dev === 'unknown') continue;
      const key = it.identifier || it.id;
      if (newAdditions[key]) {
        if (!succeededByDev.has(dev)) succeededByDev.set(dev, []);
        succeededByDev.get(dev).push({ item: it, addition: newAdditions[key] });
      } else {
        if (!unmatchedByDev.has(dev)) unmatchedByDev.set(dev, []);
        unmatchedByDev.get(dev).push(it);
      }
    }

    // Build the full list of (sibling-item, dev-templates) work units up
    // front so we can emit accurate progress (current/total) and run the
    // probes in parallel. Each work unit is one sibling × all of its
    // dev's templates; first matching template wins.
    const workUnits = [];
    for (const [dev, succeeded] of succeededByDev) {
      const unmatched = unmatchedByDev.get(dev);
      if (!unmatched || unmatched.length === 0) continue;
      const templates = [];
      for (const { item: src, addition } of succeeded) {
        const tpl = deriveUrlTemplate(addition.updateUrl, src.name);
        if (tpl && !templates.find((t) => t.url === tpl)) {
          templates.push({ url: tpl, regex: addition.versionRegex });
        }
      }
      if (templates.length === 0) continue;
      for (const it of unmatched) workUnits.push({ it, templates, dev });
    }

    const tplTotal = workUnits.length;
    let tplDone = 0;
    let templatePassFound = 0;
    sendToRenderer('progress:discoverAll', {
      phase: 'discoverAll',
      current: total + tplDone, total: total + tplTotal,
      message: `Trying URL patterns 0/${tplTotal}…`,
    });

    // Run in parallel like the main discovery loop. CONCURRENCY matches
    // the earlier worker pool — 8 simultaneous probes is safe for almost
    // every developer's web server.
    const TPL_CONCURRENCY = 8;
    let tplCursor = 0;
    async function tplWorker() {
      while (tplCursor < workUnits.length) {
        const idx = tplCursor++;
        const { it, templates } = workUnits[idx];
        for (const tpl of templates) {
          const tryUrl = applyUrlTemplate(tpl.url, it.name);
          if (!tryUrl) continue;
          try {
            const test = await discoverUpdateSource({
              ...it, manualHomepage: tryUrl, registry: { ...(it.registry || {}), homepage: tryUrl },
            });
            if (test && test.url && test.versionRegex) {
              const k = it.identifier || it.id;
              newAdditions[k] = {
                updateUrl: test.url,
                versionRegex: test.versionRegex,
                addedAt: new Date().toISOString(),
                addedBy: 'auto-discover-template',
              };
              templatePassFound++;
              break;
            }
          } catch { /* try next template */ }
        }
        tplDone++;
        // Throttle progress updates a bit — every result + every 10
        // completions, so the bar moves but we don't spam the renderer.
        if (tplDone % 5 === 0 || tplDone === tplTotal) {
          sendToRenderer('progress:discoverAll', {
            phase: 'discoverAll',
            current: total + tplDone, total: total + tplTotal,
            message: `Trying URL patterns ${tplDone}/${tplTotal} (+${templatePassFound} found)…`,
          });
        }
      }
    }
    await Promise.all(Array.from({ length: TPL_CONCURRENCY }, () => tplWorker()));
    foundCount += templatePassFound;

    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...(existing.userRegistryAdditions || {}), ...newAdditions };
    await patchCache({ userRegistryAdditions: merged });

    sendToRenderer('progress:discoverAll', {
      phase: 'discoverAll', current: total, total,
      message: `Found ${foundCount} of ${total}.`,
    });
    return {
      ok: true,
      data: {
        total,
        foundCount,
        templatePassFound,
        skippedNoIdentifier,
        skippedAlreadyHaveSource: list.length - total - skippedNoIdentifier,
        additions: newAdditions,
        mergedAdditions: merged,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Save (or clear) a user-added registry entry. Keyed by plugin identifier
// when present, falling back to item.id. These additions live in the cache
// and are merged on top of the curated registry at display time.
ipcMain.handle('registry:saveAddition', async (_event, { key, addition }) => {
  try {
    if (!key) return { ok: false, error: 'no key' };
    const existing = (await loadCache(userDataDir())) || {};
    const additions = { ...(existing.userRegistryAdditions || {}) };
    if (addition === null || addition === undefined) {
      delete additions[key];
    } else {
      // Always strip tracking params before persisting — final
      // backstop in case the renderer's cleanUrl path got skipped
      // (e.g. opt-in flows that bypass saveAddition, or a stale URL
      // copy-pasted into the cache during dev).
      const sanitized = { ...addition };
      if (sanitized.updateUrl) sanitized.updateUrl = cleanUrl(sanitized.updateUrl);
      additions[key] = { ...(additions[key] || {}), ...sanitized };
    }
    await patchCache({ userRegistryAdditions: additions });
    return { ok: true, additions };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Clear cached update-check results for a list of library ids. Used by
// the bulk-remove-source flow so a plugin whose source was just deleted
// doesn't keep showing the OLD "Newer than registry" or "Update
// available" status on the next launch — the renderer's setUpdates clears
// it from in-memory state but that change never reached the cache before
// this handler existed.
ipcMain.handle('updates:clearForIds', async (_event, ids) => {
  try {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: true, cleared: 0 };
    const existing = (await loadCache(userDataDir())) || {};
    const updates = { ...(existing.updates || {}) };
    let cleared = 0;
    for (const id of ids) {
      if (updates[id]) {
        delete updates[id];
        cleared++;
      }
    }
    if (cleared > 0) await patchCache({ updates });
    return { ok: true, cleared };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Mark the tutorial as dismissed (or un-dismiss it).
ipcMain.handle('tutorial:setDismissed', async (_event, dismissed) => {
  try {
    await patchCache({ tutorialDismissed: !!dismissed });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Persist the user's theme preference. Valid values:
//   'auto'  → follow OS dark/light setting
//   'dark', 'light' → built-in themes
//   'abalone', 'logical', 'fruity', 'protea', 'bitty',
//   'cubert', 'rationale', 'grim' → DAW-themed palettes
ipcMain.handle('theme:set', async (_event, themePreference) => {
  try {
    await patchCache({ themePreference: themePreference || 'auto' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Persist a small set of UI preferences. Restricted to known keys so a
// renderer compromise can't write arbitrary fields into the cache.
const ALLOWED_PREF_KEYS = new Set(['categorySort', 'developerSort', 'formatSort', 'customFolders', 'columnWidths', 'compatFilter', 'userCategories', 'sidebarSectionOrder', 'sortBy', 'sortDir', 'view', 'appView', 'audioVolume', 'defaultTab', 'currencyPref', 'hiddenTabs']);
// Background-app prefs: read + write the runInMenuBar / launchAtLogin
// toggles. Persisted to cache so they survive restarts; main applies
// them immediately (tray icon + login-item registration) so the
// toggle is reactive without an app restart.
ipcMain.handle('app:getBackgroundMode', async () => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    return {
      ok: true,
      runInMenuBar:  !!existing.runInMenuBar,
      launchAtLogin: !!existing.launchAtLogin,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('app:setBackgroundMode', async (_event, payload = {}) => {
  try {
    const patch = {};
    if (typeof payload.runInMenuBar  === 'boolean') patch.runInMenuBar  = payload.runInMenuBar;
    if (typeof payload.launchAtLogin === 'boolean') patch.launchAtLogin = payload.launchAtLogin;
    if (Object.keys(patch).length === 0) return { ok: false, error: 'no fields to update' };
    await patchCache(patch);
    const existing = (await loadCache(userDataDir())) || {};
    applyBackgroundMode({
      runInMenuBar:  !!existing.runInMenuBar,
      launchAtLogin: !!existing.launchAtLogin,
    });
    return {
      ok: true,
      runInMenuBar:  !!existing.runInMenuBar,
      launchAtLogin: !!existing.launchAtLogin,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('prefs:set', async (_event, patch) => {
  try {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'no patch' };
    const safe = {};
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED_PREF_KEYS.has(k)) safe[k] = v;
    }
    await patchCache(safe);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Expose a slim view of the registry to the renderer so it can apply
// companion-app / homepage info live against the FINAL displayed
// developer name (post-overrides, post-case-fold). Without this, edits
// to a plugin's developer in the UI don't pick up the registry's
// companion app — the lookup only runs at scan time in main.
ipcMain.handle('registry:getCompanionMap', async () => {
  try {
    const { loadRegistry, invalidateRegistryCache } = require('./lib/registryLookup.cjs');
    invalidateRegistryCache();
    const reg = loadRegistry();
    // companions: developer name → { companionApp, homepage, supportUrl, downloadsUrl }
    const companions = {};
    const merge = (name, dev) => {
      if (!dev) return;
      companions[name] = {
        companionApp: dev.companionApp || null,
        homepage: dev.homepage || null,
        supportUrl: dev.supportUrl || null,
        downloadsUrl: dev.downloadsUrl || null,
      };
    };
    for (const [name, dev] of Object.entries(reg.developers || {})) merge(name, dev);
    for (const [name, pub] of Object.entries(reg.appPublishers || {})) merge(name, pub);
    // aliases: variant (lowercased, whitespace-normalized) → canonical
    const aliases = {};
    for (const [variant, canonical] of Object.entries(reg.developerAliases || {})) {
      if (variant.startsWith('_')) continue;
      aliases[variant.toLowerCase().replace(/[\s ]+/g, ' ').trim()] = canonical;
    }
    return { ok: true, data: { companions, aliases } };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Surface the configured support URL (or null) + whether bug reports
// are wired up. Renderer uses this to enable/disable the buttons in
// the Preferences tab so a not-yet-configured install doesn't leave
// dead buttons sitting around.
ipcMain.handle('support:getConfig', async () => {
  return {
    ok: true,
    supportUrl: supportConfig.supportUrl(),
    bugReportEnabled: supportConfig.isBugReportConfigured(),
    // True when running unpackaged (npm run dev / electron .). The
    // renderer uses this to gate developer-only UI like the click
    // diagnostics table — end users shouldn't see internal metrics.
    isDevMode: !app.isPackaged,
  };
});

// Submit a bug report. Renderer collects the form fields; we attach
// anonymous diagnostic counts (app version, OS version, library size,
// project count) so reports arrive with reproducible context.
ipcMain.handle('support:submitBug', async (_event, report) => {
  try {
    // Anonymous diagnostic context. NO plugin names, NO file paths,
    // NO developer info — just counts.
    const cache = (await loadCache(userDataDir())) || {};
    const pluginCount = (cache.library && Array.isArray(cache.library.items)) ? cache.library.items.length : 0;
    const projectCount = (cache.projectLibrary && Array.isArray(cache.projectLibrary.projects))
      ? cache.projectLibrary.projects.length : 0;
    const res = await supportConfig.submitBugReport({
      ...(report || {}),
      appVersion: app.getVersion(),
      osVersion: getFriendlyOSVersion(),
      pluginCount,
      projectCount,
    });
    return res;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Mark/unmark a deal as dismissed (hidden from all sections). Pass
// saved:false to UN-dismiss. Returns the updated map so the renderer
// can reconcile its optimistic update.
ipcMain.handle('deals:setDismissed', async (_event, { id, dismissed } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const existing = (await loadCache(userDataDir())) || {};
    const next = { ...(existing.dismissedDeals || {}) };
    if (dismissed) next[id] = { dismissedAt: new Date().toISOString() };
    else delete next[id];
    await patchCache({ dismissedDeals: next });
    return { ok: true, dismissedDeals: next };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Reset the entire dismissed-deals list (Preferences "Clear hidden deals").
ipcMain.handle('deals:clearDismissed', async () => {
  try {
    await patchCache({ dismissedDeals: {} });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Bump the "last time the user opened the Deals tab" timestamp. The
// renderer calls this when the Deals tab becomes active; the TabBar
// "N new" badge counts items whose firstSeenAt is later than this
// value. Pass an explicit ISO string in `at` to back-date if needed;
// otherwise we use "now".
ipcMain.handle('deals:setLastViewed', async (_event, { at } = {}) => {
  try {
    const ts = (typeof at === 'string' && at) ? at : new Date().toISOString();
    await patchCache({ dealsLastViewedAt: ts });
    return { ok: true, dealsLastViewedAt: ts };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Click tracking — increments per-source counter every time the user
// clicks through to a deal. Useful for diagnosing affiliate-network
// undercounting: if APD reports N clicks but Plugr's counter is N+M,
// the gap is dedup/blocked-tracker rather than a Plugr bug.
ipcMain.handle('deals:trackClick', async (_event, { source, url } = {}) => {
  try {
    if (!source) return { ok: false };
    const existing = (await loadCache(userDataDir())) || {};
    const counts = { ...(existing.clickCounts || {}) };
    const entry = counts[source] || { total: 0, last30Days: [] };
    entry.total = (entry.total || 0) + 1;
    // Append today's date to last30Days, prune anything older. Storing
    // dates not timestamps keeps the array small and human-readable.
    const today = new Date().toISOString().slice(0, 10);
    const arr = Array.isArray(entry.last30Days) ? entry.last30Days.slice() : [];
    arr.push(today);
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    entry.last30Days = arr.filter((d) => d >= cutoff);
    counts[source] = entry;
    await patchCache({ clickCounts: counts });
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Submit a community contribution (opt-in). The renderer is responsible
// for asking the user; this just performs the network call.
ipcMain.handle('community:submit', async (_event, addition) => {
  try {
    const res = await community.submitAddition({
      ...(addition || {}),
      appVersion: app.getVersion(),
    });
    return res;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Fetch the latest community-curated additions list. Caches inside the
// usual cache file with a 24h TTL.
ipcMain.handle('community:fetchAdditions', async (_event, { force } = {}) => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    const cached = existing.communityAdditions;
    const fresh = cached && cached.fetchedAt &&
      (Date.now() - new Date(cached.fetchedAt).getTime() < community.ADDITIONS_TTL_MS);
    if (fresh && !force) {
      return { ok: true, data: cached, fromCache: true };
    }
    if (!community.isConfigured()) {
      // Surface the cached result if any, otherwise tell the renderer the
      // feature isn't set up yet (which is the default until the developer
      // fills in URLs in community.cjs).
      return { ok: true, data: cached || null, configured: false };
    }
    const res = await community.fetchCommunityAdditions();
    if (!res.ok) {
      // On a fetch error, fall back to whatever we have cached.
      return { ok: true, data: cached || null, error: res.error, fromCache: !!cached };
    }
    const next = { ...res.data, fetchedAt: new Date().toISOString() };
    await patchCache({ communityAdditions: next });

    // Persist companion-app patches to disk so registryLookup can
    // overlay them on next load. Invalidate the cached registry so the
    // overlay takes effect on the next scan without a restart.
    try {
      if (Array.isArray(next.companionAppPatches) && next.companionAppPatches.length > 0) {
        const w = await community.writePatchesToDisk(next.companionAppPatches);
        if (w && w.ok) {
          const { invalidateRegistryCache } = require('./lib/registryLookup.cjs');
          invalidateRegistryCache();
          console.log(`[community] wrote ${w.count} companion-app patch(es); registry cache invalidated`);
        }
      }
    } catch (err) {
      console.warn('[community] failed to persist patches:', err && err.message);
    }

    return { ok: true, data: next, fromCache: false };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Deals — fetch + cache plugin-deal feeds. The renderer's Deals tab
// shows these matched against the user's library. 24-hour TTL keeps
// network use minimal; force=true bypasses for a manual refresh.
//
// fetcherVersion bumps whenever we change the source list or filter
// logic in dealsFetcher.cjs in a way that would make existing cached
// items stale or wrong. The cache check below treats a version
// mismatch like an expired TTL — force a refetch on the next call.
//   v1: audioplugin.deals/feed/, no filter (everything kept)
//   v2: bedroomproducersblog.com/feed/, deal-shape filter, priceBadge
//   v3: real retailer scrapers (Plugin Boutique + APD) with affiliate
//       URL wrapping. Items now have endsAt + structured price badge.
//   v4: scrapers hardened — match relative URLs, use real browser UA so
//       commercial sites don't 403, APD scraper rewritten URL-anchored
//       (no longer depends on WooCommerce default <li> wrapper).
//   v5: deals now include imageUrl (hero / product thumbnail) for the
//       redesigned visual cards in the renderer.
//   v6: APD scraper now filters out non-sale catalog products (no more
//       Pigments-at-$199 false deals); PB discount picker prefers
//       "Up to X% OFF" pattern; ranking uses tuple comparator so
//       no-endsAt deals aren't penalized.
//   v7: APD chunk extraction switched to midpoint chunking so it works
//       regardless of where the URL appears in the product card (was
//       attributing wrong card content to products with end-of-card
//       View Product links). Loosened discount regex now that chunks
//       are correctly bounded. Per-product accept/reject logging.
//   v8: APD titles cleaned — strips "box shot", "Website Box Shot",
//       "min", "logo", file-extension and dimension suffixes baked
//       into image alts; falls back to URL slug when nothing better
//       is available. Acronyms (OTT, EQ, etc.) preserved in slug
//       title-casing.
//   v9: APD scraper now fetches each product's DETAIL page and parses
//       OpenGraph + product:* meta tags for clean title, description,
//       image, and prices. Old listing-only scraping gave broken /
//       missing titles and no descriptions. Detail-page fetches are
//       parallel (concurrency 6) and cached 24h so it's a one-time
//       cost per refresh.
const DEALS_TTL_MS = 24 * 60 * 60 * 1000;
const DEALS_FETCHER_VERSION = 9;
ipcMain.handle('deals:get', async (_event, { force } = {}) => {
  try {
    const existing = (await loadCache(userDataDir())) || {};
    const cached = existing.deals;
    const fresh = cached && cached.fetchedAt &&
      cached.fetcherVersion === DEALS_FETCHER_VERSION &&
      (Date.now() - new Date(cached.fetchedAt).getTime() < DEALS_TTL_MS);
    if (fresh && !force) {
      // Return the cached items, the latest price history snapshot,
      // dismissed-deals map, currency preference, and exchange rates
      // so the renderer can hide / convert in one round-trip.
      return {
        ok: true,
        data: {
          ...cached,
          priceHistory: existing.priceHistory || {},
          dismissedDeals: existing.dismissedDeals || {},
          currencyPref: existing.currencyPref || 'USD',
          exchangeRates: existing.exchangeRates || null,
          dealsLastViewedAt: existing.dealsLastViewedAt || null,
        },
        fromCache: true,
      };
    }
    // onProgress forwards per-source/per-page/per-product status to
    // the renderer so the Refresh button isn't an opaque "wait several
    // seconds". Channel matches the other progress:* channels.
    const sender = _event && _event.sender;
    const onProgress = sender && !sender.isDestroyed()
      ? (msg) => { try { sender.send('progress:deals', msg); } catch {} }
      : null;
    const items = await dealsFetcher.fetchAllDeals(onProgress);
    const next = {
      items,
      fetchedAt: new Date().toISOString(),
      fetcherVersion: DEALS_FETCHER_VERSION,
    };
    // Record a fresh price-history snapshot for every deal we just
    // fetched. This is the only place that writes price history — the
    // 24h TTL on the deal cache naturally throttles it to ~once per day.
    const updatedHistory = priceHistory.recordSnapshot(existing.priceHistory || {}, items);
    // Piggyback an exchange-rate refresh on the deals refresh — both
    // are 24h-cached and both are needed by the renderer at the same
    // time, so coupling them avoids a second wait on tab open.
    const updatedRates = await exchangeRates.getRates(existing.exchangeRates || null, { force: false });
    await patchCache({ deals: next, priceHistory: updatedHistory, exchangeRates: updatedRates });

    // ─── Deal alert matcher ──────────────────────────────────────────
    // Run user-defined watches against the freshly-fetched items. We
    // only do this on a real fetch (not the cached-return branch), so
    // the user gets at most one notification window per ~24h cycle.
    // Each individual alert ALSO gets its own 24h suppression via
    // dealAlerts.shouldNotify() so a returning sale that's still
    // running doesn't re-notify on every fetch.
    try {
      const currentAlerts = Array.isArray(existing.dealAlerts) ? existing.dealAlerts : [];
      if (currentAlerts.length > 0 && Array.isArray(items) && items.length > 0) {
        const matches = dealAlerts.findMatches(currentAlerts, items);
        const newMatches = matches.filter((m) => dealAlerts.shouldNotify(m.alert));
        if (newMatches.length > 0) {
          // Stamp lastNotifiedAt on every alert that fired so the
          // 24h suppression window applies on the next fetch. We
          // map over the full current list rather than mutating in
          // place so the JSON serializer sees a fresh object.
          const nowIso = new Date().toISOString();
          const notifiedIds = new Set(newMatches.map((m) => m.alertId));
          const updatedAlerts = currentAlerts.map((a) =>
            notifiedIds.has(a.id) ? { ...a, lastNotifiedAt: nowIso } : a
          );
          await patchCache({ dealAlerts: updatedAlerts });

          // Fire a native macOS notification. Three cases handled
          // distinctly so the body reads naturally:
          //   1. Single deal, single alert  → "Plugr deal alert: X" + deal title
          //   2. Multiple deals, one alert  → "N deals matching X" + deal titles
          //   3. Multiple distinct alerts   → "N Plugr deal alerts" + label list
          // Case 2 is the common one (one watch matches several deals in
          // a single sale day) — repeating the same label in the body
          // would be confusing, so we list deal titles instead.
          if (Notification.isSupported()) {
            const focusApp = () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
              }
            };
            // Group matches by alert so we can distinguish case 2 vs 3.
            const byAlert = new Map();
            for (const m of newMatches) {
              if (!byAlert.has(m.alertId)) {
                byAlert.set(m.alertId, { alert: m.alert, deals: [] });
              }
              byAlert.get(m.alertId).deals.push(m.deal);
            }
            const distinctAlerts = Array.from(byAlert.values());

            let notif;
            if (newMatches.length === 1) {
              // Case 1: single deal under a single alert.
              const m = newMatches[0];
              const d = m.deal || {};
              const tail = d.discountText || d.discount || '';
              notif = new Notification({
                title: `Plugr deal alert: ${m.alert.label}`,
                body: tail ? `${d.title || ''} — ${tail}` : (d.title || 'New matching deal'),
                silent: false,
              });
            } else if (distinctAlerts.length === 1) {
              // Case 2: many deals matched, all under one alert.
              const entry = distinctAlerts[0];
              const titles = entry.deals
                .slice(0, 2)
                .map((d) => d.title || 'unnamed deal')
                .join(', ');
              const extra = entry.deals.length > 2 ? ` +${entry.deals.length - 2} more` : '';
              notif = new Notification({
                title: `${entry.deals.length} deals matching ${entry.alert.label}`,
                body: `${titles}${extra}`,
                silent: false,
              });
            } else {
              // Case 3: multiple distinct alerts each matched.
              const labels = distinctAlerts
                .slice(0, 3)
                .map((e) => e.alert.label)
                .join(', ');
              const extra = distinctAlerts.length > 3 ? ` +${distinctAlerts.length - 3} more` : '';
              notif = new Notification({
                title: `${distinctAlerts.length} Plugr deal alerts`,
                body: `${labels}${extra}`,
                silent: false,
              });
            }
            notif.on('click', focusApp);
            notif.show();
          }

          // Forward to the renderer so in-app UI (bell badge, banner,
          // etc.) can react. Slimmed payload — alertId + label + the
          // matched deal is enough for any consumer to identify what
          // happened without re-running matching client-side.
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('alerts:matched', {
                matches: newMatches.map((m) => ({
                  alertId: m.alertId,
                  alertLabel: m.alert.label,
                  deal: m.deal,
                })),
              });
            }
          } catch { /* tolerate */ }
        }
      }
    } catch (alertErr) {
      // Alerts are a side-feature on the deal fetch — a failure here
      // must never break the actual deal return. Just log and move on.
      console.warn('[alerts] matcher failed:', alertErr && alertErr.message);
    }

    return {
      ok: true,
      data: {
        ...next,
        priceHistory: updatedHistory,
        dismissedDeals: existing.dismissedDeals || {},
        currencyPref: existing.currencyPref || 'USD',
        exchangeRates: updatedRates,
        dealsLastViewedAt: existing.dealsLastViewedAt || null,
      },
      fromCache: false,
    };
  } catch (err) {
    // On error, fall back to whatever's cached — but only if it was
    // produced by the current fetcher version. Otherwise the user
    // would keep seeing stale, wrongly-filtered items forever any
    // time the network glitched.
    try {
      const existing = (await loadCache(userDataDir())) || {};
      if (existing.deals && existing.deals.fetcherVersion === DEALS_FETCHER_VERSION) {
        return {
          ok: true,
          data: { ...existing.deals, priceHistory: existing.priceHistory || {} },
          error: String(err && err.message || err),
          fromCache: true,
        };
      }
    } catch { /* fall through */ }
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Toggle the saved/wishlist state of a deal. The renderer passes the
// full deal object so we can persist enough to re-render the card even
// after the deal disappears from the live scrape (PB rotates its sales
// list; without this snapshot a saved deal would vanish a week later).
ipcMain.handle('deals:setSaved', async (_event, { id, deal, saved } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const existing = (await loadCache(userDataDir())) || {};
    const savedDeals = { ...(existing.savedDeals || {}) };
    if (saved && deal) {
      savedDeals[id] = {
        id, url: deal.url, title: deal.title, imageUrl: deal.imageUrl || null,
        priceBadge: deal.priceBadge || null, endsAt: deal.endsAt || null,
        source: deal.source || null, developer: deal.developer || null,
        savedAt: new Date().toISOString(),
      };
    } else {
      delete savedDeals[id];
    }
    await patchCache({ savedDeals });
    return { ok: true, savedDeals };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Try a URL template against a list of sibling plugins (same developer
// as a plugin where Discover just succeeded). Used by the "try this URL
// pattern for X other plugins from <dev>?" prompt that appears after a
// manual save. Saves successful results to the user's registry additions.
ipcMain.handle('updates:tryTemplate', async (_event, { template, seedName, siblings }) => {
  try {
    if (!template || !Array.isArray(siblings) || siblings.length === 0) {
      return { ok: true, data: { foundCount: 0, total: 0, mergedAdditions: null } };
    }
    // The renderer hands us the seed plugin's bare saved URL, not a
    // {slug}-templated string. Convert it to a real template here by
    // locating the seed's slug inside the URL path and replacing it
    // with the {slug} placeholder. Without this conversion, every
    // sibling would get the seed's exact URL (the .replace below would
    // be a no-op since there's no {slug} marker to substitute).
    const urlTemplate = seedName ? deriveUrlTemplate(template, seedName) : null;
    if (!urlTemplate) {
      sendToRenderer('progress:tryTemplate', {
        phase: 'tryTemplate', current: 0, total: siblings.length,
        message: `Couldn't derive a URL template from this page — the plugin's name isn't in the URL.`,
      });

      return {
        ok: true,
        data: {
          total: siblings.length,
          foundCount: 0,
          urlOnlyCount: 0,
          additions: {},
          mergedAdditions: null,
          templateNotDerivable: true,
        },
      };
    }
    const total = siblings.length;
    let done = 0;
    let foundCount = 0;            // saved with both URL + working regex
    let urlOnlyCount = 0;          // saved URL-only (manual-check)
    const newAdditions = {};
    const CONCURRENCY = 6;
    let cursor = 0;

    // Lightweight check for whether the page even references the
    // plugin's name — used to decide if we can save URL-only when
    // version extraction fails. Without this guard, a Wordpress 404
    // page that returns 200 OK would look "valid" and we'd save
    // junk URLs.
    function pageMentionsName(html, name) {
      if (!html || !name) return false;
      const cleaned = String(html).replace(/<[^>]+>/g, ' ').toLowerCase();
      // Walk each name variant ("CS-80 V3" → ["CS-80 V3", "CS-80 V", ...])
      // and check both literal-substring and slug forms. This lets a
      // page that shows the LATEST version of a product ("CS-80 V4")
      // still be accepted when the user has an older version installed
      // ("CS-80 V3"). The shared base ("CS-80 V" or "CS-80") matches.
      for (const variant of nameVariants(name)) {
        const norm = variant.toLowerCase();
        if (norm.length >= 3 && cleaned.includes(norm)) return true;
        const slug = norm.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (slug.length >= 3 && cleaned.includes(slug)) return true;
      }
      return false;
    }

    async function worker() {
      while (cursor < siblings.length) {
        const idx = cursor++;
        const it = siblings[idx];

        // Try multiple slug variations (strict, number-glued,
        // all-collapsed) so vendors like Arturia who use
        // "comp-fet76" instead of "comp-fet-76" still match. Cap at
        // 3 to keep total request count reasonable.
        const slugs = nameToSlugCandidates(it.name);
        let firstTryUrl = null;
        let workingHtml = null;       // HTML of the first URL that loaded + mentioned the name
        let workingUrl = null;        // the URL that html came from

        for (const slug of slugs) {
          // Apply this slug to the template by substituting {slug}.
          // We call applyUrlTemplate with a synthetic single-token
          // name to keep the path consistent.
          const candidateUrl = urlTemplate.replace('{slug}', slug);
          if (!firstTryUrl) firstTryUrl = candidateUrl;
          try {
            const html = await fetchText(candidateUrl);
            if (html && pageMentionsName(html, it.name)) {
              workingHtml = html;
              workingUrl = candidateUrl;
              break;
            }
          } catch { /* 404 / network — try the next slug */ }
        }

        sendToRenderer('progress:tryTemplate', {
          phase: 'tryTemplate', current: done, total,
          message: workingUrl
            ? `Found ${it.name} at ${workingUrl} (${done + 1} of ${total})…`
            : `Trying ${it.name} at ${firstTryUrl || '(no URL derived)'} (${done + 1} of ${total})…`,
        });

        if (workingHtml && workingUrl) {
          try {
            // We already have the right URL + page contents. Run
            // discoverUpdateSource only against that URL so it doesn't
            // hunt around — pass it as manualHomepage and let the
            // existing version-finder logic do its thing.
            const test = await discoverUpdateSource({
              ...it,
              manualHomepage: workingUrl,
              registry: { ...(it.registry || {}), homepage: workingUrl },
            });
            const k = it.identifier || it.id;
            if (test && test.url && test.versionRegex) {
              // Best case: page loaded AND we extracted a version regex
              newAdditions[k] = {
                updateUrl: test.url,
                versionRegex: test.versionRegex,
                addedAt: new Date().toISOString(),
                addedBy: 'sibling-template',
              };
              foundCount++;
            } else {
              // The strict findVersionInText (via discoverUpdateSource)
              // didn't find a version, but the URL was derived from a
              // known-good template AND the page mentions the plugin
              // (pre-verified by the slug-candidate loop above). Try a
              // permissive version finder for EACH name variant before
              // falling back to URL-only. Reuse the HTML we already
              // fetched.
              const text = stripHtml(workingHtml);
              let loose = null;
              for (const variant of nameVariants(it.name || '')) {
                const candidate = findVersionInTextLoose(text, variant);
                if (candidate && candidate.version && candidate.regex) {
                  loose = candidate;
                  break;
                }
              }
              if (loose && loose.version && loose.regex) {
                newAdditions[k] = {
                  updateUrl: workingUrl,
                  versionRegex: loose.regex,
                  addedAt: new Date().toISOString(),
                  addedBy: 'sibling-template-loose',
                };
                foundCount++;
              } else {
                // Page exists and mentions the name but no version
                // we can recognize. Save URL-only ONLY when the
                // plugin isn't already managed by a companion app —
                // otherwise we'd drop the Companion-app-only status
                // (which the user expects) in favor of Check-
                // manually. For companion-managed plugins we skip
                // the save entirely; the companion handles updates.
                const isCompanionManaged = !!(it.registry && it.registry.companionApp);
                if (!isCompanionManaged) {
                  newAdditions[k] = {
                    updateUrl: workingUrl,
                    versionRegex: null,
                    addedAt: new Date().toISOString(),
                    addedBy: 'sibling-template-url-only',
                  };
                  urlOnlyCount++;
                }
              }
            }
          } catch { /* ignore */ }
        }
        done++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, siblings.length) }, () => worker()),
    );

    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...(existing.userRegistryAdditions || {}), ...newAdditions };
    await patchCache({ userRegistryAdditions: merged });
    sendToRenderer('progress:tryTemplate', {
      phase: 'tryTemplate', current: total, total,
      message: `Found ${foundCount} with versions, ${urlOnlyCount} URL-only, of ${total} tried.`,
    });
    return {
      ok: true,
      data: { total, foundCount, urlOnlyCount, additions: newAdditions, mergedAdditions: merged },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
// Apply the SAME URL + regex to every sibling — used when the seed
// plugin's saved URL doesn't contain its name (and therefore can't
// produce a per-product template). Common with vendors that ship a
// single shared changelog page (Kilohearts, some Slate products, etc.)
// where every plugin from that developer shares the exact same
// release schedule and version number.
ipcMain.handle('updates:applySharedSource', async (_event, { addition, siblings }) => {
  console.log(`[applySharedSource] called with addition.updateUrl=${addition && addition.updateUrl}, siblings.length=${Array.isArray(siblings) ? siblings.length : 'NOT-ARRAY'}`);
  try {
    if (!addition || !addition.updateUrl || !Array.isArray(siblings) || siblings.length === 0) {
      console.log('[applySharedSource] early-return: missing addition or siblings');
      return { ok: true, data: { savedCount: 0, total: 0, mergedAdditions: null } };
    }
    const newAdditions = {};
    let skipped = 0;
    for (const it of siblings) {
      const k = it.identifier || it.id;
      if (!k) { skipped++; continue; }
      newAdditions[k] = {
        updateUrl: addition.updateUrl,
        versionRegex: addition.versionRegex || null,
        addedAt: new Date().toISOString(),
        addedBy: 'shared-dev-source',
      };
    }
    console.log(`[applySharedSource] built ${Object.keys(newAdditions).length} additions (skipped ${skipped} with no key)`);
    const existing = (await loadCache(userDataDir())) || {};
    const merged = { ...(existing.userRegistryAdditions || {}), ...newAdditions };
    await patchCache({ userRegistryAdditions: merged });
    console.log(`[applySharedSource] saved. total userRegistryAdditions now: ${Object.keys(merged).length}`);
    return {
      ok: true,
      data: {
        total: siblings.length,
        savedCount: Object.keys(newAdditions).length,
        additions: newAdditions,
        mergedAdditions: merged,
      },
    };
  } catch (err) {
    console.warn('[applySharedSource] error:', err && err.message);
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Persist the user's consent choice for community sharing.
//   'unknown' → ask once after the next successful auto-discovery
//   'allowed' → auto-submit going forward
//   'denied'  → never submit
ipcMain.handle('community:setConsent', async (_event, consent) => {
  try {
    const allowed = ['unknown', 'allowed', 'denied'];
    const next = allowed.includes(consent) ? consent : 'unknown';
    await patchCache({ communityShareConsent: next });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Launch a companion app (Native Access, Waves Central, etc.).
//
// We try methods in increasing order of fragility:
//   1. `open -b <bundleId>` — most reliable when we have a verified bundle
//      identifier. Works regardless of where the app is installed.
//   2. `open -a "<Name>"` — macOS Launch Services looks up the app by its
//      display name, again regardless of install location. This is what
//      Spotlight does internally.
//   3. Literal path fallback (legacy; the path lookup can be wrong if a
//      vendor changed their installer's location between versions).
//
// We try them serially and return the first success. If all fail, we
// surface a "not installed" error to the renderer.
const { execFile } = require('node:child_process');
function tryOpen(args) {
  return new Promise((resolve) => {
    execFile('open', args, (err, stdout, stderr) => {
      const text = (stderr || '').toString();
      // open exits non-zero if the bundle can't be found.
      if (err || /Unable to find application/.test(text)) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Convert a stubborn .icns to PNG via macOS sips, return a data URL.
// Electron's nativeImage.createFromPath returns empty for many modern
// .icns formats (ic07/ic08 ARGB-compressed icons used by Apple, NI,
// Ableton, FL Studio etc.). sips is a built-in macOS tool that always
// works because it uses CoreGraphics under the hood.
function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}
async function icnsToDataUrlViaSips(icnsPath) {
  try {
    const tmp = require('node:os').tmpdir();
    const out = path.join(tmp, `plugr-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    await execFileP('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '256', icnsPath, '--out', out]);
    const img = nativeImage.createFromPath(out);
    fspEarly.unlink(out).catch(() => {});
    if (!img || img.isEmpty()) return null;
    return img.toDataURL();
  } catch { return null; }
}

// Read an .app bundle's real icon from disk. macOS apps store their
// icons in a few different shapes:
//   1. Modern .icns (decodes via sips because Electron NativeImage
//      can't handle ic07/ic08 ARGB formats).
//   2. PNG files in Resources/ (Electron-based apps like iZotope).
//   3. As a last resort, Electron's app.getFileIcon (slow + sometimes
//      returns generic, but better than nothing).
// Resolve the actual on-disk path of an .app bundle when the registry's
// hardcoded path doesn't exist. Uses macOS Spotlight (mdfind) — fast,
// no network, returns paths to bundles indexed at any location.
// Strategy: try the original path, then mdfind by bundle ID (most
// reliable), then mdfind by display name.
const __pathResolveCache = new Map();
async function resolveAppPath(originalPath, bundleId, displayName) {
  if (!originalPath && !bundleId && !displayName) return null;
  const cacheKey = `${originalPath}|${bundleId}|${displayName}`;
  if (__pathResolveCache.has(cacheKey)) return __pathResolveCache.get(cacheKey);
  // 1. Try the registry path as-is.
  if (originalPath) {
    try { await fspEarly.access(originalPath); __pathResolveCache.set(cacheKey, originalPath); return originalPath; }
    catch { /* fall through */ }
  }
  // 2. Spotlight by bundle ID — most reliable when present.
  if (bundleId) {
    try {
      const { stdout } = await execFileP('/usr/bin/mdfind', ['-onlyin', '/Applications', `kMDItemCFBundleIdentifier == "${bundleId}"`]);
      const first = stdout.split('\n').map((s) => s.trim()).find(Boolean);
      if (first) { __pathResolveCache.set(cacheKey, first); console.log('[icon] resolved via bundleId:', bundleId, '→', first); return first; }
    } catch { /* fall through */ }
  }
  // 3. Spotlight by exact display name.
  if (displayName) {
    try {
      const { stdout } = await execFileP('/usr/bin/mdfind', ['kMDItemDisplayName == "' + displayName + '"', '-onlyin', '/Applications']);
      const first = stdout.split('\n').map((s) => s.trim()).find((p) => p.endsWith('.app'));
      if (first) { __pathResolveCache.set(cacheKey, first); console.log('[icon] resolved via name:', displayName, '→', first); return first; }
    } catch { /* fall through */ }
  }
  // 4. Filesystem find as fallback. Some apps (Slate Digital Connect,
  // PA-InstallationManager, others installed via custom installers) aren't
  // indexed by Spotlight. We previously used `osascript path to application`
  // here, but that goes through LaunchServices and CAN trigger the app to
  // launch as a side effect (observed with Kilohearts Installer on macOS).
  // /usr/bin/find is purely filesystem — it cannot launch anything.
  // Bounded depth keeps it fast on /Applications even with nested folders.
  if (displayName) {
    try {
      const exact = `${displayName}.app`;
      const { stdout } = await execFileP('/usr/bin/find', [
        '/Applications', '-maxdepth', '4', '-name', exact, '-type', 'd', '-print', '-quit'
      ], { timeout: 4000 });
      const resolved = stdout.trim().replace(/\/$/, '');
      if (resolved && resolved.endsWith('.app')) {
        __pathResolveCache.set(cacheKey, resolved);
        console.log('[icon] resolved via find:', displayName, '→', resolved);
        return resolved;
      }
    } catch { /* fall through */ }
  }

  // 5. Fuzzy filename search — mdfind -name handles cases where the registry's
  // display name has punctuation that doesn't match Spotlight's index
  // (e.g. "FLUX:: Center" vs "FLUX Center.app"). We clean the query and pick
  // the shortest-named match (closest length to the target).
  if (displayName) {
    try {
      const cleaned = displayName.replace(/[^\w\s]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned) {
        const { stdout } = await execFileP('/usr/bin/mdfind', ['-name', cleaned]);
        const candidates = stdout.split('\n').map((s) => s.trim()).filter((p) => p.endsWith('.app'));
        if (candidates.length > 0) {
          // Score: prefer .app names that contain ALL cleaned tokens as substrings.
          const tokens = cleaned.toLowerCase().split(/\s+/);
          const scored = candidates.map((p) => {
            const name = path.basename(p, '.app').toLowerCase();
            let hits = 0;
            for (const t of tokens) if (name.includes(t)) hits++;
            return { p, hits, lenDelta: Math.abs(name.length - cleaned.length) };
          }).sort((a, b) => (b.hits - a.hits) || (a.lenDelta - b.lenDelta));
          const best = scored[0];
          if (best && best.hits > 0) {
            __pathResolveCache.set(cacheKey, best.p);
            console.log('[icon] resolved via fuzzy:', displayName, '→', best.p);
            return best.p;
          }
        }
      }
    } catch { /* fall through */ }
  }
  __pathResolveCache.set(cacheKey, null);
  return null;
}

async function readAppIcnsDataUrl(appBundlePath) {
  try {
    if (!appBundlePath || !appBundlePath.endsWith('.app')) return null;
    const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources');
    let entries = [];
    try { entries = await fspEarly.readdir(resourcesDir); }
    catch { console.log('[icon] no Resources dir:', appBundlePath); return null; }

    // Pass 1 — .icns: try every .icns in Resources/, starting with the
    // most likely candidate. If NativeImage can't decode it, fall back
    // to sips (which uses CoreGraphics under the hood and decodes
    // anything macOS knows how to render).
    const icns = entries.filter((f) => f.toLowerCase().endsWith('.icns'));
    if (icns.length > 0) {
      // Build a try-order: preferred names first, then everything else.
      const score = (f) => {
        if (/^appicon\.icns$/i.test(f)) return 4;
        if (/^icon\.icns$/i.test(f)) return 3;
        if (/app/i.test(f)) return 2;
        if (/icon/i.test(f)) return 1;
        return 0;
      };
      const ordered = [...icns].sort((a, b) => score(b) - score(a));
      for (const name of ordered) {
        const icnsPath = path.join(resourcesDir, name);
        const img = nativeImage.createFromPath(icnsPath);
        if (img && !img.isEmpty()) {
          console.log('[icon] OK (icns):', appBundlePath, '→', name);
          return img.toDataURL();
        }
        const viaSips = await icnsToDataUrlViaSips(icnsPath);
        if (viaSips) {
          console.log('[icon] OK (icns via sips):', appBundlePath, '→', name);
          return viaSips;
        }
      }
      console.log('[icon] all icns failed:', appBundlePath, ordered);
    }

    // Pass 2 — PNG icons. Prefer square names (icon.png) over wordmark/
    // banner names (logo_large.png is often a wide wordmark, not a square
    // app icon).
    const pngs = entries.filter((f) => /\.png$/i.test(f));
    if (pngs.length > 0) {
      const preferred =
        pngs.find((f) => /^appicon\.png$/i.test(f)) ||
        pngs.find((f) => /^icon\.png$/i.test(f)) ||
        pngs.find((f) => /^app\.png$/i.test(f)) ||
        pngs.find((f) => /^logo\.png$/i.test(f)) ||
        pngs.find((f) => /icon/i.test(f) && !/menu/i.test(f)) ||
        pngs.find((f) => /^logo/i.test(f));
      if (preferred) {
        const img = nativeImage.createFromPath(path.join(resourcesDir, preferred));
        if (img && !img.isEmpty()) {
          console.log('[icon] OK (png):', appBundlePath, '→', preferred);
          return img.toDataURL();
        }
      }
    }

    // Pass 3 — Electron's getFileIcon as last resort.
    try {
      const img = await app.getFileIcon(appBundlePath, { size: 'large' });
      if (img && !img.isEmpty()) {
        const sz = img.getSize();
        if (sz && sz.width >= 32 && sz.height >= 32) {
          console.log('[icon] OK (getFileIcon):', appBundlePath, sz.width + 'x' + sz.height);
          return img.toDataURL();
        }
      }
    } catch { /* fall through */ }

    console.log('[icon] no icon found:', appBundlePath);
    return null;
  } catch (err) {
    console.log('[icon] outer error:', appBundlePath, err.message);
    return null;
  }
}

// Extract the icon of a macOS .app bundle (or any file) and return it
// as a base64 data URL. Used by the Companion Apps tab to display real
// vendor logos without us having to ship them. Cached in main-process
// memory since icons rarely change between launches.
const __iconCache = new Map();
ipcMain.handle('shell:getFileIcon', async (_event, payload) => {
  try {
    // Accept either a plain string path (legacy) or a descriptor
    // { path, bundleId, name } so we can fall back to Spotlight lookup
    // when the path is wrong.
    let filePath, bundleId, displayName, legacyNames;
    if (typeof payload === 'string') { filePath = payload; }
    else if (payload && typeof payload === 'object') {
      filePath = payload.path; bundleId = payload.bundleId; displayName = payload.name || payload.displayName;
      legacyNames = Array.isArray(payload.legacyNames) ? payload.legacyNames : [];
    }
    if (!filePath && !bundleId && !displayName) return { ok: false, error: 'no input' };
    const cacheKey = filePath || bundleId || displayName;
    if (__iconCache.has(cacheKey)) {
      const v = __iconCache.get(cacheKey);
      return v ? { ok: true, dataUrl: v } : { ok: false, error: 'cached-miss' };
    }
    // Locate the actual app on disk. Try the current name first; if
    // that fails, fall through to each legacyName so renamed apps
    // (Slate Digital Connect → Complete Access Hub, etc.) still resolve
    // for users who haven't migrated to the new installer.
    let resolved = await resolveAppPath(filePath, bundleId, displayName);
    if (!resolved && legacyNames) {
      for (const alt of legacyNames) {
        resolved = await resolveAppPath(null, null, alt);
        if (resolved) {
          console.log('[icon] resolved via legacy name:', alt, '→', resolved);
          break;
        }
      }
    }
    if (!resolved) {
      __iconCache.set(cacheKey, null);
      console.log('[icon] could not locate:', { filePath, bundleId, displayName });
      return { ok: false, error: 'not-found' };
    }
    const dataUrl = await readAppIcnsDataUrl(resolved);
    if (!dataUrl) {
      __iconCache.set(cacheKey, null);
      return { ok: false, error: 'no-icns' };
    }
    __iconCache.set(cacheKey, dataUrl);
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Resolve the user's installed DAW app paths and extract their icons.
// We look in /Applications and ~/Applications, matching common DAW
// installer naming patterns. Returns { ableton, logic, flstudio } where
// each value is a data URL or null. Cached in memory after first call.
let __dawIconsCache = null;
ipcMain.handle('daw:getIcons', async () => {
  if (__dawIconsCache) return { ok: true, icons: __dawIconsCache };
  const home = require('node:os').homedir();
  const searchDirs = ['/Applications', path.join(home, 'Applications')];
  // Patterns: regex matches against the app filename (case-insensitive).
  const patterns = {
    ableton:  /^Ableton Live .*\.app$/i,
    logic:    /^Logic Pro( X)?\.app$/i,
    flstudio: /^FL Studio.*\.app$/i,
  };
  const found = { ableton: null, logic: null, flstudio: null };
  for (const dir of searchDirs) {
    let entries = [];
    try { entries = await fspEarly.readdir(dir); } catch { continue; }
    for (const name of entries) {
      for (const key of Object.keys(patterns)) {
        if (found[key]) continue;  // already located the highest one
        if (patterns[key].test(name)) {
          found[key] = path.join(dir, name);
        }
      }
    }
  }
  const icons = {};
  for (const key of ['ableton', 'logic', 'flstudio']) {
    if (!found[key]) { icons[key] = null; continue; }
    icons[key] = await readAppIcnsDataUrl(found[key]);
  }
  __dawIconsCache = icons;
  return { ok: true, icons };
});

ipcMain.handle('shell:openCompanionApp', async (_event, app) => {
  try {
    if (!app || (!app.bundleId && !app.name && !app.path)) {
      return { ok: false, error: 'no companion app info' };
    }
    if (app.bundleId) {
      const ok = await tryOpen(['-b', app.bundleId]);
      if (ok) return { ok: true, method: 'bundleId' };
    }
    if (app.name) {
      // open -a "Name" finds the app via Launch Services regardless of path.
      const ok = await tryOpen(['-a', app.name]);
      if (ok) return { ok: true, method: 'name' };
    }
    if (app.path) {
      const fs = require('node:fs');
      if (fs.existsSync(app.path)) {
        const result = await shell.openPath(app.path);
        if (!result) return { ok: true, method: 'path' };
      }
    }
    return {
      ok: false,
      error: `${app.name || 'Companion app'} doesn't appear to be installed.`,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Reveal the cache file in Finder (handy for "where is my data?")
ipcMain.handle('shell:openCacheFile', async () => {
  const file = cacheFilePath(userDataDir());
  shell.showItemInFolder(file);
  return { ok: true, file };
});

// CSV export — ask the user whether to include hidden plugins. We use a
// messageBox with a checkbox here (rather than asking inside the React
// app) so the experience matches the native macOS dialogs used by Reset
// Cache and Move to Trash. Returns { proceed, includeHidden }.
ipcMain.handle('dialog:askIncludeHidden', async () => {
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Export'],
      defaultId: 1,
      cancelId: 0,
      message: 'Export your library as CSV',
      detail:
        'One row per plugin, one column per piece of data — name, developer, category, version, update status, macOS compatibility, size on disk, and more. Open the file in Excel, Numbers, or Google Sheets.',
      checkboxLabel: 'Include hidden plugins',
      checkboxChecked: false,
    });
    return {
      ok: true,
      proceed: choice.response === 1,
      includeHidden: !!choice.checkboxChecked,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// CSV export — show a Save dialog and write the CSV content to the
// chosen file. Renderer is responsible for building the CSV string
// (it already has the merged item list with overrides applied).
ipcMain.handle('library:exportCsv', async (_event, payload) => {
  try {
    // Server-side gate — CSV export is a paid feature. Browsing the
    // library on screen stays free.
    const gate = await entitlements.requires(userDataDir(), 'csvExport');
    if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    const { csv, defaultFilename } = payload || {};
    if (typeof csv !== 'string' || !csv) {
      return { ok: false, error: 'No CSV content provided.' };
    }
    const suggested = (defaultFilename && String(defaultFilename)) || 'plugr-library.csv';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Library as CSV',
      defaultPath: suggested,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    // Prepend a UTF-8 BOM so Excel on Windows opens it as UTF-8 (Excel
    // assumes Windows-1252 otherwise, which mangles accented characters
    // in developer names). Mac apps tolerate the BOM fine.
    const fsp = require('node:fs/promises');
    await fsp.writeFile(result.filePath, '﻿' + csv, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Backup export — pulls a snapshot of all user-facing state (favorites,
// custom registry sources, project annotations, prefs, etc.) and writes
// it to a JSON file the user picks via the system save dialog. The
// caller's renderer never sees the data — main reads cache + project
// store directly so there's a single source of truth.
ipcMain.handle('backup:export', async () => {
  try {
    // Server-side gate — backup export is a paid feature.
    const dir = userDataDir();
    const gate = await entitlements.requires(dir, 'backupRestore');
    if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    const cache = (await loadCache(dir)) || {};
    const projectStore = (await loadProjectStore(dir)) || {};
    const backup = buildBackup(cache, projectStore);

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const suggested = `plugr-backup-${stamp}.json`;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Plugr Backup',
      defaultPath: suggested,
      filters: [{ name: 'Plugr Backup (JSON)', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    await writeBackupFile(result.filePath, backup);
    return { ok: true, path: result.filePath, summary: summarizeBackup(backup) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Backup import phase 1 — show an open dialog, parse the file, and
// return a summary the renderer can show in a confirmation modal. We
// do NOT apply anything yet; the renderer follows up with backup:apply
// only after the user confirms. Splitting this means the user gets a
// preview of "8 favorites, 23 projects, theme = dark…" before their
// existing state gets clobbered.
ipcMain.handle('backup:pickAndPreview', async () => {
  try {
    // Server-side gate — backup import is a paid feature.
    const gate = await entitlements.requires(userDataDir(), 'backupRestore');
    if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Plugr Backup',
      properties: ['openFile'],
      filters: [{ name: 'Plugr Backup (JSON)', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    const parsed = await readBackupFile(filePath);
    if (parsed.error) {
      return { ok: false, error: parsed.error };
    }
    return {
      ok: true,
      path: filePath,
      backup: parsed.backup,                    // returned so phase-2 doesn't re-read disk
      summary: summarizeBackup(parsed.backup),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Backup import phase 2 — apply the previewed backup. Renderer hands
// back the exact backup object it confirmed against, so there's no
// risk of TOCTOU (file changing between preview and apply).
ipcMain.handle('backup:apply', async (_event, backup) => {
  try {
    // Server-side gate — backup restore is a paid feature. Final
    // confirmation point after the renderer has already previewed.
    const dir = userDataDir();
    const gate = await entitlements.requires(dir, 'backupRestore');
    if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
    if (!backup || typeof backup !== 'object' || backup.plugrBackup !== true) {
      return { ok: false, error: 'Invalid backup payload.' };
    }
    await applyBackup(backup, dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Pick an installed Mac application — used when the user wants to point
// a plugin's developer at a companion app Plugr doesn't know about.
// Returns enough information to launch the app reliably (display name +
// bundle ID + on-disk path).
ipcMain.handle('shell:pickCompanionApp', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'Applications', extensions: ['app'] }],
      defaultPath: '/Applications',
      title: 'Choose a companion app',
      message: 'Pick the installer / license-manager app for this developer.',
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const appPath = result.filePaths[0];
    if (!appPath.endsWith('.app')) {
      return { ok: false, error: 'That doesn\'t look like a macOS .app bundle.' };
    }
    // Read the picked app's Info.plist for the display name + bundle ID.
    let displayName = require('node:path').basename(appPath, '.app');
    let bundleId = null;
    try {
      const { readBundleInfo } = require('./lib/plistParser.cjs');
      const info = await readBundleInfo(appPath);
      if (info) {
        displayName = info.name || displayName;
        bundleId = info.identifier || null;
      }
    } catch { /* fall back to filename-derived name */ }
    return {
      ok: true,
      data: {
        name: require('node:path').basename(appPath, '.app'),  // for `open -a "<name>"`
        displayName,
        bundleId,
        path: appPath,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Save a user-defined companion app for a developer. The override is
// keyed by developer name so it lights up the button on every plugin
// from that developer.
ipcMain.handle('overrides:setDevCompanion', async (_event, { developer, companion }) => {
  try {
    if (!developer) return { ok: false, error: 'no developer' };
    const existing = (await loadCache(userDataDir())) || {};
    const map = { ...(existing.userDeveloperCompanions || {}) };
    if (!companion) delete map[developer];
    else map[developer] = companion;
    await patchCache({ userDeveloperCompanions: map });
    return { ok: true, map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Show macOS' native folder picker. Used for the "add a custom scan
// folder" flow in the Library Locations settings tab.
ipcMain.handle('shell:pickFolder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a folder to add to Plugr',
      message: 'Pick any folder containing plugins or apps. Plugr will scan it on every library scan.',
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Reveal the developer registry file in Finder so power users can hand-edit.
ipcMain.handle('shell:openRegistryFile', async () => {
  const file = path.join(__dirname, 'lib', 'developerRegistry.json');
  shell.showItemInFolder(file);
  return { ok: true, file };
});

// Send a message from main → renderer (used by Help menu items).
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('shell:openInFinder', async (_event, fullPath) => {
  if (!fullPath) return { ok: false, error: 'no path' };
  shell.showItemInFolder(fullPath);
  return { ok: true };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (!url) return { ok: false, error: 'no url' };
  await shell.openExternal(url);
  return { ok: true };
});

// =================================================================
// Project scanning
// =================================================================
//
// Walks user-selected folders for DAW project files (.als / .alp /
// future .logicx / .flp), parses each one via the per-DAW parsers in
// electron/lib/projectScanners/, and stores the merged result in the
// `projectLibrary` cache slot. The renderer reads from that cache and
// computes the cross-references against the installed library.

const fsp = require('node:fs/promises');

/**
 * Stable per-file id based on the absolute path. Lets the renderer
 * dedupe rescans of the same project across sessions even if the
 * file's modtime/size changed.
 */
function projectIdFor(absPath) {
  let hash = 0;
  for (let i = 0; i < absPath.length; i++) {
    hash = (hash << 5) - hash + absPath.charCodeAt(i);
    hash |= 0;
  }
  return 'proj_' + (hash >>> 0).toString(36);
}

/**
 * Recursively find every file under `root` whose extension matches a
 * registered project parser. Bundle-style projects (.logicx — directory
 * masquerading as a file) are treated as terminals.
 *
 * Bounded by maxDepth so we never walk forever on weird symlink loops.
 * Skips a small list of folder names that are almost never user
 * project sources (Backups, node_modules, etc.).
 */
// Per-folder timeout in ms. Cloud-synced folders (Google Drive, OneDrive,
// Dropbox) can take *minutes* to enumerate a single directory when there
// are many cloud-only files, because each readdir round-trips to the
// daemon to populate metadata. Without a timeout the whole scan can hang
// forever. 20 seconds is generous for local disks and still bounded for
// cloud folders — better to skip a slow folder than freeze the app.
const READDIR_TIMEOUT_MS = 20000;

function readdirWithTimeout(dir, timeoutMs = READDIR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('readdir timed out (folder may be in cloud storage)');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    fsp.readdir(dir, { withFileTypes: true }).then((entries) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(entries);
    }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Recursively find every project file under `root`. Returns:
 *   { files: [{path, ext}], errors: [{dir, code, message}] }
 *
 * Errors are collected (not thrown) so a single unreadable subfolder
 * doesn't kill the whole scan. The caller can decide whether to surface
 * the error count to the user. Emits progress via the `onProgress`
 * callback as it walks — important for cloud folders where the walk
 * itself can take longer than the parse.
 */
async function findProjectFilesWithErrors(root, { maxDepth = 8, onProgress = null } = {}) {
  const out = [];
  const errors = [];
  let foldersWalked = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdirWithTimeout(dir);
    } catch (err) {
      errors.push({ dir, code: err.code || 'EUNKNOWN', message: String(err.message || err) });
      return;
    }
    foldersWalked += 1;
    if (onProgress) onProgress({ foldersWalked, lastDir: dir, found: out.length });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (PROJECT_SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const ext = path.extname(ent.name).toLowerCase();
      // Bundle projects (Logic .logicx) — treat the directory as the project.
      if (ent.isDirectory()) {
        if (PROJECT_PARSERS[ext]) {
          out.push({ path: full, ext });
        } else {
          await walk(full, depth + 1);
        }
      } else if (ent.isFile() && PROJECT_PARSERS[ext]) {
        out.push({ path: full, ext });
      }
    }
  }
  await walk(root, 0);
  return { files: out, errors, foldersWalked };
}

// Backwards-compatible wrapper for old call sites that just want the
// flat array of file paths (no error reporting).
async function findProjectFiles(root, maxDepth = 8) {
  const { files } = await findProjectFilesWithErrors(root, { maxDepth });
  return files;
}

// Detect whether a path lives in macOS CloudStorage (Google Drive,
// OneDrive, Dropbox, iCloud Drive). Used to warn the user upfront that
// scanning will be slow + may hit timeouts.
function isCloudStoragePath(p) {
  if (!p || typeof p !== 'string') return false;
  return p.includes('/Library/CloudStorage/')
      || p.includes('/Library/Mobile Documents/');
}

async function parseOneProject(filePath, win) {
  const ext = path.extname(filePath).toLowerCase();
  const def = PROJECT_PARSERS[ext];
  if (!def) return null;
  try {
    const data = await def.parse(filePath);
    return {
      id: projectIdFor(filePath),
      path: filePath,
      dawType: data.dawType || def.dawType,
      name: data.name || path.basename(filePath, path.extname(filePath)),
      lastModified: data.lastModified || null,
      lastScannedAt: new Date().toISOString(),
      plugins: data.plugins || [],
      totalPluginInstances: data.totalPluginInstances || 0,
      // Auto-discovered bounces — see electron/lib/projectScanners/
      // bounces.cjs for the three-tier heuristic. Users can also
      // add bounces manually via the projects:addManualBounce IPC
      // when auto-detect missed something or got it wrong; those
      // live in cache.projectBounceOverrides and are merged in the
      // renderer.
      bounces: data.bounces || [],
      // Project master tempo (BPM) and key (display string like
      // "C Major") when the DAW exposes them. null when the
      // project predates the feature (Live 11 and older don't
      // store a project-level key).
      tempo: typeof data.tempo === 'number' ? data.tempo : null,
      key: data.key || null,
      // User-facing DAW version string ("Ableton Live 12.0.5", "Logic
      // Pro 11.1.0", "FL Studio 21.2.3.4035"). Pulled by each parser
      // from the project file metadata. null when unknown.
      dawVersion: data.dawVersion || null,
    };
  } catch (err) {
    // Don't kill the whole scan for one bad file. Record an error
    // marker so the UI can surface it.
    return {
      id: projectIdFor(filePath),
      path: filePath,
      dawType: def.dawType,
      name: path.basename(filePath, path.extname(filePath)),
      lastModified: null,
      lastScannedAt: new Date().toISOString(),
      plugins: [],
      totalPluginInstances: 0,
      error: String(err && err.message || err),
    };
  }
}

/**
 * Scan a list of folders (and/or individual project files), parse
 * every project found, merge with whatever was already scanned, and
 * persist. Emits progress events on channel 'progress:projects' so
 * the renderer can show a progress bar like it does for library scans.
 */
async function runProjectScan({ folders = [], files = [], replaceExisting = false }) {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const emit = (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('progress:projects', payload);
  };

  // Collect every file path to parse. Track scan-time errors per folder
  // so we can surface them in a useful toast at the end (instead of the
  // old "silently scan returns 0 results" behavior, which was impossible
  // to diagnose).
  emit({ current: 0, total: 1, message: 'Finding project files…' });
  const found = [];
  const scanErrors = [];   // [{ folder, errors: [{dir, code, message}] }]
  const cloudFolders = []; // user-facing list of cloud-storage folders touched
  for (const f of folders) {
    if (isCloudStoragePath(f)) cloudFolders.push(f);
    const { files: list, errors } = await findProjectFilesWithErrors(f, {
      onProgress: ({ foldersWalked, lastDir, found: foundSoFar }) => {
        // Stream progress while walking — important for cloud folders
        // where each readdir can take many seconds. Without this the UI
        // sits on "Scanning projects… 0/1" forever.
        emit({
          current: 0,
          total: 1,
          message: `Scanning ${foldersWalked} folders · ${foundSoFar} projects found · ${path.basename(lastDir)}`,
        });
      },
    });
    for (const item of list) found.push(item.path);
    if (errors.length) scanErrors.push({ folder: f, errors });
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (PROJECT_PARSERS[ext]) found.push(f);
  }
  // De-dupe.
  const unique = [...new Set(found)];

  // Parse each one. Sequential for now — XML parsing of .als is fast
  // (few hundred ms even on big projects), and parallel I/O on the
  // same disk doesn't help much.
  const parsed = [];
  for (let i = 0; i < unique.length; i++) {
    emit({
      current: i,
      total: unique.length,
      message: `Scanning ${path.basename(unique[i])}…`,
    });
    const result = await parseOneProject(unique[i], win);
    if (result) parsed.push(result);
  }
  emit({ current: unique.length, total: unique.length, message: 'Done.' });

  // Merge with the existing projectLibrary entries (keyed by id, which
  // is path-derived). New scan results replace old ones for the same
  // path; everything else stays. Project data lives in its own file
  // (projectStore) — completely isolated from the main library cache
  // so writes to one never affect the other.
  const existingStore = (await loadProjectStore(userDataDir())) || {};
  const existingLib = (existingStore.projectLibrary) || { folders: [], projects: [], lastScannedAt: null };
  const folderSet = new Set([...(existingLib.folders || []), ...folders]);
  const scanTime = new Date().toISOString();

  // Build a set of paths we just successfully parsed — used to decide
  // which previously-known projects should be marked "missing".
  const parsedPaths = new Set(parsed.map((p) => p.path));

  // Helper: is a project's path "in scope" for THIS scan? It's in scope
  // if its path falls under one of the folders we're scanning right
  // now, OR if its path was explicitly listed in `files`. Otherwise it
  // belongs to a different folder we're not touching, and we should
  // leave its flags alone — we have no evidence about its status.
  const scopeFolders = [...folders];
  const scopeFiles = new Set(files);
  function isInScope(p) {
    if (!p || !p.path) return false;
    if (scopeFiles.has(p.path)) return true;
    return scopeFolders.some((f) => p.path === f || p.path.startsWith(f.endsWith('/') ? f : f + '/'));
  }

  let projectsList;
  if (replaceExisting) {
    // Even in replaceExisting mode we still flag freshly-parsed ones
    // with lastSeenAt so future scans can detect them going missing.
    projectsList = parsed.map((p) => ({ ...p, missing: false, lastSeenAt: scanTime }));
  } else {
    const byId = new Map();
    // 1. Seed the merged map with everything we already knew about.
    //    For projects that were IN SCOPE for this scan but didn't turn
    //    up in `parsed`, flag them as missing so the UI can show a
    //    "couldn't find this file" warning. Projects out of scope are
    //    left exactly as they were — no false-positive flags from a
    //    partial scan.
    for (const p of (existingLib.projects || [])) {
      if (isInScope(p) && !parsedPaths.has(p.path)) {
        byId.set(p.id, { ...p, missing: true });
      } else {
        // Out-of-scope or about to be overwritten by `parsed`. Keep
        // as-is; the parsed override happens in step 2.
        byId.set(p.id, p);
      }
    }
    // 2. Overlay freshly-parsed results — these are definitively
    //    present, so clear any stale `missing` flag and stamp lastSeenAt.
    for (const p of parsed) {
      byId.set(p.id, { ...p, missing: false, lastSeenAt: scanTime });
    }
    projectsList = [...byId.values()];
  }
  const projectLibrary = {
    folders: [...folderSet],
    projects: projectsList,
    lastScannedAt: scanTime,
  };
  await patchProjectStore(userDataDir(), { projectLibrary });
  // Bundle the library + diagnostic info so the renderer can show a
  // useful toast (e.g. "scanned 4 folders, 12 unreadable" instead of
  // silently completing with no feedback).
  return {
    projectLibrary,
    scanErrors,
    cloudFolders,
    projectCount: projectsList.length,
  };
}

// IPC: pick a folder of projects via the system dialog.
ipcMain.handle('projects:pickFolder', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a folder of DAW projects',
      message: 'Plugr will recursively find .als / .alp / .flp / .logicx project files in this folder.',
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return { ok: true, folder: res.filePaths[0] };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: run a scan over the given folders / files. Folders are walked
// recursively; files are parsed directly. Both lists are optional.
ipcMain.handle('projects:scan', async (_event, { folders = [], files = [], replaceExisting = false } = {}) => {
  try {
    const data = await runProjectScan({ folders, files, replaceExisting });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: drop the persisted project library. Useful if the user wants to
// start over or has reorganized their projects folder.
ipcMain.handle('projects:clear', async () => {
  try {
    await patchProjectStore(userDataDir(), { projectLibrary: null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: set the tag list for a single project. Empty array deletes the
// project's tag entry entirely so the store stays compact.
ipcMain.handle('projects:setTags', async (_event, { projectId, tags } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const cleaned = Array.isArray(tags)
      ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
      : [];
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectTags || {}) };
    if (cleaned.length === 0) delete map[projectId];
    else map[projectId] = cleaned;
    await patchProjectStore(userDataDir(), { projectTags: map });
    return { ok: true, projectTags: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: set the tier rating ('A'/'B'/'C'/'D'/'F') for a single
// project. Pass null to clear. Empty/invalid ratings clear too.
const VALID_RATINGS = new Set(['A', 'B', 'C', 'D', 'F']);
ipcMain.handle('projects:setRating', async (_event, { projectId, rating } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectRatings || {}) };
    const cleaned = typeof rating === 'string' ? rating.toUpperCase().trim() : null;
    if (!cleaned || !VALID_RATINGS.has(cleaned)) delete map[projectId];
    else map[projectId] = cleaned;
    await patchProjectStore(userDataDir(), { projectRatings: map });
    return { ok: true, projectRatings: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: set the manual key signature for a single project. Pass null
// or empty to clear. Only used as a display fallback — detected key
// from the project file always wins, so a re-scan that finds a real
// key will silently outvote any stored override. Lenient validation
// — we accept whatever the picker emits (e.g. "C minor", "F# major").
ipcMain.handle('projects:setKeyOverride', async (_event, { projectId, key } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectKeyOverrides || {}) };
    const cleaned = typeof key === 'string' ? key.trim() : null;
    if (!cleaned) delete map[projectId];
    else map[projectId] = cleaned;
    await patchProjectStore(userDataDir(), { projectKeyOverrides: map });
    return { ok: true, projectKeyOverrides: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: set the workflow status for a single project. Pass null to
// clear. Status IDs are validated against the user's customStatuses
// list (if customized) or the built-in defaults — but we don't enforce
// here because the renderer manages the canonical list; any unknown ID
// just won't render in the UI and the user can clear it.
ipcMain.handle('projects:setStatus', async (_event, { projectId, statusId } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectStatuses || {}) };
    const cleaned = typeof statusId === 'string' ? statusId.trim() : null;
    if (!cleaned) delete map[projectId];
    else map[projectId] = cleaned;
    await patchProjectStore(userDataDir(), { projectStatuses: map });
    return { ok: true, projectStatuses: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: replace the entire custom-status list (add/edit/remove). The
// renderer sends the full ordered list each time — simpler than
// individual add/edit/delete IPCs. Pass null/[] to revert to the
// built-in defaults.
ipcMain.handle('projects:setStatusList', async (_event, list) => {
  try {
    const cleaned = Array.isArray(list)
      ? list.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.label === 'string')
            .map((s) => ({
              id: String(s.id).trim().slice(0, 64),
              label: String(s.label).trim().slice(0, 80),
              color: typeof s.color === 'string' ? s.color.trim().slice(0, 24) : '#9aa0a6',
            }))
      : null;
    await patchProjectStore(userDataDir(), { customStatuses: cleaned });
    return { ok: true, customStatuses: cleaned };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: set free-form notes for a single project. Empty string drops
// the entry entirely so the store stays compact.
ipcMain.handle('projects:setNotes', async (_event, { projectId, notes } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectNotes || {}) };
    const cleaned = String(notes || '').trim();
    if (!cleaned) delete map[projectId];
    else map[projectId] = cleaned;
    await patchProjectStore(userDataDir(), { projectNotes: map });
    return { ok: true, projectNotes: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: open a "choose audio file" dialog so the user can manually
// attach a bounce file to a project. Returns the picked file's
// metadata so the renderer can add it via projects:setBounceOverrides.
ipcMain.handle('projects:pickBounceFile', async (_event, { projectPath } = {}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add bounce file(s)',
      filters: [
        { name: 'Audio files', extensions: ['wav', 'aif', 'aiff', 'mp3', 'flac', 'm4a', 'ogg', 'opus'] },
        { name: 'All files', extensions: ['*'] },
      ],
      defaultPath: projectPath ? path.dirname(projectPath) : undefined,
      message: 'Choose audio files to attach to this project as bounces.',
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    // Stat each picked file so we can persist the same metadata
    // shape that auto-discovery produces.
    const fsp = require('node:fs/promises');
    const files = [];
    for (const fp of result.filePaths) {
      try {
        const stat = await fsp.stat(fp);
        files.push({
          path: fp,
          name: path.basename(fp),
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
          source: 'manual',
        });
      } catch (e) {
        // Skip unreadable files but don't fail the whole pick.
      }
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: stat a list of file paths so the renderer can attach
// drag-and-dropped audio files as manual bounces. The HTML drop event
// gives us paths but not file size or mtime — stat'ing them here
// produces the same shape pickBounceFile returns so the rest of the
// pipeline (override merge, bounce list, waveform fetch) doesn't need
// to special-case the drop source. Audio-extension check is enforced
// here too so a wayward .als drop doesn't silently turn into a "bounce".
ipcMain.handle('projects:statBouncePaths', async (_event, { paths } = {}) => {
  try {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'no paths' };
    }
    const fsp = require('node:fs/promises');
    const AUDIO_EXTS = new Set(['.wav', '.aif', '.aiff', '.mp3', '.flac', '.m4a', '.ogg', '.opus']);
    const files = [];
    for (const fp of paths) {
      if (!fp || typeof fp !== 'string') continue;
      const ext = path.extname(fp).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      try {
        const stat = await fsp.stat(fp);
        if (!stat.isFile()) continue;
        files.push({
          path: fp,
          name: path.basename(fp),
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
          source: 'manual',
        });
      } catch {
        // Skip unreadable but don't fail the whole batch.
      }
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: replace the manual-bounce override entry for a project. The
// renderer sends the full { added, dismissed } shape; we just persist
// it. Pass an empty/null payload to clear all overrides for the
// project.
ipcMain.handle('projects:setBounceOverrides', async (_event, { projectId, overrides } = {}) => {
  try {
    if (!projectId) return { ok: false, error: 'no projectId' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const map = { ...(existing.projectBounceOverrides || {}) };
    const clean = overrides && (
      (Array.isArray(overrides.added) && overrides.added.length > 0) ||
      (Array.isArray(overrides.dismissed) && overrides.dismissed.length > 0)
    ) ? {
      added: Array.isArray(overrides.added) ? overrides.added : [],
      dismissed: Array.isArray(overrides.dismissed) ? overrides.dismissed : [],
    } : null;
    if (clean) map[projectId] = clean;
    else delete map[projectId];
    await patchProjectStore(userDataDir(), { projectBounceOverrides: map });
    return { ok: true, projectBounceOverrides: map };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: extract a waveform peaks array for a bounce file. Returns
// { peaks: [[min,max], ...], durationSeconds } where each peak is
// normalized to -1..1. Caches results on disk under
// userData/waveforms keyed by audio-path + size + mtime — so opening
// a project re-renders waveforms instantly from cache. The first
// invocation per bounce takes a few hundred ms (afconvert subprocess
// + WAV parse); subsequent ones are <1 ms.
const { getCachedPeaks: getWaveformPeaks } = require('./lib/waveform.cjs');
ipcMain.handle('bounces:getWaveform', async (_event, { path: audioPath } = {}) => {
  try {
    if (!audioPath || typeof audioPath !== 'string') {
      return { ok: false, error: 'no path' };
    }
    const data = await getWaveformPeaks(audioPath, userDataDir());
    if (!data) return { ok: false, error: 'file not readable' };
    return {
      ok: true,
      peaks: data.peaks,
      durationSeconds: data.durationSeconds,
      fromCache: data.fromCache,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// IPC: open a project file with the system default application.
// shell.openPath returns an empty string on success, error message
// otherwise — we surface either to the renderer.
ipcMain.handle('projects:openInDAW', async (_event, fullPath) => {
  try {
    if (!fullPath) return { ok: false, error: 'no path' };
    const result = await shell.openPath(fullPath);
    if (result) return { ok: false, error: result };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/// IPC: stop watching a folder. The caller passes
//   { folder, alsoRemoveProjects: bool }
// — when alsoRemoveProjects is false we leave the scanned projects
// in the library (so the user can still browse them, just without
// future rescans of that folder); when true we also drop every
// project whose path falls under the folder.
//
// Backwards-compat: a few legacy callsites invoke this with a bare
// `folder` string. We accept either shape so old preload bridges
// don't break.
ipcMain.handle('projects:removeFolder', async (_event, arg) => {
  try {
    const folder = typeof arg === 'string' ? arg : (arg && arg.folder);
    const alsoRemoveProjects = typeof arg === 'object' && arg !== null
      ? !!arg.alsoRemoveProjects
      : true;   // legacy default: remove both
    if (!folder) return { ok: false, error: 'no folder' };
    const existing = (await loadProjectStore(userDataDir())) || {};
    const lib = existing.projectLibrary;
    if (!lib) return { ok: true, projectLibrary: null };
    const folders = (lib.folders || []).filter((f) => f !== folder);
    const norm = folder.endsWith(path.sep) ? folder : folder + path.sep;
    const projects = alsoRemoveProjects
      ? (lib.projects || []).filter((p) => !p.path || (p.path !== folder && !p.path.startsWith(norm)))
      : (lib.projects || []);
    const next = { ...lib, folders, projects };
    await patchProjectStore(userDataDir(), { projectLibrary: next });
    return { ok: true, projectLibrary: next };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---------- IPC: auto-update ----------

ipcMain.handle('updater:getStatus',  () => autoUpdater.getStatus());
ipcMain.handle('updater:checkNow',   () => ({ ok: autoUpdater.checkNow() }));
ipcMain.handle('updater:install',    () => ({ ok: autoUpdater.quitAndInstall() }));

// ---------- IPC: licensing + trial + entitlements ----------

// Snapshot of the combined trial+license state. The renderer calls this
// on every mount + after any license action. Cheap (disk reads only).
ipcMain.handle('entitlements:snapshot', async () => {
  try {
    return { ok: true, data: await entitlements.snapshot(userDataDir()) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// User pasted a license key into Preferences → License.
// On success, returns the fresh entitlements snapshot.
ipcMain.handle('license:activate', async (_event, { licenseKey } = {}) => {
  try {
    const res = await licenseModule.activate(userDataDir(), licenseKey);
    if (!res.ok) return res;
    const snap = await entitlements.snapshot(userDataDir());
    return { ok: true, entitlements: snap };
  } catch (err) {
    return { ok: false, error: 'unknown', message: String(err && err.message || err) };
  }
});

// Force a validation pass — wired to a "Refresh" button in the License
// preferences so the user can verify they're connected to LemonSqueezy.
ipcMain.handle('license:validate', async () => {
  try {
    const res = await licenseModule.validate(userDataDir());
    const snap = await entitlements.snapshot(userDataDir());
    return { ok: res.ok, error: res.error, entitlements: snap };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// User clicked "Deactivate this device" / "Sign out" in Preferences →
// License. Frees the seat on LemonSqueezy so they can activate on a
// different Mac.
ipcMain.handle('license:deactivate', async () => {
  try {
    await licenseModule.deactivate(userDataDir());
    const snap = await entitlements.snapshot(userDataDir());
    return { ok: true, entitlements: snap };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Open the LemonSqueezy checkout in the user's default browser. The
// checkout URL is composed in the renderer (it's just a static link
// per tier), so this is just `shell.openExternal`. We keep it as an
// IPC so the renderer doesn't have to know about Electron's shell API.
ipcMain.handle('license:openCheckout', async (_event, { url } = {}) => {
  try {
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return { ok: false, error: 'invalid-url' };
    }
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
