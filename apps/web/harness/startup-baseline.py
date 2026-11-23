"""Interleave seeded startup cells with exactly one process tree alive on the host.

Each sample is a fresh collector's cold context and its retained-data warm
reload. Raw run ledgers and Chromium Paint traces stay in the host checkout.

POD-7099: the host and its lock are arguments (measure_hosts.py), defaulting
to the agent VMs under remote-lane's locks. Several checkouts may be given
(`--checkout=podium-test-7099-base,podium-test-7099`); their cells are then
interleaved in one schedule, so a base and a candidate share the host's drift.
"""
import argparse
import datetime
import json
from pathlib import Path
import re
import shlex
import subprocess
import uuid

import measure_hosts


def sample_order(arms, step):
    rotated = arms[step % len(arms):] + arms[:step % len(arms)]
    # A complete rotation block, then its reverse: at eight samples and four
    # cells, every cell occupies every position twice.
    return rotated if (step // len(arms)) % 2 == 0 else list(reversed(rotated))


def completed_pair(run, row, cohort, host, surface):
    """Recover only the collector's complete, matching pair after an exit gap.

    Browser-error admission remains the report guard's job; a rejected sample
    still belongs in the immutable schedule, with its original evidence.
    """
    actions = run.get('actions', [])
    if (run.get('status') != 'complete' or not run.get('endedAt')
            or run.get('mode') != 'timing' or not run.get('paired')
            or run.get('cell') != row['cell'] or run.get('surface') != surface
            or run.get('host') != host.alias
            or run.get('lease', {}).get('cohort') != cohort
            or run.get('lease', {}).get('name') != host.lock
            or [action.get('action') for action in actions] != ['app-cold-start', 'app-warm-start']
            or any(action.get('profiled') or not isinstance(action.get('inputToPaintMs'), (int, float))
                   or not 0 < action['inputToPaintMs'] < float('inf') for action in actions)):
        raise ValueError('Existing capture is incomplete or differs from the saved plan; keep it and use a fresh round')
    return run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    measure_hosts.add_arguments(parser)
    parser.add_argument('--checkout', default='podium-test-5594',
                        help='comma list of issue-owned checkouts under the host $HOME')
    parser.add_argument('--cells', default='h1a1,h10a1,h1a4,h10a4')
    parser.add_argument('--surface', default='web', choices=['web', 'phone', 'desktop'])
    parser.add_argument('--measure-memory', action='store_true')
    parser.add_argument('--decks', action='store_true')
    parser.add_argument('--samples', default=8, type=int)
    parser.add_argument('--round', default=1, type=int)
    parser.add_argument('--min-available-gib', default=6, type=float, help='admission floor per capture')
    parser.add_argument('--meter-held', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--resume', action='store_true', help='continue the saved schedule without replacing completed pairs')
    parser.add_argument('--max-pairs', type=int, help='yield the lock after this many new pairs')
    args = parser.parse_args()
    host = measure_hosts.resolve(args)
    cells = args.cells.split(',')
    checkouts = args.checkout.split(',')
    if any(not re.fullmatch(r'podium-test-[a-z0-9-]+', checkout) for checkout in checkouts) or len(set(checkouts)) != len(checkouts):
        raise ValueError('Distinct issue-owned checkouts (podium-test-<issue>) are required')
    if args.samples < 1 or len(set(cells)) != len(cells) or any(cell != 'operator' and not re.fullmatch(r'h(?:[1-9]|1[0-9]|20)a[124]', cell) for cell in cells):
        raise ValueError('Distinct corpus cells and at least one sample are required')
    arms = [(checkout, cell) for checkout in checkouts for cell in cells]
    key = (lambda checkout, cell: cell) if len(checkouts) == 1 else (lambda checkout, cell: f'{checkout}/{cell}')
    root = Path('.artifacts/startup-baseline')
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / f'{args.surface}-r{args.round}.json'
    pause = root / f'{args.surface}-r{args.round}.pause'
    plan = [{'step': step, 'cell': cell, 'checkout': checkout, 'key': key(checkout, cell),
             'run': f'~/{checkout}/.artifacts/old-vs-new/timing-{cell}-{args.surface}-{cell}-r{args.round}-s{step}/run.json'}
            for step in range(args.samples) for checkout, cell in sample_order(arms, step)]
    keys = [key(checkout, cell) for checkout, cell in arms]
    if args.max_pairs is not None and args.max_pairs < 1:
        raise ValueError('--max-pairs must be positive')
    if args.resume:
        data = json.loads(ledger.read_text())
        if (data['status'] not in ['running', 'paused'] or data['surface'] != args.surface
                or data['samplesPerCell'] != args.samples or list(data['outputs']) != keys
                or data['schedule'] != plan[:len(data['schedule'])] or data.get('host') != host.alias):
            raise ValueError('Resume must retain the original host, cells, surface and balanced schedule')
        expected = {k: [row['run'] for row in data['schedule'] if row['key'] == k] for k in keys}
        if data['outputs'] != expected:
            raise ValueError('Saved outputs do not match the completed schedule')
        cohort, outputs, schedule = data['cohort'], data['outputs'], data['schedule']
        collector_exits = data.get('collectorExits', {})
    else:
        if ledger.exists():
            raise ValueError('This baseline round already exists; use --resume or a fresh round')
        cohort, outputs, schedule = str(uuid.uuid4()), {k: [] for k in keys}, []
        collector_exits = {}

    def save(status):
        ledger.write_text(json.dumps({'cohort': cohort, 'surface': args.surface, 'host': host.alias, 'lock': host.lock,
                                     'checkouts': checkouts, 'outputs': outputs, 'schedule': schedule,
                                     'samplesPerCell': args.samples, 'collectorExits': collector_exits, 'status': status}, indent=2) + '\n')
    held = False
    try:
        grant = host.acquire()
        held = True
        payload = json.dumps({'name': host.lock, 'host': host.alias, 'cohort': cohort,
                              'acquiredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              'grant': grant})
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
                host.renew()
            relative = str(Path(row['run'].split('/', 2)[2]).parent)
            argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/cold-start.mjs',
                    '--external-lease', '--paired', '--no-profile', '--mode=timing', f'--arm={cell}',
                    f'--surface={args.surface}', f'--cell={cell}', f'--round={args.round}',
                    '--samples=1', '--port=19661', f'--out={relative}',
                    f'--host={host.alias}', f'--lease={host.lock}',
                    *(['--measure-memory'] if args.measure_memory else []),
                    *(['--decks'] if args.decks else [])]
            # Grant files precede collector startup. They never prime the app.
            prepare = (f'mkdir -p {shlex.quote(relative)} && '
                       f'cat > {shlex.quote(relative + "/lease.json")} && '
                       f'touch {shlex.quote(relative + "/step-0.go")}')
            prefix = f'cd "$HOME/{row["checkout"]}" && {measure_hosts.TOOLCHAIN}'
            read_run = prefix + 'cat ' + shlex.quote(relative + '/run.json')
            existing = host.run(read_run, capture_output=True, text=True)
            if existing.returncode == 0:
                if not args.resume:
                    raise ValueError('Capture already exists; only --resume may recover a completed pair')
                completed_pair(json.loads(existing.stdout), row, cohort, host, args.surface)
                collector_exits[row['run']] = 'recovered complete capture after controller exit'
                print(f'CAPTURE_RECOVERED {row["run"]}', flush=True)
            else:
                host.run(prefix + prepare, input=payload, text=True, check=True)
                command = prefix + shlex.join(['python3', 'apps/web/harness/flatblock-budget.py', '--census',
                                              f'--min-available-gib={args.min_available_gib}',
                                              f'--log={relative}/collector.log', '--', *argv])
                captured = host.run(command)
                if captured.returncode:
                    saved = host.run(read_run, capture_output=True, text=True, check=True)
                    completed_pair(json.loads(saved.stdout), row, cohort, host, args.surface)
                    log = host.run(prefix + 'cat ' + shlex.quote(relative + '/collector.log'),
                                   capture_output=True, text=True, check=True).stdout
                    if 'fetch: Request context disposed.' not in log:
                        raise subprocess.CalledProcessError(captured.returncode, command)
                    collector_exits[row['run']] = {'exitCode': captured.returncode,
                                                  'reason': 'request context disposed during browser teardown'}
                    print(f'CAPTURE_CLEANUP_WARNING {row["run"]}', flush=True)
            outputs[row['key']].append(row['run'])
            schedule.append(row)
            save('running')
        save('complete')
        print(ledger.read_text(), flush=True)
    finally:
        if held:
            host.release()


if __name__ == '__main__':
    main()
