// Affiliate ID configuration for the Deals tab.
//
// Plugr scrapes deals from real retailers (Plugin Boutique, Audio Plugin
// Deals, etc.) and routes every outbound click through these affiliate
// programs so purchases generate a commission for the app maintainer.
// Until each ID is filled in, links work normally but earn nothing.
//
// ──────────────────────────────────────────────────────────────────────
// HOW TO ENROLL
// ──────────────────────────────────────────────────────────────────────
//
// Plugin Boutique
//   1. Visit https://pluginboutique.postaffiliatepro.com/affiliates/signup.php
//   2. Approval typically takes a few business days.
//   3. After approval, log in to the Post Affiliate Pro dashboard and copy
//      your affiliate ID (the value passed as `a_aid` in tracking links).
//   4. Paste it below as PLUGIN_BOUTIQUE.affiliateId.
//
// Audio Plugin Deals
//   1. Visit https://audioplugin.deals/  → footer → "Affiliates" link.
//   2. They run their program in-house. Once approved you'll receive a
//      tracking parameter (usually `?ref=YOURID` or similar — confirm
//      the exact parameter name when you receive your approval email).
//   3. Set AUDIO_PLUGIN_DEALS.affiliateId and AUDIO_PLUGIN_DEALS.paramName
//      below to whatever they assign.
//
// ──────────────────────────────────────────────────────────────────────
// FTC DISCLOSURE
// ──────────────────────────────────────────────────────────────────────
//
// United States affiliates are required by the FTC to clearly disclose
// affiliate relationships. The Deals tab shows a small footer line
// ("Plugr earns a commission from purchases made via these links")
// any time at least one source below has a non-null affiliateId.
// Do not remove that footer — it's a legal requirement, not an
// aesthetic choice.

const PLUGIN_BOUTIQUE = {
  // null = no affiliate tracking yet, links work but earn nothing.
  // Fill in after Post Affiliate Pro approval.
  affiliateId: null,
  // Query-string tracking: ?a_aid=ID
  trackingStyle: 'query',
  // Query parameter name. Post Affiliate Pro's default is `a_aid`.
  // Confirm in your dashboard before going live.
  paramName: 'a_aid',
  // Hostnames that should receive the affiliate param. Click-throughs
  // from this source land on pluginboutique.com; we only stamp our
  // tracking on URLs we know belong to the program.
  domains: ['pluginboutique.com', 'www.pluginboutique.com'],
};

const AUDIO_PLUGIN_DEALS = {
  // Set to the user's confirmed affiliate id. APD provides links of the
  // shape https://audioplugin.deals/ref/<id>/ — append /ref/<id>/ to any
  // product URL to get tracked credit on purchases.
  affiliateId: '444',
  // Path-segment tracking: /product/X/ → /product/X/ref/<id>/
  trackingStyle: 'path',
  // Path prefix that precedes the id. Combined with affiliateId this
  // becomes `/ref/444/`. Some affiliate plugins use different prefixes
  // (e.g. /aff/ or /a/), so this is configurable per source.
  pathPrefix: 'ref',
  domains: ['audioplugin.deals'],
};

// Single source of truth for "do we currently earn commission anywhere".
// DealsView checks this to decide whether to render the FTC disclosure.
function hasAnyAffiliateId() {
  return Boolean(PLUGIN_BOUTIQUE.affiliateId || AUDIO_PLUGIN_DEALS.affiliateId);
}

// Append the right affiliate identifier to a URL, if its hostname matches
// any configured source AND that source has an affiliateId set. Two
// styles supported:
//   'query' — appends ?paramName=affiliateId   (e.g. Post Affiliate Pro)
//   'path'  — appends /pathPrefix/affiliateId/ (e.g. APD's /ref/444/ scheme)
// Returns the URL unchanged on bad input or no matching configured source.
function wrapAffiliate(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = u.hostname.toLowerCase();

  for (const cfg of [PLUGIN_BOUTIQUE, AUDIO_PLUGIN_DEALS]) {
    if (!cfg.affiliateId) continue;
    if (!cfg.domains.some((d) => host === d || host.endsWith('.' + d))) continue;

    if (cfg.trackingStyle === 'query') {
      // Don't overwrite an existing param — respects any deeper-link
      // tracking the source page might have already stamped.
      if (u.searchParams.has(cfg.paramName)) return u.toString();
      u.searchParams.set(cfg.paramName, cfg.affiliateId);
      return u.toString();
    }

    if (cfg.trackingStyle === 'path') {
      // Insert /pathPrefix/affiliateId/ before any query/hash, after
      // the existing path. Avoid double-stamping if it's already there.
      const segments = u.pathname.split('/').filter(Boolean);
      const prefixIdx = segments.indexOf(cfg.pathPrefix);
      if (prefixIdx !== -1 && segments[prefixIdx + 1] === cfg.affiliateId) {
        return u.toString();
      }
      // Append the affiliate segment to the path (trailing slash preserved).
      segments.push(cfg.pathPrefix, cfg.affiliateId);
      u.pathname = '/' + segments.join('/') + '/';
      return u.toString();
    }
  }
  return rawUrl;
}

module.exports = {
  PLUGIN_BOUTIQUE,
  AUDIO_PLUGIN_DEALS,
  wrapAffiliate,
  hasAnyAffiliateId,
};
