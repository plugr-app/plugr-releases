#!/usr/bin/env node
// One-shot migration: merge the orphaned plugin-hub cache into the
// new plugr cache.
//
// Background: when the app was renamed Plugin Hub → Plugr, Electron's
// userData directory name followed the rename. The old folder
// (~/Library/Application Support/plugin-hub/) was left behind on
// disk, full of useful state:
//   - 3,514 update-check results (saved versions, etc.)
//   - Possibly user overrides, custom registry sources, custom
//     categories, custom folders — all the personalization built up
//     before the rename.
// And the v4 → v5 cache migration in cache.cjs intentionally drops
// `updates` and `library` when it salvages an old cache. So even if
// the new folder had pointed at the old file, the migration would
// have wiped the update results.
//
// This tool merges forward: it takes everything useful out of the
// old plugin-hub cache and merges into the new plugr cache, keeping
// the v5 schema. The new file is backed up first so the merge is
// reversible if anything goes wrong.
//
// MUST be run with Plugr quit, or the merged file could be clobbered
// when Plugr next writes the cache.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OLD = path.join(os.homedir(), 'Library', 'Application Support', 'plugin-hub', 'library-cache.json');
const NEW = path.join(os.homedir(), 'Library', 'Application Support', 'plugr', 'library-cache.json');

function read(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) { console.error(`Couldn't parse ${p}: ${err.message}`); process.exit(1); }
}

function count(o) { return o && typeof o === 'object' ? Object.keys(o).length : 0; }

console.log('OLD:', OLD);
console.log('NEW:', NEW);
console.log();

const oldCache = read(OLD);
const newCache = read(NEW);

if (!oldCache) {
  console.error('No old plugin-hub cache found. Nothing to migrate.');
  process.exit(1);
}
if (!newCache) {
  console.error('No new plugr cache found. Run Plugr at least once before migrating.');
  process.exit(1);
}

console.log('Before merge:');
console.log('  OLD updates:', count(oldCache.updates), ' updatesCheckedAt:', oldCache.updatesCheckedAt || '(never)');
console.log('  OLD userOverrides:', count(oldCache.userOverrides),
            '  userRegistryAdditions:', count(oldCache.userRegistryAdditions),
            '  userCategories:', count(oldCache.userCategories),
            '  customFolders:', (oldCache.customFolders || []).length,
            '  userDeveloperCompanions:', count(oldCache.userDeveloperCompanions));
console.log();
console.log('  NEW updates:', count(newCache.updates), ' updatesCheckedAt:', newCache.updatesCheckedAt || '(never)');
console.log('  NEW userOverrides:', count(newCache.userOverrides),
            '  userRegistryAdditions:', count(newCache.userRegistryAdditions),
            '  userCategories:', count(newCache.userCategories),
            '  customFolders:', (newCache.customFolders || []).length,
            '  userDeveloperCompanions:', count(newCache.userDeveloperCompanions));
console.log();

// Back up the new cache before touching it.
const backupPath = NEW + '.before-migration-' + Date.now() + '.bak';
fs.copyFileSync(NEW, backupPath);
console.log('Backed up NEW cache to:', backupPath);

// Merge strategy:
//   - updates / updatesCheckedAt: take from OLD if NEW is empty,
//     otherwise prefer NEW. (NEW was never checked, so OLD wins.)
//   - userOverrides / userRegistryAdditions / userCategories /
//     customFolders / userDeveloperCompanions: union them,
//     preferring NEW when keys overlap (since NEW is what the user
//     has been actively editing).
function mergeMaps(oldMap, newMap) {
  const out = { ...(oldMap || {}) };
  for (const [k, v] of Object.entries(newMap || {})) out[k] = v;
  return out;
}
function mergeArrays(oldArr, newArr) {
  const seen = new Set();
  const out = [];
  for (const item of [...(newArr || []), ...(oldArr || [])]) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const merged = {
  ...newCache,                                                   // keep all NEW fields (incl. v5 schema)
  updates: count(newCache.updates) > 0 ? newCache.updates : (oldCache.updates || {}),
  updatesCheckedAt: newCache.updatesCheckedAt || oldCache.updatesCheckedAt || null,
  library: newCache.library || oldCache.library || null,         // prefer NEW's library scan if present
  userOverrides: mergeMaps(oldCache.userOverrides, newCache.userOverrides),
  userRegistryAdditions: mergeMaps(oldCache.userRegistryAdditions, newCache.userRegistryAdditions),
  userCategories: mergeMaps(oldCache.userCategories, newCache.userCategories),
  customFolders: mergeArrays(oldCache.customFolders, newCache.customFolders),
  userDeveloperCompanions: mergeMaps(oldCache.userDeveloperCompanions, newCache.userDeveloperCompanions),
};

fs.writeFileSync(NEW, JSON.stringify(merged, null, 2), 'utf8');

console.log();
console.log('After merge (written to NEW):');
console.log('  updates:', count(merged.updates), ' updatesCheckedAt:', merged.updatesCheckedAt);
console.log('  userOverrides:', count(merged.userOverrides),
            '  userRegistryAdditions:', count(merged.userRegistryAdditions),
            '  userCategories:', count(merged.userCategories),
            '  customFolders:', (merged.customFolders || []).length,
            '  userDeveloperCompanions:', count(merged.userDeveloperCompanions));
console.log();
console.log('Done. Restart Plugr — update statuses + any orphaned personalization should be back.');
console.log('If anything looks wrong, restore the backup:');
console.log('  cp "' + backupPath + '" "' + NEW + '"');
