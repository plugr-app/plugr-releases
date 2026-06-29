// Support + bug report configuration.
//
// ──────────────────────────────────────────────────────────────────────
// SETUP (one-time, ~10 minutes)
// ──────────────────────────────────────────────────────────────────────
//
// 1. SUPPORT_URL — Where the "Visit support site" button takes the user.
//    Set to your support page once it exists. Until then, falls back to
//    the GitHub repo / a holding page. No user impact while null beyond
//    the button being disabled.
//
// 2. BUG_REPORT_URL — Google Form submission endpoint (POST). Create a
//    form with these fields, in this order:
//       - Title              (Short answer, REQUIRED)
//       - Description        (Paragraph, REQUIRED)
//       - Steps to reproduce (Paragraph, optional)
//       - Email              (Short answer, optional)
//       - App version        (Short answer)   ← auto-filled by Plugr
//       - OS version         (Short answer)   ← auto-filled
//       - Plugin count       (Short answer)   ← auto-filled
//       - Project count      (Short answer)   ← auto-filled
//
//    Then in the form: ... menu → "Get pre-filled link" → fill the
//    fields → "Get link" → copy. The URL contains entry.NNNNN values
//    for each field. Paste those numbers into BUG_REPORT_FIELDS below
//    and change the URL's '/viewform' to '/formResponse'.
//
// ──────────────────────────────────────────────────────────────────────
// PRIVACY
// ──────────────────────────────────────────────────────────────────────
//
// Bug reports send only what the user enters PLUS anonymous diagnostic
// counts: app version, OS version, total plugins scanned, total
// projects scanned. No plugin names, no file paths, no developer info,
// no user identifiers beyond email (which is optional and only used
// for follow-up).

// External site URL — null disables the "Visit support site" button.
// Set this to your support page once it exists.
const SUPPORT_URL = 'https://plugr.co/support/';

// Bug report form endpoint. Submit URL ends in /formResponse (not
// /viewform). Set to null to disable the bug report flow.
const BUG_REPORT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeY-KgaRbcHC77L8s9wBHJsZKpkqVuXf0jALkiQlACfh3Ck5A/formResponse';

// Google Form field IDs. Filled in after you create the form. Each
// value should be the string "entry.NNNNNNNN" from the pre-filled link.
const BUG_REPORT_FIELDS = {
  title:            'entry.909543709',
  description:      'entry.908727257',
  stepsToReproduce: 'entry.742252384',
  email:            'entry.619335219',
  appVersion:       'entry.303492445',
  osVersion:        'entry.46391088',
  pluginCount:      'entry.476012164',
  projectCount:     'entry.749022637',
};

const FETCH_TIMEOUT_MS = 8000;
const UA = 'Plugr/0.1 (bug-report)';

function supportUrl() { return SUPPORT_URL; }
function isBugReportConfigured() {
  return Boolean(BUG_REPORT_URL) && BUG_REPORT_FIELDS.title && BUG_REPORT_FIELDS.description;
}

async function submitBugReport(report) {
  if (!BUG_REPORT_URL || !isBugReportConfigured()) {
    return { ok: false, error: 'Bug report endpoint not configured (see electron/lib/supportConfig.cjs).' };
  }

  const params = new URLSearchParams();
  for (const [key, fieldId] of Object.entries(BUG_REPORT_FIELDS)) {
    if (!fieldId) continue;
    const value = report[key];
    if (value !== undefined && value !== null && value !== '') {
      params.set(fieldId, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(BUG_REPORT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: params.toString(),
    });
    // Google Forms returns 200 on success; some setups redirect (302).
    return { ok: res.ok || (res.status >= 200 && res.status < 400) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SUPPORT_URL,
  BUG_REPORT_URL,
  supportUrl,
  isBugReportConfigured,
  submitBugReport,
};
