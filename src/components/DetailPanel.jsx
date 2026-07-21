import React, { useState, useEffect, useRef } from 'react';
import UpdateBadge from './UpdateBadge.jsx';
import FormatTag from './FormatTag.jsx';
import { formatBytes, displaySubcategory, displayCategory } from '../util/format.js';

// Sentinel used in the category/subcategory dropdowns to mean "let me type
// a custom name". When the user selects it, we prompt for the value and
// add it to the persistent user-defined list.
const CUSTOM_SENTINEL = '__custom__';

function fieldRow(label, value, copyable) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="field-row" key={label}>
      <div className="field-label">{label}</div>
      <div className="field-value" title={typeof value === 'string' ? value : ''}>
        {copyable ? <code>{String(value)}</code> : <span>{String(value)}</span>}
      </div>
    </div>
  );
}

export default function DetailPanel({
  item, update, allItems, knownCategories, knownTags,
  onClose, onSelect, onOpenInFinder, onOpenApp, onOpenHomepage, onSetOverride, onTrash,
  onDiscover, onEditRegistrySource, onEditUpdateSource, onRemoveUpdateSource, onShowAddSourceHelp, onOpenCompanionApp,
  onPickCompanion, onClearCompanion,
  onSetMirrorFrom,                            // () => void — open the picker modal
  onClearMirrorFrom,                          // () => void — drop the mirror link
  onLinkMirrorTo,                             // (parent) => void — quick link from auto-suggest banner
  onDismissMirrorSuggest,                     // () => void — hide the auto-suggest banner forever
  onBulkRenameDeveloperTo,                    // (oldName, newName) => void
  onAddCustomCategory,                        // (categoryName, subcategoryName?) => void
  onRequestConfirm,                           // (config) => Promise<boolean>
  // Deal-alert wiring. App.jsx computes whether this plugin / developer
  // is currently being watched and passes toggle handlers down. We
  // render a bell next to the title (plugin watch) and next to the
  // developer name (developer watch). Tabs/list cards get their own
  // bells in Phase 3.3 — these two are the high-intent placements
  // because the DetailPanel is exactly where users go to decide "I
  // want to know when this is on sale".
  isWatchingPlugin = false,
  isWatchingDeveloper = false,
  onToggleWatchPlugin,
  onToggleWatchDeveloper,
}) {
  if (!item) return null;
  const reg = item.registry || {};
  const dup = item.duplicate;
  const groupMembers = dup && allItems
    ? allItems.filter((x) => x.duplicate && x.duplicate.groupId === dup.groupId && x.id !== item.id)
    : [];
  // The copy this one is duplicated by / superseded by — used to render
  // its path as a clickable reveal-in-Finder link in the cleanup card.
  const keptItem = (dup && dup.keptId && dup.keptId !== item.id && allItems)
    ? (allItems.find((x) => x.id === dup.keptId) || null)
    : null;

  // Format lag: this plugin is outdated but sibling formats are already at the latest version.
  // Happens when developers release AU/VST3 before AAX (Avid certification takes time).
  // The user can acknowledge this to suppress the OLD badge and update CTA.
  const lagSiblings = (update && update.status === 'outdated' && update.latestVersion && groupMembers.length > 0)
    ? groupMembers.filter((m) => m.version === update.latestVersion && m.format !== item.format)
    : [];
  const isFormatLag = lagSiblings.length > 0;
  const formatLagAcknowledged = isFormatLag && item.formatLagAcknowledgedAt === update.latestVersion;
  const updateDismissed = !!(update && update.latestVersion && item.dismissedUpdateVersion === update.latestVersion);
  const isIgnored = !!(update && update.status === 'outdated' && (
    item.ignoreAllUpdates || (item.ignoredUpdateVersion && item.ignoredUpdateVersion === update.latestVersion)
  ));
  const lagSiblingFormats = lagSiblings.map((m) => m.format);
  const lagFormatsLabel = lagSiblingFormats.length === 1
    ? lagSiblingFormats[0]
    : lagSiblingFormats.slice(0, -1).join(', ') + ' and ' + lagSiblingFormats[lagSiblingFormats.length - 1];
  const lagVersionWord = lagSiblings.length === 1 ? 'version' : 'versions';
  const lagIsAre = lagSiblings.length === 1 ? 'is' : 'are';

  // Update detection can come from three places:
  //   1. A registry/user-saved updateUrl + versionRegex pair
  //   2. A Sparkle appcast URL declared in the bundle (most reliable)
  //   3. A previous successful check (we got back outdated/current/ahead)
  // The "Updates not configured" card should only appear when none of
  // these are available. ImageOptim falls into category 2 (Sparkle): the
  // version is being detected just fine, so the card was wrong to show.
  const hasManualSource = !!(reg.updateUrl && reg.versionRegex);
  // URL-only "manual check" source: user saved a URL but accepted that
  // Plugr can't auto-detect the version (typical for JS-rendered pages
  // or pages where the version isn't in the static HTML). Counts as a
  // source so the "Updates not configured" card stays hidden.
  const hasManualCheckUrl = !!(reg.updateUrl && !reg.versionRegex);
  // Where the "Get update" / "Open page" button sends the user. Prefer a
  // separate download page when one was set; otherwise the version-source
  // URL (the common case — a single link). Keeps single-link plugins
  // behaving exactly as before while supporting release-notes-here /
  // download-there sources.
  const ctaUrl = reg.downloadUrl || reg.updateUrl;
  const hasSeparateDownload = !!(reg.downloadUrl && reg.downloadUrl !== reg.updateUrl);
  const hasSparkle = !!item.sparkleFeedUrl;
  const updateIsWorking = !!(update && (
    update.status === 'outdated' ||
    update.status === 'current' ||
    update.status === 'ahead' ||
    update.status === 'manual-check'
  ));
  const hasUpdateSource = hasManualSource || hasManualCheckUrl || hasSparkle || updateIsWorking;
  // A companion app counts as a real source even if Plugr can't web-check
  // — the companion is where this plugin gets updated, so showing the
  // alarming "Updates not configured" card would be misleading.
  const hasCompanion = !!(reg.companionApp);
  const noSource = !hasUpdateSource && !hasCompanion;

  // Mirror-from-parent resolution. The data layer has already populated
  // item.mirrorFromId via applyOverrides; here we find the actual parent
  // item in allItems so we can render its name.
  const mirrorParent = (item.mirrorFromId && allItems)
    ? (allItems.find((x) => x.id === item.mirrorFromId) || null)
    : null;

  // Unified source-edit routing (1.0.21 redesign): "the detected version
  // is wrong" and "the source URL/regex is wrong" are the same problem,
  // so both funnel into DiscoverModal's edit mode prefilled with the
  // current source (which has the "type the version you actually see"
  // correction field). User-added sources route through onEditUpdateSource,
  // bundled registry sources through onEditRegistrySource. Sources
  // inherited from a sibling format aren't editable here — editing
  // happens on the plugin that owns the source.
  const ownsUserSource = !!(item.registryAddedByUser && !item.registryAppliedViaSibling);
  const inheritedUserSource = !!(item.registryAddedByUser && item.registryAppliedViaSibling);
  const handleEditSource = ownsUserSource ? (onEditUpdateSource || onEditRegistrySource) : onEditRegistrySource;
  const canEditSource = !!(reg.updateUrl && handleEditSource && !inheritedUserSource);

  // Auto-suggest a likely parent for plugins with no source yet. Picks
  // siblings from the same developer whose name brackets the current
  // item's name on either side. The "shortest matching name" tiebreak
  // prefers genuine parents (Serum) over other siblings (Serum Pro).
  // Skipped entirely when the user already linked one or dismissed the
  // banner.
  let suggestedMirror = null;
  if (!item.mirrorFromId && !item.dismissedMirrorSuggest && noSource && allItems) {
    const myDev = (item.developer || '').toLowerCase().trim();
    const myName = item.name || '';
    if (myDev && myDev !== 'unknown' && myName) {
      let best = null;
      for (const other of allItems) {
        if (other.id === item.id) continue;
        if (other.mirrorFromId) continue;     // don't suggest a child as parent
        const otherDev = (other.developer || '').toLowerCase().trim();
        if (otherDev !== myDev) continue;
        const otherName = other.name || '';
        if (!otherName) continue;
        // Match in either direction so users can reach the parent by
        // selecting either the child OR the parent. Two prefix shapes
        // for the child→parent case (' ' and '-') because real-world
        // naming uses both ("Serum FX" and "Pro-Q Mid/Side").
        const childMatchesParent =
          myName.startsWith(otherName + ' ') || myName.startsWith(otherName + '-');
        const parentMatchesChild = otherName.startsWith(myName + ' ');
        if (!childMatchesParent && !parentMatchesChild) continue;
        if (!best || otherName.length < best.name.length) {
          best = other;
        }
      }
      suggestedMirror = best;
    }
  }

  const [editingDev, setEditingDev] = useState(false);
  const [devDraft, setDevDraft] = useState(item.developer || '');
  useEffect(() => { setDevDraft(item.developer || ''); setEditingDev(false); }, [item.id]);

  const [editingCat, setEditingCat] = useState(false);
  const [catDraftCategory, setCatDraftCategory] = useState(item.category || 'Other');
  const [catDraftSubcategory, setCatDraftSubcategory] = useState(item.subcategory || '');
  useEffect(() => {
    setCatDraftCategory(item.category || 'Other');
    setCatDraftSubcategory(item.subcategory || '');
    setEditingCat(false);
  }, [item.id]);

  const [showAddCategory, setShowAddCategory] = useState(false);
  const [extraCatCategory, setExtraCatCategory] = useState('Effect');
  const [extraCatSubcategory, setExtraCatSubcategory] = useState('Reverb');

  const [showAdvanced, setShowAdvanced] = useState(false);

  const subOptionsForDraft = (knownCategories.find((c) => c.category === catDraftCategory) || {}).subcategories || [];
  const subOptionsForExtra = (knownCategories.find((c) => c.category === extraCatCategory) || {}).subcategories || [];

  async function commitDeveloperEdit() {
    const trimmed = (devDraft || '').trim();
    if (!trimmed || trimmed === item.developer) {
      setEditingDev(false);
      return;
    }
    const oldName = item.developer || '';
    // "Unknown" is a placeholder, not a real developer — many unrelated
    // plugins share it. Treat as a single-plugin edit, no bulk prompt.
    const isPlaceholder = !oldName || oldName === 'Unknown';
    if (!isPlaceholder) {
      const sameDevCount = (allItems || []).filter((x) => x.developer === oldName && x.id !== item.id).length;
      if (sameDevCount > 0 && onBulkRenameDeveloperTo && onRequestConfirm) {
        // High-friction custom dialog: YES is red, NO is the focused
        // default. Triggers on operations that affect non-selected items.
        const yes = await onRequestConfirm({
          title: `Rename ${sameDevCount + 1} plugins?`,
          body: (
            <>
              <p>This will change the developer of <strong>{sameDevCount + 1} plugins</strong> currently attributed to "<strong>{oldName}</strong>" → "<strong>{trimmed}</strong>".</p>
              <p>Choose <strong>No</strong> to rename only this one plugin.</p>
            </>
          ),
          details: `Affects this plugin and ${sameDevCount} other${sameDevCount === 1 ? '' : 's'} you haven't selected. You can Undo right after.`,
          yesLabel: `Yes, rename all ${sameDevCount + 1}`,
          noLabel: `No, only this one`,
          destructive: true,
        });
        if (yes) {
          onBulkRenameDeveloperTo(oldName, trimmed);
          setEditingDev(false);
          return;
        }
      }
    }
    onSetOverride({ developer: trimmed });
    setEditingDev(false);
  }
  function commitCategoryEdit() {
    const sub = (catDraftSubcategory || '').trim();
    onSetOverride({
      category: catDraftCategory,
      // Treat the redundant "Effect / Effect" choice as no subcategory.
      subcategory: sub && sub.toLowerCase() !== (catDraftCategory || '').toLowerCase() ? sub : null,
    });
    setEditingCat(false);
  }
  // Prompt for a user-supplied category name and persist it to the
  // shared user-categories list so it appears in this and future plugin
  // dropdowns. Used by the "+ Custom…" sentinel option.
  function handlePickCustomCategory(setter) {
    const raw = window.prompt('Name for this custom category (e.g. "Vocal Chain", "Sound Design", "Mixing"):', '');
    if (!raw) return null;
    const name = raw.trim();
    if (!name) return null;
    setter(name);
    if (onAddCustomCategory) onAddCustomCategory(name);
    return name;
  }
  function handlePickCustomSubcategory(parent, setter) {
    const raw = window.prompt(`Name for this custom ${parent ? `${parent} ` : ''}subcategory (e.g. "Vocal Mix", "Drum Bus"):`, '');
    if (!raw) return null;
    const name = raw.trim();
    if (!name) return null;
    setter(name);
    if (onAddCustomCategory) onAddCustomCategory(parent, name);
    return name;
  }
  function clearOverrides() {
    if (!window.confirm('Reset all your customizations on this item (favorite, custom developer, custom category, notes, tags)?')) return;
    onSetOverride({ __clear: true });
  }
  function addExtraCategory() {
    const existing = item.extraCategories || [];
    const next = [...existing, { category: extraCatCategory, subcategory: extraCatSubcategory }];
    onSetOverride({ extraCategories: next });
    setShowAddCategory(false);
  }
  function removeExtraCategory(idx) {
    const existing = item.extraCategories || [];
    const next = existing.filter((_, i) => i !== idx);
    onSetOverride({ extraCategories: next });
  }

  return (
    <aside className="detail-panel">
      <button className="close-button" onClick={onClose} aria-label="Close details">×</button>

      <div className="detail-header">
        <div className={`detail-art cat-${(item.category || 'other').toLowerCase()}`}>
          <FormatTag item={item} />
        </div>
        <div className="detail-title">
          <div className="detail-title-row">
            <h2>{item.name}</h2>
            <button
              type="button"
              className={`fav-star detail-fav ${item.favorite ? 'on' : ''}`}
              onClick={() => onSetOverride({ favorite: !item.favorite })}
              title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              {item.favorite ? '★' : '☆'}
            </button>
            {/* Deal-alert bell for this specific plugin. Filled when
             *  there's an active watch, hollow otherwise. Clicking
             *  toggles the watch on/off — the user gets a toast
             *  confirming what happened. */}
            {onToggleWatchPlugin && (
              <button
                type="button"
                className={`watch-bell detail-watch ${isWatchingPlugin ? 'on' : ''}`}
                onClick={onToggleWatchPlugin}
                title={isWatchingPlugin
                  ? `Stop watching ${item.name} for deals`
                  : `Notify me when ${item.name} goes on sale`}
                aria-pressed={isWatchingPlugin}
                aria-label={isWatchingPlugin ? 'Stop watching for deals' : 'Watch for deals'}
              >
                {isWatchingPlugin ? '🔔' : '🔕'}
              </button>
            )}
          </div>
          <div className="detail-sub">
            <span className="developer">{item.developer}{item.developerOverridden && <span className="badge-mini" title="Custom developer name">edited</span>}</span>
            {/* Developer-level deal-alert bell. Catches sales,
             *  bundles, or new releases from this maker — even for
             *  products the user doesn't own yet. */}
            {onToggleWatchDeveloper && item.developer && (
              <button
                type="button"
                className={`watch-bell detail-watch-dev ${isWatchingDeveloper ? 'on' : ''}`}
                onClick={onToggleWatchDeveloper}
                title={isWatchingDeveloper
                  ? `Stop watching ${item.developer} for deals`
                  : `Notify me about any ${item.developer} deal`}
                aria-pressed={isWatchingDeveloper}
                aria-label={isWatchingDeveloper ? 'Stop watching developer for deals' : 'Watch developer for deals'}
              >
                {isWatchingDeveloper ? '🔔' : '🔕'}
              </button>
            )}
            <span className="dot-sep">·</span>
            <span>{displaySubcategory(item) || item.category}{item.categoryOverridden && <span className="badge-mini" title="Custom category">edited</span>}</span>
          </div>
        </div>
      </div>

      <div className="detail-status">
        {/* Skip the "No source" pill when the helper card right below
         *  is about to spell out the same situation — previously this
         *  panel showed the same fact twice ("No source" pill + a
         *  full "Updates not configured" callout). */}
        {noSource ? null : <UpdateBadge item={item} update={update} verbose />}
        {update && update.latestVersion && (
          <span className="detail-status-text">
            installed <code>v{item.version || '?'}</code> · latest <code>v{update.latestVersion}</code>
            {isIgnored && (
              <> · <span style={{ opacity: 0.65 }}>{item.ignoreAllUpdates ? 'All updates ignored' : 'Update ignored'}</span>{' · '}<button type="button" className="linkish" onClick={() => onSetOverride(item.ignoreAllUpdates ? { ignoreAllUpdates: null, ignoredUpdateVersion: null } : { ignoredUpdateVersion: null })}>Undo</button></>
            )}
            {updateDismissed && (
              <> · <button type="button" className="linkish" title="Re-enable update detection for this app" onClick={() => onSetOverride({ dismissedUpdateVersion: null })}>Undo dismiss</button></>
            )}
          </span>
        )}
        {update && update.message && update.status !== 'outdated' && (
          <span className="detail-status-text muted">{update.message}</span>
        )}
        {/* Unified source row (1.0.21 redesign). One consistent line
         * showing where update info comes from — Plugr registry, a source
         * the user added, a built-in Sparkle feed, or a mirror link —
         * with every source-management action in one place. Replaces four
         * scattered lines ("Edit source…", "added by you ✓ · Edit ·
         * Remove", "Mirrors from X · Unlink", "Mirror from another
         * plugin…"). Hidden when there's no source at all (the no-source
         * card covers that) and in the companion-only case (the companion
         * banner covers it). */}
        {!noSource && !(hasCompanion && !hasUpdateSource && !mirrorParent) && (
          <span className="detail-status-text muted">
            {mirrorParent ? (
              <span title={`Update status borrowed from "${mirrorParent.name}". Removing this link will make Plugr check this plugin on its own.`}>
                Source: mirrors <strong>{mirrorParent.name}</strong>
                {onClearMirrorFrom && (
                  <>
                    {' · '}
                    <button type="button" className="linkish" onClick={onClearMirrorFrom}>Unlink</button>
                  </>
                )}
              </span>
            ) : (
              <>
                {'Source: '}
                {item.registryAddedByUser ? (
                  <>added by you ✓{inheritedUserSource && <span title="Inherited from another format of this plugin"> (via sibling)</span>}</>
                ) : hasSparkle && !reg.updateUrl ? (
                  <span title="This app announces updates itself via a built-in Sparkle feed — the most reliable kind of source">built-in update feed</span>
                ) : (
                  'Plugr registry'
                )}
                {canEditSource && (
                  <>
                    {' · '}
                    <button type="button" className="linkish" onClick={handleEditSource} title="Edit the update page URL or version pattern — opens prefilled with the current source">Edit source…</button>
                  </>
                )}
                {ownsUserSource && onRemoveUpdateSource && (
                  <>
                    {' · '}
                    <button type="button" className="linkish danger" onClick={onRemoveUpdateSource}>Remove</button>
                  </>
                )}
                {onSetMirrorFrom && (
                  <>
                    {' · '}
                    <button type="button" className="linkish" onClick={onSetMirrorFrom} title="Borrow update status from another plugin you've already configured">Mirror from another plugin…</button>
                  </>
                )}
              </>
            )}
          </span>
        )}
        {/* Ignore actions on their own tidy line, below the source row.
         *  Previously these sat inline on the version line alongside a
         *  duplicate "Fix it…" link (same action as the source row's
         *  "Edit source…", now removed). */}
        {update && update.status === 'outdated' && !updateDismissed && !isIgnored && !formatLagAcknowledged && (
          <span className="detail-status-text muted">
            <button type="button" className="linkish" title="Ignore this update — removes it from Updates available until a newer version is detected" onClick={() => onSetOverride({ ignoredUpdateVersion: update.latestVersion })}>Ignore this update</button>
            {' · '}
            <button type="button" className="linkish" title="Never show update alerts for this plugin — ignores all versions, not just this one" onClick={() => onSetOverride({ ignoreAllUpdates: true })}>Ignore all</button>
          </span>
        )}
      </div>

      {/* Auto-suggest banner: when a plain heuristic spots a likely
       * parent (Serum FX → Serum, etc.) offer a one-click link before
       * the user has to open the picker. Visually matches the companion
       * "Updates handled by…" banner below — same soft accent tint, same
       * row layout — so the UI feels consistent. */}
      {suggestedMirror && !mirrorParent && (
        <div
          className="mirror-suggest-banner"
          style={{
            margin: '8px 16px 0',
            padding: '10px 12px',
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
            fontSize: 12,
            color: 'var(--text-muted, rgba(127,127,127,0.85))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span>
            Looks like this might share updates with <strong>{suggestedMirror.name}</strong> — link them?
          </span>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="btn"
              onClick={() => onLinkMirrorTo && onLinkMirrorTo(suggestedMirror)}
              title={`Borrow update status from "${suggestedMirror.name}"`}
            >
              Link
            </button>
            <button
              type="button"
              className="linkish"
              onClick={() => onDismissMirrorSuggest && onDismissMirrorSuggest()}
              title="Don't suggest this again for this plugin"
            >
              Not really
            </button>
          </span>
        </div>
      )}

      {/* No-source helper card */}
      {noSource && (
        <div className="no-source-card">
          <div className="no-source-title">Updates not configured for this plugin</div>
          <div className="no-source-body">
            Plugr doesn't yet know where to look for updates from <strong>{item.developer}</strong>{reg.homepage ? '' : '.'}.
            Try <strong>Find update source</strong> — Plugr will visit the developer's website and try to figure it out automatically.
          </div>
          <div className="no-source-actions">
            <button className="btn primary" onClick={onDiscover}>Find update source</button>
            {/* Alternative path: if this is a sibling of an already-
             * configured plugin (Serum FX → Serum), let the user point
             * the link directly rather than discovering. */}
            {onSetMirrorFrom && (
              <button className="btn" onClick={onSetMirrorFrom} title="Borrow the update result from another plugin you've already configured">
                Mirror from another plugin…
              </button>
            )}
            <button className="btn" onClick={onShowAddSourceHelp}>How does this work?</button>
          </div>
        </div>
      )}

      {/* When a plugin IS companion-managed but the user wants to also
       * track updates via a website (e.g. for vendors who quietly push
       * updates without surfacing them in their installer), offer the
       * Discover flow as a secondary option. */}
      {hasCompanion && !hasUpdateSource && !mirrorParent && (onDiscover || onSetMirrorFrom) && (
        <div style={{
          margin: '8px 16px 0',
          padding: '10px 12px',
          borderRadius: 8,
          background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
          fontSize: 12,
          color: 'var(--text-muted, rgba(127,127,127,0.85))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{ flex: '1 1 220px', minWidth: 0 }}>
            Updates handled by {reg.companionApp.displayName || reg.companionApp.name}.
            You can also track this plugin via the developer's website
            {onSetMirrorFrom ? ', or borrow update status from a sibling plugin.' : '.'}
          </span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: '0 0 auto' }}>
            {onDiscover && (
              <button type="button" className="linkish" onClick={onDiscover}>
                Add web source
              </button>
            )}
            {onSetMirrorFrom && (
              <button type="button" className="linkish" onClick={onSetMirrorFrom} title="Borrow update status from another plugin you've already configured">
                Mirror from another plugin…
              </button>
            )}
          </div>
        </div>
      )}

      {item.osCompat && item.osCompat.status === 'incompatible' && (
        <div className="detail-cleanup os-warn">
          <div className="cleanup-title">macOS compatibility</div>
          <div className="cleanup-body">{item.osCompat.message}</div>
        </div>
      )}

      {dup && dup.status && (
        <div className={`detail-cleanup dup-${dup.status}`}>
          <div className="cleanup-title">{dup.status === 'duplicate' ? 'Duplicate copy' : 'Older version'}</div>
          {/* Reconstruct the reason with the kept copy's path as a
           * clickable reveal-in-Finder link instead of dead text. Falls
           * back to the plain reason string when the kept item can't be
           * resolved (e.g. it was trashed since the last scan). */}
          <div className="cleanup-body">
            {keptItem && onOpenInFinder ? (
              <>
                {dup.status === 'duplicate'
                  ? 'Same version as the kept copy at '
                  : `Older than v${keptItem.version || '?'} installed at `}
                <button
                  type="button"
                  className="linkish"
                  style={{ wordBreak: 'break-all', textAlign: 'left' }}
                  title="Show in Finder"
                  onClick={() => onOpenInFinder(keptItem.path)}
                >{keptItem.path}</button>
              </>
            ) : dup.reason}
          </div>
          {/* Escape hatch for false family grouping (product-line
           * reboots like iZotope Trash v1.x vs legacy Trash 2, or model
           * numbers the grouper misread). Persisted per-item override —
           * survives rescans; Undo affordance renders below once set. */}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="linkish"
              title="Wrongly grouped? Exclude this plugin from duplicate/older-version detection. You can undo this any time."
              onClick={() => onSetOverride({ notDuplicate: true })}
            >Not the same plugin? Unlink</button>
          </div>
          {groupMembers.length > 0 && (
            <div className="cleanup-list">
              <div className="cleanup-list-title">Other copies in this group</div>
              {groupMembers.map((m) => (
                <button key={m.id} type="button" className="cleanup-list-item" onClick={() => onSelect && onSelect(m.id)} title={m.path}>
                  <FormatTag item={m} variant="pill" />
                  <span className="cleanup-list-version">v{m.version || '?'}</span>
                  <span className="cleanup-list-size">{formatBytes(m.sizeBytes)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Orphaned WaveShell — no installed or Central-deactivated Waves
       * payload declares a dependency on this shell version, so it can
       * load nothing and is safe to remove. Determined from Waves' own
       * manifest.yaml dependency maps (fail-closed), not a heuristic. */}
      {item.wavesShellOrphaned && (
        <div className="detail-cleanup waves-orphan">
          <div className="cleanup-title">Safe to remove</div>
          <div className="cleanup-body">
            No installed Waves plugin loads through this shell version — every payload
            that required it has been removed. Deleting it frees space and won&rsquo;t
            affect any Waves plugin you still have.
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Best removed through Waves Central, which keeps its own dependency records.
          </div>
          {onOpenInFinder && (
            <button
              type="button"
              className="linkish"
              style={{ wordBreak: 'break-all', textAlign: 'left' }}
              title="Show in Finder"
              onClick={() => onOpenInFinder(item.path)}
            >{item.path}</button>
          )}
        </div>
      )}

      {/* Undo affordance for "Not the same plugin" — the cleanup card
       * itself no longer renders once the dup record is stripped, so
       * this muted line is the way back. */}
      {item.notDuplicate && (
        <div className="detail-status" style={{ paddingTop: 0 }}>
          <span className="detail-status-text muted">
            Excluded from duplicate detection
            {' · '}
            <button
              type="button"
              className="linkish"
              onClick={() => onSetOverride({ notDuplicate: null })}
            >Undo</button>
          </span>
        </div>
      )}

      {/* Format-lag banner — STANDALONE since the fix for the missing
       * "Mark as current" option. It used to live inside the duplicate/
       * superseded cleanup card above, which was fine when cross-format
       * version lag produced an OLD flag. The 1.0.19 format-aware
       * superseded change (correctly) stopped flagging those items, but
       * that also silently removed this banner's only render path. Now
       * it renders whenever format lag is detected, OLD flag or not. */}
      {isFormatLag && (
        <div style={{
          margin: '8px 16px 0',
          padding: '8px 10px',
          borderRadius: 6,
          background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
          fontSize: 12,
          color: 'var(--text-muted, rgba(127,127,127,0.85))',
        }}>
          {formatLagAcknowledged ? (
            <span>
              <span style={{ opacity: 0.65 }}>{item.format} marked as current</span>
              {' · '}
              <button
                type="button"
                className="linkish"
                onClick={() => onSetOverride({ formatLagAcknowledgedAt: null })}
              >Undo</button>
            </span>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 7 }}>
                <span style={{ flexShrink: 0, opacity: 0.5, lineHeight: '1.5' }}>ℹ</span>
                <span style={{ lineHeight: '1.5' }}>
                  The {lagFormatsLabel} {lagVersionWord} of this plugin {lagIsAre} already on v{update.latestVersion}, but the {item.format} is still on v{item.version}. Developers sometimes release formats at different times — if there is no {item.format} update available yet, you can mark it as current.
                </span>
              </div>
              <button
                type="button"
                className="linkish"
                style={{ marginLeft: 16 }}
                onClick={() => onSetOverride({ formatLagAcknowledgedAt: update.latestVersion })}
              >Mark {item.format} as current</button>
            </>
          )}
        </div>
      )}

      <div className="detail-actions">
        <button className="btn" onClick={() => onOpenInFinder(item.path)} title="Reveal in Finder">Show in Finder</button>
        {item.format === 'App' && onOpenApp && (
          <button className="btn" onClick={() => onOpenApp(item.path)}>Open app</button>
        )}

        {/* When an update is available AND the developer has a companion
         * app, promote that companion app as the primary CTA — that's
         * almost always where the user actually applies the update. */}
        {reg.companionApp && update && update.status === 'outdated' && !formatLagAcknowledged && !updateDismissed && !isIgnored ? (
          <button
            className="btn primary companion-btn update-cta"
            onClick={() => onOpenCompanionApp && onOpenCompanionApp(reg.companionApp)}
            title={`Update available (v${update.latestVersion}). Open ${reg.companionApp.displayName || reg.companionApp.name} to install.`}
          >
            Update available — Open {reg.companionApp.displayName || reg.companionApp.name}
          </button>
        ) : reg.companionApp ? (
          <button
            className="btn primary companion-btn"
            onClick={() => onOpenCompanionApp && onOpenCompanionApp(reg.companionApp)}
            title={`Open ${reg.companionApp.displayName || reg.companionApp.name} — the manager app for ${item.developer} plugins`}
          >
            Open {reg.companionApp.displayName || reg.companionApp.name}
          </button>
        ) : (
          /* No companion app on file. Offer to let the user point Plugr
           * at one — useful for developers Plugr doesn't yet know about. */
          onPickCompanion && item.developer && item.developer !== 'Unknown' ? (
            <button
              className="btn"
              onClick={onPickCompanion}
              title={`Tell Plugr which app manages ${item.developer} plugins. Applies to all plugins from this developer.`}
            >
              + Add companion app
            </button>
          ) : null
        )}
        {/* Allow the user to clear a custom companion they previously set */}
        {item.companionFromUser && onClearCompanion && (
          <button
            className="btn"
            onClick={onClearCompanion}
            title="Forget the custom companion app for this developer"
          >
            Clear companion
          </button>
        )}

        {reg.homepage && (
          <button className="btn" onClick={() => onOpenHomepage(reg.homepage)}>Developer site</button>
        )}
        {reg.supportUrl && (
          <button className="btn" onClick={() => onOpenHomepage(reg.supportUrl)}>Support</button>
        )}
        {reg.downloadsUrl && (
          <button className="btn" onClick={() => onOpenHomepage(reg.downloadsUrl)}>Downloads</button>
        )}

        {/* If there's no companion app and we have a direct update URL, that
         * becomes the primary update CTA when an update is available. */}
        {hasUpdateSource && reg.updateUrl && (
          update && update.status === 'outdated' && !reg.companionApp && !formatLagAcknowledged && !updateDismissed && !isIgnored ? (
            <button className="btn primary update-cta" onClick={() => onOpenHomepage(ctaUrl)}>
              Update available — Get v{update.latestVersion}
            </button>
          ) : (
            <button className="btn" onClick={() => onOpenHomepage(ctaUrl)}>{hasSeparateDownload ? 'Open download page' : 'Open update page'}</button>
          )
        )}

        {/* Hide / Unhide. Hidden plugins are stripped from every normal
         * sidebar bucket + the main library view; the user can find
         * them again under the "⊘ Hidden" row in the sidebar and use
         * this same button to bring them back. Useful for uninstallers,
         * developer helper apps, demo plugins they don't want cluttering
         * the regular view. */}
        {item.hidden ? (
          <button
            className="btn"
            onClick={() => onSetOverride({ hidden: false })}
            title="Show this plugin in the normal lists again"
          >Unhide</button>
        ) : (
          <button
            className="btn"
            onClick={() => onSetOverride({ hidden: true })}
            title="Hide from the normal lists (you can unhide later from the Hidden sidebar bucket)"
          >Hide…</button>
        )}

        {/* Trash sits inline with the other actions — the .btn.danger
         * red color and the confirm dialog already telegraph it's the
         * dangerous one, so a separate "DANGER ZONE" row was just
         * eating space. */}
        <button className="btn danger" onClick={onTrash} title="Move to Trash (reversible)">Move to Trash…</button>
      </div>

      {/* Editable Category */}
      <div className="detail-section">
        <div className="section-title-row">
          <span className="section-title">Category</span>
          {!editingCat ? (
            <button className="link-btn" onClick={() => setEditingCat(true)}>edit</button>
          ) : (
            <div className="link-btn-row">
              <button className="link-btn" onClick={commitCategoryEdit}>save</button>
              <button className="link-btn muted" onClick={() => setEditingCat(false)}>cancel</button>
            </div>
          )}
        </div>
        {!editingCat ? (
          <div className="cat-display">
            <span className="cat-pill primary">{displayCategory(item)}</span>
            {(item.extraCategories || []).map((c, i) => (
              <span key={i} className="cat-pill extra">
                {displayCategory(c)}
                <button className="cat-pill-x" onClick={() => removeExtraCategory(i)} title="Remove this category">×</button>
              </span>
            ))}
            <button className="link-btn" onClick={() => setShowAddCategory(true)}>+ add another</button>
          </div>
        ) : (
          <div className="cat-edit">
            <select value={catDraftCategory} onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) {
                handlePickCustomCategory((name) => {
                  setCatDraftCategory(name);
                  setCatDraftSubcategory('');     // user can add sub via "+ Custom…" below
                });
                return;
              }
              setCatDraftCategory(v);
              const subs = (knownCategories.find((c) => c.category === v) || {}).subcategories || [];
              setCatDraftSubcategory(subs.length ? subs[0] : '');
            }}>
              {knownCategories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
              {/* Always allow the user to type a custom one. */}
              <option value={CUSTOM_SENTINEL}>+ Custom category…</option>
            </select>
            <select value={catDraftSubcategory} onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) {
                handlePickCustomSubcategory(catDraftCategory, setCatDraftSubcategory);
                return;
              }
              setCatDraftSubcategory(v);
            }}>
              <option value="">— none —</option>
              {subOptionsForDraft.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value={CUSTOM_SENTINEL}>+ Custom subcategory…</option>
            </select>
          </div>
        )}
        {showAddCategory && (
          <div className="cat-edit add-extra">
            <select value={extraCatCategory} onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) {
                handlePickCustomCategory((name) => {
                  setExtraCatCategory(name);
                  setExtraCatSubcategory('');
                });
                return;
              }
              setExtraCatCategory(v);
              const subs = (knownCategories.find((c) => c.category === v) || {}).subcategories || [];
              setExtraCatSubcategory(subs.length ? subs[0] : '');
            }}>
              {knownCategories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
              <option value={CUSTOM_SENTINEL}>+ Custom category…</option>
            </select>
            <select value={extraCatSubcategory} onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) {
                handlePickCustomSubcategory(extraCatCategory, setExtraCatSubcategory);
                return;
              }
              setExtraCatSubcategory(v);
            }}>
              <option value="">— none —</option>
              {subOptionsForExtra.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value={CUSTOM_SENTINEL}>+ Custom subcategory…</option>
            </select>
            <button className="link-btn" onClick={addExtraCategory}>add</button>
            <button className="link-btn muted" onClick={() => setShowAddCategory(false)}>cancel</button>
          </div>
        )}
        {item.categoryCandidates && item.categoryCandidates.length > 1 && (
          <div className="candidates-hint">
            also detected: {item.categoryCandidates.filter((c) => c.category !== item.category || c.subcategory !== item.subcategory).map((c, i) => (
              <span key={i} className="candidate">{displayCategory(c)} <span className="muted">({c.sourceFormat})</span></span>
            ))}
          </div>
        )}
      </div>

      {/* Editable Developer */}
      <div className="detail-section">
        <div className="section-title-row">
          <span className="section-title">Developer</span>
          {!editingDev ? (
            <button className="link-btn" onClick={() => setEditingDev(true)}>edit</button>
          ) : (
            <div className="link-btn-row">
              <button className="link-btn" onClick={commitDeveloperEdit}>save</button>
              <button className="link-btn muted" onClick={() => { setDevDraft(item.developer || ''); setEditingDev(false); }}>cancel</button>
            </div>
          )}
        </div>
        {!editingDev ? (
          <div className="dev-display">{item.developer}</div>
        ) : (
          <input
            className="dev-input"
            type="text"
            list="known-developers-dl"
            value={devDraft}
            onChange={(e) => setDevDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitDeveloperEdit(); if (e.key === 'Escape') setEditingDev(false); }}
            autoFocus
          />
        )}
      </div>

      {/* Plugin info — the top-line fields (Format / Version / Size /
       *  Min macOS) used to take 4 separate rows. They're short enough
       *  to live on a single dotted line, which collapses ~80px of
       *  vertical scroll. Long-form / technical fields stay behind
       *  the "Advanced details" toggle below. */}
      <div className="detail-section">
        <div className="section-title">Plugin info</div>
        <div className="plugin-info-inline">
          {[
            (item.formats && item.formats.length) ? item.formats.join(' · ') : item.format,
            item.version ? `v${item.version}` : null,
            formatBytes(item.sizeBytes),
            item.minimumSystemVersion ? `macOS ${item.minimumSystemVersion}+` : null,
          ].filter(Boolean).join(' · ')}
        </div>

        <button className="link-btn advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾ Hide advanced details' : '▸ Show advanced details'}
        </button>
        {showAdvanced && (
          <>
            {[
              fieldRow('Bundle name', item.bundleName, true),
              fieldRow('Build', item.buildVersion && item.buildVersion !== item.version ? item.buildVersion : null),
              fieldRow('Identifier', item.identifier, true),
              fieldRow('Categorized via', item.categorySource),
            ]}
            <div className="field-row">
              <div className="field-label">Location</div>
              <div className="field-value"><code>{item.path}</code></div>
            </div>
            {item.copyright && (
              <div className="field-row">
                <div className="field-label">Copyright</div>
                <div className="field-value">{item.copyright}</div>
              </div>
            )}
          </>
        )}
      </div>

      <NotesSection
        // Re-mount on item change so the textarea picks up the new
        // plugin's note instead of the previous selection's draft.
        key={item.id}
        notes={item.notes || ''}
        onSave={(value) => onSetOverride({ notes: value || null })}
      />

      <TagsSection
        key={'tags-' + item.id}
        tags={item.tags || []}
        knownTags={knownTags || []}
        onChange={(nextTags) => onSetOverride({ tags: nextTags })}
      />

      {(item.developerOverridden || item.categoryOverridden || item.favorite || (item.extraCategories && item.extraCategories.length) || item.notes || (item.tags && item.tags.length)) && (
        <div className="detail-section">
          <button className="link-btn muted" onClick={clearOverrides}>Reset customizations</button>
        </div>
      )}

      {item.error && (
        <div className="detail-section">
          <div className="section-title error">Scan warning</div>
          <div className="copyright">{item.error}</div>
        </div>
      )}
    </aside>
  );
}

// Free-text plugin notes — small textarea on the detail panel.
//
// Two design choices worth flagging:
//
//   - Local draft state so typing is snappy (every keystroke into the
//     real onChange would re-render the whole panel via the override
//     round-trip). We save 600ms after the user stops typing, plus on
//     blur so a quick selection switch still persists the last note.
//
//   - The DetailPanel passes a fresh `key={item.id}` so this component
//     unmounts + remounts when the user selects a different plugin.
//     That guarantees the draft state starts from the new item's note,
//     not the previous selection's in-progress text.
function NotesSection({ notes, onSave }) {
  const [draft, setDraft] = useState(notes || '');
  const [savedHint, setSavedHint] = useState(false);
  const timerRef = useRef(null);
  const lastSavedRef = useRef(notes || '');
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  // Cleanup the pending timer if the component unmounts before the
  // debounce fires (e.g. user switches plugins). We also flush so
  // an in-flight edit isn't lost.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  function flush(value) {
    const v = (value || '').trim();
    const prev = (lastSavedRef.current || '').trim();
    if (v === prev) return;
    lastSavedRef.current = v;
    if (onSaveRef.current) onSaveRef.current(v);
    setSavedHint(true);
    setTimeout(() => setSavedHint(false), 1500);
  }

  function handleChange(e) {
    const next = e.target.value;
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush(next);
    }, 600);
  }

  function handleBlur() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    flush(draft);
  }

  return (
    <div className="detail-section">
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>Notes</span>
        <span style={{
          fontSize: '10px',
          fontWeight: 400,
          opacity: savedHint ? 0.6 : 0,
          color: 'var(--accent, #6ec1ff)',
          transition: 'opacity 200ms',
          letterSpacing: '0.3px',
        }}>saved</span>
      </div>
      <textarea
        value={draft}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Personal note — workflow, presets you like, what to swap it for, anything."
        rows={3}
        style={{
          width: '100%',
          minHeight: '52px',
          padding: '8px 10px',
          fontSize: '13px',
          lineHeight: 1.5,
          borderRadius: '6px',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          background: 'var(--input-bg, rgba(255,255,255,0.04))',
          color: 'inherit',
          resize: 'vertical',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

// Free-form plugin tags. Comma- / Enter- / Tab-separated input;
// backspace on an empty draft removes the last chip. Suggests tags
// from elsewhere in the library via a datalist so the user reuses
// existing labels instead of accidentally creating typo'd duplicates
// ("vocals" vs "vocal"). Tag display is lowercase to match how
// they're stored on disk.
function TagsSection({ tags, knownTags, onChange }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  const datalistId = 'plugin-tag-suggestions';

  function commit(raw) {
    const next = (raw || '').trim().toLowerCase();
    if (!next) return;
    if (tags.includes(next)) {                       // already there → no-op
      setDraft('');
      return;
    }
    onChange([...tags, next]);
    setDraft('');
  }

  function removeAt(idx) {
    const next = tags.filter((_, i) => i !== idx);
    onChange(next);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      // Tab still completes a tag, but only if there's an actual
      // draft. If the user hits Tab on an empty input we let the
      // browser move focus naturally.
      if (!draft.trim()) return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      removeAt(tags.length - 1);
    } else if (e.key === 'Escape') {
      setDraft('');
    }
  }

  function onBlur() {
    // Commit the pending draft on blur so a tag the user typed but
    // didn't hit Enter on isn't silently discarded.
    if (draft.trim()) commit(draft);
  }

  return (
    <div className="detail-section">
      <div className="section-title">Tags</div>
      <div
        onClick={() => inputRef.current && inputRef.current.focus()}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          padding: '6px',
          borderRadius: '6px',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          background: 'var(--input-bg, rgba(255,255,255,0.04))',
          minHeight: '36px',
          cursor: 'text',
        }}
      >
        {tags.map((t, idx) => (
          <span key={t + idx} style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 6px 2px 8px',
            borderRadius: '4px',
            background: 'var(--accent-soft, rgba(110,193,255,0.18))',
            color: 'var(--accent, #6ec1ff)',
            fontSize: '12px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}>
            {t}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeAt(idx); }}
              title={`Remove "${t}"`}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                fontSize: '14px',
                lineHeight: 1,
                opacity: 0.7,
              }}
            >×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          list={datalistId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder={tags.length === 0 ? 'Add tags (Enter or , to confirm)' : ''}
          style={{
            flex: '1 1 80px',
            minWidth: '80px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            fontSize: '13px',
            fontFamily: 'inherit',
            padding: '2px 4px',
          }}
        />
      </div>
      <datalist id={datalistId}>
        {knownTags.filter((t) => !tags.includes(t)).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}
