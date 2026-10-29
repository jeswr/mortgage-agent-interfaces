#!/usr/bin/env node
// Agent-runtime overhead per grounded run: CLI process start -> first model request, last agent response -> process exit
// (which contains the CLI's housekeeping calls), and housekeeping calls made in the middle of a session.
// Claude-run arms: session start/end come from cli-procs.jsonl when present, else from run.started + session walls.
// Code arms (several short claude -p processes): from cli-procs.jsonl when present, else the calibrated per-process
// median (results/calibration/*) times the number of model invocations (marked "estimated").
// Usage: node overhead.js [runs.jsonl]  -> writes results/overhead.json and prints a per-arm table
'use strict';
const fs = require('fs'); const path = require('path'); const { readJsonl } = require('./llm');
const ROOT = path.resolve(__dirname, '..');
const runs = readJsonl(process.argv[2] || path.join(ROOT, 'results', 'runs.jsonl')).filter((r) => r.condition === 'grounded' || r.condition === 'grounded-standing');
const cal = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'calibration', n, 'calibration.json'), 'utf8')).median;
const CAL = { default: cal('cli-default'), lean: cal('cli-lean') };
const out = [];
for (const r of runs) {
  const dir = path.join(ROOT, 'results', 'raw', r.seed);
  const px = readJsonl(path.join(dir, 'proxy.jsonl')).filter((e) => e.method === 'POST' && /^\/v1\/messages(\?|$)/.test(e.path || ''));
  const agentIds = new Set(); for (const f of ['stream-s1.jsonl', 'stream-s2.jsonl']) for (const e of readJsonl(path.join(dir, f))) if (e.type === 'assistant') agentIds.add(e.message.id);
  let procs = readJsonl(path.join(dir, 'cli-procs.jsonl')).map((p) => ({ start: Date.parse(p.start), end: Date.parse(p.end) })); let estimated = false;
  const code = ['C2', 'C2-lean', 'B-full-code'].includes(r.arm);
  if (!procs.length && !code) { const s = r.grounded.sessions; const t0 = Date.parse(r.started); procs = [{ start: t0, end: t0 + s[0].wall_s * 1000 }, { start: t0 + s[0].wall_s * 1000, end: t0 + (s[0].wall_s + s[1].wall_s) * 1000 }]; }
  let startup = 0; let tail = 0; let midHidden = 0; let hiddenN = 0; let hiddenMs = 0;
  if (procs.length) {
    for (const p of procs) {
      const inW = px.filter((e) => Date.parse(e.ts) >= p.start - 50 && Date.parse(e.ts) <= p.end); if (!inW.length) continue;
      const ag = inW.filter((e) => agentIds.has(e.id)); const lastEnd = ag.length ? Math.max(...ag.map((e) => Date.parse(e.ts) + e.ms)) : p.start;
      startup += (Math.min(...inW.map((e) => Date.parse(e.ts))) - p.start) / 1000; tail += Math.max(0, p.end - lastEnd) / 1000;
      for (const e of inW.filter((x) => !agentIds.has(x.id))) { hiddenN++; hiddenMs += e.ms; if (Date.parse(e.ts) + e.ms <= lastEnd) midHidden += e.ms / 1000; }
    }
  } else { // code arm without process log: calibrated per-process overhead
    estimated = true; const c = r.arm === 'C2-lean' ? CAL.lean : CAL.default; const n = r.llm_invocations || 2;
    startup = n * c.startup_s; tail = n * c.tail_s; hiddenN = px.filter((e) => !agentIds.has(e.id)).length; hiddenMs = px.filter((e) => !agentIds.has(e.id)).reduce((a, e) => a + e.ms, 0);
  }
  const overhead = startup + tail + midHidden; const wall = r.grounded.wall_sessions_s;
  out.push({ seed: r.seed, arm: r.arm, cond: r.condition, estimated, cli_processes: procs.length || (r.llm_invocations || 2), startup_s: startup, tail_s: tail, mid_session_housekeeping_s: midHidden,
    housekeeping_calls: hiddenN, housekeeping_model_ms: hiddenMs, runtime_overhead_s: overhead, wall_s: wall, wall_without_runtime_overhead_s: wall - overhead });
}
fs.writeFileSync(path.join(ROOT, 'results', 'overhead.json'), JSON.stringify(out, null, 1));
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] + (s.length % 2 ? 0 : (s[s.length / 2] - s[(s.length - 1) >> 1]) / 2) : NaN; };
const arms = [...new Set(out.map((x) => x.arm + '|' + x.cond))];
for (const a of arms) { const g = out.filter((x) => x.arm + '|' + x.cond === a); console.log(a, 'n', g.length, 'est', g.some((x) => x.estimated), 'overhead', med(g.map((x) => x.runtime_overhead_s)).toFixed(1), 'startup', med(g.map((x) => x.startup_s)).toFixed(1), 'tail', med(g.map((x) => x.tail_s)).toFixed(1), 'hk calls', med(g.map((x) => x.housekeeping_calls)), 'wall', med(g.map((x) => x.wall_s)).toFixed(0), 'wall w/o', med(g.map((x) => x.wall_without_runtime_overhead_s)).toFixed(0)); }
