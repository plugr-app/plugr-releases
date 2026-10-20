// renderFetch.cjs
//
// Loads a page in a real (hidden) Chromium window and returns its rendered
// text. This exists because httpFetch.cjs — which uses Electron's
// net.request and therefore has a genuine browser TLS/header fingerprint —
// still does NOT execute JavaScript. Two classes of page defeat it:
//
//   1. Bot checks (Cloudflare "managed challenge"). The server returns an
//      interstitial carrying __cf_chl_tk; a real browser runs its JS,
//      completes the token exchange and is issued a cf_clearance cookie.
//      A plain fetch only ever sees the interstitial.
//   2. JS-rendered pages (SPAs). The HTML is an empty shell and the real
//      content — including the version string — is built client-side.
//      A1AUDIO was the first of these we hit (see 2026-07-16 d).
//
// Electron already ships Chromium (it is what draws Plugr's window), so
// this adds no dependency — it just asks the renderer we already have to
// do the job.
//
// RULES (deliberate, do not relax without thinking):
//   - Opt-in per source (`render: true` in the registry) or used as a
//     one-shot retry when a normal fetch comes back blocked/empty. It is
//     never the default path: it costs a window and several seconds.
//   - Serialized — one window at a time. Memory, not speed, is the risk.
//   - Hard timeout. A page that will not settle is a failure, and a
//     failure must degrade to manual-check. NEVER guess a version.
//   - This is NOT a captcha solver. A managed challenge usually clears
//     itself; an interactive one ("click to verify") will not, and must
//     fail cleanly.

const { UA } = require('./httpFetch.cjs');

// Persisted so the cf_clearance cookie survives between checks and between
// app launches — the first visit pays the challenge cost, later ones don't.
const PARTITION = 'persist:plugr-render';
const DEFAULT_TIMEOUT_MS = 20000;
const SETTLE_MS = 1200;
const POLL_MS = 500;

// Markers that mean "this is a bot check, not the page".
const CHALLENGE_RE = /__cf_chl_tk|cf-browser-verification|cf_chl_opt|Just a moment\s*(?:\.\.\.|…)|Checking your browser|Enable JavaScript and cookies to continue|Attention Required!\s*\|\s*Cloudflare/i;

function getElectron() {
  try {
    // Lazy: this module is also loaded by tests and CLI tools running in
    // plain node, where there is no Electron at all.
    const e = require('electron');
    return e && e.BrowserWindow ? e : null;
  } catch {
    return null;
  }
}

function isAvailable() {
  return Boolean(getElectron());
}

/**
 * True when a fetched body looks like a bot check or an empty JS shell
 * rather than a real page. Used to decide whether a failed extraction is
 * worth retrying through a browser.
 */
function looksBlockedOrEmpty(body) {
  if (!body) return true;
  const raw = String(body);
  if (CHALLENGE_RE.test(raw)) return true;
  const visible = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A real version page always has more prose than this. An SPA shell and
  // a challenge page both land well under it.
  return visible.length < 200;
}

// One window at a time: a queue of promises rather than parallel windows.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of individual failures.
  chain = run.then(() => {}, () => {});
  return run;
}

async function renderOnce(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const electron = getElectron();
  if (!electron) throw new Error('render-unavailable');
  const { BrowserWindow } = electron;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      javascript: true,
      images: false,          // nothing we read is an image; saves time
      webgl: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const deadline = Date.now() + timeoutMs;
  try {
    win.webContents.setUserAgent(UA);
    await win.loadURL(url);

    // Give the page a moment to run its scripts, then keep polling while it
    // still looks like a challenge — Cloudflare reloads itself once solved.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    let text = '';
    for (;;) {
      text = await win.webContents.executeJavaScript(
        'document && document.body ? document.body.innerText : ""',
        true,
      );
      if (!CHALLENGE_RE.test(String(text || '')) && String(text || '').trim().length >= 200) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    const out = String(text || '');
    if (CHALLENGE_RE.test(out)) throw new Error('render-challenge-unsolved');
    if (!out.trim()) throw new Error('render-empty');
    return out;
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
}

/** Queued entry point. Returns the page's rendered innerText. */
function renderText(url, opts) {
  return serialize(() => renderOnce(url, opts));
}

module.exports = { renderText, looksBlockedOrEmpty, isAvailable, CHALLENGE_RE };
