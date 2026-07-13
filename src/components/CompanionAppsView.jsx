import React, { useMemo, useState } from 'react';
import { naturalCompare } from '../util/format.js';

// "Companion Apps" tab — visual card grid of every companion installer
// detected across the user's library (Native Access, Waves Central,
// Plugin Alliance Installation Manager, iZotope Product Portal, etc.).
//
// Use case: it's the first of the month, the user wants to do a quick
// "update everything" pass. Instead of clicking into one plugin per
// developer, they open this tab and rip through them all in 30 seconds.
//
// Props:
//   items                — the library item array (after applyOverrides)
//   onOpenCompanionApp   — App.jsx callback that launches a given app
//   onCheckUpdates       — App.jsx callback that runs a full update check

const SORT_OPTIONS = [
  { value: 'updates', label: 'Updates first' },
  { value: 'count', label: 'Most plugins' },
  { value: 'alpha', label: 'A → Z' },
];

// Stable bright palette for app avatars when we don't have a real
// logo. Hashing the app name into the palette gives the same color
// across sessions, so the visual identity is consistent.
const AVATAR_PALETTE = [
  '#5B8DEF', '#7C5BEF', '#EF5B9C', '#EF7C5B', '#EFC55B',
  '#5BEFB1', '#5BC9EF', '#9CEF5B', '#EF5B5B', '#B15BEF',
];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function avatarInitials(name) {
  if (!name) return '?';
  // Pull the first letter of up to the first two words, prefer
  // capital letters to keep it readable for names like "iZotope".
  const words = String(name).split(/[\s\-_]+/).filter(Boolean).slice(0, 2);
  return words.map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function CompanionAppsView({ items, updates, onOpenCompanionApp, onCheckUpdates }) {
  const [sortBy, setSortBy] = useState('updates');
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
          updateCount: 0,
          developers: new Set(),
        });
      }
      const entry = byKey.get(key);
      entry.pluginCount += 1;
      if (it.developer) entry.developers.add(it.developer);
      // Track whether each item is a plugin or an app, so the card can
      // pluralize correctly. Microsoft AutoUpdate / App Store / Adobe
      // Creative Cloud manage applications, not plugins.
      if (!entry.formats) entry.formats = { plugin: 0, app: 0 };
      const fmt = String(it.format || '').toLowerCase();
      if (fmt === 'app' || it.category === 'Application' || it.category === 'DAW') {
        entry.formats.app += 1;
      } else {
        entry.formats.plugin += 1;
      }
      // Count plugins managed by this app that have an outdated update.
      const u = updates && updates[it.id];
      if (u && u.status === 'outdated') entry.updateCount += 1;
    }
    const arr = [...byKey.values()];
    for (const e of arr) {
      const f = e.formats || { plugin: 0, app: 0 };
      // Single-type apps get a specific label; mixed → "items" so we
      // don't lie about what's being managed.
      if (f.app > 0 && f.plugin === 0) e.unitLabel = e.pluginCount === 1 ? 'app' : 'apps';
      else if (f.plugin > 0 && f.app === 0) e.unitLabel = e.pluginCount === 1 ? 'plugin' : 'plugins';
      else e.unitLabel = e.pluginCount === 1 ? 'item' : 'items';
    }
    if (sortBy === 'alpha') {
      arr.sort((a, b) => naturalCompare(a.name, b.name));
    } else if (sortBy === 'updates') {
      // Apps with available updates first (highest update count → lowest),
      // then ties broken by plugin count, then name.
      arr.sort((a, b) =>
        b.updateCount - a.updateCount ||
        b.pluginCount - a.pluginCount ||
        naturalCompare(a.name, b.name)
      );
    } else {
      arr.sort((a, b) => b.pluginCount - a.pluginCount || naturalCompare(a.name, b.name));
    }
    return arr;
  }, [items, updates, sortBy]);

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={eyebrowStyle}>COMPANION APPS</div>
          <h1 style={titleStyle}>Update managers</h1>
          <p style={subtleText}>
            Every update manager detected across your library — Native Access, Waves Central, Plugin Alliance Installation Manager, and so on. Click <strong>Open</strong> on any one to launch it for a quick batch-update pass.
          </p>
        </div>

        {apps.length > 0 && (
          <div style={toolbarStyle}>
            <div style={countLabelStyle}>
              {apps.length} {apps.length === 1 ? 'companion' : 'companions'} · {apps.reduce((n, a) => n + a.pluginCount, 0)} items managed{(() => {
                const totalUpd = apps.reduce((n, a) => n + a.updateCount, 0);
                return totalUpd > 0 ? <> · <span style={{ color: 'var(--warn, #ff9f5a)', fontWeight: 600 }}>{totalUpd} update{totalUpd === 1 ? '' : 's'} available</span></> : null;
              })()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {onCheckUpdates && (
                <button
                  type="button"
                  onClick={onCheckUpdates}
                  style={checkUpdatesButtonStyle}
                >
                  Check for updates
                </button>
              )}
              <label style={sortLabelStyle}>Sort by</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={sortSelectStyle}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {apps.length === 0 ? (
          <div style={emptyStyle}>
            <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.5 }} aria-hidden="true">○</div>
            <div style={{ fontSize: 14, opacity: 0.7 }}>
              No companion apps detected in your library yet.
            </div>
            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6, maxWidth: 440, lineHeight: 1.5 }}>
              Once Plugr scans plugins from vendors that ship their own installers (Native Instruments, Waves, Plugin Alliance, iZotope, etc.), they'll appear here.
            </div>
          </div>
        ) : (
          <div style={gridStyle}>
            {apps.map((app) => (
              <CompanionCard
                key={app.key}
                app={app}
                onOpen={() => onOpenCompanionApp && onOpenCompanionApp(app.appRef)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Module-level cache so icons aren't re-fetched on tab remount or scroll.
const __iconDataUrls = new Map();

function useAppIcon(filePath) {
  const [dataUrl, setDataUrl] = useState(() => (filePath ? __iconDataUrls.get(filePath) || null : null));
  React.useEffect(() => {
    if (!filePath) return;
    if (__iconDataUrls.has(filePath)) { setDataUrl(__iconDataUrls.get(filePath)); return; }
    let cancelled = false;
    (async () => {
      try {
        const api = window.pluginHub;
        if (!api || !api.getFileIcon) return;
        const res = await api.getFileIcon(filePath);
        if (cancelled) return;
        if (res && res.ok && res.dataUrl) {
          __iconDataUrls.set(filePath, res.dataUrl);
          setDataUrl(res.dataUrl);
        } else {
          // Cache the miss as null so we don't spam the IPC retrying.
          __iconDataUrls.set(filePath, null);
        }
      } catch { /* fall back to initials */ }
    })();
    return () => { cancelled = true; };
  }, [filePath]);
  return dataUrl;
}

function CompanionCard({ app, onOpen }) {
  const [hover, setHover] = useState(false);
  // Pass the full descriptor so main.cjs can fall back to Spotlight
  // (mdfind by bundleId or name) when the registry path is wrong.
  const iconUrl = useAppIcon(useMemo(() => ({
    path: app.path,
    bundleId: app.bundleId,
    name: app.name,
    legacyNames: app.legacyNames || (app.appRef && app.appRef.legacyNames) || [],
  }), [app.path, app.bundleId, app.name, app.legacyNames, app.appRef]));
  const devs = [...app.developers];
  const visibleDevs = devs.slice(0, 3);
  const extraDevs = Math.max(0, devs.length - visibleDevs.length);
  const color = avatarColor(app.name);
  const initials = avatarInitials(app.name);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...cardStyle,
        borderColor: hover ? 'color-mix(in srgb, var(--accent) 45%, var(--line))' : 'var(--line, rgba(255,255,255,0.1))',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: hover
          ? '0 8px 24px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)'
          : '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden="true"
          style={iconImgStyle}
          draggable={false}
        />
      ) : (
        <div style={{ ...avatarStyle, background: `linear-gradient(135deg, ${color}, ${color}cc)` }}>
          {initials}
        </div>
      )}
      <div style={cardNameStyle} title={app.name}>{app.name}</div>
      <div style={cardMetaStyle}>
        <span style={pluginCountStyle}>{app.pluginCount}</span>
        <span style={pluginCountLabelStyle}>{app.unitLabel || (app.pluginCount === 1 ? 'plugin' : 'plugins')}</span>
      </div>
      {app.updateCount > 0 && (
        <div style={updateBadgeStyle} title={`${app.updateCount} plugin${app.updateCount === 1 ? '' : 's'} have an update available`}>
          <span style={updateBadgeDotStyle} aria-hidden="true" />
          {app.updateCount} update{app.updateCount === 1 ? '' : 's'}
        </div>
      )}
      {visibleDevs.length > 0 && (
        <div style={cardDevsStyle} title={devs.join(', ')}>
          {visibleDevs.join(' · ')}
          {extraDevs > 0 && <span style={{ opacity: 0.55 }}> +{extraDevs} more</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onOpen}
        style={{
          ...openButtonStyle,
          background: hover ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 12%, transparent)',
          color: hover ? '#fff' : 'var(--accent)',
          borderColor: hover ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 30%, transparent)',
        }}
      >
        Open
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────
const pageStyle = {
  flex: 1, minWidth: 0, overflow: 'auto',
  padding: '32px 32px 80px',
};
const containerStyle = { maxWidth: 1180, margin: '0 auto' };
const headerStyle = { marginBottom: 24 };
const eyebrowStyle = {
  fontSize: 11, letterSpacing: '0.18em', fontWeight: 600,
  color: 'var(--accent)', marginBottom: 6, opacity: 0.85,
};
const titleStyle = { margin: '0 0 6px 0', fontSize: 30, fontWeight: 700, letterSpacing: '-0.01em' };
const subtleText = { fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: 0, maxWidth: 720 };

const toolbarStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 18, paddingBottom: 14,
  borderBottom: '1px solid var(--line, rgba(127,127,127,0.12))',
};
const countLabelStyle = { fontSize: 12, opacity: 0.65 };
const checkUpdatesButtonStyle = {
  padding: '6px 13px', fontSize: 12, fontWeight: 600,
  letterSpacing: '0.03em',
  border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
  borderRadius: 7,
  background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
  color: 'var(--accent)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 140ms ease, border-color 140ms ease',
};
const sortLabelStyle = { fontSize: 11, opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.06em' };
const sortSelectStyle = {
  padding: '6px 10px', fontSize: 13, borderRadius: 6,
  border: '1px solid var(--line, rgba(255,255,255,0.12))',
  background: 'var(--bg-1, rgba(0,0,0,0.18))',
  color: 'inherit', fontFamily: 'inherit',
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 16,
};

const cardStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '20px 18px 16px',
  borderRadius: 14,
  border: '1px solid var(--line, rgba(255,255,255,0.1))',
  background: 'var(--bg-2, rgba(255,255,255,0.03))',
  transition: 'transform 140ms ease, box-shadow 160ms ease, border-color 160ms ease',
  cursor: 'default',
  textAlign: 'center',
};
const iconImgStyle = {
  // No background, no shadow, no border-radius enforcement — the vendor
  // designed their icon (rounded square, circle, irregular shape).
  // We just give it a uniform max box and let the natural design show.
  // This also handles the visual variance between icons with their own
  // padding (Native Access) vs ones that fill the canvas (Waves Central):
  // both look right without us trying to homogenize them.
  width: 64, height: 64,
  marginBottom: 12,
  objectFit: 'contain',
  background: 'transparent',
};
const avatarStyle = {
  width: 56, height: 56, borderRadius: 14,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: '0.04em',
  marginBottom: 12,
  boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
};
const cardNameStyle = {
  fontSize: 14, fontWeight: 600, lineHeight: 1.3,
  marginBottom: 8,
  // Allow up to two lines so long official names like
  // "Plugin Alliance Installation Manager" and "Steinberg Download
  // Assistant" fit without truncation. The -webkit-line-clamp combo
  // adds an ellipsis fallback if anything ever exceeds two lines.
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  wordBreak: 'break-word',
  maxWidth: '100%',
};
const cardMetaStyle = {
  display: 'flex', alignItems: 'baseline', gap: 5,
  marginBottom: 8,
};
const pluginCountStyle = {
  fontSize: 22, fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--accent)',
  lineHeight: 1,
};
const pluginCountLabelStyle = {
  fontSize: 11, opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.06em',
};
const updateBadgeStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '3px 9px',
  marginBottom: 10,
  borderRadius: 999,
  fontSize: 10.5, fontWeight: 600,
  letterSpacing: '0.04em',
  background: 'color-mix(in srgb, var(--warn, #ff9f5a) 18%, transparent)',
  color: 'var(--warn, #ff9f5a)',
  border: '1px solid color-mix(in srgb, var(--warn, #ff9f5a) 35%, transparent)',
};
const updateBadgeDotStyle = {
  width: 6, height: 6, borderRadius: '50%',
  background: 'var(--warn, #ff9f5a)',
  boxShadow: '0 0 0 3px color-mix(in srgb, var(--warn, #ff9f5a) 25%, transparent)',
};
const cardDevsStyle = {
  fontSize: 11, opacity: 0.6, lineHeight: 1.4,
  marginBottom: 14,
  // Same two-line wrap treatment as the title so bundles with many
  // sub-brands (e.g. Plugin Alliance · Lindell Audio · …) fit without
  // truncating after one developer.
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  wordBreak: 'break-word',
  maxWidth: '100%',
};
const openButtonStyle = {
  padding: '8px 18px', fontSize: 12, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase',
  border: '1px solid', borderRadius: 8,
  cursor: 'pointer',
  transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
  marginTop: 'auto',
};
const emptyStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '80px 20px', textAlign: 'center',
};
