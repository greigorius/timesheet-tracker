@echo off
cd /d "%~dp0"
git add netlify/functions/notion-proxy.js netlify/functions/claude-parse.js
git commit -m "fix: embed rows as pre-serialised JSON string to avoid Make array serialisation issue

Make cannot reliably serialise an array-of-collections embedded via {{variable}}
in a raw HTTP body template — it renders as empty string, producing invalid JSON.

Fix: claude-parse now returns rows_json (JSON.stringify of the rows array).
Module 17 embeds {{4.data.rows_json}} (a plain string) which Make substitutes
verbatim, resulting in valid inline JSON.

Also: notion-proxy buildNameIndex now throws on non-200 Notion API responses
(previously silently returned {} causing all rows to fail with 'not found').
Adds _debug index sizes to the 200 response for diagnostics."
git push
echo.
echo Done! Press any key to close.
pause
