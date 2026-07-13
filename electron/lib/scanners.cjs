// Filesystem scanners.
//
// Walk the standard macOS plugin and application directories, identify
// bundles by file extension, read their Info.plist, categorize, and return
// a normalized record.
//
// We do NOT recurse into bundle internals — we just list each top-level
// bundle in its parent directory. Some plugin packages drop folders that
// contain multiple bundles (e.g. Native Instruments, Waves), so we recurse
// one extra level into "non-bundle" subfolders.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readBundleInfo } = require('./plistParser.cjs');
const { categorize, inferDeveloper } = require('./categorize.cjs');
const { lookupRegistry, getDeveloperEntry, invalidateRegistryCache } = require('./registryLookup.cjs');

/**
 * When the bundle identifier doesn't match any registry prefix, but the
 * developer name was still inferred (from copyright string, alias, or
 * identifier guessing), look up the developer entry by NAME and merge
 * its companion-app / homepage / support URLs into the per-item registry
 * record. Without this, plugins from e.g. iZotope or Native Instruments
 * whose bundle IDs use an unusual prefix don't surface as "Managed by
 * companion" even though we know who made them.
 */
function enrichRegistryByDeveloperName(registryEntry, developer, forceReplace = false) {
  if (!developer || developer === 'Unknown') return registryEntry;
  const devEntry = getDeveloperEntry(developer);
  if (!devEntry) return registryEntry;
  const out = registryEntry ? { ...registryEntry } : { developer };
  // When forceReplace is true (caller knows the developer changed via
  // override and the previous registry came from the wrong vendor), we
  // overwrite vendor-derived fields instead of treating them as sticky.
  // Otherwise we only fill blanks — preserves user-customized values.
  if (forceReplace || !out.developer) out.developer = developer;
  if ((forceReplace || !out.companionApp) && devEntry.companionApp) out.companionApp = devEntry.companionApp;
  if ((forceReplace || !out.homepage) && devEntry.homepage) out.homepage = devEntry.homepage;
  if ((forceReplace || !out.supportUrl) && devEntry.supportUrl) out.supportUrl = devEntry.supportUrl;
  if ((forceReplace || !out.downloadsUrl) && devEntry.downloadsUrl) out.downloadsUrl = devEntry.downloadsUrl;
  return out;
}
const { computeSizesBatch } = require('./sizeUtil.cjs');
const { detectDuplicates } = require('./duplicates.cjs');
const { detectArchitecturesBatch } = require('./archUtil.cjs');

const HOME = os.homedir();

// Format definitions: which directories to scan, which extensions to match.
const FORMATS = {
  VST3: {
    extensions: ['.vst3'],
    paths: [
      '/Library/Audio/Plug-Ins/VST3',
      `${HOME}/Library/Audio/Plug-Ins/VST3`,
    ],
  },
  AU: {
    extensions: ['.component'],
    paths: [
      '/Library/Audio/Plug-Ins/Components',
      `${HOME}/Library/Audio/Plug-Ins/Components`,
    ],
  },
  VST2: {
    extensions: ['.vst'],
    paths: [
      '/Library/Audio/Plug-Ins/VST',
      `${HOME}/Library/Audio/Plug-Ins/VST`,
    ],
  },
  AAX: {
    extensions: ['.aaxplugin'],
    paths: [
      '/Library/Application Support/Avid/Audio/Plug-Ins',
    ],
  },
  CLAP: {
    extensions: ['.clap'],
    paths: [
      '/Library/Audio/Plug-Ins/CLAP',
      `${HOME}/Library/Audio/Plug-Ins/CLAP`,
    ],
  },
  App: {
    extensions: ['.app'],
    paths: [
      '/Applications',
      `${HOME}/Applications`,
    ],
    // Don't recurse into Applications/Utilities subfolders too deep
    maxDepth: 2,
  },
};

const KNOWN_EXT = new Set(['.vst3', '.component', '.vst', '.aaxplugin', '.clap', '.app']);

function hasKnownExt(name) {
  const ext = path.extname(name).toLowerCase();
  return KNOWN_EXT.has(ext);
}

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

async function listDirSafe(p) {
  try { return await fs.readdir(p, { withFileTypes: true }); } catch { return []; }
}

/**
 * Walk a directory and yield all bundles whose extension is in `extensions`.
 * Supports limited recursion through non-bundle folders so that vendor-grouped
 * plugin folders (e.g. ".../VST3/FabFilter/FabFilter Pro-Q 3.vst3") are found.
 */
async function* walkBundles(rootDir, extensions, maxDepth = 4, currentDepth = 0) {
  if (!fsSync.existsSync(rootDir)) return;
  const entries = await listDirSafe(rootDir);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(rootDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();

    if (extensions.includes(ext)) {
      yield { path: fullPath, name: entry.name, ext };
      continue;
    }

    if (entry.isDirectory() && currentDepth < maxDepth && !hasKnownExt(entry.name)) {
      yield* walkBundles(fullPath, extensions, maxDepth, currentDepth + 1);
    }
  }
}

// Audio Units identify themselves by a 4-tuple of FourCC codes:
// (type, subtype, manufacturer). DAW projects (Logic, Ableton, FL)
// reference plugins by this tuple — but the field's plist
// representation varies: most bundles store each as a 4-char ASCII
// string ("aufx"), others store the same value as an unsigned int
// (0x61756678). Normalize either form to a 4-char string, then
// stitch the three pieces into a canonical "au:type:subtype:manu"
// key that's stable across project files.
function fourCCFromAny(v) {
  if (v == null) return '';
  if (typeof v === 'number') {
    return String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  return String(v).trim();
}
function buildAuKey(type, subtype, manufacturer) {
  const t = fourCCFromAny(type);
  const s = fourCCFromAny(subtype);
  const m = fourCCFromAny(manufacturer);
  if (!t || !s || !m) return null;
  if (t.length !== 4 || s.length !== 4 || m.length !== 4) return null;
  return `au:${t}:${s}:${m}`;
}

/** Hash a path into a stable id. */
function makeId(fullPath) {
  // Cheap deterministic id from path. Plenty unique for a single user's library.
  let hash = 0;
  for (let i = 0; i < fullPath.length; i++) {
    hash = ((hash << 5) - hash) + fullPath.charCodeAt(i);
    hash |= 0;
  }
  return `${path.basename(fullPath)}-${(hash >>> 0).toString(36)}`;
}

async function scanFormat(format) {
  const def = FORMATS[format];
  const items = [];
  for (const root of def.paths) {
    for await (const found of walkBundles(root, def.extensions, def.maxDepth || 4)) {
      try {
        const info = await readBundleInfo(found.path);
        if (!info) continue;

        // Look up registry entry and categorize.
        const registryEntry = lookupRegistry({
          identifier: info.identifier,
          pluginName: info.name,
        });

        const cat = categorize({ bundleInfo: info, format, registryEntry });
        const developer = inferDeveloper({ bundleInfo: info, registryEntry });

        // For AU plugins, prefer the AudioComponent name if it differs (often
        // more user-friendly than the bundle file name).
        let displayName = info.name;
        let auKeys = null;
        if (format === 'AU' && info.auComponents && info.auComponents.length > 0) {
          const auName = info.auComponents[0].name;
          if (auName) {
            // AU names are usually "Manufacturer: Plugin Name"
            const parts = auName.split(':').map((s) => s.trim());
            displayName = parts[parts.length - 1] || displayName;
          }
          // Build a list of canonical "au:type:subtype:manufacturer" keys
          // (one per AudioComponent in the bundle — multi-component plugins
          // like FabFilter Pro-Q expose effect + sidechain variants under
          // one bundle). The project matcher uses these to resolve a
          // FourCC-style reference from a Logic project to this library
          // item.
          auKeys = info.auComponents
            .map((c) => buildAuKey(c.type, c.subtype, c.manufacturer))
            .filter(Boolean);
        }

        // Strip developer-name prefix when the plugin embeds it in its own
        // display name (e.g. Acon Digital AU bundles ship as
        // "Acon Digital Convolve" instead of just "Convolve"). Stripping
        // brings the AU name in line with its VST3/AAX counterparts so that
        // duplicate detection and registry lookups work correctly across
        // formats. We only strip when:
        //   • the developer is known (not "Unknown")
        //   • the remainder is non-empty after stripping
        //   • the match is case-insensitive (covers edge cases where bundle
        //     casing differs from the inferred developer string)
        if (developer && developer !== 'Unknown') {
          const prefix = developer.toLowerCase() + ' ';
          const lower = displayName.toLowerCase();
          if (lower.startsWith(prefix) && displayName.length > prefix.length) {
            displayName = displayName.slice(prefix.length).trimStart();
          }
        }

        items.push({
          id: makeId(found.path),
          name: displayName,
          bundleName: info.bundleName,
          format,
          path: found.path,
          identifier: info.identifier,
          auKeys,
          version: info.version,
          buildVersion: info.buildVersion,
          developer,
          category: cat.category,
          subcategory: cat.subcategory,
          categorySource: cat.source,
          copyright: info.copyright,
          minimumSystemVersion: info.minimumSystemVersion,
          // Executable name for the Mach-O arch check below.
          executable: info.executable,
          registry: enrichRegistryByDeveloperName(registryEntry, developer),
          // Sparkle: when a bundle declares its own appcast URL, capture
          // it so the update checker can hit it directly — no scraping,
          // no regex, just structured version data.
          sparkleFeedUrl: info.sparkleFeedUrl || null,
        });
      } catch (err) {
        // Don't let one bad bundle kill the scan.
        items.push({
          id: makeId(found.path),
          name: path.basename(found.path, path.extname(found.path)),
          bundleName: path.basename(found.path),
          format,
          path: found.path,
          version: null,
          developer: 'Unknown',
          category: 'Other',
          subcategory: 'Uncategorized',
          error: String(err && err.message || err),
        });
      }
    }
  }
  return items;
}

/**
 * Scan everything the user asked for.
 *
 * @param {object} options
 * @param {string[]} [options.formats] - subset of FORMATS keys to scan; defaults to all
 * @returns {Promise<{items: Array, summary: object, scannedAt: string}>}
 */
/**
 * Scan a single arbitrary folder (e.g. an external drive) for one format's
 * extensions. Mirrors the per-format scanFormat logic but takes a custom
 * root path. The 'fromCustomFolder' flag is attached so the UI can mark
 * these items as "from a custom location" if it wants to.
 */
async function scanCustomFolder(rootDir, format, extensions, maxDepth) {
  const items = [];
  for await (const found of walkBundles(rootDir, extensions, maxDepth)) {
    try {
      const info = await readBundleInfo(found.path);
      if (!info) continue;
      const registryEntry = lookupRegistry({
        identifier: info.identifier,
        pluginName: info.name,
      });
      const cat = categorize({ bundleInfo: info, format, registryEntry });
      const developer = inferDeveloper({ bundleInfo: info, registryEntry });
      let displayName = info.name;
      let auKeys = null;
      if (format === 'AU' && info.auComponents && info.auComponents.length > 0) {
        const auName = info.auComponents[0].name;
        if (auName) {
          const parts = auName.split(':').map((s) => s.trim());
          displayName = parts[parts.length - 1] || displayName;
        }
        auKeys = info.auComponents
          .map((c) => buildAuKey(c.type, c.subtype, c.manufacturer))
          .filter(Boolean);
      }
      items.push({
        id: makeId(found.path),
        name: displayName,
        bundleName: info.bundleName,
        format,
        path: found.path,
        identifier: info.identifier,
        auKeys,
        version: info.version,
        buildVersion: info.buildVersion,
        developer,
        category: cat.category,
        subcategory: cat.subcategory,
        categorySource: cat.source,
        copyright: info.copyright,
        minimumSystemVersion: info.minimumSystemVersion,
        registry: registryEntry || null,
        sparkleFeedUrl: info.sparkleFeedUrl || null,
        fromCustomFolder: true,
      });
    } catch (err) {
      // Skip bad bundles silently in custom folders — user can rescan.
    }
  }
  return items;
}

// Compare two macOS version strings ("14.4.1" vs "13.0").
// Returns negative, zero, or positive (like compareFunction).
function compareOsVersions(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Add osCompat: { status, message } to each item.
 *
 * Three signals, in priority order:
 *   1. LSMinimumSystemVersion (a declared minimum macOS). If the user's
 *      macOS is older than this, the bundle WILL fail to load — definite
 *      'incompatible'.
 *   2. Mach-O architectures from `lipo -archs` on the executable. If the
 *      bundle has no architecture the current Mac can run (Apple Silicon
 *      can run arm64 natively and x86_64 through Rosetta; Intel can only
 *      run x86_64), that's also a definite 'incompatible'.
 *   3. If both checks pass with positive evidence → 'ok'.
 *   4. If we only have one signal (e.g. arch is fine but no min declared,
 *      or min is fine but no arch readable) → 'ok'.
 *   5. If we have NEITHER signal (no min declared AND lipo failed to read
 *      architectures) → 'unknown'. Honest, not optimistic.
 *
 * `currentArch` is the Node arch slug ('arm64' or 'x64'). We translate
 * to Mach-O slugs internally ('arm64' / 'x86_64').
 */
function applyOsCompat(items, currentSystemVersion, currentArch) {
  if (!currentSystemVersion && !currentArch) return;
  const needArch = currentArch === 'arm64' ? 'arm64' : 'x86_64';
  for (const it of items) {
    const min = it.minimumSystemVersion;
    const archs = Array.isArray(it.architectures) ? it.architectures : null;

    // 1. Declared minimum macOS exceeds the user's macOS → definite no-load.
    if (min && currentSystemVersion && compareOsVersions(currentSystemVersion, min) < 0) {
      it.osCompat = {
        status: 'incompatible',
        message: `Requires macOS ${min}, you have ${currentSystemVersion}. Will not load.`,
        reason: 'min-os',
      };
      continue;
    }

    // 2. Architecture mismatch — definite no-load.
    if (archs && archs.length > 0) {
      const haveArm   = archs.includes('arm64');
      const haveX64   = archs.includes('x86_64');
      const havei386  = archs.includes('i386');
      const havePPC   = archs.includes('ppc') || archs.includes('ppc64');
      const dead      = (havei386 || havePPC) && !haveArm && !haveX64;
      if (dead) {
        it.osCompat = {
          status: 'incompatible',
          message: `Built for ${archs.join('/')} only — that architecture hasn't been supported on macOS in years.`,
          reason: 'arch-dead',
        };
        continue;
      }
      if (currentArch === 'arm64') {
        if (!haveArm && !haveX64) {
          it.osCompat = {
            status: 'incompatible',
            message: `Built for ${archs.join('/')} only — not compatible with Apple Silicon.`,
            reason: 'arch-mismatch',
          };
          continue;
        }
        if (!haveArm && haveX64) {
          it.osCompat = {
            status: 'ok',
            message: `x86_64 only — will run via Rosetta translation on Apple Silicon.`,
            note: 'rosetta',
          };
          // Fall through to OK confirmation below. Already set; continue.
          continue;
        }
      } else if (currentArch === 'x64') {
        if (!haveX64) {
          it.osCompat = {
            status: 'incompatible',
            message: `Built for ${archs.join('/')} only — not compatible with Intel Mac.`,
            reason: 'arch-mismatch',
          };
          continue;
        }
      }
    }

    // 3. We have at least one positive signal — record it.
    if (min) {
      it.osCompat = {
        status: 'ok',
        message: `Requires macOS ${min}+ — you have ${currentSystemVersion}. Architecture${archs ? ` (${archs.join('/')})` : ''} is compatible.`,
      };
      continue;
    }
    if (archs && archs.length > 0) {
      it.osCompat = {
        status: 'ok',
        message: `Architecture ${archs.join('/')} is compatible with your ${needArch} Mac. (No minimum macOS declared.)`,
      };
      continue;
    }

    // 4. Genuinely no signal — be honest.
    it.osCompat = {
      status: 'unknown',
      message: 'No minimum macOS declared and architecture could not be read. Compatibility uncertain.',
    };
  }
}

async function scanLibrary(options = {}) {
  // Always reload the registry from disk at the start of a scan. This way
  // edits to developerRegistry.json (or the lookup .cjs files) take effect
  // without requiring a full Electron main-process restart — useful for
  // both ongoing development and users who hand-edit the registry JSON.
  invalidateRegistryCache();

  const formats = options.formats && options.formats.length
    ? options.formats
    : Object.keys(FORMATS);
  const includeSizes = options.includeSizes !== false;
  const includeArchs = options.includeArchs !== false;
  const systemVersion = options.systemVersion || null;
  const systemArch = options.systemArch || null;
  const customFolders = Array.isArray(options.customFolders) ? options.customFolders : [];
  // Caller can pass an onProgress({ phase, current, total, message }) hook.
  // Optional — silently no-ops if missing.
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const totalPhases = formats.length + (customFolders.length > 0 ? 1 : 0) + (includeSizes ? 1 : 0) + (includeArchs ? 1 : 0) + 2;
  let phaseIndex = 0;
  const tick = (message) => onProgress({ phase: 'scan', current: ++phaseIndex, total: totalPhases, message });

  const all = [];
  for (const fmt of formats) {
    if (!FORMATS[fmt]) continue;
    tick(`Scanning ${fmt}…`);
    const items = await scanFormat(fmt);
    all.push(...items);
  }

  // Custom folders: scan each one for every requested format. Plugins on
  // an external drive or in a non-default location land here.
  if (customFolders.length > 0) tick(`Scanning custom folders…`);
  for (const folder of customFolders) {
    if (!folder || !fsSync.existsSync(folder)) continue;
    for (const fmt of formats) {
      if (!FORMATS[fmt]) continue;
      const def = FORMATS[fmt];
      const items = await scanCustomFolder(folder, fmt, def.extensions, def.maxDepth || 4);
      all.push(...items);
    }
  }
  // Dedupe (custom folder may overlap with a default path).
  const seenPaths = new Set();
  const deduped = [];
  for (const it of all) {
    if (seenPaths.has(it.path)) continue;
    seenPaths.add(it.path);
    deduped.push(it);
  }
  all.length = 0;
  all.push(...deduped);

  // Compute size-on-disk for every item (in parallel, capped concurrency).
  if (includeSizes) {
    tick(`Measuring sizes (${all.length} items)…`);
    const paths = all.map((it) => it.path);
    const sizes = await computeSizesBatch(paths, 8);
    for (const it of all) it.sizeBytes = sizes.get(it.path) ?? null;
  }

  // Detect Mach-O architectures via `lipo -archs`. Without this we can't
  // honestly tell whether a bundle will load — that's the whole point of
  // re-doing the OS-compat check.
  if (includeArchs) {
    tick(`Checking compatibility (${all.length} items)…`);
    const archInputs = all.map((it) => ({ bundlePath: it.path, executable: it.executable }));
    const archMap = await detectArchitecturesBatch(archInputs, 8);
    for (const it of all) {
      const archs = archMap.get(it.path);
      it.architectures = Array.isArray(archs) ? archs : null;
    }
  }

  tick(`Categorizing across formats…`);
  unifyCrossFormatCategories(all);
  unifyCrossFormatDevelopers(all);
  unifyCaseOnlyDevelopers(all);
  propagateByName(all);
  // After every developer-name unification pass has run, re-enrich each
  // item's registry record using the FINAL developer name. Without this,
  // an item that started with a misattributed developer (e.g. "Massive"
  // or "Native-instruments" from an identifier-guess) and was later
  // corrected to "Native Instruments" would never get its companion-app
  // entry attached.
  enrichAllRegistryByDeveloperName(all);
  applyOsCompat(all, systemVersion, systemArch);

  tick(`Detecting duplicates…`);

  // Detect duplicates / superseded versions.
  const dupMap = detectDuplicates(all);
  for (const it of all) {
    const d = dupMap.get(it.id);
    if (d) it.duplicate = d;
  }

  // Build summary counts.
  const byFormat = {};
  const byCategory = {};
  const byDeveloper = {};
  let totalBytes = 0;
  let duplicateBytes = 0;
  let supersededBytes = 0;
  let duplicateCount = 0;
  let supersededCount = 0;
  for (const item of all) {
    byFormat[item.format] = (byFormat[item.format] || 0) + 1;
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    byDeveloper[item.developer] = (byDeveloper[item.developer] || 0) + 1;
    if (item.sizeBytes) totalBytes += item.sizeBytes;
    if (item.duplicate && item.duplicate.status === 'duplicate') {
      duplicateCount++;
      duplicateBytes += item.sizeBytes || 0;
    } else if (item.duplicate && item.duplicate.status === 'superseded') {
      supersededCount++;
      supersededBytes += item.sizeBytes || 0;
    }
  }

  let incompatibleCount = 0;
  for (const it of all) {
    if (it.osCompat && it.osCompat.status === 'incompatible') incompatibleCount++;
  }

  return {
    items: all,
    summary: {
      total: all.length,
      byFormat,
      byCategory,
      byDeveloper,
      totalBytes,
      duplicateCount,
      supersededCount,
      duplicateBytes,
      supersededBytes,
      incompatibleCount,
    },
    systemVersion,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Score a category classification by how trustworthy / specific it is.
 * Higher is better. Used to pick the canonical category across formats.
 *
 *   registry override               → 100  (someone explicitly mapped it)
 *   AU type for instruments (aumu)  → 80   (very specific)
 *   AU type for MIDI processor      → 75   (very specific)
 *   Name heuristic with subcategory → 60   (e.g. "Flanger" → Modulation)
 *   AU type aufx (generic effect)   → 50   (correct but coarse)
 *   AU type aumf (music effect)     → 30   (often misleading — many audio
 *                                          effects claim aumf so they can
 *                                          receive MIDI control. We don't
 *                                          want that to win against a name-
 *                                          based "Modulation" classification.)
 *   fallback / unknown              → 0
 */
function scoreCategory(item) {
  const src = item.categorySource;
  const sub = item.subcategory;
  if (src === 'registry') return 100;
  if (src === 'au-type') {
    if (item.category === 'Instrument') return 80;
    if (item.category === 'MIDI') return 75;
    // Generic Effect with no specific subcategory — the name heuristic
    // should be allowed to win over this with a real subcategory.
    if (item.category === 'Effect' && !sub) return 40;
    return 50;
  }
  if (src === 'name-heuristic') {
    // A name match with a real, specific subcategory is high-confidence.
    // MIDI without a subcategory still beats a generic Effect.
    if (sub && sub !== 'Uncategorized') return 60;
    if (item.category === 'MIDI') return 55;
    return 35;
  }
  return 0;
}

function unifyCrossFormatCategories(items) {
  // Group by identifier when present, otherwise by lowercased developer+name.
  const groups = new Map();
  for (const it of items) {
    const key = (it.identifier || `${it.developer || 'unknown'}|${it.name || ''}`).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    let best = null;
    for (const m of members) {
      const s = scoreCategory(m);
      if (!best || s > best.score) best = { item: m, score: s };
    }
    if (!best) continue;

    // Track every distinct category across the group so the detail panel can
    // show "also classified as: …".
    const seen = new Set();
    const candidates = [];
    for (const m of members) {
      const k = `${m.category}/${m.subcategory}`;
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push({
        category: m.category,
        subcategory: m.subcategory,
        source: m.categorySource,
        sourceFormat: m.format,
      });
    }

    for (const m of members) {
      m.categoryCandidates = candidates;
      if (m === best.item) continue;
      m.category = best.item.category;
      m.subcategory = best.item.subcategory;
      m.categorySource = `${best.item.categorySource}+cross-format`;
    }
  }
}

/**
 * Cross-format developer-name consistency.
 *
 * The Absynth-style bug: VST3 and AU bundles for the same plugin sometimes
 * carry different copyrights (or no copyright at all in the AU), yielding
 * different developer names from the same product. We group by identifier
 * and pick the best name to apply to all members.
 *
 * Priority for picking the canonical name:
 *   1. A name that matches the registry exactly (developer key in
 *      developerRegistry.json) — that means our identifier-prefix lookup
 *      hit and we KNOW it's right.
 *   2. The longest name (more specific is usually correct, e.g. "Native
 *      Instruments" beats "NI" or "Apple" beats a single-letter parse).
 *   3. The first name encountered.
 */
function unifyCrossFormatDevelopers(items) {
  const { loadRegistry } = require('./registryLookup.cjs');
  const reg = loadRegistry();
  const knownDevelopers = new Set([
    ...Object.keys(reg.developers || {}),
    ...Object.keys(reg.appPublishers || {}),
  ]);

  // Group by identifier when present. Items without an identifier can't be
  // safely unified with anything else.
  const groups = new Map();
  for (const it of items) {
    const id = (it.identifier || '').toLowerCase();
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(it);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Score every member's developer name.
    let best = null;
    for (const m of members) {
      const dev = m.developer || '';
      if (!dev || dev === 'Unknown') continue;
      let score = 0;
      if (knownDevelopers.has(dev)) score = 1000;        // registry-known wins outright
      score += dev.length;                                 // longer = more specific tie-break
      if (!best || score > best.score) best = { score, name: dev };
    }
    if (!best) continue;
    for (const m of members) {
      if (m.developer !== best.name) {
        m.developer = best.name;
        m.developerSource = 'cross-format';
      }
    }
  }
}

/**
 * Collapse developer names that differ only in case ("Ujam" vs "UJAM"),
 * picking a single canonical form to apply across every member.
 *
 * Scoring:
 *   - Most common variant wins (count × 10).
 *   - All-uppercase is penalized (people don't usually want "UJAM" as the
 *     display form), as is all-lowercase.
 *   - Ties broken by first encountered.
 *
 * Runs after unifyCrossFormatDevelopers so registry-canonical names are
 * already applied where the bundle identifier is known. This step picks
 * up free-text developer names from copyright strings that the registry
 * didn't recognize.
 */
function unifyCaseOnlyDevelopers(items) {
  const variantsByLower = new Map();
  for (const it of items) {
    const dev = it.developer;
    if (!dev || dev === 'Unknown') continue;
    const key = dev.toLowerCase();
    if (!variantsByLower.has(key)) variantsByLower.set(key, new Map());
    const m = variantsByLower.get(key);
    m.set(dev, (m.get(dev) || 0) + 1);
  }
  const canonicalByLower = new Map();
  for (const [lower, variants] of variantsByLower) {
    if (variants.size <= 1) continue;            // already consistent
    let best = null;
    for (const [name, count] of variants) {
      let score = count * 10;
      if (name === name.toUpperCase()) score -= 5;
      if (name === name.toLowerCase()) score -= 4;
      if (!best || score > best.score) best = { name, score };
    }
    canonicalByLower.set(lower, best.name);
  }
  for (const it of items) {
    const dev = it.developer;
    if (!dev) continue;
    const canon = canonicalByLower.get(dev.toLowerCase());
    if (canon && canon !== dev) {
      it.developer = canon;
      it.developerSource = (it.developerSource || 'inferred') + '+case-fold';
    }
  }
}

/**
 * Cross-format propagation by EXACT plugin name.
 *
 * The other unify* passes group by CFBundleIdentifier, which is the right
 * thing 90% of the time. But sometimes the same product ships with
 * different identifiers per format — Native Instruments Battery 4 is the
 * classic case (the App, VST3, and VST2 bundles all carry different
 * identifiers). When that happens, identifier-based grouping leaves the
 * VST3/VST2 entries with developer='Unknown' and category='Undefined'
 * even though the App entry has the right info.
 *
 * This pass groups every item by lowercased name and, for each group,
 * picks a "donor" with a known developer / non-Undefined category, then
 * copies those values to recipients whose corresponding field is still
 * Unknown / Undefined. Conservative — never overwrites an already-known
 * developer with a different one.
 */
function propagateByName(items) {
  const groups = new Map();
  for (const it of items) {
    const key = (it.name || '').toLowerCase().trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    let donorDev = null;
    let donorCat = null;
    for (const it of group) {
      if (!donorDev && it.developer && it.developer !== 'Unknown') {
        donorDev = it.developer;
      }
      if (it.category && it.category !== 'Undefined' && it.category !== 'Other') {
        // Prefer a PLUGIN category donor over an app's 'Application' —
        // if the group holds both Granite.app and Granite.component
        // (Synth), the Synth should win as donor for the VST3/VST2.
        if (!donorCat || (donorCat.category === 'Application' && it.category !== 'Application')) {
          donorCat = { category: it.category, subcategory: it.subcategory };
        }
      }
    }
    if (!donorDev && !donorCat) continue;

    for (const it of group) {
      if (donorDev && (!it.developer || it.developer === 'Unknown')) {
        it.developer = donorDev;
        it.developerSource = (it.developerSource || 'inferred') + '+propagated-by-name';
      }
      if (donorCat && (it.category === 'Undefined' || it.category === 'Other' || !it.category)) {
        // NEVER propagate 'Application' onto a plugin-format item. The
        // donor here is a standalone .app sharing the product's name
        // (New Sonic Arts Freestyle/Vice case: Freestyle.app donated
        // "Application" to the Freestyle VST3/VST2). A plugin whose
        // category we can't determine should stay Undefined — honest —
        // rather than claim to be an application. Apps themselves are
        // always categorized by categorize()'s format === 'App' branch,
        // so they never need donation in the other direction.
        if (donorCat.category === 'Application' && it.format !== 'App') continue;
        it.category = donorCat.category;
        it.subcategory = donorCat.subcategory;
        it.categorySource = (it.categorySource || 'fallback') + '+propagated-by-name';
      }
    }
  }
}

/**
 * Final pass: for every item, re-apply the alias map to normalize the
 * developer name to its canonical form, then re-enrich the registry
 * record with companion-app / homepage / support URLs based on that
 * final name.
 *
 * Why two passes are needed: the per-item `inferDeveloper` call inside
 * scanFormat applies aliases, but only to the COPYRIGHT-derived guess.
 * If `findDeveloperByIdentifier` matched a prefix, the developer name
 * comes back without going through aliases — and later unification
 * passes may further mutate the name. This is the safety net.
 */
function enrichAllRegistryByDeveloperName(items) {
  const { applyDeveloperAlias, loadRegistry } = require('./registryLookup.cjs');
  // Build a name-keyed override map once. developerByName lets the
  // registry force-reattribute a plugin based on its name regardless
  // of the bundle ID. Useful when a vendor distributes plugins under
  // a different brand's namespace (e.g. Splice's Astra ships with
  // Brainworx bundle IDs, so identifier-based attribution would land
  // it under Plugin Alliance).
  const reg = loadRegistry();
  const byNameMap = (reg && reg.developerByName) || {};
  const nameKeys = Object.keys(byNameMap).filter((k) => k && k !== '_comment');
  // Build two parallel maps so we can match both "Splice Bridge" and
  // "SpliceBridge" against the same registry entry. The normalized
  // form strips everything that isn't a letter or digit.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const lcMap = {};
  const normMap = {};
  for (const k of nameKeys) {
    if (!k || k === '_comment') continue;
    lcMap[k.toLowerCase()] = byNameMap[k];
    normMap[norm(k)] = byNameMap[k];
  }

  for (const it of items) {
    // Name-based override wins over whatever identifier said.
    let overrodeByName = false;
    const lowerName = String(it.name || '').toLowerCase();
    const normName = norm(it.name);
    if (lowerName) {
      // Strict match first (whole plugin name keyed in map).
      let forced = lcMap[lowerName] || normMap[normName];
      // Fallback: prefix match — "Astra" matches "Astra 2" etc.
      if (!forced) {
        for (const k of nameKeys) {
          const lcK = k.toLowerCase();
          const nK = norm(k);
          if (
            lowerName === lcK ||
            lowerName.startsWith(lcK + ' ') ||
            lowerName.startsWith(lcK + '-') ||
            normName === nK ||
            normName.startsWith(nK)
          ) {
            forced = byNameMap[k];
            break;
          }
        }
      }
      if (forced && typeof forced === 'string' && forced !== it.developer) {
        console.log(`[enrich] name-override: "${it.name}" (${it.format}) ${it.developer} → ${forced}`);
        it.developer = forced;
        it.developerSource = (it.developerSource || 'inferred') + '+name-override';
        overrodeByName = true;
      }
    }
    // Skip alias remapping when name-override fired — the override is
    // authoritative and the alias table uses substring matching, which
    // can clobber the override (e.g. "spl" → Plugin Alliance matches
    // "Splice" as a substring and undoes the override).
    if (!overrodeByName && it.developer && it.developer !== 'Unknown') {
      const aliased = applyDeveloperAlias(it.developer);
      if (aliased && aliased !== it.developer) {
        it.developer = aliased;
      }
    }
    // When name-override fired we also force-replace registry fields
    // (companion app, homepage, etc.) so they don't stay pointing at
    // the wrong vendor.
    it.registry = enrichRegistryByDeveloperName(it.registry, it.developer, overrodeByName);
  }
}

module.exports = { scanLibrary, FORMATS, unifyCrossFormatCategories, unifyCrossFormatDevelopers, unifyCaseOnlyDevelopers, propagateByName, enrichAllRegistryByDeveloperName };
