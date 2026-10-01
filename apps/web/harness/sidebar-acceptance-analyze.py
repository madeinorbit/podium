#!/usr/bin/env python3
"""Reproducible verdicts over raw synthetic browser records; no live data.

--controls copies aside, plants one bad field per check, invokes the same
checker, restores with cp, and preserves the red/green log.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys

PLAN = json.loads((Path(__file__).with_name('sidebar-acceptance-plan.json')).read_text())


def union_ms(intervals):
    end = -math.inf
    result = 0.0
    for start, stop in sorted((i['start'], i['end']) for i in intervals if i['end'] > i['start']):
        result += max(0.0, stop - max(end, start))
        end = max(end, stop)
    return result


def distribution(values, p95=True):
    ordered = sorted(values)
    if not ordered:
        return {'n': 0, 'p50': None, 'p95': None, 'max': None}
    # A sparse collection has no acceptance p95. Never rename a max to p95.
    return {'n': len(values), 'p50': statistics.median(values),
            'p95': ordered[math.ceil(0.95 * len(ordered)) - 1] if p95 and len(ordered) >= PLAN['samples'] else None,
            'max': ordered[-1]}


def measurement(record):
    result = record['result']
    return result.get('measurement', result)


def cpu(record):
    return union_ms([i for i in measurement(record)['intervals'] if i['kind'] != 'sidebar row render'])


def derives(record):
    panel = measurement(record).get('panel') or {}
    return (panel.get('idle') or {}).get('derivations', 0) + ((panel.get('lastUpdate') or {}).get('work') or {}).get('derivations', 0)


def publications(record):
    pubs = measurement(record)['stats']['publishes']
    navigation = [p for p in pubs if 'selectedIssueId' in p['changedKeys']]
    optimism = [p for p in pubs if 'selectedIssueId' not in p['changedKeys'] and any(k in p['changedKeys'] for k in ['issues', 'issueProjections', 'outboxSize', 'outboxDeadLetters'])]
    clock = [p for p in pubs if p['changedKeys'] and set(p['changedKeys']) <= {'coarseNow'}]
    other = [p for p in pubs if p not in navigation and p not in optimism and p not in clock]
    return {'navigation': len(navigation), 'optimistic_or_outbox': len(optimism), 'clock': len(clock), 'other': len(other), 'total': len(pubs)}


def regression(pilot, legacy):
    return 100 * (pilot / legacy - 1) if legacy else None


def control_verdict(value):
    b = PLAN['bars']
    return {
        'idle': value['idle'] == b['idleWork'],
        'unrelated': value['unrelated'] == b['unrelatedSidebarDerivations'],
        'publication': value['publication'] == b['gesturePublications'],
        'warm': value['warm'] <= b['warmSwitchP95Ms'],
        'cpu': value['cpu'] <= b['stateCpuP95Ms'],
        'benefit': value['benefit'] >= b['minimumCpuReductionPercent'],
        'startup': value['startup'] <= b['maximumStartupRegressionPercent'],
        'memory': value['memory'] <= b['maximumRetainedMemoryRegressionPercent'],
        'selection': value['selection'] <= b['sidebarSelectionP95Ms'],
        'parity': value['parity'] == b['sideBySideDifferences'],
        'complete': value['samples'] >= PLAN['samples'],
        'load': value['load'] <= PLAN['maxLoad'],
        'cpu_union': union_ms(value['intervals']) == value['unionExpected'],
        'p95_not_max': distribution(value['percentiles'])['p95'] == value['p95Expected'],
        'sparse_p95': distribution(value['sparse'])['p95'] is None,
    }


def controls(out):
    out.mkdir(parents=True, exist_ok=True)
    target = out / 'planted-control.json'
    aside = out / 'control.aside'
    good = {'idle': 0, 'unrelated': 0, 'publication': 1, 'warm': 99, 'cpu': 7,
            'benefit': 51, 'startup': 9, 'memory': 9, 'selection': 15, 'parity': 0,
            'samples': 40, 'load': 8, 'intervals': [{'start': 0, 'end': 8}, {'start': 2, 'end': 6}],
            'unionExpected': 8, 'percentiles': list(range(40)), 'p95Expected': 37,
            'sparse': [1, 2, 3]}
    bad = {'idle': 1, 'unrelated': 1, 'publication': 2, 'warm': 101, 'cpu': 9,
           'benefit': 49, 'startup': 11, 'memory': 11, 'selection': 17, 'parity': 1,
           'samples': 39, 'load': 8.01, 'unionExpected': 12, 'p95Expected': 39,
           'sparse': list(range(40))}
    target.write_text(json.dumps(good))
    subprocess.run(['cp', str(target), str(aside)], check=True, timeout=10)
    log = []
    for key, wrong in bad.items():
        planted = copy.deepcopy(good)
        planted[key] = wrong
        target.write_text(json.dumps(planted))
        run = subprocess.run([sys.executable, __file__, '--check-control', str(target)], capture_output=True, text=True, timeout=20)
        if run.returncode == 0:
            raise AssertionError(f'Planted {key} was not rejected')
        log.append({'plant': key, 'exit': run.returncode, 'output': run.stdout.strip()})
        subprocess.run(['cp', str(aside), str(target)], check=True, timeout=10)
    clean = subprocess.run([sys.executable, __file__, '--check-control', str(target)], capture_output=True, text=True, timeout=20)
    if clean.returncode:
        raise AssertionError(clean.stdout + clean.stderr)
    log.append({'restored': True, 'exit': clean.returncode, 'output': clean.stdout.strip()})
    (out / 'negative-controls.json').write_text(json.dumps(log, indent=2))
    print(f'{len(bad)} independent raw-record plants RED; cp restoration GREEN')


def analyze(root):
    records = []
    for phase in ['counts', 'timing', 'memory', 'attribution']:
        path = root / phase / 'records.jsonl'
        if path.exists():
            records.extend(dict(json.loads(line), phase=phase) for line in path.read_text().splitlines() if line.strip())
    void = [r for r in records if not r['valid'] or r.get('before', {}).get('loadavg', [0])[0] > PLAN['maxLoad']]
    accepted = [r for r in records if r not in void]
    summary = {'plan': PLAN, 'records': len(records), 'voidRecords': len(void), 'cells': {}, 'bars': {}, 's9': 'PENDING: one operator day on ludovico with panel'}
    cpu_cells = []
    warm_cells = []
    selection_cells = []
    publish_cells = []
    for scale in PLAN['scales']:
        cells = summary['cells'][scale] = {}
        for surface in ['sidebar', 'full']:
            rows = [r for r in accepted if r['phase'] == 'timing' and r['kind'] == 'click' and r['scale'] == scale and r['surface'] == surface]
            cells[surface] = {}
            for mode in ['legacy', 'pool']:
                arm = [r for r in rows if r['mode'] == mode]
                cells[surface][mode] = {'paint': distribution([r['paint']['inputToPaintMs'] for r in arm]),
                    'twoRafProxy': distribution([r['paint']['twoRafMs'] for r in arm]),
                    'stateCpu': distribution([cpu(r) for r in arm]),
                    'publications': [publications(r) for r in arm]}
            pilot = cells[surface]['pool']['paint']
            (warm_cells if surface == 'full' else selection_cells).append(pilot['p95'] is not None and pilot['p95'] <= PLAN['bars']['warmSwitchP95Ms' if surface == 'full' else 'sidebarSelectionP95Ms'])
            publish_cells.extend(p['navigation'] == 1 and p['other'] == 0 for p in cells[surface]['pool']['publications'])
        cells['cpu'] = {}
        for kind in ['click', 'unrelated', 'title', 'phase', 'draft']:
            arms = {}
            for mode in ['legacy', 'pool']:
                rows = [r for r in accepted if r['phase'] == 'timing' and r['kind'] == kind and r['scale'] == scale and r['mode'] == mode and r.get('surface') == 'sidebar']
                arms[mode] = distribution([cpu(r) for r in rows])
            p, l = arms['pool']['p95'], arms['legacy']['p95']
            reduction = 100 * (1 - p / l) if p is not None and l else None
            cells['cpu'][kind] = {**arms, 'reductionPercent': reduction}
            cpu_cells.append((p is not None and p <= PLAN['bars']['stateCpuP95Ms'], reduction is not None and reduction >= PLAN['bars']['minimumCpuReductionPercent']))
    memory_cells = []
    startup_cells = []
    for scale in PLAN['memoryCells']:
        cells = summary['cells'].setdefault(scale, {})
        cells['memory'] = {}
        for mode in ['legacy', 'pool']:
            rows = [r for r in accepted if r['phase'] == 'memory' and r['scale'] == scale and r['mode'] == mode]
            cells['memory'][mode] = {'startup': distribution([r['startupMs'] for r in rows], p95=False),
                'v8Startup': distribution([r['heapStartup']['usedSize'] for r in rows], p95=False),
                'v8Retained': distribution([r['heapRetained']['usedSize'] for r in rows], p95=False),
                'totalRetained': distribution([sum(r['heapRetained'].get(k, 0) for k in ['usedSize', 'embedderHeapUsedSize', 'backingStorageSize']) for r in rows], p95=False)}
        arms = cells['memory']
        regressions = {}
        complete = all(arms[mode]['startup']['n'] == PLAN['startupAndMemorySamples'] for mode in ['pool', 'legacy'])
        for metric in ['startup', 'v8Startup', 'v8Retained', 'totalRetained']:
            p, l = arms['pool'][metric]['p50'], arms['legacy'][metric]['p50']
            regressions[metric] = regression(p, l) if p is not None and l is not None else None
        cells['memory']['regressionPercentOfPairedCellMedians'] = regressions
        startup_cells.append(complete and regressions['startup'] is not None and regressions['startup'] <= PLAN['bars']['maximumStartupRegressionPercent'])
        memory_cells.append(complete and all(regressions[k] is not None and regressions[k] <= PLAN['bars']['maximumRetainedMemoryRegressionPercent'] for k in ['v8Retained', 'totalRetained']))
    idle = [r for r in accepted if r['kind'] == 'idle' and r['mode'] == 'pool']
    unrelated = [r for r in accepted if r['kind'] == 'unrelated' and r['mode'] == 'pool']
    parity = [r for r in accepted if r['kind'] == 'parity']
    principal = [r for r in accepted if r['kind'] == 'principal']
    summary['idle'] = [{'scale': r['scale'], 'panel': measurement(r).get('panel'), 'publications': publications(r), 'intervals': measurement(r)['intervals']} for r in idle]
    summary['unrelated'] = [{'scale': r['scale'], 'derivations': derives(r)} for r in unrelated]
    summary['parity'] = {'checks': len(parity), 'differences': sum(r['result']['differences'] for r in parity), 'pending': sum(r['result']['pending'] for r in parity), 'results': [r['result'] for r in parity]}
    summary['principal'] = [{'scale': r['scale'], 'mode': r['mode'], 'readyMs': r['readyMs'], 'rebuild': r['rebuild'], 'survivors': r['survivors']} for r in principal]
    results = {
        'idle': len(idle) == len(PLAN['scales']) and all((measurement(r).get('panel') or {}).get('idle', {}).get('rows', -1) == 0 and derives(r) == 0 and publications(r)['total'] == publications(r)['clock'] for r in idle),
        'unrelated': len(unrelated) >= len(PLAN['scales']) * PLAN['samples'] and all(derives(r) == 0 for r in unrelated),
        'onePublication': bool(publish_cells) and all(publish_cells),
        'warmSwitch': all(warm_cells),
        'stateCpu': all(p for p, _ in cpu_cells),
        'cpuBenefit': all(p for _, p in cpu_cells),
        'startup': all(startup_cells),
        'retainedMemory': all(memory_cells),
        'selectionFrame': all(selection_cells),
        'sideBySide': len(parity) == 24 and all(r['result']['differences'] == 0 and r['result']['pending'] == 0 for r in parity),
    }
    summary['bars'] = {key: 'PASS' if passed else 'FAIL' for key, passed in results.items()}
    summary['verdict'] = 'NOT ACCEPTED: S9 pending' if all(results.values()) else 'FAIL: fixed browser acceptance bars not all met; S9 pending'
    (root / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({'bars': summary['bars'], 'verdict': summary['verdict'], 'records': len(records), 'void': len(void), 'cells': summary['cells']}, indent=2))


parser = argparse.ArgumentParser()
parser.add_argument('--controls', type=Path)
parser.add_argument('--check-control', type=Path)
parser.add_argument('--root', type=Path, default=Path('.artifacts/sidebar-acceptance'))
args = parser.parse_args()
if args.check_control:
    checks = control_verdict(json.loads(args.check_control.read_text()))
    failed = [name for name, passed in checks.items() if not passed]
    print(json.dumps({'failed': failed}))
    sys.exit(1 if failed else 0)
elif args.controls:
    controls(args.controls)
else:
    analyze(args.root)
