// Mach-O architecture detection.
//
// For every bundle we resolve `Contents/MacOS/<CFBundleExecutable>` and
// shell out to `lipo -archs`. lipo returns space-separated arch slugs:
//     arm64
//     x86_64
//     arm64 x86_64
//     i386                 (32-bit Intel — dead on modern macOS)
//     ppc / ppc64          (PowerPC — long dead)
//
// We use this to decide whether a plugin will actually load on the
// current Mac. Unlike a missing LSMinimumSystemVersion (which we used to
// guess at), arch is a definitive hard signal:
//   - On Apple Silicon, an x86_64-only bundle loads through Rosetta — OK.
//   - On Apple Silicon, an i386-only or ppc-only bundle won't load at all.
//   - On Intel, an arm64-only bundle won't load.
//
// Concurrency is capped because each `lipo` call is a fresh subprocess.

const { execFile } = require('node:child_process');
const fsSync = require('node:fs');
const path = require('node:path');

function detectArchitectures(execPath) {
  return new Promise((resolve) => {
    if (!execPath || !fsSync.existsSync(execPath)) return resolve(null);
    execFile('lipo', ['-archs', execPath], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout || '').trim();
      if (!out) return resolve(null);
      // lipo errors come on stderr; on success stdout is a single line of
      // space-separated arch names.
      const archs = out.split(/\s+/).filter(Boolean);
      resolve(archs);
    });
  });
}

/** Map a bundle path + plist executable name to the absolute Mach-O path. */
function bundleExecPath(bundlePath, executable) {
  if (!bundlePath || !executable) return null;
  return path.join(bundlePath, 'Contents', 'MacOS', executable);
}

/**
 * Detect architectures for many bundles in parallel.
 * Returns a Map<bundlePath, string[] | null>.
 */
async function detectArchitecturesBatch(items, concurrency = 8) {
  const results = new Map();
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const execPath = bundleExecPath(it.bundlePath, it.executable);
      const archs = await detectArchitectures(execPath);
      results.set(it.bundlePath, archs);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { detectArchitectures, detectArchitecturesBatch, bundleExecPath };
