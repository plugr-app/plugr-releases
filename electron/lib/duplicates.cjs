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
const { nameVariants } = require('./discoverUpdateSource.cjs');

// Normalize a name down to its product family identifier — strips
// trailing version markers (V3, V4, 3, V) and decorative punctuation,
// but KEEPS internal numbers like "80" in "CS-80" or "2600" in
// "ARP 2600". We do this by feeding the name through nameVariants and
// taking the most-stripped variant (which is always last). So:
//   "CS-80 V3"   → "cs 80"   (strip V3 → "CS-80 V" → "CS-80" → normalize)
//   "CS-80 V4"   → "cs 80"   (same key — groups for old-version detection)
//   "Pro-Q 3"    → "pro q"
//   "Mini V3"    → "mini"
//   "ARP 2600 V" → "arp 2600"
//   "Pigments"   → "pigments"
function normalizeName(name) {
  if (!name) return '';
  const variants = nameVariants(name);
  const mostStripped = variants[variants.length - 1] || name;
  return String(mostStripped)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')   // strip "(stereo)" etc
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function groupKey(item) {
  // Group by (developer + name-family) — format intentionally excluded.
  // Cross-format grouping lets us catch the iZotope-Neutron-4-dropped-
  // VST2 case: Neutron 3 VST2 should be flagged OLD even though there
  // is no Neutron 4 VST2 to compare against, because Neutron 4 VST3 /
  // AU exists. Within the group, we still distinguish same-format
  // duplicates (multiple installs of the same plugin version) from
  // legit multi-format installs (Pro-Q 3 VST3 + Pro-Q 3 AU).
  const fam = normalizeName(item.name);
  const dev = (item.developer || 'unknown').toLowerCase().trim();
  return `${dev}|${fam}`;
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

    const newest = sorted[0];
    const newestVer = newest.version || '';

    // Bucket members by (version + format) so we can identify true
    // same-format duplicates separately from cross-format multi-format
    // installs at the same version.
    const versionFormatBuckets = new Map();
    for (const m of members) {
      const k = `${m.version || ''}|${m.format}`;
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
      const isNewestVersion = mVer === newestVer || compareSemver(mVer, newestVer) >= 0;

      if (!isNewestVersion) {
        // Older version than the group's newest → superseded, regardless
        // of format. This is the iZotope-Neutron-3-VST2 case: even
        // though there's no Neutron 4 VST2, the VST3/AU/AAX of v4 mean
        // the user has v4 around and the VST2 of v3 is old.
        out.set(m.id, {
          status: 'superseded',
          groupId: key,
          keptId: newest.id,
          reason: `Older than v${newestVer || '?'} installed at ${newest.path}`,
        });
      } else {
        // Member is at the newest version. Check whether any peer
        // shares the same version AND format — that's a real duplicate.
        const peers = versionFormatBuckets.get(`${mVer}|${m.format}`) || [];
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
            reason: `Newest version (v${mVer || '?'}) in this product family`,
          });
        }
      }
    }
  }
  return out;
}

module.exports = { detectDuplicates, normalizeName, groupKey };
