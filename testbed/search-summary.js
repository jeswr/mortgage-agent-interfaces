#!/usr/bin/env node
// search-scale: per arm and N, medians and correct-choice rate; least-squares growth per extra lender over all runs.
'use strict';
const fs = require('fs'); const path = require('path'); const { readJsonl } = require('./llm');
const ROOT = path.resolve(__dirname, '..');
const runs = readJsonl(path.join(ROOT, 'results', 'runs.jsonl')).filter((r) => /^search-scale-n/.test(r.condition || ''));
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return NaN; const m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; };
const M = { model_requests: (r) => r.model_requests, tokens: (r) => r.tokens.total, list_cost_usd: (r) => r.list_cost_agent_usd, wall_s: (r) => r.wall_s, model_s: (r) => r.model_s,
  web_pages: (r) => r.server.web_pages, api_calls: (r) => r.server.api_calls + r.server.index_queries + (r.code_api_calls ? 0 : 0), tool_calls: (r) => r.tool_calls, code_api_calls: (r) => r.code_api_calls || 0, injected_latency_s: (r) => r.server.injected_latency_s };
function slope(xs, ys) { const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0; let sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } return sxx ? sxy / sxx : NaN; }
const rows = [['arm', 'N', 'n', 'correct', ...Object.keys(M).map((k) => `${k}_median`)].join(',')]; const grow = [['arm', ...Object.keys(M).map((k) => `${k}_per_extra_lender`), 'index_build_ms_median_by_N'].join(',')];
for (const arm of ['A', 'C1', 'C-RDF', 'C2']) {
  const g = runs.filter((r) => r.arm === arm); if (!g.length) continue;
  for (const N of [...new Set(g.map((r) => r.search_n))].sort((a, b) => a - b)) { const h = g.filter((r) => r.search_n === N); rows.push([arm, N, h.length, `${h.filter((r) => r.correct).length}/${h.length}`, ...Object.values(M).map((f) => +med(h.map(f)).toFixed(3))].join(',')); }
  const idx = [...new Set(g.map((r) => r.search_n))].sort((a, b) => a - b).map((N) => `N${N}:${med(g.filter((r) => r.search_n === N && r.index).map((r) => r.index.build_ms))}`).join(' ');
  grow.push([arm, ...Object.values(M).map((f) => +slope(g.map((r) => r.search_n), g.map(f)).toFixed(4)), idx].join(','));
}
fs.writeFileSync(path.join(ROOT, 'results', 'search-summary.csv'), rows.join('\n') + '\n\n' + grow.join('\n') + '\n');
console.log(rows.join('\n')); console.log(); console.log(grow.join('\n'));
