#!/usr/bin/env node
'use strict';
// "User" MCP server: the principal's authority, credentials for this arm, and ask_user.
// Usage: node mcp-user.js <runDir>
const fs = require('fs'); const path = require('path');
const { serve } = require('./mcp-lib'); const { askUser, reissueToken } = require('./user-tool');
const dir = process.argv[2]; const flags = process.argv.slice(3); const withWallet = flags.includes('wallet'); const cond = (flags.find((f) => f.startsWith('cond=')) || 'cond=baseline').slice(5); const log = path.join(dir, 'user-tool.jsonl');
const rec = (tool) => fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), tool }) + '\n');
const tools = [
  { name: 'get_authority', description: "Read Sam and Nadia's written authority for this task (what may be shared, with whom, consents, Loan Estimate limits) and their profile.", inputSchema: { type: 'object', properties: {} },
    handler: () => { rec('get_authority'); return fs.readFileSync(path.join(dir, 'authority.json'), 'utf8'); } },
  { name: 'get_credentials', description: 'Read the addresses and credentials you can use to reach each organization.', inputSchema: { type: 'object', properties: {} },
    handler: () => { rec('get_credentials'); return fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'); } },
  { name: 'ask_user', description: 'Ask Sam and Nadia a question and get their answer. Use only for information only they can provide.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    handler: (a) => askUser(a.question, log, cond) },
];
if (withWallet) tools.push({ name: 'reissue_permission_token', description: "Ask Sam and Nadia's wallet (the issuer of the permission tokens) to re-issue an expired permission token. Returns the new token, with the same scope.", inputSchema: { type: 'object', properties: { permission_token: { type: 'string' } }, required: ['permission_token'] },
  handler: (a) => reissueToken(a.permission_token, log) });
serve('user', tools);
