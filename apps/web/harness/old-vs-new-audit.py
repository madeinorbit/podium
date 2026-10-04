"""End-of-capture evidence audit; no browser, server, or product mutations."""
import argparse
import collections
import hashlib
import json
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument('--new-sha', required=True)
parser.add_argument('--deleted-sha', required=True)
parser.add_argument('--current-sha', required=True)
parser.add_argument('--home', type=pathlib.Path, default=pathlib.Path.home())
parser.add_argument('--scope', choices=['original', 'coordinator-finish'], default='original')
parser.add_argument('--scope-record', type=pathlib.Path)
args = parser.parse_args()
finish = args.scope == 'coordinator-finish'
scope_record = json.loads(args.scope_record.read_text())['finishScope'] if finish and args.scope_record else None
if finish and (not scope_record or scope_record.get('coordinatorMessage') != 'msg_0599a35e-780b-476a-8fad-9b3bce58885c'):
    raise RuntimeError('The reduced audit requires the recorded coordinator scope change')
checkouts = {arm: args.home / f'podium-test-5501-{arm}' for arm in ['old', 'new']}
expected_sha = {'old': '5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb', 'new': args.new_sha, 'new-deleted': args.deleted_sha, 'new-current': args.current_sha}
web = set('sidebar-select sidebar-collapse sidebar-expand sidebar-group-collapse sidebar-group-expand session-switch superagent-composer-typing flight-deck-collapse flight-deck-expand sidebar-drag-start sidebar-drag-drop mark-read mission-switch large-mission-switch command-palette issue-picker-search board-open dock-open dock-close issue-rename header-menu issue-page-open board-search'.split())
phone = set('phone-issue-screen phone-work-screen phone-mission-open phone-long-press phone-mission-details phone-composer-typing phone-issue-open phone-issue-picker-search phone-issue-rename phone-work-search'.split())
errors = []
counts = collections.Counter()
failures = collections.Counter()
heaps = collections.Counter()
backgrounds = collections.Counter()
captures = []
evidence_count = 0
unattributed_profiles = []
corpus_hashes = {}
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
        corpus_key = (checkout_arm, run['scale'])
        if corpus_key not in corpus_hashes:
            corpus_hashes[corpus_key] = hashlib.sha256((root / f'corpus-{run["scale"]}x.json').read_bytes()).hexdigest()
        require(corpus_hashes[corpus_key] == run['semanticSha256'], 'semantic corpus digest mismatch')
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
        if run['status'] == 'failed' and not run.get('actionPhaseComplete'):
            require(run['arm'] == 'old' and run['surface'] == 'phone' and '185' in run.get('failure', ''), 'unexpected whole-run failure')
            failures[(run['mode'], *key)] += 1
            continue
        if run['status']!='complete' and run.get('actionPhaseComplete'):
            require(name=='timing-old-web-4x-r10' and run['harnessSha256']=='e0d8a84eb2258bd15f31022a7a78b33e700e119aed4de6faa61a24ef25f9a0c3' and 'Comparison target A' in run.get('failure',''), 'unexpected partial action phase')
        require(run['status'] == 'complete' or run.get('actionPhaseComplete'), 'unfinished capture')
        require(not any('185' in error for error in run['errors']), 'hidden React startup failure')
        if run['mode'] == 'memory':
            require(run['heapStartup']['usedSize'] > 0 and run['heapFiveMinutes']['usedSize'] > 0, 'heap observation missing')
            require(run['heapUse']['durationSeconds'] >= 300, 'five-minute observation too early')
            require(run['heapUse']['actions'] == len(run['heapUse']['stepsCompleted']), 'workload count mismatch')
            heaps[(*key, run['arm'])] += 1
            continue
        arm_actions = web if run['surface'] == 'web' else phone
        if run['surface'] == 'web' and not run.get('backgroundOnly'):
            if any(row['action']=='session-composer-typing' for row in run['actions']):
                arm_actions = arm_actions | {'session-composer-typing'}
            else:
                require(any(gap['action']=='session-composer-typing' and 'mode-chat' in gap['reason']
                    and '10000ms' in gap['reason'] for gap in run['unavailable']), 'session composer fixture gap not documented')
        expected_actions = arm_actions | {'app-cold-start', 'app-warm-start'}
        # This attempt used a collector witness that incorrectly expected the
        # mission root among child rows. Its other observations remain valid;
        # corrected round 11 supplies both large-mission cells with eight samples.
        known_witness_error = (name in {'timing-old-web-1x-r10','timing-new-web-1x-r10'}
            and run['harnessSha256'] == '4b4ad7b2ad639fd523b566b83e1dea56978255a9f1fac5c0f17a6ca75b60d18f')
        if known_witness_error:
            expected_actions = expected_actions - {'large-mission-switch'}
            require(any(gap['action'] == 'large-mission-switch' and '20000ms' in gap['reason']
                for gap in run['unavailable']), 'documented collector failure missing')
        known_4x_preparation = (name == 'timing-old-web-4x-r10'
            and run['harnessSha256'] == 'e0d8a84eb2258bd15f31022a7a78b33e700e119aed4de6faa61a24ef25f9a0c3')
        if known_4x_preparation:
            expected_actions = expected_actions - {'sidebar-select','large-mission-switch'}
            require(any(gap['action']=='sidebar-select' and 'performing click action' in gap['reason'] for gap in run['unavailable']), 'documented preparation timeout missing')
            require(any(gap['action']=='large-mission-switch' and 'i4089' in gap['reason'] for gap in run['unavailable']), 'documented deferred-root attempt missing')
        if run.get('backgroundOnly'):
            expected_actions = set()
        actual_actions = {row['action'] for row in run['actions']}
        require(actual_actions == expected_actions, f'action coverage mismatch: {sorted(expected_actions ^ actual_actions)}')
        attribution_file = file.parent / 'cpu-attribution.json'
        if attribution_file.exists():
            attribution = json.loads(attribution_file.read_text())
            require(len(attribution['summaries']) == sum(row['profiled'] for row in run['actions']), 'profile attribution count mismatch')
        elif finish:
            unattributed_profiles.append(name)
        else:
            require(False, 'sampled source attribution missing')
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
        if run.get('backgroundSuperseded'):
            require(run['surface']=='web' and pair=='new' and ((run['scale']==1 and run['round'] in [10,11]) or (run['scale']==4 and run['round']==10)), 'unexpected background exclusion')
            continue
        require(run.get('issueUpdateEntities') == (['issue','issueProjection'] if run['arm']=='old' else ['issueProjection']), 'logical issue publication incomplete')
        require(run.get('backgroundContext','').startswith('Fresh browser profile'), 'resident pane state not matched')
        backgrounds[(*key,run['arm'])] += 1
        require(len(run['background']) == 38, 'quiet/update window count mismatch')
        require(run.get('outputDeliveryWitness') is True, 'visible terminal delivery not verified')
        require(run['idle']['seconds'] >= 60, 'connected-idle window too short')
        require(run['idle']['delivered'] == {'heartbeat': 30, 'issueChange': 10, 'sessionOutput': 120}, 'live replay count mismatch')
        require(run['idleProfiles']['observed']['seconds'] >= 60, 'historical-rate idle window too short')
        require(run['idleProfiles']['observed']['delivered'] == {'heartbeat':12,'issueChange':6,'machine':16,'conversation':28,'hostMetrics':36,'draft':2,'sessionOutput':0}, 'historical-rate replay count mismatch')
        for row in run['background']:
            require(row['taskMs'] >= 0 and (file.parent / row['trace']).is_file(), 'update CPU/evidence missing')
            evidence_count += 1
for pair in (['new-current'] if finish else ['new', 'new-deleted', 'new-current']):
    for surface in ['web', 'phone']:
        for scale in [1, 4]:
            key = (pair, surface, scale)
            for arm in ['old', pair]:
                if arm == 'old' and surface == 'phone':
                    available_failures = sum(n for (mode, p, s, z), n in failures.items() if mode == 'timing' and s == 'phone' and z == scale)
                    if (available_failures < 1 if finish else failures[('timing', *key)] < 2 or failures[('memory', *key)] < 1):
                        errors.append(f'{key}: OLD boot failure evidence incomplete')
                    continue
                arm_actions = web if surface == 'web' else phone
                if surface == 'web' and counts[(*key, arm, 'session-composer-typing')]:
                    arm_actions = arm_actions | {'session-composer-typing'}
                for action in arm_actions | {'app-cold-start', 'app-warm-start'}:
                    expected_n = 8 if action in ['app-cold-start', 'app-warm-start'] else 16
                    if pair == 'new' and surface == 'web' and scale == 1 and action == 'large-mission-switch':
                        expected_n = 8
                    if pair == 'new' and surface == 'web' and scale == 4 and arm == 'old' and action in ['sidebar-select','large-mission-switch']:
                        expected_n = 8
                    if counts[(*key, arm, action)] != expected_n:
                        errors.append(f'{key}/{arm}/{action}: sample count {counts[(*key, arm, action)]}, expected {expected_n}')
                required_heaps = int(arm == 'new-current' and surface == 'web' and scale == 4) if finish else 1
                if heaps[(*key, arm)] != required_heaps:
                    errors.append(f'{key}/{arm}: missing five-minute heap pair')
                if backgrounds[(*key, arm)] != 2:
                    errors.append(f'{key}/{arm}: corrected background capture count {backgrounds[(*key,arm)]}, expected 2')
# Alternation is checked within each surface/scale/comparison/mode. Host gaps
# for the deletion priority slot do not become concurrent implementations.
orders = collections.defaultdict(list)
for run in sorted(captures, key=lambda row: row['captureStartedAt']):
    lane='background' if run.get('backgroundOnly') else run['mode']
    orders[(lane, run.get('comparisonArm', 'new'), run['surface'], run['scale'])].append(run['arm'])
for key, arms in orders.items():
    repetitions=2 if key[0]=='timing' or (key[0]=='background' and key[3]==1) else 1
    expected = ['old', key[1]] * repetitions
    if finish:
        if key[1] == 'new-current' and key[0] == 'timing' and key[2] == 'phone':
            expected = ['old', 'new-current', 'new-current'] if key[3] == 1 else ['new-current', 'new-current']
        elif key[1] == 'new-current' and key[0] == 'memory':
            expected = ['new-current']
        elif key[1] != 'new-current':
            expected = ['old', key[1]] * (len(arms) // 2)
    if arms != expected:
        errors.append(f'{key}: run order {arms}, expected {expected}')
audit = {'ok': not errors, 'scope': args.scope, 'originalRequestComplete': not finish and not errors,
         'unmeasuredOriginalRequests': scope_record['unmeasured'] if finish else [],
         'runsWithoutSampledAttribution': unattributed_profiles,
         'captures': len(captures), 'rawTraceAndProfileFiles': evidence_count, 'sampleCells': len(counts), 'errors': errors, 'sourceShas': expected_sha}
print(json.dumps(audit, indent=2))
raise SystemExit(1 if errors else 0)
