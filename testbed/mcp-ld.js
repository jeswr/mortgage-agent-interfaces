#!/usr/bin/env node
'use strict';
// Arm C-RDF: the common agent API in JSON-LD (schema.org / DPV / PROV-O / aw:), plus a SPARQL rates index.
// Usage: node mcp-ld.js <runDir> <basePort>
const fs = require('fs'); const path = require('path'); const { serve } = require('./mcp-lib'); const D = require('./data');
const dir = process.argv[2]; const base = Number(process.argv[3]);
const ORGS = { ...D.ORGS, cml: D.EXTRA_ORGS.cml, srm: D.EXTRA_ORGS.srm };
const orgUrl = (k) => { if (!ORGS[k]) throw new Error(`unknown org key ${k}; use one of ${Object.keys(ORGS).join(', ')}`); return `http://127.0.0.1:${base + ORGS[k].offset}`; };
const keys = Object.keys(ORGS).join(', ');
const logc = (o) => fs.appendFileSync(path.join(dir, 'agentapi-tool.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
serve('ld', [
  { name: 'ld_describe', description: `Get an organization's JSON-LD service description for the common agent API (operations, request shape, example params). org is one of: ${keys}.`, inputSchema: { type: 'object', properties: { org: { type: 'string' } }, required: ['org'] },
    handler: async (a) => (await fetch(orgUrl(a.org) + '/agent/v1/ld/describe')).text() },
  { name: 'ld_request', description: `Send a JSON-LD request (aw:AgentRequest with @context) to an organization's common agent API (POST /agent/v1/ld). Responses are JSON-LD; records carry prov: origin and a dpv:Permission (recipient, purpose). org is one of: ${keys}.`,
    inputSchema: { type: 'object', properties: { org: { type: 'string' }, request: { type: 'object', description: 'the JSON-LD request document' } }, required: ['org', 'request'] },
    handler: async (a) => { const r = await fetch(orgUrl(a.org) + '/agent/v1/ld', { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(a.request) }); logc({ org: a.org, op: a.request && (a.request['aw:operation'] || a.request.operation), status: r.status }); return `HTTP ${r.status}\n` + (await r.text()); } },
  { name: 'index_query', description: 'Run a SPARQL 1.1 SELECT query against the Mortgage Rates Index, which crawls the lenders\' published rate pages (schema.org JSON-LD embedded in each page). Vocabulary: PREFIX schema: <https://schema.org/> PREFIX aw: <https://w3id.org/agentweb-testbed#>. Each product is a schema:MortgageLoan with schema:name, schema:identifier, schema:provider (schema:FinancialService with schema:name and schema:url), schema:interestRate and schema:annualPercentageRate (percent, xsd:double), schema:loanTerm [schema:value years], aw:rateType ("fixed"|"adjustable"), aw:discountPoints, and aw:exampleLoanAmount, aw:estimatedMonthlyPayment, aw:estimatedClosingCosts (each a schema:MonetaryAmount with schema:value) for the published example loan of $440,000. Returns SPARQL JSON results.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (a) => { const r = await fetch(`http://127.0.0.1:${base + D.EXTRA_ORGS.idx.offset}/sparql`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: a.query }); logc({ org: 'idx', op: 'sparql', status: r.status }); return `HTTP ${r.status}\n` + (await r.text()); } },
]);
