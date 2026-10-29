'use strict';
// Arms C2 and C2-lean, grounded condition: the routine flow is code over the common agent API, split in two phases
// like the agent sessions (phase 1 ends at submission; phase 2 starts from the saved note when the Loan Estimate exists).
// Model calls happen only for judgment about the underwriting conditions: (1) interpret them, (2) draft the explanation.
// C2-lean runs the same two calls with a one-line --system-prompt instead of the CLI default.
const fs = require('fs');
const path = require('path');
const D = require('./data');
const F = require('./fixtures');
const U = require('./user-tool');
const { runClaude } = require('./llm');

async function runC2Grounded({ phase, cond, seed, runDir, workDir, base, model, env, streamFile, stderrFile, timeoutMs, lean, standing }) {
  const auth = JSON.parse(fs.readFileSync(path.join(runDir, 'authority.json'), 'utf8'));
  const cred = JSON.parse(fs.readFileSync(path.join(runDir, 'credentials.json'), 'utf8'));
  const id = cred.identifiers; const ulog = path.join(runDir, 'user-tool.jsonl'); const noteFile = path.join(runDir, 'handover-note.json');
  const ORGS = { ...D.ORGS, ...D.EXTRA_ORGS }; const log = []; let codeCalls = 0; let llmCalls = 0; const t0 = Date.now();
  async function call(org, operation, subject, token, params, recipient) {
    codeCalls++;
    const r = await fetch(`http://127.0.0.1:${base + ORGS[org].offset}/agent/v1/request`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, subject, on_behalf_of: subject, recipient, purpose: id.purpose, permission_token: token, params }) });
    const j = await r.json(); log.push({ org, operation, status: r.status }); if (r.status !== 200) throw new Error(`${org} ${operation} -> ${r.status} ${JSON.stringify(j)}`); return j;
  }
  async function llm(prompt) {
    llmCalls++;
    const extra = ['--tools', '', '--strict-mcp-config', ...(lean ? ['--system-prompt', 'You are a concise assistant. Follow the instructions exactly.'] : [])];
    await runClaude({ prompt, model, cwd: workDir, env, streamFile, stderrFile, timeoutMs: Math.max(60000, timeoutMs - (Date.now() - t0)), extraArgs: extra });
    const ev = fs.readFileSync(streamFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
    return (ev[ev.length - 1] || {}).result || '';
  }
  const lim = auth.machine_readable.limits;

  if (phase === 1) {
    // Discovery: public products.list; lowest 30-year fixed rate whose example figures fit the limits.
    const offers = [];
    for (const k of D.LENDER_KEYS) { const j = await call(k, 'products.list'); for (const x of j.products) if (x.term_years === 30 && x.rate_type === 'fixed' && x.rate_percent <= lim.max_rate_percent && x.estimated_monthly_payment <= lim.max_monthly_payment && x.estimated_closing_costs <= lim.max_closing_costs) offers.push({ k, ...x }); }
    offers.sort((a, b) => a.rate_percent - b.rate_percent); const LK = offers[0].k; const tChoice = (Date.now() - t0) / 1000; const recipient = F.LENDER_IDS[LK];
    // One wallet approval per organization (same function, same human wait as the agents).
    const tokens = [];
    for (const org of ['jfcu', 'nsb', 'lgh', LK]) { if (!standing) await U.humanWait('approve_grant', cond, runDir); const out = JSON.parse(U.approveGrant(org, 'authorised records / application for this mortgage', LK, runDir, seed, cond, standing)); for (const t of out.tokens) tokens.push({ org, subject: t.subject, token: t.token }); }
    const tok = (org, subject) => tokens.find((t) => t.org === org && (!subject || t.subject === subject)).token;
    // Balances (for the assets section) and income (payslips) are needed for the application itself.
    const accounts = []; const assets = [];
    for (const org of ['jfcu', 'nsb']) {
      const t = tokens.find((x) => x.org === org); const j = await call(org, 'records.list', t.subject, t.token, { record_type: 'account' }, recipient);
      for (const a of j.accounts.filter((x) => x.ownership === 'personal')) { accounts.push({ org, subject: t.subject, account_id: a.account_id, periods: a.statements_available.slice(-auth.machine_readable.share.statements.last_n) });
        assets.push({ institution: ORGS[org].name, account_type: a.type, last4: a.last4, balance: a.current_balance }); }
    }
    const payslipRefs = []; const pay = {};
    for (const subj of [id.sam, id.nadia]) {
      const t = tok('lgh', subj); const j = await call('lgh', 'records.list', subj, t, { record_type: 'payslip' }, recipient);
      const got = await call('lgh', 'records.provide', subj, t, { items: j.records.slice(0, 2).map((x) => ({ record_type: 'payslip', record_id: x.record_id })) }, recipient);
      for (const r of got.records) payslipRefs.push(r.record_ref); pay[subj] = got.records[0].content;
    }
    const P = auth.profile; const subj = [id.sam, id.nadia];
    const application = {
      borrowers: P.borrowers.map((b, i) => ({ ...b, employer: pay[subj[i]].employer, position: pay[subj[i]].position, start_date: pay[subj[i]].hire_date, annual_base_income: pay[subj[i]].annual_base_salary })),
      current_address: P.current_address, property: P.property, loan: { loan_amount: P.loan_request.loan_amount, down_payment: P.loan_request.down_payment, product: P.loan_request.loan_type }, assets,
    };
    const sub = await call(LK, 'application.submit', id.household, tok(LK), { application, consents: { credit_check: true, esign: true } }, recipient);
    const note = { lender: LK, recipient, application_id: sub.application_id, tokens, accounts, payslip_refs: payslipRefs };
    fs.writeFileSync(noteFile, JSON.stringify(note, null, 1));
    return { phase, chosen_lender: LK, t_choice_s: tChoice, code_calls: codeCalls, llm_calls: llmCalls, log };
  }

  // Phase 2: only the saved note carries state.
  const note = JSON.parse(fs.readFileSync(noteFile, 'utf8')); const LK = note.lender; const recipient = note.recipient;
  const tok = (org, subject) => note.tokens.find((t) => t.org === org && (!subject || t.subject === subject)).token;
  let st = await call(LK, 'application.status', id.household, tok(LK), { application_id: note.application_id }, recipient);
  const le = st.loan_estimate;
  const within = le && le.rate_percent <= lim.max_rate_percent && le.estimated_total_monthly_payment <= lim.max_monthly_payment && le.closing_costs <= lim.max_closing_costs;
  if (!within) { const msg = `Loan Estimate outside your limits; intent not recorded.`; U.notifyUser(msg, ulog); fs.writeFileSync(path.join(runDir, 'c2-log.json'), JSON.stringify({ final_message: msg, log }, null, 1)); return { phase, final_message: msg, code_calls: codeCalls, llm_calls: llmCalls, log }; }
  await call(LK, 'estimate.accept_intent', id.household, tok(LK), { application_id: note.application_id, estimate_id: le.estimate_id }, recipient);
  // Documents after intent: statements now; payslip refs from phase 1.
  const refs = [...note.payslip_refs];
  for (const org of ['jfcu', 'nsb']) {
    const items = note.accounts.filter((a) => a.org === org).flatMap((a) => a.periods.map((p) => ({ record_type: 'statement', account_id: a.account_id, period: p })));
    const t = note.tokens.find((x) => x.org === org); const got = await call(org, 'records.provide', t.subject, t.token, { items }, recipient); for (const r of got.records) refs.push(r.record_ref);
  }
  const pkg = await call(LK, 'documents.submit', id.household, tok(LK), { application_id: note.application_id, records: refs }, recipient);
  const conds = (pkg.conditions || []).filter((c) => c.status === 'open');
  // Model call 1: interpret the conditions.
  const raw = await llm(`A mortgage lender raised these underwriting conditions for Sam and Nadia Okafor-Reyes:\n${conds.map((c) => `- ${c.condition_id}: "${c.text}"`).join('\n')}\n\nFor each condition, decide whether it needs a written explanation that only the borrowers can give, or documents. Documents can be: "w2" (W-2 from the payroll service), "payslip", or "statement". Reply with JSON only, an array of objects: {"condition_id": "...", "kind": "explanation" | "documents", "question_for_borrowers": "..." (explanation only), "documents": "w2" | "payslip" | "statement" | null}.`);
  let plan = []; try { plan = JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) { plan = []; }
  const explain = plan.filter((x) => x.kind === 'explanation'); const answers = [];
  for (const x of explain) { await U.humanWait('ask_user', cond, runDir); answers.push({ condition_id: x.condition_id, text: conds.find((c) => c.condition_id === x.condition_id)?.text, answer: U.askUser(x.question_for_borrowers, ulog, cond) }); }
  if (answers.length) {
    // Model call 2: draft the explanation(s).
    const draftRaw = await llm(`Draft short, factual replies from Sam and Nadia Okafor-Reyes to their mortgage lender's underwriting conditions.\n\n${answers.map((a) => `Condition ${a.condition_id}: "${a.text}"\nTheir answer: "${a.answer}"`).join('\n\n')}\n\nReply with JSON only: an array of {"condition_id": "...", "response": "..."}; no greeting lines or signature placeholders.`);
    let drafts = []; try { drafts = JSON.parse((draftRaw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) { drafts = []; }
    for (const d of drafts) await call(LK, 'condition.respond', id.household, tok(LK), { application_id: note.application_id, condition_id: d.condition_id, response: d.response }, recipient);
  }
  for (const x of plan.filter((p) => p.kind === 'documents')) {
    if (x.documents !== 'w2') continue; const wrefs = [];
    for (const subj of [id.sam, id.nadia]) {
      const t = tok('lgh', subj); const j = await call('lgh', 'records.list', subj, t, { record_type: 'payslip' }, recipient);
      const w = (j.tax_forms || []).filter((f) => f.tax_year === auth.machine_readable.share.w2.tax_year);
      const got = await call('lgh', 'records.provide', subj, t, { items: w.map((f) => ({ record_type: 'w2', record_id: f.record_id })) }, recipient); for (const r of got.records) wrefs.push(r.record_ref);
    }
    await call(LK, 'condition.respond', id.household, tok(LK), { application_id: note.application_id, condition_id: x.condition_id, response: 'W-2s for tax year 2025 for both borrowers are attached.', records: wrefs }, recipient);
  }
  const final = `Application ${note.application_id} with ${recipient}: intent recorded (rate ${le.rate_percent}%), ${refs.length} documents submitted, ${plan.length} conditions answered.`;
  fs.writeFileSync(path.join(runDir, 'c2-log.json'), JSON.stringify({ final_message: final, plan, log }, null, 1));
  return { phase, final_message: final, code_calls: codeCalls, llm_calls: llmCalls, log };
}
module.exports = { runC2Grounded };
