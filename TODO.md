# Plugr — Roadmap & Pending Work

Last updated: v0.2.1. This file is the living task list. When HANDOFF.md and this file disagree, HANDOFF.md wins — it's refreshed at each release. Update this file whenever something ships or priorities shift.

---

## Recurring: pre-release hygiene

Before every `npm run release:mac`:

```bash
npm run promote-cache -- --dry-run   # preview what would be merged
npm run promote-cache                # apply: merges userOverrides + userRegistryAdditions → developerRegistry.json
git diff electron/lib/developerRegistry.json
git add electron/lib/developerRegistry.json
git commit -m "Promote discovered update sources to bundled registry (vX.Y.Z)"
```

This merges Josh's locally-discovered update sources into the bundled registry so new users get them out of the box. Takes ~10 minutes. Worth it every time.

---

## Open smoke tests (manual, no code)

These are legacy roadmap items that need manual verification — no code changes expected.

- [ ] **#197** — Smoke test all three DAW parsers (Ableton, Logic, FL) end-to-end plus the full UI.
- [ ] **#254** — Post-release sanity sweep: library scan, projects, audio, backup/restore.
- [ ] **#270** — Confirm DMG installs and runs correctly on Josh's studio Mac. Likely resolved by v0.2.0 release; verify and close.

---

## Pending features

### DAW project parsers

- [ ] **Reaper (.RPP)** — not built. Ableton, Logic, and FL are shipped.
- [ ] **Studio One (.song)** — not built.
- [ ] **Bitwig (.bwproject)** — not built.

### Medium-priority

- [ ] **Preset browser** — Index file-based presets across known plugin folders (Logic User Library, Ableton User Library, FabFilter/u-he/Soundtoys preset folders). Unified search.
- [ ] **Authorization / license-status detection** — Detect iLok presence, demo expiry, NI activation state. Prefer "unknown" over a wrong assertion.
- [ ] **CPU benchmark** — Run plugins through a synthetic standalone host, report CPU/RAM. Sort by hungriest.

### Lower priority / aspirational

- [ ] **Curated plugin alternatives** — Small JSON of "if you have X, you might not need Y" suggestions.
- [ ] **Mobile companion** — Push notifications for sales / updates.
- [ ] **Hosted multi-device sync** (paid tier) — beyond the iCloud sync that already ships.

---

## What's already shipped (don't re-add these)

Everything below is live as of v0.2.1. Listed here to prevent future confusion.

- **Library scanning + categorization** — VST3, VST2, AU, AAX, CLAP, /Applications. Auto-categorize, group by developer, size on disk, duplicates/superseded detection.
- **Update checking + Discover** — Curated registry (126 devs, 300+ matchers), Discover flow, shared-dev-page detection, Sparkle appcast support, community additions overlay.
- **Projects tab** — Ableton (.als), Logic (.logicx), FL Studio (.flp). Tempo, key, bounce extraction. Virtualized with react-window.
- **Deals tab** — Plugin Boutique + Audio Plugin Deals scrapers, image-less cards, ownership filter, wishlist, sort, price history, currency conversion, dismiss-with-undo, click tracking, "N new" badge.
- **Deal Alerts** — Watch by plugin / developer / keyword. Native macOS notifications with 24h dedupe. Bell icons throughout UI.
- **Companion Apps tab** — Update manager launchers (Native Access, Waves Central, etc.) with real .icns icons. Community patches feed live.
- **Tools tab** — Tap tempo, BPM↔delay calc, Note↔frequency, dB↔linear, Camelot wheel.
- **Plugin tags** — TagInput in DetailPanel, sidebar filter, bulk add/remove in BulkEditPanel, chips on grid + list cards.
- **Per-plugin notes** — Textarea in DetailPanel with debounced save into userOverrides.
- **Menu Bar mode** — Tray, launch-at-login, before-quit interceptor.
- **Tab hiding** — Right-click to hide, + button to restore. Paid/trial only.
- **Backup & restore** — Single-file JSON export/import of all overrides, tags, notes, sources, settings.
- **iCloud sync** — Optional; relocates cache under iCloud Drive for two-Mac sharing.
- **Licensing & entitlements** — LemonSqueezy activation + background validation (licenseStore.cjs), feature flags (entitlements.cjs: isPaidOrTrialing, unlocked, inTrial, tabVisibility), trial banner, Buy dialog, License section in Help dialog (key entry, sign-out, manage subscription). All gates live: bulk ops, studio themes, iCloud sync, CSV export, backup/restore, library scans, 100-plugin update cap on trial. Dev mode (app.isPackaged === false) bypasses all gates.
- **Themes** — 8 studio palette themes (paid/trial only), plus Dark / Light / Auto for everyone.
- **CSV export** — Paid/trial only.
- **Support + bug reporting** — Visit Support Site → plugr.co/support; Report a Bug → Google Form with 8 pre-filled diagnostic fields.
- **Friendly OS string** — getFriendlyOSVersion() returns "macOS Tahoe 26.5.1" style strings. Covers Big Sur (11) → Tahoe (26).
- **Community contribution feed** — Google Form for submissions + GitHub Pages additions.json overlay. Companion app patches feed also live.
- **plugr.co marketing site** — Live, serving latest DMG via GitHub Releases API. Pricing: $7/mo, $49/yr, $149 lifetime, all paid tiers = 3 Macs.
