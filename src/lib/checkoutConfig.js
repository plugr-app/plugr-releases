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
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/d6701527-5e5e-43a7-8679-c38a0d27bba7?enabled=1818415',
  },
  {
    id: 'annual',
    label: 'Annual',
    priceDisplay: '$49',
    cadence: 'per year',
    blurb: 'The default — save 40% vs monthly.',
    badge: 'Best value',
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/210ef268-bf58-4f49-976a-a39454f6f369?enabled=1818417',
  },
  {
    id: 'lifetime',
    label: 'Lifetime',
    priceDisplay: '$149',
    cadence: 'one-time',
    blurb: 'Pay once, own forever. All features available at purchase + future updates of those features.',
    checkoutUrl: 'https://plugr.lemonsqueezy.com/checkout/buy/e4a0cf1b-81ca-4e2b-9406-28d66850a28a?enabled=1818418',
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
