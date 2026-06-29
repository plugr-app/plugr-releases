import React, { useState } from 'react';
import plugrIcon from '../assets/plugr-icon.png';

// Inline mini-mockups so each tutorial step shows what it's describing,
// not just tells. The mockups read live theme variables, so they look
// correct whichever theme the user has chosen.

function MiniSidebar({ highlight }) {
  const sections = [
    { key: 'fav', label: 'Favorites' },
    { key: 'fmt', label: 'Formats' },
    { key: 'upd', label: 'Update status' },
    { key: 'cln', label: 'Cleanup' },
    { key: 'cat', label: 'Categories' },
    { key: 'dev', label: 'Developers' },
  ];
  return (
    <div className="tut-mock tut-sidebar-mock" aria-hidden="true">
      {sections.map((s) => (
        <div key={s.key} className={`tut-side-row ${highlight === s.key ? 'is-active' : ''}`}>
          <span className="tut-side-label">{s.label}</span>
          <span className="tut-side-pill" />
        </div>
      ))}
    </div>
  );
}

function MiniCardRow() {
  const cards = [
    { cat: 'effect', fmt: 'VST3', name: 'Pro-Q 3', dev: 'FabFilter' },
    { cat: 'instrument', fmt: 'AU', name: 'Serum', dev: 'Xfer' },
    { cat: 'application', fmt: 'App', name: 'Logic', dev: 'Apple' },
  ];
  return (
    <div className="tut-mock tut-cards-mock" aria-hidden="true">
      {cards.map((c, i) => (
        <div key={i} className="tut-card">
          <div className={`tut-strip cat-${c.cat}`}>
            <span className="tut-strip-fmt">{c.fmt}</span>
          </div>
          <div className="tut-card-body">
            <div className="tut-card-title">{c.name}</div>
            <div className="tut-card-meta">{c.dev}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniUpdateStatuses() {
  return (
    <div className="tut-mock tut-pills-row" aria-hidden="true">
      <span className="tut-pill outdated">Update available</span>
      <span className="tut-pill current">Up to date</span>
      <span className="tut-pill no-source">No source</span>
    </div>
  );
}

function MiniCleanup() {
  return (
    <div className="tut-mock tut-cleanup-mock" aria-hidden="true">
      <div className="tut-clean-row dup">
        <span className="tut-clean-icon">⚠</span>
        <span className="tut-clean-label">Duplicates</span>
        <span className="tut-clean-size">214 MB</span>
      </div>
      <div className="tut-clean-row old">
        <span className="tut-clean-icon">↻</span>
        <span className="tut-clean-label">Old versions</span>
        <span className="tut-clean-size">1.2 GB</span>
      </div>
    </div>
  );
}

function MiniDetailEdits() {
  return (
    <div className="tut-mock tut-detail-mock" aria-hidden="true">
      <div className="tut-detail-row">
        <div className="tut-detail-label">Category</div>
        <div className="tut-detail-value">
          <span className="tut-cat-pill">Effect / Reverb</span>
          <span className="tut-link">edit</span>
        </div>
      </div>
      <div className="tut-detail-row">
        <div className="tut-detail-label">Developer</div>
        <div className="tut-detail-value">
          <span>Valhalla DSP</span>
          <span className="tut-link">edit</span>
        </div>
      </div>
      <div className="tut-detail-row">
        <div className="tut-detail-label">Favorite</div>
        <div className="tut-detail-value"><span className="tut-star">★</span></div>
      </div>
    </div>
  );
}

function MiniThemeRow() {
  const swatches = ['dark', 'light', 'fruity', 'cubert', 'rationale', 'grim'];
  return (
    <div className="tut-mock tut-theme-mock" aria-hidden="true">
      {swatches.map((t) => (
        <div key={t} className="tut-theme-swatch" data-theme={t}>
          <div className="tut-theme-strip cat-effect" />
          <div className="tut-theme-bar" />
        </div>
      ))}
    </div>
  );
}

function MiniCompanion() {
  return (
    <div className="tut-mock tut-companion-mock" aria-hidden="true">
      <span className="tut-cta">Update available — Open Native Access</span>
    </div>
  );
}

// Small reusable visual for tutorial steps that show the top-level
// tab bar. Renders compact cards stacked so the user sees the
// breadth of Plugr at a glance.
function MiniFourTabs({ activeLabel = null, onSelect = null }) {
  const tabs = ['Plugins & Apps', 'Projects', 'Companion Apps', 'Deals', 'Tools'];
  const clickable = !!onSelect;
  return (
    <div className="tut-fourtabs-bar" role={clickable ? 'tablist' : undefined}>
      {tabs.map((label) => {
        const isActive = label === activeLabel;
        return (
          <button
            key={label}
            type="button"
            className={'tut-fourtab' + (isActive ? ' active' : '') + (clickable ? ' clickable' : '')}
            onClick={clickable ? () => onSelect(label) : undefined}
            aria-current={isActive ? 'true' : undefined}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Visual for the dedicated Companion Apps step — show a small grid of
// installer-style tiles so the user recognizes what kind of apps live
// in that tab (Native Access, Waves Central, iZotope Product Portal, etc.).
function MiniCompanionGrid() {
  const apps = [
    { name: 'Native Access', badge: '12' },
    { name: 'Waves Central', badge: '8' },
    { name: 'iZotope',       badge: '4' },
    { name: 'PA Installer',  badge: '5' },
  ];
  return (
    <div className="tut-companion-grid" aria-hidden="true">
      {apps.map((a) => (
        <div key={a.name} className="tut-companion-tile">
          <div className="tut-companion-tile-icon">{a.name.charAt(0)}</div>
          <div className="tut-companion-tile-name">{a.name}</div>
          <div className="tut-companion-tile-count">{a.badge} plugins</div>
        </div>
      ))}
    </div>
  );
}

const STEPS = [
  {
    title: 'Welcome to Plugr',
    icon: <img src={plugrIcon} alt="Plugr" className="tutorial-icon-img" />,
    isWelcome: true,
    subtitle: 'Your studio, finally in one place.',
    body: (
      <>
        <p className="tutorial-lede">Plugins, projects, companion apps, deals, and producer tools — all in one app, built for music makers on macOS.</p>
        <p className="muted">Plugr only ever <em>reads</em> from your machine. Anything destructive always asks first.</p>
      </>
    ),
  },
  {
    title: 'Browse your plugin library',
    icon: '🔎',
    visual: <MiniSidebar highlight="cat" />,
    body: (
      <>
        <p>The <strong>sidebar on the left</strong> of the Plugins & Apps tab is the main way to explore your software library. Click anything to filter:</p>
        <ul>
          <li><strong>Favorites</strong> — star anything to save it here.</li>
          <li><strong>Formats</strong> — pick which plugin types you want to see (VST3, AU, VST2, AAX, CLAP, plus apps).</li>
          <li><strong>Categories</strong> — drill into Effects → Reverb, Instruments → Synth, etc.</li>
          <li><strong>Developers</strong> — click any developer to filter to just their plugins.</li>
          <li><strong>Tags, Update status, OS compatibility, Cleanup, Hidden</strong> — additional groupings available in the sidebar.</li>
        </ul>
        <p>Search the top toolbar for anything by name. Active filters appear at the top of the sidebar — click any to clear it. You can also drag the sidebar section headers to reorder them, and toggle Categories / Developers between alphabetical and by-count with the <code>#</code> / <code>A→Z</code> button next to each section.</p>
      </>
    ),
  },
  {
    title: 'Cards, list view, and sorting',
    icon: '🗂️',
    visual: <MiniCardRow />,
    body: (
      <>
        <p>Each plugin appears as a card in grid view or a row in list view. The header strip on each card is colored by category — blue for Effects, purple for Instruments, orange for MIDI, green for Applications. The format (VST3, AU, App, etc.) is also always visible. Any tags you add and a favorite star sit on each card too.</p>
        <p>Switch between grid and list view from the toolbar. In list view, click any column header to sort, click again to reverse, and drag any column's right edge to resize it. The colored dot next to each plugin's name in list view tells you its category (effect, instrument, etc.) at a glance.</p>
      </>
    ),
  },
  {
    title: 'Customize anything',
    icon: '✏️',
    visual: <MiniDetailEdits />,
    body: (
      <>
        <p>Click any plugin or app to open its detail panel on the right. From there, you can:</p>
        <ul>
          <li>Tap the <strong>★ star</strong> to favorite it.</li>
          <li>Click <strong>edit</strong> next to Category or Developer to override what was auto-detected. Your edits stick across rescans.</li>
          <li><strong>Add tags</strong> (your own labels) and <strong>free-text notes</strong> for anything you want to remember about a plugin. Tags can be a great way to organize plugins into groups based on the way you like to use them.</li>
          <li><strong>Add multiple categories</strong> to plugins that fit more than one role (multi-effects, hybrid synths, etc.).</li>
          <li><strong>Hide a plugin/app</strong> you never use but don't want to (or can't) delete — it disappears from view but stays installed and is recoverable from the Hidden bucket in the sidebar. This is particularly helpful for uninstallers or other helper apps that may be detected by Plugr but aren't necessary to see.</li>
          <li>See the plugin's minimum supported macOS version and whether your system can run it.</li>
        </ul>
        <p>Hold ⌘ or Shift to select multiple plugins at once and edit them all together.</p>
      </>
    ),
  },
  {
    title: 'Check for updates',
    icon: '🔔',
    visual: <MiniUpdateStatuses />,
    body: (
      <>
        <p>Plugr automatically checks for updates the first time you launch each day. You can also click <strong>Check for Plugin Updates</strong> in the toolbar any time. Plugr looks up each plugin against a built-in registry of developers and their version-check pages.</p>
        <p>For each plugin you'll see one of these states:</p>
        <ul>
          <li>🟢 <strong>Up to date</strong> — nothing to do.</li>
          <li>🟠 <strong>Update available</strong> — a newer version is on the developer's site. Click the plugin to see what's new and where to get it.</li>
          <li>🔵 <strong>Open companion app</strong> — the developer ships their own installer (Native Instruments, Waves, Plugin Alliance, iZotope, Adobe, etc.) and Plugr takes you straight there.</li>
          <li>🟡 <strong>No source</strong> — Plugr doesn't know where to look yet. Open the plugin and click <strong>Find update source</strong> and Plugr will visit the developer's website and try to figure it out automatically. If that doesn't work, the Help menu has a plain-English guide for adding one manually. The more people use Plugr, the better this gets — every successful detection can be shared back into the registry for everyone else.</li>
        </ul>
      </>
    ),
  },
  {
    title: 'Free up disk space',
    icon: '🧹',
    visual: <MiniCleanup />,
    body: (
      <>
        <p>The sidebar's <strong>Cleanup</strong> section flags two kinds of waste:</p>
        <ul>
          <li><strong>Duplicates</strong> — the same plugin installed twice in the same format.</li>
          <li><strong>Old versions</strong> — an older copy hanging around alongside a newer one.</li>
        </ul>
        <p>Multi-format installs (VST3 + AU of the same plugin) are <em>not</em> flagged as duplicates.</p>
        <p>Open any plugin and click <strong>Move to Trash</strong> to remove it. It's reversible — files go to your macOS Trash, not deleted permanently. You can also do this in bulk by selecting multiple plugins at once.</p>
      </>
    ),
  },
  {
    title: 'Organize your DAW projects',
    icon: '🎚',
    body: (
      <>
        <p>Switch to the <strong>Projects</strong> tab and click <strong>+ Add folder…</strong> to point Plugr at a folder of DAW projects. It currently reads Ableton (<code>.als</code>), Logic Pro (<code>.logicx</code>), and FL Studio (<code>.flp</code>) projects and turns them into a searchable, sortable library. You can also drag an individual project into the Projects tab to scan just that one project.</p>
        <p>For each project Plugr surfaces:</p>
        <ul>
          <li><strong>Tempo and key</strong> (auto-detected from the project file), plus your own <strong>rating</strong> (A through F) and <strong>workflow status</strong> (Rough Concept, In Progress, Needs Mixing, Finished). Statuses are fully customizable and you can rename, remove, or add as you like.</li>
          <li><strong>Tags and notes</strong> — same idea as plugins, but for projects. Tags are a great way to organize your projects into groups by genre, artist project, client, or anything else you like.</li>
          <li><strong>Bounces</strong> — Plugr finds any exports in your project folder automatically. Click any to play it in-app with a scrubable waveform. If Plugr doesn't detect a bounce for the project, you can also drag in your own audio files in to attach them to the project. Compare multiple bounces to decide if you've really improved the track, or you've gone and made it worse :)</li>
          <li><strong>Every plugin each project uses</strong> — and the three charts at the top show your most-used plugins, your category mix, and which developers you actually rely on. Click any chart to drill the project list down.</li>
        </ul>
        <p>Filter by tempo range, key, rating, status, or tags from the sticky toolbar above the project list.</p>
      </>
    ),
  },
  {
    title: 'All your update managers in one place',
    icon: '🧩',
    visual: <MiniCompanionGrid />,
    body: (
      <>
        <p>Every plugin company has its own update manager these days. Native Access, Waves Central, Plugin Alliance, iZotope, Arturia, IK Multimedia — they pile up in your Applications folder and you can never remember which one to open when something needs an update.</p>
        <p>The <strong>Companion Apps</strong> tab puts them all on one screen, with a count of how many plugins each one manages so you can see which ones actually matter to your setup. When Plugr spots an update for a plugin managed by one of these apps, it puts a little badge on that tile so you know exactly where to go.</p>
        <p>One click opens the update manager. No more digging.</p>
      </>
    ),
  },
  {
    title: 'Plugr helps you avoid overpaying for plugins',
    icon: '💸',
    body: (
      <>
        <p>The <strong>Deals</strong> tab pulls live discounts from select trusted retailers like Plugin Boutique and Audio Plugin Deals — refreshed automatically every day.</p>
        <p>What makes it different from just visiting those sites yourself:</p>
        <ul>
          <li><strong>Plugr matches deals against your library</strong> — so at a glance you can see which sales are on plugins you already own (think upgrades) and plugins from developers you already trust versus ones you don't have yet.</li>
          <li><strong>Bookmark anything</strong> you want to come back to with the wishlist button.</li>
          <li><strong>Hide deals</strong> you're not interested in with the × — they won't come back to clutter the list.</li>
          <li><strong>Currency conversion</strong>, filter by source, filter by ownership, sort by discount — all in the toolbar.</li>
        </ul>
      </>
    ),
  },
  {
    title: 'Producer tools at your fingertips',
    icon: '🛠',
    body: (
      <>
        <p>The <strong>Tools</strong> tab tucks in the everyday utilities you'd usually have to open a browser tab for:</p>
        <ul>
          <li><strong>Tap tempo</strong> — tap any key in time and get a BPM reading.</li>
          <li><strong>BPM ↔ delay</strong> — convert tempo to delay times in milliseconds for any subdivision.</li>
          <li><strong>Camelot wheel</strong> — see harmonic relationships between keys for mixing and key matching.</li>
          <li>Plus a handful more. With Plugr in your Dock, you'll always have these useful tools one click away.</li>
        </ul>
      </>
    ),
  },
  {
    title: 'Make it yours',
    icon: '🎨',
    visual: <MiniThemeRow />,
    body: (
      <>
        <p>Pick a <strong>theme</strong> from the palette icon in the toolbar — choose Auto / Dark / Light, or one of the named studio palettes. Each one has its own personality, accent colors, and more.</p>
        <p>Plugr can also <strong>sync across your Macs via iCloud</strong> (Help → iCloud sync). Your favorites, tags, notes, ratings, project annotations — everything follows you between machines, for free, so long as you have iCloud set up.</p>
        <p>Open this tutorial again any time from the <strong>Help</strong> menu or the <code>?</code> button in the toolbar. The Help menu also has guides for adding update sources, library locations, tips & shortcuts, and a way to report bugs straight from the app.</p>
        <p>Have fun!</p>
      </>
    ),
  },
];

const TAB_FOR_STEP = {
  0: null, 1: 'Plugins & Apps', 2: 'Plugins & Apps', 3: 'Plugins & Apps',
  4: 'Plugins & Apps', 5: 'Plugins & Apps', 6: 'Projects',
  7: 'Companion Apps', 8: 'Deals', 9: 'Tools',
};
const TAB_FIRST_STEP = {
  'Plugins & Apps': 1, 'Projects': 6, 'Companion Apps': 7, 'Deals': 8, 'Tools': 9,
};

export default function Tutorial({ onClose, onDismissForever }) {
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;
  const cur = STEPS[step];

  function close() {
    if (dontShowAgain && onDismissForever) onDismissForever();
    onClose();
  }

  return (
    <div
      className="tutorial-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Plugr tutorial"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <div className={'tutorial-modal' + (cur.isWelcome ? ' tutorial-welcome' : '')}>
        <div className="tutorial-progress">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`tutorial-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => setStep(i)}
              role="button"
              tabIndex={0}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        <div className="tutorial-icon" aria-hidden="true">{cur.icon}</div>
        <h2 className="tutorial-title">{cur.title}</h2>
        {cur.subtitle && <p className="tutorial-subtitle">{cur.subtitle}</p>}
        {Object.prototype.hasOwnProperty.call(TAB_FOR_STEP, step) && (
          <MiniFourTabs
            activeLabel={TAB_FOR_STEP[step]}
            onSelect={(label) => {
              const target = TAB_FIRST_STEP[label];
              if (typeof target === 'number') setStep(target);
            }}
          />
        )}
        {cur.visual && <div className="tutorial-visual">{cur.visual}</div>}
        <div className="tutorial-body">{cur.body}</div>

        <div className="tutorial-footer">
          <label className="tutorial-dontshow">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            Don't show this again
          </label>
          <div className="tutorial-actions">
            {!isFirst && (
              <button className="btn" onClick={() => setStep(step - 1)}>Back</button>
            )}
            {!isLast ? (
              <>
                <button
                  className="btn ghost"
                  onClick={close}
                  style={{ WebkitAppRegion: 'no-drag', pointerEvents: 'auto' }}
                >Skip</button>
                <button
                  className="btn primary"
                  onClick={() => setStep(step + 1)}
                  style={{ WebkitAppRegion: 'no-drag', pointerEvents: 'auto' }}
                >Next</button>
              </>
            ) : (
              <button className="btn primary" onClick={close}>Get started</button>
            )}
          </div>
        </div>
        {/* Close button — last child of modal so it naturally wins
            stacking over earlier siblings. Plus isolation/z-index in CSS
            for belt-and-suspenders. */}
        <button
          className="tutorial-close"
          onClick={close}
          aria-label="Close tutorial"
          style={{ WebkitAppRegion: 'no-drag', pointerEvents: 'auto' }}
        >×</button>
      </div>
    </div>
  );
}
