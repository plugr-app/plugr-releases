import React, { useState, useEffect } from 'react';

// Floating toast shown when electron-updater has downloaded a new
// Plugr version and is ready to install. Click "Restart" to apply.
//
// We listen on the `updater:status` IPC channel via the preload
// bridge. Status progression: idle → checking → available → downloading
// → downloaded → (user clicks Restart) → app quits and relaunches into
// the new version automatically.
//
// We only render in the 'downloaded' state — the in-between phases
// happen silently in the background so we don't pester the user. If
// a user dismisses the toast (×), we hide it for the rest of the
// session; it'll show again next launch if the update is still
// pending. The app also installs pending updates on its own when the
// user quits, so even a dismissed update lands eventually.
//
// Props:
//   api — window.pluginHub

export default function UpdateToast({ api }) {
  const [status, setStatus] = useState(null);   // { status, detail, ts }
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!api) return undefined;
    // Pull initial state so a download that happened before the
    // toast mounted still shows up.
    api.getUpdaterStatus().then((s) => setStatus(s)).catch(() => {});
    // Subscribe to live updates.
    const unsubscribe = api.onUpdaterStatus((payload) => {
      setStatus(payload);
      // New event = "user might want to act on this" → un-dismiss
      if (payload && payload.status === 'downloaded') setDismissed(false);
    });
    return unsubscribe;
  }, [api]);

  if (!status || status.status !== 'downloaded' || dismissed) return null;

  const version = status.detail && status.detail.version;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 250,
        minWidth: '320px',
        maxWidth: '420px',
        padding: '12px 14px',
        background: 'var(--bg-1)',
        border: '1px solid var(--accent, #6ec1ff)',
        borderRadius: '10px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        display: 'grid',
        gridTemplateColumns: '1fr auto auto',
        gap: '10px',
        alignItems: 'center',
        color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontWeight: 600, fontSize: '13px' }}>
          Plugr update ready
        </div>
        <div style={{ fontSize: '11.5px', opacity: 0.7 }}>
          {version ? <>Version <strong>{version}</strong> is downloaded and ready to install.</> : 'A new version is ready to install.'}
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
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Hide for now — Plugr will install the update next time you quit."
        style={{
          background: 'transparent', border: 'none', color: 'inherit',
          opacity: 0.5, cursor: 'pointer', fontSize: '18px',
          padding: '0 4px', lineHeight: 1,
        }}
      >×</button>
    </div>
  );
}
