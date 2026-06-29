import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { naturalCompare } from './util/format.js';
import Toolbar, { VolumeControl } from './components/Toolbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import LibraryView from './components/LibraryView.jsx';
import UnmatchedReferencesList from './components/UnmatchedReferencesList.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import BulkEditPanel from './components/BulkEditPanel.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
// Import the developer registry directly so Vite hot-reloads it when
// edited. Going through IPC required restarting the Electron main
// process for changes to land — direct import avoids that entirely and
// guarantees the renderer always has the latest registry data.
import developerRegistry from '../electron/lib/developerRegistry.json';

// Build companion-app + alias maps once at module load. These are
// derived deterministically from the imported registry so any future
// JSON edits show up after a hot-reload.
const REGISTRY_COMPANIONS = (() => {
  const out = {};
  const collect = (table) => {
    for (const [name, dev] of Object.entries(table || {})) {
      if (dev && dev.companionApp) {
        out[name] = {
          companionApp: dev.companionApp,
          homepage: dev.homepage || null,
          supportUrl: dev.supportUrl || null,
          downloadsUrl: dev.downloadsUrl || null,
        };
      } else if (dev) {
        // Even without a companion, expose homepage so the renderer can
        // attach it to items that lack registry data.
        out[name] = {
          companionApp: null,
          homepage: dev.homepage || null,
          supportUrl: dev.supportUrl || null,
          downloadsUrl: dev.downloadsUrl || null,
        };
      }
    }
  };
  collect(developerRegistry.developers);
  collect(developerRegistry.appPublishers);
  return out;
})();

const REGISTRY_ALIASES = (() => {
  const out = {};
  for (const [variant, canonical] of Object.entries(developerRegistry.developerAliases || {})) {
    if (variant.startsWith('_')) continue;
    out[variant.toLowerCase().replace(/[\s ]+/g, ' ').trim()] = canonical;
  }
  return out;
})();
import EmptyState from './components/EmptyState.jsx';
import Tutorial from './components/Tutorial.jsx';
import HelpDialog from './components/HelpDialog.jsx';
// Release-prep components — trial countdown banner, buy/upgrade modal,
// auto-update notification toast. The license-section UI lives inside
// HelpDialog as a new tab (see PreferencesTab → LicenseSection there).
import TrialBanner from './components/TrialBanner.jsx';
import BuyDialog from './components/BuyDialog.jsx';
import UpdateToast from './components/UpdateToast.jsx';
import AlertsManager from './components/AlertsManager.jsx';
// Companion apps utility — single-click list of every detected
// installer app (Native Access, Waves Central, etc.) with Open buttons.
// Useful for batch update workflows.
import CompanionAppsView from './components/CompanionAppsView.jsx';
import DiscoverModal from './components/DiscoverModal.jsx';
import MirrorPickerModal from './components/MirrorPickerModal.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import ThemePicker from './components/ThemePicker.jsx';
import EasterEgg from './components/EasterEgg.jsx';
import Toasts from './components/Toasts.jsx';
import { buildLibraryCsv } from './lib/exportCsv.js';
import { buildProjectMatch, buildPerItemSummary } from './lib/projectMatcher.js';
import TabBar from './components/TabBar.jsx';
import ProjectsView, { AudioVolumeProvider } from './components/ProjectsView.jsx';
import DealsView from './components/DealsView.jsx';
import ToolsView from './components/ToolsView.jsx';

const FORMAT_LIST = ['VST3', 'AU', 'VST2', 'AAX', 'CLAP', 'App'];

const api = (typeof window !== 'undefined' && window.pluginHub) || {
  scanLibrary: async () => ({ ok: true, data: SAMPLE_LIBRARY }),
  checkUpdates: async () => ({ ok: true, data: { results: [], checkedAt: new Date().toISOString() } }),
  discoverUpdate: async () => ({ ok: true, data: { url: null, versionRegex: null, latestVersion: null, tried: [], message: 'Browser preview — discover only works in the desktop app.' } }),
  deriveSourceFromVersion: async () => ({ ok: false, error: 'Browser preview — version derivation only works in the desktop app.' }),
  discoverAllUpdates: async () => ({ ok: true, data: { total: 0, foundCount: 0, additions: {}, mergedAdditions: {} } }),
  openInFinder: async () => ({ ok: true }),
  openExternal: async (u) => { window.open(u, '_blank'); return { ok: true }; },
  trashItem: async () => ({ ok: true }),
  openCacheFile: async () => ({ ok: true }),
  openRegistryFile: async () => ({ ok: true }),
  pickFolder: async () => ({ ok: false, canceled: true }),
  pickCompanionApp: async () => ({ ok: false, canceled: true }),
  setDevCompanion: async () => ({ ok: true, map: {} }),
  openCompanionApp: async () => ({ ok: true }),
  askIncludeHidden: async () => ({ ok: true, proceed: false, includeHidden: false }),
  exportCsv: async () => ({ ok: false, error: 'browser-preview' }),
  pickProjectFolder: async () => ({ ok: false, canceled: true }),
  scanProjects: async () => ({ ok: false, error: 'browser-preview' }),
  clearProjects: async () => ({ ok: true }),
  removeProjectFolder: async () => ({ ok: true }),
  setProjectTags: async () => ({ ok: true }),
  setProjectNotes: async () => ({ ok: true }),
  setProjectRating: async () => ({ ok: true }),
  setProjectStatus: async () => ({ ok: true }),
  setProjectKeyOverride: async () => ({ ok: true }),
  getBounceWaveform: async () => ({ ok: false, error: 'no api' }),
  exportBackup: async () => ({ ok: false, error: 'no api' }),
  pickAndPreviewBackup: async () => ({ ok: false, error: 'no api' }),
  applyBackup: async () => ({ ok: false, error: 'no api' }),
  getSyncStatus: async () => ({ ok: true, enabled: false, available: false, currentPath: '', iCloudPath: '', localPath: '' }),
  setSyncEnabled: async () => ({ ok: true, enabled: false }),
  setStatusList: async () => ({ ok: true }),
  pickBounceFile: async () => ({ ok: false, canceled: true }),
  statBouncePaths: async () => ({ ok: false, files: [] }),
  setBounceOverrides: async () => ({ ok: true }),
  openProjectInDAW: async () => ({ ok: false, error: 'browser-preview' }),
  loadCache: async () => ({ ok: true, data: null }),
  clearCache: async () => ({ ok: true, cleared: true }),
  setOverride: async () => ({ ok: true, overrides: {} }),
  saveRegistryAddition: async () => ({ ok: true, additions: {} }),
  clearUpdatesForIds: async () => ({ ok: true, cleared: 0 }),
  setTutorialDismissed: async () => ({ ok: true }),
  setTheme: async () => ({ ok: true }),
  setPrefs: async () => ({ ok: true }),
  getRegistryCompanionMap: async () => ({ ok: true, data: { companions: {}, aliases: {} } }),
  onProgress: () => () => {},
  tryTemplateForSiblings: async () => ({ ok: true, data: { foundCount: 0, total: 0, mergedAdditions: null } }),
  applySharedSource: async () => ({ ok: true, data: { savedCount: 0, total: 0, mergedAdditions: null } }),
  submitToCommunity: async () => ({ ok: false, error: 'browser-preview' }),
  fetchCommunityAdditions: async () => ({ ok: true, data: null }),
  setCommunityConsent: async () => ({ ok: true }),
  getDeals: async () => ({ ok: true, data: { items: [], fetchedAt: null }, fromCache: false }),
  setDealSaved: async () => ({ ok: true, savedDeals: {} }),
  trackDealClick: async () => ({ ok: true }),
  setDealDismissed: async () => ({ ok: true, dismissedDeals: {} }),
  clearDismissedDeals: async () => ({ ok: true }),
  getSupportConfig: async () => ({ ok: true, supportUrl: null, bugReportEnabled: false }),
  submitBugReport: async () => ({ ok: false, error: 'browser-preview' }),
  onMenuEvent: () => () => {},
};

// Tiny helper for window-level drag-and-drop: returns true when a path
// looks like a DAW project file we can parse. Kept up here so the
// component body can short-circuit on dragover without rebuilding a
// regex on every event.
const KNOWN_PROJECT_EXTS = ['.als', '.alp', '.logicx', '.flp'];
function path_endsWithProjectExt(p) {
  const lower = (p || '').toLowerCase();
  return KNOWN_PROJECT_EXTS.some((ext) => lower.endsWith(ext));
}

// All available themes. System group first (auto/dark/light), then the
// named studio palettes alphabetically. `sub` is a short DAW-inspiration
// subtitle shown under the name in the theme picker — gives the user a
// recognizable anchor for what each abstract studio name actually
// represents.
export const THEMES = [
  { value: 'auto',  label: 'Auto (system)', sub: 'Follows macOS',   group: 'system' },
  { value: 'dark',  label: 'Dark',          sub: 'Plugr default',   group: 'system' },
  { value: 'light', label: 'Light',         sub: 'Bright + clean',  group: 'system' },
  // Studio palettes — no subtitles. Their names are intentionally
  // abstract and the preview tile communicates the look.
  { value: 'abalone',   label: 'Abalone',   group: 'daw' },
  { value: 'bitty',     label: 'Bitty',     group: 'daw' },
  { value: 'cubert',    label: 'Cubert',    group: 'daw' },
  { value: 'fruity',    label: 'Fruity',    group: 'daw' },
  { value: 'grim',      label: 'Grim',      group: 'daw' },
  { value: 'logical',   label: 'Logical',   group: 'daw' },
  { value: 'protea',    label: 'Protea',    group: 'daw' },
  { value: 'rationale', label: 'Rationale', group: 'daw' },
];

/** Apply a theme to the <html> element. Resolves 'auto' via matchMedia. */
function resolveAndApplyTheme(preference) {
  let resolved = preference;
  if (preference === 'auto') {
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    resolved = prefersLight ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * Renderer-side mirror of the scanner's case-folding pass. Even after
 * scanLibrary normalizes the case, a user override (or a stale cached
 * library) can re-introduce a different casing for the same developer.
 * Collapsing here means the sidebar never shows "Ujam" + "UJAM" as two
 * separate buckets.
 */
function foldCaseOnlyDevelopers(items) {
  const variantsByLower = new Map();
  for (const it of items) {
    const dev = it.developer;
    if (!dev || dev === 'Unknown') continue;
    const key = dev.toLowerCase();
    if (!variantsByLower.has(key)) variantsByLower.set(key, new Map());
    const m = variantsByLower.get(key);
    m.set(dev, (m.get(dev) || 0) + 1);
  }
  const canonicalByLower = new Map();
  for (const [lower, variants] of variantsByLower) {
    if (variants.size <= 1) continue;
    let best = null;
    for (const [name, count] of variants) {
      let score = count * 10;
      if (name === name.toUpperCase()) score -= 5;
      if (name === name.toLowerCase()) score -= 4;
      if (!best || score > best.score) best = { name, score };
    }
    canonicalByLower.set(lower, best.name);
  }
  if (canonicalByLower.size === 0) return items;
  return items.map((it) => {
    const dev = it.developer;
    if (!dev) return it;
    const canon = canonicalByLower.get(dev.toLowerCase());
    return canon && canon !== dev ? { ...it, developer: canon } : it;
  });
}

// Pre-compute a normalized lowercase-keyed companion lookup table once
// at module load. The keys collapse all whitespace + lowercase so
// "Native Instruments ", "native instruments", and "NATIVE INSTRUMENTS"
// all hit the same entry.
const LC_REGISTRY_COMPANIONS = (() => {
  const out = {};
  for (const [name, v] of Object.entries(REGISTRY_COMPANIONS)) {
    out[name.toLowerCase().replace(/[\s ]+/g, ' ').trim()] = { canonicalName: name, ...v };
  }
  return out;
})();

function resolveCompanionForDeveloper(rawDev) {
  if (!rawDev) return null;
  const norm = rawDev.toLowerCase().replace(/[\s ]+/g, ' ').trim();
  if (!norm) return null;
  // 1. Direct hit.
  if (LC_REGISTRY_COMPANIONS[norm]) return LC_REGISTRY_COMPANIONS[norm];
  // 2. Alias match — case-insensitive substring.
  for (const [variant, canonical] of Object.entries(REGISTRY_ALIASES)) {
    if (norm.includes(variant)) {
      const canonLc = canonical.toLowerCase().replace(/[\s ]+/g, ' ').trim();
      if (LC_REGISTRY_COMPANIONS[canonLc]) return LC_REGISTRY_COMPANIONS[canonLc];
    }
  }
  return null;
}

/**
 * Renderer-side companion-app + homepage lookup keyed by developer name.
 *
 * Runs on every render against the live REGISTRY_COMPANIONS map (built
 * from the imported developerRegistry.json). Vite hot-reloads the JSON
 * so registry edits take effect instantly — no IPC, no preload restart,
 * no Electron main-process restart.
 *
 * Critical for cases like:
 *   - Items where the scanner failed to attach companionApp (identifier
 *     prefix didn't match).
 *   - Items where the user manually overrode the developer to a name
 *     that IS in the registry (the override happens in the renderer
 *     and never re-runs the scanner-side enrichment).
 *   - Cached items from older builds where the registry didn't yet have
 *     entries for the relevant vendor.
 */
function applyRegistryCompanions(items) {
  return items.map((it) => {
    const reg = it.registry || {};
    if (reg.companionApp) return it;
    const entry = resolveCompanionForDeveloper(it.developer);
    if (!entry || !entry.companionApp) return it;
    return {
      ...it,
      registry: {
        ...reg,
        developer: reg.developer || it.developer,
        companionApp: entry.companionApp,
        homepage: reg.homepage || entry.homepage || null,
        supportUrl: reg.supportUrl || entry.supportUrl || null,
        downloadsUrl: reg.downloadsUrl || entry.downloadsUrl || null,
      },
    };
  });
}

function applyOverrides(items, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return items;
  return items.map((it) => {
    const o = overrides[it.id];
    if (!o) return it;
    const next = { ...it };
    if (o.favorite) next.favorite = true;
    // Hidden flag: user explicitly opted this plugin out of the normal
    // lists (uninstallers, helper apps, etc.). Surfaced only in the
    // "Hidden" sidebar bucket so they can unhide later.
    if (o.hidden) next.hidden = true;
    if (o.developer && o.developer.trim()) {
      next.developer = o.developer.trim();
      next.developerOverridden = true;
    }
    if (o.category) {
      next.category = o.category;
      // Allow explicit null/empty subcategory — that's how a user signals
      // "just the top-level category, no sub". Previously this fell back
      // to `o.category`, producing redundant "Effect / Effect" displays.
      next.subcategory = (o.subcategory && String(o.subcategory).trim()) ? o.subcategory : null;
      next.categoryOverridden = true;
    }
    if (Array.isArray(o.extraCategories) && o.extraCategories.length) {
      next.extraCategories = o.extraCategories;
    }
    // Free-text notes — user's personal scratch about this plugin. Empty
    // string means "no note" (we strip it before saving), so only
    // attach truthy values so item.notes stays falsy in the no-note case.
    if (o.notes && typeof o.notes === 'string' && o.notes.trim()) {
      next.notes = o.notes;
    }
    // Free-form tags — arbitrary labels like "vocal chain", "trap
    // drums". Used for grouping/filtering in the sidebar Tags
    // section. Stored as a string[] on the override; we lowercase
    // and dedupe on save so 'Trap', 'trap', 'trap ' collapse.
    if (Array.isArray(o.tags) && o.tags.length > 0) {
      next.tags = o.tags;
    }
    // Mirror updates from another plugin. Used when a plugin is a
    // sibling of another (Serum FX → Serum, After Effects Render
    // Engine → After Effects, etc.) — they share update releases
    // but the anchored regex on the parent's source page wouldn't
    // match the child's distinct name. Storing the parent's library
    // id here makes the renderer's update lookup borrow the parent's
    // result instead of running its own check.
    if (o.mirrorFromId && typeof o.mirrorFromId === 'string') {
      next.mirrorFromId = o.mirrorFromId;
    }
    // The "Looks like this might share updates with X — link them?"
    // suggestion banner in DetailPanel honors this flag. Stored in the
    // override (not derived) so it survives across sessions even if the
    // potential parent changes.
    if (o.dismissedMirrorSuggest) {
      next.dismissedMirrorSuggest = true;
    }
    return next;
  });
}

/**
 * Build a family key for cross-format propagation. Normalizes the plugin
 * name so cosmetic separator differences across formats — space vs
 * underscore vs hyphen vs dot — don't break the match. So:
 *   "Invisible Limiter" (VST3)  → "aomfactory|invisiblelimiter"
 *   "Invisible_Limiter" (AU)    → "aomfactory|invisiblelimiter"
 *   "FF Pro-Q 3"                → "fabfilter|ffproq3"
 * and the saved source propagates between them automatically.
 *
 * Returns null when developer or name are missing so the caller can skip.
 */
function familyKeyFor(it) {
  const dev = (it.developer || '').toLowerCase().trim();
  if (!dev || dev === 'unknown') return null;
  const name = (it.name || '').toLowerCase();
  // Strip ALL non-alphanumeric chars (spaces, _, -, ., :, etc.). This is
  // intentionally aggressive — separator inconsistency is the main reason
  // sibling propagation misses, and aggressive collapsing rarely false-
  // positives because the developer half of the key still has to match.
  const normName = name.replace(/[^a-z0-9]+/g, '');
  if (!normName) return null;
  return `${dev}|${normName}`;
}

/**
 * Merge user-saved registry additions on top of each item's `registry` field.
 *
 * Two-pass keying:
 *   1. Direct lookup by identifier (or id) — what we always did.
 *   2. Cross-format fallback: if a sibling plugin (same developer +
 *      normalized name) had a saved addition, propagate it. This way
 *      pointing the VST2 version of a plugin at the right source page
 *      also lights up the VST3, AU, AAX, and CLAP versions automatically.
 */
function applyRegistryAdditions(items, additions) {
  if (!additions || Object.keys(additions).length === 0) return items;

  // Build a (developer, normalized-name) → addition map from items that DO
  // have a direct addition. We do this in a first pass before applying so
  // any sibling item can pick it up regardless of scan order.
  const familyMap = new Map();
  for (const it of items) {
    const key = it.identifier || it.id;
    const add = additions[key];
    if (!add) continue;
    const familyKey = familyKeyFor(it);
    if (!familyKey) continue;
    if (!familyMap.has(familyKey)) familyMap.set(familyKey, add);
  }

  return items.map((it) => {
    const key = it.identifier || it.id;
    let add = additions[key];
    let viaFamily = false;
    if (!add) {
      const familyKey = familyKeyFor(it);
      if (familyKey) {
        add = familyMap.get(familyKey);
        viaFamily = !!add;
      }
    }
    if (!add) return it;
    return {
      ...it,
      registry: { ...(it.registry || {}), ...add },
      registryAddedByUser: true,
      registryAppliedViaSibling: viaFamily || undefined,
    };
  });
}

/**
 * Apply user-defined companion-app overrides per developer. When a user
 * has explicitly pointed Plugr at a companion app for a developer that
 * the registry didn't know about, every plugin from that developer
 * inherits the override.
 */
function applyDevCompanions(items, devCompanions) {
  if (!devCompanions || Object.keys(devCompanions).length === 0) return items;
  return items.map((it) => {
    const dev = it.developer || '';
    const comp = devCompanions[dev];
    if (!comp) return it;
    // If the registry already has a companion app, keep it; otherwise,
    // attach the user-defined one.
    if (it.registry && it.registry.companionApp) return it;
    return {
      ...it,
      registry: { ...(it.registry || {}), companionApp: comp },
      companionFromUser: true,
    };
  });
}

/**
 * Apply community-curated registry additions (lower priority than the
 * user's own additions, higher priority than the bundled registry).
 *
 * The data has the shape produced by community.cjs: an array of
 *   { key, updateUrl, versionRegex, ... } entries keyed by plugin
 * CFBundleIdentifier.
 */
function applyCommunityAdditions(items, communityData) {
  if (!communityData || !Array.isArray(communityData.entries) || communityData.entries.length === 0) {
    return items;
  }
  const byKey = new Map();
  for (const e of communityData.entries) byKey.set(String(e.key).toLowerCase(), e);
  return items.map((it) => {
    const id = (it.identifier || '').toLowerCase();
    if (!id) return it;
    const e = byKey.get(id);
    if (!e) return it;
    return {
      ...it,
      registry: {
        ...(it.registry || {}),
        updateUrl: it.registry && it.registry.updateUrl ? it.registry.updateUrl : e.updateUrl,
        versionRegex: it.registry && it.registry.versionRegex ? it.registry.versionRegex : e.versionRegex,
      },
      registryAddedByCommunity: !(it.registry && it.registry.updateUrl),
    };
  });
}


// Frozen — two behaviors based on the active transition:
//   • inactive  → bail out (the tab isn't visible, no point re-rendering)
//   • active (including switching IN) → let React reconcile normally.
//     ProjectsView is wrapped in React.memo(projectsPropsEqual) which
//     already skips the expensive 400-row render when only function
//     refs changed. We removed the old "switching IN → bail" shortcut
//     because it caused a bug: data that arrived while the tab was
//     hidden (e.g. a project scan that completed on the Library tab)
//     never flowed through to ProjectsViewInner, so the user saw a
//     stale empty state until restart.
const Frozen = React.memo(
  function Frozen({ children }) { return children; },
  (prev, next) => {
    // Tab is hidden — don't bother reconciling its subtree.
    if (!next.active) return true;
    // Active (or switching in) — let the re-render through.
    // ProjectsView's own memo comparator (projectsPropsEqual) handles
    // the "don't re-render if only handler refs changed" optimisation,
    // so tab switching is still fast when no real data changed.
    return false;
  }
);

// Style each tab wrapper as an absolutely-positioned overlay inside the
// shared tab area. All mounted tabs occupy the same rect; the active
// one is fully visible and interactive, the others are hidden via
// visibility + pointer-events. CRITICAL difference vs display:none:
// browsers don't re-layout when toggling visibility, so switching tabs
// no longer triggers a layout pass over thousands of rows / cards. The
// inactive tabs are also marked contain:strict so their subtree is
// isolated from the layout/paint scheduler entirely while hidden.
function tabStyle(isActive) {
  return {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
    visibility: isActive ? 'visible' : 'hidden',
    pointerEvents: isActive ? 'auto' : 'none',
    zIndex: isActive ? 1 : 0,
    contain: isActive ? 'none' : 'strict',
  };
}

export default function App() {
  const [library, setLibrary] = useState({ items: [], summary: null, scannedAt: null });
  const [updates, setUpdates] = useState({});
  const [updatesCheckedAt, setUpdatesCheckedAt] = useState(null);

  // Declared early because the effectiveUpdates memo below resolves
  // mirror links by reading directly from this map. (Moving the
  // declaration up avoids a temporal-dead-zone ReferenceError that
  // would otherwise crash the renderer on mount.)
  const [overrides, setOverrides] = useState({});

  // Effective updates: applies mirror-from-parent links on top of raw
  // `updates`. A plugin with item.mirrorFromId borrows its parent's
  // status / latestVersion / updateUrl wholesale, so siblings like
  // Serum FX → Serum stay in sync without needing their own scrape
  // (which wouldn't work anyway — the parent's source page anchors
  // the regex on the parent's name).
  //
  // Resolved lazily on read via a Map keyed by id. Memoized so we
  // only rebuild when updates or library identity changes.
  const effectiveUpdates = useMemo(() => {
    // Read mirror links straight out of `overrides`, not from items.
    // applyOverrides — which copies mirrorFromId onto each item — only
    // runs later in the displayedItems pipeline, so library.items here
    // never has the field yet. Iterating overrides directly bypasses
    // that ordering problem and means the count + filter buckets
    // refresh immediately when the user picks a parent.
    if (!overrides || Object.keys(overrides).length === 0) return updates;
    const items = (library && library.items) || [];
    const byId = new Map();
    for (const it of items) byId.set(it.id, it);
    const out = { ...updates };
    for (const [childId, o] of Object.entries(overrides)) {
      if (!o || !o.mirrorFromId) continue;
      const parentUpd = updates[o.mirrorFromId];
      if (!parentUpd) continue;
      const parent = byId.get(o.mirrorFromId);
      out[childId] = {
        ...parentUpd,
        mirroredFromId: o.mirrorFromId,
        mirroredFromName: parent ? parent.name : '',
      };
    }
    return out;
  }, [updates, overrides, library]);
  const [registryAdditions, setRegistryAdditions] = useState({});
  // Mirror state in a ref so async callbacks (notably performUndo, which
  // is invoked from a toast click 5+ seconds after the bulk action ran)
  // can read CURRENT additions instead of whatever was captured in the
  // closure when the callback was defined. Without this, the diff
  // calculation inside performUndo compares a stale "after" against the
  // snapshotted "before" and concludes nothing changed → no-op undo.
  const registryAdditionsRef = useRef({});
  useEffect(() => { registryAdditionsRef.current = registryAdditions; }, [registryAdditions]);
  const [tutorialDismissed, setTutorialDismissed] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);     // legacy single-error (still used by some inline cases)
  const [toasts, setToasts] = useState([]);     // [{ id, kind, title?, message, durationMs? }]
  const toastIdRef = useRef(0);

  // Push a transient floating toast. Always visible regardless of scroll.
  const pushToast = useCallback((toast) => {
    toastIdRef.current += 1;
    const t = { id: toastIdRef.current, kind: 'error', ...toast };
    setToasts((cur) => [...cur, t]);
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // ─── Entitlements (trial + license) ────────────────────────────────
  // Mirror of the main-process snapshot from electron/lib/entitlements.cjs.
  // Loaded on mount, re-loaded after any license action. Renderer gates
  // paid features off this — see `requirePaid()` helper below.
  const [entitlements, setEntitlements] = useState(null);
  const [buyDialogOpen, setBuyDialogOpen] = useState(false);
  // Quick-access list of all detected companion installer apps. Opened
  // from the Library menu and from a button next to "Find sources for
  // all unchecked" in the sidebar. Free for everyone — convenience
  // utility, no editing happens here.

  // Pull a fresh snapshot from main. Cheap (disk reads only) so we can
  // call it liberally. We also call it on every license-change action.
  const refreshEntitlements = useCallback(async () => {
    try {
      const res = await api.getEntitlements();
      if (res && res.ok) setEntitlements(res.data);
    } catch { /* tolerate */ }
  }, []);
  useEffect(() => { refreshEntitlements(); }, [refreshEntitlements]);

  // Helper used by paid-feature actions. Returns true if the user has
  // access; otherwise shows a toast pointing at the buy dialog and
  // returns false. Use like:
  //     if (!requirePaid('bulkOperations', 'bulk discover')) return;
  const requirePaid = useCallback((featureKey, friendlyLabel) => {
    if (!entitlements) return true;   // not loaded yet — allow optimistically; main also gates
    const feature = entitlements.features && entitlements.features[featureKey];
    if (feature === false) {
      pushToast({
        kind: 'warning',
        title: 'Subscribe to unlock',
        message: `${friendlyLabel || 'This feature'} is part of paid Plugr. Click Upgrade to see plans.`,
        durationMs: 8000,
        action: { label: 'Upgrade', onClick: () => setBuyDialogOpen(true) },
      });
      return false;
    }
    return true;
  }, [entitlements, pushToast]);

  // ─── Custom confirm dialog ─────────────────────────────────────────
  // Replaces window.confirm() for high-friction prompts (operations that
  // affect items the user didn't explicitly select). The dialog shows
  // clear YES/NO labels, defaults focus to NO, and styles YES red.
  // Usage: const yes = await requestConfirm({ title, body, ... });
  const [confirmDialogState, setConfirmDialogState] = useState(null);
  const confirmResolverRef = useRef(null);
  const requestConfirm = useCallback((config) => {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialogState(config);
    });
  }, []);
  const resolveConfirm = useCallback((answer) => {
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialogState(null);
    if (r) r(answer);
  }, []);

  // ─── Undo machinery ────────────────────────────────────────────────
  // Each bulk operation snapshots the prior overrides for every touched
  // id. Pushing an entry shows a toast with an "Undo" action; clicking
  // it restores the snapshot per-item via __clear + re-apply prior patch.
  // Single-slot for now (only the LAST bulk op is undoable) — keeps the
  // mental model simple.
  const undoOpRef = useRef(null);
  const performUndo = useCallback(async () => {
    const op = undoOpRef.current;
    if (!op) return;
    undoOpRef.current = null;

    // Branch 1: restore overrides (developer/category/favorite/hide/tags
    // /mirror — any per-plugin override field).
    if (Array.isArray(op.items) && op.items.length > 0) {
      setOverrides((cur) => {
        const next = { ...cur };
        for (const { id, prior } of op.items) {
          if (prior === undefined || prior === null) delete next[id];
          else next[id] = prior;
        }
        return next;
      });
      for (const { id, prior } of op.items) {
        try {
          await api.setOverride(id, { __clear: true });
          if (prior && typeof prior === 'object' && Object.keys(prior).length > 0) {
            await api.setOverride(id, prior);
          }
        } catch { /* per-item failure shouldn't abort the rest */ }
      }
    }

    // Branch 2: restore registryAdditions (saved update URL + regex
    // per plugin). Used by the "Apply to N more" sibling-template and
    // shared-source flows where the action writes additions for many
    // plugins at once. The snapshot is a full priorAdditions map; we
    // compute the diff and call saveRegistryAddition for each key
    // that needs to change.
    if (op.priorAdditions !== undefined) {
      const before = op.priorAdditions || {};
      // Read CURRENT additions from the ref. The closure capture of
      // `registryAdditions` is stale at undo-click time because the
      // bulk action just ran setRegistryAdditions and React hasn't
      // necessarily reconciled performUndo against the new state yet.
      const after = registryAdditionsRef.current || {};
      const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
      setRegistryAdditions(before);
      for (const k of allKeys) {
        const hadBefore = !!before[k];
        const hasAfter = !!after[k];
        if (hadBefore && !hasAfter) {
          // Was there, got removed by the action → restore it
          try { await api.saveRegistryAddition(k, before[k]); } catch {}
        } else if (!hadBefore && hasAfter) {
          // Wasn't there, got added by the action → remove it
          try { await api.saveRegistryAddition(k, null); } catch {}
        } else if (hadBefore && hasAfter) {
          // Changed → restore prior value (skip if identical)
          const sameUrl = before[k].updateUrl === after[k].updateUrl;
          const sameRegex = before[k].versionRegex === after[k].versionRegex;
          if (!sameUrl || !sameRegex) {
            try { await api.saveRegistryAddition(k, before[k]); } catch {}
          }
        }
      }
    }

    pushToast({
      kind: 'info',
      message: `Undid: ${op.label}.`,
      durationMs: 3500,
    });
  }, [pushToast]);
  /** Snapshot prior overrides for the given ids and stash for undo. */
  const recordUndoOp = useCallback((label, ids) => {
    if (!ids || ids.length === 0) return;
    const snapshot = ids.map((id) => ({
      id,
      prior: overrides[id] ? { ...overrides[id] } : undefined,
    }));
    undoOpRef.current = { label, items: snapshot };
  }, [overrides]);

  /** Snapshot the FULL registryAdditions map so undo can restore it
   *  wholesale after a bulk-applying action (sibling-template, shared
   *  source, bulk apply/remove source from BulkEditPanel, etc.). */
  const recordAdditionsUndo = useCallback((label) => {
    // Snapshot via the ref so the captured "before" reflects the live
    // state at call time, not a stale closure value.
    undoOpRef.current = { label, priorAdditions: { ...(registryAdditionsRef.current || {}) } };
  }, []);
  /** Push a success toast with an Undo action wired to performUndo. */
  const toastWithUndo = useCallback((message) => {
    pushToast({
      kind: 'success',
      message,
      action: { label: 'Undo', onClick: performUndo },
      durationMs: 8000,
    });
  }, [pushToast, performUndo]);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  // Live progress for scan / update-check ops. Reset to null when idle.
  const [progress, setProgress] = useState(null);   // { phase, current, total, message }

  // Theme + sidebar sort preferences
  const [themePreference, setThemePreference] = useState('auto');
  const [categorySort, setCategorySort] = useState('count');         // 'count' | 'alpha'
  const [developerSort, setDeveloperSort] = useState('count');
  const [formatSort, setFormatSort] = useState('count');
  const [customFolders, setCustomFolders] = useState([]);
  const [columnWidths, setColumnWidths] = useState(null);    // null = use defaults
  const [devCompanions, setDevCompanions] = useState({});    // { [developerName]: companionApp }
  // User-defined categories. Shape: { [categoryName]: string[] of subcategories }.
  // Empty arrays are fine — that just means a custom top-level category
  // with no subcategories yet. Persisted via prefs:set so they survive
  // restarts.
  const [userCategories, setUserCategories] = useState({});
  // User's preferred order of sidebar sections. null = use defaults.
  const [sidebarSectionOrder, setSidebarSectionOrder] = useState(null);
  // Live registry → companion-app map, loaded from main on app start.
  // Used to apply companionApp / homepage to items in the renderer based
  // on the FINAL displayed developer name (after user overrides, case
  // folding, etc.) — without this, edits don't pull in the registry data.
  const [registryEnrichment, setRegistryEnrichment] = useState({ companions: {}, aliases: {} });

  // Community contribution state
  const [communityAdditions, setCommunityAdditions] = useState(null);   // { entries, fetchedAt }
  // Wishlist: user's saved deals from the Deals tab. Map of dealId →
  // snapshot ({ url, title, imageUrl, priceBadge, endsAt, ... savedAt }).
  // Hydrated from cache on boot, written through by deals:setSaved IPC.
  const [savedDeals, setSavedDeals] = useState({});
  const [communityConsent, setCommunityConsent] = useState('unknown');  // 'unknown' | 'allowed' | 'denied'

  // Project scanning: parsed DAW project files. Shape comes from the
  // main process: { folders, projects: [{ id, path, dawType, name, plugins }], lastScannedAt }.
  const [projectLibrary, setProjectLibrary] = useState(null);
  // Track whether the user is dragging a project file over the window
  // so we can render a drop overlay. Reset on dragleave / drop.
  const [projectDragActive, setProjectDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  // The Project sidebar bucket the user has clicked (drives library filtering).
  // null = no project filter active. Possible values:
  //   { kind: 'mostUsed' }
  //   { kind: 'unused' }
  //   { kind: 'unmatched' }
  //   { kind: 'project', projectId }
  const [projectFilter, setProjectFilter] = useState(null);
  // Free-form tags per project (map: projectId → string[]).
  const [projectTags, setProjectTags] = useState({});
  // Free-form notes per project (map: projectId → string).
  const [projectNotes, setProjectNotes] = useState({});
  // Manual bounce overrides per project (map: projectId → { added:[], dismissed:[] }).
  const [projectBounceOverrides, setProjectBounceOverrides] = useState({});
  // Tier ratings per project (map: projectId → 'A'|'B'|'C'|'D'|'F').
  const [projectRatings, setProjectRatings] = useState({});
  // Workflow statuses per project (map: projectId → statusId).
  const [projectStatuses, setProjectStatuses] = useState({});
  // Manual key signature per project (map: projectId → key string).
  // Used ONLY as a display fallback when the project file doesn't
  // expose its own key. Detected key always wins on display, so a
  // re-scan that finds a real key automatically supersedes any
  // override the user typed — exactly what Josh asked for.
  const [projectKeyOverrides, setProjectKeyOverrides] = useState({});
  // User's custom status list. null means "use built-in defaults".
  // Once the user adds/edits/removes a status, this becomes the
  // canonical full list (we never go back to null automatically).
  const [customStatuses, setCustomStatuses] = useState(null);
  // Active top-level tab: 'library' (default) or 'projects'.
  const [appView, setAppView] = useState('library');
  // Tab-mount cache. Once a tab has been shown, keep it mounted so the
  // switch back is instant. We accumulate visited tabs in a ref so the
  // cache survives across renders without forcing an extra re-render
  // when the cache grows. The Set returned via useMemo is rebuilt only
  // when appView changes (and the ref grows), so render-time checks are
  // synchronous — the active tab paints on the same render that
  // switches to it (no blank-frame delay).
  const mountedTabsRef = useRef(new Set(['library']));
  // Bump this when we mutate mountedTabsRef from outside the
  // appView-based path (e.g. pre-warming Projects during boot idle).
  // The useMemo below recomputes when it changes so React re-renders
  // with the newly-mounted tabs in the set.
  const [mountedTabsVersion, setMountedTabsVersion] = useState(0);
  const mountedTabs = useMemo(() => {
    if (!mountedTabsRef.current.has(appView)) {
      mountedTabsRef.current = new Set([...mountedTabsRef.current, appView]);
    }
    return mountedTabsRef.current;
  }, [appView, mountedTabsVersion]);

  // Modal state — declared early because the pre-warm useEffect below
  // gates on whether the welcome tutorial is showing.
  const [showTutorial, setShowTutorial] = useState(false);
  // AlertsManager modal — opened via Plugr menu → "My Deal Alerts…".
  const [showAlerts, setShowAlerts] = useState(false);
  // Deal-alert state. Lifted to App.jsx so multiple consumers can read
  // it (AlertsManager modal, DetailPanel bell icons, Deals tab cards).
  // Kept in sync via refreshDealAlerts after every mutation + on the
  // 'alerts:matched' event from main (which updates lastNotifiedAt).
  const [dealAlerts, setDealAlerts] = useState([]);
  // Count of new deals since the user last opened the Deals tab. Shown
  // as a small chip on the Deals tab in the TabBar so users get a
  // reason to visit even when they aren't actively shopping. Reset to
  // zero (and stamped to "now" in cache) whenever the Deals tab is
  // selected.
  const [newDealsCount, setNewDealsCount] = useState(0);

  // Pre-warm the Projects tab during boot idle time. After the app
  // has settled (cacheLoaded + projectLibrary present), schedule
  // mounting ProjectsView in the background using requestIdleCallback.
  // ProjectsView's skeleton-first pattern means the heavy render
  // happens during idle CPU — and by the time the user clicks
  // Projects, the cold mount is already done, so the tab pops up
  // instantly with real content (not the loading spinner).
  useEffect(() => {
    if (!cacheLoaded) return;
    // Don't pre-warm while the welcome tutorial is showing — the heavy
    // ProjectsView render blocks the main thread for 2-3s and during
    // that window the user can't click the tutorial's X/Skip buttons.
    if (showTutorial) return;
    if (mountedTabsRef.current.has('projects')) return;

    // Two-stage gate so the pre-warm never blocks the user's first clicks:
    // (1) wait ~6 seconds of wall-clock time so boot startup work
    //     (scan kickoff, deals fetch, icon loads, etc.) is well past
    // (2) then yield to requestIdleCallback so the mount happens during
    //     actual main-thread idle.
    // Trade-off: clicking Projects within the first 6s after boot does a
    // cold mount with the skeleton, but boot stays buttery on every
    // other tab and the 6+ second mark almost always finds the user
    // already settled into Library.
    let idleCancel = null;
    const delayMs = 6000;
    const t = setTimeout(() => {
      if (mountedTabsRef.current.has('projects')) return;
      const schedule = (typeof window.requestIdleCallback === 'function')
        ? (fn) => { idleCancel = window.requestIdleCallback(fn, { timeout: 8000 }); }
        : (fn) => { idleCancel = setTimeout(fn, 0); };
      schedule(() => {
        if (mountedTabsRef.current.has('projects')) return;
        mountedTabsRef.current = new Set([...mountedTabsRef.current, 'projects']);
        setMountedTabsVersion((v) => v + 1);
      });
    }, delayMs);

    return () => {
      clearTimeout(t);
      if (idleCancel != null) {
        if (typeof window.cancelIdleCallback === 'function' && typeof idleCancel === 'number') {
          try { window.cancelIdleCallback(idleCancel); } catch { /* no-op */ }
        } else {
          try { clearTimeout(idleCancel); } catch { /* no-op */ }
        }
      }
    };
  }, [cacheLoaded, showTutorial]);
  // Which tab opens on launch. 'library' is the new default so a fresh
  // install lands on Plugins & Apps every time. 'remember' restores the
  // last-opened tab (the legacy behavior); 'projects' / 'deals' lock to
  // those tabs specifically.
  const [defaultTabPref, setDefaultTabPref] = useState('library');
  // List of tab ids the user has chosen to hide (paid+trial feature).
  // Persisted via prefs:set. Always read directly; only RENDERED as
  // filtered when the tabVisibility entitlement is on. The list stays
  // intact across entitlement downgrades so re-upgrading restores
  // the prior layout.
  const [hiddenTabs, setHiddenTabs] = useState([]);
  const updateDefaultTabPref = useCallback((next) => {
    setDefaultTabPref(next);
    if (api.setPrefs) api.setPrefs({ defaultTab: next });
  }, []);

  // Currency selector for the Deals tab. APD prices come tagged USD;
  // if this differs, the renderer converts using cached exchange rates.
  const [currencyPref, setCurrencyPref] = useState('USD');
  const updateCurrencyPref = useCallback((next) => {
    setCurrencyPref(next);
    if (api.setPrefs) api.setPrefs({ currencyPref: next });
  }, []);
  // Global playback volume for bounce audio across the app. 0..1.
  // Persisted in the cache so the setting survives restarts.
  // Default 0.8 = slightly under unity gain — comfortable starting
  // level that doesn't blast the user the first time they hit play.
  const [audioVolume, setAudioVolume] = useState(0.8);
  // Audio bus — single-claimant coordinator so starting one bounce
  // pauses the previous one. Also serves as the target for the
  // Space / arrow-key shortcuts: they always act on whatever audio
  // currently owns the bus (i.e. the most recently played).
  const audioBusRef = useRef(null);
  const claimPlayback = useCallback((audio) => {
    if (audioBusRef.current && audioBusRef.current !== audio && !audioBusRef.current.paused) {
      audioBusRef.current.pause();
    }
    audioBusRef.current = audio;
  }, []);

  // Modal state
  const [showHelp, setShowHelp] = useState(false);
  const [helpInitialTab, setHelpInitialTab] = useState('updates');
  const [discoverItem, setDiscoverItem] = useState(null);
  // When set, the DiscoverModal opens in 'edit' mode with these prefilled
  // URL+regex values instead of running auto-discover. Cleared when the
  // modal closes.
  const [discoverEditState, setDiscoverEditState] = useState(null);     // { mode: 'edit', existingAddition: { updateUrl, versionRegex } } | null
  // Open when the user clicks "Mirror from another plugin…" in the
  // detail panel. The picker reads the current selection from
  // selectedItem and writes back through handleSetMirrorFrom.
  const [mirrorPickerOpen, setMirrorPickerOpen] = useState(false);
  // Right-click context menu for library items. Null when closed;
  // when open, holds { x, y, item, items } — caller builds the items
  // list in handleItemContextMenu below. Rendered near the bottom of
  // the tree alongside the other top-level modals.
  const [contextMenu, setContextMenu] = useState(null);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  // Konami-style: 5 clicks on the brand mark within 2 seconds reveals it.
  const brandClicksRef = useRef({ count: 0, last: 0 });

  // Multi-select state. selectedIds is the canonical Set; we keep a
  // setSelectedId function (single-select) for back-compat callers.
  // lastSelectedId is the "pivot" for shift-click range selection.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [lastSelectedId, setLastSelectedId] = useState(null);
  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
  const setSelectedId = useCallback((id) => {
    if (id == null) {
      setSelectedIds(new Set());
      setLastSelectedId(null);
    } else {
      setSelectedIds(new Set([id]));
      setLastSelectedId(id);
    }
  }, []);
  const [search, setSearch] = useState('');
  const [activeFormats, setActiveFormats] = useState(new Set(FORMAT_LIST));
  const [activeCategory, setActiveCategory] = useState(null);
  const [activeDeveloper, setActiveDeveloper] = useState(null);
  // Active tag filter — when set, show only plugins tagged with this
  // exact string. Click a tag in the sidebar to set; click again to
  // clear. Null = no tag filter active.
  const [activeTag, setActiveTag] = useState(null);
  const [updateFilter, setUpdateFilter] = useState('all');
  const [cleanupFilter, setCleanupFilter] = useState('all');
  const [compatFilter, setCompatFilter] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // When true, the main grid/list shows ONLY plugins the user has hidden.
  // Mirrors the favoritesOnly toggle: same single-row sidebar control,
  // same one-or-the-other UX. Default false → hidden items are excluded
  // from every other bucket, exactly as the user asked.
  const [showHidden, setShowHidden] = useState(false);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [view, setView] = useState('grid');

  const searchRef = useRef(null);
  // CSV export reads from this ref so the menu handler — which is wired
  // up once on mount and never re-bound — can always see the latest
  // merged item list / updates without churning the IPC subscription.
  const exportStateRef = useRef({ items: [], updates: {}, checkedAt: null });

  // Build the displayed items: base scan + user overrides, community
  // additions (lower priority), user's own registry additions, then
  // user-defined per-developer companion apps. Order reflects the
  // layered registry: bundled < community < user-saved.
  const displayedItems = useMemo(() => {
    const withOverrides = applyOverrides(library.items, overrides);
    const withCommunity = applyCommunityAdditions(withOverrides, communityAdditions);
    const withRegistry = applyRegistryAdditions(withCommunity, registryAdditions);
    const withCompanions = applyDevCompanions(withRegistry, devCompanions);
    // Registry-driven companion lookup. Runs AFTER user overrides so an
    // item whose developer was hand-edited to "Native Instruments" picks
    // up Native Access automatically. Also a safety net for cached items
    // that pre-date recent registry edits. Uses the imported JSON
    // directly so Vite hot-reloads keep it current — no IPC required.
    const withRegistryCompanions = applyRegistryCompanions(withCompanions);
    // Final passes:
    //   - Collapse developer-name case variants ("Ujam" vs "UJAM").
    //   - Strip the retired "Mastering" subcategory from any cached or
    //     user-saved item, so it never surfaces in the sidebar tree even
    //     if the user has stale data. A fresh scan will reclassify them
    //     properly; until then they display as plain "Effect".
    const folded = foldCaseOnlyDevelopers(withRegistryCompanions);
    return folded.map((it) => {
      if (it && it.subcategory === 'Mastering') {
        return { ...it, subcategory: null };
      }
      return it;
    });
  }, [library.items, overrides, registryAdditions, communityAdditions, devCompanions]);

  // Keep the export ref pointed at the latest merged state. The menu
  // handler runs from a useEffect that's wired up once on mount, so it
  // would otherwise close over a stale snapshot.
  useEffect(() => {
    exportStateRef.current = { items: displayedItems, updates, checkedAt: updatesCheckedAt };
  }, [displayedItems, updates, updatesCheckedAt]);

  // Cross-reference scanned DAW projects with the installed library.
  // projectMatch holds: usedItemIds, mostUsed[], unmatchedReferences[],
  // projectsByLibraryId, countByLibraryId. Cheap to compute even for
  // big libraries — it's a couple of map lookups per plugin reference.
  const projectMatch = useMemo(() => {
    const projs = (projectLibrary && projectLibrary.projects) || [];
    return buildProjectMatch(projs, displayedItems);
  }, [projectLibrary, displayedItems]);

  // Per-item summary: itemId → { projectCount, instanceCount, projects:[{id,name,…}] }.
  // Used by the 'Used in N projects' badge popover.
  const perItemProjectSummary = useMemo(() => {
    const projs = (projectLibrary && projectLibrary.projects) || [];
    return buildPerItemSummary(projectMatch, projs);
  }, [projectMatch, projectLibrary]);

  // Decorate items with project-usage info so library cards/rows + the
  // detail panel can render badges without needing the match Maps
  // directly. Items that aren't used get projectUsage: null (cheaper
  // than {count:0}).
  const itemsWithProjectUsage = useMemo(() => {
    if (perItemProjectSummary.size === 0) return displayedItems;
    return displayedItems.map((it) => {
      const u = perItemProjectSummary.get(it.id);
      if (!u) return it;
      return { ...it, projectUsage: u };
    });
  }, [displayedItems, perItemProjectSummary]);


  // Pull the slim registry companion-app map from main on mount so the
  // renderer can apply companion / homepage info to items based on their
  // CURRENT displayed developer name (including any user overrides).
  // Refreshed on every successful scan too, so registry edits between
  // scans get picked up without an app restart.
  const reloadRegistryEnrichment = useCallback(async () => {
    try {
      const res = await api.getRegistryCompanionMap && api.getRegistryCompanionMap();
      if (res && res.ok && res.data) setRegistryEnrichment(res.data);
    } catch { /* harmless */ }
  }, []);

  // On mount: try cache; apply theme; show tutorial if first run.
  useEffect(() => {
    (async () => {
      try {
        reloadRegistryEnrichment();
        const cached = await api.loadCache();
        if (cached && cached.ok && cached.data) {
          if (cached.data.library) setLibrary(cached.data.library);
          if (cached.data.updates) setUpdates(cached.data.updates);
          if (cached.data.updatesCheckedAt) setUpdatesCheckedAt(cached.data.updatesCheckedAt);
          if (cached.data.userOverrides) setOverrides(cached.data.userOverrides);
          if (cached.data.userRegistryAdditions) setRegistryAdditions(cached.data.userRegistryAdditions);
          if (cached.data.themePreference) setThemePreference(cached.data.themePreference);
          if (cached.data.categorySort) setCategorySort(cached.data.categorySort);
          if (typeof cached.data.audioVolume === 'number') {
            // Clamp on read in case a manual edit / older version
            // wrote something out of range.
            setAudioVolume(Math.max(0, Math.min(1, cached.data.audioVolume)));
          }
          if (cached.data.developerSort) setDeveloperSort(cached.data.developerSort);
          if (cached.data.formatSort) setFormatSort(cached.data.formatSort);
          if (Array.isArray(cached.data.customFolders)) setCustomFolders(cached.data.customFolders);
          if (cached.data.columnWidths && typeof cached.data.columnWidths === 'object') {
            setColumnWidths(cached.data.columnWidths);
          }
          if (cached.data.compatFilter) setCompatFilter(cached.data.compatFilter);
          if (cached.data.userDeveloperCompanions) setDevCompanions(cached.data.userDeveloperCompanions);
          if (cached.data.userCategories && typeof cached.data.userCategories === 'object') {
            setUserCategories(cached.data.userCategories);
          }
          if (Array.isArray(cached.data.sidebarSectionOrder)) {
            setSidebarSectionOrder(cached.data.sidebarSectionOrder);
          }
          if (cached.data.sortBy) setSortBy(cached.data.sortBy);
          if (cached.data.sortDir === 'asc' || cached.data.sortDir === 'desc') setSortDir(cached.data.sortDir);
          if (cached.data.view === 'grid' || cached.data.view === 'list') setView(cached.data.view);
          if (cached.data.communityShareConsent) setCommunityConsent(cached.data.communityShareConsent);
          if (cached.data.communityAdditions) setCommunityAdditions(cached.data.communityAdditions);
          if (cached.data.savedDeals && typeof cached.data.savedDeals === 'object') {
            setSavedDeals(cached.data.savedDeals);
          }
          if (typeof cached.data.currencyPref === 'string') {
            setCurrencyPref(cached.data.currencyPref);
          }
          if (cached.data.projectLibrary) setProjectLibrary(cached.data.projectLibrary);
          if (cached.data.projectTags) setProjectTags(cached.data.projectTags);
          if (cached.data.projectNotes) setProjectNotes(cached.data.projectNotes);
          if (cached.data.projectBounceOverrides) setProjectBounceOverrides(cached.data.projectBounceOverrides);
          if (cached.data.projectRatings) setProjectRatings(cached.data.projectRatings);
          if (cached.data.projectStatuses) setProjectStatuses(cached.data.projectStatuses);
          if (cached.data.projectKeyOverrides) setProjectKeyOverrides(cached.data.projectKeyOverrides);
          if (Array.isArray(cached.data.customStatuses)) setCustomStatuses(cached.data.customStatuses);
          // Decide which tab to open on launch.
          //   - defaultTab is the user's setting. If 'library'/'projects'/'deals',
          //     ALWAYS go there regardless of where they were last time.
          //   - If 'remember' (or unset legacy installs), restore the last appView.
          const defaultTab = cached.data.defaultTab || 'library';
          const lastView = cached.data.appView;
          const KNOWN_VIEWS = ['library', 'projects', 'deals', 'tools'];
          if (KNOWN_VIEWS.includes(defaultTab)) {
            setAppView(defaultTab);
            setDefaultTabPref(defaultTab);
          } else if (defaultTab === 'remember') {
            setDefaultTabPref('remember');
            if (KNOWN_VIEWS.includes(lastView)) {
              setAppView(lastView);
            }
          }
          setTutorialDismissed(!!cached.data.tutorialDismissed);
          if (Array.isArray(cached.data.hiddenTabs)) {
            setHiddenTabs(cached.data.hiddenTabs);
          }
          resolveAndApplyTheme(cached.data.themePreference || 'auto');
          if (!cached.data.tutorialDismissed) setShowTutorial(true);
          setCacheLoaded(true);
          // Always run a fresh scan in the background. The cached library
          // is already showing, so the UI feels instant; the scan brings
          // newly-installed plugins in over the next few seconds.
          runScan();
        } else {
          // First launch — show the tutorial before scanning.
          resolveAndApplyTheme('auto');
          setShowTutorial(true);
          setCacheLoaded(true);
          await runScan();
        }
      } catch (err) {
        resolveAndApplyTheme('auto');
        setCacheLoaded(true);
        pushToast({ kind: 'error', message: String(err && err.message || err) });
      }
    })();
    /* eslint-disable-next-line */
  }, []);

  // When in 'auto' mode, listen for OS-level dark/light flips and re-apply.
  useEffect(() => {
    if (themePreference !== 'auto') return;
    if (!window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => resolveAndApplyTheme('auto');
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else mql.addListener(handler);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else mql.removeListener(handler);
    };
  }, [themePreference]);

  // Pull a fresh community-additions feed in the background once the cache
  // is loaded. Cached internally for 24h by the main process; this no-ops
  // if the URLs aren't configured yet.
  useEffect(() => {
    if (!cacheLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.fetchCommunityAdditions({});
        if (cancelled) return;
        if (res && res.ok && res.data) setCommunityAdditions(res.data);
      } catch { /* silent — community feed is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [cacheLoaded]);

  // Load deal alerts once the cache has been hydrated. We keep this
  // state up here in App.jsx (rather than only inside AlertsManager)
  // because multiple parts of the UI need to read it — bell icons in
  // DetailPanel, bell on each deal card, "N new" badge in the tab
  // header.
  const refreshDealAlerts = useCallback(async () => {
    try {
      const res = await api.listDealAlerts();
      if (res && res.ok && Array.isArray(res.alerts)) {
        setDealAlerts(res.alerts);
      }
    } catch { /* silent — alerts feature is non-critical */ }
  }, [api]);

  useEffect(() => {
    if (!cacheLoaded) return;
    refreshDealAlerts();
  }, [cacheLoaded, refreshDealAlerts]);

  // Subscribe to 'alerts:matched' from main: when a deal fetch fires
  // a notification, main updates lastNotifiedAt in the alerts list.
  // Pull the fresh list so DetailPanel bells reflect the new state.
  useEffect(() => {
    if (!api.onDealAlertsMatched) return;
    const unsub = api.onDealAlertsMatched(() => {
      refreshDealAlerts();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [api, refreshDealAlerts]);

  // Compute the "N new since last view" count for the Deals tab badge.
  // Pulls cached deals (no network, no fetch — getDeals(false) is a
  // pure cache read inside the TTL) and counts items whose
  // firstSeenAt is later than the user's dealsLastViewedAt. Runs on
  // boot and again whenever a fresh fetch lands ('alerts:matched'
  // fires after a deal-fetch from main).
  const recomputeNewDealsCount = useCallback(async () => {
    try {
      const res = await api.getDeals(false);
      if (!res || !res.ok || !res.data) return;
      const data = res.data;
      const lastViewedMs = data.dealsLastViewedAt
        ? new Date(data.dealsLastViewedAt).getTime()
        : 0;
      const items = Array.isArray(data.items) ? data.items : [];
      const dismissed = data.dismissedDeals || {};
      // Count deals whose first appearance is newer than the
      // last-viewed mark, excluding ones the user dismissed (they
      // already saw + hid those, so they're not "new" from the
      // user's perspective). When firstSeenAt isn't set, fall back
      // to fetchedAt so we never undercount.
      let n = 0;
      for (const it of items) {
        if (!it || !it.id) continue;
        if (dismissed[it.id]) continue;
        const seen = it.firstSeenAt || data.fetchedAt;
        if (!seen) continue;
        if (new Date(seen).getTime() > lastViewedMs) n += 1;
      }
      // Cap at 99 in the chip — anything higher reads as "lots" anyway.
      setNewDealsCount(Math.min(n, 99));
    } catch { /* silent — badge is a nice-to-have */ }
  }, [api]);

  useEffect(() => {
    if (!cacheLoaded) return;
    recomputeNewDealsCount();
  }, [cacheLoaded, recomputeNewDealsCount]);

  // After a deal-alert match (which can only happen on a fresh fetch),
  // the deals cache has just been refreshed — re-count.
  useEffect(() => {
    if (!api.onDealAlertsMatched) return;
    const unsub = api.onDealAlertsMatched(() => {
      recomputeNewDealsCount();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [api, recomputeNewDealsCount]);

  // Match helpers — kept in lockstep with dealAlerts.cjs::normalize so a
  // bell button reflects the same alert that would actually fire.
  // Mirroring the main-side normalizer here avoids an IPC round-trip
  // for every render of every plugin row / deal card.
  const normalizeAlertString = useCallback((s) => (
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  ), []);

  const findAlertForPlugin = useCallback((item) => {
    if (!item) return null;
    const id = normalizeAlertString(item.identifier);
    const name = normalizeAlertString(item.name);
    return dealAlerts.find((a) => {
      if (a.type !== 'plugin') return false;
      if (a.identifier && id && normalizeAlertString(a.identifier) === id) return true;
      const label = normalizeAlertString(a.label);
      return label && name && label === name;
    }) || null;
  }, [dealAlerts, normalizeAlertString]);

  const findAlertForDeveloper = useCallback((devName) => {
    const n = normalizeAlertString(devName);
    if (!n) return null;
    return dealAlerts.find((a) => (
      a.type === 'developer' && normalizeAlertString(a.label) === n
    )) || null;
  }, [dealAlerts, normalizeAlertString]);

  // Toggle a plugin watch on/off from anywhere (DetailPanel bell,
  // deal-card bell). Adds if missing, removes if present. Toast
  // confirms the change so users know the click did something.
  const toggleDealAlertForPlugin = useCallback(async (item) => {
    if (!item) return;
    const existing = findAlertForPlugin(item);
    if (existing) {
      const res = await api.removeDealAlert(existing.id);
      if (res && res.ok) {
        await refreshDealAlerts();
        pushToast({ kind: 'info', message: `Stopped watching ${item.name}.`, durationMs: 4000 });
      }
      return;
    }
    const res = await api.addDealAlert({
      type: 'plugin',
      label: item.name,
      identifier: item.identifier || null,
      active: true,
    });
    if (res && res.ok) {
      await refreshDealAlerts();
      pushToast({
        kind: 'success',
        message: `Watching ${item.name} for deals.`,
        durationMs: 5000,
      });
    }
  }, [api, findAlertForPlugin, refreshDealAlerts, pushToast]);

  // Find / toggle helpers keyed off a deal object (used by the bells
  // on each DealCard). A "deal watch" creates a plugin-type alert
  // labeled with the deal's title — that way the alert is reusable
  // across catalog refreshes even if the same plugin shows up with a
  // slightly different deal record. When the deal has been matched to
  // a known library item, prefer that item's name so the label lines
  // up with what DetailPanel would show.
  const findAlertForDeal = useCallback((deal) => {
    if (!deal) return null;
    const matched = deal.match && deal.match.items && deal.match.items[0];
    const title = (matched && matched.name) || deal.title || '';
    const identifier = (matched && matched.identifier) || deal.identifier || null;
    const n = normalizeAlertString(title);
    const id = normalizeAlertString(identifier);
    return dealAlerts.find((a) => {
      if (a.type !== 'plugin') return false;
      if (a.identifier && id && normalizeAlertString(a.identifier) === id) return true;
      const label = normalizeAlertString(a.label);
      return label && n && label === n;
    }) || null;
  }, [dealAlerts, normalizeAlertString]);

  const toggleDealAlertForDeal = useCallback(async (deal) => {
    if (!deal) return;
    const matched = deal.match && deal.match.items && deal.match.items[0];
    const label = (matched && matched.name) || deal.title;
    const identifier = (matched && matched.identifier) || deal.identifier || null;
    if (!label) return;
    const existing = findAlertForDeal(deal);
    if (existing) {
      const res = await api.removeDealAlert(existing.id);
      if (res && res.ok) {
        await refreshDealAlerts();
        pushToast({ kind: 'info', message: `Stopped watching ${label}.`, durationMs: 4000 });
      }
      return;
    }
    const res = await api.addDealAlert({
      type: 'plugin',
      label,
      identifier,
      active: true,
    });
    if (res && res.ok) {
      await refreshDealAlerts();
      pushToast({
        kind: 'success',
        message: `Watching ${label} for deals.`,
        durationMs: 5000,
      });
    }
  }, [api, findAlertForDeal, refreshDealAlerts, pushToast]);

  const toggleDealAlertForDeveloper = useCallback(async (devName) => {
    const n = (devName || '').trim();
    if (!n) return;
    const existing = findAlertForDeveloper(n);
    if (existing) {
      const res = await api.removeDealAlert(existing.id);
      if (res && res.ok) {
        await refreshDealAlerts();
        pushToast({ kind: 'info', message: `Stopped watching ${n}.`, durationMs: 4000 });
      }
      return;
    }
    const res = await api.addDealAlert({
      type: 'developer',
      label: n,
      active: true,
    });
    if (res && res.ok) {
      await refreshDealAlerts();
      pushToast({
        kind: 'success',
        message: `Watching ${n} for deals.`,
        durationMs: 5000,
      });
    }
  }, [api, findAlertForDeveloper, refreshDealAlerts, pushToast]);

  // Auto-run "Check for Updates" once per app session, after the boot
  // scan finishes — but only if the last successful check was longer
  // than AUTO_CHECK_COOLDOWN_HOURS ago. Without the cooldown, opening
  // Plugr several times in one day would trigger several minutes of
  // network traffic each time, which is wasteful and annoying.
  //
  // Single-shot guarded by `autoCheckedThisSessionRef` so toggling
  // anything that triggers a re-scan during the session (rescan
  // button, ⌘R, etc.) does NOT kick off another automatic check —
  // those manual rescans are intentional and the user can decide
  // whether to re-check updates manually.
  const AUTO_CHECK_COOLDOWN_HOURS = 12;
  const autoCheckedThisSessionRef = useRef(false);
  useEffect(() => {
    if (!cacheLoaded) return;
    if (!entitlements) return;                                  // wait for entitlements — cap can't apply without them
    if (scanning) return;                                       // wait for scan to finish
    if (autoCheckedThisSessionRef.current) return;              // only once per launch
    if (!library.items || library.items.length === 0) return;   // nothing to check
    if (checking) return;                                       // user already checking
    const lastCheckedMs = updatesCheckedAt ? new Date(updatesCheckedAt).getTime() : 0;
    const hoursSince = (Date.now() - lastCheckedMs) / (60 * 60 * 1000);
    if (hoursSince < AUTO_CHECK_COOLDOWN_HOURS) return;         // checked recently enough
    autoCheckedThisSessionRef.current = true;
    // Inline "how long ago" so we don't have to import a formatter
    // up at file top for one line of UI copy.
    const lastSummary = updatesCheckedAt
      ? (() => {
          const days = Math.floor(hoursSince / 24);
          if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
          const hrs = Math.floor(hoursSince);
          return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
        })()
      : 'never';
    pushToast({
      kind: 'info',
      title: 'Checking for updates in the background…',
      message: `Last checked ${lastSummary}. Continue using Plugr — the toolbar Check button will show when it finishes.`,
      durationMs: 6000,
    });
    runUpdateCheck();
    // We intentionally do NOT include runUpdateCheck in deps — it's
    // defined inline above and changes every render. The ref guard
    // makes the dep list irrelevant for correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheLoaded, scanning, library.items.length, checking, updatesCheckedAt, entitlements]);

  // Opportunistic catch-up check: when a plugin has an effective source
  // (registry-or-user-saved updateUrl + versionRegex, or a Sparkle
  // feed) but NO update-check result in `updates`, fire a focused
  // check on just those plugins. This handles the common drift case
  // where a user saved a source on the VST3 a while ago — propagation
  // gave the AU/VST2 family siblings the same source, but their
  // update-check never ran because the original auto-check predated
  // sibling propagation. Plugins keep saying "Managed by companion"
  // when they should be saying "outdated → v1.12.0."
  //
  // Bypasses the 12-hour cooldown because this is targeted catch-up,
  // not a full re-check of the library.
  const catchupCheckedThisSessionRef = useRef(false);
  useEffect(() => {
    if (!cacheLoaded) return;
    if (!entitlements) return;                // wait for entitlements — cap can't apply without them
    if (scanning) return;
    if (checking) return;
    if (catchupCheckedThisSessionRef.current) return;
    if (!displayedItems || displayedItems.length === 0) return;

    const stragglers = displayedItems.filter((it) => {
      if (updates[it.id]) return false;       // already has a result
      const reg = it.registry || {};
      const hasSource = !!(reg.updateUrl && reg.versionRegex);
      const hasSparkle = !!it.sparkleFeedUrl;
      return hasSource || hasSparkle;
    });
    if (stragglers.length === 0) return;

    // Respect the trial cap: ensure the running total of checked plugins
    // (auto-check + catch-up combined) never exceeds trialUpdateChecksCap.
    const trialCap = entitlements.features ? entitlements.features.trialUpdateChecksCap : null;
    const alreadyChecked = Object.keys(updates).length;
    let cappedStragglers = stragglers;
    if (typeof trialCap === 'number' && trialCap > 0) {
      const remaining = Math.max(0, trialCap - alreadyChecked);
      if (remaining === 0) return;            // trial cap already exhausted by auto-check
      cappedStragglers = stragglers.slice(0, remaining);
    }
    if (cappedStragglers.length === 0) return;

    catchupCheckedThisSessionRef.current = true;

    (async () => {
      try {
        const res = await api.checkUpdates(cappedStragglers);
        if (res && res.ok && res.data && Array.isArray(res.data.results)) {
          setUpdates((prev) => {
            const next = { ...prev };
            for (const r of res.data.results) next[r.id] = r;
            return next;
          });
          if (res.data.checkedAt) setUpdatesCheckedAt(res.data.checkedAt);
        }
      } catch { /* silent — user can manually re-check via the toolbar */ }
      finally { setProgress(null); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheLoaded, scanning, checking, displayedItems, updates, entitlements]);

  // Keep the tray menu in sync with the current update results.
  // Fires after every update check (auto, catch-up, or manual) and on
  // cache load, so the count badge and plugin list are always current.
  useEffect(() => {
    if (!api.traySetUpdates) return;
    const outdated = library.items
      .filter((item) => updates[item.id]?.status === 'outdated')
      .map((item) => ({
        name: item.name,
        from: item.version || '?',
        to: updates[item.id].latestVersion || '?',
      }));
    api.traySetUpdates(outdated);
  }, [updates, library.items]);

  // Subscribe to scan / update / discover-all progress streams.
  useEffect(() => {
    if (!api.onProgress) return;
    const unsubs = [
      api.onProgress('progress:scan', (p) => setProgress(p)),
      api.onProgress('progress:updates', (p) => setProgress(p)),
      api.onProgress('progress:discoverAll', (p) => setProgress(p)),
      // URL-template trials when the user clicks 'Try for N more' after
      // a successful Discover save. Without this, the progress bar shows
      // stale data from whatever was last running.
      api.onProgress('progress:tryTemplate', (p) => setProgress(p)),
      // Project scanner emits 'progress:projects' as it walks folders
      // and parses each project file. Without listening here, the UI
      // sat on its initial "Scanning projects…" forever even when the
      // backend was working fine. Same pattern for deals refreshes.
      api.onProgress('progress:projects', (p) => setProgress(p)),
      api.onProgress('progress:deals', (p) => setProgress(p)),
    ];
    return () => unsubs.forEach((u) => u && u());
    /* eslint-disable-next-line */
  }, []);

  // Wire up menu actions from the main process.
  useEffect(() => {
    if (!api.onMenuEvent) return;
    const unsub = api.onMenuEvent((channel, payload) => {
      switch (channel) {
        case 'menu:scan': runScan(); break;
        // Manual "Check for Plugr Updates" handler — fires the electron-updater
  // check, then races the next status event against a timeout so the
  // user gets explicit feedback (up to date / available / error / slow).
  // Auto-checks on boot stay silent; only manual checks show toasts.
  async function handleCheckForPlugrUpdates() {
    pushToast({ kind: 'info', title: 'Checking for Plugr updates…', durationMs: 4000 });
    let resolveResult;
    const resultP = new Promise((res) => { resolveResult = res; });
    let done = false;
    const unsub = api.onUpdaterStatus && api.onUpdaterStatus((payload) => {
      if (done || !payload) return;
      if (['up-to-date', 'available', 'error'].includes(payload.status)) {
        done = true;
        resolveResult(payload);
      }
    });
    try { await api.checkForUpdates(); } catch { /* tolerate */ }
    const timeoutP = new Promise((res) => setTimeout(() => res({ status: 'timeout' }), 10000));
    const result = await Promise.race([resultP, timeoutP]);
    if (typeof unsub === 'function') unsub();
    const v = result && result.detail && result.detail.version;
    if (result.status === 'up-to-date') {
      pushToast({ kind: 'success', title: 'Plugr is up to date', message: 'You\'re running the latest version.', durationMs: 6000 });
    } else if (result.status === 'available') {
      pushToast({ kind: 'info', title: 'Plugr update available', message: v ? `Version ${v} is downloading in the background. You\'ll see a Restart prompt when it\'s ready.` : 'A new version is downloading. You\'ll see a Restart prompt when it\'s ready.', durationMs: 10000 });
    } else if (result.status === 'error') {
      const msg = (result.detail && result.detail.message) || 'Could not reach the update server.';
      pushToast({ kind: 'error', title: 'Update check failed', message: msg, durationMs: 10000 });
    } else if (result.status === 'timeout') {
      pushToast({ kind: 'warning', title: 'Still checking…', message: 'Update server is slow. Try again in a moment, or look for a Restart prompt later.', durationMs: 8000 });
    }
  }

    case 'menu:checkUpdates': handleCheckForPlugrUpdates(); break;
        case 'menu:scanProjects': runAddProjectFolder(); break;
        case 'menu:exportCsv': runCsvExport(); break;
        case 'menu:exportBackup': runBackupExport(); break;
        case 'menu:importBackup': runBackupImport(); break;
        case 'menu:openCompanionApps': changeAppView('apps'); break;
        case 'menu:focusSearch':
          if (searchRef.current) searchRef.current.focus();
          break;
        case 'menu:showTutorial':
          setShowTutorial(true);
          break;
        case 'menu:openAlerts':
          setShowAlerts(true);
          break;
        case 'menu:showHelp':
          setHelpInitialTab((payload && payload.tab) || 'updates');
          setShowHelp(true);
          break;
        case 'menu:cacheCleared':
          setLibrary({ items: [], summary: null, scannedAt: null });
          setUpdates({});
          setOverrides({});
          setRegistryAdditions({});
          runScan();
          break;
        default: break;
      }
    });
    return unsub;
    /* eslint-disable-next-line */
  }, []);

  async function runScan() {
    // Library scan is trial-AND-paid (free during trial, locked
    // post-expiry). Expired users can still browse their cached
    // library — they just can't refresh it. The renderer toast
    // points to BuyDialog so they can re-subscribe and resume.
    if (!requirePaid('libraryScan', 'Rescanning your plugin library')) return;
    setScanning(true);
    setProgress({ phase: 'scan', current: 0, total: 1, message: 'Starting scan…' });
    try {
      // Reload the registry companion map BEFORE the scan, so renderer
      // enrichment uses the freshest data alongside the scanner's own.
      reloadRegistryEnrichment();
      const res = await api.scanLibrary({});
      if (!res.ok) throw new Error(res.error || 'Scan failed');
      setLibrary(res.data);
    } catch (err) {
      pushToast({ kind: 'error', message: String(err && err.message || err) });
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  // Bulk-discover update sources, then immediately re-check updates.
  //
  // Earlier this had a stale-closure bug: it called runUpdateCheck() right
  // after setRegistryAdditions, but runUpdateCheck reads displayedItems via
  // useMemo — that memo can't have re-run yet, so the check ran against
  // stale items and reported every newly-discovered plugin as "no-source"
  // anyway. Now we apply the new additions to a local snapshot and pass
  // them directly to checkUpdates, bypassing React state propagation.
  async function runDiscoverAll() {
    if (!displayedItems.length) return;
    // Bulk discover hits every plugin in parallel — a big spend of
    // both time and network. Gate behind the paid plan; trial users
    // can still discover one-at-a-time via the Discover button on
    // each plugin's detail panel.
    if (!requirePaid('bulkOperations', 'Bulk discover sources')) return;
    setProgress({ phase: 'discoverAll', current: 0, total: 1, message: 'Looking for update sources…' });
    try {
      const res = await api.discoverAllUpdates(displayedItems);
      if (!res.ok) throw new Error(res.error || 'Discover failed');
      const data = res.data || { foundCount: 0, total: 0, mergedAdditions: registryAdditions };
      const newAdditions = data.mergedAdditions || registryAdditions;
      setRegistryAdditions(newAdditions);

      // Build the items list with the freshly-saved additions applied so
      // the immediate update check picks them up. Don't rely on React
      // state propagation here.
      const itemsForCheck = applyRegistryAdditions(
        applyCommunityAdditions(
          applyOverrides(library.items, overrides),
          communityAdditions,
        ),
        newAdditions,
      );

      setChecking(true);
      try {
        const upd = await api.checkUpdates(itemsForCheck);
        if (!upd.ok) throw new Error(upd.error || 'Update check failed');
        const map = { ...updates };
        for (const r of upd.data.results || []) map[r.id] = r;
        setUpdates(map);
        setUpdatesCheckedAt(upd.data.checkedAt);
      } finally {
        setChecking(false);
      }

      const skip = data.skippedAlreadyHaveSource || 0;
      const noId = data.skippedNoIdentifier || 0;
      const tplFound = data.templatePassFound || 0;
      const directFound = (data.foundCount || 0) - tplFound;

      pushToast({
        kind: data.foundCount > 0 ? 'success' : 'info',
        title: data.foundCount > 0
          ? `Found ${data.foundCount} new source${data.foundCount === 1 ? '' : 's'}`
          : 'No new sources found',
        message:
          data.foundCount > 0
            ? (tplFound > 0
              ? `${directFound} direct · ${tplFound} via URL templates · ${skip} already had sources.`
              : `${data.foundCount} new · ${skip} already had sources.`)
            : `Checked ${data.total} plugins · ${skip} already had sources.`,
        persistent: true,
      });
    } catch (err) {
      pushToast({ kind: 'error', message: String(err && err.message || err) });
    } finally {
      setProgress(null);
    }
  }

  async function runUpdateCheck() {
    if (!library.items.length) return;
    // Update checks are trial-AND-paid for the action itself, but
    // CAPPED at 100 plugins during trial. Post-expiry: fully locked.
    // The cap exists so trial users feel the value (their first 100
    // hits give an honest sample of how many of their plugins are
    // outdated) but the long tail is reserved for paying users.
    if (!requirePaid('updateChecks', 'Checking for plugin updates')) return;
    const trialCap = entitlements && entitlements.features
      ? entitlements.features.trialUpdateChecksCap
      : null;
    let itemsForCheck = displayedItems;
    if (typeof trialCap === 'number' && trialCap > 0 && displayedItems.length > trialCap) {
      itemsForCheck = displayedItems.slice(0, trialCap);
      pushToast({
        kind: 'info',
        title: `Trial check limited to ${trialCap} plugins`,
        message: `Plugr's free trial caps update checks at ${trialCap} plugins at a time. The remaining ${displayedItems.length - trialCap} will be skipped until you subscribe.`,
        persistent: true,
        action: { label: 'Upgrade', onClick: () => setBuyDialogOpen(true) },
      });
    }
    setChecking(true);
    setProgress({ phase: 'updates', current: 0, total: itemsForCheck.length, message: 'Starting update check…' });
    try {
      const res = await api.checkUpdates(itemsForCheck);
      if (!res.ok) throw new Error(res.error || 'Update check failed');
      const map = { ...updates };
      for (const r of res.data.results || []) map[r.id] = r;
      setUpdates(map);
      setUpdatesCheckedAt(res.data.checkedAt);
    } catch (err) {
      pushToast({ kind: 'error', message: String(err && err.message || err) });
    } finally {
      setChecking(false);
      setProgress(null);
    }
  }

  // Shared result-handling for both Add Folder and Rescan flows. The
  // backend now returns { projectLibrary, scanErrors, cloudFolders,
  // projectCount } so we can show useful diagnostics instead of the
  // old "0 projects, ¯\_(ツ)_/¯" silent toast.
  // Build a name + DAW-type signature for a project — used as a
  // path-independent identity so annotations carry across Macs when
  // the underlying paths differ (e.g. external drives mounted at
  // different names, or projects mirrored across local and cloud
  // copies). Normalized lowercase + alphanumeric so subtle
  // capitalization or punctuation differences don't break matches.
  function projectSignature(p) {
    if (!p || !p.name) return null;
    const norm = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!norm) return null;
    return `${p.dawType || '?'}:${norm}`;
  }

  // Reconcile project annotations after a scan. If iCloud sync brought
  // over annotations from another Mac that are keyed to a different
  // project ID (path was different), but the freshly-scanned project
  // on THIS Mac has the same name + DAW type, copy them over so the
  // user sees their notes / tags / ratings / status / key / bounces
  // attached to the right project. This is a one-shot per-scan
  // reconciliation, not a sync — annotations stay keyed by project ID
  // afterward.
  function reconcileProjectAnnotationsByName(projectLibrary) {
    const newProjects = (projectLibrary && projectLibrary.projects) || [];
    if (newProjects.length === 0) return;
    // Index every freshly-scanned project's ID by its signature so we
    // know which IDs are "claimable" via name-fallback.
    const sigToNewIds = new Map();
    for (const p of newProjects) {
      const sig = projectSignature(p);
      if (!sig) continue;
      if (!sigToNewIds.has(sig)) sigToNewIds.set(sig, []);
      sigToNewIds.get(sig).push(p.id);
    }
    // Index annotations BY signature where possible. We need the
    // project from the old library (if any) OR the new project itself
    // (for orphaned annotation IDs that won't be in either list, we
    // can't recover the signature — those just won't reconcile).
    const oldProjects = ((projectLibrary && projectLibrary.projects) || []).concat([]);
    const oldById = new Map(oldProjects.map((p) => [p.id, p]));

    // Walk each annotation map. For every entry keyed to an ID that's
    // NOT a freshly-scanned project ID, try to find its signature and
    // see if that signature now matches a freshly-scanned project.
    // If yes — and if that new project has NO annotation under its
    // own ID — copy the orphan annotation to the new ID.
    function reconcile(map, setter) {
      const newIds = new Set(newProjects.map((p) => p.id));
      let changed = false;
      const next = { ...map };
      for (const [oldId, value] of Object.entries(map)) {
        if (newIds.has(oldId)) continue;   // already attached correctly
        const oldProj = oldById.get(oldId);
        if (!oldProj) continue;            // can't get signature without the project record
        const sig = projectSignature(oldProj);
        if (!sig) continue;
        const targetIds = sigToNewIds.get(sig);
        if (!targetIds || targetIds.length === 0) continue;
        for (const newId of targetIds) {
          if (!next[newId]) {              // don't clobber existing annotations
            next[newId] = value;
            changed = true;
          }
        }
      }
      if (changed) setter(next);
    }

    reconcile(projectTags,            setProjectTags);
    reconcile(projectNotes,           setProjectNotes);
    reconcile(projectRatings,         setProjectRatings);
    reconcile(projectStatuses,        setProjectStatuses);
    reconcile(projectKeyOverrides,    setProjectKeyOverrides);
    reconcile(projectBounceOverrides, setProjectBounceOverrides);
  }

  function showProjectScanResult(data, contextLabel) {
    if (!data) return;
    setProjectLibrary(data.projectLibrary || data);
    // After updating the library, run the name-based reconciliation so
    // annotations from a sibling Mac (synced via iCloud) land on the
    // right project even if the path differs locally.
    try { reconcileProjectAnnotationsByName(data.projectLibrary || data); }
    catch (err) { console.warn('reconcileProjectAnnotationsByName failed:', err.message); }
    const count = data.projectCount != null
      ? data.projectCount
      : (data.projects ? data.projects.length : 0);
    const errs = Array.isArray(data.scanErrors) ? data.scanErrors : [];
    const cloud = Array.isArray(data.cloudFolders) ? data.cloudFolders : [];

    // Count subfolders that timed out (likely cloud-storage hangs) vs.
    // permission errors (EACCES/EPERM) so we can target the message.
    let timeoutCount = 0;
    let permissionCount = 0;
    let otherErrorCount = 0;
    for (const e of errs) {
      for (const err of (e.errors || [])) {
        if (err.code === 'ETIMEDOUT') timeoutCount++;
        else if (err.code === 'EACCES' || err.code === 'EPERM') permissionCount++;
        else otherErrorCount++;
      }
    }

    // Count projects flagged as missing (file not found at last known
    // location). Surface this so the user knows their library has
    // stale records they can either ignore, rescan, or clean up.
    const lib = data.projectLibrary || data;
    const missingCount = (lib.projects || []).filter((p) => p.missing).length;
    const missingNote = missingCount > 0
      ? ` ${missingCount} project${missingCount === 1 ? "" : "s"} couldn't be found at the last known location and ${missingCount === 1 ? 'is' : 'are'} flagged as possibly outdated.`
      : '';

    // Success path — found stuff, no errors.
    if (count > 0 && errs.length === 0) {
      pushToast({
        kind: missingCount > 0 ? 'warn' : 'success',
        title: 'Project scan complete',
        message: `${count.toLocaleString()} project${count === 1 ? '' : 's'} indexed${contextLabel ? ` from ${contextLabel}` : ''}.${missingNote}`,
        durationMs: missingCount > 0 ? 9000 : 5000,
      });
      return;
    }

    // Found nothing AND nothing went wrong — folder just has no
    // recognized projects in it.
    if (count === 0 && errs.length === 0) {
      pushToast({
        kind: 'info',
        title: 'No projects found',
        message: cloud.length > 0
          ? 'Plugr looked through this Google Drive / iCloud folder but didn\'t find any .als, .alp, .flp, or .logicx files. If your projects are stored cloud-only, try downloading them locally first.'
          : 'Plugr looked through that folder but didn\'t find any .als, .alp, .flp, or .logicx project files.',
        durationMs: 8000,
      });
      return;
    }

    // Anything else — there were errors. Build a message that explains
    // what happened so the user can act on it.
    const parts = [];
    if (count > 0) parts.push(`Indexed ${count} project${count === 1 ? '' : 's'}.`);
    if (timeoutCount > 0) {
      parts.push(`${timeoutCount} folder${timeoutCount === 1 ? '' : 's'} took too long to read${cloud.length ? ' (likely cloud-only files in Google Drive / iCloud).' : '.'}`);
    }
    if (permissionCount > 0) {
      parts.push(`${permissionCount} folder${permissionCount === 1 ? '' : 's'} couldn't be read — likely a permission issue. Open System Settings → Privacy & Security → Files and Folders and give Plugr access.`);
    }
    if (otherErrorCount > 0) {
      parts.push(`${otherErrorCount} folder${otherErrorCount === 1 ? '' : 's'} failed for other reasons.`);
    }
    pushToast({
      kind: (count > 0 ? 'warn' : 'error'),
      title: count > 0 ? 'Partial scan' : "Couldn't scan projects",
      message: parts.join(' '),
      durationMs: 12000,
    });
  }

  // Pick a folder via the system dialog and scan every recognized
  // project file underneath. Adds the folder to the persistent list,
  // so subsequent rescans pick it up automatically.
  async function runAddProjectFolder() {
    // Project scan is trial-AND-paid (free during trial, locked
    // post-expiry). Existing projects stay viewable after expiry —
    // only adding new folders or rescanning is gated.
    if (!requirePaid('projectScan', 'Scanning a new folder for projects')) return;
    try {
      const pick = await api.pickProjectFolder();
      if (!pick || !pick.ok || !pick.folder) return;
      const folder = pick.folder;
      // Removed: cloud-storage pre-confirmation. The 20s-per-readdir
      // timeout in the scanner is sufficient — empirically, cloud
      // folders (Google Drive, iCloud, Dropbox) scan fast enough that
      // the upfront warning created anxiety without paying off. If a
      // folder genuinely IS slow, the user gets a partial-scan toast
      // at the end of the walk with a clear "cloud folder" note.
      setProgress({ phase: 'projects', current: 0, total: 1, message: 'Scanning projects…' });
      const res = await api.scanProjects({ folders: [folder] });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Project scan failed');
      showProjectScanResult(res.data, folder);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: "Couldn't scan projects",
        message: String(err && err.message || err),
      });
    } finally {
      setProgress(null);
    }
  }

  // Same flow but for an explicit list of folder + file paths (used by
  // drag-and-drop and by 'Rescan all folders').
  async function runScanProjectPaths({ folders = [], files = [] }) {
    if (!folders.length && !files.length) return;
    if (!requirePaid('projectScan', 'Rescanning project folders')) return;
    try {
      setProgress({ phase: 'projects', current: 0, total: 1, message: 'Scanning projects…' });
      const res = await api.scanProjects({ folders, files });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Project scan failed');
      showProjectScanResult(res.data, null);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: "Couldn't scan projects",
        message: String(err && err.message || err),
      });
    } finally {
      setProgress(null);
    }
  }

  // Persist a project's tier rating (A/B/C/D/F or null to clear).
  // Optimistic update; cache write is fire-and-forget.
  async function updateProjectRating(projectId, rating) {
    if (!requirePaid('projectAnnotations', 'Rating projects')) return;
    setProjectRatings((prev) => {
      const next = { ...prev };
      if (!rating) delete next[projectId];
      else next[projectId] = rating;
      return next;
    });
    try { await api.setProjectRating(projectId, rating); }
    catch { /* tolerate */ }
  }

  // Persist a project's manual key signature (string, or null/'' to
  // clear). Optimistic — UI updates immediately, cache catches up.
  async function updateProjectKeyOverride(projectId, key) {
    if (!requirePaid('projectAnnotations', 'Editing project keys')) return;
    const cleaned = (typeof key === 'string' ? key.trim() : '') || null;
    setProjectKeyOverrides((prev) => {
      const next = { ...prev };
      if (!cleaned) delete next[projectId];
      else next[projectId] = cleaned;
      return next;
    });
    try { await api.setProjectKeyOverride(projectId, cleaned); }
    catch { /* tolerate */ }
  }

  // Persist a project's workflow status. Pass null to clear.
  async function updateProjectStatus(projectId, statusId) {
    if (!requirePaid('projectAnnotations', 'Setting project status')) return;
    setProjectStatuses((prev) => {
      const next = { ...prev };
      if (!statusId) delete next[projectId];
      else next[projectId] = statusId;
      return next;
    });
    try { await api.setProjectStatus(projectId, statusId); }
    catch { /* tolerate */ }
  }

  // Replace the full list of custom statuses. Pass null/[] to revert
  // to built-in defaults. After a successful save, any project whose
  // status no longer exists in the new list keeps the orphaned ID
  // (still visible as raw text until the user picks a new status).
  async function updateStatusList(list) {
    if (!requirePaid('projectAnnotations', 'Editing the project status list')) return;
    setCustomStatuses(list && list.length > 0 ? list : null);
    try { await api.setStatusList(list); }
    catch { /* tolerate */ }
  }

  // Persist free-form notes for a project. Same optimistic pattern as
  // tags: update local state first so the textarea feels instant, then
  // fire-and-forget the IPC.
  async function updateProjectNotes(projectId, notes) {
    if (!requirePaid('projectAnnotations', 'Editing project notes')) return;
    setProjectNotes((prev) => {
      const next = { ...prev };
      if (!notes || !notes.trim()) delete next[projectId];
      else next[projectId] = notes;
      return next;
    });
    try { await api.setProjectNotes(projectId, notes); }
    catch { /* tolerate */ }
  }

  // Manual bounce override updater. Same pattern.
  async function updateProjectBounceOverrides(projectId, overrides) {
    if (!requirePaid('projectAnnotations', 'Editing project bounces')) return;
    setProjectBounceOverrides((prev) => {
      const next = { ...prev };
      const empty = !overrides || (
        (!overrides.added || overrides.added.length === 0) &&
        (!overrides.dismissed || overrides.dismissed.length === 0)
      );
      if (empty) delete next[projectId];
      else next[projectId] = {
        added: Array.isArray(overrides.added) ? overrides.added : [],
        dismissed: Array.isArray(overrides.dismissed) ? overrides.dismissed : [],
      };
      return next;
    });
    try { await api.setBounceOverrides(projectId, overrides); }
    catch { /* tolerate */ }
  }

  // Open the system file picker so the user can manually attach a
  // bounce file to a project that auto-detection missed. Picked files
  // are merged into the project's bounce-override list.
  async function addManualBounce(project) {
    if (!project) return;
    try {
      const res = await api.pickBounceFile(project.path);
      if (!res || !res.ok || !res.files || res.files.length === 0) return;
      const current = projectBounceOverrides[project.id] || { added: [], dismissed: [] };
      // De-dupe by path so re-picking a file is idempotent.
      const havePaths = new Set((current.added || []).map((f) => f.path));
      const merged = [...current.added || []];
      for (const f of res.files) {
        if (!havePaths.has(f.path)) merged.push(f);
      }
      await updateProjectBounceOverrides(project.id, {
        added: merged,
        dismissed: current.dismissed || [],
      });
      pushToast({
        kind: 'success',
        message: `Added ${res.files.length} bounce file${res.files.length === 1 ? '' : 's'} to ${project.name}.`,
        durationMs: 3500,
      });
    } catch (err) {
      pushToast({ kind: 'error', title: "Couldn't add bounce", message: String(err && err.message || err) });
    }
  }

  // Attach a list of dropped audio paths as manual bounces. Mirrors
  // addManualBounce(project) but skips the file picker — the OS drag
  // event already gave us the paths. Main process stats each path,
  // filters non-audio, and returns the same {path,name,sizeBytes,mtime}
  // shape so the override-merge logic is identical.
  async function addBouncesFromPaths(project, paths) {
    if (!project || !Array.isArray(paths) || paths.length === 0) return;
    try {
      const res = await api.statBouncePaths(paths);
      if (!res || !res.ok || !res.files || res.files.length === 0) {
        pushToast({
          kind: 'info',
          message: 'Drop audio files (wav / aif / mp3 / flac / m4a / ogg / opus) to attach them as bounces.',
          durationMs: 4000,
        });
        return;
      }
      const current = projectBounceOverrides[project.id] || { added: [], dismissed: [] };
      const havePaths = new Set((current.added || []).map((f) => f.path));
      const merged = [...current.added || []];
      let added = 0;
      for (const f of res.files) {
        if (havePaths.has(f.path)) continue;
        merged.push(f);
        added++;
      }
      if (added === 0) {
        pushToast({ kind: 'info', message: 'Those bounces are already attached.', durationMs: 3000 });
        return;
      }
      await updateProjectBounceOverrides(project.id, {
        added: merged,
        dismissed: current.dismissed || [],
      });
      pushToast({
        kind: 'success',
        message: `Added ${added} bounce file${added === 1 ? '' : 's'} to ${project.name}.`,
        durationMs: 3500,
      });
    } catch (err) {
      pushToast({ kind: 'error', title: "Couldn't add bounce", message: String(err && err.message || err) });
    }
  }

  // Dismiss an auto-detected bounce (it was actually a sample / wrong
  // file). Adds its path to the dismissed list. The renderer's merge
  // logic filters dismissed entries out of the displayed bounces.
  async function dismissAutoBounce(project, bouncePath) {
    if (!project || !bouncePath) return;
    const current = projectBounceOverrides[project.id] || { added: [], dismissed: [] };
    if ((current.dismissed || []).includes(bouncePath)) return;
    await updateProjectBounceOverrides(project.id, {
      added: current.added || [],
      dismissed: [...(current.dismissed || []), bouncePath],
    });
  }

  // Remove a manually-added bounce.
  async function removeManualBounce(project, bouncePath) {
    if (!project || !bouncePath) return;
    const current = projectBounceOverrides[project.id] || { added: [], dismissed: [] };
    await updateProjectBounceOverrides(project.id, {
      added: (current.added || []).filter((f) => f.path !== bouncePath),
      dismissed: current.dismissed || [],
    });
  }

  // Persist a project's tag list. Optimistically updates the UI; main
  // process write is fire-and-forget (failure here would only mean
  // tags don't survive a restart, which is fine for a low-stakes
  // metadata field).
  async function updateProjectTags(projectId, tags) {
    if (!requirePaid('projectAnnotations', 'Tagging projects')) return;
    setProjectTags((prev) => {
      const next = { ...prev };
      if (!tags || tags.length === 0) delete next[projectId];
      else next[projectId] = tags;
      return next;
    });
    try { await api.setProjectTags(projectId, tags); }
    catch { /* tolerate — optimistic UI already updated */ }
  }

  // Add or remove a tab id from the hidden list. Gated by the
  // tabVisibility entitlement — free + trial-expired users get an
  // upsell toast and the patch is dropped. Auto-switches away from a
  // tab that's being hidden so the user doesn't get stranded on it.
  function toggleTabHidden(tabId, shouldHide) {
    if (!tabId) return;
    if (shouldHide && !requirePaid('tabVisibility', 'Hiding tabs')) return;
    setHiddenTabs((prev) => {
      const set = new Set(prev);
      if (shouldHide) set.add(tabId); else set.delete(tabId);
      const next = Array.from(set);
      // Fire-and-forget persistence; optimistic state already updated.
      if (api.setPrefs) api.setPrefs({ hiddenTabs: next });
      return next;
    });
    if (shouldHide && tabId === appView) {
      // Active tab was just hidden — bounce to library so the now-
      // hidden tab doesn't keep occupying the view.
      changeAppView('library');
    }
  }

  // Switch tabs + persist the choice so it survives restart.
  function changeAppView(next) {
    if (next === appView) return;
    setAppView(next);
    api.setPrefs && api.setPrefs({ appView: next });
    // Landing on the Deals tab counts as "I've seen these now" —
    // clear the optimistic badge and stamp the cache so the badge
    // doesn't immediately re-appear on the next boot.
    if (next === 'deals') {
      setNewDealsCount(0);
      if (api.setDealsLastViewed) {
        // Fire-and-forget — the badge is purely cosmetic and a
        // failed write just means the count regenerates next boot.
        api.setDealsLastViewed().catch(() => {});
      }
    }
  }

  // Jump from a ProjectsView plugin row into the Library tab with the
  // plugin selected. Clears any active project filter so the user isn't
  // staring at an empty filtered list.
  function jumpToPluginInLibrary(itemId) {
    setActiveCategory(null);
    setActiveDeveloper(null);
    setActiveTag(null);
    setProjectFilter(null);
    setSearch('');
    setSelectedId(itemId);
    setSelectedIds(new Set([itemId]));
    changeAppView('library');
  }

  // Export the full library as a CSV file.
  //
  // Reads the latest merged item list / updates from exportStateRef
  // (the menu listener closes over an initial render's snapshot
  // otherwise). Asks the user via native dialog whether to include
  // hidden plugins, builds the CSV, then offers a Save dialog. Empty
  // library short-circuits with a polite toast.
  async function runCsvExport() {
    // Paid-only: exporting CSV is part of the "take your data with
    // you" tier. Browsing the library on screen stays free.
    if (!requirePaid('csvExport', 'Exporting your library as CSV')) return;
    const { items, updates: liveUpdates, checkedAt } = exportStateRef.current || {};
    if (!items || items.length === 0) {
      pushToast({
        kind: 'info',
        title: 'Nothing to export',
        message: 'Scan your library first, then try Export again.',
        durationMs: 4000,
      });
      return;
    }
    try {
      const choice = await api.askIncludeHidden();
      if (!choice || !choice.ok || !choice.proceed) return;
      const includeHidden = !!choice.includeHidden;
      const csv = buildLibraryCsv({
        items,
        updates: liveUpdates,
        checkedAt,
        includeHidden,
      });
      // Filename uses local date, not ISO — easier to skim in Finder.
      const today = new Date().toISOString().slice(0, 10);
      const defaultFilename = `plugr-library-${today}.csv`;
      const res = await api.exportCsv({ csv, defaultFilename });
      if (!res || res.canceled) return;
      if (!res.ok) throw new Error(res.error || 'Export failed');
      // Count rows excluding header for the toast.
      const rowCount = csv.split(/\r?\n/).filter(Boolean).length - 1;
      pushToast({
        kind: 'success',
        title: 'CSV exported',
        message: `${rowCount.toLocaleString()} plugin${rowCount === 1 ? '' : 's'} saved.`,
        durationMs: 6000,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: "Couldn't export CSV",
        message: String(err && err.message || err),
      });
    }
  }

  // Backup export — main builds the snapshot, shows a Save dialog,
  // writes the file. Renderer just kicks off and reports the result.
  async function runBackupExport() {
    if (!requirePaid('backupRestore', 'Exporting a full backup')) return;
    try {
      const res = await api.exportBackup();
      if (!res || res.canceled) return;
      if (!res.ok) throw new Error(res.error || 'Export failed');
      const s = res.summary || {};
      const bits = [];
      if (s.overrides) bits.push(`${s.overrides} plugin override${s.overrides === 1 ? '' : 's'}`);
      if (s.registryAdditions) bits.push(`${s.registryAdditions} update source${s.registryAdditions === 1 ? '' : 's'}`);
      if (s.projects) bits.push(`${s.projects} project${s.projects === 1 ? '' : 's'}`);
      pushToast({
        kind: 'success',
        title: 'Backup exported',
        message: bits.length ? `Saved ${bits.join(' · ')}.` : 'Backup file written.',
        durationMs: 7000,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: "Couldn't export backup",
        message: String(err && err.message || err),
      });
    }
  }

  // Backup import — three steps:
  //   1. main shows Open dialog and parses the picked file
  //   2. renderer shows a confirm dialog with the contents preview
  //   3. on confirm, main writes everything to cache + projectStore
  //      and we reload all the affected React state.
  async function runBackupImport() {
    if (!requirePaid('backupRestore', 'Importing a backup')) return;
    try {
      const pick = await api.pickAndPreviewBackup();
      if (!pick || pick.canceled) return;
      if (!pick.ok) throw new Error(pick.error || 'Import failed');
      const s = pick.summary || {};
      // Build a human-readable body that itemizes what's coming in,
      // so the user has a fair picture of what they're about to
      // overwrite.
      const exportedAt = s.exportedAt ? new Date(s.exportedAt).toLocaleString() : 'unknown';
      const lines = [
        `Created: ${exportedAt}`,
        '',
        `· ${s.favorites || 0} favorite${s.favorites === 1 ? '' : 's'}`,
        `· ${s.hidden || 0} hidden plugin${s.hidden === 1 ? '' : 's'}`,
        `· ${s.overrides || 0} total plugin override${s.overrides === 1 ? '' : 's'}`,
        `· ${s.registryAdditions || 0} update source${s.registryAdditions === 1 ? '' : 's'}`,
        `· ${s.customCategories || 0} custom categor${s.customCategories === 1 ? 'y' : 'ies'}`,
        `· ${s.customFolders || 0} custom scan folder${s.customFolders === 1 ? '' : 's'}`,
        `· ${s.projects || 0} project${s.projects === 1 ? '' : 's'} (${s.projectFolders || 0} folder${s.projectFolders === 1 ? '' : 's'})`,
        `· ${s.projectRatings || 0} rating${s.projectRatings === 1 ? '' : 's'}, ${s.projectStatuses || 0} status${s.projectStatuses === 1 ? '' : 'es'}`,
        `· theme: ${s.theme}`,
      ].join('\n');
      const yes = await requestConfirm({
        title: 'Restore this backup?',
        body:
          `Your current favorites, custom registry sources, project annotations, and settings will be replaced with what's in this backup. This cannot be undone.\n\n${lines}`,
        yesLabel: 'Restore',
        noLabel: 'Cancel',
        destructive: true,
      });
      if (!yes) return;

      const applied = await api.applyBackup(pick.backup);
      if (!applied || !applied.ok) {
        throw new Error((applied && applied.error) || 'Apply failed');
      }

      // Pull the restored data back into React state. Simplest path:
      // re-read the cache via the same loader the app uses on boot.
      // That populates every field consistently and avoids missing
      // a spot.
      try {
        const cached = await api.loadCache();
        if (cached && cached.ok && cached.data) {
          const d = cached.data;
          if (d.userOverrides) setOverrides(d.userOverrides);
          if (d.userRegistryAdditions) setRegistryAdditions(d.userRegistryAdditions);
          if (d.userDeveloperCompanions) setDevCompanions(d.userDeveloperCompanions);
          if (d.userCategories) setUserCategories(d.userCategories);
          if (Array.isArray(d.customFolders)) setCustomFolders(d.customFolders);
          if (d.themePreference) {
            setThemePreference(d.themePreference);
            resolveAndApplyTheme(d.themePreference);
          }
          if (typeof d.audioVolume === 'number') setAudioVolume(d.audioVolume);
          if (d.projectLibrary) setProjectLibrary(d.projectLibrary);
          if (d.projectTags) setProjectTags(d.projectTags);
          if (d.projectNotes) setProjectNotes(d.projectNotes);
          if (d.projectBounceOverrides) setProjectBounceOverrides(d.projectBounceOverrides);
          if (d.projectRatings) setProjectRatings(d.projectRatings);
          if (d.projectStatuses) setProjectStatuses(d.projectStatuses);
          if (Array.isArray(d.customStatuses)) setCustomStatuses(d.customStatuses);
          if (d.projectKeyOverrides) setProjectKeyOverrides(d.projectKeyOverrides);
        }
      } catch { /* tolerate — the file was applied, UI just won't refresh in-place */ }

      pushToast({
        kind: 'success',
        title: 'Backup restored',
        message: 'Your previous settings, favorites, and project annotations are back. Rescan if any plugin paths differ on this machine.',
        durationMs: 10000,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: "Couldn't import backup",
        message: String(err && err.message || err),
      });
    }
  }

  const setItemOverride = useCallback(async (id, patch) => {
    // Editing any plugin attribute (favorite, hide, category, developer,
    // tags, notes, multi-category, custom companion app, custom update
    // source) is trial-or-paid. Expired users see read-only data. We
    // pick the most relevant feature flag for the toast message based
    // on which key is being touched. Catch-all default is pluginNotes
    // (the broadest organizational feature).
    let gate = 'pluginNotes';
    let label = 'Editing your library';
    if (patch && typeof patch === 'object') {
      if ('favorite' in patch) { gate = 'pluginFavorite'; label = 'Marking favorites'; }
      else if ('hidden' in patch) { gate = 'pluginHiddenToggle'; label = 'Hiding plugins'; }
      else if ('category' in patch || 'categories' in patch || 'subcategory' in patch) { gate = 'pluginCategoryEdit'; label = 'Editing categories'; }
      else if ('developer' in patch) { gate = 'pluginDeveloperEdit'; label = 'Editing developers'; }
      else if ('tags' in patch) { gate = 'pluginTags'; label = 'Editing tags'; }
      else if ('notes' in patch) { gate = 'pluginNotes'; label = 'Editing notes'; }
    }
    if (!requirePaid(gate, label)) return;
    const next = { ...overrides };
    if (patch && patch.__clear) {
      delete next[id];
    } else {
      next[id] = { ...(next[id] || {}), ...(patch || {}) };
      if (next[id].favorite === false) delete next[id].favorite;
      // Mirror main.cjs cleanup: hidden:false is "unhide", strip it.
      if (next[id].hidden === false) delete next[id].hidden;
      if (Object.keys(next[id]).length === 0) delete next[id];
    }
    setOverrides(next);
    await api.setOverride(id, patch);
  }, [overrides, requirePaid]);

  // Mirror link/unlink. The data layer is already wired (applyOverrides
  // surfaces mirrorFromId; effectiveUpdates resolves it) — these
  // handlers just persist the override + nudge local state. We use the
  // raw api.setOverride/setOverrides direct write path (rather than
  // setItemOverride) so we don't trip the paid-feature gate: borrowing
  // a sibling's update result is part of the free update-tracking
  // experience, not a power-user organizational feature.
  const handleSetMirrorFrom = useCallback(async (childId, parentItem) => {
    if (!childId || !parentItem || !parentItem.id) return;
    if (parentItem.id === childId) return;     // can't mirror from self
    const patch = { mirrorFromId: parentItem.id };
    setOverrides((cur) => {
      const next = { ...cur };
      next[childId] = { ...(next[childId] || {}), ...patch };
      // If the user previously dismissed the auto-suggest banner, clear
      // that flag — they obviously want the link now.
      if (next[childId].dismissedMirrorSuggest) delete next[childId].dismissedMirrorSuggest;
      return next;
    });
    await api.setOverride(childId, patch);
  }, []);

  const handleClearMirrorFrom = useCallback(async (childId) => {
    if (!childId) return;
    const patch = { mirrorFromId: null };
    setOverrides((cur) => {
      const next = { ...cur };
      if (next[childId]) {
        next[childId] = { ...next[childId] };
        delete next[childId].mirrorFromId;
        if (Object.keys(next[childId]).length === 0) delete next[childId];
      }
      return next;
    });
    await api.setOverride(childId, patch);
  }, []);

  // Dismiss the "Looks like this might share updates with X" banner so
  // it doesn't keep nagging when the user actively doesn't want the
  // link. Stored on the override so it persists across sessions.
  const handleDismissMirrorSuggest = useCallback(async (childId) => {
    if (!childId) return;
    const patch = { dismissedMirrorSuggest: true };
    setOverrides((cur) => {
      const next = { ...cur };
      next[childId] = { ...(next[childId] || {}), ...patch };
      return next;
    });
    await api.setOverride(childId, patch);
  }, []);

  const trashItem = useCallback(async (item) => {
    if (!item) return;
    const ok = window.confirm(`Move "${item.name}" to the Trash?\n\nFile: ${item.path}\n\nThis is reversible — you can drag it back out of the Trash.`);
    if (!ok) return;
    const res = await api.trashItem(item.path);
    if (!res.ok) {
      pushToast({ kind: 'error', title: "Couldn't move to Trash", message: res.error || 'Unknown error' });
      return;
    }
    setLibrary((prev) => ({ ...prev, items: prev.items.filter((x) => x.id !== item.id) }));
    setSelectedIds((cur) => {
      if (!cur.has(item.id)) return cur;
      const next = new Set(cur);
      next.delete(item.id);
      return next;
    });
    pushToast({ kind: 'success', message: `Moved "${item.name}" to Trash.`, durationMs: 4000 });
  }, [selectedId, pushToast]);

  // Save tutorial dismissal preference.
  const dismissTutorialForever = useCallback(async () => {
    setTutorialDismissed(true);
    await api.setTutorialDismissed(true);
  }, []);

  // Apply + persist a theme choice. The named studio palettes (the
  // DAW-themed group) are paid-only — they get gated by requirePaid().
  // System themes (Auto / Dark / Light) are always free.
  const applyTheme = useCallback(async (next) => {
    const themeMeta = THEMES.find((t) => t.value === next);
    if (themeMeta && themeMeta.group === 'daw') {
      if (!requirePaid('studioPalettes', `The "${themeMeta.label}" studio palette`)) return;
    }
    setThemePreference(next);
    resolveAndApplyTheme(next);
    await api.setTheme(next);
  }, [requirePaid]);

  // Update + persist the global bounce-playback volume. Clamps the
  // input so a buggy slider can't write a -3 or +1.5 that confuses
  // the HTMLAudioElement.volume setter (which throws on out-of-range).
  const updateAudioVolume = useCallback(async (next) => {
    const v = Math.max(0, Math.min(1, Number(next) || 0));
    setAudioVolume(v);
    if (api.setPrefs) await api.setPrefs({ audioVolume: v });
  }, []);

  // Keyboard shortcuts for the Projects tab:
  //   Space      — play/pause the active bounce (the one most
  //                recently played, or paused but still on the bus).
  //   ←  /  →    — scrub the active bounce ±5 seconds.
  // We skip the handler when focus is in a text-entry surface so
  // typing a note or a tag doesn't accidentally pause playback.
  useEffect(() => {
    if (appView !== 'projects') return undefined;
    function isTextEntry(el) {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    const onKey = (e) => {
      if (isTextEntry(e.target)) return;
      const audio = audioBusRef.current;
      if (!audio) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (audio.paused) {
          // claimPlayback is idempotent if `audio` already owns the
          // bus, so this is safe.
          claimPlayback(audio);
          const p = audio.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } else {
          audio.pause();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const dur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
        audio.currentTime = Math.min(dur, audio.currentTime + 5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appView, claimPlayback]);

  // Persist sidebar sort changes.
  const updateCategorySort = useCallback(async (next) => {
    setCategorySort(next);
    await api.setPrefs({ categorySort: next });
  }, []);
  const updateDeveloperSort = useCallback(async (next) => {
    setDeveloperSort(next);
    await api.setPrefs({ developerSort: next });
  }, []);
  const updateFormatSort = useCallback(async (next) => {
    setFormatSort(next);
    await api.setPrefs({ formatSort: next });
  }, []);

  // Custom folder management.
  const addCustomFolder = useCallback(async () => {
    const res = await api.pickFolder();
    if (!res || !res.ok || !res.path) return;
    const next = customFolders.includes(res.path) ? customFolders : [...customFolders, res.path];
    setCustomFolders(next);
    await api.setPrefs({ customFolders: next });
  }, [customFolders]);
  const removeCustomFolder = useCallback(async (path) => {
    const next = customFolders.filter((p) => p !== path);
    setCustomFolders(next);
    await api.setPrefs({ customFolders: next });
  }, [customFolders]);

  const updateColumnWidths = useCallback(async (next) => {
    setColumnWidths(next);
    await api.setPrefs({ columnWidths: next });
  }, []);
  const updateCompatFilter = useCallback(async (next) => {
    setCompatFilter(next);
    await api.setPrefs({ compatFilter: next });
  }, []);
  const updateSidebarSectionOrder = useCallback(async (next) => {
    setSidebarSectionOrder(next);
    await api.setPrefs({ sidebarSectionOrder: next });
  }, []);
  // Wrappers that persist sort + view choices so they survive app restart.
  const applySortBy = useCallback(async (next) => {
    setSortBy(next);
    await api.setPrefs({ sortBy: next });
  }, []);
  const applySortDir = useCallback(async (next) => {
    setSortDir(next);
    await api.setPrefs({ sortDir: next });
  }, []);
  const applyView = useCallback(async (next) => {
    setView(next);
    await api.setPrefs({ view: next });
  }, []);

  // Add or remove a user-defined companion app for a developer.
  const setDevCompanion = useCallback(async (developer, companion) => {
    const next = { ...devCompanions };
    if (companion) next[developer] = companion;
    else delete next[developer];
    setDevCompanions(next);
    await api.setDevCompanion(developer, companion);
  }, [devCompanions]);
  const pickAndSetDevCompanion = useCallback(async (developer) => {
    if (!developer) return;
    const res = await api.pickCompanionApp();
    if (!res.ok || res.canceled) return;
    await setDevCompanion(developer, res.data);
    pushToast({
      kind: 'success',
      message: `${res.data.displayName} is now the companion app for ${developer}.`,
      durationMs: 5000,
    });
  }, [setDevCompanion, pushToast]);

  // Easter egg trigger: 5 clicks on the brand mark within 2 seconds.
  const handleBrandClick = useCallback(() => {
    const now = Date.now();
    const ref = brandClicksRef.current;
    if (now - ref.last > 2000) ref.count = 0;
    ref.count += 1;
    ref.last = now;
    if (ref.count >= 5) {
      ref.count = 0;
      setShowEasterEgg(true);
    }
  }, []);

  // Open a companion app (Native Access, Waves Central, etc.). If the app
  // can't be found locally we surface a friendly error.
  const openCompanionApp = useCallback(async (companionApp) => {
    if (!companionApp) return;
    const res = await api.openCompanionApp(companionApp);
    if (!res.ok) {
      pushToast({
        kind: 'error',
        title: `Couldn't open ${companionApp.displayName || companionApp.name}`,
        message: res.error || 'not installed',
      });
    }
  }, [pushToast]);

  // Persist + apply a community-share consent decision.
  const updateCommunityConsent = useCallback(async (next) => {
    setCommunityConsent(next);
    await api.setCommunityConsent(next);
  }, []);

  // Internal: do the actual rename across all matching items. Shared
  // between the sidebar "Rename" prompt (which asks for the new name) and
  // the DetailPanel save flow (which already has the new name).
  const bulkRenameDeveloperTo = useCallback(async (oldName, newName) => {
    const trimmed = (newName || '').trim();
    if (!oldName || !trimmed || trimmed === oldName) return 0;
    // Bulk rename touches every plugin under the old developer name —
    // a paid feature. Trial users can still rename one plugin at a
    // time through the detail panel.
    if (!requirePaid('bulkOperations', 'Bulk rename a developer')) return 0;
    // Safety: "Unknown" is the placeholder we use when a developer can't
    // be inferred. Many unrelated plugins share it; bulk-renaming it
    // would wrongly group them under a single attribution. Refuse and
    // tell the user how to do the operation safely.
    if (oldName === 'Unknown') {
      pushToast({
        kind: 'error',
        title: "Can't bulk-rename 'Unknown'",
        message: '"Unknown" is a placeholder — many unrelated plugins share it. To rename specific ones, click them in the library (use Cmd-click for multi-select) and edit the developer there, or use the bulk-edit panel.',
        durationMs: 8000,
      });
      return 0;
    }
    const displayedMatches = displayedItems.filter((it) => it.developer === oldName);
    const rawMatches = library.items.filter(
      (it) => (it.developer || '') === oldName ||
              (overrides[it.id] && overrides[it.id].developer === oldName),
    );
    const targets = displayedMatches.length > 0 ? displayedMatches : rawMatches;
    if (targets.length === 0) return 0;
    // Snapshot for undo BEFORE we mutate anything.
    recordUndoOp(`renamed ${targets.length} plugin${targets.length === 1 ? '' : 's'} from "${oldName}" to "${trimmed}"`, targets.map((t) => t.id));
    const next = { ...overrides };
    for (const it of targets) {
      next[it.id] = { ...(next[it.id] || {}), developer: trimmed };
    }
    setOverrides(next);
    for (const it of targets) {
      await api.setOverride(it.id, { developer: trimmed });
    }
    toastWithUndo(`Renamed ${targets.length} plugin${targets.length === 1 ? '' : 's'} from "${oldName}" to "${trimmed}".`);
    return targets.length;
  }, [library.items, displayedItems, overrides, pushToast, recordUndoOp, toastWithUndo]);

  // Sidebar entrypoint: prompts the user for the new name and then runs
  // the shared bulk-rename helper above.
  const bulkRenameDeveloper = useCallback(async (oldName) => {
    if (!oldName) return;
    if (oldName === 'Unknown') {
      pushToast({
        kind: 'info',
        title: "'Unknown' isn't a real developer",
        message: 'It\'s a placeholder for plugins where Plugr couldn\'t identify the developer. Edit each plugin individually (or multi-select with Cmd/Shift) to set a developer.',
        durationMs: 7000,
      });
      return;
    }
    const targetCount = displayedItems.filter((it) => it.developer === oldName).length;
    if (targetCount === 0) {
      window.alert(`No plugins are currently attributed to "${oldName}".`);
      return;
    }
    const newName = window.prompt(
      `Rename "${oldName}" to what? This will apply to all ${targetCount} plugin${targetCount === 1 ? '' : 's'} currently attributed to "${oldName}".\n\n(Leave blank and click OK to cancel.)`,
      oldName,
    );
    if (!newName || !newName.trim()) return;
    await bulkRenameDeveloperTo(oldName, newName);
  }, [displayedItems, bulkRenameDeveloperTo]);

  // Add a user-defined category (and optionally a subcategory under it).
  // Stored as { [category]: string[] } and persisted via prefs:set.
  const addCustomCategory = useCallback(async (category, subcategory) => {
    const c = (category || '').trim();
    if (!c) return;
    const s = (subcategory || '').trim();
    const next = { ...userCategories };
    const existingSubs = Array.isArray(next[c]) ? [...next[c]] : [];
    if (s && !existingSubs.includes(s)) existingSubs.push(s);
    next[c] = existingSubs;
    setUserCategories(next);
    await api.setPrefs({ userCategories: next });
  }, [userCategories]);

  // Clear a registry addition from local state and drop any stored
  // update result for the corresponding item. Shared by the detail-panel
  // Remove button and the DiscoverModal's edit-mode Remove button so both
  // paths actually clean up the UI (previously the modal called onSaved
  // which is a merge-only callback, so removal silently no-op'd).
  const clearRegistryAddition = useCallback((key, itemId) => {
    setRegistryAdditions((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (itemId) {
      setUpdates((prev) => {
        const next = { ...prev };
        if (next[itemId]) delete next[itemId];
        return next;
      });
    }
  }, []);

  // After saving a registry addition, refresh local state so the new
  // updateUrl/regex shows up immediately, and immediately run a single-
  // shot update check for the saved plugin (+ cross-format siblings that
  // will inherit the source) so the user sees the result without having
  // to click "Check for Updates". This is what moves the plugin out of
  // the Unchecked bucket right away.
  const onSavedRegistryAddition = useCallback(async (addition) => {
    if (!discoverItem) return;
    const key = discoverItem.identifier || discoverItem.id;
    setRegistryAdditions((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...addition } }));

    // Build the just-saved item with its new registry fields stitched in,
    // plus any same-family siblings so the check covers all formats of
    // this plugin in one go. Allow URL-only additions through (no
    // versionRegex) — the checker will return 'manual-check' for those,
    // which is exactly what we want stored so the item leaves Unchecked.
    if (!addition || !addition.updateUrl) return;
    const savedFamilyKey = familyKeyFor(discoverItem);
    const itemsToCheck = library.items
      .filter((it) => {
        const sameId = (it.identifier || it.id) === key;
        if (sameId) return true;
        if (!savedFamilyKey) return false;
        return familyKeyFor(it) === savedFamilyKey;
      })
      .map((it) => ({
        ...it,
        registry: { ...(it.registry || {}), ...addition },
      }));

    if (itemsToCheck.length === 0) return;

    try {
      console.log('[onSavedRegistryAddition] auto-checking', itemsToCheck.length, 'items for plugin', discoverItem && discoverItem.name);
      const res = await api.checkUpdates(itemsToCheck);
      console.log('[onSavedRegistryAddition] check result:', res && res.ok, 'results:', res && res.data && res.data.results);
      if (res && res.ok && res.data && Array.isArray(res.data.results)) {
        // Merge new results into the updates state — don't replace
        // anything we already know about other items.
        setUpdates((prev) => {
          const next = { ...prev };
          for (const r of res.data.results) next[r.id] = r;
          return next;
        });
        if (res.data.checkedAt) setUpdatesCheckedAt(res.data.checkedAt);
      }
    } catch (e) { console.warn('[onSavedRegistryAddition] threw:', e && e.message); }
  }, [discoverItem, library.items]);

  // Filtering
  // Shared predicate used by all the per-section filtered views below.
  //
  // `skip` lets a caller exclude one axis from filtering — needed for the
  // sidebar so e.g. the Developers section can show counts respecting the
  // current Update / Format filters but NOT the current activeDeveloper
  // (otherwise selecting a developer would hide every other developer).
  // Same idea for Categories ignoring activeCategory, etc.
  const matchesFilters = useCallback((it, skip = {}) => {
    // Hidden gate runs first. By default hidden items are stripped from
    // every view (this is the whole point of the feature). When the
    // "Hidden" sidebar bucket is active the relationship inverts: ONLY
    // hidden items show, no matter what other filters are picked. The
    // `skip.hidden` escape hatch is used by the Hidden bucket's own
    // counter so it can show its own count regardless of the toggle.
    if (!skip.hidden) {
      if (showHidden) {
        if (!it.hidden) return false;
      } else {
        if (it.hidden) return false;
      }
    }
    if (favoritesOnly && !it.favorite) return false;
    if (!skip.format && !activeFormats.has(it.format)) return false;
    if (!skip.category && activeCategory) {
      if (activeCategory.subcategory) {
        if (it.subcategory !== activeCategory.subcategory) return false;
      } else if (it.category !== activeCategory.category) return false;
    }
    if (!skip.developer && activeDeveloper && it.developer !== activeDeveloper) return false;
    if (!skip.tag && activeTag) {
      if (!Array.isArray(it.tags) || !it.tags.includes(activeTag)) return false;
    }
    if (!skip.update && updateFilter !== 'all') {
      const u = effectiveUpdates[it.id];
      // "Real" check results: outdated, current, ahead, AND manual-check.
      // Ahead means the installed version is newer than what the registry
      // knows about. Manual-check means the user saved a URL knowing
      // Plugr can't auto-detect — that's still an intentional decision,
      // not "unchecked". All of these should NOT fall into Unchecked or
      // Managed buckets.
      const realStatus = u && (u.status === 'outdated' || u.status === 'current' || u.status === 'ahead' || u.status === 'manual-check') ? u.status : null;
      if (updateFilter === 'outdated' && realStatus !== 'outdated') return false;
      // "Up to date" includes ahead — the user has a known version installed
      // and there's nothing to update to.
      if (updateFilter === 'current' && realStatus !== 'current' && realStatus !== 'ahead') return false;
      // Unknown bucket — everything that doesn't have a definitive
      // outdated/current/ahead answer. Used to be three separate
      // buckets (managed / manual-check / unchecked); collapsed since
      // the card itself already surfaces companion app and saved URL.
      if (updateFilter === 'unknown') {
        if (realStatus === 'outdated' || realStatus === 'current' || realStatus === 'ahead') return false;
      }
    }
    if (!skip.cleanup && cleanupFilter !== 'all') {
      const dup = it.duplicate;
      if (cleanupFilter === 'duplicate' && (!dup || dup.status !== 'duplicate')) return false;
      if (cleanupFilter === 'superseded' && (!dup || dup.status !== 'superseded')) return false;
    }
    if (!skip.compat && compatFilter !== 'all') {
      const status = (it.osCompat && it.osCompat.status) || 'unknown';
      if (compatFilter === 'incompatible' && status !== 'incompatible') return false;
      if (compatFilter === 'ok' && status !== 'ok') return false;
      if (compatFilter === 'unknown' && status !== 'unknown') return false;
    }
    if (!skip.search && search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${it.name} ${it.developer} ${it.category} ${it.subcategory} ${it.identifier || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // Project sidebar filter: one of mostUsed / unused / project:<id>.
    // Unmatched plugins are NOT installed library items so they never
    // pass this filter — they're rendered separately via the sidebar
    // bucket itself.
    if (!skip.project && projectFilter) {
      const usedIds = projectMatch.usedItemIds;
      if (projectFilter.kind === 'mostUsed') {
        if (!usedIds.has(it.id)) return false;
      } else if (projectFilter.kind === 'unused') {
        if (usedIds.has(it.id)) return false;
      } else if (projectFilter.kind === 'project') {
        const set = projectMatch.projectsByLibraryId.get(it.id);
        if (!set || !set.has(projectFilter.projectId)) return false;
      } else if (projectFilter.kind === 'unmatched') {
        // Unmatched references aren't library items — nothing should
        // pass this filter when applied to the installed library.
        return false;
      }
    }
    return true;
  }, [showHidden, favoritesOnly, activeFormats, activeCategory, activeDeveloper, activeTag, updateFilter, cleanupFilter, compatFilter, search, updates, projectFilter, projectMatch]);

  const filteredItems = useMemo(() => {
    let items = displayedItems.filter((it) => matchesFilters(it));

    const dir = sortDir === 'desc' ? -1 : 1;
    items = [...items].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'developer': cmp = naturalCompare(a.developer || '', b.developer || '') || naturalCompare(a.name, b.name); break;
        case 'category':  cmp = naturalCompare(a.category || '', b.category || '') || naturalCompare(a.subcategory || '', b.subcategory || '') || naturalCompare(a.name, b.name); break;
        case 'format':    cmp = naturalCompare(a.format || '', b.format || '') || naturalCompare(a.name, b.name); break;
        case 'version':
        case 'recent':    cmp = (a.version || '').localeCompare(b.version || '', undefined, { numeric: true }); break;
        case 'size':      cmp = (a.sizeBytes || 0) - (b.sizeBytes || 0); break;
        case 'status':    cmp = ((effectiveUpdates[a.id] && effectiveUpdates[a.id].status) || '').localeCompare((effectiveUpdates[b.id] && effectiveUpdates[b.id].status) || ''); break;
        case 'name':
        default:          cmp = naturalCompare(a.name, b.name);
      }
      return cmp * dir;
    });
    return items;
  }, [displayedItems, matchesFilters, sortBy, sortDir, updates]);

  // Per-section filter projections — each one applies every active filter
  // EXCEPT its own dimension. Without this, e.g. the Developers section
  // would hide every developer except the one you just picked, defeating
  // the point of having a list.
  const itemsForCategoriesSidebar = useMemo(
    () => displayedItems.filter((it) => matchesFilters(it, { category: true })),
    [displayedItems, matchesFilters],
  );
  const itemsForDevelopersSidebar = useMemo(
    () => displayedItems.filter((it) => matchesFilters(it, { developer: true })),
    [displayedItems, matchesFilters],
  );
  const itemsForCompatSidebar = useMemo(
    () => displayedItems.filter((it) => matchesFilters(it, { compat: true })),
    [displayedItems, matchesFilters],
  );
  // Update status counts: respect every other filter, but not the current
  // update filter itself (you should be able to see how many would be
  // "Up to date" even while you're currently on "Outdated").
  const itemsForUpdateSidebar = useMemo(
    () => displayedItems.filter((it) => matchesFilters(it, { update: true })),
    [displayedItems, matchesFilters],
  );

  // The list the sidebar treats as "everything" for its "All categories" /
  // "All developers" totals and the cleanup "Show all" row. We flip it
  // based on the Hidden toggle so the totals match what's actually in the
  // main view: when Hidden is off (the normal case), hidden plugins are
  // gone from those counts too.
  const sidebarItems = useMemo(
    () => displayedItems.filter((it) => showHidden ? it.hidden : !it.hidden),
    [displayedItems, showHidden],
  );

  const selected = useMemo(
    () => filteredItems.find((x) => x.id === selectedId) || displayedItems.find((x) => x.id === selectedId) || null,
    [filteredItems, displayedItems, selectedId],
  );

  // Materialize the full list of currently-selected items (in the same
  // order as filteredItems for predictable display).
  const selectedItemsList = useMemo(() => {
    if (selectedIds.size === 0) return [];
    return filteredItems.filter((it) => selectedIds.has(it.id));
  }, [filteredItems, selectedIds]);

  // Unified selection handler. The library view forwards click events
  // with optional { toggle, range } modifiers — toggle on Cmd-click,
  // range on Shift-click. Plain click collapses to single-select.
  const handleItemSelect = useCallback((id, mode) => {
    if (id == null) {
      setSelectedIds(new Set());
      setLastSelectedId(null);
      return;
    }
    if (mode && mode.toggle) {
      setSelectedIds((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      setLastSelectedId(id);
      return;
    }
    if (mode && mode.range && lastSelectedId) {
      const idx1 = filteredItems.findIndex((it) => it.id === lastSelectedId);
      const idx2 = filteredItems.findIndex((it) => it.id === id);
      if (idx1 < 0 || idx2 < 0) {
        setSelectedIds(new Set([id]));
        setLastSelectedId(id);
        return;
      }
      const [a, b] = idx1 <= idx2 ? [idx1, idx2] : [idx2, idx1];
      const rangeIds = filteredItems.slice(a, b + 1).map((it) => it.id);
      setSelectedIds(new Set(rangeIds));
      // Don't advance the pivot — Shift-clicking another row should
      // re-anchor the range to the original pivot, matching Finder.
      return;
    }
    // Plain click → single-select.
    setSelectedIds(new Set([id]));
    setLastSelectedId(id);
  }, [filteredItems, lastSelectedId]);

  // Right-click handler for any card/row in the library. Builds either a
  // SINGLE-ITEM or MULTI-SELECT menu based on whether the right-clicked
  // item is part of an active multi-selection — same rule as Finder:
  // right-clicking a non-selected item while a multi-select is active
  // operates on that one item only, never extends the selection.
  const handleItemContextMenu = useCallback((item, event) => {
    if (!item) return;
    const x = (event && event.clientX) || 0;
    const y = (event && event.clientY) || 0;
    const isMulti = selectedIds.has(item.id) && selectedIds.size > 1;

    // Helper: a navigator.clipboard.writeText that tolerates an absent
    // clipboard API (tests / iframe) — silent failure is fine, the
    // alternative is throwing inside a menu action.
    const copy = (text) => {
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text || '');
        }
      } catch { /* swallow */ }
    };

    let items;
    if (isMulti) {
      const sel = filteredItems.filter((it) => selectedIds.has(it.id));
      const names = sel.map((it) => it.name).join('\n');
      const idents = sel.map((it) => it.identifier).filter(Boolean).join('\n');
      items = [
        { group: true, label: `${sel.length} plugins selected` },
        { divider: true },
        { label: 'Copy names', action: () => copy(names) },
        { label: 'Copy bundle identifiers', action: () => copy(idents), disabled: !idents },
        { divider: true },
        {
          label: 'Bulk edit…',
          action: () => {
            // BulkEditPanel auto-mounts when selectedIds.size >= 2.
            // Closing the menu is enough — the panel is already in the DOM.
          },
        },
        {
          label: 'Mark all as favorite',
          action: async () => {
            for (const it of sel) {
              // eslint-disable-next-line no-await-in-loop
              await setItemOverride(it.id, { favorite: true });
            }
          },
        },
        {
          label: 'Hide selected',
          action: async () => {
            for (const it of sel) {
              // eslint-disable-next-line no-await-in-loop
              await setItemOverride(it.id, { hidden: true });
            }
          },
        },
        { divider: true },
        {
          label: `Move ${sel.length} plugins to Trash…`,
          danger: true,
          action: async () => {
            for (const it of sel) {
              // trashItem prompts its own confirm per item — that's the
              // existing single-trash UX and matches what DetailPanel does.
              // eslint-disable-next-line no-await-in-loop
              await trashItem(it);
            }
          },
        },
      ];
    } else {
      const reg = item.registry || {};
      const hasIdentifier = !!item.identifier;
      const hasPath = !!item.path;
      const hasHomepage = !!reg.homepage;
      // "Edit" vs "Find" label depending on whether the user has a saved
      // override addition for this plugin (the same heuristic the detail
      // panel uses when deciding which button to surface).
      const key = item.identifier || item.id;
      const existingAddition = registryAdditions && registryAdditions[key];
      const hasSavedSource = !!(existingAddition && existingAddition.updateUrl);
      const findOrEditLabel = hasSavedSource ? 'Edit update source…' : 'Find update source…';

      items = [
        { label: 'Copy plugin name', action: () => copy(item.name) },
        { label: 'Copy developer', action: () => copy(item.developer || '') },
        { label: 'Copy bundle identifier', action: () => copy(item.identifier || ''), disabled: !hasIdentifier },
        { label: 'Copy file path', action: () => copy(item.path || ''), disabled: !hasPath },
        { divider: true },
        { label: 'Open in Finder', action: () => api.openInFinder(item.path), disabled: !hasPath },
        { label: "Open developer's website", action: () => api.openExternal(reg.homepage), disabled: !hasHomepage },
        { divider: true },
        {
          label: findOrEditLabel,
          action: () => {
            // Match the DetailPanel flow: edit mode preloads the saved
            // values; otherwise the modal runs auto-discover.
            if (hasSavedSource) {
              setDiscoverEditState({
                mode: 'edit',
                existingAddition: {
                  updateUrl: existingAddition.updateUrl || '',
                  versionRegex: existingAddition.versionRegex || '',
                },
              });
            } else {
              setDiscoverEditState(null);
            }
            setDiscoverItem(item);
          },
        },
        {
          label: 'Mirror updates from another plugin…',
          action: () => {
            // MirrorPickerModal reads from the current single selection
            // (it expects `selected` to be set). Promote this item to
            // the selection so the modal opens for the right plugin.
            setSelectedIds(new Set([item.id]));
            setLastSelectedId(item.id);
            setMirrorPickerOpen(true);
          },
        },
        { divider: true },
        {
          label: item.favorite ? '☆ Unfavorite' : '★ Favorite',
          action: () => setItemOverride(item.id, { favorite: !item.favorite }),
        },
        {
          label: item.hidden ? 'Unhide' : 'Hide',
          action: () => setItemOverride(item.id, { hidden: !item.hidden }),
        },
        { divider: true },
        {
          label: 'Move to Trash…',
          danger: true,
          action: () => trashItem(item),
        },
      ];
    }
    setContextMenu({ x, y, item, items });
  }, [filteredItems, selectedIds, registryAdditions, setItemOverride, trashItem]);

  // Bulk apply: walks the selected items and applies the field changes
  // from the BulkEditPanel. Each change layered as a per-item override
  // (same path as the existing single-item edits), so user customizations
  // survive rescans.
  const applyBulkChanges = useCallback(async (changes, items) => {
    if (!changes || !items || items.length === 0) return;
    // Bulk edit applies the same patch to every selected plugin —
    // gated as a paid feature. Trial users can edit one plugin's
    // developer/category/tags via DetailPanel.
    if (!requirePaid('bulkOperations', 'Bulk-editing multiple plugins')) return;
    const patch = {};
    if (typeof changes.developer === 'string' && changes.developer.trim()) {
      patch.developer = changes.developer.trim();
    }
    // Explicit "clear developer override" — sends null so the IPC handler
    // deletes the developer key, reverting to the scan-detected value.
    // Used both for general cleanup and for recovering from the
    // "WhatsApp → Meta swept up everything" mishap.
    if (changes.clearDeveloper) {
      patch.developer = null;
    }
    if (typeof changes.category === 'string' && changes.category) {
      patch.category = changes.category;
      patch.subcategory = changes.subcategory && String(changes.subcategory).trim() ? changes.subcategory : null;
    }
    if (changes.favorite === true) patch.favorite = true;
    if (changes.favorite === false) patch.favorite = false;
    // Mirror updates from another plugin — bulk path. Single-plugin
    // mirroring is in handleSetMirrorFrom; this is the bulk equivalent.
    if (changes.mirrorFromId && typeof changes.mirrorFromId === 'string') {
      patch.mirrorFromId = changes.mirrorFromId;
    }
    if (changes.clearMirrorFromId) {
      patch.mirrorFromId = null;
    }
    // Hidden: tri-state in the panel, two-state on the wire. true hides,
    // false unhides. The main.cjs cleanup drops hidden:false, so unhide
    // collapses the field cleanly.
    if (changes.hidden === true) patch.hidden = true;
    if (changes.hidden === false) patch.hidden = false;
    // Extra category is per-item: append rather than overwrite.
    const extra = changes.addExtraCategory;
    // Tag adds/removes are per-item too — we union/subtract against
    // each item's existing tag set in the loop below.
    const addTags = Array.isArray(changes.addTags) ? changes.addTags : [];
    const removeTags = Array.isArray(changes.removeTags) ? changes.removeTags : [];

    // Are there any "override-track" changes (developer/category/favorite/
    // extra/tags)? If not — e.g. the user only filled the Update source
    // fields — we skip the undo snapshot and the override loop entirely
    // so we don't record a no-op undo or fire a misleading "Applied
    // changes" toast.
    const hasOverrideChanges =
      Object.keys(patch).length > 0 || !!extra || !!changes.clearDeveloper
      || !!changes.clearMirrorFromId
      || addTags.length > 0 || removeTags.length > 0;

    // Snapshot for undo before mutating.
    if (hasOverrideChanges) {
      recordUndoOp(`bulk-edited ${items.length} plugin${items.length === 1 ? '' : 's'}`, items.map((it) => it.id));
    }

    const next = { ...overrides };
    if (hasOverrideChanges) for (const it of items) {
      const existing = next[it.id] || {};
      const merged = { ...existing, ...patch };
      // null developer means "remove this key entirely from the override".
      if (changes.clearDeveloper) delete merged.developer;
      // Same pattern for clearing a mirror link.
      if (changes.clearMirrorFromId) delete merged.mirrorFromId;
      if (extra) {
        const cur = Array.isArray(it.extraCategories) ? it.extraCategories : [];
        const already = cur.some((c) => c.category === extra.category && c.subcategory === extra.subcategory);
        merged.extraCategories = already ? cur : [...cur, extra];
      }
      // Tag union + subtract. Start from existing override tags if
      // present (preserves chains of bulk operations within the same
      // session); otherwise from the item's currently-merged tags.
      if (addTags.length > 0 || removeTags.length > 0) {
        const baseline = Array.isArray(merged.tags) ? merged.tags
                       : Array.isArray(it.tags) ? it.tags : [];
        const set = new Set(baseline);
        for (const t of addTags) set.add(t);
        for (const t of removeTags) set.delete(t);
        const nextTags = [...set];
        if (nextTags.length === 0) delete merged.tags;
        else merged.tags = nextTags;
      }
      next[it.id] = merged;
    }
    if (hasOverrideChanges) {
      setOverrides(next);
      // Persist each item — serial loop is fine, IPC is fast.
      for (const it of items) {
        const itemPatch = { ...patch };
        if (extra) {
          const cur = Array.isArray(it.extraCategories) ? it.extraCategories : [];
          const already = cur.some((c) => c.category === extra.category && c.subcategory === extra.subcategory);
          itemPatch.extraCategories = already ? cur : [...cur, extra];
        }
        await api.setOverride(it.id, itemPatch);
      }
    }
    // Bulk apply of an update source: derive the regex once from the URL +
    // version the user gave us, then save the same addition to every
    // selected item and run a single bulk version check. This is the path
    // Bulk REMOVE saved update sources. Runs BEFORE the updateSource
    // branch so users can both clear-then-apply in a single pass if
    // they ever want to. Records an undo snapshot of registryAdditions
    // before mutating so Cmd+Z (via the toast) puts everything back.
    if (changes.removeUpdateSource) {
      recordAdditionsUndo(`removed update source from ${items.length} plugin${items.length === 1 ? '' : 's'}`);
      const nextAdditions = { ...registryAdditions };
      let cleared = 0;
      for (const it of items) {
        const key = it.identifier || it.id;
        if (nextAdditions[key]) {
          try {
            await api.saveRegistryAddition(key, null);
            delete nextAdditions[key];
            cleared++;
          } catch { /* per-item failure won't block the rest */ }
        }
      }
      setRegistryAdditions(nextAdditions);
      // Clear stale update-check results too. Without this, a plugin
      // that was last checked while a now-deleted source was active
      // still shows "Newer than registry" or whatever the old check
      // returned — and the DetailPanel thinks the source still works
      // (because updateIsWorking is true), so it hides the
      // "Find update source" button. Clearing the per-id updates
      // map entry resets the plugin to "Unchecked" cleanly.
      setUpdates((prev) => {
        const next = { ...prev };
        for (const it of items) {
          if (next[it.id]) delete next[it.id];
        }
        return next;
      });
      // Persist the cleared updates to disk. Without this, the in-memory
      // setUpdates above worked for the rest of the session, but on next
      // launch the cached `updates` map still held the stale entries —
      // so the plugin came back showing "Newer than registry" even
      // though its source was gone. (Cache used to only get a fresh
      // `updates` snapshot on the next `updates:check` IPC.)
      try {
        const idsToClear = items.map((it) => it.id).filter(Boolean);
        if (idsToClear.length > 0) await api.clearUpdatesForIds(idsToClear);
      } catch { /* best-effort; in-memory state is already correct */ }
      toastWithUndo(`Removed update source from ${cleared} plugin${cleared === 1 ? '' : 's'}.`);
    }

    // that handles "BC Chorus 4 VST(Mono) / VST3(Stereo) / etc." where
    // automatic propagation can't tell the plugins are the same product.
    if (changes.updateSource && changes.updateSource.url) {
      const src = changes.updateSource;
      let updateUrl = src.url;
      let versionRegex = src.regex;

      // Helper: persist a finalized addition (URL + maybe-regex) to every
      // selected item, refresh local state, and trigger one combined
      // version check. The "manual-check" status flows naturally when
      // versionRegex is empty. Returns the check results so the caller
      // can show a tally toast.
      async function saveAdditionToAll(finalAddition) {
        const nextAdditions = { ...registryAdditions };
        for (const it of items) {
          const key = it.identifier || it.id;
          try {
            await api.saveRegistryAddition(key, finalAddition);
            nextAdditions[key] = { ...(nextAdditions[key] || {}), ...finalAddition };
          } catch { /* per-item failure won't block the rest */ }
        }
        setRegistryAdditions(nextAdditions);

        const itemsForCheck = items.map((it) => ({
          ...it,
          registry: { ...(it.registry || {}), ...finalAddition },
        }));
        let checkResults = [];
        try {
          const res = await api.checkUpdates(itemsForCheck);
          if (res && res.ok && res.data && Array.isArray(res.data.results)) {
            checkResults = res.data.results;
            setUpdates((prev) => {
              const next = { ...prev };
              for (const r of res.data.results) next[r.id] = r;
              return next;
            });
            if (res.data.checkedAt) setUpdatesCheckedAt(res.data.checkedAt);
          }
        } catch { /* silent — user can re-check */ }
        return checkResults;
      }

      // Build a human-readable breakdown of check outcomes for toast.
      function tallyResults(results) {
        const tally = { outdated: 0, current: 0, ahead: 0, 'manual-check': 0, failed: 0, other: 0 };
        for (const r of results) {
          if (r.status === 'outdated') tally.outdated++;
          else if (r.status === 'current') tally.current++;
          else if (r.status === 'ahead') tally.ahead++;
          else if (r.status === 'manual-check') tally['manual-check']++;
          else if (r.status === 'parse-failed' || r.status === 'error') tally.failed++;
          else tally.other++;
        }
        const parts = [];
        if (tally.outdated) parts.push(`${tally.outdated} update${tally.outdated === 1 ? '' : 's'} available`);
        if (tally.current) parts.push(`${tally.current} up to date`);
        if (tally.ahead) parts.push(`${tally.ahead} ahead of registry`);
        if (tally['manual-check']) parts.push(`${tally['manual-check']} check manually`);
        if (tally.failed) parts.push(`${tally.failed} check failed`);
        if (tally.other) parts.push(`${tally.other} unchecked`);
        return { tally, summary: parts.join(' · ') };
      }

      // Track whether derivation used a fallback (couldn't anchor on the
      // exact version the user typed). We still save in that case — better
      // to have an imperfect source the user can edit than to silently
      // refuse to save.
      let deriveWarning = null;

      // If the user didn't supply a regex, derive one once. Use the first
      // selected item's name as the anchor.
      if (!versionRegex && src.version) {
        try {
          const r = await api.deriveSourceFromVersion({
            url: src.url,
            knownVersion: src.version,
            name: items[0] ? items[0].name : '',
          });
          if (r && r.ok && r.data && r.data.versionRegex) {
            updateUrl = r.data.url || updateUrl;
            versionRegex = r.data.versionRegex;
            if (r.data.warning) deriveWarning = r.data.message || 'Pattern may need tweaking later.';
          } else {
            // Derivation truly couldn't proceed (network error, etc.).
            // Save URL-only as the manual-check fallback so the user
            // still gets a clickable bookmark.
            versionRegex = '';
            deriveWarning = (r && r.error) || 'Could not analyze that page — saved URL only.';
          }
        } catch (e) {
          versionRegex = '';
          deriveWarning = String(e && e.message || e);
        }
      }

      // If derivation produced a low-confidence pattern (the user's version
      // wasn't on the page, so we fell back to a generic regex that will
      // probably report a wrong version on the check), offer the user a
      // cleaner option: save as Check manually instead of silently saving
      // an imprecise regex.
      if (deriveWarning && versionRegex) {
        const useManualCheck = await requestConfirm({
          title: `Couldn't auto-detect "${src.version}" on that page`,
          body: (
            <>
              <p>Plugr couldn't find <code>{src.version}</code> in the page's text. The auto-built pattern will probably report a different version on the next check (or fail to match anything).</p>
              <p>
                Save the URL as <strong>Check manually</strong> for all <strong>{items.length} selected plugin{items.length === 1 ? '' : 's'}</strong> instead?
                You'll get a one-click jump to the page so you can verify versions by hand — Plugr just won't try to auto-compare.
              </p>
            </>
          ),
          details: `If you choose No, the imprecise regex gets saved anyway and you can edit each plugin individually.`,
          yesLabel: `Yes, mark all ${items.length} as Check manually`,
          noLabel: 'No, save the regex anyway',
          destructive: false,
        });
        if (useManualCheck) {
          versionRegex = '';
          deriveWarning = 'Saved URL only — all marked as Check manually.';
        }
      }

      if (!updateUrl) {
        pushToast({
          kind: 'error',
          title: 'Update source not applied',
          message: 'A URL is required.',
          durationMs: 8000,
        });
        return;
      }

      const addition = {
        updateUrl,
        versionRegex,
        addedAt: new Date().toISOString(),
        addedBy: 'bulk-apply',
      };

      const results = await saveAdditionToAll(addition);
      const { tally, summary } = tallyResults(results);
      // If any failed OR derivation fell back to a generic pattern, use
      // a warning toast so the user sees they may need to fine-tune.
      const hadFailures = tally.failed > 0 || !!deriveWarning;
      const message = deriveWarning
        ? `${deriveWarning} ${summary ? `· ${summary}` : ''}`.trim()
        : (summary || 'Source saved; check finished.');
      pushToast({
        kind: hadFailures ? 'warning' : 'success',
        title: `Update source saved to ${items.length} plugin${items.length === 1 ? '' : 's'}`,
        message,
        durationMs: 9000,
      });
    }

    // Only show the "Applied changes" undo toast when override fields
    // actually changed — the updateSource branch issues its own toast
    // and isn't part of the undo system.
    if (hasOverrideChanges) {
      toastWithUndo(`Applied changes to ${items.length} plugin${items.length === 1 ? '' : 's'}.`);
    }
  }, [overrides, recordUndoOp, toastWithUndo, registryAdditions, pushToast, requestConfirm]);

  const updateStatusCounts = useMemo(() => {
    // Count over the projection that respects every active filter EXCEPT
    // the update filter itself — so the user can see how many would land
    // in each update bucket given their other active filters.
    const c = { all: itemsForUpdateSidebar.length, outdated: 0, current: 0, unknown: 0 };
    for (const it of itemsForUpdateSidebar) {
      const u = effectiveUpdates[it.id];
      const isReal = u && (u.status === 'outdated' || u.status === 'current' || u.status === 'ahead');
      if (isReal && u.status === 'outdated') c.outdated++;
      // 'ahead' (installed > registry) counts as Up to date.
      else if (isReal && (u.status === 'current' || u.status === 'ahead')) c.current++;
      // Everything else — no result, manual-check, or companion-managed —
      // rolls up into a single Unknown bucket. Per-card UpdateBadge still
      // shows the distinction.
      else c.unknown++;
    }
    return c;
  }, [itemsForUpdateSidebar, effectiveUpdates]);

  const favoritesCount = useMemo(
    () => displayedItems.reduce((n, it) => n + (it.favorite && !it.hidden ? 1 : 0), 0),
    [displayedItems],
  );

  // Total hidden items in the library, regardless of any other active
  // filter. Drives the "Hidden" sidebar row's count badge.
  const hiddenCount = useMemo(
    () => displayedItems.reduce((n, it) => n + (it.hidden ? 1 : 0), 0),
    [displayedItems],
  );

  // List of every developer name currently in the library. Drives the
  // autocomplete <datalist> for the developer text inputs. Sorted by
  // frequency so the most-used ones appear first.
  const knownDevelopers = useMemo(() => {
    const counts = new Map();
    for (const it of displayedItems) {
      const d = it.developer;
      if (!d || d === 'Unknown') continue;
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([d]) => d);
  }, [displayedItems]);

  // Drop handler used by sidebar developer/category drop targets. The
  // library view sets `application/x-plugr-items` on dragstart to a
  // JSON array of plugin ids. When dropped onto a sidebar target, we
  // confirm the change and apply it across all dragged plugins.
  const applyDropOnDeveloper = useCallback(async (targetDeveloper, ids) => {
    if (!targetDeveloper || !ids || ids.length === 0) return;
    const targets = displayedItems.filter((it) => ids.includes(it.id) && it.developer !== targetDeveloper);
    if (targets.length === 0) {
      pushToast({ kind: 'info', message: `All ${ids.length} dragged plugin${ids.length === 1 ? ' is' : 's are'} already attributed to "${targetDeveloper}".`, durationMs: 3500 });
      return;
    }
    const ok = window.confirm(
      `Change developer for ${targets.length} dragged plugin${targets.length === 1 ? '' : 's'} to "${targetDeveloper}"?`,
    );
    if (!ok) return;
    recordUndoOp(`reassigned ${targets.length} plugin${targets.length === 1 ? '' : 's'} to "${targetDeveloper}"`, targets.map((t) => t.id));
    const next = { ...overrides };
    for (const it of targets) next[it.id] = { ...(next[it.id] || {}), developer: targetDeveloper };
    setOverrides(next);
    for (const it of targets) await api.setOverride(it.id, { developer: targetDeveloper });
    toastWithUndo(`Reassigned ${targets.length} plugin${targets.length === 1 ? '' : 's'} to "${targetDeveloper}".`);
  }, [displayedItems, overrides, pushToast, recordUndoOp, toastWithUndo]);

  const applyDropOnCategory = useCallback(async ({ category, subcategory }, ids) => {
    if (!category || !ids || ids.length === 0) return;
    const targets = displayedItems.filter((it) => ids.includes(it.id));
    const label = subcategory ? `${category} / ${subcategory}` : category;
    const ok = window.confirm(
      `Change category for ${targets.length} dragged plugin${targets.length === 1 ? '' : 's'} to "${label}"?`,
    );
    if (!ok) return;
    recordUndoOp(`reclassified ${targets.length} plugin${targets.length === 1 ? '' : 's'} as "${label}"`, targets.map((t) => t.id));
    const next = { ...overrides };
    const patch = { category, subcategory: subcategory || null };
    for (const it of targets) next[it.id] = { ...(next[it.id] || {}), ...patch };
    setOverrides(next);
    for (const it of targets) await api.setOverride(it.id, patch);
    toastWithUndo(`Reclassified ${targets.length} plugin${targets.length === 1 ? '' : 's'} as "${label}".`);
  }, [displayedItems, overrides, pushToast, recordUndoOp, toastWithUndo]);

  const knownCategories = useMemo(() => {
    const map = new Map();
    const ensure = (c, s) => {
      if (!c) return;
      if (!map.has(c)) map.set(c, new Set());
      // Don't seed the subcategory set with values that duplicate the parent
      // — those should render as "no subcategory" not as a redundant option.
      if (s && s.toLowerCase() !== c.toLowerCase()) map.get(c).add(s);
    };
    for (const it of displayedItems) {
      ensure(it.category, it.subcategory);
      if (it.categoryCandidates) for (const cc of it.categoryCandidates) ensure(cc.category, cc.subcategory);
    }
    // Built-in canonical categories. MIDI has no subcategories — the
    // top-level label is sufficient. "Undefined" is BOTH a subcategory of
    // Effect (for AU `aufx` plugins whose name yields no specific match —
    // we know it's an effect, just not what kind) AND a top-level category
    // for plugins where we couldn't determine even that much. We removed
    // the legacy "Other / Uncategorized" bucket: everything is now either
    // a real category (Effect / Instrument / MIDI / Application) or
    // explicitly Undefined.
    const PRESETS = {
      Effect: ['EQ', 'Dynamics', 'Reverb', 'Delay', 'Modulation', 'Distortion', 'Pitch', 'Imaging', 'Utility', 'Creative', 'Multi-Effect', 'Undefined'],
      Instrument: ['Synth', 'Sampler', 'Drums', 'Keys', 'Bass', 'Guitar/Bass', 'Orchestral'],
      MIDI: [],
      Application: ['Application', 'DAW'],
      Undefined: [],
    };
    for (const [c, subs] of Object.entries(PRESETS)) {
      if (!map.has(c)) map.set(c, new Set());
      for (const s of subs) ensure(c, s);
    }
    // User-defined custom categories — guaranteed to appear in the dropdowns
    // even if no items currently use them.
    for (const [c, subs] of Object.entries(userCategories || {})) {
      if (!c) continue;
      if (!map.has(c)) map.set(c, new Set());
      if (Array.isArray(subs)) for (const s of subs) ensure(c, s);
    }
    return [...map.entries()]
      .map(([category, subSet]) => ({ category, subcategories: [...subSet].sort() }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }, [displayedItems, userCategories]);

  // Aggregate every tag the user has applied across the library so
  // the DetailPanel's TagInput can suggest existing tags (reduces
  // typo'd duplicates like "vocal" vs "vocals") and the sidebar's
  // Tags section can render counts.
  const tagCounts = useMemo(() => {
    const counts = new Map();
    for (const it of displayedItems) {
      if (!Array.isArray(it.tags)) continue;
      for (const t of it.tags) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return counts;
  }, [displayedItems]);
  const knownTags = useMemo(
    () => [...tagCounts.keys()].sort((a, b) => a.localeCompare(b)),
    [tagCounts],
  );

  const showFirstRunScreen = !cacheLoaded || (scanning && library.items.length === 0);
  const showNoMatchScreen = !showFirstRunScreen && filteredItems.length === 0 && !(projectFilter && projectFilter.kind === 'unmatched');

  // Window-level drag handlers for project files. The user can drop
  // .als / .alp / .logicx / .flp anywhere on the app shell and we'll
  // route it to the project scanner.
  const PROJECT_EXTS = ['.als', '.alp', '.logicx', '.flp'];
  function isProjectDrag(e) {
    if (!e.dataTransfer) return false;
    // During dragenter/over Chrome only lets us see types, not the
    // filenames. Files type is enough to know it's an OS-file drop —
    // we accept it tentatively and re-check on drop.
    return e.dataTransfer.types && e.dataTransfer.types.includes('Files');
  }
  function onShellDragEnter(e) {
    if (!isProjectDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setProjectDragActive(true);
  }
  function onShellDragOver(e) {
    if (!isProjectDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onShellDragLeave(e) {
    if (!isProjectDrag(e)) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setProjectDragActive(false);
  }
  function onShellDrop(e) {
    if (!isProjectDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setProjectDragActive(false);
    const files = [...(e.dataTransfer.files || [])];
    const projectPaths = files
      .map((f) => f.path)
      .filter((p) => p && PROJECT_EXTS.some((ext) => p.toLowerCase().endsWith(ext)));
    // Folders that were dragged in get scanned recursively.
    const folderPaths = files
      .filter((f) => f.path && !path_endsWithProjectExt(f.path))
      .map((f) => f.path);
    if (projectPaths.length === 0 && folderPaths.length === 0) {
      pushToast({
        kind: 'info',
        message: 'Nothing to scan — drop an .als / .alp / .logicx / .flp file or a folder of them.',
        durationMs: 4000,
      });
      return;
    }
    // Hop to the Projects tab so the user sees the scan happen + the
    // result appear in place. Without this, dropping while on the
    // Library tab would scan invisibly and the user would have to
    // manually switch tabs to see what landed. (We also do this when
    // they're already on Projects — harmless no-op there.)
    changeAppView('projects');
    runScanProjectPaths({ files: projectPaths, folders: folderPaths });
  }

  return (
   <AudioVolumeProvider
     volume={audioVolume}
     setVolume={updateAudioVolume}
     claimPlayback={claimPlayback}
     busRef={audioBusRef}
   >
    <div
      className="app-shell"
      onDragEnter={onShellDragEnter}
      onDragOver={onShellDragOver}
      onDragLeave={onShellDragLeave}
      onDrop={onShellDrop}
    >
      {/* Trial / license countdown banner. Renders nothing when the
       *  user has an active license. During the trial it shows a
       *  count-down with optional Upgrade CTA; post-expiry it's a
       *  hard-to-miss red bar that still doesn't block the app — the
       *  user can browse their library + the deals tab forever. */}
      <TrialBanner
        entitlements={entitlements}
        onUpgrade={() => setBuyDialogOpen(true)}
      />

      {/* Global progress strip. Lives at the app-shell level (not
       *  inside any tab) so scans / update checks / project walks /
       *  deal refreshes stay visible regardless of which tab the user
       *  is on. position:fixed so it floats at the bottom of the
       *  viewport.
       *
       *  Indeterminate vs. determinate: during the early walking phase
       *  of a project scan we don't yet know how many files exist, so
       *  the backend emits {current:0, total:1} as a sentinel. We treat
       *  that as "indeterminate" — show an animated sweeping bar and
       *  drop the misleading "(0/1)" counter suffix. Once the walk is
       *  done and we're parsing each project, total becomes the real
       *  count and the counter + filled bar take over. */}
      {progress && progress.total > 0 && (() => {
        const isIndeterminate = progress.total <= 1 && progress.current === 0;
        return (
          <div
            className={`progress-bar-strip ${isIndeterminate ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-valuenow={isIndeterminate ? undefined : progress.current}
            aria-valuemax={isIndeterminate ? undefined : progress.total}
            aria-label={progress.message}
          >
            {!isIndeterminate && (
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }}
              />
            )}
            <div className="progress-bar-label">
              {progress.message}
              {!isIndeterminate && (
                <> <span className="muted">({progress.current}/{progress.total})</span></>
              )}
            </div>
          </div>
        );
      })()}
      {projectDragActive && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0, 0, 0, 0.55)',
            border: '3px dashed rgba(255, 255, 255, 0.5)',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: '18px',
            fontWeight: 600,
            pointerEvents: 'none',
            backdropFilter: 'blur(2px)',
          }}
        >
          Drop DAW project files to scan
        </div>
      )}
      {/* Global autocomplete sources. The text inputs in DetailPanel and
       * BulkEditPanel reference these by id via the HTML `list` attribute,
       * so users get a typeahead suggestion list drawn from their actual
       * library data — e.g. typing "W" suggests "W. A. Production",
       * "Waves", "Wavesfactory", etc. */}
      <datalist id="known-developers-dl">
        {knownDevelopers.map((d) => <option key={d} value={d} />)}
      </datalist>
      <datalist id="known-categories-dl">
        {knownCategories.map((c) => <option key={c.category} value={c.category} />)}
      </datalist>

      <TabBar
        active={appView}
        onChange={changeAppView}
        onBrandClick={handleBrandClick}
        tabs={(() => {
          // Build the full tab list, then optionally filter out hidden
          // ones. The filter only applies when the tabVisibility
          // entitlement is on — free + trial-expired users see every
          // tab, which is the "graceful trial-end transition"
          // requirement: a user's saved hiddenTabs list survives the
          // downgrade but stops affecting the UI until they re-upgrade.
          // The Plugins & Apps tab is never hideable — it's the home
          // base and hiding it would orphan a user who closed it.
          const all = [
            { id: 'library',  label: 'Plugins & Apps', hint: 'Plugin & app organizer', hideable: false },
            { id: 'projects', label: 'Projects',       hint: 'DAW project organizer', hideable: true },
            { id: 'apps',     label: 'Companion Apps', hint: 'Update managers — Native Access, Waves Central, etc.', hideable: true },
            { id: 'deals',    label: 'Deals',          hint: 'Sales on plugins (refreshed daily)', badge: newDealsCount, hideable: true },
            { id: 'tools',    label: 'Tools',          hint: 'Tap tempo, BPM ↔ delay, Camelot wheel, etc.', hideable: true },
          ];
          const entitled = !!(entitlements && entitlements.features && entitlements.features.tabVisibility !== false);
          if (!entitled) return all;
          // Never filter out the active tab — if the user landed on a
          // tab that's now hidden (e.g. they hid Deals while on the
          // Deals tab), keep it visible until they switch away. This
          // mirrors how macOS Safari treats the focused tab when
          // toggling tab bars.
          return all.filter((t) => !t.hideable || !hiddenTabs.includes(t.id) || t.id === appView);
        })()}
        hiddenTabs={hiddenTabs}
        allTabs={[
          { id: 'projects', label: 'Projects' },
          { id: 'apps',     label: 'Companion Apps' },
          { id: 'deals',    label: 'Deals' },
          { id: 'tools',    label: 'Tools' },
        ]}
        canHideTabs={!!(entitlements && entitlements.features && entitlements.features.tabVisibility !== false)}
        onHideTab={(tabId) => toggleTabHidden(tabId, true)}
        onShowTab={(tabId) => toggleTabHidden(tabId, false)}
        onHideTabBlocked={() => {
          // Free / trial-expired user clicked Hide → upsell flow. The
          // same requirePaid pattern we use elsewhere; pops a toast
          // pointing at the buy dialog.
          requirePaid('tabVisibility', 'Hiding tabs');
        }}
        rightAccessories={(
          <>
            <VolumeControl value={audioVolume} onChange={updateAudioVolume} />
            <button
              className="btn icon-btn theme-btn"
              onClick={() => setShowThemePicker(true)}
              title={`Theme: ${themePreference || 'auto'} — click to change`}
              aria-label="Theme"
            >
              {themePreference === 'light' ? '☀'
                : themePreference === 'dark' ? '☾'
                : themePreference === 'auto' ? '◐'
                : '◉'}
            </button>
            <button
              className="btn icon-btn"
              onClick={() => { setHelpInitialTab('tips'); setShowHelp(true); }}
              title="Help and tips"
              aria-label="Help"
            >?</button>
          </>
        )}
      />

      {/* Positioned tab container — child tabs use position:absolute so
       *  switching between them is a paint flip, not a layout recompute. */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

      {(mountedTabs.has('tools')) && (
        <div style={tabStyle(appView === 'tools')}>
          <Frozen active={appView === 'tools'}>
            <ToolsView />
          </Frozen>
        </div>
      )}
      {(mountedTabs.has('deals')) && (
        <div style={tabStyle(appView === 'deals')}>
        <Frozen active={appView === 'deals'}>
        <DealsView
          api={api}
          libraryItems={displayedItems}
          pushToast={pushToast}
          savedDealsInitial={savedDeals}
          currencyPref={currencyPref}
          findAlertForDeal={findAlertForDeal}
          onToggleDealAlert={toggleDealAlertForDeal}
        />
        </Frozen>
        </div>
      )}
      {(mountedTabs.has('apps')) && (
        <div style={tabStyle(appView === 'apps')}>
          <Frozen active={appView === 'apps'}>
            <CompanionAppsView
              items={displayedItems}
              updates={effectiveUpdates}
              onOpenCompanionApp={openCompanionApp}
            />
          </Frozen>
        </div>
      )}
      {(mountedTabs.has('projects')) && (
        <div style={tabStyle(appView === 'projects')}>
        <Frozen active={appView === 'projects'}>
        <ProjectsView
          projectLibrary={projectLibrary}
          projectMatch={projectMatch}
          projectTags={projectTags}
          projectNotes={projectNotes}
          projectBounceOverrides={projectBounceOverrides}
          projectRatings={projectRatings}
          projectStatuses={projectStatuses}
          projectKeyOverrides={projectKeyOverrides}
          customStatuses={customStatuses}
          libraryItems={displayedItems}
          onAddProjectFolder={runAddProjectFolder}
          onRescanProjects={() => {
            // Rescan everything we know about — folders that were
            // added wholesale AND individual project files the user
            // dragged in (those don't live under any tracked folder
            // so the folder-walk alone would miss them).
            const lib = projectLibrary || { folders: [], projects: [] };
            const folders = lib.folders || [];
            const projects = lib.projects || [];
            const orphanFiles = projects
              .filter((p) => {
                if (!p.path) return false;
                return !folders.some((f) => p.path === f || p.path.startsWith(f + '/'));
              })
              .map((p) => p.path);
            runScanProjectPaths({ folders, files: orphanFiles });
          }}
          onClearProjects={async () => {
            await api.clearProjects();
            setProjectLibrary(null);
            setProjectFilter(null);
            pushToast({ kind: 'success', message: 'Cleared project data.', durationMs: 3000 });
          }}
          onRemoveProjectFolder={async (folder, opts) => {
            // `opts` arrives as { alsoRemoveProjects: bool } from the
            // Manage Folders dialog. Legacy callers (sidebar × chip)
            // omit it; preload defaults that to true to preserve the
            // old "drop both" behavior.
            const res = await api.removeProjectFolder(folder, opts);
            if (res && res.ok) setProjectLibrary(res.projectLibrary || null);
          }}
          onSetTags={updateProjectTags}
          onSetNotes={updateProjectNotes}
          onAddManualBounce={addManualBounce}
          onDropBouncesOnProject={addBouncesFromPaths}
          onDismissAutoBounce={dismissAutoBounce}
          onRemoveManualBounce={removeManualBounce}
          onOpenInDAW={async (p) => {
            const res = await api.openProjectInDAW(p);
            if (res && !res.ok && !res.canceled) {
              pushToast({ kind: 'error', title: "Couldn't open project", message: res.error });
            }
          }}
          onRevealInFinder={(p) => api.openInFinder(p)}
          onJumpToPluginInLibrary={jumpToPluginInLibrary}
          onSetRating={updateProjectRating}
          onSetStatus={updateProjectStatus}
          onSetKeyOverride={updateProjectKeyOverride}
          onSetStatusList={updateStatusList}
        />
        </Frozen>
        </div>
      )}
      {(mountedTabs.has('library')) && (
      <div style={tabStyle(appView === 'library')}>
      <Frozen active={appView === 'library'}>
      <Toolbar
        scanning={scanning}
        checking={checking}
        onScan={runScan}
        onCheckUpdates={runUpdateCheck}
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
        sortBy={sortBy}
        onSortChange={(v) => { applySortBy(v); applySortDir('asc'); }}
        view={view}
        onViewChange={applyView}
        outdatedCount={updateStatusCounts.outdated}
        totalCount={library.items.length}
        scannedAt={library.scannedAt}
        updatesCheckedAt={updatesCheckedAt}
        totalBytes={library.summary && library.summary.totalBytes}
        progress={progress}
        onBrandClick={handleBrandClick}
      />
      <div className="body">
        <Sidebar
          summary={library.summary}
          activeFormats={activeFormats}
          onToggleFormat={(fmt) => {
            const next = new Set(activeFormats);
            if (next.has(fmt)) next.delete(fmt); else next.add(fmt);
            setActiveFormats(next);
          }}
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
          activeDeveloper={activeDeveloper}
          onSelectDeveloper={setActiveDeveloper}
          activeTag={activeTag}
          onSelectTag={setActiveTag}
          tagCounts={tagCounts}
          updateFilter={updateFilter}
          onUpdateFilterChange={setUpdateFilter}
          updateStatusCounts={updateStatusCounts}
          cleanupFilter={cleanupFilter}
          onCleanupFilterChange={setCleanupFilter}
          favoritesOnly={favoritesOnly}
          onFavoritesOnlyChange={setFavoritesOnly}
          favoritesCount={favoritesCount}
          showHidden={showHidden}
          onShowHiddenChange={setShowHidden}
          hiddenCount={hiddenCount}
          items={sidebarItems}
          itemsForCategories={itemsForCategoriesSidebar}
          itemsForDevelopers={itemsForDevelopersSidebar}
          itemsForCompat={itemsForCompatSidebar}
          categorySort={categorySort}
          onCategorySortChange={updateCategorySort}
          developerSort={developerSort}
          onDeveloperSortChange={updateDeveloperSort}
          formatSort={formatSort}
          onFormatSortChange={updateFormatSort}
          onBulkRenameDeveloper={bulkRenameDeveloper}
          onDiscoverAll={runDiscoverAll}
          compatFilter={compatFilter}
          onCompatFilterChange={updateCompatFilter}
          onDropOnDeveloper={applyDropOnDeveloper}
          onDropOnCategory={applyDropOnCategory}
          sectionOrder={sidebarSectionOrder}
          onSectionOrderChange={updateSidebarSectionOrder}
          projectLibrary={projectLibrary}
          projectMatch={projectMatch}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          onAddProjectFolder={runAddProjectFolder}
          onRescanProjects={() => {
            // Rescan everything we know about — folders that were
            // added wholesale AND individual project files the user
            // dragged in (those don't live under any tracked folder
            // so the folder-walk alone would miss them).
            const lib = projectLibrary || { folders: [], projects: [] };
            const folders = lib.folders || [];
            const projects = lib.projects || [];
            const orphanFiles = projects
              .filter((p) => {
                if (!p.path) return false;
                return !folders.some((f) => p.path === f || p.path.startsWith(f + '/'));
              })
              .map((p) => p.path);
            runScanProjectPaths({ folders, files: orphanFiles });
          }}
          onClearProjects={async () => {
            await api.clearProjects();
            setProjectLibrary(null);
            setProjectFilter(null);
            pushToast({ kind: 'success', message: 'Cleared project data.', durationMs: 3000 });
          }}
        />
        <main className="main-area">
          {/* In-flow error banner intentionally removed — errors now show
           *  as floating toasts that stay visible regardless of scroll. */}
          {showFirstRunScreen ? (
            <EmptyState
              title="Scanning your plugin library…"
              subtitle="This may take 30–60 seconds. We're reading your VST3, AU, VST2, AAX, CLAP, and Applications folders."
            />
          ) : showNoMatchScreen ? (
            library.items.length === 0 ? (
              <EmptyState
                title="No plugins or apps found"
                subtitle="Click the button below to scan your plugin folders. Plugr never modifies your files — it only reads them."
                primaryAction={{ label: 'Scan Library', onClick: runScan }}
                secondaryAction={{ label: 'Show tutorial', onClick: () => setShowTutorial(true) }}
              />
            ) : (
              <EmptyState
                title="Nothing matches your filters"
                subtitle="Try clearing the search or unticking some sidebar filters."
                primaryAction={{ label: 'Clear filters', onClick: () => {
                  setSearch('');
                  setActiveCategory(null);
                  setActiveDeveloper(null);
                  setActiveTag(null);
                  setUpdateFilter('all');
                  setCleanupFilter('all');
                  setCompatFilter('all');
                  setFavoritesOnly(false);
                  setActiveFormats(new Set(FORMAT_LIST));
                } }}
              />
            )
          ) : (
            <>
              {/* "What I actually use" headline. Only renders when at
               *  least one project has been scanned. Clickable to filter
               *  the library to just the plugins in use. */}
              {projectLibrary && projectLibrary.projects && projectLibrary.projects.length > 0 && (
                <div
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    fontSize: '13px',
                  }}
                >
                  <div>
                    <span style={{ opacity: 0.65 }}>You use </span>
                    <button
                      type="button"
                      onClick={() => setProjectFilter(projectFilter && projectFilter.kind === 'mostUsed' ? null : { kind: 'mostUsed' })}
                      style={{ background: 'none', border: 'none', color: 'var(--accent, #6ec1ff)', cursor: 'pointer', fontWeight: 600, padding: 0, fontSize: 'inherit' }}
                      title="Click to filter to just the plugins used in your projects"
                    >
                      {projectMatch.usedItemIds.size.toLocaleString()}
                    </button>
                    <span style={{ opacity: 0.65 }}> of your </span>
                    <span style={{ fontWeight: 600 }}>{displayedItems.length.toLocaleString()}</span>
                    <span style={{ opacity: 0.65 }}> plugins
                      {' '}({Math.round((projectMatch.usedItemIds.size / Math.max(1, displayedItems.length)) * 100)}%)
                      {' '}across {projectLibrary.projects.length.toLocaleString()} project{projectLibrary.projects.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {projectMatch.unmatchedReferences.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setProjectFilter(projectFilter && projectFilter.kind === 'unmatched' ? null : { kind: 'unmatched' })}
                      style={{ background: 'none', border: '1px solid var(--accent-soft, rgba(255,255,255,0.15))', borderRadius: '4px', color: 'var(--text-muted, rgba(255,255,255,0.7))', cursor: 'pointer', fontSize: '11px', padding: '3px 8px' }}
                      title="Plugins referenced by projects that aren't installed on this Mac"
                    >
                      {projectMatch.unmatchedReferences.length} referenced but not installed
                    </button>
                  )}
                </div>
              )}
              {projectFilter && projectFilter.kind === 'unmatched' ? (
                <UnmatchedReferencesList
                  references={projectMatch.unmatchedReferences || []}
                  projects={(projectLibrary && projectLibrary.projects) || []}
                  onOpenExternal={(url) => api.openExternal(url)}
                />
              ) : (
              <LibraryView
                items={filteredItems}
              updates={effectiveUpdates}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onSelect={handleItemSelect}
              onToggleFavorite={(id, val) => setItemOverride(id, { favorite: val })}
              view={view}
              draggable={true}
              sortBy={sortBy}
              sortDir={sortDir}
              onSortChange={(col) => {
                if (col === sortBy) applySortDir(sortDir === 'asc' ? 'desc' : 'asc');
                else { applySortBy(col); applySortDir('asc'); }
              }}
                columnWidths={columnWidths}
                onColumnWidthsChange={updateColumnWidths}
                projectUsageById={perItemProjectSummary}
                onItemContextMenu={handleItemContextMenu}
              />
              )}
            </>
          )}
        </main>
        {selectedIds.size > 1 ? (
          <BulkEditPanel
            items={selectedItemsList}
            allItems={displayedItems}
            knownCategories={knownCategories}
            knownTags={knownTags}
            onClose={() => { setSelectedIds(new Set()); setLastSelectedId(null); }}
            onApply={applyBulkChanges}
            onAddCustomCategory={addCustomCategory}
          />
        ) : selected && (
          <DetailPanel
            item={selected}
            update={effectiveUpdates[selected.id]}
            allItems={displayedItems}
            knownCategories={knownCategories}
            knownTags={knownTags}
            isWatchingPlugin={!!findAlertForPlugin(selected)}
            isWatchingDeveloper={!!findAlertForDeveloper(selected.developer)}
            onToggleWatchPlugin={() => toggleDealAlertForPlugin(selected)}
            onToggleWatchDeveloper={() => toggleDealAlertForDeveloper(selected.developer)}
            onClose={() => setSelectedId(null)}
            onSelect={setSelectedId}
            onOpenInFinder={(p) => api.openInFinder(p || selected.path)}
            onOpenHomepage={(url) => api.openExternal(url)}
            onOpenCompanionApp={openCompanionApp}
            onSetOverride={(patch) => setItemOverride(selected.id, patch)}
            onTrash={() => trashItem(selected)}
            onDiscover={() => { setDiscoverEditState(null); setDiscoverItem(selected); }}
            onEditUpdateSource={() => {
              // Open Discover in edit mode pre-loaded with the saved
              // source values. The modal will skip auto-discover and
              // jump straight to the editable URL/regex form.
              const reg = selected.registry || {};
              setDiscoverEditState({
                mode: 'edit',
                existingAddition: {
                  updateUrl: reg.updateUrl || '',
                  versionRegex: reg.versionRegex || '',
                },
              });
              setDiscoverItem(selected);
            }}
            onRemoveUpdateSource={async () => {
              const key = selected.identifier || selected.id;
              const ok = window.confirm(
                `Remove the update source you added for "${selected.name}"?\n\n` +
                `Plugr will go back to using the bundled registry (or "no source" if there isn't one).`
              );
              if (!ok) return;
              const res = await api.saveRegistryAddition(key, null);
              if (res && res.ok) {
                clearRegistryAddition(key, selected.id);
                // Offer an immediate path to add a fresh source — most
                // users remove a source specifically to replace it with
                // a working one, not to leave the plugin source-less.
                pushToast({
                  kind: 'success',
                  message: `Removed update source for ${selected.name}.`,
                  durationMs: 8000,
                  action: {
                    label: 'Add new source',
                    onClick: () => {
                      setDiscoverEditState(null);
                      setDiscoverItem(selected);
                    },
                  },
                });
              }
            }}
            onShowAddSourceHelp={() => { setHelpInitialTab('updates'); setShowHelp(true); }}
            onPickCompanion={() => pickAndSetDevCompanion(selected.developer)}
            onClearCompanion={selected.companionFromUser ? () => setDevCompanion(selected.developer, null) : null}
            onSetMirrorFrom={() => setMirrorPickerOpen(true)}
            onClearMirrorFrom={() => handleClearMirrorFrom(selected.id)}
            onLinkMirrorTo={(parent) => handleSetMirrorFrom(selected.id, parent)}
            onDismissMirrorSuggest={() => handleDismissMirrorSuggest(selected.id)}
            onBulkRenameDeveloperTo={bulkRenameDeveloperTo}
            onAddCustomCategory={addCustomCategory}
            onRequestConfirm={requestConfirm}
          />
        )}
      </div>
      </Frozen>
      </div>
      )}

      </div>{/* end positioned tab container */}

      {/* Floating toasts — always visible, regardless of scroll position. */}
      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {/* Auto-update toast. Shows once electron-updater has finished
       *  downloading a new Plugr version in the background; click
       *  Restart to install. Self-rendered (no need to pass status
       *  in — it subscribes to the updater IPC channel directly). */}
      <UpdateToast api={api} />

      {/* Buy / upgrade dialog. Opens from TrialBanner, LicenseSection,
       *  and any locked-feature toast. */}
      {buyDialogOpen && (
        <BuyDialog
          onClose={() => setBuyDialogOpen(false)}
          onOpenCheckout={async (tier) => {
            if (!tier.checkoutUrl) return;
            await api.openCheckout(tier.checkoutUrl);
            // Don't auto-close — user might want to see multiple tiers
            // before committing. They can dismiss the modal manually.
          }}
        />
      )}

      {/* High-friction YES/NO confirmation dialog. Mounted at the root so
       * it overlays everything; consumers open it via requestConfirm(). */}
      {confirmDialogState && (
        <ConfirmDialog
          {...confirmDialogState}
          onYes={() => resolveConfirm(true)}
          onNo={() => resolveConfirm(false)}
        />
      )}

      {showThemePicker && (
        <ThemePicker
          current={themePreference}
          onChange={(next) => { applyTheme(next); }}
          onClose={() => setShowThemePicker(false)}
        />
      )}

      {showTutorial && (
        <Tutorial
          onClose={() => setShowTutorial(false)}
          onDismissForever={dismissTutorialForever}
        />
      )}
      {showAlerts && (
        <AlertsManager
          api={api}
          libraryItems={(library && library.items) || []}
          onClose={() => setShowAlerts(false)}
          onAlertsChanged={refreshDealAlerts}
        />
      )}
      {showHelp && (
        <HelpDialog
          initialTab={helpInitialTab}
          onClose={() => setShowHelp(false)}
          openExternal={(u) => api.openExternal(u)}
          onShowTutorial={() => { setShowHelp(false); setShowTutorial(true); }}
          customFolders={customFolders}
          onAddCustomFolder={addCustomFolder}
          onRemoveCustomFolder={removeCustomFolder}
          api={api}
          pushToast={pushToast}
          defaultTabPref={defaultTabPref}
          onDefaultTabPrefChange={updateDefaultTabPref}
          currencyPref={currencyPref}
          onCurrencyPrefChange={updateCurrencyPref}
          // License tab needs the current entitlement snapshot, a way to
          // push back updates after activate/deactivate, and an upgrade
          // hook that closes Help and opens BuyDialog.
          entitlements={entitlements}
          onEntitlementsChanged={(snap) => setEntitlements(snap)}
          onOpenUpgrade={() => { setShowHelp(false); setBuyDialogOpen(true); }}
        />
      )}
      {showEasterEgg && (
        <EasterEgg onClose={() => setShowEasterEgg(false)} />
      )}

      {discoverItem && (
        <DiscoverModal
          item={discoverItem}
          onClose={() => { setDiscoverItem(null); setDiscoverEditState(null); }}
          onSaved={onSavedRegistryAddition}
          onRemoved={clearRegistryAddition}
          api={api}
          mode={discoverEditState ? discoverEditState.mode : 'discover'}
          existingAddition={discoverEditState ? discoverEditState.existingAddition : null}
          communityConsent={communityConsent}
          onSetCommunityConsent={updateCommunityConsent}
          /* The sibling-prompt feature: count how many other plugins
           * from the same developer don't yet have an update source. If
           * there are any, the modal will offer to try the same URL
           * pattern against them. */
          siblingsForDeveloper={(() => {
            if (!discoverItem) return [];
            const dev = (discoverItem.developer || '').toLowerCase().trim();
            if (!dev || dev === 'unknown') return [];
            return displayedItems.filter((it) => {
              if (it.id === discoverItem.id) return false;
              if ((it.developer || '').toLowerCase().trim() !== dev) return false;
              const reg = it.registry || {};
              if (reg.updateUrl && reg.versionRegex) return false;
              if (it.sparkleFeedUrl) return false;
              return true;
            });
          })()}
          onTemplateSiblingsResult={async (res) => {
            const found = (res && res.data && res.data.foundCount) || 0;
            const total = (res && res.data && res.data.total) || 0;
            if (res && res.data && res.data.mergedAdditions) {
              // Snapshot the prior additions BEFORE applying the merged
              // result, so Undo can restore. Only record when at least
              // one source was actually written.
              if (found > 0) {
                recordAdditionsUndo(`applied update source to ${found} plugin${found === 1 ? '' : 's'}`);
              }
              setRegistryAdditions(res.data.mergedAdditions);
            }
            if (found > 0) {
              toastWithUndo(`Applied source to ${found} of ${total} plugins.`);
            } else {
              pushToast({
                kind: 'info',
                title: 'Sibling lookup finished',
                message: `Found ${found} of ${total} more plugins using the same URL pattern.`,
                durationMs: 7000,
              });
            }

            // Auto-check the newly-discovered siblings so they leave
            // "Unchecked" immediately, without the user having to click
            // "Check for Updates" again. We look up each addition's key
            // against library.items, stitch the new URL+regex into the
            // item's registry on the fly, and feed them all to one
            // checkUpdates call.
            const newAdditions = (res && res.data && res.data.additions) || {};
            const keys = Object.keys(newAdditions);
            if (keys.length === 0) return;
            const itemsForCheck = library.items
              .filter((it) => newAdditions[it.identifier || it.id])
              .map((it) => {
                const add = newAdditions[it.identifier || it.id];
                return { ...it, registry: { ...(it.registry || {}), ...add } };
              });
            if (itemsForCheck.length === 0) return;
            try {
              const r = await api.checkUpdates(itemsForCheck);
              if (r && r.ok && r.data && Array.isArray(r.data.results)) {
                setUpdates((prev) => {
                  const next = { ...prev };
                  for (const u of r.data.results) next[u.id] = u;
                  return next;
                });
                if (r.data.checkedAt) setUpdatesCheckedAt(r.data.checkedAt);
              }
            } catch { /* silent — user can manually re-check */ }
          }}
        />
      )}

      {/* Sibling mirror picker. Opened from DetailPanel's "Mirror from
       * another plugin…" button. Writes back through handleSetMirrorFrom
       * which both persists the override and updates local state so the
       * effectiveUpdates memo recomputes immediately. */}
      {/* Right-click context menu for library items. Positioned at the
       * cursor (with viewport-edge flipping). The menu items list is
       * built in handleItemContextMenu — see there for the SINGLE-ITEM
       * and MULTI-SELECT branches. */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {mirrorPickerOpen && selected && (
        <MirrorPickerModal
          item={selected}
          allItems={displayedItems}
          onClose={() => setMirrorPickerOpen(false)}
          onPick={async (parent) => {
            await handleSetMirrorFrom(selected.id, parent);
            setMirrorPickerOpen(false);
            pushToast({
              kind: 'success',
              message: `${selected.name} will now follow updates from ${parent.name}.`,
              durationMs: 5000,
            });
          }}
        />
      )}
    </div>
   </AudioVolumeProvider>
  );
}

const SAMPLE_LIBRARY = {
  systemVersion: '14.4',
  items: [
    { id: 'sample-1', name: 'Pro-Q 3', bundleName: 'FabFilter Pro-Q 3.vst3', format: 'VST3', path: '/Library/Audio/Plug-Ins/VST3/FabFilter Pro-Q 3.vst3', identifier: 'com.fabfilter.proq3', version: '3.24', developer: 'FabFilter', category: 'Effect', subcategory: 'EQ', sizeBytes: 28e6, registry: { homepage: 'https://www.fabfilter.com', supportUrl: 'https://www.fabfilter.com/support' } },
    { id: 'sample-2', name: 'Serum', bundleName: 'Serum.vst3', format: 'VST3', path: '/Library/Audio/Plug-Ins/VST3/Serum.vst3', identifier: 'com.xferrecords.serum', version: '1.366', developer: 'Xfer Records', category: 'Instrument', subcategory: 'Synth', sizeBytes: 52e6 },
    { id: 'sample-4', name: 'Logic Pro', bundleName: 'Logic Pro.app', format: 'App', path: '/Applications/Logic Pro.app', identifier: 'com.apple.logic10', version: '11.0', developer: 'Apple', category: 'Application', subcategory: 'Application', sizeBytes: 6 * 1024 * 1024 * 1024 },
  ],
  summary: { total: 3, byFormat: { VST3: 2, App: 1 }, byCategory: { Effect: 1, Instrument: 1, Application: 1 }, byDeveloper: { FabFilter: 1, 'Xfer Records': 1, Apple: 1 }, totalBytes: 6 * 1024 * 1024 * 1024 + 80e6, duplicateCount: 0, supersededCount: 0, duplicateBytes: 0, supersededBytes: 0 },
  scannedAt: new Date().toISOString(),
};
