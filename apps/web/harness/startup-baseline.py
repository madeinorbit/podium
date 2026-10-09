"""Interleave seeded startup cells with exactly one flatblock process tree alive.

Each sample is a fresh collector's cold context and its retained-data warm
reload. Raw run ledgers and Chromium Paint traces stay in the remote checkout.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid


def sample_order(cells, step):
    rotated = cells[step % len(cells):] + cells[:step % len(cells)]
    return rotated if step % 2 == 0 else list(reversed(rotated))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', default='podium-test-5594')
    parser.add_argument('--cells', default='h1a1,h10a1,h1a4,h10a4')
    parser.add_argument('--surface', default='web', choices=['web', 'phone'])
    parser.add_argument('--samples', default=8, type=int)
    parser.add_argument('--round', default=1, type=int)
    parser.add_argument('--meter-held', action='store_true', help='reuse the current session\'s caller-owned meter lease')
    args = parser.parse_args()
    cells = args.cells.split(',')
    if not re.fullmatch(r'podium-test-[a-z0-9-]+', args.checkout):
        raise ValueError('An issue-owned flatblock checkout is required')
    if args.samples < 1 or len(set(cells)) != len(cells) or any(not re.fullmatch(r'h(?:[1-9]|1[0-9]|20)a[124]', cell) for cell in cells):
        raise ValueError('Distinct corpus cells and at least one sample are required')
    cohort = str(uuid.uuid4())
    root = Path('.artifacts/startup-baseline')
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / f'{args.surface}-r{args.round}.json'
    if ledger.exists():
        raise ValueError('This baseline round already exists; use a fresh round')
    held = []
    outputs = {cell: [] for cell in cells}
    grants = {}
    try:
        if args.meter_held:
            status = subprocess.run(['podium', 'lock', 'status', 'meter:flatblock', '--json'], check=True, capture_output=True, text=True)
            holder = (json.loads(status.stdout).get('data') or {}).get('holder', {})
            if not os.environ.get('PODIUM_SESSION_ID') or holder.get('sessionId') != os.environ['PODIUM_SESSION_ID']:
                raise RuntimeError('--meter-held requires this session to own meter:flatblock')
        for name in ([] if args.meter_held else ['meter:flatblock']) + ['bench:flatblock']:
            grant = subprocess.run(['podium', 'lock', 'acquire', name, '--wait', '--ttl', '45m', '--json'], check=True, capture_output=True, text=True)
            grants[name] = json.loads(grant.stdout)
            if not grants[name].get('data', {}).get('granted'):
                raise RuntimeError(f'{name} was not acquired')
            held.append(name)
        payload = json.dumps({'name': 'bench:flatblock', 'host': 'ludovico', 'cohort': cohort,
                              'acquiredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              'grant': grants['bench:flatblock'], 'also': ['meter:flatblock']})
        for step in range(args.samples):
            for name in ['meter:flatblock', 'bench:flatblock']:
                subprocess.run(['podium', 'lock', 'renew', name, '--ttl', '45m'], check=True)
            for cell in sample_order(cells, step):
                relative = f'.artifacts/old-vs-new/timing-{cell}-{args.surface}-{cell}-r{args.round}-s{step}'
                argv = ['.toolchain/bun', '--conditions=@podium/source', 'apps/web/harness/cold-start.mjs',
                        '--external-lease', '--paired', '--no-profile', '--mode=timing', f'--arm={cell}',
                        f'--surface={args.surface}', f'--cell={cell}', f'--round={args.round}',
                        '--samples=1', '--port=19661', f'--out={relative}']
                # Grant files precede collector startup. They never prime the app.
                prepare = (f'mkdir -p {shlex.quote(relative)} && '
                           f'cat > {shlex.quote(relative + "/lease.json")} && '
                           f'touch {shlex.quote(relative + "/step-0.go")}')
                prefix = f'cd "$HOME/{args.checkout}" && '
                subprocess.run(['ssh', 'flatblock', prefix + prepare], input=payload, text=True, check=True)
                command = prefix + shlex.join(['python3', 'apps/web/harness/flatblock-budget.py', '--census',
                                              f'--log={relative}/collector.log', '--', *argv])
                subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', command], check=True)
                outputs[cell].append(f'{relative}/run.json')
                ledger.write_text(json.dumps({'cohort': cohort, 'surface': args.surface, 'outputs': outputs,
                                               'samplesPerCell': args.samples, 'status': 'running'}, indent=2) + '\n')
        data = json.loads(ledger.read_text())
        data['status'] = 'complete'
        ledger.write_text(json.dumps(data, indent=2) + '\n')
        print(json.dumps(data), flush=True)
    finally:
        for name in reversed(held):
            subprocess.run(['podium', 'lock', 'release', name], check=True)


if __name__ == '__main__':
    main()
