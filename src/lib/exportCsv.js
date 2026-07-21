// CSV exporter for the library.
//
// Takes the post-overrides item list (what the UI shows) plus the
// updates map and produces a CSV string with one row per plugin and
// one column per piece of data. Values are RFC-4180-escaped: any value
// containing a comma, a double quote, or a newline is wrapped in
// double quotes, with internal quotes doubled up.
//
// This file is pure — no Electron, no DOM, no Node-only APIs. That
// keeps it trivial to test, and lets the renderer import it directly.

/**
 * Format a byte count as a human-readable string (e.g. "12.4 MB").
 * Returns an empty string when bytes is null/undefined.
 */
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  // 1 decimal for MB+, integer for B/KB.
  const fixed = i <= 1 ? n.toFixed(0) : n.toFixed(1);
  return `${fixed} ${units[i]}`;
}

/**
 * Map an internal update status to a friendlier label so spreadsheet
 * users don't have to memorize the jargon. Unknown statuses pass
 * through unchanged.
 */
function friendlyUpdateStatus(status) {
  switch (status) {
    case 'current':       return 'Up to date';
    case 'outdated':      return 'Update available';
    case 'ahead':         return 'Ahead of published';
    case 'manual-check':  return 'Check manually';
    case 'no-source':     return 'No update source';
    case 'parse-failed':  return 'Source page changed';
    case 'error':         return 'Check failed';
    case undefined:
    case null:
    case '':              return 'Unchecked';
    default:              return status;
  }
}

/**
 * Escape a single value for CSV output. The rule (RFC 4180):
 *   - If the value contains a comma, a double-quote, a CR, or an LF,
 *     wrap the whole field in double-quotes and double up any internal
 *     double-quotes.
 *   - Booleans become "true"/"false".
 *   - null/undefined become "".
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Stable column order. Adding a column? Append to the END so existing
// downstream spreadsheets keep working.
export const COLUMNS = [
  'Name',
  'Developer',
  'Category',
  'Subcategory',
  'Extra Categories',
  'Format',
  'Installed Version',
  'Build Version',
  'Latest Version',
  'Update Status',
  'Update Status Detail',
  'Source URL',
  'Sparkle Feed',
  'macOS Compatibility',
  'macOS Compatibility Detail',
  'Minimum macOS',
  'Size (bytes)',
  'Size',
  'Bundle Identifier',
  'Path',
  'Favorite',
  'Hidden',
  'From Custom Folder',
  'Companion App',
  'Homepage',
  'Copyright',
  'Updates Checked At',
];

/**
 * Build the value array for a single item, in the same order as
 * COLUMNS above. Anything missing becomes ''.
 *
 * @param {object} item        - post-override merged item from the renderer
 * @param {object} update      - updates[item.id] or {}; may be empty
 * @param {string|null} checkedAt - global updatesCheckedAt timestamp
 */
function rowFor(item, update, checkedAt) {
  const reg = item.registry || {};
  const compat = item.osCompat || {};
  const updateUrl = (update && update.updateUrl) || reg.updateUrl || '';
  const extraCats = Array.isArray(item.extraCategories) && item.extraCategories.length
    ? item.extraCategories.join('; ')
    : '';
  return [
    item.name || '',
    item.developer || '',
    item.category || '',
    item.subcategory || '',
    extraCats,
    (item.formats && item.formats.length) ? item.formats.join(' / ') : (item.format || ''),
    item.version || '',
    item.buildVersion || '',
    (update && update.latestVersion) || '',
    friendlyUpdateStatus(update && update.status),
    (update && update.message) || '',
    updateUrl,
    item.sparkleFeedUrl || '',
    compat.status || '',
    compat.message || '',
    item.minimumSystemVersion || '',
    item.sizeBytes ?? '',
    formatBytes(item.sizeBytes),
    item.identifier || '',
    item.path || '',
    !!item.favorite,
    !!item.hidden,
    !!item.fromCustomFolder,
    reg.companionApp || '',
    reg.homepage || '',
    item.copyright || '',
    checkedAt || '',
  ];
}

/**
 * Build a full CSV from the library.
 *
 * @param {object} args
 * @param {Array}  args.items             - merged items (with overrides applied)
 * @param {object} args.updates           - id → update result map
 * @param {string} [args.checkedAt]       - global updatesCheckedAt
 * @param {boolean} [args.includeHidden]  - default false; hidden items stripped when false
 * @returns {string} CSV text including header row, CRLF-terminated lines
 */
export function buildLibraryCsv({ items, updates = {}, checkedAt = null, includeHidden = false } = {}) {
  if (!Array.isArray(items)) throw new Error('buildLibraryCsv: items must be an array');
  const rows = [];
  rows.push(COLUMNS.map(csvEscape).join(','));
  for (const it of items) {
    if (!includeHidden && it.hidden) continue;
    const upd = (updates && updates[it.id]) || null;
    const cells = rowFor(it, upd, checkedAt);
    rows.push(cells.map(csvEscape).join(','));
  }
  // CRLF line endings — Excel and Numbers both prefer this for CSV, and
  // it survives copy/paste between Mac and Windows tools.
  return rows.join('\r\n') + '\r\n';
}
