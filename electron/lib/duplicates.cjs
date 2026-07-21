// Duplicate / superseded-version detection.
//
// We deliberately treat "the same plugin installed in multiple FORMATS"
// (e.g. VST3 + AU + AAX of FabFilter Pro-Q 3) as NOT a duplicate — that's
// the normal, expected setup.
//
// What we DO flag, per (developer, normalized name, format) group:
//   - status='duplicate'   if there are 2+ entries at the same version.
//                          The largest path on disk is kept, others marked.
//   - status='superseded'  if there are 2+ entries at different versions.
//                          The newest version is kept, older ones are
//                          marked as candidates for cleanup.
//
// Each item gets:
//   duplicate: {
//     status: 'duplicate' | 'superseded' | null,
//     groupId: stable group key,
//     keptId: id of the entry we recommend keeping in this group,
//     reason: human-readable note,
//   }

const semver = require('semver');

// Normalize a name down to its product family identifier — strips
// trailing VERSION markers but keeps MODEL numbers. Previously this
// borrowed nameVariants() from discoverUpdateSource and took its
// most-stripped variant; that's correct for URL discovery (aggressive
// stripping just means trying more slugs) but WRONG here: it collapsed
// "Pre V76" and "Pre 1973" (different Arturia preamp PRODUCTS) both
// down to "pre", so every format of Pre V76 was marked OLD against
// Pre 1973's higher version number.
//
// The distinction we rely on: version markers are "V" + a SINGLE digit
// ("Mini V3", "CS-80 V4") or a bare 1-2 digit trailing number
// ("Neutron 3", "Ozone 11", "Pro-Q 3") — grouping those is the whole
// point (Neutron 3 should flag OLD when Neutron 4 exists). Model
// numbers are V + 2+ digits ("Pre V76" — the V76 is a hardware unit)
// or 3+ digit numbers ("Pre 1973", "ARP 2600") and must NOT strip.
//   "CS-80 V3"   → "cs 80"     "Pre V76"    → "pre v76"
//   "CS-80 V4"   → "cs 80"     "Pre 1973"   → "pre 1973"
//   "Pro-Q 3"    → "pro q"     "ARP 2600 V" → "arp 2600"
//   "Mini V3"    → "mini"      "Pigments"   → "pigments"
// Strip a developer's trailing legal-entity suffix ("Acon Digital AS" →
// "Acon Digital", "Foo GmbH" → "Foo") so a vendor that ships some plugins
// under "X" and others under "X AS/GmbH/Ltd" is treated as ONE developer.
// Requires a separator before the suffix so single-token names ("AAS",
// "Waves") are never touched. Loops to peel "Foo Inc Ltd"-style stacks.
function stripLegalSuffix(dev) {
  let s = String(dev || '');
  let prev;
  do {
    prev = s;
    s = s.replace(/[\s,]+(?:a\/s|as|gmbh|ltd|llc|inc|corp|ab|oy|b\.?v|s\.?l|s\.?r\.?l|kg|ug|pty|plc|k\.?k)\.?$/i, '').trim();
  } while (s !== prev);
  return s;
}

function normalizeName(name, version, developer) {
  if (!name) return '';
  let s = String(name);
  // Strip the developer's own name off the FRONT of the plugin name. Some
  // vendors name one format "Acon Digital DeClick 2" and another "DeClick2";
  // dropping the leading vendor name lets those group. Guarded so we never
  // strip the name down to nothing (a plugin literally named after its dev).
  const cdev = stripLegalSuffix(developer);
  if (cdev) {
    const re = new RegExp('^' + cdev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s:_-]*', 'i');
    const stripped = s.replace(re, '');
    if (stripped && stripped.trim().length >= 2) s = stripped;
  }
  // strip "(stereo)" / "(m)" etc before the trailing-number check
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Trailing-number handling — disambiguates a VERSION suffix from a MODEL
  // number by requiring the number to equal the installed MAJOR version:
  // "Neutron 3" → v3 (strip, groups with Neutron 4), "SEM V2" → v2.13 (strip),
  // vs "RC 48" → v1.4.11 (keep), "Pre V76" → v1.8.1 (keep), "MC77" → v1 (keep).
  // Whitespace is OPTIONAL so "DeClick2" and "DeClick 2" behave identically —
  // the major-version gate still protects model numbers ("1176" → v1 keeps).
  // Unknown version → keep (unknown-version items aren't marked superseded).
  const m = s.match(/\s*V?(\d{1,2})\s*$/i);
  if (m) {
    const sv = semver.coerce(String(version || ''));
    if (sv && sv.major === parseInt(m[1], 10)) {
      s = s.slice(0, m.index);
    }
  }
  // Trailing bare " V" (Arturia "ARP 2600 V", "Mini V") is a version marker.
  s = s.replace(/\s+V\s*$/i, '');
  // Strip ALL non-alphanumerics (matching the registry's product matcher) so
  // spacing / punctuation differences ("Auto-Align 2" vs "AutoAlign2",
  // "Helper-Equalizer 2" vs "HelperEqualizer2") never split a product.
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function groupKey(item) {
  // Group by (developer + name-family) — format intentionally excluded.
  // Cross-format grouping lets us catch the iZotope-Neutron-4-dropped-
  // VST2 case: Neutron 3 VST2 should be flagged OLD even though there
  // is no Neutron 4 VST2 to compare against, because Neutron 4 VST3 /
  // AU exists. Within the group, we still distinguish same-format
  // duplicates (multiple installs of the same plugin version) from
  // legit multi-format installs (Pro-Q 3 VST3 + Pro-Q 3 AU).
  const fam = normalizeName(item.name, item.version, item.developer);
  const dev = stripLegalSuffix(item.developer || 'unknown').toLowerCase().trim();
  const vm = (item.name || '').match(/\(([a-zA-Z][a-zA-Z\s]*)\)\s*$/);
  const variant = vm ? `|${vm[1].toLowerCase().trim()}` : '';
  // Waves generation is NOT part of identity (2026-07-17, Josh's call):
  // V15 "Stream" and V16 "Stream" are the same plugin, so the older
  // generation should be flagged OLD/superseded like any other outdated
  // version — consistent with the rest of the app. (Old DAW sessions can
  // still pin to an older shell, so treat OLD as a cleanup hint, and lean
  // on "used in projects" + the orphan-shell "safe to remove" detector to
  // decide what's actually removable.) Versions sort across generations
  // naturally (15.x < 16.x), so the newest generation is the kept copy.
  return `${dev}|${fam}${variant}`;
}

function compareSemver(a, b) {
  const sa = semver.coerce(a);
  const sb = semver.coerce(b);
  if (sa && sb) return semver.compare(sa, sb);
  // numeric tuple fallback
  const pa = String(a || '').split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Build a Map<id, dupRecord> for items that participate in a duplicate or
 * superseded group. Items not in any group don't appear in the map.
 */
function detectDuplicates(items) {
  const groups = new Map();
  for (const it of items) {
    const key = groupKey(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const out = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;

    // Sort newest version first, then largest size first (as a tiebreaker).
    const sorted = [...members].sort((a, b) => {
      const cmp = compareSemver(b.version, a.version);
      if (cmp !== 0) return cmp;
      return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    });

    const newestByFormat = new Map();
    for (const m of members) {
      const fmt = (m.format || '').toLowerCase();
      const cur = newestByFormat.get(fmt);
      if (!cur || compareSemver(m.version || '', cur.version || '') > 0) newestByFormat.set(fmt, m);
    }

    // Bucket members by (version + format + bundle filename) so we can
    // identify true same-format duplicates separately from cross-format
    // multi-format installs at the same version. The FILENAME is part of
    // the identity: a genuine duplicate (same product installed twice —
    // system vs user plugin folder) carries the same bundle name, while
    // companion variants that register the same friendly AU name from
    // DIFFERENT bundles (Polyverse "Gatekeeper.component" vs
    // "GatekeeperMIDI.component") are distinct products and must not be
    // flagged. Superseded detection deliberately ignores filenames —
    // those legitimately change across versions ("Neutron 3.vst3" →
    // "Neutron 4.vst3").
    const dupBucketKey = (m) => `${m.version || ''}|${m.format}|${String(m.bundleName || '').toLowerCase()}`;
    const versionFormatBuckets = new Map();
    for (const m of members) {
      const k = dupBucketKey(m);
      if (!versionFormatBuckets.has(k)) versionFormatBuckets.set(k, []);
      versionFormatBuckets.get(k).push(m);
    }

    for (const m of sorted) {
      const mVer = m.version || '';
      // Use semver comparison instead of raw string equality so that
      // build-metadata suffixes don't cause false "superseded" flags.
      // Example: "2.4.0.82a3f41" vs "2.4.0" — both coerce to 2.4.0, so
      // compareSemver returns 0. Without this, the string "2.4.0.82a3f41"
      // !== "2.4.0" would make the build-suffixed copy look older.
      const fmtNewest = newestByFormat.get((m.format || '').toLowerCase()) || sorted[0];
      const fmtNewestVer = fmtNewest.version || '';
      // An unknown version (on either side) can never prove "older".
      // This matters for bundles whose plist version was rejected as
      // garbage by saneVersion (KORG AAX placeholder strings): without
      // this guard the empty string compares as v0 and the copy gets a
      // bogus OLD badge. Unknown-version copies fall through to the
      // same-format duplicate check instead.
      const isNewestVersion = !mVer || !fmtNewestVer ||
        mVer === fmtNewestVer || compareSemver(mVer, fmtNewestVer) >= 0;

      if (!isNewestVersion) {
        // Older version than the group's newest → superseded, regardless
        // of format. This is the iZotope-Neutron-3-VST2 case: even
        // though there's no Neutron 4 VST2, the VST3/AU/AAX of v4 mean
        // the user has v4 around and the VST2 of v3 is old.
        out.set(m.id, {
          status: 'superseded',
          groupId: key,
          keptId: fmtNewest.id,
          reason: `Older than v${fmtNewestVer || '?'} installed at ${fmtNewest.path}`,
        });
      } else {
        // Member is at the newest version. Check whether any peer
        // shares the same version AND format — that's a real duplicate.
        const peers = versionFormatBuckets.get(dupBucketKey(m)) || [];
        if (peers.length >= 2) {
          // Two+ installs of the exact same plugin+version+format.
          // Keep the one with the largest size (heuristic — more likely
          // to be the real installation vs a stub/leftover).
          const peerSorted = [...peers].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
          const kept = peerSorted[0];
          const isKept = m.id === kept.id;
          out.set(m.id, {
            status: isKept ? null : 'duplicate',
            groupId: key,
            keptId: kept.id,
            reason: isKept
              ? `Kept (${peers.length - 1} other copy/copies of v${mVer || '?'})`
              : `Same version as kept copy at ${kept.path}`,
          });
        } else {
          // Newest version, no same-format duplicate. This member is
          // "kept" — recorded so the renderer can list group siblings
          // and so the kept item visually anchors the OLD flag on its
          // older counterparts.
          out.set(m.id, {
            status: null,
            groupId: key,
            keptId: m.id,
            reason: mVer
              ? `Newest version (v${mVer}) in this product family`
              : 'Version unknown — not compared against other copies',
          });
        }
      }
    }
  }
  return out;
}

module.exports = { detectDuplicates, normalizeName, groupKey };
