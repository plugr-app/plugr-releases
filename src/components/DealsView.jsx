import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { matchDeals } from '../lib/dealsMatcher.js';

// DealsView — affiliate-driven storefront.
//
// Sections (ranked by purchase motivation, NOT by ownership):
//   1. Today's top deals    — algorithmic pick across all sources, ranked
//                             by FREE → highest discount → ending soonest.
//                             Independent of ownership. The "front page."
//   2. From developers you trust
//                           — other products on sale from companies whose
//                             plugins are in the user's library.
//   3. Upgrades & expansions for your library
//                           — reframed "owned-plugin" matches. Pitch is
//                             "get more value from what you have" (Melodyne
//                             upgrades, Kontakt sample libs, etc.) — not
//                             "buy something you already own."
//   4. Browse all deals     — collapsible, everything else.
//
// Click-throughs already include the user's affiliate id where one is
// configured (see electron/lib/affiliateConfig.cjs); the affiliate
// disclosure footer is rendered below all sections.

const TOP_PICKS_COUNT = 6;

// Sort options — drive the sort dropdown above the deal grid. "Featured"
// is the curated default (FREE → highest discount → ending soon).
const SORT_OPTIONS = [
  { id: 'featured',    label: 'Featured',        cmp: byBestDealFirst },
  { id: 'discount',    label: 'Discount % (high to low)', cmp: byDiscountDesc },
  { id: 'endingSoon',  label: 'Ending soonest',  cmp: byEndingSoon },
];

// Filter chips above the grid. Each chip narrows the visible deal set
// across ALL sections. "All" clears the filter.
//
// Ownership filters come first (most personal, most likely to be used)
// followed by deal-type filters. When an ownership filter is active it
// typically empties most sections; Section's hideWhenEmpty hides those
// silently so the user sees only the relevant content.
const FILTER_OPTIONS = [
  { id: 'all',        label: 'All',                     test: () => true },

  // Ownership-based filters.
  { id: 'unowned',    label: "Don't own",               test: (d) =>
      d.match && (d.match.kind === 'unmatched' || d.match.kind === 'owned-developer') },
  { id: 'fromDevs',   label: 'From my developers',      test: (d) =>
      d.match && d.match.kind === 'owned-developer' },
  { id: 'upgrades',   label: 'Upgrades for my library', test: (d) =>
      d.match && d.match.kind === 'owned-plugin' },

  // Deal-type filters.
  { id: 'free',       label: 'Free',                    test: (d) => (d.priceBadge || '').toUpperCase() === 'FREE' },
  { id: 'half',       label: '50%+ off',                test: (d) => parsePctOff(d.priceBadge) >= 50 },
  { id: 'massive',    label: '80%+ off',                test: (d) => parsePctOff(d.priceBadge) >= 80 },
  { id: 'bundle',     label: 'Bundles',                 test: (d) => /\bbundle\b/i.test(d.title || '') },
  { id: 'endingSoon', label: 'Ending this week',        test: (d) => {
    if (!d.endsAt) return false;
    const ms = Date.parse(d.endsAt) - Date.now();
    return ms > 0 && ms <= 7 * 86_400_000;
  } },
];

export default function DealsView({
  api, libraryItems, pushToast, savedDealsInitial, currencyPref,
  // Deal-alert wiring. App.jsx owns the shared dealAlerts state and
  // toggles. Both props are optional so DealsView keeps working in
  // isolation (tests, storybook, etc.) without alerts plumbed.
  findAlertForDeal,
  onToggleDealAlert,
}) {
  const [deals, setDeals] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Per-deal rolling price history (collected by main on every refresh).
  // Used to emit "Lowest in N days" / "Lowest ever" badges on cards.
  const [priceHistory, setPriceHistory] = useState({});
  // Live refresh status (per-source) — populated by 'progress:deals'
  // events from main during fetches. Keyed by source name so we
  // always show the latest status for each source independently.
  const [refreshProgress, setRefreshProgress] = useState({});
  // User-dismissed deals (X button on cards). Hydrated from cache.
  const [dismissedDeals, setDismissedDeals] = useState({});
  // Exchange rates for converting prices to the user's preferred
  // display currency. Hydrated from cache via deals:get response.
  const [exchangeRates, setExchangeRates] = useState(null);

  const toggleDismissed = useCallback(async (deal, shouldDismiss) => {
    if (!deal || !deal.id) return;
    const id = deal.id;
    // Optimistic update.
    setDismissedDeals((prev) => {
      const next = { ...prev };
      if (shouldDismiss) next[id] = { dismissedAt: new Date().toISOString() };
      else delete next[id];
      return next;
    });
    if (shouldDismiss && pushToast) {
      pushToast({
        kind: 'info',
        title: 'Deal hidden',
        message: deal.title,
        durationMs: 6000,
        action: { label: 'Undo', onClick: () => toggleDismissed(deal, false) },
      });
    }
    try {
      const res = await api.setDealDismissed(id, shouldDismiss);
      if (res && res.ok && res.dismissedDeals) setDismissedDeals(res.dismissedDeals);
    } catch (err) {
      // Roll back on failure.
      setDismissedDeals((prev) => {
        const next = { ...prev };
        if (shouldDismiss) delete next[id];
        else if (prev[id]) next[id] = prev[id];
        return next;
      });
    }
  }, [api, pushToast]);

  // Wishlist state — saved deals are persisted in main-process cache.
  // We hydrate from cache (via the savedDealsInitial prop) and update
  // optimistically on toggle, then write through to main for durability.
  const [savedDeals, setSavedDeals] = useState(() => savedDealsInitial || {});
  const toggleSaved = useCallback(async (deal) => {
    const id = deal.id;
    if (!id) return;
    const isCurrentlySaved = !!savedDeals[id];
    // Optimistic UI update first.
    setSavedDeals((prev) => {
      const next = { ...prev };
      if (isCurrentlySaved) delete next[id];
      else next[id] = { id, url: deal.url, title: deal.title, imageUrl: deal.imageUrl || null,
                       priceBadge: deal.priceBadge || null, endsAt: deal.endsAt || null,
                       source: deal.source || null, developer: deal.developer || null,
                       savedAt: new Date().toISOString() };
      return next;
    });
    try {
      const res = await api.setDealSaved(id, deal, !isCurrentlySaved);
      // Reconcile with the server-of-truth in case anything diverged.
      if (res && res.ok && res.savedDeals) setSavedDeals(res.savedDeals);
    } catch (err) {
      // Roll back optimistic update on failure.
      setSavedDeals((prev) => {
        const next = { ...prev };
        if (isCurrentlySaved) next[id] = prev[id];
        else delete next[id];
        return next;
      });
      if (pushToast) pushToast({ kind: 'error', title: 'Couldn’t save deal', message: String(err.message || err) });
    }
  }, [savedDeals, api, pushToast]);

  // Filter & sort controls.
  const [sortId, setSortId] = useState('featured');
  const [filterId, setFilterId] = useState('all');
  const sortFn   = (SORT_OPTIONS.find((o) => o.id === sortId)   || SORT_OPTIONS[0]).cmp;
  const filterFn = (FILTER_OPTIONS.find((o) => o.id === filterId) || FILTER_OPTIONS[0]).test;

  const load = useCallback(async (force) => {
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const res = await api.getDeals(!!force);
      if (res && res.ok) {
        const data = res.data || { items: [], fetchedAt: null };
        setDeals(Array.isArray(data.items) ? data.items : []);
        setFetchedAt(data.fetchedAt || null);
        if (data.priceHistory && typeof data.priceHistory === 'object') {
          setPriceHistory(data.priceHistory);
        }
        if (data.dismissedDeals && typeof data.dismissedDeals === 'object') {
          setDismissedDeals(data.dismissedDeals);
        }
        if (data.exchangeRates && typeof data.exchangeRates === 'object') {
          setExchangeRates(data.exchangeRates);
        }
        if (res.error && pushToast) {
          pushToast({
            kind: 'warning',
            title: 'Couldn’t refresh deals',
            message: `Showing cached deals. ${res.error}`,
            durationMs: 6000,
          });
        }
      } else {
        setError((res && res.error) || 'Unknown error fetching deals.');
        setDeals([]);
      }
    } catch (err) {
      setError(String(err && err.message || err));
      setDeals([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, pushToast]);

  useEffect(() => { load(false); }, [load]);

  // Subscribe to per-source refresh progress while the Deals tab is
  // mounted. Auto-clears the per-source entry a moment after it
  // reports 'done' so the status line doesn't linger forever.
  useEffect(() => {
    if (!api.onProgress) return undefined;
    const unsub = api.onProgress('progress:deals', (msg) => {
      if (!msg || !msg.source) return;
      setRefreshProgress((prev) => ({ ...prev, [msg.source]: msg }));
      if (msg.stage === 'done' || msg.stage === 'error') {
        // Clear this source's entry after a short delay so the user
        // can read the final state but it doesn't linger after refresh.
        setTimeout(() => {
          setRefreshProgress((prev) => {
            const next = { ...prev };
            delete next[msg.source];
            return next;
          });
        }, 1500);
      }
    });
    return unsub;
  }, [api]);

  // Re-hydrate when the parent reloads cache (e.g. after backup import).
  useEffect(() => {
    if (savedDealsInitial) setSavedDeals(savedDealsInitial);
  }, [savedDealsInitial]);

  // Categorize against user's library once per change. We filter out
  // dismissed deals BEFORE categorization so dismissed deals don't
  // appear in any section or in the counts. Wishlist (savedDeals)
  // still has access to dismissed-but-saved deals via the snapshot.
  const matched = useMemo(() => {
    const visible = deals.filter((d) => !d || !dismissedDeals[d.id]);
    return matchDeals(visible, libraryItems || []);
  }, [deals, libraryItems, dismissedDeals]);

  // Saved deals — render from cache snapshot AND merge any matching live
  // deal info (so a saved deal that's still live gets the freshest
  // discount/image, and one that's no longer live shows the snapshot).
  const savedDealsList = useMemo(() => {
    const liveById = new Map(matched.enriched.map((d) => [d.id, d]));
    const out = [];
    for (const id of Object.keys(savedDeals)) {
      const live = liveById.get(id);
      const snap = savedDeals[id];
      if (live) {
        out.push({ ...live, _saved: true });
      } else {
        // Stale: deal isn't in live results. Render from snapshot, mark
        // it as expired so the user knows it may no longer be valid.
        out.push({ ...snap, _saved: true, _stale: true, match: { kind: 'unmatched', items: [], developer: snap.developer } });
      }
    }
    out.sort(sortFn);
    return out;
  }, [savedDeals, matched, sortFn]);

  // Apply the active filter to every section. The filter narrows ALL
  // sections at once — so when "Free" is selected, you see only free
  // deals across Top picks / From your devs / Upgrades / Browse.
  const topPicks = useMemo(() => {
    const candidates = matched.enriched
      .filter((d) => d.match.kind !== 'owned-plugin')
      .filter(filterFn)
      .slice()
      .sort(sortFn);
    return candidates.slice(0, TOP_PICKS_COUNT);
  }, [matched, filterFn, sortFn]);

  const topPickIds = useMemo(() => new Set(topPicks.map((d) => d.id)), [topPicks]);

  const fromYourDevs = useMemo(
    () => matched.ownedDeveloperDeals
      .filter((d) => !topPickIds.has(d.id))
      .filter(filterFn)
      .sort(sortFn),
    [matched, topPickIds, filterFn, sortFn],
  );

  const upgradesForYou = useMemo(
    () => matched.ownedPluginDeals
      .filter(filterFn)
      .sort(sortFn),
    [matched, filterFn, sortFn],
  );

  const browseAll = useMemo(
    () => matched.otherDeals
      .filter((d) => !topPickIds.has(d.id))
      .filter(filterFn)
      .sort(sortFn),
    [matched, topPickIds, filterFn, sortFn],
  );

  const [showBrowseAll, setShowBrowseAll] = useState(false);

  return (
    <div className="deals-view" style={pageStyle}>
      <Header
        fetchedAt={fetchedAt}
        totalCount={matched.counts.total}
        onRefresh={() => load(true)}
        refreshing={refreshing}
      />

      {/* Per-source refresh progress. Only visible while a refresh
       *  is actively in flight; each source updates independently. */}
      {Object.keys(refreshProgress).length > 0 && (
        <div style={progressStripStyle}>
          {Object.values(refreshProgress).map((p) => (
            <div key={p.source} style={progressLineStyle}>
              <span style={{ fontWeight: 600 }}>{p.source}:</span>{' '}
              <span style={{ opacity: 0.85 }}>{p.message}</span>
              {p.total && p.current != null && (
                <span style={progressBarOuterStyle}>
                  <span style={{
                    ...progressBarInnerStyle,
                    width: `${Math.min(100, Math.round((p.current / p.total) * 100))}%`,
                  }} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <EmptyState>Loading deals…</EmptyState>
      ) : error ? (
        <EmptyState>
          <div style={{ color: 'var(--color-warning, #e0a060)' }}>
            Couldn’t load deals: {error}
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => load(true)}>
            Try again
          </button>
        </EmptyState>
      ) : matched.counts.total === 0 ? (
        <EmptyState>
          <div>No deals to show right now.</div>
          <div style={subtleText}>
            Plugr pulls live deals from Plugin Boutique and Audio Plugin Deals once a day.
            Hit Refresh to try again.
          </div>
        </EmptyState>
      ) : (
        <>
          <Controls
            sortId={sortId} onSortChange={setSortId}
            filterId={filterId} onFilterChange={setFilterId}
          />

          {/* Saved deals — only shows if the user has wishlisted anything.
           *  Lives above Top picks because it's the most personal section
           *  (their own picks beat any algorithmic recommendation). */}
          {savedDealsList.length > 0 && (
            <Section
              kind="hero"
              title={`Saved deals (${savedDealsList.length})`}
              subtitle="Your wishlist — survives across app restarts."
              deals={savedDealsList}
              api={api}
              savedDeals={savedDeals}
              onToggleSaved={toggleSaved}
              findAlertForDeal={findAlertForDeal}
              onToggleDealAlert={onToggleDealAlert}
            />
          )}

          <Section
            kind="hero"
            title="Today’s top deals"
            subtitle="The best of what’s on sale right now, across every source."
            deals={topPicks}
            api={api}
            savedDeals={savedDeals}
            onToggleSaved={toggleSaved}
            priceHistory={priceHistory}
            onDismiss={(deal) => toggleDismissed(deal, true)}
            currencyPref={currencyPref}
            exchangeRates={exchangeRates}
            findAlertForDeal={findAlertForDeal}
            onToggleDealAlert={onToggleDealAlert}
            hideWhenEmpty
          />
          <Section
            title="From developers you trust"
            subtitle="Other products on sale from companies whose plugins you already use."
            deals={fromYourDevs}
            api={api}
            savedDeals={savedDeals}
            onToggleSaved={toggleSaved}
            priceHistory={priceHistory}
            onDismiss={(deal) => toggleDismissed(deal, true)}
            currencyPref={currencyPref}
            exchangeRates={exchangeRates}
            findAlertForDeal={findAlertForDeal}
            onToggleDealAlert={onToggleDealAlert}
            hideWhenEmpty
          />
          <Section
            title="Upgrades & expansions for your library"
            subtitle="Get more out of what you already own — updates, presets, sample libraries."
            deals={upgradesForYou}
            api={api}
            savedDeals={savedDeals}
            onToggleSaved={toggleSaved}
            priceHistory={priceHistory}
            onDismiss={(deal) => toggleDismissed(deal, true)}
            currencyPref={currencyPref}
            exchangeRates={exchangeRates}
            findAlertForDeal={findAlertForDeal}
            onToggleDealAlert={onToggleDealAlert}
            hideWhenEmpty
          />
          <Section
            title={`Browse all deals (${browseAll.length})`}
            subtitle="Everything else on offer right now."
            deals={showBrowseAll ? browseAll : []}
            api={api}
            savedDeals={savedDeals}
            onToggleSaved={toggleSaved}
            priceHistory={priceHistory}
            onDismiss={(deal) => toggleDismissed(deal, true)}
            currencyPref={currencyPref}
            exchangeRates={exchangeRates}
            findAlertForDeal={findAlertForDeal}
            onToggleDealAlert={onToggleDealAlert}
            collapsed={!showBrowseAll}
            onToggle={() => setShowBrowseAll((v) => !v)}
            collapsedHint="Show all"
            hideWhenEmpty={browseAll.length === 0}
          />
        </>
      )}

      {/* FTC affiliate disclosure. Always-on so it can't be forgotten
       *  once any source's affiliateId is wired up. */}
      <div style={ftcStyle}>
        Plugr may earn a commission from qualifying purchases made via these links,
        at no extra cost to you. Prices and final discounts are shown on the
        vendor’s page on click-through.
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Ranking
// ───────────────────────────────────────────────────────────────

// Tuple comparator — checks each signal in order, only consulting the
// next one if the previous one was a tie:
//   1. FREE always wins
//   2. Higher discount % wins
//   3. Ending soonest wins (tiebreaker only — never let a missing
//      end date demote a deal below a deal with a worse discount)
//
// Earlier attempts used a single composite score, which incorrectly
// penalized deals with no endsAt (most APD deals don't have one) so
// that a 98%-off-with-no-enddate would lose to 65%-off-ending-in-8d.
function byBestDealFirst(a, b) {
  const aFree = (a.priceBadge || '').toUpperCase() === 'FREE';
  const bFree = (b.priceBadge || '').toUpperCase() === 'FREE';
  if (aFree !== bFree) return aFree ? -1 : 1;

  const aPct = parsePctOff(a.priceBadge);
  const bPct = parsePctOff(b.priceBadge);
  if (aPct !== bPct) return bPct - aPct;

  const aEnds = a.endsAt ? Date.parse(a.endsAt) : Number.POSITIVE_INFINITY;
  const bEnds = b.endsAt ? Date.parse(b.endsAt) : Number.POSITIVE_INFINITY;
  return aEnds - bEnds;
}

// Pure highest-discount sort. Ignores FREE bias and end date so the
// user sees a strict % ranking. FREE deals fall to the bottom of this
// because parsePctOff('FREE') === 0 — that's fine; FREE has its own
// filter chip if the user wants those at the top.
function byDiscountDesc(a, b) {
  return parsePctOff(b.priceBadge) - parsePctOff(a.priceBadge);
}

// Soonest-ending first. Deals with no end date sort to the bottom so
// "ending soon" actually surfaces time-sensitive deals.
function byEndingSoon(a, b) {
  const aEnds = a.endsAt ? Date.parse(a.endsAt) : Number.POSITIVE_INFINITY;
  const bEnds = b.endsAt ? Date.parse(b.endsAt) : Number.POSITIVE_INFINITY;
  if (aEnds !== bEnds) return aEnds - bEnds;
  // Same end date (or both null): higher discount wins as a tiebreaker.
  return parsePctOff(b.priceBadge) - parsePctOff(a.priceBadge);
}

function parsePctOff(badge) {
  if (!badge) return 0;
  const m = String(badge).match(/(\d{1,3})\s*%/);
  return m ? parseInt(m[1], 10) : 0;
}

// Parse a currency string like "$9.99" into a number, or null.
function parsePriceStr(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

// Detect the source currency from a price string. Returns the 3-letter
// code or null. APD prices come tagged USD by upstream parsing; this
// is the fallback when we only have the string.
const CURRENCY_FROM_SYMBOL = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
function detectCurrency(s) {
  if (!s) return null;
  for (const c of String(s)) {
    if (CURRENCY_FROM_SYMBOL[c]) return CURRENCY_FROM_SYMBOL[c];
  }
  return null;
}

// Convert + format a price string into the user's preferred currency.
// Returns an object { display, originalDisplay, wasConverted }:
//   display          - the string to show ("≈€9.19" or "$9.99")
//   originalDisplay  - the original string (for tooltips)
//   wasConverted     - true when conversion actually changed currencies
// Falls back to the source string unchanged when conversion isn't
// possible (no rates, unknown currency, etc.).
function convertPrice(priceStr, targetCurrency, rates) {
  if (!priceStr) return null;
  const target = (targetCurrency || 'USD').toUpperCase();
  const source = detectCurrency(priceStr) || 'USD';
  const original = String(priceStr);
  if (source === target || !rates || !rates.rates) {
    return { display: original, originalDisplay: original, wasConverted: false };
  }
  const amount = parsePriceStr(priceStr);
  if (amount == null) {
    return { display: original, originalDisplay: original, wasConverted: false };
  }
  const fromRate = rates.rates[source];
  const toRate = rates.rates[target];
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    return { display: original, originalDisplay: original, wasConverted: false };
  }
  const inBase = amount / fromRate;
  const converted = inBase * toRate;
  const sym = ({ USD: '$', EUR: '€', GBP: '£', JPY: '¥' })[target] || '';
  // JPY rounds to whole numbers; everything else 2 decimals.
  const decimals = target === 'JPY' ? 0 : 2;
  const rounded = parseFloat(converted.toFixed(decimals));
  const whole = Math.floor(rounded);
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = decimals === 0
    ? `${sym}${wholeStr}`
    : `${sym}${wholeStr}${(rounded - whole).toFixed(decimals).slice(1)}`;
  return { display: `≈${formatted}`, originalDisplay: original, wasConverted: true };
}

// Renderer-side mirror of electron/lib/priceHistory.cjs's pickBadge. Kept
// here (rather than imported) so the renderer doesn't have to pull in
// the CommonJS module via IPC for every card. Logic must stay in sync.
//
// Eligibility based on DAYS TRACKED (not sample count) so a deal whose
// price has been stable for months still qualifies. firstSeenAt is the
// stable "we first started tracking this" date — set once, never
// updated even when same-price refreshes touch the latest sample.
//
// Rules:
//   - "Lowest in 30d" needs >= 14 days tracked
//   - "Lowest in 90d" needs >= 30 days tracked
//   - "Lowest ever"   needs >= 60 days tracked
//   - Match-with-tolerance: current price within 0.5% of historical low
function pickLowPriceBadge(deal, history, nowMs = Date.now()) {
  if (!deal || !deal.id || !history) return null;
  const entry = history[deal.id];
  if (!entry || !Array.isArray(entry.samples) || entry.samples.length === 0) return null;

  const current = parsePriceStr(deal.salePrice);
  if (current == null) return null;

  const firstSeenAt = entry.firstSeenAt || entry.samples[0].at;
  const firstAt = Date.parse(firstSeenAt);
  const daysOfHistory = Math.max(1, Math.floor((nowMs - firstAt) / 86_400_000));
  if (daysOfHistory < 14) return null;

  const tolerantMatch = (target) => {
    if (target == null) return false;
    const tol = Math.max(0.01, target * 0.005);
    return current <= target + tol;
  };

  // Compute lowest within window.
  const lowestIn = (days) => {
    const cutoff = nowMs - days * 86_400_000;
    let low = null;
    for (const s of entry.samples) {
      if (Date.parse(s.at) < cutoff) continue;
      if (s.sale == null) continue;
      if (low == null || s.sale < low) low = s.sale;
    }
    return low;
  };

  let lowestEver = entry.samples[0].sale;
  for (const s of entry.samples) {
    if (s.sale != null && s.sale < lowestEver) lowestEver = s.sale;
  }

  if (daysOfHistory >= 60 && tolerantMatch(lowestEver))      return 'LOWEST EVER';
  if (daysOfHistory >= 30 && tolerantMatch(lowestIn(90)))    return 'LOWEST IN 90D';
  if (daysOfHistory >= 14 && tolerantMatch(lowestIn(30)))    return 'LOWEST IN 30D';
  return null;
}

// ───────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────

function Header({ fetchedAt, totalCount, onRefresh, refreshing }) {
  return (
    <div style={headerStyle}>
      <div>
        <h1 style={titleStyle}>Deals</h1>
        <div style={subtleText}>
          {totalCount > 0
            ? `${totalCount} live deals from Plugin Boutique and Audio Plugin Deals.`
            : 'Sales on audio plugins, refreshed daily.'}
          {fetchedAt && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              · Updated {formatRelative(fetchedAt)}
            </span>
          )}
        </div>
      </div>
      <button
        className="btn"
        onClick={onRefresh}
        disabled={refreshing}
        style={{ alignSelf: 'flex-start' }}
        title="Force a refetch (ignores 24h cache)"
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

function Controls({ sortId, onSortChange, filterId, onFilterChange }) {
  // Split filters into two visual groups so the row reads as
  // "ownership | type" rather than one undifferentiated stream of 9
  // chips. Each group has its own background so the separator is
  // implicit (no divider element needed).
  const OWNERSHIP_IDS = new Set(['all', 'unowned', 'fromDevs', 'upgrades']);
  const ownershipFilters = FILTER_OPTIONS.filter((f) => OWNERSHIP_IDS.has(f.id));
  const typeFilters = FILTER_OPTIONS.filter((f) => !OWNERSHIP_IDS.has(f.id));

  const renderChip = (f) => {
    const active = f.id === filterId;
    return (
      <button
        key={f.id}
        type="button"
        onClick={() => onFilterChange(f.id)}
        style={{
          ...chipStyle,
          background: active ? 'var(--accent, #6ec1ff)' : 'transparent',
          color: active ? '#0a0d12' : 'inherit',
          fontWeight: active ? 600 : 500,
        }}
      >
        {f.label}
      </button>
    );
  };

  return (
    <div style={controlsRowStyle}>
      <div style={filterGroupsStyle}>
        <div style={filterGroupStyle} title="Filter by what's in your library">
          {ownershipFilters.map(renderChip)}
        </div>
        <div style={filterGroupStyle} title="Filter by deal type">
          {typeFilters.map(renderChip)}
        </div>
      </div>
      <label style={sortControlStyle}>
        <span style={{ ...subtleText, marginRight: 6 }}>Sort:</span>
        <select
          value={sortId}
          onChange={(e) => onSortChange(e.target.value)}
          style={selectStyle}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Section({
  title,
  subtitle,
  deals,
  api,
  kind,
  savedDeals,
  onToggleSaved,
  priceHistory,
  onDismiss,
  currencyPref,
  exchangeRates,
  hideWhenEmpty,
  collapsed,
  onToggle,
  collapsedHint,
  // Watch-this-deal wiring forwarded down to DealCard.
  findAlertForDeal,
  onToggleDealAlert,
}) {
  if (hideWhenEmpty && (!deals || deals.length === 0) && !collapsed) return null;
  // Hero section uses a bigger / wider card layout. The discriminator
  // is passed down to DealCard so it can pick a richer visual style for
  // the front-page picks.
  const isHero = kind === 'hero';
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <div>
          <h2 style={isHero ? sectionTitleHeroStyle : sectionTitleStyle}>{title}</h2>
          {subtitle && <div style={subtleText}>{subtitle}</div>}
        </div>
        {onToggle && (
          <button className="btn" onClick={onToggle}>
            {collapsed ? (collapsedHint || 'Show') : 'Hide'}
          </button>
        )}
      </div>
      {(!deals || deals.length === 0) ? (
        !collapsed && <div style={{ ...subtleText, padding: '12px 0' }}>Nothing to show right now.</div>
      ) : (
        <div style={isHero ? dealGridHeroStyle : dealGridStyle}>
          {deals.map((d) => (
            <DealCard
              key={d.id}
              deal={d}
              api={api}
              hero={isHero}
              isSaved={!!(savedDeals && savedDeals[d.id])}
              onToggleSaved={onToggleSaved}
              lowPriceBadge={pickLowPriceBadge(d, priceHistory)}
              onDismiss={onDismiss}
              currencyPref={currencyPref}
              exchangeRates={exchangeRates}
              isWatched={findAlertForDeal ? !!findAlertForDeal(d) : false}
              onToggleWatch={onToggleDealAlert}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DealCard({ deal, api, hero, isSaved, onToggleSaved, lowPriceBadge, onDismiss, currencyPref, exchangeRates, isWatched, onToggleWatch }) {
  const [hovered, setHovered] = useState(false);
  const [imgErrored, setImgErrored] = useState(false);
  const onClick = () => {
    if (!deal.url) return;
    // Fire-and-forget local click counter for affiliate-network
    // diagnostics — never blocks or delays the browser-open call.
    if (api.trackDealClick) {
      try { api.trackDealClick(deal.source, deal.url); } catch { /* ignore */ }
    }
    api.openExternal(deal.url);
  };

  const isFree = (deal.priceBadge || '').toUpperCase() === 'FREE';
  const pctOff = parsePctOff(deal.priceBadge);
  const isMassive = pctOff >= 70;
  const daysLeft = daysUntil(deal.endsAt);

  // Color treatment by deal type.
  const accentColor = isFree
    ? 'var(--success, #4cc060)'
    : isMassive
      ? 'var(--warning, #ff9744)'
      : 'var(--accent, #6ec1ff)';
  const accentBg = isFree
    ? 'rgba(76, 192, 96, 0.18)'
    : isMassive
      ? 'rgba(255, 151, 68, 0.18)'
      : 'rgba(110, 193, 255, 0.18)';

  // Hover lift effect — feels tactile without being twitchy.
  const cardTransform = hovered ? 'translateY(-2px)' : 'translateY(0)';
  const cardShadow = hovered
    ? '0 6px 18px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.1)'
    : '0 1px 3px rgba(0,0,0,0.08)';
  const cardBorderColor = hovered
    ? accentColor
    : 'var(--border-color, rgba(255,255,255,0.08))';

  const showImage = deal.imageUrl && !imgErrored;
  const cardStyle = hero ? cardHeroStyle : cardStandardStyle;

  return (
    <a
      href={deal.url}
      onClick={(e) => { e.preventDefault(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardStyle,
        transform: cardTransform,
        boxShadow: cardShadow,
        borderColor: cardBorderColor,
      }}
      title={deal.title}
    >
      {/* Media — image with overlay badges. Falls back to a colored
       *  block with the discount centered when no image is available. */}
      <div style={{
        ...mediaStyle,
        aspectRatio: hero ? '16 / 10' : '16 / 11',
        background: showImage
          ? 'var(--media-bg, #1a1d22)'
          : `linear-gradient(135deg, ${accentBg}, var(--card-bg, rgba(0,0,0,0.2)))`,
      }}>
        {showImage ? (
          <img
            src={deal.imageUrl}
            alt=""
            loading="lazy"
            onError={() => setImgErrored(true)}
            style={imgStyle}
          />
        ) : (
          // No image — render a layered fallback so the card looks
          // intentional rather than half-empty. Top: large developer
          // name (the brand). Below: subtle source label. The whole
          // thing sits on a diagonal gradient stripe in the accent
          // color so cards don't read as broken.
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '20px 24px',
            textAlign: 'center',
            background: `repeating-linear-gradient(135deg, ${accentBg}, ${accentBg} 12px, transparent 12px, transparent 24px)`,
          }}>
            <div style={{
              fontSize: hero ? 22 : 17,
              fontWeight: 800,
              letterSpacing: '-0.2px',
              color: accentColor,
              lineHeight: 1.15,
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}>
              {deal.developer || deal.title || deal.source}
            </div>
            {deal.priceBadge && (
              <div style={{
                marginTop: 10,
                fontSize: hero ? 14 : 12,
                fontWeight: 700,
                letterSpacing: '0.5px',
                color: accentColor,
                opacity: 0.8,
              }}>
                {deal.priceBadge}
              </div>
            )}
          </div>
        )}

        {/* Discount badge — top-left overlay on the image */}
        {deal.priceBadge && showImage && (
          <div style={{
            ...overlayBadgeStyle,
            top: 8, left: 8,
            background: accentColor,
            color: '#fff',
          }}>
            {deal.priceBadge}
          </div>
        )}

        {/* Countdown — top-right, urgency cue */}
        {daysLeft != null && daysLeft <= 14 && (
          <div style={{
            ...overlayBadgeStyle,
            top: 8, right: 8,
            background: daysLeft <= 3 ? 'rgba(255, 80, 80, 0.92)' : 'rgba(0,0,0,0.55)',
            color: '#fff',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
          }}>
            {daysLeft <= 0 ? 'Ends today' : daysLeft === 1 ? 'Ends tomorrow' : `Ends in ${daysLeft}d`}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        <div style={titleRowStyle}>
          <div style={hero ? cardTitleHeroStyle : cardTitleStyle}>{deal.title}</div>
          {/* Save/wishlist heart — separate clickable button. stopPropagation
           *  so toggling save doesn't ALSO open the vendor page. */}
          {onToggleSaved && (
            <button
              type="button"
              aria-label={isSaved ? 'Remove from saved deals' : 'Save deal for later'}
              title={isSaved ? 'Saved — click to remove' : 'Save for later'}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSaved(deal); }}
              style={{
                ...saveButtonStyle,
                color: isSaved ? '#ff5d6c' : 'var(--text-muted, rgba(255,255,255,0.45))',
              }}
            >
              {isSaved ? '♥' : '♡'}
            </button>
          )}
          {/* Watch-for-deals bell — turns this card into a recurring
           *  alert (notifies on future deals for the same title/dev).
           *  Distinct from save/wishlist which only stores THIS deal. */}
          {onToggleWatch && (
            <button
              type="button"
              aria-label={isWatched ? 'Stop watching for deals on this plugin' : 'Watch for deals on this plugin'}
              aria-pressed={!!isWatched}
              title={isWatched
                ? 'Watching — click to stop'
                : 'Notify me when this is on sale again'}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleWatch(deal); }}
              style={{
                ...saveButtonStyle,
                fontSize: 14,
                filter: isWatched ? 'none' : 'grayscale(1) opacity(.55)',
              }}
            >
              {isWatched ? '🔔' : '🔕'}
            </button>
          )}
          {/* Dismiss (X) — hides this deal from every section. Toast
           *  with Undo lets the user reverse it without digging into
           *  Preferences. stopPropagation prevents click-through to
           *  the vendor page. */}
          {onDismiss && (
            <button
              type="button"
              aria-label="Hide this deal"
              title="Hide this deal"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(deal); }}
              style={{
                ...saveButtonStyle,
                fontSize: 16,
                color: 'var(--text-muted, rgba(255,255,255,0.4))',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#ff5d6c'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted, rgba(255,255,255,0.4))'; }}
            >
              ×
            </button>
          )}
        </div>

        {(() => {
          // Prefer the library's canonical developer name when this deal
          // matches an owned developer/plugin — that way "WA Productions"
          // (APD's spelling) renders as "W.A. Production" (how the user
          // has it cataloged). Falls back to the scraper's developer
          // string when there's no match.
          const matchedDev = deal.match && deal.match.items && deal.match.items[0]
            && deal.match.items[0].developer;
          const displayedDev = matchedDev || deal.developer;
          return (
            <div style={metaRowStyle}>
              {displayedDev && (
                <span style={metaTextStyle}>{displayedDev}</span>
              )}
              {displayedDev && <span style={metaDotStyle}>·</span>}
              <span style={metaTextStyle}>{deal.source}</span>
              {deal._stale && (
                <>
                  <span style={metaDotStyle}>·</span>
                  <span style={{ ...metaTextStyle, color: 'var(--color-warning, #e0a060)' }}>
                    no longer live
                  </span>
                </>
              )}
            </div>
          );
        })()}

        {/* Price block — sale + struck-through original (APD-style)
         *  OR badge text only when we don't have prices (PB-style).
         *  Prices are converted to the user's currencyPref when an
         *  exchange-rate table is available; the title attr keeps the
         *  original source price visible on hover. */}
        {(() => {
          if (!deal.salePrice && !deal.regularPrice) return null;
          const sale = convertPrice(deal.salePrice, currencyPref, exchangeRates);
          const regular = convertPrice(deal.regularPrice, currencyPref, exchangeRates);
          const tip = (sale && sale.wasConverted)
            ? `Original: ${sale.originalDisplay}${regular ? ` / ${regular.originalDisplay}` : ''}`
            : undefined;
          return (
            <div style={priceRowStyle} title={tip}>
              {sale && (
                <span style={{ ...salePriceStyle, color: accentColor }}>{sale.display}</span>
              )}
              {regular && regular.display !== (sale && sale.display) && (
                <span style={regularPriceStyle}>{regular.display}</span>
              )}
            </div>
          );
        })()}
        {!(deal.salePrice || deal.regularPrice) && !showImage ? null : (deal.salePrice || deal.regularPrice) ? null : (
          // For image cards w/o explicit prices, repeat the badge text
          // below as a price-shaped line so the eye lands on it.
          deal.priceBadge && (
            <div style={priceRowStyle}>
              <span style={{ ...salePriceStyle, color: accentColor }}>{deal.priceBadge}</span>
            </div>
          )
        )}

        {/* Low-price badge — strongest single conversion signal we can
         *  show ("buy now, this won't get cheaper"). Only appears once
         *  we've collected enough history to be meaningful (see
         *  pickLowPriceBadge). Green for "lowest ever", accent for
         *  shorter windows. */}
        {lowPriceBadge && (
          <div style={{
            ...lowPriceBadgeStyle,
            background: lowPriceBadge === 'LOWEST EVER'
              ? 'var(--success-bg, rgba(76, 192, 96, 0.18))'
              : 'var(--accent-bg, rgba(110, 193, 255, 0.18))',
            color: lowPriceBadge === 'LOWEST EVER'
              ? 'var(--success, #4cc060)'
              : 'var(--accent, #6ec1ff)',
          }}>
            ★ {lowPriceBadge}
          </div>
        )}

        {/* Short description — gives the user enough context to want
         *  to click on a plugin they may have never heard of. Capped
         *  at 2 lines via WebkitLineClamp so the card heights stay
         *  comparable. Skipped silently if the source didn't expose
         *  one (some PB cards). */}
        {deal.description && (
          <div style={descStyle}>{deal.description}</div>
        )}

        {/* Ownership context — deduplicate item names (often the same
         *  plugin matched across VST3 + AU + VST2 formats, which read
         *  as "Pigments, Pigments +3" — uninformative). Show distinct
         *  names; fall back to a clean count when there's nothing
         *  better to say. */}
        {deal.match && deal.match.kind === 'owned-developer' && (
          <div style={ownerHintStyle}>
            You have plugins by {deal.match.developer}.
          </div>
        )}
        {deal.match && deal.match.kind === 'owned-plugin' && (() => {
          const uniqueNames = Array.from(new Set(deal.match.items.map((i) => i.name)));
          if (uniqueNames.length === 1 && deal.match.items.length > 1) {
            // Same plugin across N formats — say so explicitly.
            return (
              <div style={ownerHintStyle}>
                You own {uniqueNames[0]} ({deal.match.items.length} formats).
              </div>
            );
          }
          if (uniqueNames.length === 1) {
            return <div style={ownerHintStyle}>You own {uniqueNames[0]}.</div>;
          }
          const shown = uniqueNames.slice(0, 2).join(', ');
          const extra = uniqueNames.length - 2;
          return (
            <div style={ownerHintStyle}>
              Related to your {shown}{extra > 0 ? ` and ${extra} more` : ''}.
            </div>
          );
        })()}
      </div>
    </a>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function formatRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)}d ago`;
  if (sec < 86400 * 30) return `${Math.round(sec / 86400 / 7)}w ago`;
  return `${Math.round(sec / 86400 / 30)}mo ago`;
}

function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  return Math.ceil(ms / 86_400_000);
}

// ───────────────────────────────────────────────────────────────
// Styles — kept inline so this component is self-contained, matching
// the rest of the app. CSS variables fall back to dark-mode-friendly
// values so theme switches don't blow up the design.
// ───────────────────────────────────────────────────────────────

const pageStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
  padding: '20px 24px 80px',
};

// Per-source refresh-progress strip styles. Slim line + thin bar so it
// fits under the header without pushing the deal grid down too much.
const progressStripStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: -16,
  marginBottom: 20,
  padding: '10px 12px',
  background: 'var(--card-bg, rgba(255,255,255,0.04))',
  borderRadius: 6,
  fontSize: 12,
};
const progressLineStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const progressBarOuterStyle = {
  flex: 1,
  height: 4,
  background: 'rgba(255,255,255,0.08)',
  borderRadius: 2,
  overflow: 'hidden',
  marginLeft: 8,
};
const progressBarInnerStyle = {
  display: 'block',
  height: '100%',
  background: 'var(--accent, #6ec1ff)',
  transition: 'width 200ms ease',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  marginBottom: 28,
};

const titleStyle = {
  fontSize: 24,
  fontWeight: 700,
  margin: '0 0 4px 0',
};

const subtleText = {
  fontSize: 12,
  opacity: 0.7,
};

const sectionStyle = {
  marginBottom: 36,
};

const sectionHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  marginBottom: 14,
  gap: 12,
};

const sectionTitleStyle = {
  fontSize: 15,
  fontWeight: 600,
  margin: '0 0 2px 0',
};

const sectionTitleHeroStyle = {
  fontSize: 18,
  fontWeight: 700,
  margin: '0 0 2px 0',
};

// Hero grid: 2 cols wide, larger cards.
const dealGridHeroStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
  gap: 16,
};

// Standard grid: more cards per row.
const dealGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 14,
};

const cardStandardStyle = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 10,
  border: '1px solid',
  background: 'var(--card-bg, rgba(255,255,255,0.04))',
  color: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
  overflow: 'hidden',
  transition: 'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease',
  willChange: 'transform',
};

const cardHeroStyle = {
  ...cardStandardStyle,
  borderRadius: 12,
};

const mediaStyle = {
  position: 'relative',
  width: '100%',
  overflow: 'hidden',
};

const imgStyle = {
  width: '100%',
  height: '100%',
  // `contain` preserves the whole image (no cropping) at the cost of
  // some letterbox space. Picked over `cover` because PB sale banners
  // include important text/branding at the edges that `cover` was
  // chopping off (e.g. "Plugin Alliance" → "gin Alliance" when the
  // 16:10 card cropped 20% off each side of a wider banner).
  objectFit: 'contain',
  display: 'block',
  // Subtle dark backdrop behind the letterbox so the transition from
  // image to card body feels intentional, not accidental.
  background: 'rgba(0,0,0,0.25)',
};

const overlayBadgeStyle = {
  position: 'absolute',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.5px',
  padding: '4px 8px',
  borderRadius: 4,
  textTransform: 'uppercase',
};

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 14px 14px',
};

const titleRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 8,
};

const cardTitleStyle = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.3,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const cardTitleHeroStyle = {
  ...cardTitleStyle,
  fontSize: 16,
  WebkitLineClamp: 2,
};

const metaRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const metaTextStyle = {
  fontSize: 11,
  opacity: 0.7,
};

const metaDotStyle = {
  fontSize: 11,
  opacity: 0.4,
};

const priceRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  marginTop: 4,
};

const salePriceStyle = {
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: '0.2px',
};

const regularPriceStyle = {
  fontSize: 12,
  opacity: 0.55,
  textDecoration: 'line-through',
};

// Low-price badge. Distinct from the orange/red discount-overlay on
// the image — this one is data-driven (history) rather than scraped
// from the source page, so it gets its own visual treatment.
const lowPriceBadgeStyle = {
  alignSelf: 'flex-start',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.5px',
  padding: '3px 7px',
  borderRadius: 4,
  marginTop: 6,
};

const descStyle = {
  fontSize: 12,
  lineHeight: 1.4,
  opacity: 0.75,
  marginTop: 6,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const ownerHintStyle = {
  fontSize: 11,
  opacity: 0.6,
  marginTop: 4,
  fontStyle: 'italic',
};

// Filter chips + sort dropdown
const controlsRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  marginBottom: 24,
  paddingBottom: 16,
  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))',
};

const chipsRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

// Outer container holding both filter groups side-by-side. Wraps to
// a column at narrow widths.
const filterGroupsStyle = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  flex: 1,
};

// Each group is a self-contained chip cluster with its own pill-shaped
// background — gives a visual seam between the ownership and type
// filters without needing an actual divider element.
const filterGroupStyle = {
  display: 'inline-flex',
  flexWrap: 'wrap',
  gap: 4,
  padding: 4,
  background: 'var(--card-bg, rgba(255,255,255,0.04))',
  borderRadius: 999,
  border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
};

const chipStyle = {
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: 999,
  border: '1px solid var(--border-color, rgba(255,255,255,0.07))',
  cursor: 'pointer',
  letterSpacing: '0.2px',
  transition: 'background 120ms, color 120ms',
};

const sortControlStyle = {
  display: 'flex',
  alignItems: 'center',
};

const selectStyle = {
  fontSize: 12,
  padding: '4px 8px',
  background: 'var(--card-bg, rgba(255,255,255,0.04))',
  color: 'inherit',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 6,
  cursor: 'pointer',
};

// Heart/save button on each card — positioned inline at the right of
// the title row. Background-less, so it doesn't compete with the card
// itself, but big enough to be a comfortable click target.
const saveButtonStyle = {
  flexShrink: 0,
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 18,
  lineHeight: 1,
  padding: 0,
  transition: 'color 120ms',
};

const ftcStyle = {
  marginTop: 40,
  paddingTop: 16,
  borderTop: '1px solid var(--border-color, rgba(255,255,255,0.07))',
  fontSize: 11,
  opacity: 0.55,
  lineHeight: 1.5,
  textAlign: 'center',
  maxWidth: 640,
  marginLeft: 'auto',
  marginRight: 'auto',
};
