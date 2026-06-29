import React, { useEffect, useMemo, useRef, useState } from 'react';

// AlertsManager
// ─────────────
// Modal for viewing, creating, and deleting deal alerts. Three watch types:
//
//   • plugin    — by plugin name (typeahead from the user's library).
//                 Works equally for plugins the user owns and for ones
//                 they DON'T own (free-text fallback).
//   • developer — by developer name (typeahead from the user's library).
//   • custom    — by free-text keywords (multi-keyword AND match).
//
// The list at the top shows every existing alert with a toggle (active /
// paused) and a delete button. The add panel at the bottom collects the
// type + payload, then calls api.addDealAlert and refreshes the list.
//
// Data refresh is naive (re-fetch the full list after each mutation) —
// the list is tiny in practice and the IPC round trip is fast.

export default function AlertsManager({ api, libraryItems, onClose, onAlertsChanged }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState(null); // null | 'plugin' | 'developer' | 'custom'

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes; Cmd+W too.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function refresh() {
    setLoading(true);
    try {
      const result = await api.listDealAlerts();
      setAlerts(result && result.ok ? result.alerts : []);
    } catch {
      setAlerts([]);
    }
    setLoading(false);
  }

  // Fire-and-forget hook for App.jsx so its shared dealAlerts state
  // refreshes when the user mutates from inside this modal. Without
  // this, bell icons in DetailPanel + deal cards would go stale until
  // the next 'alerts:matched' event arrived.
  function notifyChanged() {
    if (typeof onAlertsChanged === 'function') onAlertsChanged();
  }

  async function handleToggle(alert) {
    await api.updateDealAlert(alert.id, { active: !alert.active });
    refresh();
    notifyChanged();
  }

  async function handleDelete(alert) {
    await api.removeDealAlert(alert.id);
    refresh();
    notifyChanged();
  }

  return (
    <div
      className="tutorial-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="My deal alerts"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="discover-modal"
        style={{
          maxWidth: 640,
          width: '92vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>My Deal Alerts</h2>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
            Plugr watches the deal feed for plugins, developers, or keywords
            you care about — and pings you when a match shows up.
          </p>
        </header>

        {/* ─── Existing alerts ─── */}
        <div style={{ flex: '1 1 auto', overflowY: 'auto', marginBottom: 16 }}>
          {loading ? (
            <p className="muted" style={{ textAlign: 'center', padding: 24 }}>Loading…</p>
          ) : alerts.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '32px 16px',
              color: 'var(--text-muted, rgba(255,255,255,0.55))',
              fontSize: 13,
            }}>
              No alerts yet. Use the form below to add one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {alerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  onToggle={() => handleToggle(alert)}
                  onDelete={() => handleDelete(alert)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ─── Add new alert ─── */}
        <div style={{
          borderTop: '1px solid var(--border-color, rgba(255,255,255,0.12))',
          paddingTop: 14,
          flex: '0 0 auto',
        }}>
          {addMode === null ? (
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                Add a new alert
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => setAddMode('plugin')}>
                  + Watch a plugin
                </button>
                <button className="btn" onClick={() => setAddMode('developer')}>
                  + Watch a developer
                </button>
                <button className="btn" onClick={() => setAddMode('custom')}>
                  + Watch keywords
                </button>
              </div>
            </div>
          ) : (
            <AddAlertForm
              mode={addMode}
              libraryItems={libraryItems}
              api={api}
              onSaved={() => { setAddMode(null); refresh(); notifyChanged(); }}
              onCancel={() => setAddMode(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────

function AlertRow({ alert, onToggle, onDelete }) {
  const typeBadge = {
    plugin: 'Plugin',
    developer: 'Developer',
    custom: 'Keyword',
  }[alert.type] || 'Alert';
  const lastNotified = alert.lastNotifiedAt
    ? new Date(alert.lastNotifiedAt).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      })
    : null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 12px',
      borderRadius: 8,
      background: 'var(--input-bg, rgba(255,255,255,0.04))',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      opacity: alert.active ? 1 : 0.55,
    }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'color-mix(in srgb, var(--accent, #6ec1ff) 24%, transparent)',
            color: 'var(--accent, #6ec1ff)',
            flex: '0 0 auto',
          }}>{typeBadge}</span>
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{alert.label}</div>
        </div>
        {alert.type === 'custom' && alert.keywords && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>
            Keywords: {alert.keywords.join(', ')}
          </div>
        )}
        {lastNotified && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>
            Last triggered {lastNotified}
          </div>
        )}
      </div>
      <button
        className="btn btn-small"
        onClick={onToggle}
        title={alert.active ? 'Pause this alert' : 'Resume this alert'}
        style={{ flex: '0 0 auto', minWidth: 72 }}
      >
        {alert.active ? 'Pause' : 'Resume'}
      </button>
      <button
        className="btn btn-small danger"
        onClick={onDelete}
        title="Delete this alert"
        style={{ flex: '0 0 auto' }}
        aria-label="Delete"
      >
        Delete
      </button>
    </div>
  );
}

function AddAlertForm({ mode, libraryItems, api, onSaved, onCancel }) {
  const titleByMode = {
    plugin: 'Watch a plugin',
    developer: 'Watch a developer',
    custom: 'Watch keywords',
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button className="btn btn-small ghost" onClick={onCancel} aria-label="Back">← Back</button>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{titleByMode[mode]}</div>
      </div>
      {mode === 'plugin' && (
        <PluginPicker libraryItems={libraryItems} api={api} onSaved={onSaved} />
      )}
      {mode === 'developer' && (
        <DeveloperPicker libraryItems={libraryItems} api={api} onSaved={onSaved} />
      )}
      {mode === 'custom' && (
        <CustomKeywordsForm api={api} onSaved={onSaved} />
      )}
    </div>
  );
}

// Plugin picker with typeahead from the user's library + free-text
// fallback for plugins they don't own. The fallback is what makes
// "watch for Melodyne" work even when the user doesn't have Melodyne
// installed.
function PluginPicker({ libraryItems, api, onSaved }) {
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  // Deduped list of plugin names from the library. Mirroring (multiple
  // formats of the same plugin) gets collapsed to a single suggestion.
  const suggestions = useMemo(() => {
    const seen = new Map();
    for (const it of libraryItems || []) {
      const key = (it.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.set(key, { name: it.name, developer: it.developer || '', identifier: it.identifier });
    }
    return Array.from(seen.values());
  }, [libraryItems]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return suggestions
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, suggestions]);

  async function save({ name, identifier = null }) {
    if (!name || !name.trim()) return;
    setSaving(true);
    try {
      await api.addDealAlert({
        type: 'plugin',
        label: name.trim(),
        identifier: identifier || null,
      });
      onSaved();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        className="dev-input"
        placeholder="Plugin name (e.g. Melodyne 5, Pro-Q 4)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.trim()) {
            // Enter saves with first suggestion (if any) else free-text
            if (filtered.length > 0) save(filtered[0]);
            else save({ name: query });
          }
        }}
        disabled={saving}
      />
      <div className="muted micro" style={{ marginTop: 4 }}>
        Plugr will notify you when a deal mentions this plugin — even if you don't own it yet.
      </div>
      {filtered.length > 0 && (
        <div style={{
          marginTop: 8,
          maxHeight: 180,
          overflowY: 'auto',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 6,
        }}>
          {filtered.map((s) => (
            <button
              key={s.identifier || s.name}
              className="btn ghost"
              onClick={() => save(s)}
              disabled={saving}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 0,
                border: 'none',
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 500 }}>{s.name}</div>
              {s.developer && (
                <div style={{ fontSize: 11, opacity: 0.6 }}>{s.developer}</div>
              )}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          className="btn primary"
          onClick={() => save({ name: query })}
          disabled={!query.trim() || saving}
        >
          {saving ? 'Saving…' : `Add "${query.trim() || '…'}"`}
        </button>
      </div>
    </div>
  );
}

function DeveloperPicker({ libraryItems, api, onSaved }) {
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const developers = useMemo(() => {
    const seen = new Set();
    for (const it of libraryItems || []) {
      const d = (it.developer || '').trim();
      if (d) seen.add(d);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [libraryItems]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return developers.filter((d) => d.toLowerCase().includes(q)).slice(0, 8);
  }, [query, developers]);

  async function save(devName) {
    const name = (devName || '').trim();
    if (!name) return;
    setSaving(true);
    try {
      await api.addDealAlert({
        type: 'developer',
        label: name,
        identifier: name,
      });
      onSaved();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        className="dev-input"
        placeholder="Developer name (e.g. Plugin Alliance, FabFilter)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.trim()) {
            save(filtered[0] || query);
          }
        }}
        disabled={saving}
      />
      <div className="muted micro" style={{ marginTop: 4 }}>
        Get notified when ANY deal from this developer shows up — sales, new releases, bundles.
      </div>
      {filtered.length > 0 && (
        <div style={{
          marginTop: 8,
          maxHeight: 180,
          overflowY: 'auto',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 6,
        }}>
          {filtered.map((d) => (
            <button
              key={d}
              className="btn ghost"
              onClick={() => save(d)}
              disabled={saving}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 0,
                border: 'none',
                fontSize: 13,
              }}
            >{d}</button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          className="btn primary"
          onClick={() => save(query)}
          disabled={!query.trim() || saving}
        >
          {saving ? 'Saving…' : `Add "${query.trim() || '…'}"`}
        </button>
      </div>
    </div>
  );
}

function CustomKeywordsForm({ api, onSaved }) {
  const [label, setLabel] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  // Comma-separated → array. Trim each, drop empties.
  const keywords = useMemo(() => {
    return keywordsText
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }, [keywordsText]);

  async function save() {
    if (keywords.length === 0) return;
    setSaving(true);
    try {
      await api.addDealAlert({
        type: 'custom',
        label: label.trim() || keywords.join(' + '),
        keywords,
      });
      onSaved();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <span className="muted micro" style={{ display: 'block', marginBottom: 4 }}>
          Keywords (separate with commas — a deal must match ALL of them)
        </span>
        <input
          ref={inputRef}
          type="text"
          className="dev-input"
          placeholder='e.g. melodyne, celemony'
          value={keywordsText}
          onChange={(e) => setKeywordsText(e.target.value)}
          disabled={saving}
        />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <span className="muted micro" style={{ display: 'block', marginBottom: 4 }}>
          Friendly label (optional — defaults to the keyword list)
        </span>
        <input
          type="text"
          className="dev-input"
          placeholder="e.g. Melodyne sale watch"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          disabled={saving}
        />
      </label>
      <div className="muted micro" style={{ marginBottom: 12 }}>
        Match: each comma-separated word must appear somewhere in the deal's title
        or developer. Useful for niche plugins Plugr doesn't track or for matching
        a series (e.g. "uvi, falcon").
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={keywords.length === 0 || saving}
        >
          {saving ? 'Saving…' : `Add alert (${keywords.length} keyword${keywords.length === 1 ? '' : 's'})`}
        </button>
      </div>
    </div>
  );
}
