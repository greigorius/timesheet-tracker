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
      await resolveRelationTitles(data.results, token);
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
      const id = findInIndex(clientIdx, row.client, 'exact');
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
      const id = findInIndex(projectIdx, row.project, 'starts-with');
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
 * Looks up a search value in a name index using progressive matching:
 *   'exact'       -- case-insensitive exact
 *   'contains'    -- index key contains the value (for items with project prefixes)
 *   'starts-with' -- index key starts with the value (for project refs like "24-354")
 */
function findInIndex(index, searchValue, matchType) {
  const search = searchValue.trim();
  const lower  = search.toLowerCase();
  const entries = Object.entries(index);

  for (const [key, id] of entries) {
    if (key.toLowerCase() === lower) return id;
  }
  if (matchType === 'contains') {
    for (const [key, id] of entries) {
      if (key.toLowerCase().includes(lower)) return id;
    }
  }
  if (matchType === 'starts-with') {
    for (const [key, id] of entries) {
      if (key.toLowerCase().startsWith(lower)) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RELATION TITLE RESOLUTION (query mode)
// ---------------------------------------------------------------------------

async function resolveRelationTitles(pages, token) {
  const relIds = new Set();
  pages.forEach(page => {
    Object.values(page.properties || {}).forEach(prop => {
      if (prop.type === 'relation') {
        (prop.relation || []).forEach(rel => relIds.add(rel.id));
      }
    });
  });

  if (!relIds.size) return;

  const titleMap = {};
  await Promise.allSettled(
    [...relIds].map(async id => {
      try {
        const r = await fetch('https://api.notion.com/v1/pages/' + id, {
          headers: notionHeaders(token),
        });
        if (!r.ok) return;
        const p = await r.json();
        const titleProp = Object.values(p.properties || {}).find(v => v.type === 'title');
        titleMap[id] = (titleProp && titleProp.title && titleProp.title[0] && titleProp.title[0].plain_text) || id;
      } catch { /* silently skip */ }
    })
  );

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
