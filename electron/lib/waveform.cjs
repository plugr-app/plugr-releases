// Audio waveform peak extractor for bounce files.
//
// Strategy: shell out to macOS's built-in `afconvert` to decode the
// source audio file (WAV / AIFF / MP3 / M4A / FLAC — whatever) into
// a small mono 16-bit PCM WAV at 8 kHz. Then parse the WAV's data
// chunk and downsample to N min/max pairs for a mirrored-bars
// SoundCloud-style waveform.
//
// 8 kHz mono is plenty for a thumbnail — at 200 buckets across a
// 4-minute bounce we get ~9600 samples per bucket which absorbs all
// transient detail visually. The decoded temp file is tiny (~470 KB
// per minute), so the parse is fast (<10 ms typical).
//
// Caching: peaks JSON is keyed by audio path + size + mtime so it
// regenerates only when the bounce changes on disk. Cache lives in
// the Electron userData folder so it survives reloads but isn't
// stored next to the user's audio files.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TARGET_SAMPLE_RATE = 8000;
const DEFAULT_NUM_PEAKS = 200;
const AFCONVERT_TIMEOUT_MS = 30_000;

// Run afconvert to decode `srcPath` into a mono 16-bit signed
// little-endian PCM WAV at TARGET_SAMPLE_RATE Hz, writing to
// `dstPath`. Rejects on non-zero exit / timeout.
function afconvertToMono8k(srcPath, dstPath) {
  return new Promise((resolve, reject) => {
    execFile('afconvert',
      [
        '-f', 'WAVE',                                  // WAV container
        '-d', `LEI16@${TARGET_SAMPLE_RATE}`,           // 16-bit LE, 8kHz
        '-c', '1',                                     // mono mix-down
        srcPath, dstPath,
      ],
      { timeout: AFCONVERT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

// Walk RIFF chunks until we find "data". Returns { dataOffset, dataLength }
// pointing at the raw sample bytes. Throws if the file isn't a WAV or
// the data chunk can't be found.
function findDataChunk(buf) {
  if (buf.length < 12) throw new Error('file too short for WAV');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAVE file');
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      return { dataOffset: off + 8, dataLength: Math.min(len, buf.length - (off + 8)) };
    }
    off += 8 + len;
    if (len % 2 !== 0) off += 1;   // RIFF pads odd-length chunks
  }
  throw new Error('no data chunk found in WAV');
}

// Downsample mono 16-bit LE PCM to numPeaks { min, max } pairs in
// the range -1..1. We deliberately preserve both the minimum and
// maximum of each bucket so the renderer can draw the asymmetric
// transients that make a real waveform recognizable (rather than
// just an absolute-value envelope).
function wavToPeaks(buf, numPeaks) {
  const { dataOffset, dataLength } = findDataChunk(buf);
  const totalSamples = Math.floor(dataLength / 2);   // 2 bytes per mono sample
  if (totalSamples === 0) return { peaks: [], durationSeconds: 0 };

  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / numPeaks));
  const actualPeaks = Math.min(numPeaks, Math.ceil(totalSamples / samplesPerPeak));
  const peaks = new Array(actualPeaks);
  for (let i = 0; i < actualPeaks; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(totalSamples, start + samplesPerPeak);
    let mn = 32767, mx = -32768;
    for (let j = start; j < end; j++) {
      const s = buf.readInt16LE(dataOffset + j * 2);
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    peaks[i] = [mn / 32768, mx / 32768];
  }
  return {
    peaks,
    durationSeconds: totalSamples / TARGET_SAMPLE_RATE,
  };
}

// Convert + parse without any caching. Generates a unique temp WAV,
// always cleans it up. Returns { peaks, durationSeconds }.
async function computePeaks(audioPath, numPeaks = DEFAULT_NUM_PEAKS) {
  if (!fsSync.existsSync(audioPath)) {
    throw new Error(`audio file not found: ${audioPath}`);
  }
  const tmpName = `plugr-waveform-${crypto.randomBytes(8).toString('hex')}.wav`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  try {
    await afconvertToMono8k(audioPath, tmpPath);
    const wav = await fs.readFile(tmpPath);
    return wavToPeaks(wav, numPeaks);
  } finally {
    try { await fs.unlink(tmpPath); } catch { /* ok, tmp dir is self-cleaning */ }
  }
}

function cachePathFor(userDataDir, audioPath, size, mtimeMs, numPeaks) {
  const key = `${audioPath}|${size}|${Math.round(mtimeMs)}|${numPeaks}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
  return path.join(userDataDir, 'waveforms', `${hash}.json`);
}

/**
 * Get cached peaks or compute and cache. Returns
 * { peaks, durationSeconds, fromCache } or null if the file can't
 * be read at all.
 */
async function getCachedPeaks(audioPath, userDataDir, numPeaks = DEFAULT_NUM_PEAKS) {
  let stat;
  try { stat = await fs.stat(audioPath); }
  catch { return null; }
  const cachePath = cachePathFor(userDataDir, audioPath, stat.size, stat.mtimeMs, numPeaks);
  if (fsSync.existsSync(cachePath)) {
    try {
      const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      return { ...data, fromCache: true };
    } catch { /* fall through and recompute */ }
  }
  const data = await computePeaks(audioPath, numPeaks);
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(data), 'utf8');
  } catch { /* tolerate cache write failures */ }
  return { ...data, fromCache: false };
}

module.exports = {
  computePeaks,
  getCachedPeaks,
  DEFAULT_NUM_PEAKS,
};
