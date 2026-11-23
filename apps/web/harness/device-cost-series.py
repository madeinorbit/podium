"""Interleaved SQLite, feed and cache samples; runs only inside remote-lane.

Run `build` after data-on-device-baseline.py prepare. Each series owns a short
host-lock window; all independent processes are sequential. Raw files cannot
be overwritten. The report consumes them, including failed runs.
"""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

import importlib.util


spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('data-on-device-baseline.py'))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['build', 'sqlite', 'feed', 'cache', 'search'])
    parser.add_argument('--base', default='17d01cd9c5')
    parser.add_argument('--round', type=int, default=21)
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--cells', default='h1a1,h10a1,operator')
    parser.add_argument('--clients', default='phone,browser,desktop')
    parser.add_argument('--host', default='vega')
    parser.add_argument('--refresh-corpus', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--max-cases', type=int)
    args = parser.parse_args()
    paths = baseline.checkouts(args)
    here = Path.cwd()
    candidate = baseline.git(here, 'rev-parse', 'HEAD')
    for path in paths:
        if path != here:
            baseline.sh(f'git checkout {candidate} -- apps/web/harness', path)
    if args.step == 'build':
        baseline.prepare(args)
        for path in paths:
            if path != here:
                baseline.sh(f'git checkout {candidate} -- apps/web/harness', path)
            feed_only = 'PODIUM_MEASUREMENT_FEED_ONLY=1 ' if path != here else ''
            baseline.sh(feed_only + 'bun apps/web/node_modules/vite/bin/vite.js build --config apps/web/harness/device-cache.vite.ts', path)
        return
    cells = args.cells.split(',')
    clients = args.clients.split(',')
    tasks = [(path, cell, client, None) for cell in cells for client in clients for path in paths]
    if args.step == 'feed':
        # The before sync engine has no client policy and this fixture has no
        # screen. One full-history before arm is therefore shared by the three
        # policy candidates, all interleaved in the same schedule.
        tasks = [(path, cell, client, None) for cell in cells for path in paths
                 for client in (['shared'] if path != here else clients)]
    if args.step == 'cache':
        caps = {'phone': [0, 500, 1000, 2000], 'browser': [0, 2500, 5000], 'desktop': [0, 5000, 10000]}
        tasks = [(here, 'h10a1', client, cap) for client in clients for cap in caps[client]]
    if args.step == 'search':
        candidate = baseline.git(here, 'rev-parse', 'HEAD')
        for path in paths:
            if path != here:
                baseline.sh(f'git checkout {candidate} -- apps/web/harness/device-search.ts', path)
        tasks = [(path, 'operator', 'server', None) for path in paths]
    root = Path('.artifacts/7095')
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / f'{args.step}-r{args.round}.json'
    if ledger.exists() and not args.resume:
        raise SystemExit('Use a fresh round; raw results are immutable')
    prior = json.loads(ledger.read_text()) if args.resume else {'schedule': [], 'results': []}
    schedule, results = prior['schedule'], prior['results']
    completed, position, added = len(schedule), 0, 0
    def save(status):
        ledger.write_text(json.dumps({'step': args.step, 'round': args.round, 'status': status,
                                     'schedule': schedule, 'results': results}, indent=2) + '\n')
    for sample in range(args.samples):
        rotated = tasks[sample % len(tasks):] + tasks[:sample % len(tasks)]
        if sample % 2:
            rotated.reverse()
        for path, cell, client, cap in rotated:
            name = f'{args.step}-{cell}-{client}' + (f'-cap{cap}' if cap is not None else '') + f'-r{args.round}-s{sample}.json'
            relative = f'.artifacts/7095/{name}'
            planned = {'checkout': path.name, 'cell': cell, 'client': client, 'cap': cap, 'sample': sample, 'path': str(path / relative)}
            if position < completed:
                if planned != schedule[position]:
                    raise SystemExit('Resume must preserve the original schedule and samples')
                position += 1
                continue
            if args.max_cases and added >= args.max_cases:
                save('paused')
                print(f'DEVICE_SERIES_PAUSED {ledger}: {len(schedule)} cases', flush=True)
                return
            argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/device-costs.mjs', f'--mode={args.step}',
                    f'--cell={cell}', f'--client={client}', f'--round={args.round}', f'--sample={sample}', f'--out={relative}']
            if cap is not None:
                argv.append(f'--cap={cap}')
            if args.step == 'search':
                argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/device-search.ts', relative]
            baseline.sh(shlex.join(argv), path)
            result = json.loads((path / relative).read_text())
            results.append({'checkout': path.name, **result})
            schedule.append(planned)
            position += 1
            added += 1
            save('running')
    save('complete')
    print(f'DEVICE_SERIES_COMPLETE {ledger}: {len(schedule)} cases', flush=True)


if __name__ == '__main__':
    main()
