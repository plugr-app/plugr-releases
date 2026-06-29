// FL Studio project parser (.flp files).
//
// .flp is a chunked binary format (no compression). Top-level structure:
//
//   "FLhd" magic (4 bytes)
//   header size (4 bytes LE, almost always 6)
//   format type, channel count, PPQ (2+2+2 = 6 bytes)
//   "FLdt" magic (4 bytes)
//   data size (4 bytes LE)
//   event stream (data_size bytes)
//
// Events are TLV-style. The 1-byte event ID tells you how to read the
// payload:
//   - id in 0..63    → 1 byte payload          (BYTE event)
//   - id in 64..127  → 2 byte payload (LE)     (WORD event)
//   - id in 128..191 → 4 byte payload (LE)     (DWORD event)
//   - id in 192..255 → variable-length payload, length is a 7-bit
//                     varint (each byte's low 7 bits, high bit = "more
//                     bytes follow"), then `length` bytes of payload.
//
// PLUGIN DETECTION
//
// Plugin info is stored inside variable-length events whose payloads
// are length-prefixed (not null-terminated) and whose exact layout
// shifts across FL Studio versions. Rather than reverse-engineer the
// binary structure for every FL version, we brute-force scan the data
// section for plugin path strings — looking for known plugin
// extensions (.dll, .vst3, .vst, .component, .clap) in BOTH
// UTF-16-LE (modern FL) and Latin-1 / ASCII (older FL, Windows path
// fragments inside binary blobs). We do NOT require a null terminator
// after the extension because FL stores paths length-prefixed; we
// instead verify the byte after the extension is not part of a longer
// word (e.g. ".dll" inside ".dllinfo" doesn't count).
//
// SAMPLE EXCLUSION
//
// We also harvest sample file paths from text events (event id 196 =
// FLP_Text_SampleFileName) so the bounces module can be told NOT to
// list those files as bounces. Without this, every kick/snare in a
// project gets dumped into the Bounces section.
//
// TEMPO
//
// Tempo IS parsed via events since that's reliable:
//   - id 67 (BPM as integer, WORD)            — old FL
//   - id 156 (BPM × 1000, DWORD)              — modern FL ("FineTempo")
//
// KEY
//
// FL Studio doesn't expose a project-wide musical key the way Ableton
// 12 does. Per-pattern root notes exist but aren't aggregated into a
// project scale. We return null.

const fs = require('node:fs/promises');
const path = require('node:path');
const { findBouncesFor } = require('./bounces.cjs');

// Optional verbose logging — set PLUGR_FLP_DEBUG=1 to dump a histogram
// of event IDs encountered in each .flp the parser handles. Useful
// when a real-world file produces unexpected results.
const DEBUG = !!process.env.PLUGR_FLP_DEBUG;

// Read a 7-bit varint at `offset` in `buf`. Returns { value, bytesRead }.
function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos];
    pos++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, bytesRead: pos - offset };
    shift += 7;
    if (shift > 28) throw new Error('FLP varint too long');
  }
  throw new Error('FLP varint truncated');
}

function formatFromExt(ext) {
  switch (ext.toLowerCase()) {
    case '.dll':       return 'VST2';
    case '.vst':       return 'VST2';
    case '.vst3':      return 'VST3';
    case '.component': return 'AU';
    case '.clap':      return 'CLAP';
    default: return null;
  }
}

// "Could this byte plausibly continue a file extension as a longer
// word?" We only consider ASCII letters here — NOT digits. FL stores
// paths length-prefixed inside its binary blobs, and the byte right
// after a path very often happens to be a small numeric length field
// for the next struct member. If we treated digits as continuation
// characters, we'd reject every "/path/Plugin.vst3" + length-byte
// sequence in the file. (No real plugin extension extends to a digit
// — there's no ".vst30" or ".dll5" format.)
function isExtensionContinuation(byte) {
  return (byte >= 0x41 && byte <= 0x5a) || // A-Z
         (byte >= 0x61 && byte <= 0x7a);   // a-z
}

// "Looks like a printable ASCII path character" (for walking back
// through the path string).
function isPathChar(byte) {
  // 0x20 (space) through 0x7e (~), inclusive.
  return byte >= 0x20 && byte <= 0x7e;
}

// Heuristic to decide if a candidate plugin path is plausible. Filters
// out random binary noise that happened to contain a `.dll`-like
// byte sequence.
function looksLikePluginPath(pathStr) {
  if (!pathStr) return false;
  if (pathStr.length < 5 || pathStr.length > 400) return false;
  // Must contain a path separator (anything stored as a "real" path
  // does) OR start with a recognizable plugin-name char run.
  if (!/[\\/]/.test(pathStr)) return false;
  // Must have a sane fraction of printable letters/digits. Binary
  // garbage that incidentally has a `.dll` byte run will fail this.
  const printableRatio = (pathStr.match(/[A-Za-z0-9 _\-./\\:]/g) || []).length / pathStr.length;
  if (printableRatio < 0.9) return false;
  // Reject runs of repeated separators / control-ish chars.
  if (/[/\\]{3,}/.test(pathStr)) return false;
  return true;
}

// Scan a buffer for plugin paths. Returns
// { plugins: [{ name, identifier, format, count }], debug }.
function scanForPluginPaths(buf, start, end) {
  // identifier → record. We dedupe on lowercase identifier, but use
  // a separate region tracker to make sure the same blob region
  // doesn't get attributed to two different "instances".
  const records = new Map();
  const claimedRegions = []; // sorted by hitStart

  function addHit({ name, identifier, format, hitStart, hitEnd }) {
    for (const [s, e] of claimedRegions) {
      if (hitStart < e && hitEnd > s) return;
    }
    claimedRegions.push([hitStart, hitEnd]);
    const key = identifier.toLowerCase();
    if (!records.has(key)) {
      records.set(key, { name, identifier, format, count: 0 });
    }
    records.get(key).count++;
    const rec = records.get(key);
    if (name && (!rec.name || rec.name.length < name.length)) rec.name = name;
  }

  const EXTS = ['.dll', '.vst3', '.vst', '.component', '.clap'];
  const hitCounts = { utf16: 0, latin1: 0 };

  // ---- Pass 1: UTF-16-LE ----
  // For each extension, search for the extension itself (no null
  // terminator) encoded as UTF-16-LE. Validate the boundary: the byte
  // pair AFTER the extension must NOT be an ASCII letter/digit
  // (otherwise we matched mid-word like ".dllsomething").
  for (const ext of EXTS) {
    const needle = Buffer.from(ext, 'utf16le');
    let searchFrom = start;
    while (searchFrom < end) {
      const idx = buf.indexOf(needle, searchFrom);
      if (idx < 0 || idx >= end) break;
      const endOfExt = idx + needle.length;
      // Boundary check
      let okBoundary = true;
      if (endOfExt + 2 <= end) {
        const lo = buf[endOfExt];
        const hi = buf[endOfExt + 1];
        // High byte must be 0 for an ASCII char in UTF-16-LE; if it's
        // not, definitely not a continuation of the word.
        if (hi === 0 && isExtensionContinuation(lo)) okBoundary = false;
      }
      if (!okBoundary) { searchFrom = idx + 2; continue; }
      // Walk backwards 2 bytes at a time through valid UTF-16-LE
      // printable ASCII chars (high byte 0, low byte ≥ 0x20).
      let s = idx;
      while (s >= start + 2) {
        const lo = buf[s - 2];
        const hi = buf[s - 1];
        if (hi !== 0) break;
        if (lo < 0x20) break;
        s -= 2;
      }
      const rawPath = buf.subarray(s, endOfExt).toString('utf16le');
      const cleanPath = rawPath.replace(/^[^A-Za-z/\\]+/, ''); // trim leading junk
      if (!looksLikePluginPath(cleanPath)) {
        searchFrom = endOfExt;
        continue;
      }
      const base = cleanPath.split(/[/\\]/).pop();
      const stem = base.replace(/\.[^.]+$/, '');
      if (stem && stem.length > 0 && stem.length < 120 && /[A-Za-z]/.test(stem)) {
        addHit({ name: stem, identifier: cleanPath, format: formatFromExt(ext), hitStart: s, hitEnd: endOfExt });
        hitCounts.utf16++;
      }
      searchFrom = endOfExt;
    }
  }

  // ---- Pass 2: Latin-1 / ASCII ----
  // Same approach for single-byte encodings. Boundary: next byte is
  // not an ASCII letter/digit.
  for (const ext of EXTS) {
    const needle = Buffer.from(ext, 'latin1');
    let searchFrom = start;
    while (searchFrom < end) {
      const idx = buf.indexOf(needle, searchFrom);
      if (idx < 0 || idx >= end) break;
      const endOfExt = idx + needle.length;
      let okBoundary = true;
      if (endOfExt < end) {
        const ch = buf[endOfExt];
        if (isExtensionContinuation(ch)) okBoundary = false;
      }
      if (!okBoundary) { searchFrom = idx + 1; continue; }
      let s = idx;
      while (s > start) {
        const ch = buf[s - 1];
        if (!isPathChar(ch)) break;
        s--;
      }
      const rawPath = buf.subarray(s, endOfExt).toString('latin1');
      const cleanPath = rawPath.replace(/^[^A-Za-z/\\]+/, '');
      if (!looksLikePluginPath(cleanPath)) {
        searchFrom = endOfExt;
        continue;
      }
      const base = cleanPath.split(/[/\\]/).pop();
      const stem = base.replace(/\.[^.]+$/, '');
      if (stem && stem.length > 0 && stem.length < 120 && /[A-Za-z]/.test(stem)) {
        addHit({ name: stem, identifier: cleanPath, format: formatFromExt(ext), hitStart: s, hitEnd: endOfExt });
        hitCounts.latin1++;
      }
      searchFrom = endOfExt;
    }
  }

  return { plugins: [...records.values()], hitCounts };
}

// Walk the event stream to extract:
//   - tempo (from event 67 or 156)
//   - sample file paths (from text events 196 = SampleFileName)
//   - plugin display names (from text events 201 = DefPluginName)
//   - event histogram (debug)
//   - paired event 201 → 212 sequences (lets us inspect plugin format)
function walkEvents(buf, dataStart, dataEnd) {
  let tempo = null;
  // FL Studio writes a Text_Version event (id 199) early in the
  // stream carrying the build that saved this project ("21.2.3.4035").
  // Captured raw; the parser wraps it with "FL Studio " before returning.
  let dawVersionRaw = null;
  const samplePaths = new Set();
  const pluginNameEvents = [];  // ordered list of { name, position }
  const pluginParamEvents = []; // ordered list of { magic, size, position }
  const eventHistogram = {}; // id → count

  function bump(id) {
    eventHistogram[id] = (eventHistogram[id] || 0) + 1;
  }

  function decodeFlText(payloadBuf) {
    if (payloadBuf.length === 0) return '';
    // Sniff encoding: count zero high-bytes in the first ~32 bytes.
    let zeroHighBytes = 0;
    const sample = Math.min(payloadBuf.length, 64);
    for (let i = 1; i < sample; i += 2) {
      if (payloadBuf[i] === 0) zeroHighBytes++;
    }
    const sampleHalf = Math.floor(sample / 2);
    if (sampleHalf > 0 && zeroHighBytes / sampleHalf > 0.6) {
      return payloadBuf.toString('utf16le').replace(/\0+$/, '');
    }
    return payloadBuf.toString('latin1').replace(/\0+$/, '');
  }

  let pos = dataStart;
  while (pos < dataEnd) {
    const id = buf[pos];
    pos++;
    bump(id);
    if (id < 64) {
      if (pos >= dataEnd) break;
      pos += 1;
    } else if (id < 128) {
      if (pos + 2 > dataEnd) break;
      const val = buf.readUInt16LE(pos);
      pos += 2;
      if (id === 67 && tempo == null) {
        if (val > 0 && val < 1000) tempo = val;
      }
    } else if (id < 192) {
      if (pos + 4 > dataEnd) break;
      const val = buf.readUInt32LE(pos);
      pos += 4;
      if (id === 156) {
        const bpm = val / 1000;
        if (bpm > 0 && bpm < 1000) tempo = Math.round(bpm * 100) / 100;
      }
    } else {
      // Variable-length event
      let v;
      try { v = readVarint(buf, pos); }
      catch { break; }
      pos += v.bytesRead;
      if (pos + v.value > dataEnd) break;
      const payload = buf.subarray(pos, pos + v.value);
      const payloadStart = pos;
      pos += v.value;
      // Event 199 (Text_Version): FL Studio version string that saved
      // the project ("21.2.3.4035", sometimes preceded by encoding
      // bytes). Captured as-is; renderer prepends "FL Studio" when
      // displaying.
      if (id === 199 && dawVersionRaw == null) {
        const text = decodeFlText(payload).trim();
        if (text) dawVersionRaw = text;
      }
      // Event 196: sample file path
      if (id === 196) {
        const text = decodeFlText(payload);
        if (text && /[\\/]/.test(text) && /\.(wav|mp3|aif|aiff|ogg|flac|m4a|opus|wma)$/i.test(text)) {
          samplePaths.add(text);
        }
      }
      // Event 201 (Text_DefPluginName): the canonical plugin display
      // name for this channel/insert ("Sytrus", "FabFilter Pro-Q 3").
      // Capture every one — we'll dedupe + count later.
      if (id === 201) {
        const text = decodeFlText(payload).trim();
        if (text) pluginNameEvents.push({ name: text, position: payloadStart });
      }
      // Event 212 (Data_PluginParams): the binary plugin state blob.
      // We store a copy of the payload (up to a reasonable cap) so we
      // can later scan it for the wrapped plugin's name when event
      // 201 just reports "Fruity Wrapper".
      if (id === 212 && payload.length >= 4) {
        const magicAscii = payload.toString('ascii', 0, 4);
        // 16KB is plenty — the plugin name appears in the first few
        // hundred bytes; saving the whole blob would balloon memory
        // for projects with hundreds of plugin instances.
        const snapshotLen = Math.min(payload.length, 16 * 1024);
        const snapshot = Buffer.from(payload.subarray(0, snapshotLen));
        pluginParamEvents.push({
          magic: magicAscii,
          firstByte: payload[0],
          size: payload.length,
          position: payloadStart,
          payload: snapshot,
        });
      }
    }
  }

  return {
    tempo,
    dawVersionRaw,
    samplePaths: [...samplePaths],
    pluginNameEvents,
    pluginParamEvents,
    eventHistogram,
  };
}

// FL Studio's stock plugins. Names captured from FL's plugin database
// as of FL 21. Matched case-insensitively, with and without the
// "Fruity " prefix (FL Studio displays some of these both ways). When
// the user asked for "VST/AU plugins only", these are what gets
// filtered out — anything not in this list is assumed to be an
// external VST / AU.
const FL_NATIVE_PLUGINS = new Set([
  // Generators / instruments
  '3x osc', '3xosc',
  'autogun',
  'bassdrum',
  'beepmap',
  'beat slicer',
  'boobass',
  'chrome',
  'cobalt',
  'dashfx',
  'direct wave', 'directwave',
  'drumpad',
  'drumsynth live',
  'dx10', 'fruity dx10',
  'edison',
  'envelope controller', 'fruity envelope controller',
  'fl keys', 'fruity keys',
  'fl slayer', 'fruity slayer',
  'fl studio mobile',
  'flex',
  'formula controller', 'fruity formula controller',
  'fruit kick', 'fruitkick',
  'fruity cell', 'cell',
  'fruity drumsynth live',
  'fruity granulizer', 'granulizer',
  'fruity keyboard controller',
  'fruity scratcher',
  'fruity slicer', 'slicer',
  'fruity soundfont player', 'soundfont player',
  // NOTE: 'fruity wrapper' is intentionally NOT in this list. When
  // FL Studio hosts an external VST/AU plugin, event 201 reports the
  // channel name as "Fruity Wrapper" and the actual plugin name lives
  // inside the corresponding event 212 binary blob. We extract the
  // real plugin name from there instead of filtering these as natives.
  'gms',
  'groove machine synth',
  'harmless',
  'harmor',
  'kepler',
  'midi out', 'fruity midi out',
  'morphine',
  'patcher',
  'plucked!', 'plucked', 'fruity plucked',
  'poizone',
  'sakura',
  'sawer',
  'simsynth', 'sim synth', 'fruity simsynth',
  'slicex',
  'speech synthesizer',
  'sytrus',
  'toxic biohazard', 'toxic',
  'transistor bass',
  'wasp', 'wasp xt', 'waspxt',
  'wave candy',
  'wave traveller', 'wavetraveller',
  'zgameeditor visualizer',
  // Effects
  '7 band eq', 'fruity 7 band eq',
  'balance', 'fruity balance',
  'bass boost', 'fruity bass boost',
  'big clock', 'fruity big clock',
  'blood overdrive', 'fruity blood overdrive',
  'center', 'fruity center',
  'chorus', 'fruity chorus',
  'compressor', 'fruity compressor',
  'convolver',
  'db meter', 'fruity db meter',
  'delay', 'fruity delay',
  'delay 2', 'fruity delay 2',
  'delay 3', 'fruity delay 3',
  'delay bank', 'fruity delay bank',
  'effector',
  'equo',
  'fast dist', 'fruity fast dist',
  'fast lp', 'fruity fast lp',
  'filter', 'fruity filter',
  'flanger', 'fruity flanger',
  'flangus', 'fruity flangus',
  'free filter', 'fruity free filter',
  'frequency shifter', 'fruity frequency shifter',
  'frequency splitter', 'fruity frequency splitter',
  'hardcore',
  'hi pass lp', 'fruity hi pass lp', 'hipass lp',
  'hotkeys', 'fruity hotkeys',
  'limiter', 'fruity limiter',
  'love philter', 'fruity love philter',
  'maximus',
  'mid-side',
  'multiband compressor', 'fruity multiband compressor',
  'multiband delay',
  'notebook', 'fruity notebook',
  'notectrl', 'fruity notectrl', 'fruity note controller',
  'parametric eq', 'fruity parametric eq',
  'parametric eq 2', 'fruity parametric eq 2',
  'peak controller', 'fruity peak controller',
  'phase inverter', 'fruity phase inverter',
  'phaser', 'fruity phaser',
  'pitch shifter', 'fruity pitch shifter',
  'pitcher',
  'reeverb', 'fruity reeverb', 'reverb', 'fruity reverb',
  'reeverb 2', 'fruity reeverb 2', 'reverb 2', 'fruity reverb 2',
  'send', 'fruity send',
  'slot', 'fruity slot',
  'soundgoodizer', 'fruity soundgoodizer',
  'spectroman', 'fruity spectroman',
  'squeeze', 'fruity squeeze',
  'stereo enhancer', 'fruity stereo enhancer',
  'stereo shaper', 'fruity stereo shaper',
  'vocoder', 'fruity vocoder',
  'waveshaper', 'fruity waveshaper',
  'x-y controller', 'fruity x-y controller',
  // FL 20.5+ / FL 21+ stock additions
  'distructor',
  'hyper chorus',
  'luxeverb',
  'multiband maximizer',
  'pluginbooster',
  'plucked!2',
  'soft clipper', 'fruity soft clipper',
  'spreader', 'fruity spreader',
  'vintage chorus',
  'vintage phaser',
  // FLEX presets sometimes register as their preset name; the core
  // engine is FLEX which we already cover above.
  // Misc / utility names that show up in event 201 but aren't VST/AU
  'sampler', 'channel sampler', 'fl studio sampler',
  'audio clip', 'automation clip', 'layer',
  '', // empty strings sometimes appear
]);

function isFlNativePlugin(name) {
  return FL_NATIVE_PLUGINS.has(String(name || '').toLowerCase().trim());
}

// Pull readable strings out of a Fruity Wrapper binary blob. Modern
// FL stores the wrapped VST/AU's metadata inside event 212 — there's
// no single documented offset because the layout shifted across FL
// versions and across plugin formats. We scan for runs of UTF-16-LE
// or Latin-1 printable ASCII (≥3 chars) and return them in the order
// they appear. The first such string is overwhelmingly the plugin's
// display name; subsequent strings tend to be vendor, file path, or
// preset names.
function extractStringsFromBlob(payload) {
  const out = [];

  // ---- UTF-16-LE strings ----
  let i = 0;
  while (i < payload.length - 1) {
    // Each char is one printable ASCII byte followed by 0x00.
    if (payload[i] >= 0x20 && payload[i] <= 0x7e && payload[i + 1] === 0) {
      const start = i;
      while (
        i < payload.length - 1 &&
        payload[i] >= 0x20 && payload[i] <= 0x7e &&
        payload[i + 1] === 0
      ) {
        i += 2;
      }
      const strLen = (i - start) / 2;
      if (strLen >= 3 && strLen <= 200) {
        out.push({ text: payload.toString('utf16le', start, i), encoding: 'utf16' });
      }
    } else {
      i++;
    }
  }

  // ---- Latin-1 strings ----
  // Only collect runs ≥4 chars in single-byte encoding (otherwise we
  // catch huge swaths of incidental ASCII like "Mfile" markers).
  i = 0;
  while (i < payload.length) {
    if (payload[i] >= 0x20 && payload[i] <= 0x7e) {
      const start = i;
      while (i < payload.length && payload[i] >= 0x20 && payload[i] <= 0x7e) i++;
      const len = i - start;
      if (len >= 4 && len <= 200) {
        out.push({ text: payload.toString('latin1', start, i), encoding: 'latin1' });
      }
    } else {
      i++;
    }
  }
  return out;
}

// From the strings in a Fruity Wrapper blob, pick the most plausible
// "plugin display name" and (when possible) infer the plugin format
// from any file path or wrapper magic we spotted.
function pluginNameFromWrapperBlob(payload) {
  const strings = extractStringsFromBlob(payload);
  if (strings.length === 0) return null;

  // Find a file-path string first — gives us format AND the plugin
  // name from the basename.
  let format = null;
  let nameFromPath = null;
  for (const { text } of strings) {
    const m = text.match(/([^/\\]+)\.(dll|vst3|vst|component|clap)\b/i);
    if (m) {
      nameFromPath = m[1];
      format = formatFromExt('.' + m[2].toLowerCase());
      break;
    }
  }

  if (nameFromPath) return { name: nameFromPath, format };

  // No file path found — fall back to the first reasonable string
  // that isn't a path, isn't all-numeric, and isn't obvious noise.
  // Plugin names typically come early in the blob; vendor names and
  // state strings come later.
  for (const { text } of strings) {
    const t = text.trim();
    if (!t) continue;
    if (/[\\/]/.test(t)) continue;                  // looks like a path
    if (!/[A-Za-z]/.test(t)) continue;              // must have letters
    if (/^[0-9.]+$/.test(t)) continue;              // version-like
    if (/^[A-Z][a-z]+:/.test(t)) continue;          // "Preset:" prefixes
    if (t.length < 3) continue;
    return { name: t, format: null };
  }

  return null;
}

/**
 * Parse a single .flp file. Same return shape as the Ableton parser
 * so the rest of Plugr doesn't have to special-case anything:
 *   {
 *     name, dawType: 'flstudio', lastModified,
 *     plugins: [{ name, identifier?, format, count }],
 *     totalPluginInstances,
 *     bounces, tempo, key,
 *     sampleRefs: [normalized basename strings]  // for bounces exclusion
 *   }
 */
async function parseFlStudioProject(filePath) {
  const stat = await fs.stat(filePath);
  const buf = await fs.readFile(filePath);

  if (buf.length < 22) throw new Error('FLP file too short');
  if (buf.toString('ascii', 0, 4) !== 'FLhd') {
    throw new Error('Not a FL Studio project file (missing FLhd magic)');
  }
  const hdrSize = buf.readUInt32LE(4);
  if (hdrSize < 6 || hdrSize > 64) {
    throw new Error(`Suspicious FLhd size: ${hdrSize}`);
  }
  const dataChunkOffset = 8 + hdrSize;
  if (dataChunkOffset + 8 > buf.length) {
    throw new Error('FLP truncated before FLdt chunk');
  }
  if (buf.toString('ascii', dataChunkOffset, dataChunkOffset + 4) !== 'FLdt') {
    throw new Error('FLP missing FLdt chunk');
  }
  const declaredDataSize = buf.readUInt32LE(dataChunkOffset + 4);
  const dataStart = dataChunkOffset + 8;
  const dataEnd = Math.min(dataStart + declaredDataSize, buf.length);

  const {
    tempo, dawVersionRaw, samplePaths, eventHistogram,
    pluginNameEvents, pluginParamEvents,
  } = walkEvents(buf, dataStart, dataEnd);
  // FL Studio's Text_Version event is just digits + dots; prepend the
  // brand so users see "FL Studio 21.2.3.4035" instead of bare numbers.
  const dawVersion = dawVersionRaw
    ? (/^FL\s*Studio/i.test(dawVersionRaw)
        ? dawVersionRaw
        : `FL Studio ${dawVersionRaw}`)
    : null;
  const { plugins: scannedPlugins, hitCounts } = scanForPluginPaths(buf, dataStart, dataEnd);

  // Build plugin list from event 201 (DefPluginName) names. Every
  // plugin instance produces one of these. We pair each name event
  // with the next event 212 (the binary state blob) in file order:
  //
  //   - If event 201 says "Fruity Wrapper" → this is a wrapped VST
  //     or AU plugin. The actual plugin name lives inside event 212
  //     as embedded UTF-16-LE / Latin-1 strings. We dig it out via
  //     pluginNameFromWrapperBlob().
  //
  //   - If event 201 says any other recognized FL native name → drop
  //     it (the user asked for VST/AU only).
  //
  //   - Otherwise → treat it as the plugin name as-is. Some VSTs are
  //     embedded inside FL via per-vendor wrappers and don't go
  //     through Fruity Wrapper.
  const byName = new Map();
  const filteredOut = new Map(); // name → count (debug visibility)
  const wrapperResolutionFailures = []; // for debug — wrappers we couldn't name
  for (let i = 0; i < pluginNameEvents.length; i++) {
    const ev = pluginNameEvents[i];
    const rawName = ev.name;
    if (!rawName) continue;
    // Pair with the next event 212 that came after this event 201 in
    // file order. (Both arrays are in file order.)
    const params = pluginParamEvents.find((p) => p.position > ev.position);

    let resolvedName = rawName;
    let resolvedFormat = null;
    let resolvedIdentifier = null;

    if (/^fruity wrapper$/i.test(rawName.trim())) {
      // Wrapped VST/AU. In modern FL the event 212 blob paired with
      // a Fruity Wrapper is just a 52-byte channel header — the real
      // plugin metadata (name, vendor, file path) lives elsewhere in
      // the file as embedded strings, which the binary path scanner
      // picks up separately. So if we can't extract a name here, we
      // SKIP this event entirely rather than adding an "Unknown
      // VST/AU plugin" placeholder — otherwise every wrapped plugin
      // would be double-counted (once here, once via the path scan).
      if (params && params.payload) {
        const dug = pluginNameFromWrapperBlob(params.payload);
        if (dug) {
          resolvedName = dug.name;
          resolvedFormat = dug.format;
        } else {
          wrapperResolutionFailures.push({ position: ev.position, size: params.size });
          continue; // skip — path scanner will name this instance
        }
      } else {
        wrapperResolutionFailures.push({ position: ev.position, size: 0 });
        continue; // skip — path scanner will name this instance
      }
    }

    if (isFlNativePlugin(resolvedName)) {
      filteredOut.set(resolvedName, (filteredOut.get(resolvedName) || 0) + 1);
      continue;
    }

    const key = resolvedName.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, { name: resolvedName, identifier: resolvedIdentifier, format: resolvedFormat, count: 0 });
    }
    const rec = byName.get(key);
    rec.count++;
    if (resolvedFormat && !rec.format) rec.format = resolvedFormat;
    if (resolvedIdentifier && !rec.identifier) rec.identifier = resolvedIdentifier;
  }

  // Also fold in anything the file-extension scan found that we
  // didn't already catch via event 201. For wrapped plugins (Fruity
  // Wrapper instances we skipped earlier), this is where they get
  // named — the .vst3 / .dll / .component path appears elsewhere in
  // the file.
  for (const p of scannedPlugins) {
    const key = (p.name || '').toLowerCase();
    if (!key) continue;
    if (isFlNativePlugin(p.name)) continue;
    if (byName.has(key)) {
      const rec = byName.get(key);
      if (!rec.identifier && p.identifier) rec.identifier = p.identifier;
      if (!rec.format && p.format) rec.format = p.format;
    } else {
      byName.set(key, { ...p });
    }
  }

  // If there are wrapped plugins that NEITHER the wrapper-blob
  // extractor NOR the path scanner could name, surface a single
  // honest "Unidentified" row with the count, so the user knows
  // their project contains N plugins Plugr couldn't read. The math:
  //   #unresolvedWrappers - #instancesFoundViaPaths = #truly_unknown
  // This avoids the double-count bug (where 65 wrappers + 64 named
  // path-scan results showed up as 129 plugins).
  const totalScannedInstances = scannedPlugins
    .filter((p) => !isFlNativePlugin(p.name))
    .reduce((sum, p) => sum + p.count, 0);
  const unidentifiedCount = Math.max(0, wrapperResolutionFailures.length - totalScannedInstances);
  if (unidentifiedCount > 0) {
    byName.set('__unidentified_vst__', {
      name: 'Unidentified VST/AU plugin',
      identifier: null,
      format: null,
      count: unidentifiedCount,
      _unidentified: true, // flag for the UI / matcher
    });
  }

  const plugins = [...byName.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name),
  );
  const totalPluginInstances = plugins.reduce((n, p) => n + p.count, 0);
  const projectName = path.basename(filePath, path.extname(filePath));

  // Normalize sample refs to basename-without-extension so the bounces
  // module can match by filename without worrying about absolute path
  // mismatches (FL stores Windows-style paths even on macOS sometimes).
  const sampleRefs = samplePaths.map((p) => {
    const base = p.split(/[/\\]/).pop() || '';
    return base.replace(/\.[^.]+$/, '').toLowerCase();
  });

  if (DEBUG) {
    const topEvents = Object.entries(eventHistogram)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id, c]) => `${id}:${c}`).join(' ');
    console.log(`[FLP] ${path.basename(filePath)}: tempo=${tempo} plugins=${plugins.length} samples=${samplePaths.length} name-events=${pluginNameEvents.length} params-events=${pluginParamEvents.length} ext-hits(utf16/latin1)=${hitCounts.utf16}/${hitCounts.latin1}`);
    console.log(`[FLP]   top events: ${topEvents}`);
    if (plugins.length > 0) {
      console.log('[FLP]   detected plugins:');
      for (const p of plugins) {
        console.log(`[FLP]     - ${p.name}${p.format ? ' (' + p.format + ')' : ''}  ×${p.count}`);
      }
    }
    if (filteredOut.size > 0) {
      const filteredStr = [...filteredOut.entries()].map(([n, c]) => `${n}×${c}`).join(', ');
      console.log(`[FLP]   filtered FL native plugins: ${filteredStr}`);
    }
    if (wrapperResolutionFailures.length > 0) {
      // Note: in modern FL, the small (~52-byte) event 212 blob next
      // to a Fruity Wrapper rarely contains the plugin's name; the
      // path scan over the rest of the data section is the actual
      // source of names for these. Counting "failures" is normal —
      // they just mean we deferred naming to the path scanner.
      console.log(`[FLP]   ${wrapperResolutionFailures.length} Fruity Wrapper instance(s) deferred to path-scan naming (event 212 too small).`);
    }
    // The deep string scan is expensive and only useful when we're
    // truly stuck — i.e. zero plugins were detected. Skip it once we
    // have results.
    if (plugins.length === 0 && wrapperResolutionFailures.length > 0) {
      console.log('[FLP]   --- deep string scan (top distinct strings 4–60 chars) ---');
      const stringCounts = new Map();
      // UTF-16-LE strings
      {
        let i = dataStart;
        while (i < dataEnd - 1) {
          if (buf[i] >= 0x20 && buf[i] <= 0x7e && buf[i + 1] === 0) {
            const start = i;
            while (i < dataEnd - 1 && buf[i] >= 0x20 && buf[i] <= 0x7e && buf[i + 1] === 0) i += 2;
            const len = (i - start) / 2;
            if (len >= 4 && len <= 60) {
              const s = buf.toString('utf16le', start, i);
              stringCounts.set(s, (stringCounts.get(s) || 0) + 1);
            }
          } else {
            i++;
          }
        }
      }
      // Latin-1 strings (only ≥6 chars to cut noise)
      {
        let i = dataStart;
        while (i < dataEnd) {
          if (buf[i] >= 0x20 && buf[i] <= 0x7e) {
            const start = i;
            while (i < dataEnd && buf[i] >= 0x20 && buf[i] <= 0x7e) i++;
            const len = i - start;
            if (len >= 6 && len <= 60) {
              const s = buf.toString('latin1', start, i);
              // Skip ones that are mostly punctuation
              if (/[A-Za-z]/.test(s) && (s.match(/[A-Za-z]/g) || []).length >= 3) {
                stringCounts.set(s, (stringCounts.get(s) || 0) + 1);
              }
            }
          } else {
            i++;
          }
        }
      }
      const sorted = [...stringCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [s, count] of sorted.slice(0, 80)) {
        console.log(`[FLP]     ×${count}  ${JSON.stringify(s)}`);
      }
      console.log('[FLP]   --- end of deep scan ---');
    }
    // Sample of PluginParams magic bytes seen — useful when investigating
    // unrecognized wrapper formats.
    const magicHistogram = {};
    for (const p of pluginParamEvents) {
      magicHistogram[p.magic] = (magicHistogram[p.magic] || 0) + 1;
    }
    const magicStr = Object.entries(magicHistogram)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([m, c]) => `'${m.replace(/[^\x20-\x7e]/g, '·')}':${c}`).join(' ');
    if (magicStr) console.log(`[FLP]   PluginParams magic bytes: ${magicStr}`);
  }

  let bounces = [];
  try {
    bounces = await findBouncesFor(filePath, projectName, { excludeBasenames: sampleRefs });
  } catch { /* tolerate — bounces are best-effort */ }

  return {
    name: projectName,
    dawType: 'flstudio',
    lastModified: stat.mtime.toISOString(),
    plugins,
    totalPluginInstances,
    bounces,
    tempo,
    key: null,
    dawVersion,
    sampleRefs,
  };
}

module.exports = { parseFlStudioProject };
