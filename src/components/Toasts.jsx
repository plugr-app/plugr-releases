import React, { useEffect } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Floating toast notifications.
//
// Rendered in a position:fixed container at the top-right of the viewport
// so they're visible regardless of scroll. Each toast auto-dismisses after
// ~6 seconds; the user can dismiss manually. Multiple toasts stack.
//
// API: <Toasts toasts={[{id, kind, message}]} onDismiss={fn} />
//   kind: 'error' | 'info' | 'success'
// ─────────────────────────────────────────────────────────────────────────

export default function Toasts({ toasts, onDismiss }) {
  if (!toasts || toasts.length === 0) return null;
  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  // `persistent: true` skips the auto-dismiss timer so info-rich result
  // toasts (like the find-sources summary) stick around until the user
  // actively dismisses them.
  useEffect(() => {
    if (toast.persistent) return;
    const ms = toast.durationMs || 6000;
    const timer = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.persistent]);

  return (
    <div className={`toast toast-${toast.kind || 'error'} ${toast.persistent ? 'toast-persistent' : ''}`} role="alert">
      <div className="toast-icon" aria-hidden="true">
        {toast.kind === 'success' ? '✓' : toast.kind === 'info' ? 'ⓘ' : '!'}
      </div>
      <div className="toast-body">
        {toast.title && <div className="toast-title">{toast.title}</div>}
        <div className="toast-message">{toast.message}</div>
        {/* Optional action button — typically used for "Undo" right after
         * a bulk change. Clicking the action also dismisses the toast so
         * we don't show a stale undo button after it's been used. */}
        {toast.action && toast.action.label && (
          <button
            className="toast-action"
            onClick={() => {
              try { toast.action.onClick && toast.action.onClick(); }
              finally { onDismiss(toast.id); }
            }}
          >{toast.action.label}</button>
        )}
      </div>
      <button
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >×</button>
    </div>
  );
}
