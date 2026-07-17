import React, { useMemo, useState } from 'react';
import { TAXONOMY, isUncategorized, validateAssignment, buildPrompt, parseResponse } from '../util/taxonomy.js';

// AI-assisted categorization (Tier 2 of the crowd-sourced categorization
// plan, CLAUDE.md §16). Fully local + self-contained: Plugr builds a
// copy-paste prompt pre-loaded with its exact category vocabulary and the
// user's uncategorized plugins; the user runs it through their own AI
// (ChatGPT/Claude/etc.), pastes the answer back, and Plugr VALIDATES every
// returned category against the taxonomy before applying it as local
// overrides. Nothing leaves the machine and nothing invalid is applied.
export default function CategorizeModal({ open, onClose, items, onApply }) {
  const [phase, setPhase] = useState('start');   // 'start' | 'applying' | 'done'
  const [response, setResponse] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);    // { applied, skipped:[{label,reason}] }
  const [copied, setCopied] = useState(false);

  // Deduped list of uncategorized products (by developer + name) — the same
  // plugin across VST3/AU/AAX is one line, but we apply to every format.
  const uncategorized = useMemo(() => {
    const seen = new Map();
    for (const it of (items || [])) {
      if (!isUncategorized(it)) continue;
      const key = `${(it.developer || '').toLowerCase()}|${(it.name || '').toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, { developer: it.developer || 'Unknown', name: it.name || '' });
    }
    return [...seen.values()].sort((a, b) => (a.developer + a.name).localeCompare(b.developer + b.name));
  }, [items]);

  const prompt = useMemo(() => buildPrompt(uncategorized), [uncategorized]);

  if (!open) return null;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can select the text manually */ }
  }

  async function apply() {
    setError(null);
    let parsed;
    try { parsed = parseResponse(response); }
    catch (e) { setError(e.message); return; }

    // Index library items by developer|name for matching.
    const byKey = new Map();
    for (const it of (items || [])) {
      const key = `${(it.developer || '').toLowerCase()}|${(it.name || '').toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }

    const assignments = [];       // { id, category, subcategory }
    const skipped = [];           // { label, reason }
    const appliedKeys = new Set();
    for (const row of parsed) {
      const dev = row && (row.developer || row.dev);
      const name = row && row.name;
      const label = `${dev || '?'} — ${name || '?'}`;
      if (!dev || !name) { skipped.push({ label, reason: 'missing developer or name' }); continue; }
      const v = validateAssignment(row.category, row.subcategory);
      if (!v.ok) { skipped.push({ label, reason: v.reason }); continue; }
      const key = `${String(dev).toLowerCase()}|${String(name).toLowerCase()}`;
      const matches = byKey.get(key);
      if (!matches || matches.length === 0) { skipped.push({ label, reason: 'no matching plugin in your library' }); continue; }
      for (const it of matches) assignments.push({ id: it.id, category: v.category, subcategory: v.subcategory });
      appliedKeys.add(key);
    }

    if (assignments.length === 0) {
      setError('Nothing could be applied — none of the entries matched your library or passed validation.' + (skipped.length ? ` (${skipped.length} skipped)` : ''));
      return;
    }

    setPhase('applying');
    try {
      await onApply(assignments);
    } catch (e) {
      setError('Failed to apply: ' + String((e && e.message) || e));
      setPhase('start');
      return;
    }
    setResult({ applied: appliedKeys.size, formats: assignments.length, skipped });
    setPhase('done');
  }

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Categorize plugins">
      <div className="discover-modal">
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <div className="discover-head">
          <div className="detail-art cat-effect"><span className="fmt-text">✨</span></div>
          <div className="discover-head-text">
            <h2>Categorize undefined plugins</h2>
            <div className="muted">{uncategorized.length} uncategorized {uncategorized.length === 1 ? 'plugin' : 'plugins'} · uses your own AI, stays on your Mac</div>
          </div>
        </div>

        {phase === 'start' && uncategorized.length === 0 && (
          <div className="discover-status found"><span className="check">✓</span> Everything in your library already has a category. Nothing to do here.</div>
        )}

        {phase === 'start' && uncategorized.length > 0 && (
          <>
            <div className="discover-status">
              <div>
                <div className="discover-status-title">1 · Copy this prompt into your AI</div>
                <div className="muted">Paste it into ChatGPT, Claude, or any assistant. It already contains Plugr's exact category list and your uncategorized plugins — nothing else about your library leaves your Mac.</div>
              </div>
            </div>
            <div className="discover-fields">
              <label>
                <span>Prompt</span>
                <textarea className="dev-input mono" readOnly rows={7} value={prompt} onFocus={(e) => e.target.select()} style={{ resize: 'vertical' }} />
              </label>
              <div>
                <button type="button" className="btn" onClick={copyPrompt}>{copied ? 'Copied ✓' : 'Copy prompt'}</button>
              </div>
              <label>
                <span>2 · Paste your AI's answer here</span>
                <textarea
                  className="dev-input mono"
                  rows={6}
                  placeholder='[ { "developer": "...", "name": "...", "category": "...", "subcategory": "..." }, ... ]'
                  value={response}
                  onChange={(e) => { setResponse(e.target.value); if (error) setError(null); }}
                  style={{ resize: 'vertical' }}
                />
                <div className="muted micro">Plugr checks every entry against its own category list — anything invalid or unrecognized is skipped, never applied.</div>
              </label>
              {error && (
                <div className="discover-status notfound" style={{ marginTop: 4 }}>
                  <span className="warn" aria-hidden="true">!</span>
                  <div>{error}</div>
                </div>
              )}
            </div>
          </>
        )}

        {phase === 'applying' && <div className="discover-status searching"><div className="spinner" /> Applying categories…</div>}

        {phase === 'done' && result && (
          <div className="discover-status found" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <div><span className="check">✓</span> Applied categories to <strong>{result.applied}</strong> {result.applied === 1 ? 'plugin' : 'plugins'}{result.formats > result.applied ? ` (${result.formats} across all formats)` : ''}.</div>
            {result.skipped.length > 0 && (
              <details style={{ width: '100%' }}>
                <summary className="muted micro">{result.skipped.length} skipped — click to see why</summary>
                <div className="muted micro" style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
                  {result.skipped.map((s, i) => (<div key={i}>• {s.label} — {s.reason}</div>))}
                </div>
              </details>
            )}
            <div className="muted micro">You can fine-tune any of these any time from a plugin's detail panel.</div>
          </div>
        )}

        <div className="discover-footer">
          <button className="btn ghost" onClick={onClose}>{phase === 'done' ? 'Done' : 'Cancel'}</button>
          {phase === 'start' && uncategorized.length > 0 && (
            <button className="btn primary" onClick={apply} disabled={!response.trim()}>Apply categories</button>
          )}
        </div>
      </div>
    </div>
  );
}
