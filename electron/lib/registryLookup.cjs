// Loaders / lookups against developerRegistry.json.
//
// Two questions this module answers, given a discovered bundle:
//   1. Which developer is this from?
//   2. Is there a specific product entry that gives us a category override
//      and/or update URL?

const path = require('node:path');
const fs = require('node:fs');

let cachedRegistry = null;
let cachedDevPrefixes = null;
let cachedAliasEntries = null;

function loadRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const file = path.join(__dirname, 'developerRegistry.json');
  const raw = fs.readFileSync(file, 'utf8');
  const reg = JSON.parse(raw);

  // Overlay community patches if present. This file is written by
  // community.cjs after a successful fetch from the additions feed.
  // Patches can correct companion-app names, bundle IDs, paths, and
  // legacy aliases — letting renames (e.g. Slate Digital Connect →
  // Complete Access Hub) propagate to installed Plugr clients without
  // shipping a new app version.
  try {
    const patchesFile = path.join(__dirname, 'communityPatches.json');
    if (fs.existsSync(patchesFile)) {
      const payload = JSON.parse(fs.readFileSync(patchesFile, 'utf8'));
      const patches = Array.isArray(payload && payload.patches) ? payload.patches : [];
      let applied = 0;
      for (const patch of patches) {
        if (!patch || typeof patch !== 'object') continue;
        const dev = reg.developers && reg.developers[patch.developer];
        if (!dev || !patch.set || typeof patch.set !== 'object') continue;
        for (const [k, v] of Object.entries(patch.set)) {
          dev[k] = v;
        }
        applied += 1;
      }
      if (applied > 0) {
        console.log(`[registry] applied ${applied} community patch(es) from communityPatches.json`);
      }
    }
  } catch (err) {
    // Patches are best-effort; never block registry load on a bad overlay.
    console.warn('[registry] community patch overlay failed:', err && err.message);
  }

  cachedRegistry = reg;
  return cachedRegistry;
}

/**
 * Drop all in-memory caches and force the next lookup to re-read the
 * registry file from disk. Called at the start of every scan so that
 * registry edits made between scans (during `npm run dev` development,
 * or after the user adds entries via the in-app flow) take effect
 * without restarting the Electron main process.
 */
function invalidateRegistryCache() {
  cachedRegistry = null;
  cachedDevPrefixes = null;
  cachedAliasEntries = null;
}

function getDeveloperPrefixes() {
  if (cachedDevPrefixes) return cachedDevPrefixes;
  const reg = loadRegistry();
  const list = [];
  for (const [devName, dev] of Object.entries(reg.developers || {})) {
    for (const prefix of dev.identifierPrefix || []) {
      list.push({ prefix: prefix.toLowerCase(), developer: devName });
    }
  }
  // App publishers (Adobe, Microsoft, Apple) — primarily for /Applications
  // scanning so we can light up their Creative Cloud / AutoUpdate / App
  // Store companion buttons on those items.
  for (const [devName, pub] of Object.entries(reg.appPublishers || {})) {
    for (const prefix of pub.identifierPrefix || []) {
      list.push({ prefix: prefix.toLowerCase(), developer: devName });
    }
  }
  // Bare shortcuts (less specific). These are last-resort.
  for (const [prefix, devName] of Object.entries(reg.identifierShortcuts || {})) {
    list.push({ prefix: prefix.toLowerCase(), developer: devName });
  }
  // Sort longest prefix first so more-specific wins.
  list.sort((a, b) => b.prefix.length - a.prefix.length);
  cachedDevPrefixes = list;
  return list;
}

/**
 * Look up a developer entry by NAME. Tries exact match first, then a
 * trimmed + case-insensitive fallback — because cross-format / case-fold
 * passes can normalize names to forms that differ in case or carry stray
 * whitespace from copyright strings (e.g., "Native Instruments " with a
 * trailing space, or "izotope" all-lowercase). Without these fallbacks,
 * those items lose their companion-app association.
 */
function getDeveloperEntry(developerName) {
  if (!developerName) return null;
  const reg = loadRegistry();
  const devs = reg.developers || {};
  const pubs = reg.appPublishers || {};
  // 1. Exact match.
  if (devs[developerName]) return devs[developerName];
  if (pubs[developerName]) return pubs[developerName];
  // 2. Trimmed + case-insensitive fallback (also normalizes NBSP and
  //    other unicode whitespace that sometimes shows up in plist text).
  const norm = developerName.replace(/[\s ]+/g, ' ').trim().toLowerCase();
  if (!norm) return null;
  for (const [k, v] of Object.entries(devs)) {
    if (k.replace(/[\s ]+/g, ' ').trim().toLowerCase() === norm) return v;
  }
  for (const [k, v] of Object.entries(pubs)) {
    if (k.replace(/[\s ]+/g, ' ').trim().toLowerCase() === norm) return v;
  }
  return null;
}

function getAliasEntries() {
  if (cachedAliasEntries) return cachedAliasEntries;
  const reg = loadRegistry();
  const aliases = reg.developerAliases || {};
  const list = [];
  for (const [variant, canonical] of Object.entries(aliases)) {
    if (variant.startsWith('_')) continue;        // skip _comment
    list.push({ variant: variant.toLowerCase(), canonical });
  }
  // Longest first so "w. a. production" beats "w.a." beats "w.a"
  list.sort((a, b) => b.variant.length - a.variant.length);
  cachedAliasEntries = list;
  return list;
}

/**
 * Apply the aliases map to a free-text developer name (case-insensitive
 * substring match — first hit wins, longest-first).
 */
function applyDeveloperAlias(name) {
  if (!name) return name;
  // Normalize whitespace (including non-breaking spaces sometimes found
  // in plist copyright strings) and case-fold for matching. Aliases
  // themselves are matched against the lowercased, whitespace-normalized
  // copy of the input.
  const norm = name.replace(/[\s ]+/g, ' ').trim().toLowerCase();
  for (const { variant, canonical } of getAliasEntries()) {
    if (norm.includes(variant)) return canonical;
  }
  return name.trim();
}

function findDeveloperByIdentifier(identifier) {
  if (!identifier) return null;
  const id = identifier.toLowerCase();
  for (const { prefix, developer } of getDeveloperPrefixes()) {
    if (id.startsWith(prefix) || id.includes(prefix)) return developer;
  }
  return null;
}

/**
 * Try to match a plugin name to a productMatchers entry. The registry uses
 * lenient prefix matching: "Pro-Q 3" matches "Pro-Q".
 *
 * Looks at both developers[devName].productMatchers and
 * appPublishers[devName].productMatchers — apps like Logic Pro live under
 * appPublishers (because Apple is the publisher) but still need product
 * mappings for DAW recognition.
 *
 * Matches in two passes:
 *   1. Strict: lowercased includes() against the registry key — preserves
 *      the legacy behavior, so existing matches keep working.
 *   2. Normalized fallback: both sides stripped of non-alphanumeric chars
 *      and lowercased. This lets a single key like "Cyclic Panner" match
 *      every separator variant ("Cyclic_Panner", "Cyclic-Panner", "Cyclic
 *      Panner") that scanners emit across VST3/AU/VST2 of the same plugin.
 */
function findProductEntry(developerName, pluginName) {
  if (!developerName || !pluginName) return null;
  const reg = loadRegistry();
  let dev =
    (reg.developers && reg.developers[developerName]) ||
    (reg.appPublishers && reg.appPublishers[developerName]) ||
    null;
  // Fall back to alias-based lookup when the developer name doesn't
  // match a registered key directly (e.g. "zplane.development" →
  // "Zplane"). This keeps cross-format / case-fold drift in the
  // scanner output from breaking productMatchers attribution.
  if (!dev) {
    const canonical = applyDeveloperAlias(developerName);
    if (canonical && canonical !== developerName) {
      dev =
        (reg.developers && reg.developers[canonical]) ||
        (reg.appPublishers && reg.appPublishers[canonical]) ||
        null;
    }
  }
  if (!dev || !dev.productMatchers) return null;

  const lowerName = pluginName.toLowerCase();
  // Prefer longest match (more specific wins).
  const keys = Object.keys(dev.productMatchers).sort((a, b) => b.length - a.length);
  // Pass 1: strict lowercased includes() — same as before.
  for (const key of keys) {
    if (lowerName.includes(key.toLowerCase())) {
      return { matchedKey: key, ...dev.productMatchers[key] };
    }
  }
  // Pass 2: normalized fallback. Strip everything that isn't a letter or
  // number, then compare. Catches separator drift between formats.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normName = norm(pluginName);
  if (normName) {
    for (const key of keys) {
      const normKey = norm(key);
      if (normKey && normName.includes(normKey)) {
        return { matchedKey: key, ...dev.productMatchers[key] };
      }
    }
  }
  return null;
}


/**
 * Build a registryEntry suitable for passing to categorize().
 * Combines developer + product info into a single record.
 */
function lookupRegistry({ identifier, pluginName }) {
  const developerFromId = findDeveloperByIdentifier(identifier);
  const developer = developerFromId;
  const productEntry = developer ? findProductEntry(developer, pluginName) : null;
  const devEntry = developer ? getDeveloperEntry(developer) : null;
  if (!developer) return null;
  return {
    developer,
    homepage: devEntry && devEntry.homepage,
    downloadsUrl: devEntry && devEntry.downloadsUrl,
    supportUrl: devEntry && devEntry.supportUrl,
    companionApp: devEntry && devEntry.companionApp,
    category: productEntry && productEntry.category,
    subcategory: productEntry && productEntry.subcategory,
    updateUrl: productEntry && productEntry.updateUrl,
    versionRegex: productEntry && productEntry.versionRegex,
    // Optional per-product download page (release-notes page ≠ download
    // page). Surfaced so a promoted/bundled source can route the CTA the
    // same way a user-added one does.
    downloadUrl: productEntry && productEntry.downloadUrl,
    matchedProduct: productEntry && productEntry.matchedKey,
  };
}

module.exports = {
  loadRegistry,
  findDeveloperByIdentifier,
  findProductEntry,
  getDeveloperEntry,
  lookupRegistry,
  applyDeveloperAlias,
  invalidateRegistryCache,
};
