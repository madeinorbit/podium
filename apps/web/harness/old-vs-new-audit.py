"""End-of-capture evidence audit; no browser, server, or product mutations."""
import argparse
import collections
import hashlib
import json
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument('--new-sha', required=True)
parser.add_argument('--deleted-sha', required=True)
parser.add_argument('--home', type=pathlib.Path, default=pathlib.Path.home())
args = parser.parse_args()
checkouts = {arm: args.home / f'podium-test-5501-{arm}' for arm in ['old', 'new']}
expected_sha = {'old': '5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb', 'new': args.new_sha, 'new-deleted': args.deleted_sha}
web = set('sidebar-select sidebar-collapse sidebar-expand sidebar-group-collapse sidebar-group-expand session-switch superagent-composer-typing flight-deck-collapse flight-deck-expand sidebar-drag-start sidebar-drag-drop mark-read mission-switch large-mission-switch command-palette issue-picker-search board-open dock-open dock-close issue-rename header-menu issue-page-open board-search'.split())
phone = set('phone-issue-screen phone-work-screen phone-mission-open phone-long-press phone-mission-details phone-composer-typing phone-issue-open phone-issue-picker-search phone-issue-rename phone-work-search'.split())
errors = []
counts = collections.Counter()
failures = collections.Counter()
heaps = collections.Counter()
captures = []
evidence_count = 0
for checkout_arm, checkout in checkouts.items():
    root = checkout / '.artifacts/old-vs-new'
    for file in sorted(root.glob('*/run.json')):
        run = json.loads(file.read_text())
        if run.get('purpose') != 'measurement' or run.get('controlOnly'):
            continue
        name = file.parent.name
        def require(condition, message):
            if not condition:
                errors.append(f'{name}: {message}')
        require(run['host'] == 'flatblock', 'wrong host')
        require(run['sha'] == expected_sha[run['arm']], 'wrong source SHA')
        require(run['durationTimeDomain'] == 'threadTicks', 'CPU wall clock substituted')
        corpus = (root / f'corpus-{run["scale"]}x.json').read_bytes()
        require(hashlib.sha256(corpus).hexdigest() == run['semanticSha256'], 'semantic corpus digest mismatch')
        require(run['corpus']['syntheticIssues'] == 4867 * run['scale'], 'issue count mismatch')
        require(run['corpus']['syntheticSessions'] == 4304 * run['scale'], 'session count mismatch')
        require(run['preflightRows'] > run['corpus']['syntheticIssues'], 'production decoder did not validate full stream')
        lease = run.get('lease', {})
        require(lease.get('host') == 'ludovico', 'lease not acquired from ludovico')
        require(lease.get('name') == ('bench:flatblock' if run['mode'] == 'timing' else 'meter:flatblock'), 'wrong capture lease')
        require(lease.get('grant', {}).get('data', {}).get('granted') is True, 'lease was not granted')
        require('captureStartedAt' in run and 'endedAt' in run, 'capture clock boundaries missing')
        require(len(run.get('captureLoadStart', [])) == 3 and len(run.get('loadEnd', [])) == 3, 'host load missing')
        captures.append(run)
        pair = run.get('comparisonArm', 'new')
        key = (pair, run['surface'], run['scale'])
        if run['status'] == 'failed':
            require(run['arm'] == 'old' and run['surface'] == 'phone' and '185' in run.get('failure', ''), 'unexpected whole-run failure')
            failures[(run['mode'], *key)] += 1
            continue
        require(run['status'] == 'complete', 'unfinished capture')
        require(not any('185' in error for error in run['errors']), 'hidden React startup failure')
        if run['mode'] == 'memory':
            require(run['heapStartup']['usedSize'] > 0 and run['heapFiveMinutes']['usedSize'] > 0, 'heap observation missing')
            require(run['heapUse']['durationSeconds'] >= 300, 'five-minute observation too early')
            require(run['heapUse']['actions'] == len(run['heapUse']['stepsCompleted']), 'workload count mismatch')
            heaps[(*key, run['arm'])] += 1
            continue
        expected_actions = (web if run['surface'] == 'web' else phone) | {'app-cold-start', 'app-warm-start'}
        # This attempt used a collector witness that incorrectly expected the
        # mission root among child rows. Its other observations remain valid;
        # corrected round 11 supplies the large-mission cell with eight samples.
        known_witness_error = (name == 'timing-old-web-1x-r10'
            and run['harnessSha256'] == '4b4ad7b2ad639fd523b566b83e1dea56978255a9f1fac5c0f17a6ca75b60d18f')
        if known_witness_error:
            expected_actions = expected_actions - {'large-mission-switch'}
            require(any(gap['action'] == 'large-mission-switch' and '20000ms' in gap['reason']
                for gap in run['unavailable']), 'documented collector failure missing')
        actual_actions = {row['action'] for row in run['actions']}
        require(actual_actions == expected_actions, f'action coverage mismatch: {sorted(expected_actions ^ actual_actions)}')
        attribution = json.loads((file.parent / 'cpu-attribution.json').read_text())
        require(len(attribution['summaries']) == sum(row['profiled'] for row in run['actions']), 'profile attribution count mismatch')
        for row in run['actions']:
            require(row['inputToPaintMs'] > 0 and 0 <= row['selectedDomMs'] <= row['inputToPaintMs'], f'{row["action"]}: paint precedes input/DOM')
            if row.get('mainThreadCpuMs') is not None:
                require(0 <= row['mainThreadCpuMs'] <= row['inputToPaintMs'] + 2, f'{row["action"]}: CPU exceeds elapsed time')
            for field in ['trace', 'cpu']:
                if row.get(field):
                    require((file.parent / row[field]).is_file(), f'{row["action"]}: raw {field} missing')
                    evidence_count += 1
            if not row['profiled']:
                counts[(*key, run['arm'], row['action'])] += 1
        require(len(run['background']) == 38, 'quiet/update window count mismatch')
        require(run.get('outputDeliveryWitness') is True, 'visible terminal delivery not verified')
        require(run['idle']['seconds'] >= 60, 'connected-idle window too short')
        require(run['idle']['delivered'] == {'heartbeat': 30, 'issueChange': 10, 'sessionOutput': 120}, 'live replay count mismatch')
        require(run['idleProfiles']['observed']['seconds'] >= 60, 'historical-rate idle window too short')
        require(run['idleProfiles']['observed']['delivered'] == {'heartbeat':12,'issueChange':6,'machine':16,'conversation':28,'hostMetrics':36,'draft':2,'sessionOutput':0}, 'historical-rate replay count mismatch')
        for row in run['background']:
            require(row['taskMs'] >= 0 and (file.parent / row['trace']).is_file(), 'update CPU/evidence missing')
            evidence_count += 1
for pair in ['new', 'new-deleted']:
    for surface in ['web', 'phone']:
        for scale in [1, 4]:
            key = (pair, surface, scale)
            for arm in ['old', pair]:
                if arm == 'old' and surface == 'phone':
                    if failures[('timing', *key)] < 2 or failures[('memory', *key)] < 1:
                        errors.append(f'{key}: OLD boot failure evidence incomplete')
                    continue
                for action in (web if surface == 'web' else phone) | {'app-cold-start', 'app-warm-start'}:
                    expected_n = 8 if action in ['app-cold-start', 'app-warm-start'] else 16
                    if pair == 'new' and surface == 'web' and scale == 1 and arm == 'old' and action == 'large-mission-switch':
                        expected_n = 8
                    if counts[(*key, arm, action)] != expected_n:
                        errors.append(f'{key}/{arm}/{action}: sample count {counts[(*key, arm, action)]}, expected {expected_n}')
                if heaps[(*key, arm)] != 1:
                    errors.append(f'{key}/{arm}: missing five-minute heap pair')
# Alternation is checked within each surface/scale/comparison/mode. Host gaps
# for the deletion priority slot do not become concurrent implementations.
orders = collections.defaultdict(list)
for run in sorted(captures, key=lambda row: row['captureStartedAt']):
    orders[(run['mode'], run.get('comparisonArm', 'new'), run['surface'], run['scale'])].append(run['arm'])
for key, arms in orders.items():
    expected = ['old', key[1]] * (2 if key[0] == 'timing' else 1)
    if arms != expected:
        errors.append(f'{key}: run order {arms}, expected {expected}')
audit = {'ok': not errors, 'captures': len(captures), 'rawTraceAndProfileFiles': evidence_count, 'sampleCells': len(counts), 'errors': errors, 'sourceShas': expected_sha}
print(json.dumps(audit, indent=2))
raise SystemExit(1 if errors else 0)
