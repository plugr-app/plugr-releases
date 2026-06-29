// Ableton Live project parser (.als files).
//
// .als is a gzipped XML document describing the entire Live set. Third-party
// plugins live under wrapper elements that look roughly like:
//
//   <PluginDevice Id="...">
//     <PluginDesc>
//       <Vst3PluginInfo Id="N">
//         <Name Value="Pro-Q 3" />
//         <DeviceId Value="ABCDEF..." />
//         ...
//       </Vst3PluginInfo>
//     </PluginDesc>
//   </PluginDevice>
//
// VST2 uses <VstPluginInfo> with <PlugName> + <UniqueId>; AU uses
// <AuPluginInfo> with <Name> + <Manu> + <Type> + <SubType> (the four-CC
// AudioUnit identifier). All three formats follow the same Value-attribute
// convention.
//
// We use a streaming SAX parser because .als files can be tens of MB once
// uncompressed; reading the whole DOM is wasteful when we only care about
// a handful of leaf attributes.

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const sax = require('sax');
const { findBouncesFor } = require('./bounces.cjs');

const gunzip = promisify(zlib.gunzip);

// Convert Ableton's 0–11 root-note integer to a note name. Index 0 = C
// per the Live convention. We pick sharps over flats because that's
// how Ableton itself displays them in the UI.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Build a human-readable key label from the parsed scale data.
 * Examples: { tonic: 0, name: 'Major' } → "C Major".
 *           { tonic: 7, name: 'Minor' } → "G Minor".
 *           { tonic: 6, name: 'Dorian' } → "F# Dorian".
 *           { name: 'Major' }            → "Major"   (tonic missing).
 *           { tonic: 3 }                 → "D#"      (mode missing).
 * Returns null when nothing was captured at all.
 */
function formatKey(scale) {
  if (!scale) return null;
  const root = (typeof scale.tonic === 'number') ? NOTE_NAMES[scale.tonic] : null;
  // Strip any redundant root prefix Live sometimes embeds in Name
  // ("C Major" → "Major") so we don't end up with "C C Major".
  let mode = (scale.name || '').trim();
  if (mode && root) {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mode = mode.replace(new RegExp('^' + escapedRoot + '\\s+', 'i'), '');
  }
  // Ableton 12 sometimes stores the scale's "Name" field as a numeric
  // ID ("0", "1", "12") rather than a human-readable mode name —
  // those IDs are internal enum values we have no mapping for. Drop
  // them so we don't render gibberish like "C 0"; if all we have is
  // a numeric ID with no root, the whole field becomes null.
  if (mode && /^-?\d+$/.test(mode)) mode = '';
  if (root && mode) return `${root} ${mode}`;
  if (root) return root;
  if (mode) return mode;
  return null;
}

/**
 * Parse a single .als file. Returns:
 *   {
 *     name: 'Project name (basename without .als)',
 *     dawType: 'ableton',
 *     lastModified: 'ISO timestamp',
 *     plugins: [{ name, identifier?, format, count }],
 *     totalPluginInstances: N,
 *   }
 *
 * Throws if the file isn't a valid gzipped XML.
 */
async function parseAbletonProject(filePath) {
  const stat = await fs.stat(filePath);
  const buf = await fs.readFile(filePath);
  // .als is gzipped. If somebody passes us an already-decompressed XML
  // (unlikely but defensive), pass through.
  let xml;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const decompressed = await gunzip(buf);
    xml = decompressed.toString('utf8');
  } else {
    xml = buf.toString('utf8');
  }

  // Tally plugins by (format + identifier-or-name).
  const byKey = new Map();
  function recordPlugin({ name, identifier, format }) {
    if (!name && !identifier) return;
    const key = (format || '?') + '|' + (identifier || name).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: name || identifier || '(unknown)',
        identifier: identifier || null,
        format: format || null,
        count: 0,
      });
    }
    byKey.get(key).count++;
    // First-seen name wins when both are present, but if we later
    // discover a longer name (rare), keep it.
    const existing = byKey.get(key);
    if (name && (!existing.name || existing.name.length < name.length)) {
      existing.name = name;
    }
  }

  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true });
    // Track which plugin-info wrapper we're currently inside (if any).
    // Stack-of-one is enough — Ableton doesn't nest these.
    let activeInfo = null;          // 'vst3' | 'vst2' | 'au' | null
    let pending = null;             // accumulating fields for the current plugin

    // Project-level scalars we extract once. Tempo comes from the
    // <Tempo><Manual Value="..."/></Tempo> structure inside the master
    // track; we just watch for the first <Tempo>-then-<Manual> pair
    // (subsequent <Tempo> elements appear on automation tracks but
    // the first one is always the project master).
    let projectTempo = null;
    let inTempo = false;
    let tempoCaptured = false;

    // Project key (Ableton Live 12+ adds a project-wide scale via
    // <ScaleInformation> or <KeySignature> wrappers). The wrappers
    // carry <RootNote Value="N"/> or <Tonic Value="N"/> (0=C, 1=C#,
    // …, 11=B) and a <Name Value="Major"/> child (or <Scale Value=…>).
    //
    // IMPORTANT: these wrappers ALSO appear inside MIDI/audio clips
    // for Live's per-clip Scale awareness feature, which has been
    // around since Live 10. If we grab the first one we see, we'll
    // pick up a random clip's scale and treat it as the project
    // scale. To avoid that, we track whether we're currently inside
    // a clip/track wrapper, and only honor scale tags at the project
    // root (i.e. when `clipDepth === 0`). Older projects (pre-Live
    // 12) had no project-level scale concept, so they should report
    // null — which the UI shows as "no key set" instead of fabricating
    // "C Major" from clip data.
    let inScale = false;
    let scaleCaptured = false;
    let pendingScale = null;        // { tonic?: 0-11, name?: 'Major'|… }
    // Live 12 ALWAYS writes a project-level <ScaleInformation> into every
    // .als (defaulting to Root=0/Name=0 = C Major) even when the user
    // never touched the scale toggle. The actual "scale awareness is on"
    // signal is a separate sibling element: <InKey Value="true|false"/>.
    // Only treat the captured scale as real when this flag is true.
    // Captured at LiveSet root level (clipDepth === 0); per-clip InKey
    // elements lower in the file are ignored.
    let projectInKey = false;
    let clipDepth = 0;              // > 0 means we're inside a clip/track

    // Project-level scale was added in Live 12. Anything older NEVER
    // had project scale data — any <ScaleInformation> / <KeySignature>
    // found in such a file is per-clip Scale awareness leakage we must
    // suppress. We grab `MajorVersion` from the root <Ableton> element
    // and use it as a hard veto at the end. Stays null until we've
    // seen the root tag (sax fires onopentag in order so this races
    // any scale parsing, but the final emit waits for parser.onend so
    // we always have the value by then).
    let liveMajorVersion = null;
    // Full user-facing version string from the <Ableton> root element's
    // Creator attribute (e.g. "Ableton Live 12.0.5"). Surfaced in the
    // UI so users can see which Live build last saved this project.
    let liveCreator = null;

    // Tags that, when entered, indicate we're inside a clip/track or
    // other non-project-root context — scale info found here is per-
    // clip, NOT the project scale, so we suppress it. The set is
    // intentionally broad to cover the various ways Live nests these
    // across versions. Includes MasterTrack / PreHearTrack because
    // Live can keep clip-style metadata on those special tracks too.
    const CLIP_CONTEXT_TAGS = new Set([
      'MidiClip', 'AudioClip',
      'MidiTrack', 'AudioTrack', 'ReturnTrack', 'GroupTrack',
      'MasterTrack', 'PreHearTrack',
      'ClipSlot', 'ClipSlotList',
      'Clips', 'ClipsListWrapper',
      'TakeLanes', 'TakeLane',
      'Arrangement', 'AutomationEnvelopes',
    ]);

    parser.onerror = (err) => reject(err);
    parser.onopentag = (node) => {
      // The first tag in any .als XML is <Ableton …>. Pull the user-
      // facing Live version from MinorVersion (e.g. "12.0_433") or
      // from Creator ("Ableton Live 12.0.5"). NOTE: the MajorVersion
      // attribute looks like the obvious choice but isn't — it's a
      // *schema* version (still "5" in both Live 11 and Live 12), so
      // reading it would always say "5" and incorrectly veto every
      // Live-12 file. MinorVersion / Creator are where the actual
      // Live version number lives.
      if (liveMajorVersion === null && node.name === 'Ableton') {
        const attrs = node.attributes || {};
        const minor = attrs.MinorVersion;
        if (minor) {
          const m = String(minor).match(/^(\d+)/);
          if (m) liveMajorVersion = Number(m[1]);
        }
        if (liveMajorVersion === null && attrs.Creator) {
          const m = String(attrs.Creator).match(/Live\s+(\d+)/i);
          if (m) liveMajorVersion = Number(m[1]);
        }
        // Capture the full display string Live writes into Creator
        // (e.g. "Ableton Live 12.0.5"). This is the canonical user-
        // facing version. Fall back to MinorVersion ("12.0_433") only
        // when Creator is absent.
        if (typeof attrs.Creator === 'string' && attrs.Creator.trim()) {
          liveCreator = attrs.Creator.trim();
        } else if (typeof minor === 'string' && minor.trim()) {
          liveCreator = `Ableton Live ${minor.trim()}`;
        }
      }
      // Maintain the clip-depth stack so scale capture knows whether
      // we're at the project root (depth 0) or nested in clip data.
      if (CLIP_CONTEXT_TAGS.has(node.name)) clipDepth += 1;

      switch (node.name) {
        case 'Vst3PluginInfo':
          activeInfo = 'vst3';
          pending = { format: 'VST3' };
          break;
        case 'VstPluginInfo':
          activeInfo = 'vst2';
          pending = { format: 'VST2' };
          break;
        case 'AuPluginInfo':
          activeInfo = 'au';
          pending = { format: 'AU' };
          break;
        case 'Tempo':
          // Only capture the FIRST <Tempo> we see — that's the
          // project master tempo. Later <Tempo> elements appear on
          // automation tracks or per-clip warp markers.
          if (!tempoCaptured) inTempo = true;
          break;
        case 'ScaleInformation':
        case 'KeySignature':
        case 'ProjectKey':
          // ONLY capture when we're at the project root. Inside any
          // track or clip wrapper, this is per-clip Scale awareness
          // data — which we want to ignore for the project-level key.
          if (!scaleCaptured && clipDepth === 0) {
            inScale = true;
            pendingScale = {};
          }
          break;
        case 'InKey':
          // Live 12's project-level scale-awareness toggle. Captured only
          // at the project root (clipDepth === 0); the same element name
          // also appears on every individual clip and we don't want
          // those to flip our project-wide flag.
          if (clipDepth === 0) {
            const v = node.attributes && node.attributes.Value;
            if (v != null) {
              projectInKey = String(v).toLowerCase() === 'true';
            }
          }
          break;
        default:
          // Tempo capture: only the <Manual Value="N"/> child of the
          // master <Tempo> element. Cast to Number; reject NaN /
          // negative (which would indicate we picked up a different
          // <Manual> by accident).
          if (inTempo && !tempoCaptured && node.name === 'Manual') {
            const v = node.attributes && node.attributes.Value;
            const n = v != null ? Number(v) : NaN;
            if (Number.isFinite(n) && n > 0 && n < 2000) {
              projectTempo = Math.round(n * 100) / 100;
              tempoCaptured = true;
              inTempo = false;
            }
          }
          // Scale capture: inside ScaleInformation/KeySignature/
          // ProjectKey we look for the tonic index and the scale
          // name. Different Live versions and per-clip vs project
          // scopes use slightly different child element names, so
          // we accept any of these synonyms.
          if (inScale && pendingScale) {
            const v = node.attributes && node.attributes.Value;
            if (v != null) {
              if (node.name === 'RootNote' || node.name === 'Tonic' || node.name === 'Root') {
                const n = Number(v);
                if (Number.isFinite(n) && n >= 0 && n <= 11) pendingScale.tonic = n;
              } else if (node.name === 'Name' || node.name === 'Scale' || node.name === 'ScaleName') {
                pendingScale.name = String(v);
              }
            }
          }
          // Attributes inside an active plugin-info wrapper.
          if (!activeInfo || !pending) return;
          // Most relevant attributes carry their value on a "Value"
          // attribute. We pluck by node name.
          const v = node.attributes && node.attributes.Value;
          if (v == null) return;
          if (activeInfo === 'vst3') {
            if (node.name === 'Name')      pending.name = String(v);
            else if (node.name === 'DeviceId') pending.identifier = String(v);
          } else if (activeInfo === 'vst2') {
            if (node.name === 'PlugName') pending.name = String(v);
            else if (node.name === 'UniqueId') pending.identifier = 'vst2:' + String(v);
          } else if (activeInfo === 'au') {
            if (node.name === 'Name')      pending.name = String(v);
            else if (node.name === 'Manu') pending.manu = String(v);
            else if (node.name === 'Type') pending.type = String(v);
            else if (node.name === 'SubType') pending.subType = String(v);
          }
          break;
      }
    };
    parser.onclosetag = (tagName) => {
      // Mirror the depth stack on close — must happen before the
      // scale-finalize check below so we don't get off-by-one.
      if (CLIP_CONTEXT_TAGS.has(tagName) && clipDepth > 0) clipDepth -= 1;

      if (inTempo && tagName === 'Tempo') inTempo = false;
      if (inScale && (tagName === 'ScaleInformation' || tagName === 'KeySignature' || tagName === 'ProjectKey')) {
        // Finalize. Require at least one captured field (Live 11 and
        // older sometimes emit an empty <KeySignature/> placeholder we
        // need to ignore).
        //
        // We DON'T set scaleCaptured here directly — we let the post-
        // parse finalization check projectInKey first, since Live 12
        // writes a ScaleInformation block into every file regardless
        // of whether the user actually enabled scale awareness. The
        // <InKey> sibling element is the real "user enabled this" flag.
        if (pendingScale && (pendingScale.tonic != null || pendingScale.name)) {
          scaleCaptured = true;
        }
        inScale = false;
      }
      // Closing the wrapper we tracked — finalize and reset.
      if (
        (activeInfo === 'vst3' && tagName === 'Vst3PluginInfo') ||
        (activeInfo === 'vst2' && tagName === 'VstPluginInfo') ||
        (activeInfo === 'au'   && tagName === 'AuPluginInfo')
      ) {
        if (activeInfo === 'au' && pending && (pending.manu || pending.type || pending.subType)) {
          // Compose a stable 4-char AU identifier: type:subType:manu.
          pending.identifier = ['au', pending.type, pending.subType, pending.manu]
            .filter(Boolean).join(':');
        }
        recordPlugin(pending || {});
        activeInfo = null;
        pending = null;
      }
    };
    parser.onend = async () => {
      const plugins = [...byKey.values()].sort((a, b) =>
        b.count - a.count || a.name.localeCompare(b.name),
      );
      const totalPluginInstances = plugins.reduce((n, p) => n + p.count, 0);
      const projectName = path.basename(filePath, path.extname(filePath));
      // Bounce discovery is async I/O — we await it before resolving
      // so the cached project record has bounces ready to render.
      let bounces = [];
      try {
        bounces = await findBouncesFor(filePath, projectName);
      } catch { /* tolerate — bounces are best-effort */ }
      resolve({
        name: projectName,
        dawType: 'ableton',
        lastModified: stat.mtime.toISOString(),
        plugins,
        totalPluginInstances,
        bounces,
        // Tempo in BPM (number), or null if not captured (older Live
        // files without a master tempo node, or files where the
        // first <Tempo> didn't carry a <Manual> child for whatever
        // reason).
        tempo: projectTempo,
        // Display string like "C Major" or "F# Minor", or null if
        // the project was saved before Live 12's project scale
        // feature existed. We veto any captured scale data when the
        // file is pre-Live-12 — project-level scale literally did not
        // exist before then, so any value we extracted is a clip
        // leak we want to suppress. Unknown MajorVersion (very rare)
        // is allowed through; the clip-depth tracking handles those.
        // Key gating rules:
        //   1. Pre-Live-12 files: null (project-level scale didn't exist).
        //   2. Live 12+: require projectInKey === true. Live 12 writes a
        //      default ScaleInformation (Root=0/Name=0 → C Major) into
        //      EVERY .als regardless of whether the user touched the
        //      scale toggle. The sibling <InKey> element is the only
        //      reliable "user actually enabled this" signal — if it's
        //      false, we ignore the captured data.
        key: (
          (liveMajorVersion != null && liveMajorVersion < 12)
            ? null
            : formatKey((scaleCaptured && projectInKey) ? pendingScale : null)
        ),
        // User-facing DAW version (the Creator attribute), e.g. "Ableton
        // Live 12.0.5". Null on the very rare file that doesn't carry one.
        dawVersion: liveCreator,
      });
    };

    parser.write(xml).close();
  });
}

module.exports = { parseAbletonProject };
