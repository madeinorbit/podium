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
EXIT_SOURCE = GRAPH + 'session-exit-source.ts'
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
    ('deleted-artifact', READER, 'direct && !(direct as IssueViewModel).deletedAt', 'direct', 'drops deleted issue artifacts', FILE),
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
    ('pinned-brief-fixture', WEB + 'ChatView.tsx', 'brief={chat.scroll.pinnedBrief}', 'brief={null}', 'mounts the pinned-brief shelf', WEB + 'ChatView.test.tsx'),
    ('session-exit-batch', EXIT_SOURCE, 'demanded.add(id)', "owner.replica.exitKind?.('session', id); demanded.add(id)", 'shares addressed session exits', FILE),
    ('session-exit-kind', EXIT_SOURCE, "owner.replica.exitKind?.('session', id)", "owner.replica.exitKind?.('sessions', id)", 'shares addressed session exits', FILE),
    ('session-exit-address', EXIT_SOURCE, "row.kind === 'sessions'", "row.kind === 'issueProjections'", 'shares addressed session exits', FILE),
    ('session-exit-rescope', EXIT_SOURCE, 'for (const id of demanded) dirty.add(id)', 'for (const id of demanded) dirty.delete(id)', 'shares addressed session exits', FILE),
    ('session-exit-disposal', EXIT_SOURCE, 'stop(); demanded.clear()', 'demanded.clear()', 'clears rescope inputs', FILE),
    ('session-exit-hook', HOOKS, '? usePoolSessionExitKind : useLegacySessionExitKind', '? useLegacySessionExitKind : useLegacySessionExitKind', INPUTS, FILE),
    ('stable-selector-attribution', 'apps/web/test/chat-context.browser.tsx', "const omitArtifactStrip = new URLSearchParams(location.search).get('omitArtifactStrip') === '1'", 'const omitArtifactStrip = false', '@browser', 'apps/web/test/chat-context-proof.ts'),
]

def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, **kwargs)

baseline = run(['git', 'rev-parse', 'HEAD'], capture_output=True).stdout.strip()
if run(['git', 'status', '--porcelain'], capture_output=True).stdout:
    raise SystemExit('Controls require a clean committed candidate')
env = dict(os.environ, PATH=str(ROOT / '.toolchain') + ':' + os.environ['PATH'])
env['LD_LIBRARY_PATH'] = str(ROOT / '.toolchain/lib') + (':' + os.environ['LD_LIBRARY_PATH'] if os.environ.get('LD_LIBRARY_PATH') else '')
output = ROOT / '.artifacts/chat-context/controls'
output.mkdir(parents=True, exist_ok=True)
results = []
start = next((arg.split('=', 1)[1] for arg in sys.argv[1:] if arg.startswith('--from=')), None)
only = next((arg.split('=', 1)[1].split(',') for arg in sys.argv[1:] if arg.startswith('--only=')), None)
selected = controls
if only:
    if any(name not in [control[0] for control in controls] for name in only):
        raise SystemExit('Unknown selected control')
    selected = [control for control in controls if control[0] in only]
if start:
    at = next(index for index, control in enumerate(controls) if control[0] == start)
    previous = json.loads((output.parent / 'controls.json').read_text())
    for name, file, *_ in controls[:at]:
        old_blob = run(['git', 'rev-parse', previous['candidate'] + ':' + file], capture_output=True).stdout
        new_blob = run(['git', 'rev-parse', baseline + ':' + file], capture_output=True).stdout
        if old_blob != new_blob:
            raise SystemExit('Earlier production control source changed: ' + name)
        result = next(item for item in previous['controls'] if item['control'] == name)
        if not result['red']:
            raise SystemExit('Earlier control is not red: ' + name)
        results.append({**result, 'candidate': result.get('candidate', previous['candidate'])})
    selected = controls[at:]
try:
    for name, file, old, new, test, test_file in selected:
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
        command = ['timeout', '180', 'bun', test_file] if test == '@browser' else ['timeout', '120', 'bun', 'run', 'test:file', '--', test_file, '-t', test]
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
        text = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout + result.stderr)
        (output / (name + '.log')).write_text(text)
        red = result.returncode == 1 and ('Stable selector attribution failed' in text if test == '@browser' else 'Failed Tests' in text and 'Failed Suites' not in text)
        results.append({'control': name, 'exit': result.returncode, 'red': red, 'candidate': baseline})
        print(json.dumps(results[-1]), flush=True)
        if not red:
            raise RuntimeError('Control did not fail its named assertion: ' + name)
finally:
    run(['git', 'switch', '-q', '--detach', baseline])
    report = 'controls-extra.json' if only else 'controls.json'
    (output.parent / report).write_text(json.dumps({'candidate': baseline, 'controls': results}, indent=2))
if len(results) != (len(selected) if only else len(controls)):
    sys.exit(1)
