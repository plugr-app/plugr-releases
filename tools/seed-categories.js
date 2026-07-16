#!/usr/bin/env node
//
// seed-categories.js — one-shot data import.
//
// Takes the categorization map below (curated from Josh's CSV of plugins
// that landed at Effect/Undefined or fully-Undefined) and writes them into
// the bundled developerRegistry.json as productMatchers entries.
//
// Why: when a plugin's category can't be inferred from its name or AU
// type (most of the time because the manufacturer uses creative names
// like "Bite" or "Movement"), the only way to give the user the correct
// category at scan time is to look it up in the registry. This script
// builds that table.
//
// Pass --dry-run to preview without writing the registry file.
//
// The script never overwrites existing productMatchers fields it didn't
// set — it only adds category/subcategory (or fills them in when an
// existing entry already had updateUrl/versionRegex but no category).

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, '..', 'electron', 'lib', 'developerRegistry.json');
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

// Map shape:
//   { devName: { 'Plugin Name Pattern': { category, subcategory } } }
// Patterns are matched against the scanned plugin name with includes()
// (plus a normalized fallback that ignores spaces / underscores / dashes).
// So "Cyclic Panner" matches "Cyclic Panner", "Cyclic_Panner", and
// "Cyclic-Panner". Pick the SHORTEST key that's still unique to the
// plugin within that developer's product line — that maximizes coverage.
const CATEGORIES = {
  'A.O.M. Factory': {
    'Cyclic Panner':     { category: 'Effect', subcategory: 'Modulation' },
    'Invisible Limiter': { category: 'Effect', subcategory: 'Dynamics' },
  },
  'AIR Music Tech': {
    'theRiser': { category: 'Instrument', subcategory: 'Synth' },
    'Xpand':    { category: 'Instrument', subcategory: 'Synth' },
  },
  'Antares': {
    'Aspire':         { category: 'Effect', subcategory: 'Pitch' },
    'Choir':          { category: 'Effect', subcategory: 'Pitch' },
    'Duo':            { category: 'Effect', subcategory: 'Pitch' },
    'Punch':          { category: 'Effect', subcategory: 'Dynamics' },
    'Sybil':          { category: 'Effect', subcategory: 'Dynamics' },
    'Throat':         { category: 'Effect', subcategory: 'Pitch' },
    'Warm':           { category: 'Effect', subcategory: 'Distortion' },
    'Harmony Engine': { category: 'Effect', subcategory: 'Pitch' },
    'Metamorph':      { category: 'Effect', subcategory: 'Pitch' },
    // AVOX bundle umbrella — covers AVOX ASPIRE etc. via substring.
    'AVOX':           { category: 'Effect', subcategory: 'Pitch' },
  },
  'Apple': {
    'AES3 Audio Decoder': { category: 'Effect', subcategory: 'Utility' },
  },
  'Applied Acoustics Systems': {
    'AAS Player':           { category: 'Instrument', subcategory: 'Sampler' },
    'Lounge Lizard':        { category: 'Instrument', subcategory: 'Keys' },
    'Strum Session':        { category: 'Instrument', subcategory: 'Guitar/Bass' },
    'Ultra Analog Session': { category: 'Instrument', subcategory: 'Synth' },
  },
  'Arturia': {
    'Bus FORCE':       { category: 'Effect', subcategory: 'Dynamics' },
    'Dist COLDFIRE':   { category: 'Effect', subcategory: 'Distortion' },
    'Dist OPAMP':      { category: 'Effect', subcategory: 'Distortion' },
    'Dist TUBE':       { category: 'Effect', subcategory: 'Distortion' },
    'Efx FRAGMENTS':   { category: 'Effect', subcategory: 'Creative' },
    'Pre 1973':        { category: 'Effect', subcategory: 'EQ' },
    'Pre TridA':       { category: 'Effect', subcategory: 'EQ' },
    'Pre V76':         { category: 'Effect', subcategory: 'EQ' },
    'Rev INTENSITY':   { category: 'Effect', subcategory: 'Reverb' },
    'Rev LX-24':       { category: 'Effect', subcategory: 'Reverb' },
    'Tape MELLO-FI':   { category: 'Effect', subcategory: 'Distortion' },
  },
  'Audified': {
    'SpeakUp': { category: 'Effect', subcategory: 'Utility' },
  },
  'AudioThing': {
    'Valves': { category: 'Effect', subcategory: 'Distortion' },
  },
  'Audiomodern': {
    'Experiverb': { category: 'Effect', subcategory: 'Reverb' },
    'Filterstep': { category: 'Effect', subcategory: 'Modulation' },
    'Gatelab':    { category: 'Effect', subcategory: 'Modulation' },
    'Panflow':    { category: 'Effect', subcategory: 'Modulation' },
  },
  'Audiority': {
    'Deleight': { category: 'Effect', subcategory: 'Delay' },
  },
  'Avid': {
    'BF-76':              { category: 'Effect', subcategory: 'Dynamics' },
    'ClickII':            { category: 'Instrument', subcategory: 'Generator' },
    'Dither':             { category: 'Effect', subcategory: 'Utility' },
    'DownMixer':          { category: 'Effect', subcategory: 'Utility' },
    'DynamicsIII':        { category: 'Effect', subcategory: 'Dynamics' },
    'Eleven':             { category: 'Effect', subcategory: 'Distortion' },
    'EQIII':              { category: 'Effect', subcategory: 'EQ' },
    'InTune':             { category: 'Effect', subcategory: 'Utility' },
    'MasterMeter':        { category: 'Effect', subcategory: 'Utility' },
    'Maxim':              { category: 'Effect', subcategory: 'Dynamics' },
    'ModDelay':           { category: 'Effect', subcategory: 'Delay' },
    'Normalize-Gain':     { category: 'Effect', subcategory: 'Utility' },
    'NoteStack':          { category: 'MIDI',   subcategory: null },
    'PitchControl':       { category: 'Effect', subcategory: 'Pitch' },
    'PitchII':            { category: 'Effect', subcategory: 'Pitch' },
    'RectiFi':            { category: 'Effect', subcategory: 'Distortion' },
    'Reverse-DC Removal': { category: 'Effect', subcategory: 'Utility' },
    'SansAmp':            { category: 'Effect', subcategory: 'Distortion' },
    'SciFi':              { category: 'Effect', subcategory: 'Creative' },
    'SignalGenerator':    { category: 'Instrument', subcategory: 'Generator' },
    'Time Shift':         { category: 'Effect', subcategory: 'Utility' },
    'TimeAdjuster':       { category: 'Effect', subcategory: 'Utility' },
    'Trim':               { category: 'Effect', subcategory: 'Utility' },
    'VariFi':             { category: 'Effect', subcategory: 'Creative' },
    'VelocityControl':    { category: 'MIDI',   subcategory: null },
  },
  'Blue Cat Audio': {
    'BC Free Amp':    { category: 'Effect', subcategory: 'Distortion' },
    'BC FreqAnalyst': { category: 'Effect', subcategory: 'Utility' },
    'BC Gain':        { category: 'Effect', subcategory: 'Utility' },
  },
  'Cableguys': {
    'Kickstart':  { category: 'Effect', subcategory: 'Modulation' },
    'PanCake':    { category: 'Effect', subcategory: 'Modulation' },
    'ShaperBox':  { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Camelaudio': {
    'CamelCrusher': { category: 'Effect', subcategory: 'Distortion' },
  },
  'D16 Group': {
    'Syntorus': { category: 'Effect', subcategory: 'Modulation' },
  },
  'Digidesign': {
    'Invert-Duplicate': { category: 'Effect', subcategory: 'Utility' },
  },
  'EaReckon': {
    'MIDIPolysher': { category: 'MIDI', subcategory: null },
  },
  'FLUX SE': {
    'Alchemist':            { category: 'Effect', subcategory: 'Multi-Effect' },
    'BitterSweet':          { category: 'Effect', subcategory: 'Dynamics' },
    'Elixir':               { category: 'Effect', subcategory: 'Dynamics' },
    'EvoChannel':           { category: 'Effect', subcategory: 'Multi-Effect' },
    'EvoIn':                { category: 'Effect', subcategory: 'Multi-Effect' },
    'HEar':                 { category: 'Effect', subcategory: 'Utility' },
    'LevelMagic':           { category: 'Effect', subcategory: 'Dynamics' },
    'SampleGrabber':        { category: 'Effect', subcategory: 'Utility' },
    'Solera':               { category: 'Effect', subcategory: 'Dynamics' },
    'SpatRevolution':       { category: 'Effect', subcategory: 'Imaging' },
    'Spat':                 { category: 'Effect', subcategory: 'Imaging' },
    'TraxCs':               { category: 'Effect', subcategory: 'Utility' },
    'TraxSf':               { category: 'Effect', subcategory: 'Utility' },
    'Trax':                 { category: 'Effect', subcategory: 'Utility' },
  },
  'FineCutBodies': {
    'LaPetiteExcite': { category: 'Effect', subcategory: 'Distortion' },
  },
  'Firesonic': {
    'FireCharger': { category: 'Effect', subcategory: 'Distortion' },
    'FireMaster':  { category: 'Effect', subcategory: 'Dynamics' },
  },
  'Focusrite': {
    'Balancer':      { category: 'Effect', subcategory: 'Utility' },
    'FAST Balancer': { category: 'Effect', subcategory: 'Utility' },
  },
  'Greenoak': {
    'Crystal': { category: 'Instrument', subcategory: 'Synth' },
  },
  'Image-Line': {
    'Drumaxx':        { category: 'Instrument', subcategory: 'Drums' },
    'Hardcore':       { category: 'Effect',     subcategory: 'Distortion' },
    'PoiZone':        { category: 'Instrument', subcategory: 'Synth' },
    'Sawer':          { category: 'Instrument', subcategory: 'Synth' },
    'ToxicBiohazard': { category: 'Instrument', subcategory: 'Synth' },
  },
  'Instant Audio': {
    'QuickBass': { category: 'Effect', subcategory: 'Utility' },
  },
  'JMG Sound': {
    'Expanse3D':    { category: 'Effect', subcategory: 'Imaging' },
    'Mirror':       { category: 'Effect', subcategory: 'Imaging' },
    'Nanopulse':    { category: 'Effect', subcategory: 'Distortion' },
    'Transmutator': { category: 'Effect', subcategory: 'Creative' },
  },
  'KORG': {
    'MDE-X': { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Kilohearts': {
    'Disperser':         { category: 'Effect', subcategory: 'Creative' },
    'Faturator':         { category: 'Effect', subcategory: 'Distortion' },
    'Channel Mixer':     { category: 'Effect', subcategory: 'Utility' },
    'Convolver':         { category: 'Effect', subcategory: 'Reverb' },
    'kHs Dynamics':      { category: 'Effect', subcategory: 'Dynamics' },
    'Frequency Shifter': { category: 'Effect', subcategory: 'Pitch' },
    'kHs Gain':          { category: 'Effect', subcategory: 'Utility' },
    'Haas':              { category: 'Effect', subcategory: 'Imaging' },
    'Pitch Shifter':     { category: 'Effect', subcategory: 'Pitch' },
    'Resonator':         { category: 'Effect', subcategory: 'Creative' },
    'Reverser':          { category: 'Effect', subcategory: 'Creative' },
    'kHs Stereo':        { category: 'Effect', subcategory: 'Imaging' },
    'Tape Stop':         { category: 'Effect', subcategory: 'Creative' },
    'Multipass':         { category: 'Effect', subcategory: 'Multi-Effect' },
    'Snap Heap':         { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Klevgrand': {
    'DAW Cassette': { category: 'Effect', subcategory: 'Distortion' },
    'DAWCassette':  { category: 'Effect', subcategory: 'Distortion' },
  },
  'Lindell Audio': {
    '6X-500':            { category: 'Effect', subcategory: 'EQ' },
    'ChannelX':          { category: 'Effect', subcategory: 'Multi-Effect' },
    'Lindell 254E':      { category: 'Effect', subcategory: 'Dynamics' },
    'Lindell 354E':      { category: 'Effect', subcategory: 'Dynamics' },
    'Lindell 80 Bus':    { category: 'Effect', subcategory: 'Multi-Effect' },
    'Lindell 80 Channel':{ category: 'Effect', subcategory: 'Multi-Effect' },
    'Lindell TE-100':    { category: 'Effect', subcategory: 'Distortion' },
    'PEX-500':           { category: 'Effect', subcategory: 'EQ' },
  },
  'McDowell Signal Processing': {
    'ML4000': { category: 'Effect', subcategory: 'Dynamics' },
  },
  'MeldaProduction': {
    'MAGC':           { category: 'Effect', subcategory: 'Dynamics' },
    'MAmp':           { category: 'Effect', subcategory: 'Distortion' },
    'MAutoAlign':     { category: 'Effect', subcategory: 'Utility' },
    'MAutoPitch':     { category: 'Effect', subcategory: 'Pitch' },
    'MAutoStereoFix': { category: 'Effect', subcategory: 'Imaging' },
    'MAutoVolume':    { category: 'Effect', subcategory: 'Dynamics' },
    'MBassador':      { category: 'Effect', subcategory: 'Utility' },
    'MBitFun':        { category: 'Effect', subcategory: 'Distortion' },
    'MCabinet':       { category: 'Effect', subcategory: 'Distortion' },
    'MCCGenerator':   { category: 'MIDI',   subcategory: null },
    'MChannelMatrix': { category: 'Effect', subcategory: 'Utility' },
    'MCharacter':     { category: 'Effect', subcategory: 'Distortion' },
    'MComb':          { category: 'Effect', subcategory: 'Modulation' },
    'MCompare':       { category: 'Effect', subcategory: 'Utility' },
    'MDoubleTracker': { category: 'Effect', subcategory: 'Pitch' },
    'MDrumEnhancer':  { category: 'Effect', subcategory: 'Utility' },
    'MDrumReplacer':  { category: 'Effect', subcategory: 'Utility' },
    'MDrumStrip':     { category: 'Effect', subcategory: 'Multi-Effect' },
    'MDynamics':      { category: 'Effect', subcategory: 'Dynamics' },
    'MFreeformPhase': { category: 'Effect', subcategory: 'Utility' },
    'MFreqShifter':   { category: 'Effect', subcategory: 'Pitch' },
    'MGuitarArchitect':{ category: 'Effect', subcategory: 'Multi-Effect' },
    'MMetronome':     { category: 'Instrument', subcategory: 'Generator' },
    'MMorph':         { category: 'Effect', subcategory: 'Creative' },
    'MNoiseGenerator':{ category: 'Instrument', subcategory: 'Generator' },
    'MNotepad':       { category: 'Effect', subcategory: 'Utility' },
    'MOscillator':    { category: 'Instrument', subcategory: 'Generator' },
    'MOscilloscope':  { category: 'Effect', subcategory: 'Utility' },
    'MPhatik':        { category: 'Effect', subcategory: 'Distortion' },
    'MRatio':         { category: 'Effect', subcategory: 'Dynamics' },
    'MRecorder':      { category: 'Effect', subcategory: 'Utility' },
    'MRhythmizer':    { category: 'Effect', subcategory: 'Modulation' },
    'MSpectralDynamics':{ category: 'Effect', subcategory: 'Dynamics' },
    'MSpectralPan':   { category: 'Effect', subcategory: 'Imaging' },
    'MStereoGenerator':{ category: 'Effect', subcategory: 'Imaging' },
    'MStereoProcessor':{ category: 'Effect', subcategory: 'Imaging' },
    'MStereoScope':   { category: 'Effect', subcategory: 'Utility' },
    'MSuperLooper':   { category: 'Effect', subcategory: 'Creative' },
    'MTransformer':   { category: 'Effect', subcategory: 'Multi-Effect' },
    'MTuner':         { category: 'Effect', subcategory: 'Utility' },
    'MTurboAmp':      { category: 'Effect', subcategory: 'Distortion' },
    'MUnison':        { category: 'Effect', subcategory: 'Pitch' },
    'MWaveFolder':    { category: 'Effect', subcategory: 'Distortion' },
    'MWobbler':       { category: 'Effect', subcategory: 'Modulation' },
    'MXXX':           { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Mixed In Key': {
    'Mixed In Key': { category: 'Effect', subcategory: 'Utility' },
  },
  'Muramasa Audio': {
    'Bassment': { category: 'Effect', subcategory: 'Utility' },
    'Electrum': { category: 'Effect', subcategory: 'Distortion' },
  },
  'Native Instruments': {
    'Bite':           { category: 'Effect', subcategory: 'Distortion' },
    'Choral':         { category: 'Effect', subcategory: 'Modulation' },
    'Dirt':           { category: 'Effect', subcategory: 'Distortion' },
    'Driver':         { category: 'Effect', subcategory: 'Distortion' },
    'Flair':          { category: 'Effect', subcategory: 'Modulation' },
    'Freak':          { category: 'Effect', subcategory: 'Modulation' },
    'Phasis':         { category: 'Effect', subcategory: 'Modulation' },
    'RC 24':          { category: 'Effect', subcategory: 'Reverb' },
    'RC 48':          { category: 'Effect', subcategory: 'Reverb' },
    'Solid Dynamics': { category: 'Effect', subcategory: 'Dynamics' },
    'VC 160':         { category: 'Effect', subcategory: 'Dynamics' },
    'VC 2A':          { category: 'Effect', subcategory: 'Dynamics' },
    'VC 76':          { category: 'Effect', subcategory: 'Dynamics' },
  },
  'New Sonic Arts': {
    'FreestyleFX': { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Nugen Audio': {
    'NUGEN Send': { category: 'Effect', subcategory: 'Utility' },
    'Pod':        { category: 'Effect', subcategory: 'Utility' },
  },
  'Output': {
    'Movement': { category: 'Effect', subcategory: 'Multi-Effect' },
    'Thermal':  { category: 'Effect', subcategory: 'Distortion' },
  },
  'Plugin Alliance': {
    'Acme Opticom XLA-3':         { category: 'Effect', subcategory: 'Dynamics' },
    'ADPTR MetricAB':             { category: 'Effect', subcategory: 'Utility' },
    'Black Box Analog Design HG-2': { category: 'Effect', subcategory: 'Distortion' },
    'bx_bassdude':                { category: 'Effect', subcategory: 'Distortion' },
    'bx_blackdist':               { category: 'Effect', subcategory: 'Distortion' },
    'bx_bluechorus':              { category: 'Effect', subcategory: 'Modulation' },
    'bx_boom':                    { category: 'Effect', subcategory: 'Utility' },
    'bx_cleansweep':              { category: 'Effect', subcategory: 'EQ' },
    'bx_console':                 { category: 'Effect', subcategory: 'Multi-Effect' },
    'bx_control':                 { category: 'Effect', subcategory: 'Utility' },
    'bx_delay':                   { category: 'Effect', subcategory: 'Delay' },
    'bx_digital':                 { category: 'Effect', subcategory: 'EQ' },
    'bx_distorange':              { category: 'Effect', subcategory: 'Distortion' },
    'bx_greenscreamer':           { category: 'Effect', subcategory: 'Distortion' },
    'bx_hybrid':                  { category: 'Effect', subcategory: 'EQ' },
    'bx_limiter':                 { category: 'Effect', subcategory: 'Dynamics' },
    'bx_masterdesk':              { category: 'Effect', subcategory: 'Multi-Effect' },
    'bx_megadual':                { category: 'Effect', subcategory: 'Distortion' },
    'bx_megasingle':              { category: 'Effect', subcategory: 'Distortion' },
    'bx_metal':                   { category: 'Effect', subcategory: 'Distortion' },
    'bx_meter':                   { category: 'Effect', subcategory: 'Utility' },
    'bx_opto':                    { category: 'Effect', subcategory: 'Dynamics' },
    'bx_refinement':              { category: 'Effect', subcategory: 'EQ' },
    'bx_rockergain':              { category: 'Effect', subcategory: 'Distortion' },
    'bx_rockrack':                { category: 'Effect', subcategory: 'Multi-Effect' },
    'bx_rooMS':                   { category: 'Effect', subcategory: 'Reverb' },
    'bx_saturator':               { category: 'Effect', subcategory: 'Distortion' },
    'bx_shredspread':             { category: 'Effect', subcategory: 'Imaging' },
    'bx_solo':                    { category: 'Effect', subcategory: 'Utility' },
    'bx_stereomaker':             { category: 'Effect', subcategory: 'Imaging' },
    'bx_subfilter':               { category: 'Effect', subcategory: 'EQ' },
    'bx_subsynth':                { category: 'Effect', subcategory: 'Utility' },
    'bx_tuner':                   { category: 'Effect', subcategory: 'Utility' },
    'bx_XL':                      { category: 'Effect', subcategory: 'Dynamics' },
    'bx_yellowdrive':             { category: 'Effect', subcategory: 'Distortion' },
    'Chandler GAV19T':            { category: 'Effect', subcategory: 'Distortion' },
    'Diezel Herbert':             { category: 'Effect', subcategory: 'Distortion' },
    'Diezel VH4':                 { category: 'Effect', subcategory: 'Distortion' },
    'elysia karacter':            { category: 'Effect', subcategory: 'Distortion' },
    'elysia mpressor':            { category: 'Effect', subcategory: 'Dynamics' },
    'elysia museq':               { category: 'Effect', subcategory: 'EQ' },
    'elysia nvelope':             { category: 'Effect', subcategory: 'Dynamics' },
    'elysia phils cascade':       { category: 'Effect', subcategory: 'EQ' },
    'ENGL E646':                  { category: 'Effect', subcategory: 'Distortion' },
    'ENGL E765':                  { category: 'Effect', subcategory: 'Distortion' },
    'ENGL Savage':                { category: 'Effect', subcategory: 'Distortion' },
    'fiedler audio stage':        { category: 'Effect', subcategory: 'Imaging' },
    'Friedman BE100':             { category: 'Effect', subcategory: 'Distortion' },
    'Friedman DS40':              { category: 'Effect', subcategory: 'Distortion' },
    'Fuchs Train':                { category: 'Effect', subcategory: 'Distortion' },
    'Maag EQ2':                   { category: 'Effect', subcategory: 'EQ' },
    'Maag EQ4':                   { category: 'Effect', subcategory: 'EQ' },
    'Maag MAGNUM':                { category: 'Effect', subcategory: 'Dynamics' },
    'Millennia NSEQ':             { category: 'Effect', subcategory: 'EQ' },
    'Millennia TCL':              { category: 'Effect', subcategory: 'Dynamics' },
    'NEOLD V76U73':               { category: 'Effect', subcategory: 'Multi-Effect' },
    'Noveltech Character':        { category: 'Effect', subcategory: 'Distortion' },
    'Noveltech Vocal Enhancer':   { category: 'Effect', subcategory: 'Utility' },
    'Pro Audio DSP DSM':          { category: 'Effect', subcategory: 'Dynamics' },
    'Purple Audio MC 77':         { category: 'Effect', subcategory: 'Dynamics' },
    'Schoeps Double MS':          { category: 'Effect', subcategory: 'Imaging' },
    'Schoeps Mono Upmix':         { category: 'Effect', subcategory: 'Imaging' },
    'SPL Attacker':               { category: 'Effect', subcategory: 'Dynamics' },
    'SPL DrumXchanger':           { category: 'Effect', subcategory: 'Utility' },
    'SPL Free Ranger':            { category: 'Effect', subcategory: 'EQ' },
    'SPL HawkEye':                { category: 'Effect', subcategory: 'Utility' },
    'SPL IRON':                   { category: 'Effect', subcategory: 'Dynamics' },
    'SPL Passeq':                 { category: 'Effect', subcategory: 'EQ' },
    'SPL TwinTube':               { category: 'Effect', subcategory: 'Distortion' },
    'SPL Vitalizer':              { category: 'Effect', subcategory: 'EQ' },
    'Vertigo VSC':                { category: 'Effect', subcategory: 'Dynamics' },
    'Vertigo VSM':                { category: 'Effect', subcategory: 'Distortion' },
  },
  'Resonantcavity': {
    'Voloco': { category: 'Effect', subcategory: 'Pitch' },
  },
  'Rocket Powered Sound': {
    'Car Test': { category: 'Effect', subcategory: 'Utility' },
  },
  'Samplemagic': {
    'Magic AB': { category: 'Effect', subcategory: 'Utility' },
  },
  'Sennheiser / Dear Reality': {
    'dearVR': { category: 'Effect', subcategory: 'Imaging' },
  },
  'Slate Digital': {
    'Fresh Air': { category: 'Effect', subcategory: 'EQ' },
  },
  'Softube': {
    'Console 1':   { category: 'Effect', subcategory: 'Multi-Effect' },
    'Drawmer S73': { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Sonic Academy': {
    'Kick': { category: 'Instrument', subcategory: 'Drums' },
  },
  'Sonnox': {
    'Oxford Inflator': { category: 'Effect', subcategory: 'Distortion' },
  },
  'Sound Device Digital': {
    'FrontDAW':         { category: 'Effect', subcategory: 'Multi-Effect' },
    'MasterMind':       { category: 'Effect', subcategory: 'Multi-Effect' },
    'SubbassDoctor808': { category: 'Effect', subcategory: 'Utility' },
    'TrapTune':         { category: 'Effect', subcategory: 'Pitch' },
    'UrbanPuncher':     { category: 'Effect', subcategory: 'Multi-Effect' },
    'VoxDucker':        { category: 'Effect', subcategory: 'Dynamics' },
    'Voxessor':         { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'SoundRadix': {
    'Muteomatic': { category: 'Effect', subcategory: 'Utility' },
  },
  'Soundtoys': {
    'Devil-Loc':     { category: 'Effect', subcategory: 'Distortion' },
    'DevilLoc':      { category: 'Effect', subcategory: 'Distortion' },
    'PrimalTap':     { category: 'Effect', subcategory: 'Delay' },
    'Radiator':      { category: 'Effect', subcategory: 'Distortion' },
    'PanMan':        { category: 'Effect', subcategory: 'Modulation' },
    'PhaseMistress': { category: 'Effect', subcategory: 'Modulation' },
    'Sie-Q':         { category: 'Effect', subcategory: 'EQ' },
    'SieQ':          { category: 'Effect', subcategory: 'EQ' },
    'Tremolator':    { category: 'Effect', subcategory: 'Modulation' },
  },
  'Steinberg': {
    'Content Player': { category: 'Effect', subcategory: 'Utility' },
    'Padshop':        { category: 'Instrument', subcategory: 'Synth' },
    'Retrologue':     { category: 'Instrument', subcategory: 'Synth' },
  },
  'Sugar Bytes': {
    'Aparillo':   { category: 'Instrument', subcategory: 'Synth' },
    'Artillery':  { category: 'Effect',     subcategory: 'Multi-Effect' },
    'Factory':    { category: 'Instrument', subcategory: 'Synth' },
    'Guitarist':  { category: 'Instrument', subcategory: 'Guitar/Bass' },
    'Unique':     { category: 'Instrument', subcategory: 'Synth' },
    'WOW':        { category: 'Effect',     subcategory: 'Modulation' },
  },
  'TAL Software': {
    'allpassphase': { category: 'Effect', subcategory: 'Utility' },
  },
  'Tailorednoise': {
    'Endless Smile':   { category: 'Effect', subcategory: 'Multi-Effect' },
    'Sausage Fattener':{ category: 'Effect', subcategory: 'Distortion' },
    'SausageFattener': { category: 'Effect', subcategory: 'Distortion' },
  },
  'Tokyo Dawn Labs': {
    'Kotelnikov': { category: 'Effect', subcategory: 'Dynamics' },
  },
  'UJAM': {
    'FIN-DYNAMO': { category: 'Effect', subcategory: 'Multi-Effect' },
    'FIN-FLUXX':  { category: 'Effect', subcategory: 'Multi-Effect' },
    'FIN-MICRO':  { category: 'Effect', subcategory: 'Multi-Effect' },
    'FIN-NEO':    { category: 'Effect', subcategory: 'Multi-Effect' },
    'FIN-RETRO':  { category: 'Effect', subcategory: 'Multi-Effect' },
    'FIN-VOOD':   { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'UVI': {
    'UVIWorkstation': { category: 'Instrument', subcategory: 'Sampler' },
  },
  'Unfiltered Audio': {
    'Bass Mint':   { category: 'Effect', subcategory: 'Utility' },
    'Byome':       { category: 'Effect', subcategory: 'Multi-Effect' },
    'Dent':        { category: 'Effect', subcategory: 'Distortion' },
    'Fault':       { category: 'Effect', subcategory: 'Distortion' },
    'G8':          { category: 'Effect', subcategory: 'Dynamics' },
    'Indent':      { category: 'Effect', subcategory: 'Distortion' },
    'Sandman':     { category: 'Effect', subcategory: 'Delay' },
    'SpecOps':     { category: 'Effect', subcategory: 'Multi-Effect' },
    'Triad':       { category: 'Effect', subcategory: 'EQ' },
    'Zip':         { category: 'Effect', subcategory: 'Dynamics' },
  },
  'Venomode': {
    'DeeQ':    { category: 'Effect', subcategory: 'EQ' },
    'Maximal': { category: 'Effect', subcategory: 'Dynamics' },
  },
  'Voxengo': {
    'MSED':         { category: 'Effect', subcategory: 'Imaging' },
    'SPAN':         { category: 'Effect', subcategory: 'Utility' },
    'Stereo Touch': { category: 'Effect', subcategory: 'Imaging' },
    'Tube Amp':     { category: 'Effect', subcategory: 'Distortion' },
  },
  'W. A. Production': {
    'Biggifier':            { category: 'Effect', subcategory: 'Distortion' },
    'ComBear':              { category: 'Effect', subcategory: 'Dynamics' },
    'Combustor':            { category: 'Effect', subcategory: 'Distortion' },
    'Heat':                 { category: 'Effect', subcategory: 'Distortion' },
    'Helper-Equalizer':     { category: 'Effect', subcategory: 'EQ' },
    'HelperEqualizer':      { category: 'Effect', subcategory: 'EQ' },
    'Helper-Saturator':     { category: 'Effect', subcategory: 'Distortion' },
    'HelperSaturator':      { category: 'Effect', subcategory: 'Distortion' },
    'Helper-Transients':    { category: 'Effect', subcategory: 'Dynamics' },
    'HelperTransients':     { category: 'Effect', subcategory: 'Dynamics' },
    'Imprint':              { category: 'Effect', subcategory: 'Distortion' },
    'KSHMR Essentials Kick':{ category: 'Effect', subcategory: 'Utility' },
    'KSHMR Essentials':     { category: 'Effect', subcategory: 'Multi-Effect' },
    'KSHMREssentialsKick':  { category: 'Effect', subcategory: 'Utility' },
    'KSHMREssentials':      { category: 'Effect', subcategory: 'Multi-Effect' },
    'Multibender':          { category: 'Effect', subcategory: 'Multi-Effect' },
    'Orchid':               { category: 'Effect', subcategory: 'Multi-Effect' },
    'Outlaw':               { category: 'Effect', subcategory: 'Distortion' },
    'Pumper':               { category: 'Effect', subcategory: 'Modulation' },
    'Puncher':              { category: 'Effect', subcategory: 'Dynamics' },
    'PutMeOnDrums':         { category: 'Effect', subcategory: 'Multi-Effect' },
    'Satyrus':              { category: 'Instrument', subcategory: 'Synth' },
    'Screamo':              { category: 'Effect', subcategory: 'Distortion' },
    'SphereQuad':           { category: 'Effect', subcategory: 'Imaging' },
    'The King':             { category: 'Effect', subcategory: 'Dynamics' },
    'TheKing':              { category: 'Effect', subcategory: 'Dynamics' },
    'Trackspacer':          { category: 'Effect', subcategory: 'Dynamics' },
    'TrackSpacer':          { category: 'Effect', subcategory: 'Dynamics' },
    'Trivox':               { category: 'Effect', subcategory: 'Multi-Effect' },
    'Venom':                { category: 'Effect', subcategory: 'Distortion' },
    'VINAI XTT':            { category: 'Effect', subcategory: 'Multi-Effect' },
    'VINAIXTT':             { category: 'Effect', subcategory: 'Multi-Effect' },
    'Vocal Cleaner':        { category: 'Effect', subcategory: 'Utility' },
    'VocalCleaner':         { category: 'Effect', subcategory: 'Utility' },
    'Vocal Splitter':       { category: 'Effect', subcategory: 'Utility' },
    'VocalSplitter':        { category: 'Effect', subcategory: 'Utility' },
    'Zqueezer':             { category: 'Effect', subcategory: 'Dynamics' },
  },
  'Waves': {
    'WaveShell': { category: 'Effect', subcategory: 'Utility' },
  },
  'XLN Audio': {
    'RC-20 Retro Color': { category: 'Effect', subcategory: 'Multi-Effect' },
  },
  'Xfer Records': {
    '8BitShaper':     { category: 'Effect', subcategory: 'Distortion' },
    'DeltaModulator': { category: 'Effect', subcategory: 'Distortion' },
    'MIDIShiftArray': { category: 'MIDI',   subcategory: null },
  },
  'XynthAudio': {
    'Chroma': { category: 'Instrument', subcategory: 'Synth' },
  },
  'Zplane': {
    'peel':       { category: 'Effect', subcategory: 'Utility' },
    'PEEL':       { category: 'Effect', subcategory: 'Utility' },
    'vielklang':  { category: 'Effect', subcategory: 'Pitch' },
  },
  'iZotope': {
    'Dialogue Match': { category: 'Effect', subcategory: 'Multi-Effect' },
    'Neoverb':        { category: 'Effect', subcategory: 'Reverb' },
    'Neutrino':       { category: 'Effect', subcategory: 'EQ' },
    'R2':             { category: 'Effect', subcategory: 'Reverb' },
    'R4':             { category: 'Effect', subcategory: 'Reverb' },
    'Relay':          { category: 'Effect', subcategory: 'Utility' },
    'Vinyl':          { category: 'Effect', subcategory: 'Creative' },
    'Vocal Doubler':  { category: 'Effect', subcategory: 'Pitch' },
  },
  'oeksound': {
    'soothe': { category: 'Effect', subcategory: 'EQ' },
  },
  'Ohm Force': {
    'Frohmage': { category: 'Effect', subcategory: 'EQ' },
  },
};

// Developer-name aliases to add. The promote-cache run handles per-plugin
// developer overrides, but some developers show up under variant names
// the registry doesn't know yet — wire them in here so future scans
// canonicalize them automatically.
const ALIASES_TO_ADD = {
  'zplane.development': 'Zplane',
  'zplane gmbh':        'Zplane',
};

// Aliases — sometimes the same product was scanned under a different
// developer name (e.g. "zplane.development" vs "Zplane"). When promoting,
// route those to the canonical developer key. Keys are lowercased.
const DEVELOPER_REDIRECTS = {
  'zplane.development': 'Zplane',
};

function ensureDev(reg, devName) {
  reg.developers = reg.developers || {};
  if (!reg.developers[devName]) {
    reg.developers[devName] = { identifierPrefix: [], productMatchers: {} };
  }
  if (!reg.developers[devName].productMatchers) {
    reg.developers[devName].productMatchers = {};
  }
  return reg.developers[devName];
}

// Merge the external supplement file (category-seed-supplement.json) into
// the inline CATEGORIES map. Keeps the big data-only table out of this
// script while reusing all of its merge/backfill/alias machinery. Inline
// CATEGORIES wins on any exact dev+product conflict (hand-curated).
function loadSupplement() {
  const p = path.join(__dirname, 'category-seed-supplement.json');
  if (!fs.existsSync(p)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('Could not parse category-seed-supplement.json:', e.message); process.exit(1); }
  for (const [dev, products] of Object.entries(data)) {
    if (dev.startsWith('_')) continue;   // skip _comment
    CATEGORIES[dev] = CATEGORIES[dev] || {};
    for (const [name, cat] of Object.entries(products)) {
      if (!(name in CATEGORIES[dev])) CATEGORIES[dev][name] = cat;
    }
  }
}

function main() {
  loadSupplement();
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const reg = JSON.parse(raw);

  const stats = {
    devsCreated: 0,
    devsTouched: new Set(),
    pluginsAdded: 0,
    pluginsUpdated: 0,
    pluginsUnchanged: 0,
    backfilled: 0,
    aliasesAdded: 0,
  };

  // Normalize for fuzzy substring matching: strip non-alphanumeric, lower.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  for (let [devName, plugins] of Object.entries(CATEGORIES)) {
    const lc = devName.toLowerCase();
    if (DEVELOPER_REDIRECTS[lc]) devName = DEVELOPER_REDIRECTS[lc];
    const existed = !!(reg.developers && reg.developers[devName]);
    if (!existed) {
      ensureDev(reg, devName);
      stats.devsCreated++;
    }
    const devEntry = ensureDev(reg, devName);
    for (const [pat, cat] of Object.entries(plugins)) {
      const existing = devEntry.productMatchers[pat];
      if (existing && existing.category === cat.category && existing.subcategory === cat.subcategory) {
        stats.pluginsUnchanged++;
        continue;
      }
      // Preserve any URL/regex/etc fields that were already there.
      const merged = { ...(existing || {}), category: cat.category, subcategory: cat.subcategory };
      // Drop empty-string subcategory so JSON stays clean.
      if (merged.subcategory == null) {
        // keep null so downstream code knows "top-level category, no sub".
      }
      devEntry.productMatchers[pat] = merged;
      if (existing) stats.pluginsUpdated++;
      else stats.pluginsAdded++;
      stats.devsTouched.add(devName);
    }
  }

  // -----------------------------------------------------------------
  // Backfill pass: for each developer we touched, walk its existing
  // productMatchers entries. If an entry has no category (typically
  // because it landed there via promote-cache-additions, which only
  // sets updateUrl + versionRegex), find the longest CATEGORIES key for
  // that developer whose normalized form is a substring of the existing
  // entry's normalized key, and copy category/subcategory onto it. This
  // is what stops longer URL-only matchers from shadowing shorter
  // category-bearing ones at runtime — they BOTH end up with category
  // info, so whoever wins the longest-first sort still returns the
  // right category.
  // Build the full set of developers that could benefit from backfill:
  // every developer named in CATEGORIES (after redirects), regardless of
  // whether the seed pass actually added or changed anything for them.
  // This catches the case where ALL of a developer's CATEGORIES entries
  // were unchanged (already in the registry from a prior run) but other
  // existing productMatchers — typically promote-cache URL-only entries
  // — still lack category info.
  const allCatDevs = new Set();
  for (const devName of Object.keys(CATEGORIES)) {
    const lc = devName.toLowerCase();
    allCatDevs.add(DEVELOPER_REDIRECTS[lc] || devName);
  }
  for (const devName of allCatDevs) {
    const devEntry = reg.developers[devName];
    if (!devEntry || !devEntry.productMatchers) continue;
    const catMap = CATEGORIES[devName] || {};
    // Find redirected source entries too (e.g. zplane.development → Zplane).
    for (const [from, to] of Object.entries(DEVELOPER_REDIRECTS)) {
      if (to === devName) Object.assign(catMap, CATEGORIES[from] || {});
    }
    const sortedPatterns = Object.keys(catMap).sort((a, b) => norm(b).length - norm(a).length);
    for (const [key, val] of Object.entries(devEntry.productMatchers)) {
      if (val && val.category) continue; // already has category
      const normKey = norm(key);
      if (!normKey) continue;
      for (const pat of sortedPatterns) {
        const normPat = norm(pat);
        if (normPat && normKey.includes(normPat)) {
          const cat = catMap[pat];
          devEntry.productMatchers[key] = { ...val, category: cat.category, subcategory: cat.subcategory };
          stats.backfilled++;
          break;
        }
      }
    }
  }

  // Alias insertion. Mirrors the developerAliases tail of the registry
  // so the runtime alias resolver (applyDeveloperAlias) picks these up
  // without anyone having to hand-edit the JSON.
  reg.developerAliases = reg.developerAliases || {};
  for (const [variant, canonical] of Object.entries(ALIASES_TO_ADD)) {
    const lc = variant.toLowerCase();
    if (reg.developerAliases[lc] !== canonical) {
      reg.developerAliases[lc] = canonical;
      stats.aliasesAdded++;
    }
  }

  // -----------------------------------------------------------------
  console.log('Categorization import');
  console.log('  developers created : ', stats.devsCreated);
  console.log('  developers touched : ', stats.devsTouched.size);
  console.log('  productMatchers +  : ', stats.pluginsAdded);
  console.log('  productMatchers ~  : ', stats.pluginsUpdated);
  console.log('  productMatchers =  : ', stats.pluginsUnchanged);
  console.log('  backfilled (existing): ', stats.backfilled);
  console.log('  aliases added       : ', stats.aliasesAdded);
  console.log('');

  if (DRY_RUN) {
    console.log('--dry-run: registry NOT written.');
    return;
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  console.log('Wrote', REGISTRY_PATH);
}

main();
