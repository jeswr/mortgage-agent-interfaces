#!/usr/bin/env python3
"""Sensitivity of each run to the lender's fixed 5 s Loan Estimate delay (server.js:220).
For each run: t_sub = application creation (state.json), t_ready = first observation >= 5 s later
(state.json le_issued), t0 = first observation of the application after submission (server log at the
lender). If t0 < t_ready the agent saw 'processing'. Counterfactual with no delay: the first observation
would already show the Loan Estimate, so everything between t0 and t_ready is removed:
saved_s = t_ready - t0; removed model requests = agent model requests started in (t0, t_ready).
Usage: delay_sensitivity.py <results dir>"""
import json, gzip, os, sys, statistics as st
from datetime import datetime
R = sys.argv[1]
def P(ts): return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
def jl(f):
    if not os.path.exists(f) and os.path.exists(f + '.gz'): op, f = gzip.open, f + '.gz'
    elif not os.path.exists(f): return []
    else: op = open
    out = []
    for l in op(f, 'rt'):
        try: out.append(json.loads(l))
        except Exception: pass
    return out
runs = [json.loads(l) for l in open(os.path.join(R, 'runs.jsonl'))]
rows = []
for r in runs:
    d = os.path.join(R, 'raw', r['seed'])
    s = json.load(open(os.path.join(d, 'state.json')))
    apps = s['lender']['applications']
    if not apps: continue
    a = apps[0]; t_sub = P(a['ts']); t_ready = P(a['le_issued'])
    obs = []
    for q in jl(os.path.join(d, 'server-requests.jsonl')):
        if q['org'] != 'bhl' or q['iface'] in ('s2s', 'crawl', 'web-rates'): continue
        t = P(q['ts']); p = q['path']
        if t <= t_sub: continue
        if p.startswith('/applications/') or p.startswith('/agent/v1/request') or p.startswith('/agent/v1/ld') or (p.startswith('/bhl/api/v1/loan-applications/') and q['method'] == 'GET'):
            obs.append(t)
    t0 = min(obs) if obs else t_ready
    notready = [t for t in obs if t < t_ready - 0.05]
    saved = max(0.0, t_ready - t0) if notready else 0.0
    ids = set(); waits = 0; tools_in = 0
    for e in jl(os.path.join(d, 'stream.jsonl')):
        if e.get('type') == 'assistant':
            ids.add(e['message']['id'])
    px = [x for x in jl(os.path.join(d, 'proxy.jsonl')) if x.get('id') in ids]
    removed = [x for x in px if notready and t0 < P(x['ts']) < t_ready]
    rem_tok = sum(sum(x['usage'].get(k, 0) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens')) for x in removed)
    lat = [x['ms'] / 1000 for x in px]
    # context size of the first agent request after the Loan Estimate was issued (for the cache-expiry estimate)
    after = sorted([x for x in px if P(x['ts']) >= t_ready], key=lambda x: x['ts'])
    ctx = None
    if after:
        u = after[0]['usage']; ctx = (u.get('input_tokens', 0) or 0) + (u.get('cache_read_input_tokens', 0) or 0) + (u.get('cache_creation_input_tokens', 0) or 0)
    for e in jl(os.path.join(d, 'stream.jsonl')):
        if e.get('type') == 'assistant' and e.get('timestamp') and notready and t0 < P(e['timestamp']) <= t_ready + 0.5:
            for b in e['message'].get('content', []):
                if b.get('type') == 'tool_use':
                    tools_in += 1
                    if 'wait' in b['name']: waits += 1
    rows.append(dict(arm=r['arm'], model=r['model'].replace('claude-', ''), cond=r.get('condition') or 'baseline', wall=r['wall_s'], mreq=r['model_requests'], tok=r['tokens']['total'],
        t_first_obs=t0 - t_sub, t_ready=t_ready - t_sub, n_notready=len(notready), saved_s=saved, removed_req=len(removed), removed_tok=rem_tok,
        tools_in_window=tools_in, wait_tools=waits, med_lat=st.median(lat) if lat else None, ctx_after_le=ctx))
json.dump(rows, open(os.path.join(os.path.dirname(__file__), 'delay_rows.json'), 'w'), indent=1)
def med(xs): xs = [x for x in xs if x is not None]; return st.median(xs) if xs else float('nan')
groups = {}
for x in rows: groups.setdefault((x['cond'], x['arm'], x['model']), []).append(x)
print('cond,arm,model,n,wall_med,wall_nodelay_med,saved_s_med,saved_s_min,saved_s_max,saved_pct_med,notready_obs_med,mreq_med,removed_req_med,removed_req_min,removed_req_max,removed_tok_med,wait_tool_calls_total,first_obs_s_med,ready_s_med,model_latency_med_s,ctx_after_le_med')
for k in sorted(groups):
    g = groups[k]
    print(','.join(map(str, [*k, len(g), round(med([x['wall'] for x in g]), 1), round(med([x['wall'] - x['saved_s'] for x in g]), 1), round(med([x['saved_s'] for x in g]), 2),
        round(min(x['saved_s'] for x in g), 2), round(max(x['saved_s'] for x in g), 2), round(med([100 * x['saved_s'] / x['wall'] for x in g]), 1), med([x['n_notready'] for x in g]),
        med([x['mreq'] for x in g]), med([x['removed_req'] for x in g]), min(x['removed_req'] for x in g), max(x['removed_req'] for x in g), round(med([x['removed_tok'] for x in g])),
        sum(x['wait_tools'] for x in g), round(med([x['t_first_obs'] for x in g]), 2), round(med([x['t_ready'] for x in g]), 2), round(med([x['med_lat'] for x in g]), 2) if g[0]['med_lat'] else '', med([x['ctx_after_le'] for x in g])])))
