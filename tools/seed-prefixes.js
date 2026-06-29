#!/usr/bin/env node
//
// seed-prefixes.js — adds missing identifierPrefix entries.
//
// The seed-categories.js run added productMatchers entries for ~500
// plugins, but a chunk of them still couldn't be auto-categorized at
// scan time because the scanner can't even figure out which developer
// they belong to: it routes by bundle-ID prefix, and many developers'
// registered prefix lists don't include the prefixes their plugins
// actually use (e.g. FLUX SE plugins use bundle IDs like
// "audio.flux.*" but the registry only had "com.flux.").
//
// This script appends the missing prefixes. It's idempotent — each
// prefix is added only if not already present (dedup ignores trailing
// dots).

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, '..', 'electron', 'lib', 'developerRegistry.json');
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

// Map: developer canonical name → list of identifierPrefix strings to add.
// Sourced from the CSV the user exported on 2026-05-25 — every prefix
// here was observed in real scanned plugins that the scanner couldn't
// attribute to a developer.
const PREFIXES_TO_ADD = {
  // Existing developers with missing prefixes.
  'D16 Group':                   ['com.d16group'],
  'FLUX SE':                     ['audio.flux', 'com.gaelyvan.flux'],
  'Tokyo Dawn Labs':             ['com.tokyodawnlabs'],
  'Plugin Alliance':             ['com.Plugin Alliance', 'com.PluginAlliance'],
  'iZotope':                     ['com.ExponentialAudio'],
  'UVI':                         ['com.uvisoundsource'],
  'Sound Device Digital':        ['com.soundevicedigital'],
  'Klevgrand':                   ['com.klevgrand'],

  // Developers that existed but had no identifierPrefix list at all.
  'Camelaudio':                  ['com.camelaudio'],
  'Digidesign':                  ['com.digidesign'],
  'EaReckon':                    ['com.eaReckon'],
  'FineCutBodies':               ['com.FineCutBodies'],
  'Greenoak':                    ['com.greenoak'],
  'McDowell Signal Processing':  ['com.mcdsp'],
  'Mixed In Key':                ['com.mixedinkey'],
  'Resonantcavity':              ['com.resonantcavity'],
  'Rocket Powered Sound':        ['com.rocketpoweredsound'],
  'Samplemagic':                 ['com.samplemagic'],
  'Sonic Academy':               ['com.sonicacademy'],
  'SoundRadix':                  ['com.SoundRadix'],
  'Tailorednoise':               ['com.tailorednoise'],
  'XynthAudio':                  ['com.XynthAudio'],
  'Zplane':                      ['com.zplane'],
  'oeksound':                    ['com.oeksound'],
  // Frohmage's plist developer text was the literal "Ohm Force" string —
  // bundle ID is "com.Ohm Force.Frohmage.*" with a space. We add both
  // the spaced form (matches the literal bundle ID) and the spaceless
  // form (in case future Ohm Force plugins drop the space) so either
  // works.
  'Ohm Force':                   ['com.Ohm Force', 'com.OhmForce', 'com.ohm-force'],
};

function normalizePrefix(p) {
  return String(p || '').toLowerCase().replace(/\.+$/, '');
}

function main() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const reg = JSON.parse(raw);
  reg.developers = reg.developers || {};

  const stats = { devsTouched: new Set(), prefixesAdded: 0, prefixesAlready: 0, devsCreated: 0 };

  for (const [devName, prefixes] of Object.entries(PREFIXES_TO_ADD)) {
    if (!reg.developers[devName]) {
      reg.developers[devName] = { identifierPrefix: [], productMatchers: {} };
      stats.devsCreated++;
    }
    const dev = reg.developers[devName];
    if (!Array.isArray(dev.identifierPrefix)) dev.identifierPrefix = [];
    const have = new Set(dev.identifierPrefix.map(normalizePrefix));
    for (const p of prefixes) {
      const np = normalizePrefix(p);
      if (have.has(np)) { stats.prefixesAlready++; continue; }
      dev.identifierPrefix.push(p);
      have.add(np);
      stats.prefixesAdded++;
      stats.devsTouched.add(devName);
    }
    // Sort longest first so the lookup table picks the most-specific
    // match first (registryLookup.cjs already does this, but we keep
    // the on-disk order tidy for human readers).
    dev.identifierPrefix.sort((a, b) => b.length - a.length);
  }

  console.log('identifierPrefix additions');
  console.log('  developers touched : ', stats.devsTouched.size);
  console.log('  developers created : ', stats.devsCreated);
  console.log('  prefixes added     : ', stats.prefixesAdded);
  console.log('  prefixes already in: ', stats.prefixesAlready);
  console.log('');

  if (DRY_RUN) {
    console.log('--dry-run: registry NOT written.');
    return;
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  console.log('Wrote', REGISTRY_PATH);
}

main();
