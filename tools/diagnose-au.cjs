#!/usr/bin/env node
// Diagnostic: run Plugr's readBundleInfo on a .component bundle and
// print exactly what it found. Used to figure out why legacy AU
// plugins like OTT don't get matched.
//
// Usage:
//   node tools/diagnose-au.cjs "/Library/Audio/Plug-Ins/Components/OTT.component"

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('Usage: node tools/diagnose-au.cjs <path-to-.component-bundle>');
  process.exit(1);
}
if (!fsSync.existsSync(bundlePath)) {
  console.error(`Bundle not found: ${bundlePath}`);
  process.exit(1);
}

const { readBundleInfo } = require('../electron/lib/plistParser.cjs');

(async () => {
  console.log(`=== Diagnosing ${bundlePath} ===\n`);

  // 1. Top-level bundle layout
  console.log('--- Bundle layout ---');
  const contentsDir = path.join(bundlePath, 'Contents');
  if (fsSync.existsSync(contentsDir)) {
    const top = await fs.readdir(contentsDir, { withFileTypes: true });
    for (const e of top) {
      console.log(`  ${e.isDirectory() ? '[dir]' : '[file]'} Contents/${e.name}`);
      if (e.isDirectory()) {
        try {
          const sub = await fs.readdir(path.join(contentsDir, e.name));
          for (const f of sub) {
            const fp = path.join(contentsDir, e.name, f);
            let size = '-';
            try { size = (await fs.stat(fp)).size + 'B'; } catch {}
            console.log(`         Contents/${e.name}/${f}  (${size})`);
          }
        } catch {}
      }
    }
  } else {
    console.log('  No Contents/ directory — not a standard bundle');
  }

  // 2. Run readBundleInfo and dump the result
  console.log('\n--- readBundleInfo() result ---');
  const info = await readBundleInfo(bundlePath);
  if (!info) {
    console.log('  null — Info.plist not found or unparseable');
    return;
  }
  console.log('  name         =', info.name);
  console.log('  identifier   =', info.identifier);
  console.log('  version      =', info.version);
  console.log('  executable   =', info.executable);
  console.log('  auComponents =',
    info.auComponents ? JSON.stringify(info.auComponents, null, 4) : 'null');

  // 3. If auComponents is null, manually retry the legacy scan with
  //    verbose logging to see why.
  if (!info.auComponents || info.auComponents.length === 0) {
    console.log('\n--- Manual legacy scan ---');
    const AU_TYPE_FOURCCS = ['aufx', 'aumu', 'aumf', 'augn', 'aupn', 'aumx'];
    function isPrintable4(b1, b2, b3, b4) {
      return (b1 >= 0x20 && b1 <= 0x7e) && (b2 >= 0x20 && b2 <= 0x7e) &&
             (b3 >= 0x20 && b3 <= 0x7e) && (b4 >= 0x20 && b4 <= 0x7e);
    }
    function scan(buf, label) {
      const limit = buf.length - 12;
      const found = new Map();
      for (let i = 0; i <= limit; i++) {
        if (buf[i] !== 0x61 || buf[i + 1] !== 0x75) continue;
        const typeStr = buf.toString('ascii', i, i + 4);
        if (!AU_TYPE_FOURCCS.includes(typeStr)) continue;
        const s1 = buf[i + 4], s2 = buf[i + 5], s3 = buf[i + 6], s4 = buf[i + 7];
        const m1 = buf[i + 8], m2 = buf[i + 9], m3 = buf[i + 10], m4 = buf[i + 11];
        if (!isPrintable4(s1, s2, s3, s4)) continue;
        if (!isPrintable4(m1, m2, m3, m4)) continue;
        const sub = String.fromCharCode(s1, s2, s3, s4);
        const man = String.fromCharCode(m1, m2, m3, m4);
        const key = `${typeStr}:${sub}:${man}`;
        if (!found.has(key)) found.set(key, { offset: i, type: typeStr, sub, man });
      }
      console.log(`  ${label}: ${buf.length} bytes, ${found.size} FourCC matches`);
      for (const f of found.values()) {
        console.log(`    @${f.offset}: ${f.type} ${f.sub} ${f.man}`);
      }
      return found;
    }

    // Scan every file in Contents/Resources/
    const resDir = path.join(bundlePath, 'Contents', 'Resources');
    if (fsSync.existsSync(resDir)) {
      const entries = await fs.readdir(resDir);
      for (const name of entries) {
        const fp = path.join(resDir, name);
        try {
          const st = await fs.stat(fp);
          if (!st.isFile()) continue;
          const buf = await fs.readFile(fp);
          scan(buf, `Resources/${name}`);
        } catch {}
      }
    } else {
      console.log('  (no Contents/Resources/ directory)');
    }

    // Scan the Mach-O executable
    if (info.executable) {
      const exePath = path.join(bundlePath, 'Contents', 'MacOS', info.executable);
      if (fsSync.existsSync(exePath)) {
        const buf = await fs.readFile(exePath);
        scan(buf, `MacOS/${info.executable}`);
      } else {
        console.log(`  (Mach-O not found at ${exePath})`);
      }
    }
  }
})();
