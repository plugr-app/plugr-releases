// Discover audio "bounces" (final mixdowns) for a given DAW project file.
//
// The hard problem: a project's parent folder almost always contains
// audio files that AREN'T bounces — samples, recorded takes, warp
// markers, project-info clips. Naively listing every .wav next to the
// .als/.flp/.logicx would flood the UI with hundreds of one-shots.
//
// Strategy is three tiers, in order of confidence:
//
//   TIER 1 — Canonical bounce folders.
//     Sibling folders with well-known bounce names (Bounces, Exports,
//     Mixdowns, Rendered, Mastering, Output, …). Every audio file
//     inside is treated as a bounce. Also covers Ableton's "Manage
//     Project"-style nested "<ProjectName> Project/Bounces/" layout.
//
//   TIER 2 — Adjacent files matching the project name.
//     Audio files directly next to the project file are included only
//     when the filename contains the project name (case-insensitive,
//     normalized). This rules out the FL Studio sample-folder case:
//     "kick_punchy_03.wav" sitting next to "MyTrack.flp" won't match.
//
//   TIER 3 — Hard blacklist.
//     Never recurse into folders named Samples, Recorded, Project
//     Info, Backup, Cache, Asset Library, Plugins, etc.
//
// Safety net: files under 200KB are dropped. Most one-shots are
// 50–500KB; real tracks are tens of MB. The threshold lets us catch
// even short cues (jingles, stems of intro hits) while filtering out
// drum hits and warp markers.

const fs = require('node:fs/promises');
const path = require('node:path');

// Audio extensions we recognize as potential bounces. AIFF/M4A
// covered because Logic and FL Studio both default to them in some
// preset configurations.
const AUDIO_EXTS = new Set([
  '.wav', '.aif', '.aiff', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wma',
]);

// Folder names (case-insensitive) that almost always contain
// finished bounces. Order matters for documentation only — we test
// case-insensitively.
const BOUNCE_FOLDER_NAMES = new Set([
  'bounces', 'bounce',
  'exports', 'export', 'exported',
  'mixdowns', 'mixdown', 'mixes', 'mix',
  'rendered', 'renders', 'render',
  'mastering', 'masters', 'mastered',
  'output', 'outputs', 'out',
  'final', 'finals',
  // NOTE: 'audio' was previously in this set on the theory that
  // FL Studio's default render path is often "Audio/". In practice
  // an "Audio/" folder usually contains samples, not bounces — too
  // many false positives. Users with renders in an Audio/ folder
  // can add them manually via "+ Add bounce…".
]);

// Folder names that mark a directory as "this is a proper DAW project
// folder, not just a folder that happens to contain a .flp / .als at
// the top level". When at least one of these is present alongside the
// project file, we know we're in a managed project layout — samples
// live in the Samples/ subfolder, and top-level audio files are
// almost certainly the user's bounces / mixdowns even when they
// don't share the project name. Triggers TIER 2.5 below.
const PROJECT_STRUCTURE_FOLDER_NAMES = new Set([
  'samples',
  'backup', 'backups',
  'ableton project info',
  'project info',
  'recorded', 'recording', 'recordings',
]);

// Folder names we MUST never recurse into — these reliably hold
// samples, recorded takes, or auxiliary data, not bounces.
const BLACKLIST_FOLDER_NAMES = new Set([
  'samples', 'sample',
  'recorded', 'recording', 'recordings',
  'project info',
  'backup', 'backups',
  'cache', '.cache',
  'asset library',
  'plugins', 'plugin presets',
  // Ableton's per-project metadata folder.
  'ableton project info',
  // Logic's bundle internals — these are project-internal, not bounces.
  'media', 'autosave',
  // Stems folders contain partial mixes — useful but not "bounces"
  // in the canonical sense. We exclude by default; if users want
  // them surfaced we can add a setting later.
  'stems',
]);

// Minimum file size to consider as a bounce (200KB). Anything
// smaller is almost certainly a one-shot, click track, or metronome
// stem rather than a finished mixdown.
const MIN_BOUNCE_BYTES = 200 * 1024;

// Maximum total bounces we surface per project. Prevents the UI
// from rendering hundreds of files for a project with a huge
// rendered/ subfolder full of versions.
const MAX_BOUNCES_PER_PROJECT = 60;

function lcExt(file) {
  return path.extname(file).toLowerCase();
}

function isAudioFile(filename) {
  return AUDIO_EXTS.has(lcExt(filename));
}

/**
 * Normalize a name for fuzzy matching. Lowercased + non-alphanumeric
 * stripped — so "MyTrack" matches "my-track_v3" and "My Track Master".
 */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Yields every audio file at the given root, recursing through
 * sub-folders unless a folder name appears in the blacklist. Returns
 * an array of { path, name, sizeBytes, mtime } records. Hidden files
 * (dotfiles) and bundle-internal paths are skipped.
 */
async function collectAudioFiles(root, maxDepth = 4) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (BLACKLIST_FOLDER_NAMES.has(ent.name.toLowerCase())) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && isAudioFile(ent.name)) {
        try {
          const stat = await fs.stat(full);
          out.push({
            path: full,
            name: ent.name,
            sizeBytes: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch { /* dead symlink, permissions — skip silently */ }
      }
    }
  }
  await walk(root, 0);
  return out;
}

/**
 * Detect whether a folder looks like a managed DAW project folder
 * (Samples/, Backup/, Ableton Project Info/ subfolders present).
 * When true, audio files at the top level are almost certainly
 * bounces — the structure folders quarantine actual samples and
 * recorded takes elsewhere.
 */
async function hasProjectStructure(parentDir) {
  let entries;
  try { entries = await fs.readdir(parentDir, { withFileTypes: true }); }
  catch { return false; }
  for (const ent of entries) {
    if (ent.isDirectory() && PROJECT_STRUCTURE_FOLDER_NAMES.has(ent.name.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Discover bounces for a given project file. Pure async function —
 * caller invokes once per project. Doesn't touch any cache; the
 * scanner is responsible for storing the result on the project
 * record.
 *
 * @param {string} projectFilePath - absolute path to .als / .flp /
 *   .logicx file
 * @param {string} projectName     - the project's display name
 *   (used for Tier 2 filename matching)
 * @param {object} [opts]
 * @param {string[]} [opts.excludeBasenames] - lowercased basenames-
 *   without-extension that should NEVER be reported as bounces (i.e.
 *   the project's own sample files, extracted from the .flp/.als).
 *   The parser passes these so we don't list kick.wav, snare.wav,
 *   etc. as bounces.
 * @returns {Promise<Array<{ path, name, sizeBytes, mtime, source }>>}
 */
async function findBouncesFor(projectFilePath, projectName, opts = {}) {
  const parentDir = path.dirname(projectFilePath);
  const projectKey = normName(projectName);
  const excludeBasenames = new Set((opts.excludeBasenames || []).map((s) => String(s || '').toLowerCase()));
  const found = new Map();   // path → record (de-dupes if Tier 1 + Tier 2 overlap)

  // Returns true if this filename matches one of the project's
  // known sample references — in which case we DO NOT want to list
  // it as a bounce, regardless of which tier found it.
  function isSampleReference(filename) {
    if (excludeBasenames.size === 0) return false;
    const stem = path.basename(filename, path.extname(filename)).toLowerCase();
    return excludeBasenames.has(stem);
  }

  // -----------------------------------------------------------------
  // TIER 1 — sibling bounce folders.
  // -----------------------------------------------------------------
  // We look at the project's parent folder AND its parent's parent
  // (covers the Ableton "Manage Project" case where the .als lives
  // in /Projects/MyTrack Project/MyTrack.als and Bounces sits as
  // /Projects/MyTrack Project/Bounces/).
  const searchRoots = new Set([parentDir, path.dirname(parentDir)]);
  for (const root of searchRoots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!BOUNCE_FOLDER_NAMES.has(ent.name.toLowerCase())) continue;
      const sub = path.join(root, ent.name);
      const files = await collectAudioFiles(sub);
      for (const f of files) {
        if (f.sizeBytes < MIN_BOUNCE_BYTES) continue;
        if (isSampleReference(f.name)) continue;
        if (!found.has(f.path)) found.set(f.path, { ...f, source: 'tier1' });
      }
    }
  }

  // -----------------------------------------------------------------
  // TIER 2 — same folder as the project file, filename must match.
  // -----------------------------------------------------------------
  // This is the FL-Studio-flat-folder case. We only surface audio
  // whose normalized basename CONTAINS the project name (so a
  // bounce called "MyTrack_v3.wav" matches but "kick_03.wav"
  // doesn't).
  if (projectKey.length >= 3) {
    let entries;
    try { entries = await fs.readdir(parentDir, { withFileTypes: true }); }
    catch { entries = []; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!isAudioFile(ent.name)) continue;
      if (isSampleReference(ent.name)) continue;
      const baseKey = normName(path.basename(ent.name, path.extname(ent.name)));
      if (!baseKey.includes(projectKey)) continue;
      const full = path.join(parentDir, ent.name);
      if (found.has(full)) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size < MIN_BOUNCE_BYTES) continue;
        found.set(full, {
          path: full,
          name: ent.name,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
          source: 'tier2',
        });
      } catch { /* skip */ }
    }
  }

  // -----------------------------------------------------------------
  // TIER 2.5 — managed project folder, top-level audio with hints.
  // -----------------------------------------------------------------
  // When the project's folder has a standard DAW project structure
  // (Samples/, Backup/, Ableton Project Info/, Recorded/), top-level
  // audio files are often bounces. Users sometimes name them after
  // the working title rather than the .als/.flp filename (project is
  // "another 90s New New.als" but the bounce is
  // "computerplayer - dialed in - 2-16-26.wav"), so we can't rely on
  // strict name-matching alone.
  //
  // Previous behavior accepted EVERY top-level audio file under this
  // tier, which was a disaster for FL Studio projects where the
  // project's parent folder often contains the source samples too.
  // Now we require at least one of:
  //   - filename contains a bounce-signal keyword (mix/master/render/
  //     final/v1-v9/bounce/export/wip/take)
  //   - filename CONTAINS the project name (relaxed Tier 2)
  //   - filename matches a date pattern like 2024-03-15 (working
  //     producers tag bounces with dates)
  // AND it must not match a known sample reference (handled below).
  const BOUNCE_HINT_PATTERNS = [
    /\b(mix|mixdown|master|mastered|mastering)\b/i,
    /\b(render|rendered|bounce|bounced|export|exported|exp)\b/i,
    /\b(final|finals|finalmix|finalmaster|wip|rough|draft|take|takes)\b/i,
    /\b(v|ver|version)\s*\d+/i,
    /\b\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\b/,    // YYYY-MM-DD
    /\b\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4}\b/,  // MM-DD-YY or MM-DD-YYYY
  ];
  function looksLikeBounceFilename(filename) {
    const stem = path.basename(filename, path.extname(filename));
    if (BOUNCE_HINT_PATTERNS.some((re) => re.test(stem))) return true;
    if (projectKey.length >= 3 && normName(stem).includes(projectKey)) return true;
    return false;
  }
  if (await hasProjectStructure(parentDir)) {
    let entries;
    try { entries = await fs.readdir(parentDir, { withFileTypes: true }); }
    catch { entries = []; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!isAudioFile(ent.name)) continue;
      if (isSampleReference(ent.name)) continue;
      if (!looksLikeBounceFilename(ent.name)) continue;
      const full = path.join(parentDir, ent.name);
      if (found.has(full)) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size < MIN_BOUNCE_BYTES) continue;
        found.set(full, {
          path: full,
          name: ent.name,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
          source: 'tier2.5',
        });
      } catch { /* skip */ }
    }
  }

  // Sort newest first (the bounce you just rendered is what you
  // probably want to listen to) and cap.
  const sorted = [...found.values()]
    .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
    .slice(0, MAX_BOUNCES_PER_PROJECT);
  return sorted;
}

module.exports = {
  findBouncesFor,
  // Exported for testing / verification.
  BOUNCE_FOLDER_NAMES,
  BLACKLIST_FOLDER_NAMES,
  MIN_BOUNCE_BYTES,
};
