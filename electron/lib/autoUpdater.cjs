// Auto-update wiring for the packaged Plugr build.
//
// Uses `electron-updater` against the GitHub Releases provider — every
// new DMG you push to a GitHub Release becomes an auto-update for every
// installed user within minutes.
//
// How it works at runtime:
//   1. On app launch we call init(). If we're in dev (not packaged) the
//      whole thing no-ops — we don't want a dev build pinging GitHub.
//   2. Five seconds after the window is up we ask GitHub for the latest
//      release. If there's a newer version, electron-updater downloads
//      the DMG in the background (no UI interruption).
//   3. When the download finishes, we tell the renderer via the
//      `updater:status` IPC channel. The renderer shows a toast with a
//      "Restart to install" button. Clicking it calls quitAndInstall().
//   4. We also re-check every 4 hours while the app stays open, so a
//      user who never quits still gets updates within a day.
//
// What the renderer needs to do:
//   - Listen for `updater:status` events from preload.
//   - When status === 'downloaded', show a "Restart to update" toast.
//   - Wire that toast's button to `window.pluginHub.installUpdate()`.
//
// GitHub Releases setup (one-time):
//   - Set GH_TOKEN or GITHUB_TOKEN in your build environment with a
//     personal access token that has `repo` scope.
//   - electron-builder will auto-detect the GitHub publish config from
//     `package.json` and upload `Plugr-<version>-arm64.dmg` plus the
//     `latest-mac.yml` manifest to each release. The manifest is what
//     electron-updater compares against on the client side.
//   - Tag the release `v0.1.0` (matching the version in package.json).
//     electron-builder reads the version from package.json and uses
//     that as the release tag.
//
// Why GitHub Releases vs S3:
//   - Free, generous bandwidth quota
//   - Stable URLs, signed by GitHub
//   - Public download stats out of the box
//   - One-line config in package.json — no separate hosting to manage

const { app, BrowserWindow } = require('electron');

let autoUpdater = null;       // resolved at init time (electron-updater is an optional dep)
let currentStatus = 'idle';
let lastEventDetail = null;
let listeners = new Set();

function broadcastToRenderer(status, detail = null) {
  currentStatus = status;
  lastEventDetail = detail;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:status', { status, detail, ts: Date.now() });
    }
  }
  for (const fn of listeners) {
    try { fn({ status, detail }); } catch { /* tolerate */ }
  }
}

/**
 * Wire up auto-updates. Safe to call multiple times (idempotent).
 * No-ops in dev mode or when electron-updater isn't installed.
 */
function init({ checkOnStartDelayMs = 5000, checkIntervalMs = 4 * 60 * 60 * 1000 } = {}) {
  if (autoUpdater) return autoUpdater;   // already initialized
  if (!app.isPackaged) {
    broadcastToRenderer('disabled-in-dev');
    return null;
  }
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    // electron-updater isn't installed. Log a hint but don't crash —
    // older builds before we added it should still launch.
    console.warn('[auto-update] electron-updater missing; auto-updates disabled. Run: npm install electron-updater');
    broadcastToRenderer('unavailable', { reason: 'electron-updater not installed' });
    return null;
  }

  // Don't auto-download until we've told the renderer the user can
  // expect a "Restart to update" toast. (Defaults are fine for now —
  // electron-updater auto-downloads as soon as it finds a new version.)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // install pending updates when the user quits anyway

  // Hook up every event electron-updater emits so the renderer can
  // render reasonable UI for each phase.
  autoUpdater.on('checking-for-update',  () => broadcastToRenderer('checking'));
  autoUpdater.on('update-available',     (info) => broadcastToRenderer('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', (info) => broadcastToRenderer('up-to-date', { version: info && info.version }));
  autoUpdater.on('error', (err) => {
    // Log the full error to Console.app for debugging.
    // Open Console.app and filter for "[auto-update]" to find these entries.
    console.error('[auto-update] error:', err);
    try {
      // Dump every useful diagnostic property — electron-updater sometimes
      // buries the real cause in code/statusCode rather than message.
      const diag = {
        message:    err && err.message,
        code:       err && err.code,         // e.g. ENOTFOUND, ECONNREFUSED
        statusCode: err && err.statusCode,   // HTTP status from the download request
        url:        err && err.url,          // which URL triggered the error
        stack:      err && err.stack,
        extra: (() => {
          const out = {};
          const skip = new Set(['message', 'code', 'statusCode', 'url', 'stack']);
          for (const k of Object.getOwnPropertyNames(err || {})) {
            if (!skip.has(k)) {
              try { out[k] = String(err[k]); } catch { /* skip */ }
            }
          }
          return out;
        })(),
      };
      console.error('[auto-update] diagnostics:', JSON.stringify(diag, null, 2));
    } catch (_) { /* tolerate serialisation errors */ }

    let message = String(err && err.message || err);
    // electron-updater sets err.message to a JSON-serialised array of
    // download-file objects when the transfer itself fails (e.g. network
    // drop mid-download, SHA512 mismatch). That raw JSON is unreadable
    // as a toast — replace it with a plain sentence.
    if (message.trimStart().startsWith('[') || message.trimStart().startsWith('{')) {
      message = 'Download failed. Check your internet connection and try again.';
    }
    broadcastToRenderer('error', { message });
  });
  autoUpdater.on('download-progress', (p) => {
    broadcastToRenderer('downloading', {
      percent: Math.round((p && p.percent) || 0),
      transferred: (p && p.transferred) || 0,
      total: (p && p.total) || 0,
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    broadcastToRenderer('downloaded', { version: info && info.version });
  });

  // First check after a short delay so we don't compete with the
  // boot-time library scan + project scan for network bandwidth.
  setTimeout(() => {
    try { autoUpdater.checkForUpdates(); }
    catch (err) { console.warn('[auto-update] check failed', err.message); }
  }, checkOnStartDelayMs);

  // Periodic re-check for users who leave the app running for days.
  setInterval(() => {
    try { autoUpdater.checkForUpdates(); }
    catch { /* tolerate */ }
  }, checkIntervalMs);

  return autoUpdater;
}

/**
 * Manually trigger a check. Used by the "Check for updates" menu item
 * and a hidden Preferences button. Returns true if a check was issued.
 */
function checkNow() {
  if (!autoUpdater) return false;
  try {
    autoUpdater.checkForUpdates();
    return true;
  } catch (err) {
    console.warn('[auto-update] manual check failed', err.message);
    return false;
  }
}

/**
 * Restart and install the pending update. Called by the renderer when
 * the user clicks "Restart to update" on the toast.
 */
function quitAndInstall() {
  if (!autoUpdater) return false;
  try {
    autoUpdater.quitAndInstall();
    return true;
  } catch (err) {
    console.warn('[auto-update] quitAndInstall failed', err.message);
    return false;
  }
}

/** Last reported status, for renderer to fetch on mount. */
function getStatus() {
  return { status: currentStatus, detail: lastEventDetail };
}

/** Optional in-process listener (used by tests; renderer uses IPC). */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { init, checkNow, quitAndInstall, getStatus, subscribe };
