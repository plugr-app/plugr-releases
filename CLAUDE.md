# CLAUDE.md — Plugr project memory

**Read this file cover-to-cover before doing ANY work.** This is the single source of truth for how to work on Plugr. It supersedes the older `HANDOFF.md` (which was written at v0.2.1 and is now historical — keep it for archaeology, but this file wins on any conflict).

**This file is mutable and MUST be kept current.** At the end of every work session — after completing any feature set, fix batch, or design decision — update the "Current state", "Session log", and "Open tasks" sections of this file as part of finishing the work. Do not ask Josh for permission to update it; it's part of the job. A stale CLAUDE.md is how project knowledge dies when a chat fills up.

---

## 0. How sessions work now (READ FIRST — this changed)

The old workflow (Josh uploads files → Claude writes patch scripts → Josh pastes them into Terminal) is **dead**. It caused repeated disasters: stale file snapshots, patches written blind against old code, scripts that failed because anchors didn't match, and Josh being asked to do work he shouldn't have to do. Never go back to it.

The current workflow:

1. **Josh starts each task in the Claude desktop app with the plugr folder connected** (the folder button when starting a new task, pointed at `/Users/joshuaisaacs/plugr`). This mounts his live files.
2. **First thing in every session:** read this file, then run `git -C <plugr folder> log --oneline -15` and `git status` to see where things actually stand. Check `package.json` for the current version. Never trust your memory of the code over the code.
3. **Edit files directly** through the mounted folder. No heredoc scripts, no tarballs, no "paste this into Terminal" — ever again, unless the folder connection is genuinely unavailable AND Josh explicitly agrees.
4. **Known bridge limitation:** the device bridge cannot delete files (`rm` fails with "Operation not permitted"). To delete, `mv` into a `_to_delete/` folder inside the repo and tell Josh so he can empty it. **Git corollary:** every git op that takes a lock leaves the lock file behind. Mitigate: (a) prefix ALL read-only git commands with `GIT_OPTIONAL_LOCKS=0` (env var; stops `git status`/`diff` from creating index.lock at all); (b) after any commit, immediately `mv` the leftover `.git/*.lock` + `.git/objects/*/tmp_obj_*` into `_to_delete/` — a stale `index.lock` blocks all future git commands including Josh's.
5. The mounted folder and any cloud sandbox are **separate filesystems**. Work on Josh's files through the mount. Use the cloud sandbox only for scratch work, and never assume a file written in one place exists in the other.

**If this session does NOT have the plugr folder connected:** say so immediately, in one sentence, and ask Josh to start a new task with the folder attached. Do not improvise a patch-script workflow. Do not write code against stale copies.

---

## 1. What Plugr is

A native macOS app for music producers, built by **Josh Isaacs** (call him Josh, not Joshua). Scans every plugin (VST3 / VST2 / AU / AAX / CLAP) and `/Applications` app, organizes them, checks for updates, tracks which plugins he actually uses across Ableton / Logic / FL projects, surfaces plugin deals, watches for sales on wishlisted plugins, and includes Tools (tap tempo, BPM↔delay, Camelot wheel) and Companion Apps (launchers for Native Access, Waves Central, etc.) tabs.

**Tech:** Electron 31 + React 18 + Vite. Universal binary (Apple Silicon + Intel). macOS 12+. macOS-only.

**Pricing:** $7/mo, $49/yr, $149 lifetime — all tiers 3 Macs, all features. 14-day trial caps update checks at 100 plugins and gates bulk ops, themes, iCloud sync, library export, backup/restore. LemonSqueezy is the license backend. Dev builds (`app.isPackaged === false`) bypass all entitlement gates — deliberate, don't "fix" it.

---

## 2. Current state (as of 2026-07-12, verified against live repo)

- **Version:** **1.0.23** (package.json AND package-lock.json). **1.0.21 was RELEASED** (release:mac run by Josh, 2026-07-12). Unreleased since: 1.0.22 = KORG-AAX garbage-version fix; 1.0.23 = Application-category-leak fix + NSA registry categories. Josh batches releases — don't prompt him to release after every fix.
- **1.0.19 commit CONFIRMED landed** (`ce4574b`), plus CLAUDE.md commit (`b235b53`). Branch `main` is **14+ commits ahead of origin** — Josh pushes when ready.
- **The 1.0.20 script DID run.** Verified 2026-07-12. It was coherent, not mangled: autoUpdater error diagnostics + friendly download-failure toast; full UpdateToast rewrite (progress bar, error+Retry states); HelpDialog tab reorder + About-tab logo/version; CompanionAppsView "Check for updates" button; registry fix (Beatmaker → Splice, bogus Astra/Beatmaker Plugin Alliance entries removed); App.jsx `onEditRegistrySource`; DetailPanel partial §3 work. It left 3 bugs, **all fixed in 1.0.21**: (a) stray " · · " separator where "Wrong version?" was deleted, (b) `onCheckUpdates` never passed to CompanionAppsView so its button never rendered, (c) preload's `getVersion` had no `app:getVersion` handler in main.cjs so the About tab showed no version.
- **Update detail panel UX redesign (old §3): SHIPPED in 1.0.21.** See §3 for what was built. Everything uncommitted in the working tree = the 1.0.20 script + the 1.0.21 session changes.

### Confirmed applied in v1.0.19 (Josh confirmed: "I think it worked that time")

1. **`electron/lib/duplicates.cjs` — format-aware superseded.** Added a `newestByFormat` Map so "superseded/OLD" only fires when the SAME format has a newer version installed. AAX v1.4.6 is no longer marked OLD just because VST v1.6.6 exists — cross-format version lag is an "updates available" concern, not a duplicates concern. (This deliberately reverses the older iZotope-Neutron-VST2 rationale documented in the file's original comments.)
2. **`electron/lib/duplicates.cjs` — Mono/Stereo variants.** `groupKey()` now preserves letter-only parenthetical suffixes via `/\(([a-zA-Z][a-zA-Z\s]*)\)\s*$/`, so "Foo (Mono)" and "Foo (Stereo)" are separate groups, not false duplicates. Numeric parentheticals still get stripped by `normalizeName`.
3. **`electron/main.cjs` — trash password fix.** The `shell:trashItem` IPC handler now falls back (macOS only) to `osascript -e 'do shell script "mv -f <src> <dest>" with administrator privileges'` when `shell.trashItem` throws (EACCES on `/Library/Audio/Plug-Ins/…`). macOS caches the admin auth ~5 minutes, so bulk-trashing system plugins prompts once, not per-file. Destination is `~/.Trash/<stem>_<timestamp><ext>`; paths quoted via `JSON.stringify`.

### Applied in the session before that (v1.0.17–1.0.18 era, in Josh's live repo only)

- **`src/App.jsx` — `effectiveUpdates` useMemo** (VERIFIED 2026-07-12 against live code): applies (1) mirror-from-parent links read straight from `overrides` (not items — applyOverrides runs later in the pipeline), and (2) mark-as-current overrides. The mark-as-current logic is two-tier: **explicit** via `overrides[id].updateStatusOverride`, and **implicit** — a raw-library `superseded` item whose override has any field NOT in a benign allow-list (`favorite, hidden, developer, category, subcategory, extraCategories, notes, tags, mirrorFromId, dismissedMirrorSuggest, updateStatusOverride, acknowledgedLatestVersion`) is treated as current. `formatLagAcknowledgedAt` is deliberately NOT in the benign list — setting it is what implicitly marks the item current. `acknowledgedLatestVersion` guards against staleness: if the live `latestVersion` moved past the acknowledged one, the override stops applying.
- **`src/App.jsx` — `matchesFilters`** reads from `effectiveUpdates` (it's in the dep array) so filter buckets refresh live.
- **DetailPanel format-lag acknowledgment**: an info banner + "Mark [format] as current" button + "Undo", persisted via a `formatLagAcknowledgedAt` override. This is what "removes the OLD badge".
- **Kanban drag fix** (projects not moving between statuses until restart) — was reported and worked on; VERIFY it's actually fixed in live code before assuming.

---

## 3. SHIPPED (1.0.21) — update detail panel UX redesign

Josh's original feedback, preserved:

> "Wrong version shouldn't just mark as up to date while keeping the same detected version there."
> "Edit source basically takes you to the same options you have when you're adding a new source (manual or automatic). But when hitting 'edit source' I'd rather be shown the existing source so I can edit it, rather than having to enter something from scratch."

What was built (Josh approved both options via AskUserQuestion, 2026-07-12):

1. **Unified fix flow.** "Wrong version?" (which used to silently set `dismissedUpdateVersion` while still displaying the wrong number) and "Edit source…" are now ONE flow: a **"Wrong version or source? Fix it…"** link on the outdated status line. It opens DiscoverModal in edit mode prefilled with the current URL/regex; the modal's "Wrong version detected? Type the version you actually see" field (`reDeriveWithCorrectedVersion` → `api.deriveSourceFromVersion`) is the canonical correction path. Routing helper in DetailPanel: `handleEditSource` (user-owned source → `onEditUpdateSource`, registry source → `onEditRegistrySource`); `canEditSource` requires `reg.updateUrl` and hides for sibling-inherited sources.
2. **Unified Source row.** The four scattered muted lines ("Edit source…", "added by you ✓ · Edit · Remove", "Mirrors from X · Unlink", "Mirror from another plugin…") are now ONE row: `Source: <Plugr registry | added by you ✓ | built-in update feed (Sparkle) | mirrors ParentName>` + `Edit · Remove · Mirror from another plugin… / Unlink` as applicable. Hidden when no source (no-source card covers it) and in the companion-only case (companion banner covers it).
3. **"Ignore update" → "Ignore this update".** (Done by the 1.0.20 script.)
4. **DiscoverModal guards for registry edits:** "Remove source" footer button now only shows when `item.registryAddedByUser` (bundled entries can't be deleted, only overridden), and the edit-phase title says "Editing the update source" for registry sources vs "Editing your saved source" for user ones.
5. Legacy `dismissedUpdateVersion` overrides still render their "Undo dismiss" link — kept for users who clicked the old button.

Note: saving an edit of a REGISTRY source creates a `userRegistryAddition` override (existing data model), so after saving, the Source row flips to "added by you ✓". That's correct behavior, not a bug.

**No open feature tasks.** Next release: `npm run release:mac` at 1.0.21 whenever Josh is ready (remember `promote-cache --dry-run` first).

---

## 4. Where everything lives

| Path | What it is |
|---|---|
| `/Users/joshuaisaacs/plugr/` | The Electron app — main git repo. Connect THIS folder to each task. |
| `~/Library/CloudStorage/GoogleDrive-info@joshisaacs.com/My Drive/Documents - Drive/Plugr/` | Google Drive "Plugr" folder: marketing-site repo + website copy audit doc. |
| `.../Plugr/website/` | **plugr.co marketing site git repo** (separate repo). Deploys via GitHub Pages → `plugr-app/plugr.co`. |
| `.../Plugr/PLUGR-WEBSITE-COPY-AUDIT.md` | **Source of truth for ALL website copy.** Edits propagate both ways — HTML change requires audit-doc change and vice versa. |
| `~/Library/Application Support/Plugr/library-cache.json` | Runtime cache (library, projects, deals, userOverrides, prefs, alerts). NEVER commit its contents anywhere. |
| GitHub org `plugr-app` | `plugr-releases` (DMGs as GitHub Releases; site fetches latest via API), `plugr.co` (Pages + CNAME). App repo itself lives only at `~/plugr` unless that changed — verify. |

---

## 5. Architecture in 60 seconds

```
Renderer (React/Vite) — src/
  App.jsx: top-level ~4500-line component; owns nearly all state
  (library, updates, effectiveUpdates, overrides, registryAdditions,
  projects, deals, dealAlerts, entitlements, prefs, theme, hiddenTabs…)
  Tabs: Plugins · Projects · Deals · Companion Apps · Tools
  Key components: DetailPanel.jsx, DiscoverModal.jsx, PluginCard.jsx,
  ProjectsView.jsx (react-window virtualized), ProjectsKanban.jsx,
  UpdateBadge.jsx, BuyDialog.jsx, LicenseSection.jsx
        ▲  window.pluginHub.* (contextBridge)
        ▼
Preload — electron/preload.cjs  (the renderer↔main CONTRACT; grep here first)
        ▲  ipcMain handlers
        ▼
Main — electron/main.cjs  (lifecycle, IPC, scanner orchestration, tray,
  license check, deals fetcher, project parsers, cache I/O, trashItem)
        ▼
Libs — electron/lib/  (VERIFIED file list, 2026-07-12 deep review)
  cache.cjs                 JSON cache I/O, atomic tmp+rename writes, CACHE_VERSION (v5)
  developerRegistry.json    Curated dev metadata (~126 devs, 300+ matchers)
  registryLookup.cjs        plugin → developer/product matching
  scanners.cjs              filesystem walkers (plugin dirs + /Applications, depth-1 into non-bundle subfolders)
  categorize.cjs            category heuristics (lattice: Instrument/Effect/MIDI/Application + subcats; "Mastering" deliberately not a category)
  updateChecker.cjs         fetch pages via httpFetch, regex out versions; dedupes by updateUrl; capped concurrency
  discoverUpdateSource.cjs  auto-discover update URLs (candidate URLs → fetch → name+version proximity); 5s timeouts
  httpFetch.cjs             Electron net.request (real Chromium TLS fingerprint beats bot detection); fetch() fallback for tests
  sparkle.cjs               SUFeedURL appcast fetch+parse (most reliable source)
  duplicates.cjs            duplicate/superseded detection (format-aware post-1.0.19)
  entitlements.cjs          merges trial+license → status: trial|trial-expired|licensed|grace|grace-exceeded
  license.cjs               LemonSqueezy activate/validate/deactivate; HMAC-signed local license.json; 7-day revalidation, 30-day grace
  trial.cjs                 14-day trial; HMAC-signed start timestamp (cache-wipe-proof)
  community.cjs             community submissions (Google Form POST) + fetch additions feed (GitHub Pages)
  projectScanners/          ableton.cjs (.als = gzipped XML), logic.cjs (.logicx bundle), flstudio.cjs (.flp chunked binary), bounces.cjs (3-tier confidence)
  projectStore.cjs          projects live in their OWN file, separate write chain (cache-merge wipes bit twice)
  dealsFetcher.cjs+sources/ orchestrator + siloed scrapers: pluginBoutique.cjs, audioPluginDeals.cjs
  dealAlerts.cjs            plugin/developer/custom-keyword watches → macOS notifications
  priceHistory.cjs          rolling per-deal price snapshots (treated as user data — survives fetcher bumps)
  exchangeRates.cjs         frankfurter.app ECB rates, 24h cache, hardcoded fallback
  pluginWatcher.cjs         fs.watch on plugin dirs; debounced; clears stale outdated badges w/o rescan
  autoUpdater.cjs           electron-updater vs GitHub Releases; no-ops in dev
  backup.cjs                export/restore all user data; syncPrefs.cjs — iCloud location sidecar
  plistParser.cjs (plutil→JSON), archUtil.cjs (lipo -archs), sizeUtil.cjs (du -sk),
  waveform.cjs (afconvert→PCM peaks), affiliateConfig.cjs, supportConfig.cjs
```

**Cross-format propagation is in the RENDERER, not a lib:** `familyKeyFor()` + `applyRegistryAdditions()` in `src/App.jsx` (~line 374). Key = `developer|nameStrippedOfAllNonAlphanumerics`. There is NO `electron/lib/familyKey.cjs` — earlier versions of this doc were wrong about that (and about `licenseStore.cjs`/`projectParsers/`/`dealFetchers/` — corrected names above).

---

## 6. CRITICAL conventions that will bite you

### 6a. New top-level cache field = THREE places
1. `electron/lib/cache.cjs` → `saveCache()` schema serializes it.
2. `electron/main.cjs` → `patchCache()` preserve-list includes it (or it gets wiped on partial writes).
3. `electron/main.cjs` → `ALLOWED_PREF_KEYS` if user-settable via `prefs:set`.
This bug has shipped at least 4 times. Grep both lists every time.

### 6b. IPC naming
Main: `ipcMain.handle('namespace:verb', …)` → Preload: `pluginHub.namespaceVerb` → Renderer: `await window.pluginHub.namespaceVerb(…)`. The preload is the contract; grep it first when an IPC seems missing.

### 6c. Format families
Update-source additions propagate across a plugin's formats via `familyKeyFor()` + `applyRegistryAdditions()` in `src/App.jsx` (NOT an electron lib). Propagated items get `registryAppliedViaSibling: true` — they show the source but hide Edit/Remove (edit on the owning plugin). Touch anything cross-format → read those two functions first.

### 6d. Developer matching order
`developerByName` forced override → `userOverrides[id].developer` → bundle-ID `identifierPrefix` → alias → raw metadata. Never widen an `identifierPrefix` below two segments (`com.foo.` good; `com.f` caused the Trackspacer/W.A. Production bug).

### 6e. Cache schema changes require a `CACHE_VERSION` bump + migration.

### 6f. Duplicates semantics (post-1.0.19 — current law)
- **Family grouping: version-suffix vs model-number is decided by MAJOR-VERSION MATCH (2026-07-13, supersedes the digit-count heuristic):** `normalizeName(name, version)` in duplicates.cjs strips a trailing " V?<1-2 digits>" ONLY when the number equals `semver.coerce(version).major`. Neutron 3 (v3.x) → "neutron" groups with Neutron 4; RC 48 (v1.4.11) stays "rc 48" distinct from RC 24; SEM V2 (v2.13.2) groups with SEM V3; Pre V76 (v1.8.1) stays distinct from Pre 1973. Unknown version → keep the number. Trailing bare " V" (ARP 2600 V) always strips.
- **Same-version duplicate flags require matching bundle FILENAMES (2026-07-13):** true duplicates (same product, system + user dir) share a filename; companion variants registering the same friendly AU name from different bundles (Polyverse Gatekeeper.component vs GatekeeperMIDI.component) don't and are NOT flagged. Superseded detection ignores filenames (they change across versions).
- **"Not the same plugin? Unlink" (2026-07-13):** per-item `notDuplicate` override — applyOverrides strips `item.duplicate`; link on the cleanup card, Undo line in DetailPanel; in both benign-fields lists; main.cjs collapses falsy values. Escape hatch for product-line reboots (iZotope Trash v1.x vs Trash 2 v2.x — grouped but new product LOSES on version number; unfixable heuristically).
- **Multi-plugin shells are named honestly (2026-07-13):** an AU bundle with ≥ `SHELL_COMPONENT_THRESHOLD` (5) components keeps its on-disk bundle name — Waves WaveShell registers EVERY owned plugin as components of one bundle and used to masquerade as its alphabetically-first component ("Abbey Road Chambers (m)"), colliding across V15/V16 shells and hiding that trashing it kills every Waves plugin of that generation. FabFilter-style 2-3 component bundles keep the friendly component name.
- **Symlink/alias bundle copies collapse at scan (2026-07-13):** scanLibrary's dedupe pass resolves realpaths — installer-dropped symlinks (OpenVPN Connect) no longer produce self-duplicates; the real path wins; symlinks to targets outside scan roots survive as sole representative (external-drive workflows).
- **Packed AU versions (2026-07-12 fix):** `decodePackedAuVersion()` in plistParser.cjs — Arturia writes Apple's packed AU integer (0x10801 = 67585 = 1.8.1) into AU plist version fields, which displayed as "v67585" and read as "Newer than registry". Decoded for `.component` bundles only, in readBundleInfo + pluginWatcher. Guards: pure digits, ≥ 0x10000, major 1-99.
- **Plist version sanitation (1.0.22):** `saneVersion()` in `plistParser.cjs` — a version must START with a digit (optional "v" prefix); digit-containing is not enough (KORG AAX ships literal `KLAAXWRAPPER_M1_VERSION_STRING` placeholders, and semver.coerce extracts the "1" from "M1"). Applied in readBundleInfo (version, buildVersion, legacy AU components) and pluginWatcher. Unknown-version copies are NEVER marked superseded in duplicates.cjs (can't prove "older"), but still participate in same-format duplicate detection.
- Same plugin in multiple FORMATS = normal, never a duplicate.
- `duplicate` = 2+ copies at same version AND same format (largest size kept).
- `superseded` (OLD badge) = older version within the SAME format only. Cross-format version lag is handled by the updates system + the format-lag "Mark as current" acknowledgment, NOT by duplicates.
- Mono/Stereo (any letter-only parenthetical) variants are distinct groups.

### 6g. Update-source data model
- Bundled registry sources: `item.registry.updateUrl` + `versionRegex` (from `developerRegistry.json`).
- User-added sources: `userRegistryAdditions`, keyed by `item.identifier || item.id`, saved via `api.saveRegistryAddition(key, addition | null)` (null = delete). Marked `registryAddedByUser`; propagate to siblings (`registryAppliedViaSibling`).
- Mirror links: `overrides[childId].mirrorFromId` — child borrows parent's update status via `effectiveUpdates` in App.jsx.
- Sparkle: `item.sparkleFeedUrl`, most reliable when present.
- DiscoverModal phases: `chooser | searching | found | notfound | manual | saving | saved | sharing | error`; edit mode = `mode:'edit'` + `existingAddition` jumps straight to `found` prefilled.

### 6h-pre. Renderer data pipeline (order matters — deep-reviewed 2026-07-12)
`library.items` (raw from scan) → `applyRegistryAdditions(items, registryAdditions)` (merges user sources + sibling propagation) → `applyOverrides(items, overrides)` (favorite/hidden/developer/category/subcategory/extraCategories/notes/tags/mirrorFromId → flags like `developerOverridden`) → `displayedItems` → `matchesFilters`/`filteredItems` (reads `effectiveUpdates`, not raw `updates`). `effectiveUpdates` deliberately reads mirror links from `overrides` directly because it runs BEFORE applyOverrides in the memo graph. ~75 IPC channels; the preload exposes ~100 methods. Update-source fix flows: DiscoverModal `deriveSourceFromVersion` (`updates:deriveFromVersion`) builds a regex from a user-typed version; `updates:tryTemplate` applies a found source pattern across siblings; `updates:applySharedSource` applies a shared-dev-page URL verbatim to siblings.

### 6i-pre. Trash-adjacent gotchas found in deep review
- `.env` EXISTS in the repo folder (gitignored — never read it into chat or commit it).
- Google Drive Plugr folder root is littered with legacy paste-era `.tgz` patch bundles and `splice-fix*` folders — dead artifacts of the killed workflow. Ignore them; don't resurrect. (Ask Josh before deleting.)
- Repo has stray `# Plugr Releases` file and `FRESH_CLAUDE_FIRST_MESSAGE.md` at root — historical, harmless.

### 6h. Perf
`ProjectsView` is react-window virtualized; Plugins view uses content-aware memoization. Perf-test before/after if touched.

### 6i. Trash
`shell:trashItem` falls back to privileged osascript `mv` into `~/.Trash` on macOS EACCES (system plugin dirs). Auth caches ~5 min. Don't "simplify" this back to plain `shell.trashItem`.

---

## 7. How to work with Josh (hard rules, learned the hard way)

1. **Never ask Josh to run diagnostic commands and paste output.** Figure it out from the files. You have them mounted.
2. **Never ask Josh to do work you can do.** Minimize his required actions to approximately zero.
3. **Edit files directly.** The paste-script era is over (see §0). If you ever must hand him something to run, it's ONE self-contained block, as short as possible, no verbose comments.
4. **Assume a handed-off step happened if he doesn't respond** and moves on.
5. **`git push` is always Josh, from his Terminal.** You may `git add`/`commit` locally when asked; never push.
6. **Version bumps happen at RELEASE time, not per fix** (Josh's call, 2026-07-12 — supersedes the old auto-bump-per-feature-set rule). During dev, leave the version at the last-released number. When Josh says he's releasing: one `chore: bump vX.Y.Z` commit touching package.json + package-lock.json, then he runs release:mac. Never prompt him to release.
7. **Never hedge with "if that exists" about his own codebase.** Read the live file and KNOW. If you genuinely can't access something, say exactly that, in one sentence, with the concrete fix.
8. **Verify after editing** — read the diff, syntax-check. Never claim done without verifying.
9. **Use the task-list tool liberally**; Josh likes watching progress.
10. **Use AskUserQuestion for genuine design decisions** (like the update-panel redesign) — not for anything discoverable from code.
11. **Push back when he contradicts an earlier decision** — politely flag it; he values that.
12. **Brevity.** No corporate tone, no emoji unless he uses them first.

---

## 8. What never to do

1. **Never put secrets in the repo.** `.env` is gitignored. GitHub PAT, Apple app-specific passwords, LemonSqueezy keys live in env vars only.
2. **Never commit `library-cache.json` contents** anywhere, even snippets Josh pastes in chat.
3. **Never call the app "Plugin Hub"** in any user-facing string — competitor's name. (Internal `window.pluginHub` bridge name is legacy and fine.)
4. **Never widen an `identifierPrefix`** below two dot-segments.
5. **Never change cache schema without bumping `CACHE_VERSION`.**
6. **Never `git push` from the sandbox.**
7. **Never present copy as final** — Josh has strong tone opinions; present options.
8. **Never write patch scripts against unverified/stale file copies.** (The cardinal sin of June–July 2026.)

---

## 9. Release workflow

```bash
cd ~/plugr
npm run release:mac
```
Builds universal DMG (signed, Developer ID `JOSHUA HOWARD ISAACS (C9G97WCSS3)`, notarized, team `C9G97WCSS3`), publishes GitHub Release on `plugr-app/plugr-releases` tagged `v<version>`. Requires `GH_TOKEN` in Josh's shell env. plugr.co's download button auto-fetches the latest release — no site edit needed.

Before releasing: bump `version` in `package.json` AND `package-lock.json`; run `npm run promote-cache -- --dry-run` to preview promoting Josh's locally-discovered update sources into the bundled registry, then apply/diff/commit if good.

Dev loop: `npm run dev` (Vite on :5173 + Electron). Josh runs this himself and reports what he sees.

---

## 10. Website (plugr.co) workflow

Separate repo at `~/Library/CloudStorage/.../Plugr/website/`. Vanilla HTML/CSS, no build step, GitHub Pages.

- `PLUGR-WEBSITE-COPY-AUDIT.md` is copy source-of-truth; keep HTML and doc in sync bidirectionally.
- Deploy: `cd` into the website folder, then `rm -f .git/HEAD.lock .git/index.lock` (REQUIRED — Google Drive sync leaves stale git locks), `git add -A && git commit && git push`. Pages rebuilds in ~1 min.
- Pages (verified 2026-07-12): index / features / pricing / download / about / changelog / 404; support/{index,getting-started,faq,troubleshooting,contact}; legal/{privacy,eula,refund,terms}. Plus robots.txt, sitemap.xml, CNAME, assets/{logos,icons,screenshots}. Site repo working tree was CLEAN at last check (latest commit: "Fix Best value → Most popular on homepage").
- Homepage positioning: title "the ultimate music production companion app"; OG tagline "Built for producers who'd rather be making music." / "Every plugin you own. Every update you've missed. Every project you've built. Every tool you need. One Mac app." Pricing badge is "Most popular" (annual) — was deliberately changed FROM "Best value"; don't revert.
- CSS utilities: `.container[-narrow|-wide]`, `.feature-grid` (auto-fit), `.feature-grid-3` (forced 3-col), `.feature-card-centered`, `.pricing-grid-3`, `.trial-banner`.

---

## 11. Brand voice

Conversational, specific, honest about limits, never corporate. "Every plugin, app, DAW project, and update manager on your Mac in one beautiful, searchable place." Name real developers, not "all major vendors."

**Banned:** "Plugin Hub" (competitor). "Vendor installers/apps" → say **"update managers"**. Josh's last name + location stay out of public copy ("Josh" / "Josh Isaacs" only). "VST Buzz" (removed deal source — don't re-add).

---

## 12. Session log (newest first — APPEND HERE every session)

- **2026-07-16 (d)** — **A1AUDIO "Check failed" fixed (link-only) + found a save-verify gap.** All A1AUDIO plugins (A1StereoControl, A1TriggerGate) showed red "Check failed". Root cause (confirmed via Claude-in-Chrome): the updateUrl `a1audio.alexhilton.net/downloads` is a **JavaScript-rendered SPA** (Vite + Firebase) — raw-HTML fetch (how updateChecker works) gets only a "needs JavaScript enabled" shell with no version, so extractVersion → parse-failed → "Check failed". Rendered with JS the page shows v1.44 (= installed), so nothing was actually outdated. No stable JS-free version source exists (version is baked into a hash-named JS chunk that changes every deploy). Also A1StereoControl's stored regex was `"1.44"` — a hardcoded literal with NO capture group, broken regardless. **Fix:** made both A1AUDIO productMatchers **link-only** in `developerRegistry.json` (dropped versionRegex, kept updateUrl + added downloadUrl = same page) → updateChecker returns `manual-check` (clean clickable link, no false error). Ships next release. **Josh's follow-up (valid, deferred to a decision):** the DiscoverModal save flow should verify-on-save — test-fetch the page, and if the version can't be detected, warn + offer link-only. Current state: only the "type the version you see" manual path (`deriveSourceFromVersion`) and auto-discover verify; the found-phase `save()` and the advanced hand-typed-regex path (`saveManual` advanced) persist url+regex with NO confirming fetch, and the link-only offer only surfaces in the auto-discover `notfound` phase. Potential fix: add a verify step to `save()` (reuse `updates:check` or a new `updates:testSource`) → on no-version, show "Save as link only / Save anyway". NOT yet built — awaiting Josh's go-ahead.
- **2026-07-16 (c)** — **Update-status section de-cluttered (Josh: "tidy but keep all visible").** The outdated detail-status block showed SIX inline links, two of which — "Wrong version or source? Fix it…" and the Source-row "Edit source…" — called the identical `handleEditSource`. Removed the standalone outdated-only "Fix it…" link (the Source-row "Edit source…" is the keeper because it renders in EVERY state, not just outdated — removing that instead would've lost the ability to edit a source when up-to-date/manual-check). Lifted the two Ignore actions off the crowded version line onto their own tidy muted line BELOW the Source row; shortened "Ignore all updates" → "Ignore all" (full intent kept in the tooltip). Kept "Edit source…" verbatim (NOT shortened to "Edit…") to honor the 2026-07-12(e) decision. New layout: badge / `installed vX · latest vY` / `Source: … · Edit source… · Remove · Mirror from another plugin…` / `Ignore this update · Ignore all`. Renderer-only, DetailPanel.jsx; babel parse-verified (rendered Fix-it buttons = 0, Edit-source = 1, Ignore = 1; other grep hits are comments). Uncommitted → committing; no version bump (this lands in the NEXT release after 1.0.25, or fold in if 1.0.25 hasn't been built yet).
- **2026-07-16 (b)** — **RELEASING v1.0.25.** Josh said he's ready to release. Bumped package.json + package-lock.json (both version fields) 1.0.24 → **1.0.25** in one `chore: bump v1.0.25` commit (`86e9d74`); Josh runs `npm run release:mac` + `git push`. **Deliberately did NOT run promote-cache** — Josh's source/download-page edits live on his OTHER Mac and he's not ready to bring the cache over, so this build ships the CODE changes but no newly-promoted registry sources (fine; do a promote-cache release later per §9/§15). 1.0.25 contents = everything committed since the 1.0.24 release: orphaned-WaveShell "Safe to remove" detector; live cleanup-bucket counts (hidden-aware); link-only sources for versionless pages + optional separate download page (DiscoverModal/DetailPanel/main); downloadUrl + link-only propagation through promote-cache, registryLookup, and the community pipeline; community feed Option A wiring (form "Download page" field `entry.1633676877`, responses sheet readable, registry repo connectable). NOTE: §2 header still references 1.0.23 — the authoritative version is now **1.0.25** (package.json).
- **2026-07-16 (a)** — **Community feed: building the missing publish step (Option A — human-reviewed).** Discovered the community pipeline was only half-built: submissions reach the Google Form, and the app reads `additions.json` (ADDITIONS_URL, plugr-app.github.io/plugr-community-registry) — but the MIDDLE step (form responses → published additions.json) never existed, and the live file has been an empty placeholder (`entries: []`, lastUpdated 2026-04-30) since April. So community sharing has never delivered anything. Josh chose **Option A: Claude-in-the-loop human review** (over a Google Apps Script auto-publish) — matches his promote-cache rhythm, human gate built in, nothing runs unattended. **Design:** on demand, Claude reads the responses sheet via the Google Drive connector, diffs against the live additions.json, presents each NEW submission in plain English + red-flags (bad regex, sketchy URL), Josh approves keepers, Claude writes them into `additions.json` in the community-registry repo, Josh pushes → users pick up within 24h. **Setup piece 1 DONE:** Josh linked the form to a responses Sheet. Form = "Plugr Community Submissions" (id `1e6r1uJQCzvaskY2_jXQsjQa0PvtoNVkIx1wPd1Q9CGQ`); responses sheet = "Plugr Community Submissions (Responses)" (id `1dFzt5EzssBSdQ03EKx2A2G1XyJ4fjLZgDVRsAsu8W_s`), readable via Drive connector; columns: Timestamp, Plugin name, Developer, Identifier, Format, Update URL, Download page, Version regex, Detected Version, App Version. **Setup piece 2 PENDING:** connect the `plugr-app/plugr-community-registry` repo (holds additions.json) to a session so Claude can write approved entries + Josh pushes. **NOTE:** Josh deferred promoting the cache from his OTHER (main) Mac — he'll say when ready; when he is, bring `~/Library/Application Support/Plugr/library-cache.json` over (via the synced Google Drive Plugr folder) and run `npm run promote-cache -- --cache <path> --dry-run` (the `--cache` flag exists for exactly this cross-machine case).
- **2026-07-14 (d)** — **Propagation: downloadUrl + link-only sources now flow through promote-cache AND community (Josh picked "both").** Investigation for Josh found downloadUrl/link-only fixes weren't reaching other users. Closed every gap. **Promote-cache path (self-contained, works now):** (1) `tools/promote-cache-additions.js` no longer requires `versionRegex` (link-only sources promote as manual-check) and writes `downloadUrl` into the productMatcher when set; (2) `electron/lib/registryLookup.cjs` now surfaces `productEntry.downloadUrl` into `item.registry` (it previously only read updateUrl/versionRegex out of a bundled entry — so even a promoted downloadUrl would've been invisible; this was the hidden blocker). So editing sources/download-pages on the other Mac → `npm run promote-cache` → they bundle into a release correctly, MasterCheck-style link-only fixes included. **Community path (code complete, needs ONE manual step from Josh):** (3) `community.cjs` SUBMIT_FIELDS has a new `downloadUrl` mapping set to `''` — **Josh must add a "Download page" question to the Google Form and paste its `entry.NNN` id there**; until then submitAddition just skips it (`if (!formField) continue;`), nothing breaks. (4) fetch/merge in community.cjs now accepts entries with NO versionRegex (validates the regex only when present) and carries `downloadUrl`; (5) `applyCommunityAdditions` in App.jsx merges `downloadUrl` and tolerates empty regex; (6) DiscoverModal's `submitToCommunity` includes `downloadUrl`. Full end-to-end trace verified (submit→form→fetch→merge→registry, and addition→promote→lookup→CTA); node --check + babel parse all green. NO data-model/CACHE_VERSION change. Uncommitted → committing this session; no version bump (dev). **ACTION FOR JOSH: add the Google Form "Download page" field + paste its entry id into `community.cjs` SUBMIT_FIELDS.downloadUrl before the community side transmits.**
- **2026-07-14 (c)** — **"Right page, no version" + separate download page — SHIPPED the design Josh approved.** Problem: NuGen MasterCheck's user-added source pointed at the correct product page, but that page shows no version, so the regex latched onto a bogus v7.1.4 → false "Major upgrade". The old "Fix it…" edit flow only let him *correct* the version (useless when none is shown). Josh also raised the long-discussed "separate update source from download page" idea (release-notes page ≠ download page) but didn't want extra steps for the common single-link case. Backend already had the key mechanism: **a source with `updateUrl` but empty `versionRegex` → `manual-check` status** (clickable link, no version claim) — it just wasn't reachable from the edit flow. Built (all renderer + one main.cjs backstop; NO data-model/CACHE_VERSION change — `downloadUrl` is just a new optional property on existing `userRegistryAdditions`, and `applyRegistryAdditions` already spreads the whole addition into `reg`): (1) **Link-only escape hatch** — in DiscoverModal's `found`/edit phase, a "This page has no version number — keep it as a link only" link (`keepAsLinkOnly()`) clears the regex and saves URL-only; `onSaved` re-check turns the badge into manual-check, killing the false update. (2) **Optional "Download page" field** — blank by default (common case = one link, zero new steps); when set, it's where the CTA sends you. Threaded through `saveAddition({...downloadUrlToSave})` → persisted on the addition (`downloadUrl: dl ? cleanUrl(dl) : null`); main.cjs `registry:saveAddition` cleans it too. (3) **CTA routing** — DetailPanel `ctaUrl = reg.downloadUrl || reg.updateUrl`; primary "Get update" + "Open update/download page" button use it (label flips to "Open download page" when a separate one is set). Verified: `node --check` main.cjs, babel JSX parse of DiscoverModal + DetailPanel, end-to-end grep of the downloadUrl path. Uncommitted → committing this session; no version bump (dev). For MasterCheck: open Fix-it → click "keep it as a link only" (optionally paste the real download page) → Save.
- **2026-07-14 (b)** — **Cleanup-count vs hidden-items bug fixed.** Josh hid all 6 superseded plugins; the grid (Hidden off) correctly emptied, but the sidebar "Old versions" bucket still read 6 (·202 MB). Root cause: the Cleanup counts in `Sidebar.jsx` read `summary.duplicateCount`/`supersededCount`/`*Bytes`, which are computed by the SCANNER at scan time (`scanners.cjs` ~654-688) over ALL items — the scanner has no knowledge of the renderer-side `hidden` override (or `notDuplicate` unlinks). Fix: new `cleanupLive` useMemo in Sidebar computes duplicate/superseded counts + reclaimable bytes live from `items` (= `sidebarItems`, which already excludes hidden and honors overrides); the "Show all" row still uses `items.length`. Now hiding/unhiding/unlinking updates the buckets instantly and they always match the grid. `summary` prop retained (still used for `byFormat` ordering). Renderer-only — no rescan needed, just reload. NOTE: the FORMATS sidebar counts (`summary.byFormat`) are still scan-time totals and NOT hidden-aware — left as-is (arguably intended as library totals; not what Josh reported). JSX parse-verified. Committed separately; not released.
- **2026-07-14 (a)** — **Orphaned-WaveShell detector completed and wired.** The 2026-07-13(k) session had written `collectRequiredWaveShells()` + `flagOrphanWaveShells()` in `scanners.cjs` but never called them and never surfaced the result — left uncommitted in the working tree. Finished it: (1) `scanLibrary` now `await flagOrphanWaveShells(all)` right after `detectDuplicates`; (2) DetailPanel renders a green "Safe to remove" cleanup card when `item.wavesShellOrphaned`, with Waves-Central guidance + a Show-in-Finder link (new `.detail-cleanup.waves-orphan` CSS, `--good` treatment). Mechanism (unchanged from the approved design): reads each Waves payload's `Contents/manifest.yaml` `depends:` list (active `Plug-Ins V*` items + `Unused Plug-Ins V*` bundles, since Central can reactivate those), aggregates required `number|FORMAT|major.minor` keys, flags any scanned `WaveShell…` bundle whose key is in NO manifest. ARA shells ride on their base version (regex ignores the `-ARA` segment for keying). **Fails closed**: `manifestsParsed===0 → flag nothing`. Verified: `node --check` scanners, `@babel/parser` JSX parse of DetailPanel, and a mock-tree logic test (regexes pulled verbatim from source) — needed 16.0/16.7 shells kept, orphan 15.9/13.0 flagged, ARA base-version ride correct, all pass. Uncommitted; no version bump (dev). Suggested commit: `feat(waves): flag orphaned WaveShells safe-to-remove via manifest deps`. NOTE §2 is stale — live version is **1.0.24** (git-confirmed), not 1.0.23.
- **2026-07-13 (k)** — Two bugs from Josh's own auto-update experience, fixed post-1.0.24: (1) clicking Restart on the update toast closed the window but Plugr sat in the dock until manual quit — Squirrel.Mac emits `before-quit-for-update`, NOT `before-quit`, so `isQuitting` stayed false and the menu-bar-mode close interceptor swallowed the quit. Handler added + `updater:install` sets the flag directly. (2) Menu-bar icon "disappeared": createTray's empty-image fallback makes a ZERO-WIDTH invisible tray item on macOS; now falls back to a text title ("Plugr") + warn log. Root cause of the icon-load failure in packaged builds still unconfirmed — watch whether the text fallback appears (means the asset didn't load from asar). Waves shells advice given (see chat): shells are needed per payload MINOR version (manifest.yaml `depends` proves it); orphan-shell detection noted as a possible Plugr cleanup feature.
- **2026-07-13 (j)** — **Waves overhaul, Josh-driven.** His /Applications/Waves listing (via Desktop Commander — first time inspecting his real FS) revealed the full layout: `Plug-Ins V<gen>/<Plugin>.bundle` = per-plugin payloads with REAL names/versions/identifiers (H-Delay.bundle → CFBundleShortVersionString 16.0.23, com.WavesAudio.H-Delay.16.0.23); `Applications V16/*.app` = per-plugin standalones ALL plist-named "AudioPluginHost" (the card-spam cause); `WaveShells V*` = shell binaries; `Unused Plug-Ins V*` = Central-deactivated. Built: (1) new **FORMATS.Waves** pseudo-format scanning Plug-Ins V* bundles (dirFilter excludes Unused/WaveShells/Data/Applications), items carry `wavesGeneration`; (2) `wavesGeneration` in duplicates groupKey — V12/V13/V16 copies of a plugin NEVER cross-flag (gens coexist by design); (3) `fixGenericAppNames()` in scanLibrary — 2+ Apps sharing one plist name across different filenames get renamed to their filename (kills the AudioPluginHost wall, generic for any vendor); (4) realpath scan dedupe (OpenVPN alias case, session i); (5) renderer: 'Waves' in FORMAT_LIST/FORMAT_ORDER, black fmt pill (--fmt-waves). Abandoned mid-build: AU-component expansion of shells (bundle scan is strictly better — real sizes/versions, all formats). Waves items have no updateUrl → show "Managed" via Waves Central companion. All verified against a fake Waves tree + full dup regression matrix. Needs rescan. No version bump.
- **2026-07-13 (i)** — Josh's screenshots exposed FOUR distinct dup-system failures in one session (all fixed, see §6f law updates; all need a rescan): (1) WaveShell masquerading as "Abbey Road Chambers (m)" → shells with ≥5 AU components keep bundle names (AskUserQuestion: Josh picked honest naming over per-plugin expansion). (2) iZotope Trash v1.x flagged OLD vs legacy Trash 2 → new "Not the same plugin? Unlink" per-item escape hatch (`notDuplicate` override; Josh picked this over registry exceptions). (3) RC 24/RC 48 (NI, both v1.4.11) merged into one family → trailing-number stripping now requires the number to MATCH the major version. (4) Polyverse Gatekeeper vs GatekeeperMIDI flagged duplicates (same AU friendly name, same version, different bundles) → same-version dup buckets now keyed on bundle filename too. Plus: OpenVPN alias self-duplicate → realpath-based scan dedupe. Waves AudioPluginHost app spam diagnosed but NOT yet fixed — need a file path from Josh's machine to pick skip rule (likely nested-inside-bundle apps). Full regression matrix passed (Neutron 3/4, SEM V2/V3, Mini V3/V4 still group; true same-file duplicates still flag). No version bump.
- **2026-07-13 (h)** — Josh kept both Hidden (item visibility) and Ignored (update-alert suppression) after discussing — different axes, not redundant. Three UI fixes: (1) context menu "Open in Finder" → "Show in Finder" (his earlier consistency request had missed the menu); (2) context menu now has Ignore this update / Ignore all updates (when a live outdated result exists) and Stop ignoring (when an ignore is in force) — mirrors DetailPanel logic via effectiveUpdates; (3) the dup/superseded cleanup card renders the kept copy's path as a clickable reveal-in-Finder link (`keptItem` resolved from dup.keptId; falls back to plain dup.reason text). No version bump.
- **2026-07-12 (g)** — SEM V2 AU showed OLD + "Newer than registry" together. OLD was CORRECT (SEM V2→V3 is same-product versioning, both AUs installed — unlike the Pre V76 case). "Newer than registry" was a STALE cached check result computed when the AU version still read as packed int 134402; rescans change versions but never invalidated old verdicts. Fix: staleness guard at the top of `effectiveUpdates` — any result whose recorded `installedVersion` no longer matches the item's current version is dropped (renders as never-checked until the next update run). Also renamed toolbar "Check for Plugin Updates" → "Check for Updates" (Josh's request; HelpDialog + Tutorial references updated to match). No version bump. NOTE: the released 1.0.23 DMG includes (a)–(f) but NOT (g) — (g) ships next release.
- **2026-07-12 (f)** — Josh's screenshot: Arturia Pre V76 showing "Up to date"/"Newer than registry" AND OLD simultaneously, AU displaying "v67585". Two independent bugs (see §6f): (1) duplicates normalizeName collapsed Pre V76/Pre 1973/Pre TridA into one "pre" family → false cross-product OLD flags; now uses conservative local stripping instead of nameVariants' most-stripped variant. (2) Arturia AU plists carry packed AU integers (67585 = 0x10801 = 1.8.1) → new decodePackedAuVersion() for .component bundles. Full test matrix passed (model numbers distinct, Mini V3/V4 + Neutron 3/4 still group, decode guards). Needs rescan. No version bump.
- **2026-07-12 (e)** — Josh flagged two things on the 1.0.21 build: (1) Source row's bare "Edit" was unclear → now "Edit source…". (2) "Mark AAX as current" banner gone. Root cause was NOT the panel redesign: the banner lived inside the dup/superseded cleanup card, and 1.0.19's format-aware superseded change removed the OLD flag for cross-format lag — taking the banner's only render path with it, AND breaking effectiveUpdates' implicit mark-as-current (which required raw status 'superseded'). Fix: format-lag banner is now a STANDALONE block in DetailPanel (renders whenever isFormatLag), and effectiveUpdates honors `formatLagAcknowledgedAt === latestVersion` directly (version equality doubles as the staleness guard). Lesson recorded: when suppressing a status flag, grep for UI that renders inside that flag's blocks. No version bump (new process).
- **2026-07-12 (d)** — Josh found New Sonic Arts VST/CLAP plugins categorized as "Application". Root cause: `propagateByName()` in scanners.cjs (the Battery-4 unification pass) let a standalone .app (Freestyle.app, Vice.app) donate category "Application" to same-named Undefined plugin-format siblings; Granite escaped only because its AU (aumu→Synth) shares the exact name and won as donor. Fix (**1.0.23**): propagateByName never propagates 'Application' onto non-App formats, and donor selection prefers plugin-category donors over apps; seeded registry categories for all NSA products (Freestyle→Instrument, Granite→Instrument/Synth, Vice/Vice 2/Nuance/Nuance 2→Instrument/Sampler). Smoke-tested all three propagation scenarios. Needs rescan to take effect. NOTE: Freestyle=Instrument was my judgment call (it's a plugin host) — Josh may want different.
- **2026-07-12 (c)** — Josh released 1.0.21 and, testing on his other Mac, found KORG legacy AAX wrappers showing `vKLAAXWRAPPER_*_VERSION_STRING` as their version + bogus OLD badges. Root cause: KORG ships Info.plists with unexpanded build placeholders (Pro Tools reads version from the AAX binary, so KORG never noticed); semver.coerce extracted "1" from "M1" making them compare as v1.0.0. Fix (**1.0.22**): `saneVersion()` in plistParser.cjs (see §6f), same filter in pluginWatcher, and duplicates.cjs never marks unknown-version copies superseded. Smoke-tested detectDuplicates both ways. Requires a rescan on affected machines to purge cached garbage versions.
- **2026-07-12 (b, connected-folder session)** — Verified the 1.0.20 script ran cleanly (autoUpdater diagnostics, UpdateToast rewrite, HelpDialog About tab, registry Beatmaker→Splice) and fixed its 3 leftover bugs: stray " · · " separator in DetailPanel, missing `onCheckUpdates` prop on CompanionAppsView, missing `app:getVersion` IPC handler. **Shipped the §3 update-panel redesign** (unified "Wrong version or source? Fix it…" link + unified Source row; DiscoverModal registry-edit guards) — Josh approved both design options via AskUserQuestion. Bumped to **1.0.21** (package.json + package-lock, which had been stale at 0.2.1). Deep-reviewed the full app codebase + website repo; corrected §5's architecture map (familyKey lives in App.jsx; lib names fixed) and added §6h-pre pipeline notes. All changes uncommitted — suggest commit: `feat(detail-panel): unified fix-source flow + Source row; fix 1.0.20 leftovers; v1.0.21`.
- **2026-07-12/13 (a)** — Fixed format-aware superseded + Mono/Stereo grouping in `duplicates.cjs`; privileged-trash fallback in `main.cjs`; bumped 1.0.19 (all confirmed applied). Raised + specced the update-panel UX redesign — coded in session (b). Established the connected-folder workflow and this CLAUDE.md.
- **~2026-07-early** — (prior compacted session) `effectiveUpdates`/`matchesFilters` in App.jsx so mark-as-current moves items to "up to date" live; format-lag acknowledgment UI; kanban drag-status fix (verify). Versions ~1.0.12–1.0.18 span multiple compacted sessions whose details are lost — `git log` is the authoritative record of that gap.
- **≤ v1.0.11** — Deal Alerts, Menu Bar mode, tab hiding, entitlements/LemonSqueezy, kanban view, mirror-from-plugin system, community submissions scaffolding, shared-dev-page detection, plugr.co launch. See `HANDOFF.md` and `TODO.md` for the deep history.

---

## 13. Older reference docs in the repo

- `HANDOFF.md` — original handoff at v0.2.1. Historical; superseded by this file.
- `TODO.md` — roadmap + pre-release checklist (promote-cache, community feed setup, monetization spec agreed 2026-06-07). Still largely valid for pre-public-release planning.
- `README.md` — user-facing summary.

## 14. Glossary

| Term | Meaning |
|---|---|
| Companion app / update manager | Native Access, Waves Central, iZotope PP, etc. |
| identifierPrefix | Reverse-DNS prefix attributing a plugin to a developer. |
| userOverrides | Per-plugin user edits in the cache (dev, category, tags, hidden, notes, mirrorFromId…). |
| userRegistryAdditions | Update sources saved via Discover. Distinct from userOverrides. |
| promote-cache | Merges Josh's local discoveries into the bundled registry for release. |
| format family | Same product across VST3/AU/AAX/etc. |
| superseded / OLD | Older version than the newest SAME-FORMAT copy (post-1.0.19 semantics). |
| Mirror link | Child plugin borrows a parent's update status (`mirrorFromId`, e.g. Serum FX → Serum). |
| Sparkle appcast | App's `SUFeedURL`; most reliable update source when present. |
| shared-dev-page | One changelog URL covering a whole catalog (Kilohearts-style); applied to siblings verbatim. |

## 15. Community submission review & publish (Option A — human-reviewed)

The community feed's missing middle step is a **Claude-in-the-loop review**, run on demand when Josh says something like "review new Plugr submissions." Both setup pieces are DONE (see 2026-07-16 session log): the form's responses Sheet is readable via the Drive connector, and the `plugr-app/plugr-community-registry` repo (holds `additions.json`, served at plugr-app.github.io/plugr-community-registry) is connectable so approved entries can be written and Josh pushes them live.

**IDs:** form `1e6r1uJQCzvaskY2_jXQsjQa0PvtoNVkIx1wPd1Q9CGQ`; responses sheet `1dFzt5EzssBSdQ03EKx2A2G1XyJ4fjLZgDVRsAsu8W_s` (Drive `read_file_content`). Sheet columns: Timestamp, Plugin name, Developer, Identifier, Format, Update URL, Download page, Version regex, Detected Version, App Version.

**Procedure each review:**
1. Read the responses sheet via the Google Drive connector; read the live `additions.json` (from the connected registry repo, or the ADDITIONS_URL).
2. Diff — a submission is NEW if no existing entry has the same `key` (+ same `updateUrl`). Present each new one to Josh in plain English.
3. **Red-flag before approving:** `versionRegex` fails `new RegExp()` (a link-only/empty regex is FINE post-2026-07-14 — that's a manual-check source); `updateUrl`/`downloadUrl` not https or on an unexpected domain for the developer; identifier malformed; obvious spam/junk. Empty regex is allowed; empty updateUrl is not.
4. Josh approves the keepers. Write ONLY approved ones into `additions.json`.
5. **Entry schema** (matches `community.cjs` fetch/merge + `applyCommunityAdditions`): `{ key: <plugin identifier, lowercased on merge>, pluginName, developer, updateUrl, versionRegex (optional, '' = link-only), downloadUrl (optional) }`. Top-level file: `{ version:1, lastUpdated:<ISO now>, entries:[...], companionAppPatches?:[...] }`. Bump `lastUpdated`.
6. Validate: `node -e` parse the JSON + `new RegExp` every non-empty regex before committing.
7. Josh pushes the registry repo (never Claude): `cd ~/plugr-community-registry && rm -f .git/*.lock; git add -A && git commit && git push`. Users pick up within 24h (ADDITIONS_TTL_MS).

**Fields already wired app-side (2026-07-14 c/d):** `downloadUrl` and link-only (no-regex) entries flow all the way through submit → sheet → `additions.json` → fetch/merge → `reg.downloadUrl` → CTA. The Google Form "Download page" field id `entry.1633676877` is live in `community.cjs`.
