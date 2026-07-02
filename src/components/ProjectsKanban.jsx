import React, { useState, useReducer, useEffect, useRef } from 'react';
import dawAbletonLogo  from '../assets/daw-ableton.png';
import dawLogicLogo    from '../assets/daw-logic.png';
import dawFlStudioLogo from '../assets/daw-flstudio.png';

// ─── DAW logo (mirrors real-app-icon upgrade mechanism in ProjectsView.jsx) ──
const DAW_LOGOS = { ableton: dawAbletonLogo, logic: dawLogicLogo, flstudio: dawFlStudioLogo };
function dawLabel(t) {
  if (t === 'ableton') return 'Ableton Live';
  if (t === 'logic') return 'Logic Pro';
  if (t === 'flstudio') return 'FL Studio';
  return t || 'Unknown';
}
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
    return () => __kanbanIconSubs.delete(force);
  }, []);
  const src = __kanbanIconUrls[dawType] || DAW_LOGOS[dawType];
  if (!src) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, fontSize: Math.round(size * 0.65), opacity: 0.45, flex: '0 0 auto', lineHeight: 1 }}
        aria-hidden="true">♪</span>
    );
  }
  return (
    <img src={src} alt={dawLabel(dawType)} title={dawLabel(dawType)} draggable={false}
      style={{ width: size, height: size, objectFit: 'contain', flex: '0 0 auto', display: 'inline-block' }} />
  );
}

const RATING_COLORS = { A: '#60d394', B: '#6ec1ff', C: '#ffa552', D: '#c084fc', F: '#f87171' };
const RATINGS = ['A', 'B', 'C', 'D', 'F'];

function formatDateShort(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch { return null; }
}
function formatDateLong(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return null; }
}

// ─── Kanban card ─────────────────────────────────────────────────────────────
function KanbanCard({ project, rating, tags, isDragging, isSelected, onClick }) {
  const [hovered, setHovered] = useState(false);
  const pluginCount = (project.plugins || []).length;
  const shownTags   = (tags || []).slice(0, 3);
  const tagOverflow = (tags || []).length - shownTags.length;
  const dateStr     = formatDateShort(project.lastModified);

  return (
    <div
      style={{
        background: isSelected
          ? 'color-mix(in srgb, var(--accent, #6ec1ff) 10%, var(--panel-bg, rgba(255,255,255,0.04)))'
          : 'var(--panel-bg, rgba(255,255,255,0.04))',
        border: isSelected
          ? '1px solid var(--accent, #6ec1ff)'
          : isDragging
            ? '1px solid color-mix(in srgb, var(--accent, #6ec1ff) 60%, transparent)'
            : '1px solid var(--border-color, rgba(127,127,127,0.15))',
        borderRadius: 7,
        padding: '10px 11px 9px',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        opacity: isDragging ? 0.45 : 1,
        transition: 'border-color 120ms, opacity 120ms, box-shadow 120ms, background 120ms',
        position: 'relative',
        boxShadow: (hovered || isSelected) && !isDragging
          ? '0 2px 8px rgba(0,0,0,0.22)'
          : '0 1px 3px rgba(0,0,0,0.12)',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {rating && (
        <span style={{ position: 'absolute', top: 8, right: 9,
          fontSize: 10, fontWeight: 700, lineHeight: 1,
          color: RATING_COLORS[rating] || 'inherit' }}>{rating}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: rating ? 18 : 0 }}>
        <DawLogoMini dawType={project.dawType} size={13} />
        <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
          title={project.name}>{project.name}</span>
      </div>
      {(pluginCount > 0 || project.tempo != null || project.key || dateStr) && (
        <div style={{ fontSize: 10, opacity: 0.48, marginTop: 5,
          display: 'flex', gap: 5, flexWrap: 'wrap', lineHeight: 1.4 }}>
          {pluginCount > 0 && <span>{pluginCount} plugin{pluginCount === 1 ? '' : 's'}</span>}
          {typeof project.tempo === 'number' && <span>{Math.round(project.tempo)} BPM</span>}
          {project.key && <span>{project.key}</span>}
          {dateStr && <span>{dateStr}</span>}
        </div>
      )}
      {shownTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 6 }}>
          {shownTags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 500,
              background: 'var(--accent-soft, rgba(110,193,255,0.15))',
              color: 'var(--accent, #6ec1ff)',
              maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{t}</span>
          ))}
          {tagOverflow > 0 && (
            <span style={{ fontSize: 10, opacity: 0.4, fontWeight: 500 }}>+{tagOverflow}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Column ───────────────────────────────────────────────────────────────────
function KanbanColumn({
  status, projects, projectRatings, projectTags,
  dragProjectId, isDragOver, selectedProjectId,
  onCardDragStart, onDragEnter, onDragLeave, onDrop, onCardClick,
}) {
  const label = status ? status.label : 'No Status';
  const color = status ? status.color : 'rgba(127,127,127,0.35)';

  return (
    <div
      style={{
        flex: '0 0 220px', display: 'flex', flexDirection: 'column', maxHeight: '100%',
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
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onDragLeave(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
    >
      <div style={{ padding: '10px 13px 8px', display: 'flex', alignItems: 'center', gap: 7,
        flexShrink: 0, borderBottom: '1px solid var(--border-color, rgba(127,127,127,0.08))' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color,
          flex: '0 0 auto', boxShadow: `0 0 5px ${color}80` }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', opacity: 0.82, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 600, background: 'rgba(127,127,127,0.18)',
          borderRadius: 10, padding: '1px 7px', opacity: 0.65, flexShrink: 0 }}>{projects.length}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 9px 12px',
        display: 'flex', flexDirection: 'column', gap: 7 }}>
        {projects.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.3, textAlign: 'center',
            padding: '24px 0', fontStyle: 'italic' }}>
            {isDragOver ? 'Drop here' : 'No projects'}
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                // Store via both dataTransfer (robust across closure reflows)
                // and state (for the "dimmed card" visual while dragging).
                e.dataTransfer.setData('text/plain', p.id);
                onCardDragStart(p.id);
              }}
              onClick={(e) => { e.stopPropagation(); onCardClick(p.id); }}
            >
              <KanbanCard
                project={p}
                rating={(projectRatings && projectRatings[p.id]) || null}
                tags={(projectTags && projectTags[p.id]) || []}
                isDragging={dragProjectId === p.id}
                isSelected={selectedProjectId === p.id}
              />
            </div>
          ))
        )}
        {projects.length > 0 && isDragOver && (
          <div style={{ height: 36, borderRadius: 6, marginTop: 2,
            border: '2px dashed color-mix(in srgb, var(--accent, #6ec1ff) 40%, transparent)',
            opacity: 0.5 }} />
        )}
      </div>
    </div>
  );
}

// ─── Detail side panel ───────────────────────────────────────────────────────
function KanbanDetailPanel({
  project, tags, notes, rating, status,
  statuses, knownTags,
  onSetTags, onSetNotes, onSetRating, onSetStatus,
  onOpenInDAW, onRevealInFinder,
  onClose,
}) {
  const [notesDraft, setNotesDraft] = useState(notes || '');
  const [tagInput, setTagInput] = useState('');
  const notesTimer = useRef(null);

  // Keep notesDraft in sync when the selected project changes
  useEffect(() => { setNotesDraft(notes || ''); }, [project.id, notes]);

  function persistNotes(text) {
    setNotesDraft(text);
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => {
      onSetNotes && onSetNotes(project.id, text);
    }, 600);
  }

  function addTag(raw) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!t || (tags || []).includes(t)) return;
    onSetTags && onSetTags(project.id, [...(tags || []), t]);
    setTagInput('');
  }

  function removeTag(t) {
    onSetTags && onSetTags(project.id, (tags || []).filter((x) => x !== t));
  }

  const pluginCount = (project.plugins || []).length;

  return (
    <div style={{
      flex: '0 0 290px', display: 'flex', flexDirection: 'column',
      overflowY: 'auto', overflowX: 'hidden',
      borderLeft: '1px solid var(--border-color, rgba(127,127,127,0.12))',
      background: 'var(--panel-bg, rgba(255,255,255,0.02))',
      padding: '14px 16px 20px',
      gap: 14,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
        <DawLogoMini dawType={project.dawType} size={18} />
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, lineHeight: 1.35,
          wordBreak: 'break-word' }}>{project.name}</span>
        <button type="button" onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            opacity: 0.45, fontSize: 16, lineHeight: 1, padding: '0 2px',
            color: 'inherit', flexShrink: 0 }}
          title="Close panel">×</button>
      </div>

      {/* Meta strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, opacity: 0.55, flexShrink: 0 }}>
        {pluginCount > 0 && <span>{pluginCount} plugin{pluginCount === 1 ? '' : 's'}</span>}
        {typeof project.tempo === 'number' && <span>{Math.round(project.tempo)} BPM</span>}
        {project.key && <span>{project.key}</span>}
        {project.lastModified && <span>{formatDateLong(project.lastModified)}</span>}
      </div>

      {/* Actions */}
      {project.path && (
        <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
          {onOpenInDAW && (
            <button type="button" className="btn btn-small"
              style={{ flex: 1, fontSize: 11 }}
              onClick={() => onOpenInDAW(project.path)}>Open in {dawLabel(project.dawType)}</button>
          )}
          {onRevealInFinder && (
            <button type="button" className="btn btn-small btn-ghost"
              style={{ flex: 1, fontSize: 11 }}
              onClick={() => onRevealInFinder(project.path)}>Reveal</button>
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border-color, rgba(127,127,127,0.10))', flexShrink: 0 }} />

      {/* Status */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', opacity: 0.55, marginBottom: 7 }}>Status</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <button type="button"
            onClick={() => onSetStatus && onSetStatus(project.id, null)}
            style={{
              fontSize: 10.5, padding: '3px 9px', borderRadius: 12, cursor: 'pointer',
              fontWeight: 600, border: '1px solid',
              background: !status ? 'rgba(127,127,127,0.25)' : 'transparent',
              borderColor: !status ? 'rgba(127,127,127,0.5)' : 'rgba(127,127,127,0.2)',
              color: 'inherit', opacity: !status ? 1 : 0.5,
            }}>No Status</button>
          {statuses.map((s) => (
            <button key={s.id} type="button"
              onClick={() => onSetStatus && onSetStatus(project.id, s.id)}
              style={{
                fontSize: 10.5, padding: '3px 9px', borderRadius: 12, cursor: 'pointer',
                fontWeight: 600, border: '1px solid',
                background: status === s.id ? `${s.color}28` : 'transparent',
                borderColor: status === s.id ? s.color : 'rgba(127,127,127,0.2)',
                color: status === s.id ? s.color : 'inherit',
                opacity: status === s.id ? 1 : 0.55,
              }}>{s.label}</button>
          ))}
        </div>
      </div>

      {/* Rating */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', opacity: 0.55, marginBottom: 7 }}>Rating</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {RATINGS.map((r) => (
            <button key={r} type="button"
              onClick={() => onSetRating && onSetRating(project.id, rating === r ? null : r)}
              style={{
                width: 32, height: 28, borderRadius: 5, cursor: 'pointer',
                fontSize: 12, fontWeight: 700, border: '1px solid',
                background: rating === r ? `${RATING_COLORS[r]}28` : 'transparent',
                borderColor: rating === r ? RATING_COLORS[r] : 'rgba(127,127,127,0.2)',
                color: rating === r ? RATING_COLORS[r] : 'inherit',
                opacity: rating === r ? 1 : 0.45,
              }}>{r}</button>
          ))}
        </div>
      </div>

      {/* Tags */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', opacity: 0.55, marginBottom: 7 }}>Tags</div>
        {(tags || []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {(tags || []).map((t) => (
              <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 10.5, padding: '2px 7px', borderRadius: 4, fontWeight: 500,
                background: 'var(--accent-soft, rgba(110,193,255,0.15))',
                color: 'var(--accent, #6ec1ff)' }}>
                #{t}
                <button type="button" onClick={() => removeTag(t)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: 'inherit', opacity: 0.55, fontSize: 11, lineHeight: 1,
                    padding: 0, marginLeft: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 5 }}>
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
            }}
            placeholder="Add tag…"
            list="kanban-tag-suggestions"
            style={{ flex: 1, fontSize: 11.5, padding: '4px 8px', borderRadius: 4,
              border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
              background: 'var(--input-bg, rgba(255,255,255,0.04))', color: 'inherit' }}
          />
          <button type="button" className="btn btn-small btn-ghost"
            style={{ fontSize: 11, padding: '4px 9px' }}
            onClick={() => addTag(tagInput)}>+</button>
        </div>
        {knownTags && knownTags.length > 0 && (
          <datalist id="kanban-tag-suggestions">
            {knownTags.map((t) => <option key={t} value={t} />)}
          </datalist>
        )}
      </div>

      {/* Notes */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', opacity: 0.55, marginBottom: 7 }}>Notes</div>
        <textarea
          value={notesDraft}
          onChange={(e) => persistNotes(e.target.value)}
          placeholder="Add notes…"
          rows={4}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '7px 9px',
            borderRadius: 5, border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
            background: 'var(--input-bg, rgba(255,255,255,0.04))', color: 'inherit',
            resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
        />
      </div>

      {/* Plugin list */}
      {pluginCount > 0 && (
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.5px', opacity: 0.55, marginBottom: 7 }}>
            Plugins ({pluginCount})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {(project.plugins || []).slice(0, 30).map((ref, i) => (
              <div key={i} style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.35,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={ref.name || ref.identifier || ''}>
                {ref.name || ref.identifier || '(unknown)'}
              </div>
            ))}
            {pluginCount > 30 && (
              <div style={{ fontSize: 10, opacity: 0.4 }}>+{pluginCount - 30} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────
export default function ProjectsKanban({
  projects, statuses, projectStatuses,
  projectTags, projectRatings, projectNotes, knownTags,
  onSetStatus, onSetTags, onSetNotes, onSetRating,
  onOpenInDAW, onRevealInFinder,
}) {
  // '__none__' = no column hovered; null = "No Status" column hovered.
  const [dragProjectId,    setDragProjectId]    = useState(null);
  const [dragOverColumnId, setDragOverColumnId] = useState('__none__');
  const [selectedProjectId, setSelectedProjectId] = useState(null);

  const columns = [
    { id: null, label: 'No Status', color: 'rgba(127,127,127,0.4)' },
    ...statuses,
  ];

  function getColumnProjects(colId) {
    return projects.filter((p) => ((projectStatuses && projectStatuses[p.id]) || null) === colId);
  }

  function handleDrop(e, targetColId) {
    // Read the project id from dataTransfer — avoids React stale-closure
    // issues where dragProjectId state hasn't updated by drop time.
    const projectId = e.dataTransfer.getData('text/plain');
    if (!projectId) return;
    onSetStatus && onSetStatus(projectId, targetColId);
    setDragProjectId(null);
    setDragOverColumnId('__none__');
  }

  function handleCardClick(projectId) {
    setSelectedProjectId((prev) => prev === projectId ? null : projectId);
  }

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId)
    : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Scrollable columns area */}
      <div
        style={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden',
          display: 'flex', flexDirection: 'row', alignItems: 'stretch',
          padding: '12px 16px 20px', gap: 10 }}
        onClick={(e) => {
          // Clicking the empty board area (not a card) deselects.
          if (e.target === e.currentTarget) setSelectedProjectId(null);
        }}
        onDragEnd={() => { setDragProjectId(null); setDragOverColumnId('__none__'); }}
      >
        {columns.map((col) => (
          <KanbanColumn
            key={col.id === null ? '__nostatus__' : col.id}
            status={col.id === null ? null : col}
            projects={getColumnProjects(col.id)}
            projectRatings={projectRatings}
            projectTags={projectTags}
            dragProjectId={dragProjectId}
            isDragOver={dragProjectId !== null && dragOverColumnId === col.id}
            selectedProjectId={selectedProjectId}
            onCardDragStart={setDragProjectId}
            onDragEnter={() => setDragOverColumnId(col.id)}
            onDragLeave={() => setDragOverColumnId((prev) => prev === col.id ? '__none__' : prev)}
            onDrop={(e) => handleDrop(e, col.id)}
            onCardClick={handleCardClick}
          />
        ))}
      </div>

      {/* Detail panel — slides in when a card is selected */}
      {selectedProject && (
        <KanbanDetailPanel
          project={selectedProject}
          tags={(projectTags && projectTags[selectedProject.id]) || []}
          notes={(projectNotes && projectNotes[selectedProject.id]) || ''}
          rating={(projectRatings && projectRatings[selectedProject.id]) || null}
          status={(projectStatuses && projectStatuses[selectedProject.id]) || null}
          statuses={statuses}
          knownTags={knownTags}
          onSetTags={onSetTags}
          onSetNotes={onSetNotes}
          onSetRating={onSetRating}
          onSetStatus={onSetStatus}
          onOpenInDAW={onOpenInDAW}
          onRevealInFinder={onRevealInFinder}
          onClose={() => setSelectedProjectId(null)}
        />
      )}
    </div>
  );
}
