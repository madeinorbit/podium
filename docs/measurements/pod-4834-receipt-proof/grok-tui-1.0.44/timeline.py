#!/usr/bin/env python3
"""Merge marks, hooks, model requests and file observations into one timeline around a mark.

usage: timeline.py <logs-dir> <label> [seconds-after=15] [seconds-before=1]
Each line: ms after the mark's Enter, source, and a short digest of the record. File records
appear in FILE ORDER at the time the watcher first saw them (20 ms poll).
"""
import json, os, sys

logs, label = sys.argv[1], sys.argv[2]
after = float(sys.argv[3]) if len(sys.argv) > 3 else 15
before = float(sys.argv[4]) if len(sys.argv) > 4 else 1

def load(name):
    p = os.path.join(logs, name)
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p) if l.strip()]

marks = load('marks.jsonl')
mark = next(m for m in marks if m['label'] == label)
t0 = mark['at']
lo, hi = t0 - before * 1000, t0 + after * 1000
rows = []

def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' | '.join(b.get('text', f"[{b.get('type')}]") if isinstance(b, dict) else str(b) for b in c)
    return ''

def short(s, n=160):
    s = s.replace('\n', '\\n')
    return s if len(s) <= n else s[:n] + '…'

for m in marks:
    if lo <= m['at'] <= hi:
        rows.append((m['at'], 'KEY', f"{m['label']} Enter: {short(m['text'])}"))
for h in load('hooks.jsonl'):
    if lo <= h['at'] <= hi:
        p = h['payload']
        extra = f" prompt={short(p['prompt'], 80)!r}" if 'prompt' in p else ''
        extra += f" reason={p['reason']}" if 'reason' in p else ''
        extra += f" source={p['source']}" if 'source' in p else ''
        extra += f" tool={p.get('toolName')}" if 'toolName' in p else ''
        rows.append((h['at'], 'HOOK', f"{h['ev']} promptId={p.get('promptId')}{extra}"))
for h in load('podium-hook.jsonl'):
    if lo <= h['at'] <= hi:
        p = h['payload'] or {}
        rows.append((h['at'], 'PODIUM-HOOK', f"{p.get('hookEventName')} promptId={p.get('promptId')}"))
for r in load('model-requests.jsonl'):
    if not (lo <= r['at'] <= hi):
        continue
    if 'path' not in r:
        rows.append((r['at'], 'MODEL', f"#{r['idx']} reply done ({r.get('reply')})"))
        continue
    if not r['path'].endswith('/chat/completions'):
        continue
    msgs = [m for m in r['messages'] if m['role'] != 'system']
    tail = []
    for m in msgs[-4:]:
        c = text_of(m.get('content'))
        if m['role'] == 'tool':
            c = f"[tool_result {m.get('tool_call_id')}] {c}"
        if m.get('tool_calls'):
            c += ' ' + ' '.join(f"[tool_call {tc.get('id')}]" for tc in m['tool_calls'])
        tail.append(f"{m['role']}:{short(c, 120)}")
    rows.append((r['at'], 'MODEL', f"#{r['idx']} model={r['model']} tools={r['nTools']} n={len(msgs)} last: " + ' || '.join(tail)))
skip = ('summary.json', 'signals.json', 'usage.json', 'prompt_context.json')
for f in load('files.jsonl'):
    if not (lo <= f['at'] <= hi):
        continue
    name = f['file'].split('/')[-1]
    if name in skip:
        continue
    rec = f.get('rec', f.get('json'))
    if name == 'updates.jsonl' and isinstance(rec, dict):
        u = rec['params']['update']
        meta = rec['params'].get('_meta', {})
        kind = u.get('sessionUpdate')
        bits = [f"{rec['method']} {kind}"]
        for k in ('event_name', 'prompt_id', 'stop_reason'):
            if k in u:
                bits.append(f"{k}={u[k]}")
        if 'content' in u and isinstance(u['content'], dict):
            bits.append(f"text={short(u['content'].get('text', ''), 80)!r}")
        um = u.get('_meta') or {}
        for k in ('promptIndex', 'promptId'):
            if k in um:
                bits.append(f"u._meta.{k}={um[k]}")
        for k in ('eventId', 'promptId', 'agentTimestampMs'):
            if k in meta:
                bits.append(f"_meta.{k}={meta[k]}")
        rows.append((f['at'], 'updates', ' '.join(bits)))
    elif name == 'chat_history.jsonl' and isinstance(rec, dict):
        keys = {k: v for k, v in rec.items() if k != 'content'}
        rows.append((f['at'], 'chat_history', f"{rec.get('type')} {short(text_of(rec.get('content')), 140)!r} {json.dumps(keys)}"))
    else:
        rows.append((f['at'], name.replace('.jsonl', ''), short(json.dumps(rec), 260)))

print(f"# timeline for {label} (Enter at {t0}), ms relative to Enter")
for at, src, txt in sorted(rows, key=lambda r: r[0]):
    print(f"{at - t0:+7d}  {src:<13} {txt}")
