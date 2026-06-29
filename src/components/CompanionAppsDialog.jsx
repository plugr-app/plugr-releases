import React, { useMemo } from 'react';

// "All Companion Apps" modal — a single-purpose utility for users who
// want to update everything at once. Lists every companion app
// detected across the user's library (Native Access, Waves Central,
// iZotope Product Portal, Plugin Alliance Installation Manager, etc.)
// with how many plugins each one manages and an Open button.
//
// Use case: it's the first of the month, the user wants to do a quick
// "update everything" pass. Instead of clicking into one plugin per
// developer, they open this dialog, hit Open on each companion app,
// and rip through them all in 30 seconds.
//
// Props:
//   items                — the library item array (after applyOverrides)
//   onOpenCompanionApp   — App.jsx callback that launches a given app
//   onClose
//
// What counts as a "companion app":
//   Either the developer-level companionApp (from the bundled
//   registry — e.g. all Native Instruments plugins → Native Access)
//   OR a per-plugin user-defined companion (Help → Plugin → Set
//   companion app…). We merge both.

export default function CompanionAppsDialog({ items, onOpenCompanionApp, onClose }) {
  // Build a map of unique companion apps → list of plugins managed by
  // each. Keyed by path (most stable identifier) with bundleId/name as
  // a fallback for older entries that don't have a path yet.
  const apps = useMemo(() => {
    const byKey = new Map();
    for (const it of items || []) {
      const c = it && it.registry && it.registry.companionApp;
      if (!c) continue;
      const key = c.path || c.bundleId || c.name;
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name: c.displayName || c.name || 'Companion app',
          path: c.path,
          bundleId: c.bundleId,
          appRef: c,
          pluginCount: 0,
          // Track developers separately so we can show "Manages plugins
          // from X, Y, Z" when the same app handles multiple brands
          // (rare but happens with Plugin Alliance, etc.).
          developers: new Set(),
        });
      }
      const entry = byKey.get(key);
      entry.pluginCount += 1;
      if (it.developer) entry.developers.add(it.developer);
    }
    // Sort by plugin count desc — the app that handles the most plugins
    // is the most useful "Open" target for batch update workflows.
    return [...byKey.values()].sort((a, b) => b.pluginCount - a.pluginCount);
  }, [items]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="All companion apps"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
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
          background: 'var(--bg-1)',
          border: '1px solid var(--line, rgba(127,127,127,0.18))',
          borderRadius: '10px',
          boxShadow: 'var(--shadow, 0 12px 36px rgba(0,0,0,0.45))',
          color: 'var(--text)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line, rgba(127,127,127,0.18))' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>Companion apps</div>
          <div style={{ fontSize: '12px', opacity: 0.65, marginTop: '2px' }}>
            Open the update managers used by developers whose updates aren't directly checked in Plugr. Click any to launch.
          </div>
        </div>
        <div style={{ padding: '12px 18px', overflowY: 'auto', flex: 1 }}>
          {apps.length === 0 ? (
            <div style={{ fontSize: '13px', opacity: 0.65, padding: '20px 0', textAlign: 'center' }}>
              Plugr didn't detect any companion apps in your library. Apps from developers
              like Native Instruments, Waves, iZotope, and Plugin Alliance will appear here once scanned.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {apps.map((app) => (
                <div
                  key={app.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: '12px',
                    alignItems: 'center',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line, rgba(127,127,127,0.12))',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{app.name}</div>
                    <div style={{ fontSize: '11.5px', opacity: 0.7, marginTop: '2px' }}>
                      Manages {app.pluginCount} plugin{app.pluginCount === 1 ? '' : 's'}
                      {app.developers.size > 0 && (
                        <> · {[...app.developers].slice(0, 3).join(', ')}{app.developers.size > 3 ? ` +${app.developers.size - 3} more` : ''}</>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => onOpenCompanionApp && onOpenCompanionApp(app.appRef)}
                    title={`Open ${app.name}`}
                  >Open</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line, rgba(127,127,127,0.18))', display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
