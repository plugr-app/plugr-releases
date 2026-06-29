import React, { useState, useEffect } from 'react';
import LicenseSection from './LicenseSection.jsx';

// In-app help. Tabs: License, Preferences, Updates, Locations, Sync, Tips, About.
// Plain language, examples, no jargon assumed.

export default function HelpDialog({
  onClose, openExternal, onShowTutorial, initialTab = 'updates',
  customFolders, onAddCustomFolder, onRemoveCustomFolder,
  api, pushToast,
  defaultTabPref, onDefaultTabPrefChange,
  // License tab plumbing — fed by App.jsx so this dialog stays a
  // pure renderer of state (no IPC of its own beyond LicenseSection).
  entitlements, onEntitlementsChanged, onOpenUpgrade,
}) {
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Help">
      <div className="help-modal">
        <button className="tutorial-close" onClick={onClose} aria-label="Close help">×</button>

        <div className="help-tabs">
          {/* License tab is first since it's the most-visited setting for
           *  paid users (and the most relevant action for trial users). */}
          <button className={tab === 'license' ? 'active' : ''} onClick={() => setTab('license')}>License</button>
          <button className={tab === 'preferences' ? 'active' : ''} onClick={() => setTab('preferences')}>Preferences</button>
          <button className={tab === 'updates' ? 'active' : ''} onClick={() => setTab('updates')}>How to add an update source</button>
          <button className={tab === 'locations' ? 'active' : ''} onClick={() => setTab('locations')}>Library locations</button>
          <button className={tab === 'sync' ? 'active' : ''} onClick={() => setTab('sync')}>iCloud sync</button>
          <button className={tab === 'tips' ? 'active' : ''} onClick={() => setTab('tips')}>Tips & shortcuts</button>
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>About</button>
        </div>

        <div className="help-body">
          {tab === 'license' && (
            <LicenseSection
              api={api}
              entitlements={entitlements}
              onChanged={onEntitlementsChanged}
              onUpgrade={onOpenUpgrade}
              pushToast={pushToast}
            />
          )}
          {tab === 'preferences' && (
            <PreferencesTab
              defaultTabPref={defaultTabPref}
              onDefaultTabPrefChange={onDefaultTabPrefChange}
              api={api}
              pushToast={pushToast}
            />
          )}
          {tab === 'updates' && <UpdatesTab openExternal={openExternal} />}
          {tab === 'locations' && (
            <LocationsTab
              customFolders={customFolders}
              onAdd={onAddCustomFolder}
              onRemove={onRemoveCustomFolder}
            />
          )}
          {tab === 'sync' && <SyncTab api={api} pushToast={pushToast} />}
          {tab === 'tips' && <TipsTab onShowTutorial={onShowTutorial} />}
          {tab === 'about' && <AboutTab />}
        </div>

        <div className="help-footer">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Preferences — default-tab choice + support actions + diagnostics.
// Three sections separated by short headings; layout stays inside a
// single .help-prose container so all settings are scrollable together.
function PreferencesTab({ defaultTabPref, onDefaultTabPrefChange, currencyPref, onCurrencyPrefChange, api, pushToast }) {
  const options = [
    { id: 'library',  label: 'Plugins & Apps',
      hint: 'Always open the software organizer when Plugr launches (Default)' },
    { id: 'projects', label: 'Projects',
      hint: 'Always open the DAW project organizer' },
    { id: 'deals',    label: 'Deals',
      hint: 'Always open the deals feed' },
    { id: 'tools',    label: 'Tools',
      hint: 'Always open the producer tools (tap tempo, BPM ↔ delay, Camelot wheel, etc.)' },
    { id: 'remember', label: 'Remember last opened',
      hint: 'Reopen whichever tab was active when you last quit' },
  ];
  const current = defaultTabPref || 'library';

  // Load support config + click counts + dismissed count on mount.
  // All come from main (cheap IPCs), none hot enough to need polling.
  const [supportConfig, setSupportConfig] = useState({ supportUrl: null, bugReportEnabled: false, isDevMode: false });
  const [clickCounts, setClickCounts] = useState({});
  const [dismissedCount, setDismissedCount] = useState(0);
  const reloadCacheCounts = React.useCallback(() => {
    if (!api || !api.loadCache) return;
    api.loadCache().then((res) => {
      if (res && res.ok && res.data) {
        if (res.data.clickCounts) setClickCounts(res.data.clickCounts);
        const dd = res.data.dismissedDeals || {};
        setDismissedCount(Object.keys(dd).length);
      }
    }).catch(() => {});
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    if (api && api.getSupportConfig) {
      api.getSupportConfig().then((res) => {
        if (!cancelled && res && res.ok) {
          setSupportConfig({
            supportUrl: res.supportUrl,
            bugReportEnabled: res.bugReportEnabled,
            isDevMode: !!res.isDevMode,
          });
        }
      }).catch(() => {});
    }
    reloadCacheCounts();
    return () => { cancelled = true; };
  }, [api, reloadCacheCounts]);

  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="help-prose">
      <h3>Default tab on launch</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Which tab Plugr opens to when it starts up.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {options.map((o) => (
          <label key={o.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name="defaultTab"
              value={o.id}
              checked={current === o.id}
              onChange={() => onDefaultTabPrefChange && onDefaultTabPrefChange(o.id)}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{o.label}</span>
              <span style={{ display: 'block', fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                {o.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      {/* Currency ───────────────────────────────────────────────── */}
      <h3 style={{ marginTop: 28 }}>Currency</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        How prices on the Deals tab are displayed. Conversions are approximate — actual checkout price is shown on the vendor's page.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {[
          { id: 'USD', label: '$ USD' },
          { id: 'EUR', label: '€ EUR' },
          { id: 'GBP', label: '£ GBP' },
          { id: 'JPY', label: '¥ JPY' },
        ].map((o) => {
          const active = (currencyPref || 'USD') === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onCurrencyPrefChange && onCurrencyPrefChange(o.id)}
              style={{
                fontSize: 13,
                padding: '6px 14px',
                borderRadius: 999,
                border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                background: active ? 'var(--accent, #6ec1ff)' : 'transparent',
                color: active ? '#0a0d12' : 'inherit',
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      {/* Background & startup ──────────────────────────────────── */}
      <BackgroundModeSection api={api} pushToast={pushToast} />

      {/* Support section ────────────────────────────────────────── */}
      <h3 style={{ marginTop: 28 }}>Support</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Need help? Visit the support site or send a bug report straight from Plugr.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <button
          className="btn"
          disabled={!supportConfig.supportUrl}
          title={supportConfig.supportUrl || 'Support site URL not configured yet'}
          onClick={() => {
            if (supportConfig.supportUrl && api.openExternal) api.openExternal(supportConfig.supportUrl);
          }}
        >
          Visit support site
        </button>
        <button
          className="btn"
          disabled={!supportConfig.bugReportEnabled}
          title={supportConfig.bugReportEnabled ? '' : 'Bug report form not configured yet'}
          onClick={() => setShowBugReport(true)}
        >
          Report a bug
        </button>
      </div>
      {(!supportConfig.supportUrl && !supportConfig.bugReportEnabled) && (
        <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8, fontStyle: 'italic' }}>
          Both are disabled because they’re not configured yet — set them up in
          electron/lib/supportConfig.cjs.
        </p>
      )}

      {/* Hidden deals ───────────────────────────────────────────── */}
      <h3 style={{ marginTop: 28 }}>Hidden deals</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        {dismissedCount === 0
          ? 'You haven’t hidden any deals. Click the × on any deal card to hide it.'
          : `You’ve hidden ${dismissedCount} deal${dismissedCount === 1 ? '' : 's'}. They won’t appear in any section.`}
      </p>
      {dismissedCount > 0 && (
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (api && api.clearDismissedDeals) {
              await api.clearDismissedDeals();
              reloadCacheCounts();
              if (pushToast) pushToast({ kind: 'success', title: 'Hidden deals cleared', message: `${dismissedCount} restored.` });
            }
          }}
        >
          Show hidden deals again
        </button>
      )}

      {/* Diagnostics — DEV-ONLY. Hidden in packaged builds so end users
       *  don't see internal affiliate-click metrics. The click counter
       *  itself still runs (data lives in cache.clickCounts) so we
       *  retain the diagnostic capability for future debugging. */}
      {supportConfig.isDevMode && (
        <>
          <h3 style={{ marginTop: 28 }}>Diagnostics <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 400, letterSpacing: '1px', marginLeft: 6 }}>DEV ONLY</span></h3>
          <p style={{ fontSize: 13, opacity: 0.8 }}>
            Plugr counts every outbound deal click locally. Useful for comparing against
            what your affiliate dashboard reports — if numbers differ, the gap is
            affiliate-network deduplication or blocked tracking pixels, not Plugr.
          </p>
          <ClickCountsTable clickCounts={clickCounts} />
        </>
      )}

      {showBugReport && (
        <BugReportDialog
          onClose={() => setShowBugReport(false)}
          api={api}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

function ClickCountsTable({ clickCounts }) {
  const entries = Object.entries(clickCounts || {});
  if (entries.length === 0) {
    return (
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8, fontStyle: 'italic' }}>
        No deal clicks recorded yet. Click any deal in the Deals tab to start counting.
      </p>
    );
  }
  return (
    <table style={{ marginTop: 12, fontSize: 12, borderCollapse: 'collapse', width: '100%', maxWidth: 420 }}>
      <thead>
        <tr style={{ textAlign: 'left', opacity: 0.7 }}>
          <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>Source</th>
          <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))', textAlign: 'right' }}>Last 30 days</th>
          <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))', textAlign: 'right' }}>All time</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([source, data]) => (
          <tr key={source}>
            <td style={{ padding: '6px 8px' }}>{source}</td>
            <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {Array.isArray(data.last30Days) ? data.last30Days.length : 0}
            </td>
            <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
              {data.total || 0}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// In-help bug report form. Submit goes through api.submitBugReport
// which posts to the configured Google Form. Anonymous diagnostic
// context (app version, OS, library size, project count) is attached
// in main; we show the user what will be sent so it's transparent.
function BugReportDialog({ onClose, api, pushToast }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const canSubmit = title.trim().length >= 3 && description.trim().length >= 10 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await api.submitBugReport({
        title: title.trim(),
        description: description.trim(),
        stepsToReproduce: stepsToReproduce.trim(),
        email: email.trim(),
      });
      if (res && res.ok) {
        setSubmitted(true);
        if (pushToast) pushToast({ kind: 'success', title: 'Bug report sent', message: 'Thanks — we’ll take a look.' });
        setTimeout(onClose, 1500);
      } else {
        if (pushToast) pushToast({ kind: 'error', title: 'Couldn’t send report', message: (res && res.error) || 'Unknown error' });
      }
    } catch (err) {
      if (pushToast) pushToast({ kind: 'error', title: 'Couldn’t send report', message: String(err && err.message || err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="Report a bug" onClick={onClose}>
      <div className="help-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <button className="tutorial-close" onClick={onClose} aria-label="Close">×</button>
        <div style={{ padding: 24 }}>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>Report a bug</h2>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            We auto-attach your app version, OS, and library size (no plugin names,
            no file paths) so reports arrive with reproducible context.
          </p>

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginTop: 16, marginBottom: 4 }}>
            Title <span style={{ color: 'var(--accent, #6ec1ff)' }}>*</span>
          </label>
          <input
            type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Brief summary of the issue"
            style={inputStyle}
            disabled={submitting || submitted}
          />

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>
            What happened? <span style={{ color: 'var(--accent, #6ec1ff)' }}>*</span>
          </label>
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="What did you expect to happen, and what actually happened?"
            rows={5} style={{ ...inputStyle, resize: 'vertical' }}
            disabled={submitting || submitted}
          />
          <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4, marginBottom: 0, lineHeight: 1.45 }}>
            Got a screenshot or recording? Upload it to Dropbox, iCloud, or imgur and paste the link above.
          </p>

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>
            Steps to reproduce (optional)
          </label>
          <textarea
            value={stepsToReproduce} onChange={(e) => setStepsToReproduce(e.target.value)}
            placeholder="1. Open Plugr&#10;2. Click X&#10;3. ..."
            rows={3} style={{ ...inputStyle, resize: 'vertical' }}
            disabled={submitting || submitted}
          />

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginTop: 12, marginBottom: 4 }}>
            Email (optional, for follow-up)
          </label>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={inputStyle}
            disabled={submitting || submitted}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
            <button
              className="btn"
              onClick={submit}
              disabled={!canSubmit || submitted}
              style={{ background: 'var(--accent, #6ec1ff)', color: '#0a0d12', fontWeight: 600 }}
            >
              {submitted ? 'Sent ✓' : submitting ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  background: 'var(--card-bg, rgba(255,255,255,0.04))',
  color: 'inherit',
  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
  borderRadius: 6,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

// Background-mode section: two related toggles. "Run in menu bar"
// keeps Plugr alive in the macOS menu bar after the window is closed
// so deal-alert notifications still fire; "Launch at login" registers
// Plugr as a macOS login item. Both default OFF — surprise background
// processes are a bad first impression.
function BackgroundModeSection({ api, pushToast }) {
  const [state, setState] = React.useState({ runInMenuBar: false, launchAtLogin: false });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    if (api && api.getBackgroundMode) {
      api.getBackgroundMode().then((res) => {
        if (cancelled || !res || !res.ok) return;
        setState({
          runInMenuBar:  !!res.runInMenuBar,
          launchAtLogin: !!res.launchAtLogin,
        });
      }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, [api]);

  const apply = async (patch) => {
    if (!api || !api.setBackgroundMode) return;
    // Optimistic — flip the checkbox immediately so the click feels
    // instant; reconcile from the server response in case main
    // refused the patch (e.g. on a platform without login-item API).
    setState((prev) => ({ ...prev, ...patch }));
    try {
      const res = await api.setBackgroundMode(patch);
      if (res && res.ok) {
        setState({
          runInMenuBar:  !!res.runInMenuBar,
          launchAtLogin: !!res.launchAtLogin,
        });
        if (pushToast) {
          if (patch.runInMenuBar === true) {
            pushToast({ kind: 'info', message: 'Plugr will keep running in the menu bar when you close the window.', durationMs: 5500 });
          } else if (patch.runInMenuBar === false) {
            pushToast({ kind: 'info', message: 'Plugr will quit when you close the window.', durationMs: 4500 });
          }
          if (patch.launchAtLogin === true) {
            pushToast({ kind: 'info', message: 'Plugr will launch automatically when you log in.', durationMs: 4500 });
          } else if (patch.launchAtLogin === false) {
            pushToast({ kind: 'info', message: 'Plugr will no longer launch at login.', durationMs: 4000 });
          }
        }
      }
    } catch { /* tolerate — the optimistic flip already reflects intent */ }
  };

  return (
    <>
      <h3 style={{ marginTop: 28 }}>Background &amp; startup</h3>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Optional — let Plugr stick around to send you deal alerts even when its window is closed.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.runInMenuBar}
            disabled={loading}
            onChange={(e) => apply({ runInMenuBar: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Run in menu bar</span>
            <span style={{ display: 'block', fontSize: 12, opacity: 0.65, marginTop: 2 }}>
              Closing the Plugr window hides it to a small icon in the macOS menu bar. Deal alerts keep working. Pick Quit Plugr from the menu bar icon to fully shut down.
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.launchAtLogin}
            disabled={loading}
            onChange={(e) => apply({ launchAtLogin: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Launch Plugr at login</span>
            <span style={{ display: 'block', fontSize: 12, opacity: 0.65, marginTop: 2 }}>
              macOS starts Plugr automatically when you log in. Pairs well with "Run in menu bar" so deal alerts are always live without thinking about it.
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

function LocationsTab({ customFolders, onAdd, onRemove }) {
  const folders = Array.isArray(customFolders) ? customFolders : [];
  const DEFAULTS = [
    { fmt: 'VST3', paths: ['/Library/Audio/Plug-Ins/VST3', '~/Library/Audio/Plug-Ins/VST3'] },
    { fmt: 'AU', paths: ['/Library/Audio/Plug-Ins/Components', '~/Library/Audio/Plug-Ins/Components'] },
    { fmt: 'VST2', paths: ['/Library/Audio/Plug-Ins/VST', '~/Library/Audio/Plug-Ins/VST'] },
    { fmt: 'AAX', paths: ['/Library/Application Support/Avid/Audio/Plug-Ins'] },
    { fmt: 'CLAP', paths: ['/Library/Audio/Plug-Ins/CLAP', '~/Library/Audio/Plug-Ins/CLAP'] },
    { fmt: 'Apps', paths: ['/Applications', '~/Applications'] },
  ];

  return (
    <div className="help-prose">
      <h2>Where Plugr scans</h2>
      <p>
        By default, Plugr looks in the standard macOS plugin folders and your Applications
        folders. If you keep plugins on an external drive or in a non-default location, add
        those folders below — Plugr will include them on every scan.
      </p>

      <h3>Default scan locations</h3>
      <ul className="loc-list">
        {DEFAULTS.map((d) => (
          <li key={d.fmt}>
            <strong>{d.fmt}:</strong>{' '}
            {d.paths.map((p, i) => (
              <span key={i}><code>{p}</code>{i < d.paths.length - 1 ? ', ' : ''}</span>
            ))}
          </li>
        ))}
      </ul>

      <h3>Your custom folders</h3>
      {folders.length === 0 ? (
        <p className="muted">No custom folders yet. Click below to add one.</p>
      ) : (
        <ul className="loc-custom-list">
          {folders.map((p) => (
            <li key={p}>
              <code>{p}</code>
              <button className="link-btn muted" onClick={() => onRemove && onRemove(p)}>remove</button>
            </li>
          ))}
        </ul>
      )}
      <button className="btn primary" onClick={() => onAdd && onAdd()}>+ Add folder…</button>
      <p className="muted" style={{ marginTop: 12 }}>
        After adding or removing folders, click <strong>Scan Library</strong> in the toolbar to
        refresh.
      </p>
    </div>
  );
}

function UpdatesTab({ openExternal }) {
  // Old long-form regex walkthrough lives in a collapsible Advanced
  // section. 95% of users never need to touch this; the auto-discover
  // and "type the version number" flows handle their case in one
  // click each.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <div className="help-prose">
      <h2>Teaching Plugr where to find an update</h2>
      <p>
        When a plugin shows <span className="tut-pill no-source">No source</span>, that just means
        Plugr hasn't been told yet where on the developer's website to look for new versions.
        Different developers post version info in different places, so there's no single magic URL
        that works for everyone — but in most cases, Plugr can figure it out for you in one click.
        Once it's set up once, it'll always know.
      </p>

      <h3>Try it on every plugin at once</h3>
      <p>
        Click <em>⚡ Find missing sources</em> in the sidebar's Update status section. Plugr
        will visit each developer's homepage in parallel and try to figure out where to look
        automatically. Most known developers resolve in one pass; the rest you can fix one at
        a time below.
      </p>

      <h3>Fix one plugin at a time</h3>
      <p>
        Open any No-source plugin and click <strong>Find update source</strong> in the detail
        panel on the right. Plugr quietly visits the developer's website, hunts for your plugin's
        name on the page, and looks for a version number near it. If it finds one, you'll see a
        suggestion to confirm — give it about ten seconds.
      </p>

      <h3>Plugr couldn't find the version? Just type it in</h3>
      <p>
        If Plugr found the right page but couldn't spot the version number on it, you'll get a
        prompt asking <em>"What's the latest version?"</em> Type what the page says (e.g.{' '}
        <code>3.24</code> or <code>2.4.1</code>) and Plugr will work out the search pattern by
        itself — no regex needed. It'll then re-check the page to confirm it picks up the same
        number you typed.
      </p>
      <p className="muted">
        From then on, every time you Check for Plugin Updates, Plugr re-visits that same page and pulls
        the current version using the same pattern. If the developer keeps the page format
        consistent — and most do — it'll catch new releases automatically.
      </p>

      <h3>What if the developer's site is behind a login?</h3>
      <p>
        Plugr can't sign in to user portals like Native Access or Waves Central. If a plugin's
        only update info lives behind a login, use the companion app instead — Plugr's{' '}
        <strong>"Open Native Access"</strong> / <strong>"Open Waves Central"</strong> button takes
        you straight there. Plugr can't tell you whether an update is available in that case, but
        it can take you one click closer.
      </p>

      <h3>Still not working? Try advanced mode</h3>
      <p>
        For sites that load content with JavaScript after the page renders, or where the version
        appears in a context Plugr can't parse, you can edit the underlying URL + search pattern
        by hand. This is the same flow Plugr uses internally — you're just writing it directly.
      </p>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => setAdvancedOpen((v) => !v)}
        style={{ marginTop: '4px' }}
      >
        {advancedOpen ? '▲ Hide advanced mode' : '▼ Show advanced mode'}
      </button>

      {advancedOpen && (
        <div style={{ marginTop: '16px', paddingLeft: '16px', borderLeft: '3px solid var(--line, rgba(127,127,127,0.25))' }}>
          <h4>Editing the search pattern by hand</h4>
          <p>
            Open any plugin's <em>update source</em> editor (in its detail panel) to see the URL
            and pattern. You can also edit them in the bundled <em>developerRegistry.json</em>{' '}
            (Library → Reveal Registry File in Finder) — handy when you want to add a new entry
            for a developer who isn't there yet.
          </p>
          <p>
            The pattern is a <strong>regular expression</strong> with one capture group around the
            version number. Plugr matches it against the page text and returns whatever the
            parentheses caught. Almost every pattern is one of these two shapes:
          </p>
          <ul>
            <li><code>Pro-Q 3 v(\d+\.\d+\.\d+)</code> — strict three-part version like <code>3.24.5</code></li>
            <li><code>Pro-Q 3 v(\d+\.\d+(?:\.\d+)?)</code> — handles both <code>3.24</code> and <code>3.24.5</code> (usually the safer pick)</li>
          </ul>
          <p>To adapt one to a different plugin:</p>
          <ul>
            <li>Replace <code>Pro-Q 3</code> with the plugin name as it appears on the page.</li>
            <li>Replace the <code>v</code> with whatever appears right before the version (might be{' '}
              <code>v</code>, <code>version</code>, or nothing — match exactly what's there).
            </li>
            <li>Leave the <code>(\d+\.\d+(?:\.\d+)?)</code> part alone — that's the version capture group.</li>
          </ul>

          <h4>The bits inside the pattern, explained</h4>
          <ul>
            <li><code>\d</code> matches any digit (0–9). <code>\d+</code> matches one or more digits in a row.</li>
            <li><code>\.</code> matches a literal period. (A plain <code>.</code> is a wildcard, so we escape it.)</li>
            <li><code>(...)</code> is the capture group — Plugr returns whatever's inside.</li>
            <li><code>(?:...)?</code> is an optional non-capturing group — "this part may or may not be there."</li>
          </ul>

          <h4>Editing the registry file</h4>
          <p>
            From the Library menu choose <em>Reveal Registry File in Finder</em>, open the file in
            any text editor, find your developer (or add a new entry under <code>developers</code>),
            and paste in the URL and pattern under <code>productMatchers</code>:
          </p>
          <pre className="help-code">{`"FabFilter": {
  "homepage": "https://www.fabfilter.com",
  "identifierPrefix": ["com.fabfilter."],
  "productMatchers": {
    "Pro-Q 3": {
      "category": "Effect",
      "subcategory": "EQ",
      "updateUrl": "https://www.fabfilter.com/products/pro-q-3-equalizer-plug-in",
      "versionRegex": "Pro-Q 3 v(\\\\d+\\\\.\\\\d+(?:\\\\.\\\\d+)?)"
    }
  }
}`}</pre>
          <p>Save the file. Restart Plugr. Click <strong>Check for Plugin Updates</strong> again.</p>

          <h4>Testing a pattern</h4>
          <p>
            The easiest way to test is at{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); openExternal('https://regex101.com'); }}>regex101.com</a>.
            Set the flavor to "JavaScript" (top-left dropdown), paste your pattern in the top box,
            and paste a snippet of the page text in the bottom box. If the version number gets
            highlighted, the pattern works.
          </p>
        </div>
      )}
    </div>
  );
}

function TipsTab({ onShowTutorial }) {
  return (
    <div className="help-prose">
      <h2>Tips & shortcuts</h2>
      <ul>
        <li>Click any column header in list view to sort. Click again to reverse.</li>
        <li>Click the ★ on any card or list row to favorite it.</li>
        <li>The detail panel's <em>Edit</em> links let you override category and developer; your edits stick across rescans, and across devices (if you have iCloud sync turned on).</li>
        <li>Add multiple categories to one plugin (multi-effects, hybrid synths, etc.) via <em>Category → + add another</em>.</li>
        <li>Use the <em>toggles at the top of the sidebar</em> to see and clear active filters at a glance.</li>
        <li><kbd>⌘F</kbd> focuses the search field.</li>
        <li><kbd>⌘R</kbd> rescans the library.</li>
        <li><kbd>⌘,</kbd> opens this help dialog.</li>
      </ul>

      <h3>Colored dots in list view</h3>
      <p>Each plugin has a small colored dot next to its name in list view. The color tells you the category at a glance (also visible on hover):</p>
      {/* Each legend entry renders its actual category dot color so the
       *  text isn't talking about color in the abstract — the reader
       *  sees the exact dot they'll see in the library list view. The
       *  inline style references the same CSS variables the list view
       *  reads, so the colors stay in sync with whatever theme is on. */}
      <div className="dot-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
        {[
          { label: 'Effect',                color: 'var(--cat-effect-color, var(--cat-effect-grad, #2d7eba))' },
          { label: 'Instrument',            color: 'var(--cat-instrument-color, var(--cat-instrument-grad, #8a51d4))' },
          { label: 'MIDI',                  color: 'var(--cat-midi-color, var(--cat-midi-grad, #c47a32))' },
          { label: 'Application',           color: 'var(--cat-application-color, var(--cat-application-grad, #389878))' },
          { label: 'Other / Uncategorized', color: 'var(--cat-other-color, var(--cat-other-grad, #6e7484))' },
        ].map((cat) => (
          <div
            key={cat.label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 12px',
              borderRadius: '999px',
              background: 'var(--bg-2)',
              border: '1px solid var(--line, rgba(127,127,127,0.18))',
              fontSize: '12.5px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: cat.color,
                flex: '0 0 auto',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
              }}
            />
            {cat.label}
          </div>
        ))}
      </div>

      <p style={{ marginTop: 20 }}>Want to revisit the welcome tutorial?</p>
      <button className="btn primary" onClick={onShowTutorial}>Show tutorial</button>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="help-prose">
      <h2>About Plugr</h2>
      <p>
        Plugr is a labor of love built by me, Josh — a lifelong music production nerd and
        unapologetic plugin hoarder. After years of searching for a better way to organize
        my tools, I set out to build the solution I always wished existed: a place where every
        plugin, app, and project is easy to find and manage. The goal is simple — spend less
        time troubleshooting, updating, and digging through folders, and more time making music.
      </p>
      <p>
        My aim is to make Plugr the most useful DAW companion app on the Mac. Every feature
        is in here because I wanted it for my own studio, and thought you might too. If
        something's missing or wrong, the feedback loop is short — there's a "Find update
        source" flow inside every no-source plugin, an editable category and developer for
        every item, and a one-click way to share findings with everyone else using Plugr.
      </p>
      <p className="muted">
        macOS only. Reads from your standard plugin folders and your /Applications
        directory. Never modifies plugins on its own — the most destructive thing
        Plugr can do is move a file to your Trash, and only with confirmation.
      </p>
      <p>Built with Electron + React. Runs entirely on your machine; no telemetry, no accounts.</p>
    </div>
  );
}

// iCloud sync — toggle moves Plugr's library cache + project store
// between Application Support and iCloud Drive. When on, any other
// Mac signed into the same iCloud account that runs Plugr picks up
// the same favorites / tags / notes / update sources / project
// annotations automatically. Library SCAN results sync too, but
// each Mac re-scans on launch so the active library list reflects
// what's actually installed on that machine.
function SyncTab({ api, pushToast }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  // Pull current status whenever the tab mounts so the toggle reflects
  // what's actually on disk, not a stale React state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getSyncStatus();
        if (!cancelled && res && res.ok) setStatus(res);
      } catch { /* tolerate */ }
    })();
    return () => { cancelled = true; };
  }, [api]);

  async function toggle() {
    if (!status || busy) return;
    const target = !status.enabled;
    if (target && !status.available) {
      pushToast && pushToast({
        kind: 'error',
        title: 'iCloud Drive is off',
        message: 'Turn on iCloud Drive in System Settings → Apple Account → iCloud, then try again.',
      });
      return;
    }
    setBusy(true);
    try {
      const res = await api.setSyncEnabled(target);
      if (res && res.ok) {
        setStatus({ ...status, enabled: res.enabled, currentPath: res.currentPath || status.currentPath });
        pushToast && pushToast({
          kind: 'success',
          title: res.enabled ? 'iCloud sync enabled' : 'iCloud sync disabled',
          message: res.enabled
            ? 'Your library + project data is now in iCloud Drive. Other Macs signed into the same iCloud account will pick it up after a moment.'
            : 'Your library + project data is back in Application Support (this Mac only).',
          durationMs: 8000,
        });
      } else {
        pushToast && pushToast({
          kind: 'error',
          title: "Couldn't change sync setting",
          message: (res && res.error) || 'Unknown error.',
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="help-tab">
      <h3>iCloud sync</h3>
      <p>
        With this on, your favorites, tags, notes, custom categories, custom developer names,
        saved update sources, project annotations (ratings, statuses, tags, notes, key overrides),
        and preferences all sync between your Macs through iCloud Drive — no account, no server,
        no fees beyond what you already pay Apple for iCloud.
      </p>

      <div style={{
        margin: '14px 0',
        padding: '12px 14px',
        borderRadius: '8px',
        border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
        background: 'var(--input-bg, rgba(255,255,255,0.03))',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '2px' }}>
              {status && status.enabled ? 'Syncing via iCloud' : 'Not syncing'}
            </div>
            <div style={{ fontSize: '11px', opacity: 0.6 }}>
              {!status
                ? 'Checking…'
                : !status.available
                  ? 'iCloud Drive is not enabled on this Mac. Turn it on in System Settings → Apple Account → iCloud.'
                  : status.enabled
                    ? 'Data folder: ~/Library/Mobile Documents/com~apple~CloudDocs/Plugr'
                    : 'Data folder: ~/Library/Application Support/plugr'}
            </div>
          </div>
          <button
            className={status && status.enabled ? 'btn' : 'btn primary'}
            onClick={toggle}
            disabled={!status || busy || (!status.enabled && !status.available)}
            style={{ flex: '0 0 auto' }}
          >
            {busy ? 'Working…' : status && status.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>

      <h4>What syncs</h4>
      <ul>
        <li>Favorites, hidden plugins, custom developer/category names</li>
        <li>Plugin notes, tags</li>
        <li>Saved update sources, Discover results</li>
        <li>Custom companion-app mappings, custom scan folders</li>
        <li>Project library: tags, notes, ratings, statuses, bounce overrides, key overrides</li>
        <li>Preferences: theme, sort, view, column widths, audio volume</li>
      </ul>

      <h4>What doesn't sync</h4>
      <ul>
        <li>Scan results — each Mac scans its own plugin folders fresh.</li>
        <li>Update-check timestamps — each Mac checks on its own schedule.</li>
        <li>Waveform thumbnails — those rebuild from the audio files, which are local.</li>
      </ul>

      <h4>What happens if my plugin sets differ between Macs</h4>
      <p>
        Personalization is keyed by plugin path. So a note you added on FabFilter Pro-Q 3
        at <code>/Library/Audio/Plug-Ins/VST3/</code> appears on any other Mac that has
        the same plugin in the same location. If a Mac doesn't have that plugin installed,
        the personalization sits dormant and reappears the moment you install it there.
        No conflicts, no errors.
      </p>

      <h4>Conflicts</h4>
      <p>
        If you edit Plugr on two Macs simultaneously, the most-recently-saved change wins
        (timestamps live in the cache file). For mission-critical state, export a backup
        first via <strong>File → Library → Export Backup…</strong> — that gives you a
        manual restore point.
      </p>
    </div>
  );
}
