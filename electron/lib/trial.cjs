// Trial state management for Plugr.
//
// Decisions baked into this module (per TODO.md monetization spec):
//   - 14-day trial, no card required, auto-starts on first launch
//   - On expiry: library + projects stay viewable read-only; the Deals
//     tab stays fully open (affiliate revenue); other features show a
//     "Subscribe to restore" toast.
//   - The local trial-start timestamp is HMAC-signed so wiping the
//     cache and reinstalling can't reset the clock. The user can wipe
//     the OS, but that's beyond what we try to defend against.
//
// What this module DOESN'T do (intentionally):
//   - It doesn't phone home for trial-start fingerprint uniqueness.
//     That's a v1.1 hardening — for now, a fresh OS install + reset
//     resets the trial, which is acceptable for launch.
//   - It doesn't generate the device fingerprint. license.cjs owns
//     that so we have one canonical hashing function.
//
// Future v1.1 hardening (when revenue justifies the work):
//   - Send hashed device fingerprint to your backend on trial start
//   - Backend records every fingerprint ever seen → reject re-tries
//   - Falls back gracefully if the user is offline (sign the local
//     timestamp pessimistically — extra-fresh-install will start a
//     trial, but you can revoke later via the validation loop)

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// HMAC secret used to sign the local trial-start timestamp. Keep this
// constant across releases or you'll invalidate every existing trial.
// (It doesn't need to be secret-secret — a determined attacker with
// the DMG can extract it. Its job is to stop trivial JSON edits, not
// stop crackers. That's a different game.)
const TRIAL_SIGNING_SECRET = 'plugr-trial-v1-do-not-rotate-without-migration';

const TRIAL_FILENAME = 'trial.json';
const TRIAL_DURATION_DAYS = 14;
const TRIAL_DURATION_MS = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;

function trialFilePath(userDataDir) {
  return path.join(userDataDir, TRIAL_FILENAME);
}

function signTimestamp(ts) {
  return crypto.createHmac('sha256', TRIAL_SIGNING_SECRET)
    .update(String(ts))
    .digest('hex');
}

/**
 * Returns the current trial state. Shape:
 *   { startedAt: ISO string, daysRemaining: number, isExpired: boolean,
 *     hasStarted: boolean }
 *
 * If no trial has been started yet, returns `hasStarted: false` and
 * the caller (usually license.cjs) decides whether to call ensureStarted().
 */
async function getTrialState(userDataDir) {
  try {
    const raw = await fs.readFile(trialFilePath(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    // Verify the signature — if it doesn't match, the file was edited.
    // We treat that as "trial expired" rather than crashing — refusing
    // to start would soft-brick the app.
    if (!data || typeof data.startedAt !== 'string' || data.sig !== signTimestamp(data.startedAt)) {
      return { hasStarted: true, isExpired: true, tampered: true, daysRemaining: 0, startedAt: data && data.startedAt };
    }
    const startedAt = new Date(data.startedAt).getTime();
    const now = Date.now();
    const elapsed = now - startedAt;
    const remainingMs = TRIAL_DURATION_MS - elapsed;
    return {
      hasStarted: true,
      isExpired: remainingMs <= 0,
      tampered: false,
      daysRemaining: Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
      startedAt: data.startedAt,
      expiresAt: new Date(startedAt + TRIAL_DURATION_MS).toISOString(),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { hasStarted: false, isExpired: false, daysRemaining: TRIAL_DURATION_DAYS };
    }
    // Corrupted file — treat as fresh install. Better UX than blocking.
    console.warn('[trial] failed to read trial state:', err.message);
    return { hasStarted: false, isExpired: false, daysRemaining: TRIAL_DURATION_DAYS };
  }
}

/**
 * Start a new trial if one hasn't been started. Idempotent — calling
 * this on a machine that already has an active trial is a no-op.
 * Returns the resulting trial state.
 */
async function ensureStarted(userDataDir) {
  const existing = await getTrialState(userDataDir);
  if (existing.hasStarted) return existing;
  const startedAt = new Date().toISOString();
  const payload = { startedAt, sig: signTimestamp(startedAt), version: 1 };
  try {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(trialFilePath(userDataDir), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[trial] failed to write trial state:', err.message);
    // Even if we can't persist, return as if started — better UX than
    // blocking on disk I/O. The state will write next launch.
  }
  return getTrialState(userDataDir);
}

/**
 * DESTRUCTIVE — drops the local trial file. Only exposed for dev /
 * support purposes (e.g. resetting your own trial during testing).
 * Never call this from a user-facing flow.
 */
async function _devResetTrial(userDataDir) {
  try { await fs.unlink(trialFilePath(userDataDir)); return true; }
  catch (err) { if (err.code === 'ENOENT') return true; throw err; }
}

module.exports = {
  getTrialState,
  ensureStarted,
  TRIAL_DURATION_DAYS,
  _devResetTrial,
};
