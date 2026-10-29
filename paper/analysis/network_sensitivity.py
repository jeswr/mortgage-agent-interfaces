#!/usr/bin/env python3
"""Wall-time and token sensitivity to real network latency and real page weights.
Wall time: added = N_nav * T_nav + (N_post + N_pdf) * T_rtt_web + N_api * T_api, where N_* are each run's server-logged
requests (server-requests.jsonl): web GETs = page navigations, web POSTs and PDF downloads = one round trip each,
bespoke/agent/agent-ld/s2s/index = API calls. All requests in these runs are sequential (each waits on a model turn or
on the previous call), so latencies add. Scenarios from our own Playwright measurement of 13 real pages (real_pages.json)
and the sandbox (sandbox_pages.json): T_nav = median TTFB (low), median DOMContentLoaded (central), median load (high).
Tokens (website arms only): page-content tokens re-read in every later request scale by the measured snapshot-size
ratio (real/sandbox median); extra = (k-1) * sum over requests of browser-result tokens already in context (chars/4).
Usage: network_sensitivity.py <results dir>"""
import json, gzip, os, sys, statistics as st
R = sys.argv[1]; here = os.path.dirname(os.path.abspath(__file__))
real = [x for x in json.load(open(os.path.join(here, 'real_pages.json'))) if x['status'] == 200 and x['nav']]
sand = json.load(open(os.path.join(here, 'sandbox_pages.json')))
ttfb = st.median(x['nav']['ttfb'] for x in real) / 1000; dcl = st.median(x['nav']['dcl'] for x in real) / 1000; load = st.median(x['nav']['load'] for x in real) / 1000
snap_real = st.median(x['snapshot_chars'] for x in real if x['snapshot_chars'] > 1000); snap_sand = st.median(x['snapshot_chars'] for x in sand)
k = snap_real / snap_sand
SCEN = {'low': dict(nav=ttfb, rtt=0.1, api=0.1), 'central': dict(nav=dcl, rtt=ttfb, api=0.3), 'high': dict(nav=load, rtt=ttfb, api=ttfb)}
print(f'real pages n={len(real)}: median TTFB {ttfb:.2f}s, DCL {dcl:.2f}s, load {load:.2f}s, requests {st.median(x["requests"] for x in real)}, snapshot {snap_real:.0f} chars; sandbox: median load {st.median(x["wall_load_s"] for x in sand):.3f}s, requests {st.median(x["requests"] for x in sand)}, snapshot {snap_sand:.0f} chars; ratio k={k:.1f}')
print('scenarios', {s: {kk: round(v, 2) for kk, v in d.items()} for s, d in SCEN.items()})
def jl(f):
    if not os.path.exists(f) and os.path.exists(f + '.gz'): op, f = gzip.open, f + '.gz'
    elif not os.path.exists(f): return []
    else: op = open
    return [json.loads(l) for l in op(f, 'rt') if l.strip()]
runs = [json.loads(l) for l in open(os.path.join(R, 'runs.jsonl'))]
out = {}
for r in runs:
    d = os.path.join(R, 'raw', r['seed']); n = dict(nav=0, post=0, pdf=0, api=0)
    for q in jl(os.path.join(d, 'server-requests.jsonl')):
        i = q['iface']
        if i in ('crawl', 'asset'): continue
        if i in ('web', 'web-rates'):
            if q['method'] == 'POST': n['post'] += 1
            elif q['path'].endswith('.pdf') or q['path'].endswith('/pdf'): n['pdf'] += 1
            else: n['nav'] += 1
        else: n['api'] += 1
    add = {s: n['nav'] * p['nav'] + (n['post'] + n['pdf']) * p['rtt'] + n['api'] * p['api'] for s, p in SCEN.items()}
    # token inflation for browser content
    stream = jl(os.path.join(d, 'stream.jsonl')); names = {}; cum = 0; seen = set(); s_sum = 0
    for e in stream:
        if e.get('type') == 'assistant':
            mid = e['message']['id']
            if mid not in seen: seen.add(mid); s_sum += cum
            for b in e['message'].get('content', []):
                if b.get('type') == 'tool_use': names[b['id']] = b['name']
        if e.get('type') == 'user' and isinstance(e['message'].get('content'), list):
            for b in e['message']['content']:
                if b.get('type') == 'tool_result' and 'browser' in names.get(b.get('tool_use_id'), ''):
                    c = b.get('content'); t = c if isinstance(c, str) else ''.join(x.get('text', '') for x in (c or []) if isinstance(x, dict)); cum += len(t) / 4
    extra_tok = (k - 1) * s_sum
    out.setdefault((r.get('condition') or 'baseline', r['arm'], r['model'].replace('claude-', '')), []).append(dict(wall=r['wall_s'], tok=r['tokens']['total'], n=n, add=add, extra_tok=extra_tok))
print('\ncond,arm,model,wall_med,nav,post+pdf,api,add_low,add_central,add_high,wall_central,pct_low,pct_central,pct_high,tok_med,browser_tok_reread_med,extra_tok_med_if_real_pages,pct_tok')
med = st.median
for key in sorted(out):
    v = out[key]
    print(','.join(map(str, [*key, round(med([x['wall'] for x in v]), 1), med([x['n']['nav'] for x in v]), med([x['n']['post'] + x['n']['pdf'] for x in v]), med([x['n']['api'] for x in v]),
        *[round(med([x['add'][s] for x in v]), 1) for s in ('low', 'central', 'high')], round(med([x['wall'] + x['add']['central'] for x in v]), 1),
        *[round(med([100 * x['add'][s] / x['wall'] for x in v])) for s in ('low', 'central', 'high')],
        round(med([x['tok'] for x in v])), round(med([x['extra_tok'] / (k - 1) for x in v])), round(med([x['extra_tok'] for x in v])), round(med([100 * x['extra_tok'] / x['tok'] for x in v]))])))
