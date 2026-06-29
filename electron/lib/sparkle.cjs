// ─────────────────────────────────────────────────────────────────────────
// Sparkle appcast support.
//
// Sparkle is a long-standing macOS auto-update framework that originated
// with the desktop app world but is also used by quite a few plugin
// developers. When an app uses Sparkle it publishes a small RSS-style XML
// feed (the "appcast") at a stable URL containing release history. The
// bundle's Info.plist declares the feed URL in the SUFeedURL key.
//
// What this module does:
//   - readSparkleFeedUrl(bundleInfo) — pull SUFeedURL out of an item's
//     parsed Info.plist (read during the regular scan).
//   - fetchAndParseAppcast(url) — fetch the XML, parse it, return a list
//     of items in the order they appeared.
//   - latestVersionFromAppcast(items) — pick the highest version among
//     the parsed items (semver-coerced).
//
// We deliberately use a regex-based parser instead of pulling in an XML
// library: Sparkle feeds are simple, the cost of a real parser isn't
// justified, and a regex parser fails gracefully (just skips weird items)
// rather than throwing on any malformed character.
// ─────────────────────────────────────────────────────────────────────────

const semver = require('semver');

const FETCH_TIMEOUT_MS = 12000;
const UA = 'Plugr/0.1 (Sparkle reader)';

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a Sparkle feed URL from a parsed Info.plist record. Returns the
 * URL string or null if the bundle doesn't declare one.
 *
 * Most apps use the literal key `SUFeedURL`. Some declare it elsewhere
 * (e.g. nested under a settings dictionary), so we accept a few
 * plausible field names.
 */
function readSparkleFeedUrl(plist) {
  if (!plist || typeof plist !== 'object') return null;
  const direct = plist.SUFeedURL || plist.SUFeedURLString;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Parse a Sparkle XML appcast. Returns an array of items in the order
 * they appear in the feed. Each item has:
 *   { version, shortVersion, title, pubDate, downloadUrl, minSystem }
 * Any field that isn't present in the source XML is null/undefined.
 */
function parseAppcast(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item\s*>/gi;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[0];

    // Sparkle exposes the version in a few places; check them in order
    // of trustworthiness.
    const versionEl = block.match(/<sparkle:shortVersionString[^>]*>([\s\S]*?)<\/sparkle:shortVersionString>/i);
    const buildEl = block.match(/<sparkle:version[^>]*>([\s\S]*?)<\/sparkle:version>/i);
    const enclosureV = block.match(/<enclosure\b[^>]*\bsparkle:shortVersionString="([^"]+)"/i)
      || block.match(/<enclosure\b[^>]*\bsparkle:version="([^"]+)"/i);

    const shortVersion = versionEl ? decodeXmlEntities(versionEl[1]).trim() : null;
    const buildVersion = buildEl ? decodeXmlEntities(buildEl[1]).trim() : null;
    const encVersion = enclosureV ? decodeXmlEntities(enclosureV[1]).trim() : null;

    const titleEl = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pubEl = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const linkEl = block.match(/<enclosure\b[^>]*\burl="([^"]+)"/i);
    const minSysEl = block.match(/<sparkle:minimumSystemVersion[^>]*>([\s\S]*?)<\/sparkle:minimumSystemVersion>/i);

    // Prefer the visible "shortVersion" since that's what the user sees.
    const version = shortVersion || encVersion || buildVersion;
    if (!version) continue;

    items.push({
      version,
      shortVersion: shortVersion || null,
      buildVersion: buildVersion || null,
      title: titleEl ? decodeXmlEntities(titleEl[1]).trim() : null,
      pubDate: pubEl ? decodeXmlEntities(pubEl[1]).trim() : null,
      downloadUrl: linkEl ? linkEl[1] : null,
      minSystem: minSysEl ? decodeXmlEntities(minSysEl[1]).trim() : null,
    });
  }
  return items;
}

/**
 * Pick the highest version among a list of appcast items. Returns the
 * full item record so the caller can use the title or download URL.
 * Falls back to the first item if no version is comparable (some feeds
 * are listed already-sorted).
 */
function latestVersionFromAppcast(items) {
  if (!items || items.length === 0) return null;
  let best = null;
  let bestNum = -Infinity;
  for (const it of items) {
    const coerced = semver.coerce(it.version);
    if (!coerced) continue;
    const num = (coerced.major * 1e9) + (coerced.minor * 1e5) + coerced.patch;
    if (num > bestNum) { best = it; bestNum = num; }
  }
  return best || items[0];
}

/** Fetch + parse + pick latest. Returns `{ latest, all }` or null. */
async function checkSparkleFeed(url) {
  if (!url) return null;
  let xml;
  try { xml = await fetchText(url); } catch { return null; }
  const items = parseAppcast(xml);
  if (items.length === 0) return null;
  return { latest: latestVersionFromAppcast(items), all: items };
}

module.exports = {
  readSparkleFeedUrl,
  parseAppcast,
  latestVersionFromAppcast,
  checkSparkleFeed,
};
