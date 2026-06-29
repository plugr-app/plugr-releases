import React, { useMemo, useState } from 'react';

// Renders the plugins your DAW projects reference but that aren't
// installed on this Mac. Sourced from projectMatch.unmatchedReferences
// (built by the project matcher). Each row gives the plugin name,
// format (when known), count of projects using it, and a "Search the
// web" button so the user can go find/install the missing plugin.

export default function UnmatchedReferencesList({ references, projects, onOpenExternal }) {
  const [search, setSearch] = useState('');
  const projectsById = useMemo(() => {
    const m = new Map();
    for (const p of projects || []) m.set(p.id, p);
    return m;
  }, [projects]);

  // Junk names Ableton/Logic write when they can't read a real plugin
  // name from the project file. Surfacing them as "missing plugins" is
  // confusing — they aren't real plugins to install, just unparseable
  // references. We tally them separately so the user knows the count
  // without cluttering the main list.
  const JUNK_NAMES = new Set(['default', 'untitled', '', 'placeholder']);
  const { realRefs, junkCount, wavesCount } = useMemo(() => {
    const rows = [...(references || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
    let junk = 0;
    let waves = 0;
    const real = [];
    for (const r of rows) {
      const nm = (r.name || '').trim().toLowerCase();
      if (!nm || JUNK_NAMES.has(nm) || nm.length < 2) { junk++; continue; }
      if (nm === 'waveshell' || nm.startsWith('waveshell')) { waves++; continue; }
      real.push(r);
    }
    return { realRefs: real, junkCount: junk, wavesCount: waves };
  }, [references]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return realRefs;
    return realRefs.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.format || '').toLowerCase().includes(q));
  }, [realRefs, search]);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '20px 24px 40px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.18em', fontWeight: 600, color: 'var(--accent)', marginBottom: 6, opacity: 0.85 }}>
            REFERENCED BUT NOT INSTALLED
          </div>
          <h1 style={{ margin: '0 0 6px 0', fontSize: 24, fontWeight: 700 }}>
            {realRefs.length} plugin{realRefs.length === 1 ? '' : 's'} you don't have
          </h1>
          <p style={{ fontSize: 13, opacity: 0.65, margin: 0, lineHeight: 1.5 }}>
            Plugins referenced by your DAW projects that aren't currently on this Mac. They might be uninstalled, never imported, or installed at a path Plugr didn't scan. Sorted by how many projects use them.
          </p>
          {(junkCount > 0 || wavesCount > 0) && (
            <div style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
              fontSize: 12,
              opacity: 0.85,
              lineHeight: 1.5,
            }}>
              {wavesCount > 0 && (
                <div>
                  <strong>{wavesCount} Waves reference{wavesCount === 1 ? '' : 's'} hidden.</strong> Waves plugins load through a shared host called <code>WaveShell</code>, so DAW projects record them as "WaveShell" instead of the actual plugin name. Plugr can't tell which specific Waves plugin a project uses from that alone. To track Waves updates, use Waves Central.
                </div>
              )}
              {junkCount > 0 && (
                <div style={{ marginTop: wavesCount > 0 ? 8 : 0 }}>
                  <strong>{junkCount} unidentified reference{junkCount === 1 ? '' : 's'} hidden.</strong> Your project file recorded these plugins with placeholder names like "Default" or "Untitled" — usually means the DAW couldn't read the plugin's real name when the project was saved. Re-saving the project after re-validating the plugin usually fixes it.
                </div>
              )}
            </div>
          )}
        </div>

        {realRefs.length > 0 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by plugin name or format…"
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid var(--line, rgba(127,127,127,0.18))',
              background: 'var(--bg-1, rgba(0,0,0,0.12))',
              color: 'inherit',
              fontFamily: 'inherit',
              marginBottom: 16,
              boxSizing: 'border-box',
            }}
          />
        )}

        {filtered.length === 0 ? (
          <div style={{ padding: '60px 20px', textAlign: 'center', opacity: 0.55, fontSize: 13 }}>
            {realRefs.length === 0
              ? 'Nothing here — every plugin your projects reference is installed (or hidden above).'
              : 'No matches for that filter.'}
          </div>
        ) : (
          <div style={{ border: '1px solid var(--line, rgba(127,127,127,0.18))', borderRadius: 10, overflow: 'hidden' }}>
            {filtered.map((ref, idx) => {
              const projectsUsing = (ref.projectIds || []).map((id) => projectsById.get(id)).filter(Boolean);
              const projectNames = projectsUsing.slice(0, 3).map((p) => p.name).join(', ')
                + (projectsUsing.length > 3 ? `, +${projectsUsing.length - 3} more` : '');
              return (
                <div
                  key={ref.key || ref.name + idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: 16,
                    alignItems: 'center',
                    padding: '14px 16px',
                    borderBottom: idx < filtered.length - 1 ? '1px solid var(--line, rgba(127,127,127,0.10))' : 'none',
                    background: idx % 2 === 1 ? 'var(--bg-2, rgba(255,255,255,0.02))' : 'transparent',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{ref.name || '(unknown)'}</span>
                      {ref.format && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.05em',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                          color: 'var(--accent)',
                        }}>{ref.format.toUpperCase()}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {projectNames || `${ref.count || 0} reference${ref.count === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' }}>
                    {projectsUsing.length} project{projectsUsing.length === 1 ? '' : 's'}
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => onOpenExternal && onOpenExternal(`https://www.google.com/search?q=${encodeURIComponent(ref.name + ' VST plugin')}`)}
                    title="Search the web for this plugin"
                  >
                    Find online
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
