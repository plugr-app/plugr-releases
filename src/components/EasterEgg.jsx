import React, { useEffect, useMemo, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Plugr's hidden 16-step drum sequencer.
//
// Triggered by clicking the brand mark in the toolbar 5 times in quick
// succession. Synthesizes its own sounds — no samples shipped with the
// app, no network needed, just the Web Audio API.
//
// Four tracks across 16 steps:
//   • Kick  — short low sine sweep
//   • Snare — burst of filtered noise + a noisy tone
//   • Hat   — high-passed noise pop
//   • Clap  — three short noise bursts in quick succession (a "clap")
//
// Click a cell to toggle a hit. Press Play / Space to start the loop.
// Adjust BPM with the slider. Patterns are lost when the modal closes
// (intentional — this is a toy, not a feature).
// ─────────────────────────────────────────────────────────────────────────

const TRACKS = [
  { id: 'kick', label: 'Kick',  hue: 4 },
  { id: 'snare', label: 'Snare', hue: 38 },
  { id: 'hat', label: 'Hat',   hue: 70 },
  { id: 'clap', label: 'Clap',  hue: 320 },
];
const STEPS = 16;

// A modest preset so the first thing the user hears isn't silence.
const DEFAULT_PATTERN = {
  kick:  [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,1,0],
  snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
  hat:   [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,1],
  clap:  [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
};

export default function EasterEgg({ onClose }) {
  const [bpm, setBpm] = useState(110);
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);
  const [swing, setSwing] = useState(0);    // 0..0.5 — % shift on offbeats

  const audioCtxRef = useRef(null);
  const timerRef = useRef(null);
  const stepRef = useRef(0);
  const patternRef = useRef(pattern);
  const swingRef = useRef(swing);

  // Keep refs in sync so the audio loop sees latest values.
  useEffect(() => { patternRef.current = pattern; }, [pattern]);
  useEffect(() => { swingRef.current = swing; }, [swing]);

  function ensureCtx() {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  }

  function toggleCell(track, idx) {
    setPattern((p) => {
      const row = [...p[track]];
      row[idx] = row[idx] ? 0 : 1;
      return { ...p, [track]: row };
    });
  }

  function clearAll() { setPattern({ kick: Array(16).fill(0), snare: Array(16).fill(0), hat: Array(16).fill(0), clap: Array(16).fill(0) }); }
  function fillRandom() {
    const r = (n) => Array.from({ length: 16 }, () => (Math.random() < n ? 1 : 0));
    setPattern({ kick: r(.18), snare: r(.12), hat: r(.45), clap: r(.06) });
  }
  function loadPreset() { setPattern(DEFAULT_PATTERN); }

  // ────────── Audio synthesis ──────────

  function playKick(when) {
    const ctx = audioCtxRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(40, when + 0.18);
    gain.gain.setValueAtTime(.9, when);
    gain.gain.exponentialRampToValueAtTime(.001, when + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.34);
  }

  function playSnare(when) {
    const ctx = audioCtxRef.current;
    // Noise burst
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1200;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(.6, when);
    noiseGain.gain.exponentialRampToValueAtTime(.001, when + 0.18);
    noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
    noise.start(when);
    noise.stop(when + 0.2);

    // Body tone
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.frequency.setValueAtTime(200, when);
    oscGain.gain.setValueAtTime(.4, when);
    oscGain.gain.exponentialRampToValueAtTime(.001, when + 0.12);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.13);
  }

  function playHat(when) {
    const ctx = audioCtxRef.current;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(.25, when);
    g.gain.exponentialRampToValueAtTime(.001, when + 0.04);
    noise.connect(filter).connect(g).connect(ctx.destination);
    noise.start(when);
    noise.stop(when + 0.05);
  }

  function playClap(when) {
    // Three quick bursts, very short, sounds like a hand clap.
    [0, 0.013, 0.028].forEach((offset, i) => {
      const ctx = audioCtxRef.current;
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < data.length; j++) data[j] = (Math.random() * 2 - 1);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(.4 - i * .05, when + offset);
      g.gain.exponentialRampToValueAtTime(.001, when + offset + 0.05);
      noise.connect(filter).connect(g).connect(ctx.destination);
      noise.start(when + offset);
      noise.stop(when + offset + 0.07);
    });
  }

  function playStep(track, when) {
    if (track === 'kick') playKick(when);
    else if (track === 'snare') playSnare(when);
    else if (track === 'hat') playHat(when);
    else if (track === 'clap') playClap(when);
  }

  // ────────── Loop ──────────

  function start() {
    ensureCtx();
    setPlaying(true);
    stepRef.current = 0;

    const tick = () => {
      const ctx = audioCtxRef.current;
      const cur = stepRef.current;
      // Apply swing on the off-beats (odd 16th notes).
      const stepSec = 60 / bpm / 4;
      const isOff = (cur % 2) === 1;
      const swingShift = isOff ? swingRef.current * stepSec : 0;
      const when = ctx.currentTime + 0.02 + swingShift;
      const pat = patternRef.current;
      for (const t of TRACKS) {
        if (pat[t.id][cur]) playStep(t.id, when);
      }
      setStep(cur);
      stepRef.current = (cur + 1) % STEPS;
    };
    tick(); // immediate first hit
    timerRef.current = setInterval(tick, (60 / bpm / 4) * 1000);
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setStep(-1);
  }

  // Restart the timer when BPM changes mid-playback so the new tempo takes effect.
  useEffect(() => {
    if (!playing) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const ctx = audioCtxRef.current;
      const cur = stepRef.current;
      const stepSec = 60 / bpm / 4;
      const isOff = (cur % 2) === 1;
      const swingShift = isOff ? swingRef.current * stepSec : 0;
      const when = ctx.currentTime + 0.02 + swingShift;
      const pat = patternRef.current;
      for (const t of TRACKS) {
        if (pat[t.id][cur]) playStep(t.id, when);
      }
      setStep(cur);
      stepRef.current = (cur + 1) % STEPS;
    }, (60 / bpm / 4) * 1000);
    /* eslint-disable-next-line */
  }, [bpm]);

  // Cleanup on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
  }, []);

  // Keyboard: space toggles play/stop.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        playing ? stop() : start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    /* eslint-disable-next-line */
  }, [playing]);

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Plugr drum machine easter egg">
      <div className="egg-modal">
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>

        <div className="egg-head">
          <div className="egg-title">
            <span className="egg-glyph" aria-hidden="true">🥁</span>
            <span>You found Plugr's hidden drum machine</span>
          </div>
          <div className="egg-sub muted">
            Click cells to lay down a beat. Space starts and stops. Have fun.
          </div>
        </div>

        <div className="egg-controls">
          <button className="btn primary" onClick={() => playing ? stop() : start()}>
            {playing ? '■ Stop' : '▶ Play'}
          </button>
          <label className="egg-bpm">
            <span>BPM</span>
            <input type="range" min="60" max="180" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
            <span className="bpm-num">{bpm}</span>
          </label>
          <label className="egg-swing">
            <span>Swing</span>
            <input type="range" min="0" max="50" value={Math.round(swing * 100)} onChange={(e) => setSwing(Number(e.target.value) / 100)} />
          </label>
          <div className="egg-action-row">
            <button className="btn" onClick={loadPreset}>Preset</button>
            <button className="btn" onClick={fillRandom}>Random</button>
            <button className="btn ghost" onClick={clearAll}>Clear</button>
          </div>
        </div>

        <div className="egg-grid">
          {/* Step header */}
          <div className="egg-row egg-header-row">
            <div className="egg-label" />
            {Array.from({ length: STEPS }, (_, i) => (
              <div key={i} className={`egg-step-num ${i % 4 === 0 ? 'beat' : ''} ${step === i ? 'is-now' : ''}`}>
                {i + 1}
              </div>
            ))}
          </div>

          {TRACKS.map((t) => (
            <div key={t.id} className="egg-row">
              <div className="egg-label" style={{ '--track-hue': t.hue }}>{t.label}</div>
              {pattern[t.id].map((on, i) => (
                <button
                  key={i}
                  type="button"
                  className={`egg-cell ${on ? 'on' : ''} ${i % 4 === 0 ? 'beat' : ''} ${step === i ? 'is-now' : ''}`}
                  style={{ '--track-hue': t.hue }}
                  onClick={() => toggleCell(t.id, i)}
                  aria-label={`${t.label} step ${i + 1}`}
                  aria-pressed={!!on}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="egg-footer muted">
          A little something for the hours you've spent with Plugr — from one producer to another.
        </div>
      </div>
    </div>
  );
}
