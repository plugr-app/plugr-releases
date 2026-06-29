import React, { useMemo, useState } from 'react';
import { displayCategory, naturalCompare } from '../util/format.js';
import MirrorPickerModal from './MirrorPickerModal.jsx';

const CUSTOM_SENTINEL = '__custom__';

/**
 * Side panel shown when the user has 2+ plugins selected (via Cmd-click
 * or Shift-click in the library). Lets them apply changes to all selected
 * plugins at once — developer rename, category change, favorite toggle,
 * extra-category add — with an explicit confirmation step before commit.
 *
 * Each field is opt-in: an empty/blank value means "don't touch this field
 * on the selected items." This matches how multi-select editors work in
 * Lightroom, Photos, etc.
 */
export default function BulkEditPanel({
  items,                       // array of selected items
  allItems,                    // full library — needed to render the mirror-from picker
  knownCategories,             // [{ category, subcategories: string[] }]
  knownTags,                   // string[] of every tag used anywhere in the library
  onClose,
  onApply,                     // (changes, items) => Promise<void>
  onAddCustomCategory,         // (cat, sub?) => void
}) {
  // Simple text input: blank = don't change, any text = set developer to
  // that value across the selected items.
  const [developer, setDeveloper] = useState('');
  const [category, setCategory] = useState('');     // '' = don't change
  const [subcategory, setSubcategory] = useState(''); // '' = don't change / no sub
  // Tri-state favorite: null = don't change, true = mark as favorite,
  // false = unmark.
  const [favoriteSet, setFavoriteSet] = useState(null);
  // Tri-state hide: null = don't change, true = hide all selected,
  // false = unhide all selected. Hiding strips them from every normal
  // list — they reappear only when the user clicks the "⊘ Hidden" row
  // in the sidebar. Useful for batch-hiding uninstallers, helper apps,
  // and demo plugins all at once.
  const [hiddenSet, setHiddenSet] = useState(null);
  const [extraCategory, setExtraCategory] = useState('');
  const [extraSubcategory, setExtraSubcategory] = useState('');
  const [busy, setBusy] = useState(false);

  // Bulk "apply update source" fields. The URL + version model mirrors the
  // single-plugin DiscoverModal manual flow: user pastes a URL and the
  // version they see on the page; the backend derives one regex once and
  // we save the same URL+regex to every selected item.
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceVersion, setSourceVersion] = useState('');
  const [sourceAdvanced, setSourceAdvanced] = useState(false);
  const [sourceRegex, setSourceRegex] = useState('');
  // Tri-state: false (default — don't touch), true (remove saved source
  // from every selected plugin). Used to clean up after a bulk-apply
  // misfire or to clear sources before re-discovering.
  const [removeSource, setRemoveSource] = useState(false);

  // Mirror-updates-from-another-plugin. Opening the picker stashes
  // the selected parent here; commit folds it into the patch as
  // mirrorFromId for every selected item.
  const [mirrorParent, setMirrorParent] = useState(null);
  const [mirrorPickerOpen, setMirrorPickerOpen] = useState(false);
  const [clearMirror, setClearMirror] = useState(false);

  // Bulk tag editing. Two independent operations applied to every
  // selected plugin:
  //   - addTags: union'd into each plugin's existing tag set
  //   - removeTags: subtracted from each plugin's existing tag set
  // Both can be set in the same operation; we apply add then remove.
  const [addTags, setAddTags] = useState([]);
  const [removeTags, setRemoveTags] = useState([]);
  const [addTagDraft, setAddTagDraft] = useState('');
  const [removeTagDraft, setRemoveTagDraft] = useState('');
  // Tags currently on at least one selected plugin — these are the
  // ones it makes sense to offer for removal. (You can't remove a
  // tag that nobody in the selection has.) Ordered by how many
  // selected plugins carry it, descending.
  const tagsOnSelection = useMemo(() => {
    const counts = new Map();
    for (const it of items) {
      if (!Array.isArray(it.tags)) continue;
      for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || naturalCompare(a[0], b[0]));
  }, [items]);

  const subOptionsForCat = useMemo(
    () => (knownCategories.find((c) => c.category === category) || {}).subcategories || [],
    [knownCategories, category],
  );
  const subOptionsForExtra = useMemo(
    () => (knownCategories.find((c) => c.category === extraCategory) || {}).subcategories || [],
    [knownCategories, extraCategory],
  );

  // Build a human-readable summary of what's about to change. Used in the
  // confirm() prompt so the user can sanity-check before committing.
  const pendingChanges = [];
  const changes = {};
  if (developer.trim()) {
    changes.developer = developer.trim();
    pendingChanges.push(`Developer → "${developer.trim()}"`);
  }
  if (category) {
    changes.category = category;
    changes.subcategory = subcategory && subcategory !== category ? subcategory : null;
    pendingChanges.push(`Category → ${changes.subcategory ? `${category} / ${changes.subcategory}` : category}`);
  }
  if (favoriteSet === true) { changes.favorite = true; pendingChanges.push('Mark as favorite ★'); }
  if (favoriteSet === false) { changes.favorite = false; pendingChanges.push('Remove favorite'); }
  if (hiddenSet === true) { changes.hidden = true; pendingChanges.push('Hide from normal lists ⊘'); }
  if (hiddenSet === false) { changes.hidden = false; pendingChanges.push('Unhide (restore to normal lists)'); }
  if (extraCategory) {
    changes.addExtraCategory = { category: extraCategory, subcategory: extraSubcategory || null };
    pendingChanges.push(`+ Extra category: ${extraSubcategory ? `${extraCategory} / ${extraSubcategory}` : extraCategory}`);
  }
  // Update source: requires URL + (version OR advanced regex). One source
  // is derived/used and applied to every selected item; perfect for the
  // VST2/VST3/AU/CLAP + Mono/Stereo variant case.
  if (addTags.length > 0) {
    changes.addTags = addTags;
    pendingChanges.push(`+ Tags: ${addTags.map((t) => `#${t}`).join(' ')}`);
  }
  if (removeTags.length > 0) {
    changes.removeTags = removeTags;
    pendingChanges.push(`− Tags: ${removeTags.map((t) => `#${t}`).join(' ')}`);
  }

  if (sourceUrl.trim() && ((sourceAdvanced && sourceRegex.trim()) || sourceVersion.trim())) {
    changes.updateSource = {
      url: sourceUrl.trim(),
      version: sourceVersion.trim(),
      regex: sourceAdvanced ? sourceRegex.trim() : '',
    };
    pendingChanges.push(`Update source → ${sourceUrl.trim()}${sourceAdvanced && sourceRegex.trim() ? ' (custom regex)' : ` (version ${sourceVersion.trim()})`}`);
  }
  if (removeSource) {
    changes.removeUpdateSource = true;
    pendingChanges.push(`Remove saved update source from ${items.length} plugin${items.length === 1 ? '' : 's'}`);
  }

  // Mirror — either set a new parent or clear the existing link.
  if (mirrorParent && mirrorParent.id) {
    changes.mirrorFromId = mirrorParent.id;
    pendingChanges.push(`Mirror updates from → ${mirrorParent.name}`);
  } else if (clearMirror) {
    changes.clearMirrorFromId = true;
    pendingChanges.push('Clear mirror link');
  }

  const hasChanges = pendingChanges.length > 0;
  const canCommit = hasChanges && !busy;

  function handleCustomCategory(setter) {
    const raw = window.prompt('Name for this custom category:', '');
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    setter(name);
    if (onAddCustomCategory) onAddCustomCategory(name);
  }
  function handleCustomSubcategory(parent, setter) {
    const raw = window.prompt(`Name for this custom ${parent} subcategory:`, '');
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    setter(name);
    if (onAddCustomCategory) onAddCustomCategory(parent, name);
  }

  async function commit() {
    if (!hasChanges) return;
    const list = items
      .slice(0, 8)
      .map((it) => `• ${it.name}${it.developer ? ` — ${it.developer}` : ''}`)
      .join('\n');
    const more = items.length > 8 ? `\n…and ${items.length - 8} more` : '';
    const summary = pendingChanges.map((c) => `  • ${c}`).join('\n');
    const ok = window.confirm(
      `Apply the following changes to ${items.length} plugin${items.length === 1 ? '' : 's'}?\n\n` +
      `${summary}\n\nAffected plugins:\n${list}${more}`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await onApply(changes, items);
    } finally {
      setBusy(false);
    }
  }

  // Categorize "common values" for quick reference up top — e.g. "All
  // selected are FabFilter" or "Mixed developers".
  const devSet = new Set(items.map((it) => it.developer));
  const catSet = new Set(items.map((it) => `${it.category}/${it.subcategory || ''}`));
  const commonDev = devSet.size === 1 ? [...devSet][0] : null;
  const commonCat = catSet.size === 1 ? items[0] : null;

  return (
    <aside className="detail-panel bulk-edit-panel" aria-label="Bulk edit selected plugins">
      <button className="close-button" onClick={onClose} aria-label="Close bulk edit">×</button>
      <div className="detail-header bulk-header">
        <div className="bulk-count">{items.length}</div>
        <div className="detail-title">
          <h2>{items.length} plugins selected</h2>
          <div className="detail-sub">
            <span>{commonDev ? commonDev : `${devSet.size} developers`}</span>
            <span className="dot-sep">·</span>
            <span>{commonCat ? displayCategory(commonCat) : `${catSet.size} categories`}</span>
          </div>
        </div>
      </div>

      <div className="bulk-help muted">
        Leave a field blank to keep it unchanged. You'll get a confirmation prompt before anything is applied.
      </div>

      <div className="detail-section">
        <div className="section-title">Developer</div>
        <input
          className="dev-input"
          type="text"
          list="known-developers-dl"
          placeholder={commonDev ? `Current: ${commonDev} — leave blank to keep` : 'Leave blank to keep mixed developers'}
          value={developer}
          onChange={(e) => setDeveloper(e.target.value)}
        />
      </div>

      <div className="detail-section">
        <div className="section-title">Category</div>
        <div className="cat-edit">
          <select
            value={category}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) { handleCustomCategory((name) => { setCategory(name); setSubcategory(''); }); return; }
              setCategory(v);
              const subs = (knownCategories.find((c) => c.category === v) || {}).subcategories || [];
              setSubcategory(subs.length ? '' : '');     // user picks sub manually
            }}
          >
            <option value="">— don't change —</option>
            {knownCategories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
            <option value={CUSTOM_SENTINEL}>+ Custom category…</option>
          </select>
          <select
            value={subcategory}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) { handleCustomSubcategory(category, setSubcategory); return; }
              setSubcategory(v);
            }}
            disabled={!category}
          >
            <option value="">— none —</option>
            {subOptionsForCat.map((s) => <option key={s} value={s}>{s}</option>)}
            {category && <option value={CUSTOM_SENTINEL}>+ Custom subcategory…</option>}
          </select>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">Favorite</div>
        <div className="bulk-fav-row">
          <label className="radio-pill">
            <input type="radio" name="bulkfav" checked={favoriteSet === null} onChange={() => setFavoriteSet(null)} />
            Don't change
          </label>
          <label className="radio-pill">
            <input type="radio" name="bulkfav" checked={favoriteSet === true} onChange={() => setFavoriteSet(true)} />
            ★ Mark favorite
          </label>
          <label className="radio-pill">
            <input type="radio" name="bulkfav" checked={favoriteSet === false} onChange={() => setFavoriteSet(false)} />
            ☆ Remove favorite
          </label>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">Hidden</div>
        <div className="bulk-fav-row">
          <label className="radio-pill">
            <input type="radio" name="bulkhidden" checked={hiddenSet === null} onChange={() => setHiddenSet(null)} />
            Don't change
          </label>
          <label className="radio-pill">
            <input type="radio" name="bulkhidden" checked={hiddenSet === true} onChange={() => setHiddenSet(true)} />
            ⊘ Hide all
          </label>
          <label className="radio-pill">
            <input type="radio" name="bulkhidden" checked={hiddenSet === false} onChange={() => setHiddenSet(false)} />
            Unhide all
          </label>
        </div>
        <div className="muted micro" style={{ marginTop: 4 }}>
          Hidden plugins are removed from every normal list. You can bring
          them back any time from the "⊘ Hidden" row in the sidebar.
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">Add extra category</div>
        <div className="cat-edit add-extra">
          <select
            value={extraCategory}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) { handleCustomCategory((name) => { setExtraCategory(name); setExtraSubcategory(''); }); return; }
              setExtraCategory(v);
              setExtraSubcategory('');
            }}
          >
            <option value="">— don't add —</option>
            {knownCategories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
            <option value={CUSTOM_SENTINEL}>+ Custom category…</option>
          </select>
          <select
            value={extraSubcategory}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) { handleCustomSubcategory(extraCategory, setExtraSubcategory); return; }
              setExtraSubcategory(v);
            }}
            disabled={!extraCategory}
          >
            <option value="">— none —</option>
            {subOptionsForExtra.map((s) => <option key={s} value={s}>{s}</option>)}
            {extraCategory && <option value={CUSTOM_SENTINEL}>+ Custom subcategory…</option>}
          </select>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">Tags</div>
        <div className="muted micro" style={{ marginBottom: 6 }}>
          Apply tag changes to every selected plugin. Adding a tag
          unions it into each plugin's existing tags; removing
          subtracts. Both ops can be queued together.
        </div>
        <ChipInputRow
          label="Add tag(s) to all"
          placeholder={addTags.length ? '' : 'Type a tag, Enter / , to confirm'}
          chips={addTags}
          chipColor="add"
          draft={addTagDraft}
          setDraft={setAddTagDraft}
          onAdd={(t) => {
            const nv = t.trim().toLowerCase();
            if (!nv || addTags.includes(nv)) return;
            setAddTags([...addTags, nv]);
          }}
          onRemoveChip={(t) => setAddTags(addTags.filter((x) => x !== t))}
          suggestions={(knownTags || []).filter((t) => !addTags.includes(t))}
          datalistId="bulk-add-tag-suggestions"
        />
        {tagsOnSelection.length > 0 && (
          <>
            <div className="muted micro" style={{ marginTop: 10, marginBottom: 4 }}>
              Tags currently on selected — click to mark for removal:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {tagsOnSelection.map(([t, n]) => {
                const queued = removeTags.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      if (queued) setRemoveTags(removeTags.filter((x) => x !== t));
                      else setRemoveTags([...removeTags, t]);
                    }}
                    title={`On ${n} of ${items.length} selected`}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                      background: queued
                        ? 'var(--danger-soft, rgba(239,154,154,0.18))'
                        : 'transparent',
                      color: queued ? 'var(--danger, #ef9a9a)' : 'inherit',
                      fontSize: '12px',
                      cursor: 'pointer',
                      textDecoration: queued ? 'line-through' : 'none',
                    }}
                  >
                    {queued ? '−' : '×'} #{t}
                    <span style={{ marginLeft: '6px', opacity: 0.5, fontSize: '10px' }}>{n}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="detail-section">
        <div className="section-title">Update source</div>
        <div className="muted micro" style={{ marginBottom: 6 }}>
          Apply the same update source to every selected plugin. Useful for plugins
          whose names differ across formats (e.g. <code>Chorus 4 VST(Mono)</code> vs
          <code> Chorus 4 VST3(Stereo)</code>) where auto-propagation can't tell
          they're the same product.
        </div>
        <label>
          <span className="micro muted">Update page URL</span>
          <input
            className="dev-input"
            type="url"
            placeholder="https://developer.example.com/products/this-plugin"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        </label>
        <label style={{ marginTop: 6 }}>
          <span className="micro muted">Current version shown on that page</span>
          <input
            className="dev-input"
            type="text"
            placeholder="e.g., 1.15.3"
            value={sourceVersion}
            onChange={(e) => setSourceVersion(e.target.value)}
          />
        </label>
        <details
          className="discover-advanced"
          open={sourceAdvanced}
          onToggle={(e) => setSourceAdvanced(e.currentTarget.open)}
          style={{ marginTop: 6 }}
        >
          <summary>Advanced: enter a regex by hand</summary>
          <label>
            <span className="micro muted">Version pattern (regex)</span>
            <input
              className="dev-input mono"
              type="text"
              placeholder="Version\s+(\d+\.\d+(?:\.\d+)?)"
              value={sourceRegex}
              onChange={(e) => setSourceRegex(e.target.value)}
            />
            <div className="muted micro">
              Optional. If filled, this overrides the auto-derived pattern.
              The first capture group becomes the version.
            </div>
          </label>
        </details>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={removeSource}
              onChange={(e) => setRemoveSource(e.target.checked)}
            />
            <span>
              <strong style={{ color: 'var(--danger, #c33)' }}>Remove saved update source</strong>
              <div className="muted micro">
                Clears the saved URL + version pattern from every selected plugin.
                Useful for cleaning up after a misfired "Apply to N more" — the plugins
                fall back to their bundled-registry source (or No source).
              </div>
            </span>
          </label>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title">Mirror updates from another plugin</div>
        <div className="muted micro" style={{ marginBottom: 6 }}>
          Use when every selected plugin shares a release schedule with
          one other plugin (e.g. all your Avid bundle plugins mirror
          Pro Tools). The mirrored child borrows the parent's update
          status — no need to detect a version per plugin.
        </div>
        {mirrorParent ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}>
            <span style={{ flex: 1 }}>
              <strong>{mirrorParent.name}</strong>
              <span className="muted"> · {mirrorParent.developer || 'Unknown'}</span>
            </span>
            <button type="button" className="linkish" onClick={() => setMirrorPickerOpen(true)}>Change</button>
            <button type="button" className="linkish danger" onClick={() => { setMirrorParent(null); }}>Clear</button>
          </div>
        ) : clearMirror ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}>
            <span style={{ flex: 1 }} className="muted">Will remove any existing mirror link from the selected plugins.</span>
            <button type="button" className="linkish" onClick={() => setClearMirror(false)}>Undo</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setMirrorPickerOpen(true)}>
              Pick a plugin to mirror from…
            </button>
            <button type="button" className="linkish" onClick={() => setClearMirror(true)} title="Remove any existing mirror link from these plugins">
              Remove existing mirror
            </button>
          </div>
        )}
      </div>

      <div className="detail-section">
        <div className="bulk-selected-list">
          <div className="section-title">Affected plugins ({items.length})</div>
          <ul className="bulk-list">
            {items.slice(0, 30).map((it) => (
              <li key={it.id} title={it.path}>
                <span className="bulk-list-name">{it.name}</span>
                <span className="muted"> — {it.developer || 'Unknown'}</span>
              </li>
            ))}
            {items.length > 30 && (
              <li className="muted">…and {items.length - 30} more</li>
            )}
          </ul>
        </div>
      </div>

      <div className="bulk-actions">
        <button className="btn primary" onClick={commit} disabled={!canCommit}>
          {busy ? 'Applying…' : `Apply to ${items.length} plugin${items.length === 1 ? '' : 's'}`}
        </button>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      </div>

      {mirrorPickerOpen && items.length > 0 && (
        <MirrorPickerModal
          item={items[0]}
          allItems={allItems || []}
          onClose={() => setMirrorPickerOpen(false)}
          onPick={(parent) => {
            setMirrorParent(parent);
            setClearMirror(false);
            setMirrorPickerOpen(false);
          }}
        />
      )}
    </aside>
  );
}

// Compact chip-input row used by the bulk tag editor. Same UX as the
// DetailPanel TagInput (Enter / comma / Tab confirm, Backspace removes
// trailing chip) but rendered inline as part of a section rather than
// in its own bordered card.
function ChipInputRow({ label, placeholder, chips, chipColor, draft, setDraft, onAdd, onRemoveChip, suggestions, datalistId }) {
  const isAdd = chipColor === 'add';
  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (!draft.trim()) return;
      e.preventDefault();
      onAdd(draft);
      setDraft('');
    } else if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      e.preventDefault();
      onRemoveChip(chips[chips.length - 1]);
    }
  }
  function onBlur() {
    if (draft.trim()) {
      onAdd(draft);
      setDraft('');
    }
  }
  return (
    <div>
      <span className="micro muted">{label}</span>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px',
        padding: '6px', marginTop: '2px',
        borderRadius: '6px',
        border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
        background: 'var(--input-bg, rgba(255,255,255,0.04))',
        minHeight: '34px',
      }}>
        {chips.map((t) => (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px 2px 8px', borderRadius: '4px',
            background: isAdd
              ? 'var(--accent-soft, rgba(110,193,255,0.18))'
              : 'var(--danger-soft, rgba(239,154,154,0.18))',
            color: isAdd
              ? 'var(--accent, #6ec1ff)'
              : 'var(--danger, #ef9a9a)',
            fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap',
          }}>
            #{t}
            <button
              type="button"
              onClick={() => onRemoveChip(t)}
              title={`Remove #${t} from this queue`}
              style={{
                background: 'transparent', border: 'none', color: 'inherit',
                cursor: 'pointer', padding: 0, fontSize: '14px', lineHeight: 1, opacity: 0.7,
              }}
            >×</button>
          </span>
        ))}
        <input
          type="text"
          list={datalistId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder={placeholder}
          style={{
            flex: '1 1 80px', minWidth: '80px',
            background: 'transparent', border: 'none', outline: 'none',
            color: 'inherit', fontSize: '13px', fontFamily: 'inherit',
            padding: '2px 4px',
          }}
        />
      </div>
      {suggestions && suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((t) => <option key={t} value={t} />)}
        </datalist>
      )}
    </div>
  );
}
