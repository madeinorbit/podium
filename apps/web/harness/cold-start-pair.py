"""Foreground OLD/candidate ABBA cold and warm captures under one short lease."""
import argparse
import datetime
import json
import pathlib
import queue
import shlex
import subprocess
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--candidate', default='candidate', choices=['candidate', 'candidate2', 'candidate3', 'new'])
parser.add_argument('--baseline', default='', choices=['', 'current'])
parser.add_argument('--samples', type=int, default=8)
parser.add_argument('--round', type=int, default=2)
args = parser.parse_args()
if args.samples < 1:
    raise ValueError('At least one paired sample is required')
cohort = str(uuid.uuid4())
arms = ['old', *([args.baseline] if args.baseline else []), args.candidate]
messages = queue.Queue()
children = {}
outputs = {}
held = False
waiting = False
renewed = 0
finished = set()
root = pathlib.Path('.artifacts/cold-start-remote')
root.mkdir(parents=True, exist_ok=True)

def ssh(command, **kwargs):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', command], check=True, **kwargs)

def write(arm, filename, value):
    path = f'podium-test-5513-{arm}/{outputs[arm]}/{filename}'
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
            subprocess.run(['podium', 'lock', 'renew', 'bench:flatblock', '--ttl', '10m'], check=True)
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
        outputs[arm] = f'.artifacts/old-vs-new/timing-{arm}-web-1x-r{args.round}'
        argv = ['--external-lease', '--paired', '--mode=timing', f'--arm={arm}',
                '--surface=web', '--scale=1', f'--round={args.round}',
                f'--samples={args.samples}', f'--port={19661 + at}',
                f'--out={outputs[arm]}']
        command = (f'cd "$HOME/podium-test-5513-{arm}" && '
                   'export PATH="$PWD/.toolchain:$PATH" && '
                   'export LD_LIBRARY_PATH="$PWD/.toolchain/lib" && '
                   'exec .toolchain/bun --conditions=@podium/source apps/web/harness/cold-start.mjs '
                   + shlex.join(argv))
        child = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', 'flatblock', command],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        children[arm] = child
        threading.Thread(target=collect, args=(arm, child), daemon=True).start()
    ready = set()
    while len(ready) != len(arms):
        arm, line = receive()
        if line.startswith('CAPTURE_READY '):
            ready.add(arm)
    waiter_argv = ['podium', 'lock', 'acquire', 'bench:flatblock', '--ttl', '10m', '--wait', '--json']
    waiting = True
    waiter = subprocess.Popen(waiter_argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    (root / f'paired-waiter-r{args.round}-pid.json').write_text(json.dumps({
        'pid': waiter.pid, 'role': 'paired-lease-waiter', 'argv': waiter_argv,
    }) + '\n')
    try:
        stdout, stderr = waiter.communicate()
        if waiter.returncode:
            raise RuntimeError(f'Timing lease waiter failed: {stderr}')
    finally:
        if waiter.poll() is None:
            waiter.terminate()
            waiter.wait(timeout=20)
    lease = json.loads(stdout)
    if not lease.get('data', {}).get('granted'):
        raise RuntimeError('Paired capture lease not granted')
    held = True
    waiting = False
    renewed = time.monotonic()
    print(lease.get('text', 'Paired capture lease acquired'), flush=True)
    payload = json.dumps({'name': 'bench:flatblock', 'host': 'ludovico', 'cohort': cohort,
                          'acquiredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          'grant': lease})
    for arm in arms:
        write(arm, 'lease.json', payload)
    for step in range(args.samples + 1):
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
    subprocess.run(['podium', 'lock', 'release', 'bench:flatblock'], check=True)
    held = False
    for child in children.values():
        if child.wait() != 0:
            raise RuntimeError('Collector failed during cleanup')
    print(json.dumps({'status': 'complete', 'cohort': cohort, 'outputs': outputs}), flush=True)
finally:
    if waiting:
        subprocess.run(['podium', 'lock', 'cancel', 'bench:flatblock'], check=True)
    if held:
        subprocess.run(['podium', 'lock', 'release', 'bench:flatblock'], check=True)
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
'''.replace('CHECKOUT', repr(f'podium-test-5513-{arm}')).replace('OUTPUT', repr(outputs[arm]))
            subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', 'python3 -'], input=cleanup, text=True)
            child.terminate()
