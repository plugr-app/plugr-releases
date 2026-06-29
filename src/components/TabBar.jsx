import React, { useEffect, useState } from 'react';
// Brand lockup — two variants of the "Plugr" PNG so the wordmark
// stays legible against both light and dark surfaces. Both files
// keep the gradient color on the "P" icon; they differ in the
// "lugr" wordmark color:
//   plugr-logo.png       → dark "lugr"  → reads on LIGHT surfaces
//   plugr-logo-dark.png  → white "lugr" → reads on DARK surfaces
// (The file is named "-dark" for "intended for dark themes", not
// because the logo itself is dark — the opposite, in fact.)
import plugrLogo      from '../assets/plugr-logo.png';
import plugrLogoDark  from '../assets/plugr-logo-dark.png';

// Light-surface themes. Everything else (Dark, Logical, Bitty,
// Cubert, Fruity, Grim, Protea, Rationale + 'auto' when macOS is in
// dark mode) gets the white-wordmark variant.
const LIGHT_THEMES = new Set(['light', 'abalone']);

// Read the current resolved data-theme from <html> and re-render
// whenever it changes. App.jsx writes the resolved value (e.g. 'auto'
// becomes 'light' or 'dark' depending on macOS), so this hook always
// matches what the user actually sees.
function useResolvedTheme() {
  const [theme, setTheme] = useState(() =>
    (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'dark'
  );
  useEffect(() => {
    const html = document.documentElement;
    const update = () => setTheme(html.getAttribute('data-theme') || 'dark');
    // MutationObserver is cheap here — data-theme changes at most
    // once per theme pick / OS appearance flip.
    const obs = new MutationObserver(update);
    obs.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    update();
    return () => obs.disconnect();
  }, []);
  return theme;
}

// Top-level tab bar that switches between the Library page (plugin
// organizer) and the Projects page (DAW project organizer). Renders
// above the toolbar so the rest of the chrome can swap freely.
//
// Tabs are keyboard-accessible: arrow-key navigation and Enter to
// activate, matching the WAI-ARIA tablist pattern.
// `rightAccessories` lets the host slot global controls (volume, theme,
// help) on the right edge of the bar. The bar is always rendered, so
// anything here stays reachable from every tab without each tab's view
// having to mount its own copy of these buttons.

export default function TabBar({
  active, onChange, tabs, rightAccessories, onBrandClick,
  // Tab-hiding wiring (Phase 5 — paid+trial feature).
  //   hiddenTabs:        ids the user has hidden (full list, including
  //                      ones not currently in `tabs` because they're
  //                      filtered out by App.jsx)
  //   allTabs:           every hideable tab id+label, used to populate
  //                      the "+" restore menu so we can list tabs the
  //                      user has hidden but aren't being rendered now
  //   canHideTabs:       entitlement gate — true for paid+trial,
  //                      false for free + trial-expired
  //   onHideTab(id):     called by the per-tab right-click → "Hide"
  //                      action. Hideable tabs only.
  //   onShowTab(id):     called by the "+" restore menu.
  //   onHideTabBlocked:  called when a free/expired user attempts to
  //                      hide a tab; App.jsx pops the upgrade toast.
  hiddenTabs,
  allTabs,
  canHideTabs,
  onHideTab,
  onShowTab,
  onHideTabBlocked,
}) {
  const resolvedTheme = useResolvedTheme();
  // Local state for the per-tab context menu + "+ restore" popover.
  // Both are mutually exclusive — opening one closes the other.
  const [menuForTabId, setMenuForTabId] = React.useState(null);
  const [showRestoreMenu, setShowRestoreMenu] = React.useState(false);
  React.useEffect(() => {
    if (menuForTabId === null && !showRestoreMenu) return;
    const close = () => { setMenuForTabId(null); setShowRestoreMenu(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return () => {
      window.removeEventListener('mousedown', close);
    };
  }, [menuForTabId, showRestoreMenu]);

  // List of tab ids the user has hidden that aren't already in the
  // rendered `tabs` array — what the + button should offer. Derived
  // from hiddenTabs ∩ allTabs so we don't surface IDs that no longer
  // exist (future-proof for if we ever remove a tab).
  const restorableTabs = React.useMemo(() => {
    if (!Array.isArray(allTabs) || !Array.isArray(hiddenTabs)) return [];
    const visibleIds = new Set((tabs || []).map((t) => t.id));
    return allTabs.filter((t) => hiddenTabs.includes(t.id) && !visibleIds.has(t.id));
  }, [allTabs, hiddenTabs, tabs]);
  // Light surfaces → default logo (dark wordmark reads on white).
  // Dark surfaces → white-wordmark variant.
  const brandLogo = LIGHT_THEMES.has(resolvedTheme) ? plugrLogo : plugrLogoDark;
  const list = tabs || [
    { id: 'library',  label: 'Plugins & Apps',  hint: 'Plugin & app organizer' },
    { id: 'projects', label: 'Projects',        hint: 'DAW project organizer' },
  ];
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = list.findIndex((t) => t.id === active);
    if (i < 0) return;
    const next = e.key === 'ArrowLeft'
      ? list[(i - 1 + list.length) % list.length]
      : list[(i + 1) % list.length];
    onChange(next.id);
  };
  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label="Plugr sections"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        // Tabs left, accessories right. The two clusters never collide
        // because the right cluster has its own min-content width while
        // the gap between them grows with the window.
        justifyContent: 'space-between',
        gap: '8px',
        // 80px left padding reserves space for the macOS traffic-light
        // buttons (close / minimize / zoom) which Electron renders on
        // top of our window content when the title bar is hidden. The
        // exact stoplight width is ~70px including the right-side
        // breathing room, so 80px keeps clean space between them and
        // the first tab.
        padding: '4px 12px 0 80px',
        borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))',
        background: 'var(--toolbar-bg, var(--bg, transparent))',
        // Whole bar is a window-drag region so users can move the
        // window by clicking empty space; the buttons themselves
        // opt back out of that with -webkit-app-region: no-drag.
        WebkitAppRegion: 'drag',
        minHeight: '36px',
        alignItems: 'flex-end',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Brand: logo + name. Lives in the tab bar so it stays visible
         *  on every tab (was previously stuck inside the library-only
         *  Toolbar). Clicking the brand fires onBrandClick (existing
         *  easter-egg hook). */}
        <button
          type="button"
          onClick={onBrandClick}
          title="Plugr"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 6px 4px 2px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'inherit', WebkitAppRegion: 'no-drag',
          }}
        >
          {/* Full brand lockup (icon + "Plugr" wordmark) as a single
           * raster image. The src swaps to the all-black variant on
           * light themes so the gradient doesn't disappear against
           * the bright surface. Auto width preserves aspect ratio. */}
          <img
            src={brandLogo}
            alt="Plugr"
            height={26}
            style={{ display: 'block', height: 26, width: 'auto' }}
            draggable={false}
          />
        </button>

        <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end' }}>
        {list.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            title={t.hint}
            // Inactive tabs use color: inherit with opacity so they
            // remain visible in both light and dark themes — the
            // earlier rgba(255,255,255, …) fallback was white-on-white
            // in light mode. We also flatten the default browser
            // focus outline (a bright yellow rectangle in macOS dark
            // mode and a bright orange ring in light) in favor of a
            // subtler underline-style indicator.
            style={{
              padding: '7px 16px',
              border: 'none',
              outline: 'none',
              borderBottom: on
                ? '2px solid var(--accent, #6ec1ff)'
                : '2px solid transparent',
              marginBottom: '-1px',     // overlap the parent border
              background: 'transparent',
              color: 'inherit',
              opacity: on ? 1 : 0.55,
              fontSize: '13px',
              fontWeight: on ? 600 : 500,
              letterSpacing: '0.2px',
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
              transition: 'opacity 120ms, border-color 120ms',
              // Needed so the absolutely-positioned "Hide this tab"
              // popover anchors to this button rather than the bar.
              position: 'relative',
            }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.opacity = '0.55'; }}
            onFocus={(e) => {
              // Keyboard focus shows the bottom-border accent without
              // the chunky default outline. Mouse focus does nothing
              // extra (hover handles that case).
              if (!on) e.currentTarget.style.borderBottomColor = 'var(--accent, #6ec1ff)';
            }}
            onBlur={(e) => {
              if (!on) e.currentTarget.style.borderBottomColor = 'transparent';
            }}
            // Right-click on a hideable tab opens a one-item context
            // menu offering to hide it. Library is non-hideable, so the
            // contextmenu event is a no-op there. For free users this
            // still fires; onHideTabBlocked handles the upsell.
            onContextMenu={(e) => {
              if (!t.hideable) return;
              e.preventDefault();
              if (!canHideTabs) {
                if (onHideTabBlocked) onHideTabBlocked();
                return;
              }
              setShowRestoreMenu(false);
              setMenuForTabId(t.id);
            }}
          >
            {t.label}
            {/* Optional numeric badge ("N new" on the Deals tab). Hidden
             *  when zero/missing so unread tabs look clean. Rendered
             *  inline so the tab grows naturally rather than overlapping
             *  the borderBottom underline. */}
            {Number(t.badge) > 0 && (
              <span
                style={{
                  marginLeft: 6,
                  padding: '1px 6px',
                  borderRadius: 8,
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: 1.4,
                  color: '#fff',
                  background: 'var(--accent, #6ec1ff)',
                  verticalAlign: 'middle',
                  minWidth: 14,
                  textAlign: 'center',
                  display: 'inline-block',
                }}
              >
                {t.badge >= 99 ? '99+' : t.badge}
              </span>
            )}
            {/* Per-tab "Hide this tab" popover. Anchored to the tab
             *  button so it floats just below the tab strip. Closing
             *  is handled by the document-wide mousedown listener in
             *  the effect above. */}
            {menuForTabId === t.id && (
              <span
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 8,
                  padding: '4px',
                  borderRadius: 6,
                  background: 'var(--card-bg, #1a1d22)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.16))',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  zIndex: 1000,
                  minWidth: 160,
                  textAlign: 'left',
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onHideTab) onHideTab(t.id);
                    setMenuForTabId(null);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    padding: '6px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--row-hover-bg, rgba(255,255,255,0.06))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  Hide "{t.label}"
                </button>
                <div style={{
                  padding: '4px 10px 6px',
                  fontSize: 11,
                  opacity: 0.55,
                  borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))',
                  marginTop: 4,
                }}>
                  Restore from the + button.
                </div>
              </span>
            )}
          </button>
        );
      })}
        {/* "+" restore button — only shown when there's at least one
         *  hidden tab to restore. Opens a popover listing the hidden
         *  tabs; clicking one un-hides it. Anchored after the tab
         *  cluster so it sits naturally at the end of the strip. */}
        {restorableTabs.length > 0 && (
          <div style={{ position: 'relative', alignSelf: 'flex-end' }}>
            <button
              type="button"
              title={`${restorableTabs.length} hidden tab${restorableTabs.length === 1 ? '' : 's'} — click to restore`}
              aria-label="Show hidden tabs"
              aria-haspopup="true"
              aria-expanded={showRestoreMenu}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { setMenuForTabId(null); setShowRestoreMenu((v) => !v); }}
              style={{
                padding: '7px 10px',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'inherit',
                opacity: 0.5,
                fontSize: '14px',
                lineHeight: 1,
                cursor: 'pointer',
                WebkitAppRegion: 'no-drag',
                marginBottom: '-1px',
                borderBottom: '2px solid transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
            >
              +
            </button>
            {showRestoreMenu && (
              <span
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  padding: '6px',
                  borderRadius: 6,
                  background: 'var(--card-bg, #1a1d22)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.16))',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  zIndex: 1000,
                  minWidth: 180,
                }}
              >
                <div style={{
                  padding: '4px 8px 6px',
                  fontSize: 11,
                  opacity: 0.6,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}>Show tab</div>
                {restorableTabs.map((rt) => (
                  <button
                    key={rt.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onShowTab) onShowTab(rt.id);
                      setShowRestoreMenu(false);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      padding: '6px 10px',
                      borderRadius: 4,
                      fontSize: 12,
                      color: 'inherit',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--row-hover-bg, rgba(255,255,255,0.06))'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {rt.label}
                  </button>
                ))}
              </span>
            )}
          </div>
        )}
        </div>
      </div>
      {rightAccessories && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            // Buttons inside opt back out of the window-drag region so
            // clicks don't get hijacked by macOS's window-move handler.
            WebkitAppRegion: 'no-drag',
            paddingBottom: '4px',
          }}
        >
          {rightAccessories}
        </div>
      )}
    </div>
  );
}
