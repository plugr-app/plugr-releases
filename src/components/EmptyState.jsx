import React from 'react';

/**
 * Friendly empty-state with optional title, subtitle, and CTA buttons.
 *
 * Backwards-compatible: pass `message` (string) and you get the same plain
 * text it always rendered. Pass `title` + `subtitle` + `primaryAction` for
 * the richer non-technical-user-friendly layout.
 */
export default function EmptyState({ title, subtitle, message, primaryAction, secondaryAction }) {
  return (
    <div className="empty-state">
      <div className="empty-art" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="10" y="14" width="44" height="36" rx="4" />
          <path d="M10 22h44" />
          <path d="M22 36h20M22 42h12" />
        </svg>
      </div>
      {title && <h2 className="empty-title">{title}</h2>}
      {(subtitle || message) && <p className="empty-subtitle">{subtitle || message}</p>}
      {(primaryAction || secondaryAction) && (
        <div className="empty-actions">
          {primaryAction && (
            <button className="btn primary" onClick={primaryAction.onClick}>{primaryAction.label}</button>
          )}
          {secondaryAction && (
            <button className="btn" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>
          )}
        </div>
      )}
    </div>
  );
}
