#!/usr/bin/env node
'use strict';
// HTTP request tool restricted to an allow-list of local origins (arm B).
// Usage: node mcp-http.js <runDir> <origin1,origin2,...>
const fs = require('fs'); const path = require('path'); const { serve } = require('./mcp-lib');
const dir = process.argv[2]; const allowed = (process.argv[3] || '').split(',').filter(Boolean); const withUpload = process.argv[4] === 'upload';
const dl = path.join(dir, 'work', 'downloads'); fs.mkdirSync(dl, { recursive: true });
const log = (o) => fs.appendFileSync(path.join(dir, 'http-tool.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
const tool = {
  name: 'http_request',
  description: `Make an HTTP request to an allowed API origin (${allowed.join(', ')}). Returns status, content-type and body text (truncated at 20000 characters). Binary bodies are not returned inline: pass save_as (a file name) to save the body under the downloads folder; the result gives the absolute path.${withUpload ? ' To send a saved file as the request body, pass body_file (its path or file name in the downloads folder) instead of body.' : ''}`,
  inputSchema: { type: 'object', properties: { method: { type: 'string', description: 'GET, POST, ...' }, url: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string', description: 'request body as a string' }, save_as: { type: 'string', description: 'optional file name to save the response body to' } }, required: ['url'] },
  handler: async (a) => {
    const u = new URL(a.url); const request = { method: a.method || 'GET', url: a.url, headers: a.headers || {}, body: a.body, save_as: a.save_as };
    if (!allowed.includes(u.origin)) { log({ request, denied: true }); throw new Error(`origin ${u.origin} is not allowed`); }
    let reqBody = a.body;
    if (withUpload && a.body_file) { const fp = path.isAbsolute(a.body_file) ? a.body_file : path.join(dl, a.body_file); if (!path.resolve(fp).startsWith(path.resolve(dl))) throw new Error('body_file must be in the downloads folder'); reqBody = fs.readFileSync(fp); request.body_file = path.basename(fp); }
    const r = await fetch(a.url, { method: request.method, headers: request.headers, body: reqBody });
    const buf = Buffer.from(await r.arrayBuffer()); const ct = r.headers.get('content-type') || '';
    log({ request, status: r.status, bytes: buf.length });
    const head = `HTTP ${r.status}\ncontent-type: ${ct}\n`;
    if (a.save_as) { const f = path.join(dl, path.basename(a.save_as)); fs.writeFileSync(f, buf); return `${head}saved ${buf.length} bytes to ${f}`; }
    if (!/json|text|xml|html/.test(ct)) return `${head}[binary body, ${buf.length} bytes; use save_as to save it]`;
    const t = buf.toString('utf8'); return head + '\n' + (t.length > 20000 ? t.slice(0, 20000) + '\n[truncated]' : t);
  },
};
if (withUpload) tool.inputSchema.properties.body_file = { type: 'string', description: 'optional: send this saved file (in the downloads folder) as the request body' };
serve('http', [tool]);
