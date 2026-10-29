#!/usr/bin/env python3
"""Per-run: list-price cost from proxy usage (Anthropic pricing page, read 29 Oct 2026), CLI cost, model latency share of
wall time, run concurrency, server-request counts by kind (for the network-latency model), tool-result sizes.
Usage: cost_latency.py <results dir>"""
import json, gzip, os, sys, statistics as st
from datetime import datetime
R = sys.argv[1]
PRICE = {  # USD per MTok: input, 5m write, 1h write, cache read, output
  'claude-sonnet-5-5': (2.0, 2.5, 4.0, 0.10, 10.0), 'claude-opus-5-5': (4.0, 5.0, 8.0, 0.20, 20.0)}
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
spans = [(P(r['started']), P(r['started']) + r['wall_s']) for r in runs]
rows = []
for i, r in enumerate(runs):
    d = os.path.join(R, 'raw', r['seed']); pr = PRICE[r['model']]
    stream = jl(os.path.join(d, 'stream.jsonl'))
    ids = {e['message']['id'] for e in stream if e.get('type') == 'assistant'}
    px = [x for x in jl(os.path.join(d, 'proxy.jsonl')) if x.get('method') == 'POST' and str(x.get('path', '')).startswith('/v1/messages') and x.get('usage')]
    def cost(xs):
        c = 0; w5 = w1 = 0
        for x in xs:
            u = x['usage']; cc = u.get('cache_creation') or {}
            e5 = cc.get('ephemeral_5m_input_tokens', 0) or 0; e1 = cc.get('ephemeral_1h_input_tokens', 0) or 0
            rest = (u.get('cache_creation_input_tokens', 0) or 0) - e5 - e1; e5 += max(0, rest)
            w5 += e5; w1 += e1
            c += ((u.get('input_tokens', 0) or 0) * pr[0] + e5 * pr[1] + e1 * pr[2] + (u.get('cache_read_input_tokens', 0) or 0) * pr[3] + (u.get('output_tokens', 0) or 0) * pr[4]) / 1e6
        return c, w5, w1
    c_agent, w5, w1 = cost([x for x in px if x.get('id') in ids]); c_all, _, _ = cost(px)
    thinking = sum(((x['usage'].get('output_tokens_details') or {}).get('thinking_tokens', 0) or 0) for x in px)
    model_s = sum(x['ms'] for x in px) / 1000  # sequential in these runs except C2 (sequential too)
    t0, t1 = spans[i]; conc = [sum(1 for (a, b) in spans if a < t and b > t) for t in [t0 + k * (t1 - t0) / 10 for k in range(11)]]
    srv = jl(os.path.join(d, 'server-requests.jsonl'))
    kinds = {}
    for q in srv:
        if q['iface'] in ('crawl', 'asset'): continue
        if q['iface'] in ('web', 'web-rates'):
            k = 'web_post' if q['method'] == 'POST' else ('web_pdf' if q['path'].endswith('.pdf') or q['path'].endswith('/pdf') else ('web_redirect_follow' if False else 'web_get'))
        else: k = q['iface']
        kinds[k] = kinds.get(k, 0) + 1
    # tool-result sizes (chars) for browser tools vs other tools
    names = {}
    for e in stream:
        if e.get('type') == 'assistant':
            for b in e['message'].get('content', []):
                if b.get('type') == 'tool_use': names[b['id']] = b['name']
    tr = {}
    for e in stream:
        if e.get('type') == 'user' and isinstance(e['message'].get('content'), list):
            for b in e['message']['content']:
                if b.get('type') == 'tool_result':
                    c = b.get('content'); t = c if isinstance(c, str) else ''.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
                    n = names.get(b.get('tool_use_id'), '?'); grp = 'browser' if 'browser' in n else 'other'
                    tr.setdefault(grp, []).append(len(t))
    rows.append(dict(arm=r['arm'], model=r['model'], cond=r.get('condition') or 'baseline', wall=r['wall_s'], cli_cost=r['cli_cost_usd'], list_cost_agent=c_agent, list_cost_all=c_all,
        w5=w5, w1=w1, thinking=thinking, model_s=model_s, model_share=model_s / r['wall_s'], conc_med=st.median(conc), conc_max=max(conc), kinds=kinds,
        browser_result_chars_med=st.median(tr['browser']) if tr.get('browser') else None, browser_result_chars_sum=sum(tr.get('browser', [])), n_browser_results=len(tr.get('browser', [])),
        tool_calls=r['tool_calls'], tool_calls_by_name=r.get('tool_calls_by_name'), human=r.get('human_interactions'), mreq=r['model_requests'], first_ctx=None))
json.dump(rows, open(os.path.join(os.path.dirname(__file__), 'cost_rows.json'), 'w'), indent=1)
def med(xs): xs = [x for x in xs if x is not None]; return st.median(xs) if xs else float('nan')
g = {}
for x in rows: g.setdefault((x['cond'], x['arm'], x['model'].replace('claude-', '')), []).append(x)
print('cond,arm,model,n,cli_cost_med,list_cost_agent_med,list_cost_all_med,ratio_cli_to_list,w1h_share,thinking_tok_sum,model_s_med,model_share_med,wall_med,conc_med,web_get,web_post,web_pdf,bespoke,agent,agent_ld,browser_result_chars_med,browser_calls_med')
for k in sorted(g):
    v = g[k]; kk = lambda key: med([x['kinds'].get(key, 0) for x in v])
    print(','.join(map(str, [*k, len(v), round(med([x['cli_cost'] for x in v]), 3), round(med([x['list_cost_agent'] for x in v]), 3), round(med([x['list_cost_all'] for x in v]), 3),
        round(med([x['cli_cost'] / x['list_cost_all'] for x in v if x['list_cost_all']]), 3), round(med([x['w1'] / max(1, x['w1'] + x['w5']) for x in v]), 3), sum(x['thinking'] for x in v),
        round(med([x['model_s'] for x in v]), 1), round(med([x['model_share'] for x in v]), 3), round(med([x['wall'] for x in v]), 1), med([x['conc_med'] for x in v]),
        kk('web_get'), kk('web_post'), kk('web_pdf'), kk('bespoke'), kk('agent'), kk('agent-ld'), med([x['browser_result_chars_med'] for x in v]), med([x['n_browser_results'] for x in v])])))
# concurrency vs per-request model latency (Sonnet, model-orchestrated arms)
import itertools
pairs = [(x['conc_med'], x['model_s'] / max(1, x['mreq'])) for x in rows if x['model'] == 'claude-sonnet-5-5' and x['arm'] not in ('C2', 'B-full-code')]
by = {}
for c, l in pairs: by.setdefault(int(c), []).append(l)
print('\nconcurrency(median runs in flight) -> median seconds per agent model request (Sonnet, model-run arms)')
for c in sorted(by): print(c, len(by[c]), round(st.median(by[c]), 2))
