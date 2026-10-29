'use strict';
// Spawning the Claude Code CLI and parsing its stream-json output / the proxy log.
const { spawn } = require('child_process');
const fs = require('fs');

function readJsonl(f) { if (!fs.existsSync(f) && fs.existsSync(f + '.gz')) return require('zlib').gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }

// Run `claude -p` and write its stdout (stream-json) to streamFile.
function runClaude({ prompt, model, cwd, env, extraArgs = [], streamFile, stderrFile, timeoutMs }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--no-session-persistence',
    '--disable-slash-commands', '--max-budget-usd', '30', ...extraArgs];
  return new Promise((resolve) => {
    const t0 = Date.now(); const out = fs.openSync(streamFile, 'a'); const err = fs.openSync(stderrFile, 'a');
    const child = spawn('claude', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, err], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } }, 5000); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(out); fs.closeSync(err); try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* group gone */ } resolve({ code, signal, timedOut, wall_s: (Date.now() - t0) / 1000 }); });
  });
}

// Model requests = distinct assistant message ids in the stream. Token usage in
// stream assistant events is a message_start snapshot (output is partial), so
// usage is taken from the proxy log entry with the same message id when present.
function parseStream(file, proxyFile) {
  const ev = readJsonl(file);
  const px = new Map(readJsonl(proxyFile || '').filter((e) => e.id && e.usage).map((e) => [e.id, e.usage]));
  const msgs = new Map(); const toolIds = new Set(); const toolNames = {}; const models = new Set(); const results = []; let init = null;
  for (const e of ev) {
    if (e.type === 'system' && e.subtype === 'init' && !init) init = { tools: e.tools, mcp_servers: e.mcp_servers, model: e.model, claude_code_version: e.claude_code_version, permissionMode: e.permissionMode };
    if (e.type === 'assistant' && e.message) {
      const m = e.message; models.add(m.model); const u = m.usage || {};
      const prev = msgs.get(m.id) || { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
      msgs.set(m.id, { input: Math.max(prev.input, u.input_tokens || 0), cache_read: Math.max(prev.cache_read, u.cache_read_input_tokens || 0),
        cache_creation: Math.max(prev.cache_creation, u.cache_creation_input_tokens || 0), output: Math.max(prev.output, u.output_tokens || 0) });
      for (const b of m.content || []) if (b.type === 'tool_use' && !toolIds.has(b.id)) { toolIds.add(b.id); toolNames[b.name] = (toolNames[b.name] || 0) + 1; }
    }
    if (e.type === 'result') results.push({ subtype: e.subtype, is_error: e.is_error, num_turns: e.num_turns, total_cost_usd: e.total_cost_usd, duration_ms: e.duration_ms, duration_api_ms: e.duration_api_ms, terminal_reason: e.terminal_reason, result: typeof e.result === 'string' ? e.result.slice(0, 2000) : null, permission_denials: (e.permission_denials || []).length });
  }
  const tok = { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
  let fromProxy = 0;
  for (const [id, su] of msgs) {
    const pu = px.get(id); let u = su;
    if (pu) { fromProxy++; u = { input: pu.input_tokens || 0, cache_read: pu.cache_read_input_tokens || 0, cache_creation: pu.cache_creation_input_tokens || 0, output: pu.output_tokens || 0 }; }
    for (const k in tok) tok[k] += u[k];
  }
  tok.total = tok.input + tok.cache_read + tok.cache_creation + tok.output;
  return { model_requests: msgs.size, usage_from_proxy: fromProxy, tokens: tok, message_ids: [...msgs.keys()], tool_calls: toolIds.size, tool_calls_by_name: toolNames, models: [...models], results, init };
}

function parseProxy(file, agentIds = []) {
  const agent = new Set(agentIds);
  const ev = readJsonl(file).filter((e) => e.method === 'POST' && /^\/v1\/messages/.test(e.path || ''));
  const tok = { input: 0, cache_read: 0, cache_creation: 0, output: 0 }; const byModel = {}; let hidden = 0; let errors = 0;
  const msgCalls = ev.filter((e) => /^\/v1\/messages(\?|$)/.test(e.path));
  for (const e of msgCalls) {
    const u = e.usage || {}; if (e.status !== 200) errors++;
    tok.input += u.input_tokens || 0; tok.cache_read += u.cache_read_input_tokens || 0; tok.cache_creation += u.cache_creation_input_tokens || 0; tok.output += u.output_tokens || 0;
    const m = e.model || e.req_model || 'unknown'; byModel[m] = (byModel[m] || 0) + 1;
    if (!agent.has(e.id)) hidden++;
  }
  tok.total = tok.input + tok.cache_read + tok.cache_creation + tok.output;
  return { api_requests: msgCalls.length, requests_not_in_stream: hidden, non_streaming_requests: msgCalls.filter((e) => !e.stream).length, other_message_endpoints: ev.length - msgCalls.length, error_responses: errors, tokens: tok, by_model: byModel };
}

module.exports = { runClaude, parseStream, parseProxy, readJsonl };
