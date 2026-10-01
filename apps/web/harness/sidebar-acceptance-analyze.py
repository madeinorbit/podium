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
    if '_cpu' in record:
        return record['_cpu']
    return union_ms([i for i in measurement(record)['intervals'] if i['kind'] != 'sidebar row render'])


def derives(record):
    if '_derives' in record:
        return record['_derives']
    panel = measurement(record).get('panel') or {}
    return (panel.get('idle') or {}).get('derivations', 0) + ((panel.get('lastUpdate') or {}).get('work') or {}).get('derivations', 0)


def publications(record):
    if '_publications' in record:
        return record['_publications']
    pubs = measurement(record)['stats']['publishes']
    navigation = [p for p in pubs if 'selectedIssueId' in p['changedKeys']]
    optimism = [p for p in pubs if 'selectedIssueId' not in p['changedKeys'] and any(k in p['changedKeys'] for k in ['issues', 'issueProjections', 'outboxSize', 'outboxDeadLetters'])]
    clock = [p for p in pubs if p['changedKeys'] and set(p['changedKeys']) <= {'coarseNow'}]
    other = [p for p in pubs if p not in navigation and p not in optimism and p not in clock]
    return {'navigation': len(navigation), 'optimistic_or_outbox': len(optimism), 'clock': len(clock), 'other': len(other), 'total': len(pubs)}


def compact_record(record):
    """Keep every decision input while releasing each large interval list.

    Original JSONL remains untouched; CPU is reduced by the same union function.
    This avoids holding nearly a gigabyte of raw JSON as Python objects at once.
    """
    small = {key: value for key, value in record.items() if key not in ['result', 'stats']}
    if record['kind'] in ['click', 'unrelated', 'title', 'phase', 'draft', 'idle']:
        small['_cpu'] = cpu(record)
        small['_derives'] = derives(record)
        small['_publications'] = publications(record)
        meter = measurement(record)
        small['result'] = {'intervals': meter['intervals'] if record['kind'] == 'idle' else [],
            'stats': {'publishes': meter['stats']['publishes']}, 'panel': meter.get('panel')}
    elif record['kind'] == 'parity':
        small['result'] = record['result']
    return small


def regression(pilot, legacy):
    return 100 * (pilot / legacy - 1) if legacy else None


def check_math():
    assert union_ms([{'start': 0, 'end': 8}, {'start': 2, 'end': 6}]) == 8
    assert distribution([1] * 37 + [7, 999, 1000])['p95'] == 7
    assert distribution([1, 2, 3])['p95'] is None
    probe = {'kind': 'click', 'result': {'intervals': [
        {'start': 0, 'end': 9, 'kind': 'runtime batch'},
        {'start': 2, 'end': 4, 'kind': 'sidebar derivation'},
        {'start': 10, 'end': 100, 'kind': 'sidebar row render'}],
        'stats': {'publishes': [{'changedKeys': keys} for keys in [['selectedIssueId'], ['outboxSize'], ['coarseNow'], ['drafts']]]},
        'panel': {'idle': {'derivations': 2}, 'lastUpdate': {'work': {'derivations': 3}}}}}
    compacted = compact_record(probe)
    assert cpu(compacted) == 9
    assert derives(compacted) == 5
    assert publications(compacted) == {'navigation': 1, 'optimistic_or_outbox': 1, 'clock': 1, 'other': 1, 'total': 4}
    assert compacted['result']['intervals'] == []


def controls(out):
    out.mkdir(parents=True, exist_ok=True)
    golden = {'counts': [], 'timing': [], 'memory': []}
    def meter(mode, kind='click'):
        return {'intervals': [{'start': 0, 'end': 2 if mode == 'pool' else 6, 'kind': 'state delivery/selector'}],
            'stats': {'publishes': [{'changedKeys': ['selectedIssueId']}] if kind == 'click' else []},
            'panel': {'idle': {'rows': 0, 'derivations': 0, 'mainThreadMs': 0}, 'lastUpdate': None}}
    for scale in PLAN['scales']:
        golden['counts'].append({'kind': 'idle', 'scale': scale, 'mode': 'pool', 'result': meter('pool', 'idle')})
        for i in range(12):
            golden['counts'].append({'kind': 'parity', 'scale': scale, 'mode': 'pool', 'result': {'differences': 0, 'pending': 0, 'sections': 1, 'rows': 1}})
        for mode in ['pool', 'legacy']:
            for kind in ['click', 'unrelated', 'title', 'phase', 'draft']:
                for i in range(40):
                    record = {'kind': kind, 'scale': scale, 'surface': 'sidebar', 'mode': mode, 'iteration': i, 'result': meter(mode, kind)}
                    if kind == 'click': record['paint'] = {'inputToPaintMs': 15, 'twoRafMs': 30}
                    golden['timing'].append(record)
            for i in range(40):
                golden['timing'].append({'kind': 'click', 'scale': scale, 'surface': 'full', 'mode': mode, 'iteration': i,
                    'result': meter(mode), 'paint': {'inputToPaintMs': 99, 'twoRafMs': 120}})
    for scale in PLAN['memoryCells']:
        for mode in ['pool', 'legacy']:
            for i in range(10):
                golden['memory'].append({'kind': 'memory', 'scale': scale, 'mode': mode, 'iteration': i, 'startupMs': 100,
                    'heapStartup': {'usedSize': 1000}, 'heapRetained': {'usedSize': 1000, 'embedderHeapUsedSize': 100, 'backingStorageSize': 100}})
    for phase, records in golden.items():
        directory = out / 'golden' / phase
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / 'records.jsonl'
        path.write_text(''.join(json.dumps(dict(r, valid=True, runner={'loadavg': [1, 1, 1]})) + '\n' for r in records))
        subprocess.run(['cp', str(path), str(path.with_suffix('.aside'))], check=True, timeout=10)
    def run_checker():
        return subprocess.run([sys.executable, __file__, '--root', str(out / 'golden'), '--require-all-bars'], capture_output=True, text=True, timeout=30)
    baseline = run_checker()
    if baseline.returncode: raise AssertionError(baseline.stdout + baseline.stderr)
    log = []
    plants = ['idle', 'unrelated', 'onePublication', 'warmSwitch', 'stateCpu', 'cpuBenefit', 'startup', 'retainedMemory', 'selectionFrame', 'sideBySide', 'missingCell', 'highLoad']
    for plant in plants:
        phase = 'counts' if plant in ['idle', 'sideBySide'] else 'memory' if plant in ['startup', 'retainedMemory'] else 'timing'
        path = out / 'golden' / phase / 'records.jsonl'
        values = [json.loads(line) for line in path.read_text().splitlines()]
        for r in values:
            if r.get('mode') != 'pool': continue
            if plant == 'idle' and r['kind'] == 'idle': r['result']['panel']['idle']['rows'] = 1
            if plant == 'unrelated' and r['kind'] == 'unrelated': r['result']['panel']['idle']['derivations'] = 1
            if plant == 'onePublication' and r['kind'] == 'click': r['result']['stats']['publishes'].append({'changedKeys': ['selectedIssueId']})
            if plant == 'warmSwitch' and r['kind'] == 'click' and r.get('surface') == 'full': r['paint']['inputToPaintMs'] = 101
            if plant == 'stateCpu': r['result']['intervals'][0]['end'] = 9
            if plant == 'cpuBenefit': r['result']['intervals'][0]['end'] = 4
            if plant == 'startup': r['startupMs'] = 111
            if plant == 'retainedMemory': r['heapRetained']['usedSize'] = 1111
            if plant == 'selectionFrame' and r['kind'] == 'click' and r.get('surface') == 'sidebar': r['paint']['inputToPaintMs'] = 17
            if plant == 'sideBySide' and r['kind'] == 'parity': r['result']['differences'] = 1
            if plant == 'highLoad': r['valid'] = False; r['runner']['loadavg'][0] = 8.01
        if plant == 'missingCell': values = [r for r in values if not (r['mode'] == 'pool' and r['scale'] == '4x' and r['kind'] == 'click' and r.get('surface') == 'full')]
        path.write_text(''.join(json.dumps(r) + '\n' for r in values))
        run = run_checker()
        if run.returncode == 0: raise AssertionError(f'Planted {plant} was not rejected by actual raw-record analysis')
        summary = json.loads((out / 'golden' / 'summary.json').read_text())
        log.append({'plant': plant, 'exit': run.returncode, 'failedBars': [k for k, v in summary['bars'].items() if v == 'FAIL']})
        subprocess.run(['cp', str(path.with_suffix('.aside')), str(path)], check=True, timeout=10)
    script = Path(__file__)
    aside = out / 'analyzer.aside'
    subprocess.run(['cp', str(script), str(aside)], check=True, timeout=10)
    original = script.read_text()
    source_plants = {
        'nested_cpu_double_count': ('end = -math.inf', "return sum(i['end'] - i['start'] for i in intervals)\n    end = -math.inf"),
        'max_as_p95': ('ordered[math.ceil(0.95 * len(ordered)) - 1]', 'ordered[-1]'),
        'sparse_p95_as_max': ("len(ordered) >= PLAN['samples']", 'len(ordered) > 0'),
        'compacted_cpu_lost': ("small['_cpu'] = cpu(record)", "small['_cpu'] = 0"),
        'compacted_derivations_lost': ("small['_derives'] = derives(record)", "small['_derives'] = 0"),
        'compacted_publications_lost': ("small['_publications'] = publications(record)", "small['_publications'] = {}"),
    }
    try:
        for name, (old, wrong) in source_plants.items():
            assert old in original
            script.write_text(original.replace(old, wrong, 1))
            run = subprocess.run([sys.executable, str(script), '--check-math'], capture_output=True, text=True, timeout=20)
            if run.returncode == 0: raise AssertionError(f'Planted {name} was not caught')
            log.append({'plant': name, 'exit': run.returncode, 'output': run.stderr.strip().splitlines()[-1]})
            subprocess.run(['cp', str(aside), str(script)], check=True, timeout=10)
    finally:
        subprocess.run(['cp', str(aside), str(script)], check=True, timeout=10)
    check_math()
    clean = run_checker()
    if clean.returncode: raise AssertionError(clean.stdout + clean.stderr)
    log.append({'restored': True, 'exit': clean.returncode, 'allBars': 'PASS'})
    (out / 'negative-controls.json').write_text(json.dumps(log, indent=2))
    print(f'{len(plants)} actual-record plants and {len(source_plants)} source plants RED; cp restoration GREEN')


def analyze(root):
    records = []
    for phase in ['counts', 'timing', 'memory', 'attribution']:
        path = root / phase / 'records.jsonl'
        if path.exists():
            with path.open() as source:
                for line in source:
                    if line.strip():
                        records.append(dict(compact_record(json.loads(line)), phase=phase))
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
            if surface == 'full':
                p = cells[surface]['pool']['stateCpu']['p95']
                l = cells[surface]['legacy']['stateCpu']['p95']
                reduction = 100 * (1 - p / l) if p is not None and l else None
                cells[surface]['stateCpuReductionPercent'] = reduction
                cpu_cells.append((p is not None and p <= PLAN['bars']['stateCpuP95Ms'], reduction is not None and reduction >= PLAN['bars']['minimumCpuReductionPercent']))
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
        'idle': len(idle) == len(PLAN['scales']) and all((measurement(r).get('panel') or {}).get('idle', {}).get('rows', -1) == 0 and (measurement(r).get('panel') or {}).get('idle', {}).get('mainThreadMs', -1) == 0 and derives(r) == 0 and publications(r)['total'] == publications(r)['clock'] for r in idle),
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
    print(json.dumps({'bars': summary['bars'], 'verdict': summary['verdict'], 'records': len(records), 'void': len(void)}, indent=2))
    return all(results.values())


parser = argparse.ArgumentParser()
parser.add_argument('--controls', type=Path)
parser.add_argument('--check-math', action='store_true')
parser.add_argument('--require-all-bars', action='store_true')
parser.add_argument('--root', type=Path, default=Path('.artifacts/sidebar-acceptance'))
args = parser.parse_args()
if args.check_math:
    check_math()
elif args.controls:
    controls(args.controls)
else:
    passed = analyze(args.root)
    sys.exit(1 if args.require_all_bars and not passed else 0)
