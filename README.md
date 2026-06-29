# Plugr

A personal Mac app for music producers — scans, organizes, and helps update your audio plugins (VST3, AU, VST2, AAX, CLAP) and the applications you use day to day.

Built by **Josh Isaacs** — lifelong music aficionado, producer, music-tech executive, plugin hoarder, and incurable nerd — to be the most useful DAW companion app on macOS.

Built with Electron + React + Vite. macOS-only (uses `plutil` and the standard plugin folders).

## What it does

- Scans every standard plugin folder on your Mac and lists what it finds.
- Reads each plugin's `Info.plist` to pull out version, manufacturer, identifier, and (for AU plugins) the official type code.
- Auto-categorizes each plugin into a useful tree:
  - **Instrument** → Synth / Sampler / Drums / Keys / Guitar/Bass / Orchestral
  - **Effect** → EQ / Dynamics / Reverb / Delay / Modulation / Distortion / Pitch / Imaging / Utility / Creative / Multi-Effect / Undefined
  - **MIDI**
  - **Application** (your `/Applications` and `~/Applications`)
- Groups by developer.
- Checks for updates against a curated developer registry (`electron/lib/developerRegistry.json`) — 60+ developers and 250+ products seeded out of the box.
- Computes **size on disk** for every plugin/app. Total library size in the toolbar, per-item size in cards and the list view, sort-by-size to find disk hogs.
- Detects **duplicates** (same plugin + version installed twice) and **superseded versions** (an older copy hanging around next to a newer one). Multi-format installs (VST3 + AU + AAX of the same plugin) are NOT flagged — that's expected.
- **Persistent cache**: scans and update results are saved to `~/Library/Application Support/Plugr/library-cache.json` so reopening the app is instant; rescans are explicit.
- Polished dark UI with grid + list views, search, multi-axis filters (formats, categories, developers, update status, cleanup), and a detail panel that reveals each plugin in Finder, opens the developer's downloads page, and lets you jump between members of a duplicate group.

## Getting started

Requires Node.js 18+ (for the built-in `fetch`) and a Mac.

```bash
cd plugr
npm install
npm run dev      # opens the app with hot-reload
```

This starts Vite for the renderer (port 5173) and Electron pointed at it. Hit **Scan Library** in the toolbar — it will walk your plugin folders and populate the view.

To build and run a "production" version (loads the bundled HTML, no dev server):

```bash
npm run start
```

To package a `.dmg`:

```bash
npm run dist:mac
```

## Folders it scans

| Format | Path |
|---|---|
| VST3 | `/Library/Audio/Plug-Ins/VST3` and `~/Library/Audio/Plug-Ins/VST3` |
| AU | `/Library/Audio/Plug-Ins/Components` and `~/Library/Audio/Plug-Ins/Components` |
| VST2 | `/Library/Audio/Plug-Ins/VST` and `~/Library/Audio/Plug-Ins/VST` |
| AAX | `/Library/Application Support/Avid/Audio/Plug-Ins` |
| CLAP | `/Library/Audio/Plug-Ins/CLAP` and `~/Library/Audio/Plug-Ins/CLAP` |
| Apps | `/Applications` and `~/Applications` |

## How categorization works

For each item we apply, in priority order:

1. **Registry override** — explicit category from `developerRegistry.json` (e.g. _FabFilter Pro-Q 3 → Effect / EQ_).
2. **AU type code** — for `.component` plugins, the four-character `type` field tells us whether something is a music device, an effect, a MIDI processor, etc.
3. **Name heuristics** — a long list of regex rules in `electron/lib/categorize.cjs` that match common plugin names ("Diva" → Synth, "Pro-C" → Dynamics, "Decapitator" → Distortion, etc.).
4. Fallback to **Other / Uncategorized**.

You can see how each plugin was categorized in the detail panel under "Categorized via".

## How update checking works

There's no universal API for plugin versions. Plugr uses a **curated registry** approach: `electron/lib/developerRegistry.json` lists known developers along with optional per-product entries that contain an `updateUrl` and a `versionRegex`. When you click **Check for Updates**, the app fetches each unique URL once, runs the regex against the response, and compares the captured version to what you have installed (using semver-coerced comparison).

Possible per-item statuses:
- `outdated` — a newer version is available.
- `current` — you have the latest.
- `ahead` — your installed version is newer than what the page says (rare; usually a beta).
- `no-source` — no `updateUrl` configured for this product yet.
- `parse-failed` / `error` — the page was reached but the regex didn't match, or the request failed.

### Adding a developer

Open `electron/lib/developerRegistry.json` and add an entry:

```json
"My Plugin Co": {
  "homepage": "https://myplugin.co",
  "downloadsUrl": "https://myplugin.co/download",
  "identifierPrefix": ["com.myplugin."],
  "productMatchers": {
    "Crusher": {
      "category": "Effect",
      "subcategory": "Distortion",
      "updateUrl": "https://myplugin.co/products/crusher",
      "versionRegex": "Crusher\\s+v?(\\d+\\.\\d+(?:\\.\\d+)?)"
    }
  }
}
```

`identifierPrefix` is matched against `CFBundleIdentifier` (case-insensitive prefix). `productMatchers` keys are matched against the plugin's display name (substring, longest match wins). `versionRegex` should put the version in capture group 1.

The registry seeds in this repo cover ~25 popular developers (FabFilter, iZotope, Native Instruments, Waves, u-he, Xfer Records, Soundtoys, Valhalla DSP, Image-Line, Cableguys, Arturia, etc.) — extend it as you go. Updates that aren't in the registry simply show "No source" with a link to the developer's homepage.

## Architecture

```
electron/
  main.cjs              Electron main process, BrowserWindow, IPC handlers
  preload.cjs           contextBridge: scanLibrary, checkUpdates, loadCache,
                        clearCache, openInFinder, openExternal
  lib/
    plistParser.cjs     plutil-based Info.plist reader, plist-package fallback
    scanners.cjs        Walk plugin folders, normalize records, attach sizes,
                        run duplicate detection, build summary
    categorize.cjs      AU-type → category, plus name-keyword rules
    registryLookup.cjs  Match identifiers to developers, names to products
    updateChecker.cjs   Fetch+regex update detection with concurrency cap
    sizeUtil.cjs        du -sk wrapper with Node-walker fallback
    duplicates.cjs      Per-(identifier, format) grouping; flags duplicate
                        and superseded items; never flags multi-format installs
    cache.cjs           Atomic JSON cache in app.getPath('userData')
    developerRegistry.json   Curated knowledge base (60+ devs, 250+ products)

src/
  main.jsx              React entry
  App.jsx               State, filtering pipeline, scan/update orchestration,
                        cache load on mount
  index.css             Dark theme styles
  util/format.js        Renderer-side helpers: formatBytes, formatRelativeTime
  components/
    Toolbar.jsx         Search, sort, view toggle, scan/update, last-scanned
    Sidebar.jsx         Format toggles, update filter, cleanup filter,
                        category tree, developer list
    LibraryView.jsx     Grid or list of items (list adds a Size column)
    PluginCard.jsx      Card for the grid view (size + duplicate badge)
    UpdateBadge.jsx     Update status pill
    DetailPanel.jsx     Right panel with metadata, actions, duplicate-group nav
    EmptyState.jsx      First-run / no-results placeholder
```

## Limitations & next steps

- **Update accuracy depends on the registry.** Maintaining regexes against developer pages is fragile — when a site is redesigned, the regex may need updating. The infrastructure is there; coverage grows with use.
- **No installer triggering.** The app links you to each developer's downloads page; it does not download or run installers for you. (MacUpdater did, but it's a much bigger surface area to get right safely.)
- **Read-only.** Plugr never deletes or modifies bundles. The "Show in Finder" action is the only filesystem write — and it only opens Finder.
- **No Windows path support.** The folders, plist parsing, and `plutil` shell-out are macOS-specific. Adding Windows would mostly mean adding the appropriate plugin paths and a different metadata reader.
- **Sandbox.** When packaged for the App Store this would need a sandbox profile and security-scoped bookmarks. For personal use (running unpackaged or as an unsigned app) the default permissions are enough.

## License

MIT — personal use, hack on it freely.
