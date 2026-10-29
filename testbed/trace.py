#!/usr/bin/env python3
"""Print a compact transcript of a run: tool calls, results and text. Usage: trace.py <runDir> [maxchars]"""
import json, sys, gzip, os
d = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 160
f = os.path.join(d, 'stream.jsonl'); op = open
if not os.path.exists(f): f += '.gz'; op = gzip.open
for l in op(f, 'rt'):
    e = json.loads(l)
    if e['type'] == 'assistant':
        for b in e['message']['content']:
            if b['type'] == 'tool_use': print('USE', b['name'].replace('mcp__', ''), json.dumps(b['input'])[:n])
            elif b['type'] == 'text': print('TXT', b['text'][:n].replace('\n', ' '))
    elif e['type'] == 'user' and isinstance(e['message']['content'], list):
        for b in e['message']['content']:
            if b.get('type') == 'tool_result':
                c = b['content']; t = c if isinstance(c, str) else ' '.join(x.get('text', '[img]') for x in c if isinstance(x, dict))
                print('   RES', t[:n].replace('\n', ' | '))
    elif e['type'] == 'result': print('RESULT', e.get('subtype'), e.get('num_turns'), (e.get('result') or '')[:n])
