'use strict';
// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited), no dependencies.
const readline = require('readline');
function serve(name, tools) {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg; try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.id === undefined) return; // notification
    const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (msg.method === 'initialize') return reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } });
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
    if (msg.method === 'tools/call') {
      const t = byName[msg.params.name]; if (!t) return fail(-32602, 'unknown tool');
      try { const r = await t.handler(msg.params.arguments || {}); return reply({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] }); }
      catch (e) { return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
    }
    return fail(-32601, 'method not found');
  });
}
module.exports = { serve };
