"""Foreground OLD/candidate ABBA cold and warm captures under one short lease.

Baseline mode (POD-5594): --cells=h1a1,h10a1,h1a4,h10a4 --checkout=podium-test-5594
runs one collector per corpus cell in ONE checkout and interleaves the cells the
same way it interleaves OLD and candidate arms. --surface picks web or phone;
--meter also holds the memory lock (meter:flatblock) on flatblock.

POD-7099: --host/--local/--lock/--lock-held pick the host and its lock
(measure_hosts.py); the default is the vega agents VM under test:vega-agents.
"""
import argparse
import datetime
import json
import os
import pathlib
import queue
import re
import shlex
import subprocess
import sys
import threading
import time
import uuid

import measure_hosts

parser = argparse.ArgumentParser()
measure_hosts.add_arguments(parser)
parser.add_argument('--candidate', default='candidate', choices=['candidate', 'candidate2', 'candidate3', 'candidate4', 'new'])
parser.add_argument('--baseline', default='', choices=['', 'current'])
parser.add_argument('--alternative', default='', choices=['', 'candidate3'])
parser.add_argument('--samples', type=int, default=8)
parser.add_argument('--round', type=int, default=2)
parser.add_argument('--cells', default='', help='comma list of corpus cells; the arms are the cells')
parser.add_argument('--checkout', default='', help='issue-owned checkout on the host for --cells')
parser.add_argument('--surface', default='web', choices=['web', 'phone'])
parser.add_argument('--meter', action='store_true', help='also hold the memory lock (meter:<host>; the VMs have one lock)')
parser.add_argument('--no-profile', action='store_true')
parser.add_argument('--meter-held', action='store_true')
parser.add_argument('--resume', action='store_true')
parser.add_argument('--max-pairs', type=int)
args = parser.parse_args()
host = measure_hosts.resolve(args)
if args.samples < 1:
    raise ValueError('At least one paired sample is required')
cohort = str(uuid.uuid4())
cells = [cell for cell in args.cells.split(',') if cell]
if cells:
    if not re.fullmatch(r'podium-test-[a-z0-9-]+', args.checkout):
        raise ValueError('--cells needs an issue-owned --checkout=podium-test-<issue>')
    if any(not re.fullmatch(r'h[0-9]+a[124]', cell) for cell in cells):
        raise ValueError('Cells are h<history>a<1|2|4>')
    # One process tree at a time: four idle collectors still retain four
    # corpora, harnesses and browsers. The baseline controller interleaves
    # complete cold/warm pairs by restarting the collector between cells.
    command = [sys.executable, str(pathlib.Path(__file__).with_name('startup-baseline.py')),
               f'--checkout={args.checkout}', f'--cells={args.cells}',
               f'--surface={args.surface}', f'--samples={args.samples}', f'--round={args.round}',
               f'--host={host.name}', *(['--local'] if host.local else []), f'--lock={host.lock}',
               *(['--lock-held'] if host.held else []),
               *(['--resume'] if args.resume else []),
               *([f'--max-pairs={args.max_pairs}'] if args.max_pairs is not None else [])]
    raise SystemExit(subprocess.call(command))
else:
    if args.resume or args.max_pairs is not None:
        raise ValueError('--resume and --max-pairs require baseline --cells')
    arms = ['old', *([args.baseline] if args.baseline else []), *([args.alternative] if args.alternative else []), args.candidate]
checkouts = {arm: args.checkout if cells else f'podium-test-5513-{arm}' for arm in arms}
meter_lock = f'meter:{host.alias}' if host.name == 'flatblock' else host.lock
leases = list(dict.fromkeys([host.lock, *([meter_lock] if args.meter else [])]))
if len(set(arms)) != len(arms):
    raise ValueError('Each checkout must be measured once per round')
messages = queue.Queue()
children = {}
outputs = {}
held = []
waiting = False
renewed = 0
finished = set()
root = pathlib.Path('.artifacts/cold-start-remote')
root.mkdir(parents=True, exist_ok=True)
(root / f'paired-controller-r{args.round}-pid.json').write_text(json.dumps({
    'pid': os.getpid(), 'role': 'paired-controller', 'cwd': str(pathlib.Path.cwd()),
    'argv': pathlib.Path('/proc/self/cmdline').read_bytes().replace(b'\0', b' ').decode(),
}) + '\n')

def ssh(command, **kwargs):
    return host.run(command, check=True, **kwargs)

def write(arm, filename, value):
    path = f'{checkouts[arm]}/{outputs[arm]}/{filename}'
    ssh(f'cat > "$HOME/{path}"', input=value, text=True, capture_output=True)

def collect(arm, child):
    with (root / f'paired-{arm}-r{args.round}.log').open('w') as log:
        for line in child.stdout:
            log.write(line)
            log.flush()
            messages.put((arm, line.rstrip()))
    messages.put((arm, 'EXIT ' + str(child.wait())))

def receive():
    global renewed
    while True:
        try:
            arm, line = messages.get(timeout=20)
        except queue.Empty:
            print('Pair collectors are waiting in foreground', flush=True)
            line = None
        if held and time.monotonic() - renewed > 240:
            for name in held:
                host.renew(name, '10m')
            renewed = time.monotonic()
        if line is None:
            continue
        print(f'{arm}: {line}', flush=True)
        if line.startswith('CAPTURE_FINISHED '):
            if line != 'CAPTURE_FINISHED complete':
                raise RuntimeError(f'{arm} capture did not complete')
            finished.add(arm)
        if line.startswith('EXIT ') and line != 'EXIT 0':
            raise RuntimeError(f'{arm} collector failed: {line}')
        return arm, line

try:
    for at, arm in enumerate(arms):
        corpus = arm if cells else '1x'
        outputs[arm] = f'.artifacts/old-vs-new/timing-{arm}-{args.surface}-{corpus}-r{args.round}'
        argv = ['--external-lease', '--paired', '--mode=timing', f'--arm={arm}',
                f'--surface={args.surface}', '--scale=1', *([f'--cell={arm}'] if cells else []),
                f'--round={args.round}', f'--samples={args.samples}', f'--port={19661 + at}',
                f'--out={outputs[arm]}', *(['--no-profile'] if args.no_profile else []),
                f'--host={host.alias}', f'--lease={host.lock}']
        command = (f'cd "$HOME/{checkouts[arm]}" && {measure_hosts.TOOLCHAIN}'
                   'exec bun --conditions=@podium/source apps/web/harness/cold-start.mjs '
                   + shlex.join(argv))
        child = host.popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        children[arm] = child
        threading.Thread(target=collect, args=(arm, child), daemon=True).start()
    ready = set()
    while len(ready) != len(arms):
        arm, line = receive()
        if line.startswith('CAPTURE_READY '):
            ready.add(arm)
    grants = {}
    for name in leases:
        if host.held:
            grants[name] = host.acquire(name)
            held.append(name)
            continue
        waiter_argv = ['podium', 'lock', 'acquire', name, '--ttl', '10m', '--wait', '--json']
        waiting = name
        waiter = subprocess.Popen(waiter_argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        (root / f'paired-waiter-r{args.round}-pid.json').write_text(json.dumps({
            'pid': waiter.pid, 'role': 'paired-lease-waiter', 'argv': waiter_argv,
        }) + '\n')
        try:
            stdout, stderr = waiter.communicate()
            if waiter.returncode:
                raise RuntimeError(f'Lease waiter failed: {stderr}')
        finally:
            if waiter.poll() is None:
                waiter.terminate()
                waiter.wait(timeout=20)
        grants[name] = json.loads(stdout)
        if not grants[name].get('data', {}).get('granted'):
            raise RuntimeError(f'Paired capture lease {name} not granted')
        held.append(name)
        waiting = False
    lease = grants[host.lock]
    renewed = time.monotonic()
    print(lease.get('text', 'Paired capture lease acquired'), flush=True)
    payload = json.dumps({'name': host.lock, 'host': host.alias, 'cohort': cohort,
                          'acquiredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          'grant': lease, 'also': sorted(set(held) - {host.lock})})
    for arm in arms:
        write(arm, 'lease.json', payload)
    for step in range(args.samples + (0 if args.no_profile else 1)):
        order = arms if len(arms) == 2 else arms[step % len(arms):] + arms[:step % len(arms)]
        for arm in (order if step % 2 == 0 else list(reversed(order))):
            write(arm, f'step-{step}.go', cohort)
            while True:
                actual, line = receive()
                if line.startswith('PAIR_STEP_FINISHED '):
                    done = json.loads(line[len('PAIR_STEP_FINISHED '):])
                    if actual != arm or done['step'] != step:
                        raise RuntimeError('Pair collector order diverged')
                    break
    while len(finished) != len(arms):
        receive()
    for name in reversed(held):
        host.release(name)
    held = []
    for child in children.values():
        if child.wait() != 0:
            raise RuntimeError('Collector failed during cleanup')
    print(json.dumps({'status': 'complete', 'cohort': cohort, 'outputs': outputs}), flush=True)
finally:
    if waiting:
        # The terminated waiter may already have removed its queue entry.
        # A failed cancellation must not prevent recorded-process cleanup.
        subprocess.run(['podium', 'lock', 'cancel', waiting], check=False)
    for name in reversed(held):
        host.release(name)
    # Remote cleanup addresses only this run's recorded PIDs, after verifying cwd.
    for arm, child in children.items():
        if child.poll() is None:
            cleanup = '''from pathlib import Path
import json,os,signal
checkout=Path.home()/CHECKOUT
path=checkout/OUTPUT/'run.json'
if path.exists():
 for entry in sorted(json.loads(path.read_text()).get('pids',[]),key=lambda p:p['role']=='collector'):
  pid=entry['pid']
  try:
   if Path(os.readlink(f'/proc/{pid}/cwd'))!=checkout:raise RuntimeError('PID ownership changed')
   os.kill(pid,signal.SIGTERM)
  except (FileNotFoundError,ProcessLookupError):pass
'''.replace('CHECKOUT', repr(checkouts[arm])).replace('OUTPUT', repr(outputs[arm]))
            host.run('python3 -', input=cleanup, text=True)
            child.terminate()
