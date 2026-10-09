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
    # A complete rotation block, then its reverse: at eight samples and four
    # cells, every cell occupies every position twice.
    return rotated if (step // len(cells)) % 2 == 0 else list(reversed(rotated))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', default='podium-test-5594')
    parser.add_argument('--cells', default='h1a1,h10a1,h1a4,h10a4')
    parser.add_argument('--surface', default='web', choices=['web', 'phone'])
    parser.add_argument('--samples', default=8, type=int)
    parser.add_argument('--round', default=1, type=int)
    parser.add_argument('--meter-held', action='store_true', help='reuse the current session\'s caller-owned meter lease')
    parser.add_argument('--resume', action='store_true', help='continue the saved schedule without replacing completed pairs')
    parser.add_argument('--max-pairs', type=int, help='yield the leases after this many new pairs')
    args = parser.parse_args()
    cells = args.cells.split(',')
    if not re.fullmatch(r'podium-test-[a-z0-9-]+', args.checkout):
        raise ValueError('An issue-owned flatblock checkout is required')
    if args.samples < 1 or len(set(cells)) != len(cells) or any(not re.fullmatch(r'h(?:[1-9]|1[0-9]|20)a[124]', cell) for cell in cells):
        raise ValueError('Distinct corpus cells and at least one sample are required')
    root = Path('.artifacts/startup-baseline')
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / f'{args.surface}-r{args.round}.json'
    pause = root / f'{args.surface}-r{args.round}.pause'
    plan = [{'step': step, 'cell': cell,
             'run': f'.artifacts/old-vs-new/timing-{cell}-{args.surface}-{cell}-r{args.round}-s{step}/run.json'}
            for step in range(args.samples) for cell in sample_order(cells, step)]
    if args.max_pairs is not None and args.max_pairs < 1:
        raise ValueError('--max-pairs must be positive')
    if args.resume:
        data = json.loads(ledger.read_text())
        if (data['status'] not in ['running', 'paused'] or data['surface'] != args.surface
                or data['samplesPerCell'] != args.samples or list(data['outputs']) != cells
                or data['schedule'] != plan[:len(data['schedule'])]):
            raise ValueError('Resume must retain the original cells, surface and balanced schedule')
        expected = {cell: [row['run'] for row in data['schedule'] if row['cell'] == cell] for cell in cells}
        if data['outputs'] != expected:
            raise ValueError('Saved outputs do not match the completed schedule')
        cohort, outputs, schedule = data['cohort'], data['outputs'], data['schedule']
    else:
        if ledger.exists():
            raise ValueError('This baseline round already exists; use --resume or a fresh round')
        cohort, outputs, schedule = str(uuid.uuid4()), {cell: [] for cell in cells}, []
    def save(status):
        ledger.write_text(json.dumps({'cohort': cohort, 'surface': args.surface, 'outputs': outputs,
                                     'schedule': schedule, 'samplesPerCell': args.samples, 'status': status}, indent=2) + '\n')
    held = []
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
        completed = len(schedule)
        last_step = None
        for row in plan[completed:]:
            if pause.exists() or (args.max_pairs is not None and len(schedule) - completed >= args.max_pairs):
                save('paused')
                print(f'BASELINE_PAUSED {ledger}: {len(schedule)}/{len(plan)} pairs', flush=True)
                return
            step, cell = row['step'], row['cell']
            if step != last_step:
                last_step = step
                for name in ['meter:flatblock', 'bench:flatblock']:
                    subprocess.run(['podium', 'lock', 'renew', name, '--ttl', '45m'], check=True)
            relative = str(Path(row['run']).parent)
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
            outputs[cell].append(row['run'])
            schedule.append(row)
            save('running')
        save('complete')
        print(ledger.read_text(), flush=True)
    finally:
        for name in reversed(held):
            subprocess.run(['podium', 'lock', 'release', name], check=True)


if __name__ == '__main__':
    main()
