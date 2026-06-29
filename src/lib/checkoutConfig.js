// Configuration for the LemonSqueezy checkout flow.
//
// Each tier has:
//   - id: matches the `tier` field returned by license.cjs after
//     activation (so we can highlight the user's current tier in UI).
//   - label / priceDisplay / cadence: cosmetic text for the buy cards.
//   - checkoutUrl: the LemonSqueezy "Buy now" hosted checkout link.
//     **Fill these in from your LemonSqueezy dashboard before going
//     live.** Until then they're empty strings; the UI shows a
//     "Setup pending" placeholder so we don't ship a broken button.
//
// How to fill in:
//   1. LemonSqueezy → Products → click your Plugr product.
//   2. Click the "Variants" section; each variant (monthly / annual /
//      lifetime) has its own "Share" button → "Checkout link".
//   3. Paste the resulting URL into the matching `checkoutUrl` below.
//   4. While you're there, copy each variant's numeric ID (visible in
//      the URL bar) into PRODUCT_VARIANT_TO_TIER inside
//      electron/lib/license.cjs so server responses get tier-typed
//      correctly post-activation.

export const CHECKOUT_TIERS = [
  {
    id: 'monthly',
    label: 'Monthly',
    priceDisplay: '$7',
    cadence: 'per month',
    blurb: 'Try it for a month, cancel anytime.',
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/fb836312-b7ef-4185-a9ab-0ad3b974a1fa?enabled=1851090',
  },
  {
    id: 'annual',
    label: 'Annual',
    priceDisplay: '$49',
    cadence: 'per year',
    blurb: 'The default — save 40% vs monthly.',
    badge: 'Best value',
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/3d0415fb-4bc3-4329-934b-a47635c517ac?enabled=1851103',
  },
  {
    id: 'lifetime',
    label: 'Lifetime',
    priceDisplay: '$149',
    cadence: 'one-time',
    blurb: 'Pay once, own forever. All features available at purchase + future updates of those features.',
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/9831e89b-745f-4b0e-be3a-fa53280aac30?enabled=1851105',
  },
];

// Optional launch-window discount: when set, the lifetime card shows a
// strikethrough price + the discounted price. Set to null to disable.
export const LIFETIME_LAUNCH_DISCOUNT = {
  // strikethroughPrice: '$149',
  // discountedPrice:    '$99',
  // expiresAt:          '2026-08-01T00:00:00Z',   // ISO string; UI hides the offer past this date
};

// LemonSqueezy customer portal. LS delivers per-customer portal links
// via email magic-link rather than exposing a single global URL — so
// this points at the store's "My Orders" page where any customer can
// type their email to get a fresh magic link back to their order
// management (cancel sub, swap payment method, etc.).
export const CUSTOMER_PORTAL_URL = 'https://plugr.lemonsqueezy.com/my-orders';

export function isCheckoutConfigured() {
  return CHECKOUT_TIERS.some((t) => t.checkoutUrl && t.checkoutUrl.startsWith('http'));
}
