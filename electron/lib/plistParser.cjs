// Robust Info.plist parser.
//
// macOS plist files come in two flavors: XML and binary. The binary format
// is used by most modern apps and plugin bundles, so a naive XML parser is
// not enough.
//
// Strategy:
//   1. Use the built-in `plutil` command to convert any plist to JSON. This
//      is always available on macOS and handles both formats correctly.
//   2. Fall back to the `plist` npm package for XML plists if plutil fails
//      (e.g. in tests on a non-macOS machine).

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

function plutilToJson(plistPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

async function parsePlistFile(plistPath) {
  if (!fsSync.existsSync(plistPath)) return null;

  // 1. Try plutil first (preferred on macOS)
  try {
    return await plutilToJson(plistPath);
  } catch (_e) {
    // fall through
  }

  // 2. Fallback: try parsing as XML with the plist package
  try {
    const plistLib = require('plist');
    const xml = await fs.readFile(plistPath, 'utf8');
    return plistLib.parse(xml);
  } catch (_e) {
    return null;
  }
}

// Legacy AU plugins (built against the old Component Manager API,
// pre-AU v2) don't declare AudioComponents in their Info.plist. They
// register themselves with macOS via 'thng' resources inside a .rsrc
// resource fork file, or — in the case of bundles that compile the
// descriptor into their Mach-O — directly in the executable binary.
//
// Plugr can't load those plugins, but for project-matching purposes
// it just needs the (type, subtype, manufacturer) FourCC triple. We
// can find it by brute-force scanning the bundle's binary files for
// the canonical AU type bytes ('aufx', 'aumu', etc.) followed by
// 8 more bytes of printable FourCC. Same approach we use for FL
// Studio project plugin paths.
const AU_TYPE_FOURCCS = new Set(['aufx', 'aumu', 'aumf', 'augn', 'aupn', 'aumx']);

function isPrintable4(b1, b2, b3, b4) {
  return (b1 >= 0x20 && b1 <= 0x7e) && (b2 >= 0x20 && b2 <= 0x7e) &&
         (b3 >= 0x20 && b3 <= 0x7e) && (b4 >= 0x20 && b4 <= 0x7e);
}

function scanForAuFourCCsInBuffer(buf, maxBytes = 4 * 1024 * 1024) {
  const limit = Math.min(buf.length, maxBytes) - 12;
  const found = new Map(); // key "type:subtype:manu" → triple
  for (let i = 0; i <= limit; i++) {
    if (buf[i] !== 0x61 || buf[i + 1] !== 0x75) continue;  // 'au' prefix
    const typeStr = buf.toString('ascii', i, i + 4);
    if (!AU_TYPE_FOURCCS.has(typeStr)) continue;
    const subB1 = buf[i + 4], subB2 = buf[i + 5], subB3 = buf[i + 6], subB4 = buf[i + 7];
    const manB1 = buf[i + 8], manB2 = buf[i + 9], manB3 = buf[i + 10], manB4 = buf[i + 11];
    if (!isPrintable4(subB1, subB2, subB3, subB4)) continue;
    if (!isPrintable4(manB1, manB2, manB3, manB4)) continue;
    const subtype = String.fromCharCode(subB1, subB2, subB3, subB4);
    const manufacturer = String.fromCharCode(manB1, manB2, manB3, manB4);
    const key = `${typeStr}:${subtype}:${manufacturer}`;
    if (!found.has(key)) {
      found.set(key, { type: typeStr, subtype, manufacturer });
    }
    i += 11;
  }
  return [...found.values()];
}

async function extractLegacyAuComponents(bundlePath, bundleInfo) {
  const out = [];
  // Try .rsrc files in Contents/Resources/ first (classic resource fork).
  try {
    const resDir = path.join(bundlePath, 'Contents', 'Resources');
    if (fsSync.existsSync(resDir)) {
      const entries = await fs.readdir(resDir);
      for (const name of entries) {
        if (!name.toLowerCase().endsWith('.rsrc')) continue;
        try {
          const buf = await fs.readFile(path.join(resDir, name));
          const found = scanForAuFourCCsInBuffer(buf);
          for (const f of found) out.push(f);
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  // Fall back to scanning the Mach-O executable.
  if (out.length === 0 && bundleInfo && bundleInfo.CFBundleExecutable) {
    const exePath = path.join(bundlePath, 'Contents', 'MacOS', bundleInfo.CFBundleExecutable);
    try {
      if (fsSync.existsSync(exePath)) {
        const buf = await fs.readFile(exePath);
        const found = scanForAuFourCCsInBuffer(buf);
        for (const f of found) out.push(f);
      }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Sanity-check a plist version value. Returns the trimmed string when it
 * looks like an actual version, else null.
 *
 * Why: some vendors ship Info.plists whose version fields contain
 * unexpanded build-system placeholders — KORG's legacy AAX wrappers are
 * the canonical case, with CFBundleShortVersionString literally set to
 * "KLAAXWRAPPER_M1_VERSION_STRING". Pro Tools reads the version from the
 * AAX binary's own resources, never the plist, so KORG never noticed.
 * Without this check that garbage becomes the displayed version AND
 * poisons duplicate/superseded comparison (semver.coerce extracts the
 * "1" out of "M1" and the copy compares as v1.0.0).
 *
 * The rule: a real version starts with a digit (optionally prefixed with
 * "v"). Digit-CONTAINING is not enough — see the M1 case above.
 * plutil's JSON conversion can also give us numbers (CFBundleVersion is
 * sometimes numeric) — those are always valid.
 */
function saneVersion(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^v?\d/i.test(t) ? t : null;
}

/**
 * Read a bundle's Info.plist and return a normalized record.
 * Works for .app, .vst3, .component, .vst, .aaxplugin and .clap bundles.
 */
async function readBundleInfo(bundlePath) {
  const infoPath = path.join(bundlePath, 'Contents', 'Info.plist');
  const info = await parsePlistFile(infoPath);
  if (!info) return null;

  // AudioComponents array is present on AU plugins and tells us the type.
  let auComponents = null;
  if (Array.isArray(info.AudioComponents)) {
    auComponents = info.AudioComponents.map((c) => ({
      type: c.type,
      subtype: c.subtype,
      manufacturer: c.manufacturer,
      name: c.name,
      description: c.description,
      tags: c.tags,
      version: c.version,
    }));
  }
  // Legacy fallback — for old AU plugins like Xfer Records OTT that
  // predate the AudioComponents convention, scan the bundle's binary
  // files for embedded AU FourCC descriptors. Only run for
  // .component bundles to avoid scanning unrelated binaries.
  if ((!auComponents || auComponents.length === 0) && bundlePath.toLowerCase().endsWith('.component')) {
    const legacy = await extractLegacyAuComponents(bundlePath, info);
    if (legacy.length > 0) {
      auComponents = legacy.map((c) => ({
        type: c.type,
        subtype: c.subtype,
        manufacturer: c.manufacturer,
        name: info.CFBundleName || path.basename(bundlePath, '.component'),
        description: null,
        tags: null,
        version: saneVersion(info.CFBundleVersion),
      }));
    }
  }

  return {
    bundlePath,
    bundleName: path.basename(bundlePath),
    name:
      info.CFBundleDisplayName ||
      info.CFBundleName ||
      path.basename(bundlePath, path.extname(bundlePath)),
    identifier: info.CFBundleIdentifier || null,
    version:
      saneVersion(info.CFBundleShortVersionString) ||
      saneVersion(info.CFBundleVersion) ||
      null,
    buildVersion: saneVersion(info.CFBundleVersion),
    executable: info.CFBundleExecutable || null,
    minimumSystemVersion: info.LSMinimumSystemVersion || null,
    iconFile: info.CFBundleIconFile || info.CFBundleIconName || null,
    copyright: info.NSHumanReadableCopyright || null,
    auComponents,
    // Sparkle feed URL declared by the bundle itself. When present, this
    // is by far the most reliable source of update info — no scraping or
    // regex-guessing required.
    sparkleFeedUrl:
      (typeof info.SUFeedURL === 'string' && info.SUFeedURL.trim()) ||
      (typeof info.SUFeedURLString === 'string' && info.SUFeedURLString.trim()) ||
      null,
  };
}

module.exports = { parsePlistFile, readBundleInfo, saneVersion };
