import React, { useMemo, useState } from 'react';

// Hand-rolled SVG charts for the Projects page. Three views:
//   - TopPluginsChart: horizontal bar chart of the N most-used plugins.
//   - CategoryDonut:   donut chart of plugin INSTANCES by category.
//   - TopDevelopersChart: horizontal bar chart of top developers by
//     total plugin instances summed across every scanned project.
//
// Why hand-rolled? Adding recharts (or any chart lib) would pull a
// few hundred KB into the renderer bundle and we only need three
// chart shapes. SVG primitives + a memo'd data prep step are plenty.

// Themed palette derived from existing CSS variables so the charts
// inherit whatever DAW theme the user has active. Falls back to
// brand-neutral defaults so we still render in light/dark/system.
// When a project references a plugin we can't find in the user's
// library, see if we can still attribute it to a developer by name
// alone. This handles wrappers/shells that DAWs record by their host
// name rather than the actual plugin name, hiding their real vendor.
//
// Today this only covers Waves (every Waves plugin loads through a
// shared WaveShell host, so .als / .logicx / .flp files all show
// "WaveShell" instead of e.g. "RVerb"). Easy to extend later if we
// find other hosts behaving the same way.
function guessDeveloperFromRef(ref) {
  const nm = String(ref && (ref.name || ref.identifier) || '').toLowerCase();
  if (!nm) return null;
  if (nm.startsWith('waveshell') || nm.includes('waveshell')) return 'Waves';
  return null;
}

// Project plugin references can never be standalone /Applications items.
// Filter them out before building the lookup so a project ref to "Massive"
// matches the Massive VST plugin, not /Applications/Massive.app — which
// would mis-bucket plugin instances under the Application category and
// give the wrong developer attribution.
function pluginsOnly(libraryItems) {
  if (!Array.isArray(libraryItems)) return [];
  return libraryItems.filter((it) => {
    const cat = String(it && it.category || '').toLowerCase();
    if (cat === 'application' || cat === 'daw') return false;
    const fmt = String(it && it.format || '').toLowerCase();
    if (fmt === 'app') return false;
    return true;
  });
}

const PALETTE = [
  'var(--accent, #6ec1ff)',
  'var(--cat-effect-color, #ff8a65)',
  'var(--cat-instrument-color, #ba68c8)',
  'var(--cat-midi-color, #4db6ac)',
  'var(--cat-application-color, #ffd54f)',
  'var(--cat-other-color, #90a4ae)',
  '#f06292',
  '#7986cb',
  '#aed581',
  '#fff176',
];

function ChartShell({ title, subtitle, children, footer, height = 280 }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--panel-bg, rgba(255,255,255,0.03))',
        border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
        borderRadius: '8px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ marginBottom: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '0.2px' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: '11px', opacity: 0.6, marginTop: '2px' }}>{subtitle}</div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: height, display: 'flex', alignItems: 'stretch' }}>
        {children}
      </div>
      {footer && (
        <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// Small clickable explainer rendered beneath Developer and Category
// charts to surface the "couldn't attribute" instance count without
// polluting the main chart. Clicking it pipes through the same
// onSelect that the chart rows use, so the project list below
// filters to projects with un-attributable plugin refs.
function UnattributedFooter({ count, onSelect, selected }) {
  if (!count || count <= 0) return null;
  const handleClick = onSelect ? () => onSelect() : null;
  const RowEl = handleClick ? 'button' : 'div';
  return (
    <RowEl
      onClick={handleClick}
      title={handleClick ? 'Click to see the projects that reference these plugins' : undefined}
      style={{
        all: 'unset',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        cursor: handleClick ? 'pointer' : 'default',
        padding: '2px 4px',
        borderRadius: '4px',
        background: selected ? 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)' : 'transparent',
        transition: 'background 120ms ease',
      }}
    >
      <div style={{ fontSize: '11px', opacity: 0.7, lineHeight: 1.4 }}>
        Plus <strong style={{ opacity: 1 }}>{count.toLocaleString()}</strong> instances Plugr couldn't attribute — usually plugins referenced by projects but not currently installed on this Mac.
      </div>
    </RowEl>
  );
}

/**
 * Horizontal bar list. Generic — used for plugins and developers.
 * Bars are scaled to the largest entry. Names are truncated if too
 * long for the row; the full text lives in the title attribute.
 *
 * `totalDenominator`, when provided, shows each row's value as a
 * percentage of that denominator alongside the raw count. For the
 * Most-Used-Plugins chart, the denominator is total project count
 * (so "EchoBoy: 302 (78%)" reads as "in 78% of projects"). For
 * Developers, the denominator is total plugin instances across all
 * projects (so percentages capture share-of-DAW-load).
 */
function HorizontalBars({ rows, maxRows = 20, accent, onSelect, selectedKey, totalDenominator }) {
  const visible = rows.slice(0, maxRows);
  if (visible.length === 0) {
    return <EmptyState label="Nothing to chart yet." />;
  }
  const top = visible[0].value || 1;
  const color = accent || PALETTE[0];
  // Each row is a button when onSelect is wired, so the user can click
  // to drill the project list down to that plugin / developer. A row
  // matching `selectedKey` gets a subtle highlight so the user can
  // see what's currently driving the filter without scrolling back up
  // to the chip.
  // Pick a count-column width that fits the biggest number we'll render.
  // toLocaleString() commas can push a 5-digit number to 6 chars — without
  // budgeting for that we either truncate the count or (worse) the parent
  // shows a horizontal scrollbar because the row grid overflows.
  // When percentages are enabled, the column is wider to fit "12,345 · 87%".
  const widestCount = visible.reduce((n, r) => Math.max(n, r.value || 0), 0);
  const countDigits = String(Math.round(widestCount).toLocaleString()).length;
  const hasPercent = typeof totalDenominator === 'number' && totalDenominator > 0;
  const charPx = 7.6;   // tabular-numeric at 11px renders ~7.6px per char
  const countColPx = hasPercent
    ? Math.max(78, Math.min(120, Math.ceil((countDigits + 6) * charPx)))   // " · 100%"
    : Math.max(36, Math.min(72,  Math.ceil(countDigits * charPx)));
  return (
    <div style={{
      width: '100%',
      maxWidth: '100%',
      display: 'flex', flexDirection: 'column', gap: '4px',
      overflowY: 'auto',
      // Hard-block horizontal overflow — if anything in a row exceeds
      // the inner width we'd rather ellipsize the label than push out
      // a horizontal scrollbar that ruins the whole chart's layout.
      overflowX: 'hidden',
      minWidth: 0,
    }}>
      {visible.map((row, idx) => {
        const pct = Math.max(2, (row.value / top) * 100);
        const isSelected = selectedKey != null && row.key === selectedKey;
        const RowEl = onSelect ? 'button' : 'div';
        return (
          <RowEl
            key={row.key || idx}
            title={onSelect ? `Click to filter projects by ${row.label}` : `${row.label} — ${row.value}`}
            onClick={onSelect ? () => onSelect(row) : undefined}
            style={{
              all: 'unset',
              display: 'grid',
              gridTemplateColumns: `minmax(0, 38%) minmax(0, 1fr) ${countColPx}px`,
              alignItems: 'center',
              gap: '8px',
              padding: '2px 4px',
              borderRadius: 4,
              cursor: onSelect ? 'pointer' : 'default',
              background: isSelected ? 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)' : 'transparent',
              transition: 'background 120ms ease',
              minWidth: 0,
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}
            onMouseEnter={onSelect ? (e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(127,127,127,0.08)'; } : undefined}
            onMouseLeave={onSelect ? (e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; } : undefined}
          >
            <div
              style={{
                fontSize: '11.5px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontWeight: isSelected ? 600 : 400,
              }}
            >
              {row.label}
            </div>
            <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '3px', height: '10px', position: 'relative' }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: color,
                  borderRadius: '3px',
                  transition: 'width 200ms',
                }}
              />
            </div>
            <div style={{ fontSize: '11px', opacity: 0.7, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {row.value.toLocaleString()}
              {hasPercent && (
                <span style={{ opacity: 0.55, marginLeft: 4 }}>
                  · {Math.round((row.value / totalDenominator) * 100)}%
                </span>
              )}
            </div>
          </RowEl>
        );
      })}
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5, fontSize: '12px', padding: '20px' }}>
      {label}
    </div>
  );
}

/**
 * Top plugins by project count. We use project count (number of distinct
 * projects the plugin appears in) rather than instance count, because
 * "appears in 30 different projects" tells you more about usefulness
 * than "300 instances inside one weird project full of duplicates".
 */
export function TopPluginsChart({ projectMatch, libraryItems, projects, maxRows = 15, onSelect, selectedKey }) {
  // Denominator for "% of projects" is the total number of scanned
  // projects. We accept it directly from props so this component
  // doesn't have to derive it (the parent already has the list).
  const totalProjects = Array.isArray(projects) ? projects.length : 0;
  const rows = useMemo(() => {
    if (!projectMatch || !projectMatch.mostUsed) return [];
    const byId = new Map(libraryItems.map((it) => [it.id, it]));
    const projectsByItemId = projectMatch.projectsByLibraryId || new Map();

    // De-dupe by plugin "family" — a plugin installed in multiple
    // formats (e.g. Decapitator VST3 + Decapitator AU, bx_meter VST2
    // + VST3) is one entity to the user, even though the library
    // stores each format as its own item with its own ID. We group
    // by normalized display name and union the projects across
    // formats so the count is "projects that contain ANY format of
    // this plugin" — never inflated by a project that happens to
    // have both formats loaded.
    const families = new Map();
    for (const entry of projectMatch.mostUsed) {
      const it = byId.get(entry.itemId);
      if (!it) continue;
      const label = it.name;
      const familyKey = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!familyKey) continue;
      let fam = families.get(familyKey);
      if (!fam) {
        fam = {
          familyKey,
          label,
          itemIds: [],
          projectIds: new Set(),
          bestCount: 0,
        };
        families.set(familyKey, fam);
      }
      fam.itemIds.push(entry.itemId);
      // Union the per-item project sets so the merged count is
      // distinct projects (not summed instances).
      const set = projectsByItemId.get(entry.itemId);
      if (set) for (const pid of set) fam.projectIds.add(pid);
      // Pick the format with the most projects as the label source
      // (handles the case where one format has a slightly cleaner
      // display name than the other).
      if (entry.projectCount > fam.bestCount) {
        fam.bestCount = entry.projectCount;
        fam.label = label;
      }
    }
    return [...families.values()]
      .map((f) => ({
        // `key` is what HorizontalBars uses for selection comparison,
        // and what ProjectsView uses as the chartFilter handle. The
        // normalized family name is stable across rescans (same name
        // → same key) and unique per family.
        key: f.familyKey,
        label: f.label,
        value: f.projectIds.size,
        // itemIds is the array the projectMatchesChartFilter consults
        // — any project whose plugin resolves to ANY of these ids
        // matches the filter.
        itemIds: f.itemIds,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [projectMatch, libraryItems]);
  return (
    <ChartShell
      title="Most-used plugins"
      subtitle={`How many of your projects each plugin appears in (top ${Math.min(maxRows, rows.length)}). Click any to filter.`}
    >
      <HorizontalBars
        rows={rows}
        maxRows={maxRows}
        accent={PALETTE[0]}
        onSelect={onSelect}
        selectedKey={selectedKey}
        totalDenominator={totalProjects}
      />
    </ChartShell>
  );
}

/**
 * Top developers by TOTAL instances across all projects. Using
 * instance counts here (not project counts) because the question
 * being answered is "which companies do I rely on" — a developer
 * with 10 plugins each used twice should still beat one with 1
 * plugin used 5 times.
 */
export function TopDevelopersChart({ projects, libraryItems, maxRows = 15, onSelect, selectedKey }) {
  // Denominator for "% of instances" is total plugin instances across
  // every project. Same number that drives the donut center total.
  const totalInstances = useMemo(() => {
    if (!projects) return 0;
    let n = 0;
    for (const proj of projects) {
      for (const p of (proj.plugins || [])) n += (p.count || 1);
    }
    return n;
  }, [projects]);
  const rows = useMemo(() => {
    if (!projects || projects.length === 0) return [];
    // Build name→identifier→developer lookup from the library so we can
    // attribute project plugin refs to a developer.
    const byIdent = new Map();
    const byName = new Map();
    for (const it of pluginsOnly(libraryItems)) {
      if (it.identifier) byIdent.set(String(it.identifier).toLowerCase(), it);
      const nameKey = String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, it);
    }
    const totals = new Map();   // developer → instance count
    for (const proj of projects) {
      for (const p of (proj.plugins || [])) {
        const ident = p.identifier ? String(p.identifier).toLowerCase() : null;
        const nameKey = String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const hit = (ident && byIdent.get(ident)) || byName.get(nameKey);
        const dev = hit
          ? (hit.developer || 'Unknown')
          : (guessDeveloperFromRef(p) || '(not installed)');
        totals.set(dev, (totals.get(dev) || 0) + (p.count || 1));
      }
    }
    return [...totals.entries()]
      .map(([dev, n]) => ({ key: dev, label: dev, value: n }))
      .sort((a, b) => b.value - a.value);
  }, [projects, libraryItems]);

  // Split out the synthetic "(not installed)" bucket from the chart.
  // It's not a real developer — surfacing it as the leader was both
  // misleading and crowded out the actual insight (which real
  // developers you rely on). We still show the count, but in a
  // footer beneath the chart, where clicking it drills the project
  // list down to the projects that reference unknown plugins.
  const unattributedRow = rows.find((r) => r.key === '(not installed)');
  const realRows = rows.filter((r) => r.key !== '(not installed)');
  const attributedTotal = totalInstances - (unattributedRow ? unattributedRow.value : 0);
  const unattributedSelected = selectedKey === '(not installed)';

  return (
    <ChartShell
      title="Developers you rely on"
      subtitle={`Total plugin instances across all projects (top ${Math.min(maxRows, realRows.length)}). Click any to filter.`}
      footer={(
        <UnattributedFooter
          count={unattributedRow ? unattributedRow.value : 0}
          onSelect={onSelect ? () => onSelect({ key: '(not installed)', label: '(not installed)', value: unattributedRow.value }) : null}
          selected={unattributedSelected}
        />
      )}
    >
      <HorizontalBars
        rows={realRows}
        maxRows={maxRows}
        accent={PALETTE[1]}
        onSelect={onSelect}
        selectedKey={selectedKey}
        totalDenominator={attributedTotal}
      />
    </ChartShell>
  );
}

/**
 * Category usage donut. Aggregates project plugin INSTANCES (not
 * project counts) by category — the category breakdown question is
 * about the shape of your sound design, so heavy use of one plugin
 * still pulls its category up.
 */
export function CategoryDonut({ projects, libraryItems, size = 240, onSelect, selectedKey }) {
  const data = useMemo(() => {
    if (!projects || projects.length === 0) return [];
    const byIdent = new Map();
    const byName = new Map();
    for (const it of pluginsOnly(libraryItems)) {
      if (it.identifier) byIdent.set(String(it.identifier).toLowerCase(), it);
      const k = String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (k && !byName.has(k)) byName.set(k, it);
    }
    const counts = new Map();
    for (const proj of projects) {
      for (const p of (proj.plugins || [])) {
        const ident = p.identifier ? String(p.identifier).toLowerCase() : null;
        const nameKey = String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const hit = (ident && byIdent.get(ident)) || byName.get(nameKey);
        let cat;
        if (hit) {
          cat = hit.category || 'Undefined';
        } else if (guessDeveloperFromRef(p)) {
          // We recognized the vendor (e.g. WaveShell → Waves) but
          // have no category — assume Effect since the vast majority
          // of vendor-wrapper hosts (Waves chief among them) are
          // effect-heavy.
          cat = 'Effect';
        } else {
          cat = 'Not installed';
        }
        counts.set(cat, (counts.get(cat) || 0) + (p.count || 1));
      }
    }
    return [...counts.entries()]
      .map(([cat, n]) => ({ label: cat, value: n }))
      .sort((a, b) => b.value - a.value);
  }, [projects, libraryItems]);

  // Split "Not installed" out of the donut for the same reason we
  // split "(not installed)" out of the developer chart — it isn't a
  // category, just a hole in our attribution. The count still gets
  // surfaced as a clickable footer beneath the donut.
  const unattributedSlice = data.find((d) => d.label === 'Not installed');
  const realData = data.filter((d) => d.label !== 'Not installed');
  const data_ = realData;
  const total = data_.reduce((n, d) => n + d.value, 0);
  if (total === 0) {
    return (
      <ChartShell title="Category mix" subtitle="How your projects break down by plugin category">
        <EmptyState label="Nothing to chart yet." />
      </ChartShell>
    );
  }

  // SVG donut math: each slice gets a portion of the 360° circle.
  // We use the stroke-dasharray trick on a single <circle> per slice
  // to avoid path arithmetic — each circle has the same r and is
  // rotated into its position.
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const slices = data_.map((d, i) => {
    const fraction = d.value / total;
    const length = fraction * circumference;
    const start = offset;
    offset += length;
    return {
      ...d,
      color: PALETTE[i % PALETTE.length],
      dash: `${length} ${circumference - length}`,
      offset: -start + circumference / 4,    // rotate to start at 12 o'clock
    };
  });

  // When `onSelect` is provided, each slice and each legend row becomes
  // clickable — clicking sets the chartFilter to that category so the
  // project list below drills down. A row matching `selectedKey` is
  // highlighted (matches the styling used by HorizontalBars).
  const handleSelect = onSelect ? (s) => onSelect({ label: s.label }) : null;

  // Hover state — tracked at the donut level so both the legend row
  // and the matching slice can react together (hover one, the other
  // also gets the pop / highlight, which keeps the eye anchored).
  const [hoveredLabel, setHoveredLabel] = useState(null);

  const unattributedSelected = selectedKey === 'Not installed';

  return (
    <ChartShell
      title="Category mix"
      subtitle={onSelect
        ? `How your ${total.toLocaleString()} plugin instances break down. Click a slice to filter.`
        : `How your ${total.toLocaleString()} plugin instances break down`}
      footer={(
        <UnattributedFooter
          count={unattributedSlice ? unattributedSlice.value : 0}
          onSelect={onSelect ? () => onSelect({ label: 'Not installed' }) : null}
          selected={unattributedSelected}
        />
      )}
    >
      <div style={{ display: 'flex', gap: '14px', width: '100%', alignItems: 'center', minHeight: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: '0 0 auto', overflow: 'visible' }}>
          {slices.map((s) => {
            const isSelected = selectedKey != null && s.label === selectedKey;
            const isHovered  = hoveredLabel === s.label;
            // Pop the active segment outward: hovered or selected slices
            // grow their stroke a touch, AND we translate the slice along
            // the radius vector pointing at the slice's midpoint so the
            // wedge visually detaches from the donut. The translation is
            // computed from the slice's start+length around the circle.
            // Hover/selected: just bump stroke width slightly. We used to
            // translate the slice outward (cx/cy animation) but that made
            // the hover state jumpy because the slice would slide away
            // from the cursor and the next slice would steal hover. A
            // plain stroke-width bump is much smoother.
            const liveStroke = size * (isHovered ? 0.21 : isSelected ? 0.21 : 0.18);
            return (
              <circle
                key={s.label}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={liveStroke}
                strokeDasharray={s.dash}
                strokeDashoffset={s.offset}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{
                  cursor: handleSelect ? 'pointer' : 'default',
                  opacity: selectedKey != null && !isSelected && !isHovered ? 0.4 : 1,
                  transition: 'opacity 140ms ease, stroke-width 140ms ease',
                }}
                onClick={handleSelect ? () => handleSelect(s) : undefined}
                onMouseEnter={() => setHoveredLabel(s.label)}
                onMouseLeave={() => setHoveredLabel((v) => v === s.label ? null : v)}
              >
                <title>
                  {handleSelect ? `Click to filter projects by ${s.label} — ${s.value}` : `${s.label} — ${s.value}`}
                </title>
              </circle>
            );
          })}
          {/* Total label in the donut hole */}
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={size * 0.12} fontWeight="600" fill="var(--text, currentColor)" style={{ pointerEvents: 'none' }}>
            {total.toLocaleString()}
          </text>
          <text x={cx} y={cy + size * 0.08} textAnchor="middle" fontSize={size * 0.05} opacity="0.6" fill="var(--text, currentColor)" style={{ pointerEvents: 'none' }}>
            uses
          </text>
        </svg>
        {/* Legend — each row mirrors the bar-chart click behavior so the
            user can hit either the slice or the label, whichever's closer. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, fontSize: '11.5px', overflow: 'hidden' }}>
          {slices.map((s) => {
            const isSelected = selectedKey != null && s.label === selectedKey;
            const isHovered  = hoveredLabel === s.label;
            const RowEl = handleSelect ? 'button' : 'div';
            return (
              <RowEl
                key={s.label}
                title={handleSelect ? `Click to filter projects by ${s.label}` : `${s.label} — ${s.value}`}
                onClick={handleSelect ? () => handleSelect(s) : undefined}
                onMouseEnter={() => setHoveredLabel(s.label)}
                onMouseLeave={() => setHoveredLabel((v) => v === s.label ? null : v)}
                style={{
                  all: 'unset',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '2px 4px',
                  borderRadius: 4,
                  cursor: handleSelect ? 'pointer' : 'default',
                  background: isSelected
                    ? 'color-mix(in srgb, var(--accent, #6ec1ff) 14%, transparent)'
                    : isHovered
                      ? 'rgba(127,127,127,0.08)'
                      : 'transparent',
                  transition: 'background 120ms ease',
                }}
              >
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: s.color, flex: '0 0 auto' }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSelected || isHovered ? 600 : 400 }}>{s.label}</span>
                <span style={{ opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{s.value.toLocaleString()}</span>
              </RowEl>
            );
          })}
        </div>
      </div>
    </ChartShell>
  );
}
