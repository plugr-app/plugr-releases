// Audio Plugin Deals scraper.
//
// Two-phase fetch:
//   1. /shop/         → list of product URLs only
//   2. /product/SLUG/ → per-product detail page, parsed via OpenGraph
//                       + product:* meta tags + <del>/<ins> price markup
//
// Why this approach? APD's /shop/ listing tiles are sparse: no real
// description, alt text contains marketing asset names ("box shot
// min"), no struck-through original price. The per-product detail
// pages, by contrast, expose clean structured data via OpenGraph
// (`og:title`, `og:description`, `og:image`, `product:price:amount`,
// `product:price:currency`) which is a published, machine-readable
// contract. Fetching each detail page is N extra HTTP requests, but
// it happens at most once per 24h (cached) so the cost amortizes.
//
// All outbound product URLs are routed through wrapAffiliate so the
// configured ?ref=ID path segment (APD's affiliate link format) is
// applied.

const crypto = require('node:crypto');
const { wrapAffiliate } = require('../affiliateConfig.cjs');

const SOURCE_NAME = 'Audio Plugin Deals';
const BASE_URL = 'https://audioplugin.deals';
const SHOP_URL = `${BASE_URL}/shop/`;
const FETCH_TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
// Don't try to scrape an unbounded number of products. APD's /shop/
// typically lists 15-40 active deals; 40 is plenty for the UI and
// caps the per-refresh fetch budget at 40 detail pages.
const MAX_DEALS = 40;
// Parallel detail-page fetches. 6 keeps APD's server happy while
// finishing a fresh refresh in ~5-10 seconds.
const FETCH_CONCURRENCY = 6;

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────

async function fetchDeals(onProgress) {
  if (onProgress) onProgress({ stage: 'fetching', message: 'Loading /shop/…' });
  let listingHtml;
  try {
    listingHtml = await fetch_(SHOP_URL);
  } catch (err) {
    console.warn(`[deals] ${SOURCE_NAME}: /shop/ fetch failed: ${err.message}`);
    return [];
  }

  const productUrls = extractProductUrls(listingHtml);
  console.log(`[deals] ${SOURCE_NAME}: found ${productUrls.length} product URLs on /shop/`);
  if (productUrls.length === 0) return [];

  // Fetch detail pages in parallel with a concurrency limit. Emit
  // per-product progress as each finishes so the user sees the bar
  // move steadily — N+1 fetches of ~1s each is otherwise an opaque
  // multi-second silence.
  let done = 0;
  const total = productUrls.length;
  if (onProgress) onProgress({ stage: 'fetching', current: 0, total, message: `0 of ${total} products` });
  const results = await parallelMap(productUrls, async (p) => {
    try {
      const detailHtml = await fetch_(p.url);
      const parsed = parseProductDetailPage(detailHtml, p);
      done++;
      // Throttle to avoid flooding the IPC: emit every 3rd product
      // (and always the last one).
      if (onProgress && (done % 3 === 0 || done === total)) {
        onProgress({ stage: 'fetching', current: done, total, message: `${done} of ${total} products` });
      }
      return parsed;
    } catch (err) {
      console.warn(`[deals] ${SOURCE_NAME}: detail fetch failed for ${p.slug}: ${err.message}`);
      done++;
      if (onProgress && (done % 3 === 0 || done === total)) {
        onProgress({ stage: 'fetching', current: done, total, message: `${done} of ${total} products` });
      }
      return null;
    }
  }, FETCH_CONCURRENCY);

  const deals = results.filter((d) => d !== null);
  console.log(`[deals] ${SOURCE_NAME}: ${deals.length} kept after detail-page parsing (${productUrls.length - deals.length} skipped)`);
  return deals.map((d) => ({ ...d, source: SOURCE_NAME }));
}

// ──────────────────────────────────────────────────────────────────
// Fetch helpers
// ──────────────────────────────────────────────────────────────────

async function fetch_(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Run `fn` over `items` with at most `concurrency` in flight at once.
// Preserves index order in the output. Errors per item return null
// (callers should filter falsy results).
async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try { results[i] = await fn(items[i]); }
      catch { results[i] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ──────────────────────────────────────────────────────────────────
// Listing parser — just URL extraction
// ──────────────────────────────────────────────────────────────────

function extractProductUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const urls = [];
  const seen = new Set();
  // Match either absolute (https://audioplugin.deals/product/slug/) or
  // root-relative (/product/slug/) forms. Case-insensitive in case the
  // theme stores them mixed-case anywhere.
  const re = /(?:https?:\/\/audioplugin\.deals)?\/product\/([a-z0-9_\-]+)\/?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    if (slug.length < 2 || slug === 'category' || slug === 'tag') continue;
    seen.add(slug);
    let url = m[0];
    if (url.startsWith('/')) url = BASE_URL + url;
    if (!url.endsWith('/')) url += '/';
    urls.push({ slug, url });
    if (urls.length >= MAX_DEALS) break;
  }
  return urls;
}

// ──────────────────────────────────────────────────────────────────
// Detail-page parser — uses OpenGraph + product:* meta tags
// ──────────────────────────────────────────────────────────────────

function parseProductDetailPage(html, pos) {
  if (!html || typeof html !== 'string') return null;

  // Pull a single meta tag's content by property/name. Case-insensitive.
  const meta = (prop) => {
    const re = new RegExp(
      `<meta\\s+(?:property|name)\\s*=\\s*["']${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s+content\\s*=\\s*["']([^"']*)["']`,
      'i',
    );
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : null;
  };

  // Title — OpenGraph is clean ("June Mega Bundle"), no asset suffixes.
  const title = meta('og:title') || meta('twitter:title') || slugToTitle(pos.slug);

  // Description — OpenGraph or HTML meta description. Both are usually
  // 1-3 sentences and reasonably card-sized.
  const description = meta('og:description') || meta('description') || meta('twitter:description');

  // Image — OpenGraph image is the canonical hero/box-shot at full res
  // (typically 600px), much better than the 300x300 thumbnail in /shop/.
  const imageUrl = meta('og:image') || meta('twitter:image');

  // Sale price + currency from product:* meta tags. APD exposes both.
  const salePriceStr = meta('product:price:amount') || meta('og:price:amount');
  const currency = meta('product:price:currency') || meta('og:price:currency') || 'USD';
  let salePrice = null;
  if (salePriceStr) {
    const sym = currencySymbol(currency);
    salePrice = `${sym}${salePriceStr}`;
  }

  // Regular (struck-through) price — APD wraps it in a <del>...$X</del>
  // and ALSO emits a "Original price was: $X" text snippet, both of
  // which are easy to grep. Try both for robustness across theme tweaks.
  let regularPrice = null;
  const delMatch = html.match(/<del\b[\s\S]*?<\/del>/i);
  if (delMatch) {
    const inner = stripTags(delMatch[0]);
    const m = inner.match(/[$€£¥]\s*\d{1,4}(?:[.,]\d{1,3})*(?:[.,]\d{2})?/);
    if (m) regularPrice = m[0].replace(/\s+/g, '');
  }
  if (!regularPrice) {
    const m = html.match(/Original\s+price\s+was:\s*[$€£¥]?\s*([\d.,]+)/i);
    if (m) regularPrice = `${currencySymbol(currency)}${m[1]}`;
  }

  // Compute discount badge from prices.
  let priceBadge = null;
  if (salePrice && regularPrice) {
    const s = priceNumber(salePrice);
    const r = priceNumber(regularPrice);
    if (s != null && r != null && r > 0 && s < r) {
      const pctOff = Math.round((1 - s / r) * 100);
      if (pctOff >= 5) priceBadge = `${pctOff}% OFF`;
    }
  }
  // Free goods (rare but possible) — represent as "FREE" badge.
  if (!priceBadge && salePriceStr && parseFloat(salePriceStr) === 0) priceBadge = 'FREE';

  // Require ACTUAL discount before including the product. Without this
  // we'd surface regular-priced catalog pages as "deals" (which was the
  // earlier Pigments-at-$199 bug). FREE deals qualify even without a
  // separate regular price.
  const hasDiscount = priceBadge === 'FREE'
    || (salePrice && regularPrice && priceNumber(salePrice) < priceNumber(regularPrice));
  if (!hasDiscount) return null;

  // Deal-ends-in copy: APD shows "Deal ends in: X days" on the detail
  // page. Convert to an absolute ISO timestamp so the renderer's
  // "Ends in Xd" countdown stays accurate.
  let endsAt = null;
  const endsMatch = html.match(/Deal\s+ends\s+in:?[\s\S]{0,200}?(\d+)\s+day/i)
                 || html.match(/(\d+)\s+days?\s+left\b/i);
  if (endsMatch) {
    const days = parseInt(endsMatch[1], 10);
    if (Number.isFinite(days) && days > 0 && days < 365) {
      endsAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }
  }

  const cleanedTitle = cleanTitle(title);
  return {
    id: `apd-${sha1(pos.url).slice(0, 12)}`,
    title: cleanedTitle,
    url: wrapAffiliate(pos.url),
    imageUrl,
    priceBadge,
    publishedAt: null,
    endsAt,
    description: description ? description.slice(0, 280) : null,
    pluginName: cleanedTitle,
    developer: extractDeveloperFromTitle(cleanedTitle),
    salePrice,
    regularPrice,
  };
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function currencySymbol(code) {
  return { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[String(code || '').toUpperCase()] || '$';
}

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function priceNumber(s) {
  if (!s) return null;
  // Strip currency symbols, then thousand-separator commas before 3 digits.
  const cleaned = String(s).replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  return parseFloat(m[1]);
}

// Strips marketing-asset suffixes that occasionally creep into product
// names (mostly from old listings). OpenGraph titles are typically
// already clean — this is here as a safety net.
function cleanTitle(title) {
  if (!title) return '';
  let s = decodeEntities(String(title)).replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s
      .replace(/\s+(box[\s_-]*shot|cover\s*art|product\s*shot|hero\s*image|featured\s*image|logo|thumbnail|thumb|banner|header)\s*$/i, '')
      .replace(/\s+(website|web|site|official|main|primary)\s*$/i, '')
      .replace(/\s+(min|small|medium|large|2x|3x|hires|hi[-_\s]?res)\s*$/i, '')
      .replace(/\s+\d{2,4}x\d{2,4}\s*$/i, '')
      .replace(/\s+\.?(jpe?g|png|gif|webp)\s*$/i, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

function slugToTitle(slug) {
  if (!slug) return '';
  return String(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => {
      const upper = w.toUpperCase();
      if (['OTT', 'EQ', 'AU', 'FX', 'NI', 'CLA', 'JJP', 'PA', 'SSL', 'UAD'].includes(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// Pull developer from common APD title patterns:
//   "Loop Engine 3 by W.A. Production"   → "W.A. Production"
//   "OTT Extreme (Xfer Records)"         → "Xfer Records"
//   "Plugin Name - Vendor Name"          → "Vendor Name"
function extractDeveloperFromTitle(title) {
  if (!title) return null;
  const by = title.match(/\bby\s+(.+?)$/i);
  if (by) return by[1].trim();
  const paren = title.match(/\(([^)]+)\)\s*$/);
  if (paren) return paren[1].trim();
  const dash = title.match(/[-–—]\s*([^-–—]+)$/);
  if (dash && dash[1].trim().split(/\s+/).length <= 4) return dash[1].trim();
  return null;
}

module.exports = {
  fetchDeals,
  // exported for tests
  extractProductUrls,
  parseProductDetailPage,
  parallelMap,
  cleanTitle,
  slugToTitle,
  extractDeveloperFromTitle,
  SOURCE_NAME,
  SHOP_URL,
  BASE_URL,
};
