"""Validate and summarize a startup-baseline controller ledger.

Run where its raw capture paths exist (normally the issue checkout on flatblock).
Median, minimum and maximum retain the observed spread, without a speed claim.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import statistics

spec = importlib.util.spec_from_file_location('cold_start_guard', Path(__file__).with_name('cold-start-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def summarize(ledger):
    data = json.loads(Path(ledger).read_text())
    if data['status'] != 'complete':
        raise ValueError('Only a completed interleaved round can be summarized')
    cells = {}
    for cell, paths in data['outputs'].items():
        cold, provenance = guard.cold_samples(paths)
        if provenance[3] != data['cohort'] or provenance[5] != data['surface'] or provenance[7] != cell:
            raise ValueError('Controller and capture provenance differ')
        runs = [json.loads(Path(path).read_text()) for path in paths]
        warm = []
        for run in runs:
            unprofiled = [row for row in run['actions'] if not row.get('profiled')]
            if [row['action'] for row in unprofiled] != ['app-cold-start', 'app-warm-start']:
                raise ValueError('Each interleaved run must contain one cold/warm pair')
            value = unprofiled[1]['inputToPaintMs']
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError('Invalid warm Paint sample')
            warm.append(value)
        if len(cold) != data['samplesPerCell'] or len(warm) != len(cold):
            raise ValueError('Missing interleaved pairs')
        def spread(values):
            return {'samplesMs': values, 'medianMs': statistics.median(values), 'minMs': min(values), 'maxMs': max(values)}
        cells[cell] = {
            'cold': spread(cold), 'warm': spread(warm), 'runs': paths,
            'sourceShas': sorted(set(run['sha'] for run in runs)),
            'builds': [run['build'] for run in runs[:1]],
            'corpus': runs[0]['corpus'], 'semanticSha256': provenance[0],
            'collectorSha256': provenance[4], 'browser': provenance[1],
            'httpCache': provenance[2], 'startupBoundary': runs[0]['startupBoundary'],
            'loadStart': [run['loadStart'] for run in runs],
            'loadEnd': [run['loadEnd'] for run in runs],
            'population': [run['population'] for run in runs],
        }
    return {'cohort': data['cohort'], 'surface': data['surface'], 'cells': cells}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', required=True)
    parser.add_argument('--out')
    args = parser.parse_args()
    text = json.dumps(summarize(args.ledger), indent=2) + '\n'
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text)
    print(text, end='')
