#!/usr/bin/env node
// Diagnostic: dig through a Logic .logicx ProjectData binary looking
// for tempo and key-signature hints. Prints:
//   - any <key>...</key> entries in embedded XML plists whose name
//     contains "tempo", "bpm", "key", "scale", "signature"
//   - any bplist objects with class names containing those terms
//   - candidate Float64 tempo values found near "tempo"-related context
//   - candidate small ints (0..14) found in dicts keyed by 'KeySignature'
//
// Usage:
//   node tools/diagnose-logic-tempo-key.cjs /path/to/Project.logicx

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const bplist = require('bplist-parser');

bplist.maxObjectCount = 5_000_000;
bplist.maxObjectSize = 500 * 1000 * 1000;

const target = process.argv[2];
if (!target || !fsSync.existsSync(target)) {
  console.error('Usage: node tools/diagnose-logic-tempo-key.cjs /path/to/Project.logicx');
  process.exit(1);
}

async function findProjectData(packageDir) {
  const altsDir = path.join(packageDir, 'Alternatives');
  if (fsSync.existsSync(altsDir)) {
    const entries = await fs.readdir(altsDir, { withFileTypes: true });
    const candidates = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pd = path.join(altsDir, ent.name, 'ProjectData');
      if (fsSync.existsSync(pd)) {
        const stat = await fs.stat(pd);
        candidates.push({ path: pd, mtime: stat.mtime });
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      return candidates[0].path;
    }
  }
  const root = path.join(packageDir, 'ProjectData');
  return fsSync.existsSync(root) ? root : null;
}

function extractXmlPlistRegions(buf) {
  const regions = [];
  const xmlStart = Buffer.from('<?xml version', 'ascii');
  const plistEnd = Buffer.from('</plist>', 'ascii');
  let from = 0;
  while (from < buf.length) {
    const a = buf.indexOf(xmlStart, from);
    if (a < 0) break;
    const b = buf.indexOf(plistEnd, a);
    if (b < 0) break;
    regions.push(buf.toString('utf8', a, b + plistEnd.length));
    from = b + plistEnd.length;
  }
  return regions;
}

function findBplists(buf) {
  const magic = Buffer.from('bplist00', 'ascii');
  const offsets = [];
  let from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(magic, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + 8;
  }
  const parsed = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const upper = (i + 1 < offsets.length) ? offsets[i + 1] : buf.length;
    for (let trim = 0; trim <= 256; trim++) {
      const slice = buf.subarray(start, upper - trim);
      if (slice.length < 40) break;
      try { parsed.push(bplist.parseBuffer(slice)); break; } catch { /* try */ }
    }
  }
  return parsed;
}

const TERMS = ['tempo', 'bpm', 'beatspermin', 'songtempo', 'key', 'scale', 'signature', 'pitch', 'tonic', 'mode'];

function matchesTerm(s) {
  if (typeof s !== 'string') return false;
  const ls = s.toLowerCase();
  return TERMS.some((t) => ls.includes(t));
}

(async () => {
  const pdPath = await findProjectData(target);
  if (!pdPath) {
    console.error('No ProjectData file found inside', target);
    process.exit(1);
  }
  console.log(`ProjectData: ${pdPath}`);
  const buf = await fs.readFile(pdPath);
  console.log(`Size: ${buf.length} bytes\n`);

  // 1. XML plist scan
  console.log('=== XML plist scan ===');
  const xmls = extractXmlPlistRegions(buf);
  console.log(`Found ${xmls.length} XML plist region(s)`);
  let xmlHitCount = 0;
  for (let xi = 0; xi < xmls.length; xi++) {
    const xml = xmls[xi];
    // Pull every <key>X</key> next to its value to see candidates.
    const re = /<key>([^<]+)<\/key>\s*<(integer|real|string|true\/|false\/|dict|array)([^>]*)>([^<]*)?/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const k = m[1];
      if (!matchesTerm(k)) continue;
      const tag = m[2];
      const inline = m[4] || '';
      console.log(`  [xml#${xi}] <${tag}> key="${k}" value="${inline.slice(0, 80)}"`);
      xmlHitCount++;
      if (xmlHitCount > 80) break;
    }
    if (xmlHitCount > 80) break;
  }
  if (xmlHitCount === 0) console.log('  (no matching keys in XML regions)');

  // 2. bplist scan — class names + string samples + dicts with matching keys
  console.log('\n=== Binary plist scan ===');
  const bps = findBplists(buf);
  console.log(`Found ${bps.length} parseable bplist00 region(s)`);
  let bpHitCount = 0;
  for (let bi = 0; bi < bps.length; bi++) {
    const root = Array.isArray(bps[bi]) ? bps[bi][0] : bps[bi];
    if (!root || !root.$archiver || !Array.isArray(root.$objects)) continue;
    const objs = root.$objects;

    // Class histogram and matching class names
    const classHits = new Set();
    const stringHits = new Map();  // string → count
    const dictHits = []; // { sig, sampleProps }
    for (const obj of objs) {
      if (typeof obj === 'string') {
        if (matchesTerm(obj)) stringHits.set(obj, (stringHits.get(obj) || 0) + 1);
        continue;
      }
      if (obj && typeof obj === 'object' && obj.$class) {
        const classRef = obj.$class;
        let className = '?';
        if (classRef && typeof classRef === 'object' && 'UID' in classRef) {
          const co = objs[classRef.UID];
          if (co && co.$classname) className = String(co.$classname);
        }
        if (matchesTerm(className)) classHits.add(className);
        // Dictionaries: peek at NS.keys
        if ((className === 'NSDictionary' || className === 'NSMutableDictionary') && Array.isArray(obj['NS.keys'])) {
          const keys = obj['NS.keys']
            .map((k) => k && typeof k === 'object' && 'UID' in k ? objs[k.UID] : k)
            .filter((k) => typeof k === 'string');
          if (keys.some(matchesTerm)) {
            const vals = (obj['NS.objects'] || [])
              .map((v) => v && typeof v === 'object' && 'UID' in v ? objs[v.UID] : v);
            const props = {};
            for (let i = 0; i < keys.length; i++) {
              let v = vals[i];
              if (typeof v === 'string') v = v.length > 60 ? v.slice(0, 60) + '…' : v;
              else if (typeof v === 'number') {}
              else if (typeof v === 'boolean') {}
              else if (v && v.$classname) v = `<${v.$classname}>`;
              else if (Array.isArray(v)) v = `<array len=${v.length}>`;
              else if (v && typeof v === 'object') v = `<dict keys=[${Object.keys(v).slice(0, 5).join(',')}]>`;
              props[keys[i]] = v;
            }
            dictHits.push({ keys: keys.join('|'), props });
          }
        }
        // Non-dict classes whose properties contain matching keys
        if (className !== 'NSDictionary' && className !== 'NSMutableDictionary' &&
            className !== 'NSArray' && className !== 'NSMutableArray' &&
            className !== 'NSString' && className !== 'NSMutableString' &&
            className !== 'NSNumber') {
          const propKeys = Object.keys(obj).filter((k) => k !== '$class');
          if (propKeys.some(matchesTerm) || matchesTerm(className)) {
            const props = {};
            for (const k of propKeys) {
              let v = obj[k];
              if (v && typeof v === 'object' && 'UID' in v && Object.keys(v).length === 1) {
                v = objs[v.UID];
              }
              if (typeof v === 'string') v = v.length > 60 ? v.slice(0, 60) + '…' : v;
              else if (v && v.$classname) v = `<${v.$classname}>`;
              else if (Array.isArray(v)) v = `<array len=${v.length}>`;
              else if (v && typeof v === 'object') v = `<dict keys=[${Object.keys(v).slice(0, 5).join(',')}]>`;
              props[k] = v;
            }
            dictHits.push({ keys: `<${className}> ${propKeys.join(',')}`, props });
          }
        }
      }
    }

    if (classHits.size || stringHits.size || dictHits.length) {
      console.log(`  ── bplist #${bi} (${objs.length} objects) ──`);
      if (classHits.size) {
        console.log(`    matching classes: ${[...classHits].join(', ')}`);
      }
      if (stringHits.size) {
        const top = [...stringHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
        console.log(`    matching strings:`);
        for (const [s, c] of top) console.log(`      ×${c}  ${JSON.stringify(s)}`);
      }
      if (dictHits.length) {
        console.log(`    matching dicts/objects (${dictHits.length}):`);
        for (const d of dictHits.slice(0, 20)) {
          console.log(`      keys: ${d.keys}`);
          for (const [k, v] of Object.entries(d.props)) {
            console.log(`        ${k} = ${JSON.stringify(v)}`);
          }
        }
        if (dictHits.length > 20) console.log(`      ... and ${dictHits.length - 20} more`);
      }
      bpHitCount++;
    }
  }
  if (bpHitCount === 0) console.log('  (no matching content in bplist regions)');

  // 3. Raw byte scan — look for "tempo" / "bpm" / "key" ASCII strings
  //    in the binary outside plist/bplist regions, and dump context.
  console.log('\n=== Raw context scan ===');
  for (const needleStr of ['tempo', 'Tempo', 'BPM', 'Bpm', 'KeySignature', 'keySignature']) {
    const needle = Buffer.from(needleStr, 'ascii');
    let from = 0, hits = 0;
    while (from < buf.length && hits < 6) {
      const idx = buf.indexOf(needle, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - 8);
      const end = Math.min(buf.length, idx + needle.length + 24);
      const window = buf.subarray(start, end);
      // Format: hex + ASCII
      const hex = [...window].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const asc = [...window].map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
      console.log(`  '${needleStr}' @${idx}:  ${hex}  | ${asc}`);
      hits++;
      from = idx + needle.length;
    }
    if (hits === 0) {
      // Also try UTF-16-LE
      const u16 = Buffer.from(needleStr, 'utf16le');
      let f2 = 0, h2 = 0;
      while (f2 < buf.length && h2 < 4) {
        const idx = buf.indexOf(u16, f2);
        if (idx < 0) break;
        const start = Math.max(0, idx - 8);
        const end = Math.min(buf.length, idx + u16.length + 24);
        const window = buf.subarray(start, end);
        const hex = [...window].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const asc = [...window].map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
        console.log(`  '${needleStr}' (utf16le) @${idx}:  ${hex}  | ${asc}`);
        h2++;
        f2 = idx + u16.length;
      }
    }
  }
})();
