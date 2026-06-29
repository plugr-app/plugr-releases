import React, { useCallback, useEffect, useMemo, useState } from 'react';

// Tools tab — a collection of small producer utilities. Each tool is
// a self-contained sub-component with its own state; no IPC, no
// persistence (the tools are stateless lookups / calculators).
//
// Tools included:
//   • Tap Tempo            — tap a button or Space to derive BPM
//   • BPM ↔ Delay Time     — ms values for 1/4, 1/8, dotted, triplet
//   • Note ↔ Frequency     — bidirectional lookup, equal temperament
//   • dB ↔ Linear Gain     — voltage-domain conversion
//   • Pitch Shift Tempo    — how much tempo changes when pitched N semitones
//   • Camelot Wheel        — DJ harmonic-mixing reference
//
// Rendered as a full top-level tab (was previously a modal — modal had
// content-overflow issues on long screens, and a tab is more
// discoverable than an icon).

export default function ToolsView() {
  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={eyebrowStyle}>PRODUCER TOOLS</div>
          <h1 style={titleStyle}>Studio Toolkit</h1>
          <p style={subtleText}>Quick utilities for everyday production math — tempo, tuning, gain, and harmonic mixing.</p>
        </div>

        <SectionHeader label="Tempo & Timing" />
        <div style={gridStyle}>
          <TapTempo />
          <BpmToDelay />
          <PitchShiftTempo />
        </div>

        <SectionHeader label="Pitch & Tuning" />
        <div style={gridStyle}>
          <NoteFrequency />
          <DbGain />
        </div>

        <SectionHeader label="Harmonic Mixing" />
        <CamelotWheel />
      </div>
    </div>
  );
}

function SectionHeader({ label }) {
  return (
    <div style={sectionHeaderStyle}>
      <span style={sectionHeaderLine} />
      <span style={sectionHeaderText}>{label}</span>
      <span style={sectionHeaderLine} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Tap Tempo
// ───────────────────────────────────────────────────────────────

function TapTempo() {
  const [taps, setTaps] = useState([]);
  const [armed, setArmed] = useState(false); // when true, Space triggers a tap

  // Compute BPM from recorded tap intervals. We use the last 8 taps to
  // smooth out jitter, and reset the window if there's been a >2s gap
  // (user started over).
  const bpm = useMemo(() => {
    if (taps.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (!Number.isFinite(avg) || avg <= 0) return null;
    return Math.round((60000 / avg) * 10) / 10;
  }, [taps]);

  const tap = useCallback(() => {
    const now = Date.now();
    setTaps((prev) => {
      // Reset window if the last tap was more than 2 seconds ago.
      const filtered = prev.length > 0 && now - prev[prev.length - 1] > 2000 ? [] : prev;
      return [...filtered, now].slice(-8);
    });
  }, []);

  const reset = useCallback(() => setTaps([]), []);

  // Spacebar shortcut when the user has clicked "Use Space key".
  useEffect(() => {
    if (!armed) return undefined;
    const handler = (e) => {
      if (e.code === 'Space' || e.key === ' ') {
        // Don't fire when typing in an input.
        const ae = document.activeElement;
        const tag = (ae && ae.tagName) || '';
        if (tag === 'INPUT' && ae.type !== 'checkbox') return;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        // Stop the default Space-activates-focused-control behavior so a
        // checkbox or button that happens to hold focus doesn't toggle.
        if (ae && typeof ae.blur === 'function') ae.blur();
        tap();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [armed, tap]);

  // BPM readout is the hero — once you've tapped, that's the thing you
  // came here for. Make it visually dominant: large display first, TAP
  // button as a secondary action, helper controls below.
  return (
    <ToolCard title="Tap Tempo" icon="◉">
      <div style={{ textAlign: 'center', padding: '4px 0' }}>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: '-1px',
            fontVariantNumeric: 'tabular-nums',
            color: bpm != null ? 'var(--accent, #6ec1ff)' : 'var(--text-muted, rgba(255,255,255,0.3))',
            transition: 'color 120ms',
          }}
        >
          {bpm != null ? bpm.toFixed(1) : '—'}
        </div>
        <div style={{ ...subtleText, marginTop: 2, letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: 11 }}>
          {bpm != null ? 'BPM' : 'Tap to start'}
        </div>

        <button onClick={tap} style={tapButtonStyle}>TAP</button>

        <div style={{ ...subtleText, marginTop: 8 }}>
          {taps.length === 0 ? 'Press the button or hit Space' : `${taps.length} tap${taps.length === 1 ? '' : 's'}`}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 16, alignItems: 'center' }}>
          <button className="btn" onClick={reset}>Reset</button>
          {/* Real toggle with a checkbox affordance — click anywhere on
           *  the row to flip. Previous "Use Space key" / "Space ON"
           *  button was ambiguous about its current state. */}
          <label
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 12, cursor: 'pointer', userSelect: 'none',
              padding: '4px 10px', borderRadius: 6,
              background: armed ? 'var(--accent-bg, rgba(110, 193, 255, 0.18))' : 'transparent',
              border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
              transition: 'background 120ms',
            }}
          >
            <input
              type="checkbox" checked={armed}
              onChange={(e) => {
                setArmed(e.target.checked);
                // Hand focus back to <body> so subsequent Space presses
                // go to our keydown listener instead of re-toggling the
                // checkbox. Same fix needed on the TAP button below.
                e.target.blur();
              }}
              style={{ margin: 0 }}
            />
            <span>Tap with Space</span>
          </label>
        </div>
      </div>
    </ToolCard>
  );
}

// ───────────────────────────────────────────────────────────────
// BPM ↔ Delay Time
// ───────────────────────────────────────────────────────────────

function BpmToDelay() {
  const [bpm, setBpm] = useState(120);
  const beatMs = bpm > 0 ? 60000 / bpm : 0; // ms per quarter note

  // Note values relative to a quarter note. mul=1 means a quarter note.
  const NOTE_VALUES = [
    { name: '1/1', mul: 4 },
    { name: '1/2', mul: 2 },
    { name: '1/4', mul: 1 },
    { name: '1/8', mul: 0.5 },
    { name: '1/16', mul: 0.25 },
    { name: '1/32', mul: 0.125 },
  ];

  const fmt = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${ms.toFixed(1)} ms`;
  };

  return (
    <ToolCard title="BPM ↔ Delay Time" icon="⏱">
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600 }}>BPM</label>
        <input
          type="number"
          value={bpm}
          min={1}
          max={999}
          step={0.1}
          onChange={(e) => setBpm(Number(e.target.value) || 0)}
          style={{ ...inputStyle, marginTop: 4 }}
        />
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={tableHeadStyle}>Note</th>
            <th style={tableHeadStyle}>Straight</th>
            <th style={tableHeadStyle}>Dotted</th>
            <th style={tableHeadStyle}>Triplet</th>
          </tr>
        </thead>
        <tbody>
          {NOTE_VALUES.map((nv) => (
            <tr key={nv.name}>
              <td style={tableCellStyle}>{nv.name}</td>
              <td style={tableNumStyle}>{fmt(beatMs * nv.mul)}</td>
              <td style={tableNumStyle}>{fmt(beatMs * nv.mul * 1.5)}</td>
              <td style={tableNumStyle}>{fmt(beatMs * nv.mul * (2 / 3))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ToolCard>
  );
}

// ───────────────────────────────────────────────────────────────
// Note ↔ Frequency
//
// Equal temperament. MIDI 69 = A4 = 440 Hz.
//   freq = 440 * 2^((midi - 69) / 12)
//   midi = 69 + 12 * log2(freq / 440)
// Note names use sharps in display; flat input ('Bb') is accepted.
// ───────────────────────────────────────────────────────────────

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_LETTER_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(noteStr) {
  if (!noteStr) return null;
  const m = String(noteStr).trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0;
  const octave = parseInt(m[3], 10);
  const semi = NOTE_LETTER_TO_SEMITONE[letter];
  if (semi == null) return null;
  // MIDI 0 is C-1 in the common convention used by most DAWs.
  return (octave + 1) * 12 + semi + accidental;
}
function midiToNote(midi) {
  if (!Number.isFinite(midi)) return null;
  const m = Math.round(midi);
  const name = NOTE_NAMES_SHARP[((m % 12) + 12) % 12];
  const oct = Math.floor(m / 12) - 1;
  return `${name}${oct}`;
}
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function freqToMidi(freq) {
  if (freq <= 0) return null;
  return 69 + 12 * Math.log2(freq / 440);
}

function NoteFrequency() {
  // Source of truth = the last field the user edited. We keep both
  // inputs as strings so partial typing doesn't recompute on every
  // keystroke.
  const [noteInput, setNoteInput] = useState('A4');
  const [freqInput, setFreqInput] = useState('440');
  const [centsDetuned, setCentsDetuned] = useState(0);

  const onNoteChange = (val) => {
    setNoteInput(val);
    const midi = noteToMidi(val);
    if (midi != null) {
      const freq = midiToFreq(midi);
      setFreqInput(freq.toFixed(2));
      setCentsDetuned(0);
    }
  };
  const onFreqChange = (val) => {
    setFreqInput(val);
    const num = parseFloat(val);
    if (Number.isFinite(num) && num > 0) {
      const midi = freqToMidi(num);
      const rounded = Math.round(midi);
      setNoteInput(midiToNote(rounded));
      // How many cents off from the nearest note? 100 cents = 1 semitone.
      setCentsDetuned(Math.round((midi - rounded) * 100));
    }
  };

  return (
    <ToolCard title="Note ↔ Frequency" icon="♪">
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Note</label>
          <input
            type="text"
            value={noteInput}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="A4, Bb3, F#5..."
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Frequency (Hz)</label>
          <input
            type="number"
            value={freqInput}
            min={1}
            step={0.01}
            onChange={(e) => onFreqChange(e.target.value)}
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
      </div>
      {centsDetuned !== 0 && (
        <div style={{ ...subtleText, marginTop: 8 }}>
          {centsDetuned > 0 ? '+' : ''}{centsDetuned}¢ from {noteInput}
        </div>
      )}
      <div style={{ ...subtleText, marginTop: 12, fontSize: 11 }}>
        Equal temperament · A4 = 440 Hz · C-1 = MIDI 0
      </div>
    </ToolCard>
  );
}

// ───────────────────────────────────────────────────────────────
// dB ↔ Linear Gain
// dB = 20 * log10(linear); linear = 10^(dB / 20). Voltage/amplitude
// (not power) — what we want when reading mixer faders, compressor
// thresholds, etc.
// ───────────────────────────────────────────────────────────────

function DbGain() {
  const [dbInput, setDbInput] = useState('0');
  const [linInput, setLinInput] = useState('1');

  const onDbChange = (val) => {
    setDbInput(val);
    const db = parseFloat(val);
    if (Number.isFinite(db)) {
      const lin = Math.pow(10, db / 20);
      setLinInput(lin >= 100 ? lin.toFixed(2) : lin.toFixed(4));
    }
  };
  const onLinChange = (val) => {
    setLinInput(val);
    const lin = parseFloat(val);
    if (Number.isFinite(lin) && lin > 0) {
      const db = 20 * Math.log10(lin);
      setDbInput(db.toFixed(2));
    } else if (lin === 0) {
      setDbInput('-∞');
    }
  };

  return (
    <ToolCard title="dB ↔ Linear Gain" icon="📶">
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Decibels (dB)</label>
          <input
            type="text"
            value={dbInput}
            onChange={(e) => onDbChange(e.target.value)}
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Linear</label>
          <input
            type="text"
            value={linInput}
            onChange={(e) => onLinChange(e.target.value)}
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
      </div>
      <div style={{ ...subtleText, marginTop: 12, fontSize: 11 }}>
        Voltage-domain · 0 dB = 1.0 · -6 dB ≈ 0.5 · +6 dB ≈ 2.0
      </div>
    </ToolCard>
  );
}

// ───────────────────────────────────────────────────────────────
// Pitch Shift → Tempo Coupling
// When a sample is pitched N semitones without time-correction, the
// playback rate (and therefore tempo) scales by 2^(N/12). Useful for
// figuring out target sample pitch when chopping at a different BPM.
// ───────────────────────────────────────────────────────────────

function PitchShiftTempo() {
  const [bpm, setBpm] = useState(120);
  const [semitones, setSemitones] = useState(0);

  const newBpm = bpm * Math.pow(2, semitones / 12);

  return (
    <ToolCard title="Pitch shift → Tempo" icon="↕">
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Original BPM</label>
          <input
            type="number"
            value={bpm}
            min={1}
            step={0.1}
            onChange={(e) => setBpm(Number(e.target.value) || 0)}
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>Semitones</label>
          <input
            type="number"
            value={semitones}
            min={-24}
            max={24}
            step={1}
            onChange={(e) => setSemitones(Number(e.target.value) || 0)}
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </div>
      </div>
      <div style={{ marginTop: 14, fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        New BPM: {Number.isFinite(newBpm) ? newBpm.toFixed(2) : '—'}
      </div>
      <div style={{ ...subtleText, marginTop: 4, fontSize: 11 }}>
        Without time-correction · same formula as varispeed
      </div>
    </ToolCard>
  );
}

// ───────────────────────────────────────────────────────────────
// Camelot Wheel
//
// DJ-style harmonic-mixing reference. The wheel maps musical keys to a
// number (1-12) and a letter (A = minor, B = major). Compatible keys
// for mixing/layering from any position {N}{L}:
//   • {N}{!L}        — relative minor/major switch (energy boost)
//   • {N+1}{L}       — perfect 5th up (energy raise)
//   • {N-1}{L}       — perfect 4th up (energy drop)
//
// We render the 12×2 grid (numbers down, A/B across) and let the user
// click any cell to highlight that key and its three compatible
// neighbors. No state persists — purely a visual reference.
// ───────────────────────────────────────────────────────────────

const CAMELOT_MAP = {
  '1A':  'A♭ minor',  '1B':  'B major',
  '2A':  'E♭ minor',  '2B':  'F♯ major',
  '3A':  'B♭ minor',  '3B':  'D♭ major',
  '4A':  'F minor',   '4B':  'A♭ major',
  '5A':  'C minor',   '5B':  'E♭ major',
  '6A':  'G minor',   '6B':  'B♭ major',
  '7A':  'D minor',   '7B':  'F major',
  '8A':  'A minor',   '8B':  'C major',
  '9A':  'E minor',   '9B':  'G major',
  '10A': 'B minor',   '10B': 'D major',
  '11A': 'F♯ minor',  '11B': 'A major',
  '12A': 'C♯ minor',  '12B': 'E major',
};

function compatibleKeys(code) {
  if (!code) return new Set();
  const num = parseInt(code, 10);
  const letter = code.slice(-1);
  const otherLetter = letter === 'A' ? 'B' : 'A';
  const next = num === 12 ? 1 : num + 1;
  const prev = num === 1 ? 12 : num - 1;
  return new Set([`${num}${otherLetter}`, `${next}${letter}`, `${prev}${letter}`]);
}

function CamelotWheel() {
  const [selected, setSelected] = useState(null);
  const compats = useMemo(() => compatibleKeys(selected), [selected]);

  return (
    <ToolCard title="Camelot Wheel" icon="◎" wide>
      <div style={{ ...subtleText, marginBottom: 12 }}>
        Click a key to highlight harmonically compatible mixing partners.
        Letter = mode (A = minor · B = major). Compatible neighbors are
        same number-other letter (relative mode) and ±1 step same letter
        (perfect 5th/4th).
      </div>
      <div style={camelotGridStyle}>
        {/* Header row */}
        <div style={{ ...camelotCellStyle, ...camelotHeaderStyle }} />
        <div style={{ ...camelotCellStyle, ...camelotHeaderStyle }}>A (minor)</div>
        <div style={{ ...camelotCellStyle, ...camelotHeaderStyle }}>B (major)</div>

        {Array.from({ length: 12 }, (_, i) => i + 1).map((num) => {
          const aCode = `${num}A`;
          const bCode = `${num}B`;
          const aIsSel = selected === aCode;
          const bIsSel = selected === bCode;
          const aIsCompat = compats.has(aCode);
          const bIsCompat = compats.has(bCode);
          return (
            <React.Fragment key={num}>
              <div style={{ ...camelotCellStyle, ...camelotHeaderStyle, fontWeight: 700 }}>{num}</div>
              <CamelotKey
                code={aCode}
                label={CAMELOT_MAP[aCode]}
                selected={aIsSel}
                compat={aIsCompat}
                onClick={() => setSelected(aIsSel ? null : aCode)}
              />
              <CamelotKey
                code={bCode}
                label={CAMELOT_MAP[bCode]}
                selected={bIsSel}
                compat={bIsCompat}
                onClick={() => setSelected(bIsSel ? null : bCode)}
              />
            </React.Fragment>
          );
        })}
      </div>
    </ToolCard>
  );
}

function CamelotKey({ code, label, selected, compat, onClick }) {
  const bg = selected
    ? 'var(--accent, #6ec1ff)'
    : compat
      ? 'var(--success-bg, rgba(76, 192, 96, 0.22))'
      : 'transparent';
  const color = selected
    ? '#0a0d12'
    : compat
      ? 'var(--success, #4cc060)'
      : 'inherit';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...camelotCellStyle,
        background: bg,
        color,
        cursor: 'pointer',
        fontWeight: selected || compat ? 600 : 500,
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        transition: 'background 120ms, color 120ms',
      }}
      title={`${code} · ${label}`}
    >
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, opacity: 0.7 }}>{code}</span>
      <span style={{ marginLeft: 8 }}>{label}</span>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────
// Shared layout helpers
// ───────────────────────────────────────────────────────────────

function ToolCard({ title, icon, children, wide }) {
  const [hover, setHover] = useState(false);
  return (
    <section
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...cardStyle,
        gridColumn: wide ? '1 / -1' : 'auto',
        borderColor: hover ? 'color-mix(in srgb, var(--accent) 38%, var(--line))' : cardStyle.border ? undefined : 'var(--line, rgba(255,255,255,0.08))',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hover
          ? '0 6px 20px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06), inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)'
          : '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'transform 140ms ease, box-shadow 160ms ease, border-color 160ms ease',
      }}
    >
      <header style={cardHeaderStyle}>
        {icon && <span style={cardIconStyle} aria-hidden="true">{icon}</span>}
        <h3 style={cardTitleStyle}>{title}</h3>
      </header>
      {children}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────

// Full-page tab layout — matches ProjectsView / DealsView pattern.
const pageStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
  padding: '32px 32px 80px',
};
const containerStyle = { maxWidth: 1100, margin: '0 auto' };
const headerStyle = { marginBottom: 28 };
const eyebrowStyle = {
  fontSize: 11,
  letterSpacing: '0.18em',
  fontWeight: 600,
  color: 'var(--accent)',
  marginBottom: 6,
  opacity: 0.85,
};
const titleStyle = { margin: '0 0 6px 0', fontSize: 30, fontWeight: 700, letterSpacing: '-0.01em' };
const subtleText = { fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: 0, maxWidth: 640 };

const sectionHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 28,
  marginBottom: 14,
};
const sectionHeaderLine = {
  flex: '0 0 24px',
  height: 1,
  background: 'var(--line, rgba(255,255,255,0.12))',
};
const sectionHeaderText = {
  fontSize: 11,
  letterSpacing: '0.16em',
  fontWeight: 600,
  textTransform: 'uppercase',
  opacity: 0.7,
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 18,
};
const cardStyle = {
  padding: '18px 18px 16px',
  borderRadius: 12,
  border: '1px solid var(--line, rgba(255,255,255,0.08))',
  background: 'var(--bg-2, rgba(255,255,255,0.03))',
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  display: 'flex',
  flexDirection: 'column',
};
const cardHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: '0 0 14px 0',
};
const cardIconStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  color: 'var(--accent)',
  fontSize: 14,
  fontWeight: 700,
  flexShrink: 0,
};
const cardTitleStyle = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--muted, rgba(255,255,255,0.7))',
};
const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  fontSize: 14,
  background: 'var(--bg-1, rgba(0,0,0,0.18))',
  color: 'inherit',
  border: '1px solid var(--line, rgba(255,255,255,0.12))',
  borderRadius: 8,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  fontVariantNumeric: 'tabular-nums',
};
const tapButtonStyle = {
  width: 112,
  height: 112,
  marginTop: 18,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--accent, #6ec1ff)',
  color: '#fff',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '3px',
  cursor: 'pointer',
  boxShadow: '0 4px 16px color-mix(in srgb, var(--accent) 35%, transparent), 0 1px 3px rgba(0,0,0,0.15)',
  transition: 'transform 80ms ease, box-shadow 120ms ease',
};
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 };
const tableHeadStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  fontWeight: 600,
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  opacity: 0.6,
  borderBottom: '1px solid var(--line, rgba(255,255,255,0.1))',
};
const tableCellStyle = { padding: '8px 10px', fontWeight: 600 };
const tableNumStyle = {
  padding: '8px 10px',
  textAlign: 'left',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--muted, rgba(255,255,255,0.75))',
};
const camelotGridStyle = {
  display: 'grid',
  gridTemplateColumns: '50px 1fr 1fr',
  gap: 3,
  marginTop: 6,
};
const camelotCellStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '9px 12px',
  fontSize: 13,
  borderRadius: 6,
};
const camelotHeaderStyle = {
  background: 'transparent',
  border: 'none',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  opacity: 0.6,
  fontWeight: 600,
};
