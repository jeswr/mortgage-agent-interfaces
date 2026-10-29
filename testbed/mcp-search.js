#!/usr/bin/env node
'use strict';
// search-scale tools. C1: agent_request / agent_describe against any endpoint on the registry origin.
// C-RDF: index_query (SPARQL over the pre-built index of every registered lender's products).
// Usage: node mcp-search.js <runDir> <origin> <c1|crdf>
const { serve } = require('./mcp-lib');
const [dir, origin, mode] = process.argv.slice(2);
const check = (u) => { const x = new URL(u); if (x.origin !== origin) throw new Error(`endpoint must be on ${origin}`); return x.toString(); };
const tools = mode === 'crdf' ? [{ name: 'index_query', description: 'Run a SPARQL 1.1 SELECT query against the pre-built index of every licensed lender\'s published products (schema.org JSON-LD crawled from their rate pages). Vocabulary: PREFIX schema: <https://schema.org/> PREFIX aw: <https://w3id.org/agentweb-testbed#>. Each product is a schema:MortgageLoan with schema:name, schema:identifier, schema:provider (schema:FinancialService with schema:name and schema:url), schema:interestRate and schema:annualPercentageRate (percent, xsd:double), schema:loanTerm [schema:value years], aw:rateType ("fixed"|"adjustable"), aw:discountPoints, and aw:exampleLoanAmount, aw:estimatedMonthlyPayment, aw:estimatedClosingCosts (each a schema:MonetaryAmount with schema:value) for the published example loan of $440,000. Returns SPARQL JSON results.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  handler: async (a) => { const r = await fetch(`${origin}/index/sparql`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: a.query }); return `HTTP ${r.status}\n` + (await r.text()); } }]
  : [{ name: 'agent_describe', description: 'Describe the operations of a common agent API endpoint (replace /request with /describe in the endpoint URL, or pass the endpoint URL).', inputSchema: { type: 'object', properties: { endpoint: { type: 'string' } }, required: ['endpoint'] },
    handler: async (a) => (await fetch(check(a.endpoint.replace(/\/request$/, '/describe')))).text() },
  { name: 'agent_request', description: 'POST a request { operation, params } to a common agent API endpoint (a URL from the registry). The registry itself is at the registry endpoint in get_credentials (operation registry.list).', inputSchema: { type: 'object', properties: { endpoint: { type: 'string' }, operation: { type: 'string' }, params: { type: 'object' } }, required: ['endpoint', 'operation'] },
    handler: async (a) => { const r = await fetch(check(a.endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: a.operation, params: a.params || {} }) }); return `HTTP ${r.status}\n` + (await r.text()); } }];
serve('search', tools);
