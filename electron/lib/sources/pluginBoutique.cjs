// Plugin Boutique deals scraper.
//
// Pulls https://www.pluginboutique.com/deals-2 and extracts each deal
// block. Each deal is anchored by a URL of the shape
// `/deals/NNNN` (numeric id). For every unique deal URL we find on the
// page we collect the surrounding title, discount %, date range, and
// description.
//
// Returns the normalized Deal shape used by dealsFetcher.cjs (so the
// renderer doesn't have to know whether a deal came from PB, APD, or
// somewhere else).
//
// Note about scraping fragility: Plugin Boutique's HTML may change
// when they redesign. If parsing breaks, the long-term fix is to use
// their official affiliate data feed (CSV/XML), which is available to
// enrolled affiliates via the Post Affiliate Pro dashboard.

const crypto = require('node:crypto');
const { wrapAffiliate } = require('../affiliateConfig.cjs');

const SOURCE_NAME = 'Plugin Boutique';
const BASE_URL = 'https://www.pluginboutique.com';
const DEALS_URL = `${BASE_URL}/deals-2`;
const FETCH_TIMEOUT_MS = 20_000;
// Commercial sites bot-detect on User-Agent. A plain Plugr UA gets a
// 403/empty page from Plugin Boutique. Pose as a recent Safari (which
// is what Electron's renderer also looks like, so this is honest).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
// Don't try to scrape an unbounded number of deals — PB lists ~30 per
// page and that's plenty for the UI.
const MAX_DEALS = 40;

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

// Decode the small handful of HTML entities that appear in PB titles
// and descriptions (named + numeric). Not a real HTML decoder, but
// covers everything we see in deal copy.
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

// Walk the raw HTML and split it into per-deal chunks anchored on the
// first occurrence of each unique /deals/NNNN URL. We then scan each
// chunk for title, discount, date, description.
function parseDealsPage(html) {
  if (!html || typeof html !== 'string') return [];

  // Find every position where a /deals/NNNN URL appears, keep only the
  // FIRST position per unique URL — subsequent occurrences are the
  // duplicate "image" / "See Deal" links inside the same card.
  //
  // Match BOTH absolute (`https://www.pluginboutique.com/deals/12345`)
  // and root-relative (`/deals/12345`) URLs — PB's HTML often uses the
  // relative form internally. We normalize to absolute on the way out
  // so wrapAffiliate sees something it can parse with new URL().
  //
  // Range of the chunk = from this URL's position to the next URL's
  // position (or the end of doc for the last one). Anything inside
  // that range is "this deal's block".
  const positions = [];
  const seen = new Set();
  const urlRe = /(?:https?:\/\/(?:www\.)?pluginboutique\.com)?\/deals\/(\d+)\b/g;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    // Normalize relative URLs to absolute so downstream affiliate-wrap
    // and the renderer's openExternal both receive a proper URL.
    let url = m[0];
    if (url.startsWith('/')) url = BASE_URL + url;
    positions.push({ id, url, at: m.index });
    if (positions.length >= MAX_DEALS) break;
  }
  console.log(`[deals] ${SOURCE_NAME}: parsed page (${html.length} chars), found ${positions.length} unique deal URLs`);

  const deals = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const next = positions[i + 1];
    const chunkStart = p.at;
    const chunkEnd = next ? next.at : Math.min(html.length, p.at + 8_000);
    const chunk = html.slice(chunkStart, chunkEnd);

    deals.push(parseChunk(chunk, p));
  }
  return deals.filter(Boolean);
}

function parseChunk(chunk, pos) {
  // Title — prefer an alt attribute (image links carry the cleanest
  // version), fall back to the first anchor text.
  let title = '';
  const altMatch = chunk.match(/alt\s*=\s*"([^"]+)"/i)
                || chunk.match(/alt\s*=\s*'([^']+)'/i);
  if (altMatch && altMatch[1].trim().length > 3) {
    title = decodeEntities(altMatch[1].trim());
  }
  if (!title) {
    const anchorMatch = chunk.match(/<a[^>]+href\s*=\s*["'][^"']*\/deals\/\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (anchorMatch) title = stripTags(anchorMatch[1]);
  }
  // If we still don't have a title, this chunk isn't usable.
  if (!title) return null;

  // Hero image — prefer the FIRST <img> in the chunk (PB's deal cards
  // lead with the sale banner). Also try data-src for lazy-loaded
  // images. Normalize relative URLs to absolute.
  let imageUrl = null;
  const imgSrc = chunk.match(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i)
              || chunk.match(/<img\b[^>]*?\bdata-src\s*=\s*["']([^"']+)["']/i);
  if (imgSrc) {
    let src = imgSrc[1].trim();
    if (src.startsWith('//')) src = 'https:' + src;
    else if (src.startsWith('/')) src = BASE_URL + src;
    // Skip obvious tracking pixels / placeholders.
    if (!/^data:|spinner|loading|placeholder|1x1/i.test(src)) imageUrl = src;
  }

  // Discount — PB's headline discount is "Up to X% OFF". Prefer that
  // over any bare "X% off" mention because the chunk often contains
  // multiple percentages (e.g. "save 25% on most items, up to 92% off
  // on bundles" — we want 92, not 25). Fall back to bare "X% OFF" if
  // the "Up to" form isn't present.
  let priceBadge = null;
  const upTo = chunk.match(/Up\s+to\s*[<\/\w\s"'=>-]*?(\d{1,3})\s*%\s*OFF/i);
  if (upTo) priceBadge = `${upTo[1]}% OFF`;
  if (!priceBadge) {
    const pct = chunk.match(/(\d{1,3})\s*%\s*OFF/i);
    if (pct) priceBadge = `${pct[1]}% OFF`;
  }
  // FREE — PB occasionally features a free download / free bundle.
  if (!priceBadge && /\bfree\b/i.test(title)) priceBadge = 'FREE';

  // Date range — looks like "03 Jun - June 09, 2026". Optional.
  let endsAt = null;
  const dateMatch = chunk.match(/(\d{1,2})\s+(\w{3,9})\s*[-–—]\s*(\w{3,9})\s+(\d{1,2}),\s+(\d{4})/);
  if (dateMatch) {
    const end = `${dateMatch[3]} ${dateMatch[4]}, ${dateMatch[5]}`;
    const t = Date.parse(end);
    if (!Number.isNaN(t)) endsAt = new Date(t).toISOString();
  }

  // Description — the longest <p>...</p> block we can find in the chunk.
  // PB wraps deal copy in a paragraph after the title and discount.
  let description = null;
  const paragraphs = [...chunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((mm) => stripTags(mm[1]))
    .filter((s) => s.length > 20);
  if (paragraphs.length > 0) {
    paragraphs.sort((a, b) => b.length - a.length);
    description = paragraphs[0].slice(0, 280);
  }

  return {
    id: `pb-${pos.id}`,
    title,
    url: wrapAffiliate(pos.url),
    imageUrl,
    priceBadge,
    publishedAt: null,    // PB doesn't expose a per-deal start in HTML
    endsAt,
    description,
    pluginName: extractPluginNameFromTitle(title),
    developer: extractDeveloperFromTitle(title),
  };
}

// PB titles look like "FabFilter IMSTA FESTA Sale" or "XLN Audio
// Manufacturer Focus Sale" or "UJAM LoFi Bundle Make Music Month Sale"
// — the developer is almost always the first 1–3 words. We grab a
// best-guess token; the matcher uses fuzzy match anyway.
function extractDeveloperFromTitle(title) {
  if (!title) return null;
  // Strip everything from "Sale"/"Bundle"/"Deal" onward.
  const cleaned = title.replace(/\s+(sale|bundle|deal|deals|update|updates|promo|offer|focus|month|exclusive|focus\s+sale).*/i, '').trim();
  if (cleaned.length < 3) return null;
  // Heuristic: first 1–2 words is usually the developer / manufacturer.
  // "FabFilter IMSTA FESTA" → "FabFilter"; "Plugin Alliance & Brainworx" → "Plugin Alliance".
  const tokens = cleaned.split(/\s+/);
  if (tokens.length === 1) return tokens[0];
  // If the second word starts uppercase and isn't a common product word,
  // treat the first two words as the developer name.
  const t1 = tokens[0], t2 = tokens[1];
  if (/^[A-Z]/.test(t2) && !/^(Pro|Studio|Master|Mix|Drum|Bass|Synth|Vocal)/i.test(t2)) {
    return `${t1} ${t2}`;
  }
  return t1;
}

function extractPluginNameFromTitle(title) {
  if (!title) return null;
  // For PB deal titles, the developer comes first; everything between
  // developer and "Sale/Bundle" is roughly the product. This is a
  // best-effort lookup — matching falls back to fuzzy title scan.
  return title.replace(/\s+(sale|bundle|deal|deals|promo|offer|focus\s+sale|exclusive).*/i, '').trim() || title;
}

// Fetch pages 1–3 in parallel and merge. PB lists ~15 deals per page
// of /deals-2; three pages gives us ~45 in flight at any time, which
// covers virtually everything currently on sale without hammering the
// server. Each page is allowed to fail independently — empty array
// for that page, others still contribute.
const MAX_PAGES = 3;

async function fetchDeals(onProgress) {
  const pageUrls = [DEALS_URL];
  for (let p = 2; p <= MAX_PAGES; p++) pageUrls.push(`${DEALS_URL}?page=${p}`);

  let pagesDone = 0;
  if (onProgress) onProgress({ stage: 'fetching', current: 0, total: pageUrls.length, message: `Fetching ${pageUrls.length} pages…` });

  const results = await Promise.all(pageUrls.map(async (url, idx) => {
    try {
      const html = await fetch_(url);
      const items = parseDealsPage(html);
      console.log(`[deals] ${SOURCE_NAME} page ${idx + 1}: ${items.length} deals`);
      pagesDone++;
      if (onProgress) onProgress({ stage: 'fetching', current: pagesDone, total: pageUrls.length, message: `Page ${pagesDone} of ${pageUrls.length}` });
      return items;
    } catch (err) {
      console.warn(`[deals] ${SOURCE_NAME} page ${idx + 1} failed: ${err.message}`);
      pagesDone++;
      if (onProgress) onProgress({ stage: 'fetching', current: pagesDone, total: pageUrls.length, message: `Page ${pagesDone} of ${pageUrls.length} (failed)` });
      return [];
    }
  }));

  // Dedup by deal id across pages (later pages occasionally repeat
  // featured items from page 1).
  const seen = new Set();
  const merged = [];
  for (const list of results) {
    for (const d of list) {
      const key = d.id || d.url;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
  }

  console.log(`[deals] ${SOURCE_NAME}: returning ${merged.length} deals (across ${pageUrls.length} pages)`);
  return merged.map((d) => ({
    ...d,
    source: SOURCE_NAME,
    id: d.id || sha1(d.url).slice(0, 16),
  }));
}

module.exports = {
  fetchDeals,
  // exported for tests
  parseDealsPage,
  parseChunk,
  SOURCE_NAME,
  DEALS_URL,
};
