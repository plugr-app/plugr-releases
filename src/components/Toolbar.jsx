import React, { useState, useRef, useEffect } from 'react';
import { formatBytes, formatRelativeTime } from '../util/format.js';

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'developer', label: 'Developer' },
  { value: 'category', label: 'Category' },
  { value: 'recent', label: 'Version' },
  { value: 'size', label: 'Size' },
];

export default function Toolbar({
  scanning, checking, onScan, onCheckUpdates,
  search, onSearchChange, searchRef,
  sortBy, onSortChange,
  view, onViewChange,
  outdatedCount, totalCount,
  scannedAt, updatesCheckedAt, totalBytes,
  progress,
  onBrandClick,
}) {
  // Theme / help / volume controls live on the TabBar now (see App.jsx
  // — they're always-on globals, not Library-specific actions). The
  // Toolbar is just the Library-tab control surface: scan, check,
  // search, sort, view-mode toggle.
  const subBits = [];
  if (totalCount > 0) subBits.push(`${totalCount} items`);
  if (totalBytes) subBits.push(formatBytes(totalBytes));
  if (outdatedCount > 0) subBits.push(`${outdatedCount} updates`);
  if (scannedAt) subBits.push(`scanned ${formatRelativeTime(scannedAt)}`);
  // NOTE: the progress strip used to render here, but that meant it
  // only showed when the Library tab was mounted — invisible during
  // project/deal scans from any other tab. It now lives in App.jsx at
  // the app-shell level so it's always visible regardless of tab.
  return (
    <>
    <header className="toolbar">
      {/* Brand block moved to TabBar (always-visible across tabs).
       *  Library-stats summary kept here, but in a slimmer form so the
       *  empty space doesn't read as a missing header. */}
      <div className="toolbar-meta" title={updatesCheckedAt ? `Updates checked ${formatRelativeTime(updatesCheckedAt)}` : ''}>
        {subBits.length > 0 ? subBits.join(' · ') : 'Library empty'}
      </div>

      <div className="toolbar-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search plugins, developers, categories…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <div className="toolbar-actions">
        <div className="select-wrap">
          <label>Sort</label>
          <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        <div className="view-toggle" role="tablist" aria-label="View mode">
          <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => onViewChange('grid')} title="Grid view" aria-pressed={view === 'grid'}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
          </button>
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => onViewChange('list')} title="List view" aria-pressed={view === 'list'}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>

        <button className="btn" onClick={onScan} disabled={scanning} title="Scan plugin and application folders">
          {scanning ? 'Scanning…' : 'Scan Library'}
        </button>

        <button className="btn primary" onClick={onCheckUpdates} disabled={checking || totalCount === 0} title="Check for updates against the developer registry">
          {checking ? 'Checking…' : 'Check for Plugin Updates'}
        </button>

        {/* Volume / theme / help live on the TabBar now (it's always
            rendered, so the buttons stay reachable from any tab).
            Keeping the Toolbar focused on Library-specific actions
            avoids two competing icon clusters. */}
      </div>
    </header>
    </>
  );
}

// Global volume control for bounce playback. Speaker icon that opens
// a thin horizontal slider on click; click again (or click anywhere
// outside) to dismiss. The speaker glyph reflects three states —
// muted (0), low (0..0.5), high (>0.5) — so the current setting is
// readable at a glance without expanding. Clicking the speaker icon
// while expanded toggles mute (and remembers the previous level so
// "unmute" restores it).
export function VolumeControl({ value, onChange }) {
  const v = typeof value === 'number' ? value : 0.8;
  const [open, setOpen] = useState(false);
  const [lastNonZero, setLastNonZero] = useState(v > 0 ? v : 0.8);
  const ref = useRef(null);

  // Track the most recent non-zero level so the speaker-icon-as-mute-
  // toggle has something to restore to.
  useEffect(() => { if (v > 0) setLastNonZero(v); }, [v]);

  // Click-outside closes the popover. We listen on mousedown so a
  // single down-and-up inside still counts as one interaction
  // (avoids the popover flickering closed mid-drag).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  function toggleMute() {
    if (v > 0) onChange && onChange(0);
    else onChange && onChange(lastNonZero || 0.8);
  }

  const muted = v === 0;
  const lowOnly = v > 0 && v <= 0.5;
  const pct = Math.round(v * 100);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn icon-btn"
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => { e.preventDefault(); toggleMute(); }}
        title={muted ? 'Muted — click to open volume' : `Volume: ${pct}% (right-click to mute)`}
        aria-label="Volume"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {/* Speaker icon with 0, 1, or 2 "wave" arcs depending on level */}
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 7 V13 H6 L11 17 V3 L6 7 Z" fill="currentColor" stroke="currentColor" />
          {!muted && (lowOnly || !muted) && (
            <path d="M13.5 8 Q15 10 13.5 12" />
          )}
          {!muted && !lowOnly && (
            <path d="M15.5 6 Q18 10 15.5 14" />
          )}
          {muted && (
            <line x1="14" y1="7" x2="18" y2="13" />
          )}
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          background: 'var(--surface, #1e2026)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          padding: '10px 14px',
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <button
            type="button"
            onClick={toggleMute}
            title={muted ? 'Unmute' : 'Mute'}
            style={{
              background: 'transparent', border: 'none', color: 'inherit',
              padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center',
            }}
          >
            {muted ? '🔇' : (lowOnly ? '🔉' : '🔊')}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={v}
            onChange={(e) => onChange && onChange(Number(e.target.value))}
            style={{ width: '140px', cursor: 'pointer', accentColor: 'var(--accent, #6ec1ff)' }}
            aria-label="Volume"
          />
          <span style={{
            fontSize: '11px', fontVariantNumeric: 'tabular-nums',
            opacity: 0.6, minWidth: '32px', textAlign: 'right',
          }}>
            {pct}%
          </span>
        </div>
      )}
    </div>
  );
}
