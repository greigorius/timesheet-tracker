# DKH Timesheet Cockpit

A web-based operations tool for **Design Know How (DKH)** to manage weekly timesheet submissions. Team members drop `.xlsx` files into a shared Dropbox folder; this cockpit validates, imports, and visualises them through a Make.com automation pipeline into Notion.

---

## Purpose

- Provide a single interface to scan, import, and review timesheet submissions
- Parse freeform Excel data using AI (Claude Haiku) into structured Notion records
- Validate all relation fields (Person, Client, Item) against live Notion databases before writing
- Stream the full timesheet log from Notion in real time, newest entries first

---

## Architecture Overview

```
[Team Member]
     │  drops ADL_Timesheet_Template.xlsx
     ▼
[Dropbox]  /DESIGN KNOW HOW/Timesheets/Inbox/
     │
     │  Make Scenario B (Scan Inbox)
     ◄──────────────────────────────── [Cockpit "Scan" button]
     │  returns file list + already-imported flags
     ▼
[Cockpit "Import" button]
     │  POST → Make Scenario A webhook
     ▼
[Make.com — Scenario A: Full Import]
     │
     ├─ 1. Dropbox: get file bytes
     ├─ 2. parse-xlsx (Netlify fn)  → CSV rows
     ├─ 3. claude-parse (Netlify fn) → structured JSON rows (AI normalisation)
     ├─ 4. notion-proxy validate-relations (Netlify fn)
     │       → resolves Person / Client / Item page IDs
     │       → Person missing = hard fail (file rejected, 422)
     │       → Client / Item missing = soft warn (blank + "Flagged")
     ├─ 5. Notion: create one page per valid row in Timesheets DB
     ├─ 6. Dropbox: move file Inbox → Processed
     └─ 7. Webhook respond: 200 OK or 422 with error detail
          │
          ▼
     [Cockpit refreshes file list + streams new Notion rows]
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML / CSS / JS — `src/index.html` (no framework) |
| Build | [Vite](https://vitejs.dev/) |
| Deploy | [Netlify](https://netlify.com) — auto-deploy from GitHub |
| Serverless functions | Netlify Functions (`netlify/functions/`) |
| Automation | [Make.com](https://make.com) (two scenarios) |
| Database | [Notion](https://notion.so) |
| File storage | Dropbox — `/DESIGN KNOW HOW/Timesheets/` |
| AI parsing | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |

---

## Project Structure

```
timesheet-tracker/
├── src/
│   └── index.html                  ← Cockpit (all HTML/CSS/JS, single file)
├── netlify/
│   └── functions/
│       ├── notion-proxy.js         ← Notion API proxy + validate-relations
│       ├── claude-parse.js         ← Claude Haiku AI normaliser
│       └── parse-xlsx.js           ← XLSX → CSV extractor
├── ADL_Timesheet_Template.xlsx     ← Team timesheet template
├── netlify.toml                    ← Build config + function routing
├── vite.config.js
├── package.json
├── .env.example                    ← Credential reference (copy to .env locally)
├── start.bat                       ← Dev server launcher (Windows)
└── push-to-github.bat              ← Git commit + push (Windows)
```

---

## Netlify Functions

### `notion-proxy.js`

CORS proxy for Notion API — required because browser→Notion direct calls are blocked by CORS.

**Query mode** (cockpit data load):
```json
POST /.netlify/functions/notion-proxy
{ "db": "timesheets", "sorts": [{"property": "Date", "direction": "descending"}], "page_size": 100 }
```
Returns a standard Notion database query response. Resolves relation `_title` fields by querying each related DB once and caching the result for 2 minutes (prevents 429 rate-limit errors during paginated streaming).

**Validate-relations mode** (called by Make before writing to Notion):
```json
POST /.netlify/functions/notion-proxy
{ "action": "validate-relations", "rows": [ { "person": "James Christmas", "client": "TMJ", "item_no": "081", ... } ] }
```
- Fetches timesheets DB schema to discover relation DB IDs (People, Clients, Items)
- Builds name→ID lookup indexes for all three DBs
- Applies fuzzy matching cascade: exact → starts-with → contains → search-contains-key
- Item matching is anchored to the **code prefix** (everything before ` - ` in the item name) to prevent false matches against descriptive suffixes (e.g. `111` must NOT match `081 - CLG-111 Ceiling`)
- Duplicate item numbers across projects are disambiguated using the row's `project` field
- Returns `valid_rows_json` (resolved rows ready for Notion) and `error_rows` (hard failures)

**Validation rules:**

| Field | On missing/unresolved |
|---|---|
| Person | Hard fail — entire file rejected (422) |
| Client | Soft warn — blank relation, Import Status = `Flagged` |
| Item | Soft warn — blank relation, Import Status = `Flagged` |
| Project | Informational only — populated by Notion rollup from Item |

### `claude-parse.js`

Calls the Anthropic Claude Haiku API to normalise raw CSV timesheet data into structured JSON rows.

- Input: raw CSV from `parse-xlsx`, person name, week commencing date, filename
- Output: `{ rows: [...], rows_json: "...", count: N }`
- Each row: `{ date, day, client, project, item_no, category, variation, description, hours, person, week_commencing }`
- Skips empty rows (no Date + Hours), normalises Variation to `"Y"`/`"N"`, passes Client/Project/Item abbreviations through unchanged for downstream fuzzy matching

### `parse-xlsx.js`

Parses an XLSX binary (base64-encoded) into a CSV string.

- Input: base64 XLSX content + filename (from Make via POST)
- Output: `{ csv_escaped, person, week_commencing, filename }`
- Extracts person name and week from the filename convention `YYYY-WNN_FirstnameLastname.xlsx`

---

## Make.com Scenarios

### Scenario A — Full Import (ID: 6144563)

**Trigger:** Webhook POST from cockpit
**Flow:**
1. Iterator over file array from webhook payload
2. Dedup check — queries Notion for existing rows with matching `Source File`; skips if already imported
3. Dropbox: get file from `/DESIGN KNOW HOW/Timesheets/Inbox/`
4. HTTP: POST to `parse-xlsx` Netlify function
5. HTTP: POST to `claude-parse` Netlify function (60s timeout)
6. HTTP: POST to `notion-proxy` validate-relations (60s timeout)
7. Router — if `error_count > 0`: respond 422; else continue
8. JSON Parse: iterate `valid_rows_json` using data structure **ADL Valid Row** (ID: 455340)
9. Notion: Create a Page in Timesheets DB for each row
10. Aggregator: collects all created pages (breaks iterator scope so steps 11–12 run once)
11. Dropbox: move file to `/DESIGN KNOW HOW/Timesheets/Processed/`
12. Webhook: respond 200 OK

**Key Make settings:**
- Sequential processing: OFF (prevents webhook responder timeout)
- `Variation? (Y/N)` field: `{{20.variation}}` — claude-parse guarantees `Y`/`N`
- `Import Status` field: `{{if(20.import_status; 20.import_status; "Imported")}}` — defaults to Imported for clean rows
- `Item` relation: `{{if(20.item_id; split(20.item_id; ","); ignore)}}` — `ignore` avoids `parseJSON` error when item_id is null

### Scenario B — Scan Inbox

**Trigger:** Webhook GET from cockpit "Scan Inbox" button
**Flow:** Lists files in Dropbox `/DESIGN KNOW HOW/Timesheets/Inbox/` and returns metadata array to cockpit

---

## Notion Database Reference

| Database | ID | Purpose |
|---|---|---|
| **Timesheets** | `197210e4-582e-8074-af63-f01e789e2d1c` | One row per timesheet entry |
| **Projects** | `5c689434-c2b0-4766-9831-d2b31ef0f8de` | Project reference (rollup source) |
| People | discovered via schema | Person relation target |
| Clients | discovered via schema | Client relation target |
| Items | discovered via schema | Item relation target |

**Timesheets DB properties used by import:**

| Property | Notion Type | Notes |
|---|---|---|
| Short Description of Work Done | title | Entry description |
| Person | relation → People DB | Hard fail if not resolved |
| Client | relation → Clients DB | Soft warn if not resolved |
| Item | relation → Items DB | Soft warn if not resolved; code-prefix matching |
| Category | select | Design / Drafting / Coordination / Meetings / Admin / Site / Other |
| Date | date | YYYY-MM-DD |
| Actual Hours Spent | number | |
| Variation? (Y/N) | select | Y or N |
| Source File | rich_text | Filename — used for dedup check |
| Import Status | select | `Imported` / `Flagged` |
| Projects | formula/rollup | Populated automatically from Item relation |

---

## Cockpit Features

**Import Pipeline panel**
- Scans Dropbox Inbox on demand
- Marks files already in Notion with an "Imported" badge
- Triggers single-file or batch import via Make Scenario A webhook
- Shows per-file import status and error details inline

**Import Log**
- Streams Notion Timesheets DB pages in real time, newest-first (100 rows per page)
- Explicit client-side date sort as safety net
- Filter by Status / Project / Person
- Colour-coded person dots and project dots

**Hours Breakdown**
- Stacked bar chart — group by Person or Project, segment by the other
- Filter contracted vs variation hours
- Expandable tree: Client → Project → Item → hours

---

## Environment Variables

Set these in **Netlify → Site → Environment Variables**. Never commit actual values.

| Variable | Required | Description |
|---|---|---|
| `NOTION_TOKEN` | ✅ | Notion internal integration token (`ntn_...`). Must have access to Timesheets, Projects, People, Clients, and Items databases. |
| `NOTION_TIMESHEETS_DB` | ✅ | Timesheets database ID (without hyphens) |
| `NOTION_PROJECTS_DB` | ✅ | Projects database ID (without hyphens) |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (`sk-ant-...`) — used by `claude-parse.js` |

**Cockpit settings** (stored in browser `localStorage` via the ⚙ Settings drawer):

| Setting | Description |
|---|---|
| Proxy URL | `https://dkh-timesheet-tracker.netlify.app/.netlify/functions/notion-proxy` |
| Scan Inbox Webhook | Make Scenario B webhook URL |
| Write to Notion Webhook | Make Scenario A webhook URL |

---

## Local Development

**Prerequisites:** Node.js v20+

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev

# Or double-click start.bat on Windows
```

The dev server proxies nothing — to test against live Notion data, enter the production proxy URL in the cockpit Settings drawer.

**Deploy:**
```bash
# Windows — double-click push-to-github.bat
# Or manually:
git add .
git commit -m "your message"
git push
# Netlify auto-deploys within ~90 seconds
```

> ⚠️ All git operations must be run from Windows (Git Bash or PowerShell), not the Linux sandbox — NTFS lock files cause errors in WSL/Linux.

---

## Fuzzy Matching Reference

The `notion-proxy` validate-relations logic uses a 4-pass cascade for each relation field:

| Pass | Logic | Example |
|---|---|---|
| 1 — Exact | Case-insensitive exact match | `"TMJ Interiors"` → `"TMJ Interiors"` |
| 2 — Starts-with | Key starts with search term | `"24-354"` → `"24-354 - EIT Auditorium"` |
| 3 — Contains | Key contains search term | `"EIT Auditorium"` → `"24-354 - EIT Auditorium"` |
| 4 — Fuzzy | Search contains key (min 3 chars) | `"TMJ"` → `"TMJ Interiors"` |

**For Items** — matching is anchored to the **code prefix** (text before the first ` - ` separator):

| Item name | Code prefix | `"111"` matches? | `"081"` matches? |
|---|---|---|---|
| `081 - CLG-111 Ceiling` | `081` | ✗ | ✓ |
| `SK-003` | `SK-003` | ✗ | ✗ |
| `003` | `003` | ✗ | ✗ |

When the same item number exists on multiple projects (e.g. `001` on Project A and Project B), the row's `project` field is used to disambiguate.

---

## Rate Limiting Notes

Notion API rate limit: ~3 requests/second.

The cockpit streams data in pages of 100 rows with a 500ms pause between pages. The `resolveRelationTitles` function caches its DB title map for 2 minutes per warm Netlify instance, so only the first page in a session pays the full lookup cost (~4–5 Notion sub-calls); subsequent pages cost 1 call each.

If the Notion status page ([notion-status.com](https://www.notion-status.com)) shows an active incident, the cockpit will fall back to demo data automatically.

---

## Data Structure — ADL Valid Row (Make ID: 455340)

Used by the JSON Parse module (Module 20) in Scenario A. Fields:

`date`, `day`, `client`, `project`, `item_no`, `category`, `variation`, `description`, `hours`, `person`, `week_commencing`, `person_id`, `client_id`, `item_id`, `import_status`
