// Community contribution framework.
//
// ──────────────────────────────────────────────────────────────────────────
// SETUP NOTES (one-time, ~30 minutes total)
// ──────────────────────────────────────────────────────────────────────────
//
// 1. SUBMISSION ENDPOINT (where users send discoveries you'll review)
//
//    Easiest: a Google Form. Make a form with these fields:
//      - Plugin name         (Short answer)
//      - Developer           (Short answer)
//      - Identifier          (Short answer)
//      - Format              (Short answer)
//      - Update URL          (Short answer)
//      - Version regex       (Short answer)
//      - Detected version    (Short answer, optional)
//      - App version         (Short answer)
//
//    To find the submit URL:
//      View the form → click the three-dot menu → "Get pre-filled link"
//      → fill any fields → Get link → copy. The URL contains the form id.
//      Replace 'viewform' with 'formResponse' to get the submit URL.
//
//    To find each field's entry ID:
//      In the pre-filled link, each field appears as &entry.123456=value.
//      Copy each entry.NUMBER and paste below.
//
//    Alternatives: Tally.so, Formspree, Cloudflare Workers + KV.
//    All work; just send form-urlencoded POST data.
//
// 2. ADDITIONS FEED (where vetted submissions become available to all users)
//
//    Easiest: a public GitHub Pages site.
//      a. Create a public GitHub repo, e.g. "plugr-community-registry".
//      b. Add a single file: additions.json, with the schema below.
//      c. Settings → Pages → Branch: main, Folder: / (root) → Save.
//      d. After ~1 minute, your additions.json is served at
//         https://<your-username>.github.io/plugr-community-registry/additions.json
//
//    Periodically (weekly?), check Google Form responses, copy good entries
//    into additions.json, git push. Plugr clients will pick them up within
//    24 hours of you pushing.
//
//    Schema for additions.json:
//    {
//      "version": 2,
//      "lastUpdated": "2026-04-30T00:00:00Z",
//      "entries": [
//        // Plugin-level update sources. Match by CFBundleIdentifier.
//        {
//          "key": "com.example.foo",
//          "pluginName": "Foo",
//          "developer": "Example",
//          "updateUrl": "https://example.com/foo",
//          "versionRegex": "Foo v(\\d+\\.\\d+(?:\\.\\d+)?)"
//        }
//      ],
//      "companionAppPatches": [
//        // Companion-app overrides applied to the bundled developer
//        // registry at load time. Use these when a vendor renames their
//        // installer, ships a new bundle ID, or moves the app on disk.
//        // Plugr keeps the OLD name in `legacyNames` so installed copies
//        // can still be resolved via the icon fallback.
//        {
//          "developer": "Slate Digital",
//          "set": {
//            "companionApp": "Complete Access Hub",
//            "companionAppBundleId": "com.slatedigital.completeaccesshub",
//            "companionAppLegacyNames": ["Slate Digital Connect"]
//          }
//        },
//        // Add or correct an /Applications path:
//        {
//          "developer": "Plugin Alliance",
//          "set": { "companionAppPath": "/Applications/PA-InstallationManager.app" }
//        }
//      ]
//    }
//
// ──────────────────────────────────────────────────────────────────────────
// PRIVACY
// ──────────────────────────────────────────────────────────────────────────
//
// Plugr never sends user identifiers, file paths, install state, or anything
// about the user. Submissions contain only the static fields needed to make
// a registry entry: plugin name, developer, identifier, format, update URL,
// version regex, and the app version that produced the submission.
// ──────────────────────────────────────────────────────────────────────────

// Submission inbox — a Google Form whose pre-filled link gave us the
// field IDs below. Submissions POST to /formResponse (not /viewform).
const SUBMIT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScCtmbSBU5hKdrmPaql4j5RS10HIUIMykfkPJ6M4L0YDKPwCg/formResponse';

// Curated additions feed — a JSON file served from GitHub Pages. Plugr
// fetches this every 24h and merges each entry into the in-app
// registry so users get auto-detected updates for plugins others
// have already vetted.
const ADDITIONS_URL = 'https://plugr-app.github.io/plugr-community-registry/additions.json';

// Map from Plugr's internal field names → the Google Form's entry
// IDs. Pulled from the pre-filled link in form order; the order must
// match the order the fields were created in the form.
const SUBMIT_FIELDS = {
  pluginName:      'entry.99305535',
  developer:       'entry.450572045',
  identifier:      'entry.1414427659',
  format:          'entry.1132841437',
  updateUrl:       'entry.11649174',
  versionRegex:    'entry.1943901942',
  detectedVersion: 'entry.557445586',
  appVersion:      'entry.1853576775',
  // Separate download/product page (release-notes page ≠ download page).
  // Google Form "Download page" question, verified against the same form
  // id as SUBMIT_URL (1FAIpQLScCtmbSBU5hKdrmPaql4j5RS10HIUIMykfkPJ6M4L0YDKPwCg).
  downloadUrl:     'entry.1633676877',
};

const ADDITIONS_TTL_MS = 24 * 60 * 60 * 1000;     // 24 hours
const FETCH_TIMEOUT_MS = 8000;
const UA = 'Plugr/0.1 (community fetch)';

function isConfigured() {
  return Boolean(SUBMIT_URL) && Boolean(ADDITIONS_URL);
}

async function submitAddition(addition) {
  if (!SUBMIT_URL) {
    return { ok: false, error: 'Community submission URL not configured (see electron/lib/community.cjs)' };
  }

  // Build form-urlencoded body using the configured field IDs.
  const params = new URLSearchParams();
  for (const [key, formField] of Object.entries(SUBMIT_FIELDS)) {
    if (!formField) continue;
    const value = addition[key];
    if (value !== undefined && value !== null) params.set(formField, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SUBMIT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: params.toString(),
    });
    // Google Forms answers with 200 (or sometimes 302) on a successful submit.
    return { ok: res.ok || (res.status >= 200 && res.status < 400) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCommunityAdditions() {
  if (!ADDITIONS_URL) {
    return { ok: false, error: 'Community additions URL not configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ADDITIONS_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('Malformed community additions JSON');
    }
    // Normalize each entry; reject anything with an obviously bad regex so
    // we don't ship a broken pattern to users' machines.
    const safeEntries = [];
    for (const e of data.entries) {
      if (!e || typeof e !== 'object') continue;
      // updateUrl is mandatory; versionRegex is optional (a link-only
      // source for a page with no version number). Validate the regex
      // ONLY when one is present, so a bad pattern is still rejected but
      // a legitimately empty one is allowed through as manual-check.
      if (!e.key || !e.updateUrl) continue;
      if (e.versionRegex) { try { new RegExp(e.versionRegex); } catch { continue; } }
      safeEntries.push({
        key: String(e.key),
        pluginName: String(e.pluginName || ''),
        developer: String(e.developer || ''),
        updateUrl: String(e.updateUrl),
        versionRegex: e.versionRegex ? String(e.versionRegex) : '',
        downloadUrl: e.downloadUrl ? String(e.downloadUrl) : null,
      });
    }
    // Normalize companion-app patches. Each patch identifies a developer
    // (the registry key) and a `set` object holding any of:
    //   companionApp, companionAppBundleId, companionAppPath, companionAppLegacyNames
    // We reject anything that doesn't match the strict shape so a typo'd
    // entry can never wipe out a real registry field.
    const ALLOWED_FIELDS = new Set([
      'companionApp', 'companionAppBundleId', 'companionAppPath', 'companionAppLegacyNames',
    ]);
    const safePatches = [];
    const rawPatches = Array.isArray(data.companionAppPatches) ? data.companionAppPatches : [];
    for (const p of rawPatches) {
      if (!p || typeof p !== 'object') continue;
      if (!p.developer || typeof p.developer !== 'string') continue;
      if (!p.set || typeof p.set !== 'object') continue;
      const cleanSet = {};
      for (const [k, v] of Object.entries(p.set)) {
        if (!ALLOWED_FIELDS.has(k)) continue;
        if (k === 'companionAppLegacyNames') {
          if (!Array.isArray(v)) continue;
          cleanSet[k] = v.filter((s) => typeof s === 'string' && s.length > 0).map(String);
        } else {
          if (typeof v !== 'string' || v.length === 0) continue;
          cleanSet[k] = v;
        }
      }
      if (Object.keys(cleanSet).length === 0) continue;
      safePatches.push({ developer: p.developer, set: cleanSet });
    }
    return {
      ok: true,
      data: {
        version: data.version || 1,
        lastUpdated: data.lastUpdated || null,
        entries: safeEntries,
        companionAppPatches: safePatches,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}


// Apply companion-app patches to a developer-registry object in-place.
// `registry` is the parsed developerRegistry.json. `patches` is the
// safe-normalized array from fetchCommunityAdditions().
//
// Each patch's `set` object writes to the developer entry:
//   companionApp                 → entry.companionApp (string)
//   companionAppBundleId         → entry.companionAppBundleId (string)
//   companionAppPath             → entry.companionAppPath (string)
//   companionAppLegacyNames      → entry.companionAppLegacyNames (string[])
//
// If the developer key doesn't exist in the registry, the patch is
// skipped — patches can only correct entries Plugr already knows about.
// This keeps the community feed from injecting unknown developers
// (those still go through the curated Pull Request workflow).
function applyCompanionPatches(registry, patches) {
  if (!registry || !registry.developers || !Array.isArray(patches)) return 0;
  let applied = 0;
  for (const patch of patches) {
    const dev = registry.developers[patch.developer];
    if (!dev) continue;
    for (const [k, v] of Object.entries(patch.set)) {
      dev[k] = v;
    }
    applied += 1;
  }
  return applied;
}

// Persist the safe-normalized patches array to a file next to
// developerRegistry.json. registryLookup.loadRegistry() reads this on
// every cache invalidation and overlays it on top of the bundled
// registry — so corrections roll out without a Plugr update.
async function writePatchesToDisk(patches) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const file = path.join(__dirname, 'communityPatches.json');
  const payload = { writtenAt: new Date().toISOString(), patches: Array.isArray(patches) ? patches : [] };
  try {
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
    return { ok: true, count: payload.patches.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = {
  submitAddition,
  fetchCommunityAdditions,
  applyCompanionPatches,
  writePatchesToDisk,
  isConfigured,
  ADDITIONS_TTL_MS,
};
