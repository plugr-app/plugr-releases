import React from 'react';
import UpdateBadge from './UpdateBadge.jsx';
import FormatTag from './FormatTag.jsx';
import { formatBytes, displaySubcategory } from '../util/format.js';

function dupTitle(d) {
  if (!d || !d.status) return '';
  if (d.status === 'duplicate') return `Duplicate copy — ${d.reason}`;
  if (d.status === 'superseded') return `Older version — ${d.reason}`;
  return '';
}

/**
 * Card layout (top to bottom):
 *   1. Header strip (32px) — a thin gradient strip in the category color,
 *      with the format text big and centered. Always fully visible.
 *   2. Body — plugin name (1 line, ellipsis), developer · subcategory.
 *   3. Footer — version · size, update badge, favorite star.
 *
 * No more 2-letter "art initials"; the strip is enough to convey category at
 * a glance, and the format pill is impossible to crop because it's centered
 * inside its own row instead of absolutely positioned in a corner.
 */
export default function PluginCard({ item, update, selected, onClick, onContextMenu, onToggleFavorite, onDragStart, projectUsage }) {
  const dup = item.duplicate;
  const cat = (item.category || 'other').toLowerCase();
  // Suppress the OLD badge when the user has acknowledged format lag for this version.
  const formatLagAcknowledged = !!(update && update.latestVersion &&
    item.formatLagAcknowledgedAt === update.latestVersion);
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      className={`card ${selected ? 'selected' : ''} ${dup && dup.status && !formatLagAcknowledged ? `dup-${dup.status}` : ''}`}
      title={`${item.name} — ${item.developer}${dupTitle(dup) && !formatLagAcknowledged ? '\n' + dupTitle(dup) : ''}`}
    >
      <div className={`card-strip cat-${cat}`}>
        <FormatTag item={item} />
        <span className="card-strip-cat">{displaySubcategory(item) || item.category}</span>
        {dup && dup.status && !formatLagAcknowledged && (
          <span className={`dup-pill dup-${dup.status} on-strip`} title={dupTitle(dup)}>
            {dup.status === 'duplicate' ? 'duplicate' : 'old'}
          </span>
        )}
      </div>
      {/* Favorite toggle — absolutely positioned in the top-right of
       *  the card body so it's in the same spot on every card,
       *  regardless of how the plugin name wraps. (Previously it was
       *  glued to the title element, which made it sit at variable
       *  distances from the card edge depending on title length.) */}
      <span
        role="button"
        tabIndex={-1}
        className={`fav-star card-fav ${item.favorite ? 'on' : ''}`}
        onClick={onToggleFavorite}
        title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        {item.favorite ? '★' : '☆'}
      </span>
      <div className="card-body">
        <div className="card-title-row">
          <div className="card-title" title={item.name}>{item.name}</div>
        </div>
        <div className="card-meta">
          <span className="developer" title={item.developer}>{item.developer}</span>
        </div>
        {Array.isArray(item.tags) && item.tags.length > 0 && (
          <CardTagStrip tags={item.tags} />
        )}
        <div className="card-footer">
          <span className="version">
            {item.version ? `v${item.version}` : 'no version'}
            {item.sizeBytes ? <span className="size-tag"> · {formatBytes(item.sizeBytes)}</span> : null}
          </span>
          <UpdateBadge item={item} update={update} />
        </div>
        {projectUsage && projectUsage.projectCount > 0 && (
          <div
            className="card-project-usage"
            title={`Used in ${projectUsage.projectCount} project${projectUsage.projectCount === 1 ? '' : 's'}: ` +
              projectUsage.projects.slice(0, 8).map((p) => p.name).join(', ') +
              (projectUsage.projects.length > 8 ? `, +${projectUsage.projects.length - 8} more` : '')}
            style={{
              fontSize: '10px',
              padding: '2px 0',
              marginTop: '4px',
              borderRadius: '4px',
              background: 'transparent',
              padding: '2px 0',
              color: 'var(--accent, #6ec1ff)',
              alignSelf: 'flex-start',
              fontWeight: 500,
            }}
          >
            🎵 Used in {projectUsage.projectCount} project{projectUsage.projectCount === 1 ? '' : 's'}
          </div>
        )}
        {item.osCompat && item.osCompat.status === 'incompatible' && (
          <div className="card-os-warning" title={item.osCompat.message}>! macOS too old for this build</div>
        )}
      </div>
    </button>
  );
}

// Compact tag chip strip for the grid card. Caps visible chips at
// MAX so a 12-tag plugin doesn't blow the card to twice the normal
// height; remaining tags show as "+N more" with the full list in
// the tooltip so they're still discoverable.
function CardTagStrip({ tags }) {
  const MAX = 3;
  const shown = tags.slice(0, MAX);
  const overflow = tags.length - shown.length;
  return (
    <div
      title={tags.map((t) => `#${t}`).join(', ')}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '3px',
        marginTop: '4px',
      }}
    >
      {shown.map((t) => (
        <span
          key={t}
          style={{
            fontSize: '10px',
            padding: '1px 5px',
            borderRadius: '3px',
            background: 'var(--accent-soft, rgba(110,193,255,0.15))',
            color: 'var(--accent, #6ec1ff)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            maxWidth: '110px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >#{t}</span>
      ))}
      {overflow > 0 && (
        <span style={{
          fontSize: '10px',
          padding: '1px 4px',
          opacity: 0.55,
          fontWeight: 500,
        }}>+{overflow}</span>
      )}
    </div>
  );
}
