'use strict';
// Arm B-full-code, grounded condition: a deterministic program over the four organizations' own (different) APIs,
// split into two phases like the agent sessions. Consumer access is by OAuth consent (request_consent, with the human wait);
// phase 2 uses refresh tokens only. Two model calls for the underwriting conditions, as in C2.
const fs = require('fs');
const path = require('path');
const U = require('./user-tool');
const { runClaude } = require('./llm');

async function runBcodeGrounded({ phase, cond, seed, runDir, workDir, model, env, streamFile, stderrFile, timeoutMs }) {
  const auth = JSON.parse(fs.readFileSync(path.join(runDir, 'authority.json'), 'utf8'));
  const cred = JSON.parse(fs.readFileSync(path.join(runDir, 'credentials.json'), 'utf8'));
  const A = cred.apis; const ulog = path.join(runDir, 'user-tool.jsonl'); const noteFile = path.join(runDir, 'handover-note.json');
  const log = []; let codeCalls = 0; let llmCalls = 0; const t0 = Date.now(); const lim = auth.machine_readable.limits;
  async function http(method, url, { headers = {}, body } = {}) {
    codeCalls++; const r = await fetch(url, { method, headers, body }); const buf = Buffer.from(await r.arrayBuffer());
    log.push({ method, url: url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), status: r.status });
    if (r.status >= 400) throw new Error(`${method} ${url} -> ${r.status} ${buf.toString().slice(0, 300)}`);
    const ct = r.headers.get('content-type') || ''; return /json/.test(ct) ? JSON.parse(buf.toString()) : /html|text/.test(ct) ? buf.toString() : buf;
  }
  async function llm(prompt) {
    llmCalls++;
    await runClaude({ prompt, model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: Math.max(60000, timeoutMs - (Date.now() - t0)), extraArgs: ['--tools', '', '--strict-mcp-config'] });
    const ev = fs.readFileSync(streamFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
    return (ev[ev.length - 1] || {}).result || '';
  }
  const consent = async (org, scopes) => { await U.humanWait('request_consent', cond, runDir); const t = U.requestConsent(org, scopes, runDir, seed); return /Authorization code: (\S+) /.exec(t)[1]; };
  const form = { 'content-type': 'application/x-www-form-urlencoded' }; const JT = { 'content-type': 'application/vnd.api+json' };
  const j = A.juniper_fcu; const n = A.northgate_savings_bank; const pp = A.peoplepay_larkspur_general_hospital; const b = A.brightpath_home_lending;

  if (phase === 1) {
    // Discovery: the three public rates pages, read through their embedded schema.org JSON-LD.
    const pages = [b.rates_page, cred.websites.cascade_mutual_home_loans.rates_page, cred.websites.summit_ridge_mortgage.rates_page]; const offers = [];
    for (const url of pages) {
      const html = await http('GET', url, { headers: { cookie: '' } }); const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html); const g = JSON.parse(m[1])['@graph'];
      const org = g.find((x) => x['@type'] === 'schema:FinancialService');
      for (const x of g.filter((y) => y['@type'] === 'schema:MortgageLoan')) {
        if (x['schema:loanTerm']['schema:value'] === 30 && x['aw:rateType'] === 'fixed' && x['schema:interestRate'] <= lim.max_rate_percent && x['aw:estimatedMonthlyPayment']['schema:value'] <= lim.max_monthly_payment && x['aw:estimatedClosingCosts']['schema:value'] <= lim.max_closing_costs)
          offers.push({ lender: org['schema:name'], rate: x['schema:interestRate'] });
      }
    }
    offers.sort((a, c) => a.rate - c.rate); const tChoice = (Date.now() - t0) / 1000;
    if (offers[0].lender !== b.name) throw new Error(`chosen lender ${offers[0].lender} has no API in this arm`);
    // One consent per organization, each exchanged at that API's own token endpoint.
    const jt = await http('POST', `${j.base_url}/oauth/token`, { headers: form, body: `grant_type=authorization_code&code=${await consent('jfcu', 'accounts statements')}&client_id=${j.client_id}` });
    const nt = (await http('POST', `${n.base_url}/oauth2/token`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grantType: 'AUTHORIZATION_CODE', authCode: await consent('nsb', 'products estatements') }) })).data;
    const lt = await http('POST', `${pp.base_url}/auth/token`, { headers: form, body: `grant_type=authorization_code&code=${await consent('lgh', 'workers payStatements taxForms')}` });
    const bs = (await http('POST', `${b.base_url}/auth/sessions`, { headers: JT, body: JSON.stringify({ data: { type: 'sessions', attributes: { authorizationCode: await consent('bhl', 'loan application') } } }) })).data;
    const JH = { authorization: `Bearer ${jt.access_token}` }; const NH = { authorization: `Bearer ${nt.accessToken}` }; const PH = { authorization: `Bearer ${lt.access_token}` }; const BH = { ...JT, authorization: `BHL-Session ${bs.id}` };
    const holdings = []; const jAccts = []; const nProducts = [];
    for (const a of (await http('GET', `${j.base_url}/members/${j.member_id}/accounts`, { headers: JH })).accounts) { holdings.push({ institutionName: 'Juniper Federal Credit Union', holdingType: a.accountType, accountMask: a.maskedNumber.slice(-4), balanceUsd: a.currentBalance }); jAccts.push(a.accountId); }
    for (const pr of (await http('GET', `${n.base_url}/customer/products`, { headers: NH })).data.products.filter((x) => x.productType.startsWith('PERSONAL_'))) { holdings.push({ institutionName: 'Northgate Savings Bank', holdingType: pr.productType.replace('PERSONAL_', ''), accountMask: pr.acctSuffix, balanceUsd: pr.ledgerBal }); nProducts.push(pr.productRef); }
    const employment = {};
    for (const [who, wn] of Object.entries(pp.worker_numbers)) { const w = (await http('GET', `${pp.base_url}/workers?workerNumber=${wn}`, { headers: PH })).workers[0]; employment[who] = { employerName: 'Larkspur General Hospital', jobTitle: w.jobTitle, employedSince: `${w.hireDt.slice(0, 4)}-${w.hireDt.slice(4, 6)}`, yearlyBaseSalaryUsd: w.baseRate.amount }; }
    const P = auth.profile; const who = ['sam', 'nadia'];
    const attributes = {
      applicants: P.borrowers.map((x, i) => ({ legalName: x.name, dateOfBirth: x.date_of_birth, emailAddress: x.email, phoneNumber: x.phone, maritalStatus: x.marital_status, employment: employment[who[i]] })),
      residence: { line1: P.current_address.street, city: P.current_address.city, region: P.current_address.state, postalCode: P.current_address.zip, tenure: 'RENT', monthlyRentUsd: P.current_address.monthly_rent },
      collateral: { line1: P.property.street, city: P.property.city, region: P.property.state, postalCode: P.property.zip, contractPriceUsd: P.property.purchase_price, occupancyCode: 'PRIMARY' },
      financing: { principalUsd: P.loan_request.loan_amount, downPaymentUsd: P.loan_request.down_payment, productCode: 'FIX30' }, holdings, consents: { creditPull: true, eDisclosure: true },
    };
    const la = (await http('POST', `${b.base_url}/loan-applications`, { headers: BH, body: JSON.stringify({ data: { type: 'loan-applications', attributes } }) })).data.id;
    const sub = await http('POST', `${b.base_url}/loan-applications/${la}/submission`, { headers: BH, body: JSON.stringify({ data: { type: 'submissions', attributes: { certify: true } } }) });
    fs.writeFileSync(noteFile, JSON.stringify({ la, ref: sub.data.attributes.referenceNumber, refresh: { jfcu: jt.refresh_token, nsb: nt.refreshToken, lgh: lt.refresh_token, bhl: bs.attributes.refreshToken }, jAccts, nProducts }, null, 1));
    return { phase, t_choice_s: tChoice, code_calls: codeCalls, llm_calls: llmCalls, log };
  }

  // Phase 2: refresh tokens only (no human), from the saved note.
  const note = JSON.parse(fs.readFileSync(noteFile, 'utf8'));
  const jt = await http('POST', `${j.base_url}/oauth/token`, { headers: form, body: `grant_type=refresh_token&refresh_token=${note.refresh.jfcu}` });
  const nt = (await http('POST', `${n.base_url}/oauth2/token`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grantType: 'REFRESH_TOKEN', refreshToken: note.refresh.nsb }) })).data;
  const lt = await http('POST', `${pp.base_url}/auth/token`, { headers: form, body: `grant_type=refresh_token&refresh_token=${note.refresh.lgh}` });
  const bs = (await http('POST', `${b.base_url}/auth/sessions`, { headers: JT, body: JSON.stringify({ data: { type: 'sessions', attributes: { refreshToken: note.refresh.bhl } } }) })).data;
  const JH = { authorization: `Bearer ${jt.access_token}` }; const NH = { authorization: `Bearer ${nt.accessToken}` }; const PH = { authorization: `Bearer ${lt.access_token}` }; const BH = { ...JT, authorization: `BHL-Session ${bs.id}` };
  const le = (await http('GET', `${b.base_url}/loan-applications/${note.la}/loan-estimate`, { headers: BH })).data; const L = le.attributes;
  if (!(L.noteRatePct <= lim.max_rate_percent && L.totalMonthlyPaymentUsd <= lim.max_monthly_payment && L.closingCostsUsd <= lim.max_closing_costs)) { U.notifyUser('Loan Estimate outside limits; intent not recorded.', ulog); return { phase, final_message: 'outside limits', code_calls: codeCalls, llm_calls: llmCalls, log }; }
  await http('POST', `${b.base_url}/loan-estimates/${le.id}/intent-to-proceed`, { headers: BH, body: JSON.stringify({ data: { type: 'intents', attributes: { signedBy: 'Sam Okafor-Reyes; Nadia Okafor-Reyes' } } }) });
  const months = ['2026-08', '2026-09']; const docs = [];
  for (const a of note.jAccts) for (const s of (await http('GET', `${j.base_url}/accounts/${a}/statements?fromDate=${months[0]}-01&toDate=${months[1]}-31`, { headers: JH })).statements) docs.push({ cat: 'BANK_STATEMENT', name: `${s.statementId}.pdf`, pdf: await http('GET', `${j.base_url}/statements/${s.statementId}/pdf`, { headers: JH }) });
  for (const pr of note.nProducts) for (const mo of months) { const st = (await http('GET', `${n.base_url}/products/${pr}/estatements?month=${mo.slice(5)}/${mo.slice(0, 4)}`, { headers: NH })).data.eStatement; docs.push({ cat: 'BANK_STATEMENT', name: `${st.docRef}.pdf`, pdf: await http('GET', `${n.base_url}/documents/${st.docRef}?format=pdf`, { headers: NH }) }); }
  for (const wn of Object.values(pp.worker_numbers)) for (const x of (await http('GET', `${pp.base_url}/workers/${wn}/payStatements?since=20260101`, { headers: PH })).payStatements.slice(0, 2)) docs.push({ cat: 'PAYSTUB', name: `${x.statementKey}.pdf`, pdf: await http('GET', `${pp.base_url}/payStatements/${x.statementKey}/file`, { headers: PH }) });
  for (const d of docs) await http('POST', `${b.base_url}/loan-applications/${note.la}/documents`, { headers: { authorization: BH.authorization, 'content-type': 'application/pdf', 'X-BHL-Document-Category': d.cat, 'X-BHL-Filename': d.name }, body: d.pdf });
  await http('POST', `${b.base_url}/loan-applications/${note.la}/document-package`, { headers: BH, body: '{}' });
  const conds = (await http('GET', `${b.base_url}/loan-applications/${note.la}/conditions`, { headers: BH })).data.filter((c) => c.attributes.state === 'OPEN').map((c) => ({ condition_id: c.id, text: c.attributes.description }));
  const raw = await llm(`A mortgage lender raised these underwriting conditions for Sam and Nadia Okafor-Reyes:\n${conds.map((c) => `- ${c.condition_id}: "${c.text}"`).join('\n')}\n\nFor each condition, decide whether it needs a written explanation that only the borrowers can give, or documents. Documents can be: "w2" (W-2 from the payroll service), "payslip", or "statement". Reply with JSON only, an array of objects: {"condition_id": "...", "kind": "explanation" | "documents", "question_for_borrowers": "..." (explanation only), "documents": "w2" | "payslip" | "statement" | null}.`);
  let plan = []; try { plan = JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) { plan = []; }
  const answers = [];
  for (const x of plan.filter((p) => p.kind === 'explanation')) { await U.humanWait('ask_user', cond, runDir); answers.push({ condition_id: x.condition_id, text: conds.find((c) => c.condition_id === x.condition_id)?.text, answer: U.askUser(x.question_for_borrowers, ulog, cond) }); }
  if (answers.length) {
    const draftRaw = await llm(`Draft short, factual replies from Sam and Nadia Okafor-Reyes to their mortgage lender's underwriting conditions.\n\n${answers.map((a) => `Condition ${a.condition_id}: "${a.text}"\nTheir answer: "${a.answer}"`).join('\n\n')}\n\nReply with JSON only: an array of {"condition_id": "...", "response": "..."}; no greeting lines or signature placeholders.`);
    let drafts = []; try { drafts = JSON.parse((draftRaw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) { drafts = []; }
    for (const d of drafts) await http('POST', `${b.base_url}/conditions/${d.condition_id}/responses`, { headers: BH, body: JSON.stringify({ data: { type: 'condition-responses', attributes: { explanation: d.response } } }) });
  }
  for (const x of plan.filter((p) => p.kind === 'documents' && p.documents === 'w2')) {
    for (const wn of Object.values(pp.worker_numbers)) for (const f of (await http('GET', `${pp.base_url}/workers/${wn}/taxForms?year=${auth.machine_readable.share.w2.tax_year}`, { headers: PH })).taxForms)
      await http('POST', `${b.base_url}/conditions/${x.condition_id}/documents`, { headers: { authorization: BH.authorization, 'content-type': 'application/pdf', 'X-BHL-Filename': `${f.formKey}.pdf` }, body: await http('GET', `${pp.base_url}/taxForms/${f.formKey}/file`, { headers: PH }) });
    await http('POST', `${b.base_url}/conditions/${x.condition_id}/responses`, { headers: BH, body: JSON.stringify({ data: { type: 'condition-responses', attributes: { explanation: 'W-2s for tax year 2025 for both borrowers are attached.' } } }) });
  }
  const final = `Application ${note.ref}: intent recorded (rate ${L.noteRatePct}%), ${docs.length} documents uploaded, ${plan.length} conditions answered.`;
  fs.writeFileSync(path.join(runDir, 'c2-log.json'), JSON.stringify({ final_message: final, plan, log }, null, 1));
  return { phase, final_message: final, code_calls: codeCalls, llm_calls: llmCalls, log };
}
module.exports = { runBcodeGrounded };
