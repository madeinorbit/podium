"""Foreground resource guard for issue-owned flatblock measurements and gates.

Usage: python3 apps/web/harness/flatblock-budget.py --log=.artifacts/run.log
       [--census] -- .toolchain/bun run test:file -- path.test.ts
The census exception applies only while the caller holds meter:flatblock.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time


def memory():
    return {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}


def processes():
    result = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            result[int(path.name)] = (int(fields[3]), fields[19], int(fields[21]) * os.sysconf('SC_PAGE_SIZE'), int(fields[1]))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log', required=True)
    parser.add_argument('--census', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if socket.gethostname() != 'flatblock' or not command:
        raise ValueError('Only foreground flatblock runs are allowed')
    mem = memory()
    if mem['MemAvailable'] < 6 * 1024**2 or mem['SwapFree'] < 2 * 1024**2:
        raise RuntimeError(f'Admission: need 6 GiB available and 2 GiB swap free: {mem["MemAvailable"]} / {mem["SwapFree"]} KiB')
    path = Path(args.log)
    path.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'PATH': f'{Path.cwd()}/.toolchain:{os.environ["PATH"]}',
           'LD_LIBRARY_PATH': f'{Path.cwd()}/.toolchain/lib', 'PODIUM_TEST_WORKERS': '1'}
    child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    recorded = {}
    peak = 0
    min_available, min_swap = mem['MemAvailable'], mem['SwapFree']
    reason = None
    interrupted = False

    def interrupt(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        with path.open('wb') as log:
            while child.poll() is None or selector.get_map():
                current = processes()
                owned = {child.pid, *(pid for pid, identity in recorded.items() if current.get(pid, ())[:2] == identity)}
                # Chromium may create its own session. Follow parentage while
                # its parent is alive, then retain its observed identity.
                while True:
                    descendants = {pid for pid, facts in current.items() if facts[3] in owned}
                    if descendants <= owned:
                        break
                    owned.update(descendants)
                for pid, (session, started, rss, _parent) in current.items():
                    if pid in owned or session == child.pid:
                        recorded[pid] = (session, started)
                        peak = max(peak, rss)
                        if not args.census and rss > 3 * 1024**3:
                            try:
                                cmd = Path(f'/proc/{pid}/cmdline').read_bytes()
                                if b'vitest' in cmd:
                                    reason = f'Ordinary test worker {pid} exceeded 3 GiB'
                            except FileNotFoundError:
                                pass
                mem = memory()
                min_available = min(min_available, mem['MemAvailable'])
                min_swap = min(min_swap, mem['SwapFree'])
                if mem['MemAvailable'] < 1.5 * 1024**2 or mem['SwapFree'] < 2 * 1024**2:
                    reason = 'Resource floor: below 1.5 GiB available or 2 GiB swap free'
                if interrupted:
                    reason = 'Caller interrupted the foreground run'
                if reason:
                    raise RuntimeError(reason)
                for key, _ in selector.select(timeout=1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if data:
                        log.write(data)
                        log.flush()
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        selector.unregister(key.fileobj)
            return child.wait()
    finally:
        # Each PID was recorded as a member of this run's process session.
        # Check its start time again before signalling, to refuse PID reuse.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            current = processes()
            for pid, identity in reversed(list(recorded.items())):
                if current.get(pid, ())[:2] == identity:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            if sig == signal.SIGTERM:
                time.sleep(1)
        path.with_suffix(path.suffix + '.resources.json').write_text(json.dumps({
            'command': command, 'pids': recorded, 'peakProcessRssMiB': peak / 1024**2,
            'minMemAvailableMiB': min_available / 1024, 'minSwapFreeMiB': min_swap / 1024,
            'censusException': args.census, 'failure': reason, 'exitCode': child.poll(),
        }, indent=2) + '\n')


if __name__ == '__main__':
    sys.exit(main())
