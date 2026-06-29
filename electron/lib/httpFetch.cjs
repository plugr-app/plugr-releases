// Shared HTTP helper for update-source discovery + checking.
//
// Why this exists: vendor sites (Korg Zendesk, Cloudflare-protected
// pages, etc.) bot-detect at multiple layers — User-Agent, header
// set, TLS fingerprint, HTTP/2 behaviors. Faking a Safari UA with
// Node.js fetch() gets us past the easy checks but not the deeper
// ones (TLS JA3 fingerprint, ALPN negotiation, etc.). Electron's
// `net.request` goes through Chromium's actual HTTP stack — same as
// a real browser tab — and passes every layer of detection.
//
// Falls back to global fetch() for unit tests where Electron isn't
// available.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const STANDARD_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

let _electronNet = null;
function getElectronNet() {
  if (_electronNet !== null) return _electronNet;
  try {
    const { net, app } = require('electron');
    // app.isReady() must be true before net.request works. In main.cjs
    // we wait for app.whenReady() before any update flows fire, so this
    // is safe.
    if (net && net.request && app && app.isReady()) {
      _electronNet = net;
      return _electronNet;
    }
  } catch { /* not running inside Electron */ }
  _electronNet = false;
  return false;
}

/**
 * Fetch a URL and return a { status, ok, text, headers } object.
 * Prefers Electron net.request (Chromium-backed) when available.
 * Falls back to global fetch.
 *
 * @param {string} url
 * @param {object} options { timeoutMs, headers, redirect }
 * @returns {Promise<{ status: number, ok: boolean, text: () => Promise<string>, headers: object }>}
 */
async function httpGet(url, { timeoutMs = 15000, headers = {}, redirect = 'follow' } = {}) {
  const mergedHeaders = { ...STANDARD_HEADERS, ...headers };
  const net = getElectronNet();
  if (net) {
    return new Promise((resolve, reject) => {
      const req = net.request({
        url,
        redirect,
        useSessionCookies: false,
      });
      for (const [k, v] of Object.entries(mergedHeaders)) {
        req.setHeader(k, v);
      }
      const timer = setTimeout(() => {
        try { req.abort(); } catch { /* ignore */ }
        reject(new Error('Request timed out'));
      }, timeoutMs);
      req.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            headers: response.headers,
            text: async () => buf.toString('utf8'),
          });
        });
        response.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.end();
    });
  }
  // Fallback: global fetch (Node 18+ / tests)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: mergedHeaders,
      redirect,
    });
    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      text: async () => res.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}


// Tracking/referral params we strip from URLs before saving them as
// update sources. These never affect what content the server returns,
// so cleaning them keeps saved URLs canonical and shorter. Sources:
//   - Google search referrer: srsltid
//   - Google Analytics / Ads: utm_*, gclid, gad_source, gbraid, wbraid,
//                              _ga, _gl, dclid
//   - Facebook: fbclid
//   - Microsoft / Bing: msclkid
//   - Mailchimp: mc_eid, mc_cid
//   - HubSpot: hsCtaTracking, _hsenc, _hsmi
//   - Generic affiliate / campaign: ref, referrer, referer, aff,
//                                     affiliate, affid, aff_id,
//                                     campaign_id, cmpid, icid, cid
const TRACKING_PARAM_NAMES = new Set([
  'srsltid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name',
  'gclid', 'gad_source', 'gbraid', 'wbraid', 'dclid', '_ga', '_gl',
  'fbclid',
  'msclkid',
  'mc_eid', 'mc_cid',
  'hscta', 'hsctatracking', '_hsenc', '_hsmi', 'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad',
  'ref', 'referrer', 'referer',
  'aff', 'affiliate', 'affid', 'aff_id',
  'campaign_id', 'cmpid', 'icid', 'cid',
  'igshid',
  'yclid',                       // Yandex
  'ttclid',                      // TikTok
  'twclid',                      // Twitter / X
  'li_fat_id',                   // LinkedIn
  'ScCid',                       // Snapchat
  'epik', 'pp',                  // Pinterest
  'mkt_tok',                     // Marketo
  'mtm_source', 'mtm_medium',    // Matomo
  'mtm_campaign', 'mtm_keyword', 'mtm_content',
  'pk_source', 'pk_medium', 'pk_campaign', 'pk_kwd', 'pk_keyword',
  'pk_content',                  // Piwik
  'oly_anon_id', 'oly_enc_id',   // Omeda
  's_kwcid',                     // Adobe Analytics
]);

function cleanUrl(input) {
  if (!input || typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  let u;
  try { u = new URL(trimmed); }
  catch { return trimmed; }   // not a valid URL — return as-is

  // Strip lower-cased tracking params. Comparison is case-insensitive
  // since some servers use Title-Case (SrsLtId etc.).
  const toDelete = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_PARAM_NAMES.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  }
  for (const k of toDelete) u.searchParams.delete(k);

  // If the resulting URL has no query, drop the trailing "?" too.
  let out = u.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}


module.exports = { httpGet, UA, cleanUrl };
