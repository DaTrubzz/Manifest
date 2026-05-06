# Manifest

A simple PWA habit tracker for **workouts, water, sleep, and nutrition** — installable on your iPhone and laptop, with optional cross-device sync via Supabase and a local **MCP server** so Claude Desktop can read and write your data conversationally.

## What's in this folder

| Path | What it is |
|---|---|
| `index.html` | The whole app — UI, logic, styles in one file |
| `manifest.webmanifest` | PWA manifest |
| `sw.js` | Service worker (offline support) |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | App icons |
| `supabase-setup.sql` | One-time SQL to run in your Supabase project |
| `mcp-server/` | Local Node.js MCP server for Claude Desktop |

## 1 — Try it locally

The PWA needs to be served over HTTP for the service worker to register. From PowerShell or your terminal, in this folder:

```powershell
python -m http.server 8000
```

Open <http://localhost:8000>. Tap the cards, log things — data saves to your browser's localStorage immediately.

If you don't have Python: `npx serve .` works if Node is installed, or just double-click `index.html` to preview without offline support.

## 2 — Set up free cross-device sync (Supabase)

This is the one-time setup that lets your iPhone and laptop see the same data.

1. Go to <https://supabase.com> and sign up (free, no credit card).
2. Click **New project**. Pick any name, set a database password (save it; you don't need it again unless something breaks), pick a region close to you. Wait ~2 min for the project to provision.
3. In the left sidebar, open **SQL Editor** → **New query**. Paste the entire contents of `supabase-setup.sql`, click **Run**. You should see "Success."
4. Open **Project Settings** (gear icon) → **API**. Copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / public key** (a long `eyJ…` string — *not* the service role key)
5. Open Manifest in your browser → **Settings** tab → **Cross-device sync** card.
6. Paste the URL and anon key. Click **Generate code** to make a sync code, then **Enable sync**.
7. On your iPhone, open Manifest → Settings → paste the **same URL, same key, same sync code** → **Enable sync**.

Both devices now share data. The status pill on the Today screen shows sync status.

> **Threat model**: anyone with your sync code + Supabase URL can read/write your habit data. Treat the sync code like a password — don't share it. The 12-character random code is ~62 bits of entropy, plenty for this use case.

## 3 — Set up the MCP server (Claude Desktop on your laptop)

This is what makes Claude in this app able to actually call tools like *log my mobility workout* or *what's my water streak*.

### Install

1. Make sure you have Node.js 18 or newer (`node --version` to check). If not, install from <https://nodejs.org>.
2. In a terminal, change into the `mcp-server` folder and install deps:

   ```powershell
   cd "C:\Users\samuel.mahoney\AppData\Roaming\Claude\local-agent-mode-sessions\a7259e24-9732-422d-b71c-3d7e2c0fe439\6205f8b7-45b5-413b-9bc9-5864ae49e4f4\local_7a24e77e-fa7e-4e7a-8955-e7ca626234dc\outputs\mcp-server"
   npm install
   ```

### Register with Claude Desktop

Edit your Claude Desktop config file. On Windows, that's:

```
C:\Users\samuel.mahoney\AppData\Roaming\Claude\claude_desktop_config.json
```

(Create it if it doesn't exist.) Add a `manifest` entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "manifest": {
      "command": "node",
      "args": ["C:\\Users\\samuel.mahoney\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\a7259e24-9732-422d-b71c-3d7e2c0fe439\\6205f8b7-45b5-413b-9bc9-5864ae49e4f4\\local_7a24e77e-fa7e-4e7a-8955-e7ca626234dc\\outputs\\mcp-server\\server.js"],
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_KEY": "eyJ...your-anon-key...",
        "SYNC_CODE": "your-12-char-sync-code"
      }
    }
  }
}
```

Restart Claude Desktop. In a new chat you should now be able to say things like:

- *"Log a mobility workout"*
- *"How many glasses of water have I had today?"*
- *"What's my workout streak?"*
- *"Show me the last 14 days"*
- *"I slept 7.5 hours, quality 4"*

### Tools exposed

| Tool | What it does |
|---|---|
| `get_today` | Today's workout, water, sleep, nutrition, plus completion (0–4) |
| `get_streak` | Streak in days for `workout`, `water`, `sleep`, `nutrition`, or `all` |
| `get_history` | Last N days of habit data (default 30) |
| `log_workout` | Log Strength / Cardio / Mobility / Other with optional note |
| `log_water` | Add or subtract glasses (negative undoes) |
| `set_water` | Set total glasses to an exact number |
| `log_sleep` | Hours + quality (0–5) |
| `log_nutrition` | Rating: good / ok / off |
| `set_goal` | Update water or sleep daily goal |
| `get_settings` | Read current goals and name |

## 4 — `window.manifest` command bus (in-browser API)

Anything running in the browser context — DevTools console, a userscript, a Chrome extension, Claude in Chrome — can drive the app:

```js
window.manifest.logWorkout("Mobility");        // log a mobility workout for today
window.manifest.logWater(2);                    // +2 glasses
window.manifest.logSleep(7.5, 4);               // 7.5 hours, quality 4 of 5
window.manifest.logNutrition("good");           // on plan today
window.manifest.getToday();                     // → today's snapshot
window.manifest.getStreak("all");               // → days you've hit all 4
window.manifest.getHistory(14);                 // → last 14 days
window.manifest.setGoal("water", 10);           // bump water goal to 10
window.manifest.syncNow();                      // force a Supabase round trip
```

## 5 — URL deep links (iOS Shortcuts, etc.)

Open these URLs to trigger actions without using the UI. After running, the app strips the query so reloads don't repeat the action.

| URL | Effect |
|---|---|
| `index.html?action=water&n=1` | Add 1 glass of water |
| `index.html?action=water&n=-1` | Remove 1 glass |
| `index.html?action=workout&type=Mobility` | Log a Mobility workout |
| `index.html?action=workout&type=Strength&note=Push%20day` | With a note |
| `index.html?action=sleep&hours=7.5&quality=4` | Log sleep |
| `index.html?action=nutrition&rating=good` | Log on-plan eating |

You can wire these into the iOS Shortcuts app so "Hey Siri, log a glass of water" calls into Manifest.

## Privacy

Without sync enabled, your data lives only in your browser's localStorage. With sync enabled, it lives in **your** Supabase project under your anon key — nothing goes anywhere else. The MCP server runs locally on your computer and only connects to your Supabase.

## Troubleshooting

- **Sync pill shows red** — open DevTools console for the underlying error. Most often the Supabase URL/key is wrong or the SQL setup wasn't run.
- **MCP tools aren't showing up in Claude Desktop** — fully quit Claude Desktop (right-click tray icon → Quit, not just close the window) and re-open. Check the JSON in `claude_desktop_config.json` is valid.
- **MCP server log location** — Claude Desktop captures stderr from MCP servers. On Windows: `%APPDATA%\Claude\logs\mcp-server-manifest.log`.
- **Wrong data appearing on a device** — the device with the most recent change wins. Disable sync, fix the data, re-enable sync to re-push.
