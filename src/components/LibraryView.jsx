import React, { useEffect, useRef, useState } from 'react';
import PluginCard from './PluginCard.jsx';
import UpdateBadge from './UpdateBadge.jsx';
import FormatTag from './FormatTag.jsx';
import { formatBytes, displaySubcategory, displayCategory } from '../util/format.js';

// Column metadata for the list view. `min` is the minimum width (the
// width below which dragging is refused — large enough to fit the column
// header text plus its sort arrow and the cell content the column needs
// to convey at all). `default` is the starting width.
// Min widths are chosen so the column HEADER (uppercase 11px label + sort
// arrow + horizontal padding) is always fully legible. They're a hard
// floor — drag can't go below them, and stale cached widths from earlier
// builds are clamped up.
const COLUMNS = [
  { key: 'name',      label: 'Plugin',    cls: 'col-name',      min: 220, default: 380 },
  { key: 'developer', label: 'Developer', cls: 'col-developer', min: 170, default: 220 },
  { key: 'category',  label: 'Category',  cls: 'col-category',  min: 150, default: 180 },
  { key: 'format',    label: 'Format',    cls: 'col-format',    min: 120, default: 130 },
  { key: 'version',   label: 'Version',   cls: 'col-version',   min: 130, default: 140 },
  { key: 'size',      label: 'Size',      cls: 'col-size',      min: 110, default: 120 },
  { key: 'status',    label: 'Status',    cls: 'col-update',    min: 160, default: 180 },
];

function SortIcon({ dir }) {
  if (dir === 'asc') return <span className="sort-arrow">▲</span>;
  if (dir === 'desc') return <span className="sort-arrow">▼</span>;
  return <span className="sort-arrow muted">↕</span>;
}

function LibraryView({
  items, updates, selectedId, selectedIds, onSelect, onToggleFavorite, view,
  sortBy, sortDir, onSortChange,
  columnWidths, onColumnWidthsChange,
  // Project-usage lookup. Map<itemId, { projectCount, instanceCount, projects:[…] }>.
  // Optional — when present, every card/row renders a small 'N projects'
  // chip beside the format pill.
  projectUsageById,
  // Right-click on any card / row. Receives (item, event). Callers
  // typically use it to pop a ContextMenu — the parent suppresses the
  // browser default via event.preventDefault() before delegating.
  onItemContextMenu,
}) {
  // selectedIds is the canonical multi-select set; selectedId is the
  // legacy single-id prop (kept for back-compat with existing callers).
  // Compute a Set we can do O(1) lookups against.
  const selSet = selectedIds instanceof Set ? selectedIds : new Set(selectedId ? [selectedId] : []);
  // Click handler honors Cmd-click (toggle) and Shift-click (range). Both
  // collapse to a single-select on a plain click — same behavior as Finder.
  const handleItemClick = (id, event) => {
    if (!onSelect) return;
    if (event && (event.metaKey || event.ctrlKey)) {
      onSelect(id, { toggle: true });
    } else if (event && event.shiftKey) {
      onSelect(id, { range: true });
    } else {
      onSelect(id);
    }
  };

  // Drag start: serialize the dragged plugin ids into the dataTransfer so
  // the sidebar drop targets can read them in onDrop. If the user drags
  // an item that's already part of the multi-selection, drag the whole
  // selection; otherwise just that one. Matches Finder's behavior.
  const handleDragStart = (id, event) => {
    const ids = selSet.has(id) && selSet.size > 1 ? Array.from(selSet) : [id];
    try {
      event.dataTransfer.setData('application/x-plugr-items', JSON.stringify(ids));
      event.dataTransfer.setData('text/plain', `${ids.length} plugin${ids.length === 1 ? '' : 's'}`);
      event.dataTransfer.effectAllowed = 'move';
    } catch { /* dnd not available, ignore */ }
  };
  // Local widths state. Honors persisted user widths but never goes below
  // each column's per-column minimum (which is set high enough to always
  // show the full header label + sort arrow). Stored widths from older
  // versions of the app may be too narrow — we clamp them up.
  const initialWidths = COLUMNS.reduce((acc, c) => {
    const stored = columnWidths && columnWidths[c.key];
    acc[c.key] = Math.max(c.min, stored || c.default);
    return acc;
  }, {});
  const [widths, setWidths] = useState(initialWidths);
  const dragRef = useRef(null);   // { key, startX, startWidth }

  // If the parent's columnWidths prop changes (e.g. cache loaded after mount),
  // pick up the new values. Don't fight the user mid-drag.
  // Always clamp incoming widths up to the per-column minimum — stale
  // cached values from earlier builds may be below the floor.
  useEffect(() => {
    if (dragRef.current) return;
    if (!columnWidths) return;
    setWidths((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const c of COLUMNS) {
        const incoming = columnWidths[c.key];
        if (!incoming) continue;
        const clamped = Math.max(c.min, incoming);
        if (clamped !== cur[c.key]) {
          next[c.key] = clamped;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [columnWidths]);

  // Resize drag.
  //
  // Two-state design to avoid freezing the app on long libraries:
  //   - During the drag we mutate the table's --col-grid CSS variable in
  //     place via the DOM. This is one paint per frame — zero React work,
  //     so hundreds of rows don't re-render on every mouse move.
  //   - On mouseup we commit the final width to React state once.
  // Previously we called setWidths on every mousemove, which caused
  // visible freezing as React reconciled every row on every pixel.
  const tableRef = useRef(null);
  function onResizeStart(e, key) {
    e.preventDefault();
    e.stopPropagation();
    const colDef = COLUMNS.find((c) => c.key === key);
    const minWidth = (colDef && colDef.min) || 80;
    const startX = e.clientX;
    const startWidth = widths[key];
    let lastWidth = startWidth;
    dragRef.current = { key };
    document.body.classList.add('is-col-resizing');

    const buildTemplate = (overrideKey, overrideValue) => {
      const tpl = COLUMNS.map((c) => `${c.key === overrideKey ? overrideValue : widths[c.key]}px`).join(' ');
      const total = COLUMNS.reduce((sum, c) => sum + (c.key === overrideKey ? overrideValue : widths[c.key]), 0);
      if (tableRef.current) {
        tableRef.current.style.setProperty('--col-grid', tpl);
        tableRef.current.style.minWidth = `${total}px`;
      }
    };

    function onMove(ev) {
      const delta = ev.clientX - startX;
      const next = Math.max(minWidth, Math.round(startWidth + delta));
      if (next === lastWidth) return;
      lastWidth = next;
      buildTemplate(key, next);
    }
    function onUp() {
      dragRef.current = null;
      document.body.classList.remove('is-col-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (lastWidth !== startWidth) {
        setWidths((cur) => {
          const merged = { ...cur, [key]: lastWidth };
          if (onColumnWidthsChange) onColumnWidthsChange(merged);
          return merged;
        });
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  if (view === 'list') {
    const gridTemplate = COLUMNS.map((c) => `${widths[c.key]}px`).join(' ');
    const totalWidth = COLUMNS.reduce((sum, c) => sum + widths[c.key], 0);
    return (
      <div className="library-list-scroll">
      <div
        ref={tableRef}
        className="library-list"
        role="grid"
        style={{ '--col-grid': gridTemplate, minWidth: `${totalWidth}px` }}
      >
        <div className="list-header">
          {COLUMNS.map((col, i) => {
            const active = sortBy === col.key;
            const isLast = i === COLUMNS.length - 1;
            return (
              <div key={col.key} className={`header-cell-wrap ${col.cls}`}>
                <button
                  type="button"
                  className={`header-cell ${active ? 'active' : ''}`}
                  onClick={() => onSortChange(col.key)}
                  title={`Sort by ${col.label}${active ? ' — click again to reverse' : ''}`}
                >
                  <span>{col.label}</span>
                  <SortIcon dir={active ? sortDir : null} />
                </button>
                {!isLast && (
                  <div
                    className="col-resize-handle"
                    role="separator"
                    aria-label={`Resize ${col.label} column`}
                    onMouseDown={(e) => onResizeStart(e, col.key)}
                  />
                )}
              </div>
            );
          })}
        </div>
        {items.map((it) => {
          const dup = it.duplicate;
          const u = updates[it.id];
          return (
            <button
              key={it.id}
              type="button"
              role="row"
              draggable
              onDragStart={(e) => handleDragStart(it.id, e)}
              className={`list-row ${selSet.has(it.id) ? 'selected' : ''} ${dup && dup.status ? `dup-${dup.status}` : ''}`}
              onClick={(e) => handleItemClick(it.id, e)}
              onContextMenu={(e) => { if (onItemContextMenu) { e.preventDefault(); onItemContextMenu(it, e); } }}
            >
              <span className="col-name">
                <FavoriteStar
                  on={!!it.favorite}
                  onToggle={(e) => { e.stopPropagation(); onToggleFavorite(it.id, !it.favorite); }}
                />
                <span
                  className="dot"
                  data-cat={it.category}
                  title={displayCategory(it)}
                />
                <span className="row-name">{it.name}</span>
                {dup && dup.status && (
                  <span className={`dup-pill dup-${dup.status} compact`} title={dup.reason}>
                    {dup.status === 'duplicate' ? 'dup' : 'old'}
                  </span>
                )}
                {it.osCompat && it.osCompat.status === 'incompatible' && (
                  <span className="os-pill compact" title={it.osCompat.message}>!os</span>
                )}
                {Array.isArray(it.tags) && it.tags.length > 0 && (
                  <span
                    title={it.tags.map((t) => `#${t}`).join(', ')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '3px',
                      marginLeft: '4px',
                    }}
                  >
                    {it.tags.slice(0, 2).map((t) => (
                      <span key={t} style={{
                        fontSize: '10px',
                        padding: '0 5px',
                        borderRadius: '3px',
                        background: 'var(--accent-soft, rgba(110,193,255,0.15))',
                        color: 'var(--accent, #6ec1ff)',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        maxWidth: '90px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>#{t}</span>
                    ))}
                    {it.tags.length > 2 && (
                      <span style={{ fontSize: '10px', opacity: 0.55, fontWeight: 500 }}>+{it.tags.length - 2}</span>
                    )}
                  </span>
                )}
              </span>
              <span className="col-developer">{it.developer}</span>
              <span className="col-category">{displaySubcategory(it) || it.category}</span>
              <span className="col-format"><FormatTag item={it} variant="pill" /></span>
              <span className="col-version">{it.version || '—'}</span>
              <span className="col-size">{formatBytes(it.sizeBytes)}</span>
              <span className="col-update"><UpdateBadge item={it} update={u} compact /></span>
            </button>
          );
        })}
      </div>
      </div>
    );
  }

  return (
    <div className="library-grid">
      {items.map((it) => (
        <PluginCard
          key={it.id}
          item={it}
          update={updates[it.id]}
          selected={selSet.has(it.id)}
          onClick={(e) => handleItemClick(it.id, e)}
          onContextMenu={(e) => { if (onItemContextMenu) { e.preventDefault(); onItemContextMenu(it, e); } }}
          onDragStart={(e) => handleDragStart(it.id, e)}
          onToggleFavorite={(e) => { e.stopPropagation(); onToggleFavorite(it.id, !it.favorite); }}
          projectUsage={projectUsageById ? projectUsageById.get(it.id) : null}
        />
      ))}
    </div>
  );
}

function FavoriteStar({ on, onToggle }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      className={`fav-star ${on ? 'on' : ''}`}
      onClick={onToggle}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
    >
      {on ? '★' : '☆'}
    </span>
  );
}


// Same memo strategy as ProjectsView: only re-render when DATA props
// change. Function handlers are inline lambdas from App that flip refs
// every render; ignoring them in the comparator lets the Plugins tab
// stay snappy when switching tabs (no 200-card re-render).
function libraryPropsEqual(prev, next) {
  return (
    prev.items === next.items &&
    prev.updates === next.updates &&
    prev.selectedId === next.selectedId &&
    prev.selectedIds === next.selectedIds &&
    prev.view === next.view &&
    prev.sortBy === next.sortBy &&
    prev.sortDir === next.sortDir &&
    prev.columnWidths === next.columnWidths &&
    prev.projectUsageById === next.projectUsageById
  );
}
export default React.memo(LibraryView, libraryPropsEqual);

export { FavoriteStar, COLUMNS as LIST_COLUMNS };
