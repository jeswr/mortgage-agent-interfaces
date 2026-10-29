#!/usr/bin/env python3
"""Realistic condition: wall time if each simulated human step took real time instead of answering instantly.
Floor: 16.6 s per code/consent/approval (median SMS second-factor time, Reese et al., SOUPS 2019, Table 2; consent and
approval assumed equal - unverified), 60 s per ask_user answer (arbitrary). Away case: 120 s per step (arbitrary).
Usage: human_latency.py <results dir>"""
import json, os, sys, statistics as st
R = sys.argv[1]
runs = [json.loads(l) for l in open(os.path.join(R, 'runs.jsonl')) if '"realistic"' in l]
g = {}
for r in runs: g.setdefault(r['arm'], []).append(r)
print('arm,wall_med,codes+consents+approvals_med,ask_med,wall_floor_med,wall_away_med,human_share_floor')
for a, v in g.items():
    def w(r, t, ask):
        h = r['human_interactions']; n = h['request_code'] + h['request_consent'] + h['approve_grant']
        return r['wall_s'] + n * t + h['ask_user'] * ask
    print(','.join(map(str, [a, round(st.median(r['wall_s'] for r in v), 1), st.median(r['human_interactions']['request_code'] + r['human_interactions']['request_consent'] + r['human_interactions']['approve_grant'] for r in v),
        st.median(r['human_interactions']['ask_user'] for r in v), round(st.median(w(r, 16.6, 60) for r in v), 1), round(st.median(w(r, 120, 120) for r in v), 1),
        round(st.median((w(r, 16.6, 60) - r['wall_s']) / w(r, 16.6, 60) for r in v), 2)])))
