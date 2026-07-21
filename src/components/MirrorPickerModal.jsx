import React, { useEffect, useMemo, useRef, useState } from 'react';
import FormatTag from './FormatTag.jsx';
import { naturalCompare } from '../util/format.js';

// MirrorPickerModal
// ─────────────────
// Lets the user point a child plugin at a sibling whose update result
// it should follow. Examples this is built for:
//   • Serum FX → Serum
//   • After Effects Render Engine → After Effects
//   • Pro-Q 3 Mid/Side preset bank → Pro-Q 3
//
// The data layer that actually borrows the update result lives in
// App.jsx (effectiveUpdates useMemo) — this modal just lets the user
// pick which `parentItem` to set as `item.mirrorFromId`.
//
// Candidate plugins are filtered to those that ACTUALLY have something
// to mirror from — a saved updateUrl, a Sparkle feed, or just an
// existing item that isn't itself a mirror child. That way we don't
// offer the user a list of also-broken siblings.
//
// Default sort: same-developer first (alphabetical), then everyone else
// (alphabetical). Search is case-insensitive substring match on name +
// developer.

function isCandidateOf(other, item) {
  if (!other || other.id === item.id) return false;
  // Don't suggest a plugin that's itself mirroring — that would create
  // a chain. The data layer doesn't resolve chains.
  if (other.mirrorFromId) return false;
  const reg = other.registry || {};
  const hasSavedSource = !!reg.updateUrl;
  const hasSparkle = !!other.sparkleFeedUrl;
  // We always allow same-id-installed plugins as candidates — even with
  // no source — because the user might be linking PRE-discovery, and
  // the parent will become useful as soon as they configure it later.
  // Filtering to only sources-installed would block the legitimate
  // workflow "set up Serum FX to mirror Serum, then go configure Serum".
  return hasSavedSource || hasSparkle || true;
}

export default function MirrorPickerModal({ item, allItems, onClose, onPick }) {
  const [query, setQuery] = useState('');
  const searchInputRef = useRef(null);

  // Esc to close + autofocus search.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    if (searchInputRef.current) searchInputRef.current.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const myDev = (item.developer || '').toLowerCase().trim();
  const myName = item.name || '';

  // Auto-suggested candidate (same logic as the DetailPanel banner).
  // We surface it as the default highlighted row so hitting Enter
  // does the right thing immediately.
  const autoSuggest = useMemo(() => {
    if (!myDev || myDev === 'unknown' || !myName) return null;
    let best = null;
    for (const other of allItems || []) {
      if (!isCandidateOf(other, item)) continue;
      const otherDev = (other.developer || '').toLowerCase().trim();
      if (otherDev !== myDev) continue;
      const otherName = other.name || '';
      const childMatchesParent =
        myName.startsWith(otherName + ' ') || myName.startsWith(otherName + '-');
      const parentMatchesChild = otherName.startsWith(myName + ' ');
      if (!childMatchesParent && !parentMatchesChild) continue;
      if (!best || otherName.length < best.name.length) best = other;
    }
    return best;
  }, [allItems, item, myDev, myName]);

  // Build + sort the candidate list. Same-developer wins; alphabetical
  // by name within each group. The whole list is then filtered by the
  // search query (substring against name and developer).
  const candidates = useMemo(() => {
    const all = (allItems || []).filter((other) => isCandidateOf(other, item));
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((c) => {
          const n = (c.name || '').toLowerCase();
          const d = (c.developer || '').toLowerCase();
          return n.includes(q) || d.includes(q);
        })
      : all;
    return filtered.slice().sort((a, b) => {
      const aSame = (a.developer || '').toLowerCase().trim() === myDev ? 0 : 1;
      const bSame = (b.developer || '').toLowerCase().trim() === myDev ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return naturalCompare(a.name || '', b.name || '');
    });
  }, [allItems, item, query, myDev]);

  // Highlighted row. Start on the auto-suggest if present, otherwise
  // the first row. Updates as the user types.
  const [highlightId, setHighlightId] = useState(autoSuggest ? autoSuggest.id : null);
  useEffect(() => {
    if (highlightId && candidates.find((c) => c.id === highlightId)) return;
    setHighlightId(candidates.length ? candidates[0].id : null);
    // We intentionally don't depend on highlightId here — we only
    // want to re-pick when the candidate list itself shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates]);

  function confirm() {
    const target = candidates.find((c) => c.id === highlightId);
    if (target && onPick) onPick(target);
  }

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Mirror updates from another plugin">
      <div className="discover-modal" style={{ maxWidth: 560 }}>
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <div className="discover-head">
          <div className={`detail-art cat-${(item.category || 'other').toLowerCase()}`}>
            <FormatTag item={item} />
          </div>
          <div className="discover-head-text">
            <h2>Mirror updates from another plugin</h2>
            <div className="muted">
              Pick a plugin whose updates this one should follow. Useful for siblings like Serum FX → Serum, After Effects Render Engine → After Effects.
            </div>
          </div>
        </div>

        <div style={{ padding: '0 16px 8px' }}>
          <input
            ref={searchInputRef}
            type="text"
            className="dev-input"
            placeholder={`Search by plugin name or developer (e.g. "${item.developer || ''}")`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); confirm(); }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!candidates.length) return;
                const idx = candidates.findIndex((c) => c.id === highlightId);
                const dir = e.key === 'ArrowDown' ? 1 : -1;
                const nextIdx = ((idx < 0 ? 0 : idx) + dir + candidates.length) % candidates.length;
                setHighlightId(candidates[nextIdx].id);
              }
            }}
            style={{ width: '100%' }}
          />
        </div>

        <div
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            margin: '0 16px',
            border: '1px solid color-mix(in srgb, var(--text, currentColor) 12%, transparent)',
            borderRadius: 8,
          }}
        >
          {candidates.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
              {query
                ? 'No plugins match your search.'
                : "Nothing to mirror from yet. Add an update source to another plugin first, then come back."}
            </div>
          ) : (
            candidates.map((c) => {
              const reg = c.registry || {};
              const isSameDev = (c.developer || '').toLowerCase().trim() === myDev;
              const isHighlight = c.id === highlightId;
              const isSuggested = autoSuggest && c.id === autoSuggest.id;
              return (
                <button
                  type="button"
                  key={c.id}
                  onMouseEnter={() => setHighlightId(c.id)}
                  onClick={() => onPick && onPick(c)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    background: isHighlight
                      ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                      : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid color-mix(in srgb, var(--text, currentColor) 8%, transparent)',
                    cursor: 'pointer',
                    color: 'inherit',
                    font: 'inherit',
                  }}
                  title={reg.updateUrl || c.sparkleFeedUrl || 'No source yet — useful once you configure one'}
                >
                  <span style={{ fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {c.developer || 'Unknown'}{isSameDev ? '' : ''}
                  </span>
                  <FormatTag item={c} variant="pill" />
                  {isSuggested && (
                    <span
                      title="Auto-suggested based on the plugin name"
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 10,
                        background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                        color: 'var(--accent)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      suggested
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 16 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            onClick={confirm}
            disabled={!highlightId}
            title={highlightId ? 'Link to the highlighted plugin' : 'Highlight a candidate first'}
          >
            Link
          </button>
        </div>
      </div>
    </div>
  );
}
