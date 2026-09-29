#!/usr/bin/env python3
# timeline.py RUN-or-EVIDENCE-DIR FROM_LABEL [TO_LABEL] [--full]: one merged timeline (ms after FROM) of marks, hooks,
# transcript records (in FILE ORDER, time first seen), model requests and statusline calls.
import json, sys, os
run, frm = sys.argv[1], sys.argv[2]
to = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else None
full = '--full' in sys.argv
R = run if os.path.isdir(run) else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runs', run)
marks = [l.split() for l in open(f'{R}/marks.txt') if l.strip()]
m = {k: int(v) for k, v in marks}
t0 = m[frm]; t1 = m[to] if to else 1 << 62
ev = []
for k, v in marks: ev.append((int(v), 'MARK', k))
def short(s, n=110):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    s = s.replace('\n', '\\n'); return s if full or len(s) <= n else s[:n] + '…'
def jl(p):
    if not os.path.exists(p): return []
    out = []
    for l in open(p):
        try: out.append(json.loads(l))
        except Exception: pass
    return out
for h in jl(f'{R}/hooks.jsonl'):
    p = h['payload']; ev_ = h['ev']
    extra = {k: p[k] for k in ('prompt_id', 'source', 'reason', 'tool_name', 'trigger', 'stop_hook_active', 'message', 'notification_type', 'task_id', 'error') if k in p}
    if 'prompt' in p: extra['prompt'] = short(p['prompt'], 60)
    keys = sorted(set(p) - {'session_id', 'transcript_path', 'cwd', 'permission_mode', 'hook_event_name', 'tool_input', 'tool_response'})
    ev.append((h['at'], 'HOOK', f"{ev_} {json.dumps(extra, ensure_ascii=False)} keys={','.join(keys)}"))
for w in jl(f'{R}/transcript-watch.jsonl'):
    if 'rec' not in w: continue
    r = w['rec']; t = r.get('type')
    if w['file'].endswith('history.jsonl'):
        ev.append((w['at'], 'HIST', f"history.jsonl ts={r.get('timestamp')} sid={str(r.get('sessionId'))[:8]} {short(r.get('display'), 80)} pasted={short(r.get('pastedContents'), 60)}")); continue
    if t in ('file-history-snapshot', 'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'custom-title', 'ai-title', 'agent-name', 'summary'): 
        if not full: continue
    sub = r.get('subtype') or r.get('operation') or (r.get('attachment') or {}).get('type') or ''
    if t == 'attachment' and sub in ('environment','model','agent_listing_delta','skill_listing','auto_mode','total_tokens_reminder','session_context','date','remote_session_change','prompt_snapshot','deferred_tools_delta','mcp_instructions_delta') and not full: continue
    msg = r.get('message') or {}
    c = msg.get('content') if msg else (r.get('content') or (r.get('attachment') or {}).get('prompt') or (r.get('attachment') or {}).get('content'))
    ids = {k: r[k] for k in ('promptId', 'uuid', 'parentUuid', 'promptSource', 'isMeta', 'isCompactSummary', 'isApiErrorMessage', 'timestamp', 'sourceToolUseID', 'origin') if k in r}
    a = r.get('attachment') or {}
    for k in ('source_uuid', 'uuid', 'commandMode', 'origin', 'isMeta'):
        if k in a: ids['att.' + k] = a[k]
    ours = lambda v: ('OURS-' + v[-2:]) if isinstance(v, str) and v.startswith(('a00000', 'b00000', 'c00000')) else (v[:8] if isinstance(v, str) else v)
    if 'uuid' in ids: ids['uuid'] = ours(ids['uuid'])
    if 'att.source_uuid' in ids: ids['att.source_uuid'] = ours(ids['att.source_uuid'])
    if 'parentUuid' in ids and ids['parentUuid']: ids['parentUuid'] = ids['parentUuid'][:8]
    if 'promptId' in ids: ids['promptId'] = ids['promptId'][:8]
    ev.append((w['at'], 'REC', f"{t}/{sub} {json.dumps(ids)} {short(c, 90)}"))
for q in jl(f'{R}/model-requests.jsonl'):
    if 'reply' in q: ev.append((q['at'], 'MODEL', f"#{q['idx']} replied {q['reply']}")); continue
    if q.get('path', '').endswith('/messages'):
        msgs = [x for x in (q.get('messages') or []) if x.get('role') != 'system']
        lastu = msgs[-1] if msgs else {}
        ev.append((q['at'], 'MODEL', f"#{q['idx']} tools={q['hasTools']} n={q['nMsgs']} last={lastu.get('role')}: {short(q['lastText'][-160:], 160)}"))
if os.path.exists(f'{R}/sdk.log'):
    for l in open(f'{R}/sdk.log'):
        parts = l.rstrip('\n').split('\t', 2)
        if len(parts) < 3: continue
        at, d, line = int(parts[0]), parts[1], parts[2]
        if d == 'SE':
            if line.split(' ')[0] in ('message_start', 'message_stop') or (full and True): ev.append((at, 'SE', line))
            continue
        if d in ('IN', 'OUT'):
            try: m = json.loads(line.rstrip('…'))
            except Exception: ev.append((at, d, short(line, 160))); continue
            t = m.get('type'); sub = m.get('subtype') or m.get('state') or (m.get('request') or {}).get('subtype') or (m.get('response') or {}).get('subtype') or ''
            keep = {k: m[k] for k in ('uuid', 'command_uuid', 'isReplay', 'priority', 'timestamp', 'is_error', 'result', 'num_turns', 'request_id', 'status') if k in m}
            for k in ('uuid', 'command_uuid'):
                if k in keep and keep[k]: keep[k] = ('OURS-' + keep[k][-2:]) if keep[k].startswith(('a00000', 'b00000', 'c00000')) else keep[k][:8]
            c = (m.get('message') or {}).get('content')
            if t == 'system' and sub == 'init': c = None
            ev.append((at, d, f"{t}/{sub} {json.dumps(keep)} {short(c, 100) if c else ''}"))
        else: ev.append((at, d, short(line, 200)))
for s in jl(f'{R}/statusline.jsonl'):
    ev.append((s['at'], 'STATUS', short(s['payload'], 60)))
for at, kind, text in sorted(ev, key=lambda e: e[0]):
    if t0 - 500 <= at <= t1 + 30000 or (to and t0 <= at <= t1):
        if to and at > t1: continue
        print(f"{at - t0:+7d} {kind:6} {text}")
