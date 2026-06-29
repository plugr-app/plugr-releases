// Entitlements layer — merges trial state + license state into a single
// authoritative "what can the user do right now" snapshot. Every paid
// feature checks against this, never against trial.cjs or license.cjs
// directly.
//
// Statuses (snapshot.status):
//   - 'trial'          — within the 14-day trial window, no key entered
//   - 'trial-expired'  — past 14 days, no key (most things locked,
//                        Deals + library/projects read-only still open)
//   - 'licensed'       — valid license, fully unlocked
//   - 'grace'          — license exists but couldn't be re-validated;
//                        within the 30-day offline window, still unlocked
//   - 'grace-exceeded' — same as trial-expired (validation failed for
//                        too long; user should reconnect or renew)
//
// Feature flags (snapshot.features):
//   Every paid feature has a key here. The renderer + main process both
//   read these to decide whether to allow an action or show a buy CTA.
//   Adding a new paid feature: add a key here, then call requires()
//   from the relevant IPC handler.
//
// Free for everyone (NEVER gated):
//   - Deals tab (affiliate revenue from non-converters)
//   - Read-only library + project views (so an expired user keeps the
//     app on their Dock and can convert later)
//   - Plugin update CHECKS (capped at 100 during trial, uncapped paid)
//   - Theme: dark / light / auto (8 DAW themes are paid)

const trial = require('./trial.cjs');
const license = require('./license.cjs');

// Lazy electron app import — used to detect dev mode for the
// entitlement bypass below. Wrapped in try so unit tests that import
// this file without an Electron context don't blow up.
let electronApp = null;
try { electronApp = require('electron').app; } catch { /* not in Electron */ }
function isDevMode() {
  // app.isPackaged is the canonical signal: true in a built .app / DMG,
  // false when running via `npm run dev` (Electron loads from source).
  // The PLUGR_FORCE_LICENSE_CHECK env var disables the bypass so we
  // can test real activation/validation against LemonSqueezy from
  // within `npm run dev` (otherwise the dev-mode shortcut returns
  // tier='dev' before the license module is ever consulted).
  if (process.env.PLUGR_FORCE_LICENSE_CHECK === '1') return false;
  return !!(electronApp && electronApp.isPackaged === false);
}

const TRIAL_UPDATE_CHECK_CAP = 100;

/**
 * Dev-mode entitlement snapshot — fully unlocked. Returned by snapshot()
 * when running unpackaged. Shape matches the real snapshot 1:1 so the
 * renderer can't tell the difference.
 */
function buildDevSnapshot() {
  return {
    status: 'licensed',
    isLicensed: true,
    inTrial: false,
    inTrialOrLicensed: true,
    trial: {
      hasStarted: true,
      daysRemaining: null,
      startedAt: null,
      expiresAt: null,
      isExpired: false,
      tampered: false,
    },
    license: {
      isLicensed: true,
      isInOfflineGrace: false,
      gracePeriodExceeded: false,
      tier: 'dev',
      key: null,
      expiresAt: null,
    },
    features: {
      bulkOperations: true,
      studioPalettes: true,
      icloudSync: true,
      backupRestore: true,
      csvExport: true,
      projectScan: true,
      libraryScan: true,
      updateChecks: true,
      updateChecksCap: null,
      trialUpdateChecksCap: null,
      pluginNotes: true,
      pluginTags: true,
      pluginFavorite: true,
      pluginHiddenToggle: true,
      pluginCategoryEdit: true,
      pluginDeveloperEdit: true,
      projectAnnotations: true,
      dealsTab: true,
      libraryReadOnly: true,
      projectReadOnly: true,
      themesBasic: true,
      toolsTab: true,
      __devBypass: true,
    },
  };
}

/**
 * Build the canonical entitlements snapshot. Cheap — no network calls,
 * just disk reads from the local trial + license files. Renderers
 * call this on mount and after every license change.
 */
async function snapshot(userDataDir) {
  // ─── DEV-MODE BYPASS ─────────────────────────────────────────────
  // When running unpackaged (npm run dev), unlock everything so we can
  // test paid features without going through a real activation. This
  // path is impossible to hit in a shipped build because electron-
  // builder always sets app.isPackaged = true on the resulting .app
  // bundle. So there's zero risk of leaking unlimited access to end
  // users. To temporarily REPRODUCE trial behavior during dev, comment
  // out this block.
  if (isDevMode()) {
    return buildDevSnapshot();
  }
  // ──────────────────────────────────────────────────────────────────

  const [trialState, lic] = await Promise.all([
    trial.getTrialState(userDataDir),
    license.getEntitlements(userDataDir),
  ]);

  let status;
  if (lic.isLicensed) {
    status = lic.isInOfflineGrace ? 'grace' : 'licensed';
  } else if (lic.gracePeriodExceeded) {
    status = 'grace-exceeded';
  } else if (!trialState.hasStarted) {
    // No trial started yet — caller should call trial.ensureStarted().
    // We treat "not started" as "trial" so the boot flow doesn't
    // momentarily show a locked-out state before we write the file.
    status = 'trial';
  } else if (trialState.isExpired) {
    status = 'trial-expired';
  } else {
    status = 'trial';
  }

  // Single source of truth for every paid-feature flag.
  const unlocked = status === 'licensed' || status === 'grace';
  const inTrial  = status === 'trial';
  const isPaidOrTrialing = unlocked || inTrial;

  const features = {
    // STRICTLY PAID (locked during trial too): bulk operations, the 8
    // studio palettes, iCloud sync, backup/restore, CSV export.
    bulkOperations:       unlocked,                    // bulk discover, bulk hide, bulk rename, bulk apply update source
    studioPalettes:       unlocked,                    // the 8 DAW-themed palettes (light/dark/auto stay free)
    icloudSync:           unlocked,
    backupRestore:        unlocked,                    // export/import all user data
    csvExport:            unlocked,

    // TRIAL-OR-PAID (free during trial, locked after expiry). The org-
    // editing features below were originally "always free" — moving
    // them here closes the "subscribe one month, organize forever"
    // loophole. Expired users still SEE all their existing tags /
    // notes / ratings / overrides; they just can't add or modify any.
    projectScan:          isPaidOrTrialing,            // scan new project folders
    libraryScan:          isPaidOrTrialing,            // rescan plugin library (read-only browse after expiry)
    updateChecks:         isPaidOrTrialing,
    updateChecksCap:      isPaidOrTrialing ? null : 0, // null = uncapped; 0 = locked; number = cap
    trialUpdateChecksCap: inTrial ? TRIAL_UPDATE_CHECK_CAP : null,
    pluginNotes:          isPaidOrTrialing,            // add / edit notes on plugins
    pluginTags:           isPaidOrTrialing,            // add / edit tags on plugins
    pluginFavorite:       isPaidOrTrialing,            // toggle favorites
    pluginHiddenToggle:   isPaidOrTrialing,            // hide / unhide
    pluginCategoryEdit:   isPaidOrTrialing,            // override auto-detected category
    pluginDeveloperEdit:  isPaidOrTrialing,            // override auto-detected developer
    projectAnnotations:   isPaidOrTrialing,            // tag / rate / status / note projects, plus key + bounce overrides
    tabVisibility:        isPaidOrTrialing,            // hide tabs you don't use from the TabBar; restore via the + button

    // ALWAYS-FREE features (listed for documentation; renderer should
    // also default-true if missing — see requires() below).
    dealsTab:             true,                        // never gate — affiliate revenue from non-converters
    libraryReadOnly:      true,                        // expired users keep browse access
    projectReadOnly:      true,
    themesBasic:          true,                        // dark/light/auto always free
    toolsTab:             true,                        // tap tempo, BPM↔delay, etc. always free
  };

  return {
    status,
    isLicensed: unlocked,
    inTrial,
    inTrialOrLicensed: isPaidOrTrialing,
    trial: {
      hasStarted:   trialState.hasStarted,
      daysRemaining: trialState.daysRemaining,
      startedAt:    trialState.startedAt,
      expiresAt:    trialState.expiresAt,
      isExpired:    trialState.isExpired,
      tampered:     !!trialState.tampered,
    },
    license: lic,
    features,
  };
}

/**
 * Quick check from inside an IPC handler — does the user have access
 * to this feature right now? Returns { ok: bool, reason: string }.
 *
 * Usage in main.cjs:
 *   const gate = await entitlements.requires(userDataDir, 'bulkOperations');
 *   if (!gate.ok) return { ok: false, error: 'locked', message: gate.reason };
 *
 * The renderer should also do its own check (to avoid roundtrips for
 * every paid feature). Both layers exist for defense in depth.
 */
async function requires(userDataDir, featureName) {
  const ent = await snapshot(userDataDir);
  // Always-free features default-true even if a future build forgets
  // to declare them — better to grant than wrongly lock out.
  const value = featureName in ent.features ? ent.features[featureName] : true;
  if (value === true) return { ok: true };
  return {
    ok: false,
    reason: ent.status === 'trial-expired' || ent.status === 'grace-exceeded'
      ? 'Your trial has ended. Subscribe or enter a license to unlock this.'
      : ent.status === 'grace'
        ? "We can't reach the licensing server. Reconnect to continue uninterrupted."
        : 'This feature requires a Plugr subscription.',
    snapshot: ent,
  };
}

module.exports = { snapshot, requires, TRIAL_UPDATE_CHECK_CAP };
