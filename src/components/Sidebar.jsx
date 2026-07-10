import React, { useMemo, useState } from 'react';
import { formatBytes, naturalCompare } from '../util/format.js';

const FORMAT_ORDER = ['VST3', 'AU', 'VST2', 'AAX', 'CLAP', 'App'];

const UPDATE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'outdated', label: 'Updates available' },
  { value: 'current', label: 'Up to date' },
  // Plugins handled exclusively by a companion app (Native Access, Waves
  // Central, etc.) with no public version-check URL available — Plugr
  // can't detect whether they're outdated. Note: when a plugin has BOTH
  // a companion app AND a version source configured, it lands in the
  // normal 'outdated' / 'current' / 'ahead' buckets instead (with a
  // 'via <companion>' chip alongside the update status).
  // Single Unknown bucket lumps together: no source, companion-managed,
  // and saved-URL-but-can't-auto-parse. Per-card UpdateBadge still
  // distinguishes these visually so the user can see which is which
  // when viewing the bucket — the prior 3-way split was redundant
  // since the detail panel already surfaces companion + URL.
  { value: 'ignored', label: 'Ignored' },
  { value: 'unknown', label: 'Unknown' },
];

const CLEANUP_OPTIONS = [
  { value: 'all', label: 'Show all' },
  { value: 'duplicate', label: 'Duplicates' },
  { value: 'superseded', label: 'Old versions' },
];

const COMPAT_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'incompatible', label: 'May not work on this Mac' },
  { value: 'ok', label: 'Compatible' },
  { value: 'unknown', label: 'Unknown' },
];

export default function Sidebar({
  summary,
  items,
  // Per-section filtered projections so each sidebar section reflects every
  // active filter EXCEPT its own dimension. Falls back to `items` if a
  // caller doesn't pass them, preserving back-compat.
  itemsForCategories,
  itemsForDevelopers,
  itemsForCompat,
  activeFormats, onToggleFormat,
  activeCategory, onSelectCategory,
  activeDeveloper, onSelectDeveloper,
  // Free-form plugin tags. tagCounts is a Map<tagName, plugin count>
  // — passed pre-computed from App.jsx so the sidebar doesn't have
  // to walk the whole library just to render the section header.
  // Pass null/empty Map when tagging isn't enabled / no tags exist
  // and the section will hide itself.
  activeTag, onSelectTag, tagCounts,
  updateFilter, onUpdateFilterChange,
  updateStatusCounts,
  cleanupFilter, onCleanupFilterChange,
  favoritesOnly, onFavoritesOnlyChange,
  favoritesCount,
  // Hidden bucket — analogous to favorites but inverted: ON = show only
  // the user's hidden plugins, OFF = exclude them from every other view.
  // hiddenCount is unaffected by other filters so the badge always
  // reflects the true library total.
  showHidden, onShowHiddenChange,
  hiddenCount,
  categorySort, onCategorySortChange,        // 'count' | 'alpha'
  developerSort, onDeveloperSortChange,      // 'count' | 'alpha'
  formatSort, onFormatSortChange,            // 'count' | 'alpha'
  onBulkRenameDeveloper,                     // (oldName) => void
  onDiscoverAll,                             // () => void
  compatFilter, onCompatFilterChange,        // 'all' | 'incompatible' | 'ok' | 'unknown'
  onDropOnDeveloper,                         // (devName, ids) => void
  onDropOnCategory,                          // ({ category, subcategory }, ids) => void
  sectionOrder,                              // string[] | null
  onSectionOrderChange,                      // (newOrder) => void
  // Project scanning. projectLibrary is the cache payload (null when
  // the user hasn't scanned any folders yet). projectMatch is what the
  // matcher in src/lib/projectMatcher.js produced from it + the library.
  projectLibrary,
  projectMatch,
  projectFilter,
  onProjectFilterChange,                     // (filter | null) => void
  onAddProjectFolder,                        // () => void
  onRescanProjects,                          // () => void
  onClearProjects,                           // () => void
  onRemoveProjectFolder,                     // (folder) => void
  onShowUnmatchedReferences,                 // () => void  — opens a popover/list
}) {
  // Drop helpers used by developer + category rows below.
  const acceptDrag = (e) => {
    if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/x-plugr-items')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  const readDragIds = (e) => {
    try {
      const raw = e.dataTransfer.getData('application/x-plugr-items');
      if (!raw) return null;
      const ids = JSON.parse(raw);
      return Array.isArray(ids) && ids.length > 0 ? ids : null;
    } catch { return null; }
  };
  const [dropTarget, setDropTarget] = useState(null);    // 'dev:Waves' / 'cat:Effect/Reverb'

  // Section reordering. Each draggable section header writes the section
  // id into `application/x-plugr-section` on dragstart; other section
  // headers act as drop targets and rearrange the array on drop. The
  // resulting order is persisted via the onSectionOrderChange callback
  // (App.jsx wires that to prefs:set).
  // 'favorites' is the combined Favorites + Hidden pill row. The old
  // standalone 'hidden' id is filtered out of saved orders below for
  // back-compat with users who reordered the sidebar before the merge.
  const DEFAULT_SECTION_ORDER = ['favorites', 'projects', 'formats', 'updates', 'cleanup', 'compat', 'categories', 'developers', 'tags'];
  const effectiveOrder = useMemo(() => {
    const allowed = new Set(DEFAULT_SECTION_ORDER);
    const fromPref = Array.isArray(sectionOrder) ? sectionOrder.filter((id) => allowed.has(id)) : [];
    const seen = new Set(fromPref);
    // Append any default sections the user's order is missing (newly added
    // section after an upgrade). That way no section ever disappears.
    const tail = DEFAULT_SECTION_ORDER.filter((id) => !seen.has(id));
    return [...fromPref, ...tail];
  }, [sectionOrder]);
  const [dragSectionId, setDragSectionId] = useState(null);
  const [dragOverSectionId, setDragOverSectionId] = useState(null);
  // Source: lives on the small grip icon at the start of the header.
  const sectionDragSource = (id) => ({
    draggable: !!onSectionOrderChange,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-plugr-section', id);
      e.dataTransfer.setData('text/plain', `Plugr section: ${id}`);
      setDragSectionId(id);
    },
    onDragEnd: () => { setDragSectionId(null); setDragOverSectionId(null); },
  });
  // Target: lives on the whole <section> element. Accepts only the
  // section-reorder mime type, so dropping plugins onto sidebar rows
  // still works (different mime, different handlers).
  const sectionDragTarget = (id) => ({
    onDragOver: (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/x-plugr-section')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverSectionId(id);
      }
    },
    onDragLeave: () => setDragOverSectionId((cur) => cur === id ? null : cur),
    onDrop: (e) => {
      if (!onSectionOrderChange) return;
      const fromId = e.dataTransfer.getData('application/x-plugr-section');
      if (!fromId) return;
      e.preventDefault();
      setDragOverSectionId(null);
      setDragSectionId(null);
      if (fromId === id) return;
      const next = effectiveOrder.filter((s) => s !== fromId);
      const insertIdx = next.indexOf(id);
      next.splice(insertIdx, 0, fromId);
      onSectionOrderChange(next);
    },
  });
  /** Build the per-section props bundle (CSS order, drop handlers, drag-state classes). */
  const sectionPropsFor = (id) => ({
    wrapperProps: {
      style: { order: effectiveOrder.indexOf(id) + 1 },
      ...sectionDragTarget(id),
    },
    wrapperClassName: `${dragOverSectionId === id ? 'section-dragover' : ''} ${dragSectionId === id ? 'section-dragging' : ''}`,
    dragHandleProps: sectionDragSource(id),
  });
  const [openSections, setOpenSections] = useState({
    favorites: true,
    formats: true,
    categories: true,
    developers: true,
    updates: true,
    cleanup: true,
    compat: true,
    projects: true,
    tags: true,
  });
  // Per-project list expansion — only the project list under the Projects
  // section. Defaults to collapsed because the list can get long.
  const [projectsListOpen, setProjectsListOpen] = useState(false);

  // Build the category tree. Sub-category sort matches the parent's sort
  // preference for visual consistency. Counts come from
  // itemsForCategories — every active filter applied except activeCategory
  // — so picking a category doesn't hide all the others.
  const categoryItems = itemsForCategories || items;
  const categoryTree = useMemo(() => {
    const tree = {};
    for (const it of categoryItems) {
      const c = it.category || 'Undefined';
      if (!tree[c]) tree[c] = { total: 0, subs: {} };
      tree[c].total++;
      if (c === 'MIDI') continue;
      const s = it.subcategory;
      if (s && s.toLowerCase() !== c.toLowerCase() && s !== 'Uncategorized') {
        tree[c].subs[s] = (tree[c].subs[s] || 0) + 1;
      }
    }
    const sortKind = categorySort || 'count';
    const ordered = Object.entries(tree).sort(([a, da], [b, db]) => {
      // Always push pseudo-categories (Application, Other, MIDI) to the
      // bottom so users see their main musical categories first.
      const tail = (k) => (k === 'Application' ? 3 : k === 'Undefined' ? 2 : k === 'MIDI' ? 1 : 0);
      const t = tail(a) - tail(b);
      if (t !== 0) return t;
      if (sortKind === 'alpha') return naturalCompare(a, b);
      // count: most-populated first
      return db.total - da.total || naturalCompare(a, b);
    });
    return { entries: ordered, sortKind };
  }, [categoryItems, categorySort]);

  // Developer counts respect every active filter except activeDeveloper.
  const developerItems = itemsForDevelopers || items;
  const developerCounts = useMemo(() => {
    const counts = {};
    for (const it of developerItems) counts[it.developer || 'Unknown'] = (counts[it.developer || 'Unknown'] || 0) + 1;
    const sortKind = developerSort || 'count';
    const arr = Object.entries(counts);
    if (sortKind === 'alpha') {
      arr.sort((a, b) => naturalCompare(a[0], b[0]));
    } else {
      arr.sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]));
    }
    return { entries: arr, sortKind };
  }, [developerItems, developerSort]);

  function toggleSection(name) {
    setOpenSections((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  // Per-item OS-compat counts. Use the projection that respects every
  // active filter except the current compat filter, so the user can see
  // how many would land in each compat bucket given their other filters.
  const compatItems = itemsForCompat || items;
  const compatCounts = useMemo(() => {
    const c = { all: compatItems.length, ok: 0, incompatible: 0, unknown: 0 };
    for (const it of compatItems) {
      const s = it.osCompat && it.osCompat.status;
      if (s === 'ok') c.ok++;
      else if (s === 'incompatible') c.incompatible++;
      else c.unknown++;
    }
    return c;
  }, [compatItems]);

  // Build a list of active filter chips for the top of the sidebar.
  // Each entry knows how to clear itself, so users can see at a glance
  // exactly which filters are applied without scrolling the side menu.
  const activeChips = [];
  if (favoritesOnly) activeChips.push({ key: 'fav', label: '★ Favorites only', onClear: () => onFavoritesOnlyChange(false) });
  if (showHidden) activeChips.push({ key: 'hid', label: 'Hidden only', onClear: () => onShowHiddenChange && onShowHiddenChange(false) });
  if (projectFilter && onProjectFilterChange) {
    let label;
    if (projectFilter.kind === 'mostUsed') label = '📊 Used in projects';
    else if (projectFilter.kind === 'unused') label = '💤 Never used in projects';
    else if (projectFilter.kind === 'unmatched') label = '❓ Not Installed';
    else if (projectFilter.kind === 'project') {
      const projects = (projectLibrary && projectLibrary.projects) || [];
      const p = projects.find((x) => x.id === projectFilter.projectId);
      label = `🎵 Project: ${p ? p.name : projectFilter.projectId}`;
    }
    if (label) activeChips.push({ key: 'proj', label, onClear: () => onProjectFilterChange(null) });
  }
  if (activeCategory) {
    const lab = activeCategory.subcategory
      ? `${activeCategory.category} / ${activeCategory.subcategory}`
      : activeCategory.category;
    activeChips.push({ key: 'cat', label: lab, onClear: () => onSelectCategory(null) });
  }
  if (activeDeveloper) activeChips.push({ key: 'dev', label: activeDeveloper, onClear: () => onSelectDeveloper(null) });
  if (activeTag) activeChips.push({ key: 'tag', label: `#${activeTag}`, onClear: () => onSelectTag && onSelectTag(null) });
  if (updateFilter && updateFilter !== 'all') {
    const labels = { outdated: 'Updates available', current: 'Up to date', ignored: 'Ignored', unknown: 'Unchecked / unknown' };
    activeChips.push({ key: 'upd', label: labels[updateFilter] || updateFilter, onClear: () => onUpdateFilterChange('all') });
  }
  if (cleanupFilter && cleanupFilter !== 'all') {
    const labels = { duplicate: 'Duplicates only', superseded: 'Old versions only' };
    activeChips.push({ key: 'cln', label: labels[cleanupFilter] || cleanupFilter, onClear: () => onCleanupFilterChange('all') });
  }
  if (compatFilter && compatFilter !== 'all') {
    const labels = { incompatible: 'May not work on this Mac', ok: 'Compatible only', unknown: 'Compat unknown' };
    activeChips.push({ key: 'cmp', label: labels[compatFilter] || compatFilter, onClear: () => onCompatFilterChange && onCompatFilterChange('all') });
  }
  // Format chips: only show if some formats are unchecked (i.e. user
  // narrowed by format).
  const FORMAT_TOTAL = FORMAT_ORDER.length;
  if (activeFormats && activeFormats.size > 0 && activeFormats.size < FORMAT_TOTAL) {
    const list = FORMAT_ORDER.filter((f) => activeFormats.has(f)).join(' · ');
    activeChips.push({
      key: 'fmt',
      label: `Formats: ${list}`,
      onClear: () => {
        // Re-enable everything by toggling each missing format back on.
        for (const f of FORMAT_ORDER) if (!activeFormats.has(f)) onToggleFormat(f);
      },
    });
  }

  function clearAllChips() {
    for (const c of activeChips) c.onClear();
  }

  return (
    <aside className="sidebar">
      {activeChips.length > 0 && (
        <div className="active-filters">
          <div className="active-filters-row">
            {activeChips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="filter-chip"
                onClick={c.onClear}
                title={`Clear filter: ${c.label}`}
              >
                <span className="chip-label">{c.label}</span>
                <span className="chip-x" aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          {activeChips.length > 1 && (
            <button type="button" className="link-btn clear-all" onClick={clearAllChips}>
              Clear all filters
            </button>
          )}
        </div>
      )}
      {/* Compact pill toggles for Favorites + Hidden — both live on a
       *  single row to save vertical space (the previous full-width
       *  rows were overkill for two simple boolean filters). Each pill
       *  reflects its state via background + bold, with the count
       *  shown when nonzero. The combined section participates in
       *  drag-reorder under the original 'favorites' id so we don't
       *  break anyone's saved sidebar order. */}
      <div
        className={`sidebar-section single-row-section pill-row-section ${dragOverSectionId === 'favorites' ? 'section-dragover' : ''} ${dragSectionId === 'favorites' ? 'section-dragging' : ''}`}
        style={{
          order: effectiveOrder.indexOf('favorites') + 1,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
        }}
        {...sectionDragTarget('favorites')}
      >
        {onSectionOrderChange && (
          <span className="section-drag-handle" title="Drag to reorder this section" aria-label="Drag to reorder" {...sectionDragSource('favorites')}>⋮⋮</span>
        )}
        <FilterPill
          active={favoritesOnly}
          onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
          label="★ Favorites"
          count={favoritesCount || 0}
          activeColor="var(--accent, #6ec1ff)"
          title={favoritesOnly ? 'Showing favorites only — click to show all' : 'Click to show only favorites'}
        />
        {onShowHiddenChange && (
          <FilterPill
            active={showHidden}
            onClick={() => onShowHiddenChange(!showHidden)}
            label="⊘ Hidden"
            count={hiddenCount || 0}
            activeColor="var(--accent, #6ec1ff)"
            title={showHidden ? 'Showing hidden plugins only — click to go back to normal view' : 'Click to view (and unhide) plugins you have hidden'}
          />
        )}
      </div>

      {/* Projects section — only rendered when the user has actually
       *  scanned at least one project folder. The trigger to scan
       *  lives in the dedicated Projects tab; we don't want to crowd
       *  the sidebar with an onboarding card. */}
      {onProjectFilterChange && projectLibrary && projectLibrary.projects && projectLibrary.projects.length > 0 && (
        <Section
          title="Projects"
          open={openSections.projects}
          onToggle={() => toggleSection('projects')}
          {...sectionPropsFor('projects')}
        >
          {(() => {
            const lib = projectLibrary;
            const match = projectMatch || { usedItemIds: new Set(), mostUsed: [], unmatchedReferences: [] };
            const projects = (lib && lib.projects) || [];
            const folders = (lib && lib.folders) || [];
            const usedCount = match.usedItemIds ? match.usedItemIds.size : 0;
            const totalItems = items ? items.length : 0;
            const unusedCount = Math.max(0, totalItems - usedCount);
            const unmatchedCount = (match.unmatchedReferences || []).length;
            const isActive = (f) => projectFilter && projectFilter.kind === f.kind &&
              (f.kind !== 'project' || projectFilter.projectId === f.projectId);

            return (
              <>
                {/* Aggregate buckets */}
                <button
                  className={`row pickable ${isActive({ kind: 'mostUsed' }) ? 'active' : ''}`}
                  onClick={() => onProjectFilterChange(isActive({ kind: 'mostUsed' }) ? null : { kind: 'mostUsed' })}
                  type="button"
                  title="Library plugins that appear in at least one project"
                >
                  <span className="row-label">📊 Used in projects</span>
                  <span className="row-count">{usedCount}</span>
                </button>
                <button
                  className={`row pickable ${isActive({ kind: 'unused' }) ? 'active' : ''}`}
                  onClick={() => onProjectFilterChange(isActive({ kind: 'unused' }) ? null : { kind: 'unused' })}
                  type="button"
                  title="Library plugins NOT used in any scanned project — candidates for deletion or hiding"
                >
                  <span className="row-label">💤 Never used</span>
                  <span className="row-count">{unusedCount}</span>
                </button>
                {unmatchedCount > 0 && (
                  <button
                    className={`row pickable ${isActive({ kind: 'unmatched' }) ? 'active' : ''}`}
                    onClick={() => {
                      if (onShowUnmatchedReferences) onShowUnmatchedReferences();
                      onProjectFilterChange(isActive({ kind: 'unmatched' }) ? null : { kind: 'unmatched' });
                    }}
                    type="button"
                    title="Plugins referenced by your projects that aren't installed on this Mac"
                  >
                    <span className="row-label">❓ Not Installed</span>
                    <span className="row-count">{unmatchedCount}</span>
                  </button>
                )}

                {/* Per-project list */}
                <button
                  className="row pickable"
                  onClick={() => setProjectsListOpen((s) => !s)}
                  type="button"
                  style={{ opacity: 0.8 }}
                >
                  <span className="row-label">{projectsListOpen ? '▾' : '▸'} All projects</span>
                  <span className="row-count">{projects.length}</span>
                </button>
                {projectsListOpen && (
                  <div style={{ marginLeft: '6px', maxHeight: '260px', overflowY: 'auto' }}>
                    {[...projects]
                      .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || '') || naturalCompare(a.name, b.name))
                      .map((p) => {
                        const active = isActive({ kind: 'project', projectId: p.id });
                        const dawIcon = p.dawType === 'ableton' ? '🎛' : p.dawType === 'logic' ? '🎼' : p.dawType === 'flstudio' ? '🍓' : '🎵';
                        const pluginCount = (p.plugins || []).length;
                        return (
                          <button
                            key={p.id}
                            className={`row pickable subcat ${active ? 'active' : ''}`}
                            onClick={() => onProjectFilterChange(active ? null : { kind: 'project', projectId: p.id })}
                            type="button"
                            title={p.path}
                            style={{ fontSize: '11.5px' }}
                          >
                            <span className="row-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {dawIcon} {p.name}
                            </span>
                            <span className="row-count">{pluginCount}</span>
                          </button>
                        );
                      })}
                  </div>
                )}

                {/* Folder management lives on the Projects tab; the
                 *  sidebar section is purely a set of filter
                 *  shortcuts. We only keep a small "go to Projects"
                 *  hint here so the link is obvious. */}
              </>
            );
          })()}
        </Section>
      )}

      <Section
        title="Formats"
        open={openSections.formats}
        onToggle={() => toggleSection('formats')}
        {...sectionPropsFor('formats')}
        sortControl={
          <SortToggle
            value={formatSort || 'count'}
            onChange={onFormatSortChange}
            ariaLabel="Sort formats"
          />
        }
      >
        {(() => {
          const sortKind = formatSort || 'count';
          const sorted = [...FORMAT_ORDER].sort((a, b) => {
            if (sortKind === 'alpha') return naturalCompare(a, b);
            const ca = (summary && summary.byFormat && summary.byFormat[a]) || 0;
            const cb = (summary && summary.byFormat && summary.byFormat[b]) || 0;
            return cb - ca || naturalCompare(a, b);
          });
          return sorted.map((fmt) => {
            const count = (summary && summary.byFormat && summary.byFormat[fmt]) || 0;
            const checked = activeFormats.has(fmt);
            return (
              <label key={fmt} className={`row toggle ${checked ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleFormat(fmt)}
                />
                <span className="row-label">{fmt}</span>
                <span className="row-count">{count}</span>
              </label>
            );
          });
        })()}
      </Section>

      <Section
        title="Update status"
        open={openSections.updates}
        onToggle={() => toggleSection('updates')}
        {...sectionPropsFor('updates')}
      >
        {UPDATE_OPTIONS.map((opt) => {
          const count = (updateStatusCounts && updateStatusCounts[opt.value]) || 0;
          return (
            <button
              key={opt.value}
              className={`row pickable ${updateFilter === opt.value ? 'active' : ''}`}
              onClick={() => onUpdateFilterChange(opt.value)}
              type="button"
            >
              <span className="row-label">{opt.label}</span>
              <span className="row-count">{count}</span>
            </button>
          );
        })}
        {onDiscoverAll && (updateStatusCounts && updateStatusCounts.unknown > 0) && (
          <button
            className="row pickable discover-all-row"
            onClick={onDiscoverAll}
            type="button"
            title="Visit each developer's website looking for update sources for any plugin currently 'unchecked'."
          >
            <span className="row-label">⚡ Find missing sources</span>
          </button>
        )}
      </Section>

      <Section
        title="Cleanup"
        open={openSections.cleanup}
        onToggle={() => toggleSection('cleanup')}
        {...sectionPropsFor('cleanup')}
      >
        {CLEANUP_OPTIONS.map((opt) => {
          const count = opt.value === 'duplicate'
            ? (summary && summary.duplicateCount) || 0
            : opt.value === 'superseded'
              ? (summary && summary.supersededCount) || 0
              : items.length;
          const sizeHint = opt.value === 'duplicate'
            ? (summary && summary.duplicateBytes)
            : opt.value === 'superseded'
              ? (summary && summary.supersededBytes)
              : null;
          return (
            <button
              key={opt.value}
              className={`row pickable ${cleanupFilter === opt.value ? 'active' : ''}`}
              onClick={() => onCleanupFilterChange(opt.value)}
              type="button"
              title={sizeHint ? `Approx. ${formatBytes(sizeHint)} reclaimable` : undefined}
            >
              <span className="row-label">
                {opt.label}
                {sizeHint ? <span className="hint"> · {formatBytes(sizeHint)}</span> : null}
              </span>
              <span className="row-count">{count}</span>
            </button>
          );
        })}
      </Section>

      {onCompatFilterChange && (
        <Section
          title="macOS compatibility"
          open={openSections.compat}
          onToggle={() => toggleSection('compat')}
          {...sectionPropsFor('compat')}
        >
          {COMPAT_OPTIONS.map((opt) => {
            const count = compatCounts[opt.value] || 0;
            return (
              <button
                key={opt.value}
                className={`row pickable ${(compatFilter || 'all') === opt.value ? 'active' : ''}`}
                onClick={() => onCompatFilterChange(opt.value)}
                type="button"
              >
                <span className="row-label">{opt.label}</span>
                <span className="row-count">{count}</span>
              </button>
            );
          })}
        </Section>
      )}

      <Section
        title="Categories"
        open={openSections.categories}
        onToggle={() => toggleSection('categories')}
        {...sectionPropsFor('categories')}
        sortControl={
          <SortToggle
            value={categoryTree.sortKind}
            onChange={onCategorySortChange}
            ariaLabel="Sort categories"
          />
        }
      >
        <button
          type="button"
          className={`row pickable ${activeCategory === null ? 'active' : ''}`}
          onClick={() => onSelectCategory(null)}
        >
          <span className="row-label">All categories</span>
          <span className="row-count">{items.length}</span>
        </button>

        {categoryTree.entries.map(([cat, data]) => {
          const isCatActive = activeCategory && activeCategory.category === cat && !activeCategory.subcategory;
          const subs = Object.entries(data.subs).sort((a, b) => {
            if (categoryTree.sortKind === 'alpha') return naturalCompare(a[0], b[0]);
            return b[1] - a[1] || naturalCompare(a[0], b[0]);
          });
          const catKey = `cat:${cat}/`;
          const isCatDropTarget = dropTarget === catKey;
          return (
            <div key={cat} className="cat-block">
              <button
                type="button"
                className={`row pickable parent ${isCatActive ? 'active' : ''} ${isCatDropTarget ? 'drop-target' : ''}`}
                onClick={() => onSelectCategory({ category: cat, subcategory: null })}
                onDragOver={onDropOnCategory ? (e) => { acceptDrag(e); setDropTarget(catKey); } : undefined}
                onDragLeave={onDropOnCategory ? () => setDropTarget((cur) => cur === catKey ? null : cur) : undefined}
                onDrop={onDropOnCategory ? (e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const ids = readDragIds(e);
                  if (ids) onDropOnCategory({ category: cat, subcategory: null }, ids);
                } : undefined}
              >
                <span className="row-label">{cat}</span>
                <span className="row-count">{data.total}</span>
              </button>
              {subs.map(([sub, n]) => {
                const isSubActive = activeCategory && activeCategory.category === cat && activeCategory.subcategory === sub;
                const subKey = `cat:${cat}/${sub}`;
                const isSubDropTarget = dropTarget === subKey;
                return (
                  <button
                    key={sub}
                    type="button"
                    className={`row pickable child ${isSubActive ? 'active' : ''} ${isSubDropTarget ? 'drop-target' : ''}`}
                    onClick={() => onSelectCategory({ category: cat, subcategory: sub })}
                    onDragOver={onDropOnCategory ? (e) => { acceptDrag(e); setDropTarget(subKey); } : undefined}
                    onDragLeave={onDropOnCategory ? () => setDropTarget((cur) => cur === subKey ? null : cur) : undefined}
                    onDrop={onDropOnCategory ? (e) => {
                      e.preventDefault();
                      setDropTarget(null);
                      const ids = readDragIds(e);
                      if (ids) onDropOnCategory({ category: cat, subcategory: sub }, ids);
                    } : undefined}
                  >
                    <span className="row-label">{sub}</span>
                    <span className="row-count">{n}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </Section>

      <Section
        title="Developers"
        open={openSections.developers}
        onToggle={() => toggleSection('developers')}
        {...sectionPropsFor('developers')}
        sortControl={
          <SortToggle
            value={developerCounts.sortKind}
            onChange={onDeveloperSortChange}
            ariaLabel="Sort developers"
          />
        }
      >
        <button
          type="button"
          className={`row pickable ${activeDeveloper === null ? 'active' : ''}`}
          onClick={() => onSelectDeveloper(null)}
        >
          <span className="row-label">All developers</span>
          <span className="row-count">{developerCounts.entries.length}</span>
        </button>
        {developerCounts.entries.map(([dev, n]) => {
          const dropKey = `dev:${dev}`;
          const isDropTarget = dropTarget === dropKey;
          return (
            <div
              key={dev}
              className={`row-with-action ${activeDeveloper === dev ? 'active' : ''} ${isDropTarget ? 'drop-target' : ''}`}
              onDragOver={onDropOnDeveloper ? (e) => { acceptDrag(e); setDropTarget(dropKey); } : undefined}
              onDragLeave={onDropOnDeveloper ? () => setDropTarget((cur) => cur === dropKey ? null : cur) : undefined}
              onDrop={onDropOnDeveloper ? (e) => {
                e.preventDefault();
                setDropTarget(null);
                const ids = readDragIds(e);
                if (ids) onDropOnDeveloper(dev, ids);
              } : undefined}
            >
              <button
                type="button"
                className={`row pickable ${activeDeveloper === dev ? 'active' : ''}`}
                onClick={() => onSelectDeveloper(activeDeveloper === dev ? null : dev)}
                title={dev}
              >
                <span className="row-label">{dev}</span>
                <span className="row-count">{n}</span>
              </button>
              {onBulkRenameDeveloper && (
                <button
                  type="button"
                  className="row-action-btn"
                  onClick={(e) => { e.stopPropagation(); onBulkRenameDeveloper(dev); }}
                  title={`Rename "${dev}" — applies to all ${n} of their plugins`}
                  aria-label={`Rename ${dev} for all plugins`}
                >
                  ✎
                </button>
              )}
            </div>
          );
        })}
      </Section>

      {/* Tags — free-form user labels. Hidden entirely when the
          user hasn't tagged anything (no point showing an empty
          section that clutters the sidebar). Counts come from a
          pre-aggregated Map passed in from App.jsx so we don't
          recompute on every render. Click a tag to filter; click
          again (or the matching active-chip × at the top) to clear. */}
      {tagCounts && tagCounts.size > 0 && (
        <Section
          title="Tags"
          open={openSections.tags}
          onToggle={() => toggleSection('tags')}
          {...sectionPropsFor('tags')}
        >
          <button
            type="button"
            className={`row pickable ${activeTag === null ? 'active' : ''}`}
            onClick={() => onSelectTag && onSelectTag(null)}
          >
            <span className="row-label">All tags</span>
            <span className="row-count">{tagCounts.size}</span>
          </button>
          {[...tagCounts.entries()]
            .sort((a, b) => (b[1] - a[1]) || naturalCompare(a[0], b[0]))
            .map(([tag, n]) => (
              <button
                key={tag}
                type="button"
                className={`row pickable ${activeTag === tag ? 'active' : ''}`}
                onClick={() => onSelectTag && onSelectTag(activeTag === tag ? null : tag)}
                title={tag}
              >
                <span className="row-label">#{tag}</span>
                <span className="row-count">{n}</span>
              </button>
            ))}
        </Section>
      )}
    </aside>
  );
}

/** Tiny segmented control for choosing alphabetical vs count-based sort. */
function SortToggle({ value, onChange, ariaLabel }) {
  if (!onChange) return null;          // sort not enabled by parent
  const v = value || 'count';
  return (
    <div className="sort-toggle" role="radiogroup" aria-label={ariaLabel}>
      <button
        type="button"
        className={v === 'count' ? 'active' : ''}
        title="Sort by number of plugins"
        onClick={(e) => { e.stopPropagation(); onChange('count'); }}
        aria-checked={v === 'count'}
        role="radio"
      >#</button>
      <button
        type="button"
        className={v === 'alpha' ? 'active' : ''}
        title="Sort alphabetically"
        onClick={(e) => { e.stopPropagation(); onChange('alpha'); }}
        aria-checked={v === 'alpha'}
        role="radio"
      >A→Z</button>
    </div>
  );
}

/**
 * Sidebar section wrapper. Supports optional drag-to-reorder by accepting:
 *   - `dragHandleProps`: spread onto a small grip icon at the start of the
 *     header — this is the ONLY draggable element so clicks elsewhere in
 *     the header still toggle expand/collapse.
 *   - `wrapperProps`: spread onto the outer <section> element so the
 *     parent can install drop handlers that accept reorder drops.
 *   - `wrapperClassName`: extra classes (for drag-over highlight state).
 */
// Compact pill toggle used for Favorites + Hidden. Designed to sit
// inline with other pills on a single row — small, rounded, with an
// optional count badge on the right side. Active state fills the
// background with the supplied accent color; inactive state keeps a
// subtle outlined look so two pills can coexist visually without
// competing.
function FilterPill({ active, onClick, label, count, activeColor, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      title={title}
      className={`filter-pill ${active ? 'active' : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '999px',
        border: `1px solid ${active ? activeColor : 'var(--border-color, rgba(127,127,127,0.25))'}`,
        background: active
          ? `color-mix(in srgb, ${activeColor} 18%, transparent)`
          : 'transparent',
        color: active ? activeColor : 'inherit',
        opacity: active ? 1 : 0.85,
        fontSize: '12px',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms, opacity 120ms',
        outline: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <span>{label}</span>
      {count > 0 && (
        <span
          style={{
            background: active
              ? `color-mix(in srgb, ${activeColor} 35%, transparent)`
              : 'color-mix(in srgb, currentColor 12%, transparent)',
            color: active ? activeColor : 'inherit',
            fontSize: '11px',
            padding: '0 6px',
            borderRadius: '8px',
            fontVariantNumeric: 'tabular-nums',
            opacity: active ? 1 : 0.75,
          }}
        >
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

function Section({ title, open, onToggle, children, sortControl, dragHandleProps, wrapperProps, wrapperClassName }) {
  return (
    <section className={`sidebar-section ${wrapperClassName || ''}`} {...(wrapperProps || {})}>
      <div className="section-header-row">
        {dragHandleProps && (
          <span
            className="section-drag-handle"
            title="Drag to reorder this section"
            aria-label="Drag to reorder"
            {...dragHandleProps}
          >⋮⋮</span>
        )}
        <button type="button" className="section-header" onClick={onToggle} aria-expanded={open}>
          <span>{title}</span>
          <svg
            viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        {sortControl && open && <div className="section-sort">{sortControl}</div>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}
