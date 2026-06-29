import React from 'react';
import { deriveUpdateStatus, companionAppDisplayName } from '../util/format.js';

const LABELS = {
  outdated: 'Update available',
  current: 'Up to date',
  ahead: 'Newer than registry',
  unknown: 'Unchecked',
  'no-source': 'No source',
  'parse-failed': 'Check failed',
  error: 'Check failed',
  managed: 'Managed',
  'manual-check': 'Check manually',
};

// Extract the leading major-version integer from a version string. Returns
// null when no leading integer can be parsed (so we don't flag bogus cases).
//   '2'         -> 2
//   '2.6.4'     -> 2
//   'v3.0.1'    -> 3
//   '1.0.5_b240508' -> 1
//   'abc'       -> null
function majorOf(v) {
  if (!v) return null;
  const m = String(v).match(/^\s*v?(\d+)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// `verbose` opts into the longer "Managed by X" / "via X" form. The
// card view stays terse ("Managed", gear icon) so cramped footers
// don't overflow; the full DetailPanel passes verbose=true because
// it has room for the full companion name and the user is clearly
// drilling in to read details.
export default function UpdateBadge({ item, update, compact = false, verbose = false }) {
  // No item provided AND no update record → legacy "no info yet" placeholder.
  if (!item && !update) {
    return <span className={`badge badge-pending ${compact ? 'compact' : ''}`}>—</span>;
  }
  const status = deriveUpdateStatus(item, update);
  const companion = companionAppDisplayName(item);

  // Pure "managed" state: no real check result, just a companion-app
  // relationship. In compact card layouts we ship just "Managed"
  // (tooltip carries the companion name). In the verbose DetailPanel
  // we have room to spell it out — "Managed by Plugin Alliance
  // Installer" — which is more informative when the user is drilling in.
  if (status === 'managed') {
    const managedLabel = verbose && companion ? `Managed by ${companion}` : 'Managed';
    return (
      <span
        className={`badge badge-managed ${compact ? 'compact' : ''}`}
        title={companion ? `Updates for this plugin are handled by ${companion}.` : 'Updates handled by a companion app.'}
      >{managedLabel}</span>
    );
  }

  // Real check result. Show the actual status as the primary badge AND,
  // if the plugin also has a companion app, append a small chip telling
  // the user where to apply the update — "best of both worlds" so we
  // never hide either piece of info.
  const label = LABELS[status] || status;
  // Detect major-version jumps (e.g. installed v2.6.4 vs latest v3.07).
  // These are almost always paid upgrades to a new product line rather
  // than a free patch — flag them visually so the user can spot the
  // difference at a glance. Heuristic: latest's major ≥ installed's + 1.
  const installedMajor = item ? majorOf(item.version) : null;
  const latestMajor = update ? majorOf(update.latestVersion) : null;
  const isMajorUpgrade = status === 'outdated' &&
    installedMajor != null && latestMajor != null && latestMajor >= installedMajor + 1;
  return (
    <span className={`badge-row ${compact ? 'compact' : ''}`}>
      <span className={`badge badge-${status} ${compact ? 'compact' : ''}`} title={(update && update.message) || label}>
        {status === 'outdated' && update && update.latestVersion ? `→ v${update.latestVersion}` : label}
      </span>
      {isMajorUpgrade && (
        <span
          className={`badge-major-chip ${compact ? 'compact' : ''}`}
          title={`Installed v${item.version} vs latest v${update.latestVersion} — major version jump, usually a paid upgrade rather than a free patch.`}
        >
          {compact ? '⇪' : 'Major upgrade'}
        </span>
      )}
      {companion && (
        // In card / list contexts (compact, terse) we ship just a gear
        // icon — long companion names blow out the footer. In the
        // verbose DetailPanel we have room to spell out "via X" since
        // the user is reading details, not scanning a grid.
        verbose ? (
          <span
            className={`badge-companion-chip ${compact ? 'compact' : ''}`}
            title={`Updates for this plugin come through ${companion}.`}
          >via {companion}</span>
        ) : (
          <span
            className={`badge-companion-chip companion-icon ${compact ? 'compact' : ''}`}
            title={`Updates for this plugin come through ${companion}.`}
            aria-label={`via ${companion}`}
          >⚙</span>
        )
      )}
    </span>
  );
}
