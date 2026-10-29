#!/usr/bin/env node
'use strict';
// "User" MCP server: the principal's authority, credentials for this arm, and ask_user.
// Usage: node mcp-user.js <runDir>
const fs = require('fs'); const path = require('path');
const { serve } = require('./mcp-lib'); const { askUser, reissueToken, requestCode, requestConsent, approveGrant, humanWait, saveNote } = require('./user-tool');
const dir = process.argv[2]; const flags = process.argv.slice(3); const withWallet = flags.includes('wallet'); const cond = (flags.find((f) => f.startsWith('cond=')) || 'cond=baseline').slice(5);
const seed = (flags.find((f) => f.startsWith('seed=')) || 'seed=').slice(5); const human = (flags.find((f) => f.startsWith('human=')) || 'human=').slice(6).split('+').filter(Boolean); const log = path.join(dir, 'user-tool.jsonl');
const rec = (tool) => fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), tool }) + '\n');
const tools = [
  { name: 'get_authority', description: "Read Sam and Nadia's written authority for this task (what may be shared, with whom, consents, Loan Estimate limits) and their profile.", inputSchema: { type: 'object', properties: {} },
    handler: () => { rec('get_authority'); return fs.readFileSync(path.join(dir, 'authority.json'), 'utf8'); } },
  { name: 'get_credentials', description: 'Read the addresses and credentials you can use to reach each organization.', inputSchema: { type: 'object', properties: {} },
    handler: () => { rec('get_credentials'); return fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'); } },
  { name: 'ask_user', description: 'Ask Sam and Nadia a question and get their answer. Use only for information only they can provide.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    handler: async (a) => { await humanWait('ask_user', cond, dir); return askUser(a.question, log, cond); } },
];
if (withWallet) tools.push({ name: 'reissue_permission_token', description: "Ask Sam and Nadia's wallet (the issuer of the permission tokens) to re-issue an expired permission token. Returns the new token, with the same scope.", inputSchema: { type: 'object', properties: { permission_token: { type: 'string' } }, required: ['permission_token'] },
  handler: (a) => reissueToken(a.permission_token, log) });
if (human.includes('code')) tools.push({ name: 'request_code', description: 'Ask Sam or Nadia for the one-time verification code an organization has just sent them (by text message or email) during sign-in.', inputSchema: { type: 'object', properties: { org: { type: 'string', description: 'organization name' }, channel: { type: 'string', description: 'sms or email' } }, required: ['org'] },
  handler: async (a) => { await humanWait('request_code', cond, dir); return requestCode(a.org, a.channel, dir); } });
if (human.includes('consent')) tools.push({ name: 'request_consent', description: "Ask Sam or Nadia to approve an organization's OAuth consent screen for your access. Returns a one-time authorization code to exchange for tokens.", inputSchema: { type: 'object', properties: { org: { type: 'string' }, scopes: { type: 'string', description: 'what access you are requesting' } }, required: ['org'] },
  handler: async (a) => { await humanWait('request_consent', cond, dir); return requestConsent(a.org, a.scopes, dir, seed); } });
const standing = flags.includes('standing');
if (human.includes('grant')) tools.push({ name: 'approve_grant', description: standing ? "Get a permission grant for one organization from Sam and Nadia's wallet, under the standing delegation they approved in advance for this mortgage (no human step). Returns permission token(s). For banks and payroll, name the lender (recipient) the records are for." : "Ask Sam and Nadia's wallet to issue a permission grant for one organization; they approve it once. Returns permission token(s). For banks and payroll, name the lender (recipient) the records are for.", inputSchema: { type: 'object', properties: { org: { type: 'string' }, scope: { type: 'string', description: 'what the grant is for' }, recipient: { type: 'string', description: 'recipient lender (for data organizations)' } }, required: ['org'] },
  handler: async (a) => { if (!standing) await humanWait('approve_grant', cond, dir); return approveGrant(a.org, a.scope, a.recipient, dir, seed, cond, standing); } });
if (flags.includes('choice')) tools.push({ name: 'report_choice', description: 'Report the lender you have chosen (and the product and rate) to Sam and Nadia. Call it once.', inputSchema: { type: 'object', properties: { lender: { type: 'string' }, product: { type: 'string' }, rate_percent: { type: 'number' } }, required: ['lender'] },
  handler: (a) => { fs.appendFileSync(path.join(dir, 'choice.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...a }) + '\n'); return 'Thank you, noted.'; } });
if (cond === 'grounded') tools.push({ name: 'save_note', description: 'Save a handover note for your future self. It replaces any earlier note and is given to you when this task is resumed in a new session.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  handler: (a) => saveNote(a.note, dir) });
// A session nonce in the first tool's description gives the resumed session a fresh prompt cache (no carry-over from session 1).
const nonce = (flags.find((f) => f.startsWith('nonce=')) || '').slice(6); if (nonce) tools[0].description += ` (session ${nonce})`;
serve('user', tools);
