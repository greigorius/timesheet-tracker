/**
 * Notion Proxy — Netlify Function
 *
 * Forwards Notion database queries from the cockpit to api.notion.com.
 * All secrets stay server-side — set in Netlify → Site → Environment Variables:
 *   NOTION_TOKEN          — internal integration token
 *   NOTION_TIMESHEETS_DB  — timesheets database ID
 *   NOTION_PROJECTS_DB    — projects database ID (optional, for future use)
 *
 * Called by the cockpit as POST /.netlify/functions/notion-proxy
 * Body: { db?: 'timesheets'|'projects', filter?: object, sorts?: array, page_size?: number }
 */

const NOTION_VERSION = '2022-06-28';

exports.handler = async (event) => {
  // CORS pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
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
    return respond(500, { error: `NOTION_${db.toUpperCase()}_DB not configured in environment` });
  }

  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(queryPayload),
      }
    );

    const data = await res.json();
    return respond(res.status, data);
  } catch (err) {
    return respond(502, { error: 'Upstream request failed', detail: err.message });
  }
};

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
