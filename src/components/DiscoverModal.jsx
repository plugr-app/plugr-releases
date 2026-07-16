import React, { useEffect, useState } from 'react';
import { cleanUrl } from '../util/format.js';

// Discover-update-source flow.
//
// 1. We open the modal in 'searching' state and call api.discoverUpdate(item).
// 2. The result lands; either we have a suggestion (url + regex + version)
//    or we have a list of pages tried and a friendly explanation.
// 3. If we have a suggestion the user can edit URL/regex inline before saving.
// 4. Saving calls api.saveRegistryAddition(key, addition) and closes.

export default function DiscoverModal({
  item, onClose, onSaved, onRemoved, api, communityConsent, onSetCommunityConsent,
  siblingsForDeveloper, onTemplateSiblingsResult,
  // Edit mode: opened from the detail panel to edit an existing
  // user-added source. Skip auto-discover and jump straight to the
  // 'found' phase with the existing values prefilled.
  mode = 'discover',
  existingAddition = null,
}) {
  const isEditMode = mode === 'edit';
  // Default non-edit-mode opens to a chooser screen: user picks
  // "Search automatically" or "Enter manually". Edit mode jumps to
  // 'found' to show the existing saved source for tweaking.
  const [phase, setPhase] = useState(isEditMode ? 'found' : 'chooser');     // 'chooser' | 'searching' | 'found' | 'notfound' | 'manual' | 'saving' | 'saved' | 'sharing' | 'error'
  const [result, setResult] = useState(isEditMode ? {
    url: existingAddition && existingAddition.updateUrl ? cleanUrl(existingAddition.updateUrl) : null,
    versionRegex: existingAddition && existingAddition.versionRegex,
    latestVersion: null,
    message: 'Editing the source you added earlier.',
  } : null);
  const [error, setError] = useState(null);

  // Track whether the URL has been edited since the last discovery / load —
  // when true, "Re-test with this URL" is enabled so the user can re-derive
  // the regex against the page they actually want.
  const [url, setUrl] = useState(
    (isEditMode && existingAddition && existingAddition.updateUrl)
      ? cleanUrl(existingAddition.updateUrl)
      : ''
  );
  const [regex, setRegex] = useState((isEditMode && existingAddition && existingAddition.versionRegex) || '');
  // Optional separate download/product page. Left blank in the common case,
  // where the "Get update" button just uses the version-source URL above.
  // Set it only when the page Plugr reads the version from (e.g. a release-
  // notes page) is NOT where the user actually downloads the update.
  const [downloadUrl, setDownloadUrl] = useState((isEditMode && existingAddition && existingAddition.downloadUrl) || '');
  const [urlAtDiscovery, setUrlAtDiscovery] = useState((isEditMode && existingAddition && existingAddition.updateUrl) || '');
  const [reTestRunning, setReTestRunning] = useState(false);
  const [reTestError, setReTestError] = useState(null);

  // Corrected-version flow: the auto-discover sometimes latches onto the
  // wrong number on the page (a copyright year, a "macOS 10.13" system
  // requirement, etc.). Letting the user type the version they actually
  // see lets us re-derive the regex without making them write one.
  const [correctedVersion, setCorrectedVersion] = useState('');
  const [correctionRunning, setCorrectionRunning] = useState(false);
  const [correctionError, setCorrectionError] = useState(null);

  // Manual-entry "skip the regex" fields. In the manual phase, the user
  // types the version they currently see on the page; we fetch the page
  // and derive the regex for them. The advanced toggle lets power users
  // still enter a regex directly.
  const [manualVersion, setManualVersion] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualError, setManualError] = useState(null);

  // Manual-URL fallback: when guess-based discovery fails, the user can
  // paste the developer's actual website URL and we re-run discovery
  // against it.
  const [manualUrl, setManualUrl] = useState('');

  // 'unknown' → ask after save. 'allowed' → submit silently. 'denied' → never.
  const [showShareCard, setShowShareCard] = useState(false);
  const [shareThisOne, setShareThisOne] = useState(true);     // checkbox state inside the share card
  const [savedAddition, setSavedAddition] = useState(null);

  // Sibling-template prompt state. After a successful save, if there are
  // other plugins from the same developer that don't yet have a source,
  // we offer to try the same URL template against them.
  const [showSiblingCard, setShowSiblingCard] = useState(false);
  const [siblingRunning, setSiblingRunning] = useState(false);
  // True when the user's saved URL doesn't contain the plugin's name —
  // i.e. it's a shared developer page like Kilohearts' changelog rather
  // than a per-product page. In that case we offer a different prompt
  // that applies the EXACT SAME URL+regex to every sibling, no slug
  // substitution.
  const [sharedSourceMode, setSharedSourceMode] = useState(false);

  // Run discovery, optionally with a user-supplied homepage URL.
  async function runDiscover(manualHomepage) {
    setPhase('searching');
    try {
      const payload = manualHomepage ? { ...item, manualHomepage } : item;
      const r = await api.discoverUpdate(payload);
      if (!r.ok) throw new Error(r.error || 'Discover failed');
      setResult(r.data);
      if (r.data.url && r.data.versionRegex) {
        setUrl(r.data.url);
        setRegex(r.data.versionRegex);
        setUrlAtDiscovery(r.data.url);
        setPhase('found');
      } else {
        setPhase('notfound');
      }
    } catch (e) {
      setError(String(e && e.message || e));
      setPhase('error');
    }
  }

  // Re-test the user's edited URL: rerun discovery treating the new URL
  // as the canonical product page. Used when the auto-discover landed on
  // the wrong page (e.g. found "Invisible Limiter G3" when the user has
  // "Invisible Limiter G1"). The regex + detected version refresh to
  // reflect whatever's on the new page.
  async function reTestEditedUrl() {
    const u = url.trim();
    if (!u) return;
    setReTestError(null);
    setReTestRunning(true);
    try {
      // Pass the new URL as manualHomepage so the discoverer treats it as
      // the candidate page (it tries the homepage first).
      const r = await api.discoverUpdate({ ...item, manualHomepage: u });
      if (!r.ok) throw new Error(r.error || 'Re-test failed');
      if (r.data.url && r.data.versionRegex) {
        setResult(r.data);
        setUrl(r.data.url);
        setRegex(r.data.versionRegex);
        setUrlAtDiscovery(r.data.url);
      } else {
        setReTestError(
          (r.data && r.data.message) ||
          "Couldn't find a version on that page. Either pick a different URL, or switch to manual mode and tell Plugr the version you see."
        );
      }
    } catch (e) {
      setReTestError(String(e && e.message || e));
    }
    setReTestRunning(false);
  }

  // Re-derive the regex against the URL using the version the user typed,
  // not the version that auto-discover guessed. Used when discover landed
  // on a wrong-looking number (year, system requirement, price, etc.).
  async function reDeriveWithCorrectedVersion() {
    const u = url.trim();
    const v = correctedVersion.trim();
    if (!u || !v) return;
    setCorrectionError(null);
    setCorrectionRunning(true);
    try {
      const r = await api.deriveSourceFromVersion({ url: u, knownVersion: v, name: item.name });
      if (r && r.ok && r.data && r.data.versionRegex) {
        setRegex(r.data.versionRegex);
        setUrl(r.data.url || u);
        setUrlAtDiscovery(r.data.url || u);
        setResult({
          url: r.data.url || u,
          versionRegex: r.data.versionRegex,
          latestVersion: r.data.latestVersion || v,
          message: r.data.warning
            ? `Pattern updated with "${v}", but the page makes it hard to anchor — verify after Save.`
            : `Re-anchored on "${v}" — pattern verified against the page.`,
        });
        setCorrectedVersion('');     // hide the re-derive row; the new pattern is now the source of truth
      } else {
        setCorrectionError(
          (r && r.error) ||
          `Couldn't find "${v}" on that page. Either it's loaded by JavaScript, or it's not what's actually written there.`
        );
      }
    } catch (e) {
      setCorrectionError(String(e && e.message || e));
    }
    setCorrectionRunning(false);
  }

  useEffect(() => {
    // Auto-discover no longer kicks off on mount. The user makes the
    // first move from the chooser screen: "Search automatically" runs
    // the same discover flow, "Enter manually" jumps straight to the
    // manual entry form. Edit mode skips the chooser (we open straight
    // to 'found' to show the existing source).
    /* eslint-disable-next-line */
  }, [item.id]);

  // Core save: persist a registry addition and handle the follow-up
  // (community-share card, sibling-template offer, auto-close).
  // Shared by both the auto-discover "found" flow and the manual-entry flow.
  async function saveAddition({ urlToSave, regexToSave, addedBy, downloadUrlToSave }) {
    setPhase('saving');
    setError(null);
    const key = item.identifier || item.id;
    // Optional separate download page. Default: reuse the passed state so
    // every existing call site keeps its behavior; only persisted when the
    // user actually entered a distinct URL.
    const dl = (downloadUrlToSave !== undefined ? downloadUrlToSave : downloadUrl || '').trim();
    const addition = {
      updateUrl: cleanUrl(urlToSave.trim()),     // strip tracking junk
      versionRegex: regexToSave.trim(),
      downloadUrl: dl ? cleanUrl(dl) : null,     // null = "same as update page"
      addedAt: new Date().toISOString(),
      addedBy,
    };
    const res = await api.saveRegistryAddition(key, addition);
    if (!res.ok) {
      setError(res.error || 'Save failed');
      setPhase('error');
      return;
    }
    // Notify the parent so it can refresh state AND fire an immediate
    // single-shot update check for this plugin + cross-format siblings —
    // that's what moves the item out of "Unchecked" without the user
    // needing to click "Check for Updates" again.
    if (onSaved) onSaved(addition);
    setSavedAddition(addition);
    setPhase('saved');

    // Detect whether this URL is a per-product page (slug-template
    // derivable) or a shared developer page (Kilohearts-style). The
    // sibling prompt picks the right copy for whichever case applies.
    //
    // We try multiple slug normalizations because a vendor might use
    // any of them in the URL: strict ("multi-pass"), collapsed
    // ("multipass"), camelCase-split ("legacy-cell" for "LegacyCell"),
    // or the raw lowercase form. If NONE appear in the URL path, it's
    // a shared dev page.
    let isShared = false;
    try {
      const url = String(addition.updateUrl || '').toLowerCase();
      const rawName = String(item.name || '');
      const lowerName = rawName.toLowerCase();
      // Insert dashes before internal uppercase letters so camelCase
      // names like "LegacyCell" → "legacy-cell".
      const camelSplit = rawName
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();
      // Also try slugs WITHOUT the leading whitespace-separated word.
      // Many distributor vendors prepend a sub-brand prefix that
      // doesn't appear in URLs — Plugin Alliance has dozens of these
      // (Acme, ADPTR, BX, elysia, Knif, Maag, etc.) where "Acme
      // Opticom XLA-3" lives at /products/opticom-xla-3. Without
      // this, we'd wrongly classify every PA product as a shared page.
      const tokens = lowerName.split(/\s+/).filter(Boolean);
      const withoutFirstWord = tokens.length >= 2 ? tokens.slice(1).join(' ') : null;
      const withoutLastWord = tokens.length >= 2 ? tokens.slice(0, -1).join(' ') : null;
      // Insert a dash at each letter↔digit boundary in `slug`. Returns
      // up to 4 variants (no insert / left / right / both) for slugs
      // with 2 such boundaries. Matches the backend
      // enumerateBoundaryInsertions — without this, a name like
      // "Ampeg SVT3Pro" can't recognize the URL .../svt-3pro because
      // the dash between "svt" and "3pro" is at a letter-digit boundary
      // that the strict slug doesn't have.
      function withBoundaryInsertions(slug) {
        if (!slug || slug.length < 2) return [slug];
        const positions = [];
        for (let i = 1; i < slug.length; i++) {
          const prev = slug[i - 1];
          const cur = slug[i];
          if (prev === '-' || cur === '-') continue;
          const isBoundary = (/[a-z]/.test(prev) && /\d/.test(cur)) || (/\d/.test(prev) && /[a-z]/.test(cur));
          if (isBoundary) positions.push(i);
          if (positions.length >= 5) break;
        }
        if (positions.length === 0) return [slug];
        const out = new Set([slug]);
        const total = 1 << positions.length;
        for (let mask = 1; mask < total; mask++) {
          let result = '';
          for (let i = 0; i < slug.length; i++) {
            const posIdx = positions.indexOf(i);
            if (posIdx >= 0 && (mask & (1 << posIdx))) result += '-';
            result += slug[i];
          }
          out.add(result);
        }
        return [...out];
      }
      function toSlugForms(s) {
        if (!s) return [];
        const strict = s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const collapsed = s.replace(/[^a-z0-9]+/g, '');
        return [
          ...withBoundaryInsertions(strict),
          ...withBoundaryInsertions(collapsed),
          s,
        ];
      }
      const slugs = [
        lowerName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),    // strict
        lowerName.replace(/[^a-z0-9]+/g, ''),                              // collapsed
        lowerName,                                                         // raw lowercase
        camelSplit,                                                        // camelCase-split
        camelSplit.replace(/-/g, ''),                                      // camelCase-split collapsed
        ...toSlugForms(withoutFirstWord),                                  // "Acme Opticom XLA-3" → "opticom-xla-3"
        ...toSlugForms(withoutLastWord),                                   // less common but useful when last word is metadata
      ].filter((s) => s && s.length >= 2);
      // Slug-not-in-URL is the canonical signal of a shared dev page.
      // Earlier versions also tested for path keywords (changelog,
      // releases, downloads) but that was strictly more aggressive —
      // any vendor URL that happened to include those words in the
      // path (e.g. Arturia's "/downloads-manuals/product/<slug>") got
      // false-positived. Slug-absence catches the same shared-page
      // cases (Kilohearts changelog has no slug too) without false
      // positives on per-product URLs.
      const slugAppears = slugs.some((s) => url.includes(s));
      isShared = !slugAppears;
    } catch { /* default to per-product */ }
    setSharedSourceMode(isShared);

    // Two follow-up prompts can show: the community-share consent card
    // (first time only), and the sibling-template offer (whenever other
    // plugins from this dev still need a source). They're independent;
    // both can show at the same time, stacked.
    const hasSiblings = Array.isArray(siblingsForDeveloper) && siblingsForDeveloper.length > 0;
    if (hasSiblings) setShowSiblingCard(true);

    if (communityConsent === 'allowed') {
      submitToCommunity(addition);
    } else if (communityConsent === 'denied' || !api.submitToCommunity) {
      // skip
    } else {
      setShowShareCard(true);
    }

    // If neither card is showing, we can auto-close.
    if (!hasSiblings && communityConsent !== 'unknown') {
      setTimeout(onClose, 800);
    }
  }

  // "Found" auto-discover save: the URL+regex are already in state from
  // the discoverUpdate result; just hand them to saveAddition.
  async function save() {
    await saveAddition({ urlToSave: url, regexToSave: regex, addedBy: 'auto-discover' });
  }

  // "Save URL only" fallback: used when version derivation failed (page
  // is JS-rendered, version isn't in the static HTML, etc.) but the user
  // still wants to bookmark the URL so they can click through and check
  // by hand. We save URL with no versionRegex; the checker treats that
  // as 'manual-check' status — which surfaces the URL without claiming
  // a real version comparison.
  async function saveUrlOnly() {
    const u = url.trim();
    if (!u) {
      setManualError('Please paste a URL first.');
      return;
    }
    await saveAddition({ urlToSave: u, regexToSave: '', addedBy: 'manual-url-only', downloadUrlToSave: downloadUrl });
  }

  // Edit-mode escape hatch for the "right page, no version number" case
  // (e.g. a product page that never lists the current build, so any regex
  // just latches onto a bogus number). Keeps the URL as a clickable link
  // and clears the version pattern → the checker returns 'manual-check',
  // which surfaces the link with NO false "update available" claim. Any
  // separate download page the user set is preserved.
  async function keepAsLinkOnly() {
    const u = url.trim();
    if (!u) return;
    await saveAddition({ urlToSave: u, regexToSave: '', addedBy: 'edit-link-only', downloadUrlToSave: downloadUrl });
  }

  // Manual-entry save. Two paths:
  //   1. Default (simple): user provided URL + the version they see on
  //      the page. We call deriveSourceFromVersion to synthesize a regex,
  //      then save URL + derived regex.
  //   2. Advanced: user opened the Advanced disclosure and entered a
  //      regex directly. We trust them and save URL + their regex.
  async function saveManual() {
    setManualError(null);
    const u = url.trim();
    const v = manualVersion.trim();
    const r = regex.trim();

    if (!u) {
      setManualError('Please paste a URL first.');
      return;
    }

    // Advanced path: user provided a regex by hand. Use it directly.
    if (showAdvanced && r) {
      await saveAddition({ urlToSave: u, regexToSave: r, addedBy: 'manual-regex' });
      return;
    }

    if (!v) {
      setManualError(
        showAdvanced
          ? 'Either enter a regex in the Advanced field, or fill in the current version.'
          : 'Type the version number you see on that page (e.g., 1.15.3) so Plugr can locate it.'
      );
      return;
    }

    // Simple path: have Plugr derive the regex from the visible version.
    setPhase('saving');
    let derived;
    try {
      derived = await api.deriveSourceFromVersion({ url: u, knownVersion: v, name: item.name });
    } catch (e) {
      derived = { ok: false, error: String(e && e.message || e) };
    }
    if (!derived || !derived.ok) {
      setManualError(derived && derived.error ? derived.error : 'Could not analyze that page.');
      setPhase('manual');
      return;
    }
    await saveAddition({
      urlToSave: u,
      regexToSave: derived.data.versionRegex,
      addedBy: 'manual-from-version',
    });
  }

  async function runSiblingTemplate() {
    if (!savedAddition || !siblingsForDeveloper || siblingsForDeveloper.length === 0) return;
    setSiblingRunning(true);
    try {
      const res = await api.tryTemplateForSiblings({
        template: savedAddition.updateUrl,
        seedName: item.name,                 // needed by the worker to derive
                                              // a {slug} template from the URL
        siblings: siblingsForDeveloper,
      });
      onTemplateSiblingsResult && onTemplateSiblingsResult(res);
    } catch { /* result toast handles errors via fallback */ }
    setSiblingRunning(false);
    setShowSiblingCard(false);
    if (!showShareCard) onClose();
  }

  // Shared-developer-page flow. Saves the EXACT SAME URL+regex to every
  // sibling — no per-slug substitution. Used for vendors who ship one
  // changelog page that applies to every product (Kilohearts, etc.).
  async function runSharedSource() {
    console.log('[runSharedSource] start, siblings=', siblingsForDeveloper && siblingsForDeveloper.length);
    if (!savedAddition || !siblingsForDeveloper || siblingsForDeveloper.length === 0) {
      console.warn('[runSharedSource] skipped: no savedAddition or empty siblings');
      return;
    }
    setSiblingRunning(true);
    let succeeded = false;
    try {
      console.log('[runSharedSource] calling api.applySharedSource…');
      const res = await api.applySharedSource({
        addition: savedAddition,
        siblings: siblingsForDeveloper,
      });
      console.log('[runSharedSource] api returned:', res && res.ok, 'savedCount=', res && res.data && res.data.savedCount);
      // Reuse the same renderer-side handler as the per-slug flow —
      // both shapes return { mergedAdditions, ... } so the App.jsx
      // update + toast logic doesn't need to branch.
      if (onTemplateSiblingsResult && res && res.data) {
        // Normalize to look like a sibling-template result so the
        // existing toast/state-update path can consume it.
        const normalized = {
          ...res,
          data: {
            ...res.data,
            foundCount: res.data.savedCount,
            total: res.data.total,
          },
        };
        onTemplateSiblingsResult(normalized);
        succeeded = res.ok && (res.data.savedCount > 0);
      } else if (res && !res.ok) {
        console.warn('[runSharedSource] api error:', res && res.error);
      }
    } catch (e) {
      console.error('[runSharedSource] threw:', e && e.message);
    }
    setSiblingRunning(false);
    setShowSiblingCard(false);
    if (!showShareCard) onClose();
    if (!succeeded) {
      // Surface the failure to the user — silently failing was the bug.
      try {
        window.alert('Sharing the source with other plugins failed. Check the Terminal where you ran `npm run dev` for the [applySharedSource] log lines and paste them to Claude.');
      } catch { /* alerts disabled */ }
    }
  }
  function declineSiblingTemplate() {
    setShowSiblingCard(false);
    if (!showShareCard) onClose();
  }

  async function submitToCommunity(addition) {
    if (!api.submitToCommunity) return;
    try {
      await api.submitToCommunity({
        pluginName: item.name,
        developer: item.developer,
        identifier: item.identifier,
        format: item.format,
        updateUrl: addition.updateUrl,
        versionRegex: addition.versionRegex,
        downloadUrl: addition.downloadUrl || undefined,
        detectedVersion: result && result.latestVersion,
      });
    } catch { /* silent — community submit is best-effort */ }
  }

  // Remove the user-added source entirely. Passing a null addition tells
  // the IPC handler to delete the key. Only available in edit mode.
  async function removeSource() {
    if (!window.confirm(
      `Remove the update source you added for "${item.name}"?\n\n` +
      `Plugr will go back to using the bundled registry (or "no source" if there isn't one).`
    )) return;
    const key = item.identifier || item.id;
    setPhase('saving');
    try {
      const res = await api.saveRegistryAddition(key, null);
      if (!res.ok) {
        setError(res.error || 'Remove failed');
        setPhase('error');
        return;
      }
      // Use onRemoved (not onSaved) — removal is a different signal: the
      // parent needs to drop the addition from local state AND clear the
      // stale update result. onSaved only knows how to MERGE in a new
      // addition, which would silently do nothing here.
      if (onRemoved) onRemoved(key, item.id);
      onClose();
    } catch (e) {
      setError(String(e && e.message || e));
      setPhase('error');
    }
  }

  // True when the URL field differs from whatever URL was returned by the
  // last discovery (or loaded for edit). Drives the "Re-test with this URL"
  // button's enabled state.
  const urlIsEdited = url.trim() !== '' && url.trim() !== (urlAtDiscovery || '').trim();

  async function handleShareDecision(allow) {
    // Persist the decision. If "remember my choice" is unchecked the user
    // can revisit it later; for simplicity we always save the answer here.
    if (onSetCommunityConsent) {
      await onSetCommunityConsent(allow ? 'allowed' : 'denied');
    }
    if (allow && shareThisOne && savedAddition) {
      setPhase('sharing');
      await submitToCommunity(savedAddition);
    }
    onClose();
  }

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Find update source">
      <div className="discover-modal">
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <div className="discover-head">
          <div className={`detail-art cat-${(item.category || 'other').toLowerCase()}`}>
            <span className={`fmt-text fmt-${item.format.toLowerCase()}`}>{item.format}</span>
          </div>
          <div className="discover-head-text">
            <h2>Find update source</h2>
            <div className="muted">{item.name} · {item.developer}</div>
          </div>
        </div>

        {phase === 'chooser' && (
          <div className="discover-chooser">
            <div className="discover-chooser-title">How do you want to add this source?</div>
            <div className="discover-chooser-actions">
              <button
                type="button"
                className="discover-chooser-card"
                onClick={() => runDiscover()}
              >
                <div className="discover-chooser-card-title">🔎 Search automatically</div>
                <div className="discover-chooser-card-body">
                  Plugr visits {item.developer}'s website and looks for a public page that shows this plugin's name and current version. Best when you don't know which page to use.
                </div>
              </button>
              <button
                type="button"
                className="discover-chooser-card"
                onClick={() => setPhase('manual')}
              >
                <div className="discover-chooser-card-title">✏️ Enter manually</div>
                <div className="discover-chooser-card-body">
                  Paste the URL and current version yourself. Faster when you already know the right page, and the only option for vendors who hide their version behind a login or JavaScript-only widget.
                </div>
              </button>
            </div>
          </div>
        )}

        {phase === 'searching' && (
          <div className="discover-status searching">
            <div className="spinner" aria-hidden="true" />
            <div>
              <div className="discover-status-title">Searching the developer's website…</div>
              <div className="muted">Looking for a public page that shows this plugin's name and current version.</div>
            </div>
          </div>
        )}

        {phase === 'found' && result && (
          <>
            <div className="discover-status found">
              <span className="check" aria-hidden="true">{isEditMode ? '✎' : '✓'}</span>
              <div>
                <div className="discover-status-title">
                  {isEditMode
                    ? (item.registryAddedByUser ? 'Editing your saved source' : 'Editing the update source')
                    : 'Found a likely source'}
                </div>
                <div className="muted">{result.message}</div>
              </div>
            </div>
            <div className="discover-fields">
              <label>
                <span>Update page URL</span>
                <input className="dev-input" type="text" value={url} onChange={(e) => setUrl(e.target.value)}
                  onBlur={(e) => { const c = cleanUrl(e.target.value); if (c !== e.target.value) setUrl(c); }} />
                {/* When the user changes the URL — e.g. because auto-discover
                 *  landed on the wrong product page (G3 instead of G1) —
                 *  let them re-derive the regex / detected version against
                 *  the new URL. Without this, the saved regex stays
                 *  derived from the wrong page. */}
                {(urlIsEdited || reTestError) && (
                  <div className="discover-retest">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={reTestEditedUrl}
                      disabled={reTestRunning || !url.trim()}
                    >
                      {reTestRunning ? 'Re-testing…' : 'Re-test with this URL'}
                    </button>
                    <span className="muted micro">
                      Refreshes the regex and detected version using the URL above.
                    </span>
                  </div>
                )}
                {reTestError && (
                  <div className="muted micro" style={{ color: 'var(--warn, #d97706)', marginTop: 4 }}>
                    {reTestError}
                  </div>
                )}
              </label>
              <label>
                <span>Version pattern (regex)</span>
                <input className="dev-input mono" type="text" value={regex} onChange={(e) => setRegex(e.target.value)} />
                <div className="muted micro">The first capture group is treated as the version. Test it by clicking <em>Check for Updates</em> after saving.</div>
              </label>
              {result.latestVersion && (
                <div className="discover-detected">
                  Detected latest version: <code>v{result.latestVersion}</code>
                  {item.version && <> · you have <code>v{item.version}</code></>}
                </div>
              )}
              {/* "That's not the right version" correction row. The auto-
               *  discover sometimes locks onto the wrong number (a year,
               *  a system-requirement number, a price). The user can
               *  type the version they actually see on the page and we
               *  re-derive the regex against that — no manual regex
               *  editing required. */}
              <div className="discover-correct">
                <label className="discover-correct-label">
                  <span className="muted micro">Wrong version detected? Type the version you actually see:</span>
                  <div className="discover-correct-row">
                    <input
                      className="dev-input"
                      type="text"
                      placeholder="e.g., 5.4.1"
                      value={correctedVersion}
                      onChange={(e) => { setCorrectedVersion(e.target.value); if (correctionError) setCorrectionError(null); }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={reDeriveWithCorrectedVersion}
                      disabled={correctionRunning || !correctedVersion.trim() || !url.trim()}
                      title="Re-build the regex by locating this version on the page"
                    >
                      {correctionRunning ? 'Re-deriving…' : 'Use this version'}
                    </button>
                  </div>
                </label>
                {correctionError && (
                  <div className="muted micro" style={{ color: 'var(--warn, #d97706)', marginTop: 4 }}>
                    {correctionError}
                  </div>
                )}
              </div>

              {/* "No version on this page" escape hatch. For product pages
               *  that never print the current build, any pattern latches
               *  onto a bogus number. This keeps the page as a clickable
               *  link and stops version-checking entirely. */}
              <div className="discover-linkonly" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="linkish"
                  onClick={keepAsLinkOnly}
                  title="This page has no version number — keep it as a clickable link and stop trying to detect a version. Plugr will no longer claim an update for this plugin."
                >
                  This page has no version number — keep it as a link only
                </button>
              </div>

              {/* Optional separate download page. Blank in the common case;
               *  the "Get update" button then just uses the page above. Set
               *  it only when the version lives on one page (e.g. release
               *  notes) but the download lives on another. */}
              <label>
                <span>Download page <span className="muted">(optional)</span></span>
                <input
                  className="dev-input"
                  type="text"
                  placeholder="Leave blank to use the page above"
                  value={downloadUrl}
                  onChange={(e) => setDownloadUrl(e.target.value)}
                  onBlur={(e) => { const c = cleanUrl(e.target.value); if (c !== e.target.value) setDownloadUrl(c); }}
                />
                <div className="muted micro">Where the <em>Get update</em> button sends you, when that differs from the version page above.</div>
              </label>
            </div>
          </>
        )}

        {phase === 'notfound' && result && (
          <>
            <div className="discover-status notfound">
              <span className="warn" aria-hidden="true">!</span>
              <div>
                <div className="discover-status-title">Couldn't find a suitable page</div>
                <div className="muted">{result.message}</div>
                {result.tried && result.tried.length > 0 && (
                  <details className="discover-tried">
                    <summary>Pages tried ({result.tried.length})</summary>
                    <ul>{result.tried.map((u, i) => <li key={i}><code>{u}</code></li>)}</ul>
                  </details>
                )}
              </div>
            </div>

            {/* Manual URL fallback. Often the developer's real site is at
             *  a different domain than the guessed companyname.com — let
             *  the user paste it in. */}
            <div className="discover-fallback">
              <div className="discover-fallback-title">Know the developer's website?</div>
              <div className="discover-fallback-body muted">
                Plugr guessed at the developer's URL. If you know the real site
                (e.g. a developer hosts at <code>somedev.example.net</code>
                rather than <code>somedev.com</code>), paste it below and we'll
                try again against that.
              </div>
              <div className="discover-fallback-row">
                <input
                  className="dev-input"
                  type="url"
                  placeholder="https://example.com"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                />
                <button
                  className="btn primary"
                  onClick={() => manualUrl.trim() && runDiscover(manualUrl.trim())}
                  disabled={!manualUrl.trim()}
                >
                  Try this URL
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'manual' && (
          <>
            <div className="discover-status">
              <div>
                <div className="discover-status-title">Add an update source manually</div>
                <div className="muted">
                  Paste a public page that shows this plugin's version, then tell Plugr the
                  version number you see there. Plugr will figure out the rest. The page must
                  NOT require a login, and the version must be visible in the page itself
                  (not loaded by JavaScript after the page renders).
                </div>
              </div>
            </div>
            <div className="discover-fields">
              <label>
                <span>Update page URL</span>
                <input
                  className="dev-input"
                  type="url"
                  placeholder="https://developer.example.com/products/this-plugin"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); if (manualError) setManualError(null); }}
                  autoFocus
                />
              </label>
              <label>
                <span>Current version shown on that page</span>
                <input
                  className="dev-input"
                  type="text"
                  placeholder="e.g., 1.15.3"
                  value={manualVersion}
                  onChange={(e) => { setManualVersion(e.target.value); if (manualError) setManualError(null); }}
                />
                <div className="muted micro">
                  Open the link, copy whatever version number you see there, paste it here.
                  Plugr uses this to locate the version on the page and to remember where to look next time.
                </div>
              </label>

              <details
                className="discover-advanced"
                open={showAdvanced}
                onToggle={(e) => setShowAdvanced(e.currentTarget.open)}
              >
                <summary>Advanced: enter a regex by hand</summary>
                <label>
                  <span>Version pattern (regex)</span>
                  <input
                    className="dev-input mono"
                    type="text"
                    placeholder="Version\s+(\d+\.\d+(?:\.\d+)?)"
                    value={regex}
                    onChange={(e) => { setRegex(e.target.value); if (manualError) setManualError(null); }}
                  />
                  <div className="muted micro">
                    Optional. If you fill this in, it overrides the auto-derived pattern.
                    The first capture group becomes the version. Example pattern that matches
                    "Version 3.21": <code>Version\s+(\d+\.\d+(?:\.\d+)?)</code>.
                  </div>
                </label>
              </details>

              {manualError && (
                <div className="discover-status notfound" style={{ marginTop: 8 }}>
                  <span className="warn" aria-hidden="true">!</span>
                  <div>
                    <div>{manualError}</div>
                    {/* Last-resort: save just the URL so the user can at
                     *  least click through later to check manually. The
                     *  plugin moves out of "Unchecked" into "Check
                     *  manually" status.
                     *
                     *  Hidden when the plugin is already managed by a
                     *  companion app (Native Access, iZotope Product
                     *  Portal, etc.) — saving URL-only would drop the
                     *  Companion-app-only status in favor of
                     *  Check-manually, which is worse: the user loses
                     *  the "Open X" affordance AND signs up for manual
                     *  work the companion app was already doing.
                     *  Real version-detected sources (URL + regex)
                     *  remain available because they provide a precise
                     *  version comparison the companion app doesn't. */}
                    {url.trim() && !(item && item.registry && item.registry.companionApp) && (
                      <button
                        type="button"
                        className="btn"
                        style={{ marginTop: 8 }}
                        onClick={saveUrlOnly}
                        title="Save just the URL so you can click through and check the version yourself later"
                      >
                        Save URL only — I'll check manually
                      </button>
                    )}
                    {url.trim() && item && item.registry && item.registry.companionApp && (
                      <div className="muted micro" style={{ marginTop: 8 }}>
                        URL-only save is disabled here because this plugin is managed by{' '}
                        <strong>{(item.registry.companionApp.displayName || item.registry.companionApp.name)}</strong>.
                        Saving without a detected version would drop the Companion-app-only
                        status — and that companion is already doing the manual checking for
                        you. Try a different URL where the version is visible, or just keep
                        the companion-managed status.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {phase === 'saving' && <div className="discover-status searching"><div className="spinner" /> Saving…</div>}
        {phase === 'saved' && !showShareCard && <div className="discover-status found"><span className="check">✓</span> Saved!</div>}
        {phase === 'sharing' && <div className="discover-status searching"><div className="spinner" /> Sharing with community…</div>}
        {phase === 'error' && <div className="discover-status notfound"><span className="warn">!</span> {error}</div>}

        {showSiblingCard && siblingsForDeveloper && siblingsForDeveloper.length > 0 && !sharedSourceMode && (
          <div className="share-card">
            <div className="share-card-title">
              Try this URL pattern for {item.developer}'s other products?
            </div>
            <div className="share-card-body">
              {siblingsForDeveloper.length} other {siblingsForDeveloper.length === 1 ? 'item' : 'items'} from {item.developer} {siblingsForDeveloper.length === 1 ? 'has' : 'have'} no
              update source yet. Most developers use the same URL shape for
              every product, so the page you just gave us probably has
              siblings at predictable URLs. Plugr can try them automatically.
            </div>
            <div className="share-card-actions">
              <button className="btn ghost" onClick={declineSiblingTemplate} disabled={siblingRunning}>
                No thanks
              </button>
              <button className="btn primary" onClick={runSiblingTemplate} disabled={siblingRunning}>
                {siblingRunning ? 'Searching…' : `Try for ${siblingsForDeveloper.length} more`}
              </button>
            </div>
          </div>
        )}

        {showSiblingCard && siblingsForDeveloper && siblingsForDeveloper.length > 0 && sharedSourceMode && (
          <div className="share-card">
            <div className="share-card-title">
              Use this same page for all {item.developer} plugins?
            </div>
            <div className="share-card-body">
              This URL doesn't include "{item.name}" in its path, so it
              looks like a shared changelog/release page that applies to
              every {item.developer} product. {siblingsForDeveloper.length} other {siblingsForDeveloper.length === 1 ? 'item' : 'items'} from {item.developer} {siblingsForDeveloper.length === 1 ? 'has' : 'have'} no
              update source yet — Plugr can save the same URL and version
              pattern to all of them in one click.
            </div>
            <div className="share-card-actions">
              <button className="btn ghost" onClick={declineSiblingTemplate} disabled={siblingRunning}>
                No thanks
              </button>
              <button className="btn primary" onClick={runSharedSource} disabled={siblingRunning}>
                {siblingRunning ? 'Saving…' : `Apply to ${siblingsForDeveloper.length} more`}
              </button>
            </div>
          </div>
        )}

        {showShareCard && (
          <div className="share-card">
            <div className="share-card-title">Share this finding with other Plugr users?</div>
            <div className="share-card-body">
              When you teach Plugr where to find updates for a plugin, that knowledge can help everyone.
              If you opt in, Plugr sends only the static fields needed to make a registry entry — plugin
              name, developer, identifier, update URL, and version pattern. <strong>Never your name, file
              paths, library contents, or any other data.</strong>
            </div>
            <label className="share-card-this">
              <input
                type="checkbox"
                checked={shareThisOne}
                onChange={(e) => setShareThisOne(e.target.checked)}
              />
              Also share <em>this</em> finding now
            </label>
            <div className="share-card-actions">
              <button className="btn ghost" onClick={() => handleShareDecision(false)}>No thanks</button>
              <button className="btn primary" onClick={() => handleShareDecision(true)}>Yes, share future findings</button>
            </div>
            <div className="share-card-foot muted">You can change this any time from Help → About.</div>
          </div>
        )}

        <div className="discover-footer">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {/* "Remove source" only makes sense when a USER-added source
           * exists — registry-source edits (routed here since 1.0.21)
           * have nothing removable: the bundled entry can't be deleted,
           * only overridden. */}
          {isEditMode && item.registryAddedByUser && phase !== 'saved' && phase !== 'saving' && (
            <button
              className="btn danger"
              onClick={removeSource}
              title="Delete the update source you added for this plugin"
            >
              Remove source
            </button>
          )}
          {phase === 'found' && (
            <button className="btn primary" onClick={save} disabled={!url.trim() || !regex.trim()}>
              {isEditMode ? 'Save changes' : 'Save and use this source'}
            </button>
          )}
          {phase === 'manual' && (
            <button
              className="btn primary"
              onClick={saveManual}
              disabled={
                !url.trim() ||
                (showAdvanced && regex.trim()
                  ? false                                   // user supplied regex: URL is enough
                  : !manualVersion.trim())                 // simple path: need version
              }
            >
              Save and use this source
            </button>
          )}
          {phase === 'notfound' && (
            <button
              className="btn"
              onClick={() => {
                // Switch to a manual-entry phase with empty URL / version /
                // regex fields the user can fill in themselves. (The previous
                // implementation just closed the modal, which silently
                // dropped the user's intent on the floor.)
                setUrl('');
                setRegex('');
                setManualVersion('');
                setManualError(null);
                setShowAdvanced(false);
                setPhase('manual');
              }}
            >
              Add manually instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
