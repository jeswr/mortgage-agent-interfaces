'use strict';
// "search-scale" condition: N synthetic licensed lenders with varied rate pages and realistic spreads.
// 30-year fixed rates around 7.25% (+/-0.5 pp, 0.125 steps); closing costs 2-4% of the $440,000 loan (+ points);
// payment = P&I + $484 escrow (grounded Oregon averages). Some lenders are traps: the lowest rates carry points whose
// closing costs break the $14,500 limit. Exactly one lender has the lowest fitting rate.
const D = require('./data');
const LOAN = 440000; const ESCROW = D.G_ESCROW; const LIM = D.LIMITS_G;
const r2 = (x) => Math.round(x * 100) / 100;
function pAndI(P, rate, years) { const r = rate / 100 / 12; const n = years * 12; return r2(P * r / (1 - Math.pow(1 + r, -n))); }
function rng(seed) { let a = 0; for (const c of String(seed)) a = (Math.imul(a, 31) + c.charCodeAt(0)) | 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const A1 = ['Cedar', 'Willamette', 'Cascade', 'Summit', 'Harbor', 'Pioneer', 'Juniper', 'Columbia', 'Rogue', 'Alder', 'Bluebird', 'Silver Falls', 'Crater', 'Klamath', 'Siskiyou', 'Tillamook', 'Mt. Hood', 'Deschutes', 'Umpqua', 'Sandy River', 'Coast Range', 'High Desert', 'Evergreen', 'Larch', 'Osprey', 'Steelhead', 'Basalt', 'Timberline', 'Wallowa', 'Owyhee'];
const A2 = ['Home Loans', 'Mortgage', 'Lending', 'Home Finance', 'Mortgage Company', 'Bank Mortgage', 'Credit Union', 'Funding', 'Residential Lending', 'Mortgage Group'];
function product(code, name, term, kind, rate, points, closingPct) {
  const pi = pAndI(LOAN, rate, term); const closing = Math.round((LOAN * closingPct + LOAN * points / 100) / 50) * 50;
  return { product_code: code, name, term_years: term, rate_type: kind, rate_percent: rate, apr_percent: D.aprFor(LOAN, rate, term, r2(LOAN * 0.01 + 1295 + LOAN * points / 100)), discount_points: points,
    example_loan_amount: LOAN, estimated_monthly_payment: r2(pi + ESCROW), estimated_closing_costs: closing };
}
const fits = (p) => p.term_years === 30 && p.rate_type === 'fixed' && p.rate_percent <= LIM.max_rate_percent && p.estimated_monthly_payment <= LIM.max_monthly_payment && p.estimated_closing_costs <= LIM.max_closing_costs;
function generate(N, seed = 'search') {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const R = rng(`${seed}-${N}-${attempt}`); const used = new Set(); const lenders = [];
    for (let i = 0; i < N; i++) {
      let name; do { name = `${A1[Math.floor(R() * A1.length)]} ${A2[Math.floor(R() * A2.length)]}`; } while (used.has(name)); used.add(name);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); const code = slug.split('-').map((w) => w[0]).join('').toUpperCase() + String(i + 1).padStart(2, '0'); const r3 = (x) => Math.round(x * 1000) / 1000;
      const base = 6.75 + Math.round(R() * 8) * 0.125; // 6.75 .. 7.75
      const products = [];
      const trap = R() < 0.2; // cheapest rate bought with points
      if (trap) products.push(product(`${code}-30P`, '30-Year Fixed with points', 30, 'fixed', r3(base - 0.375), 1.5 + Math.round(R() * 2) * 0.5, 0.025 + R() * 0.01));
      products.push(product(`${code}-30`, '30-Year Fixed', 30, 'fixed', base, 0, 0.02 + R() * 0.02));
      if (R() < 0.5) products.push(product(`${code}-15`, '15-Year Fixed', 15, 'fixed', r3(base - 0.75), 0, 0.02 + R() * 0.02));
      if (R() < 0.35) products.push(product(`${code}-76`, '7/6 ARM', 30, 'adjustable', r3(base - 0.625), 0, 0.02 + R() * 0.02));
      lenders.push({ slug, name, nmls: String(400000 + Math.floor(R() * 500000)), layout: i % 4, products, trap });
    }
    const fitting = lenders.flatMap((l) => l.products.filter(fits).map((p) => ({ l, p }))).sort((a, b) => a.p.rate_percent - b.p.rate_percent);
    if (!fitting.length) continue;
    const best = fitting[0]; if (fitting.length > 1 && fitting[1].p.rate_percent === best.p.rate_percent) continue; // exactly one correct answer
    if (!lenders.some((l) => l.trap && l.products.some((p) => p.rate_percent < best.p.rate_percent))) continue; // at least one trap below the answer
    return { N, lenders, answer: { slug: best.l.slug, name: best.l.name, product_code: best.p.product_code, rate_percent: best.p.rate_percent }, attempt };
  }
  throw new Error('could not generate a unique answer');
}
module.exports = { generate, fits, LIM, LOAN };
if (require.main === module) for (const n of [3, 10, 30, 100]) { const g = generate(n); console.log(n, g.answer, 'traps', g.lenders.filter((l) => l.trap).length, 'attempt', g.attempt); }
