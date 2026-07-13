// pluginWatcher.cjs — MacUpdater-style background watcher for installed plugins.
//
// Watches the standard macOS plugin directories (and any user-added custom
// folders) for bundle changes. When a plugin bundle is replaced or updated
// by an installer, we debounce the events, read the new Info.plist, and
// notify the caller so the UI can clear stale "outdated" badges without
// requiring a manual rescan.
//
// Design notes:
//   - Uses Node's built-in fs.watch with { recursive: false } on each
//     directory. We only care about top-level bundle additions/replacements
//     so depth-1 watching is sufficient and avoids over-firing on every
//     binary write inside the bundle.
//   - Debounce per bundle (2 500 ms) + batch window (500 ms after first
//     debounce fires) so mass installs (e.g. 40 Melda plugins at once)
//     produce one batch notification rather than 40 individual ones.
//   - Full Disk Access: directories we can't read are skipped silently.
//     If a system-level dir fails with EACCES, we fire the onFdaRequired
//     callback ONCE (not on every watch event). The caller shows a toast
//     with a button that opens System Preferences → Privacy → Full Disk
//     Access.
//   - Library item list is kept in sync by the caller (main.cjs pushes
//     a fresh list after every successful scan). Items are matched by
//     path prefix so we can quickly find which item a changed bundle
//     corresponds to.

'use strict';

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');
const os   = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { saneVersion, decodePackedAuVersion } = require('./plistParser.cjs');

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

// Canonical plugin directories on macOS. Tried in the order listed.
// User-level dirs typically don't need FDA; system-level ones usually do.
const STANDARD_DIRS = [
  // ── User-level (~/Library) ──────────────────────────────────────────
  path.join(HOME, 'Library', 'Audio', 'Plug-Ins', 'VST3'),
  path.join(HOME, 'Library', 'Audio', 'Plug-Ins', 'Components'),
  path.join(HOME, 'Library', 'Audio', 'Plug-Ins', 'VST'),
  path.join(HOME, 'Library', 'Audio', 'Plug-Ins', 'CLAP'),
  // ── System-level (/Library) ─────────────────────────────────────────
  '/Library/Audio/Plug-Ins/VST3',
  '/Library/Audio/Plug-Ins/Components',
  '/Library/Audio/Plug-Ins/VST',
  '/Library/Audio/Plug-Ins/CLAP',
  // ── AAX (Pro Tools) ─────────────────────────────────────────────────
  '/Library/Application Support/Avid/Audio/Plug-Ins',
];

// Only fire on bundles with these extensions. Ignores other files that
// appear in plugin directories (license files, readmes, etc.).
const BUNDLE_EXTS = new Set(['.vst3', '.component', '.vst', '.clap', '.aaxplugin']);

/**
 * Read CFBundleShortVersionString (or CFBundleVersion fallback) from
 * a plugin bundle's Info.plist.
 *
 * Uses `plutil -convert json` so we handle both binary and XML plists
 * without pulling in a third-party library. Times out after 4 s so a
 * hung `plutil` doesn't stall the watcher.
 */
async function readBundleVersion(bundlePath) {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist');
  try {
    await fsp.access(plistPath, fs.constants.R_OK);
    const { stdout } = await execFileAsync(
      'plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      { timeout: 4000 },
    );
    const info = JSON.parse(stdout);
    // saneVersion filters unexpanded build placeholders (KORG AAX ships
    // "KLAAXWRAPPER_*_VERSION_STRING" literals); decodePackedAuVersion
    // unpacks AU integer versions (Arturia) — same rules as the scanner.
    const raw = saneVersion(info.CFBundleShortVersionString) || saneVersion(info.CFBundleVersion) || null;
    if (bundlePath.toLowerCase().endsWith('.component')) {
      return decodePackedAuVersion(raw) || raw;
    }
    return raw;
  } catch {
    return null;
  }
}

class PluginWatcher {
  /**
   * @param {object} opts
   * @param {(items: object[], meta: object) => void} opts.onChanged
   *   Called with an array of updated item objects (same shape as library
   *   items, with `version` replaced by the newly-read version) plus a meta
   *   object `{ newPlugins: string[] }` listing bundle paths of plugins that
   *   weren't in the library (newly installed — caller may want to schedule
   *   a full rescan).
   * @param {() => void} opts.onFdaRequired
   *   Called at most once when a system-level directory is inaccessible
   *   (EACCES / EPERM). Caller should show a toast prompting the user to
   *   grant Full Disk Access.
   */
  constructor({ onChanged, onFdaRequired } = {}) {
    this._onChanged     = onChanged     || (() => {});
    this._onFdaRequired = onFdaRequired || (() => {});

    // Node fs.Watcher instances keyed by directory path.
    this._watchers = new Map();

    // Per-bundle debounce timers (2 500 ms after last event).
    this._debounceMap = new Map();   // bundlePath → TimeoutID

    // Batch window: after the first debounce fires, collect further
    // fires for 500 ms before emitting one combined notification.
    this._batchTimer    = null;
    this._batchPending  = [];        // { bundlePath, knownItems }[]

    // Flat array of library items. Updated by caller after every scan.
    this._libraryItems  = [];

    // Have we already fired onFdaRequired? We only do it once.
    this._fdaNotified = false;

    this._started = false;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Replace the library items list. Call this after every successful scan. */
  setLibraryItems(items) {
    this._libraryItems = Array.isArray(items) ? items : [];
  }

  /**
   * Start watching. `extraDirs` is the user's custom-folder list from
   * the cache (same format as `customFolders` in the app prefs).
   */
  start(extraDirs = []) {
    if (this._started) return;
    this._started = true;

    const dirsToWatch = [...STANDARD_DIRS, ...extraDirs.map((d) => {
      // customFolders entries may be objects { path } or bare strings
      return (typeof d === 'string') ? d : (d && d.path) ? d.path : null;
    }).filter(Boolean)];

    for (const dir of dirsToWatch) {
      this._watchDir(dir);
    }
  }

  /** Stop all watchers and cancel pending timers. */
  stop() {
    for (const watcher of this._watchers.values()) {
      try { watcher.close(); } catch { /* tolerate */ }
    }
    this._watchers.clear();

    for (const t of this._debounceMap.values()) clearTimeout(t);
    this._debounceMap.clear();

    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }
    this._batchPending = [];
    this._started = false;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  _watchDir(dir) {
    // Access check — do this async so the constructor doesn't block.
    fs.access(dir, fs.constants.R_OK, (accessErr) => {
      if (accessErr) {
        if ((accessErr.code === 'EACCES' || accessErr.code === 'EPERM') && !this._fdaNotified) {
          this._fdaNotified = true;
          this._onFdaRequired();
        }
        // Directory doesn't exist or isn't accessible → skip silently.
        return;
      }

      // Don't double-watch the same directory (can happen if custom
      // folders overlap with standard dirs).
      if (this._watchers.has(dir)) return;

      try {
        const watcher = fs.watch(dir, { recursive: false, persistent: false }, (eventType, filename) => {
          if (!filename) return;
          // Only fire for bundle extensions at the top level of this dir.
          const ext = path.extname(filename).toLowerCase();
          if (!BUNDLE_EXTS.has(ext)) return;
          const bundlePath = path.join(dir, filename);
          this._scheduleCheck(bundlePath);
        });

        watcher.on('error', (err) => {
          if ((err.code === 'EACCES' || err.code === 'EPERM') && !this._fdaNotified) {
            this._fdaNotified = true;
            this._onFdaRequired();
          }
          try { watcher.close(); } catch { /* tolerate */ }
          this._watchers.delete(dir);
        });

        this._watchers.set(dir, watcher);
      } catch (err) {
        // fs.watch can throw synchronously for nonexistent paths.
        // Safe to ignore — we just won't watch that directory.
        console.warn('[plugin-watcher] could not watch:', dir, err.message);
      }
    });
  }

  _scheduleCheck(bundlePath) {
    // Reset the per-bundle debounce on every incoming event.
    if (this._debounceMap.has(bundlePath)) {
      clearTimeout(this._debounceMap.get(bundlePath));
    }
    const t = setTimeout(() => {
      this._debounceMap.delete(bundlePath);
      this._enqueue(bundlePath);
    }, 2500);
    this._debounceMap.set(bundlePath, t);
  }

  _enqueue(bundlePath) {
    // Find items that live inside this bundle path (before the plist read
    // so we can pass them to the batch processor synchronously).
    const knownItems = this._libraryItems.filter((item) => {
      if (!item || !item.path) return false;
      const ip = item.path;
      return ip === bundlePath ||
             ip.startsWith(bundlePath + '/') ||
             ip.startsWith(bundlePath + path.sep);
    });

    this._batchPending.push({ bundlePath, knownItems });

    // Open a short batch window: if more bundles arrive within 500 ms
    // (common when an installer updates a suite of plugins) they join
    // the same batch and produce a single notification.
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        const batch = this._batchPending.splice(0);
        this._processBatch(batch);
      }, 500);
    }
  }

  async _processBatch(batch) {
    const updatedItems = [];
    const newPlugins   = [];

    await Promise.all(batch.map(async ({ bundlePath, knownItems }) => {
      // Verify the bundle still exists (deletion events look the same
      // as addition events from fs.watch's perspective on macOS).
      try { await fsp.access(bundlePath, fs.constants.R_OK); }
      catch { return; }   // bundle gone or inaccessible — skip

      const newVersion = await readBundleVersion(bundlePath);
      if (!newVersion) return;

      if (knownItems.length === 0) {
        // Brand-new plugin the library hasn't seen yet.
        newPlugins.push(bundlePath);
        return;
      }

      for (const item of knownItems) {
        // Only update if the version actually changed — avoids noisy
        // notifications when an installer merely touches a bundle's
        // timestamp without changing its contents.
        if (item.version === newVersion) continue;
        updatedItems.push({ ...item, version: newVersion });
      }
    }));

    if (updatedItems.length > 0 || newPlugins.length > 0) {
      this._onChanged(updatedItems, { newPlugins });
    }
  }
}

module.exports = { PluginWatcher };
