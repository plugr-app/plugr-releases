// Logic Pro project parser (.logicx packages).
//
// .logicx is a macOS bundle — Finder shows it as a single file but on
// disk it's a directory with this rough structure:
//
//   MyProject.logicx/
//     Alternatives/
//       000/
//         ProjectData            ← main binary, undocumented
//         DisplayState.plist
//       001/
//         ProjectData
//     Audio Files/                 (recorded audio, samples)
//     Bounces/                     (rendered mixdowns)
//     Freeze Files/                (frozen tracks)
//     ...
//
// Logic Pro is Audio-Units-only — VST/VST3/CLAP are NOT supported.
// All third-party effects and instruments are AU components stored
// under /Library/Audio/Plug-Ins/Components/. Logic identifies each AU
// by a 5-tuple FourCC descriptor:
//
//   { manufacturer, type, subtype, name, version }
//
// These descriptors live inside ProjectData in two encodings:
//
//   1. XML plists — embedded as readable <dict>…</dict> blocks
//   2. Binary plists (NSKeyedArchiver) — opaque to a string scan but
//      parseable with `bplist-parser`
//
// We extract from both encodings and merge, deduping by manufacturer
// + subtype FourCC.
//
// Tempo: stored in ProjectData but the offset shifts across Logic
// versions. v1 returns null (BPM column shows "—").
//
// Key: Logic doesn't have a single project-wide key signature — each
// section/region can have its own. We return null.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const bplist = require('bplist-parser');
const { parsePlistFile } = require('../plistParser.cjs');
const { findBouncesFor } = require('./bounces.cjs');

// bplist-parser hardcodes maxObjectCount=32768 and maxObjectSize=100MB
// to guard against malicious bplists. Real Logic project NSKeyedArchiver
// bplists routinely have tens of thousands of objects (every plugin
// instance, parameter, automation point, etc. is a separate object),
// so we override the guards to fit large legit projects. We still keep
// finite caps so a genuinely corrupted bplist won't OOM us.
bplist.maxObjectCount = 5_000_000;
bplist.maxObjectSize = 500 * 1000 * 1000;  // 500 MB

const DEBUG = !!process.env.PLUGR_LOGIC_DEBUG;

// Logic stores Audio Unit plugin references as 5-tuples encoded as
// XML <dict> blocks inside ProjectData. The keys are:
//   manufacturer (integer, fourcc)
//   name         (string, plugin display name)
//   subtype      (integer, fourcc)
//   type         (integer, fourcc — 'aufx'/'aumu'/'aumf'/etc.)
//   version      (integer)
//
// Decode a 32-bit big-endian fourcc to its ASCII string.
function decodeFourCC(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return String.fromCharCode(
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ).replace(/[^\x20-\x7e]/g, '·');
}

// Common AU type FourCCs (encoded as integers). Anything starting
// with 'au' (0x6175...) is an Audio Unit. We accept these.
function isAuTypeInt(n) {
  return typeof n === 'number' && ((n >>> 16) === 0x6175);
}

const APPLE_MANUFACTURER = 0x6170706c; // 'appl' — filter these out

// Format strings for path-based plugins (legacy fallback in case any
// Logic project actually stores paths somewhere we can scan).
function formatFromExt(ext) {
  switch (ext.toLowerCase()) {
    case '.component': return 'AU';
    case '.vst3':      return 'VST3';
    case '.vst':       return 'VST2';
    case '.dll':       return 'VST2';
    case '.clap':      return 'CLAP';
    default: return null;
  }
}

// "Could this byte plausibly continue a file extension as a longer
// word?" (only used in the legacy path-scan fallback.) Same as FL.
function isExtensionContinuation(byte) {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}
function isPathChar(byte) {
  return byte >= 0x20 && byte <= 0x7e;
}

// Pull XML plist regions out of the binary. Each region runs from
// `<?xml version` to the matching `</plist>`. Returns an array of
// strings (one per plist). Null bytes and binary garbage between
// regions are skipped.
function extractXmlPlistRegions(buf) {
  const regions = [];
  const xmlStart = Buffer.from('<?xml version', 'ascii');
  const plistEnd = Buffer.from('</plist>', 'ascii');
  let from = 0;
  while (from < buf.length) {
    const startIdx = buf.indexOf(xmlStart, from);
    if (startIdx < 0) break;
    const endIdx = buf.indexOf(plistEnd, startIdx);
    if (endIdx < 0) break;
    const endOfRegion = endIdx + plistEnd.length;
    regions.push(buf.toString('utf8', startIdx, endOfRegion));
    from = endOfRegion;
  }
  return regions;
}

// Walk every top-level <dict>...</dict> in an XML plist string and
// pull out AU plugin descriptors. A descriptor has keys:
// manufacturer, name, subtype, type, version.
//
// IMPORTANT: a non-greedy regex won't work here. Logic embeds large
// plugin-state dicts whose bodies CONTAIN smaller <dict>s (parameter
// trees, etc.). A non-greedy match grabs the innermost dict — which
// almost never has the AU 5-tuple — and the outer descriptor never
// gets matched. So we walk the string tracking open/close depth and
// emit one (start..end) range per top-level dict.
function extractAUDescriptorsFromXml(xml, records) {
  const dictOpen = '<dict>';
  const dictClose = '</dict>';
  let depth = 0;
  let topStart = -1;
  const ranges = [];
  let i = 0;
  while (i < xml.length) {
    if (xml.startsWith(dictOpen, i)) {
      if (depth === 0) topStart = i;
      depth++;
      i += dictOpen.length;
      continue;
    }
    if (xml.startsWith(dictClose, i)) {
      depth--;
      if (depth === 0 && topStart >= 0) {
        ranges.push([topStart, i + dictClose.length]);
        topStart = -1;
      }
      i += dictClose.length;
      continue;
    }
    i++;
  }

  for (const [start, end] of ranges) {
    const body = xml.substring(start, end);
    if (!body.includes('<key>manufacturer</key>')) continue;
    if (!body.includes('<key>type</key>')) continue;
    if (!body.includes('<key>name</key>')) continue;

    const nameMatch  = body.match(/<key>name<\/key>\s*<string>([^<]*)<\/string>/);
    const typeMatch  = body.match(/<key>type<\/key>\s*<integer>(-?\d+)<\/integer>/);
    const manuMatch  = body.match(/<key>manufacturer<\/key>\s*<integer>(-?\d+)<\/integer>/);
    const subtMatch  = body.match(/<key>subtype<\/key>\s*<integer>(-?\d+)<\/integer>/);

    if (!typeMatch || !manuMatch) continue;
    const typeInt = parseInt(typeMatch[1], 10);
    if (!isAuTypeInt(typeInt)) continue;
    const manuInt = parseInt(manuMatch[1], 10);
    if (manuInt === APPLE_MANUFACTURER) continue;
    const subtInt = subtMatch ? parseInt(subtMatch[1], 10) : 0;

    // The descriptor's `name` is whatever the user named the track /
    // channel (e.g. "Init 1", "Untitled", or empty). It's NOT the
    // plugin's display name in Logic's library. We keep it as a
    // hint but fall back to a manufacturer-derived label so the
    // plugin always shows up.
    const channelName = nameMatch ? nameMatch[1].trim() : '';
    const manuFourCC = decodeFourCC(manuInt);
    const typeFourCC = decodeFourCC(typeInt);
    const subtFourCC = decodeFourCC(subtInt);
    const identifier = ['au', typeFourCC, subtFourCC, manuFourCC].join(':');
    const key = identifier.toLowerCase();

    // Display: prefer the channel name when non-empty (e.g. "Init 1"
    // is informative even if it's the user's label); otherwise build
    // a placeholder like "subtype (manufacturer)".
    const displayName = channelName || `${subtFourCC} (${manuFourCC})`;

    if (!records.has(key)) {
      records.set(key, {
        name: displayName,
        identifier,
        format: 'AU',
        count: 0,
        manufacturer: manuFourCC,
        channelName: channelName || null,
      });
    }
    records.get(key).count++;
    const rec = records.get(key);
    if (channelName && (!rec.channelName || channelName.length > rec.channelName.length)) {
      rec.channelName = channelName;
      if (!channelName.startsWith('Untitled') && !/^Init\s+\d+$/i.test(channelName)) {
        rec.name = channelName;
      }
    }
  }
}

// ---- Binary plist (bplist00) extraction ---------------------------
//
// Logic embeds NSKeyedArchiver-encoded bplists inside ProjectData for
// the bulk of its plugin metadata. To extract AU descriptors we find
// each bplist00 magic in the binary, parse the chunk with
// `bplist-parser`, walk the resulting object graph, and pick out
// any dict that looks like an AU descriptor (has name + type +
// manufacturer keys).
//
// NSKeyedArchiver wrinkle: instead of inline values, dict properties
// are { UID: N } references into a $objects array. resolveUID() and
// the NSKeyedArchiver-detection branch in walkForAUDescriptors handle
// that.

// Find every bplist00 region in `buf` and try to parse each as a
// stand-alone bplist. We don't know where each region ends, so we
// slice up to the next bplist00 (or end of buffer) and progressively
// trim trailing bytes until the trailer parses. Returns the array of
// successfully-parsed top-level objects.
function findAndParseBplists(buf) {
  const magic = Buffer.from('bplist00', 'ascii');
  const offsets = [];
  let from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(magic, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + 8;
  }
  const parsedResults = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const upperBound = (i + 1 < offsets.length) ? offsets[i + 1] : buf.length;
    // The bplist trailer is 32 bytes at the END of the bplist. We
    // don't know the exact end inside this region, so we try the
    // largest slice first then shrink. Most often the bplist ends
    // right before the next chunk of binary data.
    let parsed = null;
    const maxTrim = Math.min(256, upperBound - start - 40);
    for (let trim = 0; trim <= maxTrim; trim++) {
      const slice = buf.subarray(start, upperBound - trim);
      if (slice.length < 40) break;
      try {
        const out = bplist.parseBuffer(slice);
        parsed = out;
        break;
      } catch { /* try next */ }
    }
    if (parsed) parsedResults.push(parsed);
  }
  return parsedResults;
}

// Resolve a `{ UID: N }` reference through an NSKeyedArchiver
// $objects array. Returns the resolved object, or the input unchanged
// if it isn't a UID ref.
function resolveUID(v, objects) {
  if (objects && v && typeof v === 'object' && 'UID' in v && Object.keys(v).length === 1) {
    const idx = v.UID;
    if (typeof idx === 'number' && idx >= 0 && idx < objects.length) {
      return objects[idx];
    }
  }
  return v;
}

// Materialize an NSDictionary stored in NSKeyedArchiver form into a
// plain JS dict by zipping its parallel NS.keys / NS.objects arrays
// and resolving each entry through the $objects table.
//
// Returns null if `obj` doesn't look like a serialized NSDictionary.
function nsDictionaryToPlain(obj, objects) {
  if (!obj || typeof obj !== 'object') return null;
  if (!('NS.keys' in obj) || !('NS.objects' in obj)) return null;
  const rawKeys = obj['NS.keys'];
  const rawVals = obj['NS.objects'];
  if (!Array.isArray(rawKeys) || !Array.isArray(rawVals)) return null;
  const out = {};
  const n = Math.min(rawKeys.length, rawVals.length);
  for (let i = 0; i < n; i++) {
    const k = resolveUID(rawKeys[i], objects);
    if (typeof k !== 'string') continue;
    out[k] = resolveUID(rawVals[i], objects);
  }
  return out;
}

// Once we have a plain dict (either an inline JS object or a flattened
// NSDictionary), check whether it looks like an AU descriptor and
// record it.
function tryRecordAUDescriptor(dict, records) {
  if (!dict || typeof dict !== 'object') return false;
  if (!('name' in dict)) return false;
  if (!('type' in dict)) return false;
  if (!('manufacturer' in dict)) return false;
  const name = dict.name;
  const type = dict.type;
  const manu = dict.manufacturer;
  const subt = dict.subtype;
  if (typeof name !== 'string' || typeof type !== 'number' || typeof manu !== 'number') return false;
  if (!isAuTypeInt(type)) return false;
  if (manu === APPLE_MANUFACTURER) return false;
  const trimmedName = name.trim();
  if (!trimmedName) return false;
  const subtInt = typeof subt === 'number' ? subt : 0;
  const id = ['au', decodeFourCC(type), decodeFourCC(subtInt), decodeFourCC(manu)].join(':');
  const key = id.toLowerCase();
  if (!records.has(key)) {
    records.set(key, {
      name: trimmedName,
      identifier: id,
      format: 'AU',
      count: 0,
      manufacturer: decodeFourCC(manu),
    });
  }
  records.get(key).count++;
  const rec = records.get(key);
  if (trimmedName.length > rec.name.length) rec.name = trimmedName;
  return true;
}

// Recursively walk a parsed bplist object graph. Two key cases:
//
//   1. NSKeyedArchiver wrapper at top — recurse into $objects with
//      resolution enabled.
//   2. NSDictionary inside $objects — materialize via NS.keys /
//      NS.objects then check for AU descriptor pattern.
//
// Plain JS objects (from inline-encoded bplists) work via the same
// AU-descriptor check without any NSKeyedArchiver hoops.
function walkForAUDescriptors(obj, records, objects) {
  if (obj == null) return;
  if (Array.isArray(obj)) {
    for (const it of obj) walkForAUDescriptors(it, records, objects);
    return;
  }
  if (typeof obj !== 'object') return;

  // NSKeyedArchiver wrapper.
  if (obj.$archiver && Array.isArray(obj.$objects)) {
    const objs = obj.$objects;
    for (const item of objs) walkForAUDescriptors(item, records, objs);
    return;
  }

  // NSDictionary (NS.keys / NS.objects parallel arrays).
  const flat = nsDictionaryToPlain(obj, objects);
  if (flat) {
    tryRecordAUDescriptor(flat, records);
    // Recurse into the flattened values too — sometimes AU descriptor
    // dicts are nested inside other dicts.
    for (const v of Object.values(flat)) {
      walkForAUDescriptors(v, records, objects);
    }
    return;
  }

  // Plain inline JS object — try direct match.
  tryRecordAUDescriptor(obj, records);

  // Recurse, resolving UIDs first when applicable.
  for (const k of Object.keys(obj)) {
    walkForAUDescriptors(resolveUID(obj[k], objects), records, objects);
  }
}

// Read a uint64 big-endian as a regular Number (we don't expect bplist
// fields to exceed 2^53; if they do they're not valid AU descriptors
// anyway).
function readU64BE(buf, off) {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return hi * 0x100000000 + lo;
}

// Test whether a 32-byte window at buf[trailerOff..trailerOff+32] looks
// like a valid bplist trailer for a bplist starting at `bplistStart`.
// Returns the size in bytes (trailerOff + 32 - bplistStart) if valid,
// or null if not.
function checkTrailer(buf, bplistStart, trailerOff) {
  if (trailerOff + 32 > buf.length) return null;
  if (trailerOff <= bplistStart + 8) return null;
  // First 5 bytes are reserved (must be zero); 6th is sortVersion.
  for (let i = 0; i < 5; i++) {
    if (buf[trailerOff + i] !== 0) return null;
  }
  const offsetIntSize = buf[trailerOff + 6];
  const objectRefSize = buf[trailerOff + 7];
  if (![1, 2, 4, 8].includes(offsetIntSize)) return null;
  if (![1, 2, 4, 8].includes(objectRefSize)) return null;
  const numObjects = readU64BE(buf, trailerOff + 8);
  const topObject = readU64BE(buf, trailerOff + 16);
  const offsetTableOffset = readU64BE(buf, trailerOff + 24);
  // Sanity: numObjects > 0, reasonable upper bound
  if (numObjects < 1 || numObjects > 5_000_000) return null;
  if (topObject >= numObjects) return null;
  // Offset table must live between the header and the trailer, and
  // the table itself must fit within the trailer's start position.
  const bplistRelativeOffsetTable = offsetTableOffset;
  if (bplistRelativeOffsetTable < 9) return null;
  const offsetTableEnd = bplistStart + bplistRelativeOffsetTable + (numObjects * offsetIntSize);
  // The offset table should end exactly at the trailer start.
  if (offsetTableEnd !== trailerOff) return null;
  return trailerOff + 32 - bplistStart;
}

// Find the actual end of a bplist starting at `bplistStart` by
// scanning forward for a valid trailer signature. Returns the size
// of the bplist in bytes, or null if no valid trailer was found.
function findBplistSize(buf, bplistStart, maxSearch) {
  const limit = Math.min(buf.length - 32, bplistStart + maxSearch);
  // Trailer must be at offset = bplistStart + bplistSize - 32.
  // The 5 reserved zero bytes at the START of the trailer are our
  // anchor. Scan for sequences of 5+ zero bytes and validate each.
  for (let off = bplistStart + 16; off <= limit; off++) {
    // Quick reject: most positions don't have 5 zero bytes.
    if (buf[off] !== 0 || buf[off + 1] !== 0 || buf[off + 2] !== 0 ||
        buf[off + 3] !== 0 || buf[off + 4] !== 0) continue;
    const size = checkTrailer(buf, bplistStart, off);
    if (size !== null) return size;
  }
  return null;
}

function findAndParseBplistsWithStats(buf) {
  const magic = Buffer.from('bplist00', 'ascii');
  const offsets = [];
  let from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(magic, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + 8;
  }
  const parsedResults = [];
  const failures = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const upperBound = (i + 1 < offsets.length) ? offsets[i + 1] : buf.length;

    // STRATEGY 1: structurally find the bplist's actual end via its
    // trailer signature. This is the reliable path — it returns the
    // exact size so we slice precisely.
    let parsed = null;
    let lastErr = null;
    const exactSize = findBplistSize(buf, start, upperBound - start);
    if (exactSize !== null) {
      try {
        const slice = buf.subarray(start, start + exactSize);
        parsed = bplist.parseBuffer(slice);
      } catch (err) { lastErr = err; }
    }

    // STRATEGY 2 (fallback): if trailer detection didn't find a valid
    // structure, brute-force trim from the end until parsing succeeds.
    if (!parsed) {
      const maxTrim = Math.min(256, upperBound - start - 40);
      for (let trim = 0; trim <= maxTrim; trim++) {
        const slice = buf.subarray(start, upperBound - trim);
        if (slice.length < 40) break;
        try {
          parsed = bplist.parseBuffer(slice);
          break;
        } catch (err) { lastErr = err; }
      }
    }

    if (parsed) parsedResults.push(parsed);
    else failures.push({ offset: start, size: upperBound - start, err: lastErr && lastErr.message });
  }
  return { parsedResults, failures, offsetCount: offsets.length };
}

// Last-resort scan: walk the raw binary looking for occurrences of an
// AU type FourCC ('aufx', 'aumu', 'aumf', 'augn', 'aupn', 'aumx'),
// then check whether the bytes immediately after look like a plausible
// (type, subtype, manufacturer) 12-byte triple. This finds plugins
// stored in Logic's proprietary track-state binary section — without
// needing to understand that section's overall structure.
//
// Returns an array of { type, subtype, manufacturer } triples found
// (each as 4-char FourCC strings).
function scanForAUFourCCTriples(buf) {
  const VALID_AU_TYPES = new Set(['aufx', 'aumu', 'aumf', 'augn', 'aupn', 'aumx', 'auFC', 'auol']);
  // Map FourCC int → string, only for valid AU types.
  function fourCCStr(int) {
    const s = String.fromCharCode((int >>> 24) & 0xff, (int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff);
    return s;
  }
  // FourCC bytes must be printable ASCII for manufacturer/subtype to
  // be plausible.
  function isPrintableFourCC(int) {
    for (let shift = 24; shift >= 0; shift -= 8) {
      const c = (int >>> shift) & 0xff;
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }
  const triples = new Map(); // "type:subtype:manu" → { type, subtype, manufacturer, count }
  // Walk byte by byte looking for 0x61 0x75 followed by 2 ASCII chars.
  // Both big-endian and little-endian layouts are possible — Logic
  // mostly uses big-endian for FourCCs (matches Audio Unit conventions).
  for (let i = 0; i + 12 <= buf.length; i++) {
    if (buf[i] !== 0x61 || buf[i + 1] !== 0x75) continue;
    // Candidate type FourCC at i..i+4
    const typeInt = buf.readUInt32BE(i);
    const typeStr = fourCCStr(typeInt);
    if (!VALID_AU_TYPES.has(typeStr)) continue;
    // Next 4 bytes = subtype, then 4 bytes = manufacturer
    const subtInt = buf.readUInt32BE(i + 4);
    const manuInt = buf.readUInt32BE(i + 8);
    if (!isPrintableFourCC(subtInt) || !isPrintableFourCC(manuInt)) continue;
    const subtStr = fourCCStr(subtInt);
    const manuStr = fourCCStr(manuInt);
    // Filter Apple
    if (manuStr === 'appl') continue;
    const key = `${typeStr}:${subtStr}:${manuStr}`;
    if (!triples.has(key)) {
      triples.set(key, { type: typeStr, subtype: subtStr, manufacturer: manuStr, count: 0 });
    }
    triples.get(key).count++;
    // Skip ahead so we don't accidentally re-match overlapping bytes
    i += 11;
  }
  return [...triples.values()];
}

function extractAUPluginsFromBinary(buf, debugSink) {
  const records = new Map();

  // Source 1: XML plist regions.
  const xmlRegions = extractXmlPlistRegions(buf);
  const beforeXml = records.size;
  for (const xml of xmlRegions) {
    extractAUDescriptorsFromXml(xml, records);
  }
  const xmlAdded = records.size - beforeXml;

  // Source 2: binary plists (bplist00 — usually NSKeyedArchiver).
  const { parsedResults: bplists, failures, offsetCount } = findAndParseBplistsWithStats(buf);
  const beforeBplist = records.size;
  for (const root of bplists) {
    walkForAUDescriptors(root, records, null);
  }
  const bplistAdded = records.size - beforeBplist;

  // Source 3: raw FourCC scan over the proprietary binary section.
  // Each unique non-Apple (type, subtype, manufacturer) triple becomes
  // a plugin record. We don't know the human-readable plugin name from
  // FourCCs alone — that needs lookup against the user's installed AU
  // library — so the record uses the manufacturer FourCC + subtype as
  // a placeholder name. The renderer can resolve to a real name when
  // a matching library item has the same fourcc identifier.
  const triples = scanForAUFourCCTriples(buf);
  const beforeTriples = records.size;
  for (const t of triples) {
    const id = ['au', t.type, t.subtype, t.manufacturer].join(':');
    const key = id.toLowerCase();
    if (records.has(key)) continue;  // already named from plist/bplist
    records.set(key, {
      name: `${t.subtype} (${t.manufacturer})`,   // fallback display
      identifier: id,
      format: 'AU',
      count: t.count,
      manufacturer: t.manufacturer,
      _fourccOnly: true,                          // flag for the renderer
    });
  }
  const triplesAdded = records.size - beforeTriples;

  if (debugSink) {
    debugSink.xmlRegions = xmlRegions.length;
    debugSink.xmlAdded = xmlAdded;
    debugSink.bplistFound = offsetCount;
    debugSink.bplistParsed = bplists.length;
    debugSink.bplistFailed = failures.length;
    debugSink.bplistAdded = bplistAdded;
    debugSink.bplistFailures = failures.slice(0, 5);
    debugSink.triplesFound = triples.length;
    debugSink.triplesAdded = triplesAdded;
    debugSink.triplesSample = triples.slice(0, 12).map((t) => `${t.type}/${t.subtype}/${t.manufacturer}×${t.count}`);
    debugSink.bplistShapes = bplists.slice(0, 10).map((root) => {
      if (Array.isArray(root)) {
        if (root.length === 0) return 'array(empty)';
        const top = root[0];
        if (top && typeof top === 'object' && top.$archiver) {
          const objCount = Array.isArray(top.$objects) ? top.$objects.length : 0;
          return `NSKeyedArchiver($objects=${objCount})`;
        }
        return `array(len=${root.length}, top=${typeof top})`;
      }
      return `${typeof root}`;
    });
    // Deep introspection — for each NSKeyedArchiver bplist, look at
    // what's actually in $objects. We want to know:
    //   - what classes appear (NSDictionary, NSArray, etc.)
    //   - what strings are present (plugin names should show here)
    //   - what dicts contain AU-ish keys
    debugSink.bplistIntrospection = [];
    for (let i = 0; i < bplists.length; i++) {
      const root = Array.isArray(bplists[i]) ? bplists[i][0] : bplists[i];
      if (!root || !root.$archiver || !Array.isArray(root.$objects)) continue;
      const objs = root.$objects;
      const info = { idx: i, totalObjects: objs.length };
      // Tally class names
      const classNames = new Map();
      const stringSamples = [];
      const dictKeySets = new Map();   // key-set signature → count
      for (const obj of objs) {
        if (typeof obj === 'string') {
          if (stringSamples.length < 80 && obj.length >= 3 && obj.length < 80) {
            stringSamples.push(obj);
          }
          continue;
        }
        if (obj && typeof obj === 'object' && obj.$class) {
          const classRef = obj.$class;
          let className = '?';
          if (classRef && typeof classRef === 'object' && 'UID' in classRef) {
            const classObj = objs[classRef.UID];
            if (classObj && typeof classObj === 'object' && classObj.$classname) {
              className = String(classObj.$classname);
            }
          }
          classNames.set(className, (classNames.get(className) || 0) + 1);
          // Capture key signatures for NSDictionary instances
          if (className === 'NSDictionary' || className === 'NSMutableDictionary') {
            if (Array.isArray(obj['NS.keys'])) {
              const keys = obj['NS.keys']
                .map((k) => k && typeof k === 'object' && 'UID' in k ? objs[k.UID] : k)
                .filter((k) => typeof k === 'string')
                .sort();
              const sig = keys.join('|');
              dictKeySets.set(sig, (dictKeySets.get(sig) || 0) + 1);
            }
          }
        }
      }
      info.classes = [...classNames.entries()].sort((a, b) => b[1] - a[1]);
      info.uniqueStrings = stringSamples.length;
      info.sampleStrings = stringSamples.slice(0, 30);
      info.topDictKeySigs = [...dictKeySets.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);

      // Pull a sample of each unique non-trivial class so we can see
      // what keys/values it actually holds. Resolve any UID refs in
      // its property values to make the dump useful.
      const skipClassNames = new Set(['NSArray', 'NSMutableArray', 'NSString', 'NSMutableString', 'NSNumber', 'NSData']);
      const sampledClasses = new Set();
      info.classSamples = [];
      for (const obj of objs) {
        if (!obj || typeof obj !== 'object' || !obj.$class) continue;
        const classRef = obj.$class;
        if (!classRef || typeof classRef !== 'object' || !('UID' in classRef)) continue;
        const classObj = objs[classRef.UID];
        if (!classObj || !classObj.$classname) continue;
        const className = String(classObj.$classname);
        if (skipClassNames.has(className)) continue;
        if (sampledClasses.has(className)) continue;
        sampledClasses.add(className);

        // Build a flat key→value description, resolving UIDs.
        const sample = { className, props: {} };
        for (const k of Object.keys(obj)) {
          if (k === '$class') continue;
          const raw = obj[k];
          let resolved = raw;
          if (raw && typeof raw === 'object' && 'UID' in raw && Object.keys(raw).length === 1) {
            resolved = objs[raw.UID];
          }
          // Truncate the value for display.
          let display;
          if (resolved == null) display = 'null';
          else if (typeof resolved === 'string') display = JSON.stringify(resolved.length > 60 ? resolved.slice(0, 60) + '…' : resolved);
          else if (typeof resolved === 'number') display = String(resolved);
          else if (typeof resolved === 'boolean') display = String(resolved);
          else if (Buffer.isBuffer(resolved)) display = `<Buffer ${resolved.length}B>`;
          else if (resolved && resolved.$classname) display = `<${resolved.$classname}>`;
          else if (resolved && resolved.$class) display = `<object/$class>`;
          else if (Array.isArray(resolved)) display = `<array len=${resolved.length}>`;
          else if (typeof resolved === 'object') display = `<dict keys=[${Object.keys(resolved).slice(0, 5).join(',')}]>`;
          else display = String(resolved);
          sample.props[k] = display;
        }
        info.classSamples.push(sample);
        if (info.classSamples.length >= 6) break;
      }

      debugSink.bplistIntrospection.push(info);
    }
  }

  return [...records.values()];
}

function looksLikePluginPath(p) {
  if (!p) return false;
  if (p.length < 5 || p.length > 400) return false;
  if (!/[/\\]/.test(p)) return false;
  const printable = (p.match(/[A-Za-z0-9 _\-./\\:]/g) || []).length / p.length;
  if (printable < 0.9) return false;
  if (/[/\\]{3,}/.test(p)) return false;
  return true;
}

function scanForPluginPaths(buf) {
  const records = new Map();
  const claimed = [];

  function addHit({ name, identifier, format, hitStart, hitEnd }) {
    for (const [s, e] of claimed) {
      if (hitStart < e && hitEnd > s) return;
    }
    claimed.push([hitStart, hitEnd]);
    const key = identifier.toLowerCase();
    if (!records.has(key)) {
      records.set(key, { name, identifier, format, count: 0 });
    }
    records.get(key).count++;
    const rec = records.get(key);
    if (name && (!rec.name || rec.name.length < name.length)) rec.name = name;
  }

  // .component MUST come before .vst3 / .vst in the list so the
  // longer extension matches preferentially when both could apply.
  // (A path ending in .component never also ends in .vst, but the
  // claimed-region tracking will skip the shorter match either way.)
  const EXTS = ['.component', '.vst3', '.vst', '.dll', '.clap'];

  // ---- Pass 1: UTF-16-LE ----
  for (const ext of EXTS) {
    const needle = Buffer.from(ext, 'utf16le');
    let from = 0;
    while (from < buf.length) {
      const idx = buf.indexOf(needle, from);
      if (idx < 0) break;
      const endOfExt = idx + needle.length;
      let okBoundary = true;
      if (endOfExt + 2 <= buf.length) {
        const lo = buf[endOfExt];
        const hi = buf[endOfExt + 1];
        if (hi === 0 && isExtensionContinuation(lo)) okBoundary = false;
      }
      if (!okBoundary) { from = idx + 2; continue; }
      let s = idx;
      while (s >= 2) {
        const lo = buf[s - 2];
        const hi = buf[s - 1];
        if (hi !== 0) break;
        if (lo < 0x20) break;
        s -= 2;
      }
      const raw = buf.subarray(s, endOfExt).toString('utf16le');
      const clean = raw.replace(/^[^A-Za-z/\\]+/, '');
      if (looksLikePluginPath(clean)) {
        const base = clean.split(/[/\\]/).pop();
        const stem = base.replace(/\.[^.]+$/, '');
        if (stem && stem.length > 0 && stem.length < 120 && /[A-Za-z]/.test(stem)) {
          addHit({ name: stem, identifier: clean, format: formatFromExt(ext), hitStart: s, hitEnd: endOfExt });
        }
      }
      from = endOfExt;
    }
  }

  // ---- Pass 2: Latin-1 / ASCII ----
  for (const ext of EXTS) {
    const needle = Buffer.from(ext, 'latin1');
    let from = 0;
    while (from < buf.length) {
      const idx = buf.indexOf(needle, from);
      if (idx < 0) break;
      const endOfExt = idx + needle.length;
      let okBoundary = true;
      if (endOfExt < buf.length) {
        const ch = buf[endOfExt];
        if (isExtensionContinuation(ch)) okBoundary = false;
      }
      if (!okBoundary) { from = idx + 1; continue; }
      let s = idx;
      while (s > 0) {
        const ch = buf[s - 1];
        if (!isPathChar(ch)) break;
        s--;
      }
      const raw = buf.subarray(s, endOfExt).toString('latin1');
      const clean = raw.replace(/^[^A-Za-z/\\]+/, '');
      if (looksLikePluginPath(clean)) {
        const base = clean.split(/[/\\]/).pop();
        const stem = base.replace(/\.[^.]+$/, '');
        if (stem && stem.length > 0 && stem.length < 120 && /[A-Za-z]/.test(stem)) {
          addHit({ name: stem, identifier: clean, format: formatFromExt(ext), hitStart: s, hitEnd: endOfExt });
        }
      }
      from = endOfExt;
    }
  }

  return [...records.values()];
}

// Extract the project tempo (BPM) from a Logic ProjectData buffer.
//
// Logic encodes BPM as Int32-LE × 10000 (so 120 BPM = 1,200,000 =
// 0x80 0x4f 0x12 0x00). Real tempo records are wrapped in this 8-byte
// type marker, verified against a project where the pattern
//
//   04 02 07 01 00 00 00 08 <Int32-LE BPM×10000>
//
// appeared exactly twice in the first 1 KB. (The same BPM value
// also shows up at @170/@174 as bare paired Int32s — those are the
// initial-tempo doublet at the very head of the tempo region, but
// they have no record header, so we can't reliably anchor on them.)
//
// Strategy: find every occurrence of the 8-byte marker, decode the
// next 4 bytes as tempo × 10000, tally, return the dominant BPM.
// Markers are extremely specific (probability ~1 in 2^64 of random
// coincidence) so even one hit is reliable. Most projects have ≥2
// because tempo records duplicate across alternative-region copies.
//
// Fallback for very old Logic projects: if no marker found, fall
// back to the "most common plausible BPM in first 64 KB" heuristic
// but tighten the threshold (require ≥3 occurrences) to suppress
// false positives.
const TEMPO_RECORD_MARKER = Buffer.from(
  [0x04, 0x02, 0x07, 0x01, 0x00, 0x00, 0x00, 0x08]
);

function extractLogicTempo(buf) {
  const SCAN_BYTES = Math.min(buf.length - 12, 64 * 1024);
  if (SCAN_BYTES < 12) return null;
  const MIN_BPM_SCALED = 20 * 10000;
  const MAX_BPM_SCALED = 300 * 10000;

  // --- Primary path: anchored on the tempo record marker ---
  const counts = new Map();
  let from = 0;
  while (from <= SCAN_BYTES) {
    const idx = buf.indexOf(TEMPO_RECORD_MARKER, from);
    if (idx < 0 || idx > SCAN_BYTES) break;
    from = idx + TEMPO_RECORD_MARKER.length;
    const v = buf.readInt32LE(idx + 8);
    if (v < MIN_BPM_SCALED || v > MAX_BPM_SCALED) continue;
    const bpm = v / 10000;
    const rounded = Math.round(bpm * 100) / 100;
    if (Math.abs(bpm - rounded) > 0.0001) continue;
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  }
  if (counts.size > 0) {
    let best = null, bestCount = 0;
    for (const [bpm, c] of counts) {
      if (c > bestCount) { bestCount = c; best = bpm; }
    }
    if (DEBUG) {
      console.log(`[LOGIC]   tempo marker candidates: ${[...counts.entries()].map(([k,v]) => `${k}×${v}`).join(', ')}`);
    }
    return best;
  }

  // --- Fallback: most common plausible BPM ---
  const fallbackCounts = new Map();
  for (let i = 0; i <= SCAN_BYTES; i++) {
    const v = buf.readInt32LE(i);
    if (v < MIN_BPM_SCALED || v > MAX_BPM_SCALED) continue;
    const bpm = v / 10000;
    const rounded = Math.round(bpm * 100) / 100;
    if (Math.abs(bpm - rounded) > 0.0001) continue;
    fallbackCounts.set(rounded, (fallbackCounts.get(rounded) || 0) + 1);
  }
  let bestBpm = null, bestCount = 0;
  for (const [bpm, count] of fallbackCounts) {
    if (count > bestCount) { bestCount = count; bestBpm = bpm; }
  }
  if (bestCount < 3) return null;   // require stronger evidence in
                                    // fallback mode since the noise
                                    // floor is higher
  return bestBpm;
}

// Logic stores the project key signature on its global Signature
// track using MIDI's standard 2-byte encoding (signed sharps/flats
// byte + mode byte where 0=major, 1=minor), wrapped in a type-25
// record header. The full byte pattern is:
//
//   19 00 00 00 <sf:int8> <mode:uint8> 00 00 00 00
//
// Verified empirically against a project set to F minor (sf=-4,
// mode=1): the pattern `19 00 00 00 fc 01 00 00 00 00` appears
// exactly twice in the first 20 KB of ProjectData, and no other
// `19 00 00 00 ...` record passes the (sf in -7..7, mode in {0,1})
// validation. So the structural fingerprint is unambiguous.
//
// Looking up (sf, mode) → human-readable name uses the conventional
// MIDI key-signature table.
const SF_MODE_TO_KEY = (() => {
  const table = {
    // sf:mode key
    '0:0': 'C major',  '1:0': 'G major',  '2:0': 'D major',  '3:0': 'A major',
    '4:0': 'E major',  '5:0': 'B major',  '6:0': 'F# major', '7:0': 'C# major',
    '-1:0': 'F major', '-2:0': 'Bb major', '-3:0': 'Eb major', '-4:0': 'Ab major',
    '-5:0': 'Db major','-6:0': 'Gb major', '-7:0': 'Cb major',
    '0:1': 'A minor',  '1:1': 'E minor',  '2:1': 'B minor',  '3:1': 'F# minor',
    '4:1': 'C# minor', '5:1': 'G# minor', '6:1': 'D# minor', '7:1': 'A# minor',
    '-1:1': 'D minor', '-2:1': 'G minor', '-3:1': 'C minor', '-4:1': 'F minor',
    '-5:1': 'Bb minor','-6:1': 'Eb minor', '-7:1': 'Ab minor',
  };
  return table;
})();

function extractLogicKey(buf) {
  const SCAN_BYTES = Math.min(buf.length - 16, 64 * 1024);
  if (SCAN_BYTES < 16) return null;
  const HEADER = Buffer.from([0x19, 0x00, 0x00, 0x00]);

  // Tally each (sf, mode) pair that survives the structural filter.
  // The `19 00 00 00` prefix is Logic's type-25 record header — it
  // marks MANY record types, not just KeySignature. To filter down
  // to real key sigs we require:
  //   - bytes [6..15] are all zero (10 bytes of body padding —
  //     verified against F minor records that had 18 trailing zeros)
  //   - sf is in -7..7 (valid sharps/flats range)
  //   - mode is 0 (major) or 1 (minor)
  // Even with these filters, non-keysig records can collide on the
  // sf/mode bytes by coincidence. We also tally everything and pick
  // the most common pair — in projects with one stable key, the
  // real key wins by occurrence count.
  const counts = new Map();
  const debugSamples = DEBUG ? [] : null;
  let from = 0;
  while (from <= SCAN_BYTES) {
    const idx = buf.indexOf(HEADER, from);
    if (idx < 0 || idx > SCAN_BYTES) break;
    from = idx + 4;

    // Require 10 zero bytes after the (sf, mode) pair.
    let allZero = true;
    for (let i = idx + 6; i < idx + 16; i++) {
      if (buf[i] !== 0) { allZero = false; break; }
    }
    if (!allZero) continue;

    const sfByte = buf[idx + 4];
    const mode   = buf[idx + 5];
    const sf = (sfByte > 127) ? (sfByte - 256) : sfByte;
    if (sf < -7 || sf > 7) continue;
    if (mode !== 0 && mode !== 1) continue;

    const k = `${sf}:${mode}`;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (debugSamples && debugSamples.length < 30) {
      // Capture 16 bytes BEFORE the `19` header + 16 bytes AFTER —
      // so we can look for distinguishing markers between real
      // KeySignature records and structurally-similar non-keysig
      // type-25 records that pass our (sf, mode, padding) filter.
      const beforeStart = Math.max(0, idx - 16);
      const beforeBytes = buf.subarray(beforeStart, idx);
      const afterEnd = Math.min(buf.length, idx + 16);
      const afterBytes = buf.subarray(idx, afterEnd);
      const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      debugSamples.push({
        offset: idx, sf, mode, key: SF_MODE_TO_KEY[k] || '?',
        before: toHex(beforeBytes),
        after: toHex(afterBytes),
      });
    }
  }

  if (DEBUG) {
    console.log(`[LOGIC]   key candidates (sf:mode → count, decoded):`);
    for (const [k, c] of counts) {
      console.log(`[LOGIC]     ${k}  ×${c}   ${SF_MODE_TO_KEY[k] || '?'}`);
    }
    if (debugSamples && debugSamples.length) {
      console.log(`[LOGIC]   ALL key hits with 16 bytes before / 16 after:`);
      for (const s of debugSamples) {
        console.log(`[LOGIC]     @${s.offset}  ${s.key}  (sf=${s.sf} mode=${s.mode})`);
        console.log(`[LOGIC]       before:  ${s.before}`);
        console.log(`[LOGIC]       at/after: ${s.after}`);
      }
    }
  }

  if (!counts.size) return null;
  let bestKey = null, bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) { bestCount = c; bestKey = k; }
  }
  return SF_MODE_TO_KEY[bestKey] || null;
}

// Logic Audio Units that ship with the DAW. These show up in
// ProjectData as paths under /Library/Audio/Plug-Ins/Components/
// — we treat them as "native" the same way FL natives are filtered:
// only third-party plugins make it into the result list (matching
// the user's earlier preference: "VST/AU plugins only").
const LOGIC_NATIVE_AU_NAMES = new Set([
  // Synths
  'es1', 'es2', 'es e', 'es m', 'es p',
  'efm1',
  'esx24', 'exs24',
  'sculpture',
  'ultrabeat',
  'retro synth',
  'alchemy',
  'sample alchemy',
  'drum kit designer',
  'drum machine designer',
  'drum synth',
  'klopfgeist',
  'quick sampler',
  'studio bass',
  'studio horns',
  'studio strings',
  'studio piano',
  'vintage b3',
  'vintage clav',
  'vintage electric piano',
  'vintage mellotron',
  'modular',
  'mellotron',
  'beat breaker',
  'live loops',
  'session player',
  'bass player',
  'drummer',
  'keyboard player',
  // Effects — there are dozens. A representative set; we'll expand
  // as users report misidentifications.
  'channel eq', 'channel-eq',
  'linear phase eq',
  'compressor',
  'limiter',
  'adaptive limiter',
  'multiband compressor', 'multipressor',
  'noise gate',
  'expander',
  'enveloper',
  'gain',
  'space designer',
  'chromaverb',
  'silververb',
  'platinumverb',
  'goldverb',
  'enverb',
  'avverb',
  'tape delay',
  'echo',
  'sample delay',
  'stereo delay',
  'delay designer',
  'modulation delay',
  'chorus',
  'ensemble',
  'flanger',
  'microphaser',
  'phaser',
  'ringshifter',
  'rotor cabinet',
  'scanner vibrato',
  'spreader',
  'tremolo',
  'vintage chorus',
  'vintage flanger',
  'vintage phaser',
  'bass amp designer',
  'amp designer',
  'pedalboard',
  'guitar amp pro',
  'bitcrusher',
  'clip distortion',
  'distortion',
  'distortion ii',
  'overdrive',
  'phase distortion',
  'auto filter',
  'autofilter',
  'envelope filter',
  'fuzz-wah',
  'spectral gate',
  'em-1',  // some are aliases for the Pro vendor name
  'binaural post-processing',
  'direction mixer',
  'matrix',
  'multimeter',
  'stereo spread',
  'level meter',
  'tuner',
  'correlation meter',
  'loudness meter',
  'tube',
  'vintage eq collection',
  'graphic eq',
  'match eq',
  'single band eq',
  'pitch correction',
  'vocal transformer',
  'pitch shifter ii',
  'pitch shifter',
  'speech enhancer',
  'mastering assistant',
  'utility',
  'gain', 'gainer',
  'silencer',
  'denoiser',
  'exciter',
]);

// Normalize a plugin name for blacklist matching — strip non-alphanumerics
// and lowercase. So "Channel EQ", "Channel-EQ", and "ChannelEQ" all
// collapse to "channeleq" and match a single entry.
function normPluginName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const LOGIC_NATIVE_AU_NORMALIZED = new Set(
  [...LOGIC_NATIVE_AU_NAMES].map(normPluginName),
);
function isLogicNativeAU(plugin) {
  if (!plugin) return false;
  const idLower = plugin.identifier ? plugin.identifier.toLowerCase() : '';
  if (idLower) {
    if (/\/applications\/logic[^/]*\.app\//.test(idLower)) return true;
    if (idLower.includes('/library/audio/plug-ins/components/logic')) return true;
  }
  return LOGIC_NATIVE_AU_NORMALIZED.has(normPluginName(plugin.name));
}

// Read project metadata (tempo + key signature + time signature)
// from MetaData.plist. This is by far the cleanest source: Logic
// stores all the project's transport-level data here as a plain
// (XML or binary) plist with labeled fields. Sample fields:
//
//   BeatsPerMinute = 120
//   SongKey        = "F"
//   SongGenderKey  = "minor"
//   SongSignatureNumerator   = 4
//   SongSignatureDenominator = 4
//
// We pick the most-recently-modified Alternative's MetaData.plist
// to match the alternative the user was last working on (same logic
// as findProjectDataFile). Returns { tempo, key, sourcePath } or
// null if no MetaData.plist exists (very old Logic versions, or
// projects saved before Logic Pro X — those fall back to the
// ProjectData binary scan).
async function readLogicMetadata(packageDir) {
  const altsDir = path.join(packageDir, 'Alternatives');
  if (!fsSync.existsSync(altsDir)) return null;

  let entries;
  try { entries = await fs.readdir(altsDir, { withFileTypes: true }); }
  catch { return null; }

  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const mdPath = path.join(altsDir, ent.name, 'MetaData.plist');
    if (!fsSync.existsSync(mdPath)) continue;
    try {
      const stat = await fs.stat(mdPath);
      candidates.push({ path: mdPath, mtime: stat.mtime });
    } catch { /* skip unreadable */ }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  const sourcePath = candidates[0].path;

  let meta;
  try { meta = await parsePlistFile(sourcePath); }
  catch { meta = null; }
  if (!meta || typeof meta !== 'object') return null;

  // Tempo — usually a number, but be lenient if it round-trips
  // through a string somewhere.
  let tempo = null;
  if (typeof meta.BeatsPerMinute === 'number' && Number.isFinite(meta.BeatsPerMinute)) {
    tempo = meta.BeatsPerMinute;
  } else if (typeof meta.BeatsPerMinute === 'string') {
    const n = Number(meta.BeatsPerMinute);
    if (Number.isFinite(n)) tempo = n;
  }

  // Key — combine tonic ("F", "C#", "Bb", etc.) with mode ("major"
  // or "minor"). Result format matches the rest of Plugr ("F minor",
  // "C# major"). If only one half is present, return null since
  // half a key signature isn't useful.
  let key = null;
  const tonic = typeof meta.SongKey === 'string' ? meta.SongKey.trim() : '';
  const gender = typeof meta.SongGenderKey === 'string' ? meta.SongGenderKey.trim().toLowerCase() : '';
  if (tonic && (gender === 'major' || gender === 'minor')) {
    key = `${tonic} ${gender}`;
  }

  // NOTE: Logic Pro doesn't expose its release version anywhere in the
  // .logicx package — not in MetaData.plist (whose "Version" key is the
  // plist schema version, not the Logic Pro version), not in
  // DisplayState.plist, and not anywhere parseable in ProjectData. We
  // tried several candidate keys here previously and they all returned
  // schema-version integers like 3, which got displayed as "Logic Pro 3"
  // and was misleading. Until Apple changes the format, Logic projects
  // simply won't carry a dawVersion. Returning null is honest.
  const dawVersion = null;

  return { tempo, key, sourcePath, dawVersion };
}

// Find the ProjectData binary file inside a .logicx package. Modern
// Logic versions store this in Alternatives/NNN/ProjectData with
// multiple alternatives possible (Alt A, Alt B…); we pick the most
// recently-modified one. Older Logic versions used a single
// ProjectData at the package root.
async function findProjectDataFile(packageDir) {
  const candidates = [];
  // Try Alternatives/*/ProjectData
  const altsDir = path.join(packageDir, 'Alternatives');
  if (fsSync.existsSync(altsDir)) {
    let entries;
    try { entries = await fs.readdir(altsDir, { withFileTypes: true }); }
    catch { entries = []; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pd = path.join(altsDir, ent.name, 'ProjectData');
      if (fsSync.existsSync(pd)) {
        try {
          const stat = await fs.stat(pd);
          candidates.push({ path: pd, mtime: stat.mtime, size: stat.size });
        } catch { /* skip */ }
      }
    }
  }
  // Fallback: ProjectData at the package root.
  const rootPD = path.join(packageDir, 'ProjectData');
  if (fsSync.existsSync(rootPD)) {
    try {
      const stat = await fs.stat(rootPD);
      candidates.push({ path: rootPD, mtime: stat.mtime, size: stat.size });
    } catch { /* skip */ }
  }
  // Fallback: any .lpdb at the package root (very old Logic).
  try {
    const rootEntries = await fs.readdir(packageDir, { withFileTypes: true });
    for (const ent of rootEntries) {
      if (ent.isFile() && /\.lpdb$/i.test(ent.name)) {
        const p = path.join(packageDir, ent.name);
        try {
          const stat = await fs.stat(p);
          candidates.push({ path: p, mtime: stat.mtime, size: stat.size });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  if (candidates.length === 0) return null;
  // Pick the most recently modified — that's the alternative the
  // user was last working on.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

/**
 * Parse a single .logicx package. Same return shape as the Ableton
 * and FL parsers so the rest of Plugr treats it uniformly.
 */
async function parseLogicProject(packageDir) {
  const stat = await fs.stat(packageDir);
  if (!stat.isDirectory()) {
    throw new Error('.logicx must be a directory (Logic Pro package)');
  }
  const projectName = path.basename(packageDir, path.extname(packageDir));

  // DEBUG: walk every file in the package so we can see if plugin
  // metadata might live in something OTHER than ProjectData (channel
  // strip files, sampler instrument files, plugin presets, etc.)
  if (DEBUG) {
    const walked = [];
    async function walk(dir, depth, rel) {
      if (depth > 4) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(full, depth + 1, relPath);
        } else if (ent.isFile()) {
          try {
            const s = await fs.stat(full);
            walked.push({ relPath, size: s.size });
          } catch { /* skip */ }
        }
      }
    }
    await walk(packageDir, 0, '');
    walked.sort((a, b) => b.size - a.size);
    console.log(`[LOGIC] Package contents (${walked.length} files, sorted by size):`);
    for (const f of walked.slice(0, 40)) {
      const kb = (f.size / 1024).toFixed(1);
      console.log(`[LOGIC]   ${kb.padStart(8)} KB   ${f.relPath}`);
    }
    if (walked.length > 40) {
      console.log(`[LOGIC]   ... and ${walked.length - 40} more files`);
    }
  }

  // PRIMARY tempo + key source: MetaData.plist. Logic stores both
  // BeatsPerMinute and SongKey/SongGenderKey here as labeled plist
  // values — far more reliable than scanning the proprietary binary.
  // We tried byte-pattern extraction first and found it had too many
  // false positives for the key (other event records use the same
  // 16-byte layout as KeySignature). MetaData.plist is the canonical
  // source.
  let tempo = null;
  let key = null;
  let dawVersion = null;
  try {
    const meta = await readLogicMetadata(packageDir);
    if (meta) {
      if (meta.tempo != null) tempo = meta.tempo;
      if (meta.key) key = meta.key;
      if (meta.dawVersion) dawVersion = meta.dawVersion;
      if (DEBUG) {
        console.log(`[LOGIC]   from MetaData.plist (${meta.sourcePath}): tempo=${meta.tempo} key=${meta.key} version=${meta.dawVersion}`);
      }
    } else if (DEBUG) {
      console.log(`[LOGIC]   no MetaData.plist found — will try binary fallback`);
    }
  } catch (err) {
    if (DEBUG) console.warn(`[LOGIC]   MetaData.plist read failed: ${err.message}`);
  }

  const pdFile = await findProjectDataFile(packageDir);
  let plugins = [];
  let totalPluginInstances = 0;
  if (pdFile) {
    let buf;
    try {
      buf = await fs.readFile(pdFile.path);
    } catch (err) {
      if (DEBUG) console.warn(`[LOGIC] couldn't read ProjectData: ${err.message}`);
      buf = null;
    }
    if (buf) {
      // Binary-fallback tempo extraction. Only runs if MetaData.plist
      // didn't already give us one (old Logic versions, partial saves,
      // etc.). Anchors on the explicit `04 02 07 01 00 00 00 08`
      // tempo record marker.
      if (tempo == null) {
        try { tempo = extractLogicTempo(buf); } catch { tempo = null; }
        if (DEBUG && tempo != null) console.log(`[LOGIC]   tempo = ${tempo} BPM (from binary fallback)`);
      }

      // NOTE: no binary key fallback. We tried byte-pattern matching
      // against the `19 00 00 00 <sf> <mode> ...` record format and
      // found it produces false positives because the same 16-byte
      // layout is used for many event types besides KeySignature. If
      // MetaData.plist didn't have SongKey, the UI surfaces a manual
      // override picker — better to leave the field blank than fill
      // it with the wrong value.

      // Primary source: Logic stores Audio Unit references as XML
      // plist descriptors (manufacturer + name + type + subtype +
      // version FourCCs) inside ProjectData. Walk those.
      const debugSink = DEBUG ? {} : null;
      const auFromPlist = extractAUPluginsFromBinary(buf, debugSink);

      // Fallback / additive: scan for file paths (.component, .vst3,
      // .dll, etc.). In modern Logic this almost never matches
      // anything — but for older Logic versions that DID store paths,
      // and for any VST3 plugin reference that uses paths, this still
      // catches them.
      const auFromPaths = scanForPluginPaths(buf);

      // Merge: descriptor records first (they have manufacturer fourcc
      // for cleaner display), path records second (they might add
      // plugins we missed). Dedupe by lowercased name.
      const byKey = new Map();
      function add(p) {
        const key = (p.identifier || p.name || '').toLowerCase();
        if (!key) return;
        if (!byKey.has(key)) {
          byKey.set(key, { ...p });
        } else {
          const rec = byKey.get(key);
          rec.count += p.count;
          if (!rec.format && p.format) rec.format = p.format;
        }
      }
      for (const p of auFromPlist) add(p);
      for (const p of auFromPaths) add(p);

      // Filter Apple-native AUs from the path-scan side (the plist
      // side already filters manufacturer=='appl', but path-based
      // matches need name-based filtering).
      const merged = [...byKey.values()].filter((p) => !isLogicNativeAU(p));
      plugins = merged.sort((a, b) =>
        b.count - a.count || a.name.localeCompare(b.name),
      );
      totalPluginInstances = plugins.reduce((n, p) => n + p.count, 0);
      if (DEBUG) {
        const droppedCount = (auFromPlist.length + auFromPaths.length) - merged.length;
        console.log(`[LOGIC] ${path.basename(packageDir)}: ProjectData=${pdFile.path} (${pdFile.size}B) plugins=${plugins.length}  (plist=${auFromPlist.length} path=${auFromPaths.length}${droppedCount > 0 ? `, dropped=${droppedCount}` : ''})`);
        if (debugSink) {
          console.log(`[LOGIC]   xml-regions=${debugSink.xmlRegions} (added=${debugSink.xmlAdded})   bplist found=${debugSink.bplistFound} parsed=${debugSink.bplistParsed} failed=${debugSink.bplistFailed} (added=${debugSink.bplistAdded})   fourcc-triples=${debugSink.triplesFound} (added=${debugSink.triplesAdded})`);
          if (debugSink.triplesSample && debugSink.triplesSample.length) {
            console.log(`[LOGIC]   fourcc triples: ${debugSink.triplesSample.join('  ')}`);
          }
          if (debugSink.bplistShapes && debugSink.bplistShapes.length) {
            console.log(`[LOGIC]   bplist shapes: ${debugSink.bplistShapes.join(' | ')}`);
          }
          if (debugSink.bplistFailures && debugSink.bplistFailures.length) {
            for (const f of debugSink.bplistFailures) {
              console.log(`[LOGIC]   bplist parse FAIL at offset ${f.offset} (size=${f.size}B): ${f.err}`);
            }
          }
          if (debugSink.bplistIntrospection && debugSink.bplistIntrospection.length) {
            for (const info of debugSink.bplistIntrospection) {
              console.log(`[LOGIC]   ── bplist #${info.idx} (${info.totalObjects} objects) ──`);
              console.log(`[LOGIC]     class histogram: ${info.classes.map(([k, v]) => `${k}×${v}`).join('  ')}`);
              console.log(`[LOGIC]     top dict key-sets (sig → count):`);
              for (const [sig, count] of info.topDictKeySigs) {
                console.log(`[LOGIC]       ×${count}  [${sig}]`);
              }
              console.log(`[LOGIC]     sample strings (first ${info.sampleStrings.length}):`);
              for (const s of info.sampleStrings) {
                console.log(`[LOGIC]       ${JSON.stringify(s)}`);
              }
              if (info.classSamples && info.classSamples.length) {
                console.log(`[LOGIC]     class samples:`);
                for (const cs of info.classSamples) {
                  console.log(`[LOGIC]       <${cs.className}>`);
                  for (const [k, v] of Object.entries(cs.props)) {
                    console.log(`[LOGIC]         ${k} = ${v}`);
                  }
                }
              }
            }
          }
        }
        for (const p of plugins.slice(0, 20)) {
          console.log(`[LOGIC]   - ${p.name}${p.format ? ' (' + p.format + ')' : ''}  ×${p.count}`);
        }
        // Deep scan: when zero plugins found, dump the top distinct
        // strings in the binary so we can see where plugin names live
        // in this version of Logic.
        if (plugins.length === 0) {
          console.log('[LOGIC]   --- deep string scan (top distinct strings 4–60 chars) ---');
          const stringCounts = new Map();
          // UTF-16-LE strings
          let i = 0;
          while (i < buf.length - 1) {
            if (buf[i] >= 0x20 && buf[i] <= 0x7e && buf[i + 1] === 0) {
              const start = i;
              while (i < buf.length - 1 && buf[i] >= 0x20 && buf[i] <= 0x7e && buf[i + 1] === 0) i += 2;
              const len = (i - start) / 2;
              if (len >= 4 && len <= 60) {
                const s = buf.toString('utf16le', start, i);
                stringCounts.set(s, (stringCounts.get(s) || 0) + 1);
              }
            } else {
              i++;
            }
          }
          // Latin-1 strings (≥6 chars, has letters)
          i = 0;
          while (i < buf.length) {
            if (buf[i] >= 0x20 && buf[i] <= 0x7e) {
              const start = i;
              while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x7e) i++;
              const len = i - start;
              if (len >= 6 && len <= 60) {
                const s = buf.toString('latin1', start, i);
                if (/[A-Za-z]/.test(s) && (s.match(/[A-Za-z]/g) || []).length >= 3) {
                  stringCounts.set(s, (stringCounts.get(s) || 0) + 1);
                }
              }
            } else {
              i++;
            }
          }
          const sorted = [...stringCounts.entries()].sort((a, b) => b[1] - a[1]);
          for (const [s, count] of sorted.slice(0, 80)) {
            console.log(`[LOGIC]     ×${count}  ${JSON.stringify(s)}`);
          }
          console.log('[LOGIC]   --- end of deep scan ---');
        }
      }
    }
  } else if (DEBUG) {
    console.log(`[LOGIC] ${path.basename(packageDir)}: no ProjectData file found in package`);
    // Dump the package's contents so we can see what files exist
    // (Logic's project file might be named something different in this
    // version of Logic, or live in an unexpected subfolder).
    try {
      const entries = await fs.readdir(packageDir, { withFileTypes: true });
      console.log('[LOGIC]   package contents:');
      for (const e of entries) {
        console.log(`[LOGIC]     ${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`);
      }
    } catch { /* skip */ }
  }

  // Bounce discovery — the bounces module uses path.dirname() to find
  // sibling folders to scan. The ProjectData file is buried inside
  // Alternatives/NNN/, so its parent dir doesn't contain Bounces/.
  // We pass a SYNTHETIC path anchored at the package root so the
  // search hits the package's own Bounces/ folder (Tier 1) and any
  // name-matching audio files at the package root (Tier 2). The
  // grandparent search then covers user folders containing the .logicx.
  let bounces = [];
  try {
    const virtualPath = path.join(packageDir, '_plugr_anchor_');
    bounces = await findBouncesFor(virtualPath, projectName);
  } catch { /* tolerate */ }

  return {
    name: projectName,
    dawType: 'logic',
    lastModified: stat.mtime.toISOString(),
    plugins,
    totalPluginInstances,
    bounces,
    tempo,          // Initial-region BPM, extracted from the Int32-LE×10000
                    // pattern Logic uses for tempo records. null if no
                    // plausible value found.
    key,            // Project key signature from the global Signature
                    // track ("C major", "F minor", etc.) — extracted
                    // from MIDI-standard sf/mode bytes wrapped in
                    // type-25 record headers. null on tiny / corrupt
                    // projects with no signature event, in which case
                    // the UI falls back to the manual key override.
    dawVersion,     // Logic Pro version that last saved this project,
                    // e.g. "Logic Pro 11.1.0". Pulled from
                    // MetaData.plist when available, null otherwise.
  };
}

module.exports = { parseLogicProject };
