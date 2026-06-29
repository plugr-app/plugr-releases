// Size-on-disk computation.
//
// Plugin bundles can be small (a few MB) or huge (a Kontakt or Logic Pro
// install can be several GB). Walking the bundle in Node is correct but slow
// when there are tens of thousands of inner files; the macOS `du -sk` command
// is much faster and reads the same numbers.
//
// We shell out to `du -sk -- <path>` (kilobytes), parse the integer, and
// multiply. If du fails for any reason we fall back to a Node walker.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

function duKilobytes(targetPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'du', ['-sk', '--', targetPath],
      { maxBuffer: 1024 * 1024, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        const m = stdout.toString().match(/^\s*(\d+)/);
        if (!m) return reject(new Error('du parse failed: ' + stdout));
        resolve(parseInt(m[1], 10) * 1024);
      },
    );
  });
}

async function nodeWalkSize(target) {
  let total = 0;
  async function walk(p) {
    let st;
    try { st = await fs.lstat(p); } catch { return; }
    if (st.isSymbolicLink()) return;             // don't follow / count symlink targets
    if (st.isFile()) { total += st.size; return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = await fs.readdir(p); } catch { return; }
      for (const e of entries) await walk(path.join(p, e));
    }
  }
  await walk(target);
  return total;
}

async function computeSize(targetPath) {
  try {
    return await duKilobytes(targetPath);
  } catch (_e) {
    try {
      return await nodeWalkSize(targetPath);
    } catch (_e2) {
      return null;
    }
  }
}

/** Run computeSize against many paths in parallel with a concurrency cap. */
async function computeSizesBatch(paths, concurrency = 6) {
  const results = new Map();
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (i < paths.length) {
      const idx = i++;
      const p = paths[idx];
      try {
        results.set(p, await computeSize(p));
      } catch {
        results.set(p, null);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = { computeSize, computeSizesBatch, formatBytes };
