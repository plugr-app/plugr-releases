// Tiny sidecar preferences file that tells Plugr where to find its
// main data files (library cache + project store).
//
// Why a separate file: when iCloud sync is enabled the cache/projects
// JSON files live in iCloud Drive, not in Application Support. We
// need to know WHERE before we can READ — so the "are we in iCloud
// mode" flag has to live somewhere we can ALWAYS find first. That
// always-local spot is this file.
//
// Schema (intentionally minimal):
//   {
//     iCloudSync: boolean,    // default false
//     savedAt: ISO timestamp,
//   }
//
// Cost of being wrong: zero — the flag drives WHERE we read/write,
// not WHAT. If the file is missing or corrupt, we fall back to
// off (local-only), which is the safe default.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PREFS_FILENAME = 'sync-prefs.json';

// Always-local "anchor" directory — this is the standard userData
// folder, even when iCloud sync is on. It holds the prefs file and
// any other always-local state.
function anchorDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'plugr');
}

function prefsFilePath() {
  return path.join(anchorDir(), PREFS_FILENAME);
}

// iCloud Drive root that's accessible without a paid Apple Developer
// entitlement. macOS exposes the user's iCloud Drive at this path,
// and a folder we create here syncs across all the user's Macs
// automatically. No setup needed beyond the user having iCloud Drive
// turned on system-wide.
function iCloudPlugrDir() {
  return path.join(
    os.homedir(),
    'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Plugr',
  );
}

// Returns true iff the user has an iCloud Drive folder configured.
// Useful to gate the UI ("Sync via iCloud" toggle is grey-disabled
// when iCloud Drive isn't available on this Mac).
function iCloudAvailable() {
  const root = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  return fsSync.existsSync(root);
}

async function loadSyncPrefs() {
  const file = prefsFilePath();
  if (!fsSync.existsSync(file)) return { iCloudSync: false };
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    return {
      iCloudSync: !!data.iCloudSync,
      savedAt: data.savedAt || null,
    };
  } catch {
    return { iCloudSync: false };
  }
}

async function saveSyncPrefs(prefs) {
  const dir = anchorDir();
  await fs.mkdir(dir, { recursive: true });
  const file = prefsFilePath();
  const tmp = file + '.tmp';
  const data = {
    iCloudSync: !!prefs.iCloudSync,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
  return data;
}

// Returns the directory where Plugr's main JSON data files
// (library-cache.json, projects.json) should live RIGHT NOW given
// the current sync prefs. Reads sync-prefs.json from the anchor dir
// every call — that's cheap (tiny file) and means a flip takes effect
// on the next read without restarting the app.
async function resolveDataDir() {
  const prefs = await loadSyncPrefs();
  if (prefs.iCloudSync && iCloudAvailable()) {
    return iCloudPlugrDir();
  }
  return anchorDir();
}

module.exports = {
  anchorDir,
  iCloudPlugrDir,
  iCloudAvailable,
  loadSyncPrefs,
  saveSyncPrefs,
  resolveDataDir,
  prefsFilePath,
};
