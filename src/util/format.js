// Renderer-side formatting helpers (kept tiny so we don't need IPC for them).

/**
 * The subcategory shown next to the category. Returns '' when the
 * subcategory is missing or redundantly identical to the category — so
 * callers never need to render "Effect / Effect" or "Application /
 * Application". Use displayCategory() below for the full "Cat / Sub" string.
 */
export function displaySubcategory(item) {
  if (!item) return '';
  const sub = (item.subcategory || '').trim();
  const cat = (item.category || '').trim();
  if (!sub) return '';
  if (sub.toLowerCase() === cat.toLowerCase()) return '';
  if (sub.toLowerCase() === 'uncategorized') return '';
  return sub;
}

/** Full "Category / Subcategory" string with redundancy collapsed. */
export function displayCategory(item) {
  if (!item) return '';
  const cat = item.category || '';
  const sub = displaySubcategory(item);
  return sub ? `${cat} / ${sub}` : cat;
}

/**
 * Derive the display update status for an item.
 *
 * Precedence:
 *   1. Real status from a successful version check ('outdated' / 'current'
 *      / 'ahead') always wins — it's the most informative.
 *   2. Otherwise, if the developer has a companion app, fall back to
 *      'managed' — even when a previous check attempt set status to
 *      'no-source' / 'error' / 'parse-failed'. Those failure states are
 *      not interesting for the user when a companion app is available;
 *      the companion is the real source of truth.
 *   3. Otherwise return whatever non-real status came back, falling
 *      through to 'unknown' for items with no record at all.
 */
// 'manual-check' is a "real" status in the sense that it represents an
// intentional user choice (saved a URL but knows auto-detect won't work),
// so it should NOT fall back to 'managed' or 'unknown'.
const REAL_UPDATE_STATUSES = new Set(['outdated', 'current', 'ahead', 'manual-check', 'not-applicable']);
export function deriveUpdateStatus(item, update) {
  if (update && update.status && REAL_UPDATE_STATUSES.has(update.status)) {
    return update.status;
  }
  if (item && item.registry && item.registry.companionApp) return 'managed';
  if (update && update.status) return update.status;
  return 'unknown';
}

/** Pull a friendly companion-app name for "Managed by X" display. */
export function companionAppDisplayName(item) {
  const c = item && item.registry && item.registry.companionApp;
  if (!c) return null;
  return c.displayName || c.name || null;
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr = Math.round(mo / 12);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}

// Numeric-aware string comparison. Use this for ANY sort that displays
// human-readable text — plugin names, developer names, tag labels,
// project names, etc. The default localeCompare sorts lexically so
// "RX 10" comes before "RX 7" (because "1" < "7" character-by-character).
// With { numeric: true }, sequences of digits are compared as numbers,
// so "RX 7" < "RX 10" — what users expect.
//
// `sensitivity: 'base'` folds case and accents so "Ozone" and "OZONE"
// sort next to each other rather than across the entire alphabet.
export function naturalCompare(a, b) {
  return String(a || '').localeCompare(
    String(b || ''),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
}

// Strip tracking parameters (utm_*, srsltid, gclid, fbclid, etc.)
// from a URL. Used when the user pastes URLs into the manual-source
// flow so saved sources are canonical (a Plugin Alliance link copied
// off Google Search has a giant srsltid param that's irrelevant to
// the page content). Mirrors the backend cleanUrl in
// electron/lib/httpFetch.cjs — keep these two lists in sync.
const TRACKING_PARAM_NAMES = new Set([
  'srsltid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name',
  'gclid', 'gad_source', 'gbraid', 'wbraid', 'dclid', '_ga', '_gl',
  'fbclid',
  'msclkid',
  'mc_eid', 'mc_cid',
  'hscta', 'hsctatracking', '_hsenc', '_hsmi',
  'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad',
  'ref', 'referrer', 'referer',
  'aff', 'affiliate', 'affid', 'aff_id',
  'campaign_id', 'cmpid', 'icid', 'cid',
  'igshid', 'yclid', 'ttclid', 'twclid', 'li_fat_id', 'sccid',
  'epik', 'pp', 'mkt_tok',
  'mtm_source', 'mtm_medium', 'mtm_campaign', 'mtm_keyword', 'mtm_content',
  'pk_source', 'pk_medium', 'pk_campaign', 'pk_kwd', 'pk_keyword', 'pk_content',
  'oly_anon_id', 'oly_enc_id', 's_kwcid',
]);

export function cleanUrl(input) {
  if (!input || typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  let u;
  try { u = new URL(trimmed); }
  catch { return trimmed; }
  const toDelete = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_PARAM_NAMES.has(key.toLowerCase())) toDelete.push(key);
  }
  for (const k of toDelete) u.searchParams.delete(k);
  let out = u.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

/**
 * Major version number, or null when the string doesn't start with one.
 *   '2' -> 2 · '2.6.4' -> 2 · 'v3.0.1' -> 3 · '1.0.5_b240508' -> 1 · 'abc' -> null
 */
export function majorOf(v) {
  if (!v) return null;
  const m = String(v).match(/^\s*v?(\d+)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * True when the published version is a WHOLE major ahead of what's
 * installed — the "Major upgrade" case, which for most audio vendors
 * means a paid upgrade rather than a free patch. Status-agnostic on
 * purpose: callers decide whether they only care while outdated.
 */
export function isMajorUpgrade(item, update) {
  const installedMajor = majorOf(item && item.version);
  const latestMajor = majorOf(update && update.latestVersion);
  return installedMajor != null && latestMajor != null && latestMajor >= installedMajor + 1;
}

/**
 * The single source of truth for "the user has silenced this update".
 * Three ways to mute, in increasing breadth:
 *
 *   ignoredUpdateVersion  — this exact version string only. NOTE this
 *     un-mutes the moment the vendor ships a point release, because the
 *     pin no longer matches the new latestVersion.
 *   ignoreMajorUpgrades   — anything a whole major ahead of what's
 *     installed. Survives point releases within that unwanted major
 *     (5.0 → 5.0.1 → 5.1 all stay quiet), and clears itself if the user
 *     ever buys the upgrade, because the installed major catches up.
 *   ignoreAllUpdates      — permanently silent, whatever ships.
 *
 * Previously this rule was written out by hand in five places; a fourth
 * copy was one edit away from drifting.
 */
export function isUpdateMuted(item, update) {
  if (!item || !update) return false;
  if (item.ignoreAllUpdates) return true;
  if (item.ignoredUpdateVersion && item.ignoredUpdateVersion === update.latestVersion) return true;
  if (item.ignoreMajorUpgrades && isMajorUpgrade(item, update)) return true;
  return false;
}
