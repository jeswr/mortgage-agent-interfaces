#!/usr/bin/env node
// Measures the agent runtime's own per-process overhead for the code arms' model calls:
// process start -> first model request, last agent response -> process exit, and housekeeping calls.
// Usage: node calibrate-cli.js <n> <outDir> [lean]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runClaude, readJsonl } = require('./llm');
const [nStr, outDir, leanArg] = process.argv.slice(2); const N = Number(nStr || 5); const lean = leanArg === 'lean';
fs.mkdirSync(outDir, { recursive: true });
const port = 7290; const proxyLog = path.join(outDir, 'proxy.jsonl');
const PROMPT = 'A mortgage lender raised these underwriting conditions for Sam and Nadia Okafor-Reyes:\n- C-1: "Please explain the source of the $8,000.00 deposit on 09/03/2026 into account ending 4417."\n- C-2: "Please provide each borrower\'s most recent W-2 (tax year 2025)."\n\nFor each condition, decide whether it needs a written explanation that only the borrowers can give, or documents. Reply with JSON only, an array of {"condition_id", "kind", "question_for_borrowers", "documents"}.';
(async () => {
  const proxy = spawn('node', [path.join(__dirname, 'llm-proxy.js'), String(port), proxyLog], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const rows = [];
  for (let i = 0; i < N; i++) {
    const streamFile = path.join(outDir, `stream-${i}.jsonl`); const t0 = Date.now();
    const extra = ['--tools', '', '--strict-mcp-config', ...(lean ? ['--system-prompt', 'You are a concise assistant. Follow the instructions exactly.'] : [])];
    await runClaude({ prompt: PROMPT, model: 'claude-sonnet-5-5', cwd: outDir, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }, streamFile, stderrFile: path.join(outDir, 'stderr.txt'), timeoutMs: 120000, extraArgs: extra });
    const t1 = Date.now(); await new Promise((r) => setTimeout(r, 300));
    const ids = new Set(readJsonl(streamFile).filter((e) => e.type === 'assistant').map((e) => e.message.id));
    const reqs = readJsonl(proxyLog).filter((e) => e.method === 'POST' && /^\/v1\/messages/.test(e.path || '') && Date.parse(e.ts) >= t0 && Date.parse(e.ts) <= t1);
    const agent = reqs.filter((e) => ids.has(e.id)); const hidden = reqs.filter((e) => !ids.has(e.id));
    const first = Math.min(...reqs.map((e) => Date.parse(e.ts))); const lastEnd = Math.max(...agent.map((e) => Date.parse(e.ts) + e.ms));
    rows.push({ wall_s: (t1 - t0) / 1000, startup_s: (first - t0) / 1000, tail_s: (t1 - lastEnd) / 1000, agent_model_s: agent.reduce((a, e) => a + e.ms, 0) / 1000, hidden_calls: hidden.length, hidden_ms: hidden.reduce((a, e) => a + e.ms, 0),
      agent_input_tokens: agent.reduce((a, e) => a + (e.usage.input_tokens || 0) + (e.usage.cache_read_input_tokens || 0) + (e.usage.cache_creation_input_tokens || 0), 0) });
  }
  proxy.kill();
  const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const summary = { lean, n: N, median: Object.fromEntries(Object.keys(rows[0]).map((k) => [k, med(k)])), rows };
  fs.writeFileSync(path.join(outDir, 'calibration.json'), JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary.median));
})();
