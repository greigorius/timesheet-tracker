/**
 * Notion Proxy -- Netlify Function
 *
 * QUERY MODE (default, no action field)
 * Body: { db?: 'timesheets'|'projects', filter?, sorts?, page_size? }
 *
 * VALIDATE-RELATIONS MODE (action: 'validate-relations')
 * Validates a batch of parsed timesheet rows BEFORE writing to Notion.
 * Checks that Person, Client, Item, and Project all exist in their respective
 * Notion databases. Returns resolved page IDs for valid rows so the
 * Make Notion Create module can use them directly.
 *
 * Body: { action: 'validate-relations', rows: [{person, client, item_no, project, ...}] }
 * Returns: { valid_rows, error_rows, valid_count, error_count }
 *
 * Each valid row gains: person_id, client_id, item_id
 * Each error row gains: validation_errors (array of human-readable strings)
 */

const NOTION_VERSION = '2022-06-28';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return respond(500, { error: 'NOTION_TOKEN not configured in environment' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  if (body.action === 'validate-relations') {
    return handleValidateRelations(body, token);
  }

  // Default: database query
  const { db = 'timesheets', ...queryPayload } = body;
  const DB_MAP = {
    timesheets: process.env.NOTION_TIMESHEETS_DB,
    projects:   process.env.NOTION_PROJECTS_DB,
  };
  const databaseId = DB_MAP[db];
  if (!databaseId) {
    return respond(500, { error: 'NOTION_' + db.toUpperCase() + '_DB not configured' });
  }

  try {
    const res = await fetch(
      'https://api.notion.com/v1/databases/' + databaseId + '/query',
      { method: 'POST', headers: notionHeaders(token), body: JSON.stringify(queryPayload) }
    );
    const data = await res.json();
    if (!res.ok) return respond(res.status, data);
    if (data.results && data.results.length > 0) {
      await resolveRelationTitles(data.results, token, databaseId);
    }
    return respond(200, data);
  } catch (err) {
    return respond(502, { error: 'Upstream request failed', detail: err.message });
  }
};

// ---------------------------------------------------------------------------
// VALIDATE-RELATIONS
// ---------------------------------------------------------------------------

async function handleValidateRelations(body, token) {
  const { rows } = body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return respond(400, { error: 'rows must be a non-empty array' });
  }

  const timesheetsDbId = process.env.NOTION_TIMESHEETS_DB;
  const projectsDbId   = process.env.NOTION_PROJECTS_DB;
  if (!timesheetsDbId) {
    return respond(500, { error: 'NOTION_TIMESHEETS_DB not configured' });
  }

  // Discover relation DB IDs from the timesheets schema
  let personDbId, clientDbId, itemDbId;
  try {
    const schemaRes = await fetch(
      'https://api.notion.com/v1/databases/' + timesheetsDbId,
      { headers: notionHeaders(token) }
    );
    if (!schemaRes.ok) return respond(502, { error: 'Failed to fetch timesheets DB schema' });
    const schema = await schemaRes.json();
    const p = schema.properties || {};
    personDbId = p.Person && p.Person.relation && p.Person.relation.database_id;
    clientDbId = p.Client && p.Client.relation && p.Client.relation.database_id;
    itemDbId   = p.Item   && p.Item.relation   && p.Item.relation.database_id;
  } catch (err) {
    return respond(502, { error: 'Schema fetch failed', detail: err.message });
  }

  const missing = [];
  if (!personDbId) missing.push('Person');
  if (!clientDbId) missing.push('Client');
  if (!itemDbId)   missing.push('Item');
  if (missing.length) {
    return respond(500, { error: 'Could not find relation DBs for: ' + missing.join(', ') });
  }

  // Build name->id indexes in parallel
  let personIdx, clientIdx, itemIdx, projectIdx;
  try {
    const results = await Promise.all([
      buildNameIndex(personDbId, token),
      buildNameIndex(clientDbId, token),
      buildNameIndex(itemDbId,   token),
      projectsDbId ? buildNameIndex(projectsDbId, token) : Promise.resolve({}),
    ]);
    personIdx  = results[0];
    clientIdx  = results[1];
    itemIdx    = results[2];
    projectIdx = results[3];
  } catch (err) {
    return respond(502, { error: 'Failed to build lookup indexes', detail: err.message });
  }

  // Validate each row.
  // Hard errors (person/client not found)  → errorRows  (row is NOT imported)
  // Soft warnings (item not found)         → validRows with import_status="Flagged"
  //   The user can manually link the Item in Notion afterwards.
  const validRows  = [];
  const errorRows  = [];

  for (const row of rows) {
    const errors   = [];   // hard failures — row is rejected
    const warnings = [];   // soft warnings — row is imported but flagged
    const out      = Object.assign({}, row);
    out.import_status = ''; // default: no flag

    if (row.person) {
      const id = findInIndex(personIdx, row.person, 'exact');
      if (id) out.person_id = id;
      else errors.push('Person "' + row.person + '" not found in Notion -- add them to the People database first');
    } else {
      errors.push('Row is missing a Person value');
    }

    if (row.client) {
      const id = findInIndex(clientIdx, row.client, 'fuzzy');
      if (id) out.client_id = id;
      else errors.push('Client "' + row.client + '" not found in Notion -- add them to the Clients database first');
    } else {
      errors.push('Row is missing a Client value');
    }

    if (row.item_no) {
      const id = findInIndex(itemIdx, row.item_no, 'contains');
      if (id) {
        out.item_id = id;
      } else {
        // Soft warning: import the row but mark it for manual review
        warnings.push('Item "' + row.item_no + '" not found in Notion -- link it manually or add it to the Items database');
        out.item_id = null;
        out.import_status = 'Flagged';
      }
    } else {
      warnings.push('Row is missing an Item value -- link it manually in Notion');
      out.item_id = null;
      out.import_status = 'Flagged';
    }

    // Project: soft warning only — it populates via rollup from Item relation.
    if (row.project && projectsDbId && Object.keys(projectIdx).length > 0) {
      const id = findInIndex(projectIdx, row.project, 'contains');
      if (!id) {
        warnings.push('Project "' + row.project + '" not found in Notion -- add it to the Projects database first');
      }
    }

    if (errors.length > 0) {
      errorRows.push(Object.assign({}, row, { validation_errors: errors }));
    } else {
      if (warnings.length > 0) out.validation_warnings = warnings;
      validRows.push(out);
    }
  }

  return respond(200, {
    valid_rows:      validRows,
    error_rows:      errorRows,
    valid_count:     validRows.length,
    error_count:     errorRows.length,
    valid_rows_json: JSON.stringify(validRows),
    _debug: {
      person_index_size:  Object.keys(personIdx).length,
      client_index_size:  Object.keys(clientIdx).length,
      item_index_size:    Object.keys(itemIdx).length,
      project_index_size: Object.keys(projectIdx).length,
    },
  });
}

/**
 * Fetches all pages from a Notion database (paginated) and returns
 * a { trimmedTitle: pageId } map.
 */
async function buildNameIndex(dbId, token) {
  const index = {};
  let cursor;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetch(
      'https://api.notion.com/v1/databases/' + dbId + '/query',
      { method: 'POST', headers: notionHeaders(token), body: JSON.stringify(payload) }
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`DB ${dbId} query failed: ${res.status} ${errBody.message || errBody.code || ''}`);
    }
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

/**
 * Looks up a search value in a name index using a progressive cascade.
 * Each match type is a superset of the one before it.
 *
 *   'exact'      — case-insensitive exact only
 *   'starts-with'— + key starts with search  ("24-354" → "24-354 - EIT Auditorium")
 *   'contains'   — + key contains search     ("003" → "SK-003", "EIT Auditorium" → "24-354 - EIT Auditorium")
 *   'fuzzy'      — + search contains key     ("TMJ Interiors" in sheet → "TMJ" in Notion)
 *
 * Call-site usage:
 *   Person  → 'exact'      (names must match)
 *   Client  → 'fuzzy'      ("TMJ" matches "TMJ Interiors" and vice-versa)
 *   Item    → 'contains'   ("003" matches "SK-003")
 *   Project → 'contains'   ("24-354" OR "EIT Auditorium" both match "24-354 - EIT Auditorium")
 */
function findInIndex(index, searchValue, matchType) {
  if (!searchValue) return null;
  const search = searchValue.trim();
  const lower  = search.toLowerCase();
  const entries = Object.entries(index);

  // Pass 1 — exact (case-insensitive)
  for (const [key, id] of entries) {
    if (key.toLowerCase() === lower) return id;
  }
  if (matchType === 'exact') return null;

  // Pass 2 — key starts with search
  //   "24-354" → "24-354 - EIT Auditorium"
  //   "TMJ"    → "TMJ Interiors"
  for (const [key, id] of entries) {
    if (key.toLowerCase().startsWith(lower)) return id;
  }
  if (matchType === 'starts-with') return null;

  // Pass 3 — key contains search
  //   "003"            → "SK-003"
  //   "EIT Auditorium" → "24-354 - EIT Auditorium"
  for (const [key, id] of entries) {
    if (key.toLowerCase().includes(lower)) return id;
  }
  if (matchType === 'contains') return null;

  // Pass 4 — search contains key (fuzzy only, min key length 3 to avoid noise)
  //   "TMJ Interiors" in sheet → "TMJ" in Notion
  for (const [key, id] of entries) {
    if (key.length >= 3 && lower.includes(key.toLowerCase())) return id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// RELATION TITLE RESOLUTION (query mode)
// ---------------------------------------------------------------------------
//
// Strategy: query each related DB once (up to 100 records per page) to build
// an id→name map, then stamp _title onto every relation entry in the results.
// This replaces the old approach of one /v1/pages/{id} call per unique relation
// ID, which could hit 50–100+ calls and blow the 10-second Netlify timeout.
//
async function resolveRelationTitles(pages, token, sourceDbId) {
  // 1. Find which DB IDs appear as relation targets in this DB's schema.
  //    We need the schema to map relation prop → database_id.
  let relDbIds = [];
  try {
    const schemaRes = await fetch('https://api.notion.com/v1/databases/' + sourceDbId, {
      headers: notionHeaders(token),
    });
    if (schemaRes.ok) {
      const schema = await schemaRes.json();
      const seen = new Set();
      Object.values(schema.properties || {}).forEach(prop => {
        const dbId = prop.type === 'relation' && prop.relation && prop.relation.database_id;
        if (dbId && !seen.has(dbId)) { seen.add(dbId); relDbIds.push(dbId); }
      });
    }
  } catch { /* fall through — titleMap stays empty */ }

  if (!relDbIds.length) return;

  // 2. For each related DB, fetch all pages (paginated) and build id→name map.
  const titleMap = {};
  for (const dbId of relDbIds) {
    let cursor;
    do {
      try {
        const payload = { page_size: 100 };
        if (cursor) payload.start_cursor = cursor;
        const r = await fetch('https://api.notion.com/v1/databases/' + dbId + '/query', {
          method: 'POST',
          headers: notionHeaders(token),
          body: JSON.stringify(payload),
        });
        if (!r.ok) break;
        const data = await r.json();
        (data.results || []).forEach(page => {
          const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
          const name = titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text;
          if (name) titleMap[page.id] = name;
        });
        cursor = data.has_more ? data.next_cursor : null;
      } catch { break; }
    } while (cursor);
  }

  if (!Object.keys(titleMap).length) return;

  // 3. Stamp _title onto every relation entry in the returned pages.
  pages.forEach(page => {
    Object.values(page.properties || {}).forEach(prop => {
      if (prop.type === 'relation') {
        (prop.relation || []).forEach(rel => {
          if (titleMap[rel.id]) rel._title = titleMap[rel.id];
        });
      }
    });
  });
}

function notionHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
    body: JSON.stringify(body),
  };
}
