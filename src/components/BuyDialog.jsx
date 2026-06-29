import React from 'react';
import { CHECKOUT_TIERS, LIFETIME_LAUNCH_DISCOUNT } from '../lib/checkoutConfig.js';

// Buy / upgrade modal. Shown when:
//   - User clicks "Upgrade" / "Subscribe" in the TrialBanner.
//   - User tries to use a locked feature.
//   - User opens it from Help → License → "Upgrade".
//
// Three tier cards side-by-side: Monthly / Annual / Lifetime. Each
// opens its LemonSqueezy checkout URL in the user's default browser
// via the IPC bridge (`window.pluginHub.openCheckout(url)`).
//
// If the checkout URLs aren't set up yet (CHECKOUT_TIERS[*].checkoutUrl
// is empty), we show a clear "Setup pending" state instead of broken
// buttons — Josh can ship the binary before LemonSqueezy is configured
// and the UI still reads sensibly.
//
// Props:
//   onClose — close the modal
//   onOpenCheckout(tier) — receives the tier object; default impl just
//     calls `window.pluginHub.openCheckout(tier.checkoutUrl)`. Passed
//     as a prop so the parent can also push a toast / track conversions.

export default function BuyDialog({ onClose, onOpenCheckout }) {
  const launchOffer = LIFETIME_LAUNCH_DISCOUNT && LIFETIME_LAUNCH_DISCOUNT.discountedPrice
    ? LIFETIME_LAUNCH_DISCOUNT
    : null;
  // Hide the launch offer once its expiry passes — saves us from
  // shipping a future build with stale "Limited time!" copy.
  const launchOfferActive = launchOffer
    && (!launchOffer.expiresAt || new Date(launchOffer.expiresAt).getTime() > Date.now());

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade Plugr"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '760px', maxWidth: '100%', maxHeight: 'calc(100vh - 60px)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-1)',
          border: '1px solid var(--line, rgba(127,127,127,0.18))',
          borderRadius: '12px',
          boxShadow: 'var(--shadow, 0 12px 36px rgba(0,0,0,0.45))',
          color: 'var(--text)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 24px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '-0.2px' }}>Upgrade Plugr</div>
            <div style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px', maxWidth: '500px' }}>
              Pick a plan that fits. Your library, projects, notes, ratings,
              and tags carry across whichever plan you pick.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'inherit',
              opacity: 0.6, cursor: 'pointer', fontSize: '24px',
              padding: '0 4px', lineHeight: 1,
            }}
          >×</button>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
          padding: '12px 24px 20px',
          overflowY: 'auto',
        }}>
          {CHECKOUT_TIERS.map((tier) => (
            <TierCard
              key={tier.id}
              tier={tier}
              launchOffer={tier.id === 'lifetime' && launchOfferActive ? launchOffer : null}
              onBuy={() => onOpenCheckout && onOpenCheckout(tier)}
            />
          ))}
        </div>

        <div style={{
          padding: '12px 24px 18px',
          borderTop: '1px solid var(--line, rgba(127,127,127,0.18))',
          fontSize: '11.5px',
          opacity: 0.65,
          lineHeight: 1.5,
        }}>
          Payment handled by LemonSqueezy (merchant of record). All plans
          come with a 14-day refund window — email{' '}
          <strong>support@plugr.co</strong> within 14 days and we'll
          refund, no questions. The Deals tab and read-only library
          browsing stay free even after your trial ends.
        </div>
      </div>
    </div>
  );
}

function TierCard({ tier, launchOffer, onBuy }) {
  const configured = !!(tier.checkoutUrl && tier.checkoutUrl.startsWith('http'));
  return (
    <div style={{
      position: 'relative',
      padding: '16px 16px 18px',
      background: 'var(--bg-2)',
      border: `1px solid ${tier.badge ? 'var(--accent, #6ec1ff)' : 'var(--line, rgba(127,127,127,0.18))'}`,
      borderRadius: '10px',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {tier.badge && (
        <div style={{
          position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--accent, #6ec1ff)',
          color: 'var(--bg-0)',
          padding: '2px 10px',
          borderRadius: '999px',
          fontSize: '10.5px',
          fontWeight: 700,
          letterSpacing: '0.3px',
          textTransform: 'uppercase',
        }}>{tier.badge}</div>
      )}
      <div style={{ fontSize: '13px', fontWeight: 600, opacity: 0.7, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
        {tier.label}
      </div>
      <div style={{ marginTop: '8px', display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        {launchOffer ? (
          <>
            <span style={{ fontSize: '14px', textDecoration: 'line-through', opacity: 0.5 }}>{launchOffer.strikethroughPrice}</span>
            <span style={{ fontSize: '28px', fontWeight: 700 }}>{launchOffer.discountedPrice}</span>
          </>
        ) : (
          <span style={{ fontSize: '28px', fontWeight: 700 }}>{tier.priceDisplay}</span>
        )}
        <span style={{ fontSize: '12px', opacity: 0.65 }}>{tier.cadence}</span>
      </div>
      {launchOffer && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--accent, #6ec1ff)', fontWeight: 600 }}>
          Launch offer
        </div>
      )}
      <div style={{ marginTop: '12px', fontSize: '12.5px', opacity: 0.85, lineHeight: 1.5, flex: 1 }}>
        {tier.blurb}
      </div>
      <button
        type="button"
        onClick={configured ? onBuy : undefined}
        disabled={!configured}
        style={{
          marginTop: '16px',
          padding: '10px',
          width: '100%',
          background: configured ? 'var(--accent, #6ec1ff)' : 'var(--bg-3)',
          color: configured ? 'var(--bg-0)' : 'var(--muted)',
          border: 'none',
          borderRadius: '6px',
          fontSize: '13px',
          fontWeight: 600,
          cursor: configured ? 'pointer' : 'not-allowed',
          opacity: configured ? 1 : 0.6,
        }}
      >
        {configured ? `Get ${tier.label}` : 'Setup pending'}
      </button>
      {!configured && (
        <div style={{ marginTop: '8px', fontSize: '10.5px', opacity: 0.55, textAlign: 'center' }}>
          Plugr's payment processor isn't connected yet. Check back soon.
        </div>
      )}
    </div>
  );
}
