"""The screens probe (POD-7163): every main screen at operator size, or on a live install.

Operator size, on an agent VM under remote-lane's lock (the before-landing check of every
task of POD-7157):

    LANE_LOCK_TTL=30m remote-lane vega3 <issue> run bun run probe:screens -- <tip>

prepares the checkout (Chromium and its libraries, podium-host, the production web and phone
builds, the synthetic operator corpus: 8,687 issues, 6,941 sessions, a 970-issue mission),
then runs screens-probe.mjs: it opens every main screen above every budget (sidebar, deck,
board, issue page, search, phone mission), moves between them, reopens them offline, reloads
the phone with no network (its service worker, POD-7179), and prints per screen the server requests, load hops, LOADING time, the longest main-thread task
and the heap after a GC. Evidence lands in .artifacts/screens-probe/<round>/.

<tip> defaults to HEAD. Another commit runs in a sibling checkout (~/<checkout>-probe): that
commit's product tree with THIS checkout's harness files, so a before and an after run the
same probe.

Post-deploy, read-only, against the live install (docs/agents/driving-podium.md):

    bun run probe:screens -- --live=http://127.0.0.1:18787

mints a short session (`podium auth mint-session --print-only`), opens the same screens on the
live data with every write refused at the network, and prints the same table.
"""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import shlex
import socket
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('baseline', HERE / 'data-on-device-baseline.py')
baseline = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(HERE))
spec.loader.exec_module(baseline)


def git(cwd, *argv):
    return subprocess.run(['git', *argv], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def checkout_for(tip):
    """This checkout at its HEAD, or a sibling at `tip` with this checkout's harness files."""
    here = Path.cwd()
    head = git(here, 'rev-parse', 'HEAD')
    want = git(here, 'rev-parse', tip)
    if want == head:
        return here
    path = here.parent / f'{here.name}-probe'
    if not path.exists():
        baseline.sh(f'git worktree add --detach {shlex.quote(str(path))} {want}', here)
    baseline.sh(f'git checkout -q --detach {want}', path)
    baseline.sh(f'git checkout {head} -- {" ".join(baseline.HARNESS)}', path)
    baseline.sh('bun install --frozen-lockfile >/dev/null', path)
    return path


def prepare(path):
    baseline.sh('bun x playwright install chromium', path)
    baseline.chromium_libraries()
    baseline.sh('PATH="$PATH:$HOME/.cargo/bin" bun --conditions=@podium/source -e '
                + shlex.quote('const { resolveHostBin } = await import("./packages/pty/src/host-bin.ts"); '
                              'const bin = resolveHostBin(); if (!bin) process.exit(1); console.log("podium-host", bin)'),
                path)
    head = git(path, 'rev-parse', '--short=7', 'HEAD')
    for app in ['web', 'mobile']:
        stamp = path / f'apps/{app}/dist/podium-build.json'
        if stamp.exists() and json.loads(stamp.read_text()).get('sourceSha') == head:
            print(f'apps/{app} production build already at {head}', flush=True)
            continue
        baseline.sh(f'bun run --cwd apps/{app} build', path)
    if not (path / '.artifacts/old-vs-new/rows-operator.json').exists():
        baseline.sh('bun --conditions=@podium/source apps/web/harness/old-vs-new-corpus.mjs --cell=operator', path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('tip', nargs='?', default='HEAD', help='the commit to probe (default: HEAD)')
    parser.add_argument('--live', default='', help='probe this live install instead, read-only')
    parser.add_argument('--round', default='', help='evidence folder name (default: a timestamp)')
    parser.add_argument('--host', default=socket.gethostname(), help='host label recorded with the evidence')
    parser.add_argument('--surfaces', default='web,phone,phone-reload')
    parser.add_argument('--prepare-only', action='store_true', help='prepare the checkout and stop (a run of its own under a short lock)')
    args = parser.parse_args()
    stamp = args.round or datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    if args.live:
        out = Path.cwd() / '.artifacts/screens-probe' / f'live-{stamp}'
        argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/screens-probe.mjs',
                f'--live={args.live}', f'--out={out}', f'--host={args.host}', f'--surfaces={args.surfaces}']
        return subprocess.run(argv, cwd=Path.cwd()).returncode
    if socket.gethostname() == 'ludovico':
        raise SystemExit('The operator-size probe runs on an agent VM (remote-lane), never on ludovico')
    path = checkout_for(args.tip)
    prepare(path)
    if args.prepare_only:
        return 0
    sha = git(path, 'rev-parse', '--short=10', 'HEAD')
    out = path / '.artifacts/screens-probe' / f'{stamp}-{sha}'
    argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/screens-probe.mjs',
            f'--out={out}', f'--host={args.host}', f'--surfaces={args.surfaces}']
    baseline.sh(shlex.join(argv), path)
    print((out / 'report.md').read_text(), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
