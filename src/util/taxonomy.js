// Plugr category taxonomy — the single renderer-side source of truth for
// the AI-assisted categorization feature (CategorizeModal). Mirrors the
// lattice documented in electron/lib/categorize.cjs. Used to (a) build the
// copy-paste prompt for the user's AI and (b) validate what comes back so
// a hallucinated or malformed category never gets applied.

export const TAXONOMY = {
  Instrument: ['Synth', 'Sampler', 'Drums', 'Keys', 'Bass', 'Guitar', 'Orchestral', 'Generator'],
  Effect: ['EQ', 'Dynamics', 'Reverb', 'Delay', 'Modulation', 'Distortion', 'Pitch', 'Imaging', 'Utility', 'Creative', 'Multi-Effect'],
  MIDI: [],            // MIDI has no subcategory
  Application: ['DAW', 'Application'],
};

// Categories whose items MUST carry a subcategory to count as categorized.
// (MIDI / Application are complete at the top level.)
export const NEEDS_SUBCATEGORY = new Set(['Instrument', 'Effect']);

const norm = (s) => String(s || '').trim().toLowerCase();

// Is this item still uncategorized? Matches how the sidebar surfaces the
// "Undefined" and "Effect > Undefined" buckets.
export function isUncategorized(item) {
  const c = item && item.category;
  if (!c || c === 'Undefined' || c === 'Unknown') return true;
  if (NEEDS_SUBCATEGORY.has(c)) {
    const s = item.subcategory;
    if (!s || s === 'Undefined') return true;
  }
  return false;
}

// Validate + normalize an AI-returned {category, subcategory} against the
// taxonomy. Returns { ok, category, subcategory } or { ok:false, reason }.
export function validateAssignment(category, subcategory) {
  const catKey = Object.keys(TAXONOMY).find((k) => norm(k) === norm(category));
  if (!catKey) return { ok: false, reason: `unknown category "${category}"` };
  const subs = TAXONOMY[catKey];
  if (subs.length === 0) {
    // MIDI: subcategory is always null regardless of what came back.
    return { ok: true, category: catKey, subcategory: null };
  }
  if (!subcategory) return { ok: false, reason: `"${catKey}" needs a subcategory` };
  const subKey = subs.find((s) => norm(s) === norm(subcategory));
  if (!subKey) return { ok: false, reason: `"${subcategory}" is not a valid ${catKey} subcategory` };
  return { ok: true, category: catKey, subcategory: subKey };
}

// Build the copy-paste prompt the user hands to their own AI. Pre-loads the
// exact vocabulary + the uncategorized list, and demands strict JSON back.
export function buildPrompt(list) {
  const vocab = Object.entries(TAXONOMY)
    .map(([c, subs]) => (subs.length ? `- ${c}: ${subs.join(', ')}` : `- ${c}: (no subcategory)`))
    .join('\n');
  const rows = list.map((x) => `${x.developer} — ${x.name}`).join('\n');
  return `You are categorizing audio plugins for a music-production app. For each plugin below, assign a category and subcategory using ONLY this exact vocabulary (do not invent new ones):

${vocab}

Rules:
- Use the category/subcategory strings EXACTLY as written above (case-sensitive).
- MIDI plugins have no subcategory — use null.
- If you are genuinely unsure of a plugin, omit it from the output rather than guessing.
- Return ONLY a JSON array, no prose, no code fence. Each element: {"developer": "...", "name": "...", "category": "...", "subcategory": "..." or null}

Plugins:
${rows}`;
}

// Parse the AI's response into an array. Tolerates code fences and stray
// prose around the JSON array.
export function parseResponse(text) {
  if (!text || !text.trim()) throw new Error('Nothing pasted yet.');
  let t = text.trim();
  // Strip a ```json ... ``` fence if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // If there's prose around it, grab the outermost [ ... ].
  if (t[0] !== '[') {
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }
  let data;
  try { data = JSON.parse(t); }
  catch { throw new Error('Could not read that as JSON. Paste the full response your AI returned.'); }
  if (!Array.isArray(data)) throw new Error('Expected a JSON array of plugins.');
  return data;
}
