// Thin orchestrator that fans out to each individual deals source and
// merges the results into a single, deduped, normalized list.
//
// Each source module lives in ./sources/ and must export:
//   { fetchDeals: async () => Deal[], SOURCE_NAME: string }
//
// Sources are intentionally siloed — Plugin Boutique's HTML changes
// shouldn't break the APD scraper, and vice versa. If one source fails
// it logs and returns [], the others keep working.
//
// Normalized Deal shape (matches what the renderer's matcher expects):
//   {
//     id:            string,    // stable per source for dedup
//     source:        string,    // 'Plugin Boutique' / 'Audio Plugin Deals'
//     title:         string,    // human-readable
//     url:           string,    // ALREADY wrapped with affiliate param (if any)
//     imageUrl:      string?,   // hero/product image (absolute URL)
//     priceBadge:    string?,   // '50% OFF', '$9.99', 'FREE'
//     salePrice:     string?,   // raw sale price text ('$29.99'), APD only
//     regularPrice:  string?,   // raw original price text ('$149.00'), APD only
//     publishedAt:   ISO?,      // when the deal went live (if known)
//     endsAt:        ISO?,      // when the deal ends (if known)
//     description:   string?,   // short blurb, HTML-stripped
//     pluginName:    string?,   // best-guess product name for matching
//     developer:     string?,   // best-guess developer name for matching
//   }

const pluginBoutique     = require('./sources/pluginBoutique.cjs');
const audioPluginDeals   = require('./sources/audioPluginDeals.cjs');

// One entry per source. Add new sources by dropping a module in
// ./sources/ that exports fetchDeals() + SOURCE_NAME, then registering
// it here. Order in this list affects nothing — final output is
// sorted by recency.
const SOURCES = [
  { name: pluginBoutique.SOURCE_NAME,   fetchDeals: pluginBoutique.fetchDeals },
  { name: audioPluginDeals.SOURCE_NAME, fetchDeals: audioPluginDeals.fetchDeals },
];

async function fetchOneSource(source, onProgress) {
  try {
    // Adapt callback to per-source channel: each emit gets stamped
    // with the source name so the renderer knows what's progressing.
    const onP = onProgress
      ? (msg) => { try { onProgress({ source: source.name, ...msg }); } catch {} }
      : null;
    if (onP) onP({ stage: 'start', message: 'Fetching…' });
    const items = await source.fetchDeals(onP);
    if (onP) onP({ stage: 'done', message: `${(items || []).length} deals` });
    return Array.isArray(items) ? items : [];
  } catch (err) {
    if (onProgress) {
      try { onProgress({ source: source.name, stage: 'error', message: err.message || String(err) }); }
      catch {}
    }
    console.warn(`[deals] ${source.name} failed: ${err.message}`);
    return [];
  }
}

async function fetchAllDeals(onProgress) {
  const results = await Promise.all(SOURCES.map((s) => fetchOneSource(s, onProgress)));

  // Dedupe by URL across sources. If the same product/sale appears in
  // both APD and PB, keep the first one (sources are listed in
  // priority order — PB first because their affiliate program pays
  // higher commission rates).
  const seen = new Set();
  const out = [];
  for (const list of results) {
    for (const deal of list) {
      const key = (deal.url || deal.id || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(deal);
    }
  }

  // Most recent first. If publishedAt is null (PB doesn't expose per-deal
  // start dates), fall back to endsAt sort so soon-to-expire deals bubble
  // up. Stable enough for daily-refresh UX.
  out.sort((a, b) => {
    const at = (a.publishedAt && Date.parse(a.publishedAt))
            || (a.endsAt && Date.parse(a.endsAt)) || 0;
    const bt = (b.publishedAt && Date.parse(b.publishedAt))
            || (b.endsAt && Date.parse(b.endsAt)) || 0;
    return bt - at;
  });

  return out;
}

module.exports = {
  fetchAllDeals,
  fetchOneSource,
  SOURCES,
};
