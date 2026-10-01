/**
 * Pre-validate — Netlify Function
 *
 * Validates an XLSX timesheet file before import. Called by Make Scenario C
 * after it downloads the file from Dropbox.
 *
 * Checks:
 *   1. Filename format  — YYYY-WNN_Name.xlsx
 *   2. Blank cells      — columns D (Client), E (Project Ref), F (Item No.)
 *   3. Date format      — column C must be YYYY-MM-DD
 *   4. Person           — name resolved against Notion People database
 *   5. Client           — each value fuzzy-matched against Notion Clients database
 *   6. Item             — each value matched against Notion Items database
 *
 * Input (identical to parse-xlsx):
 *   Content-Type: text/plain, body = base64-encoded XLSX bytes
 *   Query:        ?filename=xxx.xlsx
 *
 * Returns:
 *   {
 *     filename, filename_valid, filename_issues[],
 *     person, person_resolved, week_commencing,
 *     total_rows, issue_count,
 *     issues: { blank_client, blank_project, blank_item, bad_date,
 *               unresolved_client, unresolved_item, person_not_found },
 *     rows: [{ row_num, date, client, project, item_no, hours, description, issues[] }]
 *   }
 */

const XLSX = require('xlsx');

const NOTION_VERSION = '2022-06-28';

// ---------------------------------------------------------------------------
// MODULE-LEVEL NOTION CACHE
// Netlify reuses warm function instances — cache indices for 5 min so that
// parallel/rapid validation calls don't each hit the Notion API from scratch.
// ---------------------------------------------------------------------------
let _notionCache = null;
let _notionCacheTs = 0;
const NOTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Mirrors the aliases in notion-proxy.js — keep in sync
const NAME_ALIASES = {
  'xavier querol': 'Xavi Querol',
};

// Valid filename: YYYY-WNN_Name.xlsx (hyphen or underscore separator, name can include spaces)
const FILENAME_RE = /^\d{4}[-_]W\d{1,2}_[A-Za-z][\w\s]*\.xlsx$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) return respond(500, { error: 'NOTION_TOKEN not configured' });

  // ── Read base64 XLSX (mirrors parse-xlsx.js input handling) ────────────────
  let base64Data, filename;
  const contentType = (event.headers['content-type'] || '').toLowerCase();
  const forceRefresh = event.queryStringParameters?.force === '1';

  if (event.isBase64Encoded) {
    base64Data = event.body;
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else if (contentType.includes('text/plain')) {
    base64Data = (event.body || '').replace(/\s+/g, '');
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else if (contentType.includes('application/octet-stream')) {
    base64Data = event.body;
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }
    base64Data = (body.data || '').replace(/\s+/g, '');
    filename = body.filename || event.queryStringParameters?.filename || 'file.xlsx';
  }

  // Manual cache-bust: ?force=1 (used by the UI's ↻ re-validate button) always
  // rebuilds the Notion indices instead of reusing the warm-instance cache.
  if (forceRefresh) {
    _notionCache = null;
    _notionCacheTs = 0;
  }

  if (!base64Data) return respond(400, { error: 'Missing file data' });

  // ── Parse XLSX ─────────────────────────────────────────────────────────────
  let dataRows, person, weekCommencing;
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    const sheetName = workbook.SheetNames.find(
      n => !['_Lists', 'Instructions', '_lists', 'instructions'].includes(n)
    ) || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: '', raw: false, dateNF: 'YYYY-MM-DD',
    });

    // Extract metadata from header rows (DKH template: row 2 = Name, row 3 = Wk Commencing)
    for (let i = 0; i < Math.min(rawRows.length, 6); i++) {
      const r = rawRows[i];
      const label = String(r[0] || '').trim().toLowerCase();
      if (label === 'name:') person = String(r[1] || '').trim() || null;
      if (label === 'wk commencing:') weekCommencing = String(r[1] || '').trim() || null;
    }
    // Fallback: extract person from filename
    if (!person && filename) {
      const m = filename.replace(/\.xlsx$/i, '').match(/^\d{4}[-_]W\d+_(.+)$/i);
      if (m) person = m[1].replace(/_/g, ' ');
    }

    // Find header row (contains "Day" and "Hours")
    let headerRowIdx = 4;
    for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
      const cells = rawRows[i].map(c => String(c).trim().toLowerCase());
      if (cells.includes('day') && cells.includes('hours')) { headerRowIdx = i; break; }
    }

    const headers = rawRows[headerRowIdx].map(h => String(h).trim());
    const colDate    = headers.findIndex(h => h.toLowerCase() === 'date');
    const colClient  = headers.findIndex(h => h.toLowerCase() === 'client');
    const colProject = headers.findIndex(h => /project/i.test(h));
    const colItem    = headers.findIndex(h => /item/i.test(h));
    const colHours   = headers.findIndex(h => h.toLowerCase() === 'hours');
    const colDesc    = headers.findIndex(h => /description/i.test(h));

    // Column B (date) must be non-empty — rows without a date are blank spacers
    const dateColIdx = colDate >= 0 ? colDate : 1;
    const rawDataRows = rawRows.slice(headerRowIdx + 1).filter(row =>
      row.some(cell => String(cell).trim().length > 0) &&
      String(row[dateColIdx] || '').trim().length > 0
    );

    dataRows = rawDataRows.map((r, idx) => ({
      row_num: idx + 1,
      date:        colDate    >= 0 ? String(r[colDate]    || '').trim() : '',
      client:      colClient  >= 0 ? String(r[colClient]  || '').trim() : '',
      project:     colProject >= 0 ? String(r[colProject] || '').trim() : '',
      item_no:     colItem    >= 0 ? String(r[colItem]    || '').trim() : '',
      hours:       colHours   >= 0 ? String(r[colHours]   || '').trim() : '',
      description: colDesc    >= 0 ? String(r[colDesc]    || '').trim() : '',
    }));
  } catch (err) {
    return respond(500, { error: 'Failed to parse XLSX', detail: err.message });
  }

  // ── Filename validation ────────────────────────────────────────────────────
  const filenameIssues = [];
  const filenameValid = FILENAME_RE.test(filename);
  if (!filenameValid) {
    if (!/^\d{4}[-_]W\d{1,2}_/.test(filename)) {
      filenameIssues.push('Missing/invalid year-week prefix — expected YYYY-WNN_');
    }
    const namePart = filename.replace(/^\d{4}[-_]W\d+_/i, '').replace(/\.xlsx$/i, '');
    if (!namePart || !/[A-Za-z]/.test(namePart)) {
      filenameIssues.push('Name portion is missing or not alphabetic');
    }
    if (filenameIssues.length === 0) {
      filenameIssues.push('Expected format: YYYY-WNN_FirstnameLastname.xlsx');
    }
  }

  // ── Notion lookups (cached) ────────────────────────────────────────────────
  const timesheetsDbId = process.env.NOTION_TIMESHEETS_DB;
  const projectsDbId   = process.env.NOTION_PROJECTS_DB;

  let personIdx = {}, clientIdx = {}, itemIdx = [], projectIdx = {};
  let notionAvailable = false;

  const now = Date.now();
  if (_notionCache && (now - _notionCacheTs) < NOTION_CACHE_TTL_MS) {
    // Cache hit — reuse indices
    ({ personIdx, clientIdx, itemIdx, projectIdx } = _notionCache);
    notionAvailable = true;
  } else if (timesheetsDbId) {
    try {
      const schemaRes = await fetch(
        'https://api.notion.com/v1/databases/' + timesheetsDbId,
        { headers: notionHeaders(token) }
      );
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const p = schema.properties || {};
        const personDbId = p.Person && p.Person.relation && p.Person.relation.database_id;
        const clientDbId = p.Client && p.Client.relation && p.Client.relation.database_id;
        const itemDbId   = p.Item   && p.Item.relation   && p.Item.relation.database_id;

        const [pi, ci, ii, pri] = await Promise.all([
          personDbId   ? buildNameIndex(personDbId, token)           : Promise.resolve({}),
          clientDbId   ? buildNameIndex(clientDbId, token)           : Promise.resolve({}),
          itemDbId     ? buildItemIndexWithProjects(itemDbId, token) : Promise.resolve([]),
          projectsDbId ? buildNameIndex(projectsDbId, token)        : Promise.resolve({}),
        ]);
        personIdx  = pi;
        clientIdx  = ci;
        itemIdx    = ii;
        projectIdx = pri;
        notionAvailable = true;
        // Store in module-level cache
        _notionCache = { personIdx, clientIdx, itemIdx, projectIdx };
        _notionCacheTs = Date.now();
      }
    } catch {
      // Notion unavailable — still return structural validation
    }
  }

  // ── Person check ───────────────────────────────────────────────────────────
  const personLookup = NAME_ALIASES[(person || '').toLowerCase()] || person;
  let personResolved = null;
  if (notionAvailable && personLookup) {
    personResolved = !!findInIndex(personIdx, personLookup, 'exact');
  }

  // ── Per-row validation ─────────────────────────────────────────────────────
  let blankClient = 0, blankProject = 0, blankItem = 0, badDate = 0;
  let unresolvedClient = 0, unresolvedItem = 0;

  const validatedRows = dataRows.map(row => {
    const issues = [];

    if (!row.client)  { issues.push('blank_client');  blankClient++; }
    if (!row.project) { issues.push('blank_project'); blankProject++; }
    if (!row.item_no) { issues.push('blank_item');    blankItem++; }

    if (row.date && !ISO_DATE_RE.test(row.date)) {
      issues.push('bad_date'); badDate++;
    }

    if (notionAvailable) {
      if (row.client && Object.keys(clientIdx).length > 0) {
        if (!findInIndex(clientIdx, row.client, 'fuzzy')) {
          issues.push('unresolved_client'); unresolvedClient++;
        }
      }
      if (row.item_no && itemIdx.length > 0) {
        if (!findItemInIndex(itemIdx, row.item_no, row.project, projectIdx)) {
          issues.push('unresolved_item'); unresolvedItem++;
        }
      }
    }

    return { ...row, issues };
  });

  const personNotFound = personResolved === false;
  const issueCount = blankClient + blankProject + blankItem + badDate
                   + unresolvedClient + unresolvedItem
                   + (personNotFound ? 1 : 0)
                   + filenameIssues.length;

  return respond(200, {
    filename,
    filename_valid:  filenameValid,
    filename_issues: filenameIssues,
    person,
    person_resolved: personResolved,
    notion_available: notionAvailable,
    week_commencing: weekCommencing,
    total_rows:  dataRows.length,
    issue_count: issueCount,
    issues: {
      blank_client:      blankClient,
      blank_project:     blankProject,
      blank_item:        blankItem,
      bad_date:          badDate,
      unresolved_client: unresolvedClient,
      unresolved_item:   unresolvedItem,
      person_not_found:  personNotFound,
    },
    rows: validatedRows,
  });
};

// ---------------------------------------------------------------------------
// NOTION HELPERS  (mirrored from notion-proxy.js — keep in sync)
// ---------------------------------------------------------------------------

function notionHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// Single-page fetches (page_size:100) — no pagination loop needed for these
// small databases. Eliminates extra Notion API round-trips per call.
async function buildNameIndex(dbId, token) {
  const index = {};
  let cursor;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetch('https://api.notion.com/v1/databases/' + dbId + '/query', {
      method: 'POST', headers: notionHeaders(token), body: JSON.stringify(payload),
    });
    if (!res.ok) break;
    const data = await res.json();
    for (const page of (data.results || [])) {
      const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
      const name = titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text;
      if (name) index[name.trim()] = page.id;
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return index;
}

async function buildItemIndexWithProjects(dbId, token) {
  const items = [];
  let cursor;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetch('https://api.notion.com/v1/databases/' + dbId + '/query', {
      method: 'POST', headers: notionHeaders(token), body: JSON.stringify(payload),
    });
    if (!res.ok) break;
    const data = await res.json();
    for (const page of (data.results || [])) {
      const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
      const name = titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text;
      if (name) {
        const projectIds = [];
        Object.values(page.properties || {}).forEach(prop => {
          if (prop.type === 'relation') (prop.relation || []).forEach(r => projectIds.push(r.id));
        });
        items.push({ name: name.trim(), id: page.id, projectIds });
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return items;
}

function itemCodePrefix(name) {
  const sep = name.indexOf(' - ');
  return (sep === -1 ? name : name.slice(0, sep)).trim();
}

function findItemInIndex(items, searchValue, projectSearchValue, projectIdx) {
  if (!searchValue) return null;
  const search = searchValue.trim().toLowerCase();

  const passes = [
    item => item.name.toLowerCase() === search,
    item => item.name.toLowerCase().startsWith(search),
    item => itemCodePrefix(item.name).toLowerCase().includes(search),
    item => {
      const prefix = itemCodePrefix(item.name).toLowerCase();
      return prefix.length >= 3 && search.includes(prefix);
    },
  ];

  for (const matchFn of passes) {
    const candidates = items.filter(matchFn);
    if (!candidates.length) continue;
    if (candidates.length === 1) return candidates[0].id;
    if (projectSearchValue && projectIdx) {
      const projId = findInIndex(projectIdx, projectSearchValue, 'contains');
      if (projId) {
        const match = candidates.find(c => c.projectIds.includes(projId));
        if (match) return match.id;
      }
    }
    return candidates[0].id;
  }
  return null;
}

function findInIndex(index, searchValue, matchType) {
  if (!searchValue) return null;
  const search = searchValue.trim();
  const lower  = search.toLowerCase();
  const entries = Object.entries(index);

  for (const [key, id] of entries) { if (key.toLowerCase() === lower) return id; }
  if (matchType === 'exact') return null;

  for (const [key, id] of entries) { if (key.toLowerCase().startsWith(lower)) return id; }
  if (matchType === 'starts-with') return null;

  for (const [key, id] of entries) { if (key.toLowerCase().includes(lower)) return id; }
  if (matchType === 'contains') return null;

  for (const [key, id] of entries) {
    if (key.length >= 3 && lower.includes(key.toLowerCase())) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RESPONSE HELPERS
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
