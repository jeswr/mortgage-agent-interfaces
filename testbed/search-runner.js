#!/usr/bin/env node
// "search-scale" runs: discovery only, ending at the lender choice, over N registered lenders.
// Usage: node search-runner.js <A|C1|C-RDF|C2> <model> <n> <N> [slot]   (appends to results/runs.jsonl, condition "search-scale-n<N>")
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const { runClaude, parseStream, parseProxy, readJsonl } = require('./llm');
const D = require('./data');
const [arm, model, nStr, NStr, slotStr] = process.argv.slice(2);
if (!['A', 'C1', 'C-RDF', 'C2'].includes(arm)) { console.error('usage: search-runner.js <A|C1|C-RDF|C2> <model> <n> <N> [slot]'); process.exit(2); }
const n = Number(nStr || 1); const N = Number(NStr || 3); const SLOT = Number(slotStr || 0);
const ROOT = path.resolve(__dirname, '..'); const TB = __dirname; const COND = `search-scale-n${N}`;
const PRICE = { input: 2, w5m: 2.5, w1h: 4, read: 0.1, output: 10 };
const listCost = (u) => { const cc = u.cache_creation || {}; const w5 = cc.ephemeral_5m_input_tokens ?? 0; const w1 = cc.ephemeral_1h_input_tokens ?? ((u.cache_creation_input_tokens || 0) - w5); return ((u.input_tokens || 0) * PRICE.input + w5 * PRICE.w5m + w1 * PRICE.w1h + (u.cache_read_input_tokens || 0) * PRICE.read + (u.output_tokens || 0) * PRICE.output) / 1e6; };
const L = D.LIMITS_G;
const HEAD = (dirUrl) => `You are a personal AI agent working for Sam and Nadia Okafor-Reyes, a married couple. Today is 2026-10-29.

Task: they want a 30-year fixed mortgage of $440,000 to buy a $550,000 home at 14 Larch Lane, Cedar Hollow, Oregon. The state's public registry of licensed mortgage lenders lists every lender (see get_credentials). Find the lender whose 30-year fixed offer has the lowest interest rate among the offers whose published figures for this loan fit their limits (see get_authority), and report it with report_choice. Do not apply anywhere and do not contact anyone. Work autonomously; when you have reported the choice, reply with one line naming the lender.`;
const IFACE = {
  A: 'Interface: use the browser_* tools. The registry web page lists each lender\'s website; each lender publishes its current rates on its website.',
  C1: 'Interface: the registry and every lender implement the common agent API. The registry\'s endpoint (operation registry.list) is in get_credentials, and it lists each lender\'s agent API endpoint; products.list on a lender endpoint is public. Use agent_request and agent_describe.',
  'C-RDF': 'Interface: index_query runs SPARQL over a pre-built index of every registered lender\'s published products (schema.org JSON-LD crawled from their rate pages).',
};
const AUTH = { text: `Mortgage search instructions from Sam and Nadia Okafor-Reyes (2026-10-29).\nThe published figures for this loan must fit ALL of these limits:\n- interest rate at most ${L.max_rate_percent}%\n- monthly payment at most $${L.max_monthly_payment.toLocaleString('en-US')}\n- closing costs at most $${L.max_closing_costs.toLocaleString('en-US')}\nOnly 30-year fixed-rate loans. Report the single best lender; do not apply or share any personal data.`, machine_readable: { limits: L, product: { term_years: 30, rate_type: 'fixed' } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmd, args, re) { return new Promise((resolve, reject) => { const ch = spawn(cmd, args, { cwd: TB, stdio: ['ignore', 'pipe', 'pipe'] }); let b = ''; const t = setTimeout(() => reject(new Error(b)), 120000); ch.stdout.on('data', (d) => { b += d; if (re.test(b)) { clearTimeout(t); resolve({ ch, out: b }); } }); ch.stderr.on('data', (d) => { b += d; }); }); }
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function one(i) {
  const seed = `${stamp()}-${COND}-${arm}-${model.replace(/^claude-/, '')}-${i}`; const runDir = path.join(ROOT, 'results', process.env.RAW_DIR || 'raw', seed); const workDir = path.join(runDir, 'work'); fs.mkdirSync(path.join(workDir, 'downloads'), { recursive: true });
  const port = 7100 + SLOT * 20 + 1; const pport = port + 9; const origin = `http://127.0.0.1:${port}`;
  const srv = await start('node', [path.join(TB, 'search-server.js'), String(port), runDir, String(N)], /search testbed up/);
  const proxy = await start('node', [path.join(TB, 'llm-proxy.js'), String(pport), path.join(runDir, 'proxy.jsonl')], /llm-proxy on/);
  fs.writeFileSync(path.join(runDir, 'authority.json'), JSON.stringify(AUTH, null, 1));
  fs.writeFileSync(path.join(runDir, 'credentials.json'), JSON.stringify({ registry: { name: 'Oregon NMLS registry of licensed mortgage lenders', website: `${origin}/directory`, agent_api: `${origin}/registry/agent/v1/request` } }, null, 1));
  const streamFile = path.join(runDir, 'stream.jsonl'); const stderrFile = path.join(runDir, 'stderr.txt'); const t0 = Date.now(); let run = { code: 0, timedOut: false }; let error = null; let codeCalls = 0;
  try {
    if (arm === 'C2') { // deterministic comparison, 0 model calls
      const req = async (ep, operation, params) => { codeCalls++; const r = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, params }) }); return r.json(); };
      const lenders = []; for (let pg = 1; ; pg++) { const j = await req(`${origin}/registry/agent/v1/request`, 'registry.list', { page: pg }); lenders.push(...j.lenders); if (pg >= j.pages) break; }
      const offers = []; for (const l of lenders) { const j = await req(l.agent_api, 'products.list', {}); for (const x of j.products) if (x.term_years === 30 && x.rate_type === 'fixed' && x.rate_percent <= L.max_rate_percent && x.estimated_monthly_payment <= L.max_monthly_payment && x.estimated_closing_costs <= L.max_closing_costs) offers.push({ lender: l.name, ...x }); }
      offers.sort((a, b) => a.rate_percent - b.rate_percent); fs.appendFileSync(path.join(runDir, 'choice.jsonl'), JSON.stringify({ ts: new Date().toISOString(), lender: offers[0].lender, product: offers[0].product_code, rate_percent: offers[0].rate_percent }) + '\n');
    } else {
      const user = { command: 'node', args: [path.join(TB, 'mcp-user.js'), runDir, 'cond=search-scale', 'choice'] };
      const servers = { user };
      if (arm === 'A') servers.browser = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated', '--output-dir', path.join(workDir, 'downloads'), '--allowed-origins', [origin, ...require('./search-data').generate(N).lenders.map((l) => `http://${l.slug}.localhost:${port}`)].join(';'), '--viewport-size', '1280x900'] };
      else servers.search = { command: 'node', args: [path.join(TB, 'mcp-search.js'), runDir, origin, arm === 'C1' ? 'c1' : 'crdf'] };
      const cfg = path.join(runDir, 'mcp-config.json'); fs.writeFileSync(cfg, JSON.stringify({ mcpServers: servers }, null, 1));
      const allowed = ['mcp__user', arm === 'A' ? 'mcp__browser' : 'mcp__search'];
      run = await runClaude({ prompt: `${HEAD()}\n\n${IFACE[arm]}`, model, cwd: workDir, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${pport}` }, streamFile, stderrFile, timeoutMs: 45 * 60000,
        extraArgs: ['--strict-mcp-config', '--mcp-config', cfg, '--tools', '', '--allowedTools', ...allowed, '--disallowedTools', 'mcp__browser__browser_run_code_unsafe', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent', 'Task', '--permission-mode', 'dontAsk'] });
    }
  } catch (e) { error = String(e && e.stack || e); }
  const wall = (Date.now() - t0) / 1000; await sleep(1200); srv.ch.kill('SIGTERM'); proxy.ch.kill('SIGTERM'); await sleep(500);
  if (!fs.existsSync(streamFile)) fs.writeFileSync(streamFile, '');
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')); const choices = readJsonl(path.join(runDir, 'choice.jsonl'));
  const s = parseStream(streamFile, path.join(runDir, 'proxy.jsonl')); const px = readJsonl(path.join(runDir, 'proxy.jsonl')).filter((e) => e.method === 'POST' && /^\/v1\/messages(\?|$)/.test(e.path || ''));
  const ids = new Set(s.message_ids); const res = s.results[s.results.length - 1] || {};
  const chosen = choices.length ? choices[choices.length - 1].lender : null;
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const correct = !!chosen && norm(chosen) === norm(st.answer.name);
  const reqs = readJsonl(path.join(runDir, 'server-requests.jsonl')).filter((r) => r.iface !== 'crawl' && r.iface !== 'asset');
  const procs = readJsonl(path.join(runDir, 'cli-procs.jsonl')); let startup = null; let tail = null;
  if (procs.length && px.length) { const p0 = procs[0]; const ag = px.filter((e) => ids.has(e.id)); startup = (Math.min(...px.map((e) => Date.parse(e.ts))) - Date.parse(p0.start)) / 1000; tail = ag.length ? (Date.parse(p0.end) - Math.max(...ag.map((e) => Date.parse(e.ts) + e.ms))) / 1000 : null; }
  const line = { arm, model, condition: COND, search_n: N, seed, started: new Date(t0).toISOString(), wall_s: wall, timed_out: !!run.timedOut, runtime_error: error || (res.is_error ? res.subtype : null),
    success: correct && !run.timedOut, correct, chosen, answer: st.answer, choices_reported: choices.length,
    model_requests: s.model_requests, tokens: s.tokens, tool_calls: s.tool_calls, tool_calls_by_name: s.tool_calls_by_name, code_api_calls: arm === 'C2' ? codeCalls : null,
    list_cost_agent_usd: px.filter((e) => ids.has(e.id)).reduce((a, e) => a + listCost(e.usage || {}), 0), list_cost_all_api_usd: px.reduce((a, e) => a + listCost(e.usage || {}), 0),
    api_requests_all: px.length, model_s: px.reduce((a, e) => a + (e.ms || 0), 0) / 1000, runtime_startup_s: startup, runtime_tail_s: tail,
    server: { web_pages: reqs.filter((r) => r.iface === 'web' && r.method === 'GET').length, web_posts: reqs.filter((r) => r.iface === 'web' && r.method === 'POST').length, api_calls: reqs.filter((r) => r.iface === 'agent').length, index_queries: reqs.filter((r) => r.iface === 'index').length, injected_latency_s: reqs.reduce((a, r) => a + (r.delay_ms || 0), 0) / 1000 },
    products_list_lenders: Object.keys(st.products_list_calls).length, rate_pages_seen: null, index: st.index, cli_cost_usd: s.results.reduce((a, r) => a + (r.total_cost_usd || 0), 0), final_message: (res.result || '').slice(0, 500) };
  line.rate_pages_seen = new Set(reqs.filter((r) => /\/rates$/.test(r.path)).map((r) => (r.host || '') + r.path)).size;
  fs.appendFileSync(process.env.RESULTS_FILE || path.join(ROOT, 'results', 'runs.jsonl'), JSON.stringify(line) + '\n'); fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(line, null, 1));
  console.log(`${seed}: correct=${correct} chosen=${chosen} req=${line.model_requests} tok=${line.tokens.total} wall=${wall.toFixed(0)}s`);
}
(async () => { for (let i = 1; i <= n; i++) await one(i); })();
