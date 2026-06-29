// Persistent JSON cache for the library and update results.
//
// Stored in Electron's per-app userData folder so it survives app restarts
// without polluting the repo. Atomic write: write to a tmp file in the same
// directory, then rename — guarantees we never end up with a half-written
// JSON file if the app crashes mid-write.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

// Bump CACHE_VERSION whenever the on-disk shape changes incompatibly.
//   v3 added userOverrides
//   v4 added userRegistryAdditions and tutorialDismissed
//   v5 added projectLibrary (DAW project scanning)
const CACHE_VERSION = 5;
const CACHE_FILENAME = 'library-cache.json';

function cacheFilePath(userDataDir) {
  return path.join(userDataDir, CACHE_FILENAME);
}

/**
 * @returns {Promise<{
 *   version: number,
 *   library: {items: Array, summary: object, scannedAt: string}|null,
 *   updates: object,         // id -> result
 *   updatesCheckedAt: string|null,
 * }|null>}
 */
async function loadCache(userDataDir) {
  const file = cacheFilePath(userDataDir);
  if (!fsSync.existsSync(file)) return null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.version !== CACHE_VERSION) {
      // Schema migration. Every bump so far has been ADDITIVE — new
      // optional fields, never a renamed or restructured one — so the
      // old data round-trips fine through the new schema. Earlier
      // versions of this function hand-listed which fields to
      // "salvage" and dropped everything else; that silently wiped
      // user data (most notably `updates`, which can take minutes to
      // rebuild via Check for Updates). We keep everything now, only
      // re-stamping the version + recording where we came from for
      // diagnostics.
      //
      // If a FUTURE version ever introduces a breaking change to a
      // specific field (rename, structural change), add an explicit
      // per-version handler here that transforms only that field —
      // don't go back to wholesale-drop-everything.
      return {
        ...data,
        version: CACHE_VERSION,
        _migratedFrom: data.version,
      };
    }
    return data;
  } catch (err) {
    console.warn('cache load failed', err.message);
    return null;
  }
}

async function saveCache(userDataDir, payload) {
  await fs.mkdir(userDataDir, { recursive: true });
  const file = cacheFilePath(userDataDir);
  const tmp = file + '.tmp';
  const data = {
    version: CACHE_VERSION,
    library: payload.library || null,
    updates: payload.updates || {},
    updatesCheckedAt: payload.updatesCheckedAt || null,
    userOverrides: payload.userOverrides || {},
    userRegistryAdditions: payload.userRegistryAdditions || {},
    tutorialDismissed: !!payload.tutorialDismissed,
    themePreference: payload.themePreference || 'auto',
    categorySort: payload.categorySort || 'count',
    developerSort: payload.developerSort || 'count',
    formatSort: payload.formatSort || 'count',
    customFolders: payload.customFolders || [],
    columnWidths: payload.columnWidths || null,
    compatFilter: payload.compatFilter || 'all',
    userDeveloperCompanions: payload.userDeveloperCompanions || {},
    userCategories: payload.userCategories || {},
    sidebarSectionOrder: payload.sidebarSectionOrder || null,
    sortBy: payload.sortBy || null,
    sortDir: payload.sortDir || null,
    view: payload.view || null,
    appView: payload.appView || null,
    // Which tab to open on app launch. Values:
    //   'library'   — always start on Plugins & Apps (default for new installs)
    //   'projects'  — always start on Projects
    //   'deals'     — always start on Deals
    //   'remember'  — use the last appView the user was on (legacy behaviour)
    defaultTab: payload.defaultTab || 'library',
    communityShareConsent: payload.communityShareConsent || 'unknown',
    communityAdditions: payload.communityAdditions || null,
    // Global bounce-playback volume (0..1). Persisting it means the
    // slider in the toolbar survives restarts. Default 0.8 matches the
    // renderer's AudioVolumeContext default so a fresh-install Plugr
    // doesn't read 0 (silence) on first open.
    audioVolume: typeof payload.audioVolume === 'number' ? payload.audioVolume : 0.8,
    // Plugin-deal feed cache. Shape: { items: Deal[], fetchedAt: ISO }.
    // Refetched at most every 24h; survives restarts so opening the
    // Deals tab on app start is instant.
    deals: payload.deals || null,
    // User's saved-for-later deals. Shape: { dealId: { id, url, title,
    // imageUrl, priceBadge, endsAt, savedAt } }. Kept separate from
    // `deals` so it isn't wiped on cache fetcherVersion bumps — this
    // is USER data and outlives any scraper redesign. Old entries are
    // garbage-collected client-side once they no longer appear in
    // fresh scrapes AND their endsAt has passed.
    savedDeals: payload.savedDeals || {},
    // Per-source outbound click counts. Shape:
    //   { 'Audio Plugin Deals': { total: 17, last30Days: ['2026-06-01', ...] },
    //     'Plugin Boutique':    { total: 9,  last30Days: [...] } }
    // Used as a diagnostic: if affiliate network reports fewer clicks
    // than Plugr counted, the gap is dedup/blocked-tracker rather than
    // a Plugr-side bug. last30Days is auto-pruned on each click.
    clickCounts: payload.clickCounts || {},
    // Per-deal rolling 180-day price history. Built up over many
    // refreshes so we can show "Lowest in N days / Lowest ever" badges
    // on cards. Survives fetcherVersion bumps because the data is
    // COLLECTED, not scraped (re-scraping the history is impossible).
    // Shape: { dealId: { samples: [{sale, regular, at:ISO}] } }.
    priceHistory: payload.priceHistory || {},
    // User-dismissed deals. Filtered out of every section in the Deals
    // tab. Shape: { dealId: { dismissedAt: ISO } }. Cleared from
    // Preferences > "Clear hidden deals". Auto-prunes nothing yet —
    // entries persist until cleared so a deal that re-appears later
    // stays hidden.
    dismissedDeals: payload.dismissedDeals || {},
    // Currency preference for the Deals tab. APD prices come tagged
    // USD; if currencyPref differs, they're converted using cached
    // exchangeRates. Default 'USD' for new installs.
    currencyPref: payload.currencyPref || 'USD',
    // Exchange rates cache. Refetched at most every 24h, falls back
    // to hardcoded approximations on network failure. Shape:
    //   { base: 'USD', rates: { USD: 1, EUR: 0.92, ... },
    //     fetchedAt: ISO, source: 'frankfurter' | 'fallback' }
    exchangeRates: payload.exchangeRates || null,
    // Project scanning: parsed DAW project files (Ableton .als, Logic
    // .logicx, FL Studio .flp). Shape:
    //   {
    //     folders: [string],          // root folders the user picked
    //     projects: [{                // one entry per parsed project
    //       id, path, dawType, name,
    //       lastModified, lastScannedAt,
    //       plugins: [{ name, identifier?, format?, count }],
    //     }],
    //     lastScannedAt: ISO timestamp,
    //   }
    projectLibrary: payload.projectLibrary || null,
    // Free-form tags on individual projects. Map projectId → string[].
    // Tags survive rescans because the id is path-derived (stable).
    projectTags: payload.projectTags || {},
    // Multi-line free-form notes per project. Map projectId → string.
    projectNotes: payload.projectNotes || {},
    // Manual bounce additions / dismissals. Auto-discovery has false
    // positives and misses — overrides let the user tune it per
    // project without rescanning. Shape:
    //   projectId → { added:[{ path, name, sizeBytes, mtime }], dismissed:[path] }
    projectBounceOverrides: payload.projectBounceOverrides || {},
    // Tier ratings per project. Shape: projectId → 'A'|'B'|'C'|'D'|'F'.
    // Lets users mark their best / worst projects for quick filtering.
    projectRatings: payload.projectRatings || {},
    // Workflow status per project. References a status id from
    // customStatuses below. Shape: projectId → statusId.
    projectStatuses: payload.projectStatuses || {},
    // User-overridden key signatures per project. Used when
    // auto-detection fails or the user disagrees with it. Shape:
    // projectId → key string like "Cmaj" / "F#min".
    projectKeyOverrides: payload.projectKeyOverrides || {},
    // User-defined workflow status pipeline. Each project's status
    // references one of these by id. Shape: [{id, label, color, order}].
    customStatuses: Array.isArray(payload.customStatuses) ? payload.customStatuses : [],
    // User-defined deal alerts. Watches for plugin/developer/keyword
    // matches that fire macOS notifications. See electron/lib/dealAlerts.cjs
    // for the data model and matcher.
    dealAlerts: Array.isArray(payload.dealAlerts) ? payload.dealAlerts : [],
    // Last time the user opened the Deals tab — used to compute the
    // "N new" badge on the TabBar. Bumped via the deals:setLastViewed
    // IPC when the user lands on the Deals tab.
    dealsLastViewedAt: typeof payload.dealsLastViewedAt === 'string' ? payload.dealsLastViewedAt : null,
    // Background-app behavior. Both off by default — the user has to
    // explicitly opt in to either, since "stays running after you
    // close the window" and "opens at login" are surprises if the
    // user didn't ask for them.
    //   runInMenuBar:  closing the window minimizes to a tray icon
    //                  instead of quitting. Deal-alert notifications
    //                  still fire while the window is closed.
    //   launchAtLogin: macOS login-item registration (delegated to
    //                  app.setLoginItemSettings on apply).
    runInMenuBar:  typeof payload.runInMenuBar === 'boolean' ? payload.runInMenuBar : false,
    launchAtLogin: typeof payload.launchAtLogin === 'boolean' ? payload.launchAtLogin : false,
    // User-hidden tabs (paid+trial feature). Array of tab ids the user
    // has chosen to hide from the TabBar. Renderer only honors this
    // when the tabVisibility entitlement is on — free + trial-expired
    // users see every tab regardless. The list is preserved across
    // entitlement downgrades so re-upgrading restores the prior setup
    // without making the user re-hide everything.
    hiddenTabs:    Array.isArray(payload.hiddenTabs) ? payload.hiddenTabs : [],
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
  return file;
}

async function clearCache(userDataDir) {
  const file = cacheFilePath(userDataDir);
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadCache, saveCache, clearCache, cacheFilePath, CACHE_VERSION };
