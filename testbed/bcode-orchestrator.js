'use strict';
// Arm B-full-code: a deterministic program over the four organizations' own (different) bespoke APIs.
// Like C2, the model is called only for the condition: (1) what to ask the borrowers, (2) the reply.
// All per-organization differences (auth styles, paths, field names, date formats) are hand-coded here.
const fs = require('fs');
const path = require('path');
const D = require('./data');
const { askUser, notifyUser } = require('./user-tool');
const { runClaude } = require('./llm');

async function runBcode({ cond, runDir, workDir, model, env, streamFile, stderrFile, timeoutMs }) {
  const auth = JSON.parse(fs.readFileSync(path.join(runDir, 'authority.json'), 'utf8'));
  const cred = JSON.parse(fs.readFileSync(path.join(runDir, 'credentials.json'), 'utf8')).apis;
  const userLog = path.join(runDir, 'user-tool.jsonl');
  const log = []; let codeCalls = 0; let llmCalls = 0; const t0 = Date.now();
  async function http(method, url, { headers = {}, body } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      codeCalls++;
      const r = await fetch(url, { method, headers, body }); const buf = Buffer.from(await r.arrayBuffer()); log.push({ method, url: url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), status: r.status });
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1000)); continue; }
      if (r.status >= 400) throw new Error(`${method} ${url} -> ${r.status} ${buf.toString().slice(0, 300)}`);
      return /json/.test(r.headers.get('content-type') || '') ? JSON.parse(buf.toString()) : buf;
    }
    throw new Error(`${method} ${url}: retries exhausted`);
  }
  async function llm(prompt) {
    llmCalls++;
    await runClaude({ prompt, model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: Math.max(60000, timeoutMs - (Date.now() - t0)), extraArgs: ['--tools', '', '--strict-mcp-config'] });
    const ev = fs.readFileSync(streamFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
    return (ev[ev.length - 1] || {}).result || '';
  }
  const lastN = auth.machine_readable.share.statements.last_n;
  // Last n complete calendar months before today.
  const months = []; for (let i = lastN; i >= 1; i--) { const d = new Date(Date.UTC(2026, 9 - i, 1)); months.push(d.toISOString().slice(0, 7)); } // today 2026-10-29 -> 2026-08, 2026-09
  const docs = []; const holdings = [];

  // Juniper FCU: OAuth client credentials, ISO dates.
  const j = cred.juniper_fcu;
  const tok = (await http('POST', `${j.base_url}/oauth/token`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${j.client_id}&client_secret=${j.client_secret}` })).access_token;
  const JH = { authorization: `Bearer ${tok}` };
  for (const a of (await http('GET', `${j.base_url}/members/${j.member_id}/accounts`, { headers: JH })).accounts) {
    holdings.push({ institutionName: 'Juniper Federal Credit Union', holdingType: a.accountType, accountMask: a.maskedNumber.slice(-4), balanceUsd: a.currentBalance });
    const sts = (await http('GET', `${j.base_url}/accounts/${a.accountId}/statements?fromDate=${months[0]}-01&toDate=${months[months.length - 1]}-31`, { headers: JH })).statements;
    for (const s of sts) docs.push({ category: 'BANK_STATEMENT', name: `${s.statementId}.pdf`, pdf: await http('GET', `${j.base_url}/statements/${s.statementId}/pdf`, { headers: JH }) });
  }
  // Northgate: API-key headers, MM/YYYY months; personal products only.
  const n = cred.northgate_savings_bank; const NH = { 'X-NGSB-ApiKey': n.api_key, 'X-NGSB-Customer': n.customer_id };
  for (const pr of (await http('GET', `${n.base_url}/customer/products`, { headers: NH })).data.products.filter((x) => x.productType.startsWith('PERSONAL_'))) {
    holdings.push({ institutionName: 'Northgate Savings Bank', holdingType: pr.productType.replace('PERSONAL_', ''), accountMask: pr.acctSuffix, balanceUsd: pr.ledgerBal });
    for (const mo of months) {
      const st = (await http('GET', `${n.base_url}/products/${pr.productRef}/estatements?month=${mo.slice(5)}/${mo.slice(0, 4)}`, { headers: NH })).data.eStatement;
      docs.push({ category: 'BANK_STATEMENT', name: `${st.docRef}.pdf`, pdf: await http('GET', `${n.base_url}/documents/${st.docRef}?format=pdf`, { headers: NH }) });
    }
  }
  // PeoplePay: Basic auth, YYYYMMDD; last n pay statements per worker; employment details.
  const pp = cred.peoplepay_larkspur_general_hospital; const PH = { authorization: 'Basic ' + Buffer.from(`${pp.api_user}:${pp.api_password}`).toString('base64') };
  const employment = {};
  for (const [who, wn] of Object.entries(pp.worker_numbers)) {
    const w = (await http('GET', `${pp.base_url}/workers?workerNumber=${wn}`, { headers: PH })).workers[0];
    employment[who] = { employerName: 'Larkspur General Hospital', jobTitle: w.jobTitle, employedSince: `${w.hireDt.slice(0, 4)}-${w.hireDt.slice(4, 6)}`, yearlyBaseSalaryUsd: w.baseRate.amount };
    const list = (await http('GET', `${pp.base_url}/workers/${wn}/payStatements?since=20260101`, { headers: PH })).payStatements.slice(0, auth.machine_readable.share.payslips.last_n);
    for (const x of list) docs.push({ category: 'PAYSTUB', name: `${x.statementKey}.pdf`, pdf: await http('GET', `${pp.base_url}/payStatements/${x.statementKey}/file`, { headers: PH }) });
  }
  // Brightpath: JSON:API resources, session header.
  const b = cred.brightpath_home_lending; const JT = { 'content-type': 'application/vnd.api+json' };
  const sid = (await http('POST', `${b.base_url}/auth/sessions`, { headers: JT, body: JSON.stringify({ data: { type: 'sessions', attributes: { login: b.login, apiSecret: b.api_secret } } }) })).data.id;
  const BH = { ...JT, authorization: `BHL-Session ${sid}` };
  const P = auth.profile; const who = ['sam', 'nadia'];
  const attributes = {
    applicants: P.borrowers.map((x, i) => ({ legalName: x.name, dateOfBirth: x.date_of_birth, emailAddress: x.email, phoneNumber: x.phone, maritalStatus: x.marital_status, employment: employment[who[i]] })),
    residence: { line1: P.current_address.street, city: P.current_address.city, region: P.current_address.state, postalCode: P.current_address.zip, tenure: 'RENT', monthlyRentUsd: P.current_address.monthly_rent },
    collateral: { line1: P.property.street, city: P.property.city, region: P.property.state, postalCode: P.property.zip, contractPriceUsd: P.property.purchase_price, occupancyCode: 'PRIMARY' },
    financing: { principalUsd: P.loan_request.loan_amount, downPaymentUsd: P.loan_request.down_payment, productCode: 'FIX30' },
    holdings, consents: { creditPull: true, eDisclosure: true },
  };
  const la = (await http('POST', `${b.base_url}/loan-applications`, { headers: BH, body: JSON.stringify({ data: { type: 'loan-applications', attributes } }) })).data.id;
  for (const d of docs) await http('POST', `${b.base_url}/loan-applications/${la}/documents`, { headers: { authorization: BH.authorization, 'content-type': 'application/pdf', 'X-BHL-Document-Category': d.category, 'X-BHL-Filename': d.name }, body: d.pdf });
  const sub = await http('POST', `${b.base_url}/loan-applications/${la}/submission`, { headers: BH, body: JSON.stringify({ data: { type: 'submissions', attributes: { certify: true } } }) });
  let le = null;
  for (let i = 0; i < 30 && !le; i++) { try { le = (await http('GET', `${b.base_url}/loan-applications/${la}/loan-estimate`, { headers: BH })).data; } catch (e) { if (!/-> 404/.test(e.message)) throw e; await new Promise((s) => setTimeout(s, 2000)); } }
  const conds = (await http('GET', `${b.base_url}/loan-applications/${la}/conditions`, { headers: BH })).data.filter((c) => c.attributes.state === 'OPEN');
  for (const c of conds) {
    const text = c.attributes.description;
    const q = await llm(`You help a couple, Sam and Nadia Okafor-Reyes, with their mortgage application. The lender raised this underwriting condition:\n\n"${text}"\n\nWrite the single question you would ask Sam and Nadia to get the information needed to answer it. Reply with the question only.`);
    const answer = askUser(q, userLog, cond);
    const draft = await llm(`Draft a short, factual reply from Sam and Nadia Okafor-Reyes to their mortgage lender's underwriting condition.\n\nCondition: "${text}"\n\nTheir answer: "${answer}"\n\nReply with the text of the response only, no greeting line or signature placeholders.`);
    await http('POST', `${b.base_url}/conditions/${c.id}/responses`, { headers: BH, body: JSON.stringify({ data: { type: 'condition-responses', attributes: { explanation: draft.trim() } } }) });
  }
  const A = le.attributes; const L = auth.machine_readable.limits;
  const within = A.noteRatePct <= L.max_rate_percent && A.totalMonthlyPaymentUsd <= L.max_monthly_payment && A.closingCostsUsd <= L.max_closing_costs;
  if (within) await http('POST', `${b.base_url}/loan-estimates/${le.id}/intent-to-proceed`, { headers: BH, body: JSON.stringify({ data: { type: 'intents', attributes: { signedBy: 'Sam Okafor-Reyes; Nadia Okafor-Reyes' } } }) });
  const ref = sub.data.attributes.referenceNumber;
  const final = within ? `Application ${ref} submitted; intent to proceed recorded (rate ${A.noteRatePct}%, payment $${A.totalMonthlyPaymentUsd}, closing costs $${A.closingCostsUsd}).`
    : `Application ${ref} submitted, but the Loan Estimate is outside your limits (rate ${A.noteRatePct}% vs ${L.max_rate_percent}%, payment $${A.totalMonthlyPaymentUsd} vs $${L.max_monthly_payment}, closing costs $${A.closingCostsUsd} vs $${L.max_closing_costs}); intent to proceed was NOT recorded.`;
  if (!within) notifyUser(final, userLog);
  const summary = { application_id: ref, within_limits: within, final_message: final, code_calls: codeCalls, llm_calls: llmCalls, documents: docs.length, log };
  fs.writeFileSync(path.join(runDir, 'c2-log.json'), JSON.stringify(summary, null, 1));
  return summary;
}
module.exports = { runBcode };
