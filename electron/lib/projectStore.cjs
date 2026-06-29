// Dedicated persistence for the DAW project library, tags, notes,
// bounce overrides, and ratings.
//
// History: project data used to live inside the main library cache.
// That worked, but ANY cache write — even one unrelated to projects
// (a sort-pref change, a theme switch, a plugin scan, etc.) — had to
// remember to preserve every project field in its merge. Forgetting
// even one field silently wiped it on the next write. The bug bit us
// at least twice, so the project data now lives in its OWN file with
// its OWN write chain. Patching the main cache cannot affect this
// file, and vice versa. This is intentionally redundant: even if the
// caller forgets to preserve project fields, the data survives.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const STORE_FILENAME = 'projects.json';

function projectStorePath(userDataDir) {
  return path.join(userDataDir, STORE_FILENAME);
}

const EMPTY_STORE = Object.freeze({
  version: STORE_VERSION,
  projectLibrary: null,
  projectTags: {},
  projectNotes: {},
  projectBounceOverrides: {},
  projectRatings: {},
  projectStatuses: {},       // projectId → statusId
  customStatuses: null,      // null = use built-in defaults; array = user list
  // Manual key signature for projects where automatic detection
  // returned null. Detected key always wins on display, so re-scan
  // never silently keeps an out-of-date override.
  projectKeyOverrides: {},   // projectId → key string (e.g. "C minor")
  appView: null,
  savedAt: null,
});

function emptyStore() {
  // Return a mutable shallow copy so callers can patch it.
  return {
    version: STORE_VERSION,
    projectLibrary: null,
    projectTags: {},
    projectNotes: {},
    projectBounceOverrides: {},
    projectRatings: {},
    projectStatuses: {},
    customStatuses: null,
    projectKeyOverrides: {},
    appView: null,
    savedAt: null,
  };
}

async function loadProjectStore(userDataDir) {
  const file = projectStorePath(userDataDir);
  if (!fsSync.existsSync(file)) return null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    // Normalize — any field could be missing if an older build wrote
    // a partial file or the schema grew. Defaulting keeps callers
    // from having to null-check every property.
    return {
      version: STORE_VERSION,
      projectLibrary: data.projectLibrary || null,
      projectTags: (data.projectTags && typeof data.projectTags === 'object') ? data.projectTags : {},
      projectNotes: (data.projectNotes && typeof data.projectNotes === 'object') ? data.projectNotes : {},
      projectBounceOverrides: (data.projectBounceOverrides && typeof data.projectBounceOverrides === 'object') ? data.projectBounceOverrides : {},
      projectRatings: (data.projectRatings && typeof data.projectRatings === 'object') ? data.projectRatings : {},
      projectStatuses: (data.projectStatuses && typeof data.projectStatuses === 'object') ? data.projectStatuses : {},
      customStatuses: Array.isArray(data.customStatuses) ? data.customStatuses : null,
      projectKeyOverrides: (data.projectKeyOverrides && typeof data.projectKeyOverrides === 'object') ? data.projectKeyOverrides : {},
      appView: data.appView || null,
      savedAt: data.savedAt || null,
    };
  } catch (err) {
    console.warn('[projectStore] load failed:', err.message);
    return null;
  }
}

async function saveProjectStore(userDataDir, payload) {
  await fs.mkdir(userDataDir, { recursive: true });
  const file = projectStorePath(userDataDir);
  const tmp = file + '.tmp';
  const data = {
    version: STORE_VERSION,
    projectLibrary: payload.projectLibrary || null,
    projectTags: payload.projectTags || {},
    projectNotes: payload.projectNotes || {},
    projectBounceOverrides: payload.projectBounceOverrides || {},
    projectRatings: payload.projectRatings || {},
    projectStatuses: payload.projectStatuses || {},
    customStatuses: Array.isArray(payload.customStatuses) ? payload.customStatuses : null,
    projectKeyOverrides: payload.projectKeyOverrides || {},
    appView: payload.appView || null,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
  return file;
}

// Independent write chain — never collides with the main cache's
// chain. Two writes to the project store still serialize against
// each other (so we can't lose a tag edit to a near-simultaneous
// rating edit), but they don't block or interleave with library /
// preference writes.
let writeChain = Promise.resolve();

/**
 * Merge `patch` into the store on disk. Read-modify-write under a
 * single promise chain so concurrent IPC calls can't lose writes.
 */
async function patchProjectStore(userDataDir, patch) {
  const result = writeChain.then(async () => {
    const existing = (await loadProjectStore(userDataDir)) || emptyStore();
    const merged = { ...existing, ...patch };
    await saveProjectStore(userDataDir, merged);
    return merged;
  });
  writeChain = result.catch(() => {});
  return result;
}

/**
 * If the project store file is missing but the legacy main cache has
 * project data, copy it over and write the store. Called once at app
 * boot. Returns the loaded store (post-migration).
 */
async function migrateFromLegacyCache(userDataDir, legacyCacheData) {
  const existing = await loadProjectStore(userDataDir);
  if (existing) return existing;
  if (!legacyCacheData) return null;
  const hasAny =
    legacyCacheData.projectLibrary ||
    (legacyCacheData.projectTags && Object.keys(legacyCacheData.projectTags).length) ||
    (legacyCacheData.projectNotes && Object.keys(legacyCacheData.projectNotes).length) ||
    (legacyCacheData.projectBounceOverrides && Object.keys(legacyCacheData.projectBounceOverrides).length) ||
    (legacyCacheData.projectRatings && Object.keys(legacyCacheData.projectRatings).length) ||
    legacyCacheData.appView;
  if (!hasAny) return null;
  const seeded = {
    projectLibrary: legacyCacheData.projectLibrary || null,
    projectTags: legacyCacheData.projectTags || {},
    projectNotes: legacyCacheData.projectNotes || {},
    projectBounceOverrides: legacyCacheData.projectBounceOverrides || {},
    projectRatings: legacyCacheData.projectRatings || {},
    appView: legacyCacheData.appView || null,
  };
  await saveProjectStore(userDataDir, seeded);
  console.log('[projectStore] migrated project data from legacy cache');
  return loadProjectStore(userDataDir);
}

module.exports = {
  loadProjectStore,
  saveProjectStore,
  patchProjectStore,
  projectStorePath,
  migrateFromLegacyCache,
  emptyStore,
  STORE_VERSION,
};
