// Deals ↔ library matcher. Pure, no Node/Electron — runs in the
// renderer so it can use the freshly-merged library (post-overrides,
// post-hidden filter) without the cached deal list needing to be
// invalidated every time the user retags a plugin.
//
// Inputs:
//   - deals: [{ id, source, title, pluginName, developer, url, publishedAt, description }]
//   - libraryItems: [{ id, name, developer, identifier?, format, ... }]  (post-overrides)
//
// Output (single object so it's cheap for useMemo):
//   {
//     enriched: [{ ...deal, match: { kind, items, developer } }],
//     ownedPluginDeals:    [...],  // deal.match.kind === 'owned-plugin'
//     ownedDeveloperDeals: [...],  // deal.match.kind === 'owned-developer'
//     otherDeals:          [...],  // deal.match.kind === 'unmatched'
//     counts: { total, ownedPlugin, ownedDeveloper, other },
//   }
//
// Match priority per deal:
//   1. owned-plugin     — plugin name matches an item we own
//   2. owned-developer  — developer name matches a developer in our library
//                         (but the plugin itself isn't recognized as owned)
//   3. unmatched        — show in "Other deals" section
//
// Matching is lenient: lowercase + strip non-alphanumerics so "FabFilter
// Pro-Q 3" matches "Pro Q 3", "ProQ3", "FabFilter Pro Q3" etc. We also
// match deal.pluginName as a substring of any library item's name (and
// vice versa) so titles like "Pro-Q 3 — 50% off" still hit owned items.

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Build lookup indexes once per call. O(library size) then O(deals × cheap)
// for the actual matching loop.
function buildLibraryIndexes(libraryItems) {
  const itemsByNormName = new Map();      // normName -> [item]
  const itemsByDeveloper = new Map();     // normDev  -> [item]
  // Also keep the array of (normName, item) pairs sorted by descending
  // name length so substring tests prefer longer matches first ("Pro-Q
  // 3" beats "Pro").
  const nameIndex = [];

  for (const item of libraryItems || []) {
    if (!item || !item.name) continue;
    const normName = normalize(item.name);
    const normDev = normalize(item.developer);

    if (normName) {
      const arr = itemsByNormName.get(normName) || [];
      arr.push(item);
      itemsByNormName.set(normName, arr);
      nameIndex.push({ normName, item });
    }
    if (normDev) {
      const arr = itemsByDeveloper.get(normDev) || [];
      arr.push(item);
      itemsByDeveloper.set(normDev, arr);
    }
  }
  // Longest name first so substring matches don't pick "Pro" when "Pro-Q 3"
  // would also fit.
  nameIndex.sort((a, b) => b.normName.length - a.normName.length);

  return { itemsByNormName, itemsByDeveloper, nameIndex };
}

// Compare two normalized developer strings with a small bit of
// tolerance — substring either way, since vendors are written
// inconsistently ("ujam", "UJAM Instruments", "Plugin Alliance" vs
// "PluginAlliance"). Returns true when they're plausibly the same
// company; false when they clearly disagree. Empty strings on either
// side return null so the caller can decide whether to fall through
// or reject.
function developersAgree(normDealDev, normItemDev) {
  if (!normDealDev || !normItemDev) return null;
  if (normDealDev === normItemDev) return true;
  // 4-char floor — shorter substring matches catch too many false
  // positives ("uad" inside "audified", "ik" inside "iklm").
  if (normDealDev.length >= 4 && normItemDev.includes(normDealDev)) return true;
  if (normItemDev.length >= 4 && normDealDev.includes(normItemDev)) return true;
  return false;
}

// Substring containment check. The minimum-length floor is intentionally
// strict (5 chars on the SHORTER side) because real-world plugin names
// have a lot of common 3-4 letter chunks ("Warm" inside "Hydroswarm",
// "Loop" inside any loop plugin, etc) and 4-char substring matches
// produced false positives in practice. Short plugin names like "OTT"
// (3 chars) still match via the exactName path above.
//
// When a normalized deal-developer is supplied, every candidate library
// item must have a matching developer too. This is what prevents bogus
// hits like "Element (Kushview)" matching "UJAM Symphonic Elements" or
// "Pigments (Arturia)" matching "UDi Audio Pigments Bundle" — the names
// share a substring but the vendor mismatch betrays them. We allow the
// match through when either side's developer is missing so the matcher
// can still do useful work on dev-less deal feeds.
function findItemsByNameContains(needle, nameIndex, normDealDev) {
  const n = needle.length;
  if (n < 5) return [];
  const seen = new Set();
  const out = [];
  for (const { normName, item } of nameIndex) {
    // Match in either direction — deal title might be a substring of an
    // item name ("Pro-Q 3" in "FabFilter Pro-Q 3") or vice versa.
    const longer  = normName.length >= n ? normName : needle;
    const shorter = normName.length >= n ? needle   : normName;
    if (shorter.length < 5) continue;
    if (!longer.includes(shorter)) continue;
    if (seen.has(item.id)) continue;
    // Exact-name match always wins; for *substring* matches require the
    // deal's developer (when known) to agree with the item's developer.
    // null = unknown, false = explicit mismatch.
    if (normDealDev && longer !== shorter) {
      const normItemDev = normalize(item.developer);
      const agree = developersAgree(normDealDev, normItemDev);
      if (agree === false) continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// Try every signal we have on a single deal to find owned items.
// Returns the matched items array (possibly empty).
function matchDealToItems(deal, idx) {
  const { itemsByNormName, nameIndex } = idx;
  const normDealDev = normalize(deal.developer || '');

  // 1. Exact normalized plugin-name match (highest confidence). We
  // still cross-check developer when both sides know one, because a
  // generic name like "Pigments" could legitimately exist under two
  // different vendors (Arturia Pigments vs UDi Audio Pigments).
  const exactName = normalize(deal.pluginName || '');
  if (exactName && itemsByNormName.has(exactName)) {
    const all = itemsByNormName.get(exactName);
    if (!normDealDev) return all;
    // Prefer same-developer items; fall back to all hits if no dev
    // info on either side. If we DO have dev info and none agree,
    // reject — exact name + wrong vendor is the canonical false-positive
    // shape ("UDi Pigments" ≠ "Arturia Pigments").
    const sameDev = all.filter((it) => developersAgree(normDealDev, normalize(it.developer)) === true);
    if (sameDev.length > 0) return sameDev;
    // No same-dev hits AND deal developer is known: bail rather than
    // mis-credit ownership.
    return [];
  }

  // 2. Plugin-name substring match (handles "FabFilter Pro-Q 3" vs "Pro-Q 3").
  if (exactName) {
    const hits = findItemsByNameContains(exactName, nameIndex, normDealDev);
    if (hits.length > 0) return hits;
  }

  // 3. Fall back to scanning the raw title — sometimes pluginName
  // extraction misses but the title still contains the product. We
  // strip price/percent fluff first so it doesn't dilute matches.
  const cleanTitle = normalize((deal.title || '').replace(/\d+%off|save\d+/gi, ''));
  if (cleanTitle && cleanTitle.length >= 4) {
    const hits = findItemsByNameContains(cleanTitle, nameIndex, normDealDev);
    if (hits.length > 0) return hits;
  }

  return [];
}

function matchDealToDeveloper(deal, idx) {
  const { itemsByDeveloper } = idx;
  const exactDev = normalize(deal.developer || '');
  if (!exactDev) return null;
  if (itemsByDeveloper.has(exactDev)) {
    // Return the first known item just so the UI can say "you own X plugins
    // by them"; the deal itself just needs the developer identity.
    return { developer: deal.developer, items: itemsByDeveloper.get(exactDev) };
  }
  // Try a substring match for cases like "PluginAlliance" vs "Plugin Alliance".
  for (const [normDev, items] of itemsByDeveloper) {
    if (normDev.length < 4) continue;
    if (normDev.includes(exactDev) || exactDev.includes(normDev)) {
      return { developer: items[0].developer || deal.developer, items };
    }
  }
  return null;
}

/**
 * Categorize a list of deals against the user's library.
 */
export function matchDeals(deals, libraryItems) {
  const list = Array.isArray(deals) ? deals : [];
  const idx = buildLibraryIndexes(libraryItems);

  const enriched = [];
  const ownedPluginDeals = [];
  const ownedDeveloperDeals = [];
  const otherDeals = [];

  for (const deal of list) {
    const items = matchDealToItems(deal, idx);
    if (items.length > 0) {
      const dev = items[0].developer || deal.developer || null;
      const next = { ...deal, match: { kind: 'owned-plugin', items, developer: dev } };
      enriched.push(next);
      ownedPluginDeals.push(next);
      continue;
    }
    const devMatch = matchDealToDeveloper(deal, idx);
    if (devMatch) {
      const next = { ...deal, match: { kind: 'owned-developer', items: devMatch.items, developer: devMatch.developer } };
      enriched.push(next);
      ownedDeveloperDeals.push(next);
      continue;
    }
    const next = { ...deal, match: { kind: 'unmatched', items: [], developer: deal.developer || null } };
    enriched.push(next);
    otherDeals.push(next);
  }

  return {
    enriched,
    ownedPluginDeals,
    ownedDeveloperDeals,
    otherDeals,
    counts: {
      total: enriched.length,
      ownedPlugin: ownedPluginDeals.length,
      ownedDeveloper: ownedDeveloperDeals.length,
      other: otherDeals.length,
    },
  };
}

// Exported for tests; tiny enough to be worth verifying directly.
export const __test = { normalize, buildLibraryIndexes, findItemsByNameContains, developersAgree };
