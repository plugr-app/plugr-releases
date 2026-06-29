// electron/lib/dealAlerts.cjs
//
// Deal alerts — user-defined watches that fire macOS notifications when
// a matching deal appears in the next deal fetch. Three alert types:
//
//   - 'plugin'    — watch by plugin identifier or label (e.g. "Melodyne 5")
//   - 'developer' — watch by developer name (e.g. "Plugin Alliance")
//   - 'custom'    — match free-text keywords against deal titles + devs
//                   (e.g. ["soundtoys", "super plate"]) — every keyword
//                   must appear (AND semantics)
//
// State persists in cache.dealAlerts as an array:
//
//   {
//     id: 'alert_xxx',
//     type: 'plugin' | 'developer' | 'custom',
//     label: 'Melodyne 5',           // display name in UI
//     identifier: 'com.celemony.…',  // optional plugin id or developer name
//     keywords: ['soundtoys'],        // for 'custom' only
//     active: true,
//     createdAt: ISO,
//     lastNotifiedAt: ISO | null,    // for 24h re-notify suppression
//   }
//
// The matcher (findMatches) is intentionally tolerant — normalizes both
// sides to lowercase alphanumeric+space before comparing — so a user
// who types "Melodyne 5" still matches a deal titled "Melodyne 5 Studio
// Edition - 40% off". Strict identifier matching kicks in first when
// the identifier is set, which keeps community-feed accuracy.

const crypto = require('crypto');

function newId() {
  return 'alert_' + crypto.randomBytes(6).toString('hex');
}

// Normalize for matching: lowercase, strip non-alphanumeric, collapse spaces.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function listAlerts(cache) {
  if (!cache || !Array.isArray(cache.dealAlerts)) return [];
  return cache.dealAlerts;
}

function addAlert(cache, alert) {
  if (!cache.dealAlerts) cache.dealAlerts = [];
  const entry = {
    id: newId(),
    type: alert.type || 'custom',
    label: alert.label || '(unnamed alert)',
    identifier: alert.identifier || null,
    keywords: Array.isArray(alert.keywords) ? alert.keywords : null,
    active: alert.active !== false,
    createdAt: new Date().toISOString(),
    lastNotifiedAt: null,
  };
  cache.dealAlerts.push(entry);
  return entry;
}

function removeAlert(cache, id) {
  if (!Array.isArray(cache.dealAlerts)) return false;
  const i = cache.dealAlerts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  cache.dealAlerts.splice(i, 1);
  return true;
}

function updateAlert(cache, id, patch) {
  const a = (cache.dealAlerts || []).find((x) => x.id === id);
  if (!a) return null;
  if (patch.label !== undefined) a.label = patch.label;
  if (patch.active !== undefined) a.active = !!patch.active;
  if (patch.keywords !== undefined) a.keywords = patch.keywords;
  if (patch.identifier !== undefined) a.identifier = patch.identifier;
  return a;
}

// Does a single alert match a single deal? Tolerant matching — strict
// identifier first, then label/keyword substring against normalized
// title + developer.
function alertMatchesDeal(alert, deal) {
  if (!alert || !alert.active || !deal) return false;
  const title = normalize(deal.title);
  const dev = normalize(deal.developer);
  const id = normalize(deal.identifier);
  const hay = (title + ' ' + dev + ' ' + id).trim();

  switch (alert.type) {
    case 'plugin': {
      if (alert.identifier && normalize(alert.identifier) === id) return true;
      const label = normalize(alert.label);
      return !!label && hay.includes(label);
    }
    case 'developer': {
      const target = normalize(alert.identifier || alert.label);
      if (!target) return false;
      // Either the deal's dev contains the target or vice versa
      return dev.includes(target) || target.includes(dev);
    }
    case 'custom': {
      const kw = (alert.keywords || []).map(normalize).filter(Boolean);
      if (kw.length === 0) return false;
      return kw.every((k) => hay.includes(k));
    }
    default:
      return false;
  }
}

// Returns matched (alert, deal) pairs across all active alerts and
// a batch of deals. Callers decide which to surface (e.g., filter by
// lastNotifiedAt to suppress 24h-old re-notifications).
function findMatches(alerts, deals) {
  if (!Array.isArray(alerts) || !Array.isArray(deals)) return [];
  const matches = [];
  for (const alert of alerts) {
    if (!alert.active) continue;
    for (const deal of deals) {
      if (alertMatchesDeal(alert, deal)) {
        matches.push({ alertId: alert.id, alert, deal });
      }
    }
  }
  return matches;
}

// Stamp an alert as "notified now" so the matcher's next run can
// suppress immediate re-notification. Doesn't suppress matching
// itself — that's still useful for UI badges.
function markNotified(cache, alertId, now = new Date()) {
  const a = (cache.dealAlerts || []).find((x) => x.id === alertId);
  if (!a) return;
  a.lastNotifiedAt = now.toISOString();
}

// Helper for the caller to decide if an alert is fresh enough to
// re-notify. Default suppress window: 24h.
function shouldNotify(alert, windowMs = 24 * 60 * 60 * 1000) {
  if (!alert || !alert.lastNotifiedAt) return true;
  const elapsed = Date.now() - new Date(alert.lastNotifiedAt).getTime();
  return elapsed > windowMs;
}

module.exports = {
  listAlerts,
  addAlert,
  removeAlert,
  updateAlert,
  findMatches,
  alertMatchesDeal,
  markNotified,
  shouldNotify,
  normalize,
};
