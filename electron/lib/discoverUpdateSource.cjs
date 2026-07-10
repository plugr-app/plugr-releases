// Auto-discovery of update sources for plugins marked "No source".
//
// Given a plugin (name, developer, registry entry), this module:
//   1. Builds a list of candidate URLs to try (homepage, downloads page,
//      common /products and /downloads derivatives).
//   2. For each URL, fetches the HTML and looks for the plugin name on the
//      page, then searches for a version pattern nearby.
//   3. If no candidate URL hits, scans the homepage for relevant outgoing
//      links (product pages) and tries those.
//   4. Returns the best result it could find, including a generated
//      versionRegex the registry can use directly.
//
// We're polite: short timeouts, capped page count, no aggressive crawling.

const semver = require('semver');

// Tightened from 12s to 5s. Real product pages respond in < 2s; anything
// slower is almost certainly a hung connection that's never going to give
// us anything useful, and 12 × 11 candidate URLs × thousands of plugins
// turns into a literal day of wall time.
const FETCH_TIMEOUT_MS = 5000;
const MAX_LINK_FOLLOW = 3;
// HTTP fetch goes through Electron's net.request (Chromium's HTTP
// stack — same as a real browser tab) when available. Falls back to
// global fetch() for tests. See httpFetch.cjs for why this matters.
const { httpGet, UA } = require('./httpFetch.cjs');

// ---------- HTTP ----------

async function fetchOnce(url) {
  return httpGet(url, { timeoutMs: FETCH_TIMEOUT_MS, redirect: 'follow' });
}

// Fetch the URL. If the server hard-404s on a bare path (which some
// WordPress sites do — e.g. aom-factory.jp/products/stereo-imager-d
// returns 404 but stereo-imager-d/ works), retry once with a trailing
// slash before giving up. Skipped when the URL already ends in "/" or
// when it has a query string / fragment (appending a slash there would
// break the URL).
async function fetchText(url) {
  let res = await fetchOnce(url);
  const eligibleForSlashRetry = res.status === 404
    && !url.endsWith('/')
    && !url.includes('?')
    && !url.includes('#');
  if (eligibleForSlashRetry) {
    try {
      const retry = await fetchOnce(url + '/');
      if (retry.ok) res = retry;
    } catch { /* fall through, original 404 wins */ }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ---------- URL planning ----------

function collectCandidateUrls(item) {
  const list = [];
  const reg = item.registry || {};

  // When the user has explicitly entered a URL to test (manualHomepage),
  // honour ONLY that URL and its slug-derived children. Skip reg.updateUrl
  // and reg.downloadsUrl entirely — they represent the OLD (possibly wrong)
  // source and must not win over what the user typed. This is what makes
  // "Re-test" actually test the URL the user entered rather than
  // silently reverting to the previously-saved source.
  if (item.manualHomepage) {
    const base = item.manualHomepage.replace(/\/$/, '');
    const slug = nameToSlug(item.name);
    list.push(item.manualHomepage);
    if (slug) list.push(`${base}/products/${slug}`);
    if (slug) list.push(`${base}/${slug}`);
    list.push(`${base}/downloads`);
    const seen = new Set();
    return list.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  }

  // Normal auto-discovery path (no manual URL): try the registry's known
  // update/downloads URL first, then derive from the homepage.
  if (reg.updateUrl) list.push(reg.updateUrl);
  if (reg.downloadsUrl) list.push(reg.downloadsUrl);

  // Trimmed to the four highest-yield URL shapes per homepage. Trying
  // every possible /support, /changelog, /release-notes guess used to
  // multiply the wall time without finding much that the homepage and
  // the slug-product-page didn't already give us.
  if (reg.homepage) {
    const base = reg.homepage.replace(/\/$/, '');
    const slug = nameToSlug(item.name);
    list.push(reg.homepage);
    if (slug) list.push(`${base}/products/${slug}`);
    if (slug) list.push(`${base}/${slug}`);
    list.push(`${base}/downloads`);
  }
  const seen = new Set();
  return list.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

function nameToSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Produce a small ordered list of slug candidates for a plugin name.
 * Different vendors slugify names differently — the strict slug
 * (dashes between every alphanumeric chunk) is right most of the
 * time but breaks for cases like:
 *   "Comp FET-76"  → strict "comp-fet-76", Arturia uses "comp-fet76"
 *   "ARP 2600 V"   → strict "arp-2600-v", some sites use "arp2600-v"
 *   "Pro-Q 3"      → strict "pro-q-3", some sites use "proq3"
 *
 * The variations we generate, in priority order:
 *   1. strict          ("comp-fet-76")
 *   2. number-glued    ("comp-fet76")   — drop dashes between letters & digits
 *   3. all-collapsed   ("compfet76")    — drop every dash
 * Duplicates are removed so identical-name cases (like "Pigments")
 * only try once.
 */
/**
 * Produce variants of the plugin name with trailing version markers
 * stripped off. Used by URL slug derivation AND page-mention checks
 * so a plugin called "CS-80 V3" still finds Arturia's stable URL
 * (.../product/cs-80v) and accepts the page even though it now shows
 * "CS-80 V4".
 *
 * Variants are returned in order of specificity (most → least), and
 * deduped against the original. So:
 *   "CS-80 V3"   → ["CS-80 V3", "CS-80 V"]
 *   "Mini V3"    → ["Mini V3", "Mini V"]
 *   "ARP 2600 V" → ["ARP 2600 V", "ARP 2600"]
 *   "Pro-Q 3"    → ["Pro-Q 3", "Pro-Q"]
 *   "Pigments"   → ["Pigments"]
 */
function nameVariants(s) {
  const name = String(s || '').trim();
  if (!name) return [];
  const out = [name];
  // Strip trailing " V<digits>" → keep " V"
  const v1 = name.replace(/\s+V\d+\s*$/i, ' V').replace(/\s+/g, ' ').trim();
  if (v1 && v1 !== name && !out.includes(v1)) out.push(v1);
  // Strip trailing " V" entirely
  const v2 = name.replace(/\s+V\s*$/i, '').trim();
  if (v2 && v2 !== name && !out.includes(v2)) out.push(v2);
  // Strip trailing bare " <digits>"
  const v3 = name.replace(/\s+\d+\s*$/i, '').trim();
  if (v3 && v3 !== name && !out.includes(v3)) out.push(v3);
  // After v1's " V", also try its bare form (CS-80 V3 → CS-80 V → CS-80)
  const v4 = v1.replace(/\s+V\s*$/i, '').trim();
  if (v4 && v4 !== name && !out.includes(v4)) out.push(v4);
  // Strip standalone 1-2 digit numbers anywhere in the name. These are
  // almost always version markers ("Ozone 8 Dynamic EQ", "Pro-Q 3",
  // "Studio One 6") rather than model numbers — which conventionally
  // use 3+ digits (ARP 2600, TR-808) or are attached to letters
  // (CS-80, EQ8, M12). The boundary requirement (whitespace or
  // start/end on both sides, with optional V prefix) means we DON'T
  // strip 2600 (4 digits, not 1-2), 80 in CS-80 (attached to "-"),
  // or 8 in EQ8 (attached to "Q").
  const v5 = name
    .replace(/(^|\s)V?\d{1,2}(\s|$)/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (v5 && v5 !== name && !out.includes(v5)) out.push(v5);
  return out;
}

// Given a strict slug like "cs-80-v", emit all the variants that
// collapse some subset of its letter↔digit boundaries:
//   cs-80-v →  cs-80-v   (no collapse)
//              cs80-v    (left boundary only)
//              cs-80v    (right boundary only)
//              cs80v     (both)
// "comp-fet-76" → comp-fet-76, comp-fet76 (no digit-letter boundary on right)
// "arp-2600-v"  → arp-2600-v, arp2600-v, arp-2600v, arp2600v
// We bound the boundary count to keep the result small (most slugs
// have 0-2 boundaries; pathological cases stop after the first 5).
// Inverse of enumerateBoundaryCollapses. Given a slug like "svt3pro"
// with letter↔digit adjacencies but NO dashes there, emit variants
// with dashes inserted at each subset of those positions:
//   svt3pro → svt3pro (no insert), svt-3pro (left), svt3-pro (right),
//             svt-3-pro (both)
// Plugin Alliance does this in URLs like /products/svt-3pro for
// "Ampeg SVT3Pro" (split between letters and the leading digit) while
// other vendors split differently. We enumerate all subsets so we
// always have the form the vendor used.
function enumerateBoundaryInsertions(strict) {
  if (!strict) return [strict];
  const positions = [];
  for (let i = 1; i < strict.length; i++) {
    const prev = strict[i - 1];
    const cur = strict[i];
    if (prev === '-' || cur === '-') continue;
    const isBoundary =
      (/[a-z]/.test(prev) && /\d/.test(cur)) ||
      (/\d/.test(prev) && /[a-z]/.test(cur));
    if (isBoundary) positions.push(i);
    if (positions.length >= 5) break;
  }
  if (positions.length === 0) return [strict];
  const out = new Set([strict]);
  const total = 1 << positions.length;
  for (let mask = 1; mask < total; mask++) {
    let result = '';
    for (let i = 0; i < strict.length; i++) {
      const posIdx = positions.indexOf(i);
      if (posIdx >= 0 && (mask & (1 << posIdx))) result += '-';
      result += strict[i];
    }
    out.add(result);
  }
  return [...out];
}

function enumerateBoundaryCollapses(strict) {
  // Find positions of dashes that separate a letter from a digit OR
  // a digit from a letter.
  const boundaries = [];
  for (let i = 0; i < strict.length; i++) {
    if (strict[i] !== '-') continue;
    const before = strict[i - 1];
    const after = strict[i + 1];
    if (!before || !after) continue;
    const isBoundary =
      (/[a-z]/.test(before) && /\d/.test(after)) ||
      (/\d/.test(before) && /[a-z]/.test(after));
    if (isBoundary) boundaries.push(i);
    if (boundaries.length >= 5) break;
  }
  const out = new Set([strict]);
  // Enumerate every subset of boundaries to collapse. For N boundaries,
  // 2^N variants. We capped N at 5 so worst case is 32 variants.
  const total = 1 << boundaries.length;
  for (let mask = 1; mask < total; mask++) {
    let result = '';
    for (let i = 0; i < strict.length; i++) {
      if (strict[i] === '-') {
        const bIdx = boundaries.indexOf(i);
        if (bIdx >= 0 && (mask & (1 << bIdx))) continue;   // skip this dash
      }
      result += strict[i];
    }
    out.add(result);
  }
  return [...out];
}

function nameToSlugCandidates(s) {
  const strict = nameToSlug(s);
  if (!strict) return [];

  // Helper: produce per-token-collapsed form ("Comp TUBE-STA"
  // → "comp-tubesta") by splitting on whitespace, stripping internal
  // non-alphanumerics per word, joining with dashes.
  function tokenCollapse(v) {
    return String(v).toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
      .join('-');
  }

  const out = [];
  function addAll(arr) {
    for (const c of arr) {
      if (c && c.length >= 2 && !out.includes(c)) out.push(c);
    }
  }

  // For each name variant (including the original), generate:
  //   1. strict slug
  //   2. all letter↔digit boundary collapse subsets (handles
  //      "cs-80-v" → "cs-80v", "cs80-v", "cs80v" — including the
  //      single-boundary collapses that vendor URLs often want)
  //   3. token-collapsed (whitespace-respecting collapse, for
  //      names like "Comp TUBE-STA" → "comp-tubesta")
  //   4. all-dashes-collapsed
  //   5. REVERSED-word-order variants for 2-word names (Arturia
  //      sometimes ships URLs as "/product/m12-filter" for a plugin
  //      named "Filter M12"). Also feeds all the same transformations
  //      so we cover "m12-filter" AND "m12filter".
  const variants = nameVariants(s);
  function emitFor(label) {
    const stricter = nameToSlug(label);
    if (!stricter || stricter.length < 2) return;
    addAll(enumerateBoundaryCollapses(stricter));
    addAll(enumerateBoundaryInsertions(stricter));
    addAll([tokenCollapse(label)]);
    addAll([stricter.replace(/-/g, '')]);
  }
  for (const v of variants) {
    emitFor(v);
    const words = String(v).trim().split(/\s+/).filter(Boolean);
    // Reversed-word form: only meaningful when the name has exactly
    // two whitespace-separated tokens. With more tokens, blind reversal
    // produces too many low-value candidates.
    if (words.length === 2) {
      emitFor(words.slice().reverse().join(' '));
    }
    // Sub-brand-prefix stripping: many distributors prepend a brand
    // word that doesn't appear in product URLs.
    //   "Acme Opticom XLA-3" → "/products/opticom-xla-3" (PA)
    //   "ADA Flanger" → "/products/flanger" (PA)
    //   "BX Console SSL" → "/products/console-ssl" (PA)
    // For 2+ word names, also emit slugs derived from name minus the
    // leading word, and (less common but useful) minus the trailing
    // word. Without this, deriveUrlTemplate can't find the slug in a
    // URL like /products/flanger because none of the strict / collapsed
    // forms of "ADA Flanger" appear there.
    if (words.length >= 2) {
      emitFor(words.slice(1).join(' '));    // drop first word
      emitFor(words.slice(0, -1).join(' ')); // drop last word
    }
  }
  return out;
}

/**
 * Build a URL template by replacing the path segment containing the
 * plugin's slug with `{slug}`. Returns null if the slug doesn't appear
 * in any path segment (which means the URL is a generic homepage and
 * there's no template worth deriving).
 *
 * Examples:
 *   ('https://www.fabfilter.com/products/pro-q-3-equalizer-plug-in', 'Pro-Q 3')
 *      → 'https://www.fabfilter.com/products/{slug}'
 *   ('https://example.com/pro-q-3', 'Pro-Q 3')
 *      → 'https://example.com/{slug}'
 *   ('https://acme.io/foo/pro-q-3/v3', 'Pro-Q 3')
 *      → 'https://acme.io/foo/{slug}/v3'   (only the matching segment changes)
 *   ('https://example.com/about', 'Pro-Q 3')
 *      → null   (slug not in path)
 *
 * The "whole-path-segment replacement" matters because most product URLs
 * include a marketing description after the slug ("-equalizer-plug-in",
 * "-compressor", "-the-best-reverb-ever") that's specific to that one
 * product. Using just the slug as the template would fail for siblings.
 */
function deriveUrlTemplate(url, name) {
  if (!url || !name) return null;
  // Try every slug variation we know about. Without this, a URL saved
  // using a collapsed slug like "comp-fet76" wouldn't match the strict
  // slug "comp-fet-76" and template derivation would falsely report
  // "the plugin's name isn't in the URL." Each variation is checked
  // against every path segment; the first match wins. We sort by
  // length DESC so longer slugs (more specific) win over shorter
  // ones — e.g. for "Mini V" we'd rather match "mini-v" than "miniv"
  // even if both happen to appear in the path.
  const candidates = nameToSlugCandidates(name).sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return null;
  // Match the URL into protocol+host, path, and query/hash so we can do
  // segment replacement in the path without url-encoding the curly braces.
  const m = url.match(/^([^:]+:\/\/[^\/?#]+)(\/[^?#]*)?(.*)$/);
  if (!m) return null;
  const origin = m[1];
  const pathname = m[2] || '/';
  const tail = m[3] || '';
  const segments = pathname.split('/');

  for (const slug of candidates) {
    if (!slug || slug.length < 2) continue;
    for (let i = 0; i < segments.length; i++) {
      // Normalize URL segment same way as nameToSlug (non-alnum → dash)
      // so "bx_bassdude" matches the slug "bx-bassdude".
      const seg = segments[i].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (seg === slug || seg.startsWith(slug + '-') || seg.endsWith('-' + slug) || seg.includes('-' + slug + '-')) {
        const segs = segments.slice();
        segs[i] = '{slug}';
        return origin + segs.join('/') + tail;
      }
    }
  }
  return null;
}

function applyUrlTemplate(template, name) {
  if (!template || !name) return null;
  const slug = nameToSlug(name);
  if (!slug) return null;
  return template.replace('{slug}', slug);
}

// ---------- HTML inspection ----------

function stripHtml(html) {
  // Remove scripts/styles, then drop tags. Cheap but sufficient.
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words that signal "the number that follows is a version, not a price".
// We require one of these in close proximity to the captured number for the
// most-trusted matches.
const VERSION_KEYWORDS = ['version', 'ver\\.?', 'release', 'released', 'build', 'rev\\.?', 'updated', 'changelog'];

// Patterns that disqualify a candidate from being a version. We check
// only the small chunk of context IMMEDIATELY adjacent to the digits — a
// currency symbol 20 characters away has nothing to do with the version
// we're trying to identify, but a `$` glued onto the front of the digits
// definitely does.
const PRICE_PREFIX = /[$€£¥₹]\s*$|\b(?:USD|EUR|GBP|JPY|CAD|AUD)\s*$/i;
const RATING_SUFFIX = /^\s*\/\s*(?:5|10|100)\b|^\s*(?:stars?|out\s+of)\b/i;
const PRICE_KEYWORD_BEFORE = /\bprice\s*[:#]?\s*$/i;

/**
 * Score the trust we have in a candidate match. Higher = more trustworthy.
 *   100  match preceded by a "version"/"release"/"build" keyword
 *    70  match preceded by a literal "v" right against the number ("v3.24")
 *    50  three-or-more-segment number (3.2.1 or 3.2.1_b240508) with no
 *         price/rating context nearby
 *    30  two-segment number with no price context nearby
 *     0  any number with price/rating context nearby (rejected)
 */
function scoreMatch(text, idx, version, beforeContext, afterContext) {
  // Hard rejections: digits immediately preceded by a currency symbol or
  // immediately followed by /5, /10, "stars", "out of N", or preceded by
  // "price:" — these are almost certainly not version numbers.
  if (PRICE_PREFIX.test(beforeContext)) return 0;
  if (PRICE_KEYWORD_BEFORE.test(beforeContext)) return 0;
  if (RATING_SUFFIX.test(afterContext)) return 0;

  // Strongest signal: a "version" / "build" / "release" keyword right before.
  for (const kw of VERSION_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\s*[:#]?\\s*$`, 'i');
    if (re.test(beforeContext)) return 100;
  }
  if (/\bv\s*$/i.test(beforeContext)) return 70;
  // Build-style versions like "1.0.5_b240508" or "1.5.1.b1234" are almost
  // always real and rarely confused with prices.
  if (/[._\-][a-z]?\d{3,}/i.test(version)) return 65;
  if (/[a-z]\d+/i.test(version)) return 60;
  // Three-segment versions are usually trustworthy.
  if (/^\d+\.\d+\.\d+/.test(version)) return 50;
  // Plain X.Y is risky (could be a price). Require keyword context to count.
  return 25;
}

/**
 * Find a plausible version near a mention of `name` on the page.
 * Returns { version, regex } or null.
 *
 * Strategy:
 *   1. Search anywhere within ~120 chars of the plugin name for a number
 *      that looks like a version.
 *   2. Score each candidate based on surrounding context (version
 *      keyword > "v" prefix > 3-segment > 2-segment; reject if a price
 *      or rating symbol is nearby).
 *   3. Among acceptable candidates, prefer highest score; tie-break by
 *      higher numeric value.
 *
 * The captured version supports build suffixes like "1.0.5_b240508".
 */
function findVersionInText(text, name) {
  if (!name || !text) return null;
  const tokens = name.split(/\s+/).filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) return null;
  const tolerantName = tokens.join('[\\s\\-_:.]*');

  // Build-suffix-aware version capture. Matches:
  //   3.24, 3.24.5, 1.0.5_b240508, 1.5.1.b1234, 2.1.0-rc1, 4.0a2
  // The suffix delimiter accepts `.`, `_`, or `-` followed by an optional
  // letter and digits, OR a letter directly attached to the number.
  const VERSION_CAPTURE = '(\\d+\\.\\d+(?:\\.\\d+)?(?:[._\\-][a-z]?\\d+|[a-z]\\d+)?)';
  const VERSION_RE = new RegExp(VERSION_CAPTURE, 'gi');

  // Find every spot the plugin name appears, then look at every version-
  // looking candidate in the next 120 chars after it. (Doing this by hand
  // instead of as one regex avoids the pitfall of regex iteration not
  // backtracking through alternative version candidates after one is rejected.)
  const nameRe = new RegExp(tolerantName, 'gi');
  const candidates = [];
  let nameMatch;
  while ((nameMatch = nameRe.exec(text)) !== null) {
    const start = nameMatch.index + nameMatch[0].length;
    const window = text.slice(start, start + 120);
    VERSION_RE.lastIndex = 0;
    let vMatch;
    while ((vMatch = VERSION_RE.exec(window)) !== null) {
      const numLocalStart = vMatch.index;
      const numAbsoluteStart = start + numLocalStart;
      const version = vMatch[1];
      const beforeCtx = text.slice(Math.max(0, numAbsoluteStart - 24), numAbsoluteStart);
      const afterCtx = text.slice(numAbsoluteStart + version.length, numAbsoluteStart + version.length + 24);
      candidates.push({ version, beforeCtx, afterCtx, distance: numLocalStart });
    }
  }

  let best = null;
  for (const c of candidates) {
    const trust = scoreMatch(text, 0, c.version, c.beforeCtx, c.afterCtx);
    if (trust === 0) continue;
    const coerced = semver.coerce(c.version);
    if (!coerced) continue;
    const numScore = (coerced.major * 1e6) + (coerced.minor * 1e3) + coerced.patch;
    // Trust dominates; numeric value tie-breaks; closer-to-name tie-breaks last.
    const totalScore = trust * 1e10 + numScore - c.distance * 0.1;
    if (!best || totalScore > best.totalScore) {
      best = { totalScore, version: c.version, trust };
    }
  }

  if (!best) return null;

  // Build a saved pattern that prefers the same trust signal so future
  // checks don't drift to a price or rating. If the original match was
  // preceded by a "version" keyword, encode that in the saved pattern.
  let savedPattern;
  if (best.trust >= 100) {
    savedPattern = `(?:version|release|released|build|rev|updated)\\s*[:#]?\\s*v?${VERSION_CAPTURE}`;
  } else if (best.trust >= 70) {
    savedPattern = `${tolerantName}[\\s\\S]{0,120}?\\bv${VERSION_CAPTURE}`;
  } else if (best.trust >= 65) {
    savedPattern = `${tolerantName}[\\s\\S]{0,120}?${VERSION_CAPTURE}`;
  } else {
    // Generic name + version, but explicitly skip price-character contexts
    // by anchoring on a non-currency character before the digits.
    savedPattern = `${tolerantName}[\\s\\S]{0,120}?(?<![$€£¥])\\bv?${VERSION_CAPTURE}`;
  }

  return { version: best.version, regex: savedPattern };
}

/**
 * Given a URL and a version number the user can see on the page, fetch the
 * page and DERIVE a regex that will reliably capture future versions in the
 * same place. This is the "skip the regex" entry point used by the
 * "Add manually instead" flow in the UI — it lets the user paste a URL and
 * the version they see, and we do the rest.
 *
 * Returns:
 *   { ok: true, data: { url, versionRegex, latestVersion, message, warning? } }
 *   { ok: false, error: string }
 *
 * Strategy:
 *   1. Fetch the page and strip HTML.
 *   2. Confirm the literal version string actually appears in the text.
 *   3. Score every occurrence using the same trust signals as
 *      findVersionInText (keyword > "v" prefix > plugin-name proximity).
 *   4. Build a regex that re-anchors on whichever signal matched best, then
 *      VERIFY by running the new regex against the page text and checking
 *      that it captures exactly the version the user gave us.
 *   5. If verification fails, fall back to a literal-text anchor cut from
 *      the bytes immediately before the version on the page.
 */
async function deriveRegexFromVersion({ url, knownVersion, name }) {
  const trimmedUrl = String(url || '').trim();
  const trimmedVersion = String(knownVersion || '').trim();

  if (!trimmedUrl) return { ok: false, error: 'A URL is required.' };
  if (!trimmedVersion) return { ok: false, error: 'A current version number is required.' };
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }
  // Allow common version shapes: 1.2, 1.2.3, 1.2.3.4, 1.0.5_b240508, 4.0a2,
  // 2.1.0-rc1. Reject anything with letters / symbols in places that aren't
  // typical version build suffixes — most "I pasted the wrong thing" cases
  // catch here.
  if (!/^\d+(?:\.\d+){1,3}(?:[._\-][a-z]?\d+|[a-z]\d+)?$/i.test(trimmedVersion)) {
    return {
      ok: false,
      error: `"${trimmedVersion}" doesn't look like a version number. Examples: 1.15.3, 2.0, 3.0a2, 1.0.5_b240508.`,
    };
  }

  let html;
  try {
    html = await fetchText(trimmedUrl);
  } catch (e) {
    return { ok: false, error: `Couldn't fetch that page: ${e.message || e}` };
  }

  const text = stripHtml(html);
  const literal = escapeRegex(trimmedVersion);
  const literalRe = new RegExp(literal, 'g');

  const occurrences = [];
  let m;
  while ((m = literalRe.exec(text)) !== null) {
    const beforeCtx = text.slice(Math.max(0, m.index - 32), m.index);
    const afterCtx = text.slice(m.index + trimmedVersion.length, m.index + trimmedVersion.length + 32);
    occurrences.push({ index: m.index, beforeCtx, afterCtx });
    if (occurrences.length > 50) break;     // cap; pathological pages won't help us anyway
  }

  // Generic keyword-anchored fallback. Captures any "Version X.Y(.Z)" on
  // the page. Used when we can't find the user's literal version (e.g.
  // because the page is for a major-version successor product like
  // FabFilter Twin 3 vs the user's installed Twin 2) — better to save
  // SOMETHING and let the user see whatever version Plugr finds than to
  // silently refuse the save. The user can edit later if the auto-
  // detected version isn't what they wanted.
  const GENERIC_VERSION_CAPTURE = '(\\d+\\.\\d+(?:\\.\\d+)?(?:[._\\-][a-z]?\\d+|[a-z]\\d+)?)';
  const GENERIC_FALLBACK_REGEX =
    `(?:version|release|released|build|rev|updated)\\s*[:#]?\\s*v?${GENERIC_VERSION_CAPTURE}`;

  if (occurrences.length === 0) {
    // Literal version isn't on the page (often because the user is
    // tracking a discontinued product whose successor uses a different
    // version number, or the page is JS-rendered). Save anyway with a
    // generic fallback so the user gets *some* version-tracking — better
    // than silently dropping their save.
    return {
      ok: true,
      data: {
        url: trimmedUrl,
        versionRegex: GENERIC_FALLBACK_REGEX,
        latestVersion: trimmedVersion,
        message:
          `Couldn't find "${trimmedVersion}" on that page — saved a generic version pattern instead. ` +
          `On the next check, Plugr will report whatever the first "Version X.Y" on the page is. ` +
          `If that's wrong, click Edit and switch to Advanced to fine-tune.`,
        warning: true,
      },
    };
  }

  // Pick the occurrence with the strongest version-context signal.
  let best = null;
  for (const occ of occurrences) {
    const score = scoreMatch(text, 0, trimmedVersion, occ.beforeCtx, occ.afterCtx);
    if (score === 0) continue;
    if (!best || score > best.score) best = { ...occ, score };
  }

  if (!best) {
    // The version is on the page but only next to price/rating contexts.
    // Save with the generic fallback so the user can verify on the next
    // check rather than blocking the save entirely.
    return {
      ok: true,
      data: {
        url: trimmedUrl,
        versionRegex: GENERIC_FALLBACK_REGEX,
        latestVersion: trimmedVersion,
        message:
          `Found "${trimmedVersion}" on the page but only next to a price/rating-like context — ` +
          `saved a generic version pattern instead. Verify on the next check.`,
        warning: true,
      },
    };
  }

  // Build the candidate regex based on which trust signal we matched.
  const VERSION_CAPTURE = '(\\d+\\.\\d+(?:\\.\\d+)?(?:[._\\-][a-z]?\\d+|[a-z]\\d+)?)';

  // Build a "context anchor" pattern from the bytes immediately before
  // the version on the page. We try several anchor lengths (SHORTEST
  // first) and pick the first one that uniquely captures the user's
  // version. Shortest-that-works gives the most resilience to page
  // layout changes around the product entry.
  //
  // Crucially we also generalize whole-word integers in the anchor to
  // \d+, so the saved regex survives major-version bumps in the product
  // name: "Pro-C 3 Version 3.02" → anchor "Pro-C \d+ Version" → still
  // matches "Pro-C 4 Version 4.00" when FabFilter releases Pro-C 4.
  // Same idea for "Cubase 13 → Cubase 14", "Twin 3 → Twin 4", etc.
  function buildAnchorCandidates(beforeCtx) {
    const trimmed = beforeCtx.replace(/\s+$/, '');
    if (!trimmed) return [];
    const candidates = [];
    // Shortest first — picks the most resilient anchor that still
    // uniquely identifies the version we want.
    for (const width of [15, 25, 40, 60]) {
      let chunk = trimmed.length > width ? trimmed.slice(-width) : trimmed;
      // Trim leading partial word to a clean word boundary.
      const cut = chunk.search(/[A-Za-z0-9]/);
      if (cut > 0) chunk = chunk.slice(cut);
      // Require the chunk to contain at least one alphabetic run — pure
      // numbers/punctuation aren't useful as anchors.
      if (!/[A-Za-z]{2,}/.test(chunk)) continue;
      // Escape regex metas; replace whitespace runs with \s+ for tab/
      // double-space tolerance. Finally, generalize whole-word integers
      // to \d+ so the anchor survives product-major-version bumps
      // (Pro-C 3 → Pro-C 4 → Pro-C 5 all match the same anchor).
      const escaped = chunk
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+')
        .replace(/\b\d+\b/g, '\\d+');
      candidates.push(escaped);
    }
    return [...new Set(candidates)];     // de-duplicate, preserve order
  }

  // Generate the list of candidate saved patterns, in order of preference.
  // Each entry: { pattern, label } where label is used for the success/
  // warning messages.
  const candidates = [];
  const anchors = buildAnchorCandidates(best.beforeCtx);
  for (const a of anchors) {
    candidates.push({
      pattern: `${a}\\s*v?${VERSION_CAPTURE}`,
      label: 'context-anchored',
    });
  }
  // Keyword-only fallback for when no useful page context exists.
  if (best.score >= 100) {
    const kwMatch = best.beforeCtx.match(/(version|release|released|build|rev\.?|updated|changelog)\s*[:#]?\s*$/i);
    if (kwMatch) {
      const keyword = kwMatch[1].replace(/\./g, '\\.?');
      candidates.push({
        pattern: `${keyword}\\s*[:#]?\\s*v?${VERSION_CAPTURE}`,
        label: 'keyword-only',
      });
    } else {
      candidates.push({
        pattern: `(?:version|release|released|build|rev|updated)\\s*[:#]?\\s*v?${VERSION_CAPTURE}`,
        label: 'keyword-only',
      });
    }
  } else if (best.score >= 70) {
    candidates.push({ pattern: `\\bv${VERSION_CAPTURE}`, label: 'v-prefix' });
  }
  // Plugin-name proximity (only when nothing else is available).
  if (name && String(name).trim()) {
    const tokens = String(name).split(/\s+/).filter(Boolean).map(escapeRegex);
    const tolerantName = tokens.join('[\\s\\-_:.]*');
    candidates.push({
      pattern: `${tolerantName}[\\s\\S]{0,120}?(?<![$€£¥])\\bv?${VERSION_CAPTURE}`,
      label: 'name-proximity',
    });
  }

  // Walk the candidates and pick the FIRST one that, when applied to the
  // page text, captures exactly the version the user typed. That's our
  // saved pattern. If none verify, fall back to the longest anchor (best
  // approximation) and flag a warning.
  let savedPattern = null;
  let savedLabel = null;
  for (const c of candidates) {
    try {
      const re = new RegExp(c.pattern, 'i');
      const v = text.match(re);
      if (v && v[1] === trimmedVersion) {
        savedPattern = c.pattern;
        savedLabel = c.label;
        break;
      }
    } catch { /* invalid regex; skip */ }
  }

  if (savedPattern) {
    return {
      ok: true,
      data: {
        url: trimmedUrl,
        versionRegex: savedPattern,
        latestVersion: trimmedVersion,
        message: `Verified — "${trimmedVersion}" captured by ${savedLabel} pattern on the page.`,
      },
    };
  }

  // No verified candidate. Save with the longest anchor anyway — the
  // user told us the version is right, so it's better to save an
  // imperfect source than to drop the save.
  const fallback = (candidates[0] && candidates[0].pattern) || GENERIC_FALLBACK_REGEX;
  return {
    ok: true,
    data: {
      url: trimmedUrl,
      versionRegex: fallback,
      latestVersion: trimmedVersion,
      message:
        `Saved — "${trimmedVersion}" was on the page, but Plugr couldn't build a pattern that captures it ` +
        `uniquely. The check might report a different version on the page until you edit the pattern.`,
      warning: true,
    },
  };
}

function extractLinks(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = stripHtml(m[2]).trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
    let absolute;
    try { absolute = new URL(href, baseUrl).toString(); } catch { continue; }
    out.add(JSON.stringify({ url: absolute, label }));
    if (out.size > 800) break;     // sanity cap
  }
  return [...out].map((s) => JSON.parse(s));
}

function rankLinksFor(name, links, baseUrl) {
  let baseHost = '';
  try { baseHost = new URL(baseUrl).host; } catch {}

  const lowerName = name.toLowerCase();
  const slug = nameToSlug(name);

  return links
    .map((l) => {
      let host = '';
      try { host = new URL(l.url).host; } catch { return null; }
      if (host !== baseHost) return null;     // stay on the developer's site
      const u = l.url.toLowerCase();
      const t = (l.label || '').toLowerCase();
      let score = 0;
      if (u.includes(slug)) score += 50;
      if (t.includes(lowerName)) score += 40;
      if (u.includes('product')) score += 10;
      if (u.includes('download')) score += 10;
      if (u.includes('support')) score += 8;
      if (u.includes('changelog') || u.includes('release-notes')) score += 12;
      if (u.match(/\.(jpg|png|gif|pdf|zip|dmg)$/)) score -= 100;
      return score > 0 ? { ...l, score, host } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LINK_FOLLOW);
}

// ---------- Public API ----------

/**
 * Try to discover an update URL + versionRegex for a single item.
 *
 * @param {object} item - scanned plugin record. Must have `name` and ideally
 *                       `registry.homepage` / `registry.downloadsUrl`.
 * @returns {Promise<{
 *   url: string,
 *   versionRegex: string,
 *   latestVersion: string,
 *   tried: string[],
 *   message: string,
 * }>}
 */
async function discoverUpdateSource(item) {
  const tried = [];
  const candidates = collectCandidateUrls(item);

  // Phase 1: try direct candidates
  for (const url of candidates) {
    tried.push(url);
    let html;
    try { html = await fetchText(url); } catch { continue; }
    const text = stripHtml(html);
    const found = findVersionInText(text, item.name);
    if (found) {
      return {
        url,
        versionRegex: found.regex,
        latestVersion: found.version,
        tried,
        message: `Found "${item.name} v${found.version}" on the page.`,
      };
    }
  }

  // Phase 2: scrape homepage for product/download links and try those
  const home = item.manualHomepage || (item.registry && item.registry.homepage);
  if (home) {
    let homeHtml;
    try { homeHtml = await fetchText(home); } catch { /* fall through */ }
    if (homeHtml) {
      const ranked = rankLinksFor(item.name, extractLinks(homeHtml, home), home);
      for (const link of ranked) {
        if (tried.includes(link.url)) continue;
        tried.push(link.url);
        let html;
        try { html = await fetchText(link.url); } catch { continue; }
        const text = stripHtml(html);
        const found = findVersionInText(text, item.name);
        if (found) {
          return {
            url: link.url,
            versionRegex: found.regex,
            latestVersion: found.version,
            tried,
            message: `Found "${item.name} v${found.version}" via the developer's product link.`,
          };
        }
      }
    }
  }

  return {
    url: null,
    versionRegex: null,
    latestVersion: null,
    tried,
    message:
      "Couldn't find a public page that mentions this plugin's name and version. " +
      "The developer may put updates behind a login or only show versions in their installer manager. " +
      "You can still add a source by hand — see Help → How to add an update source.",
  };
}

// Permissive sibling of findVersionInText. Used by the URL-template
// sibling flow where the URL we're testing was derived from a
// known-good template, so we're already confident this is the right
// product page. Rules:
//   - Wider window (300 chars after the name instead of 120)
//   - Accepts version-shaped numbers without requiring a "version" /
//     "build" / "v" trust signal
//   - Still rejects obvious prices ($1.99) and ratings (4.5 / 5)
//   - Prefers 3-part versions over 2-part, then closest-to-name
// Returns { version, regex } or null. Regex is name-anchored so a
// later product version bump (1.2.3 → 1.2.4) still captures.
function findVersionInTextLoose(text, name) {
  if (!name || !text) return null;
  const tokens = name.split(/\s+/).filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) return null;
  const tolerantName = tokens.join('[\\s\\-_:.]*');

  // Same capture shape as the strict path so saved patterns stay
  // compatible across modules.
  const VERSION_CAPTURE = '(\\d+\\.\\d+(?:\\.\\d+)?(?:[._\\-][a-z]?\\d+|[a-z]\\d+)?)';
  const VERSION_RE = new RegExp(VERSION_CAPTURE, 'gi');
  const nameRe = new RegExp(tolerantName, 'gi');

  const candidates = [];
  let nameMatch;
  while ((nameMatch = nameRe.exec(text)) !== null) {
    const start = nameMatch.index + nameMatch[0].length;
    const window = text.slice(start, start + 300);
    VERSION_RE.lastIndex = 0;
    let vMatch;
    while ((vMatch = VERSION_RE.exec(window)) !== null) {
      const numLocalStart = vMatch.index;
      const numAbsoluteStart = start + numLocalStart;
      const version = vMatch[1];
      const beforeCtx = text.slice(Math.max(0, numAbsoluteStart - 24), numAbsoluteStart);
      const afterCtx = text.slice(numAbsoluteStart + version.length, numAbsoluteStart + version.length + 24);

      // Still reject obvious non-versions
      if (PRICE_PREFIX.test(beforeCtx)) continue;
      if (PRICE_KEYWORD_BEFORE.test(beforeCtx)) continue;
      if (RATING_SUFFIX.test(afterCtx)) continue;

      const partCount = version.replace(/[._\-][a-z]?\d+|[a-z]\d+$/i, '').split('.').length;
      // Prefer 3-part (e.g. 1.2.3) > 2-part (e.g. 1.2). Closer to name
      // is a tiebreaker. Numeric "max version" tiebreaker after that.
      const coerced = semver.coerce(version);
      if (!coerced) continue;
      const partScore = partCount >= 3 ? 1000 : 500;
      const numScore = (coerced.major * 1e6) + (coerced.minor * 1e3) + coerced.patch;
      const score = partScore * 1e10 + numScore - numLocalStart * 0.1;
      candidates.push({ version, score });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Name-anchored regex with a wide-ish window so the same shape
  // catches a future patch bump on the same page layout.
  const savedPattern = `${tolerantName}[\\s\\S]{0,300}?(?<![$€£¥])\\bv?${VERSION_CAPTURE}`;
  return { version: best.version, regex: savedPattern };
}

module.exports = {
  discoverUpdateSource,
  deriveRegexFromVersion,
  // Exported for unit testing + shared use across modules
  collectCandidateUrls,
  findVersionInText,
  rankLinksFor,
  stripHtml,
  deriveUrlTemplate,
  applyUrlTemplate,
  nameToSlug,
  nameToSlugCandidates,
  nameVariants,
  fetchText,
  findVersionInTextLoose,
};
