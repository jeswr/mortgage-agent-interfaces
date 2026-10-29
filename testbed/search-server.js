#!/usr/bin/env node
// "search-scale" testbed: a public registry of N licensed lenders, each lender's website and rates page (4 layouts,
// grounded page weight and latency), each lender's common agent API (products.list), and a pre-computed SPARQL index
// (@sparq-org/sparq) of every lender's schema.org JSON-LD. Index build time is measured at start-up, outside the run.
// Usage: node search-server.js <port> <runDir> <N>
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const S = require('./search-data');
const PORT = Number(process.argv[2]); const RUN_DIR = process.argv[3]; const N = Number(process.argv[4]);
fs.mkdirSync(RUN_DIR, { recursive: true });
const G = S.generate(N); const BY = Object.fromEntries(G.lenders.map((l) => [l.slug, l]));
const LOG = path.join(RUN_DIR, 'server-requests.jsonl'); const STATE = path.join(RUN_DIR, 'state.json');
const state = { condition: 'search-scale', N, answer: G.answer, index: null, products_list_calls: {}, pages: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => v.toFixed(3) + '%';
const base = `http://127.0.0.1:${PORT}`;
// Each lender's website is its own origin (<slug>.localhost, which Chromium resolves to loopback), so in-page scripts on one
// site cannot read another lender's pages (same-origin policy), as on the real web. APIs and the index stay on 127.0.0.1.
const site = (l) => `http://${l.slug}.localhost:${PORT}`;
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((x) => x[0]));

// Boilerplate sized like real pages (accessibility snapshots ~12k characters, as in the grounded condition).
function boiler(title) {
  const menus = { 'Buy a home': ['Mortgage basics', 'First-time buyers', 'How much can I afford?', 'Prequalification', 'Down payment help', 'Closing costs explained', 'Home buying checklist', 'Find a loan officer', 'Find a real estate agent', 'Calculators'],
    'Refinance': ['Refinance rates', 'Cash-out refinance', 'Rate-and-term refinance', 'Refinance calculator', 'When to refinance', 'Streamline programs', 'Refinance checklist', 'Break-even estimator'],
    'Loan options': ['30-year fixed', '20-year fixed', '15-year fixed', 'Adjustable-rate (ARM)', 'FHA loans', 'VA loans', 'USDA loans', 'Jumbo loans', 'Construction loans', 'Renovation loans', 'Second homes', 'Investment property'],
    'Rates & tools': ['Today\'s rates', 'Rate alerts', 'Affordability calculator', 'Payment calculator', 'Amortization schedule', 'Rent vs. buy', 'Points calculator', 'Closing cost estimator'],
    'Resources': ['Learning center', 'Glossary', 'Loan process timeline', 'Document checklist', 'Credit score guide', 'Homeowners insurance', 'Property taxes', 'Help center', 'Contact us'] };
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const mega = Object.entries(menus).map(([h, it]) => `<li><span>${esc(h)}</span><ul>${it.map((t) => `<li><a href="#${slug(t)}">${esc(t)}</a></li>`).join('')}</ul></li>`).join('');
  const quick = ['Make a payment', 'Check application status', 'Upload documents', 'Message us', 'Find forms', 'Rates', 'Calculators', 'Security tips', 'Schedule an appointment', 'Locations', 'Careers', 'Espanol'].map((t) => `<li><a href="#${slug(t)}">${esc(t)}</a></li>`).join('');
  const promos = [['Lock your rate for 60 days', 'Shop for your next home with confidence. Our extended rate lock protects you if rates rise while you house hunt. Conditions apply.'], ['Closing cost credit up to $1,500', 'Eligible first-time buyers can receive a lender credit toward closing costs on purchase loans that close by December 31, 2026.'], ['Talk to a loan officer', 'Get answers about loan options, rates and the documents you will need. Appointments are available evenings and weekends.']]
    .map(([h, t]) => `<section aria-label="${esc(h)}"><h2>${esc(h)}</h2><p>${esc(t)}</p><a href="#more">Learn more</a></section>`).join('');
  const cols = { 'About us': ['Our story', 'Leadership', 'Newsroom', 'Careers', 'Community giving', 'Investor relations', 'Sustainability'], 'Help & support': ['Help center', 'Contact us', 'Security center', 'Report fraud', 'Accessibility', 'Site map', 'Feedback'],
    'Legal': ['Privacy notice', 'Online privacy', 'Cookie preferences', 'Terms of use', 'Your California privacy choices', 'Do not sell or share my information', 'Licenses and disclosures', 'Notice of data collection'], 'Connect': ['Facebook', 'Instagram', 'LinkedIn', 'YouTube', 'X', 'Blog'] };
  const fcols = Object.entries(cols).map(([h, it]) => `<div><h3>${esc(h)}</h3><ul>${it.map((t) => `<li><a href="#${slug(t)}">${esc(t)}</a></li>`).join('')}</ul></div>`).join('');
  const legal = `<p>${esc(title)} is an Equal Housing Lender. Licensed by the Oregon Division of Financial Regulation. Rates, terms and programs are subject to change without notice and are subject to credit approval and property eligibility. Not all applicants will qualify. Advertised figures assume a loan amount of $440,000, a purchase price of $550,000, a credit score of 760 or higher, and a primary residence. Your actual rate, payment and costs could be higher. Get an official Loan Estimate before choosing a loan.</p><p>The annual percentage rate (APR) reflects the interest rate plus certain fees. This site is not an offer to lend. Information and tools are provided for educational purposes only.</p>`;
  return { top: `<div><a href="#loc">Locations</a> <a href="#contact">Contact us</a> <form role="search" style="display:inline"><label>Search <input type="search"></label> <button type="button">Search</button></form></div><nav aria-label="Main menu"><ul>${mega}</ul></nav><nav aria-label="Quick links"><ul>${quick}</ul></nav>`, promos, footer: `<div>${fcols}</div>${legal}` };
}
function page(title, body, req, consentScope, jsonld) {
  const b = boiler(title); const c = cookies(req); const needBanner = consentScope && !c[`consent_${consentScope}`];
  const banner = needBanner ? `<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center"><div role="dialog" aria-label="Cookie preferences" style="background:#fff;padding:18px;max-width:640px"><h2>We value your privacy</h2><p>We use cookies to keep the site working and, with your permission, for analytics and marketing.</p><form method="post" action="${req.url.split('?')[0].replace(/\/[^/]*$/, '')}/consent"><input type="hidden" name="next" value="${esc(req.url)}"><button name="choice" value="all">Accept all cookies</button> <button name="choice" value="essential">Reject non-essential</button></form></div></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}</head><body><div>${b.top}</div><header><strong>${esc(title)}</strong></header><main>${body}<aside aria-label="Offers">${b.promos}</aside></main><footer>${b.footer}</footer>${banner}</body></html>`;
}
const CTX = { schema: 'https://schema.org/', aw: 'https://w3id.org/agentweb-testbed#' };
const MA = (v) => ({ '@type': 'schema:MonetaryAmount', 'schema:value': v, 'schema:currency': 'USD' });
function productsLd(l) {
  const u = site(l);
  return { '@context': CTX, '@graph': [{ '@id': `${u}/#org`, '@type': 'schema:FinancialService', 'schema:name': l.name, 'schema:url': `${u}/` }, ...l.products.map((x) => ({ '@id': `${u}/rates#${x.product_code}`, '@type': 'schema:MortgageLoan', 'schema:name': x.name, 'schema:identifier': x.product_code,
    'schema:provider': { '@id': `${u}/#org` }, 'schema:loanTerm': { '@type': 'schema:QuantitativeValue', 'schema:value': x.term_years, 'schema:unitCode': 'ANN' }, 'schema:interestRate': x.rate_percent, 'schema:annualPercentageRate': x.apr_percent,
    'aw:rateType': x.rate_type, 'aw:discountPoints': x.discount_points, 'aw:exampleLoanAmount': MA(x.example_loan_amount), 'aw:estimatedMonthlyPayment': MA(x.estimated_monthly_payment), 'aw:estimatedClosingCosts': MA(x.estimated_closing_costs) }))] };
}
function ratesBody(l) {
  const P = l.products; const note = '<p>Example for a $440,000 loan on a $550,000 purchase (20% down), primary residence, excellent credit. Monthly payment includes estimated property taxes and homeowner\'s insurance. Rates as of 2026-10-29.</p>';
  if (l.layout === 0) return `${note}<table><tr><th>Product</th><th>Rate</th><th>APR</th><th>Points</th><th>Est. closing costs</th><th>Est. monthly payment</th></tr>${P.map((x) => `<tr><td>${x.name}</td><td>${pct(x.rate_percent)}</td><td>${pct(x.apr_percent)}</td><td>${x.discount_points}</td><td>${money(x.estimated_closing_costs)}</td><td>${money(x.estimated_monthly_payment)}</td></tr>`).join('')}</table>`;
  if (l.layout === 1) return `<h2>Today's rates</h2>${P.map((x) => `<div><h3>${x.name}</h3><p><b>${pct(x.rate_percent)}</b> rate &middot; ${pct(x.apr_percent)} APR</p><ul><li>${x.discount_points ? x.discount_points + ' discount points' : 'No discount points'}</li><li>Estimated closing costs: ${money(x.estimated_closing_costs)}</li><li>Estimated payment: ${money(x.estimated_monthly_payment)}/mo</li></ul></div>`).join('')}${note}`;
  if (l.layout === 2) return `<dl>${P.map((x) => `<dt><strong>${x.name}</strong></dt><dd>Interest rate ${pct(x.rate_percent)} (APR ${pct(x.apr_percent)}). ${x.discount_points ? x.discount_points + ' points.' : 'No points.'} For the example loan: about ${money(x.estimated_monthly_payment)} a month including estimated taxes and insurance; estimated closing costs ${money(x.estimated_closing_costs)}.</dd>`).join('')}</dl>${note}`;
  return `${note}${P.map((x) => `<p>Our <em>${x.name}</em> is at ${pct(x.rate_percent)} today, which works out to an APR of ${pct(x.apr_percent)}${x.discount_points ? ` with ${x.discount_points} points paid at closing` : ''}. Budget about ${money(x.estimated_closing_costs)} in closing costs and a monthly payment near ${money(x.estimated_monthly_payment)}.</p>`).join('')}`;
}
const PER = 25;
function directory(req, pg) {
  const pages = Math.ceil(G.lenders.length / PER); const rows = G.lenders.slice((pg - 1) * PER, pg * PER).map((l) => `<tr><td>${esc(l.name)}</td><td>${l.nmls}</td><td>Mortgage lender</td><td>Approved</td><td><a href="${site(l)}/">${site(l)}/</a></td><td>${base}/lenders/${l.slug}/agent/v1/request</td></tr>`).join('');
  return page('Oregon licensed mortgage lenders (NMLS registry)', `<h1>Licensed mortgage lenders: Oregon</h1><p>${G.lenders.length} companies hold an active Oregon mortgage lender license.</p><table><tr><th>Company</th><th>NMLS ID</th><th>License type</th><th>Status</th><th>Website</th><th>Agent API endpoint</th></tr>${rows}</table><p>Page ${pg} of ${pages} ${pg < pages ? `<a href="/directory?page=${pg + 1}">Next page</a>` : ''} ${pg > 1 ? `<a href="/directory?page=${pg - 1}">Previous page</a>` : ''}</p>`, req, 'registry');
}
let idx = null;
async function buildIndex() {
  const t0 = Date.now(); const jsonld = require('jsonld'); const { SparqStore } = await import('@sparq-org/sparq'); let nq = ''; let n = 0;
  for (const l of G.lenders) {
    const html = await new Promise((resolve) => http.get(`${base}/lenders/${l.slug}/rates`, { headers: { 'x-crawler': 'rates-index' } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c).toString())); }));
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html); n++;
    nq += (await jsonld.toRDF(JSON.parse(m[1]), { format: 'application/n-quads' })).replace(/_:b(\d+)/g, `_:l${n}b$1`);
  }
  idx = await SparqStore.fromString(nq, 'ntriples');
  state.index = { engine: '@sparq-org/sparq@0.1.5', pages_crawled: n, triples: nq.trim().split('\n').length, build_ms: Date.now() - t0 }; save();
}
const DELAY = { nav: 1850, post: 670, api: 300 };
http.createServer(async (req, res) => {
  const u = new URL(req.url, base); const p = u.pathname; const t0 = Date.now(); let delay = 0; let iface = 'web';
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (code, b, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(b); };
  const json = (code, o) => send(code, JSON.stringify(o, null, 1), 'application/json');
  res.on('finish', () => fs.appendFileSync(LOG, JSON.stringify({ ts: new Date(t0).toISOString(), host: req.headers.host, method: req.method, path: p, iface, status: res.statusCode, ms: Date.now() - t0, delay_ms: delay }) + '\n'));
  if (/\/agent\/v1\//.test(p) || p.startsWith('/index/') || p === '/directory.json') iface = p.startsWith('/index/') ? 'index' : 'agent';
  if (req.headers['x-crawler']) iface = 'crawl';
  if (p === '/favicon.ico') { iface = 'asset'; return send(204, ''); }
  if (iface !== 'crawl') { delay = iface === 'web' ? (req.method === 'POST' ? DELAY.post : DELAY.nav) : DELAY.api; await new Promise((r) => setTimeout(r, delay)); }
  let m;
  const hostSlug = (/^([a-z0-9-]+)\.localhost(:\d+)?$/.exec(req.headers.host || '') || [])[1];
  if (hostSlug && BY[hostSlug]) { // a lender's own website
    const l = BY[hostSlug];
    if (p === '/consent' && req.method === 'POST') { const f = Object.fromEntries(new URLSearchParams(body.toString())); res.writeHead(303, { location: f.next && f.next.startsWith('/') ? f.next : '/', 'set-cookie': `consent_${l.slug}=${f.choice === 'all' ? 'all' : 'essential'}; Path=/` }); return res.end(); }
    if (p === '/') { state.pages[l.slug] = (state.pages[l.slug] || 0) + 1; save(); return send(200, page(l.name, `<h1>${esc(l.name)}</h1><p>NMLS ID ${l.nmls}. Home loans for Oregon families since 19${50 + (l.nmls % 50)}.</p><p><a href="/rates">See today's mortgage rates</a></p>`, req, l.slug)); }
    if (p === '/rates') return send(200, page(`${l.name}: mortgage rates`, ratesBody(l), req, l.slug, productsLd(l)));
    return send(404, page(l.name, '<p>Page not found.</p>', req, l.slug));
  }
  if (p === '/directory' || p === '/') return send(200, directory(req, Math.max(1, Number(u.searchParams.get('page') || 1))));
  if ((m = /^\/(?:lenders\/([a-z0-9-]+)\/)?consent$/.exec(p)) && req.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(body.toString())); const scope = m[1] || 'registry';
    res.writeHead(303, { location: f.next && f.next.startsWith('/') ? f.next : '/', 'set-cookie': `consent_${scope}=${f.choice === 'all' ? 'all' : 'essential'}; Path=/` }); return res.end();
  }
  if (p === '/directory/consent' && req.method === 'POST') { const f = Object.fromEntries(new URLSearchParams(body.toString())); res.writeHead(303, { location: f.next || '/directory', 'set-cookie': 'consent_registry=essential; Path=/' }); return res.end(); }
  // Registry on the common agent API (paged), and as JSON for programs.
  if (p === '/registry/agent/v1/request' && req.method === 'POST') {
    let b = {}; try { b = JSON.parse(body.toString() || '{}'); } catch (e) { /* */ }
    if (b.operation !== 'registry.list') return json(400, { ok: false, error: 'unknown operation; use registry.list' });
    const pg = Math.max(1, Number((b.params || {}).page || 1)); const per = 50; const pages = Math.ceil(G.lenders.length / per);
    return json(200, { ok: true, total: G.lenders.length, page: pg, pages, lenders: G.lenders.slice((pg - 1) * per, pg * per).map((l) => ({ name: l.name, nmls_id: l.nmls, website: `${site(l)}/`, agent_api: `${base}/lenders/${l.slug}/agent/v1/request` })) });
  }
  if (p === '/registry/agent/v1/describe') return json(200, { organization: 'oregon-nmls-registry', operations: { 'registry.list': { params: { page: 'number, 50 lenders per page' }, returns: '{ total, page, pages, lenders: [ { name, nmls_id, website, agent_api } ] }', auth: 'public' } } });
  if ((m = /^\/lenders\/([a-z0-9-]+)\/(rates|agent\/v1\/request|agent\/v1\/describe)?$/.exec(p))) {
    const l = BY[m[1]]; if (!l) return send(404, page('Not found', '<p>Not found</p>', req));
    if ((!m[2] || m[2] === 'rates') && !req.headers['x-crawler']) return send(404, page('Not found', '<p>Not found</p>', req));
    if (!m[2]) { state.pages[l.slug] = (state.pages[l.slug] || 0) + 1; save(); return send(200, page(l.name, `<h1>${esc(l.name)}</h1><p>NMLS ID ${l.nmls}. Home loans for Oregon families since 19${50 + (l.nmls % 50)}.</p><p><a href="/lenders/${l.slug}/rates">See today's mortgage rates</a></p>`, req, l.slug)); }
    if (m[2] === 'rates') return send(200, page(`${l.name}: mortgage rates`, ratesBody(l), req, l.slug, productsLd(l)));
    if (m[2] === 'agent/v1/describe') return json(200, { organization: l.slug, name: l.name, request: 'POST with JSON { operation, params }', operations: { 'products.list': { params: {}, auth: 'public, no permission_token needed', returns: '{ products: [ { product_code, name, term_years, rate_type, rate_percent, apr_percent, discount_points, example_loan_amount, estimated_monthly_payment, estimated_closing_costs } ] }' } } });
    let b = {}; try { b = JSON.parse(body.toString() || '{}'); } catch (e) { /* */ }
    if (b.operation !== 'products.list') return json(400, { ok: false, error: 'unknown operation' });
    state.products_list_calls[l.slug] = (state.products_list_calls[l.slug] || 0) + 1; save();
    return json(200, { ok: true, organization: l.name, as_of: '2026-10-29', products: l.products });
  }
  if (p === '/index/sparql') {
    try { const sols = idx.querySolutions(body.toString('utf8') || u.searchParams.get('query') || ''); const vars = sols.length ? [...sols[0].keys()] : [];
      return json(200, { head: { vars }, results: { bindings: sols.map((s0) => Object.fromEntries([...s0].map(([k, t]) => [k, { type: t.termType === 'NamedNode' ? 'uri' : 'literal', value: t.value }]))) } });
    } catch (e) { return json(400, { error: 'query failed', detail: String(e.message || e).slice(0, 400) }); }
  }
  return send(404, page('Not found', '<p>Page not found.</p>', req));
}).listen(PORT, '127.0.0.1', async () => { await buildIndex(); save(); console.log(`search testbed up: N=${N} ${base}/directory index_build_ms=${state.index.build_ms}`); });
