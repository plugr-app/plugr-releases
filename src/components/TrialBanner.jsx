import React, { useState } from 'react';

// Trial / license-state banner that lives at the top of the app shell.
// Renders nothing when the user is happily licensed; quietly hangs
// around with a countdown during the trial; turns urgent at the end of
// the trial and after expiry. The user can dismiss the banner for the
// current session (the `dismissedThisSession` state); it comes back on
// next launch as a reminder.
//
// Branching:
//   - status='licensed'        → render nothing (no nag for paying users)
//   - status='trial'            → small, neutral pill: "12 days left in trial"
//                                 (or amber/red when <=5 days / <=1 day)
//   - status='trial-expired'    → red banner, persistent, "Subscribe" CTA
//   - status='grace'            → amber banner, "couldn't validate, will keep trying"
//   - status='grace-exceeded'   → red banner, "validation failed", "Reconnect or renew"
//
// Props:
//   entitlements — output of `window.pluginHub.getEntitlements()`. See
//                  electron/lib/entitlements.cjs for the shape.
//   onUpgrade    — opens the BuyDialog so the user can pick a tier.

export default function TrialBanner({ entitlements, onUpgrade }) {
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  if (!entitlements) return null;
  if (entitlements.status === 'licensed') return null;

  const days = entitlements.trial && entitlements.trial.daysRemaining;

  // Color + tone progression for each status. Keep red strictly for
  // hard-blocked states — overusing red trains users to ignore it.
  let mode = 'neutral';  // 'neutral' | 'warn' | 'block'
  let icon = '';
  let message = '';
  let cta = 'Upgrade';
  let canDismiss = true;

  switch (entitlements.status) {
    case 'trial':
      icon = '✨';
      if (days != null && days <= 1) {
        mode = 'warn';
        message = `Your free trial ends today.`;
      } else if (days != null && days <= 5) {
        mode = 'warn';
        message = `${days} days left in your free trial.`;
      } else {
        mode = 'neutral';
        message = `${days != null ? days : '14'} days left in your free trial.`;
      }
      break;
    case 'trial-expired':
      icon = '⏰';
      mode = 'block';
      message = `Your trial has ended. Subscribe to keep Plugr current — your existing library and projects stay browsable for free.`;
      cta = 'Subscribe';
      canDismiss = false;
      break;
    case 'grace':
      icon = 'ⓘ';
      mode = 'warn';
      message = `We can't reach the licensing server. Plugr will keep working while we retry.`;
      cta = 'Retry now';
      break;
    case 'grace-exceeded':
      icon = '⚠';
      mode = 'block';
      message = `We couldn't validate your license for 30 days. Reconnect or re-enter your key.`;
      cta = 'Manage license';
      canDismiss = false;
      break;
    default:
      return null;
  }

  if (dismissedThisSession && canDismiss) return null;

  const colors = {
    neutral: {
      bg:     'color-mix(in srgb, var(--accent, #6ec1ff) 8%, transparent)',
      fg:     'var(--text)',
      border: 'color-mix(in srgb, var(--accent, #6ec1ff) 28%, transparent)',
      cta:    'var(--accent, #6ec1ff)',
    },
    warn: {
      bg:     'color-mix(in srgb, var(--warn, #ffb454) 14%, transparent)',
      fg:     'var(--text)',
      border: 'color-mix(in srgb, var(--warn, #ffb454) 50%, transparent)',
      cta:    'var(--warn, #ffb454)',
    },
    block: {
      bg:     'color-mix(in srgb, var(--bad, #ef6262) 14%, transparent)',
      fg:     'var(--text)',
      border: 'color-mix(in srgb, var(--bad, #ef6262) 55%, transparent)',
      cta:    'var(--bad, #ef6262)',
    },
  }[mode];

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 14px 8px 88px',
        background: colors.bg,
        color: colors.fg,
        borderBottom: `1px solid ${colors.border}`,
        fontSize: '12.5px',
        lineHeight: 1.3,
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '14px' }}>{icon}</span>
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={onUpgrade}
        style={{
          padding: '4px 12px',
          border: `1px solid ${colors.cta}`,
          borderRadius: '4px',
          background: 'transparent',
          color: colors.cta,
          fontSize: '11.5px',
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >{cta}</button>
      {canDismiss && (
        <button
          type="button"
          onClick={() => setDismissedThisSession(true)}
          title="Hide until next launch"
          aria-label="Dismiss banner"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            opacity: 0.55,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >×</button>
      )}
    </div>
  );
}
