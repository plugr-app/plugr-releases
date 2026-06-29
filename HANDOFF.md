# Plugr — Handoff for a fresh Claude

Welcome. You're picking up Plugr from a previous Claude. This doc is the fastest path to being productive. Read it cover-to-cover before doing any work.

Last refreshed at v0.2.1 release. **Shipped in this window:** Deal Alerts (watch by plugin/dev/keyword + bell icons + "N new" badge); Menu Bar mode + launch-at-login; Tab Hiding (paid/trial only); 3-Mac unification across all paid tiers; plugr.co marketing site live; bug-report form wired to Google Forms; macOS codename in OS-version string; Trackspacer/Wavesfactory registry fix.

---

## 1. What Plugr is

A native macOS app for music producers. Built by **Josh Isaacs** (the human you'll be working with — call him Josh, not Joshua).

Scans every plugin (VST3 / VST2 / AU / AAX / CLAP) and `/Applications` app, organizes them, checks for updates, tracks which plugins he actually uses across his Ableton / Logic / FL projects, surfaces plugin deals from sale sites, and watches for sales on plugins he doesn't own yet but wants. Plus a small "Tools" tab (tap tempo, BPM↔delay calc, Camelot wheel) and "Companion Apps" tab (one-click launchers for Native Access, Waves Central, etc.).

**Tech:** Electron 31 + React + Vite. Universal binary (Apple Silicon + Intel). macOS 12+.

**Current version:** 0.2.1. Pricing tiers: $7/mo, $49/yr, $149 lifetime — all 3 Macs, all features. 14-day trial caps update checks at 100 plugins and gates bulk ops, themes, iCloud sync, library export, backup/restore.

---

## 2. Where everything lives

| Path | What it is |
|---|---|
| `~/plugr/` | The Electron app — main git repo for the app itself. |
| `~/Library/CloudStorage/GoogleDrive-info@joshisaacs.com/My Drive/Documents - Drive/Plugr/` | "Plugr" folder in Google Drive. Holds the marketing-site git repo + the website copy audit doc. |
| `~/Library/CloudStorage/.../Plugr/website/` | **plugr.co marketing site git repo** (separate from `~/plugr`). Deploys via GitHub Pages → `plugr-app/plugr.co`. |
| `~/Library/CloudStorage/.../Plugr/PLUGR-WEBSITE-COPY-AUDIT.md` | **Source of truth for ALL website copy.** When Josh edits this, you propagate changes to the HTML. When you edit HTML for any reason, you also update the audit doc. Drift = bugs. |
| `~/Library/Application Support/Plugr/library-cache.json` | Runtime cache the app writes to. Contains library, projects, deals, userOverrides, prefs, deal alerts, etc. You may NOT have direct read access to this from your sandbox — that's fine, Josh can read it for you. |
| `~/Library/CloudStorage/.../Plugr/website/assets/screenshots/` | Marketing screenshots referenced from plugr.co HTML. |

**Other key repos / accounts:**
- GitHub org: `plugr-app`
- App repo: doesn't have a public mirror; lives only at `~/plugr` (it's not on GitHub yet — only the website + releases are)
- Releases repo: `plugr-app/plugr-releases` — DMGs land here as GitHub Releases. Marketing site fetches latest via the GitHub API.
- Website repo: `plugr-app/plugr.co` — served by GitHub Pages with `CNAME` → plugr.co

---

## 3. Architecture in 60 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer (React/Vite) — src/                                    │
│   src/App.jsx is the top-level component (huge — owns most       │
│   state including library, projects, deals, dealAlerts,         │
│   entitlements, prefs, theme, hiddenTabs, newDealsCount, etc.)  │
│   Tabs: Plugins · Projects · Deals · Companion Apps · Tools     │
└─────────────────────────────────────────────────────────────────┘
                       ▲
                       │ window.pluginHub.*   (contextBridge)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Preload — electron/preload.cjs                                   │
│   Exposes a frozen API as `pluginHub` on window. Every IPC must  │
│   be declared here AND in main.cjs to be callable.               │
└─────────────────────────────────────────────────────────────────┘
                       ▲
                       │ ipcMain handlers
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Main — electron/main.cjs                                         │
│   App lifecycle, IPC handlers, scanner orchestration, tray       │
│   (menu-bar mode), background prefs, license check, deals       │
│   fetcher, project parser, cache reads/writes.                   │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼ uses helpers in
┌─────────────────────────────────────────────────────────────────┐
│ Libs — electron/lib/                                             │
│   cache.cjs               JSON cache I/O (load/save/patch)       │
│   developerRegistry.json  Curated dev metadata (126 devs, ~300+  │
│                           plugin matchers, identifier prefixes)  │
│   registryLookup.cjs      Match plugin → dev via name/id/aliases │
│   updateChecker.cjs       Fetch dev pages, regex out versions    │
│   discoverUpdateSource.cjs Auto-discover update URLs             │
│   entitlements.cjs        Free / trial / paid feature flags      │
│   licenseStore.cjs        LemonSqueezy license validation        │
│   projectParsers/         .als (Ableton) .logicx .flp           │
│   dealFetchers/           Plugin Boutique, Audio Plugin Deals    │
│   ableton parser, etc.                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Key state lives in App.jsx.** It's a single ~2000-line component. Don't be precious about that — it works. But if you add new top-level state, follow the cache-sync conventions below.

---

## 4. CRITICAL conventions that will bite you

### 4a. Adding any new top-level cache field requires THREE places

This is the bug that bites most often. When you add a new persisted field, you MUST update all three:

1. **`electron/lib/cache.cjs`** → `saveCache()` schema must serialize the field.
2. **`electron/main.cjs`** → `patchCache()` preserve-list must include the field name (otherwise it gets wiped on partial writes).
3. **`electron/main.cjs`** → `ALLOWED_PREF_KEYS` if the field is user-settable via `prefs:set`.

If you only do step 1, the field will save once and then get clobbered the next time `patchCache` runs. We've shipped this bug at least 4 times. Always grep for `ALLOWED_PREF_KEYS` and the existing preserve-list when adding state.

### 4b. The IPC bridge naming pattern

- Main: `ipcMain.handle('namespace:verb', ...)` — e.g. `'deals:setLastViewed'`, `'app:setBackgroundMode'`.
- Preload: expose as `pluginHub.namespaceVerb = (...args) => ipcRenderer.invoke('namespace:verb', ...args)` — camelCase.
- Renderer: `await window.pluginHub.namespaceVerb(...)`

Don't deviate. If you can't find an IPC you expect to exist, grep `preload.cjs` first — it's the contract.

### 4c. Format families

Plugins come in up to 5 formats (VST3, VST2, AU, AAX, CLAP) but they're often the same product. When a user sets a category, tag, or update source on ONE format, the override propagates to the whole family via `formatFamilyKey()`. Look at `electron/lib/familyKey.cjs` if you're touching anything cross-format. The family key normalizes separators and strips format suffixes from names.

### 4d. Developer registry hierarchy

When matching plugin → developer, the order is:
1. `developerByName[pluginName]` — explicit forced override (e.g. "Trackspacer" → "Wavesfactory")
2. `userOverrides[id].developer` — user-set in the app
3. Bundle-ID prefix match against `developers[*].identifierPrefix`
4. Alias match against `developerAliases` then look up by canonical name
5. Fallback: whatever's in the plugin metadata as-is

Common bug: a too-broad `identifierPrefix` entry (like `"com.w"`) catches plugins from other vendors. Always use the most specific prefix possible (e.g. `"com.wavesfactory."` with the trailing dot).

### 4e. Cache versioning

If you change the cache schema in a breaking way, bump `cache.cjs`'s `CACHE_VERSION` and add a migration. The current migration logic preserves library + updates + projects across version bumps. See task #258 for the pattern.

### 4f. Entitlements gating

Paid features check `entitlements.cjs` flags: `isPaidOrTrialing`, `unlocked`, `inTrial`, `tabVisibility`, etc. The dev build (`app.isPackaged === false`) bypasses all gates so you can develop without a license — that's deliberate, don't "fix" it.

### 4g. Don't re-render giant lists

`ProjectsView` is virtualized with `react-window` (task #357). The Plugins view uses content-aware memoization. If you touch either, run a perf test before/after — tab switches got noticeably slower a couple times when we accidentally defeated memoization.

---

## 5. Release workflow

**One command:**

```bash
cd ~/plugr
npm run release:mac
```

This runs `vite build`, then `electron-builder --mac --publish always`, which:
1. Builds the universal DMG (signed with Josh's Developer ID — `JOSHUA HOWARD ISAACS (C9G97WCSS3)`)
2. Outputs to `~/plugr/release/Plugr-<version>-universal.dmg`
3. Auto-creates a GitHub Release on `plugr-app/plugr-releases` tagged `v<version>` (from package.json)
4. Uploads the DMG as a release asset

**Plugr.co's download button fetches the latest release via the GitHub API** — no website edit needed for new releases. The `download.html` button JS looks for `*-universal.dmg`, then `*-arm64.dmg`, then any `.dmg`.

Required env: `GH_TOKEN` for the publish step. Josh has it in his shell profile (confirmed working as of 0.2.0/0.2.1 releases).

**Before releasing:**
- Bump `version` in `package.json` AND `package-lock.json`.
- Run `npm run promote-cache -- --dry-run` to see if there are developer corrections in Josh's cache that should be promoted into the bundled `developerRegistry.json`. Without `--dry-run` applies the merge. Diff and commit before release.

---

## 6. Website (plugr.co) workflow

The website is a **separate git repo** at `~/Library/CloudStorage/.../Plugr/website/` — distinct from `~/plugr`. Pages are vanilla HTML/CSS, no build step. GitHub Pages serves it.

### Editing copy

`PLUGR-WEBSITE-COPY-AUDIT.md` (in the parent Plugr folder) is the **source of truth**. Workflow:
- Josh edits the audit doc, asks you to propagate to HTML, OR
- You edit HTML for some reason, then mirror the change into the audit doc

If they drift, you'll get bitten. When in doubt, use a subagent to do a full audit doc → HTML sync (see task #440).

### Deploying

```bash
cd ~/Library/CloudStorage/GoogleDrive-info@joshisaacs.com/My\ Drive/Documents\ -\ Drive/Plugr/website
rm -f .git/HEAD.lock .git/index.lock   # Google Drive sync leaves stale lock files
git add -A
git commit -m "..."
git push
```

The `rm -f` line is REQUIRED. Google Drive cloud-sync interferes with git's lock files. If you skip it, the next git op might error "another git process seems to be running" — that's the symptom.

GitHub Pages rebuilds within a minute. Hard-refresh in Incognito to bypass browser cache.

### Pages

Top-level: `index.html`, `features.html`, `pricing.html`, `download.html`, `about.html`, `changelog.html`.  
Support: `support/index.html`, `getting-started.html`, `faq.html`, `troubleshooting.html`, `contact.html`.  
Legal: `legal/privacy.html`, `legal/eula.html`.

### Useful CSS patterns

- `.container` (1080px) / `.container-narrow` (720px) / `.container-wide` (1280px)
- `.feature-grid` = `auto-fit, minmax(280px, 1fr)` — flexible grid for arbitrary feature counts
- `.feature-grid-3` = forced 3-column. Use this for step sequences and other fixed-count layouts to avoid awkward orphans.
- `.feature-card-centered` = orphan placement utility, sits in middle column at 3-col widths
- `.pricing-grid-3` = forced 3-col for pricing tiers (Monthly / Annual / Lifetime)
- `.trial-banner` = horizontal banner above pricing cards for the trial CTA

---

## 7. Brand voice

This was established over many copy revisions. Tone:

- **Conversational, slightly self-deprecating, never corporate.** "Plugr brings every plugin, app, DAW project, and update manager on your Mac into one beautiful, searchable place" — not "Plugr is the leading solution for…"
- **Specific over abstract.** "FabFilter, Soundtoys, Plugin Alliance, Native Instruments…" — not "all major developers."
- **Honest about limits.** The website and in-app copy openly says things like "Plugr keeps an eye on the major plugin sale sites" rather than overselling. Update detection coverage is honestly described as "hundreds of developers" not "everything."
- **About-page voice** is more personal — Josh's own story (avoiding the names of competing apps).

**Specific banned phrases / names:**
- ❌ "Plugin Hub" — that's the name of a competing app. Never use in user-facing copy. The internal git repo path used to be `~/plugin-hub` but it's been migrated to `~/plugr`.
- ❌ "Vendor installers" or "vendor apps" — use **"update managers"** (this was a deliberate terminology sweep — see audit doc and CompanionAppsView.jsx).
- ❌ "Josh Howard Isaacs" or "Boulder, Colorado" — Josh's last name and location don't appear publicly anywhere. Reference him as "Josh" or "Josh Isaacs" in the about page; bio is intentionally light on PII.
- ❌ "VST Buzz" — was a deal source we used briefly, then removed. Don't add it back.

---

## 8. What never to do

1. **Never put secrets in the repo.** `.env` is gitignored. GitHub PAT, Apple app-specific passwords, LemonSqueezy keys all live in env vars only.
2. **Never commit `~/Library/Application Support/Plugr/library-cache.json` content** — it's user data, may contain library paths or personal context. (The path isn't in the repo anyway, but if Josh shares cache snippets in chat, don't paste them into files.)
3. **Never refer to the app as "Plugin Hub"** in any user-facing string.
4. **Never widen an `identifierPrefix` entry** to fewer than two segments (`com.foo.` is fine, `com.foo` is the floor, `com.f` is dangerous).
5. **Never change the cache schema without bumping `CACHE_VERSION`** — you'll silently corrupt Josh's data.
6. **Never run git push from your sandbox** — you don't have credentials. Josh pushes from his Terminal after you commit.
7. **Don't decide what's good copy alone** — Josh has strong opinions on tone and will rewrite. Present options, let him pick.

---

## 9. Pending tasks (legitimate)

From the legacy roadmap, three items remain genuinely pending:

- **#197** — Verify all three DAWs + UI (manual smoke test that Ableton/Logic/FL project parsing all still work end-to-end).
- **#254** — Manual smoke test: library + projects + audio + backup (post-release sanity sweep).
- **#270** — Package Plugr into DMG installer for studio Mac (probably resolved by 0.2.0 release; verify).

Everything else from #1 to #442 is completed. The task IDs in this conversation's history are a useful audit log if Josh asks "did we ever fix X?" — search the task list before assuming we didn't.

---

## 10. Active feature areas (as of v0.2.0)

Each of these is a sub-system you may end up working in:

- **Library scanning + categorization** — `electron/lib/scanner*.cjs`, `categorize.cjs`. Stable; mostly registry tweaks.
- **Update checking + Discover** — `updateChecker.cjs`, `discoverUpdateSource.cjs`. Complex regex / slug logic. The "shared-dev-page" detection (tasks #414–426) handles cases where one URL covers a whole catalog.
- **Projects** — `electron/lib/projectParsers/` + `src/components/ProjectsView.jsx` (virtualized w/ react-window). Tempo/key extraction from Ableton, Logic, FL.
- **Deals** — `electron/lib/dealFetchers/*.cjs` (Plugin Boutique, Audio Plugin Deals). 24h cache TTL. Currency conversion via exchange-rates module.
- **Deal Alerts** — Watch-by-plugin / developer / keyword. Native macOS notifications + 24h dedupe. Bell icons throughout the UI.
- **Companion Apps** — Card grid of update managers (Native Access, Waves Central, etc.). Real app icons via `.icns` resolution.
- **Tools** — Tap tempo, BPM↔delay, Note↔frequency, dB↔linear, Camelot wheel.
- **Menu Bar mode** — `Tray` API, `before-quit`, launch-at-login. Optional, lives quietly when window is closed.
- **Tab hiding** — Right-click any tab to hide; restore via `+` button. Paid/trial only.
- **Backup & restore** — Single-file JSON export of all overrides, tags, notes, sources, project data.
- **iCloud sync** — Optional, relocates the cache file under iCloud Drive so two Macs share it.
- **Entitlements / license** — LemonSqueezy variant IDs. Dev mode bypasses gates.
- **Support + bug reporting** — `electron/lib/supportConfig.cjs` is CONFIGURED as of 0.2.1. `SUPPORT_URL` → plugr.co/support/. `BUG_REPORT_URL` → Google Forms `/formResponse` endpoint, with 8 `entry.NNN` field IDs mapped (title, description, steps, email + 4 auto-filled diagnostics: appVersion, osVersion, pluginCount, projectCount). If Josh wants to change forms or extend fields, the workflow is: edit the Google Form → re-do the "Get pre-filled link" step with placeholder values for new fields → paste URL → I parse out the new entry IDs.
- **Friendly OS string** — `getFriendlyOSVersion()` in `electron/main.cjs` returns `macOS Tahoe 26.5.1` style strings. Uses `sw_vers -productVersion` (avoids the macOS 26 compat-shim lie that bites `app.getSystemVersion()`). Codename map covers Big Sur (11) → Tahoe (26). Add new mappings to `MACOS_CODENAMES` when a new major lands; unknown majors gracefully fall back to `macOS X.Y.Z`.

---

## 10b. What shipped in the most recent windows

**0.2.1 (the build just before this handoff):**
- Wired support config: Visit Support Site → plugr.co/support, Report a Bug → Google Form. See section 10's "Support + bug reporting" bullet for how to re-wire if the form changes.
- Added `getFriendlyOSVersion()` so bug reports include `macOS Tahoe 26.5.1` not `darwin 26.5.1`.
- Added "Got a screenshot? Upload to Dropbox/iCloud/imgur and paste the link" helper text under the bug-report description field. **No native attachment upload yet** — that's a v0.3 candidate (proposed approach: Cloudflare Worker + R2, see end of section 10).
- Fixed in-app `LicenseSection` device-count copy (was still showing the pre-unification 2/3 split).
- Fixed `.help-tabs` CSS so the absolute-positioned X (`.tutorial-close`) no longer overlaps the "About" tab — 64px right padding reserved.

**0.2.0:**
- Deal Alerts complete (watch by plugin / developer / keyword, bell icons throughout the UI, native notifications with 24h dedupe, "N new" badge on the Deals tab).
- Menu Bar mode + launch-at-login + tray + before-quit interceptor.
- Tab Hiding (paid/trial only) — right-click hides, `+` button restores.
- Trackspacer / Wavesfactory registry fix (removed overly-broad `com.w` prefix from W. A. Production; created Wavesfactory entry; added `developerByName` overrides for all 4 Trackspacer name variants).
- Pricing/UX: trial as a banner above 3-column purchase grid, all paid tiers unified at 3 Macs.
- plugr.co marketing site live and serving the latest DMG via GitHub Releases API.

## 11. Day 1 reading list for fresh Claude

In this order:

1. **This file** (you're reading it).
2. `~/plugr/README.md` — user-facing summary.
3. `~/plugr/package.json` — scripts and electron-builder config.
4. `~/plugr/TODO.md` — older notes; some still relevant.
5. `~/plugr/electron/lib/cache.cjs` — see the saveCache schema (canonical state shape).
6. `~/plugr/electron/main.cjs` — search for `ipcMain.handle` and `patchCache`.
7. `~/plugr/electron/preload.cjs` — the renderer ↔ main contract.
8. `~/plugr/src/App.jsx` — top-level state (it's long, skim it).
9. `~/Library/CloudStorage/.../Plugr/PLUGR-WEBSITE-COPY-AUDIT.md` — full website copy.
10. `~/Library/CloudStorage/.../Plugr/website/index.html` — what the homepage actually looks like.

Allow yourself a session or two of "where is X?" questions before doing destructive work.

---

## 12. How to be a good Claude on this project

- **Use the TodoList tool liberally.** Every multi-step task gets tracked. Josh likes seeing progress and the renderer makes it a nice widget.
- **Use `AskUserQuestion` for genuine design decisions** (currency list, pricing structure, layout approach). Not for things you can figure out from code or context.
- **Don't ask Josh to re-explain things from this doc.** If you need to know where X is, search the codebase first.
- **Verify after editing.** Run the file through a syntax check or actually look at the diff. Don't claim something's done if you didn't verify.
- **Be willing to push back.** Josh will sometimes ask for things that contradict earlier decisions. Politely flag the contradiction. He values that.
- **Brevity wins.** Match the tone of `README.md` and the website copy — conversational, specific, no buzzwords.
- **No emojis in code or docs** unless Josh explicitly asks.

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **Companion app / update manager** | Native Access, Waves Central, iZotope PP, Plugin Alliance Installation Manager — the apps that update certain plugins. |
| **Productmatcher** | Entry in `developerRegistry.json` mapping a plugin name to its update URL + regex. |
| **identifierPrefix** | Reverse-DNS prefix used to attribute a plugin to a developer (e.g. `com.fabfilter.`). |
| **userOverrides** | Per-plugin user edits stored in the cache (developer, category, tags, hidden, notes, update source). |
| **userRegistryAdditions** | Update sources the user saved via the Discover flow. Distinct from userOverrides. |
| **promote-cache** | The tool that merges userOverrides + userRegistryAdditions into the bundled registry for the next release. |
| **format family** | All format-variant plugins that share a name (Pro-Q 3 VST3 + Pro-Q 3 AU = one family). |
| **Sparkle appcast** | macOS app's `SUFeedURL` — Plugr reads it for apps that publish one. |
| **shared-dev-page** | A developer page that lists multiple plugins (catalog page). Detected via slug heuristics so we know to apply one URL to siblings. |

---

That's the doc. If anything in here is stale, fix it — this file is mutable.
