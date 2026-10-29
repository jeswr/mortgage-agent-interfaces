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

const [arm, model, nStr, slotStr, condArg] = process.argv.slice(2);
const COND = condArg || process.env.COND || 'baseline';
if (!['baseline', 'friction', 'overask', 'outoflimits'].includes(COND)) { console.error('condition must be baseline|friction|overask|outoflimits'); process.exit(2); }
const CODE_ARMS = ['C2', 'B-full-code']; const LENDER_API_ARMS = ['B-full', 'B-full-code'];
if (!['A', 'B', 'C1', 'C2', 'B-full', 'B-full-code'].includes(arm) || !model) { console.error('usage: runner.js <A|B|C1|C2|B-full|B-full-code> <model> <n> [slot] [condition]'); process.exit(2); }
if (LENDER_API_ARMS.includes(arm) && COND !== 'baseline') { console.error('B-full arms are defined for the baseline condition only'); process.exit(2); }
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
const prompt = (a) => `${PROMPT_HEAD}\n\n${IFACE[a]}`;

function credentialsFor(a, seed, base) {
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

function mcpConfig(a, runDir, workDir, base) {
  const servers = { user: { command: 'node', args: [path.join(TB, 'mcp-user.js'), runDir, ...(a === 'C1' && COND === 'friction' ? ['wallet'] : []), `cond=${COND}`] } };
  const u = (k) => `http://127.0.0.1:${base + D.ORGS[k].offset}`;
  const pw = (origins) => ({ command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--headless', '--isolated', '--output-dir', path.join(workDir, 'downloads'), '--allowed-origins', origins.join(';'), '--viewport-size', '1280x900'] });
  if (a === 'A') servers.browser = pw(['jfcu', 'nsb', 'lgh', 'bhl'].map(u));
  if (a === 'B') { servers.browser = pw([u('bhl')]); servers.http = { command: 'node', args: [path.join(TB, 'mcp-http.js'), runDir, ['jfcu', 'nsb', 'lgh'].map(u).join(',')] }; }
  if (a === 'B-full') servers.http = { command: 'node', args: [path.join(TB, 'mcp-http.js'), runDir, ['jfcu', 'nsb', 'lgh', 'bhl'].map(u).join(','), 'upload'] };
  if (a === 'C1') servers.agentapi = { command: 'node', args: [path.join(TB, 'mcp-agentapi.js'), runDir, String(base)] };
  return { mcpServers: servers };
}
const ALLOWED = { 'B-full': ['mcp__user', 'mcp__http'], A: ['mcp__user', 'mcp__browser'], B: ['mcp__user', 'mcp__browser', 'mcp__http'], C1: ['mcp__user', 'mcp__agentapi'] };
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
  const seed = `${stamp()}-${COND === 'baseline' ? '' : COND + '-'}${arm}-${model.replace(/^claude-/, '')}-${i}`;
  const runDir = path.join(ROOT, 'results', process.env.RAW_DIR || 'raw', seed); const workDir = path.join(runDir, 'work'); fs.mkdirSync(path.join(workDir, 'downloads'), { recursive: true });
  const tmp = path.join(ROOT, 'tmp', seed); fs.mkdirSync(tmp, { recursive: true });
  const base = 7100 + SLOT * 20; const pport = base + 10;
  fs.writeFileSync(path.join(runDir, 'authority.json'), JSON.stringify(F.authority(), null, 1));
  fs.writeFileSync(path.join(runDir, 'credentials.json'), JSON.stringify(credentialsFor(arm, seed, base), null, 1));
  const server = await startChild('node', [path.join(TB, 'server.js'), String(base), runDir, seed, COND, LENDER_API_ARMS.includes(arm) ? 'lender_api' : 'no_lender_api'], { cwd: TB }, /testbed up/);
  const proxy = await startChild('node', [path.join(TB, 'llm-proxy.js'), String(pport), path.join(runDir, 'proxy.jsonl')], { cwd: TB }, /llm-proxy on/);
  // TMPDIR is left at the OS default: Playwright's Unix socket path would exceed the 104-byte limit under this folder.
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${pport}` };
  const streamFile = path.join(runDir, 'stream.jsonl'); const stderrFile = path.join(runDir, 'stderr.txt');
  const started = new Date().toISOString(); const t0 = Date.now(); let run; let c2 = null; let error = null;
  try {
    if (CODE_ARMS.includes(arm)) {
      c2 = await (arm === 'C2' ? runC2 : runBcode)({ cond: COND, runDir, workDir, base, model, env, streamFile, stderrFile, timeoutMs: TIMEOUT_MS });
      run = { code: 0, timedOut: false };
    } else {
      const cfg = path.join(runDir, 'mcp-config.json'); fs.writeFileSync(cfg, JSON.stringify(mcpConfig(arm, runDir, workDir, base), null, 1));
      run = await runClaude({ prompt: prompt(arm), model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: TIMEOUT_MS,
        extraArgs: ['--strict-mcp-config', '--mcp-config', cfg, '--tools', '', '--allowedTools', ...ALLOWED[arm], '--disallowedTools', ...DENIED, '--permission-mode', 'dontAsk'] });
    }
  } catch (e) { error = String(e && e.stack || e); run = { code: -1, timedOut: false }; }
  const wall = (Date.now() - t0) / 1000;
  await sleep(1500); server.kill('SIGTERM'); proxy.kill('SIGTERM'); await sleep(800);
  const chk = check(runDir); fs.writeFileSync(path.join(runDir, 'check.json'), JSON.stringify(chk, null, 1));
  const s = parseStream(streamFile, path.join(runDir, 'proxy.jsonl')); const px = parseProxy(path.join(runDir, 'proxy.jsonl'), s.message_ids);
  const res = s.results[s.results.length - 1] || {};
  const line = {
    arm, model, condition: COND, seed, started, wall_s: wall, timed_out: !!run.timedOut, exit_code: run.code, runtime_error: error || (res.is_error ? res.subtype : null),
    success: chk.success && !run.timedOut, success_clean: chk.success && !run.timedOut && chk.violations.total === 0, success_components: chk.components, field_errors: chk.field_errors, violations: chk.violations, probes: chk.probes,
    model_requests: s.model_requests, usage_from_proxy: s.usage_from_proxy, tokens: s.tokens, tool_calls: CODE_ARMS.includes(arm) ? 0 : s.tool_calls, tool_calls_by_name: s.tool_calls_by_name,
    code_api_calls: c2 ? c2.code_calls : null, llm_invocations: c2 ? c2.llm_calls : 1,
    proxy: px, server_requests: chk.server_requests, server_requests_by_org: chk.server_requests_by_org,
    cli_num_turns: s.results.reduce((a, r) => a + (r.num_turns || 0), 0), cli_cost_usd: s.results.reduce((a, r) => a + (r.total_cost_usd || 0), 0),
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
