/**
 * Claude Normaliser — Netlify Function
 *
 * Accepts parsed timesheet data from parse-xlsx and sends it to
 * Anthropic's Claude API for normalisation into structured Notion rows.
 *
 * Keeps the API key server-side and handles all JSON escaping correctly.
 *
 * Environment variables (set in Netlify → Site → Environment Variables):
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *
 * Called by Make as POST /.netlify/functions/claude-parse
 * Body: { csv: "...", person: "Greig Fensome", week_commencing: "2026-06-02", filename: "..." }
 * Returns: { rows: [...], count: 12 }
 *
 * Each row object:
 *   { date, day, client, project, item_no, category, variation, description, hours, person, week_commencing }
 */

const SYSTEM_PROMPT = `You are a timesheet data normaliser for Design Know How (DKH).

You receive a CSV export from a DKH timesheet template. Your job is to parse every data row and return a JSON array of structured objects — one object per row.

The CSV columns are:
  #, Day, Date, Client, Project Reference, Item No., Category, Variation? (Y/N), Description, Hours

Rules:
- Skip any row where Hours is blank or zero
- Dates: output as YYYY-MM-DD
- Day: output the full day name (Monday, Tuesday, etc.)
- Variation: output exactly "Y" or "N" (normalise Yes/yes/y → Y, No/no/n → N, blank → N)
- Hours: output as a number (float)
- All other string fields: trim whitespace, preserve case
- If a field is blank, output null (not empty string)

Output format — return ONLY a raw JSON array, no markdown fences, no explanation:
[
  {
    "date": "2026-06-02",
    "day": "Monday",
    "client": "TMJ Interiors",
    "project": "TMJ-2024-001",
    "item_no": "A1",
    "category": "Design",
    "variation": "N",
    "description": "Schematic design review",
    "hours": 3.5,
    "person": "Greig Fensome",
    "week_commencing": "2026-06-02"
  }
]`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'ANTHROPIC_API_KEY not configured in environment' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { csv, person, week_commencing, filename } = body;

  if (!csv) {
    return respond(400, { error: 'Missing required field: csv' });
  }

  // Build the user message — Node.js handles JSON.stringify escaping correctly
  const userMessage = [
    `Source file: ${filename || 'unknown'}`,
    `Person: ${person || 'unknown'}`,
    `Week commencing: ${week_commencing || 'unknown'}`,
    '',
    csv,
    '',
    'Return ONLY a raw JSON array. No markdown fences, no explanation.',
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return respond(res.status, {
        error: 'Anthropic API error',
        detail: data.error?.message || JSON.stringify(data),
      });
    }

    const text = data.content?.[0]?.text || '';

    // Strip any accidental markdown fences
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let rows;
    try {
      rows = JSON.parse(cleaned);
    } catch {
      return respond(500, {
        error: 'Claude returned invalid JSON',
        raw: text.slice(0, 500),
      });
    }

    if (!Array.isArray(rows)) {
      return respond(500, { error: 'Claude response was not a JSON array', raw: text.slice(0, 500) });
    }

    // Inject person + week_commencing into every row if not already present
    rows = rows.map((row) => ({
      person: person || row.person || null,
      week_commencing: week_commencing || row.week_commencing || null,
      ...row,
    }));

    return respond(200, { rows, rows_json: JSON.stringify(rows), count: rows.length });
  } catch (err) {
    return respond(502, { error: 'Failed to reach Anthropic API', detail: err.message });
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
