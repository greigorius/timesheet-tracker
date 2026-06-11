# Timesheet Tracker — Axiom DL

Cockpit for managing weekly timesheet imports, hours visualisation, and reconciliation.
Design Technicians submit `.xlsx` files to Dropbox; this tool validates, imports, and displays them via a Make.com pipeline into Notion.

## Stack

- **Frontend** — Plain HTML/CSS/JS in `src/index.html` (no framework)
- **Build** — [Vite](https://vitejs.dev/) (dev server + production build)
- **Deploy** — [Netlify](https://netlify.com) (auto-deploy from GitHub)
- **Automation** — [Make.com](https://make.com) (two scenarios: Scan + Import)
- **Database** — [Notion](https://notion.so) (Timesheets DB — already exists)
- **File storage** — Dropbox `/Timesheets/Inbox/` (DTs drop files here)

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) v20+
- A GitHub account with repo `greigorius/timesheet-tracker` created

### First run
Double-click **`start.bat`** — installs dependencies and opens `http://localhost:5173`.

### Subsequent runs
Double-click **`start.bat`** — skips install, goes straight to dev server.

---

## GitHub Setup (one time)

```bash
cd C:\Users\greig\Documents\ClaudeProjects\timesheet-tracker

git init
git remote add origin https://github.com/greigorius/timesheet-tracker.git
git branch -M main
git add .
git commit -m "Initial commit"
git push -u origin main
```

After pushing, connect to Netlify (see Deploy section below).

### Pushing updates
Double-click **`push-to-github.bat`**, enter a commit message. Netlify auto-deploys within ~90 seconds.

---

## Environment Variables

All runtime config is stored in browser `localStorage` (entered via the Settings drawer in the UI). There are no server-side secrets in this repo.

For local reference, copy `.env.example` to `.env` and fill in your values. The `.env` file is git-ignored and is **not used by the app** — it's a local cheat-sheet only.

```bash
cp .env.example .env
# then edit .env with your actual values
```

| Variable | What it is |
|---|---|
| `MAKE_SCAN_WEBHOOK` | Make webhook URL — returns Dropbox file list |
| `MAKE_WRITE_WEBHOOK` | Make webhook URL — triggers full import pipeline |
| `NOTION_TOKEN` | Notion internal integration token (read-only) |
| `NOTION_TIMESHEETS_DB` | Timesheets DB ID (default set in app) |
| `PROXY_URL` | Notion proxy endpoint on Axiom Hub backend |

To connect the app: open it → click **⚙** (Settings) → paste in the values above → Save & Connect.

---

## Deploy to Netlify

### One-time setup
1. Go to [netlify.com](https://netlify.com) → **Add new site → Import from Git**
2. Authorise GitHub and select `timesheet-tracker`
3. Build settings are auto-detected from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Click **Deploy** — live at your Netlify URL in ~90 seconds

> `dist/` is git-ignored. Netlify runs the build on its own servers on every deploy — never commit `dist/`.

---

## Connections Required

### 1. Make.com — Scan Webhook (Scenario B)

Triggered by "Scan Inbox" button. Must respond synchronously with:

```json
[
  {
    "name": "GF_2026-W24.xlsx",
    "size": "18 KB",
    "modified": "Today 08:12",
    "headers": ["Name","Project","Category","Description","Date","Day","Item No","Hours"]
  }
]
```

Set the URL under **Settings → Make.com Scan Inbox Webhook**.

### 2. Make.com — Write Webhook (Scenario A)

Triggered by "Write to Notion" button. Receives:

```json
{
  "files": ["GF_2026-W24.xlsx", "GO_2026-W24.xlsx"],
  "triggered_at": "2026-06-11T09:15:00.000Z"
}
```

Set the URL under **Settings → Make.com Write to Notion Webhook**.

### 3. Notion Integration Token

Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations). Grant it read access to the Timesheets database. Paste the token (`ntn_...`) under **Settings → Notion Integration Token**.

Timesheets DB ID (pre-filled): `197210e4-582e-8087-81be-000b8525577a`

### 4. Notion API Proxy

Direct Notion API calls are blocked by CORS in the browser. A proxy endpoint on the Axiom Hub Express backend forwards reads:

```js
// server/routes/notion-proxy.js  (add to greigorius/dm-tracker)
app.post('/api/notion/query', async (req, res) => {
  const { notionToken, databaseId, filter, sorts, page_size } = req.body
  const response = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter, sorts, page_size }),
    }
  )
  res.json(await response.json())
})
```

Set the deployed URL under **Settings → API Proxy URL** (e.g. `https://axiom-hub.netlify.app/api/notion/query`).

---

## Notion Database Reference

| Database | ID |
|---|---|
| **Timesheets** | `197210e4-582e-8087-81be-000b8525577a` |
| Projects | `5c689434-c2b0-4766-9831-d2b31ef0f8de` |
| Tasks | `bb783a35-a407-4637-89c6-78ebc76c8699` |

**Timesheets DB property mapping:**

| Notion property | Type | Cockpit field |
|---|---|---|
| Person | rich_text | `entry.person` |
| Project | relation title | `entry.project` |
| Category | select | `entry.category` |
| Description | rich_text | `entry.description` |
| Date | date (start) | `entry.date` |
| Day | select | `entry.day` |
| Hours | number | `entry.hours` |
| Import Status | select | `entry.status` |
| Source File | rich_text | `entry.sourceFile` |

**Category select options** (must exist in Notion): `Design`, `Drafting`, `Coordination`, `Meetings`, `Admin`, `Site`, `Other`

**Import Status options**: `Imported`, `Flagged`, `Duplicate`, `Manual`

---

## Project Structure

```
timesheet-tracker/
├── src/
│   └── index.html              ← The cockpit (all HTML/CSS/JS, ~1200 lines)
├── docs/
│   ├── make-scenario-scan.json     ← Make Scenario B blueprint (Scan Inbox)
│   ├── make-scenario-import.json   ← Make Scenario A blueprint (Full Import)
│   └── claude-normalise-prompt.md  ← Claude prompt used in Make import pipeline
├── dist/                       ← Built output (git-ignored)
├── vite.config.js
├── netlify.toml
├── package.json
├── .gitignore
├── .env.example                ← Copy to .env for local reference
├── start.bat                   ← Dev server launcher
└── push-to-github.bat          ← Git commit + push
```

---

## Roadmap

- [x] Cockpit UI — complete
- [x] Demo data — complete
- [x] Make scenario blueprints — complete
- [ ] Make scenarios deployed and webhook URLs configured
- [ ] Notion proxy endpoint added to Axiom Hub
- [ ] Invoice reconciliation view
- [ ] CSV export of filtered import log
