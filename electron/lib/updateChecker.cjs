// Update checker.
//
// For each scanned plugin, look up its registry entry and try to fetch the
// latest version from `updateUrl`, applying `versionRegex`. Results are
// merged and returned to the renderer.
//
// Notes & caveats:
//   - Web pages change. The shipped registry has a best-effort regex for each
//     known product; if a developer redesigns their site the regex may stop
//     matching. Failures are reported per-item so the UI can show "couldn't
//     check" without breaking the whole batch.
//   - We dedupe by updateUrl so we don't hit the same page once per plugin.
//   - Concurrency is capped to be polite to developer sites.

const semver = require('semver');
const { checkSparkleFeed } = require('./sparkle.cjs');
const { stripHtml } = require('./discoverUpdateSource.cjs');

const FETCH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 6;
// HTTP fetch goes through Electron's net.request (Chromium's HTTP
// stack — same as a real browser tab) when available. Falls back to
// global fetch() for tests. See httpFetch.cjs.
const { httpGet, UA } = require('./httpFetch.cjs');

async function fetchOnce(url) {
  return httpGet(url, { timeoutMs: FETCH_TIMEOUT_MS, redirect: 'follow' });
}

// Some WordPress sites (e.g. aom-factory.jp) hard-404 a bare URL but serve
// the page at the same path + "/". Retry with a trailing slash before
// giving up so saved sources keep working without manual cleanup. Skipped
// when the URL already ends in "/" or has a query string / fragment.
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

/**
 * Extract a version string from page text using a regex.
 *
 * Critical: this strips HTML tags before running the regex, because that's
 * what discoverUpdateSource does when it FINDS the pattern. Without this
 * matching pre-processing the saved patterns (which look for things like
 * "version: 1.2.3" in clean text) would never match raw HTML where there
 * are tags between the keyword and the digits (e.g. "<strong>version:</strong> 1.2.3").
 *
 * We try the stripped text first, and if no match is found we fall back to
 * the raw HTML — covers patterns that were specifically designed against
 * unstripped HTML in the bundled registry.
 */
function extractVersion(text, regexSource) {
  if (!regexSource) return null;
  let re;
  try { re = new RegExp(regexSource, 'i'); } catch { return null; }
  const stripped = stripHtml(text || '');
  let m = stripped.match(re);
  if (!m) m = (text || '').match(re);
  if (!m) return null;
  return (m[1] || m[0]).trim();
}

/**
 * Compare two version strings. Returns:
 *   "outdated" if installed < latest
 *   "current"  if equal
 *   "ahead"    if installed > latest (e.g. user has a beta)
 *   "unknown"  if not comparable
 */
// True when every numeric segment of `latest` is matched exactly by
// the same-indexed segment of `installed`. Used to detect cases like
// installed = "11.6.0.2336" vs latest = "11.6.0", where the extra
// trailing segment is a build/internal identifier and the user
// effectively has the latest release. Both inputs are pre-split arrays
// of integers (NaN-safe via `|| 0`).
function leadingPartsMatch(installedParts, latestParts) {
  if (!installedParts.length || !latestParts.length) return false;
  if (installedParts.length <= latestParts.length) return false;
  for (let i = 0; i < latestParts.length; i++) {
    if ((installedParts[i] || 0) !== (latestParts[i] || 0)) return false;
  }
  return true;
}

function compareVersions(installed, latest) {
  if (!installed || !latest) return 'unknown';
  // Pre-split both strings into numeric tuples — we use this for the
  // build-metadata check regardless of which compare path semver takes.
  const a = installed.split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);
  const b = latest.split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);

  // Try semver first, falling back to a numeric tuple comparison.
  const sInstalled = semver.coerce(installed);
  const sLatest = semver.coerce(latest);
  if (sInstalled && sLatest) {
    const cmp = semver.compare(sInstalled, sLatest);
    if (cmp < 0) return 'outdated';
    if (cmp > 0) {
      // Before declaring "ahead", check if the installed version is
      // just the latest plus a trailing build number. Example:
      // installed "11.6.0.2336", latest "11.6.0" — semver coerces both
      // to 11.6.0 so this branch usually doesn't fire, but some vendors
      // ship strings semver chokes on and we land here unintentionally.
      // Either way, leading-parts-match means the user has the latest
      // release with internal build metadata appended, not a true beta.
      if (leadingPartsMatch(a, b)) return 'current';
      return 'ahead';
    }
    return 'current';
  }

  // Fallback: numeric tuple comparison. Same build-metadata rule
  // applies — if every segment of `latest` matches the same-indexed
  // segment of `installed` and `installed` simply has more parts,
  // treat it as current rather than ahead.
  if (leadingPartsMatch(a, b)) return 'current';
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return 'outdated';
    if (av > bv) return 'ahead';
  }
  return 'current';
}

/** Cap concurrency. Run `tasks` (functions returning promises) N at a time. */
async function runWithConcurrency(tasks, n) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        results[idx] = { error: String(err && err.message || err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Check updates for a list of scanned items.
 *
 * @param {Array} items - items returned from scanLibrary
 * @param {object} [opts]
 * @param {function} [opts.onProgress] - called with { phase, current, total, message }
 *                   each time an item is checked
 * @returns {Array} status records, one per item
 */
async function checkUpdatesForItems(items, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const total = items.length;
  let done = 0;

  const pageCache = new Map(); // url -> Promise<text>

  function fetchOnce(url) {
    if (pageCache.has(url)) return pageCache.get(url);
    const p = fetchText(url).catch((err) => {
      throw err;
    });
    pageCache.set(url, p);
    return p;
  }

  function emitProgress(item) {
    done++;
    onProgress({ phase: 'updates', current: done, total, message: `Checked ${item.name}` });
  }

  const tasks = items.map((item) => async () => {
    const reg = item.registry || {};

    // Try Sparkle FIRST when the bundle declared an appcast URL — that's
    // structured version data straight from the developer, far more
    // reliable than HTML scraping. Sparkle URLs from the registry (added
    // by users) are also honored.
    const sparkleUrl = item.sparkleFeedUrl || reg.sparkleUrl;
    if (sparkleUrl) {
      try {
        const sp = await checkSparkleFeed(sparkleUrl);
        if (sp && sp.latest && sp.latest.version) {
          const latest = sp.latest.version;
          const cmp = compareVersions(item.version, latest);
          emitProgress(item);
          return {
            id: item.id,
            status: cmp,
            latestVersion: latest,
            installedVersion: item.version,
            homepage: reg.homepage,
            updateUrl: sp.latest.downloadUrl || sparkleUrl,
            sparkle: true,
          };
        }
      } catch { /* fall through to URL+regex if available */ }
    }

    if (!item.registry) {
      emitProgress(item);
      return { id: item.id, status: 'no-source', message: 'No registry entry for this plugin' };
    }
    // URL but no regex → the user opted into "I'll check manually" when
    // Plugr couldn't auto-detect the version. Surface a clickable link
    // instead of treating it as no-source.
    if (reg.updateUrl && !reg.versionRegex) {
      emitProgress(item);
      return {
        id: item.id,
        status: 'manual-check',
        updateUrl: reg.updateUrl,
        homepage: reg.homepage,
        message: 'Auto-detect not possible — open the page to check manually',
      };
    }
    if (!reg.updateUrl || !reg.versionRegex) {
      emitProgress(item);
      return {
        id: item.id,
        status: 'no-source',
        message: 'No update URL/regex configured — try Find update source',
        homepage: reg.homepage,
        downloadsUrl: reg.downloadsUrl,
      };
    }
    try {
      const html = await fetchOnce(reg.updateUrl);
      const latest = extractVersion(html, reg.versionRegex);
      if (!latest) {
        emitProgress(item);
        return {
          id: item.id,
          status: 'parse-failed',
          message: 'Fetched page but version pattern did not match',
          homepage: reg.homepage,
          updateUrl: reg.updateUrl,
        };
      }
      const cmp = compareVersions(item.version, latest);
      emitProgress(item);
      return {
        id: item.id,
        status: cmp,
        latestVersion: latest,
        installedVersion: item.version,
        homepage: reg.homepage,
        updateUrl: reg.updateUrl,
      };
    } catch (err) {
      emitProgress(item);
      return {
        id: item.id,
        status: 'error',
        message: String(err && err.message || err),
        homepage: reg.homepage,
        updateUrl: reg.updateUrl,
      };
    }
  });

  const results = await runWithConcurrency(tasks, MAX_CONCURRENT);
  return { results, checkedAt: new Date().toISOString() };
}

module.exports = {
  checkUpdatesForItems,
  compareVersions,
  extractVersion,
};
