// Exchange-rate fetch + cache for the Deals tab's currency selector.
//
// Source: frankfurter.app — a free, no-key API backed by daily ECB
// reference rates. Cached for 24h to avoid hammering the endpoint
// and to keep refresh-time costs flat. Falls back to hardcoded
// approximate rates if the fetch ever fails so the UI never breaks
// on a temporary outage.
//
// Stored in cache.exchangeRates as:
//   { base: 'USD', rates: { EUR: 0.92, GBP: 0.78, JPY: 148.5 },
//     fetchedAt: ISO, source: 'frankfurter' | 'fallback' }
//
// All prices in Plugr's deals pipeline are USD-base (APD's product
// metadata explicitly tags currency=USD); the API call accordingly
// fetches USD → others. Conversion helpers below are general so we
// could add EUR-base or GBP-base sources later without rework.

const FETCH_TIMEOUT_MS = 8_000;
const TTL_MS = 24 * 60 * 60 * 1000;
const UA = 'Plugr/0.1 (+https://github.com/plugr-app/plugr)';

// Supported display currencies. Adding a currency here just makes it
// available in the Preferences selector — the rate fetch already
// returns all of these.
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];

// Hardcoded fallback rates relative to USD. Approximate as of mid-2026
// — used only when the API is unreachable. Off by a few percent at
// most; better than failing the conversion entirely. These are NOT
// shown to the user as "live"; the cache stamp records source='fallback'.
const FALLBACK_RATES = {
  base: 'USD',
  rates: {
    USD: 1,
    EUR: 0.92,
    GBP: 0.78,
    JPY: 148.50,
  },
};

// Currency display symbols. Kept here so the renderer doesn't need to
// duplicate them.
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

async function fetchLatest() {
  // Frankfurter returns USD-base when ?from=USD. The default base is
  // EUR; we set base explicitly to keep our internal model simple.
  const url = 'https://api.frankfurter.app/latest?from=USD';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.rates) throw new Error('Malformed rates response');
    // Frankfurter omits the base currency from its rates object (USD
    // would always be 1). Add it back so consumers don't need a special
    // case for base==target conversions.
    const rates = { ...data.rates, USD: 1 };
    return {
      base: data.base || 'USD',
      rates,
      fetchedAt: new Date().toISOString(),
      source: 'frankfurter',
    };
  } finally {
    clearTimeout(timer);
  }
}

// Get rates, using the cache when fresh. Falls back to hardcoded
// rates on any failure (network down, API down, etc.) so callers
// always get usable numbers.
async function getRates(existing, { force } = {}) {
  const cached = existing && existing.fetchedAt
    ? existing
    : null;
  const fresh = cached
    && (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS);
  if (fresh && !force) return cached;

  try {
    const data = await fetchLatest();
    console.log(`[currency] rates fetched: 1 USD = ${data.rates.EUR.toFixed(4)} EUR / ${data.rates.GBP.toFixed(4)} GBP`);
    return data;
  } catch (err) {
    console.warn(`[currency] rate fetch failed: ${err.message}. Using fallback.`);
    // If we have any cached rates at all, prefer them over fallback —
    // they're more recent than hardcoded approximations.
    if (cached) return cached;
    return { ...FALLBACK_RATES, fetchedAt: new Date().toISOString(), source: 'fallback' };
  }
}

// Convert an amount from one currency to another using the provided
// rates object. All rates are relative to rates.base (always USD in
// our pipeline). Returns the converted amount as a number, or null
// when conversion isn't possible (missing rate, bad input).
function convert(amount, fromCurrency, toCurrency, rates) {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (!rates || !rates.rates) return null;
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!from || !to) return null;
  if (from === to) return amount;

  // Convert source → base, then base → target.
  const fromRate = rates.rates[from];
  const toRate = rates.rates[to];
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate)) return null;

  // amount in `from` units divided by fromRate gives base units, then
  // multiplied by toRate gives target units.
  const inBase = amount / fromRate;
  return inBase * toRate;
}

// Format a numeric amount + currency code as a display string. JPY
// (and other 0-decimal currencies) round to whole numbers; everything
// else uses 2 decimals.
function formatPrice(amount, currency) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const code = String(currency || '').toUpperCase();
  const sym = CURRENCY_SYMBOLS[code] || '';
  const decimals = code === 'JPY' ? 0 : 2;
  // Round to the target precision FIRST (toFixed rounds), then format.
  // This avoids JPY's $9.99 conversion of $1483.515 showing as $1483
  // (floored) when conventional rounding would put it at $1484.
  const rounded = parseFloat(amount.toFixed(decimals));
  const whole = Math.floor(rounded);
  // Thousands separator at 3-digit boundaries. Locale-aware would be
  // nicer but adds dependencies; this works for the typical price range.
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return `${sym}${wholeStr}`;
  const fractional = (rounded - whole).toFixed(decimals).slice(1); // ".99"
  return `${sym}${wholeStr}${fractional}`;
}

module.exports = {
  SUPPORTED_CURRENCIES,
  CURRENCY_SYMBOLS,
  FALLBACK_RATES,
  TTL_MS,
  getRates,
  convert,
  formatPrice,
  fetchLatest,  // exported for tests
};
