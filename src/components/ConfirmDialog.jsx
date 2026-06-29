import React, { useEffect, useRef } from 'react';

/**
 * Higher-friction confirmation modal used when an action will affect items
 * the user didn't explicitly select — most importantly the
 * rename-developer-across-other-plugins prompt that triggered the
 * "WhatsApp → Meta swept up everything" bug.
 *
 * Differences from window.confirm():
 *   - Custom YES / NO labels (the user can read what each button does).
 *   - The "yes" (destructive) button is styled red.
 *   - The "no" button gets keyboard focus by default and Enter triggers
 *     it. The dialog can also be dismissed with Escape or by clicking
 *     the backdrop.
 *   - Optional `body` (multiline supported) and `details` (rendered as a
 *     muted block under the body — good for "X plugins affected" hints).
 */
export default function ConfirmDialog({
  title,
  body,
  details,
  yesLabel = 'Yes',
  noLabel = 'No',
  destructive = false,
  onYes,
  onNo,
}) {
  const noBtnRef = useRef(null);

  // Focus "No" on open so a stray Enter press confirms the safe choice.
  useEffect(() => {
    if (noBtnRef.current) noBtnRef.current.focus();
  }, []);

  // Escape always cancels.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onNo && onNo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNo]);

  return (
    <div
      className="confirm-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onNo && onNo(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className={`confirm-dialog ${destructive ? 'destructive' : ''}`}>
        <h2 className="confirm-dialog-title" id="confirm-dialog-title">{title}</h2>
        {body && <div className="confirm-dialog-body">{body}</div>}
        {details && <div className="confirm-dialog-details muted">{details}</div>}
        <div className="confirm-dialog-actions">
          <button
            ref={noBtnRef}
            type="button"
            className="btn primary"
            onClick={onNo}
          >
            {noLabel}
          </button>
          <button
            type="button"
            className={`btn ${destructive ? 'destructive-action' : ''}`}
            onClick={onYes}
          >
            {yesLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
