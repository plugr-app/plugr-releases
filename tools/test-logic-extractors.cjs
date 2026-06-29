#!/usr/bin/env node
// Run the actual extractLogicTempo + extractLogicKey functions
// against a .logicx package and print the debug output. Easier than
// running the whole app with PLUGR_LOGIC_DEBUG=1.
//
// Usage:
//   node tools/test-logic-extractors.cjs ~/Downloads/"test project.logicx"

// Force DEBUG on before requiring the parser
process.env.PLUGR_LOGIC_DEBUG = '1';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { parseLogicProject } = require('../electron/lib/projectScanners/logic.cjs');

const target = process.argv[2];
if (!target || !fsSync.existsSync(target)) {
  console.error('Usage: node tools/test-logic-extractors.cjs /path/to/Project.logicx');
  process.exit(1);
}

(async () => {
  console.log(`Parsing: ${target}\n`);
  try {
    const result = await parseLogicProject(target);
    console.log('\n=== Result ===');
    console.log(`  name:    ${result.name}`);
    console.log(`  tempo:   ${result.tempo}`);
    console.log(`  key:     ${result.key}`);
    console.log(`  plugins: ${(result.plugins || []).length}`);
  } catch (err) {
    console.error('parseLogicProject threw:', err);
  }
})();
