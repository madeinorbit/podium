"""Committed production plants in the private flatblock checkout only.

Each runs one named check through test:file, requires a failed test rather
than a collection error, and restores the baseline before the next plant.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path.cwd()
if ROOT != Path.home() / 'podium-test-5173':
    raise SystemExit('Controls require the private issue-5173 flatblock checkout')
WEB = 'apps/web/src/features/chat/'
GRAPH = 'packages/client-graph/src/'
HOOKS = WEB + 'use-chat-context.ts'
READER = GRAPH + 'chat-context.ts'
SOURCE = GRAPH + 'chat-context-source.ts'
FILE = WEB + 'chat-context.pool.test.tsx'
PARITY = 'preserves mention ties'
INPUTS = 'has identical rendered inputs'
ATTACH = 'keeps hooks stable through null-pool attachment'
controls = [
    ('default-off', WEB + 'chat-context-data-layer.ts', 'return chat.layer()', "return 'pool'", 'defaults OFF', WEB + 'chat-context-data-layer.test.ts'),
    ('startup-latch', WEB + 'chat-context-data-layer.ts', 'return chat.layer()', "return location.search.includes('mobxChatContext=0') ? 'legacy' : chat.layer()", 'defaults OFF', WEB + 'chat-context-data-layer.test.ts'),
    ('no-sync-cold-read', SOURCE, 'this.demanded.add(key)', "this.owner.replica.rows('issueProjections'); this.demanded.add(key)", 'declares and batches demand', FILE),
    ('draft', SOURCE, "text: state.drafts?.[key.slice(10)] ?? ''", "text: ''", PARITY, FILE),
    ('window', SOURCE, 'attachedSessionId: state.attachedSessionId ?? null', 'attachedSessionId: null', PARITY, FILE),
    ('outbox', SOURCE, 'sends: outboxChatSends(', 'ignored: outboxChatSends(', PARITY, FILE),
    ('question-order', READER, "rows.find(row => row.kind === 'question')", "rows.toReversed().find(row => row.kind === 'question')", PARITY, FILE),
    ('pending-blocked', READER, 'blocked: rows.length > 0', 'blocked: false', PARITY, FILE),
    ('record-order', READER, 'records.push(row)', 'records.unshift(row)', PARITY, FILE),
    ('mention-order', READER, 'issues.push(row)', 'issues.unshift(row)', PARITY, FILE),
    ('cold-summary', READER, "pool.row('session', id, 'summary')", "pool.row('session', id)", 'reports missing cold summaries', FILE),
    ('resume-dedupe', READER, 'sessions: dedupeSessionsByResume(sessions)', 'sessions', 'collapses parked resume twins', FILE),
    ('addressed-updates', SOURCE, 'const present = !!owner.replica.row!(kind, address.id)', 'const present = true', 'updates addressed records', FILE),
    ('rescope', SOURCE, 'this.dirtyOrders.add(entity)', 'this.dirtyOrders.delete(entity)', 'clears rescope inputs', FILE),
    ('disposal', SOURCE, 'for (const stop of this.stops) stop()', 'for (const stop of this.stops.slice(1)) stop()', 'clears rescope inputs', FILE),
    ('artifact-owner', READER, "pool.row('issue', session.issueId)", "pool.row('issue', 'cold-issue')", 'renders the real composer', FILE),
    ('reference-machine', READER, "headerIds(pool, 'machine').flatMap", "headerIds(pool, 'machine').filter(() => false).flatMap", PARITY, FILE),
    ('reference-repo', READER, "headerIds(pool, 'repository').flatMap", "headerIds(pool, 'repository').filter(() => false).flatMap", PARITY, FILE),
    ('thread-catalog', READER, 'for (const id of catalog.ids)', 'for (const id of catalog.ids.slice(1))', PARITY, FILE),
    ('issue-seq', READER, 'return { ...row, prefix:', 'return { ...row, seq: -1, prefix:', PARITY, FILE),
    ('pane-switch-session', HOOKS, "? usePoolChatSession : usePaneSession", '? usePaneSession : usePaneSession', INPUTS, FILE),
    ('pane-switch-machines', HOOKS, '? usePoolChatMachines : usePaneMachines', '? usePaneMachines : usePaneMachines', INPUTS, FILE),
    ('conversation-ports', HOOKS, '? usePoolPorts : useLegacyPorts', '? useLegacyPorts : useLegacyPorts', INPUTS, FILE),
    ('late-hook-selection', HOOKS, "const useRead = chatContextDataLayer() === 'pool' ? usePoolPorts : useLegacyPorts", "const attached = useWorklistPool(); const useRead = attached ? usePoolPorts : useLegacyPorts", ATTACH, FILE),
    ('controller-readiness', HOOKS, 'ready: initial.current?.id === id, draft:', 'ready: data.ready, draft:', ATTACH, FILE),
    ('comparison-red', WEB + 'chat-context-check.ts', 'const fields = { value: before }', 'const fields = { value: after }', 'detects a planted wrong value', FILE),
]

def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, **kwargs)

baseline = run(['git', 'rev-parse', 'HEAD'], capture_output=True).stdout.strip()
if run(['git', 'status', '--porcelain'], capture_output=True).stdout:
    raise SystemExit('Controls require a clean committed candidate')
env = dict(os.environ, PATH=str(ROOT / '.toolchain') + ':' + os.environ['PATH'])
output = ROOT / '.artifacts/chat-context/controls'
output.mkdir(parents=True, exist_ok=True)
results = []
try:
    for name, file, old, new, test, test_file in controls:
        if os.getloadavg()[0] > 8:
            raise RuntimeError('flatblock load exceeds the agreed ceiling')
        run(['git', 'switch', '-q', '--detach', baseline])
        path = ROOT / file
        source = path.read_text()
        if source.count(old) != 1:
            raise RuntimeError('Plant anchor is not unique: ' + name)
        path.write_text(source.replace(old, new))
        run(['git', 'add', file])
        run(['git', '-c', 'user.name=Podium Control', '-c', 'user.email=control@podium.invalid', 'commit', '-q', '-m', 'Red control ' + name])
        result = subprocess.run(['timeout', '120', 'bun', 'run', 'test:file', '--', test_file, '-t', test], cwd=ROOT, env=env, capture_output=True, text=True)
        text = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout + result.stderr)
        (output / (name + '.log')).write_text(text)
        red = result.returncode == 1 and 'Failed Tests' in text and 'Failed Suites' not in text
        results.append({'control': name, 'exit': result.returncode, 'red': red})
        print(json.dumps(results[-1]), flush=True)
        if not red:
            raise RuntimeError('Control did not fail its named assertion: ' + name)
finally:
    run(['git', 'switch', '-q', '--detach', baseline])
    (output.parent / 'controls.json').write_text(json.dumps({'candidate': baseline, 'controls': results}, indent=2))
if len(results) != len(controls):
    sys.exit(1)
