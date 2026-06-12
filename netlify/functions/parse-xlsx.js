/**
 * XLSX → CSV Converter — Netlify Function
 *
 * Accepts a base64-encoded XLSX file from Make.com and returns
 * the data rows as a CSV string so Claude can read them as plain text.
 *
 * Designed for the DKH controlled timesheet template:
 *   Row 1: Title
 *   Row 2: Name: [value]
 *   Row 3: Wk Commencing: [date]   ISO Week: [auto]
 *   Row 4: Instructions note
 *   Row 5: Headers — #, Day, Date, Client, Project Reference, Item No., Category, Variation? (Y/N), Description, Hours
 *   Rows 6+: Data
 *
 * Called by Make as POST /.netlify/functions/parse-xlsx
 * Body: { data: "<base64 string>", filename: "file.xlsx" }
 * Returns: { csv: "...", rows: 12, person: "Greig Fensome", week_commencing: "2026-06-02", filename }
 */

const XLSX = require('xlsx');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let base64Data, filename;

  const contentType = (event.headers['content-type'] || '').toLowerCase();

  if (event.isBase64Encoded) {
    // Netlify received binary body and auto-encoded it as base64 — use directly.
    // This happens when Make sends the raw XLSX binary (even with text/plain content-type).
    base64Data = event.body;
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else if (contentType.includes('text/plain')) {
    // Plain-text body: the entire body is the base64-encoded file.
    // Strip any whitespace/newlines that Make's encodeBase64() may have added.
    base64Data = (event.body || '').replace(/\s+/g, '');
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else if (contentType.includes('application/octet-stream')) {
    base64Data = event.body;
    filename = event.queryStringParameters?.filename || 'file.xlsx';
  } else {
    // JSON body: { data: "<base64 string>", filename: "..." }
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }
    base64Data = (body.data || '').replace(/\s+/g, '');
    filename = body.filename || 'file.xlsx';
  }

  if (!base64Data) {
    return respond(400, { error: 'Missing file data — send as text/plain body (base64) or JSON { data: "<base64>" }' });
  }

  try {
    // Decode base64 → Buffer → workbook
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    // Use first sheet that isn't _Lists or Instructions
    const sheetName = workbook.SheetNames.find(
      (n) => !['_Lists', 'Instructions', '_lists', 'instructions'].includes(n)
    ) || workbook.SheetNames[0];

    const sheet = workbook.Sheets[sheetName];

    // Convert to array of arrays
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,
      dateNF: 'YYYY-MM-DD',
    });

    if (!rows || rows.length === 0) {
      return respond(200, { csv: '', rows: 0, sheet: sheetName, filename });
    }

    // Extract metadata from header rows (DKH template structure)
    // Row 2 (index 1): ["Name:", <value>, ...]
    // Row 3 (index 2): ["Wk Commencing:", <date>, ..., "ISO Week", <value>]
    let person = null;
    let weekCommencing = null;

    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const r = rows[i];
      const label = String(r[0] || '').trim().toLowerCase();
      if (label === 'name:') {
        person = String(r[1] || '').trim() || null;
      }
      if (label === 'wk commencing:') {
        weekCommencing = String(r[1] || '').trim() || null;
      }
    }

    // Fall back to extracting person from filename: YYYY-WXX_FirstnameSurname.xlsx
    if (!person && filename) {
      const match = filename.replace(/\.xlsx$/i, '').match(/^\d{4}-W\d+_(.+)$/i);
      if (match) {
        person = match[1].replace(/_/g, ' ');
      }
    }

    // Find header row — the row containing "Day" and "Hours"
    let headerRowIdx = 4; // default for DKH template
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const cells = rows[i].map((c) => String(c).trim().toLowerCase());
      if (cells.includes('day') && cells.includes('hours')) {
        headerRowIdx = i;
        break;
      }
    }

    const headers = rows[headerRowIdx].map((h) => String(h).trim());
    const dataRows = rows.slice(headerRowIdx + 1).filter((row) =>
      row.some((cell) => String(cell).trim().length > 0)
    );

    // Build CSV
    const csvLines = [headers.join(',')];
    for (const row of dataRows) {
      const cells = headers.map((_, i) => {
        const val = String(row[i] ?? '').trim().replace(/"/g, '""');
        return val.includes(',') || val.includes('\n') || val.includes('"')
          ? `"${val}"`
          : val;
      });
      csvLines.push(cells.join(','));
    }

    const csv = csvLines.join('\n');

    // Pre-escaped version safe for embedding directly inside a JSON string literal
    // (used by Make.com's Raw body HTTP module which can't run char() in formulas)
    const csvEscaped = csv
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');

    return respond(200, {
      csv,
      csv_escaped: csvEscaped,
      rows: dataRows.length,
      person,
      week_commencing: weekCommencing,
      sheet: sheetName,
      filename,
    });
  } catch (err) {
    return respond(500, { error: 'Failed to parse XLSX', detail: err.message });
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
