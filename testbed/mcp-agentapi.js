#!/usr/bin/env node
'use strict';
// Uniform tool set over the common agent API (arm C1).
// Usage: node mcp-agentapi.js <runDir> <basePort>
const fs = require('fs'); const path = require('path'); const { serve } = require('./mcp-lib'); const D = require('./data');
const dir = process.argv[2]; const base = Number(process.argv[3]);
const orgUrl = (k) => { if (!D.ORGS[k]) throw new Error(`unknown org key ${k}; use one of ${Object.keys(D.ORGS).join(', ')}`); return `http://127.0.0.1:${base + D.ORGS[k].offset}`; };
const keys = Object.keys(D.ORGS).join(', ');
serve('agentapi', [
  { name: 'agent_describe', description: `Describe the operations an organization supports on the common agent API. org is one of: ${keys}.`, inputSchema: { type: 'object', properties: { org: { type: 'string' } }, required: ['org'] },
    handler: async (a) => (await fetch(orgUrl(a.org) + '/agent/v1/describe')).text() },
  { name: 'agent_request', description: `Call an operation on an organization's common agent API (POST /agent/v1/request). org is one of: ${keys}. The server checks every call against permission_token.`,
    inputSchema: { type: 'object', properties: { org: { type: 'string' }, operation: { type: 'string' }, subject: { type: 'string' }, on_behalf_of: { type: 'string' }, recipient: { type: 'string' }, purpose: { type: 'string' }, permission_token: { type: 'string' }, params: { type: 'object' } }, required: ['org', 'operation', 'permission_token'] },
    handler: async (a) => {
      const { org, ...body } = a; const r = await fetch(orgUrl(org) + '/agent/v1/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      fs.appendFileSync(path.join(dir, 'agentapi-tool.jsonl'), JSON.stringify({ ts: new Date().toISOString(), org, operation: a.operation, status: r.status }) + '\n');
      return `HTTP ${r.status}\n` + (await r.text());
    } },
]);
