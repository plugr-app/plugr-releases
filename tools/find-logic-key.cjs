#!/usr/bin/env node
// Locate the project key-signature bytes inside a Logic .logicx
// ProjectData binary. Tries the MIDI key-signature encoding (1 byte
// signed sharps/flats, 1 byte mode 0=major 1=minor) at every offset
// in the first 64 KB, plus a few common variations (4-byte struct,
// swapped order, byte tonic 0-11 + mode).
//
// Usage (optionally pass the known key as the 2nd arg to filter):
//   node tools/find-logic-key.cjs /path/to/Project.logicx
//   node tools/find-logic-key.cjs /path/to/Project.logicx "G# minor"

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const wantKeyStr = process.argv[3];
if (!target || !fsSync.existsSync(target)) {
  console.error('Usage: node tools/find-logic-key.cjs /path/to/Project.logicx [known-key]');
  process.exit(1);
}

// MIDI key-signature lookup: sharps/flats count for each key.
// Major keys: C, G, D, A, E, B, F#, C# / F, Bb, Eb, Ab, Db, Gb, Cb
// Minor keys: A, E, B, F#, C#, G#, D#, A# / D, G, C, F, Bb, Eb, Ab
const KEY_TABLE = {
  // major: 0-7 sharps positive, 1-7 flats negative
  'C major':  { sf:  0, mode: 0 }, 'G major':  { sf:  1, mode: 0 },
  'D major':  { sf:  2, mode: 0 }, 'A major':  { sf:  3, mode: 0 },
  'E major':  { sf:  4, mode: 0 }, 'B major':  { sf:  5, mode: 0 },
  'F# major': { sf:  6, mode: 0 }, 'C# major': { sf:  7, mode: 0 },
  'F major':  { sf: -1, mode: 0 }, 'Bb major': { sf: -2, mode: 0 },
  'Eb major': { sf: -3, mode: 0 }, 'Ab major': { sf: -4, mode: 0 },
  'Db major': { sf: -5, mode: 0 }, 'Gb major': { sf: -6, mode: 0 },
  'Cb major': { sf: -7, mode: 0 },
  // minor
  'A minor':  { sf:  0, mode: 1 }, 'E minor':  { sf:  1, mode: 1 },
  'B minor':  { sf:  2, mode: 1 }, 'F# minor': { sf:  3, mode: 1 },
  'C# minor': { sf:  4, mode: 1 }, 'G# minor': { sf:  5, mode: 1 },
  'D# minor': { sf:  6, mode: 1 }, 'A# minor': { sf:  7, mode: 1 },
  'D minor':  { sf: -1, mode: 1 }, 'G minor':  { sf: -2, mode: 1 },
  'C minor':  { sf: -3, mode: 1 }, 'F minor':  { sf: -4, mode: 1 },
  'Bb minor': { sf: -5, mode: 1 }, 'Eb minor': { sf: -6, mode: 1 },
  'Ab minor': { sf: -7, mode: 1 },
};

// Tonic-index encoding (an alternate scheme): 0-11 for C, C#, D, ..., B,
// plus a mode byte. Logic may use this since its UI presents keys
// chromatically.
const TONIC_TABLE = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4,
  'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9,
  'A#': 10, 'Bb': 10, 'B': 11, 'Cb': 11,
};

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

function context(buf, off, width = 24) {
  const start = Math.max(0, off - 4);
  const end = Math.min(buf.length, off + width);
  const win = buf.subarray(start, end);
  const hex = [...win].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const asc = [...win].map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
  return `${hex}   | ${asc}`;
}

(async () => {
  const pdPath = await findProjectData(target);
  if (!pdPath) { console.error('No ProjectData'); process.exit(1); }
  console.log(`ProjectData: ${pdPath}`);
  const buf = await fs.readFile(pdPath);
  console.log(`Size: ${buf.length} bytes`);
  if (wantKeyStr) console.log(`Looking for key: ${wantKeyStr}`);
  console.log();

  const SCAN_BYTES = Math.min(buf.length - 4, 64 * 1024);

  // Build candidate byte patterns. Each pattern: { label, bytes, why }.
  const patterns = [];

  // For every named key, build sf+mode and mode+sf patterns
  for (const [name, info] of Object.entries(KEY_TABLE)) {
    if (wantKeyStr && name.toLowerCase() !== wantKeyStr.toLowerCase()) continue;
    const sfByte = info.sf & 0xff;  // signed → uint8
    // [sf, mode] pair
    patterns.push({
      label: `${name} as [sf=${info.sf}, mode=${info.mode}]`,
      bytes: Buffer.from([sfByte, info.mode]),
    });
    // [mode, sf] swap
    patterns.push({
      label: `${name} as [mode=${info.mode}, sf=${info.sf}]`,
      bytes: Buffer.from([info.mode, sfByte]),
    });
  }

  // Tonic-index scheme for the known key
  if (wantKeyStr) {
    const [tonic, modeStr] = wantKeyStr.split(' ');
    const idx = TONIC_TABLE[tonic];
    const modeNum = (modeStr || '').toLowerCase() === 'minor' ? 1 : 0;
    if (idx != null) {
      patterns.push({
        label: `${wantKeyStr} as [tonic=${idx}, mode=${modeNum}]`,
        bytes: Buffer.from([idx, modeNum]),
      });
      patterns.push({
        label: `${wantKeyStr} as [mode=${modeNum}, tonic=${idx}]`,
        bytes: Buffer.from([modeNum, idx]),
      });
      // 4-byte struct: [tonic, mode, padding, padding]
      patterns.push({
        label: `${wantKeyStr} as 4-byte struct [tonic, mode, 0, 0]`,
        bytes: Buffer.from([idx, modeNum, 0, 0]),
      });
      patterns.push({
        label: `${wantKeyStr} as 4-byte struct [0, 0, tonic, mode]`,
        bytes: Buffer.from([0, 0, idx, modeNum]),
      });
    }
  }

  // For each pattern, find every byte-aligned occurrence in the first
  // 64 KB. Print contexts that are NOT just runs of zeros (too noisy
  // for C major).
  const ZERO_RUN_THRESHOLD = 6;   // skip if both bytes are 0 AND the
                                  // surrounding 6 bytes are all 0
  for (const pat of patterns) {
    const hits = [];
    let from = 0;
    while (from <= SCAN_BYTES - pat.bytes.length) {
      const idx = buf.indexOf(pat.bytes, from);
      if (idx < 0 || idx > SCAN_BYTES) break;
      hits.push(idx);
      from = idx + 1;
    }
    if (!hits.length) continue;

    // Filter: drop hits that are inside an all-zeros region (too common).
    const meaningful = hits.filter((off) => {
      const start = Math.max(0, off - ZERO_RUN_THRESHOLD);
      const end = Math.min(buf.length, off + pat.bytes.length + ZERO_RUN_THRESHOLD);
      const win = buf.subarray(start, end);
      // If ANY non-zero byte is in window, it's worth seeing.
      for (const b of win) if (b !== 0) return true;
      return false;
    });

    if (!meaningful.length) {
      console.log(`--- ${pat.label} (${pat.bytes.toString('hex')}) ---`);
      console.log(`  ${hits.length} occurrence(s), all inside zero-runs (skipped)`);
      console.log();
      continue;
    }
    console.log(`--- ${pat.label} (${pat.bytes.toString('hex')}) ---`);
    console.log(`  ${meaningful.length} meaningful occurrence(s) (of ${hits.length} total):`);
    for (const off of meaningful.slice(0, 20)) {
      console.log(`    @${off}:  ${context(buf, off, 24)}`);
    }
    if (meaningful.length > 20) console.log(`    ... and ${meaningful.length - 20} more`);
    console.log();
  }
})();
