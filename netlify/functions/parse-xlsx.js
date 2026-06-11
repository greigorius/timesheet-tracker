/**
 * XLSX → CSV Converter — Netlify Function
 *
 * Accepts a base64-encoded XLSX file from Make.com and returns
 * the data rows as a CSV string so Claude can read them as plain text.
 *
 * Called by Make as POST /.netlify/functions/parse-xlsx
 * Body: { data: "<base64 string>", filename: "file.xlsx" }
 * Returns: { csv: "Name,Date,Project,...\nGreig,...", rows: 12 }
 */

const XLSX = require('xlsx');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { data: base64Data, filename = 'file.xlsx' } = body;
  if (!base64Data) {
    return respond(400, { error: 'Missing required field: data (base64 XLSX)' });
  }

  try {
    // Decode base64 → Buffer → workbook
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    // Use first sheet that isn't named _Lists or Instructions
    const sheetName = workbook.SheetNames.find(
      (n) => !['_Lists', 'Instructions', '_lists', 'instructions'].includes(n)
    ) || workbook.SheetNames[0];

    const sheet = workbook.Sheets[sheetName];

    // Convert to array of arrays (raw values, no headers yet)
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,       // return formatted strings, not raw numbers
      dateNF: 'YYYY-MM-DD',
    });

    if (!rows || rows.length === 0) {
      return respond(200, { csv: '', rows: 0, sheet: sheetName });
    }

    // Find the header row — first row where ≥3 cells are non-empty strings
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const nonEmpty = rows[i].filter((c) => String(c).trim().length > 0);
      if (nonEmpty.length >= 3) {
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

    return respond(200, {
      csv,
      rows: dataRows.length,
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
