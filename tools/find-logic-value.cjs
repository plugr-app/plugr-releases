#!/usr/bin/env node
// Search a Logic ProjectData binary for a target numeric value
// encoded as Float64 BE/LE, Float32 BE/LE, Int32 BE/LE (raw and
// scaled by common factors), and Int16 BE/LE. Useful for reverse-
// engineering offsets — e.g. "find where 120 BPM is stored".
//
// Usage:
//   node tools/find-logic-value.cjs /path/to/Project.logicx <value>
//   node tools/find-logic-value.cjs /path/to/Project.logicx 120
//   node tools/find-logic-value.cjs /path/to/Project.logicx 128.5

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const valueStr = process.argv[3];
if (!target || !valueStr) {
  console.error('Usage: node tools/find-logic-value.cjs /path/to/Project.logicx <value>');
  process.exit(1);
}
const value = Number(valueStr);
if (!Number.isFinite(value)) {
  console.error(`Bad value: ${valueStr}`);
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

// Build candidate byte patterns for the target value across multiple
// encodings. Returns [{label, bytes:Buffer, tolerance}].
function buildEncodings(v) {
  const encs = [];
  // Float64
  {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    encs.push({ label: 'Float64-BE', bytes: b });
  }
  {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    encs.push({ label: 'Float64-LE', bytes: b });
  }
  // Float32
  {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v, 0);
    encs.push({ label: 'Float32-BE', bytes: b });
  }
  {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    encs.push({ label: 'Float32-LE', bytes: b });
  }
  // Int32 raw
  if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    encs.push({ label: 'Int32-BE', bytes: b });
    const b2 = Buffer.alloc(4);
    b2.writeInt32LE(v, 0);
    encs.push({ label: 'Int32-LE', bytes: b2 });
  }
  // Common scaled int32 encodings (BPM × 1000, × 10000, × 100, × 1024).
  for (const scale of [10, 100, 1000, 10000, 1024, 16384, 60_000_000]) {
    const scaled = Math.round(v * scale);
    if (!Number.isInteger(scaled) || scaled < -0x80000000 || scaled > 0x7fffffff) continue;
    const b = Buffer.alloc(4);
    b.writeInt32BE(scaled, 0);
    encs.push({ label: `Int32-BE × ${scale}  (${scaled})`, bytes: b });
    const b2 = Buffer.alloc(4);
    b2.writeInt32LE(scaled, 0);
    encs.push({ label: `Int32-LE × ${scale}  (${scaled})`, bytes: b2 });
  }
  // Int16 raw and ×100
  if (Number.isInteger(v) && v >= -32768 && v <= 32767) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    encs.push({ label: 'Int16-BE', bytes: b });
    const b2 = Buffer.alloc(2);
    b2.writeInt16LE(v, 0);
    encs.push({ label: 'Int16-LE', bytes: b2 });
  }
  return encs;
}

function findAllOccurrences(haystack, needle) {
  const out = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

function dumpContext(buf, off, len) {
  const start = Math.max(0, off - 8);
  const end = Math.min(buf.length, off + len + 8);
  const win = buf.subarray(start, end);
  const hex = [...win].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const asc = [...win].map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
  return `${hex}   | ${asc}`;
}

(async () => {
  const pdPath = await findProjectData(target);
  if (!pdPath) {
    console.error(`No ProjectData found under ${target}`);
    process.exit(1);
  }
  console.log(`ProjectData: ${pdPath}`);
  const buf = await fs.readFile(pdPath);
  console.log(`Size: ${buf.length} bytes`);
  console.log(`Searching for value: ${value}\n`);

  const encs = buildEncodings(value);
  for (const enc of encs) {
    const hits = findAllOccurrences(buf, enc.bytes);
    if (hits.length === 0) continue;
    console.log(`--- ${enc.label} (${enc.bytes.toString('hex')}) ---`);
    console.log(`  ${hits.length} occurrence(s):`);
    for (const off of hits.slice(0, 12)) {
      console.log(`    @${off}:  ${dumpContext(buf, off, enc.bytes.length)}`);
    }
    if (hits.length > 12) console.log(`    ... and ${hits.length - 12} more`);
  }
})();
