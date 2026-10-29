#!/usr/bin/env node
// Runs n fresh, isolated runs of one arm with one model and appends one line per run to results/runs.jsonl.
// Usage: node runner.js <arm: A|B|C1|C2> <model> <n> [slot]
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const D = require('./data');
const F = require('./fixtures');
const { check } = require('./checker');
const { runClaude, parseStream, parseProxy } = require('./llm');
const { runC2 } = require('./c2-orchestrator');
const { runBcode } = require('./bcode-orchestrator');
const { computeDiscovery } = require('./discovery');
const { readJsonl } = require('./llm');
const { runC2Grounded } = require('./c2-grounded');
const { runBcodeGrounded } = require('./bcode-grounded');
// List prices per MTok, Sonnet 5.5 (assumptions.md row 66): input $2, 5-min cache write $2.50, 1-hour write $4, cache read $0.10, output $10.
const PRICE = { input: 2, w5m: 2.5, w1h: 4, read: 0.1, output: 10 };
function listCost(u) {
  const cc = u.cache_creation || {}; const w5 = cc.ephemeral_5m_input_tokens ?? 0; const w1 = cc.ephemeral_1h_input_tokens ?? ((u.cache_creation_input_tokens || 0) - w5);
  return ((u.input_tokens || 0) * PRICE.input + w5 * PRICE.w5m + w1 * PRICE.w1h + (u.cache_read_input_tokens || 0) * PRICE.read + (u.output_tokens || 0) * PRICE.output) / 1e6;
}
// grounded: per-session model metrics, list-price cost, and the wall-time split (model / human / network-server / other).
function groundedMetrics(runDir, sessions, wall, ulog) {
  const px = readJsonl(path.join(runDir, 'proxy.jsonl')).filter((e) => e.method === 'POST' && /^\/v1\/messages(\?|$)/.test(e.path || ''));
  const byId = Object.fromEntries(px.filter((e) => e.id).map((e) => [e.id, e]));
  const per = sessions.map((ss, i) => {
    const st = parseStream(path.join(runDir, ss.stream), path.join(runDir, 'proxy.jsonl')); // missing file -> zero requests
    const ids = new Set(st.message_ids); const agentCost = st.message_ids.reduce((a, id) => a + (byId[id] ? listCost(byId[id].usage || {}) : 0), 0);
    return { session: i + 1, wall_s: ss.wall_s, model_requests: st.model_requests, tokens: st.tokens, tool_calls: st.tool_calls, list_cost_usd: agentCost, timed_out: !!ss.timed_out, note_chars: ss.note_chars, ids };
  });
  const allIds = new Set(per.flatMap((p0) => [...p0.ids]));
  const modelS = px.reduce((a, e) => a + (e.ms || 0), 0) / 1000;
  const humanS = ulog.filter((x) => x.tool === 'human_wait').reduce((a, x) => a + x.s, 0);
  const srv = readJsonl(path.join(runDir, 'server-requests.jsonl')).filter((r) => !['internal', 'crawl', 's2s', 'asset'].includes(r.iface));
  const netS = srv.reduce((a, r) => a + (r.ms || 0), 0) / 1000; const delayS = srv.reduce((a, r) => a + (r.delay_ms || 0), 0) / 1000;
  const sessWall = sessions.reduce((a, x) => a + x.wall_s, 0);
  return { sessions: per.map(({ ids, ...rest }) => rest), wall_sessions_s: sessWall, model_s: modelS, human_s: humanS, network_server_s: netS, injected_latency_s: delayS, other_s: sessWall - modelS - humanS - netS,
    list_cost_agent_usd: px.filter((e) => allIds.has(e.id)).reduce((a, e) => a + listCost(e.usage || {}), 0), list_cost_all_api_usd: px.reduce((a, e) => a + listCost(e.usage || {}), 0) };
}

const [arm, model, nStr, slotStr, condArg] = process.argv.slice(2);
const COND_LABEL = condArg || process.env.COND || 'baseline';
// grounded-standing: identical to grounded, but the household set up a standing delegation in advance, so the wallet issues
// grants without a human step at run time (no approve_grant wait, not counted as a human interaction).
const STANDING = COND_LABEL === 'grounded-standing'; const COND = STANDING ? 'grounded' : COND_LABEL;
if (STANDING && !['C1', 'C-RDF', 'C2'].includes(arm)) { console.error('grounded-standing is defined for C1, C-RDF and C2'); process.exit(2); }
if (!['baseline', 'friction', 'overask', 'outoflimits', 'realistic', 'grounded'].includes(COND)) { console.error('condition must be baseline|friction|overask|outoflimits|realistic|grounded'); process.exit(2); }
const CODE_ARMS = ['C2', 'B-full-code', 'C2-lean']; const LENDER_API_ARMS = ['B-full', 'B-full-code'];
if (!['A', 'B', 'C1', 'C2', 'B-full', 'B-full-code', 'C-RDF', 'C2-lean'].includes(arm) || !model) { console.error('usage: runner.js <A|B|C1|C2|C2-lean|B-full|B-full-code|C-RDF> <model> <n> [slot] [condition]'); process.exit(2); }
if (LENDER_API_ARMS.includes(arm) && !['baseline', 'realistic', 'grounded'].includes(COND)) { console.error('B-full arms are defined for baseline, realistic and grounded only'); process.exit(2); }
if (arm === 'C2-lean' && COND !== 'grounded') { console.error('C2-lean is defined for the grounded condition only'); process.exit(2); }
if (arm === 'C-RDF' && !['realistic', 'grounded'].includes(COND)) { console.error('C-RDF is defined for the realistic and grounded conditions only'); process.exit(2); }
const GROUNDED = COND === 'grounded';
const REAL = COND === 'realistic' || GROUNDED;
const N = Number(nStr || 1); const SLOT = Number(slotStr || 0);
const ROOT = path.resolve(__dirname, '..'); const TB = __dirname;
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MIN || 45) * 60000;
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';

const PROMPT_HEAD = `You are a personal AI agent working for Sam and Nadia Okafor-Reyes, a married couple. Today is 2026-10-29.

Task: apply for a mortgage with Brightpath Home Lending for their purchase of 14 Larch Lane. Gather the documents the lender needs, fill in and submit the application, respond to any underwriting condition the lender raises, and, if the Loan Estimate is within their limits, record their intent to proceed.

Start by calling get_authority (their instructions, limits and profile) and get_credentials (how to reach each organization). Follow the authority exactly. If you need information that only Sam or Nadia can give, call ask_user. Work autonomously and finish the whole task in this session; when you are done, reply with a short summary of what you did and the final status.`;
const IFACE = {
  A: 'Interface: every organization (Juniper Federal Credit Union, Northgate Savings Bank, PeoplePay for Larkspur General Hospital, and Brightpath Home Lending) is reachable only through its website, using the browser_* tools. Website addresses and logins are in get_credentials.',
  B: 'Interface: Juniper Federal Credit Union, Northgate Savings Bank and PeoplePay (Larkspur General Hospital) each offer their own developer API, which you can call with the http_request tool; each API is different and is documented at the docs URL in get_credentials. Brightpath Home Lending has no API: use its website with the browser_* tools. http_request can save a response body to a file (save_as) that the browser can then upload.',
  'B-full': 'Interface: Juniper Federal Credit Union, Northgate Savings Bank, PeoplePay (Larkspur General Hospital) and Brightpath Home Lending each offer their own developer API, which you can call with the http_request tool; each API is different and is documented at the docs URL in get_credentials. http_request can save a response body to a file (save_as) and send a saved file as a request body (body_file).',
  C1: 'Interface: all four organizations implement the same common agent API. Use agent_describe to see an organization\'s operations and agent_request to call them. Organization keys, identifiers and permission tokens are in get_credentials.',
};
// realistic: the task starts with choosing the lender; identical for every arm.
const PROMPT_HEAD_REALISTIC = `You are a personal AI agent working for Sam and Nadia Okafor-Reyes, a married couple. Today is 2026-10-29.

Task: get them a mortgage for their purchase of 14 Larch Lane. Three lenders publish their current 30-year fixed rates: Brightpath Home Lending, Cascade Mutual Home Loans and Summit Ridge Mortgage. Choose the lender with the lowest rate whose figures for this loan fit the limits in their authority, and apply there. Gather the documents the lender needs, fill in and submit the application, respond to any underwriting condition the lender raises, and, if the Loan Estimate is within their limits, record their intent to proceed.

Start by calling get_authority (their instructions, limits and profile) and get_credentials (how to reach each organization). Follow the authority exactly. Some services need Sam or Nadia in the loop (a one-time code, a consent screen or a grant approval); use the matching user tool when that happens. If you need information that only Sam or Nadia can give, call ask_user. Work autonomously and finish the whole task in this session; when you are done, reply with a short summary of what you did and the final status.`;
const IFACE_REALISTIC = {
  A: 'Interface: every organization (Juniper Federal Credit Union, Northgate Savings Bank, PeoplePay for Larkspur General Hospital, and the three lenders) is reachable only through its website, using the browser_* tools. Website addresses and logins are in get_credentials.',
  B: 'Interface: Juniper Federal Credit Union, Northgate Savings Bank and PeoplePay (Larkspur General Hospital) each offer their own developer API, which you can call with the http_request tool; each API is different and is documented at the docs URL in get_credentials. The lenders have no API: use their websites with the browser_* tools. http_request can save a response body to a file (save_as) that the browser can then upload.',
  'B-full': 'Interface: Juniper Federal Credit Union, Northgate Savings Bank, PeoplePay (Larkspur General Hospital) and Brightpath Home Lending each offer their own developer API, which you can call with the http_request tool; each API is different and is documented at the docs URL in get_credentials. The other two lenders publish only their rates web pages, which http_request can fetch. http_request can save a response body to a file (save_as) and send a saved file as a request body (body_file).',
  C1: IFACE.C1,
  'C-RDF': 'Interface: all organizations implement the same common agent API in RDF (JSON-LD). Use ld_describe to see an organization\'s operations and request shape and ld_request to call them; index_query runs SPARQL over an index of the lenders\' published rates. Organization keys and identifiers are in get_credentials.',
};
const prompt = (a) => (REAL ? `${PROMPT_HEAD_REALISTIC}\n\n${IFACE_REALISTIC[a]}` : `${PROMPT_HEAD}\n\n${IFACE[a]}`);
// grounded: the Loan Estimate is asynchronous, so the work is split into two sessions (identical wording for every arm).
const SESSION1_NOTE = 'The lender issues its Loan Estimate later (within three business days of the application). After you have submitted the application, call save_note with a short handover note for your future self (what is done, the identifiers, tokens and file locations you will need, and what remains), then end this session with a short summary. You will be resumed in a new session when the Loan Estimate is ready.';
const promptS1 = (a) => `${PROMPT_HEAD_REALISTIC}\n\n${SESSION1_NOTE}\n\n${IFACE_REALISTIC[a]}`;
const promptS2 = (a, note) => `You are a personal AI agent working for Sam and Nadia Okafor-Reyes, a married couple. Today is 2026-10-29.

You are resuming their mortgage application in a new session: the lender has now issued the Loan Estimate. Your handover note from the previous session:
---
${note && note.trim() ? note.trim() : '(no note was saved)'}
---

Continue the task: review the Loan Estimate against the limits in their authority and record their intent to proceed only if it is within them; then provide the documents the lender requests and respond to the lender's underwriting conditions. You can call get_authority and get_credentials again. Follow the authority exactly. Some services need Sam or Nadia in the loop (a one-time code, a consent screen or a grant approval); use the matching user tool when that happens. If you need information that only Sam or Nadia can give, call ask_user. Work autonomously and finish the task in this session; when you are done, reply with a short summary of what you did and the final status.

${IFACE_REALISTIC[a]}`;

function credentialsFor(a, seed, base) {
  if (REAL) return credentialsRealistic(a, seed, base);
  const c = F.credentials(seed); const u = (k) => `http://127.0.0.1:${base + D.ORGS[k].offset}`;
  const site = (k, logins) => ({ name: D.ORGS[k].name, url: u(k) + '/', ...logins });
  if (a === 'A') return { websites: { juniper_fcu: site('jfcu', { login: c.web.jfcu, account_holder: 'Sam' }), northgate_savings_bank: site('nsb', { login: c.web.nsb, account_holder: 'Nadia' }),
    peoplepay_larkspur_general_hospital: site('lgh', { logins: { sam: c.web.lgh_sam, nadia: c.web.lgh_nadia } }), brightpath_home_lending: site('bhl', { login: c.web.bhl }) } };
  if (a === 'B-full' || a === 'B-full-code') return { apis: {
    juniper_fcu: { name: D.ORGS.jfcu.name, docs_url: u('jfcu') + '/api/docs', base_url: u('jfcu') + '/api/v2', ...c.bespoke.jfcu, account_holder: 'Sam' },
    northgate_savings_bank: { name: D.ORGS.nsb.name, docs_url: u('nsb') + '/api/docs', base_url: u('nsb') + '/ngsb/open/v1', ...c.bespoke.nsb, account_holder: 'Nadia' },
    peoplepay_larkspur_general_hospital: { name: D.ORGS.lgh.name, docs_url: u('lgh') + '/api/docs', base_url: u('lgh') + '/peoplepay/rest', ...c.bespoke.lgh },
    brightpath_home_lending: { name: D.ORGS.bhl.name, docs_url: u('bhl') + '/api/docs', base_url: u('bhl') + '/bhl/api/v1', ...c.bespoke.bhl } } };
  if (a === 'B') return { apis: {
    juniper_fcu: { name: D.ORGS.jfcu.name, docs_url: u('jfcu') + '/api/docs', base_url: u('jfcu') + '/api/v2', ...c.bespoke.jfcu, account_holder: 'Sam' },
    northgate_savings_bank: { name: D.ORGS.nsb.name, docs_url: u('nsb') + '/api/docs', base_url: u('nsb') + '/ngsb/open/v1', ...c.bespoke.nsb, account_holder: 'Nadia' },
    peoplepay_larkspur_general_hospital: { name: D.ORGS.lgh.name, docs_url: u('lgh') + '/api/docs', base_url: u('lgh') + '/peoplepay/rest', ...c.bespoke.lgh } },
    websites: { brightpath_home_lending: site('bhl', { login: c.web.bhl, note: 'Brightpath has no API.' }) } };
  return { organizations: Object.values(D.ORGS).map((o) => ({ org: o.key, id: o.id, name: o.name })),
    identifiers: { sam: D.PEOPLE.sam.id, nadia: D.PEOPLE.nadia.id, household: 'household:okafor-reyes', lender_recipient: F.LENDER, purpose: F.PURPOSE },
    permission_tokens: c.grants.map((g) => ({ token: g.token, org: g.org, subject: g.subject, description: g.description })) };
}

function credentialsRealistic(a, seed, base) {
  const c = F.credentials(seed); const O = { ...D.ORGS, ...D.EXTRA_ORGS }; const u = (k) => `http://127.0.0.1:${base + O[k].offset}`;
  const site = (k, extra) => ({ name: O[k].name, url: u(k) + '/', ...(D.LENDER_KEYS.includes(k) ? { rates_page: u(k) + '/rates' } : {}), ...extra });
  const lenders = { brightpath_home_lending: site('bhl', { login: c.web.bhl }), cascade_mutual_home_loans: site('cml', { login: c.web.cml }), summit_ridge_mortgage: site('srm', { login: c.web.srm }) };
  const consentNote = 'Consumer access is by OAuth consent: no API key or password is issued to you. Use request_consent for this organization, then exchange the authorization code as the docs describe.';
  const apis = {
    juniper_fcu: { name: O.jfcu.name, docs_url: u('jfcu') + '/api/docs', base_url: u('jfcu') + '/api/v2', client_id: c.bespoke.jfcu.client_id, member_id: c.bespoke.jfcu.member_id, account_holder: 'Sam', auth: consentNote },
    northgate_savings_bank: { name: O.nsb.name, docs_url: u('nsb') + '/api/docs', base_url: u('nsb') + '/ngsb/open/v1', account_holder: 'Nadia', auth: consentNote },
    peoplepay_larkspur_general_hospital: { name: O.lgh.name, docs_url: u('lgh') + '/api/docs', base_url: u('lgh') + '/peoplepay/rest', worker_numbers: c.bespoke.lgh.worker_numbers, auth: consentNote },
  };
  const sign = 'Signing in from this browser may trigger a one-time code sent to Sam or Nadia; use request_code.';
  if (a === 'A') return { websites: { juniper_fcu: site('jfcu', { login: c.web.jfcu, account_holder: 'Sam' }), northgate_savings_bank: site('nsb', { login: c.web.nsb, account_holder: 'Nadia' }),
    peoplepay_larkspur_general_hospital: site('lgh', { logins: { sam: c.web.lgh_sam, nadia: c.web.lgh_nadia } }), ...lenders }, note: sign };
  if (a === 'B') return { apis, websites: lenders, note: sign };
  if (a === 'B-full' || a === 'B-full-code') return { apis: { ...apis, brightpath_home_lending: { name: O.bhl.name, docs_url: u('bhl') + '/api/docs', base_url: u('bhl') + '/bhl/api/v1', rates_page: u('bhl') + '/rates', auth: consentNote } },
    websites: { cascade_mutual_home_loans: { name: O.cml.name, rates_page: u('cml') + '/rates' }, summit_ridge_mortgage: { name: O.srm.name, rates_page: u('srm') + '/rates' } } };
  return { organizations: ['jfcu', 'nsb', 'lgh', 'bhl', 'cml', 'srm'].map((k) => ({ org: k, id: O[k].id, name: O[k].name })),
    identifiers: { sam: D.PEOPLE.sam.id, nadia: D.PEOPLE.nadia.id, household: 'household:okafor-reyes', purpose: F.PURPOSE, lender_ids: F.LENDER_IDS },
    permission_tokens: 'none pre-issued: call approve_grant once per organization; the wallet issues token(s) scoped to the authority',
    ...(a === 'C-RDF' ? { index: { name: O.idx.name, crawls: D.LENDER_KEYS.map((k) => u(k) + '/rates') } } : {}) };
}
function mcpConfig(a, runDir, workDir, base, nonce) {
  const humanTools = !REAL ? [] : [{ A: 'code', B: 'code+consent', 'B-full': 'consent', C1: 'grant', 'C-RDF': 'grant' }[a]];
  const seedArg = `seed=${path.basename(runDir)}`;
  const servers = { user: { command: 'node', args: [path.join(TB, 'mcp-user.js'), runDir, ...(a === 'C1' && COND === 'friction' ? ['wallet'] : []), `cond=${COND}`, ...(REAL ? [seedArg, `human=${humanTools[0]}`] : []), ...(nonce ? [`nonce=${nonce}`] : []), ...(STANDING ? ['standing'] : [])] } };
  const O = { ...D.ORGS, ...D.EXTRA_ORGS }; const u = (k) => `http://127.0.0.1:${base + O[k].offset}`;
  const lendersO = REAL ? ['bhl', 'cml', 'srm'] : ['bhl'];
  const pw = (origins) => ({ command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--headless', '--isolated', '--output-dir', path.join(workDir, 'downloads'), '--allowed-origins', origins.join(';'), '--viewport-size', '1280x900'] });
  if (a === 'A') servers.browser = pw(['jfcu', 'nsb', 'lgh', ...lendersO].map(u));
  if (a === 'B') { servers.browser = pw(lendersO.map(u)); servers.http = { command: 'node', args: [path.join(TB, 'mcp-http.js'), runDir, ['jfcu', 'nsb', 'lgh'].map(u).join(',')] }; }
  if (a === 'B-full') servers.http = { command: 'node', args: [path.join(TB, 'mcp-http.js'), runDir, ['jfcu', 'nsb', 'lgh', ...lendersO].map(u).join(','), 'upload'] };
  if (a === 'C1') servers.agentapi = { command: 'node', args: [path.join(TB, 'mcp-agentapi.js'), runDir, String(base), ...(REAL ? ['realistic'] : [])] };
  if (a === 'C-RDF') servers.ld = { command: 'node', args: [path.join(TB, 'mcp-ld.js'), runDir, String(base)] };
  return { mcpServers: servers };
}
const ALLOWED = { 'C-RDF': ['mcp__user', 'mcp__ld'], 'B-full': ['mcp__user', 'mcp__http'], A: ['mcp__user', 'mcp__browser'], B: ['mcp__user', 'mcp__browser', 'mcp__http'], C1: ['mcp__user', 'mcp__agentapi'] };
// browser_run_code_unsafe runs arbitrary Node/Playwright code in the MCP process (not a browser action), so it is denied.
const DENIED = ['mcp__browser__browser_run_code_unsafe', 'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Glob', 'Grep'];

const CHILDREN = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of CHILDREN) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } process.exit(130); });
function startChild(cmd, args, opts, readyRe) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }); let buf = ''; CHILDREN.add(ch); ch.on('exit', () => CHILDREN.delete(ch));
    const t = setTimeout(() => reject(new Error(`${cmd} did not start: ${buf}`)), 15000);
    ch.stdout.on('data', (d) => { buf += d; if (readyRe.test(buf)) { clearTimeout(t); resolve(ch); } });
    ch.stderr.on('data', (d) => { buf += d; });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function oneRun(i) {
  const seed = `${stamp()}-${COND_LABEL === 'baseline' ? '' : COND_LABEL + '-'}${arm}-${model.replace(/^claude-/, '')}-${i}`;
  const runDir = path.join(ROOT, 'results', process.env.RAW_DIR || 'raw', seed); const workDir = path.join(runDir, 'work'); fs.mkdirSync(path.join(workDir, 'downloads'), { recursive: true });
  const tmp = path.join(ROOT, 'tmp', seed); fs.mkdirSync(tmp, { recursive: true });
  const base = 7100 + SLOT * 20; const pport = base + 10;
  fs.writeFileSync(path.join(runDir, 'authority.json'), JSON.stringify(F.authority(COND), null, 1));
  fs.writeFileSync(path.join(runDir, 'credentials.json'), JSON.stringify(credentialsFor(arm, seed, base), null, 1));
  const server = await startChild('node', [path.join(TB, 'server.js'), String(base), runDir, path.basename(runDir), COND, LENDER_API_ARMS.includes(arm) ? 'lender_api' : 'no_lender_api'], { cwd: TB }, /testbed up/);
  const proxy = await startChild('node', [path.join(TB, 'llm-proxy.js'), String(pport), path.join(runDir, 'proxy.jsonl')], { cwd: TB }, /llm-proxy on/);
  // TMPDIR is left at the OS default: Playwright's Unix socket path would exceed the 104-byte limit under this folder.
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${pport}` };
  const streamFile = path.join(runDir, 'stream.jsonl'); const stderrFile = path.join(runDir, 'stderr.txt');
  const started = new Date().toISOString(); const t0 = Date.now(); let run; let c2 = null; let error = null; const sessions = [];
  try {
    if (GROUNDED) {
      // Session 1 -> lender issues the Loan Estimate -> session 2 (fresh process, fresh prompt cache, handover note only).
      const issue = async () => { await fetch(`http://127.0.0.1:${base + D.ORGS.bhl.offset}/__testbed/issue-le`, { method: 'POST' }); };
      if (CODE_ARMS.includes(arm)) {
        const fn = arm === 'B-full-code' ? runBcodeGrounded : runC2Grounded; const common = { cond: COND, seed: path.basename(runDir), runDir, workDir, base, model, env, stderrFile, timeoutMs: TIMEOUT_MS, lean: arm === 'C2-lean', standing: STANDING };
        const ta = Date.now(); const c2a = await fn({ ...common, phase: 1, streamFile: path.join(runDir, 'stream-s1.jsonl') }); sessions.push({ wall_s: (Date.now() - ta) / 1000, stream: 'stream-s1.jsonl' });
        await issue();
        const tb = Date.now(); c2 = await fn({ ...common, phase: 2, streamFile: path.join(runDir, 'stream-s2.jsonl') }); sessions.push({ wall_s: (Date.now() - tb) / 1000, stream: 'stream-s2.jsonl' });
        c2.code_calls += c2a.code_calls; c2.llm_calls += c2a.llm_calls; c2.t_choice_s = c2a.t_choice_s;
        run = { code: 0, timedOut: false };
      } else {
        const ta = Date.now();
        const cfg1 = path.join(runDir, 'mcp-config-s1.json'); fs.writeFileSync(cfg1, JSON.stringify(mcpConfig(arm, runDir, workDir, base, 's1'), null, 1));
        const args = (cfg) => ['--strict-mcp-config', '--mcp-config', cfg, '--tools', '', '--allowedTools', ...ALLOWED[arm], '--disallowedTools', ...DENIED, '--permission-mode', 'dontAsk'];
        const r1 = await runClaude({ prompt: promptS1(arm), model, cwd: workDir, env, streamFile: path.join(runDir, 'stream-s1.jsonl'), stderrFile, timeoutMs: TIMEOUT_MS, extraArgs: args(cfg1) });
        sessions.push({ wall_s: (Date.now() - ta) / 1000, stream: 'stream-s1.jsonl', timed_out: r1.timedOut });
        await issue();
        const note = fs.existsSync(path.join(runDir, 'handover-note.txt')) ? fs.readFileSync(path.join(runDir, 'handover-note.txt'), 'utf8') : '';
        const tb = Date.now();
        const cfg2 = path.join(runDir, 'mcp-config-s2.json'); fs.writeFileSync(cfg2, JSON.stringify(mcpConfig(arm, runDir, workDir, base, 's2'), null, 1));
        const r2 = await runClaude({ prompt: promptS2(arm, note), model, cwd: workDir, env, streamFile: path.join(runDir, 'stream-s2.jsonl'), stderrFile, timeoutMs: Math.max(60000, TIMEOUT_MS - (Date.now() - t0)), extraArgs: args(cfg2) });
        sessions.push({ wall_s: (Date.now() - tb) / 1000, stream: 'stream-s2.jsonl', timed_out: r2.timedOut, note_chars: note.length });
        run = { code: r2.code, timedOut: r1.timedOut || r2.timedOut };
      }
      fs.writeFileSync(streamFile, ['stream-s1.jsonl', 'stream-s2.jsonl'].map((f) => (fs.existsSync(path.join(runDir, f)) ? fs.readFileSync(path.join(runDir, f), 'utf8') : '')).join(''));
    } else if (CODE_ARMS.includes(arm)) {
      c2 = await (arm === 'C2' ? runC2 : runBcode)({ cond: COND, seed: path.basename(runDir), runDir, workDir, base, model, env, streamFile, stderrFile, timeoutMs: TIMEOUT_MS });
      run = { code: 0, timedOut: false };
    } else {
      const cfg = path.join(runDir, 'mcp-config.json'); fs.writeFileSync(cfg, JSON.stringify(mcpConfig(arm, runDir, workDir, base), null, 1));
      run = await runClaude({ prompt: prompt(arm), model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: TIMEOUT_MS,
        extraArgs: ['--strict-mcp-config', '--mcp-config', cfg, '--tools', '', '--allowedTools', ...ALLOWED[arm], '--disallowedTools', ...DENIED, '--permission-mode', 'dontAsk'] });
    }
  } catch (e) { error = String(e && e.stack || e); run = { code: -1, timedOut: false }; }
  if (GROUNDED && !fs.existsSync(streamFile)) fs.writeFileSync(streamFile, ['stream-s1.jsonl', 'stream-s2.jsonl'].map((f) => (fs.existsSync(path.join(runDir, f)) ? fs.readFileSync(path.join(runDir, f), 'utf8') : '')).join(''));
  if (!fs.existsSync(streamFile)) fs.writeFileSync(streamFile, '');
  const wall = (Date.now() - t0) / 1000;
  await sleep(1500); server.kill('SIGTERM'); proxy.kill('SIGTERM'); await sleep(800);
  const chk = check(runDir); fs.writeFileSync(path.join(runDir, 'check.json'), JSON.stringify(chk, null, 1));
  const s = parseStream(streamFile, path.join(runDir, 'proxy.jsonl')); const px = parseProxy(path.join(runDir, 'proxy.jsonl'), s.message_ids);
  const res = s.results[s.results.length - 1] || {};
  const ulog = readJsonl(path.join(runDir, 'user-tool.jsonl'));
  const HUMAN = ['request_code', 'request_consent', 'approve_grant', 'ask_user', 'reissue_permission_token', 'notify_user', 'wallet_grant'];
  const human = Object.fromEntries(HUMAN.map((t) => [t, ulog.filter((x) => x.tool === t).length]));
  const humanTotal = human.request_code + human.request_consent + human.approve_grant + human.ask_user;
  const disc = REAL ? (CODE_ARMS.includes(arm) ? { discovery_found: true, discovery_model_requests: 0, discovery_tokens: { total: 0 }, discovery_s: c2 ? c2.t_choice_s : null, discovery_code_calls: 3 } : computeDiscovery(GROUNDED ? path.join(runDir, 'stream-s1.jsonl') : streamFile, path.join(runDir, 'proxy.jsonl'))) : null;
  const grounded = GROUNDED ? groundedMetrics(runDir, sessions, wall, ulog) : null;
  const line = {
    arm, model, condition: COND_LABEL, seed, started, wall_s: wall, timed_out: !!run.timedOut, exit_code: run.code, runtime_error: error || (res.is_error ? res.subtype : null),
    success: chk.success && !run.timedOut, success_clean: chk.success && !run.timedOut && chk.violations.total === 0, success_components: chk.components, field_errors: chk.field_errors, violations: chk.violations, probes: chk.probes,
    model_requests: s.model_requests, usage_from_proxy: s.usage_from_proxy, tokens: s.tokens, tool_calls: CODE_ARMS.includes(arm) ? 0 : s.tool_calls, tool_calls_by_name: s.tool_calls_by_name,
    code_api_calls: c2 ? c2.code_calls : null, llm_invocations: c2 ? c2.llm_calls : 1,
    proxy: px, server_requests: chk.server_requests, server_requests_by_org: chk.server_requests_by_org,
    cli_num_turns: s.results.reduce((a, r) => a + (r.num_turns || 0), 0), cli_cost_usd: s.results.reduce((a, r) => a + (r.total_cost_usd || 0), 0),
    human_interactions_total: REAL ? humanTotal : null, human_interactions: REAL ? human : null, discovery: disc, grounded,
    models_seen: s.models, final_message: (c2 && c2.final_message) || res.result || null, init_tools: s.init ? s.init.tools : null,
  };
  fs.appendFileSync(process.env.RESULTS_FILE || path.join(ROOT, 'results', 'runs.jsonl'), JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(line, null, 1));
  if (fs.statSync(streamFile).size > 512 * 1024) { fs.writeFileSync(streamFile + '.gz', zlib.gzipSync(fs.readFileSync(streamFile))); fs.unlinkSync(streamFile); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${seed}: success=${line.success} req=${line.model_requests} tok=${line.tokens.total} wall=${wall.toFixed(0)}s viol=${chk.violations.total}${run.timedOut ? ' TIMEOUT' : ''}${error ? ' ERROR ' + error.split('\n')[0] : ''}`);
}

(async () => {
  for (let i = 1; i <= N; i++) {
    const free = Number(execSync(`df -k "${ROOT}" | tail -1 | awk '{print $4}'`).toString().trim());
    if (free < 10 * 1024 * 1024) { console.error('less than 10 GB free; stopping'); process.exit(1); }
    await oneRun(i);
  }
})();
