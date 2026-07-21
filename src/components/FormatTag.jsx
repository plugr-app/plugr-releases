import React from 'react';

// Renders a plugin's format(s). Most plugins are a single format (VST3, AU,
// …). Waves plugins are installed as one payload loaded by shared shells, so
// they're genuinely available in several formats at once (item.formats) —
// those show as one combined tag listing the real formats, never a synthetic
// "Waves" format. `variant` picks the base class: 'text' (card / detail art)
// or 'pill' (list view).
export default function FormatTag({ item, variant = 'text' }) {
  const base = variant === 'pill' ? 'fmt-pill' : 'fmt-text';
  const fmts = (item && item.formats && item.formats.length) ? item.formats : [item && item.format].filter(Boolean);
  if (fmts.length === 0) return null;
  if (fmts.length === 1) {
    return <span className={`${base} fmt-${String(fmts[0]).toLowerCase()}`}>{fmts[0]}</span>;
  }
  return (
    <span className={`${base} fmt-multi`} title={`Available as ${fmts.join(', ')}`}>
      {fmts.join(' · ')}
    </span>
  );
}
