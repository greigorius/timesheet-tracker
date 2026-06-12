/**
 * Notion Proxy — Netlify Function
 *
 * Forwards Notion database queries from the cockpit to api.notion.com.
 * All secrets stay server-side — set in Netlify → Site → Environment Variables:
 *   NOTION_TOKEN          — internal integration token
 *   NOTION_TIMESHEETS_DB  — timesheets database ID
 *
 * After the main query, any `relation` properties are resolved to page titles
 * by fetching each related page in parallel and attaching `_title` to each
 * relation entry — e.g. `Client.relation[0]._title = "TMJ Interiors"`.
 *
 * Called by the cockpit as POST /.netlify/functions/notion-proxy
 * Body: { db?: 'timesheets'|'projects', filter?: object, sorts?: array, page_size?: number }
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

  const { db = 'timesheets', ...queryPayload } = body;

  const DB_MAP = {
    timesheets: process.env.NOTION_TIMESHEETS_DB,
    projects:   process.env.NOTION_PROJECTS_DB,
  };
  const databaseId = DB_MAP[db];
  if (!databaseId) {
    return respond(500, { error: `NOTION_${db.toUpperCase()}_DB not configured` });
  }

  try {
    // ── 1. Main database query ──────────────────────────────────
    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify(queryPayload),
      }
    );

    const data = await res.json();
    if (!res.ok) return respond(res.status, data);

    // ── 2. Resolve relation properties → page titles ────────────
    if (data.results && data.results.length > 0) {
      await resolveRelations(data.results, token);
    }

    return respond(200, data);
  } catch (err) {
    return respond(502, { error: 'Upstream request failed', detail: err.message });
  }
};

/**
 * Collects all unique relation page IDs from the result set,
 * fetches their titles in parallel, then attaches `_title` to
 * each relation entry in-place.
 */
async function resolveRelations(pages, token) {
  // Collect unique IDs
  const relIds = new Set();
  pages.forEach(page => {
    Object.values(page.properties || {}).forEach(prop => {
      if (prop.type === 'relation') {
        (prop.relation || []).forEach(rel => relIds.add(rel.id));
      }
    });
  });

  if (!relIds.size) return;

  // Fetch all related pages in parallel (Notion rate limit is generous for parallel reads)
  const titleMap = {};
  await Promise.allSettled(
    [...relIds].map(async id => {
      try {
        const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
          headers: notionHeaders(token),
        });
        if (!r.ok) return;
        const p = await r.json();
        // Title is the first property of type 'title'
        const titleProp = Object.values(p.properties || {}).find(v => v.type === 'title');
        titleMap[id] = titleProp?.title?.[0]?.plain_text || id;
      } catch { /* silently skip unresolvable relations */ }
    })
  );

  // Attach _title to each relation entry in-place
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
    'Authorization': `Bearer ${token}`,
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
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
