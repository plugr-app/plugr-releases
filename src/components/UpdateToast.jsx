import React, { useState, useEffect, useRef } from 'react';

// Floating toast shown during and after a Plugr self-update download.
//
// Status progression:
//   idle → checking → available → downloading → downloaded
//   → (user clicks Restart) → app quits and relaunches
//
// What we show at each phase:
//   idle / checking / up-to-date  — nothing (silent boot-time checks)
//   available                     — nothing (handleCheckForPlugrUpdates in
//                                    App.jsx already showed an info toast)
//   downloading                   — progress bar so user knows it's working
//   downloaded                    — "Restart" button so user can install
//   error (after seeing update)   — error message + Retry button; without
//                                    this the download silently dies and the
//                                    user never knows why Restart never showed
//
// Props:
//   api — window.pluginHub

export default function UpdateToast({ api }) {
  const [status, setStatus]     = useState(null);   // { status, detail, ts }
  const [dismissed, setDismissed] = useState(false);
  // Track whether we've seen an 'available' / 'downloading' event so we
  // know to surface errors (we don't want to surface errors from silent
  // boot-time checks that just found no update and timed out).
  const hadUpdateRef = useRef(false);
  // Remember the version we're downloading across status transitions
  // (available → downloading → downloaded — only 'available' carries it).
  const pendingVersionRef = useRef(null);

  useEffect(() => {
    if (!api) return undefined;
    // Pull initial state so a download that finished before the component
    // mounted (e.g. boot-time check completed before React hydrated) still
    // shows up.
    api.getUpdaterStatus().then((s) => {
      if (!s) return;
      if (['available', 'downloading', 'downloaded'].includes(s.status)) {
        hadUpdateRef.current = true;
      }
      if (s.status === 'available' && s.detail && s.detail.version) {
        pendingVersionRef.current = s.detail.version;
      }
      setStatus(s);
    }).catch(() => {});

    // Subscribe to live updates.
    const unsubscribe = api.onUpdaterStatus((payload) => {
      if (!payload) return;
      if (['available', 'downloading', 'downloaded'].includes(payload.status)) {
        hadUpdateRef.current = true;
      }
      if (payload.status === 'available' && payload.detail && payload.detail.version) {
        pendingVersionRef.current = payload.detail.version;
      }
      setStatus(payload);
      // New 'downloaded' event → un-dismiss in case the user had previously
      // dismissed but then quit-and-relaunched without installing.
      if (payload.status === 'downloaded') setDismissed(false);
      // New error while we had an update incoming → un-dismiss so the error shows.
      if (payload.status === 'error' && hadUpdateRef.current) setDismissed(false);
    });
    return unsubscribe;
  }, [api]);

  if (!status || dismissed) return null;

  const sharedWrapStyle = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 250,
    minWidth: '320px',
    maxWidth: '420px',
    padding: '12px 14px',
    background: 'var(--bg-1)',
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    color: 'var(--text)',
  };

  const dismissBtn = (title = 'Hide for now — Plugr will try again next launch.') => (
    <button
      type="button"
      onClick={() => setDismissed(true)}
      aria-label="Dismiss"
      title={title}
      style={{
        background: 'transparent', border: 'none', color: 'inherit',
        opacity: 0.5, cursor: 'pointer', fontSize: '18px',
        padding: '0 4px', lineHeight: 1,
      }}
    >×</button>
  );

  // ── Downloading ──────────────────────────────────────────────────────────
  if (status.status === 'downloading') {
    const pct     = status.detail && typeof status.detail.percent === 'number' ? status.detail.percent : null;
    const version = pendingVersionRef.current;
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          ...sharedWrapStyle,
          border: '1px solid color-mix(in srgb, var(--accent, #6ec1ff) 40%, transparent)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            Downloading Plugr update{version ? ` ${version}` : ''}…
          </div>
          {dismissBtn()}
        </div>
        {/* Progress bar */}
        <div style={{
          height: '4px',
          borderRadius: '2px',
          background: 'var(--bg-2, rgba(255,255,255,0.1))',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            borderRadius: '2px',
            background: 'var(--accent, #6ec1ff)',
            width: pct !== null ? `${pct}%` : '100%',
            transition: pct !== null ? 'width 0.4s ease' : 'none',
            // Indeterminate animation when we don't have a percent yet
            ...(pct === null ? {
              animation: 'plugr-indeterminate 1.4s ease infinite',
            } : {}),
          }} />
        </div>
        {pct !== null && (
          <div style={{ fontSize: '11px', opacity: 0.55, textAlign: 'right' }}>
            {pct}%
          </div>
        )}
        <style>{`
          @keyframes plugr-indeterminate {
            0%   { transform: translateX(-100%); width: 60%; }
            100% { transform: translateX(200%);  width: 60%; }
          }
        `}</style>
      </div>
    );
  }

  // ── Downloaded (ready to install) ────────────────────────────────────────
  if (status.status === 'downloaded') {
    const version = (status.detail && status.detail.version) || pendingVersionRef.current;
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          ...sharedWrapStyle,
          border: '1px solid var(--accent, #6ec1ff)',
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            Plugr update ready
          </div>
          <div style={{ fontSize: '11.5px', opacity: 0.7 }}>
            {version
              ? <>Version <strong>{version}</strong> is downloaded and ready to install.</>
              : 'A new version is ready to install.'}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => api.installUpdate()}
          style={{
            background: 'var(--accent, #6ec1ff)',
            color: 'var(--bg-0)',
            border: 'none',
          }}
        >Restart</button>
        {dismissBtn('Hide for now — Plugr will install the update next time you quit.')}
      </div>
    );
  }

  // ── Error (only shown if we'd already seen an update coming) ─────────────
  if (status.status === 'error' && hadUpdateRef.current) {
    const msg = status.detail && status.detail.message;
    return (
      <div
        role="alert"
        style={{
          ...sharedWrapStyle,
          border: '1px solid color-mix(in srgb, #ff6b6b 50%, transparent)',
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            Update download failed
          </div>
          <div style={{ fontSize: '11.5px', opacity: 0.7 }}>
            {msg || 'Could not download the update. Check your connection and try again.'}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            setDismissed(false);
            setStatus((s) => ({ ...s, status: 'checking' }));
            api.checkForUpdates && api.checkForUpdates();
          }}
          style={{
            background: 'transparent',
            border: '1px solid color-mix(in srgb, var(--text) 30%, transparent)',
            color: 'var(--text)',
            whiteSpace: 'nowrap',
          }}
        >Retry</button>
        {dismissBtn()}
      </div>
    );
  }

  return null;
}
