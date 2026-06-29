// License management for Plugr (LemonSqueezy integration).
//
// Architecture (per TODO.md monetization spec):
//   1. User buys via LemonSqueezy → receives license key by email,
//      format roughly `XXXXX-XXXXX-XXXXX-XXXXX` (LemonSqueezy default).
//   2. User pastes key into Preferences → License → "Activate".
//   3. We POST to LemonSqueezy's `/v1/licenses/activate` endpoint with
//      the key + an `instance_name` (we use the device fingerprint).
//      Response carries: tier (from product variant), expiry, seat
//      counter, instance ID.
//   4. We sign the response payload locally with HMAC + store at
//      `userData/license.json`. Subsequent app launches read this
//      locally without a network call.
//   5. Every 7 days we re-validate via `/v1/licenses/validate`. On
//      success, refresh the local token. On network failure, fall
//      into the 30-day offline grace window.
//   6. Beyond the grace window: enter "expired" mode (same UX as a
//      lapsed trial — read-only library + projects, deals still
//      open, paid features locked).
//
// Device fingerprint:
//   - SHA-256 of `IOPlatformUUID` (read via `ioreg`) concatenated with
//     hardware model name.
//   - Never sent in raw form. We always send the hash.
//
// Configuration:
//   - LEMONSQUEEZY_API_BASE: production endpoint
//   - PRODUCT_VARIANT_TO_TIER: maps LemonSqueezy variant IDs to our
//     tier strings. **YOU MUST FILL THIS IN** before going live, with
//     the variant IDs from your LemonSqueezy dashboard. The skeleton
//     here is annotated with the expected shape.
//
// Future hardening:
//   - Add a signed-public-key bundle so we can verify tokens without
//     hitting the network at all (Ed25519 from a key only the
//     processor knows). Out of scope for v1.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------- Configuration (fill in before production) ----------

const LEMONSQUEEZY_API_BASE = 'https://api.lemonsqueezy.com/v1';

// Map your LemonSqueezy product/variant IDs → Plugr tier.
// Find these in LemonSqueezy → Products → Variants → URL contains the
// variant ID. Until you fill these in, every successful activation
// returns the safe default tier 'monthly'.
const PRODUCT_VARIANT_TO_TIER = {
  '1851090': 'monthly',
  '1851103': 'annual',
  '1851105': 'lifetime',
};

// HMAC secret for signing the locally-cached license token. Same
// rationale as the trial-signing secret — defeats trivial JSON edits,
// not a determined attacker. Rotating this invalidates every cached
// license, so DON'T rotate it without writing a migration.
const TOKEN_SIGNING_SECRET = 'plugr-license-v1-rotate-only-with-migration';

const LICENSE_FILENAME = 'license.json';
const VALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const OFFLINE_GRACE_MS     = 30 * 24 * 60 * 60 * 1000;  // 30 days

// ---------- Device fingerprint ----------

let cachedFingerprint = null;

/**
 * Returns a stable device fingerprint hash for this Mac. Uses the
 * IOPlatformUUID + hardware model — both survive macOS reinstalls
 * tied to the same hardware, but change if you migrate to a new Mac
 * (which is what we want for seat counting).
 */
function getDeviceFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  let platformUUID = '';
  let hwModel = '';
  try {
    const ioreg = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 2000 });
    const m = ioreg.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (m) platformUUID = m[1];
  } catch { /* tolerate */ }
  try {
    hwModel = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch { /* tolerate */ }
  // If both reads failed (extremely unusual), fall back to hostname so
  // we at least produce a stable-ish value rather than 0-length input.
  if (!platformUUID && !hwModel) {
    try { hwModel = require('node:os').hostname(); } catch { /* tolerate */ }
  }
  cachedFingerprint = crypto.createHash('sha256')
    .update(platformUUID + '|' + hwModel)
    .digest('hex');
  return cachedFingerprint;
}

// ---------- Local token store ----------

function tokenFilePath(userDataDir) {
  return path.join(userDataDir, LICENSE_FILENAME);
}

function signToken(payload) {
  // Sign every field except `sig` itself so the verification step is
  // hash(payload-without-sig) === payload.sig.
  const { sig, ...rest } = payload;
  return crypto.createHmac('sha256', TOKEN_SIGNING_SECRET)
    .update(JSON.stringify(rest))
    .digest('hex');
}

function verifyToken(payload) {
  if (!payload || !payload.sig) return false;
  const expected = signToken(payload);
  return expected === payload.sig;
}

async function readToken(userDataDir) {
  try {
    const raw = await fs.readFile(tokenFilePath(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    if (!verifyToken(data)) return null;
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn('[license] failed to read token:', err.message);
    return null;
  }
}

async function writeToken(userDataDir, payload) {
  await fs.mkdir(userDataDir, { recursive: true });
  const signed = { ...payload, sig: signToken(payload) };
  await fs.writeFile(tokenFilePath(userDataDir), JSON.stringify(signed, null, 2), 'utf8');
  return signed;
}

async function deleteToken(userDataDir) {
  try { await fs.unlink(tokenFilePath(userDataDir)); return true; }
  catch (err) { if (err.code === 'ENOENT') return true; throw err; }
}

// ---------- LemonSqueezy API (uses Node's global fetch, Node 18+) ----------

async function lemonSqueezyPost(endpoint, body) {
  // LemonSqueezy's license endpoints accept form-encoded bodies (not
  // JSON). They live under `/v1/licenses/...`. No auth header required
  // for activate/validate/deactivate — the license key IS the auth.
  const url = `${LEMONSQUEEZY_API_BASE}${endpoint}`;
  const formBody = new URLSearchParams(body).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
    // 15s timeout — LemonSqueezy normally responds in <500ms but
    // we want a hard ceiling so the UI never sticks forever.
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- Public API ----------

/**
 * Try to activate a license key. Wires the result into local storage
 * and returns the entitlement shape the renderer cares about.
 *
 * Errors:
 *   - 'invalid'   — wrong/disabled key
 *   - 'seats'     — license is at its seat limit; user must deactivate
 *                   a previous device first via the customer portal
 *   - 'network'   — couldn't reach LemonSqueezy; try again later
 *   - 'unknown'   — anything else (with the raw status code attached)
 */
async function activate(userDataDir, licenseKey) {
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { ok: false, error: 'invalid', message: 'Enter your license key.' };
  }
  const fingerprint = getDeviceFingerprint();
  let res;
  try {
    res = await lemonSqueezyPost('/licenses/activate', {
      license_key: licenseKey.trim(),
      instance_name: `plugr:${fingerprint.slice(0, 16)}`,
    });
  } catch (err) {
    return { ok: false, error: 'network', message: 'Could not reach the licensing server. Check your internet and try again.' };
  }
  if (!res.ok || !res.data || res.data.activated === false) {
    const msg = res.data && (res.data.error || res.data.message);
    if (res.status === 404)        return { ok: false, error: 'invalid', message: 'That license key wasn’t recognized.' };
    if (msg && /seat/i.test(msg))  return { ok: false, error: 'seats',   message: 'This license has reached its device limit. Deactivate an older device first.' };
    if (msg && /invalid/i.test(msg))return { ok: false, error: 'invalid', message: msg };
    return { ok: false, error: 'unknown', message: msg || `Activation failed (HTTP ${res.status}).` };
  }
  // Successful activation. Build our local token.
  const ls = res.data;
  const variantId = ls.meta && ls.meta.variant_id != null ? String(ls.meta.variant_id) : null;
  const tier = (variantId && PRODUCT_VARIANT_TO_TIER[variantId]) || 'monthly';
  const expiresAt = ls.license_key && ls.license_key.expires_at;  // null for lifetime
  const token = {
    version:        1,
    licenseKey:     licenseKey.trim(),
    instanceId:     ls.instance && ls.instance.id,
    fingerprint,
    tier,
    variantId,
    activatedAt:    new Date().toISOString(),
    expiresAt:      expiresAt || null,
    lastValidated:  new Date().toISOString(),
    inOfflineGrace: false,
  };
  await writeToken(userDataDir, token);
  return { ok: true, entitlements: tokenToEntitlements(token) };
}

/**
 * Validate the cached license against LemonSqueezy. Called periodically
 * (every 7 days) and on demand from the Preferences "Refresh" button.
 *
 * On network failure, marks the token as `inOfflineGrace: true` (UI
 * shows a warning); if we've been in grace for more than 30 days,
 * downgrades to expired.
 */
async function validate(userDataDir) {
  const token = await readToken(userDataDir);
  if (!token) return { ok: false, error: 'no-license' };
  let res;
  try {
    res = await lemonSqueezyPost('/licenses/validate', { license_key: token.licenseKey });
  } catch (err) {
    return handleValidationNetworkFailure(userDataDir, token);
  }
  if (!res.ok || !res.data) return handleValidationNetworkFailure(userDataDir, token);
  if (res.data.valid === false) {
    // License was revoked or refunded — drop it and force re-entry.
    await deleteToken(userDataDir);
    return { ok: false, error: 'revoked' };
  }
  // Success — refresh the local token.
  const updated = {
    ...token,
    lastValidated:  new Date().toISOString(),
    inOfflineGrace: false,
  };
  await writeToken(userDataDir, updated);
  return { ok: true, entitlements: tokenToEntitlements(updated) };
}

async function handleValidationNetworkFailure(userDataDir, token) {
  const lastValidated = token.lastValidated ? new Date(token.lastValidated).getTime() : 0;
  const elapsed = Date.now() - lastValidated;
  if (elapsed > OFFLINE_GRACE_MS) {
    // Beyond grace — downgrade to expired. We keep the token on disk
    // so the renderer can show what license they HAD; the next
    // successful validate() will reinstate them.
    const expired = { ...token, inOfflineGrace: true, gracePeriodExceeded: true };
    await writeToken(userDataDir, expired);
    return { ok: false, error: 'expired-grace', entitlements: tokenToEntitlements(expired) };
  }
  const inGrace = { ...token, inOfflineGrace: true };
  await writeToken(userDataDir, inGrace);
  return { ok: false, error: 'offline-grace', entitlements: tokenToEntitlements(inGrace) };
}

/**
 * Deactivate this device's seat. Used when the user clicks "Sign out"
 * from the Preferences → License section. LemonSqueezy frees the seat
 * so they can activate on a different Mac.
 */
async function deactivate(userDataDir) {
  const token = await readToken(userDataDir);
  if (!token) return { ok: true };   // already gone
  try {
    await lemonSqueezyPost('/licenses/deactivate', {
      license_key:  token.licenseKey,
      instance_id:  token.instanceId,
    });
  } catch (err) {
    // We still drop the local token even if the remote call failed —
    // worst case, the user has to email support to free the seat,
    // but the local state matches what they asked for.
    console.warn('[license] remote deactivate failed:', err.message);
  }
  await deleteToken(userDataDir);
  return { ok: true };
}

/**
 * Returns the renderer-friendly entitlements snapshot. Always returns
 * a result — no license / expired / etc. are all explicit states.
 * The renderer keys all paid-feature gating off this.
 */
async function getEntitlements(userDataDir) {
  const token = await readToken(userDataDir);
  if (!token) return { tier: 'none', isLicensed: false, isInOfflineGrace: false };
  return tokenToEntitlements(token);
}

function tokenToEntitlements(token) {
  const now = Date.now();
  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  const isExpired = expiresAt != null && expiresAt < now;
  const isLicensed = !isExpired && !token.gracePeriodExceeded;
  return {
    tier:               token.tier,
    isLicensed,
    isInOfflineGrace:   !!token.inOfflineGrace,
    gracePeriodExceeded:!!token.gracePeriodExceeded,
    expiresAt:          token.expiresAt,
    activatedAt:        token.activatedAt,
    lastValidated:      token.lastValidated,
    licenseKeyMasked:   maskKey(token.licenseKey),
    seatFingerprint:    token.fingerprint,
  };
}

function maskKey(key) {
  if (!key || key.length < 8) return '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/** Start the background validation worker. Call once on app boot. */
function startBackgroundValidation(userDataDir) {
  // First validation 30 seconds after launch so we don't block boot.
  setTimeout(() => { validate(userDataDir).catch(() => {}); }, 30 * 1000);
  setInterval(() => { validate(userDataDir).catch(() => {}); }, VALIDATE_INTERVAL_MS);
}

module.exports = {
  activate,
  validate,
  deactivate,
  getEntitlements,
  getDeviceFingerprint,
  startBackgroundValidation,
};
