import React, { useState } from 'react';
import { CUSTOMER_PORTAL_URL } from '../lib/checkoutConfig.js';

// License management UI. Rendered as a tab inside HelpDialog so it
// lives alongside Preferences, Updates, About, etc. Surfaces:
//   - Current entitlement state (trial / licensed / grace / expired)
//   - Activate-a-key form (paste from email → click Activate)
//   - Active-device details (which Mac, when activated, when last
//     re-validated, masked key)
//   - Deactivate this device (frees the seat so user can use another Mac)
//   - Refresh validation (manual check against LemonSqueezy)
//   - Manage at LemonSqueezy customer portal (web link)
//   - Upgrade CTA (opens BuyDialog) when not licensed
//
// Props:
//   api          — window.pluginHub
//   entitlements — current snapshot (from getEntitlements)
//   onChanged    — called with the fresh snapshot after any state-
//                  changing action so the parent can update its mirror
//   onUpgrade    — open the BuyDialog modal
//   pushToast    — show a transient toast message

export default function LicenseSection({ api, entitlements, onChanged, onUpgrade, pushToast }) {
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState('');

  if (!entitlements) {
    return (
      <div className="help-prose">
        <p style={{ opacity: 0.65 }}>Loading license status…</p>
      </div>
    );
  }

  const isLicensed = entitlements.status === 'licensed' || entitlements.status === 'grace';

  async function handleActivate(e) {
    e.preventDefault();
    if (!keyDraft.trim()) return;
    setBusy(true); setLastError('');
    try {
      const res = await api.activateLicense(keyDraft.trim());
      if (!res || !res.ok) {
        setLastError(res && res.message ? res.message : 'Activation failed. Check the key and try again.');
      } else {
        setKeyDraft('');
        if (pushToast) pushToast({ kind: 'success', message: 'License activated. Welcome!', durationMs: 4000 });
        if (onChanged && res.entitlements) onChanged(res.entitlements);
      }
    } catch (err) {
      setLastError(String(err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setBusy(true); setLastError('');
    try {
      const res = await api.validateLicense();
      if (res && res.entitlements && onChanged) onChanged(res.entitlements);
      if (pushToast) {
        if (res && res.ok) pushToast({ kind: 'success', message: 'License re-validated.', durationMs: 3000 });
        else if (res && res.error === 'offline-grace') pushToast({ kind: 'warning', message: "Couldn't reach the server. We'll keep retrying.", durationMs: 4000 });
        else if (res && res.error === 'revoked') pushToast({ kind: 'error', message: "License was revoked or refunded. You'll need to re-activate." });
      }
    } catch (err) {
      setLastError(String(err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    if (!window.confirm('Sign this device out of your Plugr license?\n\nYour cached library and projects stay on this Mac, but paid features will lock until you re-activate (here or on another Mac).')) return;
    setBusy(true); setLastError('');
    try {
      const res = await api.deactivateLicense();
      if (res && res.entitlements && onChanged) onChanged(res.entitlements);
      if (pushToast) pushToast({ kind: 'success', message: 'Signed out of this device.', durationMs: 4000 });
    } catch (err) {
      setLastError(String(err && err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="help-prose">
      <h3 style={{ marginTop: 0 }}>Your Plugr license</h3>

      <StatusPill entitlements={entitlements} />

      {isLicensed && entitlements.license && (
        <div style={{
          marginTop: '16px',
          padding: '14px',
          background: 'var(--bg-2)',
          border: '1px solid var(--line, rgba(127,127,127,0.18))',
          borderRadius: '8px',
          fontSize: '13px',
          lineHeight: 1.6,
        }}>
          <KeyValue label="Tier"            value={prettyTier(entitlements.license.tier)} />
          <KeyValue label="License key"     value={entitlements.license.licenseKeyMasked || '—'} mono />
          <KeyValue label="Activated"       value={formatDate(entitlements.license.activatedAt)} />
          <KeyValue label="Last re-checked" value={formatDate(entitlements.license.lastValidated)} />
          <KeyValue
            label={entitlements.license.tier === 'lifetime' ? 'Expires' : 'Renews'}
            value={(() => {
              const tier = entitlements.license.tier;
              if (tier === 'lifetime') {
                return entitlements.license.expiresAt
                  ? formatDate(entitlements.license.expiresAt)
                  : 'Never (lifetime)';
              }
              // Monthly / annual: LemonSqueezy ties the license to
              // subscription status, not a hard expiry date. Show the
              // renewal cadence instead of a fake "Never" date.
              if (entitlements.license.expiresAt) return formatDate(entitlements.license.expiresAt);
              if (tier === 'monthly') return 'Monthly (auto-renews)';
              if (tier === 'annual')  return 'Yearly (auto-renews)';
              return '—';
            })()}
          />
          <KeyValue
            label="This device"
            value={entitlements.license.seatFingerprint ? entitlements.license.seatFingerprint.slice(0, 12) + '…' : '—'}
            mono
            help="Anonymous device ID used for seat tracking. We send only this hash, never your hardware UUID."
          />

          <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button className="btn btn-small" type="button" onClick={handleRefresh} disabled={busy}>
              {busy ? 'Working…' : 'Refresh status'}
            </button>
            <button className="btn btn-small btn-ghost" type="button" onClick={handleDeactivate} disabled={busy}>
              Sign out this device
            </button>
            {CUSTOMER_PORTAL_URL && (
              <button
                className="btn btn-small btn-ghost"
                type="button"
                onClick={() => api.openCheckout(CUSTOMER_PORTAL_URL)}
              >Manage subscription</button>
            )}
          </div>
        </div>
      )}

      {!isLicensed && (
        <>
          <div style={{ marginTop: '16px' }}>
            <p style={{ fontSize: '13.5px', lineHeight: 1.6 }}>
              {entitlements.status === 'trial' && (
                <>You're on a free trial — <strong>{entitlements.trial.daysRemaining} days remaining</strong>. Pick a plan now or wait until the trial ends; either way, your library, projects, and tags stay put.</>
              )}
              {entitlements.status === 'trial-expired' && (
                <>Your trial has ended. Subscribe to keep Plugr current — scanning new plugins, checking updates, tagging and editing your library, bulk operations, the DAW-themed palettes, iCloud sync, and CSV export all need an active plan. <strong>Your existing data is still here</strong> — you can browse the snapshot we have on this Mac for free, forever.</>
              )}
              {entitlements.status === 'grace-exceeded' && (
                <>We haven't been able to validate your license for over 30 days. Reconnect and click Refresh below, or paste your key again. If you canceled, no action needed — your existing data stays browsable.</>
              )}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onUpgrade}
              style={{ marginTop: '8px' }}
            >See plans</button>
          </div>

          <h4 style={{ marginTop: '24px', marginBottom: '8px' }}>I already have a license key</h4>
          <form onSubmit={handleActivate} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck="false"
              disabled={busy}
              style={{
                flex: 1,
                minWidth: '260px',
                padding: '8px 12px',
                fontFamily: 'var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                fontSize: '13px',
                letterSpacing: '0.5px',
                borderRadius: '6px',
                border: '1px solid var(--line, rgba(127,127,127,0.25))',
                background: 'var(--bg-2)',
                color: 'var(--text)',
              }}
            />
            <button type="submit" className="btn" disabled={busy || !keyDraft.trim()}>
              {busy ? 'Activating…' : 'Activate'}
            </button>
          </form>
          <p style={{ marginTop: '8px', fontSize: '11.5px', opacity: 0.65 }}>
            Your license key was emailed to you after purchase. Can't find it?
            Check spam, or contact <strong>support@plugr.co</strong>.
          </p>
        </>
      )}

      {lastError && (
        <div style={{
          marginTop: '12px',
          padding: '10px 12px',
          background: 'color-mix(in srgb, var(--bad, #ef6262) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--bad, #ef6262) 50%, transparent)',
          borderRadius: '6px',
          fontSize: '12.5px',
          color: 'var(--text)',
        }}>{lastError}</div>
      )}

      <h4 style={{ marginTop: '24px', marginBottom: '8px' }}>What's always free</h4>
      <ul style={{ fontSize: '13px', lineHeight: 1.7, paddingLeft: '20px' }}>
        <li>Browsing the snapshot of your library and projects as of your last paid day</li>
        <li>The Deals tab — recent sales on plugins and tools from trusted retail partners</li>
        <li>Update <em>checks</em> for up to 100 plugins during the trial (uncapped on paid plans, paused after trial ends)</li>
        <li>Basic themes (Dark / Light / Auto)</li>
        <li>The Tools tab — tap tempo, BPM ↔ delay, Camelot wheel, and the rest</li>
      </ul>

      <h4 style={{ marginTop: '24px', marginBottom: '8px' }}>Managing devices on your license</h4>
      <p style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.85 }}>
        Every paid license — Monthly, Annual, or Lifetime — works on up to <strong>3 active devices</strong> (e.g. studio Mac, laptop, backup). To move your license to a different Mac:
      </p>
      <ul style={{ fontSize: '13px', lineHeight: 1.7, paddingLeft: '20px' }}>
        <li><strong>Still have the old Mac?</strong> Open Plugr there → Help → License → <em>Sign out this device</em>. The seat frees up immediately.</li>
        <li><strong>Don't have access to it?</strong> Click <em>Manage subscription</em> above to open your LemonSqueezy customer portal in a browser. You can see every active device on your license and deactivate any of them remotely.</li>
        <li><strong>Stuck?</strong> Email <strong>support@plugr.co</strong> and we'll free the seat for you.</li>
      </ul>
    </div>
  );
}

function StatusPill({ entitlements }) {
  const map = {
    'licensed':      { label: 'Active',                 tone: 'good' },
    'grace':         { label: 'Active (offline mode)',  tone: 'warn' },
    'trial':         { label: `Free trial — ${entitlements.trial.daysRemaining} day${entitlements.trial.daysRemaining === 1 ? '' : 's'} left`, tone: 'neutral' },
    'trial-expired': { label: 'Trial ended',            tone: 'block' },
    'grace-exceeded':{ label: 'License re-validation failed', tone: 'block' },
  };
  const { label, tone } = map[entitlements.status] || { label: entitlements.status, tone: 'neutral' };
  const colors = {
    good:    { bg: 'color-mix(in srgb, var(--good, #2a9968) 14%, transparent)', fg: 'var(--good, #2a9968)' },
    warn:    { bg: 'color-mix(in srgb, var(--warn, #ffb454) 14%, transparent)', fg: 'var(--warn, #ffb454)' },
    block:   { bg: 'color-mix(in srgb, var(--bad,  #ef6262) 14%, transparent)', fg: 'var(--bad,  #ef6262)' },
    neutral: { bg: 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)', fg: 'var(--accent, #6ec1ff)' },
  }[tone];
  return (
    <span style={{
      display: 'inline-block',
      padding: '4px 12px',
      borderRadius: '999px',
      background: colors.bg,
      color: colors.fg,
      border: `1px solid ${colors.fg}`,
      fontSize: '12px',
      fontWeight: 600,
    }}>{label}</span>
  );
}

function KeyValue({ label, value, mono, help }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px', alignItems: 'baseline' }}>
      <span style={{ opacity: 0.65, fontSize: '12px' }}>{label}</span>
      <span
        title={help}
        style={{
          fontFamily: mono ? 'var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)' : 'inherit',
          fontSize: '12.5px',
          cursor: help ? 'help' : 'default',
          borderBottom: help ? '1px dotted var(--line)' : 'none',
        }}
      >{value}</span>
    </div>
  );
}

function prettyTier(tier) {
  switch (tier) {
    case 'monthly':  return 'Monthly subscription';
    case 'annual':   return 'Annual subscription';
    case 'lifetime': return 'Lifetime';
    default:         return tier || '—';
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}
