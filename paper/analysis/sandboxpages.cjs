// Same measurements on the sandbox's own pages (server.js started from tmp/ with a scratch run dir), logged in.
// Usage: node sandboxpages.cjs <basePort> <seed> <out.json>
const { chromium } = require(process.env.HOME + '/.npm/_npx/381cec31605a419a/node_modules/playwright-core');
const F = require('../../agentic-web-measurement-20261029/testbed/fixtures.js'); const fs = require('fs');
(async () => {
  const [base, seed, out] = process.argv.slice(2); const B = Number(base); const c = F.credentials(seed).web; const res = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  let n = 0; page.on('request', () => n++);
  async function m(label, fn) { n = 0; const t0 = Date.now(); await fn(); const t = (Date.now() - t0) / 1000; const snap = await page.locator('body').ariaSnapshot(); const bytes = await page.evaluate(() => (performance.getEntriesByType('navigation')[0] || {}).transferSize || null); res.push({ label, url: page.url(), wall_load_s: t, requests: n, doc_bytes: bytes, html_chars: (await page.content()).length, snapshot_chars: snap.length }); }
  const site = (o) => `http://127.0.0.1:${B + o}`;
  // Juniper bank
  await m('bank login page (with cookie overlay)', () => page.goto(site(1) + '/accounts', { waitUntil: 'load' }));
  await page.click('button[value=essential]'); await page.fill('#u', c.jfcu.username); await page.fill('#p', c.jfcu.password);
  await m('bank accounts (after login POST)', () => Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('form[action="/login"] button')]));
  await m('bank account transactions', () => page.goto(site(1) + '/accounts/jfcu-4417', { waitUntil: 'load' }));
  await m('bank statements search', () => page.goto(site(1) + '/statements?account=jfcu-4417&from=2026-08-01&to=2026-10-29', { waitUntil: 'load' }));
  await m('bank statement view', () => page.goto(site(1) + '/statements/JFCU-4417-202609', { waitUntil: 'load' }));
  // Lender
  await page.goto(site(4) + '/dashboard'); await page.click('button[value=essential]'); await page.fill('#u', c.bhl.username); await page.fill('#p', c.bhl.password);
  await m('lender dashboard (after login POST)', () => Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('form[action="/login"] button')]));
  for (const s of ['borrowers', 'income', 'assets', 'property', 'documents', 'review']) await m('lender apply/' + s, () => page.goto(site(4) + '/apply/' + s, { waitUntil: 'load' }));
  await browser.close(); fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
})();
