# CLAUDE.md — Manifest project handoff

You are picking up work on **Manifest**, a fitness habit tracker PWA. This project was started in Cowork mode and is being moved to Claude Code so we can do real local testing, npm installs, and deploys. Read README.md for the full picture; this file is a quick situational brief.

## User

Name: Sam (`sammymahoney@hotmail.com`). Self-described as **"some coding, mostly guidance"** — comfortable running commands you give them, but explain what you're doing and why. Windows machine. Goals are fitness-oriented (workouts, eating, mobility, sleep — straight from their Fitness project description).

## What Manifest is

A single-page PWA habit tracker for four daily habits: **workout, water, sleep, nutrition**. Streaks, 7-day strip, 30-day history grid, settings. Built as a single `index.html` (inline CSS + JS), service worker for offline, manifest for "Add to Home Screen". Local-first (localStorage), with optional cross-device sync via Supabase, plus a Node.js MCP server so Claude Desktop can call tools like `log_workout` and `get_streak`.

## Repo layout

```
outputs/
├── index.html                # The whole app
├── manifest.webmanifest      # PWA manifest
├── sw.js                     # Service worker
├── icon.svg / icon-192.png / icon-512.png / apple-touch-icon.png
├── supabase-setup.sql        # One-time SQL for the Supabase backend
├── README.md                 # User-facing setup guide
├── CLAUDE.md                 # ← you are here
└── mcp-server/
    ├── package.json          # @modelcontextprotocol/sdk + @supabase/supabase-js
    ├── server.js             # stdio MCP server, 10 tools
    └── (no node_modules yet — npm install hasn't run)
```

## Status

**Completed:**
- App is fully built and structurally tested (JS parses, manifest valid, icons render).
- `window.manifest` command bus is wired: `logWorkout`, `logWater`, `logSleep`, `logNutrition`, `getToday`, `getStreak`, `getHistory`, `setGoal`, `syncNow`, etc.
- URL deep links work: `?action=water&n=1`, `?action=workout&type=Mobility`, etc.
- Supabase sync is implemented in the app (lazy-loads `@supabase/supabase-js` from esm.sh CDN), with a Settings UI to enter URL + anon key + sync code.
- MCP server is written but `npm install` has NOT run.
- README has step-by-step setup for Supabase + Claude Desktop config (Windows paths).

**Open / next steps (in priority order):**
1. **Deploy the static site somewhere Sam's iPhone can reach it.** Sam tried Netlify Drop and hit a "file or directory not found" error. Netlify Drop wants a single folder/zip — Sam was trying to drag loose files. Better path now: do `npx vercel deploy` from this folder (Sam can run that, or you can if Vercel CLI is set up), or set up Cloudflare Pages, or just `git init && git push` to GitHub and use GitHub Pages. Whatever works. The result is a public URL Sam can open on his iPhone Safari → Add to Home Screen.
2. **Sam needs to set up Supabase** (5-min signup at supabase.com, run `supabase-setup.sql` in their SQL Editor, copy URL + anon key). README has the steps. Sam may need handholding here.
3. **`cd mcp-server && npm install`** to install MCP server deps locally on Sam's machine.
4. **Edit `%APPDATA%\Claude\claude_desktop_config.json`** to add the `manifest` MCP server with Sam's Supabase env vars. Restart Claude Desktop. Verify tools appear in a new chat.

## Important context for the next session

- The localStorage key is `manifest.v1`. Old `daily.v1` data is auto-migrated on first load.
- Sync uses one row per `sync_code` in `manifest_data` (JSONB). Last-write-wins on `updated_at`. Push is debounced 1.5s; pull on boot + every 30s.
- RLS is on but permissive — security comes from the unguessable 12-char sync code, not auth. This is intentional for this app's threat model (single-user habit data) but worth flagging if Sam later wants real auth.
- MCP server is stdio, talks directly to Supabase (not to the running app). So MCP works whether or not the PWA is open.
- Sam doesn't have a Mac, so iOS native (Capacitor / TestFlight) is out for now without buying an Apple Developer account.

## Recommended first action

Greet Sam briefly, confirm you've read this file and the README, then ask whether to (a) tackle deployment now (probably the biggest unblocker) or (b) walk through the Supabase + MCP setup using the URL Sam already has from a prior deploy attempt. Don't re-explain the project — Sam knows what it is.

## Things to avoid

- Don't re-do the rename or re-explain the architecture; both are settled.
- Don't propose Capacitor / native iOS unless Sam explicitly asks — README already lists it as a "where to next."
- Sam prefers concise, practical answers and clear next steps over long explanations.
