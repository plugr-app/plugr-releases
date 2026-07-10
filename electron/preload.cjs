// Preload script — runs with access to Node, then exposes a tightly scoped
// API to the renderer via contextBridge. Renderer cannot touch fs / net
// directly; everything goes through these IPC calls.

const { contextBridge, ipcRenderer } = require('electron');

const MENU_CHANNELS = [
  'menu:scan',
  'menu:checkUpdates',
  'menu:scanProjects',
  'menu:exportCsv',
  'menu:exportBackup',
  'menu:importBackup',
  'menu:openCompanionApps',
  'menu:focusSearch',
  'menu:showTutorial',
  'menu:showHelp',
  'menu:openAlerts',
  'menu:cacheCleared',
];

contextBridge.exposeInMainWorld('pluginHub', {
  scanLibrary: (options) => ipcRenderer.invoke('library:scan', options),
  checkUpdates: (items) => ipcRenderer.invoke('updates:check', items),
  discoverUpdate: (item) => ipcRenderer.invoke('updates:discover', item),
  deriveSourceFromVersion: (payload) => ipcRenderer.invoke('updates:deriveFromVersion', payload),
  discoverAllUpdates: (items) => ipcRenderer.invoke('updates:discoverAll', items),
  tryTemplateForSiblings: (payload) => ipcRenderer.invoke('updates:tryTemplate', payload),
  applySharedSource: (payload) => ipcRenderer.invoke('updates:applySharedSource', payload),

  // CSV export — asks (via Electron dialog) whether to include hidden
  // plugins, returns { proceed, includeHidden }. Renderer then builds
  // the CSV string and calls exportCsv() to save it.
  askIncludeHidden: () => ipcRenderer.invoke('dialog:askIncludeHidden'),
  exportCsv: (payload) => ipcRenderer.invoke('library:exportCsv', payload),

  // Backup / restore — full snapshot of user-data (favorites, custom
  // registry sources, project annotations, prefs). Three-step import
  // flow: pick file → main returns parsed backup + summary → renderer
  // shows a confirm dialog → renderer calls applyBackup with the same
  // object it confirmed against.
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  pickAndPreviewBackup: () => ipcRenderer.invoke('backup:pickAndPreview'),
  applyBackup: (backup) => ipcRenderer.invoke('backup:apply', backup),

  // iCloud sync — toggle moves the library cache + project store
  // between Application Support and iCloud Drive. Other Macs running
  // Plugr with the same iCloud account pick it up automatically.
  getSyncStatus: () => ipcRenderer.invoke('sync:getStatus'),
  setSyncEnabled: (enabled) => ipcRenderer.invoke('sync:setEnabled', { enabled }),

  // Project scanning (Ableton .als/.alp; Logic + FL Studio coming).
  pickProjectFolder: () => ipcRenderer.invoke('projects:pickFolder'),
  scanProjects: (payload) => ipcRenderer.invoke('projects:scan', payload || {}),
  clearProjects: () => ipcRenderer.invoke('projects:clear'),
  // `opts` is { alsoRemoveProjects: bool } — controls whether the
  // projects that lived under `folder` get dropped from the library
  // too, or stay as browsable-but-no-longer-auto-rescanned entries.
  removeProjectFolder: (folder, opts) => ipcRenderer.invoke('projects:removeFolder', { folder, ...(opts || {}) }),
  setProjectTags: (projectId, tags) => ipcRenderer.invoke('projects:setTags', { projectId, tags }),
  setProjectNotes: (projectId, notes) => ipcRenderer.invoke('projects:setNotes', { projectId, notes }),
  setProjectRating: (projectId, rating) => ipcRenderer.invoke('projects:setRating', { projectId, rating }),
  setProjectStatus: (projectId, statusId) => ipcRenderer.invoke('projects:setStatus', { projectId, statusId }),
  setProjectKeyOverride: (projectId, key) => ipcRenderer.invoke('projects:setKeyOverride', { projectId, key }),
  setStatusList: (list) => ipcRenderer.invoke('projects:setStatusList', list),
  pickBounceFile: (projectPath) => ipcRenderer.invoke('projects:pickBounceFile', { projectPath }),
  statBouncePaths: (paths) => ipcRenderer.invoke('projects:statBouncePaths', { paths }),
  setBounceOverrides: (projectId, overrides) => ipcRenderer.invoke('projects:setBounceOverrides', { projectId, overrides }),
  getBounceWaveform: (audioPath) => ipcRenderer.invoke('bounces:getWaveform', { path: audioPath }),
  openProjectInDAW: (fullPath) => ipcRenderer.invoke('projects:openInDAW', fullPath),

  openInFinder: (fullPath) => ipcRenderer.invoke('shell:openInFinder', fullPath),
  openApp: (fullPath) => ipcRenderer.invoke('shell:openApp', fullPath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  trashItem: (fullPath) => ipcRenderer.invoke('shell:trashItem', fullPath),
  openCacheFile: () => ipcRenderer.invoke('shell:openCacheFile'),
  openRegistryFile: () => ipcRenderer.invoke('shell:openRegistryFile'),
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder'),
  pickCompanionApp: () => ipcRenderer.invoke('shell:pickCompanionApp'),
  setDevCompanion: (developer, companion) => ipcRenderer.invoke('overrides:setDevCompanion', { developer, companion }),

  loadCache: () => ipcRenderer.invoke('cache:load'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  setOverride: (id, patch) => ipcRenderer.invoke('overrides:set', { id, patch }),
  saveRegistryAddition: (key, addition) => ipcRenderer.invoke('registry:saveAddition', { key, addition }),
  clearUpdatesForIds: (ids) => ipcRenderer.invoke('updates:clearForIds', ids),
  getRegistryCompanionMap: () => ipcRenderer.invoke('registry:getCompanionMap'),
  setTutorialDismissed: (dismissed) => ipcRenderer.invoke('tutorial:setDismissed', dismissed),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  openCompanionApp: (app) => ipcRenderer.invoke('shell:openCompanionApp', app),
  getFileIcon: (filePath) => ipcRenderer.invoke('shell:getFileIcon', filePath),
  getDawIcons: () => ipcRenderer.invoke('daw:getIcons'),

  // Community-contribution APIs (opt-in)
  submitToCommunity: (addition) => ipcRenderer.invoke('community:submit', addition),
  fetchCommunityAdditions: (opts) => ipcRenderer.invoke('community:fetchAdditions', opts || {}),
  setCommunityConsent: (consent) => ipcRenderer.invoke('community:setConsent', consent),

  // Plugin-deal feed (Audio Plugin Deals RSS + future sources). Returns
  // cached items if fresh (<24h), otherwise refetches. Pass force:true
  // to bypass the TTL (e.g. a manual Refresh button in the Deals tab).
  getDeals: (force) => ipcRenderer.invoke('deals:get', { force: !!force }),
  // Save/unsave a deal to the user's wishlist. Pass the full deal so
  // we can re-render the card later even if the deal rotates off PB's
  // live page.
  setDealSaved: (id, deal, saved) => ipcRenderer.invoke('deals:setSaved', { id, deal, saved }),
  // Increment local click counter for a deal source. Diagnostic for
  // comparing against affiliate-network reported clicks.
  trackDealClick: (source, url) => ipcRenderer.invoke('deals:trackClick', { source, url }),
  // Hide / unhide a deal from the Deals tab. Persists across restarts.
  setDealDismissed: (id, dismissed) => ipcRenderer.invoke('deals:setDismissed', { id, dismissed }),
  // Clear ALL dismissed deals (Preferences > Clear hidden deals).
  clearDismissedDeals: () => ipcRenderer.invoke('deals:clearDismissed'),
  // Bump the "last opened the Deals tab" timestamp so the TabBar
  // "N new" badge clears. Pass an explicit ISO string to back-date.
  setDealsLastViewed: (at) => ipcRenderer.invoke('deals:setLastViewed', { at }),

  // Background-app prefs (menu-bar mode + launch-at-login). See
  // electron/main.cjs::applyBackgroundMode for the side-effects each
  // pref triggers. Both default to false until the user opts in.
  getBackgroundMode: () => ipcRenderer.invoke('app:getBackgroundMode'),
  setBackgroundMode: (patch) => ipcRenderer.invoke('app:setBackgroundMode', patch),

  // Push the current outdated-plugin list to the tray so it can show
  // a count badge and a live update list in the menu.
  traySetUpdates: (outdatedList) => ipcRenderer.send('tray:setUpdates', outdatedList),

  // Support — fetch support URL + whether bug reports are wired up,
  // and submit a bug report.
  getSupportConfig: () => ipcRenderer.invoke('support:getConfig'),
  submitBugReport: (report) => ipcRenderer.invoke('support:submitBug', report),

  // Subscribe to menu actions from the main process. Returns an unsubscribe fn.
  onMenuEvent: (handler) => {
    const wrapped = (event, channel, payload) => handler(channel, payload);
    const subs = MENU_CHANNELS.map((ch) => {
      const cb = (_e, payload) => handler(ch, payload);
      ipcRenderer.on(ch, cb);
      return () => ipcRenderer.removeListener(ch, cb);
    });
    return () => subs.forEach((u) => u());
  },

  // Subscribe to progress events.
  onProgress: (channel, handler) => {
    const allowed = ['progress:scan', 'progress:updates', 'progress:discoverAll', 'progress:tryTemplate', 'progress:projects', 'progress:deals'];
    if (!allowed.includes(channel)) return () => {};
    const cb = (_e, p) => handler(p);
    ipcRenderer.on(channel, cb);
    return () => ipcRenderer.removeListener(channel, cb);
  },

  // App metadata
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // ---------- Auto-update ----------
  // Status from electron-updater. Renderer mounts a listener on the
  // 'updater:status' channel and renders a toast when status changes
  // to 'available', 'downloading', 'downloaded', or 'error'.
  getUpdaterStatus: () => ipcRenderer.invoke('updater:getStatus'),
  checkForUpdates:  () => ipcRenderer.invoke('updater:checkNow'),
  installUpdate:    () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus:  (handler) => {
    const cb = (_e, payload) => handler(payload);
    ipcRenderer.on('updater:status', cb);
    return () => ipcRenderer.removeListener('updater:status', cb);
  },

  // ---------- Licensing + trial + entitlements ----------
  // `getEntitlements()` is what every paid-feature gate calls. It returns
  // a snapshot of trial+license merged into a single object — see
  // electron/lib/entitlements.cjs for the shape.
  getEntitlements: () => ipcRenderer.invoke('entitlements:snapshot'),
  activateLicense: (licenseKey) => ipcRenderer.invoke('license:activate', { licenseKey }),
  validateLicense: () => ipcRenderer.invoke('license:validate'),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivate'),
  // `openCheckout(url)` opens the LemonSqueezy hosted checkout page in
  // the user's default browser. The renderer composes the URL based on
  // which tier the user picked.
  openCheckout: (url) => ipcRenderer.invoke('license:openCheckout', { url }),
  // ---------- Deal alerts ----------
  // CRUD for user-defined watches that fire macOS notifications when
  // matching deals land. See electron/lib/dealAlerts.cjs for the data
  // model. Renderer subscribes to 'alerts:matched' to react to fresh
  // matches.
  listDealAlerts:   () => ipcRenderer.invoke('alerts:list'),
  addDealAlert:     (alert) => ipcRenderer.invoke('alerts:add', alert),
  removeDealAlert:  (id) => ipcRenderer.invoke('alerts:remove', id),
  updateDealAlert:  (id, patch) => ipcRenderer.invoke('alerts:update', { id, patch }),
  onDealAlertsMatched: (cb) => {
    const wrapper = (_e, payload) => cb(payload);
    ipcRenderer.on('alerts:matched', wrapper);
    return () => ipcRenderer.removeListener('alerts:matched', wrapper);
  },

  // ── Plugin file watcher (MacUpdater-style auto-detection) ──────────
  // Main process watches plugin directories for bundle changes and pushes
  // two events:
  //
  //   plugins:autoUpdated  — one or more installed plugins changed on disk.
  //     payload: { items: Item[], newPluginPaths: string[] }
  //     `items` are updated library items (same shape as scan results, with
  //     a new `version`). `newPluginPaths` are bundles that weren't in the
  //     library (newly installed — caller should offer a rescan).
  //
  //   plugins:fdaRequired  — a system-level plugin dir is inaccessible.
  //     No payload. Caller should show a toast explaining Full Disk Access
  //     and offering to open System Settings.
  onPluginsAutoUpdated: (cb) => {
    const wrapper = (_e, payload) => cb(payload);
    ipcRenderer.on('plugins:autoUpdated', wrapper);
    return () => ipcRenderer.removeListener('plugins:autoUpdated', wrapper);
  },
  onPluginsFdaRequired: (cb) => {
    const wrapper = () => cb();
    ipcRenderer.on('plugins:fdaRequired', wrapper);
    return () => ipcRenderer.removeListener('plugins:fdaRequired', wrapper);
  },

});