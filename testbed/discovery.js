'use strict';
// Discovery-phase cost (realistic condition): model requests, tokens and time up to the lender choice.
// A tool call is a discovery action if it looks at lender product information:
//   - a rates page (browser URL / http_request URL path /rates),
//   - products.list on the agent API (JSON or JSON-LD), agent/ld describe of a lender, or an index_query.
// The phase is the assistant messages from the first one up to and including the message after the last
// discovery message (that message reads the last discovery result, i.e. makes the choice).
// Tokens come from the proxy (matched by message id); time = proxy start of the first request to the end of the last phase request.
const { readJsonl } = require('./llm');

function isDiscovery(name, input, resultText) {
  const n = name.replace(/^mcp__/, '');
  const urlPath = (u) => { try { return new URL(u).pathname; } catch (e) { return ''; } };
  if (n === 'ld__index_query') return true;
  if (/agent_request$/.test(n)) return input.operation === 'products.list';
  if (/ld_request$/.test(n)) return JSON.stringify(input.request || {}).includes('products.list');
  if (/(agent|ld)_describe$/.test(n)) return ['cml', 'srm'].includes(input.org);
  if (n === 'http__http_request') return urlPath(input.url) === '/rates';
  if (n.startsWith('browser__')) {
    if (input.url && urlPath(input.url) === '/rates') return true;
    const m = /Page URL: (\S+)/.exec(resultText || ''); return !!m && urlPath(m[1]) === '/rates';
  }
  return false;
}

function computeDiscovery(streamFile, proxyFile) {
  const ev = readJsonl(streamFile);
  const results = {}; for (const e of ev) if (e.type === 'user' && Array.isArray(e.message.content)) for (const b of e.message.content) if (b.type === 'tool_result') { const c = b.content; results[b.tool_use_id] = typeof c === 'string' ? c : (c || []).map((x) => x.text || '').join(' '); }
  const order = []; const msgs = {};
  for (const e of ev) if (e.type === 'assistant') {
    const id = e.message.id; if (!msgs[id]) { msgs[id] = { disc: 0, other: 0 }; order.push(id); }
    for (const b of e.message.content || []) if (b.type === 'tool_use') {
      if (/get_authority|get_credentials/.test(b.name)) continue;
      if (isDiscovery(b.name, b.input || {}, results[b.id])) msgs[id].disc++; else msgs[id].other++;
    }
  }
  const last = order.map((id) => msgs[id].disc > 0).lastIndexOf(true);
  if (last < 0) return { discovery_found: false };
  const phase = order.slice(0, Math.min(order.length, last + 2));
  const px = {}; for (const e of readJsonl(proxyFile)) if (e.id) px[e.id] = e;
  const tok = { input: 0, cache_read: 0, cache_creation: 0, output: 0 }; let t0 = null; let t1 = null;
  for (const id of phase) { const p = px[id]; if (!p) continue; const u = p.usage || {}; tok.input += u.input_tokens || 0; tok.cache_read += u.cache_read_input_tokens || 0; tok.cache_creation += u.cache_creation_input_tokens || 0; tok.output += u.output_tokens || 0;
    const s = Date.parse(p.ts); if (t0 === null || s < t0) t0 = s; const e = s + (p.ms || 0); if (t1 === null || e > t1) t1 = e; }
  tok.total = tok.input + tok.cache_read + tok.cache_creation + tok.output;
  return { discovery_found: true, discovery_model_requests: phase.length, discovery_tokens: tok, discovery_s: t0 !== null ? (t1 - t0) / 1000 : null,
    discovery_tool_calls: phase.reduce((a, id) => a + msgs[id].disc, 0), non_discovery_tool_calls_in_phase: phase.reduce((a, id) => a + msgs[id].other, 0) };
}
module.exports = { computeDiscovery };
