"""Compare fresh-context navigation-to-Paint samples with a matched OLD arm.

Usage: python3 apps/web/harness/cold-start-guard.py --old OLD/run.json \
    --candidate NEW/run.json [--old OLD2/run.json --candidate NEW2/run.json]
Profiles, incomplete captures and mismatched corpora cannot certify the budget.
"""
import argparse
import json
import statistics
import re
from datetime import datetime, timedelta
from pathlib import Path


def fixture_noise(message):
    # Both fixtures deliberately block service workers. The PWA wrapper logs
    # the resulting registration rejection; it is retained in the raw ledger.
    return message == 'warning: Service Worker registration blocked by Playwright' or (
        message.startswith('error: ')
        and 'ERROR web:sw service worker registration failed available=true' in message
        and "Cannot read properties of undefined (reading 'waiting')" in message
    )


def aborted_rpc_outside_cold(message, windows):
    match = re.match(r'warning: (\d\d:\d\d:\d\d\.\d{3}) WARN  web:trpc trpc call could not be sent ', message)
    if not match:
        return False
    clock = datetime.strptime(match[1], '%H:%M:%S.%f').time()
    for timestamp, ms in windows:
        start = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        end = start + timedelta(milliseconds=ms)
        warning = datetime.combine(start.date(), clock, start.tzinfo)
        if any(start <= warning + timedelta(days=offset) <= end for offset in [-1, 0, 1]):
            return False
    return True


def cold_samples(paths):
    samples = []
    provenance = []
    for path in paths:
        run = json.loads(Path(path).read_text())
        if run.get('status') != 'complete' or run.get('controlOnly') or run.get('variants') or run.get('diagnostic'):
            raise ValueError(f'{path}: incomplete or diagnostic capture')
        if run.get('host') != 'flatblock' or run.get('surface') != 'web' or run.get('scale') != 1:
            raise ValueError(f'{path}: expected matched flatblock web 1x')
        cold_windows = [(row['startedAt'], row['inputToPaintMs']) for row in run['actions']
                        if row['action'] == 'app-cold-start' and not row.get('profiled')]
        unexpected = []
        for message in run.get('errors', []):
            if fixture_noise(message):
                continue
            # Navigation aborts the preceding document's pending boot RPCs.
            # A warning outside every cold measurement is not cold evidence.
            if aborted_rpc_outside_cold(message, cold_windows):
                continue
            unexpected.append(message)
        if unexpected:
            raise ValueError(f'{path}: unexpected browser errors invalidate startup evidence')
        if not run.get('semanticSha256') or not run.get('browser') or not run.get('lease'):
            raise ValueError(f'{path}: missing corpus, browser or timing lease provenance')
        if run['lease'].get('name') != 'bench:flatblock':
            raise ValueError(f'{path}: startup timing requires bench:flatblock')
        count = run.get('population', {})
        expected = run['corpus']
        if max(count.get('issue', 0), count.get('issueProjection', 0)) < expected['syntheticIssues'] or count.get('session', 0) < expected['syntheticSessions']:
            raise ValueError(f'{path}: complete corpus did not hydrate')
        provenance.append((run['semanticSha256'], run['browser'], run.get('httpCache')))
        for row in run['actions']:
            if row['action'] != 'app-cold-start' or row.get('profiled'):
                continue
            value = row.get('inputToPaintMs')
            if not isinstance(value, (int, float)) or not 0 < value < float('inf'):
                raise ValueError(f'{path}: invalid Paint sample')
            samples.append(value)
    if len(samples) < 8:
        raise ValueError('At least eight unprofiled fresh contexts are required per arm')
    if len(set(provenance)) != 1:
        raise ValueError('An arm contains mismatched corpus/browser/cache provenance')
    return samples, provenance[0]


def compare(old_paths, candidate_paths, max_ms=2500):
    old, old_provenance = cold_samples(old_paths)
    candidate, candidate_provenance = cold_samples(candidate_paths)
    if old_provenance != candidate_provenance:
        raise ValueError('OLD and candidate must use the same corpus, Chromium and cache policy')
    old_median = statistics.median(old)
    candidate_median = statistics.median(candidate)
    return {
        'passed': candidate_median <= min(old_median, max_ms),
        'boundary': 'navigation to actual Chromium Paint after a visible unobscured issue row',
        'oldSamples': len(old), 'candidateSamples': len(candidate),
        'oldMedianMs': old_median, 'candidateMedianMs': candidate_median,
        'budgetMs': min(old_median, max_ms), 'absoluteBudgetMs': max_ms,
        'changePercent': (candidate_median / old_median - 1) * 100,
        'oldMaxMs': max(old), 'candidateMaxMs': max(candidate),
        'semanticSha256': old_provenance[0], 'browser': old_provenance[1],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old', action='append', required=True)
    parser.add_argument('--candidate', action='append', required=True)
    parser.add_argument('--out')
    parser.add_argument('--max-ms', type=float, default=2500)
    args = parser.parse_args()
    verdict = compare(args.old, args.candidate, args.max_ms)
    text = json.dumps(verdict, indent=2) + '\n'
    if args.out:
        Path(args.out).write_text(text)
    print(text, end='')
    print('COLD START GUARD GREEN' if verdict['passed'] else 'COLD START GUARD RED')
    raise SystemExit(0 if verdict['passed'] else 1)
