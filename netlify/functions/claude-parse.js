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
- The template has a fixed number of rows (e.g. 30). Most may be empty — skip all empty rows wherever they appear (beginning, middle, or end of the data).
- Skip any row where Hours is blank, zero, or non-numeric.
- Skip any row where both Date and Description are blank, regardless of other values.
- Only process rows that contain actual timesheet entries with at least a Date and Hours value.
- Dates: output as YYYY-MM-DD
- Day: output the full day name (Monday, Tuesday, etc.)
- Variation: output exactly "Y" or "N" (normalise Yes/yes/y → Y, No/no/n → N, blank → N)
- Hours: output as a number (float)
- All other string fields: trim whitespace, preserve case
- If a field is blank, output null (not empty string)
- Client, Project Reference, and Item No. are often abbreviated in the XLSX — output them EXACTLY as written, do not expand or guess the full name.
  Examples of valid abbreviations to pass through unchanged:
    Client:   "TMJ"         (may refer to "TMJ Interiors")
    Project:  "24-354"      (may refer to "24-354 - EIT Auditorium")
    Project:  "EIT Auditorium" (may refer to "24-354 - EIT Auditorium")
    Item No.: "003"         (may refer to "SK-003" or "DR-003")
    Item No.: "SK-003"      (exact item code — pass through as-is)

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

function parseCsvText(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; out.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

// Returns an array of normalised rows, or null if the layout isn't recognised.
function parseCsvDeterministic(csv, person, weekCommencing) {
  const table = parseCsvText(csv);
  if (table.length < 1) return null;
  const hdr = table[0].map((h) => h.trim().toLowerCase());
  const idx = (re) => hdr.findIndex((h) => re.test(h));
  const cDay = idx(/^day$/), cDate = idx(/^date$/), cClient = idx(/^client$/),
        cProj = idx(/^project/), cItem = idx(/^item/), cCat = idx(/^category$/),
        cVar = idx(/^variation/), cDesc = idx(/^description$/), cHrs = idx(/^hours$/);
  if ([cDate, cClient, cProj, cItem, cDesc, cHrs].some((i) => i < 0)) return null;

  const val = (r, i) => (i >= 0 && r[i] != null && String(r[i]).trim() !== '' ? String(r[i]).trim() : null);
  const rows = [];
  for (const r of table.slice(1)) {
    const hours = parseFloat(val(r, cHrs));
    if (!isFinite(hours) || hours <= 0) continue;
    const date = val(r, cDate), desc = val(r, cDesc);
    if (!date && !desc) continue;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null; // let the LLM handle odd date formats
    const v = (val(r, cVar) || 'N').toUpperCase();
    rows.push({
      date,
      day: val(r, cDay),
      client: val(r, cClient),
      project: val(r, cProj),
      item_no: val(r, cItem),
      category: val(r, cCat),
      variation: v === 'Y' || v === 'YES' ? 'Y' : 'N',
      description: desc,
      hours,
      person: person || null,
      week_commencing: weekCommencing || null,
    });
  }
  return rows.length ? rows : null;
}

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

  let { csv, person, week_commencing, filename } = body;

  // Accept csv_b64 (base64-encoded CSV) as a safe alternative to raw csv.
  // This avoids Make's template engine corrupting control characters (tabs, etc.)
  // when the CSV is embedded in a raw JSON body template.
  if (!csv && body.csv_b64) {
    try {
      csv = Buffer.from(body.csv_b64, 'base64').toString('utf8');
    } catch {
      return respond(400, { error: 'Invalid csv_b64 — could not decode' });
    }
  }

  if (!csv) {
    return respond(400, { error: 'Missing required field: csv or csv_b64' });
  }

  // ── Fast path: deterministic CSV parse ────────────────────────────────────
  // The CSV comes from parse-xlsx in a fixed, known layout, so no LLM is
  // needed. Calling Claude to re-emit every row as JSON took 30s+ for a full
  // week (35+ rows), blowing Netlify's 26s function limit (504 Gateway
  // Timeout → HTTP 500 in the cockpit). Falls through to the LLM only if the
  // layout is unrecognised or a date is not already ISO.
  try {
    const det = parseCsvDeterministic(csv, person, week_commencing);
    if (det) {
      const rows_json = JSON.stringify(det);
      const rows_b64 = Buffer.from(rows_json).toString('base64');
      return respond(200, { rows: det, rows_json, rows_b64, count: det.length, parsed_by: 'deterministic' });
    }
  } catch { /* fall through to LLM */ }

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
        max_tokens: 8192,
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

    const rows_json = JSON.stringify(rows);
    // rows_b64: base64-encode the JSON so Make's template engine can't corrupt it
    // (direct JSON embedding in Make templates can mangle escaping or truncate large payloads)
    const rows_b64 = Buffer.from(rows_json).toString('base64');
    return respond(200, { rows, rows_json, rows_b64, count: rows.length });
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
