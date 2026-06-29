# Copy-paste this as your FIRST message in the fresh Claude account session

---

Hey — I'm continuing work on Plugr, a macOS app for music producers I've been building. You're picking up from a previous Claude session. Before you do anything, please:

1. **Read `/Users/joshuaisaacs/plugr/HANDOFF.md` cover to cover.** It's the handoff doc the previous Claude wrote. It covers project locations, architecture, the conventions that bite you if you ignore them, the release workflow, the website workflow, brand voice, what never to do, and pending work.

2. **Glance at `/Users/joshuaisaacs/plugr/README.md`** for a high-level summary of what the app does.

3. **Note that the marketing site is a separate git repo** at `/Users/joshuaisaacs/Library/CloudStorage/GoogleDrive-info@joshisaacs.com/My Drive/Documents - Drive/Plugr/website/` — that's where plugr.co lives. The website copy audit doc (the source of truth for all site copy) is at `/Users/joshuaisaacs/Library/CloudStorage/.../Plugr/PLUGR-WEBSITE-COPY-AUDIT.md`.

Once you've read HANDOFF.md, tell me "ready" and what you understood, and I'll point you at what's next. Don't start coding or editing anything until I tell you what to work on.

A few quick orienting notes:
- Call me Josh, not Joshua.
- The current shipped version is 0.2.0. The DMG is built via `npm run release:mac` from `~/plugr`.
- The repos: `~/plugr` (the app — not on GitHub, just local), and `plugr-app/plugr.co` (the website, served via GitHub Pages), and `plugr-app/plugr-releases` (where DMGs land as GitHub Releases).
- I will be running git commits and pushes from my own Terminal — you don't have GitHub credentials. You commit, I push.
- Use the TodoList tool liberally on multi-step work.

---

## Optional follow-ups (only if Claude misses anything obvious)

If the new Claude seems unsure where to start after reading HANDOFF.md, send any of these as a follow-up:

- "What's currently in `~/plugr/electron/lib/cache.cjs`? Show me the saveCache schema so I know you've read it."
- "List the top-level state variables in `src/App.jsx` so I know you understand the architecture."
- "Run `cat ~/plugr/package.json | python3 -c 'import json,sys; p=json.load(sys.stdin); [print(k,v) for k,v in p[\"scripts\"].items()]'` and tell me what each script does."

If the new Claude tries to do something that conflicts with HANDOFF.md, point at the relevant section:

> "Re-read HANDOFF.md section 4a — every new cache field needs to be added in three places, not one."
