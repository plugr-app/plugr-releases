#!/usr/bin/env node
//
// promote-cache-additions.js
//
// Reads your local Plugr cache and merges the corrections you've made
// during normal use back into the bundled developerRegistry.json. The
// goal is: edit a plugin once in your copy of Plugr, run this script,
// and the next release ships those corrections to everybody else so
// they get them for free.
//
// Two kinds of corrections are promoted:
//
//   1. Developer-name overrides  (userOverrides[id].developer)
//      A plugin you re-attributed to the correct developer. We extract
//      the bundle-ID prefix (e.g. com.fabfilter) and add it to that
//      developer's identifierPrefix list, and add the originally
//      detected text as a developerAliases entry so future scans pick
//      the right name automatically.
//
//   2. Update-source additions   (userRegistryAdditions[id])
//      A URL+regex pair you saved via the in-app Discover flow. We
//      attach it to the corresponding developer's productMatchers
//      entry, keyed by plugin name. Developer attribution honors any
//      override from pass (1), so if you renamed a developer first and
//      then saved a source for it, this still lands in the right spot.
//
// Pass --dry-run to preview without writing the registry file. Pass
// --cache <path> to point at a different cache file (defaults to your
// macOS Application Support folder).
//
// Typical workflow:
//   1. Use Plugr normally — correct developer names in the detail panel
//      and bulk panel, save update sources via Discover.
//   2. Run `npm run promote-cache -- --dry-run` to see what would change.
//   3. Run `npm run promote-cache` to apply the merge.
//   4. Review the diff (`git diff electron/lib/developerRegistry.json`).
//   5. Commit and ship the next release.
//
// The script never touches your cache and never deletes anything from the
// registry — it only ADDS new identifierPrefix entries, developerAliases
// entries, and productMatchers entries (or fills in updateUrl /
// versionRegex on existing productMatchers entries that lacked them).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REGISTRY_PATH = path.join(__dirname, '..', 'electron', 'lib', 'developerRegistry.json');
const DEFAULT_CACHE_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Plugr',
  'library-cache.json',
);

function parseArgs(argv) {
  const args = { dryRun: false, cache: DEFAULT_CACHE_PATH };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--cache') args.cache = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: promote-cache-additions [--dry-run] [--cache <path>]');
      process.exit(0);
    }
  }
  return args;
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('Failed to parse JSON at', p, e.message); return null; }
}

/**
 * Extract the company-level reverse-DNS prefix from a CFBundleIdentifier.
 *   com.fabfilter.proq3        -> com.fabfilter
 *   com.u-he.diva              -> com.u-he
 *   jp.aom-factory.foo         -> jp.aom-factory
 *   com.foo                    -> null   (too short to be useful)
 * Returns null if the identifier doesn't have at least two segments.
 */
function companyPrefixOf(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const parts = identifier.split('.');
  if (parts.length < 2) return null;
  const first = parts[0].trim();
  const second = parts[1].trim();
  if (!first || !second) return null;
  return `${first}.${second}`.toLowerCase();
}

function normalizeAliasKey(name) {
  if (!name) return '';
  return name.replace(/[\s ]+/g, ' ').trim().toLowerCase();
}

/**
 * Normalize a bundle-ID prefix for dedup comparison. The registry mixes
 * `com.fabfilter` and `com.fabfilter.` styles — both work at lookup
 * time because the matcher uses startsWith/includes, but if we don't
 * normalize we'll end up adding a duplicate-shaped entry next to an
 * existing one. Strip trailing dots and lowercase.
 */
function normalizePrefix(p) {
  if (!p) return '';
  return p.toLowerCase().replace(/\.+$/, '');
}

/**
 * Build maps of (prefix → developer) and (alias-key → developer) from
 * the current registry, so we can detect conflicts before adding new
 * prefixes / aliases.
 */
function buildLookups(registry) {
  const prefixToDev = new Map();
  const aliasToDev = new Map();
  const knownDevsLower = new Map();
  const devs = registry.developers || {};
  const pubs = registry.appPublishers || {};
  for (const [name, dev] of Object.entries(devs)) {
    knownDevsLower.set(name.toLowerCase(), name);
    for (const p of dev.identifierPrefix || []) prefixToDev.set(normalizePrefix(p), name);
  }
  for (const [name, pub] of Object.entries(pubs)) {
    knownDevsLower.set(name.toLowerCase(), name);
    for (const p of pub.identifierPrefix || []) prefixToDev.set(normalizePrefix(p), name);
  }
  for (const [prefix, name] of Object.entries(registry.identifierShortcuts || {})) {
    prefixToDev.set(normalizePrefix(prefix), name);
    knownDevsLower.set(name.toLowerCase(), name);
  }
  for (const [variant, canonical] of Object.entries(registry.developerAliases || {})) {
    if (variant.startsWith('_')) continue;
    aliasToDev.set(normalizeAliasKey(variant), canonical);
  }
  return { prefixToDev, aliasToDev, knownDevsLower };
}

/**
 * Resolve a developer name to its canonical key in the registry.
 * Tries exact match, then case-insensitive, then alias substring.
 * Returns null if we can't find a developer entry the prefix/matcher
 * structure understands.
 */
function resolveCanonicalDeveloper(devName, lookups, registry) {
  if (!devName) return null;
  const devs = registry.developers || {};
  const pubs = registry.appPublishers || {};
  if (devs[devName] || pubs[devName]) return devName;
  const lower = devName.toLowerCase();
  if (lookups.knownDevsLower.has(lower)) return lookups.knownDevsLower.get(lower);
  // Try alias resolution as a last resort (substring-style, like the
  // app does at runtime).
  const norm = normalizeAliasKey(devName);
  for (const [variant, canonical] of lookups.aliasToDev.entries()) {
    if (norm.includes(variant) && lookups.knownDevsLower.has(canonical.toLowerCase())) {
      return lookups.knownDevsLower.get(canonical.toLowerCase());
    }
  }
  return null;
}

function ensureDeveloperEntry(registry, devName) {
  registry.developers = registry.developers || {};
  if (!registry.developers[devName]) {
    registry.developers[devName] = { identifierPrefix: [], productMatchers: {} };
  }
  if (!Array.isArray(registry.developers[devName].identifierPrefix)) {
    registry.developers[devName].identifierPrefix = [];
  }
  if (!registry.developers[devName].productMatchers) {
    registry.developers[devName].productMatchers = {};
  }
  return registry.developers[devName];
}

function main() {
  const args = parseArgs(process.argv);

  const registry = readJson(REGISTRY_PATH);
  if (!registry || !registry.developers) {
    console.error('Registry not found or malformed at', REGISTRY_PATH);
    process.exit(1);
  }
  const cache = readJson(args.cache);
  if (!cache) {
    console.error('Cache not found or unreadable at', args.cache);
    console.error('Hint: run Plugr at least once so the cache file gets created.');
    process.exit(1);
  }

  const userOverrides = cache.userOverrides || {};
  const additions = cache.userRegistryAdditions || {};
  const items = (cache.library && cache.library.items) || [];
  const itemByKey = new Map();
  for (const it of items) {
    if (it.identifier) itemByKey.set(it.identifier, it);
    if (it.id) itemByKey.set(it.id, it);
  }

  const stats = {
    // Developer pass
    devOverridesConsidered: 0,
    devOverridesUnknownDev: 0,
    devOverridesNoItem: 0,
    prefixesAdded: 0,
    prefixesAlreadyCorrect: 0,
    prefixConflicts: [],
    aliasesAdded: 0,
    aliasConflicts: [],
    devsTouched: new Set(),
    // Update-source pass
    additionsConsidered: 0,
    additionsWithoutMatchingItem: 0,
    additionsWithoutRecognizedDev: 0,
    productMatchersCreated: 0,
    productMatchersUpdated: 0,
  };

  // -----------------------------------------------------------------
  // Pass 1: developer-name overrides → identifierPrefix + aliases
  // -----------------------------------------------------------------
  let lookups = buildLookups(registry);

  for (const [id, ov] of Object.entries(userOverrides)) {
    if (!ov || !ov.developer || !String(ov.developer).trim()) continue;
    stats.devOverridesConsidered++;

    const canonicalRaw = String(ov.developer).trim();
    const item = itemByKey.get(id);
    if (!item) { stats.devOverridesNoItem++; continue; }

    // Make sure the corrected developer is a real entry in the
    // registry. We don't auto-create developer entries — that requires
    // a human decision about homepage / companion app / etc.
    const canonicalDev = resolveCanonicalDeveloper(canonicalRaw, lookups, registry);
    if (!canonicalDev) {
      stats.devOverridesUnknownDev++;
      console.warn(`  skip "${canonicalRaw}" — not a known developer in the registry yet (add it first).`);
      continue;
    }

    // Add an identifierPrefix entry derived from the plugin's bundle
    // ID, so future scans of a plugin with the same prefix route to
    // the right developer without needing the user override.
    const prefix = companyPrefixOf(item.identifier);
    if (prefix) {
      const normPrefix = normalizePrefix(prefix);
      const existingOwner = lookups.prefixToDev.get(normPrefix);
      if (existingOwner === canonicalDev) {
        stats.prefixesAlreadyCorrect++;
      } else if (existingOwner && existingOwner !== canonicalDev) {
        // Don't reroute a prefix that's already claimed by someone
        // else — flag it for human review.
        stats.prefixConflicts.push({ prefix, existing: existingOwner, requested: canonicalDev, plugin: item.name });
      } else {
        const devEntry = ensureDeveloperEntry(registry, canonicalDev);
        // Dedup against trailing-dot variants too (the registry mixes
        // styles), so we don't end up with both "com.foo" and
        // "com.foo." sitting next to each other.
        const alreadyHas = devEntry.identifierPrefix.some(
          (p) => normalizePrefix(p) === normPrefix,
        );
        if (!alreadyHas) {
          devEntry.identifierPrefix.push(prefix);
          devEntry.identifierPrefix.sort((a, b) => b.length - a.length);
          lookups.prefixToDev.set(normPrefix, canonicalDev);
          stats.prefixesAdded++;
          stats.devsTouched.add(canonicalDev);
        }
      }
    }

    // Add the originally-detected developer text as an alias so the
    // text-based fallback path (used when bundle ID lookup misses)
    // also picks up the canonical name. We only add it when it's
    // genuinely different from the canonical name and there isn't
    // already an alias that resolves to a different developer.
    const detected = (item.developer || '').trim();
    if (detected && detected.toLowerCase() !== canonicalDev.toLowerCase()) {
      const aliasKey = normalizeAliasKey(detected);
      const existingAlias = lookups.aliasToDev.get(aliasKey);
      if (existingAlias && existingAlias !== canonicalDev) {
        stats.aliasConflicts.push({ alias: detected, existing: existingAlias, requested: canonicalDev });
      } else if (!existingAlias) {
        registry.developerAliases = registry.developerAliases || {};
        // Skip noise like "Unknown" or single characters.
        if (aliasKey && aliasKey !== 'unknown' && aliasKey.length >= 2) {
          registry.developerAliases[aliasKey] = canonicalDev;
          lookups.aliasToDev.set(aliasKey, canonicalDev);
          stats.aliasesAdded++;
          stats.devsTouched.add(canonicalDev);
        }
      }
    }
  }

  // Lookups now reflect anything we added in pass 1.
  lookups = buildLookups(registry);

  // -----------------------------------------------------------------
  // Pass 2: update-source additions → productMatchers
  // -----------------------------------------------------------------
  for (const [key, add] of Object.entries(additions)) {
    stats.additionsConsidered++;
    const item = itemByKey.get(key);
    if (!item) { stats.additionsWithoutMatchingItem++; continue; }
    if (!add || !add.updateUrl || !add.versionRegex) continue;

    // Honor the user's developer override if they renamed this
    // plugin's developer in the UI. Otherwise fall back to whatever
    // the scanner attached to the item.
    const overriddenDev =
      userOverrides[key] && userOverrides[key].developer && String(userOverrides[key].developer).trim();
    const rawDev = (overriddenDev || item.developer || '').trim();
    const dev = resolveCanonicalDeveloper(rawDev, lookups, registry);
    if (!dev) { stats.additionsWithoutRecognizedDev++; continue; }

    const devEntry = ensureDeveloperEntry(registry, dev);
    const productKey = item.name;
    const existing = devEntry.productMatchers[productKey] || {};

    // Don't clobber category info that's already there.
    const merged = {
      ...existing,
      updateUrl: add.updateUrl,
      versionRegex: add.versionRegex,
    };
    if (existing.updateUrl || existing.versionRegex) stats.productMatchersUpdated++;
    else stats.productMatchersCreated++;
    devEntry.productMatchers[productKey] = merged;
    stats.devsTouched.add(dev);
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log('');
  console.log('Cache:    ', args.cache);
  console.log('Registry: ', REGISTRY_PATH);
  console.log('');
  console.log('Developer overrides');
  console.log('  considered          :', stats.devOverridesConsidered);
  console.log('  no matching item    :', stats.devOverridesNoItem);
  console.log('  unknown developer   :', stats.devOverridesUnknownDev);
  console.log('  identifierPrefix +  :', stats.prefixesAdded);
  console.log('  identifierPrefix ok :', stats.prefixesAlreadyCorrect);
  console.log('  developerAliases +  :', stats.aliasesAdded);
  if (stats.prefixConflicts.length) {
    console.log('  identifierPrefix conflicts (NOT changed — review manually):');
    for (const c of stats.prefixConflicts) {
      console.log(`    ${c.prefix}  currently -> ${c.existing}   wanted -> ${c.requested}   (e.g. ${c.plugin})`);
    }
  }
  if (stats.aliasConflicts.length) {
    console.log('  developerAliases conflicts (NOT changed — review manually):');
    for (const c of stats.aliasConflicts) {
      console.log(`    "${c.alias}"   currently -> ${c.existing}   wanted -> ${c.requested}`);
    }
  }
  console.log('');
  console.log('Update-source additions');
  console.log('  considered          :', stats.additionsConsidered);
  console.log('  no matching item    :', stats.additionsWithoutMatchingItem);
  console.log('  unknown developer   :', stats.additionsWithoutRecognizedDev);
  console.log('  productMatchers +   :', stats.productMatchersCreated);
  console.log('  productMatchers ~   :', stats.productMatchersUpdated);
  console.log('');
  console.log('Developers touched    :', stats.devsTouched.size);
  if (stats.devsTouched.size > 0) {
    console.log('   ', [...stats.devsTouched].sort().join(', '));
  }
  console.log('');

  if (args.dryRun) {
    console.log('--dry-run: registry NOT written. Re-run without --dry-run to apply.');
  } else {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    console.log('Wrote', REGISTRY_PATH);
    console.log('Review the diff:  git diff', path.relative(process.cwd(), REGISTRY_PATH));
  }
}

main();
