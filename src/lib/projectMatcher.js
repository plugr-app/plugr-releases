// Project ↔ library matcher. Pure, no Node/Electron — runs in the
// renderer and the main process tests alike.
//
// Inputs:
//   - projects: [{ id, path, name, dawType, plugins: [{ name, identifier?, format?, count }] }]
//   - libraryItems: [{ id, name, identifier?, format, ... }]  (post-overrides)
//
// Outputs:
//   - projectsByLibraryId: Map<itemId, [projectId]>
//   - countByLibraryId: Map<itemId, totalInstancesAcrossProjects>
//   - unmatchedReferences: [{ key, name, format?, identifier?, count, projectIds }]
//   - usedItemIds: Set<itemId> (any item used in at least one project)
//   - mostUsed: [{ itemId, projectCount, instanceCount }] sorted desc
//
// Match priority:
//   1. Exact identifier match (VST3 DeviceId, VST2 'vst2:NNN', AU
//      'au:type:subtype:manu').
//   2. Normalized name + format match.
//   3. Normalized name alone (matches across formats — e.g. the same
//      plugin used as VST3 in one project and AU in another counts as
//      one plugin).

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeFormat(s) {
  const f = String(s || '').toUpperCase();
  if (f.startsWith('VST3')) return 'VST3';
  if (f.startsWith('VST')) return 'VST2';
  if (f === 'AU') return 'AU';
  if (f === 'AAX') return 'AAX';
  if (f === 'CLAP') return 'CLAP';
  return f || null;
}

/**
 * Build the cross-reference between projects and library items.
 */
export function buildProjectMatch(projects, libraryItems) {
  // Index library items by identifier, by AU FourCC tuple, by
  // (name,format), and by name.
  //
  // The AU FourCC index ("au:aufx:XfTT:XFER" → item) lets us resolve
  // a Logic project reference (which stores plugins as 4-tuple AU
  // descriptors) to the same library item that's identified elsewhere
  // by its macOS bundle ID. Without this, Logic project plugins would
  // ALWAYS be "not installed" even when the user has the plugin in
  // their library.
  const byIdent = new Map();
  const byAuKey = new Map();
  const byAuTail = new Map();   // "subtype:manufacturer" → item (lenient fallback)
  const byNameFormat = new Map();
  const byName = new Map();
  for (const it of libraryItems || []) {
    if (it.identifier) byIdent.set(String(it.identifier).toLowerCase(), it);
    if (Array.isArray(it.auKeys)) {
      for (const k of it.auKeys) {
        if (typeof k !== 'string' || !k) continue;
        byAuKey.set(k.toLowerCase(), it);
        // Also index by (subtype, manufacturer) without the type byte
        // — handles cases where the project file recorded the AU as
        // a different type than the bundle declares (e.g. effect vs
        // music-effect variants of the same plugin).
        const parts = k.toLowerCase().split(':');
        if (parts.length === 4) byAuTail.set(`${parts[2]}:${parts[3]}`, it);
      }
    }
    const nf = normalizeName(it.name) + '|' + normalizeFormat(it.format);
    if (!byNameFormat.has(nf)) byNameFormat.set(nf, it);
    const n = normalizeName(it.name);
    if (n && !byName.has(n)) byName.set(n, it);
  }

  const projectsByLibraryId = new Map();        // itemId -> Set<projectId>
  const countByLibraryId = new Map();           // itemId -> total instance count
  const unmatched = new Map();                  // key -> { ...ref, projectIds: Set, count }

  function bump(itemId, projectId, count) {
    if (!projectsByLibraryId.has(itemId)) projectsByLibraryId.set(itemId, new Set());
    projectsByLibraryId.get(itemId).add(projectId);
    countByLibraryId.set(itemId, (countByLibraryId.get(itemId) || 0) + (count || 1));
  }

  for (const proj of projects || []) {
    if (!proj || !proj.plugins) continue;
    for (const ref of proj.plugins) {
      let hit = null;
      const refId = ref.identifier ? String(ref.identifier).toLowerCase() : null;
      if (refId) hit = byIdent.get(refId);
      // Logic / Ableton project files identify AU plugins by their
      // FourCC tuple ("au:aufx:XfTT:XFER") rather than by macOS bundle
      // ID. Resolve those to the library item whose own auKeys list
      // includes the same tuple.
      if (!hit && refId && refId.startsWith('au:')) {
        hit = byAuKey.get(refId);
        // Lenient fallback — match on subtype + manufacturer alone.
        if (!hit) {
          const parts = refId.split(':');
          if (parts.length === 4) {
            hit = byAuTail.get(`${parts[2]}:${parts[3]}`);
          }
        }
      }
      if (!hit) {
        const nf = normalizeName(ref.name) + '|' + normalizeFormat(ref.format);
        hit = byNameFormat.get(nf);
      }
      if (!hit) {
        hit = byName.get(normalizeName(ref.name));
      }
      if (hit) {
        bump(hit.id, proj.id, ref.count || 1);
      } else {
        // Track unmatched. Key collapses identical refs across projects
        // so we don't show duplicates in the "Referenced but not
        // installed" list.
        const key = (ref.identifier
          ? String(ref.identifier).toLowerCase()
          : normalizeName(ref.name) + '|' + normalizeFormat(ref.format));
        if (!unmatched.has(key)) {
          unmatched.set(key, {
            key,
            name: ref.name,
            identifier: ref.identifier || null,
            format: ref.format || null,
            count: 0,
            projectIds: new Set(),
          });
        }
        const u = unmatched.get(key);
        u.count += (ref.count || 1);
        u.projectIds.add(proj.id);
      }
    }
  }

  // Materialize the convenience views the UI wants.
  const usedItemIds = new Set([...projectsByLibraryId.keys()]);
  const mostUsed = [...projectsByLibraryId.entries()]
    .map(([itemId, set]) => ({
      itemId,
      projectCount: set.size,
      instanceCount: countByLibraryId.get(itemId) || 0,
    }))
    .sort((a, b) => b.projectCount - a.projectCount || b.instanceCount - a.instanceCount);

  const unmatchedReferences = [...unmatched.values()]
    .map((u) => ({ ...u, projectIds: [...u.projectIds] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    projectsByLibraryId,
    countByLibraryId,
    usedItemIds,
    mostUsed,
    unmatchedReferences,
  };
}

/**
 * Convenience: produce a Map<itemId, { projectCount, instanceCount, projects:[{id,name}] }>
 * with project names looked up from the projects array. Used by the
 * tooltip/popover that fires when you click a 'Used in N projects' badge.
 */
export function buildPerItemSummary(match, projects) {
  const projById = new Map(projects.map((p) => [p.id, p]));
  const out = new Map();
  for (const [itemId, set] of match.projectsByLibraryId.entries()) {
    const projList = [...set].map((id) => {
      const p = projById.get(id);
      return p ? { id: p.id, name: p.name, path: p.path, dawType: p.dawType } : { id };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    out.set(itemId, {
      projectCount: set.size,
      instanceCount: match.countByLibraryId.get(itemId) || 0,
      projects: projList,
    });
  }
  return out;
}
