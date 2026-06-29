import React from 'react';
import { THEMES } from '../App.jsx';

// Modal-style theme picker.
//
// Each theme is rendered as a small swatch tile that previews the actual
// theme variables (we apply the theme as a data-theme attribute on the
// preview wrapper, so the colors are guaranteed to match what you'll see
// when the theme is applied app-wide).
//
// The system group (Auto / Dark / Light) is shown first, followed by the
// DAW-themed palettes. Clicking a tile applies it immediately and closes
// the picker.

export default function ThemePicker({ current, onChange, onClose }) {
  const groups = {
    system: THEMES.filter((t) => t.group === 'system'),
    daw: THEMES.filter((t) => t.group === 'daw'),
  };

  // Apply the theme but keep the picker open so the user can audition
  // multiple. They close it themselves with the × button or backdrop click.
  function pick(value) {
    onChange(value);
  }

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Choose theme">
      <div className="theme-picker-modal">
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <h2 className="theme-picker-title">Theme</h2>
        <p className="theme-picker-sub muted">
          Pick a built-in look or one of the named studio palettes. Auto follows your Mac's
          appearance setting.
        </p>

        <div className="theme-section-label">System</div>
        <div className="theme-grid">
          {groups.system.map((t) => (
            <ThemeTile key={t.value} theme={t} active={current === t.value} onPick={() => pick(t.value)} />
          ))}
        </div>

        <div className="theme-section-label">Studio palettes</div>
        <div className="theme-grid">
          {groups.daw.map((t) => (
            <ThemeTile key={t.value} theme={t} active={current === t.value} onPick={() => pick(t.value)} />
          ))}
        </div>

        <div className="theme-picker-footer">
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Render a mini Plugr-window screenshot inside a tile so the user can
// see at a glance what each theme actually does: toolbar color +
// accent, sidebar bg + muted text-line tones, three category-strip
// cards demonstrating the cat-* gradient family, and a row of color
// swatches across the bottom for the at-a-glance "palette identity".
// We re-apply the theme via data-theme on the wrapper, so the preview
// pulls real --bg-*, --accent, and --cat-* variables. No hardcoded
// colors — switching themes changes the preview in lockstep.
function ThemePreviewWindow({ themeValue }) {
  return (
    <div className="theme-preview" data-theme={themeValue}>
      <div className="theme-preview-toolbar">
        <div className="theme-preview-mark" />
        <div className="theme-preview-search" />
        <div className="theme-preview-tabdot" />
      </div>
      <div className="theme-preview-body">
        <div className="theme-preview-sidebar">
          <div className="theme-preview-sidebar-row" />
          <div className="theme-preview-sidebar-row short" />
          <div className="theme-preview-sidebar-row" />
          <div className="theme-preview-sidebar-row short" />
        </div>
        <div className="theme-preview-cards">
          <MiniCard category="effect" />
          <MiniCard category="instrument" />
          <MiniCard category="application" />
        </div>
      </div>
      <div className="theme-preview-swatches">
        <span className="theme-swatch swatch-accent" />
        <span className="theme-swatch swatch-instrument" />
        <span className="theme-swatch swatch-effect" />
        <span className="theme-swatch swatch-midi" />
        <span className="theme-swatch swatch-application" />
      </div>
    </div>
  );
}

function MiniCard({ category }) {
  return (
    <div className="theme-preview-minicard">
      <div className={`theme-preview-minicard-strip cat-${category}`} />
      <div className="theme-preview-minicard-body">
        <div className="theme-preview-minicard-title" />
        <div className="theme-preview-minicard-pill" />
      </div>
    </div>
  );
}

function ThemeTile({ theme, active, onPick }) {
  // For 'auto', show a dark+light split preview so the user sees that
  // this option follows the system. Each half renders a tiny preview
  // in its respective hard-coded theme.
  if (theme.value === 'auto') {
    return (
      <button type="button" className={`theme-tile ${active ? 'active' : ''}`} onClick={onPick}>
        <div className="theme-preview auto-preview">
          <div className="auto-half" data-theme="dark"><MiniAutoHalf /></div>
          <div className="auto-half" data-theme="light"><MiniAutoHalf /></div>
        </div>
        <div className="theme-name">{theme.label}</div>
        <div className="theme-sub muted">{theme.sub || 'Follows macOS'}</div>
      </button>
    );
  }

  return (
    <button type="button" className={`theme-tile ${active ? 'active' : ''}`} onClick={onPick}>
      <ThemePreviewWindow themeValue={theme.value} />
      <div className="theme-name">{theme.label}</div>
      {theme.sub && <div className="theme-sub muted">{theme.sub}</div>}
    </button>
  );
}

// One half of the auto-preview tile. Same mini-window as the named
// themes, just stripped down a hair so the diptych still fits the
// tile width.
function MiniAutoHalf() {
  return (
    <>
      <div className="theme-preview-toolbar">
        <div className="theme-preview-mark" />
      </div>
      <div className="theme-preview-body auto-body">
        <div className="theme-preview-sidebar">
          <div className="theme-preview-sidebar-row" />
          <div className="theme-preview-sidebar-row short" />
        </div>
        <div className="theme-preview-cards">
          <MiniCard category="effect" />
          <MiniCard category="instrument" />
        </div>
      </div>
    </>
  );
}
