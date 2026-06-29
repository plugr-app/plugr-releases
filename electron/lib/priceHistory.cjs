// Per-deal rolling price history.
//
// Each refresh, we snapshot the current sale/regular price for every
// deal. Over time this builds a picture of what each product normally
// costs, which lets us answer questions the deals scrape itself can't:
//   - Is the current price actually the lowest it's been?
//   - Or are we just looking at the regular sale cycle?
//
// Stored in cache.priceHistory; survives fetcherVersion bumps because
// the data is COLLECTED, not scraped (re-scraping the historical low
// is impossible, so we treat this as user data on par with savedDeals).
//
// Storage shape:
//   priceHistory: {
//     [dealId]: {
//       samples: [
//         { sale: number|null, regular: number|null, at: ISO timestamp },
//         ...
//       ]
//     }
//   }
//
// Pruning policy: drop samples older than 180 days (rolling 6-month
// window). Also drop consecutive duplicates — if the price hasn't
// changed since the last sample, we just refresh the timestamp on
// the existing entry rather than appending. Keeps storage bounded
// at roughly N price-change events per deal, typically <50.

const MAX_AGE_MS = 180 * 86_400_000;   // 6 months
const MIN_DAYS_FOR_BADGE = 14;          // need >=2 weeks of tracking before any badge
const LOW_PRICE_TOLERANCE = 0.005;     // 0.5% wiggle room for "matches the low"

// Parse a currency string ($9.99, €19, etc.) into a number. Returns
// null on anything that doesn't look like a price. Identical to the
// helper in the scrapers — duplicated rather than imported because
// we want this module to be standalone.
function parsePrice(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

// Merge a fresh batch of deals into the existing priceHistory, returning
// a new history object. Pure function — no mutation of input.
function recordSnapshot(existingHistory, deals, nowMs = Date.now()) {
  const out = { ...(existingHistory || {}) };
  const cutoffIso = new Date(nowMs - MAX_AGE_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  for (const deal of (deals || [])) {
    if (!deal || !deal.id) continue;
    const sale = parsePrice(deal.salePrice);
    const regular = parsePrice(deal.regularPrice);
    // Skip if we don't have at least a sale price; otherwise the entry
    // is useless (we can't compute lowest from null).
    if (sale == null) continue;

    const prev = out[deal.id] || { samples: [], firstSeenAt: nowIso };
    const samples = (prev.samples || []).filter((s) => s.at >= cutoffIso);

    const last = samples[samples.length - 1];
    const sameAsLast = last
      && Math.abs((last.sale || 0) - sale) < 0.005
      && Math.abs((last.regular || 0) - (regular || 0)) < 0.005;

    if (sameAsLast) {
      // Price unchanged. Refresh the timestamp on the existing entry
      // so we know the deal is still live at this price — useful for
      // "current price has held for N days" later.
      last.at = nowIso;
    } else {
      samples.push({ sale, regular: regular ?? null, at: nowIso });
    }

    // firstSeenAt is set once when we first see a dealId and never
    // updated. Don't derive it from samples[0].at — that timestamp
    // gets rewritten on every same-price refresh, so a deal whose
    // price hasn't changed in 6 months would appear to have only 1
    // day of history.
    out[deal.id] = {
      samples,
      firstSeenAt: prev.firstSeenAt || nowIso,
    };
  }

  return out;
}

// Compute a small stats object for a single deal. Returns:
//   { sampleCount, daysOfHistory, lowestSale, lowestSaleAt,
//     lowestSaleLast30, lowestSaleLast90, currentMatchesLowestEver,
//     currentMatchesLowest30, currentMatchesLowest90 }
// Returns null when no samples are available.
function computeStats(history, dealId, currentSalePrice, nowMs = Date.now()) {
  if (!history || !history[dealId]) return null;
  const samples = history[dealId].samples || [];
  if (samples.length === 0) return null;

  const current = parsePrice(currentSalePrice);

  // Days tracked comes from firstSeenAt (stable) not samples[0].at
  // (which gets refreshed when prices don't change).
  const firstSeenAt = history[dealId].firstSeenAt || samples[0].at;
  const firstAtMs = Date.parse(firstSeenAt);
  const daysOfHistory = Math.max(1, Math.floor((nowMs - firstAtMs) / 86_400_000));

  // Lowest-ever within our retained window.
  let lowestSale = samples[0].sale;
  let lowestSaleAt = samples[0].at;
  for (const s of samples) {
    if (s.sale != null && s.sale < lowestSale) {
      lowestSale = s.sale;
      lowestSaleAt = s.at;
    }
  }

  // Lowest in last N days. Walk backwards for efficiency.
  const lowestInWindow = (days) => {
    const cutoff = nowMs - days * 86_400_000;
    let low = null;
    for (const s of samples) {
      const t = Date.parse(s.at);
      if (t < cutoff) continue;
      if (s.sale == null) continue;
      if (low == null || s.sale < low) low = s.sale;
    }
    return low;
  };

  const lowestSaleLast30 = lowestInWindow(30);
  const lowestSaleLast90 = lowestInWindow(90);

  // "Matches the low" with a 0.5% tolerance — handles rounding noise.
  const matches = (current, target) => {
    if (current == null || target == null) return false;
    const tol = Math.max(0.01, target * LOW_PRICE_TOLERANCE);
    return current <= target + tol;
  };

  return {
    sampleCount: samples.length,
    daysOfHistory,
    lowestSale,
    lowestSaleAt,
    lowestSaleLast30,
    lowestSaleLast90,
    currentMatchesLowestEver: matches(current, lowestSale),
    currentMatchesLowest30:   matches(current, lowestSaleLast30),
    currentMatchesLowest90:   matches(current, lowestSaleLast90),
  };
}

// Pick the most compelling badge string to show on a card, or null if
// we don't have enough data yet (or current isn't notably low). Order
// of preference: lowest ever > lowest in 90 days > lowest in 30 days.
//
// Eligibility based on DAYS TRACKED (not sample count) — a deal whose
// price hasn't changed in 6 months has only 1 sample but is genuinely
// well-tracked. Sample count would be a misleading gate.
function pickBadge(stats) {
  if (!stats) return null;
  if (stats.daysOfHistory < MIN_DAYS_FOR_BADGE) return null;

  if (stats.daysOfHistory >= 60 && stats.currentMatchesLowestEver) {
    return 'LOWEST EVER';
  }
  if (stats.daysOfHistory >= 30 && stats.currentMatchesLowest90) {
    return 'LOWEST IN 90D';
  }
  if (stats.daysOfHistory >= MIN_DAYS_FOR_BADGE && stats.currentMatchesLowest30) {
    return 'LOWEST IN 30D';
  }
  return null;
}

module.exports = {
  recordSnapshot,
  computeStats,
  pickBadge,
  parsePrice,
  MIN_DAYS_FOR_BADGE,
  MAX_AGE_MS,
};
