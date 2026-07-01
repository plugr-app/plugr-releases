import React, { useState, useReducer, useEffect } from 'react';
import dawAbletonLogo  from '../assets/daw-ableton.png';
import dawLogicLogo    from '../assets/daw-logic.png';
import dawFlStudioLogo from '../assets/daw-flstudio.png';

// ─── DAW logo (same real-app-icon upgrade mechanism as ProjectsView.jsx) ─────
const DAW_LOGOS = {
  ableton:  dawAbletonLogo,
  logic:    dawLogicLogo,
  flstudio: dawFlStudioLogo,
};
function dawLabel(t) {
  if (t === 'ableton') return 'Ableton Live';
  if (t === 'logic') return 'Logic Pro';
  if (t === 'flstudio') return 'FL Studio';
  return t || 'Unknown';
}
// Module-level icon cache — shared with any other DawLogo instances.
const __kanbanIconUrls = { ableton: null, logic: null, flstudio: null };
let __kanbanIconFetchStarted = false;
const __kanbanIconSubs = new Set();
function fetchKanbanIconsOnce() {
  if (__kanbanIconFetchStarted) return;
  __kanbanIconFetchStarted = true;
  (async () => {
    try {
      const api = typeof window !== 'undefined' && window.pluginHub;
      if (!api || !api.getDawIcons) return;
      const res = await api.getDawIcons();
      if (res && res.ok && res.icons) {
        for (const k of Object.keys(res.icons)) {
          if (res.icons[k]) __kanbanIconUrls[k] = res.icons[k];
        }
        for (const fn of __kanbanIconSubs) fn();
      }
    } catch { /* fall back to bundled PNGs */ }
  })();
}

function DawLogoMini({ dawType, size = 14 }) {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    fetchKanbanIconsOnce();
    __kanbanIconSubs.add(force);
    return () => { __kanbanIconSubs.delete(force); };
  }, []);
  const realIcon = __kanbanIconUrls[dawType];
  const src = realIcon || DAW_LOGOS[dawType];
  if (!src) {
    return (
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, fontSize: Math.round(size * 0.65),
          opacity: 0.45, flex: '0 0 auto', lineHeight: 1,
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
      draggable={false}
      style={{
        width: size, height: size, objectFit: 'contain',
        flex: '0 0 auto', display: 'inline-block',
      }}
    />
  );
}

// ─── Rating colours (matches library-view conventions) ───────────────────────
const RATING_COLORS = {
  A: '#60d394',
  B: '#6ec1ff',
  C: '#ffa552',
  D: '#c084fc',
  F: '#f87171',
};

function formatDateShort(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return null; }
}

// ─── Single project card ──────────────────────────────────────────────────────
function KanbanCard({ project, rating, tags, onOpenInDAW, onRevealInFinder, isDragging }) {
  const [hovered, setHovered] = useState(false);
  const pluginCount = (project.plugins || []).length;
  const shownTags   = (tags || []).slice(0, 3);
  const tagOverflow = (tags || []).length - shownTags.length;
  const dateStr     = formatDateShort(project.lastModified);

  return (
    <div
      style={{
        background: 'var(--panel-bg, rgba(255,255,255,0.04))',
        border: isDragging
          ? '1px solid var(--accent, #6ec1ff)'
          : '1px solid var(--border-color, rgba(127,127,127,0.15))',
        borderRadius: 7,
        padding: '10px 11px 9px',
        cursor: 'grab',
        userSelect: 'none',
        opacity: isDragging ? 0.45 : 1,
        transition: 'border-color 120ms, opacity 120ms, box-shadow 120ms',
        position: 'relative',
        boxShadow: hovered && !isDragging
          ? '0 2px 8px rgba(0,0,0,0.22)'
          : '0 1px 3px rgba(0,0,0,0.12)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Rating badge — top-right corner */}
      {rating && (
        <span style={{
          position: 'absolute', top: 8, right: 9,
          fontSize: 10, fontWeight: 700, lineHeight: 1,
          color: RATING_COLORS[rating] || 'inherit',
        }}>{rating}</span>
      )}

      {/* Project name + DAW logo */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        paddingRight: rating ? 18 : 0,
      }}>
        <DawLogoMini dawType={project.dawType} size={13} />
        <span
          style={{
            fontSize: 12.5, fontWeight: 600, lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1,
          }}
          title={project.name}
        >{project.name}</span>
      </div>

      {/* Meta row — plugin count · tempo · key · date */}
      {(pluginCount > 0 || project.tempo != null || project.key || dateStr) && (
        <div style={{
          fontSize: 10, opacity: 0.48, marginTop: 5,
          display: 'flex', gap: 5, flexWrap: 'wrap', lineHeight: 1.4,
        }}>
          {pluginCount > 0 && (
            <span>{pluginCount} plugin{pluginCount === 1 ? '' : 's'}</span>
          )}
          {typeof project.tempo === 'number' && (
            <span>{Math.round(project.tempo)} BPM</span>
          )}
          {project.key && <span>{project.key}</span>}
          {dateStr && <span>{dateStr}</span>}
        </div>
      )}

      {/* Tag chips */}
      {shownTags.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 6,
        }}>
          {shownTags.map((t) => (
            <span key={t} style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 500,
              background: 'var(--accent-soft, rgba(110,193,255,0.15))',
              color: 'var(--accent, #6ec1ff)',
              maxWidth: 80, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>#{t}</span>
          ))}
          {tagOverflow > 0 && (
            <span style={{ fontSize: 10, opacity: 0.4, fontWeight: 500 }}>+{tagOverflow}</span>
          )}
        </div>
      )}

      {/* Hover action strip — Open in DAW / Reveal in Finder */}
      {hovered && (onOpenInDAW || onRevealInFinder) && project.path && (
        <div style={{
          display: 'flex', gap: 5, marginTop: 8, paddingTop: 7,
          borderTop: '1px solid var(--border-color, rgba(127,127,127,0.10))',
        }}>
          {onOpenInDAW && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              style={{ fontSize: 10, padding: '2px 7px', flex: 1 }}
              onClick={(e) => { e.stopPropagation(); onOpenInDAW(project.path); }}
            >Open</button>
          )}
          {onRevealInFinder && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              style={{ fontSize: 10, padding: '2px 7px', flex: 1 }}
              onClick={(e) => { e.stopPropagation(); onRevealInFinder(project.path); }}
            >Reveal</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── One kanban column ────────────────────────────────────────────────────────
// `statusId` is the raw id (null = "No Status"). `status` is the full
// {id, label, color} object — null for the "No Status" column.
function KanbanColumn({
  status, projects,
  projectRatings, projectTags,
  onSetStatus, onOpenInDAW, onRevealInFinder,
  dragProjectId, isDragOver,
  onDragEnter, onDragLeave, onDrop,
  onCardDragStart,
}) {
  const label = status ? status.label : 'No Status';
  const color = status ? status.color : 'rgba(127,127,127,0.35)';

  return (
    <div
      style={{
        flex: '0 0 220px',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '100%',
        borderRadius: 10,
        background: isDragOver
          ? 'color-mix(in srgb, var(--accent, #6ec1ff) 7%, transparent)'
          : 'color-mix(in srgb, var(--bg-0, #1a1a1a) 40%, transparent)',
        border: isDragOver
          ? '2px dashed color-mix(in srgb, var(--accent, #6ec1ff) 60%, transparent)'
          : '2px solid var(--border-color, rgba(127,127,127,0.10))',
        transition: 'background 130ms, border-color 130ms',
      }}
      onDragOver={(e) => { e.preventDefault(); onDragEnter(); }}
      onDragEnter={(e) => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={(e) => {
        // Only clear the highlight when leaving the column entirely —
        // not when hovering into a child card.
        if (!e.currentTarget.contains(e.relatedTarget)) onDragLeave();
      }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
    >
      {/* Column header */}
      <div style={{
        padding: '10px 13px 8px',
        display: 'flex', alignItems: 'center', gap: 7,
        flexShrink: 0,
        borderBottom: '1px solid var(--border-color, rgba(127,127,127,0.08))',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: color, flex: '0 0 auto',
          boxShadow: `0 0 5px ${color}80`,
        }} />
        <span style={{
          fontSize: 10.5, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.5px',
          opacity: 0.82, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
        <span style={{
          fontSize: 10, fontWeight: 600,
          background: 'rgba(127,127,127,0.18)', borderRadius: 10,
          padding: '1px 7px', opacity: 0.65, flexShrink: 0,
        }}>{projects.length}</span>
      </div>

      {/* Card list */}
      <div style={{
        flex: 1, overflowY: 'auto',
        padding: '8px 9px 12px',
        display: 'flex', flexDirection: 'column', gap: 7,
      }}>
        {projects.length === 0 ? (
          <div style={{
            fontSize: 11, opacity: 0.3, textAlign: 'center',
            padding: '24px 0', fontStyle: 'italic',
          }}>
            {isDragOver ? 'Drop here' : 'No projects'}
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', p.id);
                onCardDragStart(p.id);
              }}
            >
              <KanbanCard
                project={p}
                rating={(projectRatings && projectRatings[p.id]) || null}
                tags={(projectTags && projectTags[p.id]) || []}
                onOpenInDAW={onOpenInDAW}
                onRevealInFinder={onRevealInFinder}
                isDragging={dragProjectId === p.id}
              />
            </div>
          ))
        )}
        {/* Drop target pad at the bottom of a non-empty column */}
        {projects.length > 0 && isDragOver && (
          <div style={{
            height: 36, borderRadius: 6, marginTop: 2,
            border: '2px dashed color-mix(in srgb, var(--accent, #6ec1ff) 40%, transparent)',
            opacity: 0.5,
          }} />
        )}
      </div>
    </div>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────
// Receives the same `visibleProjects` the list view uses (already filtered
// by search, tags, ratings, etc.) so the user's filter state is shared.
export default function ProjectsKanban({
  projects,
  statuses,
  projectStatuses,
  projectTags,
  projectRatings,
  onSetStatus,
  onOpenInDAW,
  onRevealInFinder,
}) {
  // '__none__' is a sentinel meaning "not hovering over any column" —
  // distinct from null which means the "No Status" column (id=null).
  const [dragProjectId,    setDragProjectId]    = useState(null);
  const [dragOverColumnId, setDragOverColumnId] = useState('__none__');

  // Columns: "No Status" bucket first, then the user's ordered statuses.
  const columns = [
    { id: null, label: 'No Status', color: 'rgba(127,127,127,0.4)' },
    ...statuses,
  ];

  function getColumnProjects(colId) {
    return projects.filter((p) => {
      const sid = (projectStatuses && projectStatuses[p.id]) || null;
      return sid === colId;
    });
  }

  function handleDrop(targetColId) {
    if (dragProjectId == null) return;
    // Dropping on "No Status" column (targetColId = null) clears the status.
    onSetStatus && onSetStatus(dragProjectId, targetColId);
    setDragProjectId(null);
    setDragOverColumnId('__none__');
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'row',
        overflowX: 'auto',
        overflowY: 'hidden',
        alignItems: 'stretch',
        padding: '12px 20px 20px',
        gap: 10,
      }}
      // dragend fires on the source element when the drag finishes
      // (whether dropped or cancelled). Always clean up.
      onDragEnd={() => {
        setDragProjectId(null);
        setDragOverColumnId('__none__');
      }}
    >
      {columns.map((col) => (
        <KanbanColumn
          key={col.id === null ? '__nostatus__' : col.id}
          status={col.id === null ? null : col}
          projects={getColumnProjects(col.id)}
          projectRatings={projectRatings}
          projectTags={projectTags}
          onSetStatus={onSetStatus}
          onOpenInDAW={onOpenInDAW}
          onRevealInFinder={onRevealInFinder}
          dragProjectId={dragProjectId}
          isDragOver={dragProjectId !== null && dragOverColumnId === col.id}
          onCardDragStart={setDragProjectId}
          onDragEnter={() => setDragOverColumnId(col.id)}
          onDragLeave={() => setDragOverColumnId((prev) => prev === col.id ? '__none__' : prev)}
          onDrop={() => handleDrop(col.id)}
        />
      ))}
    </div>
  );
}
