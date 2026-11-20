/**
 * config — shared settings for every browser.
 *
 * The Make webhook links used to be pasted into each browser's Settings panel
 * and saved in that browser only, so two people could see different behaviour
 * from the same site. They now live in Netlify environment variables and are
 * served from here, so every browser gets the same links.
 *
 * Netlify → Site configuration → Environment variables:
 *   SCAN_WEBHOOK_URL      Make Scenario B (list Inbox + Needs Review)
 *   WRITE_WEBHOOK_URL     Make Scenario A (full import)
 *   VALIDATE_WEBHOOK_URL  Make Scenario C (pre-validate one file)
 *   NOTION_PROXY_URL      optional; defaults to the built-in notion-proxy function
 *
 * These links are called directly from the browser, so they are not secret
 * from anyone using the site; keeping them here keeps them out of the public
 * GitHub repo and in one place. Secrets (NOTION_TOKEN etc.) are never returned.
 */
exports.handler = async () => {
  const pick = (k) => (process.env[k] || '').trim();
  const body = {
    scanUrl: pick('SCAN_WEBHOOK_URL'),
    writeUrl: pick('WRITE_WEBHOOK_URL'),
    validateUrl: pick('VALIDATE_WEBHOOK_URL'),
    proxyUrl: pick('NOTION_PROXY_URL'),
  };
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Short cache so a change in Netlify reaches everyone within a minute.
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
};
