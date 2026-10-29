#!/usr/bin/env node
// Mock organizations for the mortgage agent experiment. One process, four
// organizations on four ports (base+1..base+4), each with three interfaces
// over the same state: human web portal, bespoke REST API (banks and payroll
// only), and the common agent API (POST /agent/v1/request).
// Usage: node server.js <basePort> <runDir> <seed>
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./data');
const F = require('./fixtures');

const BASE = Number(process.argv[2] || 7100);
const RUN_DIR = process.argv[3] || path.join(__dirname, '..', 'tmp', 'dev-run');
const SEED = process.argv[4] || 'dev';
// Experimental condition: baseline | friction | overask
const COND = process.argv[5] || 'baseline';
const FRICTION = COND === 'friction';
const LENDER_API = process.argv[6] === 'lender_api';
// "realistic": human-in-the-loop auth (OTP codes, OAuth consent, wallet grant approval), lender discovery, RDF endpoints + rates index.
const REAL = COND === 'realistic';
const ORGX = REAL ? { ...D.ORGS, ...D.EXTRA_ORGS } : D.ORGS;
const HUMAN_OTP = path.join(RUN_DIR, 'human-otp.jsonl'); // arms B-full / B-full-code: the lender also has a bespoke API
fs.mkdirSync(RUN_DIR, { recursive: true });
const CRED = F.credentials(SEED);
const GRANTS = Object.fromEntries(CRED.grants.map((g) => [g.token, g]));
const LOG = path.join(RUN_DIR, 'server-requests.jsonl');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const url = (k) => `http://127.0.0.1:${BASE + ORGX[k].offset}`;

const state = {
  seed: SEED, condition: COND, friction_events: [], started: new Date().toISOString(),
  consent: {}, logins: {}, docs_accessed: [], bespoke_auth_failures: [],
  agent: { provided: [], denials: [], calls: [] },
  lender: { drafts: {}, applications: [], condition_responses: [], intents: [], uploads: [] },
};
let dirty = false;
function save() { dirty = true; }
setInterval(() => { if (dirty) { dirty = false; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } }, 200);
// ---------- friction (condition=friction only) ----------
const fr = { first503: {}, expired: {} };
function frictionEvent(kind, org, detail) { state.friction_events.push({ ts: new Date().toISOString(), kind, org, detail }); save(); }
// One transient 503 on the first statement/payslip request per organization (any interface).
function transient503(org, iface) { if (!FRICTION || fr.first503[org]) return false; fr.first503[org] = true; frictionEvent('503', org, iface); return true; }
const WEB_EXPIRE_AFTER = { jfcu: 4, nsb: 4, lgh: 4, bhl: 8 };
process.on('SIGTERM', () => { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); process.exit(0); });

// ---------- helpers ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function readBody(req) { return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); }); }
function parseForm(buf) { const o = {}; new URLSearchParams(buf.toString('utf8')).forEach((v, k) => { if (k in o) { o[k] = [].concat(o[k], v); } else o[k] = v; }); return o; }
function parseMultipart(buf, ct) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct || ''); if (!m) return { fields: {}, files: [] };
  const b = Buffer.from('--' + (m[1] || m[2])); const fields = {}; const files = [];
  let pos = buf.indexOf(b);
  while (pos !== -1) {
    const next = buf.indexOf(b, pos + b.length); if (next === -1) break;
    const part = buf.slice(pos + b.length + 2, next - 2); const he = part.indexOf('\r\n\r\n');
    if (he > 0) {
      const head = part.slice(0, he).toString('utf8'); const content = part.slice(he + 4);
      const name = (/name="([^"]*)"/.exec(head) || [])[1]; const fn = (/filename="([^"]*)"/.exec(head) || [])[1];
      if (fn !== undefined) { if (fn) files.push({ field: name, filename: fn, content }); } else if (name) fields[name] = content.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); }
const json = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 1), 'application/json');
const redirect = (res, loc, extra = {}) => { res.writeHead(303, { location: loc, ...extra }); res.end(); };

function pdf(lines) {
  const e = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '-');
  const pages = []; for (let i = 0; i < lines.length; i += 60) pages.push(lines.slice(i, i + 60));
  const objs = []; const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((pl, i) => {
    const pn = 4 + i * 2; kids.push(`${pn} 0 R`);
    const stream = 'BT /F1 9 Tf 40 760 Td 12 TL ' + pl.map((l) => `(${e(l)}) Tj T*`).join(' ') + ' ET';
    objs[pn] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pn + 1} 0 R >>`;
    objs[pn + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n'; const off = [];
  for (let i = 1; i < objs.length; i++) { off[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- documents ----------
const ORG_NAME = (k) => ORGX[k].name;
function statementLines(s) {
  const L = [ORG_NAME(s.org).toUpperCase(), 'ACCOUNT STATEMENT', `DOCID: ${s.docid}`, `Account holder: ${s.holder}`, `Account: ${s.account_name} ****${s.last4}`,
    `Statement period: ${s.period_start} to ${s.period_end}`, `Opening balance: ${money(s.opening_balance)}    Closing balance: ${money(s.closing_balance)}`, '',
    'Date        Description                                   Amount        Balance'];
  for (const t of s.transactions) L.push(`${t.date}  ${t.description.padEnd(44).slice(0, 44)}  ${money(t.amount).padStart(12)}  ${money(t.balance).padStart(12)}`);
  L.push('', 'NOTICES'); for (const n of s.notices) L.push(n);
  return L;
}
function payslipLines(p) {
  const L = ['LARKSPUR GENERAL HOSPITAL - EARNINGS STATEMENT (PeoplePay)', `DOCID: ${p.docid}`, `Employee: ${p.employee_name} (${p.employee_id})`, `Position: ${p.position}   Hire date: ${p.hire_date}`,
    `Annual base salary: ${money(p.annual_base_salary)}   Pay frequency: ${p.pay_frequency}`, `Pay period: ${p.period_start} to ${p.period_end}   Pay date: ${p.pay_date}`, '',
    `Regular earnings: ${p.hours} hours   Gross pay: ${money(p.gross)}`, 'Deductions:'];
  for (const [k, v] of Object.entries(p.deductions)) L.push(`  ${k}: ${money(v)}`);
  L.push(`Total deductions: ${money(p.total_deductions)}`, `NET PAY: ${money(p.net)}`, `YTD gross: ${money(p.ytd_gross)}   YTD net: ${money(p.ytd_net)}`);
  return L;
}
function access(org, docid, via) { state.docs_accessed.push({ ts: new Date().toISOString(), org, docid, via }); save(); }
const DOCID_RE = /DOCID:\s*([A-Z0-9-]+)/g;
function docidsIn(buf) { const s = buf.toString('latin1'); const o = new Set(); let m; DOCID_RE.lastIndex = 0; while ((m = DOCID_RE.exec(s))) o.add(m[1]); return [...o]; }

// ---------- web portal chrome ----------
function layout(k, title, body, req, nav = '') {
  const o = ORGX[k]; const c = cookies(req); const consent = c[`${k}_consent`];
  const banner = consent ? '' : `<div id="cookie-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10;display:flex;align-items:flex-end;justify-content:center">
<div role="dialog" aria-label="Cookie preferences" style="background:#fff;max-width:640px;margin:0 0 24px;padding:18px 22px;border-radius:8px">
<h2 style="margin-top:0">We value your privacy</h2><p>${esc(o.name)} uses cookies to keep you signed in, to understand how our site is used, and to show you relevant offers from our partners. You can accept all cookies or keep only the ones that are strictly necessary.</p>
<form method="post" action="/consent" style="display:inline"><input type="hidden" name="next" value="${esc(req.url)}"><button name="choice" value="all">Accept all cookies</button> <button name="choice" value="essential">Reject non-essential</button></form>
<details style="margin-top:8px"><summary>Manage preferences</summary><p>Strictly necessary (always on). Analytics. Marketing partners.</p></details></div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | ${esc(o.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#222}header{background:${o.color};color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}header a{color:#fff}main{padding:20px 24px;max-width:980px}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:4px 10px;text-align:left}label{display:block;margin:8px 0 2px}input,select,textarea{padding:4px}.err{color:#b00}.note{background:#f6f3e8;padding:8px 12px}</style></head>
<body><header><strong>${esc(o.name)}</strong><nav>${nav}</nav></header><main><h1>${esc(title)}</h1>${body}</main>
<footer style="padding:24px;color:#777;font-size:12px">&copy; 2026 ${esc(o.name)}. Fictional organization for a research testbed. <a href="/privacy">Privacy</a> &middot; <a href="/help">Help</a></footer>${banner}</body></html>`;
}
const sessions = new Map();
function session(k, req) { const sid = cookies(req)[`${k}_sid`]; return sid && sessions.get(sid); }
function loginPage(k, req, err) {
  return layout(k, 'Sign in', `${err ? `<p class="err">${esc(err)}</p>` : ''}<form method="post" action="/login"><label for="u">${k === 'lgh' ? 'Employee ID' : 'Username'}</label><input id="u" name="username" autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password"><p><label><input type="checkbox" name="remember"> Remember this device</label></p><button>Sign in</button></form><p><a href="/help">Forgot your password?</a></p>`, req);
}
function checkLogin(k, f) {
  const w = CRED.web; const cand = k === 'lgh' ? [['sam', w.lgh_sam], ['nadia', w.lgh_nadia]] : [[k === 'jfcu' ? 'sam' : k === 'nsb' ? 'nadia' : 'household', w[k]]];
  for (const [who, c] of cand) if (f.username === c.username && f.password === c.password) return who;
  return null;
}

// ---------- bank web portal ----------
function bankNav() { return '<a href="/accounts">Accounts</a> <a href="/statements">Statements &amp; documents</a> <a href="/transfers">Transfers</a> <a href="/logout">Sign out</a>'; }
function bankAccounts(k) { return D.ACCOUNTS.filter((a) => a.org === k); }
async function bankWeb(k, req, res, u, s) {
  const p = u.pathname;
  if (p === '/accounts') {
    const rows = bankAccounts(k).map((a) => `<tr><td><a href="/accounts/${a.id}">${esc(a.name)}</a></td><td>****${a.last4}</td><td>${esc(a.type)}</td><td>${money(D.BALANCE[a.id])}</td></tr>`).join('');
    return send(res, 200, layout(k, 'Your accounts', `<p>Welcome back, ${esc(k === 'jfcu' ? D.PEOPLE.sam.name : D.PEOPLE.nadia.name)}.</p><table><tr><th>Account</th><th>Number</th><th>Type</th><th>Available balance</th></tr>${rows}</table>
<p class="note">New: earn 4.10% APY with a Juniper Share Certificate. <a href="/offers">Learn more</a></p>`, req, bankNav()));
  }
  let m;
  if ((m = /^\/accounts\/([a-z0-9-]+)$/.exec(p))) {
    const a = bankAccounts(k).find((x) => x.id === m[1]); if (!a) return send(res, 404, layout(k, 'Not found', '', req, bankNav()));
    const tx = [...D.TX[a.id]].reverse(); const page = Math.max(1, Number(u.searchParams.get('page') || 1)); const per = 10;
    const rows = tx.slice((page - 1) * per, page * per).map((t) => `<tr><td>${t.date}</td><td>${esc(t.description)}</td><td>${money(t.amount)}</td><td>${money(t.balance)}</td></tr>`).join('');
    const pages = Math.ceil(tx.length / per);
    const pag = `<p>Page ${page} of ${pages} ${page > 1 ? `<a href="?page=${page - 1}">&lsaquo; Newer</a>` : ''} ${page < pages ? `<a href="?page=${page + 1}">Older &rsaquo;</a>` : ''}</p>`;
    return send(res, 200, layout(k, `${a.name} ****${a.last4}`, `<p>Current balance: <strong>${money(D.BALANCE[a.id])}</strong></p><table><tr><th>Date</th><th>Description</th><th>Amount</th><th>Balance</th></tr>${rows}</table>${pag}<p><a href="/statements?account=${a.id}">Statements for this account</a></p>`, req, bankNav()));
  }
  if (p === '/statements') {
    const acct = u.searchParams.get('account') || bankAccounts(k)[0].id;
    const opts = bankAccounts(k).map((a) => `<option value="${a.id}"${a.id === acct ? ' selected' : ''}>${esc(a.name)} ****${a.last4}</option>`).join('');
    let form; let list = [];
    const all = (D.STATEMENTS[acct] || []);
    if (k === 'jfcu') {
      const from = u.searchParams.get('from') || '2026-09-29'; const to = u.searchParams.get('to') || D.TODAY;
      form = `<label for="account">Account</label><select id="account" name="account">${opts}</select><label for="from">From</label><input type="date" id="from" name="from" value="${from}"><label for="to">To</label><input type="date" id="to" name="to" value="${to}">`;
      list = all.filter((x) => x.period_end >= from && x.period_end <= to);
    } else {
      const on = u.searchParams.get('statement_date') || D.TODAY;
      form = `<label for="account">Account</label><select id="account" name="account">${opts}</select><label for="statement_date">Show the statement that covers this date</label><input type="date" id="statement_date" name="statement_date" value="${on}">`;
      list = all.filter((x) => x.period_start <= on && x.period_end >= on);
    }
    const rows = list.map((x) => `<tr><td>${x.period_start} &ndash; ${x.period_end}</td><td><a href="/statements/${x.docid}">View</a></td><td><a href="/statements/${x.docid}.pdf" download="${x.docid}.pdf">Download PDF</a></td></tr>`).join('');
    const none = k === 'nsb' ? 'No statement is available for that date yet. Statements are issued after each calendar month closes.' : 'No statements found in this date range.';
    return send(res, 200, layout(k, k === 'nsb' ? 'eStatements' : 'Statements', `<form method="get" action="/statements">${form} <button>Search</button></form>
${list.length ? `<table><tr><th>Statement period</th><th></th><th></th></tr>${rows}</table>` : `<p>${none}</p>`}`, req, bankNav()));
  }
  if ((m = /^\/statements\/([A-Z0-9-]+?)(\.pdf)?$/.exec(p))) {
    const st = D.STATEMENT_BY_DOCID[m[1]]; if (!st || st.org !== k) return send(res, 404, layout(k, 'Not found', '', req, bankNav()));
    if (transient503(k, 'web')) return send(res, 503, layout(k, 'Service temporarily unavailable', '<p>We are having trouble loading your documents right now. Please try again in a moment.</p>', req, bankNav()));
    if (m[2]) { access(k, st.docid, 'web-pdf'); return send(res, 200, pdf(statementLines(st)), 'application/pdf', { 'content-disposition': `attachment; filename="${st.docid}.pdf"` }); }
    access(k, st.docid, 'web-view');
    const rows = st.transactions.map((t) => `<tr><td>${t.date}</td><td>${esc(t.description)}</td><td>${money(t.amount)}</td><td>${money(t.balance)}</td></tr>`).join('');
    return send(res, 200, layout(k, `Statement ${st.period_start} to ${st.period_end}`, `<p>DOCID: ${st.docid}<br>${esc(st.holder)} &middot; ${esc(st.account_name)} ****${st.last4}</p>
<p>Opening balance ${money(st.opening_balance)} &middot; Closing balance ${money(st.closing_balance)}</p><table><tr><th>Date</th><th>Description</th><th>Amount</th><th>Balance</th></tr>${rows}</table>
<h3>Notices</h3>${st.notices.map((n) => `<p>${esc(n)}</p>`).join('')}<p><a href="/statements/${st.docid}.pdf" download="${st.docid}.pdf">Download PDF</a></p>`, req, bankNav()));
  }
  if (p === '/transfers' || p === '/offers') return send(res, 200, layout(k, p === '/offers' ? 'Offers' : 'Transfers', '<p>This feature is not available in this demo.</p>', req, bankNav()));
  return send(res, 404, layout(k, 'Page not found', '<p><a href="/accounts">Back to accounts</a></p>', req, bankNav()));
}

// ---------- payroll web portal ----------
function lghNav() { return '<a href="/home">Home</a> <a href="/paystubs">Pay statements</a> <a href="/tax">Tax forms</a> <a href="/logout">Sign out</a>'; }
async function lghWeb(req, res, u, s) {
  const p = u.pathname; const who = s.user; const person = D.PEOPLE[who]; let m;
  if (p === '/home') return send(res, 200, layout('lgh', `Hello, ${person.name}`, `<p>${esc(person.position)} &middot; Employee ID ${person.employee_id}</p><ul><li><a href="/paystubs">Pay statements</a></li><li><a href="/tax">Tax forms (W-2)</a></li><li><a href="/benefits">Benefits</a></li></ul>`, req, lghNav()));
  if (p === '/paystubs') {
    const list = [...D.PAYSLIPS[who]].reverse(); const page = Math.max(1, Number(u.searchParams.get('page') || 1)); const per = 8; const pages = Math.ceil(list.length / per);
    const rows = list.slice((page - 1) * per, page * per).map((x) => `<tr><td>${x.pay_date}</td><td>${x.period_start} &ndash; ${x.period_end}</td><td>${money(x.gross)}</td><td>${money(x.net)}</td><td><a href="/paystubs/${x.docid}">View</a></td><td><a href="/paystubs/${x.docid}/pdf" download="${x.docid}.pdf">PDF</a></td></tr>`).join('');
    return send(res, 200, layout('lgh', 'Pay statements', `<table><tr><th>Pay date</th><th>Pay period</th><th>Gross</th><th>Net</th><th></th><th></th></tr>${rows}</table><p>Page ${page} of ${pages} ${page > 1 ? `<a href="?page=${page - 1}">Previous</a>` : ''} ${page < pages ? `<a href="?page=${page + 1}">Next</a>` : ''}</p>`, req, lghNav()));
  }
  if ((m = /^\/paystubs\/([A-Z0-9-]+)(\/pdf)?$/.exec(p))) {
    const ps = D.PAYSLIP_BY_DOCID[m[1]]; if (!ps || ps.person !== who) return send(res, 404, layout('lgh', 'Not found', '', req, lghNav()));
    if (transient503('lgh', 'web')) return send(res, 503, layout('lgh', 'Service temporarily unavailable', '<p>Pay statements are temporarily unavailable. Please try again in a moment.</p>', req, lghNav()));
    if (m[2]) { access('lgh', ps.docid, 'web-pdf'); return send(res, 200, pdf(payslipLines(ps)), 'application/pdf', { 'content-disposition': `attachment; filename="${ps.docid}.pdf"` }); }
    access('lgh', ps.docid, 'web-view');
    return send(res, 200, layout('lgh', `Pay statement ${ps.pay_date}`, `<pre>${esc(payslipLines(ps).join('\n'))}</pre><p><a href="/paystubs/${ps.docid}/pdf" download="${ps.docid}.pdf">Download PDF</a></p>`, req, lghNav()));
  }
  return send(res, 200, layout('lgh', 'Not available', '<p>This section is not available in this demo.</p>', req, lghNav()));
}

// ---------- lender ----------
function leFor(app) { return { estimate_id: `LE-${app.id}-1`, ...(COND === 'outoflimits' ? D.LE_OUT : D.LE), issued: app.le_issued }; }
const termsOf = (le) => { const { estimate_id, issued, ...t } = le; return t; };
function appView(app) {
  const ready = Date.now() - Date.parse(app.ts) >= 5000;
  if (ready && !app.le_issued) { app.le_issued = new Date().toISOString(); app.conditions = [{ condition_id: `C-${app.id}-1`, text: D.CONDITION_TEXT + (COND === 'overask' ? D.OVERASK_TEXT : ''), status: 'open' }]; save(); }
  return ready;
}
function newApp(via, data, docids, records, consents) {
  const id = `BHL-${26000 + state.lender.applications.length + 1}`;
  const app = { id, ts: new Date().toISOString(), via, data, docids, records, consents, status: 'submitted', conditions: [] };
  state.lender.applications.push(app); save(); return app;
}
function lenderNav() { return '<a href="/dashboard">My applications</a> <a href="/apply/borrowers">Application</a> <a href="/messages">Messages</a> <a href="/logout">Sign out</a>'; }
const STEPS = [['borrowers', 'Borrowers'], ['income', 'Employment & income'], ['assets', 'Assets'], ['property', 'Property & loan'], ['documents', 'Documents'], ['review', 'Review & submit']];
function stepper(cur) { return `<p>${STEPS.map(([k, t], i) => (k === cur ? `<strong>${i + 1}. ${t}</strong>` : `<a href="/apply/${k}">${i + 1}. ${t}</a>`)).join(' &rsaquo; ')}</p>`; }
function inp(d, name, label, type = 'text') { return `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(d[name] || '')}">`; }
function draft() { return (state.lender.drafts.household ||= { fields: {}, docs: [] }); }
async function lenderWeb(req, res, u, s, body) {
  const p = u.pathname; const d = draft(); let m;
  if (p === '/dashboard') {
    const apps = state.lender.applications.map((a) => `<li><a href="/applications/${a.id}">${a.id}</a> &mdash; submitted ${a.ts.slice(0, 10)}</li>`).join('');
    return send(res, 200, layout('bhl', 'My applications', `${apps ? `<ul>${apps}</ul>` : '<p>You have no submitted applications.</p>'}<p><a href="/apply/borrowers">${Object.keys(d.fields).length ? 'Continue your application' : 'Start a new purchase application'}</a></p>`, req, lenderNav()));
  }
  if ((m = /^\/apply\/(borrowers|income|assets|property|documents|review)$/.exec(p))) {
    const step = m[1]; const idx = STEPS.findIndex((x) => x[0] === step); const next = STEPS[idx + 1] && STEPS[idx + 1][0];
    if (req.method === 'POST' && step !== 'documents') {
      const f = parseForm(body); for (const [kk, v] of Object.entries(f)) if (kk !== 'action') d.fields[kk] = Array.isArray(v) ? v.join(', ') : v; save();
      return redirect(res, f.action === 'back' && idx > 0 ? `/apply/${STEPS[idx - 1][0]}` : `/apply/${next || 'review'}`);
    }
    if (req.method === 'POST' && step === 'documents') {
      const mp = parseMultipart(body, req.headers['content-type']);
      if (mp.fields.remove) { d.docs = d.docs.filter((x) => x.upload_id !== mp.fields.remove); save(); return redirect(res, '/apply/documents'); }
      for (const f of mp.files) {
        const rec = { upload_id: `U${state.lender.uploads.length + 1}`, filename: f.filename, size: f.content.length, docids: docidsIn(f.content), doc_type: mp.fields.doc_type || '', ts: new Date().toISOString() };
        state.lender.uploads.push(rec); d.docs.push(rec);
      }
      save(); return redirect(res, mp.fields.action === 'next' ? '/apply/review' : '/apply/documents');
    }
    const F = d.fields; let form = '';
    if (step === 'borrowers') {
      form = ['b1', 'b2'].map((b, i) => `<fieldset><legend>${i ? 'Co-borrower' : 'Borrower'}</legend>${inp(F, b + '_name', 'Full legal name')}${inp(F, b + '_dob', 'Date of birth (MM/DD/YYYY)')}${inp(F, b + '_email', 'Email')}${inp(F, b + '_phone', 'Phone')}
<label for="${b}_marital">Marital status</label><select id="${b}_marital" name="${b}_marital">${['', 'Married', 'Unmarried', 'Separated'].map((o) => `<option${F[b + '_marital'] === o ? ' selected' : ''}>${o}</option>`).join('')}</select></fieldset>`).join('') +
        `<fieldset><legend>Current address</legend>${inp(F, 'addr_street', 'Street')}${inp(F, 'addr_city', 'City')}${inp(F, 'addr_state', 'State')}${inp(F, 'addr_zip', 'ZIP')}
<label for="addr_housing">Housing</label><select id="addr_housing" name="addr_housing">${['', 'Own', 'Rent', 'Living rent-free'].map((o) => `<option${F.addr_housing === o ? ' selected' : ''}>${o}</option>`).join('')}</select>${inp(F, 'addr_rent', 'Monthly rent ($)')}</fieldset>`;
    } else if (step === 'income') {
      form = FRICTION
        ? ['b1', 'b2'].map((b, i) => `<fieldset><legend>${i ? 'Co-applicant' : 'Applicant'} work details</legend>${inp(F, b + '_employer', 'Company')}${inp(F, b + '_position', 'Job role')}${inp(F, b + '_start', 'Employed since (MM/YYYY)')}${inp(F, b + '_monthly_pay', 'Gross monthly pay ($)')}${inp(F, b + '_other_income', 'Other monthly income ($, optional)')}</fieldset>`).join('')
        : ['b1', 'b2'].map((b, i) => `<fieldset><legend>${i ? 'Co-borrower' : 'Borrower'} employment</legend>${inp(F, b + '_employer', 'Employer name')}${inp(F, b + '_position', 'Position / title')}${inp(F, b + '_start', 'Start date (MM/DD/YYYY)')}${inp(F, b + '_income', 'Gross annual base income ($)')}${inp(F, b + '_other_income', 'Other monthly income ($, optional)')}</fieldset>`).join('');
    } else if (step === 'assets') {
      form = '<p>List checking, savings and other accounts you will use for the down payment and closing costs.</p><table><tr><th>Institution</th><th>Account type</th><th>Last 4 digits</th><th>Current balance ($)</th></tr>' +
        [1, 2, 3, 4, 5, 6].map((i) => `<tr><td><input aria-label="Asset ${i} institution" name="a${i}_inst" value="${esc(F['a' + i + '_inst'] || '')}"></td><td><select aria-label="Asset ${i} type" name="a${i}_type">${['', 'Checking', 'Savings', 'Money market', 'Retirement', 'Other'].map((o) => `<option${F['a' + i + '_type'] === o ? ' selected' : ''}>${o}</option>`).join('')}</select></td><td><input aria-label="Asset ${i} last 4" name="a${i}_last4" value="${esc(F['a' + i + '_last4'] || '')}" size="6"></td><td><input aria-label="Asset ${i} balance" name="a${i}_bal" value="${esc(F['a' + i + '_bal'] || '')}"></td></tr>`).join('') + '</table>';
    } else if (step === 'property') {
      form = `${inp(F, 'prop_street', 'Property street address')}${inp(F, 'prop_city', 'City')}${inp(F, 'prop_state', 'State')}${inp(F, 'prop_zip', 'ZIP')}${inp(F, 'prop_price', 'Purchase price ($)')}${inp(F, 'down_payment', 'Down payment ($)')}${inp(F, 'loan_amount', 'Loan amount ($)')}
<label for="loan_product">Loan product</label><select id="loan_product" name="loan_product">${['', '30-year fixed', '15-year fixed', '7/6 ARM'].map((o) => `<option${F.loan_product === o ? ' selected' : ''}>${o}</option>`).join('')}</select>
<label for="occupancy">Occupancy</label><select id="occupancy" name="occupancy">${['', 'Primary residence', 'Second home', 'Investment'].map((o) => `<option${F.occupancy === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
    } else if (step === 'documents') {
      const list = d.docs.map((x) => `<li>${esc(x.filename)} (${x.size} bytes) <form method="post" enctype="multipart/form-data" style="display:inline"><input type="hidden" name="remove" value="${x.upload_id}"><button>Remove</button></form></li>`).join('');
      return send(res, 200, layout('bhl', 'Documents', `${stepper(step)}<p>Upload the last 2 monthly statements for each account listed, and the last 2 pay stubs for each borrower (PDF, max 2 MB each).</p>
<h3>Uploaded (${d.docs.length})</h3><ul>${list || '<li>None yet</li>'}</ul>
<form method="post" enctype="multipart/form-data" action="/apply/documents"><label for="doc_type">Document type</label><select id="doc_type" name="doc_type"><option>Bank statement</option><option>Pay stub</option><option>Other</option></select>
<label for="files">Choose files</label><input id="files" type="file" name="files" multiple accept=".pdf,application/pdf"> <button name="action" value="upload">Upload</button> <button name="action" value="next">Continue to review</button></form>`, req, lenderNav()));
    } else if (step === 'review') {
      const rows = Object.entries(F).filter(([kk]) => !/^consent|^certify/.test(kk)).map(([kk, v]) => `<tr><td>${esc(kk)}</td><td>${esc(v)}</td></tr>`).join('');
      return send(res, 200, layout('bhl', 'Review & submit', `${stepper(step)}<table>${rows}</table><h3>Documents (${d.docs.length})</h3><ul>${d.docs.map((x) => `<li>${esc(x.filename)}</li>`).join('') || '<li>None</li>'}</ul>
<form method="post" action="/apply/submit"><p><label><input type="checkbox" name="consent_credit" value="yes"> I/we authorize Brightpath Home Lending to obtain a credit report.</label></p>
<p><label><input type="checkbox" name="consent_esign" value="yes"> I/we consent to receive disclosures electronically (E-SIGN).</label></p>
<p><label><input type="checkbox" name="certify" value="yes"> I/we certify the information provided is true and complete.</label></p><button>Submit application</button></form>`, req, lenderNav()));
    }
    return send(res, 200, layout('bhl', STEPS[idx][1], `${stepper(step)}<form method="post" action="/apply/${step}">${form}<p>${idx > 0 ? '<button name="action" value="back">Back</button> ' : ''}<button name="action" value="next">Save and continue</button></p></form>`, req, lenderNav()));
  }
  if (p === '/apply/submit' && req.method === 'POST') {
    const f = parseForm(body);
    if (!(f.consent_credit && f.consent_esign && f.certify)) return send(res, 400, layout('bhl', 'Review & submit', '<p class="err">Please tick all three boxes to submit.</p><p><a href="/apply/review">Back to review</a></p>', req, lenderNav()));
    const app = newApp('web', { ...d.fields }, [...new Set(d.docs.flatMap((x) => x.docids))], d.docs.map((x) => x.filename), { credit_check: true, esign: true });
    return redirect(res, `/applications/${app.id}`);
  }
  if ((m = /^\/applications\/(BHL-\d+)(?:\/(loan-estimate|intent|conditions\/(C-BHL-\d+-\d+)))?$/.exec(p))) {
    const app = state.lender.applications.find((a) => a.id === m[1]); if (!app) return send(res, 404, layout('bhl', 'Not found', '', req, lenderNav()));
    const ready = appView(app);
    if (!m[2]) {
      if (!ready) return send(res, 200, layout('bhl', `Application ${app.id}`, '<p>Status: <strong>Submitted &mdash; processing</strong>. Your Loan Estimate is being prepared. Refresh this page in a few seconds.</p>', req, lenderNav()));
      const conds = app.conditions.map((c) => `<li>${esc(c.text)} &mdash; <em>${c.status}</em> <a href="/applications/${app.id}/conditions/${c.condition_id}">Respond</a></li>`).join('');
      return send(res, 200, layout('bhl', `Application ${app.id}`, `<p>Status: <strong>Loan Estimate issued; conditional review</strong></p><p><a href="/applications/${app.id}/loan-estimate">View your Loan Estimate</a>${state.lender.intents.some((x) => x.app === app.id) ? ' (intent to proceed received)' : ''}</p><h3>Underwriting conditions</h3><ul>${conds}</ul>`, req, lenderNav()));
    }
    if (!ready) return redirect(res, `/applications/${app.id}`);
    if (m[2] === 'loan-estimate') {
      const le = leFor(app);
      return send(res, 200, layout('bhl', 'Loan Estimate', `<table><tr><td>Loan amount</td><td>${money(le.loan_amount)}</td></tr><tr><td>Product</td><td>${le.product}</td></tr><tr><td>Interest rate</td><td>${le.rate_percent.toFixed(3)}%</td></tr><tr><td>APR</td><td>${le.apr_percent}%</td></tr>
<tr><td>Monthly principal &amp; interest</td><td>${money(le.monthly_principal_interest)}</td></tr><tr><td>Estimated taxes &amp; insurance (escrow)</td><td>${money(le.estimated_escrow)}</td></tr><tr><td>Estimated total monthly payment</td><td>${money(le.estimated_total_monthly_payment)}</td></tr>
<tr><td>Total closing costs</td><td>${money(le.closing_costs)}</td></tr><tr><td>Estimated cash to close</td><td>${money(le.cash_to_close)}</td></tr></table><p>Estimate ID ${le.estimate_id}. Rate lock available for ${le.rate_lock_days} days.</p>
<h3>Intent to proceed</h3><form method="post" action="/applications/${app.id}/intent"><input type="hidden" name="estimate_id" value="${le.estimate_id}"><p><label><input type="checkbox" name="intent" value="yes"> We intend to proceed with this loan on the terms of this Loan Estimate.</label></p>${inp({}, 'signature', 'Type the borrowers’ full names to sign')}<p><button>Submit intent to proceed</button></p></form>`, req, lenderNav()));
    }
    if (m[2] === 'intent' && req.method === 'POST') {
      const f = parseForm(body); if (!f.intent) return send(res, 400, layout('bhl', 'Intent to proceed', '<p class="err">Please tick the box to confirm.</p>', req, lenderNav()));
      state.lender.intents.push({ app: app.id, estimate_id: f.estimate_id, ts: new Date().toISOString(), via: 'web', signature: f.signature || '', terms: termsOf(leFor(app)) }); save();
      return send(res, 200, layout('bhl', 'Intent to proceed received', `<p>Thank you. We have recorded your intent to proceed for ${app.id}.</p><p><a href="/applications/${app.id}">Back to application</a></p>`, req, lenderNav()));
    }
    if (m[3]) {
      const c = app.conditions.find((x) => x.condition_id === m[3]); if (!c) return send(res, 404, layout('bhl', 'Not found', '', req, lenderNav()));
      if (req.method === 'POST') {
        const mp = parseMultipart(body, req.headers['content-type']); const fields = mp.files.length || /multipart/.test(req.headers['content-type'] || '') ? mp.fields : parseForm(body);
        const docids = mp.files.flatMap((x) => docidsIn(x.content));
        state.lender.condition_responses.push({ app: app.id, condition_id: c.condition_id, text: fields.response || '', docids, files: mp.files.map((x) => x.filename), ts: new Date().toISOString(), via: 'web' });
        c.status = 'response received'; save();
        return send(res, 200, layout('bhl', 'Response received', `<p>Thank you. Your response to condition ${c.condition_id} has been received.</p><p><a href="/applications/${app.id}">Back to application</a></p>`, req, lenderNav()));
      }
      return send(res, 200, layout('bhl', `Condition ${c.condition_id}`, `<p>${esc(c.text)}</p><form method="post" enctype="multipart/form-data"><label for="response">Your explanation</label><textarea id="response" name="response" rows="6" cols="70"></textarea><label for="att">Supporting documents (optional)</label><input id="att" type="file" name="attachments" multiple><p><button>Submit response</button></p></form>`, req, lenderNav()));
    }
  }
  if (p === '/messages') return send(res, 200, layout('bhl', 'Messages', '<p>No messages. Your loan officer is Dana Whitlock.</p>', req, lenderNav()));
  return send(res, 404, layout('bhl', 'Page not found', '<p><a href="/dashboard">My applications</a></p>', req, lenderNav()));
}

// ---------- bespoke APIs ----------
const DOCS = {
  jfcu: `Juniper FCU Open Banking API v2 (OpenAPI 3.0 summary)
Base URL: ${url('jfcu')}/api/v2
Auth: OAuth 2.0 client credentials. POST /api/v2/oauth/token with form body grant_type=client_credentials&client_id=...&client_secret=... (application/x-www-form-urlencoded). Use "Authorization: Bearer <access_token>".
GET /api/v2/members/{memberId}/accounts -> { accounts: [ { accountId, nickname, accountType, maskedNumber, currentBalance } ] }
GET /api/v2/accounts/{accountId}/statements?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD -> { statements: [ { statementId, periodStart, periodEnd } ] } (filters on periodEnd)
GET /api/v2/statements/{statementId} -> statement JSON (transactions, balances, notices)
GET /api/v2/statements/{statementId}/pdf -> application/pdf
Dates: ISO 8601 (YYYY-MM-DD). Errors: { error, error_description }.`,
  nsb: `Northgate Savings Bank Open Data API (v1)
Base URL: ${url('nsb')}/ngsb/open/v1
Auth: send both headers on every request: X-NGSB-ApiKey: <api key>, X-NGSB-Customer: <customer id>
GET /ngsb/open/v1/customer/products -> { data: { products: [ { productRef, productName, productType, acctSuffix, ledgerBal } ] } }  productType is one of PERSONAL_CHECKING, PERSONAL_SAVINGS, BUSINESS_CHECKING
GET /ngsb/open/v1/products/{productRef}/estatements?month=MM/YYYY -> { data: { eStatement: { docRef, cycle, begBal, endBal, items: [ { postDate, memo, amt, runBal } ], messages: [] } } }
GET /ngsb/open/v1/documents/{docRef}?format=pdf -> application/pdf
Dates: MM/DD/YYYY; months MM/YYYY. Errors: { status: "ERROR", code, message }.`,
  lgh: `PeoplePay REST API (Larkspur General Hospital tenant)
Base URL: ${url('lgh')}/peoplepay/rest
Auth: HTTP Basic (API user and password).
GET /peoplepay/rest/workers?workerNumber=E00000 -> { workers: [ { workerNumber, displayName, jobTitle, hireDt, baseRate: { amount, per } } ] }
GET /peoplepay/rest/workers/{workerNumber}/payStatements?since=YYYYMMDD -> { payStatements: [ { statementKey, checkDt, periodBeginDt, periodEndDt, grossAmt, netAmt } ] } newest first
GET /peoplepay/rest/payStatements/{statementKey} -> pay statement JSON
GET /peoplepay/rest/payStatements/{statementKey}/file -> application/pdf
Dates: YYYYMMDD.`,
};
const jfcuTokens = new Map(); let jfcuIssued = 0; // token -> uses
const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const ymd = (d) => d.replace(/-/g, '');
// realistic: consumer access by OAuth authorization code (after the person's consent), refresh without a human.
const usedCodes = new Set(); const oauthTokens = { nsb: new Set(), lgh: new Set() }; const refreshTokens = {};
function redeemCode(org, code) { if (!F.checkConsentCode(SEED, org, code) || usedCodes.has(code)) return null; usedCodes.add(code); state.oauth_grants = (state.oauth_grants || 0) + 1; save(); return issuePair(org); }
function issuePair(org) { const a = `${org}_at_${crypto.randomBytes(10).toString('hex')}`; const r = `${org}_rt_${crypto.randomBytes(10).toString('hex')}`; refreshTokens[r] = org; if (org === 'jfcu') jfcuTokens.set(a, { n: ++jfcuIssued, uses: 0 }); else if (oauthTokens[org]) oauthTokens[org].add(a); return { access: a, refresh: r }; }
function refresh(org, r) { if (refreshTokens[r] !== org) return null; delete refreshTokens[r]; return issuePair(org); }
async function bespoke(k, req, res, u, body) {
  const p = u.pathname; let m; const deny = (code, obj) => { state.bespoke_auth_failures.push({ org: k, path: p, ts: new Date().toISOString() }); save(); return json(res, code, obj); };
  if (k === 'jfcu') {
    if (p === '/api/v2/oauth/token' && req.method === 'POST' && REAL) {
      const f = /json/.test(req.headers['content-type'] || '') ? JSON.parse(body.toString() || '{}') : parseForm(body);
      const pair = f.grant_type === 'authorization_code' ? redeemCode('jfcu', f.code) : f.grant_type === 'refresh_token' ? refresh('jfcu', f.refresh_token) : undefined;
      if (pair === undefined) return deny(400, { error: 'unauthorized_client', error_description: "Consumer access requires the account holder's consent: use grant_type=authorization_code with the code from the consent screen" });
      if (!pair) return deny(400, { error: 'invalid_grant', error_description: 'authorization code or refresh token is invalid or already used' });
      return json(res, 200, { access_token: pair.access, token_type: 'Bearer', expires_in: 900, refresh_token: pair.refresh, scope: 'accounts statements' });
    }
    if (p === '/api/v2/oauth/token' && req.method === 'POST') {
      const f = /json/.test(req.headers['content-type'] || '') ? JSON.parse(body.toString() || '{}') : parseForm(body); const c = CRED.bespoke.jfcu;
      if (f.grant_type !== 'client_credentials' || f.client_id !== c.client_id || f.client_secret !== c.client_secret) return deny(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      const t = 'jat_' + crypto.randomBytes(12).toString('hex'); jfcuTokens.set(t, { n: ++jfcuIssued, uses: 0 }); return json(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 3600, scope: 'accounts statements' });
    }
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const tk = jfcuTokens.get(t); if (!tk) return deny(401, { error: 'invalid_token', error_description: 'Missing or invalid bearer token' });
    if (FRICTION && tk.n === 1 && tk.uses >= 2) { frictionEvent('token_expired', 'jfcu', p); return json(res, 401, { error: 'invalid_token', error_description: 'The access token expired' }); }
    tk.uses++;
    if (/statements/.test(p) && transient503('jfcu', 'bespoke')) return json(res, 503, { error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, retry later' });
    if ((m = /^\/api\/v2\/members\/([^/]+)\/accounts$/.exec(p))) {
      if (m[1] !== CRED.bespoke.jfcu.member_id) return json(res, 404, { error: 'not_found', error_description: 'Unknown member' });
      return json(res, 200, { accounts: bankAccounts('jfcu').map((a) => ({ accountId: a.id.toUpperCase(), nickname: a.name, accountType: a.type.toUpperCase(), maskedNumber: '****' + a.last4, currentBalance: D.BALANCE[a.id] })) });
    }
    if ((m = /^\/api\/v2\/accounts\/([^/]+)\/statements$/.exec(p))) {
      const a = bankAccounts('jfcu').find((x) => x.id.toUpperCase() === m[1].toUpperCase()); if (!a) return json(res, 404, { error: 'not_found', error_description: 'Unknown account' });
      const from = u.searchParams.get('fromDate') || '0000-00-00'; const to = u.searchParams.get('toDate') || '9999-99-99';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json(res, 400, { error: 'invalid_request', error_description: 'fromDate/toDate must be YYYY-MM-DD' });
      return json(res, 200, { statements: D.STATEMENTS[a.id].filter((s) => s.period_end >= from && s.period_end <= to).map((s) => ({ statementId: s.docid, periodStart: s.period_start, periodEnd: s.period_end })) });
    }
    if ((m = /^\/api\/v2\/statements\/([A-Z0-9-]+)(\/pdf)?$/.exec(p))) {
      const s = D.STATEMENT_BY_DOCID[m[1]]; if (!s || s.org !== 'jfcu') return json(res, 404, { error: 'not_found', error_description: 'Unknown statement' });
      if (m[2]) { access('jfcu', s.docid, 'bespoke-pdf'); return send(res, 200, pdf(statementLines(s)), 'application/pdf', { 'content-disposition': `attachment; filename="${s.docid}.pdf"` }); }
      access('jfcu', s.docid, 'bespoke-json');
      return json(res, 200, { statementId: s.docid, accountId: s.account_id.toUpperCase(), holder: s.holder, periodStart: s.period_start, periodEnd: s.period_end, openingBalance: s.opening_balance, closingBalance: s.closing_balance,
        transactions: s.transactions.map((t) => ({ postedDate: t.date, description: t.description, amount: t.amount, runningBalance: t.balance })), notices: s.notices });
    }
    return json(res, 404, { error: 'not_found', error_description: 'No such endpoint' });
  }
  if (k === 'nsb') {
    if (REAL) {
      if (p === '/ngsb/open/v1/oauth2/token' && req.method === 'POST') {
        let f = {}; try { f = JSON.parse(body.toString() || '{}'); } catch (e) { /* bad json */ }
        const pair = /^AUTHORIZATION_CODE$/i.test(f.grantType || '') ? redeemCode('nsb', f.authCode) : /^REFRESH_TOKEN$/i.test(f.grantType || '') ? refresh('nsb', f.refreshToken) : undefined;
        if (pair === undefined) return deny(400, { status: 'ERROR', code: 'BAD_GRANT_TYPE', message: 'grantType must be AUTHORIZATION_CODE or REFRESH_TOKEN' });
        if (!pair) return deny(400, { status: 'ERROR', code: 'INVALID_GRANT', message: 'authCode or refreshToken invalid or already used' });
        return json(res, 200, { data: { accessToken: pair.access, refreshToken: pair.refresh, expiresIn: 900 } });
      }
      if (req.headers['x-ngsb-apikey']) return deny(403, { status: 'ERROR', code: 'PARTNERS_ONLY', message: 'API keys are issued to registered partners only; consumers authorise access with OAuth consent (see /api/docs)' });
      if (!oauthTokens.nsb.has((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))) return deny(401, { status: 'ERROR', code: 'AUTH_REQUIRED', message: 'Bearer access token required' });
    } else {
    const c = CRED.bespoke.nsb; if (req.headers['x-ngsb-apikey'] !== c.api_key || req.headers['x-ngsb-customer'] !== c.customer_id) return deny(403, { status: 'ERROR', code: 'AUTH_FAILED', message: 'Invalid API key or customer' });
    }
    const pref = (a) => 'NG' + a.last4 + 'X';
    if (/estatements|documents/.test(p) && transient503('nsb', 'bespoke')) return json(res, 503, { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry' });
    if (p === '/ngsb/open/v1/customer/products') return json(res, 200, { data: { products: bankAccounts('nsb').map((a) => ({ productRef: pref(a), productName: a.name, productType: a.kind === 'business' ? 'BUSINESS_CHECKING' : a.type === 'checking' ? 'PERSONAL_CHECKING' : 'PERSONAL_SAVINGS', acctSuffix: a.last4, ledgerBal: D.BALANCE[a.id] })) } });
    if ((m = /^\/ngsb\/open\/v1\/products\/([^/]+)\/estatements$/.exec(p))) {
      const a = bankAccounts('nsb').find((x) => pref(x) === m[1]); if (!a) return json(res, 404, { status: 'ERROR', code: 'NOT_FOUND', message: 'Unknown productRef' });
      const mo = u.searchParams.get('month') || ''; const mm = /^(\d{2})\/(\d{4})$/.exec(mo); if (!mm) return json(res, 400, { status: 'ERROR', code: 'BAD_MONTH', message: 'month must be MM/YYYY' });
      const s = D.STATEMENTS[a.id].find((x) => x.period === `${mm[2]}-${mm[1]}`); if (!s) return json(res, 404, { status: 'ERROR', code: 'NO_STATEMENT', message: 'No eStatement for that month' });
      access('nsb', s.docid, 'bespoke-json');
      return json(res, 200, { data: { eStatement: { docRef: s.docid, holder: s.holder, cycle: `${mdy(s.period_start)}-${mdy(s.period_end)}`, begBal: s.opening_balance, endBal: s.closing_balance, items: s.transactions.map((t) => ({ postDate: mdy(t.date), memo: t.description, amt: t.amount, runBal: t.balance })), messages: s.notices } } });
    }
    if ((m = /^\/ngsb\/open\/v1\/documents\/([A-Z0-9-]+)$/.exec(p))) {
      const s = D.STATEMENT_BY_DOCID[m[1]]; if (!s || s.org !== 'nsb') return json(res, 404, { status: 'ERROR', code: 'NOT_FOUND', message: 'Unknown docRef' });
      if (u.searchParams.get('format') !== 'pdf') return json(res, 400, { status: 'ERROR', code: 'BAD_FORMAT', message: 'format=pdf required' });
      access('nsb', s.docid, 'bespoke-pdf'); return send(res, 200, pdf(statementLines(s)), 'application/pdf', { 'content-disposition': `attachment; filename="${s.docid}.pdf"` });
    }
    return json(res, 404, { status: 'ERROR', code: 'NOT_FOUND', message: 'No such endpoint' });
  }
  if (k === 'lgh') {
    if (REAL) {
      if (p === '/peoplepay/rest/auth/token' && req.method === 'POST') {
        const f = parseForm(body); const pair = f.grant_type === 'authorization_code' ? redeemCode('lgh', f.code) : f.grant_type === 'refresh_token' ? refresh('lgh', f.refresh_token) : undefined;
        if (pair === undefined) return deny(400, { fault: { code: 400, message: 'grant_type must be authorization_code or refresh_token' } });
        if (!pair) return deny(400, { fault: { code: 400, message: 'invalid or used code / refresh token' } });
        return json(res, 200, { access_token: pair.access, refresh_token: pair.refresh, expires_in: 900 });
      }
      if (/^Basic/i.test(req.headers.authorization || '')) return deny(401, { fault: { code: 401, message: 'Basic authentication is disabled for consumer access; use OAuth (see /api/docs)' } });
      if (!oauthTokens.lgh.has((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))) return deny(401, { fault: { code: 401, message: 'Bearer access token required' } });
    } else {
    const c = CRED.bespoke.lgh; const auth = Buffer.from((req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString();
    if (auth !== `${c.api_user}:${c.api_password}`) return deny(401, { fault: { code: 401, message: 'Unauthorized' } });
    }
    if (/payStatements/.test(p) && transient503('lgh', 'bespoke')) return json(res, 503, { fault: { code: 503, message: 'Service Unavailable' } });
    const byWorker = (w) => Object.keys(D.PEOPLE).find((x) => D.PEOPLE[x].employee_id === w);
    if (p === '/peoplepay/rest/workers') {
      const w = u.searchParams.get('workerNumber'); const who = byWorker(w); if (!who) return json(res, 200, { workers: [] });
      const pp = D.PEOPLE[who]; return json(res, 200, { workers: [{ workerNumber: pp.employee_id, displayName: pp.name, jobTitle: pp.position, hireDt: ymd(pp.hire_date), baseRate: { amount: pp.annual_salary, per: 'YEAR' } }] });
    }
    if ((m = /^\/peoplepay\/rest\/workers\/([^/]+)\/payStatements$/.exec(p))) {
      const who = byWorker(m[1]); if (!who) return json(res, 404, { fault: { code: 404, message: 'Unknown worker' } });
      const since = u.searchParams.get('since') || '00000000'; if (!/^\d{8}$/.test(since)) return json(res, 400, { fault: { code: 400, message: 'since must be YYYYMMDD' } });
      return json(res, 200, { payStatements: [...D.PAYSLIPS[who]].reverse().filter((x) => ymd(x.pay_date) >= since).map((x) => ({ statementKey: x.docid, checkDt: ymd(x.pay_date), periodBeginDt: ymd(x.period_start), periodEndDt: ymd(x.period_end), grossAmt: x.gross, netAmt: x.net })) });
    }
    if ((m = /^\/peoplepay\/rest\/payStatements\/([A-Z0-9-]+)(\/file)?$/.exec(p))) {
      const x = D.PAYSLIP_BY_DOCID[m[1]]; if (!x) return json(res, 404, { fault: { code: 404, message: 'Unknown statementKey' } });
      if (m[2]) { access('lgh', x.docid, 'bespoke-pdf'); return send(res, 200, pdf(payslipLines(x)), 'application/pdf', { 'content-disposition': `attachment; filename="${x.docid}.pdf"` }); }
      access('lgh', x.docid, 'bespoke-json');
      return json(res, 200, { statementKey: x.docid, workerNumber: x.employee_id, displayName: x.employee_name, employer: x.employer, jobTitle: x.position, annualBase: x.annual_base_salary, checkDt: ymd(x.pay_date), periodBeginDt: ymd(x.period_start), periodEndDt: ymd(x.period_end), hours: x.hours, grossAmt: x.gross, deductions: x.deductions, netAmt: x.net, ytdGross: x.ytd_gross });
    }
    return json(res, 404, { fault: { code: 404, message: 'No such endpoint' } });
  }
}
function isBespoke(k, p) { return (k === 'bhl' && LENDER_API && p.startsWith('/bhl/api/')) || (k === 'jfcu' && p.startsWith('/api/')) || (k === 'nsb' && (p.startsWith('/ngsb/') || p === '/developer')) || (k === 'lgh' && p.startsWith('/peoplepay/')); }

// ---------- lender bespoke API (B-full arms only): JSON:API-style resources ----------
DOCS.bhl = `Brightpath Home Lending Partner API v1 (JSON:API style)
Base URL: ${url('bhl')}/bhl/api/v1
Media type: application/vnd.api+json (application/json also accepted). Request and response bodies use { "data": { "type", "id", "attributes" } }.
Auth: POST /bhl/api/v1/auth/sessions  body { "data": { "type": "sessions", "attributes": { "login": "...", "apiSecret": "..." } } } -> 201 { data: { type: "sessions", id: "<session id>" } }.
      Then send "Authorization: BHL-Session <session id>" on every request.
POST  /bhl/api/v1/loan-applications  -> 201 draft. attributes:
      applicants: [ { legalName, dateOfBirth (YYYY-MM-DD), emailAddress, phoneNumber, maritalStatus, employment: { employerName, jobTitle, employedSince (YYYY-MM), yearlyBaseSalaryUsd } } ]
      residence: { line1, city, region, postalCode, tenure ("RENT"|"OWN"), monthlyRentUsd }
      collateral: { line1, city, region, postalCode, contractPriceUsd, occupancyCode ("PRIMARY"|"SECOND"|"INVESTMENT") }
      financing: { principalUsd, downPaymentUsd, productCode ("FIX30"|"FIX15"|"ARM76") }
      holdings: [ { institutionName, holdingType ("CHECKING"|"SAVINGS"|"OTHER"), accountMask (last 4), balanceUsd } ]
      consents: { creditPull: true, eDisclosure: true }
PATCH /bhl/api/v1/loan-applications/{id}  -> update a draft (same attributes, merged)
POST  /bhl/api/v1/loan-applications/{id}/documents  raw file body (Content-Type: application/pdf), header X-BHL-Document-Category: BANK_STATEMENT|PAYSTUB|OTHER -> 201
POST  /bhl/api/v1/loan-applications/{id}/submission  body { "data": { "type": "submissions", "attributes": { "certify": true } } } -> 202 (once only)
GET   /bhl/api/v1/loan-applications/{id}  -> attributes.state: DRAFT | SUBMITTED | ESTIMATE_ISSUED
GET   /bhl/api/v1/loan-applications/{id}/loan-estimate  -> 404 until issued; then { data: { type: "loan-estimates", id, attributes: { noteRatePct, aprPct, principalAndInterestUsd, escrowUsd, totalMonthlyPaymentUsd, closingCostsUsd, cashToCloseUsd, productCode } } }
GET   /bhl/api/v1/loan-applications/{id}/conditions  -> { data: [ { type: "conditions", id, attributes: { description, state } } ] }
POST  /bhl/api/v1/conditions/{id}/responses  body { "data": { "type": "condition-responses", "attributes": { "explanation": "..." } } } -> 201
POST  /bhl/api/v1/conditions/{id}/documents  raw file body (application/pdf) -> 201
POST  /bhl/api/v1/loan-estimates/{id}/intent-to-proceed  body { "data": { "type": "intents", "attributes": { "signedBy": "..." } } } -> 201
Errors: { errors: [ { status, code, title, detail } ] }`;
if (REAL) {
  const consent = (tokenEp) => `Auth (consumer access): OAuth 2.0 authorization code. API keys and passwords are not issued to consumers. The account holder approves access on our consent screen and receives a one-time authorization code; ${tokenEp}. Access tokens last 15 minutes; refresh with the refresh token (no consent needed).`;
  DOCS.jfcu = DOCS.jfcu.replace(/Auth: .*\n/, consent('exchange it with POST /api/v2/oauth/token (form) grant_type=authorization_code&code=<code>; refresh with grant_type=refresh_token&refresh_token=<token>. Use "Authorization: Bearer <access_token>"') + '\n');
  DOCS.nsb = DOCS.nsb.replace(/Auth: .*\n/, consent('exchange it with POST /ngsb/open/v1/oauth2/token JSON { "grantType": "AUTHORIZATION_CODE", "authCode": "<code>" } -> { data: { accessToken, refreshToken } }; refresh with { "grantType": "REFRESH_TOKEN", "refreshToken": "..." }. Send "Authorization: Bearer <accessToken>"') + '\n');
  DOCS.lgh = DOCS.lgh.replace(/Auth: .*\n/, consent('exchange it with POST /peoplepay/rest/auth/token (form) grant_type=authorization_code&code=<code> -> { access_token, refresh_token }; one consent covers the household\'s workers. Send "Authorization: Bearer <access_token>"') + '\n');
  DOCS.bhl = DOCS.bhl.replace(/Auth: POST \/bhl\/api\/v1\/auth\/sessions .*\n/, 'Auth: consumer access by consent. The applicant approves access on our consent screen and receives a one-time authorization code; POST /bhl/api/v1/auth/sessions body { "data": { "type": "sessions", "attributes": { "authorizationCode": "<code>" } } } -> 201 { data: { type: "sessions", id } }.\n');
}
const bhlSessions = new Set();
async function lenderApi(req, res, u, body) {
  const p = u.pathname.replace(/^\/bhl\/api\/v1/, ''); let m;
  const J = (code, obj) => send(res, code, JSON.stringify(obj, null, 1), 'application/vnd.api+json');
  const err = (code, c, title, detail) => J(code, { errors: [{ status: String(code), code: c, title, detail }] });
  const parse = () => { try { return JSON.parse(body.toString('utf8') || '{}'); } catch (e) { return null; } };
  if (p === '/auth/sessions' && req.method === 'POST') {
    const b = parse(); const a = b && b.data && b.data.attributes; const c = CRED.bespoke.bhl;
    if (REAL ? !(a && redeemCode('bhl', a.authorizationCode)) : (!a || a.login !== c.login || a.apiSecret !== c.api_secret)) { state.bespoke_auth_failures.push({ org: 'bhl', path: p, ts: new Date().toISOString() }); save(); return err(401, 'INVALID_CREDENTIALS', 'Unauthorized', 'login or apiSecret is wrong'); }
    const id = 'bs_' + crypto.randomBytes(10).toString('hex'); bhlSessions.add(id); return J(201, { data: { type: 'sessions', id, attributes: { expiresIn: 3600 } } });
  }
  const sid = (req.headers.authorization || '').replace(/^BHL-Session\s+/i, '');
  if (!bhlSessions.has(sid)) { state.bespoke_auth_failures.push({ org: 'bhl', path: p, ts: new Date().toISOString() }); save(); return err(401, 'NO_SESSION', 'Unauthorized', 'send Authorization: BHL-Session <id>'); }
  const drafts = (state.lender.api_drafts ||= {});
  const appOf = (laid) => state.lender.applications.find((a) => a.api_id === laid);
  if (p === '/loan-applications' && req.method === 'POST') {
    const b = parse(); if (!b || !b.data || b.data.type !== 'loan-applications') return err(400, 'BAD_DOCUMENT', 'Bad request', 'expected data.type "loan-applications"');
    const id = 'la_' + (Object.keys(drafts).length + 1001); drafts[id] = { attributes: b.data.attributes || {}, docs: [], submitted: false }; save();
    return J(201, { data: { type: 'loan-applications', id, attributes: { state: 'DRAFT' } } });
  }
  if ((m = /^\/loan-applications\/(la_\d+)(\/documents|\/submission|\/loan-estimate|\/conditions)?$/.exec(p))) {
    const dr = drafts[m[1]]; if (!dr) return err(404, 'NOT_FOUND', 'Not found', 'unknown loan application');
    const app = appOf(m[1]);
    if (!m[2] && req.method === 'PATCH') { if (dr.submitted) return err(409, 'LOCKED', 'Conflict', 'application already submitted'); const b = parse(); Object.assign(dr.attributes, (b && b.data && b.data.attributes) || {}); save(); return J(200, { data: { type: 'loan-applications', id: m[1], attributes: { state: 'DRAFT' } } }); }
    if (!m[2]) { const ready = app && appView(app); return J(200, { data: { type: 'loan-applications', id: m[1], attributes: { state: !app ? 'DRAFT' : ready ? 'ESTIMATE_ISSUED' : 'SUBMITTED', documentCount: dr.docs.length }, links: { estimate: `/bhl/api/v1/loan-applications/${m[1]}/loan-estimate`, conditions: `/bhl/api/v1/loan-applications/${m[1]}/conditions` } } }); }
    if (m[2] === '/documents' && req.method === 'POST') {
      if (dr.submitted) return err(409, 'LOCKED', 'Conflict', 'application already submitted');
      const rec = { upload_id: `U${state.lender.uploads.length + 1}`, filename: req.headers['x-bhl-filename'] || 'document.pdf', size: body.length, docids: docidsIn(body), doc_type: req.headers['x-bhl-document-category'] || '', ts: new Date().toISOString(), via: 'bespoke' };
      state.lender.uploads.push(rec); dr.docs.push(rec); save();
      return J(201, { data: { type: 'documents', id: rec.upload_id, attributes: { size: rec.size, category: rec.doc_type } } });
    }
    if (m[2] === '/submission' && req.method === 'POST') {
      if (dr.submitted) return err(409, 'ALREADY_SUBMITTED', 'Conflict', 'this application has already been submitted');
      const b = parse(); if (!(b && b.data && b.data.attributes && b.data.attributes.certify === true)) return err(422, 'CERTIFY_REQUIRED', 'Unprocessable', 'attributes.certify must be true');
      const c = dr.attributes.consents || {}; if (!(c.creditPull && c.eDisclosure)) return err(422, 'CONSENT_REQUIRED', 'Unprocessable', 'consents.creditPull and consents.eDisclosure must be true');
      dr.submitted = true; const a = newApp('bespoke', dr.attributes, [...new Set(dr.docs.flatMap((x) => x.docids))], dr.docs.map((x) => x.filename), { credit_check: true, esign: true }); a.api_id = m[1]; save();
      return J(202, { data: { type: 'loan-applications', id: m[1], attributes: { state: 'SUBMITTED', referenceNumber: a.id } } });
    }
    if (!app) return err(409, 'NOT_SUBMITTED', 'Conflict', 'application has not been submitted');
    const ready = appView(app);
    if (m[2] === '/loan-estimate') {
      if (!ready) return err(404, 'NOT_ISSUED', 'Not found', 'Loan Estimate not yet issued; try again in a few seconds');
      const le = leFor(app);
      return J(200, { data: { type: 'loan-estimates', id: le.estimate_id, attributes: { noteRatePct: le.rate_percent, aprPct: le.apr_percent, principalAndInterestUsd: le.monthly_principal_interest, escrowUsd: le.estimated_escrow, totalMonthlyPaymentUsd: le.estimated_total_monthly_payment, closingCostsUsd: le.closing_costs, cashToCloseUsd: le.cash_to_close, productCode: 'FIX30', principalUsd: le.loan_amount } } });
    }
    if (m[2] === '/conditions') return J(200, { data: ready ? app.conditions.map((c) => ({ type: 'conditions', id: c.condition_id, attributes: { description: c.text, state: c.status === 'open' ? 'OPEN' : 'RESPONDED' } })) : [] });
  }
  if ((m = /^\/conditions\/(C-BHL-\d+-\d+)\/(responses|documents)$/.exec(p)) && req.method === 'POST') {
    const app = state.lender.applications.find((a) => a.conditions.some((c) => c.condition_id === m[1])); if (!app) return err(404, 'NOT_FOUND', 'Not found', 'unknown condition');
    const c = app.conditions.find((x) => x.condition_id === m[1]);
    if (m[2] === 'documents') { const rec = { upload_id: `U${state.lender.uploads.length + 1}`, filename: req.headers['x-bhl-filename'] || 'document.pdf', size: body.length, docids: docidsIn(body), doc_type: 'CONDITION', ts: new Date().toISOString(), via: 'bespoke' }; state.lender.uploads.push(rec); (c.api_docs ||= []).push(...rec.docids); save(); return J(201, { data: { type: 'documents', id: rec.upload_id } }); }
    const b = parse(); const ex = b && b.data && b.data.attributes && b.data.attributes.explanation; if (!ex) return err(422, 'EXPLANATION_REQUIRED', 'Unprocessable', 'attributes.explanation required');
    state.lender.condition_responses.push({ app: app.id, condition_id: c.condition_id, text: String(ex), docids: c.api_docs || [], files: [], ts: new Date().toISOString(), via: 'bespoke' }); c.status = 'response received'; save();
    return J(201, { data: { type: 'condition-responses', id: `R-${state.lender.condition_responses.length}`, attributes: { state: 'RECEIVED' } } });
  }
  if ((m = /^\/loan-estimates\/(LE-(BHL-\d+)-1)\/intent-to-proceed$/.exec(p)) && req.method === 'POST') {
    const app = state.lender.applications.find((a) => a.id === m[2]); if (!app || !appView(app)) return err(404, 'NOT_FOUND', 'Not found', 'unknown Loan Estimate');
    const b = parse(); const le = leFor(app);
    state.lender.intents.push({ app: app.id, estimate_id: le.estimate_id, ts: new Date().toISOString(), via: 'bespoke', signature: (b && b.data && b.data.attributes && b.data.attributes.signedBy) || '', terms: termsOf(le) }); save();
    return J(201, { data: { type: 'intents', id: `I-${app.id}`, attributes: { state: 'RECORDED' } } });
  }
  return err(404, 'NOT_FOUND', 'Not found', 'no such endpoint');
}

// ---------- common agent API ----------
const DESCRIBE_COMMON = {
  api: 'agent/v1', request: 'POST /agent/v1/request with JSON body { operation, subject, on_behalf_of, recipient, purpose, permission_token, params }',
  rules: 'Every request is checked against permission_token (verbs, objects, recipient, purpose, limits). Denials return 403 with a reason. Results carry origin and permitted_use.',
};
function describe(k) {
  const o = ORGX[k];
  if (REAL && (k === 'cml' || k === 'srm')) return { organization: o.id, name: o.name, ...DESCRIBE_COMMON, operations: { 'products.list': { params: {}, auth: 'public, no permission_token needed', returns: '{ products: [ ... ] }' } }, note: 'Online applications are not available at this lender.' };
  const ops = k === 'bhl' ? {
    ...(REAL ? { 'products.list': { params: {}, auth: 'public, no permission_token needed', returns: '{ products: [ { product_code, name, term_years, rate_type, rate_percent, apr_percent, discount_points, example_loan_amount, estimated_monthly_payment, estimated_closing_costs } ] }' } } : {}),
    'application.submit': { params: { application: { borrowers: '[ { name, date_of_birth (YYYY-MM-DD), email, phone, marital_status, employer, position, start_date (YYYY-MM-DD), annual_base_income } ]', current_address: '{ street, city, state, zip, housing, monthly_rent }', property: '{ street, city, state, zip, purchase_price, occupancy }', loan: '{ loan_amount, down_payment, product }', assets: '[ { institution, account_type, last4, balance } ]' }, records: '[ record_ref, ... ] (records provided to this lender by other organizations)', consents: '{ credit_check: true, esign: true }' }, returns: '{ application_id, status }' },
    'application.status': { params: { application_id: 'string' }, returns: '{ application_id, status, loan_estimate|null, conditions: [ { condition_id, text, status } ] }' },
    'condition.respond': { params: { application_id: 'string', condition_id: 'string', response: 'string', records: '[record_ref] optional, records provided to this lender' }, returns: '{ status }' },
    'estimate.accept_intent': { params: { application_id: 'string', estimate_id: 'string' }, returns: '{ status }' },
  } : {
    'records.list': { params: { record_type: k === 'lgh' ? 'payslip' : 'statement|account' }, returns: '{ records: [ ... ] } metadata only' },
    'records.provide': { params: k === 'lgh' ? { items: '[ { record_type: "payslip", record_id } ]' } : { items: '[ { record_type: "statement", account_id, period: "YYYY-MM" } ]' }, returns: '{ records: [ { record_ref, content, origin, permitted_use } ] }' },
  };
  return { organization: o.id, name: o.name, ...DESCRIBE_COMMON, operations: ops };
}
const records = new Map(); // ref -> record
function deny(res, org, b, reason) { state.agent.denials.push({ ts: new Date().toISOString(), org, operation: b.operation, reason, params: b.params }); save(); return json(res, 403, { ok: false, error: 'permission_denied', reason }); }
function sign(obj) { return crypto.createHmac('sha256', 'testbed-' + SEED).update(JSON.stringify(obj)).digest('hex').slice(0, 24); }
function fetchJson(target, headers) {
  return new Promise((resolve) => { http.get(target, { headers }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { resolve({ code: r.statusCode, body: JSON.parse(Buffer.concat(c).toString()) }); } catch (e) { resolve({ code: r.statusCode, body: null }); } }); }).on('error', () => resolve({ code: 0, body: null })); });
}
async function agentApi(k, req, res, u, body) {
  const p = u.pathname;
  if (p === '/agent/v1/describe') return json(res, 200, describe(k));
  let m;
  if ((m = /^\/agent\/v1\/records\/([a-z0-9_]+)$/.exec(p))) { // server-to-server retrieval by the recipient
    const r = records.get(m[1]); if (!r || r.origin.org !== ORGX[k].id) return json(res, 404, { ok: false, error: 'unknown record' });
    if (req.headers['x-requesting-org'] !== r.permitted_use.recipient) return json(res, 403, { ok: false, error: 'recipient mismatch' });
    return json(res, 200, { ok: true, record: r });
  }
  if (p !== '/agent/v1/request' || req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });
  let b; try { b = JSON.parse(body.toString('utf8')); } catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
  state.agent.calls.push({ ts: new Date().toISOString(), org: k, operation: b.operation }); save();
  if (REAL && D.LENDER_KEYS.includes(k) && b.operation === 'products.list') return json(res, 200, { ok: true, organization: ORGX[k].id, as_of: D.TODAY, products: D.PRODUCTS[k] });
  if (REAL && (k === 'cml' || k === 'srm')) { otherLender(k, 'agent', b.operation); return json(res, 501, { ok: false, error: 'not_available', reason: 'Online applications are not available at this lender; please call 1-555-0199.' }); }
  let g = GRANTS[b.permission_token] || (REAL ? F.grantFromToken(SEED, b.permission_token) : null);
  if (REAL && GRANTS[b.permission_token]) g = null; // pre-issued fixture tokens are not valid in the realistic condition
  // Friction: each grant's original token expires after its first successful use; the user's wallet re-issues it as <token>_r1 (same grant, same scope and counters).
  const reissued = FRICTION && !g && /_r1$/.test(b.permission_token || '') && GRANTS[b.permission_token.slice(0, -3)];
  if (reissued) g = reissued;
  if (!g || g.org !== k) return deny(res, k, b, 'unknown or foreign permission_token');
  if (FRICTION && !reissued && g.used_once) { frictionEvent('permission_token_expired', k, b.operation); return json(res, 401, { ok: false, error: 'token_expired', reason: 'permission_token has expired; ask its issuer (the user\'s wallet) to re-issue it' }); }
  const markUsed = () => { if (FRICTION && !reissued) g.used_once = true; };
  const jsonOk = (r, code, obj) => { if (code === 200) markUsed(); return json(r, code, obj); };
  if (!g.operations.includes(b.operation)) return deny(res, k, b, `operation ${b.operation} not permitted by token`);
  const subjOk = g.subject === b.subject || (g.subject === 'household:okafor-reyes' && [D.PEOPLE.sam.id, D.PEOPLE.nadia.id, g.subject].includes(b.subject));
  if (!subjOk) return deny(res, k, b, 'subject does not match token');
  if (b.recipient !== g.recipient) return deny(res, k, b, `recipient must be ${g.recipient}`);
  if (b.purpose !== g.purpose) return deny(res, k, b, `purpose must be ${g.purpose}`);
  const P = b.params || {};
  if (k !== 'bhl') {
    const who = Object.keys(D.PEOPLE).find((x) => D.PEOPLE[x].id === g.subject);
    if (b.operation === 'records.list') {
      if (k === 'lgh') return jsonOk(res, 200, { ok: true, origin: ORGX[k].id, records: [...D.PAYSLIPS[who]].reverse().map((x) => ({ record_type: 'payslip', record_id: x.docid, pay_date: x.pay_date, period: `${x.period_start}..${x.period_end}`, gross: x.gross, net: x.net })) });
      return jsonOk(res, 200, { ok: true, origin: ORGX[k].id, accounts: bankAccounts(k).map((a) => ({ account_id: a.id, name: a.name, type: a.type, ownership: a.kind === 'business' ? 'business (Okafor-Reyes Studio LLC)' : 'personal', last4: a.last4, current_balance: D.BALANCE[a.id], statements_available: D.STATEMENTS[a.id].map((s) => s.period) })) });
    }
    if (b.operation === 'records.provide') {
      if (transient503(k, 'agent')) return json(res, 503, { ok: false, error: 'temporarily_unavailable', retry_after_s: 1 });
      const items = Array.isArray(P.items) ? P.items : [P];
      const used = state.agent.provided.filter((x) => x.token === g.token).length;
      if (used + items.length > g.limits.max_records) return deny(res, k, b, `token allows at most ${g.limits.max_records} records`);
      const out = [];
      for (const it of items) {
        let doc;
        if (k === 'lgh') {
          if (it.record_type !== 'payslip') return deny(res, k, b, 'record_type not permitted');
          if (!g.scope.docids.includes(it.record_id)) return deny(res, k, b, `record ${it.record_id} outside token scope`);
          doc = D.PAYSLIP_BY_DOCID[it.record_id];
        } else {
          if (it.record_type !== 'statement') return deny(res, k, b, 'record_type not permitted');
          if (!g.scope.accounts.includes(it.account_id)) return deny(res, k, b, `account ${it.account_id} outside token scope`);
          if (!g.scope.periods.includes(it.period)) return deny(res, k, b, `period ${it.period} outside token scope`);
          doc = (D.STATEMENTS[it.account_id] || []).find((s) => s.period === it.period);
        }
        if (!doc) return json(res, 404, { ok: false, error: 'record not found', item: it });
        const ref = `rec_${k}_${crypto.randomBytes(5).toString('hex')}`;
        const permitted = { recipient: g.recipient, purpose: g.purpose, expires: '2026-12-31' };
        const origin = { org: ORGX[k].id, issued_at: new Date().toISOString() }; origin.signature = sign({ ref, docid: doc.docid, origin, permitted });
        const content = k === 'lgh' ? { ...doc, person: undefined } : { ...doc, org: undefined, owner: undefined, kind: undefined };
        const rec = { record_ref: ref, record_type: k === 'lgh' ? 'payslip' : 'statement', docid: doc.docid, content, origin, permitted_use: permitted };
        records.set(ref, rec); state.agent.provided.push({ ts: origin.issued_at, org: k, token: g.token, ref, docid: doc.docid, recipient: g.recipient, purpose: g.purpose }); out.push(rec);
      }
      save(); return jsonOk(res, 200, { ok: true, records: out });
    }
  }
  // lender
  if (b.operation === 'application.submit') {
    const used = state.lender.applications.filter((a) => a.token === g.token).length;
    if (used >= g.limits.max_submissions) return deny(res, k, b, 'token allows only one submission; application already submitted');
    const A = P.application || {}; const errs = [];
    if (!Array.isArray(A.borrowers) || !A.borrowers.length) errs.push('application.borrowers required');
    if (!A.property || !A.property.purchase_price) errs.push('application.property.purchase_price required');
    if (!A.loan || !A.loan.loan_amount) errs.push('application.loan.loan_amount required');
    if (!P.consents || !P.consents.credit_check || !P.consents.esign) errs.push('consents.credit_check and consents.esign must be true');
    if (errs.length) return json(res, 400, { ok: false, error: 'validation_failed', details: errs });
    const docids = []; const refs = Array.isArray(P.records) ? P.records : [];
    for (const ref of refs) {
      const r = typeof ref === 'string' ? ref : ref && ref.record_ref; const okey = (/^rec_([a-z]+)_/.exec(r || '') || [])[1];
      if (!okey || !ORGX[okey]) return json(res, 400, { ok: false, error: `bad record_ref ${r}` });
      const got = await fetchJson(`${url(okey)}/agent/v1/records/${r}`, { 'x-requesting-org': g.recipient });
      if (got.code !== 200) return json(res, 400, { ok: false, error: `could not retrieve ${r} from its origin (${got.code})` });
      docids.push(got.body.record.docid);
    }
    const app = newApp('agent', A, [...new Set(docids)], refs, P.consents); app.token = g.token; save();
    return jsonOk(res, 200, { ok: true, application_id: app.id, status: 'submitted', records_received: docids.length, note: 'Loan Estimate is usually ready within a few seconds; check application.status.' });
  }
  const app = state.lender.applications.find((a) => a.id === P.application_id);
  if (!app) return json(res, 404, { ok: false, error: 'unknown application_id' });
  const ready = appView(app);
  if (b.operation === 'application.status') return jsonOk(res, 200, { ok: true, application_id: app.id, status: ready ? 'loan_estimate_issued' : 'processing', loan_estimate: ready ? leFor(app) : null, conditions: app.conditions, intent_received: state.lender.intents.some((x) => x.app === app.id) });
  if (b.operation === 'condition.respond') {
    const c = app.conditions.find((x) => x.condition_id === P.condition_id); if (!c) return json(res, 404, { ok: false, error: 'unknown condition_id' });
    const cdocs = [];
    for (const ref of (Array.isArray(P.records) ? P.records : [])) {
      const r = typeof ref === 'string' ? ref : ref && ref.record_ref; const okey = (/^rec_([a-z]+)_/.exec(r || '') || [])[1];
      if (!okey || !ORGX[okey]) return json(res, 400, { ok: false, error: `bad record_ref ${r}` });
      const got = await fetchJson(`${url(okey)}/agent/v1/records/${r}`, { 'x-requesting-org': g.recipient });
      if (got.code !== 200) return json(res, 400, { ok: false, error: `could not retrieve ${r} from its origin (${got.code})` });
      cdocs.push(got.body.record.docid);
    }
    state.lender.condition_responses.push({ app: app.id, condition_id: c.condition_id, text: String(P.response || ''), docids: cdocs, files: [], ts: new Date().toISOString(), via: 'agent' }); c.status = 'response received'; save();
    return jsonOk(res, 200, { ok: true, status: 'response received' });
  }
  if (b.operation === 'estimate.accept_intent') {
    if (!ready) return json(res, 409, { ok: false, error: 'no Loan Estimate yet' });
    const le = leFor(app); if (P.estimate_id !== le.estimate_id) return json(res, 404, { ok: false, error: 'unknown estimate_id' });
    const L = g.limits; if (le.rate_percent > L.max_rate_percent || le.estimated_total_monthly_payment > L.max_monthly_payment || le.closing_costs > L.max_closing_costs) return deny(res, k, b, 'Loan Estimate outside the limits in the permission token');
    state.lender.intents.push({ app: app.id, estimate_id: le.estimate_id, ts: new Date().toISOString(), via: 'agent', terms: termsOf(le) }); save();
    return jsonOk(res, 200, { ok: true, status: 'intent to proceed recorded' });
  }
  return json(res, 400, { ok: false, error: 'unknown operation' });
}

// ---------- realistic: other lenders, OTP, rates pages ----------
function otherLender(k, via, what) { (state.other_lender_activity ||= []).push({ ts: new Date().toISOString(), org: k, via, what }); save(); }
const pendingLogins = new Map();
function issueOtp(k, who) {
  const code = String(100000 + crypto.randomInt(900000)); const pid = crypto.randomBytes(10).toString('hex');
  pendingLogins.set(pid, { k, who, code, tries: 0 });
  fs.appendFileSync(HUMAN_OTP, JSON.stringify({ ts: new Date().toISOString(), org: k, user: who, code }) + '\n');
  (state.otp_issued ||= []).push({ ts: new Date().toISOString(), org: k, user: who }); save();
  return pid;
}
function otpPage(k, req, err) {
  return layout(k, 'Verify it\'s you', `${err ? `<p class="err">${esc(err)}</p>` : ''}<p>We don't recognise this device. We sent a 6-digit code by text message to the phone number on file for this account. Enter it to continue.</p>
<form method="post" action="/login/verify"><label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"><p><label><input type="checkbox" name="trust"> Trust this device</label></p><button>Verify</button></form>`, req);
}
const CTX = { schema: 'https://schema.org/', aw: 'https://w3id.org/agentweb-testbed#', dpv: 'https://w3id.org/dpv#', prov: 'http://www.w3.org/ns/prov#', xsd: 'http://www.w3.org/2001/XMLSchema#' };
const MA = (v) => ({ '@type': 'schema:MonetaryAmount', 'schema:value': v, 'schema:currency': 'USD' });
function productsLd(k) {
  const base = url(k); const org = { '@id': `${base}/#org`, '@type': 'schema:FinancialService', 'schema:name': ORGX[k].name, 'schema:url': base + '/' };
  return { '@context': CTX, '@graph': [org, ...D.PRODUCTS[k].map((x) => ({ '@id': `${base}/rates#${x.product_code}`, '@type': 'schema:MortgageLoan', 'schema:name': x.name, 'schema:identifier': x.product_code,
    'schema:provider': { '@id': `${base}/#org` }, 'schema:loanTerm': { '@type': 'schema:QuantitativeValue', 'schema:value': x.term_years, 'schema:unitCode': 'ANN' },
    'schema:interestRate': x.rate_percent, 'schema:annualPercentageRate': x.apr_percent, 'aw:rateType': x.rate_type, 'aw:discountPoints': x.discount_points,
    'aw:exampleLoanAmount': MA(x.example_loan_amount), 'aw:estimatedMonthlyPayment': MA(x.estimated_monthly_payment), 'aw:estimatedClosingCosts': MA(x.estimated_closing_costs), 'schema:validFrom': D.TODAY })) ] };
}
function ratesPage(k, req) {
  const P = D.PRODUCTS[k]; const pct = (v) => v.toFixed(3) + '%'; let body;
  const note = '<p class="note">Example for a $440,000 loan on a $550,000 purchase (20% down), primary residence, excellent credit. Monthly payment includes estimated property taxes and homeowner\'s insurance. Rates as of 2026-10-29; subject to change.</p>';
  if (k === 'bhl') body = `${note}<table><tr><th>Product</th><th>Rate</th><th>APR</th><th>Points</th><th>Est. closing costs</th><th>Est. monthly payment</th></tr>${P.map((x) => `<tr><td>${x.name}</td><td>${pct(x.rate_percent)}</td><td>${pct(x.apr_percent)}</td><td>${x.discount_points}</td><td>${money(x.estimated_closing_costs)}</td><td>${money(x.estimated_monthly_payment)}</td></tr>`).join('')}</table>`;
  else if (k === 'cml') body = `<h2>Today's home loan rates</h2>${P.map((x) => `<div style="border:1px solid #ccc;border-radius:8px;padding:10px 14px;margin:10px 0;max-width:420px"><h3 style="margin:4px 0">${x.name}</h3><p style="font-size:28px;margin:4px 0"><b>${pct(x.rate_percent)}</b> <small>rate</small></p><p>${pct(x.apr_percent)} APR</p><ul><li>${x.discount_points ? x.discount_points + ' discount points' : 'No discount points'}</li><li>Estimated closing costs: ${money(x.estimated_closing_costs)}</li><li>Estimated payment: ${money(x.estimated_monthly_payment)}/mo</li></ul></div>`).join('')}${note}`;
  else body = `<p>Summit Ridge publishes its rates daily.</p><dl>${P.map((x) => `<dt><strong>${x.name}</strong></dt><dd>Interest rate ${pct(x.rate_percent)} (APR ${pct(x.apr_percent)}). ${x.discount_points ? x.discount_points + ' points.' : 'No points.'} For the example loan: about ${money(x.estimated_monthly_payment)} a month including estimated taxes and insurance; estimated closing costs ${money(x.estimated_closing_costs)}.</dd>`).join('')}</dl>${note}`;
  const page = layout(k, k === 'srm' ? 'Rates' : k === 'cml' ? 'Mortgage rates' : 'Current mortgage rates', body + `<p><a href="/login">Sign in to apply</a></p>`, req);
  return page.replace('</head>', `<script type="application/ld+json">${JSON.stringify(productsLd(k))}</script></head>`);
}

// ---------- realistic: RDF (JSON-LD) face of the common agent API ----------
// Same semantics as /agent/v1/request: the JSON-LD request is normalised to the JSON request, handled by agentApi,
// and the JSON response is re-expressed in JSON-LD (schema.org / DPV / PROV-O / aw: testbed vocabulary).
const LD_MONEY = new Set(['amount', 'balance', 'opening_balance', 'closing_balance', 'current_balance', 'gross', 'net', 'total_deductions', 'ytd_gross', 'ytd_net', 'annual_base_salary', 'loan_amount',
  'monthly_principal_interest', 'estimated_escrow', 'estimated_total_monthly_payment', 'closing_costs', 'cash_to_close', 'estimated_closing_costs', 'estimated_monthly_payment', 'example_loan_amount', 'estimated_monthly_principal_interest']);
const LD_OUT = { name: 'schema:name', description: 'schema:description', rate_percent: 'schema:interestRate', apr_percent: 'schema:annualPercentageRate', loan_amount: 'schema:amount', docid: 'schema:identifier',
  product_code: 'schema:identifier', account_id: 'schema:identifier', record_id: 'schema:identifier', last4: 'aw:accountSuffix', date: 'schema:startDate', period_start: 'schema:startDate', period_end: 'schema:endDate',
  holder: 'schema:accountablePerson', employer: 'schema:worksFor', position: 'schema:jobTitle', employee_name: 'schema:name', text: 'schema:description' };
const camel = (k) => k.replace(/_([a-z])/g, (m0, c) => c.toUpperCase());
function toLd(v, key) {
  if (Array.isArray(v)) return v.map((x) => toLd(x, key));
  if (v && typeof v === 'object') {
    if (key === 'origin') return { '@type': 'prov:Entity', 'prov:wasAttributedTo': { '@id': `aw:org/${v.org}` }, 'prov:generatedAtTime': { '@value': v.issued_at, '@type': 'xsd:dateTime' }, 'aw:signature': v.signature };
    if (key === 'permitted_use') return { '@type': 'dpv:Permission', 'dpv:hasRecipient': { '@id': `aw:org/${v.recipient}` }, 'dpv:hasPurpose': { '@id': `aw:purpose/${v.purpose}` }, 'aw:expires': v.expires };
    const o = {};
    if (key === 'loan_estimate' || key === 'products') o['@type'] = 'schema:MortgageLoan';
    else if (key === 'accounts') o['@type'] = 'schema:BankAccount';
    else if (key === 'records') o['@type'] = ['aw:Record', 'schema:DigitalDocument'];
    else if (key === 'transactions') o['@type'] = 'schema:MoneyTransfer';
    for (const [kk, vv] of Object.entries(v)) {
      if (vv === undefined) continue;
      if (kk === 'term_years') { o['schema:loanTerm'] = { '@type': 'schema:QuantitativeValue', 'schema:value': vv, 'schema:unitCode': 'ANN' }; continue; }
      const term = LD_OUT[kk] || `aw:${camel(kk)}`;
      o[term] = LD_MONEY.has(kk) && typeof vv === 'number' ? MA(vv) : toLd(vv, kk);
    }
    return o;
  }
  return v;
}
function ldResponse(k, obj) { return { '@context': CTX, '@type': 'aw:AgentResponse', 'prov:wasAttributedTo': { '@id': `aw:org/${ORGX[k].id}` }, ...toLd(obj, 'root') }; }
// Request side: strip prefixes / IRIs, unwrap literals, MonetaryAmount and QuantitativeValue, then map terms to the JSON API.
const LD_IN = { onBehalfOf: 'on_behalf_of', hasRecipient: 'recipient', hasPurpose: 'purpose', permissionToken: 'permission_token', recordType: 'record_type', item: 'items', items: 'items', record: 'records', records: 'records',
  applicationId: 'application_id', conditionId: 'condition_id', estimateId: 'estimate_id', consent: 'consents', consents: 'consents', creditCheck: 'credit_check', esign: 'esign', response: 'response', period: 'period', operation: 'operation', subject: 'subject', params: 'params' };
function localName(key) { return String(key).replace(/^.*[#/:]/, ''); }
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === 'object') {
    if ('@value' in v) return v['@value'];
    const keys = Object.keys(v).filter((x) => x !== '@type' && x !== '@context');
    if (keys.length === 1 && keys[0] === '@id') return localName(v['@id']).replace(/^.*\//, '') || v['@id'];
    const t = [].concat(v['@type'] || []).map(localName);
    if (t.includes('MonetaryAmount') || t.includes('QuantitativeValue')) { const val = Object.entries(v).find(([kk]) => localName(kk) === 'value'); if (val) return unwrap(val[1]); }
    const o = {}; for (const [kk, vv] of Object.entries(v)) { if (kk === '@context' || kk === '@type') continue; if (kk === '@id') { o.id = vv; continue; } o[localName(kk)] = unwrap(vv); }
    return o;
  }
  return v;
}
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const addr = (a) => (a && typeof a === 'object' ? { street: a.streetAddress, city: a.addressLocality, state: a.addressRegion, zip: a.postalCode } : {});
function ldApplication(a) {
  return {
    borrowers: arr(a.borrower).map((b) => ({ name: b.name, date_of_birth: b.birthDate, email: b.email, phone: b.telephone, marital_status: b.maritalStatus,
      employer: b.worksFor && typeof b.worksFor === 'object' ? b.worksFor.name : b.worksFor, position: b.jobTitle, start_date: b.employedSince || b.startDate, annual_base_income: b.baseSalary })),
    current_address: { ...addr(a.currentAddress), housing: a.currentAddress && a.currentAddress.housing, monthly_rent: a.currentAddress && a.currentAddress.monthlyRent },
    property: { ...addr(a.property && a.property.address), purchase_price: a.property && a.property.purchasePrice, occupancy: a.property && a.property.occupancy },
    loan: { loan_amount: a.loan && a.loan.amount, down_payment: a.loan && a.loan.downPayment, product: a.loan && (a.loan.loanType || a.loan.name) },
    assets: arr(a.asset).map((x) => ({ institution: x.provider && typeof x.provider === 'object' ? x.provider.name : x.provider, account_type: x.accountType, last4: x.identifier || x.accountSuffix, balance: x.balance })),
  };
}
function ldRequestToJson(doc) {
  const u0 = unwrap(doc); const b = {};
  for (const [kk, vv] of Object.entries(u0)) b[LD_IN[kk] || kk] = vv;
  const P = b.params && typeof b.params === 'object' ? b.params : {}; const q = {};
  for (const [kk, vv] of Object.entries(P)) {
    const t = LD_IN[kk] || kk;
    if (t === 'items') q.items = arr(vv).map((it) => { const o = {}; for (const [a, c] of Object.entries(it)) { const n = LD_IN[a] || a; o[n === 'identifier' ? (it.recordType === 'payslip' ? 'record_id' : 'account_id') : n] = c; } return o; });
    else if (t === 'records') q.records = arr(vv).map((x) => (typeof x === 'object' ? x.recordRef || x.id : x));
    else if (t === 'consents') q.consents = { credit_check: !!(vv.creditCheck ?? vv.credit_check), esign: !!vv.esign };
    else if (kk === 'application') q.application = ldApplication(vv);
    else q[t] = vv;
  }
  b.params = q; return b;
}
function ldDescribe(k) {
  const d = describe(k); const tokenNote = 'aw:permissionToken: token from the user\'s wallet (approve_grant)';
  const ex = {
    'records.list': { 'aw:recordType': k === 'lgh' ? 'payslip' : 'account' },
    'records.provide': { 'aw:item': [k === 'lgh' ? { 'aw:recordType': 'payslip', 'schema:identifier': 'LGH-PS-E10442-20261016' } : { 'aw:recordType': 'statement', 'schema:identifier': k === 'nsb' ? 'nsb-2093' : 'jfcu-4417', 'aw:period': '2026-09' }] },
    'application.submit': { 'aw:application': { '@type': 'aw:LoanApplication',
      'aw:borrower': [{ '@type': 'schema:Person', 'schema:name': '...', 'schema:birthDate': 'YYYY-MM-DD', 'schema:email': '...', 'schema:telephone': '...', 'aw:maritalStatus': 'Married', 'schema:worksFor': { '@type': 'schema:Organization', 'schema:name': '...' }, 'schema:jobTitle': '...', 'aw:employedSince': 'YYYY-MM-DD', 'schema:baseSalary': MA(0) }],
      'aw:currentAddress': { '@type': 'schema:PostalAddress', 'schema:streetAddress': '...', 'schema:addressLocality': '...', 'schema:addressRegion': 'OR', 'schema:postalCode': '...', 'aw:housing': 'Rent', 'aw:monthlyRent': MA(0) },
      'aw:property': { '@type': 'schema:SingleFamilyResidence', 'schema:address': { '@type': 'schema:PostalAddress', 'schema:streetAddress': '...', 'schema:addressLocality': '...', 'schema:addressRegion': '..', 'schema:postalCode': '...' }, 'aw:purchasePrice': MA(0), 'aw:occupancy': 'Primary residence' },
      'aw:loan': { '@type': 'schema:MortgageLoan', 'schema:amount': MA(0), 'aw:downPayment': MA(0), 'schema:loanType': '30-year fixed' },
      'aw:asset': [{ '@type': 'schema:BankAccount', 'schema:provider': { '@type': 'schema:BankOrCreditUnion', 'schema:name': '...' }, 'aw:accountType': 'checking', 'schema:identifier': 'last 4 digits', 'aw:balance': MA(0) }] },
      'aw:record': ['rec_...'], 'aw:consent': { 'aw:creditCheck': true, 'aw:esign': true } },
    'application.status': { 'aw:applicationId': '...' }, 'condition.respond': { 'aw:applicationId': '...', 'aw:conditionId': '...', 'aw:response': '...', 'aw:record': [] },
    'estimate.accept_intent': { 'aw:applicationId': '...', 'aw:estimateId': '...' }, 'products.list': {},
  };
  return { '@context': CTX, '@type': 'aw:ServiceDescription', 'schema:provider': { '@id': `aw:org/${d.organization}`, 'schema:name': d.name }, 'aw:endpoint': 'POST /agent/v1/ld (application/ld+json)',
    'aw:rules': DESCRIBE_COMMON.rules, 'aw:requestShape': { '@context': '(the context above)', '@type': 'aw:AgentRequest', 'aw:operation': '<operation>', 'aw:subject': '<person or household id>', 'aw:onBehalfOf': '<id>', 'dpv:hasRecipient': '<recipient org id>', 'dpv:hasPurpose': '<purpose>', 'aw:permissionToken': tokenNote, 'aw:params': '{ operation-specific, see aw:operation }' },
    'aw:operation': Object.keys(d.operations).map((op) => ({ '@type': 'aw:Operation', 'schema:name': op, 'aw:returns': d.operations[op].returns, 'aw:exampleParams': ex[op] || {} })), ...(d.note ? { 'schema:description': d.note } : {}) };
}
async function ldApi(k, req, res, u, body) {
  const J = (code, obj) => send(res, code, JSON.stringify(obj, null, 1), 'application/ld+json');
  if (u.pathname === '/agent/v1/ld/describe') return J(200, ldDescribe(k));
  if (u.pathname !== '/agent/v1/ld' || req.method !== 'POST') return J(404, ldResponse(k, { ok: false, error: 'not found' }));
  let doc; try { doc = JSON.parse(body.toString('utf8')); } catch (e) { return J(400, ldResponse(k, { ok: false, error: 'invalid JSON-LD' })); }
  if (!doc['@context']) return J(400, ldResponse(k, { ok: false, error: 'missing @context' }));
  const jb = ldRequestToJson(doc);
  const cap = { code: 200, body: '', headersSent: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b; } };
  await agentApi(k, req, cap, new URL('http://x/agent/v1/request'), Buffer.from(JSON.stringify(jb)));
  let out; try { out = JSON.parse(cap.body); } catch (e) { out = { ok: false, error: 'internal' }; }
  return J(cap.code, ldResponse(k, out));
}

// ---------- realistic: rates index (crawls the lenders' rate pages; SPARQL via sparq) ----------
let idxStore = null; const idxInfo = { pages: [], triples: 0, engine: '@sparq-org/sparq@0.1.5' };
async function buildIndex() {
  const jsonld = require('jsonld'); const { SparqStore } = await import('@sparq-org/sparq');
  let nq = '';
  for (const k of D.LENDER_KEYS) {
    const html = await new Promise((resolve) => http.get(`${url(k)}/rates`, { headers: { 'x-crawler': 'rates-index', cookie: `${k}_consent=essential` } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c).toString())); }));
    const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g; let m;
    let n = 0; while ((m = re.exec(html))) { n++; nq += (await jsonld.toRDF(JSON.parse(m[1]), { format: 'application/n-quads' })).replace(/_:b(\d+)/g, `_:${k}${n}b$1`); } // blank-node labels are per document
    idxInfo.pages.push(`${url(k)}/rates`);
  }
  idxStore = await SparqStore.fromString(nq, 'ntriples'); idxInfo.triples = nq.trim().split('\n').length; state.index = idxInfo; save();
}
async function idxApi(req, res, u, body) {
  if (u.pathname === '/describe') return json(res, 200, { service: 'Mortgage Rates Index', crawled: idxInfo.pages, triples: idxInfo.triples, engine: idxInfo.engine, query: 'POST /sparql with a SPARQL 1.1 SELECT query as the body (text) -> SPARQL JSON results' });
  if (u.pathname !== '/sparql') return json(res, 404, { error: 'not found' });
  const q = req.method === 'POST' ? body.toString('utf8') : (u.searchParams.get('query') || '');
  try { const sols = idxStore.querySolutions(q); const vars = sols.length ? [...sols[0].keys()] : [];
    return json(res, 200, { head: { vars }, results: { bindings: sols.map((m0) => Object.fromEntries([...m0].map(([kk, t]) => [kk, { type: t.termType === 'NamedNode' ? 'uri' : 'literal', value: t.value }]))) } });
  } catch (e) { return json(res, 400, { error: 'query failed', detail: String(e.message || e).slice(0, 500) }); }
}

// ---------- router ----------
function iface(k, p, req) { if (req && req.headers['x-crawler']) return 'crawl'; if (k === 'idx') return 'index'; if (p === '/rates') return 'web-rates'; if (p.startsWith('/agent/v1/records/')) return 's2s'; if (p.startsWith('/agent/v1/ld')) return 'agent-ld'; if (p.startsWith('/agent/')) return 'agent'; if (isBespoke(k, p) || p === '/api/docs') return 'bespoke'; if (p === '/favicon.ico') return 'asset'; return 'web'; }
function makeServer(k) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const t0 = Date.now();
    res.on('finish', () => fs.appendFileSync(LOG, JSON.stringify({ ts: new Date(t0).toISOString(), org: k, method: req.method, path: p, iface: iface(k, p, req), status: res.statusCode, ms: Date.now() - t0 }) + '\n'));
    try {
      const body = await readBody(req);
      if (p === '/favicon.ico') return send(res, 204, '');
      if (k === 'idx') return await idxApi(req, res, u, body);
      if (REAL && p.startsWith('/agent/v1/ld')) return await ldApi(k, req, res, u, body);
      if (p.startsWith('/agent/')) return await agentApi(k, req, res, u, body);
      if (REAL && D.LENDER_KEYS.includes(k) && p === '/rates') return send(res, 200, ratesPage(k, req));
      if (REAL && (k === 'cml' || k === 'srm') && !['/consent', '/privacy', '/help'].includes(p)) otherLender(k, 'web', `${req.method} ${p}`);
      if (p === '/api/docs' || (k === 'nsb' && p === '/developer') || (k === 'lgh' && p === '/peoplepay/rest/help')) {
        if (k === 'bhl' && !LENDER_API) return send(res, 404, layout(k, 'Not found', '<p>Brightpath does not offer a public API.</p>', req));
        return send(res, 200, DOCS[k], 'text/plain; charset=utf-8');
      }
      if (k === 'bhl' && isBespoke(k, p)) return await lenderApi(req, res, u, body);
      if (k !== 'bhl' && isBespoke(k, p)) return await bespoke(k, req, res, u, body);
      // web portal
      if (p === '/consent' && req.method === 'POST') {
        const f = parseForm(body); (state.consent[k] ||= []).push(f.choice || 'unknown'); save();
        return redirect(res, f.next && f.next.startsWith('/') ? f.next : '/', { 'set-cookie': `${k}_consent=${f.choice === 'all' ? 'all' : 'essential'}; Path=/` });
      }
      if (p === '/privacy' || p === '/help') return send(res, 200, layout(k, p === '/help' ? 'Help' : 'Privacy', '<p>Contact us at 1-555-0100 during business hours.</p>', req));
      if (p === '/login' && req.method === 'POST') {
        const f = parseForm(body); const who = checkLogin(k, f); const L = (state.logins[k] ||= { ok: 0, fail: 0 });
        if (!who) { L.fail++; save(); return send(res, 401, loginPage(k, req, 'The username or password you entered is incorrect.')); }
        L.ok++; save();
        if (REAL) { const pid = issueOtp(k, who); return send(res, 200, otpPage(k, req), 'text/html; charset=utf-8', { 'set-cookie': `${k}_pending=${pid}; Path=/; HttpOnly` }); }
        const sid = crypto.randomBytes(12).toString('hex'); sessions.set(sid, { user: who, org: k });
        return redirect(res, k === 'bhl' ? '/dashboard' : k === 'lgh' ? '/home' : '/accounts', { 'set-cookie': `${k}_sid=${sid}; Path=/; HttpOnly` });
      }
      if (REAL && p === '/login/verify' && req.method === 'POST') {
        const f = parseForm(body); const pid = cookies(req)[`${k}_pending`]; const pl = pid && pendingLogins.get(pid);
        if (!pl) return send(res, 401, loginPage(k, req, 'Your sign-in attempt expired. Please sign in again.'));
        if (String(f.code || '').trim() !== pl.code) { pl.tries++; (state.otp_failures ||= []).push({ org: k, ts: new Date().toISOString() }); save(); return send(res, 401, otpPage(k, req, 'That code is not correct.')); }
        pendingLogins.delete(pid); const sid = crypto.randomBytes(12).toString('hex'); sessions.set(sid, { user: pl.who, org: k });
        return redirect(res, D.LENDER_KEYS.includes(k) ? '/dashboard' : k === 'lgh' ? '/home' : '/accounts', { 'set-cookie': `${k}_sid=${sid}; Path=/; HttpOnly` });
      }
      if (p === '/logout') { return redirect(res, '/login', { 'set-cookie': `${k}_sid=; Path=/; Max-Age=0` }); }
      const s = session(k, req);
      if (s && FRICTION && p !== '/login' && !fr.expired[k]) {
        s.count = (s.count || 0) + 1;
        if (s.count > WEB_EXPIRE_AFTER[k]) { fr.expired[k] = true; sessions.delete(cookies(req)[`${k}_sid`]); frictionEvent('session_expired', k, `${req.method} ${p}`); return send(res, 401, loginPage(k, req, 'Your session has expired. Please sign in again.')); }
      }
      if (p === '/login' || !s) return send(res, 200, loginPage(k, req));
      if (p === '/') return redirect(res, k === 'bhl' ? '/dashboard' : k === 'lgh' ? '/home' : '/accounts');
      if (k === 'jfcu' || k === 'nsb') return await bankWeb(k, req, res, u, s);
      if (k === 'lgh') return await lghWeb(req, res, u, s);
      if (k === 'cml' || k === 'srm') return send(res, 200, layout(k, 'Your account', '<p>Online applications are currently unavailable. Please call a loan officer on 1-555-0199.</p><p><a href="/rates">Current rates</a></p>', req, '<a href="/logout">Sign out</a>'));
      return await lenderWeb(req, res, u, s, body);
    } catch (e) {
      console.error(e); if (!res.headersSent) send(res, 500, 'Internal error');
    }
  });
}
(async () => {
  await Promise.all(Object.keys(ORGX).map((k) => new Promise((r) => makeServer(k).listen(BASE + ORGX[k].offset, '127.0.0.1', r))));
  if (REAL) await buildIndex();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`testbed up: ${Object.keys(ORGX).map((k) => `${k}=${url(k)}`).join(' ')}`);
})();
