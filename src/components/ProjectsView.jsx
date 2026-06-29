import React, { useMemo, useState, useRef, useEffect, createContext, useContext } from 'react';
import { naturalCompare } from '../util/format.js';
import { TopPluginsChart, TopDevelopersChart, CategoryDonut } from './ProjectsCharts.jsx';
// Real DAW logos (PNG) — replaced the previous inline SVG marks now
// that the user has supplied actual brand assets. Vite resolves each
// import to a hashed asset URL, so they work in both dev and the
// packaged Electron build.
import dawAbletonLogo  from '../assets/daw-ableton.png';
import dawLogicLogo    from '../assets/daw-logic.png';
import dawFlStudioLogo from '../assets/daw-flstudio.png';

// Same window.pluginHub bridge App.jsx uses. We keep a local
// reference here so leaf components in this file (the bounce-row
// waveform fetcher in particular) can hit the IPC layer without
// every call needing to be threaded through props from App.jsx.
const api = (typeof window !== 'undefined' && window.pluginHub) || {
  getBounceWaveform: async () => ({ ok: false, error: 'no api' }),
};

// Shared playback state for every bounce in the app:
//   - volume: 0..1, applied to each <audio>.volume on change. Lives
//     in the cache so it survives restarts.
//   - claimPlayback(audio): a "single-bus" coordinator. When a bounce
//     starts playing it calls claimPlayback, which pauses whichever
//     <audio> element was previously holding the bus. Result: clicking
//     Play on one bounce stops any other that was running, just like
//     SoundCloud / Bandcamp.
//   - busRef: read-only access to the last claimant. Used by App.jsx
//     to implement keyboard shortcuts (Space, arrow scrub) — those
//     act on whatever audio currently owns the bus.
//
// Default volume 0.8 keeps the first click slightly under unity gain
// so it doesn't blast eardrums.
export const AudioVolumeContext = createContext({
  volume: 0.8,
  setVolume: () => {},
  claimPlayback: () => {},
  busRef: { current: null },
});
export function AudioVolumeProvider({ volume, setVolume, claimPlayback, busRef, children }) {
  const value = useMemo(
    () => ({ volume, setVolume, claimPlayback, busRef }),
    [volume, setVolume, claimPlayback, busRef],
  );
  return <AudioVolumeContext.Provider value={value}>{children}</AudioVolumeContext.Provider>;
}
export function useAudioVolume() {
  return useContext(AudioVolumeContext);
}

// The full Projects page. Renders when the user has selected the
// "Projects" tab. Responsibilities:
//   - Header strip: scanned folder list, Add folder, Rescan, Clear
//   - Empty state when no projects are scanned yet
//   - Charts row (top plugins, category donut, top developers)
//   - Sort controls
//   - Scrollable project list — each row shows name + DAW icon +
//     plugin count + last-modified date + tag chips + actions
//   - Expanding a project row reveals every plugin it uses, with a
//     "view in library" shortcut per plugin

const DAW_ICONS = {
  ableton: '🎛',
  logic:   '🎼',
  flstudio: '🍓',
};

// Canonicalize project keys so "E minor" / "E Minor" collapse into one,
// and a bare note name like "C" is interpreted as the major key.
// Returns null for empty input.
function normalizeKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Match: note (A-G) + optional accidental + optional whitespace + optional mode word.
  // Case-insensitive so "C MAJOR" / "c major" / "C Major" all hit the same branch.
  const m = s.match(/^([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\.?$/i);
  if (!m) {
    // Fallback: title-cased original
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  const note = m[1].toUpperCase();
  const accRaw = m[2] || '';
  const acc = accRaw === '♯' ? '#' : accRaw === '♭' ? 'b' : accRaw;
  const modeRawOrig = m[3] || '';
  const modeLow = modeRawOrig.toLowerCase();
  // Default: bare note (no mode) is treated as MAJOR.
  // 'maj'/'major' → major. 'min'/'minor' → minor.
  // Single-letter ambiguity: lowercase "m" is minor (jazz/chord convention),
  // uppercase "M" is major.
  let mode = 'major';
  if (modeLow === 'min' || modeLow === 'minor') {
    mode = 'minor';
  } else if (modeLow === 'm') {
    mode = modeRawOrig === 'M' ? 'major' : 'minor';
  } else if (modeLow === 'maj' || modeLow === 'major' || modeLow === '') {
    mode = 'major';
  }
  return note + acc + ' ' + (mode === 'minor' ? 'Minor' : 'Major');
}


function dawIcon(t) { return DAW_ICONS[t] || '🎵'; }
function dawLabel(t) {
  if (t === 'ableton') return 'Ableton Live';
  if (t === 'logic') return 'Logic Pro';
  if (t === 'flstudio') return 'FL Studio';
  return t || 'Unknown';
}

// Real DAW logo PNGs supplied by the user, displayed as transparent
// raster icons (no colored background tile — the brand assets bring
// their own shape and color). Falls back to a neutral music-note
// chip for any DAW we don't have a logo for, so row alignment never
// drifts when an unknown DAW slips through.
const DAW_LOGOS = {
  ableton:  dawAbletonLogo,
  logic:    dawLogicLogo,
  flstudio: dawFlStudioLogo,
};

// Module-level cache of real DAW icons (extracted from the user's
// installed .app bundles via app.getFileIcon). Populated on first
// ProjectsView mount; persists for the life of the renderer.
const __dawIconUrls = { ableton: null, logic: null, flstudio: null };
let __dawIconsFetchStarted = false;
// Subscribers: every mounted DawLogo registers its force-update fn so
// they ALL re-render when icons finish loading. Without this, only the
// one instance that triggered the fetch would see the new icons.
const __dawIconSubs = new Set();
function fetchDawIconsOnce() {
  if (__dawIconsFetchStarted) return;
  __dawIconsFetchStarted = true;
  (async () => {
    try {
      const api = window.pluginHub;
      if (!api || !api.getDawIcons) return;
      const res = await api.getDawIcons();
      if (res && res.ok && res.icons) {
        for (const k of Object.keys(res.icons)) {
          if (res.icons[k]) __dawIconUrls[k] = res.icons[k];
        }
        // Force-update every mounted DawLogo so they swap from the
        // bundled PNG to the real installed-app icon.
        for (const fn of __dawIconSubs) fn();
      }
    } catch { /* silently fall back to bundled PNGs */ }
  })();
}

function DawLogo({ dawType, size = 16 }) {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    fetchDawIconsOnce();
    __dawIconSubs.add(force);
    return () => { __dawIconSubs.delete(force); };
  }, []);
  const realIcon = __dawIconUrls[dawType];
  const src = realIcon || DAW_LOGOS[dawType];
  if (!src) {
    return (
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, borderRadius: '4px',
          background: 'var(--accent-soft, rgba(127,127,127,0.25))',
          color: 'inherit', fontSize: size * 0.55, fontWeight: 700, flex: '0 0 auto',
        }}
        aria-hidden="true"
      >♪</span>
    );
  }
  return (
    <img
      src={src}
      alt={dawLabel(dawType)}
      title={dawLabel(dawType)}
      width={size}
      height={size}
      draggable={false}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        // object-contain so an asset that isn't perfectly square still
        // sits neatly inside its allotted square. The user's PNGs vary:
        // ableton 1200×1200, logic 1254×1254, FL Studio 1024×1536.
        objectFit: 'contain',
        flex: '0 0 auto',
      }}
    />
  );
}
// Single grid for the entire projects table. Header cells + every
// row's 8 cells + every expanded panel are ALL flat children of one
// grid container, so column alignment is guaranteed by the grid —
// it can't drift across rows because there's only one grid context.
//
// Columns:
//   #       — row number (48px, right-aligned inside)
//   DAW     — brand badge (48px)
//   Project — name + subtitle (flex)
//   Tempo   — BPM (90px, right-aligned)
//   Key     — scale pill (110px, centered)
//   Rating  — A/B/C/D/F tier badge (72px, centered)
//   Tags    — chips (flex)
//   Actions — Open + Reveal buttons (auto, right-aligned)
//
// No `gap` — each cell handles its own horizontal padding so a
// row-spanning background (e.g. zebra or hover) fills the entire
// row without a stripe in the gap.
const PROJECT_GRID_COLUMNS = '48px 48px minmax(180px, 1fr) 90px 110px 72px 150px minmax(150px, 1.3fr) auto';

// Built-in workflow statuses used when the user hasn't customized
// their list. Once they add/edit/remove, customStatuses takes over.
const DEFAULT_PROJECT_STATUSES = [
  { id: 'rough',      label: 'Rough Concept',   color: '#9aa0a6' },
  { id: 'inprogress', label: 'In Progress',     color: '#6ec1ff' },
  { id: 'mixing',     label: 'Needs Mixing',    color: '#ffa552' },
  { id: 'mastering',  label: 'Needs Mastering', color: '#c084fc' },
  { id: 'finished',   label: 'Finished',        color: '#60d394' },
  { id: 'released',   label: 'Released',        color: '#ffd400' },
];
const CELL_PAD_Y = '14px';
const CELL_PAD_X = '8px';
const CELL_PAD_X_EDGE = '16px';   // left padding for first column / right for last
const ROW_BORDER = '1px solid var(--border-color, rgba(127,127,127,0.10))';

// One header cell. The optional first/last flags pad against the
// grid's outer edge so contents don't crowd the border.
// Approximate height of the sticky toolbar above (search/sort/filter
// chips). Used as the top-offset for the sticky column headers so they
// dock just below the toolbar instead of overlapping it.
const PROJECT_TOOLBAR_HEIGHT = 56;

// HeaderCell can be either a static label (DAW icon column, #, Actions)
// or a click-to-sort button (Project, Tempo, Key, Rating, Status, Tags).
// When `sortKey` is provided we render as a button: clicking sets the
// table sort to that key, and the active column gets an arrow indicator.
// We don't toggle sort direction per click — each sort key already has
// its own natural direction baked into the `visibleProjects` reducer
// (e.g. tempo ascends, rating goes best→worst, modified descends), and
// a second click of the SAME column on an already-active sort just
// re-applies the same sort. That keeps the behavior predictable and
// matches the dropdown — clicking the header is just a shortcut for
// picking that option from the Sort dropdown.
function HeaderCell({ children, first, last, align, sortKey, currentSort, onSort }) {
  const sortable = !!sortKey;
  const isActive = sortable && currentSort === sortKey;
  const baseStyle = {
    padding: `12px ${CELL_PAD_X}`,
    paddingLeft: first ? CELL_PAD_X_EDGE : CELL_PAD_X,
    paddingRight: last ? CELL_PAD_X_EDGE : CELL_PAD_X,
    fontSize: '10.5px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    opacity: isActive ? 1 : 0.85,
    color: isActive ? 'var(--accent, #6ec1ff)' : 'inherit',
    // Sticky: dock under the toolbar when scrolling. Each header
    // cell is its own grid child, so each gets its own sticky
    // positioning — they all stick at the same offset, giving the
    // illusion of one sticky row.
    position: 'sticky',
    top: PROJECT_TOOLBAR_HEIGHT,
    zIndex: 15,
    // Solid background is critical so scrolled rows don't show
    // through. We blend the panel + base layer for a faintly tinted
    // header bar that still differentiates from row content.
    background: 'var(--bg-0)',
    backdropFilter: 'saturate(180%) blur(6px)',
    WebkitBackdropFilter: 'saturate(180%) blur(6px)',
    borderBottom: `1px solid ${isActive ? 'var(--accent, #6ec1ff)' : 'var(--border-color, rgba(127,127,127,0.18))'}`,
    textAlign: align || 'left',
  };
  if (!sortable) {
    return <div style={baseStyle}>{children}</div>;
  }
  // Active-column arrow indicator — shown only when this column is
  // currently driving the sort. A small caret next to the label keeps
  // it from changing the column width when activated.
  const Arrow = isActive ? (
    <span aria-hidden="true" style={{ marginLeft: 4, fontSize: '9px' }}>▾</span>
  ) : null;
  return (
    <button
      type="button"
      onClick={() => onSort && onSort(sortKey)}
      title={`Sort by ${typeof children === 'string' ? children.toLowerCase() : sortKey}`}
      style={{
        ...baseStyle,
        // Promote to a button without changing layout — flex on the
        // inner so the arrow sits inline with the label, and respect
        // the header cell's alignment (right for #, etc.).
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
        gap: 0,
        border: 'none',
        font: 'inherit',
        cursor: 'pointer',
        // Subtle hover affordance — slight bg tint so users notice
        // it's interactive. We don't add an underline; the arrow on
        // the active column is the strongest indicator.
        transition: 'background 100ms ease',
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'color-mix(in srgb, var(--accent, #6ec1ff) 8%, var(--bg-0))'; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--bg-0)'; }}
    >
      <span>{children}</span>
      {Arrow}
    </button>
  );
}

// One row cell. Manages zebra background + bottom border + cell
// padding consistently across every cell of a row. `align` controls
// the text-align of cell contents.
function RowCell({ children, first, last, align, zebra, style }) {
  return (
    <div style={{
      padding: `${CELL_PAD_Y} ${CELL_PAD_X}`,
      paddingLeft: first ? CELL_PAD_X_EDGE : CELL_PAD_X,
      paddingRight: last ? CELL_PAD_X_EDGE : CELL_PAD_X,
      background: zebra ? 'rgba(127,127,127,0.04)' : 'transparent',
      borderBottom: ROW_BORDER,
      textAlign: align || 'left',
      display: 'flex',
      alignItems: 'center',
      justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
      minWidth: 0,
      ...style,
    }}>{children}</div>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function ProjectsViewInner({
  projectLibrary,
  projectMatch,
  projectTags,
  projectNotes,
  projectBounceOverrides,
  projectRatings,
  projectStatuses,
  customStatuses,
  projectKeyOverrides,
  libraryItems,
  // Actions wired from App.jsx.
  onAddProjectFolder,
  onRescanProjects,
  onClearProjects,
  onRemoveProjectFolder,
  onSetTags,
  onSetNotes,
  onAddManualBounce,
  onDropBouncesOnProject,
  onDismissAutoBounce,
  onRemoveManualBounce,
  onSetRating,
  onSetStatus,
  onSetStatusList,
  onSetKeyOverride,
  onOpenInDAW,
  onRevealInFinder,
  onJumpToPluginInLibrary,        // (itemId) => void — switches to Library tab + selects/filter
  onJumpToUnmatchedList,          // () => void — switches to Library tab with project filter = unmatched (optional)
}) {
  const rawProjects = (projectLibrary && projectLibrary.projects) || [];
  const folders = (projectLibrary && projectLibrary.folders) || [];

  // Apply manual key overrides. The detected key from the project
  // file ALWAYS wins — overrides are consulted only when detection
  // returned null. That means: if Logic returns null (no project-
  // wide key concept) the user's stored key shows; if Ableton later
  // re-detects a real key, the override is silently outvoted, so a
  // re-scan can never leave a stale manual entry on screen.
  // We also tag projects with `keyIsOverride` so the UI can render
  // the manual chip differently (lighter, with an edit affordance).
  const projects = useMemo(() => {
    const overrides = projectKeyOverrides || {};
    return rawProjects.map((p) => {
      if (p.key) return { ...p, keyIsOverride: false };
      const ov = overrides[p.id];
      if (ov) return { ...p, key: ov, keyIsOverride: true };
      return { ...p, keyIsOverride: false };
    });
  }, [rawProjects, projectKeyOverrides]);

  // Sort + search state. Persists for the session only; people use
  // this view differently every time.
  const [sortBy, setSortBy] = useState('modified');     // 'modified' | 'name' | 'pluginCount' | 'tagged' | 'tempo' | 'key' | 'rating' | 'status'
  const [search, setSearch] = useState('');
  // Multi-select filters — each one's a Set of selected values. A
  // project must pass EVERY ACTIVE FILTER to be visible. Within a
  // single filter, selecting multiple values is OR (e.g. "tag is
  // mix OR master"); across filters it's AND (e.g. "tag in {mix,
  // master} AND rating in {A, B}"). Empty Set = filter inactive.
  // Special sentinel values: 'unrated' for rating filter, 'unset'
  // for status filter — same meaning as the single-pick days.
  const [filterTags, setFilterTags] = useState(() => new Set());
  const [filterKeys, setFilterKeys] = useState(() => new Set()); // multi-select set of normalized key names; empty Set = no filter
  const [filterRatings, setFilterRatings] = useState(() => new Set()); // contains 'A'|'B'|'C'|'D'|'F'|'unrated'
  const [filterStatuses, setFilterStatuses] = useState(() => new Set());// contains statusId or 'unset'

  // Toggle helper used by all three multi-select dropdowns/chips:
  // if `value` is already in the set, remove it; otherwise add it.
  // Returns the next Set (immutable update).
  function toggleSetValue(setter) {
    return (value) => setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }
  const toggleTagFilter    = toggleSetValue(setFilterTags);
  const toggleRatingFilter = toggleSetValue(setFilterRatings);
  const toggleStatusFilter = toggleSetValue(setFilterStatuses);
  const [manageStatusesOpen, setManageStatusesOpen] = useState(false);
  const [manageFoldersOpen, setManageFoldersOpen]   = useState(false);
  const [expandedIds, setExpandedIds] = useState(new Set());
  // Defer chart computation until after first paint of the row list.
  // The 3 chart aggregations (top plugins, category donut, top devs)
  // walk every plugin reference across every project — non-trivial CPU
  // on cold mount. Letting them render one frame late means the user
  // sees the project list immediately and the charts pop in a beat
  // later, which feels dramatically faster than a 3-5s blocking mount.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setChartsReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Charts row state — collapsible, persisted in localStorage so the
  // user's preference survives reloads. Reading on initial state to
  // avoid a flicker between collapsed/expanded on mount.
  const [chartsCollapsed, setChartsCollapsed] = useState(() => {
    try { return localStorage.getItem('plugr.projects.chartsCollapsed') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('plugr.projects.chartsCollapsed', chartsCollapsed ? '1' : '0'); }
    catch { /* tolerate quota / privacy mode */ }
  }, [chartsCollapsed]);

  // Click-to-filter from any of the three charts. Shape:
  //   { type: 'plugin',    itemId, label }
  //   { type: 'developer', value }   // canonical developer name
  //   { type: 'category',  value }   // category name like 'Effect'
  // null when no chart-driven filter is active.
  const [chartFilter, setChartFilter] = useState(null);

  // A small library index used both by chart-filtering and by the
  // existing chart components. Built once per library so each filter
  // check on a project's plugin refs is O(refs), not O(library × refs).
  const libIndex = useMemo(() => {
    const byIdent = new Map();
    const byName = new Map();
    for (const it of (libraryItems || [])) {
      if (it.identifier) byIdent.set(String(it.identifier).toLowerCase(), it);
      const k = String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (k && !byName.has(k)) byName.set(k, it);
    }
    return { byIdent, byName };
  }, [libraryItems]);

  // Full list of every plugin "family" referenced by any scanned
  // project — same de-duplication rule as the top-15 chart (group
  // by normalized display name, union project sets across formats),
  // but here we keep ALL of them so the user can filter by anything.
  // Used by the plugin-filter picker in the toolbar.
  const allPluginFamilies = useMemo(() => {
    const byId = new Map(libraryItems.map((it) => [it.id, it]));
    const families = new Map();
    for (const proj of projects) {
      // Deduplicate within a project — if the same plugin appears in
      // multiple formats inside one project (VST3 + AU), we still
      // count the project once for that family.
      const seenInProj = new Set();
      for (const ref of (proj.plugins || [])) {
        const hit = findLibraryMatch(ref, libraryItems);
        // Use the library item's display name as the family label
        // when available, otherwise fall back to the raw project
        // plugin name. Either way we normalize to group identically.
        const label = (hit && hit.name) || ref.name || '(unknown plugin)';
        const familyKey = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (!familyKey || seenInProj.has(familyKey)) continue;
        seenInProj.add(familyKey);
        let fam = families.get(familyKey);
        if (!fam) {
          fam = { key: familyKey, label, itemIds: new Set(), projectCount: 0 };
          families.set(familyKey, fam);
        }
        if (hit) fam.itemIds.add(hit.id);
        fam.projectCount += 1;
      }
    }
    // Sort by project count desc so the most-used plugins float to the
    // top of the picker. Within ties, fall back to label A→Z.
    return [...families.values()]
      .map((f) => ({ key: f.key, label: f.label, projectCount: f.projectCount, itemIds: [...f.itemIds] }))
      .sort((a, b) => b.projectCount - a.projectCount || naturalCompare(a.label, b.label));
  }, [projects, libraryItems]);

  // Returns true if any plugin reference in the project matches the
  // chart filter. We delegate to `findLibraryMatch` (same helper the
  // expanded-row "jump to library" link uses) so that whatever
  // matching rule resolves a project's plugin to a library item also
  // drives the chart filter. Without this, plugins matched via
  // AU FourCC tuples or format-specific lookup show up in the chart
  // but disappear when clicked — because the chart's matcher and the
  // filter's matcher disagreed about which library item to attribute
  // each project plugin to.
  function projectMatchesChartFilter(p, filter) {
    if (!filter) return true;
    const refs = p.plugins || [];
    for (const ref of refs) {
      const hit = findLibraryMatch(ref, libraryItems);
      if (!hit) {
        // For category filters, an unresolved ref is bucketed as
        // "Not installed" — so a category-filter for that exact
        // bucket should still match it.
        if (filter.type === 'category' && filter.value === 'Not installed') return true;
        // Same idea for the developer chart: clicking "(not
        // installed)" should show projects that actually reference
        // unknown plugins. Previously this matched nothing because
        // no library item has that as a developer name.
        if (filter.type === 'developer' && filter.value === '(not installed)') {
          // Refs we CAN attribute via guessDeveloperFromRef
          // (WaveShell → Waves) don't count as "(not installed)" —
          // they have their own bucket. Inline the same heuristic
          // here so the filter is consistent with the chart.
          const nm = String(ref.name || ref.identifier || '').toLowerCase();
          const looksWaves = nm.startsWith('waveshell') || nm.includes('waveshell');
          if (!looksWaves) return true;
        }
        // Waves bucket: matches refs whose name looks like the
        // WaveShell host (the only place we currently guess vendor
        // for a no-match ref).
        if (filter.type === 'developer' && filter.value === 'Waves') {
          const nm = String(ref.name || ref.identifier || '').toLowerCase();
          if (nm.startsWith('waveshell') || nm.includes('waveshell')) return true;
        }
        continue;
      }
      // For plugin filters, accept either form for backwards-compat:
      //   - `itemIds` (new, after the family-dedup change in
      //     TopPluginsChart — covers every format of the same plugin)
      //   - `itemId`  (legacy single-id, in case a chartFilter was
      //     serialized somewhere before the upgrade)
      if (filter.type === 'plugin') {
        if (Array.isArray(filter.itemIds) && filter.itemIds.includes(hit.id)) return true;
        if (filter.itemId && hit.id === filter.itemId) return true;
      }
      if (filter.type === 'developer' && (hit.developer || 'Unknown') === filter.value) return true;
      if (filter.type === 'category'  && (hit.category  || 'Undefined') === filter.value) return true;
    }
    return false;
  }

  // The effective status list — user's custom list if they've made
  // one, otherwise built-in defaults. We also build a lookup map so
  // every other usage (sort/filter/picker) is O(1).
  const effectiveStatuses = useMemo(() => {
    return (Array.isArray(customStatuses) && customStatuses.length > 0)
      ? customStatuses
      : DEFAULT_PROJECT_STATUSES;
  }, [customStatuses]);
  const statusById = useMemo(() => {
    const m = new Map();
    for (const s of effectiveStatuses) m.set(s.id, s);
    return m;
  }, [effectiveStatuses]);

  // Tempo range — min/max BPM of any project, used to size the dual-thumb
  // slider. Computed once per library. Includes a 1-BPM safety margin
  // so the default range covers EVERY project (the filter is inclusive).
  const tempoBounds = useMemo(() => {
    let min = Infinity, max = -Infinity, count = 0;
    for (const p of projects) {
      if (typeof p.tempo !== 'number') continue;
      const r = Math.round(p.tempo);
      if (r < min) min = r;
      if (r > max) max = r;
      count++;
    }
    if (!count) return null;
    return { min: Math.max(20, min), max: Math.min(300, max) };
  }, [projects]);

  // The two-thumb selection — defaults to the full bound. `null` means
  // "not yet initialized"; we lazily set it the first time tempoBounds
  // becomes known so it tracks library changes (a fresh scan adds
  // faster/slower projects → range expands).
  const [tempoRange, setTempoRange] = useState(null);   // [min, max] or null
  useEffect(() => {
    if (!tempoBounds) { setTempoRange(null); return; }
    setTempoRange((prev) => {
      // Keep the user's current selection if it's still within bounds.
      if (prev && prev[0] >= tempoBounds.min && prev[1] <= tempoBounds.max) return prev;
      return [tempoBounds.min, tempoBounds.max];
    });
  }, [tempoBounds && tempoBounds.min, tempoBounds && tempoBounds.max]);

  // Is the slider filtering anything? When the selection equals the
  // full bound, treat it as "no tempo filter" so other UI knows.
  const tempoFilterActive = tempoBounds && tempoRange &&
    (tempoRange[0] > tempoBounds.min || tempoRange[1] < tempoBounds.max);

  const keyOptions = useMemo(() => {
    const counts = new Map();
    for (const p of projects) {
      const k = normalizeKey(p.key);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => naturalCompare(a.key, b.key));
  }, [projects]);

  // Build the set of all known tags (used by the tag autocomplete).
  const knownTags = useMemo(() => {
    const set = new Set();
    for (const tags of Object.values(projectTags || {})) {
      for (const t of tags) set.add(t);
    }
    return [...set].sort((a, b) => naturalCompare(a, b));
  }, [projectTags]);

  // Filter + sort.
  const visibleProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Tier rank for sorting — A is best (smallest number), F is worst
    // (largest). Unrated projects fall after F so they don't clog the
    // top of "best first" lists.
    const TIER_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
    const tierOf = (id) => (projectRatings && projectRatings[id]) || null;
    let arr = projects.filter((p) => {
      if (q) {
        const hay = `${p.name} ${p.path} ${dawLabel(p.dawType)} ${p.key || ''} ${p.tempo || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filterTags.size > 0) {
        const tags = (projectTags && projectTags[p.id]) || [];
        // OR within the tag filter — project matches if it has ANY
        // of the selected tags.
        let any = false;
        for (const t of filterTags) { if (tags.includes(t)) { any = true; break; } }
        if (!any) return false;
      }
      if (tempoFilterActive) {
        if (typeof p.tempo !== 'number') return false;
        const rounded = Math.round(p.tempo);
        if (rounded < tempoRange[0] || rounded > tempoRange[1]) return false;
      }
      if (filterKeys && filterKeys.size > 0) {
        const nk = normalizeKey(p.key);
        if (!nk || !filterKeys.has(nk)) return false;
      }
      if (filterRatings.size > 0) {
        const r = tierOf(p.id);
        // OR within: project matches if its rating is in the selected
        // set, OR if 'unrated' is selected and the project has no rating.
        const matched = (r && filterRatings.has(r)) || (!r && filterRatings.has('unrated'));
        if (!matched) return false;
      }
      if (filterStatuses.size > 0) {
        const s = (projectStatuses && projectStatuses[p.id]) || null;
        const matched = (s && filterStatuses.has(s)) || (!s && filterStatuses.has('unset'));
        if (!matched) return false;
      }
      // Click-to-filter from a chart (top plugin / developer / category).
      // Applied last because it's the "drill down" filter — pairs well
      // with the others rather than replacing them.
      if (chartFilter && !projectMatchesChartFilter(p, chartFilter)) return false;
      return true;
    });
    arr = [...arr].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return naturalCompare(a.name, b.name);
        case 'pluginCount':
          return (b.plugins || []).length - (a.plugins || []).length;
        case 'tagged': {
          const at = ((projectTags && projectTags[a.id]) || []).length;
          const bt = ((projectTags && projectTags[b.id]) || []).length;
          return bt - at || naturalCompare(a.name, b.name);
        }
        case 'tempo': {
          // Projects without a tempo always go to the bottom so they
          // don't clog the top of an "ordered by BPM" list.
          const at = typeof a.tempo === 'number' ? a.tempo : Infinity;
          const bt = typeof b.tempo === 'number' ? b.tempo : Infinity;
          return at - bt || naturalCompare(a.name, b.name);
        }
        case 'key': {
          // Same — un-keyed projects go to the bottom. Among keyed
          // ones we sort alphabetically by the display string, which
          // is "C Major", "C# Minor", etc. — not music-theory
          // circle-of-fifths order, but the most intuitive for
          // browsing.
          const ak = a.key || '~';        // '~' sorts after 'Z' lexically
          const bk = b.key || '~';
          return naturalCompare(ak, bk) || naturalCompare(a.name, b.name);
        }
        case 'rating': {
          // Best-first (A → F → unrated). Within a tier, fall back to
          // most-recently-modified so the top of an A-tier list is the
          // freshest A project rather than alphabetical.
          const ar = tierOf(a.id);
          const br = tierOf(b.id);
          const av = ar ? TIER_RANK[ar] : 5;
          const bv = br ? TIER_RANK[br] : 5;
          if (av !== bv) return av - bv;
          return (b.lastModified || '').localeCompare(a.lastModified || '') || naturalCompare(a.name, b.name);
        }
        case 'status': {
          // Sort by status list order (so user-defined order matters).
          // Unset projects last.
          const statusIds = effectiveStatuses.map((s) => s.id);
          const aIdx = projectStatuses ? statusIds.indexOf(projectStatuses[a.id]) : -1;
          const bIdx = projectStatuses ? statusIds.indexOf(projectStatuses[b.id]) : -1;
          const av = aIdx < 0 ? Infinity : aIdx;
          const bv = bIdx < 0 ? Infinity : bIdx;
          if (av !== bv) return av - bv;
          return (b.lastModified || '').localeCompare(a.lastModified || '') || naturalCompare(a.name, b.name);
        }
        case 'modified':
        default:
          return (b.lastModified || '').localeCompare(a.lastModified || '') || naturalCompare(a.name, b.name);
      }
    });
    return arr;
  }, [projects, search, filterTags, tempoFilterActive, tempoRange, filterKeys, filterRatings, filterStatuses, sortBy, projectTags, projectRatings, projectStatuses, effectiveStatuses, chartFilter, libIndex]);


  // Empty-state — no projects scanned yet. The trigger to scan lives
  // HERE, not in the sidebar, so this is the central onboarding spot.
  if (projects.length === 0) {
    return (
      <div className="projects-view-empty" style={{ padding: '60px 32px', maxWidth: '640px', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.4 }}>🎛</div>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Project organizer</h2>
        <p style={{ marginTop: '12px', marginBottom: '20px', lineHeight: 1.6, opacity: 0.75, fontSize: '14px' }}>
          Point Plugr at a folder of DAW projects (Ableton <code>.als</code>, FL Studio <code>.flp</code>,
          Logic Pro <code>.logicx</code>) and it will tell you which plugins
          you actually use, surface deletion candidates, and let you tag,
          browse, and open projects from one place.
        </p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={onAddProjectFolder}
          style={{ padding: '10px 20px', fontSize: '14px' }}
        >+ Add folder of projects…</button>
        <p style={{ marginTop: '16px', fontSize: '12px', opacity: 0.55 }}>
          You can also drop project files anywhere in the Plugr window to scan them.
        </p>
      </div>
    );
  }

  return (
    <div className="projects-view" style={{
      // Explicit viewport-based height — not relying on the flex
      // chain from app-shell, which has proven unreliable for nested
      // scroll containers. 40px is the TabBar's outer height. The
      // inner scroll wrapper below uses flex:1 + minHeight:0 +
      // overflow:auto, which now has a guaranteed bounded parent
      // height to scroll within.
      height: 'calc(100vh - 40px)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Top header strip — folder management + summary stats */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))', display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '240px' }}>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>
            {projects.length.toLocaleString()} project{projects.length === 1 ? '' : 's'} scanned
          </div>
          <div style={{ fontSize: '11.5px', opacity: 0.65, marginTop: '2px' }}>
            {/* When folders=0, the projects came from drag-and-drop of
             *  individual files. "From 0 folders" reads as broken; this
             *  copy steers the user toward Add folder for auto-scan. */}
            {folders.length === 0
              ? 'Added individually — use “+ Add folder…” to auto-scan a directory'
              : `From ${folders.length === 1 ? '1 folder' : `${folders.length} folders`}`}
            {projectLibrary.lastScannedAt && ` · Last scan ${formatDate(projectLibrary.lastScannedAt)}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button className="btn btn-small" type="button" onClick={onAddProjectFolder}>+ Add folder…</button>
          {folders.length > 0 && (
            <button
              className="btn btn-small btn-ghost"
              type="button"
              onClick={() => setManageFoldersOpen(true)}
              title="Review, remove, or rescan the folders Plugr is watching"
            >Manage folders…</button>
          )}
          <button className="btn btn-small btn-ghost" type="button" onClick={onRescanProjects} title="Rescan every indexed folder">↻ Rescan all</button>
          <button
            className="btn btn-small btn-ghost"
            type="button"
            onClick={() => setChartsCollapsed((v) => !v)}
            title={chartsCollapsed ? 'Show the analytics charts' : 'Hide the charts to give the project list more room'}
          >
            {chartsCollapsed ? '▼ Show charts' : '▲ Hide charts'}
          </button>
          <button className="btn btn-small btn-ghost" type="button" onClick={onClearProjects} title="Forget every scanned project (tags are kept)">Clear</button>
        </div>
      </div>

      {/* Scrollable content area. `minHeight: 0` is critical: nested
       *  flex children default to `min-height: auto`, which makes
       *  them grow to fit content and completely defeats the
       *  `overflow: auto`. Without this, expanded rows push beyond
       *  the viewport with no way to scroll to them. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Charts row — collapsible via the toolbar toggle. When
         *  collapsed we skip rendering entirely so the project list
         *  can fill the viewport. Clicking any entry inside a chart
         *  sets a chartFilter that drills into the project list. */}
        {!chartsCollapsed && chartsReady && (
          <div style={{ display: 'flex', gap: '12px', padding: '14px 20px', alignItems: 'stretch', flexWrap: 'wrap' }}>
            <TopPluginsChart
              projectMatch={projectMatch}
              libraryItems={libraryItems}
              projects={projects}
              maxRows={15}
              onSelect={(row) => {
                // Click-toggle behavior — clicking the row that's
                // already driving the filter clears it. We compare on
                // the family key (normalized name), not a single
                // itemId, because each row may bundle multiple
                // formats (Decapitator AU + VST3, etc.).
                setChartFilter((prev) =>
                  (prev && prev.type === 'plugin' && prev.key === row.key)
                    ? null
                    : { type: 'plugin', key: row.key, itemIds: row.itemIds, label: row.label });
              }}
              selectedKey={chartFilter && chartFilter.type === 'plugin' ? chartFilter.key : null}
            />
            <CategoryDonut
              projects={projects}
              libraryItems={libraryItems}
              size={220}
              onSelect={(slice) => {
                setChartFilter((prev) =>
                  (prev && prev.type === 'category' && prev.value === slice.label)
                    ? null
                    : { type: 'category', value: slice.label });
              }}
              selectedKey={chartFilter && chartFilter.type === 'category' ? chartFilter.value : null}
            />
            <TopDevelopersChart
              projects={projects}
              libraryItems={libraryItems}
              maxRows={15}
              onSelect={(row) => {
                setChartFilter((prev) =>
                  (prev && prev.type === 'developer' && prev.value === row.key)
                    ? null
                    : { type: 'developer', value: row.key });
              }}
              selectedKey={chartFilter && chartFilter.type === 'developer' ? chartFilter.value : null}
            />
          </div>
        )}

        {/* Sticky toolbar — search + sort + filters. Sticks to the top
         *  of the scroll container so it's always reachable when
         *  scrolling through many projects. Z-index is above row content
         *  so its backdrop covers what's behind it during scroll. */}
        <div style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: 'var(--bg-0)',
          padding: '8px 20px 10px 20px',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--border-color, rgba(127,127,127,0.10))',
        }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects by name, path, or DAW…"
            style={{ flex: 1, minWidth: '200px', padding: '6px 10px', fontSize: '13px', borderRadius: '4px', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'var(--input-bg, rgba(255,255,255,0.04))', color: 'inherit' }}
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ padding: '6px 10px', fontSize: '13px', borderRadius: '4px', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'var(--input-bg, rgba(255,255,255,0.04))', color: 'inherit' }}
            title="Sort projects"
          >
            <option value="modified">Most recently modified</option>
            <option value="name">Name (A–Z)</option>
            <option value="pluginCount">Most plugins</option>
            <option value="tagged">Most tagged</option>
            <option value="tempo">Tempo (slowest → fastest)</option>
            <option value="key">Key (alphabetical)</option>
            <option value="rating">Rating (best → worst)</option>
            <option value="status">Status (workflow order)</option>
          </select>
          {knownTags.length > 0 && (
            <MultiSelectDropdown
              label="Tags"
              allLabel="All tags"
              options={knownTags.map((t) => ({ value: t, label: `#${t}` }))}
              selected={filterTags}
              onToggle={toggleTagFilter}
              onClear={() => setFilterTags(new Set())}
            />
          )}
          {tempoBounds && tempoRange && (
            <TempoRangeSlider
              bounds={tempoBounds}
              value={tempoRange}
              onChange={setTempoRange}
              active={tempoFilterActive}
            />
          )}
          {keyOptions.length > 0 && (
            <MultiSelectDropdown
              label="Keys"
              allLabel="All keys"
              options={keyOptions.map(({ key, count }) => ({ value: key, label: key + ' (' + count + ')' }))}
              selected={filterKeys}
              onToggle={(v) => setFilterKeys((prev) => {
                const next = new Set(prev);
                if (next.has(v)) next.delete(v); else next.add(v);
                return next;
              })}
              onClear={() => setFilterKeys(new Set())}
            />
          )}
          <MultiSelectDropdown
            label="Ratings"
            allLabel="All ratings"
            options={[
              { value: 'A', label: 'A' },
              { value: 'B', label: 'B' },
              { value: 'C', label: 'C' },
              { value: 'D', label: 'D' },
              { value: 'F', label: 'F' },
              { value: 'unrated', label: 'Unrated' },
            ]}
            selected={filterRatings}
            onToggle={toggleRatingFilter}
            onClear={() => setFilterRatings(new Set())}
          />
          <MultiSelectDropdown
            label="Statuses"
            allLabel="All statuses"
            options={[
              ...effectiveStatuses.map((s) => ({ value: s.id, label: s.label })),
              { value: 'unset', label: 'No status' },
            ]}
            selected={filterStatuses}
            onToggle={toggleStatusFilter}
            onClear={() => setFilterStatuses(new Set())}
          />
          {/* Filter-by-plugin picker — opens a searchable list of every
           *  plugin referenced by any scanned project (not just the top
           *  15 in the chart). Picking one drills the project list down
           *  to only projects that use that plugin. Sets the same
           *  chartFilter the chart row click sets. */}
          {allPluginFamilies.length > 0 && (
            <PluginFamilyPicker
              families={allPluginFamilies}
              selectedKey={chartFilter && chartFilter.type === 'plugin' ? chartFilter.key : null}
              totalProjects={projects.length}
              onPick={(fam) => setChartFilter({ type: 'plugin', key: fam.key, itemIds: fam.itemIds, label: fam.label })}
              onClear={() => setChartFilter(null)}
            />
          )}
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setManageStatusesOpen(true)}
            title="Add, rename, recolor, or remove project statuses"
            style={{ padding: '6px 10px', fontSize: '12px' }}
          >Manage statuses…</button>

          {/* Chart-driven filter chip — appears when the user has
           *  clicked a row in one of the three charts to drill in.
           *  Lives inside the sticky toolbar so it scrolls with it
           *  and stays one click from being cleared. */}
          {chartFilter && (
            <button
              type="button"
              onClick={() => setChartFilter(null)}
              title="Clear chart filter"
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 500,
                borderRadius: 999,
                border: '1px solid var(--accent, #6ec1ff)',
                background: 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)',
                color: 'var(--accent, #6ec1ff)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {chartFilter.type === 'plugin'    && <>Plugin: <strong>{chartFilter.label}</strong></>}
              {chartFilter.type === 'developer' && <>Developer: <strong>{chartFilter.value}</strong></>}
              {chartFilter.type === 'category'  && <>Category: <strong>{chartFilter.value}</strong></>}
              <span style={{ opacity: 0.7 }}>×</span>
            </button>
          )}
        </div>

        {/* Project list — SINGLE CSS Grid for the entire table.
         *  Header cells + every row's 7 cells + every expanded panel
         *  are all flat children of THIS grid, so column alignment
         *  is impossible to break: there's only one grid context. */}
        <div
          style={{
            margin: '0 20px 20px 20px',
            border: '1px solid var(--border-color, rgba(127,127,127,0.18))',
            borderRadius: '8px',
            // overflow:hidden was here for rounded corners but combined
            // with flex-shrink:1 (the default for flex children) it
            // CLIPPED the expanded panel when total content exceeded
            // the inner scrollable wrapper's available flex space.
            // Now we use flexShrink:0 to keep the grid at its natural
            // size — the wrapper above handles overflow via scroll.
            background: 'var(--panel-bg, rgba(255,255,255,0.02))',
            display: 'grid',
            gridTemplateColumns: PROJECT_GRID_COLUMNS,
            alignItems: 'stretch',
            flexShrink: 0,
          }}
        >
          {visibleProjects.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px 20px', textAlign: 'center', opacity: 0.6, fontSize: '13px' }}>
              No projects match your filters.
            </div>
          ) : (
            <>
              {/* Header cells — direct grid children. Columns with a
               *  sortKey are click-to-sort; the active column gets an
               *  accent-tinted label and a small arrow. The plain #,
               *  DAW-icon, and Actions columns are static (no useful
               *  meaning to "sort by row number" or "sort by icon"). */}
              <HeaderCell first align="right">#</HeaderCell>
              <HeaderCell></HeaderCell>
              <HeaderCell sortKey="name"        currentSort={sortBy} onSort={setSortBy}>Project</HeaderCell>
              <HeaderCell sortKey="tempo"       currentSort={sortBy} onSort={setSortBy} align="right">Tempo</HeaderCell>
              <HeaderCell sortKey="key"         currentSort={sortBy} onSort={setSortBy} align="center">Key</HeaderCell>
              <HeaderCell sortKey="rating"      currentSort={sortBy} onSort={setSortBy} align="center">Rating</HeaderCell>
              <HeaderCell sortKey="status"      currentSort={sortBy} onSort={setSortBy}>Status</HeaderCell>
              <HeaderCell sortKey="tagged"      currentSort={sortBy} onSort={setSortBy}>Tags</HeaderCell>
              <HeaderCell last align="right">Actions</HeaderCell>
              {/* One Fragment per project, emitting 8 cells + optional expanded panel */}
              {visibleProjects.map((p, idx) => (
                <ProjectRowCells
                  key={p.id}
                  project={p}
                  rowIndex={idx + 1}
                  zebra={idx % 2 === 1}
                  tags={(projectTags && projectTags[p.id]) || PRC_EMPTY_TAGS}
                  knownTags={knownTags}
                  notes={(projectNotes && projectNotes[p.id]) || ''}
                  bounceOverrides={(projectBounceOverrides && projectBounceOverrides[p.id]) || PRC_EMPTY_BOUNCE_OVERRIDES}
                  rating={(projectRatings && projectRatings[p.id]) || null}
                  status={(projectStatuses && projectStatuses[p.id]) || null}
                  statuses={effectiveStatuses}
                  statusById={statusById}
                  expanded={expandedIds.has(p.id)}
                  libraryItems={libraryItems}
                  onToggleExpand={() => setExpandedIds((s) => {
                    const next = new Set(s);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  })}
                  onSetTags={(tags) => onSetTags && onSetTags(p.id, tags)}
                  onSetNotes={(text) => onSetNotes && onSetNotes(p.id, text)}
                  onAddManualBounce={() => onAddManualBounce && onAddManualBounce(p)}
                  onDropBounces={(paths) => onDropBouncesOnProject && onDropBouncesOnProject(p, paths)}
                  onDismissAutoBounce={(bouncePath) => onDismissAutoBounce && onDismissAutoBounce(p, bouncePath)}
                  onRemoveManualBounce={(bouncePath) => onRemoveManualBounce && onRemoveManualBounce(p, bouncePath)}
                  onRevealBounce={(bouncePath) => onRevealInFinder && onRevealInFinder(bouncePath)}
                  onSetRating={(r) => onSetRating && onSetRating(p.id, r)}
                  onSetStatus={(s) => onSetStatus && onSetStatus(p.id, s)}
                  onSetKeyOverride={(k) => onSetKeyOverride && onSetKeyOverride(p.id, k)}
                  onOpenManageStatuses={() => setManageStatusesOpen(true)}
                  onOpenInDAW={() => onOpenInDAW && onOpenInDAW(p.path)}
                  onRevealInFinder={() => onRevealInFinder && onRevealInFinder(p.path)}
                  onJumpToPluginInLibrary={onJumpToPluginInLibrary}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {manageStatusesOpen && (
        <ManageStatusesDialog
          statuses={effectiveStatuses}
          isCustom={Array.isArray(customStatuses) && customStatuses.length > 0}
          onClose={() => setManageStatusesOpen(false)}
          onSave={(list) => { onSetStatusList && onSetStatusList(list); setManageStatusesOpen(false); }}
          onResetDefaults={() => { onSetStatusList && onSetStatusList(null); setManageStatusesOpen(false); }}
        />
      )}
      {manageFoldersOpen && (
        <ManageFoldersDialog
          folders={folders}
          projects={projects}
          onClose={() => setManageFoldersOpen(false)}
          onAddFolder={onAddProjectFolder}
          onRemoveFolder={(folder, alsoRemoveProjects) => {
            // The Manage-Folders dialog asks the user separately
            // whether to keep or drop the projects that lived in
            // that folder. We pass that intent through to App.jsx so
            // it can call the right IPC — keep-everything just
            // unindexes the folder; remove-projects-too cleans the
            // library entries that fall under that path too.
            if (onRemoveProjectFolder) onRemoveProjectFolder(folder, { alsoRemoveProjects });
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// ManageFoldersDialog — modal for viewing / removing the folders
// Plugr is currently watching for projects. Lives in the dialog
// (not the projects header) so the always-on header stays compact
// and folder paths don't bleed into the analytics view.
// ============================================================
function ManageFoldersDialog({ folders, projects, onClose, onAddFolder, onRemoveFolder }) {
  // Tally per-folder project counts so the user can see what each
  // entry contributes before deciding what to do with it. The match
  // is a path-prefix check (same rule the scanner uses); a project
  // is counted under at most one folder, the most specific (longest)
  // one that contains it. This avoids double-counting when the user
  // nested one tracked folder inside another.
  const projectsByFolder = useMemo(() => {
    const counts = new Map(folders.map((f) => [f, 0]));
    for (const p of projects) {
      if (!p || !p.path) continue;
      let best = null;
      for (const f of folders) {
        const norm = f.endsWith('/') ? f : f + '/';
        if (p.path === f || p.path.startsWith(norm)) {
          if (!best || f.length > best.length) best = f;
        }
      }
      if (best) counts.set(best, (counts.get(best) || 0) + 1);
    }
    return counts;
  }, [folders, projects]);

  function handleRemove(folder) {
    const count = projectsByFolder.get(folder) || 0;
    let alsoRemoveProjects = false;
    if (count > 0) {
      // Two-step prompt: confirm removal, then ask what to do with
      // the projects. The wording keeps the "leave them there"
      // option explicit so a fat-finger doesn't nuke the user's
      // notes, tags, and ratings.
      const proceed = window.confirm(
        `Stop watching this folder?\n\n${folder}\n\n` +
        `Plugr won't include it in future rescans.`
      );
      if (!proceed) return;
      alsoRemoveProjects = window.confirm(
        `${count} project${count === 1 ? '' : 's'} were scanned from this folder.\n\n` +
        `Do you also want to remove them from your library?\n\n` +
        `OK = Remove the projects too (tags, notes, and ratings on them will be lost).\n` +
        `Cancel = Keep the projects (you can still browse them; they just won't auto-rescan).`
      );
    } else {
      if (!window.confirm(`Stop watching this folder?\n\n${folder}`)) return;
    }
    onRemoveFolder(folder, alsoRemoveProjects);
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '560px', maxWidth: '100%', maxHeight: 'calc(100vh - 80px)',
          display: 'flex', flexDirection: 'column',
          // Use theme-aware background variables so the modal renders
          // correctly in light mode. --bg-1 is defined in every theme;
          // --text is the canonical foreground.
          background: 'var(--bg-1)',
          border: '1px solid var(--line, rgba(127,127,127,0.18))',
          borderRadius: '10px',
          boxShadow: 'var(--shadow, 0 12px 36px rgba(0,0,0,0.45))',
          color: 'var(--text)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line, rgba(127,127,127,0.18))' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>Project Folders</div>
          <div style={{ fontSize: '12px', opacity: 0.65, marginTop: '2px' }}>
            Plugr scans these folders for DAW projects. Removing a folder stops future
            rescans for everything inside it.
          </div>
        </div>
        <div style={{ padding: '12px 18px', overflowY: 'auto', flex: 1 }}>
          {folders.length === 0 ? (
            <div style={{ fontSize: '13px', opacity: 0.65, padding: '12px 0', textAlign: 'center' }}>
              No folders yet. Click <strong>Add folder…</strong> to point Plugr at a directory of projects.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {folders.map((f) => {
                const count = projectsByFolder.get(f) || 0;
                return (
                  <div
                    key={f}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: '12px',
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'var(--bg-2)',
                      border: '1px solid var(--line, rgba(127,127,127,0.12))',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        title={f}
                        style={{
                          fontSize: '12.5px',
                          fontFamily: 'var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >{f}</div>
                      <div style={{ fontSize: '11px', opacity: 0.65, marginTop: '2px' }}>
                        {count} project{count === 1 ? '' : 's'} scanned from here
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      onClick={() => handleRemove(f)}
                      title="Remove this folder from Plugr's watch list"
                      style={{ color: 'var(--bad, #c63a3a)' }}
                    >Remove</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line, rgba(127,127,127,0.18))', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => { onClose(); onAddFolder && onAddFolder(); }}
            title="Pick another folder to scan"
          >+ Add folder…</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Project row — collapsed shows summary + actions + tag chips.
// Expanded reveals the full plugin list with library shortcuts.
// ============================================================
// Pre-computed palette for tag chips — soft pastels that read in both
// light and dark themes. Each tag string hashes to one of these so a
// given tag always shows the same color.
const TAG_PALETTE = [
  { bg: 'hsl(48 95% 88%)',   fg: 'hsl(40 80% 28%)',   border: 'hsl(48 80% 75%)' },  // yellow
  { bg: 'hsl(155 60% 86%)',  fg: 'hsl(155 60% 25%)',  border: 'hsl(155 50% 70%)' }, // mint
  { bg: 'hsl(200 75% 88%)',  fg: 'hsl(210 80% 30%)',  border: 'hsl(200 70% 72%)' }, // sky
  { bg: 'hsl(330 70% 90%)',  fg: 'hsl(330 70% 32%)',  border: 'hsl(330 60% 75%)' }, // pink
  { bg: 'hsl(280 60% 90%)',  fg: 'hsl(280 60% 32%)',  border: 'hsl(280 50% 75%)' }, // lavender
  { bg: 'hsl(20 90% 88%)',   fg: 'hsl(15 75% 32%)',   border: 'hsl(20 80% 75%)' },  // peach
  { bg: 'hsl(170 50% 86%)',  fg: 'hsl(180 60% 25%)',  border: 'hsl(170 45% 70%)' }, // teal
  { bg: 'hsl(95 50% 86%)',   fg: 'hsl(95 50% 26%)',   border: 'hsl(95 45% 70%)' },  // sage
];
function tagPalette(tag) {
  let hash = 0;
  const s = String(tag || '');
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

// ─── Stable empty defaults — used when an annotation map has no
// entry for a given project, so React.memo on ProjectRowCells can
// keep skipping the row instead of getting a new ref each render.
const PRC_EMPTY_TAGS = [];
const PRC_EMPTY_BOUNCE_OVERRIDES = { added: [], dismissed: [] };

// ─── Custom comparator for ProjectRowCells memo. Compares the data
// props (refs and primitives) only. Handler props are inline arrows
// in the parent JSX (new ref every render), but they always describe
// the same behavior, so we ignore their identity. Without this every
// row re-renders on every parent re-render, which causes visible lag
// when updating one project's rating in a large library.
function projectRowCellsPropsEqual(prev, next) {
  return (
    prev.project === next.project &&
    prev.rowIndex === next.rowIndex &&
    prev.zebra === next.zebra &&
    prev.rating === next.rating &&
    prev.status === next.status &&
    prev.notes === next.notes &&
    prev.tags === next.tags &&
    prev.knownTags === next.knownTags &&
    prev.statuses === next.statuses &&
    prev.statusById === next.statusById &&
    prev.expanded === next.expanded &&
    prev.libraryItems === next.libraryItems &&
    prev.bounceOverrides === next.bounceOverrides
  );
}

const ProjectRowCells = React.memo(function ProjectRowCells({
  project,
  rowIndex,
  zebra,
  tags,
  knownTags,
  notes,
  bounceOverrides,
  rating,
  status,
  statuses,
  statusById,
  expanded,
  libraryItems,
  onToggleExpand,
  onSetTags,
  onSetNotes,
  onAddManualBounce,
  onDropBounces,
  onDismissAutoBounce,
  onRemoveManualBounce,
  onRevealBounce,
  onSetRating,
  onSetStatus,
  onSetKeyOverride,
  onOpenManageStatuses,
  onOpenInDAW,
  onRevealInFinder,
  onJumpToPluginInLibrary,
}) {
  const pluginCount = (project.plugins || []).length;
  const instanceCount = (project.plugins || []).reduce((n, p) => n + (p.count || 0), 0);

  // Merge auto-discovered bounces with the user's manual additions
  // and dismissals. Dismissed paths are filtered out; manual adds are
  // appended and de-duped against auto results by path.
  const mergedBounces = useMemo(() => {
    const auto = project.bounces || [];
    const dismissed = new Set((bounceOverrides && bounceOverrides.dismissed) || []);
    const manual = (bounceOverrides && bounceOverrides.added) || [];
    const seenPaths = new Set();
    const out = [];
    for (const b of auto) {
      if (dismissed.has(b.path)) continue;
      if (seenPaths.has(b.path)) continue;
      seenPaths.add(b.path);
      out.push({ ...b, source: b.source || 'auto' });
    }
    for (const b of manual) {
      if (seenPaths.has(b.path)) continue;
      seenPaths.add(b.path);
      out.push({ ...b, source: 'manual' });
    }
    return out.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  }, [project.bounces, bounceOverrides]);

  return (
    <>
      {/* 7 cells in the same grid as the header, one per column. */}
      <RowCell first zebra={zebra} align="right">
        <span style={{ fontSize: '11px', opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>{rowIndex}</span>
      </RowCell>
      <RowCell zebra={zebra}>
        <DawLogo dawType={project.dawType} size={28} />
      </RowCell>
      <RowCell zebra={zebra}>
        <button
          type="button"
          onClick={onToggleExpand}
          style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'inherit', minWidth: 0, overflow: 'hidden', width: '100%' }}
          title={expanded ? 'Collapse' : 'Expand to see plugin list, bounces, notes'}
        >
          <div style={{
            fontSize: '14px', fontWeight: 600, lineHeight: 1.3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            // Dim missing-file projects so the row reads as "data may
            // be stale" at a glance. The full row still works (click
            // through, edit notes, etc.) — we just signal the staleness.
            opacity: project.missing ? 0.55 : 1,
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            {project.missing && (
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: '50%',
                  background: 'var(--warn-bg, rgba(255, 180, 84, 0.18))',
                  color: 'var(--warn, #ffb454)',
                  fontSize: 11, fontWeight: 800, flex: '0 0 auto',
                  cursor: 'help',
                }}
                title={
                  `Plugr couldn't find this file at its last known location ` +
                  `(${project.path}). The info shown is from the last successful ` +
                  `scan on ${formatDate(project.lastSeenAt || project.lastScannedAt)}. ` +
                  `Rescan after the file is back to refresh.`
                }
              >!</span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
          </div>
          <div style={{ fontSize: '11px', opacity: 0.55, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.missing
              ? <span style={{ color: 'var(--warn, #ffb454)' }}>File not found · </span>
              : null}
            {pluginCount} plugin{pluginCount === 1 ? '' : 's'}
            {instanceCount !== pluginCount ? ` · ${instanceCount} instances` : ''}
            {' · '}{formatDate(project.lastModified)}
          </div>
          {project.error && (
            <div style={{ fontSize: '11px', color: 'var(--danger, #ef9a9a)', marginTop: '2px' }} title={project.error}>
              Could not parse this project: {project.error}
            </div>
          )}
        </button>
      </RowCell>
      <RowCell zebra={zebra} align="right">
        <span style={{ fontSize: '13px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, opacity: project.tempo != null ? 1 : 0.3 }}>
          {project.tempo != null
            ? (Number.isInteger(project.tempo) ? project.tempo : project.tempo.toFixed(1))
            : '—'}
          {project.tempo != null && (
            <span style={{ fontSize: '10px', opacity: 0.5, marginLeft: '3px', fontWeight: 500 }}>BPM</span>
          )}
        </span>
      </RowCell>
      <RowCell zebra={zebra} align="center">
        <KeyCell
          detectedKey={project.keyIsOverride ? null : project.key}
          overrideKey={project.keyIsOverride ? project.key : null}
          onSetOverride={onSetKeyOverride}
        />
      </RowCell>
      <RowCell zebra={zebra} align="center">
        <RatingPicker value={rating} onChange={onSetRating} />
      </RowCell>
      <RowCell zebra={zebra}>
        <StatusPicker
          value={status}
          statuses={statuses}
          statusById={statusById}
          onChange={onSetStatus}
          onOpenManage={onOpenManageStatuses}
        />
      </RowCell>
      <RowCell zebra={zebra} style={{ display: 'block' }}>
        <TagChips tags={tags} knownTags={knownTags} onChange={onSetTags} />
      </RowCell>
      <RowCell last zebra={zebra} align="right">
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            className="btn btn-small"
            type="button"
            onClick={onOpenInDAW}
            title={`Open in ${dawLabel(project.dawType)}`}
          >
            Open in {dawLabel(project.dawType)}
          </button>
          <button
            className="btn btn-small btn-ghost"
            type="button"
            onClick={onRevealInFinder}
            title="Reveal in Finder"
            aria-label="Reveal in Finder"
            style={{ width: '28px', padding: '4px 0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1.5 4 a1 1 0 0 1 1-1 h3.5 l1.5 1.5 h6 a1 1 0 0 1 1 1 v6.5 a1 1 0 0 1 -1 1 h-11 a1 1 0 0 1 -1 -1 z" />
            </svg>
          </button>
        </div>
      </RowCell>

      {/* Expanded section: spans every column via gridColumn:'1/-1'. */}
      {expanded && (
        <div style={{ gridColumn: '1 / -1', borderBottom: ROW_BORDER, padding: '14px 16px 18px 64px', background: 'rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {project.dawVersion && (
            <div style={{ fontSize: '12px', opacity: 0.7, display: 'flex', gap: '6px', alignItems: 'baseline' }}>
              <span style={{ opacity: 0.55, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 600 }}>Saved in</span>
              <span style={{ fontWeight: 500 }}>{project.dawVersion}</span>
            </div>
          )}
          <NotesSection notes={notes} onSetNotes={onSetNotes} />
          <BouncesSection
            bounces={mergedBounces}
            project={project}
            onAddManualBounce={onAddManualBounce}
            onDropBounces={onDropBounces}
            onDismissAutoBounce={onDismissAutoBounce}
            onRemoveManualBounce={onRemoveManualBounce}
            onRevealBounce={onRevealBounce}
          />
          <div style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            Plugins
          </div>
          {pluginCount === 0 ? (
            <div style={{ fontSize: '12px', opacity: 0.6 }}>No plugins detected in this project.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 60px', gap: '4px 12px', fontSize: '12px', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, opacity: 0.6 }}>Plugin</div>
              <div style={{ fontWeight: 600, opacity: 0.6, fontSize: '11px' }}>Format</div>
              <div style={{ fontWeight: 600, opacity: 0.6, fontSize: '11px', textAlign: 'right' }}>Uses</div>
              {(project.plugins || []).map((p, i) => {
                // Resolve to a library item if installed, so we can link.
                const libHit = findLibraryMatch(p, libraryItems);
                return (
                  <React.Fragment key={i}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {libHit ? (
                        <button
                          type="button"
                          onClick={() => onJumpToPluginInLibrary && onJumpToPluginInLibrary(libHit.id)}
                          title={`Jump to ${libHit.name} in your library`}
                          style={{ background: 'none', border: 'none', color: 'var(--accent, #6ec1ff)', cursor: 'pointer', textAlign: 'left', padding: 0, font: 'inherit' }}
                        >
                          {libHit.name}
                        </button>
                      ) : (
                        <span title={p.identifier || ''} style={{ opacity: 0.85 }}>
                          {p.name}{' '}
                          <span style={{ fontSize: '10px', opacity: 0.5 }}>(not installed)</span>
                        </span>
                      )}
                    </div>
                    <div style={{ opacity: 0.7, fontSize: '11px' }}>{p.format || '—'}</div>
                    <div style={{ opacity: 0.7, fontSize: '11px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>×{p.count}</div>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}, projectRowCellsPropsEqual)

// Match a project's plugin reference to a library item (same logic
// as projectMatcher.buildProjectMatch but lightweight per-row).
// Plugin references in DAW projects can never be standalone /Applications
// items — they're always plugins (VST3, VST2, AU, AAX, CLAP). Without
// this filter, a project ref to "Massive" can match /Applications/Massive.app
// instead of the Massive plugin, which inflates the Application bucket on
// the chart and produces wrong matches in the filter. Strip them up front.
function pluginsOnly(libraryItems) {
  if (!Array.isArray(libraryItems)) return [];
  return libraryItems.filter((it) => {
    const cat = String(it && it.category || '').toLowerCase();
    if (cat === 'application' || cat === 'daw') return false;
    const fmt = String(it && it.format || '').toLowerCase();
    if (fmt === 'app') return false;
    return true;
  });
}

function findLibraryMatch(ref, libraryItemsRaw) {
  if (!ref) return null;
  const libraryItems = pluginsOnly(libraryItemsRaw);
  if (ref.identifier) {
    const ident = String(ref.identifier).toLowerCase();
    // Pass 1: exact bundle-ID match (VST3 DeviceId, AU bundle id, etc.)
    for (const it of libraryItems) {
      if (it.identifier && String(it.identifier).toLowerCase() === ident) return it;
    }
    // Pass 2: AU FourCC tuple match. Logic projects reference AU plugins
    // as "au:type:subtype:manufacturer" — match against each library
    // item's auKeys (one per AudioComponent in the bundle).
    if (ident.startsWith('au:')) {
      for (const it of libraryItems) {
        if (!Array.isArray(it.auKeys)) continue;
        for (const k of it.auKeys) {
          if (typeof k === 'string' && k.toLowerCase() === ident) return it;
        }
      }
      // Pass 2b: lenient AU match — match on (subtype, manufacturer)
      // alone, ignoring the type byte. Vendors sometimes register the
      // same plugin under multiple AU types (effect/instrument/MIDI
      // variants) and the project file's recorded type may not match
      // what the installed bundle declares.
      const parts = ident.split(':');
      if (parts.length === 4) {
        const refTail = `${parts[2]}:${parts[3]}`;   // "subtype:manufacturer"
        for (const it of libraryItems) {
          if (!Array.isArray(it.auKeys)) continue;
          for (const k of it.auKeys) {
            if (typeof k !== 'string') continue;
            const kParts = k.toLowerCase().split(':');
            if (kParts.length === 4 && `${kParts[2]}:${kParts[3]}` === refTail) return it;
          }
        }
      }
    }
  }
  const nameKey = String(ref.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!nameKey) return null;
  const fmt = String(ref.format || '').toUpperCase();
  for (const it of libraryItems) {
    const itKey = String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (itKey === nameKey && String(it.format || '').toUpperCase() === fmt) return it;
  }
  for (const it of libraryItems) {
    const itKey = String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (itKey === nameKey) return it;
  }
  return null;
}

// ============================================================
// Tag chips — render existing tags + an inline input for new ones.
// Autocompletes from previously-used tags. Enter / comma / blur all
// commit; Backspace on empty input removes the last tag.
// ============================================================
function TagChips({ tags, knownTags, onChange }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (adding && inputRef.current) inputRef.current.focus(); }, [adding]);

  const commit = (raw) => {
    const v = String(raw || '').trim().replace(/^#/, '');
    if (!v) return;
    if (tags.includes(v)) return;
    onChange([...tags, v]);
    setDraft('');
  };
  const removeAt = (idx) => {
    const next = tags.slice();
    next.splice(idx, 1);
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
      {tags.map((t, i) => {
        const c = tagPalette(t);
        return (
          <span key={t + i} style={{
            background: c.bg,
            color: c.fg,
            border: `1px solid ${c.border}`,
            padding: '2px 8px',
            borderRadius: '10px',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.1px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            whiteSpace: 'nowrap',
          }}>
            {t}
            <button
              type="button"
              onClick={() => removeAt(i)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.55, padding: 0, fontSize: '12px', lineHeight: 1 }}
              title="Remove tag"
            >×</button>
          </span>
        );
      })}
      {adding ? (
        <>
          <input
            ref={inputRef}
            type="text"
            list="known-project-tags-dl"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                e.preventDefault();
                commit(draft);
              } else if (e.key === 'Escape') {
                setDraft(''); setAdding(false);
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                removeAt(tags.length - 1);
              }
            }}
            onBlur={() => { commit(draft); setAdding(false); }}
            placeholder="add tag…"
            style={{ minWidth: '80px', maxWidth: '120px', padding: '1px 6px', fontSize: '11px', borderRadius: '10px', border: '1px solid var(--accent-soft, rgba(255,255,255,0.15))', background: 'transparent', color: 'inherit' }}
          />
          {/* Autocomplete source — knownTags shared across all chip
           *  instances. We render the same datalist next to every
           *  chip, but the browser dedupes by id. */}
          <datalist id="known-project-tags-dl">
            {knownTags.filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}
          </datalist>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            background: 'transparent',
            border: '1px dashed var(--border-color, rgba(255,255,255,0.15))',
            color: 'var(--text-muted, rgba(255,255,255,0.6))',
            padding: '1px 8px',
            borderRadius: '10px',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >+ tag</button>
      )}
    </div>
  );
}

// ============================================================
// Notes section — multi-line free-form text per project.
// Autosaves on blur OR after a 600ms debounce while the user types,
// so notes are never lost without the user thinking about saving.
// ============================================================
function NotesSection({ notes, onSetNotes }) {
  const [draft, setDraft] = useState(notes || '');
  // If the project changes underneath us (rescans, manual edits in
  // another window) sync the draft. We compare to the local state so
  // typing isn't interrupted by every render.
  useEffect(() => { setDraft(notes || ''); }, [notes]);
  // Debounced autosave. Saving happens when the user pauses typing
  // for 600ms OR on blur — whichever comes first.
  const timer = useRef(null);
  function scheduleSave(value) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (value !== notes) onSetNotes && onSetNotes(value);
    }, 600);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '6px' }}>
        Notes
      </div>
      <textarea
        value={draft}
        onChange={(e) => { setDraft(e.target.value); scheduleSave(e.target.value); }}
        onBlur={() => {
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          if (draft !== notes) onSetNotes && onSetNotes(draft);
        }}
        placeholder="Add notes for this project — what's missing, what's working, who you sent it to…"
        rows={2}
        style={{
          width: '100%',
          minHeight: '60px',
          padding: '8px 10px',
          fontSize: '12.5px',
          lineHeight: 1.5,
          borderRadius: '6px',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          background: 'var(--input-bg, rgba(255,255,255,0.04))',
          color: 'inherit',
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}

// ============================================================
// Bounces section — list of mixdown audio files for the project.
// Auto-discovered files come from the parser; manually-added files
// come from the user clicking "+ Add bounce…". Each bounce gets an
// inline <audio> player so the user can preview without leaving
// Plugr.
// ============================================================
// Find the longest shared filename prefix across a list of bounces and
// return a sane "snip point" — the last separator (space / _ / - / .)
// before content starts diverging. Pre-clipping common prefixes makes
// "MyTrack_v1_master.wav / MyTrack_v2_master.wav" read as "v1 master /
// v2 master" instead of two near-identical lines that need title-attr
// hovers to distinguish. We only strip when the prefix is meaningfully
// long (>=8 chars and >=1/3 of the shortest name) — otherwise a single
// outlier short filename would erase context from all the others.
function computeCommonBouncePrefix(bounces) {
  if (!bounces || bounces.length < 2) return '';
  // Strip extensions for prefix comparison — the extension is in the
  // suffix region and shouldn't anchor the shared portion.
  const stems = bounces.map((b) => {
    const dot = b.name.lastIndexOf('.');
    return dot > 0 ? b.name.slice(0, dot) : b.name;
  });
  const shortest = stems.reduce((m, s) => Math.min(m, s.length), Infinity);
  let common = 0;
  outer: for (; common < shortest; common++) {
    const ch = stems[0][common];
    for (let i = 1; i < stems.length; i++) {
      if (stems[i][common] !== ch) break outer;
    }
  }
  if (common < 8 || common * 3 < shortest) return '';
  // Pull back to the nearest separator so we don't slice mid-word.
  const sample = stems[0].slice(0, common);
  const m = sample.match(/[ _\-.]/g);
  if (!m) return '';
  // Find the last separator index.
  let last = -1;
  for (let i = 0; i < sample.length; i++) {
    if (/[ _\-.]/.test(sample[i])) last = i;
  }
  if (last < 4) return '';
  return sample.slice(0, last + 1);
}

function BouncesSection({ bounces, project, onAddManualBounce, onDropBounces, onDismissAutoBounce, onRemoveManualBounce, onRevealBounce }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  // Compute the shared filename prefix once per bounces list, then
  // pass a `displayName` (suffix only) down to each row. We still show
  // the full path on hover via title= so the user can see the original
  // when needed.
  const prefix = useMemo(() => computeCommonBouncePrefix(bounces), [bounces]);

  function dragHasFiles(e) {
    return e && e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
  }
  // stopPropagation everywhere so the shell-level project-drop overlay
  // (App.jsx) doesn't also fire — without it, dropping audio on the
  // bounces box would also light up the "drop project files" overlay,
  // then App's drop handler would complain that nothing matched.
  function onDragEnter(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDragActive(true);
  }
  function onDragOver(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Tell the OS this drop will succeed (gives the cursor its "+" badge).
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!dragHasFiles(e)) return;
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  }
  function onDrop(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();   // don't let App.jsx's shell-level drop scoop this up
    dragCounterRef.current = 0;
    setDragActive(false);
    const paths = [...(e.dataTransfer.files || [])].map((f) => f.path).filter(Boolean);
    if (paths.length === 0) return;
    if (onDropBounces) onDropBounces(paths);
  }

  const isEmpty = bounces.length === 0;
  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        // Subtle dashed border in empty state to read as a drop zone
        // even when not actively dragging. Active drag promotes to a
        // solid accent border + tinted bg so the target is obvious.
        border: dragActive
          ? '2px dashed var(--accent, #6ec1ff)'
          : isEmpty
            ? '1px dashed var(--line, rgba(255,255,255,0.12))'
            : '1px solid transparent',
        borderRadius: 8,
        padding: isEmpty || dragActive ? '10px 12px' : '0',
        background: dragActive ? 'var(--accent-bg, rgba(110, 193, 255, 0.08))' : 'transparent',
        transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
          Bounces
        </span>
        <span style={{ fontSize: '11px', opacity: 0.55 }}>
          {isEmpty ? '(none yet)' : `${bounces.length} file${bounces.length === 1 ? '' : 's'}`}
        </span>
        {prefix && (
          // Show the user that we're stripping a common prefix from
          // display so they understand why names look short.
          <span
            title={`All bounce filenames start with "${prefix}" — stripped from display.`}
            style={{
              fontSize: '10px', opacity: 0.5, fontFamily: 'var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              padding: '1px 6px', borderRadius: 8, background: 'var(--line, rgba(255,255,255,0.06))',
            }}
          >{prefix}…</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-small"
          type="button"
          onClick={onAddManualBounce}
          title="Pick audio files to attach to this project. You can also drop files anywhere in this Bounces box."
        >+ Add bounce…</button>
      </div>
      {isEmpty ? (
        <div style={{ fontSize: '12px', opacity: 0.6, padding: '6px 0 2px', lineHeight: 1.5 }}>
          {dragActive ? (
            <strong style={{ color: 'var(--accent, #6ec1ff)' }}>Drop audio files to attach as bounces…</strong>
          ) : (
            <>
              <strong>Drop audio files here</strong> to attach them, or click <strong>+ Add bounce…</strong>.
              {' '}Plugr also auto-discovers files in <code>Bounces/</code> / <code>Exports/</code> /{' '}
              <code>Mixdowns/</code> / <code>Rendered/</code> folders next to your project.
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {bounces.map((b, i) => (
            <BounceRow
              key={b.path}
              bounce={b}
              // When the section has a common prefix, pass a stripped
              // display name so each row reads as the unique suffix.
              displayName={prefix && b.name.startsWith(prefix) ? b.name.slice(prefix.length) : b.name}
              // When this bounce finishes playing, auto-start the
              // next one in the same project — like an album. The
              // last bounce has no nextBouncePath, so playback just
              // ends + the playhead resets.
              nextBouncePath={i + 1 < bounces.length ? bounces[i + 1].path : null}
              onReveal={() => onRevealBounce && onRevealBounce(b.path)}
              onRemove={() => {
                if (b.source === 'manual') onRemoveManualBounce && onRemoveManualBounce(b.path);
                else onDismissAutoBounce && onDismissAutoBounce(b.path);
              }}
            />
          ))}
          {/* Always-visible drop affordance — without this, users have
           * no idea the section accepts dragged files (the dashed
           * border only shows when the list is empty). Promotes to
           * solid accent during an active drag so the target is
           * obvious mid-gesture. */}
          <div
            style={{
              marginTop: 2, padding: '8px 12px', borderRadius: 6,
              border: dragActive
                ? '2px dashed var(--accent, #6ec1ff)'
                : '1px dashed var(--line, rgba(255,255,255,0.14))',
              color: dragActive ? 'var(--accent, #6ec1ff)' : 'var(--muted)',
              fontSize: 11.5,
              fontWeight: dragActive ? 600 : 500,
              textAlign: 'center',
              opacity: dragActive ? 1 : 0.7,
              transition: 'border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease',
            }}
          >
            {dragActive
              ? 'Drop audio files to attach as bounces…'
              : 'Drop audio files here to attach more bounces'}
          </div>
        </div>
      )}
    </div>
  );
}

// Custom DOM event used by auto-advance: when a bounce finishes, the
// row dispatches this event with the next bounce's path. The next
// BounceRow (which listens with the same event name) checks the
// payload against its own path and triggers play() if it matches.
// Using a window event avoids needing a parent-owned refs registry
// or imperative handles across siblings.
const PLAY_BOUNCE_EVENT = 'plugr-play-bounce';

function BounceRow({ bounce, displayName, nextBouncePath, onReveal, onRemove }) {
  // Custom plugr-file:// URL — the renderer can't load file:// URIs
  // directly (Electron renderer-process security), so the main
  // process registers a privileged protocol that streams local files
  // here with proper MIME types + HTTP Range support for seeking.
  //
  // URL form: plugr-file://localhost/Users/joshua/path/to/file.wav
  //                       ^^^^^^^^^
  //                       Required host placeholder. Without it,
  //                       the URL parser treats the first path
  //                       segment (e.g. "Users") as the hostname,
  //                       which silently truncates the path.
  //
  // Each path segment is URL-encoded so spaces / @ / special chars
  // in cloud-storage paths (Google Drive, iCloud) don't break it.
  const fileUrl = useMemo(() => {
    const enc = bounce.path.split('/').map(encodeURIComponent).join('/');
    return `plugr-file://localhost${enc}`;
  }, [bounce.path]);

  // Single source of truth for transport state: BounceRow subscribes
  // to the <audio> element's events and re-renders the play button,
  // waveform playhead, and time display from these state values.
  // (Waveform also subscribes independently so it can compute its
  //  playhead position without re-rendering when the time string
  //  changes — that turns out to keep both UIs perfectly in sync
  //  without prop-drilling all the audio state through.)
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Pull the global volume from the AudioVolumeContext and push it
  // onto the audio element. The slider lives in the toolbar; this
  // component just reads the value. We also pull claimPlayback so
  // starting a bounce pauses any other bounce that was playing.
  const { volume, claimPlayback } = useAudioVolume();

  // Keep nextBouncePath in a ref so the audio event handlers
  // (registered once on mount) read the freshest value instead of a
  // stale closure. Mid-playback list reorders are rare but real
  // (rescans, manual adds), and we don't want to lose advance.
  const nextBouncePathRef = useRef(nextBouncePath);
  useEffect(() => { nextBouncePathRef.current = nextBouncePath; }, [nextBouncePath]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onMeta = () => {
      if (audio.duration && Number.isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const onPlay  = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      // Reset to the start so the next Space tap (or Play click)
      // replays from the beginning — otherwise the audio element
      // sits at duration and Space tries to play from the end,
      // which silently no-ops in most browsers.
      try { audio.currentTime = 0; } catch { /* tolerate */ }
      // Auto-advance: hand off to the next bounce in the same
      // project. The sibling row picks this up via its window-level
      // listener below. We read from a ref so mid-list reorders
      // don't leave us with a stale value.
      const nextPath = nextBouncePathRef.current;
      if (nextPath) {
        window.dispatchEvent(new CustomEvent(PLAY_BOUNCE_EVENT, {
          detail: { path: nextPath },
        }));
      }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    onMeta();
    onTime();
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  // Listen for cross-row "play this bounce" events. Fired by another
  // BounceRow when its audio ends and it wants to hand off playback
  // to us. The event payload carries a path; if it matches ours, we
  // claim the bus and start playback. We rewind first because the
  // user is starting fresh — there's no expectation that we resume
  // from where we left off mid-song.
  useEffect(() => {
    const onPlayMe = (e) => {
      if (!e.detail || e.detail.path !== bounce.path) return;
      const audio = audioRef.current;
      if (!audio) return;
      try { audio.currentTime = 0; } catch { /* tolerate */ }
      if (claimPlayback) claimPlayback(audio);
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    window.addEventListener(PLAY_BOUNCE_EVENT, onPlayMe);
    return () => window.removeEventListener(PLAY_BOUNCE_EVENT, onPlayMe);
  }, [bounce.path, claimPlayback]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Claim the bus FIRST so the previous bounce gets paused before
      // this one starts — otherwise there's a brief overlap window.
      if (claimPlayback) claimPlayback(audio);
      // play() returns a promise that rejects on AbortError / browser
      // autoplay policy — swallow so we don't leak unhandled rejections.
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      audio.pause();
    }
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: '4px 12px',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      background: 'rgba(0,0,0,0.12)',
      alignItems: 'center',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12.5px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={bounce.path}>
          {displayName || bounce.name}
        </div>
        <div style={{ fontSize: '11px', opacity: 0.55, marginTop: '2px' }}>
          {formatSizeBytes(bounce.sizeBytes)}
          {' · '}{formatDate(bounce.mtime)}
          {bounce.source === 'manual' && (
            <span style={{ marginLeft: '6px', padding: '0 6px', borderRadius: '8px', background: 'var(--accent-soft, rgba(110,193,255,0.18))', color: 'var(--accent, #6ec1ff)', fontSize: '10px', fontWeight: 500 }}>
              manual
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button className="btn btn-small btn-ghost" type="button" onClick={onReveal} title="Reveal this bounce in Finder">Reveal</button>
        <button
          className="btn btn-small btn-ghost"
          type="button"
          onClick={onRemove}
          title={bounce.source === 'manual'
            ? 'Remove this manually-added bounce from the project'
            : "Dismiss — this isn't actually a bounce (e.g. it's a sample). Plugr will hide it next time too."}
          style={{ color: 'var(--danger, #ef9a9a)', fontSize: '14px', padding: '4px 8px' }}
        >×</button>
      </div>

      {/* Transport row — play button + waveform + time. The audio
          element lives here too but is visually hidden; it's just
          the playback engine. */}
      <div style={{
        gridColumn: '1 / -1',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginTop: '6px',
      }}>
        <PlayButton isPlaying={isPlaying} onClick={togglePlay} disabled={!duration} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Waveform path={bounce.path} audioRef={audioRef} />
        </div>
        <TimeDisplay current={currentTime} total={duration} />
        <audio
          ref={audioRef}
          src={fileUrl}
          preload="metadata"
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}

// SoundCloud-style circular play / pause toggle. ~36px diameter,
// accent-colored fill, triangle (play) or two-bar (pause) glyph in
// the foreground. Disabled state (no duration loaded yet) just dims
// it slightly so the user knows the button exists but isn't ready.
function PlayButton({ isPlaying, onClick, disabled }) {
  const SIZE = 36;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={isPlaying ? 'Pause' : 'Play'}
      style={{
        width: SIZE, height: SIZE,
        borderRadius: '50%',
        border: 'none',
        background: 'var(--accent, #6ec1ff)',
        color: 'var(--bg, #1a1d22)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        flex: '0 0 auto',
        transition: 'transform 0.08s ease',
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(0.94)'; }}
      onMouseUp={(e)   => { e.currentTarget.style.transform = ''; }}
      onMouseLeave={(e)=> { e.currentTarget.style.transform = ''; }}
    >
      {isPlaying ? (
        // Pause icon — two vertical bars
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
          <rect x="0" y="0" width="4" height="14" fill="currentColor" rx="0.5" />
          <rect x="8" y="0" width="4" height="14" fill="currentColor" rx="0.5" />
        </svg>
      ) : (
        // Play icon — triangle, nudged 1px right so it looks centered
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
          <path d="M 1 0 L 12 7 L 1 14 Z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

// Compact "M:SS / M:SS" time display. Tabular numbers so the digits
// don't jitter while playing. Dim until a duration is available.
function TimeDisplay({ current, total }) {
  function fmt(t) {
    if (!t || !Number.isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  return (
    <span style={{
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
      opacity: total > 0 ? 0.7 : 0.35,
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
      minWidth: '64px',
      textAlign: 'right',
    }}>
      {fmt(current)} / {fmt(total)}
    </span>
  );
}

// Inline SVG waveform for a bounce file with click-to-seek + a
// live playhead that tracks the <audio> element's current time.
//
// Peaks come back as [[min, max], ...] in -1..1 range. Each bar
// straddles the vertical midline so transient asymmetry survives
// visually. Peaks before the playhead render in the accent color
// (the "played" part); peaks after are dimmer (the "unplayed" rest
// of the bounce).
function Waveform({ path, audioRef }) {
  const [peaks, setPeaks] = useState(null);         // null = loading, [] = failed
  const [duration, setDuration] = useState(0);      // seconds
  const [currentTime, setCurrentTime] = useState(0);
  const svgRef = useRef(null);

  // Fetch peaks once per bounce path. Also captures durationSeconds
  // from the waveform extractor so we have a usable duration even
  // before the <audio> element's metadata loads.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getBounceWaveform(path);
        if (cancelled) return;
        if (res && res.ok && Array.isArray(res.peaks) && res.peaks.length > 0) {
          setPeaks(res.peaks);
          if (typeof res.durationSeconds === 'number' && res.durationSeconds > 0) {
            setDuration(res.durationSeconds);
          }
        } else {
          setPeaks([]);
        }
      } catch {
        if (!cancelled) setPeaks([]);
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  // Track audio playback for the playhead. We subscribe to both
  // timeupdate (fires while playing) and seeked (fires on jumps —
  // so the playhead updates instantly after a click rather than
  // waiting for the next time-update tick).
  useEffect(() => {
    const audio = audioRef && audioRef.current;
    if (!audio) return undefined;
    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onMeta = () => {
      if (audio.duration && Number.isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    // Pull initial values in case the element already loaded.
    onMeta();
    onTime();
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
    };
  }, [audioRef, peaks]);   // re-attach once peaks load so dur is in sync

  // Click-and-drag scrubbing. On mousedown we both seek and start a
  // drag; while dragging we listen on `window` (not the SVG) so the
  // playhead keeps tracking when the cursor moves outside the
  // waveform's bounds. A pure click is a 1-event drag — the same
  // code path covers it, so we don't need a separate onClick.
  const [isDragging, setIsDragging] = useState(false);

  // Read `audio.duration` directly inside the seek helper so a
  // mid-drag duration change (e.g. metadata just finished loading)
  // doesn't tear down the listener and break the drag.
  function seekToClientX(clientX) {
    const audio = audioRef && audioRef.current;
    const svg = svgRef.current;
    if (!audio || !svg) return;
    const dur = (Number.isFinite(audio.duration) && audio.duration > 0)
      ? audio.duration
      : duration;
    if (!dur) return;
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = frac * dur;
    // Reflect the seek instantly even before the audio fires its
    // own event — keeps the UI snappy especially during a drag.
    setCurrentTime(frac * dur);
  }

  function handleMouseDown(e) {
    if (!seekable) return;
    // Don't let the mousedown bubble into a parent that might think
    // we're starting a window-drag, and don't let it text-select
    // adjacent labels while scrubbing.
    e.preventDefault();
    setIsDragging(true);
    seekToClientX(e.clientX);
  }

  // Window-level mousemove + mouseup while dragging. Re-binding on
  // every drag start/stop means we don't pay listener overhead when
  // the user isn't actively scrubbing.
  useEffect(() => {
    if (!isDragging) return undefined;
    function onMove(e) { seekToClientX(e.clientX); }
    function onUp() { setIsDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  // Loading placeholder — same height as the eventual waveform so
  // the row doesn't jump when peaks arrive.
  if (peaks == null) {
    return (
      <div style={{
        gridColumn: '1 / -1',
        height: '40px',
        marginTop: '6px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.03)',
      }} />
    );
  }
  // Decode failed — hide entirely so the row stays clean.
  if (peaks.length === 0) return null;

  const VIEW_W = 1000;
  const VIEW_H = 100;
  const HALF_H = VIEW_H / 2;
  const slot = VIEW_W / peaks.length;
  const barW = Math.max(1, slot * 0.7);
  const accent = 'var(--accent, #6ec1ff)';
  const dim = 'rgba(255,255,255,0.10)';

  // Fractional playhead position in 0..1. Falls back to 0 if we
  // don't have a usable duration yet (which means the click-seek
  // is also disabled — see handleSeek).
  const playFrac = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const playheadX = playFrac * VIEW_W;
  const seekable = duration > 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      onMouseDown={seekable ? handleMouseDown : undefined}
      style={{
        gridColumn: '1 / -1',
        width: '100%',
        height: '40px',
        marginTop: '6px',
        display: 'block',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.18)',
        cursor: !seekable
          ? 'default'
          : isDragging
            ? 'grabbing'
            : 'pointer',
        // Prevent the browser from selecting the surrounding row text
        // when the user starts dragging on the waveform.
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {peaks.map(([mn, mx], i) => {
        const top = HALF_H - Math.max(0, Math.min(1, mx)) * HALF_H;
        const bot = HALF_H - Math.max(-1, Math.min(0, mn)) * HALF_H;
        const h = Math.max(1, bot - top);
        // Position of THIS bar as a fraction of total — used to tint
        // played vs unplayed. We treat the bar as played if its
        // center is left of the playhead.
        const barCenterFrac = (i + 0.5) / peaks.length;
        const isPlayed = barCenterFrac <= playFrac;
        return (
          <rect
            key={i}
            x={i * slot + (slot - barW) / 2}
            y={top}
            width={barW}
            height={h}
            fill={accent}
            opacity={isPlayed ? 0.95 : 0.35}
          />
        );
      })}
      {/* Center line so silence has a visual anchor */}
      <line x1={0} y1={HALF_H} x2={VIEW_W} y2={HALF_H} stroke={dim} strokeWidth={0.5} />
      {/* Playhead — only render while a duration is known so the
          line doesn't sit at x=0 looking like a UI bug. */}
      {seekable && (
        <line
          x1={playheadX} y1={0}
          x2={playheadX} y2={VIEW_H}
          stroke="white" strokeWidth={1.5}
          opacity={0.9}
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

function formatSizeBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================
// RatingPicker — A/B/C/D/F tier badge with click-to-open picker.
// Modeled on Makid-style project rating systems. Each tier has its
// own color so a list of ratings reads as a visual hierarchy at a
// glance: gold A → red F.
// ============================================================
const TIER_COLORS = {
  A: { bg: '#FFD400', fg: '#3a2d00', border: '#d4af00' },   // gold
  B: { bg: '#60d394', fg: '#0d3d23', border: '#3fb676' },   // green
  C: { bg: '#6ec1ff', fg: '#0a3654', border: '#4aa1e0' },   // blue
  D: { bg: '#ffa552', fg: '#4a2600', border: '#e08838' },   // orange
  F: { bg: '#ef6262', fg: '#4a0808', border: '#cf4444' },   // red
};

function RatingBadge({ tier, size = 22 }) {
  const c = TIER_COLORS[tier];
  if (!c) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
      borderRadius: '50%',
      background: c.bg,
      color: c.fg,
      border: `1.5px solid ${c.border}`,
      fontSize: size * 0.55,
      fontWeight: 800,
      letterSpacing: '-0.5px',
      lineHeight: 1,
      flex: '0 0 auto',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>{tier}</span>
  );
}

// All 24 western keys, in the order most musicians scan when picking
// one. Sharps first per pitch (C → C# → ... → B), majors before minors
// for each pitch.
const KEY_OPTIONS = [
  'C major', 'C minor',
  'C# major', 'C# minor',
  'D major', 'D minor',
  'D# major', 'Eb major', 'D# minor', 'Eb minor',
  'E major', 'E minor',
  'F major', 'F minor',
  'F# major', 'F# minor',
  'G major', 'G minor',
  'G# major', 'Ab major', 'G# minor', 'Ab minor',
  'A major', 'A minor',
  'A# major', 'Bb major', 'A# minor', 'Bb minor',
  'B major', 'B minor',
];

// Key column cell. Three states:
//   1. detectedKey present → static chip (solid accent color). Not
//      editable: the project file is authoritative, so a re-scan can
//      never be silently outvoted by a stale manual entry.
//   2. overrideKey present → dimmer chip with a click-to-edit handle
//      and a small "manual" affordance (italic + dotted underline).
//   3. neither → "Add key" ghost button.
function KeyCell({ detectedKey, overrideKey, onSetOverride }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Detected — always show, never edit.
  if (detectedKey) {
    return (
      <span style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: '4px',
        background: 'var(--accent-soft, rgba(110,193,255,0.15))',
        color: 'var(--accent, #6ec1ff)',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.2px',
        whiteSpace: 'nowrap',
      }} title="Detected from project file">{normalizeKey(detectedKey) || detectedKey}</span>
    );
  }

  // Override or empty — both are editable. Identical popover; trigger
  // differs by whether there's a current value.
  const currentValue = overrideKey || '';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {overrideKey ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Manually set — click to change or clear"
          style={{
            display: 'inline-block',
            padding: '2px 10px',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--text-muted, #aaa)',
            border: '1px dashed var(--border, rgba(255,255,255,0.25))',
            fontSize: '12px',
            fontWeight: 500,
            fontStyle: 'italic',
            letterSpacing: '0.2px',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >{normalizeKey(overrideKey) || overrideKey}</button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Add a key signature manually"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted, #888)',
            fontSize: '11px',
            fontStyle: 'italic',
            cursor: 'pointer',
            opacity: 0.5,
            padding: '2px 4px',
            borderRadius: '4px',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
        >+ key</button>
      )}
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--surface, #1e2026)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: '8px',
          boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          padding: '6px',
          zIndex: 50,
          maxHeight: '280px',
          overflowY: 'auto',
          minWidth: '120px',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '2px' }}>
            {KEY_OPTIONS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { onSetOverride && onSetOverride(k); setOpen(false); }}
                style={{
                  background: k === currentValue ? 'var(--accent-soft, rgba(110,193,255,0.18))' : 'transparent',
                  color: k === currentValue ? 'var(--accent, #6ec1ff)' : 'inherit',
                  border: 'none',
                  padding: '5px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: k === currentValue ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => { if (k !== currentValue) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(e) => { if (k !== currentValue) e.currentTarget.style.background = 'transparent'; }}
              >{k}</button>
            ))}
          </div>
          {overrideKey && (
            <button
              type="button"
              onClick={() => { onSetOverride && onSetOverride(null); setOpen(false); }}
              style={{
                marginTop: '6px',
                width: '100%',
                background: 'transparent',
                border: '1px solid var(--border, rgba(255,255,255,0.15))',
                borderRadius: '4px',
                color: 'var(--text-muted, #999)',
                padding: '5px',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >Clear</button>
          )}
        </div>
      )}
    </div>
  );
}

function RatingPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click. We don't use a portal — the popover is a
  // sibling of the trigger button and uses absolute positioning, so
  // we just listen for any mousedown outside our root and dismiss.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const tiers = ['A', 'B', 'C', 'D', 'F'];

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={value ? `Tier ${value} — click to change` : 'Rate this project'}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '26px',
          height: '26px',
          borderRadius: '50%',
        }}
      >
        {value ? (
          <RatingBadge tier={value} size={22} />
        ) : (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            border: '1px dashed var(--border-color, rgba(127,127,127,0.4))',
            color: 'var(--text-muted, rgba(127,127,127,0.6))',
            fontSize: '11px',
            fontWeight: 600,
          }}>?</span>
        )}
      </button>
      {open && (
        <div
          // Pop above OR below depending on viewport; default below.
          style={{
            position: 'absolute',
            top: '110%',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            display: 'flex',
            gap: '4px',
            padding: '6px 8px',
            borderRadius: '8px',
            background: 'var(--panel-bg, #2a2a2a)',
            border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
            boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap',
            alignItems: 'center',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {tiers.map((t) => {
            const c = TIER_COLORS[t];
            const isSelected = value === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => { onChange && onChange(t); setOpen(false); }}
                title={`Rate ${t}`}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: c.bg,
                  color: c.fg,
                  border: isSelected ? `2px solid var(--accent, #6ec1ff)` : `1.5px solid ${c.border}`,
                  fontSize: '13px',
                  fontWeight: 800,
                  cursor: 'pointer',
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
              >{t}</button>
            );
          })}
          {value && (
            <button
              type="button"
              onClick={() => { onChange && onChange(null); setOpen(false); }}
              title="Clear rating"
              style={{
                marginLeft: '4px',
                padding: '2px 8px',
                borderRadius: '4px',
                background: 'transparent',
                color: 'var(--text-muted, rgba(255,255,255,0.6))',
                border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                fontSize: '11px',
                cursor: 'pointer',
                lineHeight: 1.6,
              }}
            >Clear</button>
          )}
        </div>
      )}
    </span>
  );
}

// ============================================================
// TempoRangeSlider — two-thumb range slider for filtering projects
// by BPM. Implemented as two overlaid <input type="range"> sliders
// so the user can grab either thumb. The fill bar in the middle
// shows the selected range.
// ============================================================
function TempoRangeSlider({ bounds, value, onChange, active }) {
  const [minV, maxV] = value;
  const { min, max } = bounds;
  const span = max - min || 1;
  const pctLow = ((minV - min) / span) * 100;
  const pctHigh = ((maxV - min) / span) * 100;

  // Allow thumbs to meet so the user can filter to an exact BPM
  // (e.g. "show only 150 BPM projects"). Either thumb can drag past
  // the other — we treat the pair as a sorted range when applying
  // the filter, so the user never gets stuck with an inverted range.
  const setLow = (v) => {
    const n = Math.min(Math.max(min, v), max);
    if (n === minV) return;
    onChange([Math.min(n, maxV), Math.max(n, maxV)]);
  };
  const setHigh = (v) => {
    const n = Math.max(Math.min(max, v), min);
    if (n === maxV) return;
    onChange([Math.min(minV, n), Math.max(minV, n)]);
  };
  const reset = () => onChange([min, max]);

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px 12px 6px 12px',
        borderRadius: '6px',
        border: `1px solid ${active ? 'var(--accent, #6ec1ff)' : 'var(--border-color, rgba(255,255,255,0.1))'}`,
        background: 'var(--input-bg, rgba(255,255,255,0.04))',
        minWidth: '220px',
      }}
      title="Drag the thumbs to filter projects by BPM. Drag both to the same value to filter for one exact BPM. Double-click to reset."
      onDoubleClick={reset}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums', lineHeight: 1, gap: 8 }}>
        <span style={{ fontSize: '10.5px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Tempo</span>
        {/* Active range gets bumped up: bigger font, accent color when
         *  the filter is narrowing results. Inactive state is muted
         *  so the row reads as "ready to filter". */}
        <span style={{
          color: active ? 'var(--accent, #6ec1ff)' : 'inherit',
          fontWeight: active ? 700 : 500,
          fontSize: '13px',
        }}>
          {minV === maxV ? `${minV} BPM` : `${minV}–${maxV} BPM`}
        </span>
      </div>
      <div style={{ position: 'relative', height: '22px' }}>
        {/* Track background */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: '4px',
          transform: 'translateY(-50%)',
          background: 'var(--border-color, rgba(127,127,127,0.25))',
          borderRadius: '2px',
        }} />
        {/* Selected-range fill */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: `${pctLow}%`,
          width: `${pctHigh - pctLow}%`,
          height: '4px',
          transform: 'translateY(-50%)',
          background: 'var(--accent, #6ec1ff)',
          borderRadius: '2px',
        }} />
        {/* Low thumb. Native <input type="range"> places the thumb's
         *  CENTER `thumbWidth/2` pixels in from each end of the input,
         *  which means at min/max the thumb visually stops short of
         *  the track edges. We compensate by extending the input by
         *  half a thumb-width past each edge of the container — so
         *  when the thumb is at min it sits over the container's left
         *  edge, and when at max it sits over the right edge. The
         *  fill bar (computed as a % of value range) already maps to
         *  container coordinates, so it stays aligned with the thumbs.
         *  Thumb width in CSS is 14px (see .tempo-range-thumb), hence
         *  the 7px inset. */}
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={minV}
          onChange={(e) => setLow(Number(e.target.value))}
          className="tempo-range-thumb"
          aria-label="Minimum tempo"
          style={{
            position: 'absolute',
            top: 0,
            left: '-7px',
            width: 'calc(100% + 14px)',
            height: '100%',
            // Reset chrome default styling so both inputs sit on top
            // of each other but only thumbs are interactive.
            appearance: 'none',
            WebkitAppearance: 'none',
            background: 'transparent',
            pointerEvents: 'none',
            margin: 0,
            // zIndex so the low thumb is on top when both thumbs collide.
            zIndex: minV > max - 5 ? 1 : 2,
          }}
        />
        {/* High thumb */}
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={maxV}
          onChange={(e) => setHigh(Number(e.target.value))}
          className="tempo-range-thumb"
          aria-label="Maximum tempo"
          style={{
            position: 'absolute',
            top: 0,
            left: '-7px',
            width: 'calc(100% + 14px)',
            height: '100%',
            appearance: 'none',
            WebkitAppearance: 'none',
            background: 'transparent',
            pointerEvents: 'none',
            margin: 0,
            zIndex: 2,
          }}
        />
      </div>
    </div>
  );
}

// ============================================================
// StatusPicker — colored pill showing the project's workflow
// status, click to pick from the list (with a Manage… escape hatch).
// ============================================================
function StatusPicker({ value, statuses, statusById, onChange, onOpenManage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = value && statusById ? statusById.get(value) : null;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '100%' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={current ? `Status: ${current.label} — click to change` : 'Set workflow status'}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: 'inherit', textAlign: 'left', minWidth: 0, width: '100%',
        }}
      >
        {current ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '3px 9px', borderRadius: '11px',
            background: current.color + '22',  // 13% alpha tint
            color: current.color, border: `1px solid ${current.color}`,
            fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
          }}>
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: current.color, flex: '0 0 auto',
            }} />
            {current.label}
          </span>
        ) : value ? (
          // Orphaned status (assigned, but no longer in the list).
          <span style={{
            fontSize: '11px', opacity: 0.55, fontStyle: 'italic',
          }}>{value}</span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: '2px 10px', borderRadius: '11px',
            border: '1px dashed var(--border-color, rgba(127,127,127,0.4))',
            color: 'var(--text-muted, rgba(127,127,127,0.6))',
            fontSize: '11px',
          }}>set status…</span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: '4px', zIndex: 50,
            display: 'flex', flexDirection: 'column', gap: '2px',
            padding: '4px',
            borderRadius: '8px',
            // Theme-aware surface so the popover reads correctly in
            // light mode too. --bg-1 + --text are defined in every
            // palette; the previous --panel-bg-elevated/text-primary
            // tokens were never declared, so they always fell through
            // to the dark literal.
            background: 'var(--bg-1)',
            color: 'var(--text)',
            border: '1px solid var(--line, rgba(127,127,127,0.18))',
            boxShadow: 'var(--shadow, 0 6px 18px rgba(0,0,0,0.4))',
            minWidth: '180px',
            maxWidth: '260px',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {statuses.map((s) => {
            const selected = value === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => { onChange && onChange(s.id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 10px', borderRadius: '4px',
                  background: selected ? 'var(--accent-soft, rgba(110,193,255,0.15))' : 'transparent',
                  border: 'none', color: 'inherit', cursor: 'pointer',
                  fontSize: '12.5px', textAlign: 'left',
                }}
              >
                <span style={{
                  width: '10px', height: '10px', borderRadius: '50%',
                  background: s.color, flex: '0 0 auto',
                  border: '1px solid rgba(0,0,0,0.15)',
                }} />
                <span style={{ flex: 1 }}>{s.label}</span>
                {selected && <span style={{ opacity: 0.6, fontSize: '11px' }}>✓</span>}
              </button>
            );
          })}
          {value && (
            <button
              type="button"
              onClick={() => { onChange && onChange(null); setOpen(false); }}
              style={{
                marginTop: '2px', padding: '5px 10px', borderRadius: '4px',
                background: 'transparent', border: 'none', color: 'var(--text-muted, rgba(255,255,255,0.6))',
                fontSize: '12px', cursor: 'pointer', textAlign: 'left',
              }}
            >Clear status</button>
          )}
          <div style={{ height: '1px', background: 'var(--border-color, rgba(255,255,255,0.1))', margin: '4px 0' }} />
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenManage && onOpenManage(); }}
            style={{
              padding: '5px 10px', borderRadius: '4px',
              background: 'transparent', border: 'none', color: 'var(--accent, #6ec1ff)',
              fontSize: '12px', cursor: 'pointer', textAlign: 'left',
            }}
          >Manage statuses…</button>
        </div>
      )}
    </span>
  );
}

// ============================================================
// ManageStatusesDialog — modal for editing the project status list.
// Add / rename / recolor / remove / reorder, with a draft state so
// the user can cancel without saving.
// ============================================================
const STATUS_COLOR_SWATCHES = [
  '#9aa0a6', '#6ec1ff', '#60d394', '#ffd400',
  '#ffa552', '#ef6262', '#c084fc', '#ff8fb8',
  '#5ee0c1', '#ffb7b7',
];
let _statusIdSeq = 0;
function makeStatusId() {
  _statusIdSeq++;
  return `s_${Date.now().toString(36)}_${_statusIdSeq}`;
}

function ManageStatusesDialog({ statuses, isCustom, onClose, onSave, onResetDefaults }) {
  const [draft, setDraft] = useState(() => statuses.map((s) => ({ ...s })));

  function updateAt(i, patch) {
    setDraft((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeAt(i) {
    setDraft((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveUp(i) {
    if (i === 0) return;
    setDraft((prev) => {
      const next = prev.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }
  function moveDown(i) {
    setDraft((prev) => {
      if (i >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[i + 1], next[i]] = [next[i], next[i + 1]];
      return next;
    });
  }
  function addNew() {
    setDraft((prev) => [
      ...prev,
      { id: makeStatusId(), label: 'New status', color: STATUS_COLOR_SWATCHES[prev.length % STATUS_COLOR_SWATCHES.length] },
    ]);
  }

  const valid = draft.every((s) => s.label && s.label.trim().length > 0);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '520px', maxWidth: '100%', maxHeight: 'calc(100vh - 80px)',
          display: 'flex', flexDirection: 'column',
          // Theme-aware modal surface. --bg-1 / --text / --line are
          // defined across every theme (dark, light, and the named
          // studio palettes) so the modal automatically reads as
          // light-on-dark in dark themes and dark-on-light in light
          // themes. The old vars (panel-bg-elevated, text-primary)
          // were never defined anywhere, so they always fell through
          // to the dark literal — hence the modal looked dark on a
          // light background.
          background: 'var(--bg-1)',
          border: '1px solid var(--line, rgba(127,127,127,0.18))',
          borderRadius: '10px',
          boxShadow: 'var(--shadow, 0 12px 36px rgba(0,0,0,0.45))',
          color: 'var(--text)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>Manage Project Statuses</div>
          <div style={{ fontSize: '12px', opacity: 0.65, marginTop: '2px' }}>
            Rename, recolor, reorder, or remove statuses. Changes apply to every project at once.
          </div>
        </div>
        <div style={{ padding: '12px 18px', overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {draft.map((s, i) => (
              <div
                key={s.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 28px 1fr auto auto',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    title="Move up"
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.25 : 0.7, fontSize: '11px', padding: 0, lineHeight: 1 }}
                  >▲</button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i === draft.length - 1}
                    title="Move down"
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: i === draft.length - 1 ? 'default' : 'pointer', opacity: i === draft.length - 1 ? 0.25 : 0.7, fontSize: '11px', padding: 0, lineHeight: 1 }}
                  >▼</button>
                </div>
                <input
                  type="color"
                  value={s.color}
                  onChange={(e) => updateAt(i, { color: e.target.value })}
                  title="Status color"
                  style={{ width: '28px', height: '28px', padding: 0, border: '1px solid var(--border-color, rgba(255,255,255,0.12))', borderRadius: '6px', background: 'transparent', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={s.label}
                  onChange={(e) => updateAt(i, { label: e.target.value })}
                  placeholder="Status label"
                  style={{
                    width: '100%', padding: '5px 8px', fontSize: '13px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                    background: 'var(--input-bg, rgba(255,255,255,0.04))',
                    color: 'inherit',
                  }}
                />
                <div style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '2px 8px', borderRadius: '10px',
                  background: s.color + '22', color: s.color,
                  border: `1px solid ${s.color}`, fontSize: '11px', fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}>{s.label || ' '}</div>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  title="Remove status"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger, #ef9a9a)', fontSize: '15px', padding: '4px 8px' }}
                >×</button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addNew}
            className="btn btn-small"
            style={{ marginTop: '10px' }}
          >+ Add status</button>
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isCustom && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => {
                if (confirm('Reset to the built-in statuses? Any custom statuses you\'ve added will be lost, and projects assigned to those will lose their status.')) {
                  onResetDefaults();
                }
              }}
              title="Replace your list with the built-in default statuses"
            >Reset to defaults</button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!valid}
            onClick={() => onSave(draft.map((s) => ({ id: s.id, label: s.label.trim(), color: s.color })))}
            title={valid ? 'Save changes' : 'All statuses need a label'}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MultiSelectDropdown — chip-style filter picker. Click the trigger
// to open; check / uncheck multiple options; the trigger shows a
// summary ("All tags" / "Tag · #vocal" / "Tags · 3") and a clear-all
// × when at least one option is selected. Match-anything behavior:
// passing an empty Set to `selected` means "no filter active."
// ============================================================
function MultiSelectDropdown({ label, allLabel, options, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Summary text in the trigger:
  //   - 0 selected → allLabel ("All tags")
  //   - 1 selected → "Tag · <label>"
  //   - 2+ selected → "Tags · N"
  let summary = allLabel;
  if (selected.size === 1) {
    const only = [...selected][0];
    const opt = options.find((o) => o.value === only);
    summary = opt ? `${label.replace(/s$/, '')} · ${opt.label}` : `${label} · ${selected.size}`;
  } else if (selected.size > 1) {
    summary = `${label} · ${selected.size}`;
  }
  const active = selected.size > 0;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Filter by ${label.toLowerCase()}`}
        style={{
          padding: '6px 10px',
          paddingRight: active ? '28px' : '10px',
          fontSize: '13px',
          borderRadius: '4px',
          border: `1px solid ${active ? 'var(--accent, #6ec1ff)' : 'var(--border-color, rgba(255,255,255,0.1))'}`,
          background: active ? 'color-mix(in srgb, var(--accent, #6ec1ff) 12%, var(--input-bg, rgba(255,255,255,0.04)))' : 'var(--input-bg, rgba(255,255,255,0.04))',
          color: active ? 'var(--accent, #6ec1ff)' : 'inherit',
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        {summary}
        {active && (
          // Inline × that clears the filter without opening the menu.
          // Layered on top of the button via absolute positioning so we
          // don't need a nested button (which would be invalid HTML).
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${label} filter`}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClear(); } }}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '14px',
              lineHeight: 1,
              opacity: 0.7,
              cursor: 'pointer',
              padding: '2px 4px',
            }}
          >×</span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '180px',
            maxWidth: '280px',
            maxHeight: '320px',
            overflowY: 'auto',
            background: 'var(--bg-1)',
            color: 'var(--text)',
            border: '1px solid var(--line, rgba(127,127,127,0.18))',
            borderRadius: '8px',
            boxShadow: 'var(--shadow, 0 6px 18px rgba(0,0,0,0.4))',
            zIndex: 50,
            padding: '4px',
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: '12px', opacity: 0.6 }}>No options.</div>
          ) : options.map((opt) => {
            const checked = selected.has(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onToggle(opt.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 10px',
                  width: '100%',
                  borderRadius: '4px',
                  background: checked ? 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)' : 'transparent',
                  border: 'none', color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  textAlign: 'left',
                  fontWeight: checked ? 600 : 400,
                }}
                onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = 'rgba(127,127,127,0.08)'; }}
                onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: '14px', height: '14px', borderRadius: '3px',
                  border: `1px solid ${checked ? 'var(--accent, #6ec1ff)' : 'var(--line, rgba(127,127,127,0.5))'}`,
                  background: checked ? 'var(--accent, #6ec1ff)' : 'transparent',
                  color: checked ? 'var(--bg-0)' : 'transparent',
                  fontSize: '10px', fontWeight: 800, flex: '0 0 auto',
                }}>✓</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
              </button>
            );
          })}
          {active && (
            <button
              type="button"
              onClick={() => { onClear(); setOpen(false); }}
              style={{
                marginTop: '4px',
                padding: '6px 10px',
                width: '100%',
                background: 'transparent',
                border: '1px solid var(--line, rgba(127,127,127,0.18))',
                borderRadius: '4px',
                color: 'var(--text)',
                opacity: 0.75,
                fontSize: '11.5px',
                cursor: 'pointer',
              }}
            >Clear all</button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PluginFamilyPicker — searchable picker over every plugin
// referenced by any scanned project (not just the top 15 in the
// chart). The user types to narrow down 500+ plugins to the one
// they want; clicking it sets the chart filter to that family.
// Highlights the currently-active selection (if the user already
// drilled in via the chart, opening the picker shows that plugin
// pre-selected at the top).
// ============================================================
function PluginFamilyPicker({ families, selectedKey, totalProjects, onPick, onClear }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Auto-focus the search field on open — they came here to search.
    if (inputRef.current) inputRef.current.focus();
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQuery(''); } };
    const onKey  = (e) => { if (e.key === 'Escape') { setOpen(false); setQuery(''); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Filter by query — case-insensitive substring on the display label.
  // Cap to 60 entries so the dropdown stays scrollable but performant
  // even with libraries that have thousands of unique plugins.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return families.slice(0, 60);
    const out = [];
    for (const f of families) {
      if (f.label.toLowerCase().includes(q)) out.push(f);
      if (out.length >= 60) break;
    }
    return out;
  }, [families, query]);

  // Trigger label — show "Plugin · {name}" when one's selected, else
  // the generic prompt. Picks up the active label from the families
  // list so it stays in sync if the user resolved an unknown name
  // after a rescan.
  const selectedFam = selectedKey ? families.find((f) => f.key === selectedKey) : null;
  const triggerLabel = selectedFam ? `Plugin · ${selectedFam.label}` : 'Filter by plugin…';
  const active = !!selectedFam;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Drill the project list down to projects that use a specific plugin"
        style={{
          padding: '6px 10px',
          paddingRight: active ? '28px' : '10px',
          fontSize: '13px',
          borderRadius: '4px',
          border: `1px solid ${active ? 'var(--accent, #6ec1ff)' : 'var(--border-color, rgba(255,255,255,0.1))'}`,
          background: active ? 'color-mix(in srgb, var(--accent, #6ec1ff) 12%, var(--input-bg, rgba(255,255,255,0.04)))' : 'var(--input-bg, rgba(255,255,255,0.04))',
          color: active ? 'var(--accent, #6ec1ff)' : 'inherit',
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
          position: 'relative',
          maxWidth: '220px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {triggerLabel}
        {active && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear plugin filter"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClear(); } }}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              fontSize: '14px', lineHeight: 1, opacity: 0.7, cursor: 'pointer', padding: '2px 4px',
            }}
          >×</span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '280px',
            maxWidth: '380px',
            background: 'var(--bg-1)',
            color: 'var(--text)',
            border: '1px solid var(--line, rgba(127,127,127,0.18))',
            borderRadius: '8px',
            boxShadow: 'var(--shadow, 0 6px 18px rgba(0,0,0,0.4))',
            zIndex: 50,
            padding: '6px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${families.length.toLocaleString()} plugins…`}
            style={{
              padding: '6px 10px',
              fontSize: '13px',
              borderRadius: '4px',
              border: '1px solid var(--line, rgba(127,127,127,0.18))',
              background: 'var(--bg-2)',
              color: 'inherit',
              outline: 'none',
            }}
          />
          <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '12px', fontSize: '12px', opacity: 0.6, textAlign: 'center' }}>
                No plugins match "{query}".
              </div>
            ) : (
              filtered.map((f) => {
                const isSel = f.key === selectedKey;
                const pct = totalProjects > 0 ? Math.round((f.projectCount / totalProjects) * 100) : 0;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => { onPick(f); setOpen(false); setQuery(''); }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      background: isSel ? 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)' : 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '12.5px',
                      textAlign: 'left',
                      fontWeight: isSel ? 600 : 400,
                    }}
                    onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'rgba(127,127,127,0.08)'; }}
                    onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                    <span style={{ fontSize: '11px', opacity: 0.65, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {f.projectCount} · {pct}%
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {query.trim() === '' && families.length > filtered.length && (
            <div style={{ fontSize: '10.5px', opacity: 0.55, padding: '4px 8px', textAlign: 'center' }}>
              Showing first {filtered.length} of {families.length.toLocaleString()}. Type to narrow.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Memoize ProjectsView with a custom comparator that ONLY checks the
// data props (the actual things that could meaningfully change the
// rendered output). Function/handler props are ignored — they're new
// references every App render (e.g. inline lambdas) but the BEHAVIOR
// they trigger is stable. Without this comparator, every App state
// change anywhere — even on a different tab — would force ProjectsView
// to re-render its 400-row list, which we measured at ~3.5s per click.
// With it, ProjectsView only re-renders when projectLibrary / overrides
// / library items actually mutate. Switching tabs becomes near-instant
// because the bail-out short-circuits the entire 3.5s render path.
// Content-aware equality for arrays/maps. The reference might change
// (because App's useMemo gets invalidated for harmless reasons) even
// though the underlying data didn't actually mutate. We avoid the
// expensive ProjectsView re-render by checking length + a couple of
// representative IDs.
function itemsArrayLikelyEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return (
    a[0] === b[0] || (a[0] && b[0] && a[0].id === b[0].id)
  ) && (
    a[a.length - 1] === b[b.length - 1] ||
    (a[a.length - 1] && b[b.length - 1] && a[a.length - 1].id === b[b.length - 1].id)
  );
}
function projectMatchLikelyEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // projectMatch shape: { usedItemIds:Set, mostUsed:[], unmatchedReferences:[], projectsByLibraryId:Map, countByLibraryId:Map }
  return (
    (a.usedItemIds?.size ?? 0) === (b.usedItemIds?.size ?? 0) &&
    (a.mostUsed?.length ?? 0) === (b.mostUsed?.length ?? 0) &&
    (a.unmatchedReferences?.length ?? 0) === (b.unmatchedReferences?.length ?? 0) &&
    (a.countByLibraryId?.size ?? 0) === (b.countByLibraryId?.size ?? 0)
  );
}

// Wrapper component: shows a fast skeleton on first render so the tab
// VISUALLY switches in <16ms, then triggers the heavy ProjectsViewInner
// mount in the next animation frame. Result: clicking Projects switches
// the tab instantly with a 'Loading…' shell, then the real content
// materializes a beat later instead of freezing the UI for 3-5s while
// React synchronously renders 400 rows + chart aggregations.
function ProjectsView(props) {
  const [contentReady, setContentReady] = React.useState(false);
  React.useEffect(() => {
    // Schedule the heavy mount for the next frame. The skeleton has
    // already painted; React now reconciles the full inner content
    // without blocking the original tab-switch paint.
    const id = requestAnimationFrame(() => setContentReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!contentReady) {
    return <ProjectsSkeleton />;
  }
  return <ProjectsViewInner {...props} />;
}

// Cheap placeholder shown while ProjectsViewInner mounts on first
// visit. Renders in <5ms — no project list, no charts, no aggregations.
function ProjectsSkeleton() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '60px 40px', textAlign: 'center', opacity: 0.6 }}>
        <div
          style={{
            display: 'inline-block',
            width: 28, height: 28,
            border: '2.5px solid var(--line, rgba(127,127,127,0.25))',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            marginBottom: 16,
          }}
          aria-hidden="true"
        />
        <div style={{ fontSize: 13, color: 'var(--muted, rgba(127,127,127,0.85))' }}>
          Loading your projects…
        </div>
      </div>
    </div>
  );
}

function projectsPropsEqual(prev, next) {
  // Strict ref-equality on most data props
  const refKeys = ['projectLibrary','projectTags','projectNotes','projectBounceOverrides','projectRatings','projectStatuses','projectKeyOverrides','customStatuses'];
  for (const k of refKeys) {
    if (prev[k] !== next[k]) return false;
  }
  // Content-aware for the two derived values that App keeps invalidating
  // even when nothing actually changed.
  if (!itemsArrayLikelyEqual(prev.libraryItems, next.libraryItems)) return false;
  if (!projectMatchLikelyEqual(prev.projectMatch, next.projectMatch)) return false;
  return true;
}
export default React.memo(ProjectsView, projectsPropsEqual);
