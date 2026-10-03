"""Focused output plants on the private flatblock issue checkout.

Each plant has a WIP commit, must fail a collected assertion, and is restored
to the committed candidate. Only synthetic fixtures run; no write owner changes.
"""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

root = Path.cwd()
if socket.gethostname() != 'flatblock' or not re.fullmatch(r'podium-test-\d+', root.name):
    raise SystemExit('Reader plants require the private flatblock issue checkout')

chat = 'apps/web/src/features/chat/'
app = 'apps/web/src/app/'
superagent = 'apps/web/src/features/superagent/'
notice_test = chat + 'MessageNotices.pool.test.tsx'
automation_test = app + 'automation-readers.test.tsx'
launch_test = app + 'command-launch-data.pool.test.tsx'
cases = [
    ('chat-draft', chat + 'use-chat-context.ts', r'return useWorklistPoolProjection\(read, \'\'\)', "return ''", chat + 'chat-context.pool.test.tsx', 'preserves saved chat inputs'),
    ('notices', chat + 'MessageNotices.tsx', r'const notices = usePoolMessageNotices\(\)', 'const notices = []', notice_test, 'preserves saved notice'),
    ('interactions', chat + 'PendingInteractionBar.tsx', r'const cards = usePoolInteractionCards\(sessionId\)', 'const cards = []', notice_test, 'preserves saved notice'),
    ('recovery', 'apps/web/src/features/machines/OutboxRecovery.tsx', r'const deadLetters = usePoolRecovery\(\)', 'const deadLetters = []', notice_test, 'preserves saved notice'),
    ('superagent-thread', superagent + 'use-superagent-inputs.ts', r'superagentThread\(pool, id\)', "superagentThread(pool, 'planted-absent-thread')", superagent + 'SuperagentView.pool.test.tsx', 'preserves saved thread'),
    ('event-feed', superagent + 'useIssueEvents.ts', r'useWorklistPoolProjection\(\s*superagentFeed\s*,', 'useWorklistPoolProjection(() => ({ events: [], loading: false }),', superagent + 'useIssueEvents.test.tsx', 'orders by the durable event id'),
    ('workflow-machines', 'apps/web/src/features/workflows/readers.ts', r'useWorklistPoolProjection\(\s*workflowMachines\s*,', 'useWorklistPoolProjection(() => EMPTY_MACHINES,', 'apps/web/src/features/workflows/readers.test.tsx', 'renders the actual screens'),
    ('preferences', 'apps/web/src/lib/use-persisted-ui-state.ts', r'\?\s*row\.value\s*:\s*null', '? null : null', 'apps/web/src/lib/use-persisted-ui-state.test.tsx', 'adopts a replicated value'),
    ('automations', app + 'automation-readers.ts', r'useWorklistPoolProjection\(\s*poolList\s*,', 'useWorklistPoolProjection(() => ({ ...EMPTY_LIST, pending: 0 }),', automation_test, 'list, launch, run and specs readers'),
    ('specs', app + 'automation-readers.ts', r'useWorklistPoolProjection\(\s*poolRepos\s*,', 'useWorklistPoolProjection(() => ({ repos: [], pending: 0 }),', automation_test, 'list, launch, run and specs readers'),
    ('launcher', app + 'command-launch-data.ts', r'useWorklistPoolProjection\(readLaunch, LOADING\)', 'LOADING', launch_test, 'declares launch and palette demand'),
    ('palette', app + 'command-launch-data.ts', r'useWorklistPoolProjection\(readPalette, LOADING\)', 'LOADING', launch_test, 'declares launch and palette demand'),
]
requested = set(sys.argv[1:])
unknown = requested - {case[0] for case in cases}
if unknown:
    raise SystemExit('Unknown reader controls: ' + ', '.join(sorted(unknown)))
if requested:
    cases = [case for case in cases if case[0] in requested]

def git(*args):
    return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()

baseline = git('rev-parse', 'HEAD')
if git('status', '--porcelain'):
    raise SystemExit('Reader plants require a clean committed candidate')
env = dict(os.environ, PATH=str(root / '.toolchain') + ':' + os.environ['PATH'])
env['LD_LIBRARY_PATH'] = str(root / '.toolchain/lib') + (':' + os.environ['LD_LIBRARY_PATH'] if os.environ.get('LD_LIBRARY_PATH') else '')
out = root / '.artifacts/remaining-reader-controls'
out.mkdir(parents=True, exist_ok=True)
reports = []
try:
    for name, file, pattern, replacement, test, title in cases:
        git('switch', '-q', '--detach', baseline)
        path = root / file
        text = path.read_text()
        if len(re.findall(pattern, text)) != 1:
            raise RuntimeError('Plant anchor is not unique: ' + name)
        path.write_text(re.sub(pattern, lambda _: replacement, text))
        git('add', file)
        git('-c', 'user.name=Podium Control', '-c', 'user.email=control@podium.invalid', 'commit', '-q', '-m', 'WIP reader fault ' + name)
        result = subprocess.run(['bun', 'run', 'test:file', '--', test, '-t', title], cwd=root, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        clean = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout.decode(errors='replace'))
        (out / (name + '.log')).write_text(clean)
        failed = re.search(r'Tests\s+([1-9][0-9]*) failed', clean)
        red = result.returncode == 1 and failed is not None and 'Failed Suites' not in clean
        reports.append({'control': name, 'candidate': baseline, 'exit': result.returncode,
                        'red': red, 'failedTests': int(failed[1]) if failed else 0})
        print(json.dumps(reports[-1]), flush=True)
        if not red:
            raise RuntimeError('Plant did not fail a collected assertion: ' + name)
finally:
    git('switch', '-q', '--detach', baseline)
    summary = 'summary-retry.json' if requested else 'summary.json'
    (out / summary).write_text(json.dumps({'candidate': baseline, 'controls': reports}, indent=2) + '\n')
