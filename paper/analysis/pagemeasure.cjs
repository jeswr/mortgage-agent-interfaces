// Load time, transfer size, request count and accessibility-snapshot size for a list of URLs, one attempt each.
// Usage: node pagemeasure.cjs <out.json> <url>...   (uses the playwright-core that @playwright/mcp@0.0.83 ran with)
const { chromium } = require(process.env.HOME + '/.npm/_npx/381cec31605a419a/node_modules/playwright-core');
const fs = require('fs');
(async () => {
  const [out, ...urls] = process.argv.slice(2); const res = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
  for (const u of urls) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
    let n = 0; page.on('request', () => n++);
    const t0 = Date.now(); let status = null; let err = null;
    try { const r = await page.goto(u, { waitUntil: 'load', timeout: 45000 }); status = r && r.status(); } catch (e) { err = String(e.message).split('\n')[0]; }
    const tLoad = (Date.now() - t0) / 1000;
    let nav = null, bytes = null, snap = '';
    try {
      nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint'); return n ? { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: p ? p.startTime : null, doc_bytes: n.transferSize } : null; });
      bytes = await page.evaluate(() => performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) + (performance.getEntriesByType('navigation')[0] || {}).transferSize);
      snap = await page.locator('body').ariaSnapshot({ timeout: 15000 });
    } catch (e) { err = err || String(e.message).split('\n')[0]; }
    res.push({ url: u, status, err, wall_load_s: tLoad, requests: n, transfer_bytes: bytes, nav, snapshot_chars: snap.length, title: await page.title().catch(() => '') });
    console.log(JSON.stringify(res[res.length - 1]));
    await ctx.close();
  }
  await browser.close(); fs.writeFileSync(out, JSON.stringify(res, null, 1));
})();
