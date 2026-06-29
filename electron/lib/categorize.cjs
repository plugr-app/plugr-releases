// Heuristics for categorizing audio plugins.
//
// The category lattice we use across the app:
//   Instrument / Synth, Sampler, Drums, Keys, Bass, Guitar, Orchestral, Generator
//   Effect / EQ, Dynamics, Reverb, Delay, Modulation, Distortion, Pitch,
//           Imaging, Utility, Creative, Multi-Effect, Undefined
//   MIDI                 (true MIDI processors — arpeggiators, note FX)
//   Application / DAW, Application (regular Mac apps)
//   Undefined            (genuinely unclassifiable — we don't know)
//
// "Mastering" is intentionally NOT a category — categories describe what
// a plugin DOES, not how you use it. A mastering EQ is still an EQ; a
// mastering maximizer is still a limiter (Dynamics). The full Ozone /
// Neutron suites are Multi-Effect, since they bundle many discrete tools.
//
// The MIDI top-level category does NOT have subcategories — it would force
// callers to display "MIDI / MIDI FX" which is redundant. There used to be
// an "Effect / MIDI FX" bin for AU `aumf` plugins, but that was an `aumf`
// catch-all and `aumf` is famously over-applied (most modulation plugins
// declare aumf so they can receive MIDI control). We've removed that bin
// entirely and let aumf fall through to the name heuristic.
//
// Sources of truth, in order of priority:
//   1. Explicit override in the developer registry
//   2. AU `type` codes, with cross-component prioritization (aumu > aufx >
//      aumf > aumi). When a plugin declares multiple audio components, we
//      pick the strongest signal — NOT just the first one in the array.
//   3. Keyword match on plugin name / description (expanded coverage)
//   4. "Other" only when nothing matched

// Name-based categorization rules.
//
// Order is intentional: effects first (most ambiguous terms — "bass",
// "guitar", "tape" — appear in effect plugin names more often than they
// identify a true instrument). Instrument matches require a stronger
// signal (e.g. "bass synth" not just "bass"; "guitar amp" stays in effects
// unless preceded by "synth" or "instrument").
//
// Coverage focus: any plugin whose name plainly says EQ / Comp / Limiter /
// Reverb / Delay / Chorus / Flanger / Phaser / Saturation / Tape / etc.
// must reliably land in the right subcategory. The previous rules were
// solid but missed a few obvious cases.
const NAME_RULES = [
  // ─── Effects ─────────────────────────────────────────────────────────
  { match: /\b(?:EQ|equali[sz]er|filter(?:s)?|low\s?pass|high\s?pass|band\s?pass|notch|pultec|q[1-9]|tilt(?:\s+eq)?|graphic\s+eq|parametric\s+eq|shelf|para[\s-]?eq|match[\s-]?eq|dynamic\s+eq)\b/i, category: 'Effect', subcategory: 'EQ' },
  // Dynamics now also includes maximizer / brick-wall / multiband, which
  // used to be lumped under "Mastering". A maximizer IS a limiter, no
  // matter what mixing stage you use it at.
  { match: /\b(?:comp(?:ressor|ression)?|limiter|maximi[sz]er|brick[\s-]?wall(?:\s+limiter)?|multiband(?:\s+(?:compressor|comp|limiter|dynamics))?|gate|expander|de[\s-]?ess(?:er)?|leveller|leveler|1176|la-?2a|la-?3a|ssl(?:\s+bus)?|fairchild|cl\d|optical\s+comp|vca\s+comp|bus\s+comp|opto[\s-]?comp|gain\s+reduction|transient(?:\s+shap(?:er|ing))?|attack[\s-]?release|finalizer)\b/i, category: 'Effect', subcategory: 'Dynamics' },
  { match: /\b(?:reverb|verb|hall|plate(?:\s+reverb)?|spring|room|chamber|valhalla(?:\s+verb)?|black\s?hole|raum|impulse\s+response|convolution|shimmer|cathedral|cathedrale|nimbus|reverberation|reverberate|space(?:\s+designer)?|ambient(?:\s+reverb)?)\b/i, category: 'Effect', subcategory: 'Reverb' },
  { match: /\b(?:delay|echo|tape\s+echo|tape\s+delay|repeater|memoryman|reverse\s+delay|ping[-\s]?pong|slapback|dub\s+(?:delay|echo)|repro\s+delay|stereo\s+delay|analog\s+delay|digital\s+delay|spectral\s+delay)\b/i, category: 'Effect', subcategory: 'Delay' },
  { match: /\b(?:chorus|flanger|phaser|tremolo|vibrato|rotary|leslie|ensemble|swirl|wow\s+control|auto[\s-]?pan|ring[\s-]?mod(?:ulator)?|autopanner|stereo\s+(?:phaser|flanger)|trem(?:olo)?)\b/i, category: 'Effect', subcategory: 'Modulation' },
  { match: /\b(?:distort(?:ion)?|saturat(?:or|ion|e)|fuzz|overdrive|amp[\s-]?sim(?:ulator)?|ampeg|bias\s+amp|tube\s+(?:warm|drive|preamp)|tape\s+(?:warm|sat|machine)|crunch|bit[\s-]?crush(?:er)?|decim(?:ator|ate)|exciter|wave[\s-]?shaper|transformer\s+sim|pre[\s-]?amp|lo[\s-]?fi)\b/i, category: 'Effect', subcategory: 'Distortion' },
  { match: /\b(?:auto[\s-]?tune|melodyne|harmoni[sz](?:er|ation)|pitch[\s-]?(?:shift|correct|bend)|formant|alterboy|micro[\s-]?shift|vocoder|talkbox|talk[\s-]?box)\b/i, category: 'Effect', subcategory: 'Pitch' },
  // Imaging — stereo width / imager / mid-side tools. Replaces the parts
  // of the old "Mastering" rule that fit here.
  { match: /\b(?:imager|stereo\s?(?:image|width|enhance|expand|spread|tool)|stereo[\s-]?(?:imager|enhancer|expander|widener)|mid[\s/-]?side(?:\s+(?:eq|tool|processor))?|m[\s/-]s\s+(?:eq|processor|tool)|width\s+control)\b/i, category: 'Effect', subcategory: 'Imaging' },
  // Utility — tightened. Removed plain "monitor", plain "gain", plain "trim";
  // those were over-firing. Kept the metering / analysis / specific utility
  // words that almost never appear in non-utility plugin names. Loudness
  // tools also live here (they measure, they don't process audio).
  { match: /\b(?:vu\s?meter|peak\s?meter|loudness\s?meter|loudness(?:\s+(?:standard|monitor|check|control))?|metering|spectrum\s?analy[sz]er|spectral\s?analy[sz]er|analy[sz]er(?:\s+pro)?|spectrum|correlation\s?meter|phase\s?meter|insight|spectre|vumt|gain[\s-]?(?:tool|stage|match|control|util)|stereo[\s-]?(?:tool|util)|utility|routing|patcher|landr)\b/i, category: 'Effect', subcategory: 'Utility' },
  { match: /\b(?:granular|glitch|stutter|mangle|texture|portal|effectrix|crystallizer|turnado|smear|destroy(?:er)?|warp|mangler)\b/i, category: 'Effect', subcategory: 'Creative' },
  // Multi-Effect — channel strips, mix suites, "all-in-one" bundles.
  // Runs LAST in the Effect block so a more specific keyword wins first
  // (e.g. "Ozone Maximizer" → Dynamics; bare "Ozone 9" → Multi-Effect).
  { match: /\b(?:ozone|neutron|nectar(?:\s+\d+)?|channel[\s-]?strip|chan[\s-]?strip|console\s+strip|all[\s-]?in[\s-]?one|production\s+suite|mix\s+(?:rack|suite|bus\s+rack)|master\s+suite|fx\s+chain|omni[\s-]?channel|effects\s+rack|effect\s+rack|complete\s+(?:suite|bundle)|tonal\s+balance)\b/i, category: 'Effect', subcategory: 'Multi-Effect' },

  // Bass enhancement / kick shaping / general bottom-end effects (NOT instruments)
  // Drop trailing word boundary so suffixes like "Enhancer" still match.
  { match: /\b(?:bass\s+(?:enhanc|shap|boost|station|maximize)|sub\s+(?:bass|harmonics)|low[\s-]?end\s+(?:shap|enhanc|boost)|kick[\s-]?(?:shap|punch)|fundamental\s+bass)/i, category: 'Effect', subcategory: 'Utility' },

  // ─── True MIDI processors ────────────────────────────────────────────
  // Tightened: "midi" alone is too broad. Require words that clearly
  // describe MIDI manipulation, not "Plays MIDI". No subcategory — the
  // top-level "MIDI" label is enough.
  { match: /\b(?:arpeggiat(?:or|ion)|note\s+fx|note\s+effect|midi\s+(?:effect|processor|fx|generator|filter|delay|repeat)|scaler|chord(?:\s+gen(?:erator)?)?|step\s+sequencer|note\s+repeat|ratchet|midi\s+arp|midi\s+chord|midi\s+scale)\b/i, category: 'MIDI', subcategory: null },

  // ─── Instruments ─────────────────────────────────────────────────────
  // Drums first — "battery drum module" should hit drums, not sampler.
  { match: /\b(?:drum\s+(?:machine|kit|sampler|module|instrument|library)|drum\s?kit|808\s+kit|snare\s+kit|hi[\s-]?hat\s+kit|geist|battery\s+drum|atlas\s+drums|nano\s?beast|drumlab|maschine|beat\s+(?:machine|maker))\b/i, category: 'Instrument', subcategory: 'Drums' },
  { match: /\b(?:synth(?:esi[sz]er)?|virtual\s+(?:analog|instrument)|wavetable\s+synth|fm\s+synth|massive(?:\s+x)?|serum|vital|spire|sylenth|diva|repro|hive|pigments|omnisphere|nexus|dune|phase\s+plant|monark|absynth|operator)\b/i, category: 'Instrument', subcategory: 'Synth' },
  { match: /\b(?:sampler|kontakt|halion|battery|tx16wx|decent\s?sampler|sample\s+player|romplers?|playback\s+sampler)\b/i, category: 'Instrument', subcategory: 'Sampler' },
  { match: /\b(?:piano|rhodes|wurli|wurlitzer|keyscape|noire|alicia(?:'s\s+keys)?|ravenscroft|emotional\s+piano|electric\s+piano|grand\s+piano|upright\s+piano|clavinet|harpsichord|organ|hammond|farfisa|vox\s+continental)\b/i, category: 'Instrument', subcategory: 'Keys' },
  { match: /\b(?:bass\s+(?:synth|instrument|module|guitar\s+vst)|virtual\s+bass|modo\s+bass|trilian|electric\s+bass\s+(?:vst|instrument)|upright\s+bass|fingered\s+bass|picked\s+bass)\b/i, category: 'Instrument', subcategory: 'Bass' },
  { match: /\b(?:guitar\s+(?:vst|instrument|module|library)|virtual\s+guitar|amped\s+(?:elektrik|roots)|acoustic\s+guitar\s+(?:vst|instrument)|electric\s+guitar\s+vst)\b/i, category: 'Instrument', subcategory: 'Guitar/Bass' },
  { match: /\b(?:orchestra(?:l)?|strings|brass|woodwind(?:s)?|cinematic|spitfire|symphony|symphonic|hollywood\s+(?:strings|brass|orchestra)|albion|tonebone)\b/i, category: 'Instrument', subcategory: 'Orchestral' },
];

// Audio Unit `type` codes are 4-char OSTypes. We get them as strings or as
// 32-bit integers depending on the plist. Map both forms.
//
// Each entry has a `strength` we use when a plugin declares multiple
// components — see categorize() below. Higher strength wins.
const AU_TYPE_BY_CODE = {
  // Music device (instrument) — the strongest, most specific signal.
  aumu: { category: 'Instrument', subcategory: 'Synth',     strength: 100 },
  // Generator (no audio input, produces audio) — almost always instrumental.
  augn: { category: 'Instrument', subcategory: 'Generator', strength:  95 },
  // Audio effect — strong, but the name heuristic may produce a more
  // specific subcategory ("Reverb", "Delay") that we prefer.
  aufx: { category: 'Effect',     subcategory: null,        strength:  80 },
  // Music effect (audio effect that also receives MIDI). Famously
  // over-applied: most modulation/vocoder/MIDI-controllable audio plugins
  // declare aumf. Treat as a weak audio-effect signal, never as MIDI.
  aumf: { category: 'Effect',     subcategory: null,        strength:  40 },
  // True MIDI processor (no audio I/O — input MIDI, output MIDI).
  // Strong, but lower than aumu/aufx because some instruments include
  // an aumi side-component for MIDI handling; the aufx/aumu of the same
  // bundle should win.
  aumi: { category: 'MIDI',       subcategory: null,        strength:  60 },
  // Format converter, mixer, offline processor, panner — all utility-ish.
  aufc: { category: 'Effect',     subcategory: 'Utility',   strength:  50 },
  aupn: { category: 'Effect',     subcategory: 'Utility',   strength:  50 },
  auol: { category: 'Effect',     subcategory: 'Utility',   strength:  50 },
  aumx: { category: 'Effect',     subcategory: 'Utility',   strength:  50 },
};

function fourCharCodeToString(value) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number') return null;
  // Read four bytes big-endian
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf.toString('ascii').replace(/ /g, '');
}

/** Walk every AU component and pick the strongest category signal. */
function categorizeFromAU(auComponents) {
  if (!auComponents || auComponents.length === 0) return null;
  let best = null;
  for (const c of auComponents) {
    const code = fourCharCodeToString(c.type);
    if (!code) continue;
    const def = AU_TYPE_BY_CODE[code];
    if (!def) continue;
    if (!best || def.strength > best.strength) {
      best = { code, ...def };
    }
  }
  if (!best) return null;
  return {
    category: best.category,
    subcategory: best.subcategory,
    source: 'au-type',
    auCode: best.code,
    auStrength: best.strength,
  };
}

/**
 * Insert spaces at CamelCase boundaries so single-word names like
 *   "MSpectralDelay"  → "M Spectral Delay"
 *   "MSaturator"      → "M Saturator"
 *   "MeldaProductionMSomething" → "Melda Production M Something"
 *
 * The regex word-boundary `\b` matches between a word char and a non-word
 * char only, so it WON'T fire inside CamelCase strings. Splitting at
 * lower→upper and upperRun→Upper+lower transitions reintroduces word
 * boundaries where the eye sees them.
 *
 * Names with separators ("Pro-Q 3", "Helper-Equalizer 2") are already
 * fine; this is for the no-separator case.
 */
function splitCamelCase(s) {
  if (!s) return '';
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function categorizeFromName(name, description) {
  // Search both the raw text and a CamelCase-expanded copy so a single
  // pass of word-boundary regexes catches "EQ", "Equalizer", "MSaturator",
  // "MSpectralDelay", etc. without needing per-rule special cases.
  const raw = `${name || ''} ${description || ''}`;
  const expanded = `${splitCamelCase(name || '')} ${splitCamelCase(description || '')}`;
  const haystack = `${raw} ${expanded}`;
  for (const rule of NAME_RULES) {
    if (rule.match.test(haystack)) {
      return { category: rule.category, subcategory: rule.subcategory, source: 'name-heuristic' };
    }
  }
  return null;
}

/**
 * Combine all signals to produce a final category record.
 *
 * Priority order:
 *   1. Registry override always wins.
 *   2. Apps default to Application/Application unless registry overrides.
 *   3. AU instrument (aumu / augn) — very specific, beats name.
 *   4. Name heuristic — produces precise subcategories like Reverb / Delay.
 *      Wins over weaker AU codes (aufx, aumf, aumi-when-other-codes-present).
 *   5. Whichever AU type was strongest, if any.
 *   6. "Other / Uncategorized" if nothing matched.
 */
function categorize({ bundleInfo, format, registryEntry }) {
  // Standalone .app files always stay under Application. The registry
  // can still promote them to a more specific Application subcategory
  // (DAW for Logic Pro, etc.) but it must NOT reroute them into a
  // plugin category — the .app is the standalone version of the
  // plugin, not the plugin itself, and seeding registry productMatchers
  // for the plugin (which we do at scale via tools/seed-categories.js)
  // would otherwise mislabel the companion app.
  if (format === 'App') {
    if (registryEntry && registryEntry.category === 'Application') {
      return {
        category: 'Application',
        subcategory: registryEntry.subcategory || 'Application',
        source: 'registry',
      };
    }
    return { category: 'Application', subcategory: 'Application', source: 'app' };
  }

  if (registryEntry && registryEntry.category) {
    return {
      category: registryEntry.category,
      subcategory: registryEntry.subcategory || null,
      source: 'registry',
    };
  }

  const nameSource = (bundleInfo && bundleInfo.name) || '';
  const descSource =
    (bundleInfo && bundleInfo.auComponents && bundleInfo.auComponents[0] && bundleInfo.auComponents[0].description) || '';
  const fromName = categorizeFromName(nameSource, descSource);

  const fromAU = bundleInfo && bundleInfo.auComponents
    ? categorizeFromAU(bundleInfo.auComponents)
    : null;

  // Instrument/generator codes are specific enough to beat the name.
  if (fromAU && (fromAU.auCode === 'aumu' || fromAU.auCode === 'augn')) {
    return { category: fromAU.category, subcategory: fromAU.subcategory, source: 'au-type' };
  }

  // True MIDI processor — only believe it when name AGREES or when there's
  // no other plausible audio code. The "other plausible code" check is
  // implicit: categorizeFromAU returned aumi as the strongest signal, so
  // there's no aufx/aumu/aumf in the bundle. If the name says it's a delay
  // or reverb, the name wins.
  if (fromAU && fromAU.auCode === 'aumi') {
    if (fromName && fromName.category !== 'MIDI') return fromName;
    return { category: 'MIDI', subcategory: null, source: 'au-type' };
  }

  // Otherwise prefer a precise name match.
  if (fromName) return fromName;

  // Fall back to whatever AU said. When AU told us it's an effect (aufx /
  // aumf) but the name yielded nothing specific, that's the "Effect /
  // Undefined" bucket — we know it's an effect, just not what kind.
  if (fromAU) {
    if (fromAU.category === 'Effect') {
      return { category: 'Effect', subcategory: 'Undefined', source: 'au-type' };
    }
    return {
      category: fromAU.category,
      subcategory: fromAU.subcategory === fromAU.category ? null : fromAU.subcategory,
      source: 'au-type',
    };
  }

  // Nothing matched — genuinely unknowable. Goes into the top-level
  // "Undefined" bucket so the user can sweep through and assign manually.
  return { category: 'Undefined', subcategory: null, source: 'fallback' };
}

/**
 * Pull a developer/company name from a copyright string.
 *
 * Earlier version naively stopped at the first period, which destroyed
 * names containing initials ("W. A. Production" became just "W"). This
 * version strips boilerplate tokens (©, year, "all rights reserved", legal
 * suffixes) and returns whatever's left, preserving internal punctuation
 * inside the actual name.
 *
 * Examples:
 *   "Copyright © 2024 W. A. Production. All rights reserved." → "W. A. Production"
 *   "© 2024 FabFilter B.V."                                   → "FabFilter"
 *   "(c) 2024 Cherry Audio, LLC."                             → "Cherry Audio"
 *   "© 2024 Sennheiser electronic GmbH & Co. KG"              → "Sennheiser electronic"
 */
function extractDeveloperFromCopyright(copyright) {
  if (!copyright) return null;
  let s = String(copyright);

  // Strip boilerplate tokens anywhere in the string.
  s = s.replace(/copyright/gi, ' ');
  s = s.replace(/©/g, ' ');
  s = s.replace(/\(c\)/gi, ' ');
  s = s.replace(/\d{4}(?:\s*[-–—]\s*\d{4})?/g, ' ');           // years / ranges
  s = s.replace(/\ball\s+rights\s+reserved\b\.?/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Strip leading/trailing punctuation ('&' included so "X & Co" → "X").
  s = s.replace(/^[.,;&\s]+/, '').replace(/[.,;&\s]+$/, '').trim();

  // Strip trailing legal suffixes — multiple passes handle chains like
  // "Acme & Co. KG" and "Foo, Inc. Ltd."
  const SUFFIX_RE = /[\s,]+(?:Inc\.?|L\.?L\.?C\.?|GmbH|Ltd\.?|B\.?V\.?|S\.?A\.?|Co\.?\s*KG|KG|Co\.?|Corp\.?|Corporation|Limited|Pty\.?\s?Ltd\.?|AG|N\.V\.)\.?$/i;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(SUFFIX_RE, '').replace(/[.,;&\s]+$/, '').trim();
    if (next === s) break;
    s = next;
  }

  if (!s) return null;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

/** Best-effort developer/manufacturer detection. */
function inferDeveloper({ bundleInfo, registryEntry }) {
  // Lazy-load to avoid a circular require at module load time.
  const { applyDeveloperAlias } = require('./registryLookup.cjs');

  if (registryEntry && registryEntry.developer) {
    // Registry developer keys are already canonical; no alias step needed.
    return registryEntry.developer;
  }
  if (!bundleInfo) return 'Unknown';

  const id = bundleInfo.identifier || '';
  const copyright = bundleInfo.copyright || '';

  // 1) Try the copyright string first — usually the most human-readable
  //    name (e.g. "W. A. Production"). Only fall back to identifier when
  //    copyright is absent or yielded a useless result.
  const copyGuess = extractDeveloperFromCopyright(copyright);

  // 2) From identifier (e.g. com.fabfilter.proq3 → "FabFilter"). Skip
  //    overly generic prefixes (com, org, net, app) and accept slightly
  //    shorter names than before but still require ≥ 3 chars.
  let idGuess = null;
  const idMatch = id.match(/^([a-z][a-z0-9-]+)\.([a-z][a-z0-9-]+)\./i);
  if (idMatch) {
    const top = idMatch[1].toLowerCase();
    const second = idMatch[2];
    const generic = new Set(['com', 'org', 'net', 'app', 'io', 'co', 'me', 'us', 'audio', 'plugin', 'plugins']);
    const candidate = generic.has(top) ? second : top;
    if (candidate && candidate.length >= 3) idGuess = capitalize(candidate);
  }

  // Prefer the copyright result unless it's suspiciously short (1-2 chars,
  // likely a parsing failure on a name like "U" or "W"). In that case,
  // try the identifier-based guess.
  let raw;
  if (copyGuess && copyGuess.length >= 3) raw = copyGuess;
  else if (idGuess) raw = idGuess;
  else if (copyGuess) raw = copyGuess;       // last resort, even if short
  else raw = 'Unknown';

  return applyDeveloperAlias(raw);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  categorize,
  inferDeveloper,
  fourCharCodeToString,
  categorizeFromAU,
  categorizeFromName,
  NAME_RULES,
  AU_TYPE_BY_CODE,
};
