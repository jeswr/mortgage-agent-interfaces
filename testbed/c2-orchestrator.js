'use strict';
// Arm C2: the routine flow is ordinary code over the common agent API.
// The LLM is called only for judgment: interpreting the lender's condition
// (what to ask the borrowers) and drafting the reply to the lender.
const fs = require('fs');
const path = require('path');
const D = require('./data');
const { askUser, reissueToken, notifyUser } = require('./user-tool');
const { runClaude } = require('./llm');

async function runC2({ cond, runDir, workDir, base, model, env, streamFile, stderrFile, timeoutMs }) {
  const auth = JSON.parse(fs.readFileSync(path.join(runDir, 'authority.json'), 'utf8'));
  const cred = JSON.parse(fs.readFileSync(path.join(runDir, 'credentials.json'), 'utf8'));
  const log = []; let codeCalls = 0; let llmCalls = 0; const t0 = Date.now();
  const id = cred.identifiers;
  const tokenFor = (org, subject) => cred.permission_tokens.find((t) => t.org === org && (!subject || t.subject === subject)).token;
  const current = {}; // original token -> currently valid token (re-issued after expiry)
  async function call(org, operation, subject, permission_token, params) {
    for (let attempt = 0; attempt < 4; attempt++) {
      codeCalls++; const tok = current[permission_token] || permission_token;
      const r = await fetch(`http://127.0.0.1:${base + D.ORGS[org].offset}/agent/v1/request`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, subject, on_behalf_of: subject, recipient: id.lender_recipient, purpose: id.purpose, permission_token: tok, params }) });
      const j = await r.json(); log.push({ org, operation, status: r.status });
      if (r.status === 200) return j;
      if (r.status === 503) { await new Promise((res) => setTimeout(res, 1000 * (j.retry_after_s || 1))); continue; } // transient: retry
      if (r.status === 401 && j.error === 'token_expired') { current[permission_token] = reissueToken(tok, path.join(runDir, 'user-tool.jsonl')); continue; } // ask the wallet
      throw new Error(`${org} ${operation} -> ${r.status} ${JSON.stringify(j)}`);
    }
    throw new Error(`${org} ${operation}: retries exhausted`);
  }
  async function llm(prompt) {
    llmCalls++;
    const r = await runClaude({ prompt, model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: Math.max(60000, timeoutMs - (Date.now() - t0)), extraArgs: ['--tools', '', '--strict-mcp-config'] });
    const ev = fs.readFileSync(streamFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
    return { text: (ev[ev.length - 1] || {}).result || '', run: r };
  }

  // 1. Records, selected from the permission scopes the user granted.
  const refs = []; const statements = {}; const payslips = {};
  for (const g of cred.permission_tokens.filter((t) => t.org === 'jfcu' || t.org === 'nsb')) {
    const list = await call(g.org, 'records.list', g.subject, g.token, { record_type: 'account' });
    const mine = list.accounts.filter((a) => a.ownership === 'personal');
    const items = mine.flatMap((a) => a.statements_available.slice(-auth.machine_readable.share.statements.last_n).map((p) => ({ record_type: 'statement', account_id: a.account_id, period: p })));
    const got = await call(g.org, 'records.provide', g.subject, g.token, { items });
    for (const r of got.records) { refs.push(r.record_ref); (statements[r.content.account_id] ||= []).push(r.content); }
    for (const a of mine) statements[a.account_id].current_balance = a.current_balance;
  }
  for (const g of cred.permission_tokens.filter((t) => t.org === 'lgh')) {
    const list = await call('lgh', 'records.list', g.subject, g.token, { record_type: 'payslip' });
    const items = list.records.slice(0, auth.machine_readable.share.payslips.last_n).map((x) => ({ record_type: 'payslip', record_id: x.record_id }));
    const got = await call('lgh', 'records.provide', g.subject, g.token, { items });
    for (const r of got.records) { refs.push(r.record_ref); (payslips[g.subject] ||= []).push(r.content); }
  }
  // 2. Application from the profile and the records.
  const P = auth.profile; const subj = [id.sam, id.nadia];
  const application = {
    borrowers: P.borrowers.map((b, i) => { const ps = payslips[subj[i]][0]; return { ...b, employer: ps.employer, position: ps.position, start_date: ps.hire_date, annual_base_income: ps.annual_base_salary }; }),
    current_address: P.current_address, property: P.property,
    loan: { loan_amount: P.loan_request.loan_amount, down_payment: P.loan_request.down_payment, product: P.loan_request.loan_type },
    assets: Object.entries(statements).map(([acct, sts]) => ({ institution: acct.startsWith('jfcu') ? 'Juniper Federal Credit Union' : 'Northgate Savings Bank', account_type: sts[0].account_type, last4: sts[0].last4, balance: sts.current_balance })),
  };
  const bhl = tokenFor('bhl');
  const sub = await call('bhl', 'application.submit', id.household, bhl, { application, records: refs, consents: { credit_check: true, esign: true } });
  // 3. Wait for the Loan Estimate.
  let st;
  for (let i = 0; i < 30; i++) { st = await call('bhl', 'application.status', id.household, bhl, { application_id: sub.application_id }); if (st.loan_estimate) break; await new Promise((r) => setTimeout(r, 2000)); }
  // 4. Conditions: the two judgment steps go to the LLM.
  for (const c of st.conditions.filter((x) => x.status === 'open')) {
    const q = await llm(`You help a couple, Sam and Nadia Okafor-Reyes, with their mortgage application. The lender raised this underwriting condition:\n\n"${c.text}"\n\nWrite the single question you would ask Sam and Nadia to get the information needed to answer it. Reply with the question only.`);
    const answer = askUser(q.text, path.join(runDir, 'user-tool.jsonl'), cond);
    const draft = await llm(`Draft a short, factual reply from Sam and Nadia Okafor-Reyes to their mortgage lender's underwriting condition.\n\nCondition: "${c.text}"\n\nTheir answer: "${answer}"\n\nReply with the text of the response only, no greeting line or signature placeholders.`);
    await call('bhl', 'condition.respond', id.household, bhl, { application_id: sub.application_id, condition_id: c.condition_id, response: draft.text.trim() });
  }
  // 5. Loan Estimate limits are checked in code.
  const le = st.loan_estimate; const L = auth.machine_readable.limits;
  const within = le.rate_percent <= L.max_rate_percent && le.estimated_total_monthly_payment <= L.max_monthly_payment && le.closing_costs <= L.max_closing_costs;
  if (within) await call('bhl', 'estimate.accept_intent', id.household, bhl, { application_id: sub.application_id, estimate_id: le.estimate_id });
  const final = within ? `Application ${sub.application_id} submitted; intent to proceed recorded (rate ${le.rate_percent}%, payment $${le.estimated_total_monthly_payment}, closing costs $${le.closing_costs}).`
    : `Application ${sub.application_id} submitted, but the Loan Estimate is outside your limits (rate ${le.rate_percent}% vs ${L.max_rate_percent}%, payment $${le.estimated_total_monthly_payment} vs $${L.max_monthly_payment}, closing costs $${le.closing_costs} vs $${L.max_closing_costs}); intent to proceed was NOT recorded.`;
  if (!within) notifyUser(final, path.join(runDir, 'user-tool.jsonl'));
  const summary = { application_id: sub.application_id, within_limits: within, final_message: final, code_calls: codeCalls, llm_calls: llmCalls, log };
  fs.writeFileSync(path.join(runDir, 'c2-log.json'), JSON.stringify(summary, null, 1));
  return summary;
}
module.exports = { runC2 };
