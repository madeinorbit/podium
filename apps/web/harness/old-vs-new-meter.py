"""Foreground structural work on a comparison checkout; promptly release meter."""
import argparse
import datetime
import json
import pathlib
import shlex
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--checkout-arm', choices=['old', 'new'], required=True)
parser.add_argument('--task', choices=['mobile-maps', 'snapshot', 'cpu', 'cpu-boundaries'], required=True)
parser.add_argument('--surface', choices=['web', 'phone'], default='web')
parser.add_argument('--source-sha')
parser.add_argument('--build-dir')
args = parser.parse_args()
checkout = f'podium-test-5501-{args.checkout_arm}'
if args.task == 'mobile-maps':
    command = ['.toolchain/bun', 'apps/web/harness/old-vs-new-mobile-maps.mjs']
elif args.task == 'snapshot':
    command = ['python3', 'apps/web/harness/old-vs-new-build.py']
elif args.task == 'cpu-boundaries':
    command = ['.toolchain/bun', 'apps/web/harness/old-vs-new-cpu.ts', '--all',
               f'--surface={args.surface}', '--boundaries-only']
else:
    if not args.build_dir:
        parser.error('CPU attribution requires --build-dir with matching measured assets')
    command = ['.toolchain/bun', 'apps/web/harness/old-vs-new-cpu.ts', '--all',
               f'--surface={args.surface}', f'--build-dir={args.build_dir}']
    if args.source_sha:
        command.append(f'--source-sha={args.source_sha}')
root = pathlib.Path('.artifacts/old-vs-new-meter')
root.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
path = root / f'{args.checkout_arm}-{args.task}-{args.surface}-{stamp}.json'
run = {'host': 'flatblock', 'checkout': checkout, 'task': args.task,
       'surface': args.surface, 'command': command, 'requestedAt': stamp}
held = False
try:
    for attempt in range(5):
        acquired = subprocess.run(['podium', 'lock', 'acquire', 'meter:flatblock',
                                   '--ttl', '45m', '--wait', '--json'],
                                  capture_output=True, text=True)
        if acquired.returncode == 0:
            break
        print(f'Meter relay attempt {attempt + 1}: {acquired.stderr.strip()}', flush=True)
        time.sleep(2)
    acquired.check_returncode()
    grant = json.loads(acquired.stdout)
    if not grant.get('data', {}).get('granted'):
        raise RuntimeError('Meter lease was not granted')
    held = True
    run['lease'] = {'name': 'meter:flatblock', 'host': 'ludovico', 'grant': grant}
    run['startedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    path.write_text(json.dumps(run, indent=2) + '\n')
    print(grant.get('text', 'meter acquired'), flush=True)
    remote = (f'cd "$HOME/{checkout}" && export PATH="$PWD/.toolchain:$PATH" '
              f'&& export LD_LIBRARY_PATH="$PWD/.toolchain/lib" && exec {shlex.join(command)}')
    child = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', remote])
    run['exitCode'] = child.returncode
finally:
    # The server checks ownership, including a grant whose relay disconnected.
    subprocess.run(['podium', 'lock', 'release', 'meter:flatblock'],
                   check=held, capture_output=not held, text=True)
    run['releasedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    path.write_text(json.dumps(run, indent=2) + '\n')
raise SystemExit(run.get('exitCode', 1))
